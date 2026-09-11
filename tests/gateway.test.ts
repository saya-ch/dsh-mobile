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
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { connect, type AddressInfo, type Socket } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { BlockedUpgradePathLog } from '../src/websocket-paths.js'
import { CSRF_HEADER, DEVICE_COOKIE, SESSION_COOKIE } from '../src/http-security.js'
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
const TEST_GATEWAY_PORT = 38080
const TEST_FAILED_START_PORT = 38081
const SESSION_HISTORY_PATH = '/api/session.history'
const COMPRESSIBLE_SCRIPT = 'globalThis.__compressionProbe = true;\n'.repeat(256)
const UPSTREAM_LAUNCH_TOKEN = 'test-launch-token'
const UPSTREAM_BROWSER_COOKIE = 'dsh-auth-test=v1.signed-cookie'
const HISTORY_RESPONSE = JSON.stringify({
  type: 'client-response',
  result: { ok: true, value: { events: [{ event: { type: 'assistant/chunk', content: 'history '.repeat(2_048) } }] } },
})

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
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
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
      response.once('end', () => {
        const rawBody = Buffer.concat(chunks)
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: rawBody.toString('utf8'), rawBody })
      })
    })
    outgoing.once('error', reject)
    outgoing.end(body)
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
    const timer = setTimeout(() => { client.close(); reject(new Error('UDP discovery timed out')) }, 2_000)
    client.once('error', (error) => { clearTimeout(timer); client.close(); reject(error) })
    client.once('message', (message) => {
      clearTimeout(timer)
      client.close()
      resolve(JSON.parse(message.toString('utf8')) as Record<string, unknown>)
    })
    client.send(Buffer.from('DSH_MOBILE_DISCOVER_V1', 'ascii'), port, '127.0.0.1')
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
  boot: 'legacy' | 'batched' | 'remote-settings' = 'legacy',
  requireAuthentication = false,
  upgradeBurst: Buffer = Buffer.alloc(0),
  upgradeHeaderLines: string[] = [],
  upgradeHeaderBytes?: number,
  batchedBundleResponder?: BatchedBundleResponder,
): Promise<{
  port: number
  observations: UpstreamObservation[]
  upgradeObservations: IncomingHttpHeaders[]
  upgradeResponseBytes: number[]
  releaseHold: () => void
}> {
  const observations: UpstreamObservation[] = []
  const upgradeObservations: IncomingHttpHeaders[] = []
  const upgradeResponseBytes: number[] = []
  const held: Array<() => void> = []
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
    if (incoming.url === '/hold') {
      held.push(() => { response.writeHead(200); response.end('released') })
      return
    }
    if (incoming.url === '/' && incoming.headers.accept?.includes('text/html')) {
      const entries = boot === 'legacy'
        ? [
            { id: '@deepseek-ai/dsh-client-ui-layout', url: '/plugins/layout.js', rev: 'stock-layout', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'] },
            { id: 'feature', url: '/plugins/feature.js', rev: 'feature' },
          ]
        : [
            { id: '@deepseek-ai/dsh-client-ui-renderer', url: '/plugins/renderer.js?rev=renderer', rev: 'renderer' },
            {
              id: '@deepseek-ai/dsh-client-ui-layout',
              url: '/plugins/layout.js?rev=layout',
              rev: 'layout',
              inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-theme'],
            },
            { id: 'feature', url: '/plugins/feature.js?rev=feature', rev: 'feature' },
          ]
      if (boot === 'remote-settings') entries.push(
        { id: '@deepseek-ai/dsh-client-connection', url: '/plugins/connection.js?rev=connection', rev: 'connection', inject: [] },
        { id: '@deepseek-ai/dsh-api-gateway', url: '/plugins/gateway.js?rev=gateway', rev: 'gateway', inject: ['@deepseek-ai/dsh-client-connection'] },
        { id: '@deepseek-ai/dsh-api-remotes', url: '/plugins/remotes.js?rev=remotes', rev: 'remotes', inject: ['@deepseek-ai/dsh-api-gateway'] },
        { id: '@deepseek-ai/dsh-client-ui-settings', url: '/plugins/settings.js?rev=settings', rev: 'settings', inject: ['@deepseek-ai/dsh-api-remotes'] },
        { id: 'dsh-mobile', url: '/plugins/mobile.js?rev=mobile', rev: 'mobile', inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'] },
      )
      const graph = boot === 'legacy'
        ? { rev: 'stock', entries }
        : { rev: 'stock', entries, batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock-batch', entries: entries.map(entry => entry.id) }] }
      const body = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)};</script></head><body></body></html>`
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      response.end(body)
      return
    }
    if (boot === 'batched' && incoming.url?.startsWith('/plugins/') === true) {
      if (await batchedBundleResponder?.(incoming, response) === true) return
      const body = `globalThis.__loadedMobileFixture ??= []; globalThis.__loadedMobileFixture.push(${JSON.stringify(incoming.url)});\n`
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': Buffer.byteLength(body) })
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
    if (incoming.url === '/api/session.history') {
      response.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(HISTORY_RESPONSE),
      })
      response.end(HISTORY_RESPONSE)
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
    releaseHold: () => { for (const release of held.splice(0)) release() },
  }
}

async function gateway(
  upstreamPort: number,
  overrides: Record<string, unknown> = {},
  testSessionTtlMs?: number,
  upstreamAuthenticatedUrl?: string,
  extraWebSocketPaths: readonly string[] = [],
  blockedUpgradeLog?: BlockedUpgradePathLog,
): Promise<MobileAccessGateway> {
  const resolved = parseGatewayConfig({
    listenHost: '127.0.0.1',
    listenPort: TEST_GATEWAY_PORT,
    upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
    publicAuthorities: ['127.0.0.1'],
    allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(tmpdir(), `dsh-mobile-access-${crypto.randomUUID()}.json`),
    tls: { mode: 'disabled' },
    ...overrides,
  })
  const effective = testSessionTtlMs === undefined ? resolved : Object.freeze({ ...resolved, sessionTtlMs: testSessionTtlMs })
  const extra = new Set(extraWebSocketPaths)
  const instance = new MobileAccessGateway(effective, new MemoryDeviceStore(), undefined, upstreamAuthenticatedUrl, { has: (pathname: string) => extra.has(pathname) }, blockedUpgradeLog)
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
    await writeFile(customCssFile, ':root { --preview: first; }\n', 'utf8')
    await writeFile(customScriptFile, 'window.dshMobile.register(() => undefined)\n', 'utf8')
    await writeFile(mobileLayoutFile, 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-layout" })\n', 'utf8')
    const instance = await gateway(inner.port, { customCssFile, customScriptFile, mobileLayoutFile })
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

    await writeFile(customCssFile, ':root { --preview: second; }\n', 'utf8')
    const second = await request(instance.address().port, '/mobile-access/custom.css', { headers })
    expect(second.status).toBe(200)
    expect(second.body).toContain('--preview: second')
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

    const deepLink = await request(instance.address().port, '/sessions/example', { headers })
    expect(deepLink.status).toBe(200)
    expect(deepLink.body).toContain('window.__DSH_MOBILE_FRONTEND__="dedicated"')

    const stock = await request(instance.address().port, '/?frontend=stock', { headers })
    expect(stock.status).toBe(200)
    expect(stock.body).not.toContain('__DSH_MOBILE_FRONTEND__')
    expect(stock.body).toContain('/plugins/layout.js')
  })

  it('exposes the alpha.2 trusted HTTP carrier only on an authenticated dedicated page', async () => {
    const inner = await upstream('remote-settings')
    const instance = await gateway(inner.port)
    const browser = { ...browserHeaders(instance), accept: 'text/html' }
    const anonymous = await request(instance.address().port, '/', { headers: browser })
    expect(anonymous.status).toBe(302)
    expect(anonymous.body).not.toContain('__DSH_TRANSPORT__')
    expect(inner.observations).toHaveLength(0)
    const login = await request(instance.address().port, '/mobile-access/login', { headers: browser })
    expect(login.status).toBe(200)
    expect(login.body).not.toContain('__DSH_TRANSPORT__')

    const paired = await pair(instance)
    const headers = { ...browser, cookie: `${SESSION_COOKIE}=${paired.session}` }
    const dedicated = await request(instance.address().port, '/', { headers })
    expect(dedicated.status).toBe(200)
    expect(dedicated.body).toContain('window.__DSH_TRANSPORT__={fetch:')
    expect(dedicated.body).toContain('ownsHost:true')
    expect(dedicated.body).toContain('window.__DSH_MOBILE_FRONTEND__="dedicated"')
    const stock = await request(instance.address().port, '/?frontend=stock', { headers })
    expect(stock.status).toBe(200)
    expect(stock.body).not.toContain('__DSH_TRANSPORT__')
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
    const batch = await request(instance.address().port, path, { headers })
    expect(batch.status).toBe(200)
    expect(batch.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(batch.headers.etag).toMatch(/^[a-f\d]{64}$/u)
    expect(batch.body).toContain('/plugins/renderer.js?rev=renderer')
    expect(batch.body).toContain('__dedicatedMobileLayout = true')
    expect(batch.body).toContain('/plugins/feature.js?rev=feature')
    expect(batch.body).not.toContain('/plugins/layout.js?rev=layout')
    expect(batch.body.indexOf('renderer.js')).toBeLessThan(batch.body.indexOf('__dedicatedMobileLayout'))
    expect(batch.body.indexOf('__dedicatedMobileLayout')).toBeLessThan(batch.body.indexOf('feature.js'))

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

  it('does not retry a deterministic bundle response and permits the next assembly to recover', async () => {
    let rejectRenderer = true
    const fixture = await mobileBatchFixture((incoming, response) => {
      if (!rejectRenderer || incoming.url !== '/plugins/renderer.js?rev=renderer') return false
      response.writeHead(503, { 'content-type': 'text/plain' })
      response.end('temporarily unavailable')
      return true
    })

    const failed = await request(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    expect(failed.status).toBe(502)
    expect(JSON.parse(failed.body)).toEqual({ error: 'upstream_unavailable' })
    expect(fixture.inner.observations.filter(entry => entry.url === '/plugins/renderer.js?rev=renderer')).toHaveLength(1)

    rejectRenderer = false
    const recovered = await request(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    expect(recovered.status).toBe(200)
    expect(recovered.body).toContain('/plugins/renderer.js?rev=renderer')
    expect(fixture.inner.observations.filter(entry => entry.url === '/plugins/renderer.js?rev=renderer')).toHaveLength(2)
  })

  it('retries a transient upstream reset while assembling a mobile batch', async () => {
    let resetRenderer = true
    const fixture = await mobileBatchFixture((incoming) => {
      if (!resetRenderer || incoming.url !== '/plugins/renderer.js?rev=renderer') return false
      resetRenderer = false
      incoming.socket.destroy()
      return true
    })

    const batch = await request(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    expect(batch.status).toBe(200)
    expect(batch.body).toContain('/plugins/renderer.js?rev=renderer')
    expect(fixture.inner.observations.filter(entry => entry.url === '/plugins/renderer.js?rev=renderer')).toHaveLength(2)
  })

  it('reuses one in-flight assembly for concurrent mobile batch requests', async () => {
    let releaseBundles!: () => void
    const bundlesReleased = new Promise<void>(resolve => { releaseBundles = resolve })
    const fixture = await mobileBatchFixture(async () => {
      await bundlesReleased
      return false
    })

    const first = beginRequest(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    await vi.waitFor(() => {
      expect(fixture.inner.observations.filter(entry => entry.url.startsWith('/plugins/'))).toHaveLength(2)
    })
    const second = beginRequest(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    await vi.waitFor(() => { expect(activeRequestCount(fixture.instance)).toBe(2) })

    releaseBundles()
    const [firstResult, secondResult] = await Promise.all([first.result, second.result])
    expect(firstResult.status).toBe(200)
    expect(secondResult.status).toBe(200)
    expect(secondResult.rawBody).toEqual(firstResult.rawBody)
    expect(fixture.inner.observations.filter(entry => entry.url.startsWith('/plugins/'))).toHaveLength(2)
  })

  it('keeps a shared mobile batch assembly alive when its first requester disconnects', async () => {
    let releaseBundles!: () => void
    const bundlesReleased = new Promise<void>(resolve => { releaseBundles = resolve })
    const fixture = await mobileBatchFixture(async () => {
      await bundlesReleased
      return false
    })

    const first = beginRequest(fixture.instance.address().port, fixture.path, { headers: fixture.headers })
    await vi.waitFor(() => {
      expect(fixture.inner.observations.filter(entry => entry.url.startsWith('/plugins/'))).toHaveLength(2)
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
    expect(fixture.inner.observations.filter(entry => entry.url.startsWith('/plugins/'))).toHaveLength(2)
  })

  it('aborts an assembly during retry teardown without issuing another upstream request', async () => {
    let reportReset!: () => void
    const resetObserved = new Promise<void>(resolve => { reportReset = resolve })
    const fixture = await mobileBatchFixture((incoming) => {
      if (incoming.url !== '/plugins/renderer.js?rev=renderer') return false
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
    expect(fixture.inner.observations.filter(entry => entry.url === '/plugins/renderer.js?rev=renderer')).toHaveLength(1)
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
      headers: { host, 'content-type': 'application/json' },
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
      headers: { host, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: pairedBody.deviceId }),
    })
    expect(revoked.status).toBe(200)
    const resetWithoutConfirmation = await request(adminPort, '/api/mobile-access/devices/reset', {
      method: 'POST',
      headers: { host, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(resetWithoutConfirmation.status).toBe(400)
    const reset = await request(adminPort, '/api/mobile-access/devices/reset', {
      method: 'POST',
      headers: { host, 'content-type': 'application/json' },
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
    await expect(udpDiscovery(instance.address().port)).resolves.toEqual({
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
    const credential = JSON.parse(paired.body) as { instanceId: string; deviceToken: string; sessionToken: string }
    expect(credential.instanceId).toBe(instanceId)
    expect(credential.deviceToken).toMatch(/^[\w-]{43}$/u)
    expect(credential.sessionToken).toMatch(/^[\w-]{43}$/u)

    const renewed = await request(instance.address().port, '/mobile-access/auth/native-renew', {
      method: 'POST',
      headers: { ...browserHeaders(instance), 'content-type': 'application/json' },
      body: JSON.stringify({ deviceToken: credential.deviceToken }),
    })
    expect(renewed.status).toBe(200)
    expect(JSON.parse(renewed.body)).toMatchObject({ instanceId, deviceId: expect.any(String) })
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
    expect(duplicateCookie.status).toBe(401)
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

  it('uses mobile-sized pages and compresses session history', async () => {
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
    const historyRequest = (maxMessages: number): string => JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method: 'session.history',
      payload: { sessionId: 'session-example', maxMessages },
    })

    const compressed = await request(instance.address().port, SESSION_HISTORY_PATH, {
      method: 'POST',
      headers,
      body: historyRequest(50),
    })
    expect(compressed.status).toBe(200)
    expect(compressed.headers['content-encoding']).toBe('gzip')
    expect(compressed.headers['content-length']).toBeUndefined()
    expect(gunzipSync(compressed.rawBody).toString('utf8')).toBe(HISTORY_RESPONSE)
    const capped = inner.observations.at(-1)
    expect(capped?.url).toBe(SESSION_HISTORY_PATH)
    expect(JSON.parse(capped?.body ?? '{}')).toMatchObject({ payload: { maxMessages: 10 } })
    expect(capped?.headers['content-length']).toBe(String(Buffer.byteLength(capped?.body ?? '')))

    await request(instance.address().port, SESSION_HISTORY_PATH, {
      method: 'POST',
      headers: { ...headers, 'accept-encoding': 'identity' },
      body: historyRequest(5),
    })
    expect(JSON.parse(inner.observations.at(-1)?.body ?? '{}')).toMatchObject({ payload: { maxMessages: 5 } })
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
    expect(afterRevoke.headers['set-cookie']?.join(';')).toContain(`${DEVICE_COOKIE}=;`)
    expect(JSON.stringify(instance.devices())).not.toContain('tokenDigest')
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
    const instance = await gateway(inner.port, { maxWebSockets: 3 })
    const paired = await pair(instance)
    const first = await openWebSocket(instance, '/api/events.mux', paired.session)
    const second = await openWebSocket(instance, '/api/events.host', paired.session)
    const third = await openWebSocket(instance, '/api/remote.mux', paired.session)
    expect(first.response).toContain('101 Switching Protocols')
    expect(second.response).toContain('101 Switching Protocols')
    expect(third.response).toContain('101 Switching Protocols')
    expect(inner.upgradeObservations).toHaveLength(3)
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
    const instance = await gateway(inner.port, {}, undefined, undefined, ['/sidebar/ws/terminal'])
    const paired = await pair(instance)
    const opened = await openWebSocket(instance, '/sidebar/ws/terminal?sessionId=s1&tab=t1', paired.session)
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
    const blocked = await openWebSocket(instance, '/sidebar/ws/terminal?sessionId=s1', paired.session)
    expect(blocked.response).toContain('404')
    blocked.socket.destroy()
    expect(instance.blockedUpgradePathReport()).toMatchObject([{ path: '/sidebar/ws/terminal', attempts: 1 }])
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
