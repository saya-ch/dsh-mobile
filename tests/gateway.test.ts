import { createHash, X509Certificate } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import {
  createServer,
  request as requestHttp,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { request as requestHttps } from 'node:https'
import { isAbsolute, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { connect, Socket, type AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { BlockedUpgradePathLog } from '../src/websocket-paths.js'
import { CSRF_COOKIE, CSRF_HEADER, DEVICE_COOKIE, SESSION_COOKIE } from '../src/http-security.js'
import { HOST_CSRF_COOKIE, HOST_DEVICE_COOKIE, HOST_SESSION_COOKIE } from '../src/browser-auth-cookies.js'
import { MemoryDeviceStore } from '../src/storage.js'
import { DSH_MOBILE_VERSION, MINIMUM_ANDROID_APP_VERSION } from '../src/version.js'
import { createTestTlsChain } from './tls-fixtures.js'

interface HttpResult {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
  readonly rawBody: Buffer
}

interface UpstreamObservation {
  readonly method: string
  readonly url: string
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

type BatchedBundleResponder = (
  request: IncomingMessage,
  response: ServerResponse,
) => boolean | Promise<boolean>

const cleanups: Array<() => Promise<void>> = []
const TEST_FAILED_START_PORT = 38081
/** Held by a UDP occupant so the gateway's broadcast discovery socket cannot bind it. */
const TEST_DISCOVERY_BUSY_PORT = 38099
const COMPRESSIBLE_SCRIPT = 'globalThis.__compressionProbe = true;\n'.repeat(256)
const UPSTREAM_LAUNCH_TOKEN = 'test-launch-token'
const UPSTREAM_BROWSER_COOKIE = 'dsh-auth-test=v1.signed-cookie'

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  return (server.address() as AddressInfo).port
}

async function closeServer(server: Server, sockets: Set<Socket> = new Set()): Promise<void> {
  for (const socket of sockets) socket.destroy()
  if (!server.listening) return
  server.closeAllConnections()
  await new Promise<void>(resolve => { server.close(() => resolve()) })
}

function beginRequest(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; deferEnd?: boolean } = {},
): { readonly outgoing: ClientRequest; readonly result: Promise<HttpResult> } {
  let outgoing!: ClientRequest
  const result = new Promise<HttpResult>((resolve, reject) => {
    const body = options.body
    const headers = { ...options.headers }
    if (body !== undefined && headers['content-length'] === undefined) headers['content-length'] = String(Buffer.byteLength(body))
    outgoing = requestHttp({
      host: '127.0.0.1',
      port,
      path,
      method: options.method ?? 'GET',
      headers,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.once('error', reject)
      response.once('end', () => {
        const rawBody = Buffer.concat(chunks)
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: rawBody.toString('utf8'), rawBody })
      })
    })
    outgoing.once('error', reject)
    if (!options.deferEnd) outgoing.end(body)
    else if (body !== undefined) outgoing.write(body)
  })
  return { outgoing, result }
}

async function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpResult> {
  return beginRequest(port, path, options).result
}

async function udpDiscovery(port: number): Promise<Record<string, unknown>> {
  const client = createSocket('udp4')
  return new Promise((resolve, reject) => {
    let settled = false
    let retry: ReturnType<typeof setInterval> | undefined
    const finish = (complete: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (retry !== undefined) clearInterval(retry)
      client.close()
      complete()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('UDP discovery timed out'))), 5_000)
    const send = (): void => {
      client.send(Buffer.from('DSH_MOBILE_DISCOVER_V1', 'ascii'), port, '127.0.0.1', error => {
        if (error !== null) finish(() => reject(error))
      })
    }
    client.once('error', error => finish(() => reject(error)))
    client.once('message', (message) => {
      try {
        const payload = JSON.parse(message.toString('utf8')) as Record<string, unknown>
        finish(() => resolve(payload))
      } catch (error) {
        finish(() => reject(error))
      }
    })
    client.bind(0, '127.0.0.1', () => {
      if (settled) return
      send()
      retry = setInterval(send, 250)
    })
  })
}

async function trustedHttpsRequest(port: number, path: string, rootCert: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const outgoing = requestHttps({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      ca: rootCert,
      rejectUnauthorized: true,
      agent: false,
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.once('end', () => {
        const rawBody = Buffer.concat(chunks)
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: rawBody.toString('utf8'), rawBody })
      })
    })
    outgoing.once('error', reject)
    outgoing.end()
  })
}

async function tlsFixtureFiles(): Promise<{
  readonly leaf: string
  readonly fullchain: string
  readonly intermediate: string
  readonly root: string
  readonly rootCert: string
  readonly key: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-access-tls-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const chain = createTestTlsChain()
  const files = {
    leaf: join(directory, 'leaf.pem'),
    fullchain: join(directory, 'fullchain.pem'),
    intermediate: join(directory, 'intermediate.pem'),
    root: join(directory, 'root.pem'),
    key: join(directory, 'leaf-key.pem'),
  }
  await Promise.all([
    writeFile(files.leaf, chain.leafCert, 'utf8'),
    writeFile(files.fullchain, `${chain.leafCert}${chain.intermediateCert}`, 'utf8'),
    writeFile(files.intermediate, chain.intermediateCert, 'utf8'),
    writeFile(files.root, chain.rootCert, 'utf8'),
    writeFile(files.key, chain.leafKey, { encoding: 'utf8', mode: 0o600 }),
  ])
  return { ...files, rootCert: chain.rootCert }
}

function cookiesByName(headers: IncomingHttpHeaders): Map<string, string> {
  const result = new Map<string, string>()
  for (const line of headers['set-cookie'] ?? []) {
    const pair = line.split(';', 1)[0]
    if (pair === undefined) continue
    const equals = pair.indexOf('=')
    if (equals > 0) result.set(pair.slice(0, equals), pair.slice(equals + 1))
  }
  return result
}

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'ascii').digest('base64')
}

function websocketBinaryFrame(payload: Buffer): Buffer {
  if (payload.length > 0xffff) throw new Error('test WebSocket payload is too large')
  const frame = Buffer.allocUnsafe(payload.length + 4)
  frame[0] = 0x82
  frame[1] = 126
  frame.writeUInt16BE(payload.length, 2)
  payload.copy(frame, 4)
  return frame
}

async function upstream(
  boot: 'legacy' | 'batched' | 'batched-relative' | 'batched-relative-invalid' | 'remote-settings' = 'legacy',
  requireAuthentication = false,
  upgradeBurst: Buffer = Buffer.alloc(0),
  upgradeHeaderLines: string[] = [],
  upgradeHeaderBytes?: number,
  batchedBundleResponder?: BatchedBundleResponder,
  extraBatchedEntries = 0,
  secondApplicationBatchEntries = 0,
): Promise<{
  port: number
  observations: UpstreamObservation[]
  upgradeObservations: IncomingHttpHeaders[]
  upgradeResponseBytes: number[]
  closedHolds: string[]
  releaseHold: () => void
  setBatchEntriesReversed: (reversed: boolean) => void
}> {
  const observations: UpstreamObservation[] = []
  const upgradeObservations: IncomingHttpHeaders[] = []
  const upgradeResponseBytes: number[] = []
  const held: Array<() => void> = []
  const closedHolds: string[] = []
  let batchEntriesReversed = false
  const upgraded = new Set<Socket>()
  const server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    observations.push({
      method: incoming.method ?? '',
      url: incoming.url ?? '',
      headers: incoming.headers,
      body: Buffer.concat(chunks).toString('utf8'),
    })
    if (requireAuthentication && incoming.url === `/?token=${UPSTREAM_LAUNCH_TOKEN}`) {
      response.writeHead(303, {
        location: '/',
        'set-cookie': `${UPSTREAM_BROWSER_COOKIE}; Max-Age=1800; Path=/; HttpOnly; SameSite=Strict`,
      })
      response.end()
      return
    }
    if (requireAuthentication && incoming.headers.cookie !== UPSTREAM_BROWSER_COOKIE) {
      response.writeHead(401, { 'content-type': 'text/plain' })
      response.end('authentication required')
      return
    }
    if (incoming.url === '/api/stream-hold') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('first')
      response.once('close', () => { closedHolds.push(incoming.url!) })
      held.push(() => { response.end('last') })
      return
    }
    if (incoming.url === '/hold' || incoming.url === '/api' || incoming.url === '/api/hold') {
      response.once('close', () => { closedHolds.push(incoming.url!) })
      held.push(() => { response.writeHead(200); response.end('released') })
      return
    }
    if (incoming.url === '/sidebar/html/preview.html') {
      const body = '<!doctype html><html><head><title>Plugin preview</title></head><body>owned preview</body></html>'
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    if (incoming.url === '/sidebar/html/missing.html') {
      response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body>missing preview</body></html>')
      return
    }
    const documentPath = new URL(incoming.url ?? '/', 'http://upstream.invalid').pathname
    if ((documentPath === '/' || documentPath === '/index.html') && incoming.headers.accept?.includes('text/html')) {
      const pluginUrl = (id: string, name: string, rev: string): string => {
        if (boot === 'batched-relative-invalid' && id === 'feature') return 'plugins/../api/secret'
        return boot === 'batched-relative' || boot === 'batched-relative-invalid'
          ? `plugins/??${id}/client.js&rev=${rev}`
          : `/plugins/${name}.js?rev=${rev}`
      }
      const entries = boot === 'legacy'
        ? [
            { id: '@deepseek-ai/dsh-client-ui-layout', url: '/plugins/layout.js', rev: 'stock-layout', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'] },
            { id: 'feature', url: '/plugins/feature.js', rev: 'feature' },
          ]
        : [
            { id: '@deepseek-ai/dsh-client-ui-renderer', url: pluginUrl('@deepseek-ai/dsh-client-ui-renderer', 'renderer', 'renderer'), rev: 'renderer' },
            {
              id: '@deepseek-ai/dsh-client-ui-layout',
              url: pluginUrl('@deepseek-ai/dsh-client-ui-layout', 'layout', 'layout'),
              rev: 'layout',
              inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-theme'],
            },
            { id: 'feature', url: pluginUrl('feature', 'feature', 'feature'), rev: 'feature' },
            ...Array.from({ length: extraBatchedEntries }, (_, index) => ({
              id: `feature-${String(index)}`,
              url: pluginUrl(`feature-${String(index)}`, `feature-${String(index)}`, `feature-${String(index)}`),
              rev: `feature-${String(index)}`,
            })),
          ]
      if (boot === 'remote-settings') entries.push(
        { id: '@deepseek-ai/dsh-client-connection', url: '/plugins/connection.js?rev=connection', rev: 'connection', inject: [] },
        { id: '@deepseek-ai/dsh-api-gateway', url: '/plugins/gateway.js?rev=gateway', rev: 'gateway', inject: ['@deepseek-ai/dsh-client-connection'] },
        { id: '@deepseek-ai/dsh-api-remotes', url: '/plugins/remotes.js?rev=remotes', rev: 'remotes', inject: ['@deepseek-ai/dsh-api-gateway'] },
        { id: '@deepseek-ai/dsh-client-ui-settings', url: '/plugins/settings.js?rev=settings', rev: 'settings', inject: ['@deepseek-ai/dsh-api-remotes'] },
        { id: 'dsh-mobile', url: '/plugins/mobile.js?rev=mobile', rev: 'mobile', inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'] },
      )
      const batchEntryIds = entries.map(entry => entry.id)
      if (batchEntriesReversed) batchEntryIds.reverse()
      const applicationBatchUrl = boot === 'batched-relative' || boot === 'batched-relative-invalid'
        ? 'plugins/??feature/client.js&rev=stock' : '/plugins/application.js?rev=stock'
      const applicationBatches = secondApplicationBatchEntries === 0
        ? [{ phase: 'application', url: applicationBatchUrl, rev: 'stock-batch', entries: batchEntryIds }]
        : [
            { phase: 'application', url: applicationBatchUrl, rev: 'stock-batch', entries: batchEntryIds.slice(0, -secondApplicationBatchEntries) },
            { phase: 'application', url: '/plugins/application-2.js?rev=stock', rev: 'stock-batch-2', entries: batchEntryIds.slice(-secondApplicationBatchEntries) },
          ]
      const graph = boot === 'legacy'
        ? { rev: 'stock', entries }
        : { rev: 'stock', entries, batches: applicationBatches }
      const preload = boot === 'legacy' ? '' : applicationBatches
        .map(batch => `<link rel="preload" as="script" href="${batch.url.replaceAll('&', '&amp;')}">`).join('')
      const body = `<!doctype html><html><head>${preload}<script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)};</script></head><body></body></html>`
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    if ((boot === 'batched' || boot === 'batched-relative' || boot === 'batched-relative-invalid') && incoming.url?.startsWith('/plugins/') === true) {
      if (await batchedBundleResponder?.(incoming, response) === true) return
      const body = `globalThis.__loadedMobileFixture ??= []; globalThis.__loadedMobileFixture.push(${JSON.stringify(incoming.url)});\n`
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    // A stale `rev` (the host restarted and re-issued a fresh nonce) and a
    // vanished build hash both end here: a bare rejection with no cache-control,
    // exactly as upstream DSH answers them.
    if (incoming.url?.startsWith('/plugins/stale-revision.js') === true) {
      const body = 'unknown revision\n'
      response.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      response.end(body)
      return
    }
    if (incoming.url?.startsWith('/assets/stale-') === true) {
      const body = 'not found\n'
      response.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      })
      response.end(body)
      return
    }
    if (incoming.url?.startsWith('/plugins/compressible.js') === true) {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'content-length': Buffer.byteLength(COMPRESSIBLE_SCRIPT),
        'cache-control': 'no-store',
        etag: '"compressible-script"',
      })
      response.end(COMPRESSIBLE_SCRIPT)
      return
    }
    const body = `${JSON.stringify({ ok: true, method: incoming.method, url: incoming.url })}\n`
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'public, max-age=3600',
      'expires': 'Wed, 21 Oct 2099 07:28:00 GMT',
      'pragma': 'cache',
      'set-cookie': 'upstream-secret=must-not-pass',
      'x-powered-by': 'hidden',
    })
    response.end(body)
  })
  server.on('upgrade', (incoming, socket) => {
    const networkSocket = socket as Socket
    upgraded.add(networkSocket)
    networkSocket.on('error', () => { networkSocket.destroy() })
    networkSocket.once('close', () => { upgraded.delete(networkSocket) })
    upgradeObservations.push(incoming.headers)
    if (requireAuthentication && incoming.headers.cookie !== UPSTREAM_BROWSER_COOKIE) {
      networkSocket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    const key = incoming.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      networkSocket.destroy()
      return
    }
    const responseLines = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      'Set-Cookie: upstream-secret=must-not-pass',
      ...upgradeHeaderLines,
      '',
      '',
    ]
    let response = Buffer.from(responseLines.join('\r\n'), 'latin1')
    if (upgradeHeaderBytes !== undefined) {
      const paddingOverhead = Buffer.byteLength('X-Padding: \r\n', 'latin1')
      const paddingBytes = upgradeHeaderBytes - response.length - paddingOverhead
      if (paddingBytes < 0) {
        networkSocket.destroy(new Error('requested WebSocket response header is too small'))
        return
      }
      responseLines.splice(-2, 0, `X-Padding: ${'x'.repeat(paddingBytes)}`)
      response = Buffer.from(responseLines.join('\r\n'), 'latin1')
    }
    upgradeResponseBytes.push(response.length)
    networkSocket.write(Buffer.concat([response, upgradeBurst]))
    networkSocket.pipe(networkSocket)
  })
  const port = await listen(server)
  cleanups.push(() => closeServer(server, upgraded))
  return {
    port,
    observations,
    upgradeObservations,
    upgradeResponseBytes,
    closedHolds,
    releaseHold: () => { for (const release of held.splice(0)) release() },
    setBatchEntriesReversed: (reversed) => { batchEntriesReversed = reversed },
  }
}

async function gateway(
  upstreamPort: number,
  overrides: Record<string, unknown> = {},
  testSessionTtlMs?: number,
  upstreamAuthenticatedUrl?: string,
  extraWebSocketPaths: readonly string[] = [],
  blockedUpgradeLog?: BlockedUpgradePathLog,
  onDiscoveryDegraded?: (source: 'broadcast' | 'mdns', code: string) => void,
): Promise<MobileAccessGateway> {
  const resolved = parseGatewayConfig({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
    publicAuthorities: ['127.0.0.1'],
    allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(tmpdir(), `dsh-mobile-access-${crypto.randomUUID()}.json`),
    tls: { mode: 'disabled' },
    ...overrides,
  })
  const effective = testSessionTtlMs === undefined ? resolved : Object.freeze({ ...resolved, sessionTtlMs: testSessionTtlMs })
  const extra = new Set(extraWebSocketPaths)
  const instance = new MobileAccessGateway(
    effective, new MemoryDeviceStore(), undefined, upstreamAuthenticatedUrl,
    { has: (pathname: string) => extra.has(pathname) }, blockedUpgradeLog, onDiscoveryDegraded,
  )
  await instance.start()
  cleanups.push(() => instance.close())
  return instance
}

function browserHeaders(instance: MobileAccessGateway): Record<string, string> {
  const origin = instance.address().origin
  return {
    host: new URL(origin).host,
    origin,
    'sec-fetch-site': 'same-origin',
  }
}

async function remoteCookieGateway(upstreamPort: number, sessionTtlMs = 30_000): Promise<MobileAccessGateway> {
  const config = parseGatewayConfig({
    listenHost: '127.0.0.1', listenPort: 0,
    upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
    publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(tmpdir(), `dsh-mobile-cookie-${crypto.randomUUID()}.json`),
    tls: { mode: 'disabled' },
  })
  // Remote providers terminate HTTPS outside the loopback gateway.
  const instance = new MobileAccessGateway(Object.freeze({ ...config, publicTls: true, sessionTtlMs }), new MemoryDeviceStore())
  await instance.start()
  cleanups.push(() => instance.close())
  return instance
}

async function pair(instance: MobileAccessGateway): Promise<{
  deviceId: string
  session: string
  device: string
  csrf: string
}> {
  const opened = await instance.access.openPairing()
  const result = await request(instance.address().port, '/mobile-access/auth/pair', {
    method: 'POST',
    headers: { ...browserHeaders(instance), 'content-type': 'application/json' },
    body: JSON.stringify({ token: opened.token, label: 'Test phone' }),
  })
  expect(result.status).toBe(201)
  const body = JSON.parse(result.body) as { deviceId: string; csrfToken: string }
  const cookies = cookiesByName(result.headers)
  return {
    deviceId: body.deviceId,
    session: cookies.get(SESSION_COOKIE) ?? '',
    device: cookies.get(DEVICE_COOKIE) ?? '',
    csrf: body.csrfToken,
  }
}

async function mobileBatchFixture(responder?: BatchedBundleResponder): Promise<{
  readonly inner: Awaited<ReturnType<typeof upstream>>
  readonly instance: MobileAccessGateway
  readonly headers: Record<string, string>
  readonly path: string
}> {
  const inner = await upstream('batched', false, Buffer.alloc(0), [], undefined, responder)
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-batched-layout-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const mobileLayoutFile = join(directory, 'mobile-layout.js')
  await writeFile(mobileLayoutFile, 'globalThis.__dedicatedMobileLayout = true;\n', 'utf8')
  const instance = await gateway(inner.port, { mobileLayoutFile })
  const paired = await pair(instance)
  const headers = {
    ...browserHeaders(instance),
    accept: 'text/html,application/xhtml+xml',
    cookie: `${SESSION_COOKIE}=${paired.session}`,
  }
  const mobile = await request(instance.address().port, '/', { headers })
  expect(mobile.status).toBe(200)
  const match = /"url":"(\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js)"/u.exec(mobile.body)
  expect(match?.[1]).toBeDefined()
  return { inner, instance, headers, path: match![1]! }
}

function activeRequestCount(instance: MobileAccessGateway): number {
  return (instance as unknown as { readonly activeRequests: ReadonlyMap<number, unknown> }).activeRequests.size
}

function activeMobileBatchTask(instance: MobileAccessGateway): Promise<Buffer> | undefined {
  const batches = (instance as unknown as {
    readonly mobileBootBatches: ReadonlyMap<string, { readonly assembly?: { readonly task: Promise<Buffer> } }>
  }).mobileBootBatches
  return [...batches.values()].find(batch => batch.assembly !== undefined)?.assembly?.task
}

async function openWebSocket(
  instance: MobileAccessGateway,
  path: string,
  session: string,
  origin?: string,
  fetchSite: string | undefined = 'same-origin',
  minimumRemainderBytes = 0,
): Promise<{
  socket: Socket
  response: string
  remainder: Buffer
}> {
  const address = instance.address()
  const key = Buffer.from('0123456789abcdef').toString('base64')
  return new Promise((resolve, reject) => {
    const socket = connect(address.port, '127.0.0.1')
    let buffer = Buffer.alloc(0)
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('WebSocket handshake timed out')) }, 3_000)
    socket.once('error', reject)
    socket.once('close', () => {
      clearTimeout(timeout)
      reject(new Error('WebSocket closed before handshake'))
    })
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const remainder = buffer.subarray(end + 4)
      if (remainder.length < minimumRemainderBytes) return
      clearTimeout(timeout)
      resolve({ socket, response: buffer.subarray(0, end).toString('latin1'), remainder })
    })
    socket.once('connect', () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        `Host: ${new URL(address.origin).host}`,
        `Origin: ${origin ?? address.origin}`,
        ...(fetchSite === undefined ? [] : [`Sec-Fetch-Site: ${fetchSite}`]),
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        `Cookie: ${SESSION_COOKIE}=${session}; ${DEVICE_COOKIE}=must-strip; attacker=outside`,
        '',
        '',
      ].join('\r\n'))
    })
  })
}

describe('HTTP gateway', () => {
  it('serves authenticated computer image browsing without proxying filesystem paths', async () => {
    const inner = await upstream()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-computer-files-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    await mkdir(join(directory, 'album'))
    await writeFile(join(directory, 'photo.png'), 'mobile-image')
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }
    const listing = await request(instance.address().port, `/mobile-access/computer-images?path=${encodeURIComponent(directory)}`, { headers })
    expect(listing.status).toBe(200)
    expect(JSON.parse(listing.body)).toMatchObject({ entries: [
      { kind: 'directory', name: 'album' },
      { kind: 'image', name: 'photo.png' },
    ] })
    const image = await request(instance.address().port, `/mobile-access/computer-image?path=${encodeURIComponent(join(directory, 'photo.png'))}`, { headers })
    expect(image.status).toBe(200)
    expect(image.headers['content-type']).toBe('image/png')
    expect(image.rawBody.toString()).toBe('mobile-image')
    expect(inner.observations).toHaveLength(0)
    const unauthenticated = await request(instance.address().port, `/mobile-access/computer-images?path=${encodeURIComponent(directory)}`, {
      headers: browserHeaders(instance),
    })
    expect(unauthenticated.status).toBe(401)
  })

  it('serves the latest authenticated mobile Web assets without caching them', async () => {
    const inner = await upstream()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-css-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const customCssFile = join(directory, 'mobile.css')
    const customScriptFile = join(directory, 'mobile.js')
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    const mobileCompatibilityFile = join(directory, 'mobile-compat.js')
    await writeFile(mobileCompatibilityFile, 'globalThis.__compatibilityProbe = true;\n', 'utf8')
    await writeFile(customCssFile, ':root { --preview: first; }\n', 'utf8')
    await writeFile(customScriptFile, 'window.dshMobile.register(() => undefined)\n', 'utf8')
    await writeFile(mobileLayoutFile, 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-layout" })\n', 'utf8')
    const instance = await gateway(inner.port, { customCssFile, customScriptFile, mobileLayoutFile, mobileCompatibilityFile })
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const first = await request(instance.address().port, '/mobile-access/custom.css', { headers })
    expect(first.status).toBe(200)
    expect(first.headers['cache-control']).toBe('no-store')
    expect(first.headers.etag).toMatch(/^[a-f0-9]{64}$/u)
    expect(first.headers['last-modified']).toBeDefined()
    expect(first.body).toContain('--preview: first')

    const cached = await request(instance.address().port, '/mobile-access/custom.css', {
      headers: { ...headers, 'if-none-match': String(first.headers.etag) },
    })
    expect(cached.status).toBe(304)
    expect(cached.body).toBe('')

    const script = await request(instance.address().port, '/mobile-access/custom.js', { headers })
    expect(script.status).toBe(200)
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(script.headers['cache-control']).toBe('no-store')
    expect(script.body).toContain('dshMobile.register')

    const layout = await request(instance.address().port, '/mobile-access/mobile-layout.js', { headers })
    expect(layout.status).toBe(200)
    expect(layout.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(layout.body).toContain('@deepseek-ai/dsh-client-ui-layout')

    const compatibility = await request(instance.address().port, '/mobile-access/compat.js', { headers })
    expect(compatibility.status).toBe(200)
    expect(compatibility.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(compatibility.headers['cache-control']).toBe('no-store')
    expect(compatibility.headers['x-content-type-options']).toBe('nosniff')
    expect(compatibility.body).toContain('__compatibilityProbe = true')
    const cachedCompatibility = await request(instance.address().port, '/mobile-access/compat.js', {
      headers: { ...headers, 'if-none-match': String(compatibility.headers.etag) },
    })
    expect(cachedCompatibility.status).toBe(304)
    expect(cachedCompatibility.headers['cache-control']).toBe('no-store')
    expect(cachedCompatibility.body).toBe('')
    await writeFile(mobileCompatibilityFile, 'globalThis.__compatibilityProbe = "updated";\n', 'utf8')
    const updatedCompatibility = await request(instance.address().port, '/mobile-access/compat.js', {
      headers: { ...headers, 'if-none-match': String(compatibility.headers.etag) },
    })
    expect(updatedCompatibility.status).toBe(200)
    expect(updatedCompatibility.headers.etag).not.toBe(compatibility.headers.etag)
    expect(updatedCompatibility.body).toContain('__compatibilityProbe = "updated"')

    await writeFile(customCssFile, ':root { --preview: second; }\n', 'utf8')
    const second = await request(instance.address().port, '/mobile-access/custom.css', { headers })
    expect(second.status).toBe(200)
    expect(second.body).toContain('--preview: second')
    expect(inner.observations).toHaveLength(0)
  })

  it('protects compatibility assets and refuses missing, oversized, or non-GET requests', async () => {
    const inner = await upstream()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-compat-route-'))
    cleanups.push(async () => {
      const withinTemp = relative(tmpdir(), directory)
      if (!withinTemp || withinTemp.startsWith('..') || isAbsolute(withinTemp)) throw new Error('unsafe test cleanup path')
      await rm(directory, { recursive: true, force: true })
    })
    const mobileCompatibilityFile = join(directory, 'compat.js')
    const instance = await gateway(inner.port, { mobileCompatibilityFile })
    const paired = await pair(instance)
    const headers = { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` }

    const anonymous = await request(instance.address().port, '/mobile-access/compat.js', { headers: browserHeaders(instance) })
    expect(anonymous.status).toBe(401)
    const crossOrigin = await request(instance.address().port, '/mobile-access/compat.js', {
      headers: { ...headers, origin: 'https://untrusted.example', 'sec-fetch-site': 'cross-site' },
    })
    expect(crossOrigin.status).toBe(403)
    const missing = await request(instance.address().port, '/mobile-access/compat.js', { headers })
    expect(missing.status).toBe(503)
    expect(JSON.parse(missing.body)).toMatchObject({ error: 'mobile_frontend_unavailable' })
    await writeFile(mobileCompatibilityFile, 'x'.repeat(256 * 1024 + 1), 'utf8')
    const oversized = await request(instance.address().port, '/mobile-access/compat.js', { headers })
    expect(oversized.status).toBe(413)
    const mutation = await request(instance.address().port, '/mobile-access/compat.js', {
      method: 'POST', headers: { ...headers, [CSRF_HEADER]: paired.csrf },
    })
    expect(mutation.status).toBe(404)
    expect(inner.observations).toHaveLength(0)
  })

  it('serves the dedicated layout at the authenticated root while retaining a stock escape hatch', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const mobile = await request(instance.address().port, '/', { headers })
    expect(mobile.status).toBe(200)
    expect(mobile.body).toContain('window.__DSH_MOBILE_FRONTEND__="dedicated"')
    expect(mobile.body).toContain('/mobile-access/mobile-layout.js')
    expect(mobile.body).toContain('/plugins/feature.js')
    expect(mobile.body).toContain('<script src="/mobile-access/compat.js"></script>')
    expect(mobile.body.indexOf('/mobile-access/compat.js')).toBeLessThan(mobile.body.indexOf('__DSH_BOOT__'))

    const deepLink = await request(instance.address().port, '/?sessionId=example', { headers })
    expect(deepLink.status).toBe(200)
    expect(deepLink.body).toContain('window.__DSH_MOBILE_FRONTEND__="dedicated"')
    expect(deepLink.body.indexOf('/mobile-access/compat.js')).toBeGreaterThan(0)
    expect(deepLink.body.indexOf('/mobile-access/compat.js')).toBeLessThan(deepLink.body.indexOf('__DSH_BOOT__'))

    const index = await request(instance.address().port, '/index.html?sessionId=example', {
      headers: { ...headers, 'sec-fetch-dest': 'iframe' },
    })
    expect(index.status).toBe(200)
    expect(index.body).toContain('window.__DSH_MOBILE_FRONTEND__="dedicated"')
    expect(inner.observations.map(entry => entry.url)).toContain('/?sessionId=example')
    expect(inner.observations.map(entry => entry.url)).toContain('/index.html?sessionId=example')

    const stock = await request(instance.address().port, '/?frontend=stock', { headers })
    expect(stock.status).toBe(200)
    expect(stock.body).not.toContain('__DSH_MOBILE_FRONTEND__')
    expect(stock.body).toContain('/plugins/layout.js')
    expect(stock.body).not.toContain('/mobile-access/compat.js')
  })

  it('localizes browser pairing and reauthentication pages from Accept-Language', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    await instance.access.openPairing()
    const base = browserHeaders(instance)

    const chinesePair = await request(instance.address().port, '/mobile-access/pair', {
      headers: { ...base, accept: 'text/html', 'accept-language': 'zh-CN,zh;q=0.9' },
    })
    expect(chinesePair.status).toBe(200)
    expect(chinesePair.body).toContain('<html lang="zh-CN">')
    expect(chinesePair.body).toContain('配对码')
    expect(chinesePair.headers.vary).toBe('Accept-Language')

    const italianScript = await request(instance.address().port, '/mobile-access/pair.js', {
      headers: { ...base, accept: 'text/javascript', 'accept-language': 'it-IT' },
    })
    expect(italianScript.status).toBe(200)
    expect(italianScript.body).toContain('Abbinamento non riuscito')

    const englishLogin = await request(instance.address().port, '/mobile-access/login', {
      headers: { ...base, accept: 'text/html', 'accept-language': 'fr-FR' },
    })
    expect(englishLogin.status).toBe(200)
    expect(englishLogin.body).toContain('Reconnect this device')
  })

  it('uses the authenticated HTTP carrier for dedicated-page uploads, but not stock pages', async () => {
    const inner = await upstream('remote-settings')
    const instance = await gateway(inner.port)
    const browser = { ...browserHeaders(instance), accept: 'text/html' }
    const anonymous = await request(instance.address().port, '/', { headers: browser })
    expect(anonymous.status).toBe(302)
    expect(anonymous.body).not.toContain('__DSH_TRANSPORT__')
    expect(anonymous.body).not.toContain('__DSH_FILE_UPLOAD__')
    expect(inner.observations).toHaveLength(0)
    const login = await request(instance.address().port, '/mobile-access/login', { headers: browser })
    expect(login.status).toBe(200)
    expect(login.body).not.toContain('__DSH_TRANSPORT__')
    expect(login.body).not.toContain('__DSH_FILE_UPLOAD__')

    const paired = await pair(instance)
    const headers = { ...browser, cookie: `${SESSION_COOKIE}=${paired.session}` }
    const dedicated = await request(instance.address().port, '/', { headers })
    expect(dedicated.status).toBe(200)
    expect(dedicated.body).toContain('window.__DSH_TRANSPORT__={fetch:')
    expect(dedicated.body).toContain('ownsHost:true')
    expect(dedicated.body).toContain('window.__DSH_FILE_UPLOAD__={fetch:')
    expect(dedicated.body).toContain('window.__DSH_MOBILE_FRONTEND__="dedicated"')
    const bootstrapStart = dedicated.body.indexOf('(()=>{if(window.__DSH_TRANSPORT__')
    const bootstrapEnd = dedicated.body.indexOf('window.__DSH_MOBILE_FRONTEND__=', bootstrapStart)
    expect(bootstrapStart).toBeGreaterThan(-1)
    expect(bootstrapEnd).toBeGreaterThan(bootstrapStart)
    const nativeFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const requestHeaders = new Headers(init?.headers)
      requestHeaders.set('cookie', `${SESSION_COOKIE}=${paired.session}`)
      requestHeaders.set('origin', instance.address().origin)
      requestHeaders.set('sec-fetch-site', 'same-origin')
      return fetch(new URL(String(input), instance.address().origin), { ...init, headers: requestHeaders })
    })
    const page: {
      fetch: typeof fetch
      __DSH_FILE_UPLOAD__?: { fetch: typeof fetch }
    } = { fetch: nativeFetch }
    const pageLocation = { href: `${instance.address().origin}/`, origin: instance.address().origin }
    new Function('window', 'document', 'location', 'Request', 'Headers', 'URL', dedicated.body.slice(bootstrapStart, bootstrapEnd))(
      page, { cookie: `${CSRF_COOKIE}=${paired.csrf}` }, pageLocation, Request, Headers, URL,
    )
    const uploadBody = new Blob(['%PDF-1.7\nmobile upload\n%%EOF\n'], { type: 'application/pdf' })
    const upload = await page.__DSH_FILE_UPLOAD__?.fetch('/api/session/uploadFileBinary?sessionId=test', {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: uploadBody,
    })
    expect(upload?.status).toBe(200)
    const forwarded = inner.observations.at(-1)
    expect(forwarded?.url).toBe('/api/session/uploadFileBinary?sessionId=test')
    expect(forwarded?.body).toBe('%PDF-1.7\nmobile upload\n%%EOF\n')
    expect(forwarded?.headers['content-type']).toBe('application/octet-stream')
    expect(forwarded?.headers.cookie).toBeUndefined()
    expect(forwarded?.headers[CSRF_HEADER]).toBeUndefined()
    expect(nativeFetch).toHaveBeenCalledOnce()
    const stock = await request(instance.address().port, '/?frontend=stock', { headers })
    expect(stock.status).toBe(200)
    expect(stock.body).not.toContain('__DSH_TRANSPORT__')
    expect(stock.body).not.toContain('__DSH_FILE_UPLOAD__')
    expect(stock.body).not.toContain('__DSH_MOBILE_FRONTEND__')
  })

  it('serves a DSH 0.1.2 mobile application batch without the stock layout factory', async () => {
    const inner = await upstream('batched')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-batched-layout-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    await writeFile(mobileLayoutFile, 'globalThis.__dedicatedMobileLayout = true;\n', 'utf8')
    const instance = await gateway(inner.port, { mobileLayoutFile })
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const mobile = await request(instance.address().port, '/', { headers })
    expect(mobile.status).toBe(200)
    const match = /"url":"(\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js)"/u.exec(mobile.body)
    expect(match?.[1]).toBeDefined()
    const path = match![1]!
    expect(mobile.body).not.toContain('href="/plugins/application.js?rev=stock"')
    expect(mobile.body).toContain(`<link rel="preload" as="script" href="${path}">`)
    const batch = await request(instance.address().port, path, { headers })
    expect(batch.status).toBe(200)
    expect(batch.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(batch.headers.etag).toMatch(/^[a-f\d]{64}$/u)
    expect(batch.body).toContain('/plugins/renderer.js?rev=renderer')
    expect(batch.body).toContain('__dedicatedMobileLayout = true')
    expect(batch.body).toContain('/plugins/feature.js?rev=feature')
    expect(batch.body).not.toContain('/plugins/layout.js?rev=layout')
    // A merged batch only registers each module's factory
    // (`window.__ModuleLoader__.load({ id, factory })`); `require` runs at
    // materialization and dependencies resolve through `inject`, so the order of
    // the concatenated bodies carries no contract. It is canonical (entry ids
    // sorted) all the same, so the batch key and its `ETag` stay stable when
    // upstream re-lists an unchanged module set in a different order.
    expect(batch.body.indexOf('__dedicatedMobileLayout')).toBeLessThan(batch.body.indexOf('renderer.js'))
    expect(batch.body.indexOf('renderer.js')).toBeLessThan(batch.body.indexOf('feature.js'))

    const compressed = await request(instance.address().port, path, {
      headers: { ...headers, 'accept-encoding': 'gzip' },
    })
    expect(compressed.status).toBe(200)
    expect(compressed.headers['content-encoding']).toBe('gzip')
    expect(compressed.headers.vary).toBe('Accept-Encoding')
    expect(compressed.headers.etag).toMatch(/^[a-f\d]{64}-gzip$/u)
    expect(gunzipSync(compressed.rawBody)).toEqual(batch.rawBody)
    expect(compressed.rawBody.byteLength).toBeLessThan(batch.rawBody.byteLength)

    const compressedCached = await request(instance.address().port, path, {
      headers: {
        ...headers,
        'accept-encoding': 'gzip',
        'if-none-match': String(compressed.headers.etag),
      },
    })
    expect(compressedCached.status).toBe(304)
    expect(compressedCached.headers.vary).toBe('Accept-Encoding')

    const cached = await request(instance.address().port, path, {
      headers: { ...headers, 'if-none-match': String(batch.headers.etag) },
    })
    expect(cached.status).toBe(304)
    const unauthenticated = await request(instance.address().port, path, { headers: browserHeaders(instance) })
    expect(unauthenticated.status).toBe(401)
    expect(inner.observations.map(observation => observation.url)).toContain('/plugins/renderer.js?rev=renderer')
    expect(inner.observations.map(observation => observation.url)).toContain('/plugins/feature.js?rev=feature')
    expect(inner.observations.map(observation => observation.url)).not.toContain('/plugins/layout.js?rev=layout')
    expect(inner.observations.map(observation => observation.url)).not.toContain('/plugins/application.js?rev=stock')
  })

  it('omits an optional module from the served graph, size probes, and assembled mobile batch only', async () => {
    const inner = await upstream('batched')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-exclusion-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    await writeFile(mobileLayoutFile, 'globalThis.__dedicatedMobileLayout = true;\n', 'utf8')
    const instance = await gateway(inner.port, { excludedClientModules: ['feature'], mobileLayoutFile })
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }
    const page = await request(instance.address().port, '/', { headers })
    expect(page.status).toBe(200)
    expect(page.body).not.toContain('"id":"feature"')
    const path = /"url":"(\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js)"/u.exec(page.body)?.[1]
    expect(path).toBeDefined()
    expect(page.body).not.toContain('href="/plugins/application.js?rev=stock"')
    expect(page.body).toContain(`<link rel="preload" as="script" href="${path}">`)
    const batch = await request(instance.address().port, path!, { headers })
    expect(batch.status).toBe(200)
    expect(batch.body).not.toContain('/plugins/feature.js?rev=feature')
    expect(inner.observations.map(observation => observation.url)).not.toContain('/plugins/feature.js?rev=feature')

    const stock = await request(instance.address().port, '/?frontend=stock', { headers })
    expect(stock.status).toBe(200)
    expect(stock.body).toContain('"id":"feature"')
  })

  it('reassembles a partially excluded second application batch without fetching its old preload', async () => {
    const inner = await upstream('batched', false, Buffer.alloc(0), [], undefined, undefined, 1, 2)
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-second-batch-exclusion-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    await writeFile(mobileLayoutFile, 'globalThis.__dedicatedMobileLayout = true;\n', 'utf8')
    const instance = await gateway(inner.port, { excludedClientModules: ['feature'], mobileLayoutFile })
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance), accept: 'text/html', cookie: `${SESSION_COOKIE}=${paired.session}`,
    }
    const page = await request(instance.address().port, '/', { headers })
    expect(page.status).toBe(200)
    expect(page.body).not.toContain('"id":"feature"')
    expect(page.body).not.toContain('href="/plugins/application.js?rev=stock"')
    expect(page.body).not.toContain('href="/plugins/application-2.js?rev=stock"')
    const paths = [...page.body.matchAll(/"url":"(\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js)"/gu)].map(match => match[1]!)
    expect(paths).toHaveLength(2)
    const bodies: string[] = []
    for (const path of paths) {
      expect(page.body).toContain(`<link rel="preload" as="script" href="${path}">`)
      const batch = await request(instance.address().port, path, { headers })
      expect(batch.status).toBe(200)
      expect(batch.body).not.toContain('/plugins/feature.js?rev=feature')
      bodies.push(batch.body)
    }
    expect(bodies.some(body => body.includes('/plugins/feature-0.js?rev=feature-0'))).toBe(true)
    expect(bodies.some(body => body.includes('__dedicatedMobileLayout = true'))).toBe(true)
    expect(inner.observations.map(observation => observation.url)).toContain('/plugins/feature-0.js?rev=feature-0')
    expect(inner.observations.map(observation => observation.url)).not.toContain('/plugins/feature.js?rev=feature')
    expect(inner.observations.map(observation => observation.url)).not.toContain('/plugins/application-2.js?rev=stock')
  })

  it('reports a selected module missing from the live graph without serving a partial page', async () => {
    const inner = await upstream('batched')
    const instance = await gateway(inner.port, { excludedClientModules: ['feature-missing'] })
    const paired = await pair(instance)
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    try {
      const page = await request(instance.address().port, '/', {
        headers: { ...browserHeaders(instance), accept: 'text/html', cookie: `${SESSION_COOKIE}=${paired.session}` },
      })
      expect(page.status).toBe(409)
      expect(JSON.parse(page.body)).toEqual({
        error: 'excluded_client_modules_invalid',
        detail: 'excludedClientModules: module feature-missing is not installed in this DSH client graph',
      })
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('module feature-missing is not installed'), {
        code: 'DSH_MOBILE_MODULE_EXCLUSION_INVALID',
      })
    } finally {
      warning.mockRestore()
    }
  })

  it('refuses a manifest that would evict one of its own merged boot plans', async () => {
    const inner = await upstream('batched', false, Buffer.alloc(0), [], undefined, undefined, 30)
    const instance = await gateway(inner.port)
    const measured = instance as unknown as { upstreamBundleSize(source: string): Promise<number> }
    measured.upstreamBundleSize = async () => 5 * 1024 * 1024
    const paired = await pair(instance)
    const page = await request(instance.address().port, '/', {
      headers: { ...browserHeaders(instance), accept: 'text/html', cookie: `${SESSION_COOKIE}=${paired.session}` },
    })
    expect(page.status).toBe(502)
    expect(page.body).not.toContain('window.__DSH_BOOT__')
  })

  it('keeps the mobile boot resource and ETag stable when upstream batch entries reorder', async () => {
    const inner = await upstream('batched')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-batch-order-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    await writeFile(mobileLayoutFile, 'globalThis.__dedicatedMobileLayout = true;\n', 'utf8')

    const firstGateway = await gateway(inner.port, { mobileLayoutFile })
    const firstPairing = await pair(firstGateway)
    const firstHeaders = {
      ...browserHeaders(firstGateway),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${firstPairing.session}`,
    }
    const firstPage = await request(firstGateway.address().port, '/', { headers: firstHeaders })
    const firstPath = /"url":"(\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js)"/u.exec(firstPage.body)?.[1]
    expect(firstPath).toBeDefined()
    const firstBatch = await request(firstGateway.address().port, firstPath!, { headers: firstHeaders })
    expect(firstBatch.status).toBe(200)

    inner.setBatchEntriesReversed(true)
    const secondGateway = await gateway(inner.port, { mobileLayoutFile })
    const secondPairing = await pair(secondGateway)
    const secondHeaders = {
      ...browserHeaders(secondGateway),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${secondPairing.session}`,
    }
    const secondPage = await request(secondGateway.address().port, '/', { headers: secondHeaders })
    const secondPath = /"url":"(\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js)"/u.exec(secondPage.body)?.[1]
    expect(secondPath).toBe(firstPath)
    const cached = await request(secondGateway.address().port, secondPath!, {
      headers: { ...secondHeaders, 'if-none-match': String(firstBatch.headers.etag) },
    })
    expect(cached.status).toBe(304)
    expect(cached.rawBody).toHaveLength(0)
    const secondBatch = await request(secondGateway.address().port, secondPath!, { headers: secondHeaders })
    expect(secondBatch.status).toBe(200)
    expect(secondBatch.rawBody).toEqual(firstBatch.rawBody)
    expect(secondBatch.headers.etag).toBe(firstBatch.headers.etag)
  })

  it('serves a DSH 0.1.7 mobile application batch with document-relative plugin URLs', async () => {
    const inner = await upstream('batched-relative')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-relative-layout-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    await writeFile(mobileLayoutFile, 'globalThis.__dedicatedMobileLayout = true;\n', 'utf8')
    const instance = await gateway(inner.port, { mobileLayoutFile })
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const mobile = await request(instance.address().port, '/', { headers })
    expect(mobile.status).toBe(200)
    const path = /"url":"(\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js)"/u.exec(mobile.body)?.[1]
    expect(path).toBeDefined()
    const batch = await request(instance.address().port, path!, { headers })
    expect(batch.status).toBe(200)
    expect(batch.body).toContain('/plugins/??@deepseek-ai/dsh-client-ui-renderer/client.js&rev=renderer')
    expect(batch.body).toContain('__dedicatedMobileLayout = true')
    expect(batch.body).toContain('/plugins/??feature/client.js&rev=feature')
    expect(batch.body).not.toContain('/plugins/??@deepseek-ai/dsh-client-ui-layout/client.js&rev=layout')
    expect(inner.observations.filter(entry => entry.headers['x-dsh-mobile-size-probe'] === '1').map(entry => entry.url))
      .toContain('/plugins/??@deepseek-ai/dsh-client-ui-renderer/client.js&rev=renderer')
  })

  it('does not pass through a document-relative plugin URL that escapes /plugins', async () => {
    const inner = await upstream('batched-relative-invalid')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-invalid-layout-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    await writeFile(mobileLayoutFile, 'globalThis.__dedicatedMobileLayout = true;\n', 'utf8')
    const instance = await gateway(inner.port, { mobileLayoutFile })
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const mobile = await request(instance.address().port, '/', { headers })
    expect(mobile.status).toBe(200)
    const path = /"url":"(\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js)"/u.exec(mobile.body)?.[1]
    expect(path).toBeDefined()
    const batch = await request(instance.address().port, path!, { headers })
    expect(batch.status).toBe(502)
    expect(inner.observations.map(entry => entry.url)).not.toContain('/api/secret')
  })

  it('does not retry a deterministic bundle response and permits the next assembly to recover', async () => {
    let rejectRenderer = true
    const fixture = await mobileBatchFixture((incoming, response) => {
      if (incoming.headers['x-dsh-mobile-size-probe'] !== undefined) return false
      if (!rejectRenderer || incoming.method !== 'GET' || incoming.url !== '/plugins/renderer.js?rev=renderer') return false
      response.writeHead(503, { 'content-type': 'text/plain' })
      response.end('temporarily unavailable')
      return true
    })

    const failed = await request(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    expect(failed.status).toBe(502)
    expect(JSON.parse(failed.body)).toEqual({ error: 'upstream_unavailable' })
    expect(fixture.inner.observations.filter(entry => entry.method === 'GET' && entry.headers['x-dsh-mobile-size-probe'] === undefined && entry.url === '/plugins/renderer.js?rev=renderer')).toHaveLength(1)

    rejectRenderer = false
    const recovered = await request(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    expect(recovered.status).toBe(200)
    expect(recovered.body).toContain('/plugins/renderer.js?rev=renderer')
    expect(fixture.inner.observations.filter(entry => entry.method === 'GET' && entry.headers['x-dsh-mobile-size-probe'] === undefined && entry.url === '/plugins/renderer.js?rev=renderer')).toHaveLength(2)
  })

  it('retries a transient upstream reset while assembling a mobile batch', async () => {
    let resetRenderer = true
    const fixture = await mobileBatchFixture((incoming) => {
      if (incoming.headers['x-dsh-mobile-size-probe'] !== undefined) return false
      if (!resetRenderer || incoming.method !== 'GET' || incoming.url !== '/plugins/renderer.js?rev=renderer') return false
      resetRenderer = false
      incoming.socket.destroy()
      return true
    })

    const batch = await request(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    expect(batch.status).toBe(200)
    expect(batch.body).toContain('/plugins/renderer.js?rev=renderer')
    expect(fixture.inner.observations.filter(entry => entry.method === 'GET' && entry.headers['x-dsh-mobile-size-probe'] === undefined && entry.url === '/plugins/renderer.js?rev=renderer')).toHaveLength(2)
  })

  it('reuses one in-flight assembly for concurrent mobile batch requests', async () => {
    let releaseBundles!: () => void
    const bundlesReleased = new Promise<void>(resolve => { releaseBundles = resolve })
    const fixture = await mobileBatchFixture(async (incoming) => {
      if (incoming.headers['x-dsh-mobile-size-probe'] !== undefined || incoming.method !== 'GET') return false
      await bundlesReleased
      return false
    })

    const first = beginRequest(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    await vi.waitFor(() => {
      expect(fixture.inner.observations.filter(entry => entry.method === 'GET' && entry.headers['x-dsh-mobile-size-probe'] === undefined && entry.url.startsWith('/plugins/'))).toHaveLength(2)
    })
    const second = beginRequest(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    await vi.waitFor(() => { expect(activeRequestCount(fixture.instance)).toBe(2) })

    releaseBundles()
    const [firstResult, secondResult] = await Promise.all([first.result, second.result])
    expect(firstResult.status).toBe(200)
    expect(secondResult.status).toBe(200)
    expect(secondResult.rawBody).toEqual(firstResult.rawBody)
    expect(fixture.inner.observations.filter(entry => entry.method === 'GET' && entry.headers['x-dsh-mobile-size-probe'] === undefined && entry.url.startsWith('/plugins/'))).toHaveLength(2)
  })

  it('keeps a shared mobile batch assembly alive when its first requester disconnects', async () => {
    let releaseBundles!: () => void
    const bundlesReleased = new Promise<void>(resolve => { releaseBundles = resolve })
    const fixture = await mobileBatchFixture(async (incoming) => {
      if (incoming.headers['x-dsh-mobile-size-probe'] !== undefined || incoming.method !== 'GET') return false
      await bundlesReleased
      return false
    })

    const first = beginRequest(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    await vi.waitFor(() => {
      expect(fixture.inner.observations.filter(entry => entry.method === 'GET' && entry.headers['x-dsh-mobile-size-probe'] === undefined && entry.url.startsWith('/plugins/'))).toHaveLength(2)
    })
    first.outgoing.destroy(new Error('test requester disconnected'))
    await first.result.catch(() => undefined)
    await vi.waitFor(() => { expect(activeRequestCount(fixture.instance)).toBe(0) })

    const second = beginRequest(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    await vi.waitFor(() => { expect(activeRequestCount(fixture.instance)).toBe(1) })
    releaseBundles()
    const result = await second.result
    expect(result.status).toBe(200)
    expect(result.body).toContain('/plugins/renderer.js?rev=renderer')
    expect(fixture.inner.observations.filter(entry => entry.method === 'GET' && entry.headers['x-dsh-mobile-size-probe'] === undefined && entry.url.startsWith('/plugins/'))).toHaveLength(2)
  })

  it('aborts an assembly during retry teardown without issuing another upstream request', async () => {
    let reportReset!: () => void
    const resetObserved = new Promise<void>(resolve => { reportReset = resolve })
    const fixture = await mobileBatchFixture((incoming) => {
      if (incoming.headers['x-dsh-mobile-size-probe'] !== undefined || incoming.method !== 'GET' || incoming.url !== '/plugins/renderer.js?rev=renderer') return false
      reportReset()
      incoming.socket.destroy()
      return true
    })

    const pending = beginRequest(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    await resetObserved
    const assembly = activeMobileBatchTask(fixture.instance)
    expect(assembly).toBeDefined()
    await fixture.instance.close()
    await expect(assembly).rejects.toBeDefined()
    await pending.result.catch(() => undefined)
    expect(fixture.inner.observations.filter(entry => entry.method === 'GET' && entry.headers['x-dsh-mobile-size-probe'] === undefined && entry.url === '/plugins/renderer.js?rev=renderer')).toHaveLength(1)
  })

  it('passes an oversized entry through its own batch while merging the rest', async () => {
    const layoutId = '@deepseek-ai/dsh-client-ui-layout'
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-oversized-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    await writeFile(mobileLayoutFile, 'globalThis.__dedicatedMobileLayout = true;\n', 'utf8')
    const oversizedBytes = 9 * 1024 * 1024
    const graph = {
      rev: 'stock',
      entries: [
        { id: 'small', url: '/plugins/small.js?rev=small', rev: 'small' },
        { id: 'huge', url: '/plugins/huge.js?rev=huge', rev: 'huge' },
        { id: layoutId, url: '/plugins/layout.js?rev=layout', rev: 'layout', inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-theme'] },
        { id: 'feature', url: '/plugins/feature.js?rev=feature', rev: 'feature' },
      ],
      batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock-batch', entries: ['small', 'huge', layoutId, 'feature'] }],
    }
    const inner = createServer((incoming, response) => {
      if (incoming.url === '/' && incoming.headers.accept?.includes('text/html')) {
        const body = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)};</script></head><body></body></html>`
        response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) })
        response.end(body)
        return
      }
      if (incoming.url === '/plugins/huge.js?rev=huge' && incoming.headers['x-dsh-mobile-size-probe'] !== undefined) {
        response.writeHead(200, { 'content-type': 'text/javascript' })
        response.end(Buffer.alloc(oversizedBytes, 0x78))
        return
      }
      if (incoming.url?.startsWith('/plugins/') === true) {
        const body = `globalThis.__loadedMobile = ${JSON.stringify(incoming.url)};\n`
        response.writeHead(200, { 'content-type': 'text/javascript', 'content-length': Buffer.byteLength(body) })
        response.end(body)
        return
      }
      response.writeHead(404)
      response.end()
    })
    const port = await listen(inner)
    cleanups.push(() => closeServer(inner))
    const instance = await gateway(port, { mobileLayoutFile })
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const mobile = await request(instance.address().port, '/', { headers })
    expect(mobile.status).toBe(200)
    const bootMatch = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{.*\});/u.exec(mobile.body)
    expect(bootMatch?.[1]).toBeDefined()
    const rewritten = JSON.parse(bootMatch![1]!) as { entries: Array<{ id: string; url: string }>; batches: Array<{ phase: string; url: string; entries: string[] }> }
    const rows = rewritten.batches.filter(batch => batch.phase === 'application')
    const merged = rows.find(row => row.url.startsWith('/mobile-access/mobile-boot/'))
    const solo = rows.find(row => row.url === '/plugins/huge.js?rev=huge')
    expect(merged?.entries).toEqual(expect.arrayContaining(['small', layoutId, 'feature']))
    expect(merged?.entries).not.toContain('huge')
    expect(solo?.entries).toEqual(['huge'])
    expect(solo?.url).toBe('/plugins/huge.js?rev=huge')

    const batch = await request(instance.address().port, merged!.url, { headers })
    expect(batch.status).toBe(200)
    expect(batch.body).toContain('/plugins/small.js?rev=small')
    expect(batch.body).toContain('__dedicatedMobileLayout = true')
    expect(batch.body).toContain('/plugins/feature.js?rev=feature')
    expect(batch.body).not.toContain('/plugins/huge.js?rev=huge')
  })

  it('retries a transient upstream reset when proxying a pass-through client bundle', async () => {
    const layoutId = '@deepseek-ai/dsh-client-ui-layout'
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-passthrough-retry-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const mobileLayoutFile = join(directory, 'mobile-layout.js')
    await writeFile(mobileLayoutFile, 'globalThis.__dedicatedMobileLayout = true;\n', 'utf8')
    const oversizedBytes = 9 * 1024 * 1024
    let resetNext = true
    const passthroughObservations: string[] = []
    const graph = {
      rev: 'stock',
      entries: [
        { id: layoutId, url: '/plugins/layout.js?rev=layout', rev: 'layout', inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-theme'] },
        { id: 'huge', url: '/plugins/huge.js?rev=huge', rev: 'huge' },
      ],
      batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock-batch', entries: [layoutId, 'huge'] }],
    }
    const inner = createServer((incoming, response) => {
      if (incoming.url === '/' && incoming.headers.accept?.includes('text/html')) {
        const body = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)};</script></head><body></body></html>`
        response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) })
        response.end(body)
        return
      }
      if (incoming.url === '/plugins/huge.js?rev=huge' && incoming.headers['x-dsh-mobile-size-probe'] !== undefined) {
        response.writeHead(200, { 'content-type': 'text/javascript' })
        response.end(Buffer.alloc(oversizedBytes, 0x78))
        return
      }
      if (incoming.url === '/plugins/huge.js?rev=huge' && incoming.method === 'GET') {
        passthroughObservations.push('GET')
        if (resetNext) {
          resetNext = false
          incoming.socket.destroy()
          return
        }
        const body = 'globalThis.__loadedHuge = true;\n'
        response.writeHead(200, { 'content-type': 'text/javascript', 'content-length': Buffer.byteLength(body) })
        response.end(body)
        return
      }
      if (incoming.url?.startsWith('/plugins/') === true) {
        const body = `globalThis.__loadedMobile = ${JSON.stringify(incoming.url)};\n`
        response.writeHead(200, { 'content-type': 'text/javascript', 'content-length': Buffer.byteLength(body) })
        response.end(body)
        return
      }
      response.writeHead(404)
      response.end()
    })
    const port = await listen(inner)
    cleanups.push(() => closeServer(inner))
    const instance = await gateway(port, { mobileLayoutFile })
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const mobile = await request(instance.address().port, '/', { headers })
    expect(mobile.status).toBe(200)
    const passthrough = await request(instance.address().port, '/plugins/huge.js?rev=huge', {
      headers: { ...headers, accept: '*/*' },
    })
    expect(passthrough.status).toBe(200)
    expect(passthrough.body).toContain('__loadedHuge = true')
    expect(passthroughObservations).toEqual(['GET', 'GET'])
  })

  it('retries a transient upstream reset when proxying a hashed asset', async () => {
    let resetNext = true
    const assetObservations: string[] = []
    const inner = createServer((incoming, response) => {
      if (incoming.url === '/assets/index-5SrrfWpU.js' && incoming.method === 'GET') {
        assetObservations.push('GET')
        if (resetNext) {
          resetNext = false
          incoming.socket.destroy()
          return
        }
        const body = 'globalThis.__loadedAsset = true;\n'
        response.writeHead(200, { 'content-type': 'text/javascript', 'content-length': Buffer.byteLength(body) })
        response.end(body)
        return
      }
      response.writeHead(404)
      response.end()
    })
    const port = await listen(inner)
    cleanups.push(() => closeServer(inner))
    const instance = await gateway(port)
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: '*/*',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const asset = await request(instance.address().port, '/assets/index-5SrrfWpU.js', { headers })
    expect(asset.status).toBe(200)
    expect(asset.body).toContain('__loadedAsset = true')
    expect(assetObservations).toEqual(['GET', 'GET'])
  })

  it('keeps the DSH 0.1.2 browser-auth cookie inside the authenticated mobile gateway', async () => {
    const inner = await upstream('batched', true)
    const authenticatedUrl = `http://127.0.0.1:${String(inner.port)}/?token=${UPSTREAM_LAUNCH_TOKEN}`
    const instance = await gateway(inner.port, {}, undefined, authenticatedUrl)
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      accept: 'text/html,application/xhtml+xml',
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const mobile = await request(instance.address().port, '/', { headers })
    expect(mobile.status).toBe(200)
    expect(mobile.headers['set-cookie']).toBeUndefined()
    const asset = await request(instance.address().port, '/assets/app.js', { headers })
    expect(asset.status).toBe(200)
    expect(asset.headers['set-cookie']).toBeUndefined()
    const opened = await openWebSocket(instance, '/api/remote.mux', paired.session)
    expect(opened.response).toContain('101 Switching Protocols')
    opened.socket.destroy()

    expect(inner.observations.filter(observation => observation.url?.includes('token=')).length).toBe(1)
    for (const observed of inner.observations.filter(observation => !observation.url.includes('token='))) {
      expect(observed.headers.cookie).toBe(UPSTREAM_BROWSER_COOKIE)
    }
    expect(inner.upgradeObservations).toHaveLength(1)
    expect(inner.upgradeObservations[0]?.cookie).toBe(UPSTREAM_BROWSER_COOKIE)
  })

  it('keeps pairing and device management on a loopback Host-fenced route', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const route = instance.localAdminRoute()
    const adminServer = createServer((incoming, response) => {
      void route.handler(incoming, response)
    })
    const adminPort = await listen(adminServer)
    cleanups.push(() => closeServer(adminServer))
    const host = `127.0.0.1:${String(adminPort)}`

    const rebound = await request(adminPort, '/api/mobile-access/status', {
      headers: { host: 'attacker.example' },
    })
    expect(rebound.status).toBe(403)
    const opened = await request(adminPort, '/api/mobile-access/pairing/open', {
      method: 'POST',
      headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(opened.status).toBe(201)
    const pairing = JSON.parse(opened.body) as { token: string; appKey: string; pairUrl: string; appPairUrl: string; qrSvg?: string }
    expect(pairing.token).toMatch(/^[\w-]{43}$/)
    expect(pairing.appKey).toBe(`dsh1.${instance.config.instanceId}.${pairing.token}`)
    expect(pairing.pairUrl).toBe(`${instance.address().origin}/mobile-access/pair#instance=${instance.config.instanceId}&token=${pairing.token}`)
    expect(pairing.pairUrl).not.toContain(`?token=${pairing.token}`)
    expect(pairing.appPairUrl).toBe(pairing.pairUrl)
    expect(pairing.qrSvg).toContain('<svg')

    const paired = await request(instance.address().port, '/mobile-access/auth/pair', {
      method: 'POST',
      headers: { ...browserHeaders(instance), 'content-type': 'application/json' },
      body: JSON.stringify({ token: pairing.token, label: 'Managed phone' }),
    })
    expect(paired.status).toBe(201)
    const pairedBody = JSON.parse(paired.body) as { deviceId: string }
    const listed = await request(adminPort, '/api/mobile-access/devices', { headers: { host } })
    expect(listed.status).toBe(200)
    expect(listed.body).toContain('Managed phone')
    expect(listed.body).not.toContain('tokenDigest')
    expect(listed.body).not.toContain(pairing.token)

    const revoked = await request(adminPort, '/api/mobile-access/devices/revoke', {
      method: 'POST',
      headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: pairedBody.deviceId }),
    })
    expect(revoked.status).toBe(200)
    const resetWithoutConfirmation = await request(adminPort, '/api/mobile-access/devices/reset', {
      method: 'POST',
      headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{}',
    })
    expect(resetWithoutConfirmation.status).toBe(400)
    const reset = await request(adminPort, '/api/mobile-access/devices/reset', {
      method: 'POST',
      headers: { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: '{"confirm":true}',
    })
    expect(reset.status).toBe(200)
  })

  it('never trusts X-Forwarded-For for pairing rate-limit identity', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, { maxPairingAttempts: 2 })
    const statuses: number[] = []
    for (const forwarded of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      const attempted = await request(instance.address().port, '/mobile-access/auth/pair', {
        method: 'POST',
        headers: {
          ...browserHeaders(instance),
          'content-type': 'application/json',
          'x-forwarded-for': forwarded,
        },
        body: JSON.stringify({ token: 'invalid' }),
      })
      statuses.push(attempted.status)
    }
    expect(statuses).toEqual([401, 401, 429])
  })

  it('discovers one instance and renews a native long-lived device credential', async () => {
    const inner = await upstream()
    const instanceId = 'a'.repeat(64)
    const instance = await gateway(inner.port, { instanceId })
    const discovered = await request(instance.address().port, '/mobile-access/discovery', {
      headers: { host: new URL(instance.address().origin).host },
    })
    expect(discovered.status).toBe(200)
    expect(JSON.parse(discovered.body)).toEqual({
      deviceName: expect.any(String),
      origin: instance.address().origin,
      port: instance.address().port,
      protocol: 1,
      instanceId,
    })
    const discovery = await udpDiscovery(instance.address().port).catch(error => {
      throw new Error(`UDP discovery failed: ${JSON.stringify(instance.discoveryStatus())}`, { cause: error })
    })
    expect(discovery).toEqual({
      deviceName: expect.any(String),
      origin: instance.address().origin,
      port: instance.address().port,
      protocol: 1,
      instanceId,
    })

    const opened = await instance.access.openPairing()
    const paired = await request(instance.address().port, '/mobile-access/auth/native-pair', {
      method: 'POST',
      headers: { ...browserHeaders(instance), 'content-type': 'application/json' },
      body: JSON.stringify({ token: opened.token, label: 'DeepSeek Harness Android' }),
    })
    expect(paired.status).toBe(201)
    expect(paired.headers['set-cookie']).toBeUndefined()
    const credential = JSON.parse(paired.body) as { instanceId: string; deviceId: string; deviceToken: string; sessionToken: string }
    expect(credential.instanceId).toBe(instanceId)
    expect(credential.deviceToken).toMatch(/^[\w-]{43}$/u)
    expect(credential.sessionToken).toMatch(/^[\w-]{43}$/u)

    const sessionsBeforeProbe = instance.access.metrics().sessions
    const probe = await request(instance.address().port, '/mobile-access/auth/native-probe', {
      method: 'POST',
      headers: { ...browserHeaders(instance), 'content-type': 'application/json' },
      body: JSON.stringify({ deviceToken: credential.deviceToken }),
    })
    expect(probe.status).toBe(200)
    expect(JSON.parse(probe.body)).toEqual({ instanceId, deviceId: expect.any(String), deviceExpiresAt: expect.any(Number) })
    expect(instance.access.metrics().sessions).toBe(sessionsBeforeProbe)
    const unknownProbe = await request(instance.address().port, '/mobile-access/auth/native-probe', {
      method: 'POST',
      headers: { ...browserHeaders(instance), 'content-type': 'application/json' },
      body: JSON.stringify({ deviceToken: 'Z'.repeat(43) }),
    })
    expect(unknownProbe.status).toBe(401)
    expect(JSON.parse(unknownProbe.body)).toEqual({ error: 'authentication_failed' })

    const renewed = await request(instance.address().port, '/mobile-access/auth/native-renew', {
      method: 'POST',
      headers: { ...browserHeaders(instance), 'content-type': 'application/json' },
      body: JSON.stringify({ deviceToken: credential.deviceToken }),
    })
    expect(renewed.status).toBe(200)
    expect(JSON.parse(renewed.body)).toMatchObject({ instanceId, deviceId: expect.any(String) })
    expect(await instance.access.revokeDevice(credential.deviceId)).toBe(true)
    const revokedProbe = await request(instance.address().port, '/mobile-access/auth/native-probe', {
      method: 'POST',
      headers: { ...browserHeaders(instance), 'content-type': 'application/json' },
      body: JSON.stringify({ deviceToken: credential.deviceToken }),
    })
    expect(revokedProbe.status).toBe(401)
    expect(JSON.parse(revokedProbe.body)).toEqual({ error: 'authentication_failed' })
  })

  it('starts and serves when the discovery port cannot be bound for UDP', async () => {
    // Windows keeps separate TCP and UDP port-exclusion tables, so the port the OS handed
    // the TCP listener can be unavailable for the discovery socket, and another process may
    // already hold it. Broadcast discovery is a convenience: degrading must not fail start.
    // reuseAddr is pinned off so the occupant really blocks the bind rather than relying on
    // the helper's loopback listenHost to make the two addresses collide.
    const occupant = createSocket({ type: 'udp4', reuseAddr: false })
    await new Promise<void>((resolve, reject) => {
      occupant.once('error', reject)
      occupant.bind(TEST_DISCOVERY_BUSY_PORT, '127.0.0.1', () => resolve())
    })
    cleanups.push(async () => { occupant.close() })

    const inner = await upstream()
    const instance = await gateway(inner.port, { listenPort: TEST_DISCOVERY_BUSY_PORT })
    expect(instance.address().port).toBe(TEST_DISCOVERY_BUSY_PORT)
    const discovered = await request(instance.address().port, '/mobile-access/discovery', {
      headers: { host: new URL(instance.address().origin).host },
    })
    expect(discovered.status).toBe(200)
    expect(JSON.parse(discovered.body)).toMatchObject({ port: TEST_DISCOVERY_BUSY_PORT, protocol: 1 })
    // Assert the degraded state itself. Checking only that the page still serves would keep
    // passing if the bind silently started succeeding, and the whole point of the
    // degradation is that it stays observable. The status route lives on the loopback
    // admin surface, not the public listener.
    const route = instance.localAdminRoute()
    const adminServer = createServer((incoming, response) => { void route.handler(incoming, response) })
    const adminPort = await listen(adminServer)
    cleanups.push(() => closeServer(adminServer))
    const status = await request(adminPort, '/api/mobile-access/status', {
      headers: { host: `127.0.0.1:${String(adminPort)}` },
    })
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toMatchObject({
      discovery: { broadcast: false, mdns: true, errorCode: 'discovery_broadcast_EADDRINUSE' },
    })
  })

  it('keeps the gateway alive when Bonjour reports a multicast response failure', async () => {
    const inner = await upstream()
    const degraded: string[] = []
    const instance = await gateway(inner.port, {}, undefined, undefined, [], undefined, (source, code) => {
      degraded.push(`${source}:${code}`)
    })
    const bonjour = (instance as unknown as {
      bonjour?: { server: { errorCallback: (error: Error) => void } }
    }).bonjour
    expect(bonjour).toBeDefined()
    expect(() => bonjour!.server.errorCallback(Object.assign(new Error('network changed'), { code: 'ENETUNREACH' })))
      .not.toThrow()
    expect(instance.discoveryStatus()).toMatchObject({ mdns: false, mdnsErrorCode: 'discovery_mdns_ENETUNREACH' })
    expect(degraded).toEqual(['mdns:ENETUNREACH'])
    expect((await request(instance.address().port, '/mobile-access/discovery', {
      headers: { host: new URL(instance.address().origin).host },
    })).status).toBe(200)
  })

  it('keeps the gateway alive when multicast-dns emits an error', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const bonjour = (instance as unknown as {
      bonjour?: { server: { mdns: { emit(event: string, error: Error): boolean } } }
    }).bonjour
    expect(bonjour).toBeDefined()
    expect(() => bonjour!.server.mdns.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' })))
      .not.toThrow()
    expect(instance.discoveryStatus()).toMatchObject({ mdns: false, mdnsErrorCode: 'discovery_mdns_EADDRINUSE' })
    const route = instance.localAdminRoute()
    const adminServer = createServer((incoming, response) => { void route.handler(incoming, response) })
    const adminPort = await listen(adminServer)
    cleanups.push(() => closeServer(adminServer))
    const status = await request(adminPort, '/api/mobile-access/status', {
      headers: { host: `127.0.0.1:${String(adminPort)}` },
    })
    expect(JSON.parse(status.body)).toMatchObject({
      discovery: { mdns: false, mdnsErrorCode: 'discovery_mdns_EADDRINUSE' },
    })
  })

  it('keeps HTTP and mDNS alive after a running broadcast socket fails', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const socket = (instance as unknown as { discoverySocket?: ReturnType<typeof createSocket> }).discoverySocket
    if (socket === undefined) {
      // Some Windows hosts refuse UDP on the port assigned to the TCP listener.
      // That startup degradation is covered above; only a bound socket can emit
      // the running-socket error exercised here on hosts where binding succeeds.
      expect(instance.discoveryStatus()).toMatchObject({ broadcast: false, errorCode: expect.any(String) })
      return
    }
    expect(() => socket.emit('error', Object.assign(new Error('network changed'), { code: 'ENETDOWN' }))).not.toThrow()
    expect(instance.discoveryStatus()).toMatchObject({ broadcast: false, mdns: true, errorCode: 'discovery_broadcast_ENETDOWN' })
    expect((await request(instance.address().port, '/mobile-access/discovery', {
      headers: { host: new URL(instance.address().origin).host },
    })).status).toBe(200)
  })

  it('reports a missing bundled mobile asset instead of leaving a silent 503 subresource', async () => {
    // The served index references the compatibility bundle, so a missing file would
    // otherwise only show up as a failed subresource while the page itself looks fine.
    const inner = await upstream()
    const instance = await gateway(inner.port, {
      mobileCompatibilityFile: join(tmpdir(), `dsh-mobile-absent-${crypto.randomUUID()}.js`),
    })
    const route = instance.localAdminRoute()
    const adminServer = createServer((incoming, response) => { void route.handler(incoming, response) })
    const adminPort = await listen(adminServer)
    cleanups.push(() => closeServer(adminServer))
    const status = await request(adminPort, '/api/mobile-access/status', {
      headers: { host: `127.0.0.1:${String(adminPort)}` },
    })
    // Assert containment rather than an exact value: the layout asset resolves
    // differently under the test runner than in the built package.
    const reported = (JSON.parse(status.body) as { discovery?: { mobileAssetsErrorCode?: string } }).discovery?.mobileAssetsErrorCode
    expect(reported).toContain('mobile_assets_missing_')
    expect(reported).toContain('compatibility')
  })

  it('keeps discovery metadata-only and offers the CA on a separate endpoint', async () => {
    const inner = await upstream()
    const files = await tlsFixtureFiles()
    const root = new X509Certificate(await readFile(files.root))
    const instanceId = root.fingerprint256.replaceAll(':', '').toLowerCase()
    const instance = await gateway(inner.port, {
      instanceId,
      pairingCaFile: files.root,
      tls: { mode: 'provided', certFile: files.leaf, keyFile: files.key, caFile: files.intermediate },
    })
    const discovered = await udpDiscovery(instance.address().port)
    expect(Object.keys(discovered).sort()).toEqual(['deviceName', 'instanceId', 'origin', 'port', 'protocol'])
    const certificate = await trustedHttpsRequest(instance.address().port, '/mobile-access/ca.cer', await readFile(files.root, 'utf8'))
    expect(certificate.status).toBe(200)
    expect(certificate.headers['content-type']).toBe('application/pkix-cert')
    expect(certificate.rawBody).toEqual(root.raw)
  })

  it('publishes version compatibility separately from the stable discovery protocol', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const metadata = await request(instance.address().port, '/mobile-access/metadata', {
      headers: { host: new URL(instance.address().origin).host },
    })

    expect(metadata.status).toBe(200)
    expect(JSON.parse(metadata.body)).toEqual({
      version: 1,
      pluginVersion: DSH_MOBILE_VERSION,
      minimumAndroidAppVersion: MINIMUM_ANDROID_APP_VERSION,
      discoveryProtocol: 1,
    })
  })

  it('pairs only from the exact origin, hides local admin, and preserves authenticated remote authority', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const opened = await instance.access.openPairing()
    const base = browserHeaders(instance)

    const wrongHost = await request(instance.address().port, '/mobile-access/auth/pair', {
      method: 'POST',
      headers: { ...base, host: 'attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ token: opened.token }),
    })
    expect(wrongHost.status).toBe(403)
    const wrongOrigin = await request(instance.address().port, '/mobile-access/auth/pair', {
      method: 'POST',
      headers: { ...base, origin: 'http://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ token: opened.token }),
    })
    expect(wrongOrigin.status).toBe(403)

    const paired = await request(instance.address().port, '/mobile-access/auth/pair', {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/json' },
      body: JSON.stringify({ token: opened.token, label: 'Phone' }),
    })
    expect(paired.status).toBe(201)
    expect(paired.headers['strict-transport-security']).toBeUndefined()
    expect(paired.headers['content-security-policy']).toContain("default-src 'self'")
    expect(paired.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
    expect(paired.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'")
    const body = JSON.parse(paired.body) as { csrfToken: string }
    const cookies = cookiesByName(paired.headers)
    const session = cookies.get(SESSION_COOKIE) ?? ''

    const admin = await request(instance.address().port, '/api/mobile-access/status', { headers: base })
    expect(admin.status).toBe(404)
    const anonymous = await request(instance.address().port, '/', { headers: base })
    expect(anonymous.status).toBe(401)
    const rejectedPost = await request(instance.address().port, '/api/run', {
      method: 'POST',
      headers: { host: base.host!, cookie: `${SESSION_COOKIE}=${session}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(rejectedPost.status).toBe(403)

    const rejectedPluginPost = await request(instance.address().port, '/dsh-market/update', {
      method: 'POST',
      headers: { ...base, cookie: `${SESSION_COOKIE}=${session}`, 'content-type': 'application/json' },
      body: '{"name":"dshmarket"}',
    })
    expect(rejectedPluginPost.status).toBe(403)

    const proxied = await request(instance.address().port, '/api/run?value=1', {
      method: 'POST',
      headers: {
        ...base,
        authorization: 'Bearer must-strip',
        cookie: `${SESSION_COOKIE}=${session}; ${DEVICE_COOKIE}=must-strip; upstream=must-strip`,
        'content-type': 'application/json',
        [CSRF_HEADER]: body.csrfToken,
        'x-forwarded-for': '203.0.113.5',
      },
      body: '{"task":"test"}',
    })
    expect(proxied.status).toBe(200)
    expect(proxied.headers['set-cookie']).toBeUndefined()
    expect(proxied.headers['x-powered-by']).toBeUndefined()
    expect(proxied.headers['cache-control']).toBe('no-store')
    expect(proxied.headers.expires).toBeUndefined()
    expect(proxied.headers.pragma).toBeUndefined()
    expect(inner.observations).toHaveLength(1)
    const observed = inner.observations[0]!
    expect(observed.headers.host).toBe(`127.0.0.1:${String(inner.port)}`)
    expect(observed.headers.origin).toBe(`http://127.0.0.1:${String(inner.port)}`)
    expect(observed.headers.authorization).toBeUndefined()
    expect(observed.headers.cookie).toBeUndefined()
    expect(observed.headers['x-forwarded-for']).toBeUndefined()
    expect(observed.body).toBe('{"task":"test"}')

    const pluginPost = await request(instance.address().port, '/dsh-market/update', {
      method: 'POST',
      headers: {
        ...base,
        cookie: `${SESSION_COOKIE}=${session}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: body.csrfToken,
      },
      body: '{"name":"dshmarket"}',
    })
    expect(pluginPost.status).toBe(200)
    expect(inner.observations.at(-1)).toMatchObject({
      method: 'POST',
      url: '/dsh-market/update',
      body: '{"name":"dshmarket"}',
    })

    const staticAsset = await request(instance.address().port, '/assets/app.js', {
      headers: {
        ...base,
        authorization: 'Bearer must-strip',
        cookie: `${SESSION_COOKIE}=${session}; ${DEVICE_COOKIE}=must-strip; upstream=must-strip`,
        'x-forwarded-host': 'attacker.example',
      },
    })
    expect(staticAsset.status).toBe(200)
    expect(inner.observations).toHaveLength(3)
    const staticObservation = inner.observations.at(-1)!
    expect(staticObservation.headers.host).toBe(`127.0.0.1:${String(inner.port)}`)
    expect(staticObservation.headers.origin).toBe(`http://127.0.0.1:${String(inner.port)}`)
    expect(staticObservation.headers.cookie).toBeUndefined()
    expect(staticObservation.headers.authorization).toBeUndefined()
    expect(staticObservation.headers['x-forwarded-host']).toBeUndefined()

    const rejectedCount = inner.observations.length
    const rejectedHost = await request(instance.address().port, '/api/run', {
      method: 'POST',
      headers: {
        ...base,
        host: 'attacker.example',
        cookie: `${SESSION_COOKIE}=${session}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: body.csrfToken,
      },
      body: '{}',
    })
    expect(rejectedHost.status).toBe(403)
    const rejectedOrigin = await request(instance.address().port, '/api/run', {
      method: 'POST',
      headers: {
        ...base,
        origin: 'http://attacker.example',
        cookie: `${SESSION_COOKIE}=${session}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: body.csrfToken,
      },
      body: '{}',
    })
    expect(rejectedOrigin.status).toBe(403)
    expect(inner.observations).toHaveLength(rejectedCount)

    const duplicateCookie = await request(instance.address().port, '/', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${session}; ${SESSION_COOKIE}=${session}` },
    })
    expect(duplicateCookie.status).toBe(200)
  })

  it.each(['PUT', 'PATCH', 'DELETE'])('forwards authenticated %s requests to ordinary third-party DSH routes without browser credentials', async method => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const body = JSON.stringify({ size: 'large', label: '手机设置' })
    const saved = await request(instance.address().port, '/dsh-whale/size.json?profile=current', {
      method,
      headers: {
        ...browserHeaders(instance), 'content-type': 'application/json',
        cookie: `${SESSION_COOKIE}=${paired.session}; ${DEVICE_COOKIE}=${paired.device}`,
        authorization: 'Bearer must-not-forward', [CSRF_HEADER]: paired.csrf,
        'x-forwarded-for': '203.0.113.10',
      },
      body,
    })
    expect(saved.status).toBe(200)
    expect(inner.observations).toHaveLength(1)
    expect(inner.observations[0]).toMatchObject({
      method, url: '/dsh-whale/size.json?profile=current', body,
      headers: { host: `127.0.0.1:${String(inner.port)}`, origin: `http://127.0.0.1:${String(inner.port)}`, 'content-type': 'application/json' },
    })
    const headers = inner.observations[0]!.headers
    expect(headers.cookie).toBeUndefined()
    expect(headers.authorization).toBeUndefined()
    expect(headers[CSRF_HEADER]).toBeUndefined()
    expect(headers['x-forwarded-for']).toBeUndefined()
  })

  it.each(['PUT', 'PATCH', 'DELETE'])('rejects unauthenticated, cross-origin, and CSRF-invalid %s writes before forwarding', async method => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const headers: Record<string, string> = {
      ...browserHeaders(instance), 'content-type': 'application/json',
      cookie: `${SESSION_COOKIE}=${paired.session}`, [CSRF_HEADER]: paired.csrf,
    }
    const { cookie: _session, ...withoutSession } = headers
    const { origin: _origin, ...withoutOrigin } = headers
    const { [CSRF_HEADER]: _csrf, ...withoutCsrf } = headers
    for (const [rejectedHeaders, status] of [
      [withoutSession, 401],
      [{ ...headers, cookie: `${SESSION_COOKIE}=invalid` }, 401],
      [withoutCsrf, 403],
      [{ ...headers, [CSRF_HEADER]: 'invalid' }, 403],
      [withoutOrigin, 403],
      [{ ...headers, origin: 'https://foreign.example' }, 403],
      [{ ...headers, host: 'foreign.example' }, 403],
    ] as const) {
      const rejected = await request(instance.address().port, '/dsh-whale/size.json', {
        method, headers: rejectedHeaders, body: '{}',
      })
      expect(rejected.status).toBe(status)
    }
    const admin = await request(instance.address().port, '/api/mobile-access/devices/reset', {
      method, headers, body: '{}',
    })
    expect(admin.status).toBe(404)
    expect(inner.observations).toHaveLength(0)
  })

  it.each(['OPTIONS', 'TRACE', 'PROPFIND'])('keeps ordinary-route %s requests rejected', async method => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const rejected = await request(instance.address().port, '/dsh-whale/size.json', {
      method,
      headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}`, [CSRF_HEADER]: paired.csrf },
    })
    expect(rejected.status).toBe(405)
    expect(inner.observations).toHaveLength(0)
  })

  it('keeps CONNECT requests disconnected before they can reach an ordinary DSH route', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    await expect(request(instance.address().port, '/dsh-whale/size.json', {
      method: 'CONNECT',
      headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}`, [CSRF_HEADER]: paired.csrf },
    })).rejects.toThrow()
    expect(inner.observations).toHaveLength(0)
  })

  it.each(['PUT', 'PATCH', 'DELETE'])('retains request body limits for ordinary-route %s writes', async method => {
    const inner = await upstream()
    const instance = await gateway(inner.port, { maxBodyBytes: 1024 })
    const paired = await pair(instance)
    const rejected = await request(instance.address().port, '/dsh-whale/size.json', {
      method,
      headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}`, [CSRF_HEADER]: paired.csrf },
      body: 'x'.repeat(1025),
    })
    expect(rejected.status).toBe(413)
    expect(inner.observations).toHaveLength(0)
    expect(instance.access.metrics().sessions).toBe(1)
  })

  it('retains the active-request limit while a third-party PUT response is pending', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, { maxActiveRequests: 1 })
    const paired = await pair(instance)
    const headers = { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}`, [CSRF_HEADER]: paired.csrf }
    const held = beginRequest(instance.address().port, '/hold', { method: 'PUT', headers, body: '{}' })
    try {
      await vi.waitFor(() => expect(inner.observations).toHaveLength(1))
      const busy = await request(instance.address().port, '/dsh-whale/size.json', { method: 'PATCH', headers, body: '{}' })
      expect(busy.status).toBe(429)
      expect(JSON.parse(busy.body)).toEqual({ error: 'busy' })
      expect(inner.observations).toHaveLength(1)
    } finally {
      inner.releaseHold()
      expect((await held.result).status).toBe(200)
    }
  })

  it('keeps the proxied GUI frameable by itself and by the sidebar browser, while gateway pages stay unframeable', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const base = browserHeaders(instance)
    const sessionHeaders = { ...base, cookie: `${SESSION_COOKIE}=${paired.session}` }

    // The proxied GUI document and its routes: the GUI must be able to frame
    // its own preview routes (frame-ancestors 'self' + the legacy SAMEORIGIN
    // twin) and the sidebar browser tab must be able to embed external http(s)
    // pages and blob: PDF previews (frame-src). A plain `default-src 'self'`
    // with no frame-src refuses all of them.
    const document = await request(instance.address().port, '/', {
      headers: { ...sessionHeaders, accept: 'text/html', 'sec-fetch-dest': 'document' },
    })
    expect(document.status).toBe(200)
    const csp = document.headers['content-security-policy'] ?? ''
    expect(csp).toContain("frame-ancestors 'self'")
    expect(csp).not.toContain("frame-ancestors 'none'")
    expect(csp).toContain("frame-src 'self' blob: https: http:")
    expect(csp).toContain("default-src 'self'")
    expect(document.headers['x-frame-options']).toBe('SAMEORIGIN')

    const route = await request(instance.address().port, '/sidebar/html/preview.html', {
      headers: { ...sessionHeaders, accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'iframe' },
    })
    expect(route.status).toBe(200)
    const routeCsp = route.headers['content-security-policy'] ?? ''
    expect(routeCsp).toContain("frame-ancestors 'self'")
    expect(routeCsp).toContain("frame-src 'self' blob: https: http:")
    expect(route.headers['x-frame-options']).toBe('SAMEORIGIN')
    expect(route.body).toContain('<body>owned preview</body>')
    expect(route.body).not.toContain('__DSH_MOBILE_FRONTEND__')
    expect(route.body).not.toContain('__DSH_BOOT__')
    expect(inner.observations.map(entry => entry.url)).toEqual(['/', '/sidebar/html/preview.html'])

    // Gateway-owned surfaces (the login document is the one a browser actually
    // renders) keep refusing every frame, including same-origin ones.
    const login = await request(instance.address().port, '/mobile-access/login', { headers: base })
    expect(login.status).toBe(200)
    const loginCsp = login.headers['content-security-policy'] ?? ''
    expect(loginCsp).toContain("frame-ancestors 'none'")
    expect(loginCsp).not.toContain('frame-src')
    expect(login.headers['x-frame-options']).toBe('DENY')
  })

  it('retains a plugin HTML error and does not turn an unknown document route into the DSH homepage', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}`,
      accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document',
    }
    const missing = await request(instance.address().port, '/sidebar/html/missing.html', { headers })
    expect(missing.status).toBe(404)
    expect(missing.body).toBe('<html><body>missing preview</body></html>')
    expect(missing.headers['x-frame-options']).toBe('SAMEORIGIN')
    const unknown = await request(instance.address().port, '/sessions/example', { headers })
    expect(unknown.status).toBe(200)
    expect(JSON.parse(unknown.body)).toMatchObject({ url: '/sessions/example' })
    expect(inner.observations.map(entry => entry.url)).toEqual(['/sidebar/html/missing.html', '/sessions/example'])
    expect(missing.body + unknown.body).not.toContain('__DSH_MOBILE_FRONTEND__')
  })

  it('rejects a malformed DSH entry document instead of silently serving its unadapted shell', async () => {
    const inner = createServer((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><head><script>globalThis["__DSH_BOOT__"] = {"rev":"broken","entries":[]};</script></head><body>broken shell</body></html>')
    })
    const port = await listen(inner)
    cleanups.push(() => closeServer(inner))
    const instance = await gateway(port)
    const paired = await pair(instance)
    const document = await request(instance.address().port, '/index.html?view=conversation', {
      headers: {
        ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}`,
        accept: 'text/html', 'sec-fetch-dest': 'document',
      },
    })
    expect(document.status).toBe(502)
    expect(JSON.parse(document.body)).toEqual({ error: 'upstream_unavailable' })
    expect(document.body).not.toContain('broken shell')
  })

  it('compresses text assets when the authenticated client accepts gzip', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    const compressed = await request(instance.address().port, '/plugins/compressible.js', {
      headers: { ...headers, 'accept-encoding': 'br, gzip, deflate' },
    })
    expect(compressed.status).toBe(200)
    expect(compressed.headers['content-encoding']).toBe('gzip')
    expect(compressed.headers['content-length']).toBeUndefined()
    expect(compressed.headers.etag).toBeUndefined()
    expect(compressed.headers.vary).toBe('Accept-Encoding')
    expect(gunzipSync(compressed.rawBody).toString('utf8')).toBe(COMPRESSIBLE_SCRIPT)
    expect(compressed.rawBody.length).toBeLessThan(Buffer.byteLength(COMPRESSIBLE_SCRIPT) / 4)

    const identity = await request(instance.address().port, '/plugins/compressible.js', {
      headers: { ...headers, 'accept-encoding': 'gzip;q=0, identity' },
    })
    expect(identity.status).toBe(200)
    expect(identity.headers['content-encoding']).toBeUndefined()
    expect(identity.headers['cache-control']).toBe('no-store')
    expect(identity.body).toBe(COMPRESSIBLE_SCRIPT)

    const revisioned = await request(instance.address().port, '/plugins/compressible.js?rev=content_1234', {
      headers: { ...headers, 'accept-encoding': 'gzip' },
    })
    expect(revisioned.status).toBe(200)
    expect(revisioned.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    expect(gunzipSync(revisioned.rawBody).toString('utf8')).toBe(COMPRESSIBLE_SCRIPT)
  })

  it('never marks a rejected revision or hashed asset as immutable', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      cookie: `${SESSION_COOKIE}=${paired.session}`,
    }

    // `rev` is a per-host-start nonce, so a URL the page already holds keeps its
    // shape after a restart while its revision is gone. Upstream answers such a
    // request with a bare 404 and no cache-control; the gateway must not upgrade
    // that into a year-long `immutable` entry, or the WebView pins the rejection
    // and the plugin stays broken across every later boot.
    const stalePlugin = await request(instance.address().port, '/plugins/stale-revision.js?rev=6cc8c4a085f17d9c-50', { headers })
    expect(stalePlugin.status).toBe(404)
    expect(stalePlugin.headers['cache-control']).toBe('no-store')

    const staleAsset = await request(instance.address().port, '/assets/stale-chunk-a1b2c3d4.js', { headers })
    expect(staleAsset.status).toBe(404)
    expect(staleAsset.headers['cache-control']).toBe('no-store')

    // A rejected revision stays uncacheable, while the identical URL that the
    // host actually serves keeps its immutable directive.
    const served = await request(instance.address().port, '/plugins/compressible.js?rev=content_1234', { headers })
    expect(served.status).toBe(200)
    expect(served.headers['cache-control']).toBe('private, max-age=31536000, immutable')
  })

  it('streams authenticated JSON bodies without rewriting history budgets', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const headers = {
      ...browserHeaders(instance),
      cookie: `${SESSION_COOKIE}=${paired.session}`,
      [CSRF_HEADER]: paired.csrf,
      'content-type': 'application/json',
      'accept-encoding': 'gzip',
    }
    const path = '/api/session.history'
    const body = '{\n  "method": "session.history", "payload": { "sessionId": "旧会话", "maxMessages": 500 }\n}\n'
    const forwarded = await request(instance.address().port, path, {
      method: 'POST',
      headers,
      body,
    })
    expect(forwarded.status).toBe(200)
    expect(forwarded.headers['content-encoding']).toBeUndefined()
    const observed = inner.observations.at(-1)
    expect(observed?.url).toBe(path)
    expect(observed?.body).toBe(body)
    expect(observed?.headers['content-length']).toBe(String(Buffer.byteLength(body)))
  })

  it('renews, logs out, and revokes without exposing the persistent credential to the app path', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const base = browserHeaders(instance)

    const renewed = await request(instance.address().port, '/mobile-access/auth/renew', {
      method: 'POST',
      headers: { ...base, cookie: `${DEVICE_COOKIE}=${paired.device}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(renewed.status).toBe(200)
    const renewedBody = JSON.parse(renewed.body) as { csrfToken: string }
    const renewedSession = cookiesByName(renewed.headers).get(SESSION_COOKIE) ?? ''

    const logout = await request(instance.address().port, '/mobile-access/auth/logout', {
      method: 'POST',
      headers: {
        ...base,
        cookie: `${SESSION_COOKIE}=${renewedSession}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: renewedBody.csrfToken,
      },
      body: '{}',
    })
    expect(logout.status).toBe(200)
    const afterLogout = await request(instance.address().port, '/', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${renewedSession}` },
    })
    expect(afterLogout.status).toBe(401)

    const landing = await request(instance.address().port, '/workspace/current', {
      headers: {
        ...base,
        accept: 'text/html',
        'sec-fetch-dest': 'document',
      },
    })
    expect(landing.status).toBe(302)
    expect(landing.headers.location).toBe('/mobile-access/login?return=%2Fworkspace%2Fcurrent')
    const login = await request(instance.address().port, landing.headers.location!, { headers: base })
    expect(login.status).toBe(200)
    expect(login.body).toContain('pair it again')
    const loginScript = await request(instance.address().port, '/mobile-access/login.js', { headers: base })
    expect(loginScript.status).toBe(200)
    expect(() => new Function(loginScript.body)).not.toThrow()
    expect(loginScript.body).toContain('resolved.origin === location.origin')

    expect(await instance.access.revokeDevice(paired.deviceId)).toBe(true)
    const afterRevoke = await request(instance.address().port, '/mobile-access/auth/renew', {
      method: 'POST',
      headers: { ...base, cookie: `${DEVICE_COOKIE}=${paired.device}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(afterRevoke.status).toBe(401)
    expect(afterRevoke.headers['set-cookie']).toBeUndefined()
    expect(JSON.stringify(instance.devices())).not.toContain('tokenDigest')
  })

  it('keeps valid browser credentials usable beside stale and unrelated parent-domain cookies', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const base = browserHeaders(instance)
    for (const values of [
      `${SESSION_COOKIE}=stale; ${SESSION_COOKIE}=${paired.session}`,
      `${SESSION_COOKIE}=${paired.session}; ${SESSION_COOKIE}=stale`,
    ]) {
      const document = await request(instance.address().port, '/', {
        headers: { ...base, cookie: `analytics=first%20value; analytics="older value"; ${values}` },
      })
      expect(document.status).toBe(200)
    }
    const sessions = instance.access.metrics().sessions
    const renewed = await request(instance.address().port, '/mobile-access/auth/renew', {
      method: 'POST',
      headers: {
        ...base, 'content-type': 'application/json',
        cookie: `analytics=one; analytics=two; ${DEVICE_COOKIE}=stale; ${DEVICE_COOKIE}=${paired.device}; ${DEVICE_COOKIE}=${paired.device}`,
      },
      body: '{}',
    })
    expect(renewed.status).toBe(200)
    expect(JSON.parse(renewed.body)).toMatchObject({ deviceId: paired.deviceId })
    expect(instance.access.metrics().sessions).toBe(sessions + 1)
  })

  it('rejects ambiguous valid legacy credentials without allocating extra Sessions or deleting cookies', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const first = await pair(instance)
    const second = await pair(instance)
    const base = browserHeaders(instance)
    const sessions = instance.access.metrics().sessions
    const document = await request(instance.address().port, '/', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${first.session}; ${SESSION_COOKIE}=${second.session}` },
    })
    expect(document.status).toBe(401)
    const renewal = await request(instance.address().port, '/mobile-access/auth/renew', {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/json', cookie: `${DEVICE_COOKIE}=${first.device}; ${DEVICE_COOKIE}=${second.device}` },
      body: '{}',
    })
    expect(renewal.status).toBe(401)
    expect(renewal.headers['set-cookie']).toBeUndefined()
    expect(instance.access.metrics().sessions).toBe(sessions)
    expect(inner.observations).toHaveLength(0)
  })

  it('issues protected HTTPS browser cookies while keeping the persistent credential on the renewal path', async () => {
    const inner = await upstream()
    const instance = await remoteCookieGateway(inner.port)
    const opened = await instance.access.openPairing()
    const paired = await request(instance.address().port, '/mobile-access/auth/pair', {
      method: 'POST', headers: { ...browserHeaders(instance), 'content-type': 'application/json' },
      body: JSON.stringify({ token: opened.token }),
    })
    expect(paired.status).toBe(201)
    const lines = paired.headers['set-cookie'] ?? []
    const values = cookiesByName(paired.headers)
    expect(values.get(HOST_DEVICE_COOKIE)).toBe(JSON.parse(paired.body).deviceId)
    expect(values.get(HOST_SESSION_COOKIE)).toBe(values.get(SESSION_COOKIE))
    expect(values.get(HOST_CSRF_COOKIE)).toBe(values.get(CSRF_COOKIE))
    for (const name of [HOST_SESSION_COOKIE, HOST_CSRF_COOKIE, HOST_DEVICE_COOKIE]) {
      const line = lines.find(value => value.startsWith(`${name}=`)) ?? ''
      expect(line).toContain('Path=/;')
      expect(line).toContain('Secure')
      expect(line).toContain('SameSite=Strict')
      expect(line).not.toContain('Domain=')
      expect(line.includes('HttpOnly')).toBe(name !== HOST_CSRF_COOKIE)
    }
    const persistent = lines.find(value => value.startsWith(`${DEVICE_COOKIE}=`)) ?? ''
    expect(persistent).toContain('Path=/mobile-access/auth/renew;')
    expect(persistent).toContain('HttpOnly')
    expect(persistent).toContain('Secure')
  })

  it('recovers by re-pairing beside two valid legacy credentials and renews the selected device after Session expiry', async () => {
    const inner = await upstream()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    try {
      const instance = await remoteCookieGateway(inner.port)
      const first = await pair(instance)
      const second = await pair(instance)
      const base = browserHeaders(instance)
      const cookieHeader = `${SESSION_COOKIE}=${first.session}; ${SESSION_COOKIE}=${second.session}; ${HOST_SESSION_COOKIE}=${second.session}; ${HOST_DEVICE_COOKIE}=${second.deviceId}; ${DEVICE_COOKIE}=${first.device}; ${DEVICE_COOKIE}=${second.device}`
      const recovered = await request(instance.address().port, '/', { headers: { ...base, cookie: cookieHeader } })
      expect(recovered.status).toBe(200)
      clock.mockReturnValue(Date.now() + 30_001)
      expect(() => instance.access.authorizeSession(second.session)).toThrow()
      const renewed = await request(instance.address().port, '/mobile-access/auth/renew', {
        method: 'POST', headers: { ...base, 'content-type': 'application/json', cookie: cookieHeader }, body: '{}',
      })
      expect(renewed.status).toBe(200)
      expect(JSON.parse(renewed.body)).toMatchObject({ deviceId: second.deviceId })
      expect(instance.access.authorizeSession(cookiesByName(renewed.headers).get(HOST_SESSION_COOKIE) ?? '').deviceId).toBe(second.deviceId)
    } finally {
      clock.mockRestore()
    }
  })

  it('does not use a browser identity or invalid protected Session as an authorization credential', async () => {
    const inner = await upstream()
    const instance = await remoteCookieGateway(inner.port)
    const paired = await pair(instance)
    const base = browserHeaders(instance)
    const invalidPreferred = await request(instance.address().port, '/', {
      headers: { ...base, cookie: `${HOST_SESSION_COOKIE}=invalid; ${SESSION_COOKIE}=${paired.session}` },
    })
    expect(invalidPreferred.status).toBe(401)
    const idOnly = await request(instance.address().port, '/mobile-access/auth/renew', {
      method: 'POST', headers: { ...base, 'content-type': 'application/json', cookie: `${HOST_DEVICE_COOKIE}=${paired.deviceId}` }, body: '{}',
    })
    expect(idOnly.status).toBe(401)
    const wrongIdentity = await request(instance.address().port, '/mobile-access/auth/renew', {
      method: 'POST', headers: { ...base, 'content-type': 'application/json', cookie: `${HOST_DEVICE_COOKIE}=wrong-device; ${DEVICE_COOKIE}=${paired.device}` }, body: '{}',
    })
    expect(wrongIdentity.status).toBe(401)
    expect(wrongIdentity.headers['set-cookie']).toBeUndefined()
  })

  it('upgrades a single valid legacy credential to protected browser cookies on renewal', async () => {
    const inner = await upstream()
    const instance = await remoteCookieGateway(inner.port)
    const paired = await pair(instance)
    const renewal = await request(instance.address().port, '/mobile-access/auth/renew', {
      method: 'POST', headers: { ...browserHeaders(instance), 'content-type': 'application/json', cookie: `${DEVICE_COOKIE}=${paired.device}` }, body: '{}',
    })
    expect(renewal.status).toBe(200)
    expect(cookiesByName(renewal.headers).get(HOST_DEVICE_COOKIE)).toBe(paired.deviceId)
    expect(cookiesByName(renewal.headers).has(HOST_SESSION_COOKIE)).toBe(true)
  })

  it('keeps native pairing, renewal, and authenticated HTML responses free of browser cookie migrations', async () => {
    const inner = await upstream('remote-settings')
    const instance = await remoteCookieGateway(inner.port)
    const opened = await instance.access.openPairing()
    const base = { ...browserHeaders(instance), 'user-agent': 'Android WebView DSHMobile/0.5.3' }
    const paired = await request(instance.address().port, '/mobile-access/auth/native-pair', {
      method: 'POST', headers: { ...base, 'content-type': 'application/json' }, body: JSON.stringify({ token: opened.token }),
    })
    expect(paired.status).toBe(201)
    expect(paired.headers['set-cookie']).toBeUndefined()
    const native = JSON.parse(paired.body) as { deviceToken: string }
    expect(Object.keys(native).sort()).toEqual(['instanceId', 'deviceId', 'deviceToken', 'deviceExpiresAt', 'sessionToken', 'csrfToken', 'sessionExpiresAt'].sort())
    const renewed = await request(instance.address().port, '/mobile-access/auth/native-renew', {
      method: 'POST', headers: { ...base, 'content-type': 'application/json' }, body: JSON.stringify({ deviceToken: native.deviceToken }),
    })
    expect(renewed.status).toBe(200)
    expect(renewed.headers['set-cookie']).toBeUndefined()
    const session = JSON.parse(renewed.body) as { sessionToken: string; csrfToken: string }
    expect(Object.keys(session).sort()).toEqual(['instanceId', 'deviceId', 'sessionToken', 'csrfToken', 'sessionExpiresAt'].sort())
    const document = await request(instance.address().port, '/', {
      headers: { ...base, accept: 'text/html', cookie: `${SESSION_COOKIE}=${session.sessionToken}; ${CSRF_COOKIE}=${session.csrfToken}` },
    })
    expect(document.status).toBe(200)
    expect(document.headers['set-cookie']).toBeUndefined()
    expect(document.body).toContain(`const prefix="${CSRF_COOKIE}="`)
  })

  it('uses the CSRF cookie from the selected Session family and clears both families on logout', async () => {
    const inner = await upstream('remote-settings')
    const instance = await remoteCookieGateway(inner.port)
    const paired = await pair(instance)
    const base = browserHeaders(instance)
    const legacy = await request(instance.address().port, '/', {
      headers: { ...base, accept: 'text/html', cookie: `${SESSION_COOKIE}=${paired.session}; ${HOST_CSRF_COOKIE}=unrelated` },
    })
    expect(legacy.status).toBe(200)
    expect(legacy.body).toContain(`const prefix="${CSRF_COOKIE}="`)
    const protectedDocument = await request(instance.address().port, '/', {
      headers: { ...base, accept: 'text/html', cookie: `${HOST_SESSION_COOKIE}=${paired.session}; ${SESSION_COOKIE}=stale` },
    })
    expect(protectedDocument.status).toBe(200)
    expect(protectedDocument.body).toContain(`const prefix="${HOST_CSRF_COOKIE}="`)
    const logout = await request(instance.address().port, '/mobile-access/auth/logout', {
      method: 'POST', headers: { ...base, 'content-type': 'application/json', cookie: `${HOST_SESSION_COOKIE}=${paired.session}`, [CSRF_HEADER]: paired.csrf }, body: '{}',
    })
    expect(logout.status).toBe(200)
    const lines = logout.headers['set-cookie'] ?? []
    for (const name of [SESSION_COOKIE, CSRF_COOKIE, HOST_SESSION_COOKIE, HOST_CSRF_COOKIE]) {
      expect(lines.some(value => value.startsWith(`${name}=;`) && value.includes('Max-Age=0'))).toBe(true)
    }
    expect(lines.some(value => value.startsWith(`${DEVICE_COOKIE}=`) || value.startsWith(`${HOST_DEVICE_COOKIE}=`))).toBe(false)
  })

  it('uses the login landing to renew an expired Session without widening the device Cookie', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, {}, 80)
    const base = browserHeaders(instance)
    const initial = await request(instance.address().port, '/', {
      headers: { ...base, accept: 'text/html', 'sec-fetch-dest': 'document' },
    })
    expect(initial.status).toBe(302)
    expect(initial.headers.location).toBe('/mobile-access/login?return=%2F')
    const noDevice = await request(instance.address().port, '/mobile-access/auth/renew', {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(noDevice.status).toBe(401)

    const paired = await pair(instance)
    await new Promise(resolve => setTimeout(resolve, 100))
    const expired = await request(instance.address().port, '/', {
      headers: {
        ...base,
        accept: 'text/html',
        cookie: `${SESSION_COOKIE}=${paired.session}`,
        'sec-fetch-dest': 'document',
      },
    })
    expect(expired.status).toBe(302)
    const apiDoesNotRedirect = await request(instance.address().port, '/api/session.list', {
      headers: { ...base, accept: 'text/html', cookie: `${SESSION_COOKIE}=${paired.session}` },
    })
    expect(apiDoesNotRedirect.status).toBe(401)
    expect(apiDoesNotRedirect.headers.location).toBeUndefined()

    const renewed = await request(instance.address().port, '/mobile-access/auth/renew', {
      method: 'POST',
      headers: { ...base, cookie: `${DEVICE_COOKIE}=${paired.device}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(renewed.status).toBe(200)
    const session = cookiesByName(renewed.headers).get(SESSION_COOKIE) ?? ''
    const restored = await request(instance.address().port, '/', {
      headers: { ...base, cookie: `${SESSION_COOKIE}=${session}` },
    })
    expect(restored.status).toBe(200)
  })

  it.each([
    ['an appended intermediate file', (files: Awaited<ReturnType<typeof tlsFixtureFiles>>) => ({
      mode: 'provided' as const,
      certFile: files.leaf,
      keyFile: files.key,
      caFile: files.intermediate,
    })],
    ['a fullchain certificate file', (files: Awaited<ReturnType<typeof tlsFixtureFiles>>) => ({
      mode: 'provided' as const,
      certFile: files.fullchain,
      keyFile: files.key,
    })],
  ])('serves a root-trusted TLS chain from %s without requiring a client certificate', async (_name, tls) => {
    const inner = await upstream()
    const files = await tlsFixtureFiles()
    const instance = await gateway(inner.port, { tls: tls(files) })
    const response = await trustedHttpsRequest(instance.address().port, '/mobile-access/health', files.rootCert)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ ok: true })
    expect(response.headers['strict-transport-security']).toBe('max-age=31536000')
  })

  it('rejects a self-signed root in the appended server chain', async () => {
    const inner = await upstream()
    const files = await tlsFixtureFiles()
    await expect(gateway(inner.port, {
      tls: {
        mode: 'provided',
        certFile: files.fullchain,
        keyFile: files.key,
        caFile: files.root,
      },
    })).rejects.toThrow(/must not include a self-signed root/)
  })

  it('fails closed when TLS material cannot be loaded', async () => {
    const inner = await upstream()
    const resolved = parseGatewayConfig({
      listenHost: '127.0.0.1',
      listenPort: TEST_FAILED_START_PORT,
      upstreamOrigin: `http://127.0.0.1:${String(inner.port)}`,
      publicAuthorities: ['127.0.0.1'],
      allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(tmpdir(), `dsh-mobile-access-${crypto.randomUUID()}.json`),
      tls: {
        mode: 'provided',
        certFile: join(tmpdir(), `missing-${crypto.randomUUID()}.crt`),
        keyFile: join(tmpdir(), `missing-${crypto.randomUUID()}.key`),
      },
    })
    const instance = new MobileAccessGateway(resolved, new MemoryDeviceStore())
    await expect(instance.start()).rejects.toMatchObject({ code: 'ENOENT' })
    await instance.close()
  })

  it('aborts an in-flight proxy request and waits for listener teardown', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const pending = request(instance.address().port, '/hold', {
      headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` },
    }).catch(error => error as Error)
    await vi.waitFor(() => { expect(inner.observations.some(entry => entry.url === '/hold')).toBe(true) })
    await expect(instance.close()).resolves.toBeUndefined()
    await expect(Promise.race([
      pending,
      new Promise((_, reject) => setTimeout(() => reject(new Error('request remained open')), 2_000)),
    ])).resolves.toBeInstanceOf(Error)
    inner.releaseHold()
  })

  it.each(['/api', '/api/hold'])('lets authenticated %s responses outlive the transport budget by default', async path => {
    const inner = await upstream()
    const instance = await gateway(inner.port, { upstreamTimeoutMs: 1_000 })
    const paired = await pair(instance)
    let completed = false
    const pending = request(instance.address().port, path, {
      method: 'POST', headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}`, [CSRF_HEADER]: paired.csrf }, body: '{}',
    }).then(result => { completed = true; return result })
    await vi.waitFor(() => { expect(inner.observations.some(entry => entry.url === path)).toBe(true) })
    await new Promise(resolve => setTimeout(resolve, 1_150))
    expect(completed).toBe(false)
    inner.releaseHold()
    await expect(pending).resolves.toMatchObject({ status: 200, body: 'released' })
    expect(inner.observations.filter(entry => entry.url === path)).toHaveLength(1)
  })

  it('keeps static response waits bounded and names an upstream timeout', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, { upstreamTimeoutMs: 1_000 })
    const paired = await pair(instance)
    const result = await request(instance.address().port, '/hold', {
      headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` },
    })
    expect(result.status).toBe(504)
    expect(JSON.parse(result.body)).toEqual({ error: 'upstream_timeout' })
    expect(result.headers['cache-control']).toBe('no-store')
    expect(inner.observations.filter(entry => entry.url === '/hold')).toHaveLength(1)
  })

  it('starts the optional API response budget only after the upload finishes', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, { upstreamTimeoutMs: 1_000, upstreamApiTimeoutMs: 40 })
    const paired = await pair(instance)
    const pending = beginRequest(instance.address().port, '/api/hold', {
      method: 'POST', deferEnd: true,
      headers: { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}`, [CSRF_HEADER]: paired.csrf, 'content-length': '2' },
      body: '{',
    })
    let completed = false
    void pending.result.then(() => { completed = true }, () => { completed = true })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(completed).toBe(false)
    pending.outgoing.end('}')
    const result = await pending.result
    expect(result.status).toBe(504)
    expect(JSON.parse(result.body)).toEqual({ error: 'upstream_timeout' })
    expect(inner.observations.filter(entry => entry.url === '/api/hold')).toHaveLength(1)
  })

  it('keeps unfinished API uploads under the transport budget when the response deadline is disabled', async () => {
    let notifyAborted: (() => void) | undefined
    const aborted = new Promise<void>(resolve => { notifyAborted = resolve })
    const inner = createServer((incoming, response) => {
      if (incoming.url !== '/api/upload') { response.end('probe'); return }
      incoming.once('aborted', () => { notifyAborted?.() })
      incoming.on('error', () => undefined)
      incoming.resume()
    })
    const upstreamPort = await listen(inner)
    cleanups.push(() => closeServer(inner))
    const instance = await gateway(upstreamPort, { upstreamTimeoutMs: 1_000, maxActiveRequests: 1 })
    const paired = await pair(instance)
    const headers = { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` }
    const pending = beginRequest(instance.address().port, '/api/upload', {
      method: 'POST', deferEnd: true, body: '{',
      headers: { ...headers, [CSRF_HEADER]: paired.csrf, 'content-length': '2' },
    })
    const result = await pending.result
    expect(result.status).toBe(504)
    expect(JSON.parse(result.body)).toEqual({ error: 'upstream_timeout' })
    await aborted
    await expect(request(instance.address().port, '/assets/probe.js', { headers })).resolves.toMatchObject({ status: 200, body: 'probe' })
  })

  it('destroys an abandoned API upstream and frees its request slot without a response deadline', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, { maxActiveRequests: 1 })
    const paired = await pair(instance)
    const headers = { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` }
    const pending = beginRequest(instance.address().port, '/api/hold', { headers })
    const cancelled = pending.result.catch(error => error as Error)
    await vi.waitFor(() => { expect(inner.observations.some(entry => entry.url === '/api/hold')).toBe(true) })
    await expect(request(instance.address().port, '/assets/probe.js', { headers })).resolves.toMatchObject({ status: 429 })
    pending.outgoing.destroy()
    await expect(cancelled).resolves.toBeInstanceOf(Error)
    await vi.waitFor(() => { expect(inner.closedHolds).toContain('/api/hold') })
    await expect(request(instance.address().port, '/assets/probe.js', { headers })).resolves.toMatchObject({ status: 200 })
  })

  it('closes an API stream that reaches its configured idle budget without writing another response', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, { upstreamApiTimeoutMs: 40, maxActiveRequests: 1 })
    const paired = await pair(instance)
    const headers = { ...browserHeaders(instance), cookie: `${SESSION_COOKIE}=${paired.session}` }
    const pending = beginRequest(instance.address().port, '/api/stream-hold', { headers })
    await expect(pending.result).rejects.toThrow()
    await vi.waitFor(() => { expect(inner.closedHolds).toContain('/api/stream-hold') })
    await expect(request(instance.address().port, '/assets/probe.js', { headers })).resolves.toMatchObject({ status: 200 })
  })

  it('rejects a disallowed client CIDR before opening upstream work', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, { allowedCidrs: ['192.0.2.0/24'] })
    const opened = await instance.access.openPairing()
    const paired = await instance.access.pair('test', opened.token)
    const rejected = await request(instance.address().port, '/api/run', {
      method: 'POST',
      headers: {
        ...browserHeaders(instance),
        cookie: `${SESSION_COOKIE}=${paired.sessionToken}`,
        'content-type': 'application/json',
        [CSRF_HEADER]: paired.csrfToken,
      },
      body: '{}',
    })
    expect(rejected.status).toBe(403)
    expect(inner.observations).toHaveLength(0)
  })
})

describe('WebSocket gateway', () => {
  it('guards an upgrade socket before validation or asynchronous work begins', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const server = (instance as unknown as { server?: Server }).server
    expect(server).toBeDefined()
    const socket = new Socket()
    const incoming = {
      method: 'GET',
      url: '/api/events.mux',
      headers: {},
      socket,
    } as IncomingMessage

    expect(() => server!.emit('upgrade', incoming, socket, Buffer.alloc(0))).not.toThrow()
    expect(() => socket.emit('error', Object.assign(new Error('stale connection reset'), { code: 'ECONNRESET' })))
      .not.toThrow()
    await Promise.resolve()
    expect(socket.destroyed).toBe(true)
  })

  it('forwards a large first frame delivered with the upstream upgrade response', async () => {
    const firstFrame = websocketBinaryFrame(Buffer.alloc(26 * 1024, 0x5a))
    const inner = await upstream('legacy', false, firstFrame)
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const opened = await openWebSocket(
      instance,
      '/api/events.mux',
      paired.session,
      undefined,
      undefined,
      firstFrame.length,
    )

    expect(opened.response).toContain('101 Switching Protocols')
    expect(opened.remainder).toEqual(firstFrame)
    opened.socket.destroy()
  })

  it('accepts an upstream WebSocket response whose headers exactly meet the header limit', async () => {
    const inner = await upstream('legacy', false, Buffer.alloc(0), [], 16 * 1024)
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const opened = await openWebSocket(instance, '/api/events.mux', paired.session)

    expect(inner.upgradeResponseBytes).toEqual([16 * 1024])
    expect(opened.response).toContain('101 Switching Protocols')
    opened.socket.destroy()
  })

  it('rejects an upstream WebSocket response one byte beyond the header limit', async () => {
    const inner = await upstream('legacy', false, Buffer.alloc(0), [], 16 * 1024 + 1)
    const instance = await gateway(inner.port)
    const paired = await pair(instance)

    await expect(openWebSocket(instance, '/api/events.mux', paired.session)).rejects.toThrow()
    expect(inner.upgradeResponseBytes).toEqual([16 * 1024 + 1])
  })

  it('accepts an exact-origin Android WebView upgrade without Fetch Metadata', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const opened = await openWebSocket(instance, '/api/events.mux', paired.session, undefined, undefined)
    expect(opened.response).toContain('101 Switching Protocols')
    opened.socket.destroy()
  })

  it('keeps the gateway alive when a mobile WebSocket resets abruptly', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port)
    const paired = await pair(instance)
    const opened = await openWebSocket(instance, '/api/events.mux', paired.session)
    expect(opened.response).toContain('101 Switching Protocols')
    opened.socket.resetAndDestroy()
    await new Promise(resolve => setTimeout(resolve, 50))

    const response = await request(instance.address().port, '/assets/app.js', {
      headers: {
        ...browserHeaders(instance),
        cookie: `${SESSION_COOKIE}=${paired.session}`,
      },
    })
    expect(response.status).toBe(200)
  })

  it('allows the known DSH event and Remote paths, forwards only the Session Cookie, and closes all on revocation', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, { maxWebSockets: 4 })
    const paired = await pair(instance)
    const first = await openWebSocket(instance, '/api/events.mux', paired.session)
    const second = await openWebSocket(instance, '/api/events.host', paired.session)
    const third = await openWebSocket(instance, '/api/remote.mux', paired.session)
    const terminal = await openWebSocket(instance, '/sidebar/ws/terminal?sessionId=s1&tab=t1', paired.session)
    expect(first.response).toContain('101 Switching Protocols')
    expect(second.response).toContain('101 Switching Protocols')
    expect(third.response).toContain('101 Switching Protocols')
    expect(terminal.response).toContain('101 Switching Protocols')
    expect(inner.upgradeObservations).toHaveLength(4)
    for (const observed of inner.upgradeObservations) {
      expect(observed.cookie).toBeUndefined()
      expect(observed.origin).toBe(`http://127.0.0.1:${String(inner.port)}`)
      expect(observed.host).toBe(`127.0.0.1:${String(inner.port)}`)
    }

    const firstClosed = new Promise<void>(resolve => { first.socket.once('close', () => resolve()) })
    const secondClosed = new Promise<void>(resolve => { second.socket.once('close', () => resolve()) })
    const thirdClosed = new Promise<void>(resolve => { third.socket.once('close', () => resolve()) })
    await instance.access.revokeDevice(paired.deviceId)
    await Promise.all([firstClosed, secondClosed, thirdClosed])

    const unknown = await openWebSocket(instance, '/api/events.unknown', paired.session)
    expect(unknown.response).toContain('404')
    unknown.socket.destroy()
  })

  it('proxies an admin-approved third-party path with its query string', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, {}, undefined, undefined, ['/ext/demo.ws'])
    const paired = await pair(instance)
    const opened = await openWebSocket(instance, '/ext/demo.ws?sessionId=s1&tab=t1', paired.session)
    expect(opened.response).toContain('101 Switching Protocols')
    opened.socket.destroy()
    const core = await openWebSocket(instance, '/api/events.mux?generation=2', paired.session)
    expect(core.response).toContain('101 Switching Protocols')
    core.socket.destroy()
  })

  it('records rejected upgrade paths for one-click approval', async () => {
    const inner = await upstream()
    const log = new BlockedUpgradePathLog()
    const instance = await gateway(inner.port, {}, undefined, undefined, [], log)
    const paired = await pair(instance)
    const blocked = await openWebSocket(instance, '/ext/demo.ws?sessionId=s1', paired.session)
    expect(blocked.response).toContain('404')
    blocked.socket.destroy()
    expect(instance.blockedUpgradePathReport()).toMatchObject([{ path: '/ext/demo.ws', attempts: 1 }])
  })

  it('still rejects unlisted paths and their query strings', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, {}, undefined, undefined, ['/sidebar/ws/terminal'])
    const paired = await pair(instance)
    const unknown = await openWebSocket(instance, '/api/events.unknown', paired.session)
    expect(unknown.response).toContain('404')
    unknown.socket.destroy()
    const unlistedQuery = await openWebSocket(instance, '/sidebar/ws/other?sessionId=s1', paired.session)
    expect(unlistedQuery.response).toContain('404')
    unlistedQuery.socket.destroy()
    expect(inner.upgradeObservations).toHaveLength(0)
  })

  it('rejects a wrong WebSocket Origin on every allowed path before opening upstream work', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, {}, undefined, undefined, ['/sidebar/ws/terminal'])
    const paired = await pair(instance)
    for (const path of ['/api/events.mux', '/api/events.host', '/api/remote.mux', '/sidebar/ws/terminal?sessionId=s1']) {
      const rejected = await openWebSocket(instance, path, paired.session, 'http://attacker.example')
      expect(rejected.response).toContain('403')
      rejected.socket.destroy()
    }
    expect(inner.upgradeObservations).toHaveLength(0)
  })

  it('closes an established WebSocket when its short Session expires', async () => {
    const inner = await upstream()
    const instance = await gateway(inner.port, {}, 80)
    const paired = await pair(instance)
    const opened = await openWebSocket(instance, '/api/events.mux', paired.session)
    expect(opened.response).toContain('101 Switching Protocols')
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('expired WebSocket remained open')), 1_000)
      opened.socket.once('close', () => { clearTimeout(timeout); resolve() })
    })
    await vi.waitFor(() => {
      expect(() => instance.access.authorizeSession(paired.session)).toThrow()
    })
  })
})
