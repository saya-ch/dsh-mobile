import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { channel } from 'node:diagnostics_channel'
import { request } from 'node:https'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { execFileText } from '../src/exec-file.js'
import { CaddyConfigStore, parseCaddySettings, renderCaddyfile } from '../src/caddy-config.js'
import { caddyProcessEnvironment } from '../src/caddy.js'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { JsonDeviceStore } from '../src/storage.js'
import { installedCaddyFixture } from './helpers/caddy-component-fixture.js'
import { remoteGatewayConfig } from '../src/plugin.js'
import { terminateRemoteProcess } from '../src/remote.js'
import { CSRF_COOKIE, CSRF_HEADER, DEVICE_COOKIE, SESSION_COOKIE, parseCookies } from '../src/http-security.js'

const inputExecutable = process.env.DSH_CADDY_TEST_EXECUTABLE
const manifestFile = process.env.DSH_CADDY_TEST_MANIFEST
const cleanups: (() => Promise<void>)[] = []
let fixtureController: AbortController | undefined
let activeBodyTask: Promise<void> | undefined
afterEach(async () => {
  // Runner timeout alone does not cancel its callback. Quiesce the inner work before taking the cleanup snapshot.
  fixtureController?.abort(new Error('Live fixture teardown'))
  try { await activeBodyTask } catch { /* The test body reports its own failure. */ }
  activeBodyTask = undefined
  fixtureController = undefined
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Owned live-fixture cleanup failed')
}, 60_000)

/** Observe only the spawned Caddy process's atomically allocated TCP listener. */
async function ownedPort(pid: number, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted()
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot
    if (systemRoot === undefined) throw new Error('Windows system root missing')
    const output = await execFileText(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -State Listen -OwningProcess ${String(pid)} -ErrorAction SilentlyContinue | Where-Object LocalAddress -eq '127.0.0.1' | Select-Object -ExpandProperty LocalPort) -join ','`], { timeout: 10_000, signal })
    const ports = output.stdout.trim().split(',').filter(Boolean).map(Number)
    if (ports.length !== 1 || !Number.isInteger(ports[0])) throw new Error('Owned Caddy listener is not ready')
    return ports[0]!
  }
  const output = await execFileText('ss', ['-ltnp'], { timeout: 10_000, signal })
  const line = output.stdout.split(/\r?\n/u).find(value => value.includes('pid=' + String(pid) + ',') && value.includes('127.0.0.1:'))
  const port = Number(line?.match(/127\.0\.0\.1:(\d+)/u)?.[1])
  if (!Number.isInteger(port) || port < 1) throw new Error('Owned Caddy listener is not ready')
  return port
}

function exchange(signal: AbortSignal, port: number, ca: string, path: string, method = 'GET', headers: Record<string, string> = {}, body = ''): Promise<{ status: number; headers: IncomingHttpHeaders; body: string; rawBody: Buffer }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, servername: 'phone.example.com', ca, agent: false, method, path, signal,
      headers: { host: 'phone.example.com', origin: 'https://phone.example.com', 'sec-fetch-site': 'same-origin', ...headers },
    }, incoming => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.once('end', () => { const rawBody = Buffer.concat(chunks); resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: rawBody.toString(), rawBody }) })
      incoming.once('error', reject)
    })
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('TLS request timeout: ' + method + ' ' + path.split('?', 1)[0])))
    outgoing.once('error', reject); outgoing.end(body)
  })
}

/** One direct, cookie-free boundary probe; never follows redirects or proxy environment. */
async function directUnauthenticated(signal: AbortSignal, port: number, path: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', agent: false, signal,
      headers: { host: 'phone.example.com', origin: 'https://phone.example.com', 'sec-fetch-site': 'same-origin' },
    }, incoming => {
      let body = ''
      incoming.on('data', (chunk: Buffer) => { body = (body + chunk.toString()).slice(0, 2048) })
      incoming.once('end', () => resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body }))
      incoming.once('error', reject)
    })
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('Direct gateway request timeout')))
    outgoing.once('error', reject); outgoing.end()
  })
}

function responseDiagnostic(response: { status: number; headers: IncomingHttpHeaders; body: string }): string {
  const names = ['content-type', 'content-length', 'cache-control', 'strict-transport-security', 'server']
  return JSON.stringify({ status: response.status, body: response.body.slice(0, 2048),
    headers: Object.fromEntries(names.map(name => [name, String(response.headers[name] ?? '').slice(0, 512)])),
  })
}

it.runIf(inputExecutable !== undefined || manifestFile !== undefined)('runs optional installed Caddy through trusted TLS, durable pairing, API/WSS, restart, corruption and purge', async () => {
  if (inputExecutable === undefined) throw new Error('Explicit test executable required')
  fixtureController = new AbortController()
  const signal = fixtureController.signal
  const controller = fixtureController
  const deadline = setTimeout(() => controller.abort(new Error('Live fixture 90s deadline exceeded')), 90_000)
  const body = async (): Promise<void> => {
  const step = async <T>(operation: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted()
    const result = await operation()
    signal.throwIfAborted()
    return result
  }
  signal.throwIfAborted()
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-caddy-live-'))
  const ownedChildren: { child: ChildProcess; closed: boolean }[] = []
  const ownChild = (child: ChildProcess): (() => Promise<void>) => {
    const owned = { child, closed: false }
    ownedChildren.push(owned)
    // Register immediately after spawn: only the actual close event confirms all child handles closed.
    child.once('close', () => { owned.closed = true })
    const stop = async (): Promise<void> => {
      if (!owned.closed) await terminateRemoteProcess(child)
      // terminateRemoteProcess can return on exitCode before stdio's close event.
      if (!owned.closed) await once(child, 'close', { signal: AbortSignal.timeout(1_500) })
    }
    cleanups.push(stop)
    return stop
  }
  cleanups.push(async () => {
    // Independent cleanup still runs on stop failure, but never remove files under an unclosed child.
    if (ownedChildren.some(owned => !owned.closed)) {
      throw new Error('Owned Caddy close unconfirmed; retained fixture root: ' + root)
    }
    // Only the root allocated by this test is recursively removed.
    expect((await lstat(root)).isDirectory()).toBe(true)
    await rm(root, { recursive: true, force: true })
  })
  // A late mkdtemp result is owned before the cancellation check.
  signal.throwIfAborted()
  const fixture = manifestFile === undefined ? undefined : await step(() => installedCaddyFixture(root, inputExecutable, manifestFile, fn => cleanups.push(fn), signal))
  const executable = fixture?.executable ?? inputExecutable
  const upstreamRequests = new Map<string, number>()
  const upstreamSockets = new Map<string, IncomingMessage['socket']>()
  const upstreamConnections = new Map<string, string | undefined>()
  const consumedBodies = new Map<string, Buffer>()
  const gatewayRequests = new Map<string, number>()
  const gatewaySockets = new Map<string, IncomingMessage['socket']>()
  const gatewayVersions = new Map<string, string>()
  const upstream = createServer((incoming, outgoing) => {
    const target = new URL(incoming.url!, 'http://owned-fixture')
    const id = target.searchParams.get('requestId')
    if (id !== null) {
      upstreamRequests.set(id, (upstreamRequests.get(id) ?? 0) + 1)
      upstreamSockets.set(id, incoming.socket)
      upstreamConnections.set(id, incoming.headers.connection)
    }
    if (target.pathname === '/api/caddy-test-reset' || target.pathname === '/api/caddy-test-gateway-reset') {
      const chunks: Buffer[] = []
      incoming.on('error', () => undefined)
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.once('end', () => {
        consumedBodies.set(id!, Buffer.concat(chunks))
        if (target.pathname === '/api/caddy-test-gateway-reset') {
          // Simulate a first-hop failure AFTER the upstream has committed its side effect.
          gatewaySockets.get(id!)!.resetAndDestroy()
          outgoing.end('side-effect-committed')
        } else incoming.socket.destroy()
      })
      return
    }
    if (target.pathname === '/api/caddy-test-resource') { outgoing.writeHead(200, { 'content-type': 'application/octet-stream' }); outgoing.end(Buffer.from([0, 1, 2, 250])); return }
    outgoing.writeHead(404); outgoing.end()
  })
  const webSockets = new WebSocketServer({ noServer: true })
  const peers = new Set<WebSocket>()
  webSockets.on('connection', peer => { peers.add(peer); peer.on('message', data => peer.send(data)); peer.on('close', () => peers.delete(peer)) })
  upstream.on('upgrade', (incoming, socket, head) => { webSockets.handleUpgrade(incoming, socket, head, peer => webSockets.emit('connection', peer, incoming)) })
  cleanups.push(async () => { for (const peer of peers) peer.terminate(); await new Promise<void>(resolve => webSockets.close(() => resolve())); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  await step(() => new Promise<void>((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve) }))
  const upstreamAddress = upstream.address(); if (upstreamAddress === null || typeof upstreamAddress === 'string') throw new Error('missing port')
  const template = parseGatewayConfig({ listenHost: '127.0.0.1', listenPort: 0, tls: { mode: 'disabled' },
    stateFile: join(root, 'devices.json'), upstreamOrigin: 'http://127.0.0.1:' + String(upstreamAddress.port),
    publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
  })
  const store = new JsonDeviceStore(template.stateFile)
  const gatewayConfig = remoteGatewayConfig(template, 'https://phone.example.com', template.stateFile, 'a'.repeat(64))
  const gateway = new MobileAccessGateway(gatewayConfig, store)
  cleanups.push(() => gateway.close())
  await step(() => gateway.start())
  const gatewayPort = gateway.address().port
  const requestStarts = channel('http.server.request.start')
  const observeGatewayRequest = (message: unknown): void => {
    const incoming = (message as { request: IncomingMessage }).request
    if (incoming.socket.localPort !== gatewayPort) return
    const id = new URL(incoming.url!, 'http://owned-fixture').searchParams.get('requestId')
    if (id === null) return
    gatewayRequests.set(id, (gatewayRequests.get(id) ?? 0) + 1)
    gatewaySockets.set(id, incoming.socket)
    gatewayVersions.set(id, incoming.httpVersion)
  }
  requestStarts.subscribe(observeGatewayRequest)
  cleanups.push(async () => { requestStarts.unsubscribe(observeGatewayRequest) })
  const settings = parseCaddySettings({ publicOrigin: 'https://phone.example.com', dnsProvider: 'tencentcloud', listenPort: 8443 })
  const config = new CaddyConfigStore(root)
  await step(() => config.configure(settings, { secretId: 'fake-id', secretKey: 'fake-key' }))
  await step(() => config.prepareCaddyfile(gateway.address().port))
  const environment = caddyProcessEnvironment(config, settings)
  // Validate the actual DNS-01 template without contacting DNS or acquiring a production certificate.
  await step(() => execFileText(executable, ['adapt', '--config', config.caddyfile, '--adapter', 'caddyfile'], { env: environment, timeout: 15_000 }))
  const rendered = renderCaddyfile(settings, root, gateway.address().port)
  expect(rendered.match(/https:\/\/phone\.example\.com:8443 \{/gu)).toHaveLength(1)
  expect(rendered.match(/\ttls \{\n\t\tdns tencentcloud \{[\s\S]*?\n\t\t\}\n\t\}/gu)).toHaveLength(1)
  const internal = rendered
    .replace('{\n', '{\n\tskip_install_trust\n\tservers {\n\t\tprotocols h1\n\t}\n')
    .replace('https://phone.example.com:8443 {', 'https://phone.example.com:0 {\n\tbind 127.0.0.1')
    .replace(/\ttls \{\n\t\tdns tencentcloud \{[\s\S]*?\n\t\t\}\n\t\}/u, '\ttls internal')
    .replace('output discard', 'output stderr')
  const testConfig = join(config.rootDirectory, 'Caddyfile.internal-test')
  await step(() => writeFile(testConfig, internal, { mode: 0o600 }))
  expect(internal).toContain('\tskip_install_trust\n')
  expect(internal).toContain('https://phone.example.com:0 {\n\tbind 127.0.0.1')
  expect(internal).toContain('\ttls internal\n')
  expect(internal).not.toMatch(/dns|acme|tencentcloud|8443/iu)
  const adapted = JSON.parse((await step(() => execFileText(executable, ['adapt', '--config', testConfig, '--adapter', 'caddyfile'], { env: environment, timeout: 15_000 }))).stdout)
  expect(adapted.apps.tls.automation.policies[0].issuers).toEqual([{ module: 'internal' }])
  expect(adapted.apps.http.servers.srv0.listen).toEqual(['127.0.0.1:0'])
  const proxyHandlers: { transport?: { protocol?: string; keep_alive?: { enabled?: boolean; max_idle_conns_per_host?: number }; versions?: string[] } }[] = []
  const findProxyHandlers = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    const row = value as Record<string, unknown>
    if (row.handler === 'reverse_proxy') proxyHandlers.push(row)
    for (const child of Object.values(row)) findProxyHandlers(child)
  }
  findProxyHandlers(adapted)
  expect(proxyHandlers).toHaveLength(1)
  expect(proxyHandlers[0]!.transport?.protocol).toBe('http')
  expect(proxyHandlers[0]!.transport?.keep_alive?.max_idle_conns_per_host).toBeUndefined()
  expect(proxyHandlers[0]!.transport?.keep_alive?.enabled).toBe(false)
  expect(proxyHandlers[0]!.transport?.versions ?? []).not.toContain('h2c')
  signal.throwIfAborted()
  const child = spawn(executable, ['run', '--config', testConfig, '--adapter', 'caddyfile'], { env: environment, shell: false, windowsHide: true, stdio: 'pipe' })
  const stopChild = ownChild(child)
  let childDiagnostics = ''
  child.stdout.resume(); child.stderr.on('data', (chunk: Buffer) => { childDiagnostics = (childDiagnostics + chunk.toString()).slice(-8192) }); child.stdin.end()
  await step(() => once(child, 'spawn', { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }))
  if (child.pid === undefined) throw new Error('Missing child PID')
  let port = 0
  try {
    await vi.waitFor(async () => {
      if (child.exitCode !== null) throw new Error('Caddy exited: ' + String(child.exitCode))
      port = await step(() => ownedPort(child.pid!, signal))
    }, { timeout: 20_000, interval: 100 })
    signal.throwIfAborted()
  } catch (error) { throw new Error('Caddy listener startup failed: ' + childDiagnostics, { cause: error }) }
  let ca = ''
  await step(() => vi.waitFor(async () => { ca = await step(() => readFile(join(config.dataDirectory, 'pki', 'authorities', 'local', 'root.crt'), 'utf8')) }, { timeout: 10_000 }))
  const discovery = await step(() => exchange(signal, port, ca, '/mobile-access/discovery'))
  expect(discovery.status, '[DEBUG-caddy-live] Discovery response=' + responseDiagnostic(discovery)
    + '; Caddy stderr=' + childDiagnostics).toBe(200)
  expect(JSON.parse(discovery.body).instanceId).toBe(gateway.config.instanceId)
  const unauthenticated = await step(() => exchange(signal, port, ca, '/api/caddy-test-resource'))
  if (unauthenticated.status !== 401) {
    const direct = await step(() => directUnauthenticated(signal, gateway.address().port, '/api/caddy-test-resource')
      .then(responseDiagnostic, (error: unknown) => String(error).slice(0, 2048)))
    throw new Error('[DEBUG-caddy-live] Unauthenticated API expected 401; proxied=' + responseDiagnostic(unauthenticated)
      + '; direct=' + direct + '; Caddy stderr=' + childDiagnostics)
  }
  expect(unauthenticated.status).toBe(401)
  const pairing = await step(() => gateway.access.openPairing())
  const paired = await step(() => exchange(signal, port, ca, '/mobile-access/auth/pair', 'POST', { 'content-type': 'application/json' }, JSON.stringify({ token: pairing.token, label: 'Isolated Caddy test' })))
  expect(paired.status).toBe(201)
  const cookie = paired.headers['set-cookie']?.find(value => value.startsWith(SESSION_COOKIE + '='))?.split(';')[0]
  expect(cookie).toBeDefined()
  const deviceCookie = paired.headers['set-cookie']?.find(value => value.startsWith(DEVICE_COOKIE + '='))?.split(';')[0]
  const deviceToken = parseCookies(deviceCookie)?.get(DEVICE_COOKIE)
  // The cookie serializer uses a raw base64url value, not percent encoding; never log credentials.
  expect(typeof deviceToken === 'string' && deviceToken.length > 0).toBe(true)
  const resource = await step(() => exchange(signal, port, ca, '/api/caddy-test-resource', 'GET', { cookie: cookie! }))
  expect(resource.status).toBe(200); expect(resource.rawBody).toEqual(Buffer.from([0, 1, 2, 250]))
  // Count both hops: success must not be explained by reused sockets or hidden API replay.
  const requestIds = Array.from({ length: 12 }, (_, index) => 'single-use-' + String(index))
  const readResource = async (id: string): Promise<void> => {
    const result = await step(() => exchange(signal, port, ca, '/api/caddy-test-resource?requestId=' + id, 'GET', { cookie: cookie! }))
    expect(result.status).toBe(200)
    expect(result.rawBody).toEqual(Buffer.from([0, 1, 2, 250]))
  }
  for (const id of requestIds.slice(0, 4)) await readResource(id)
  await Promise.all(requestIds.slice(4).map(readResource))
  for (const id of requestIds) {
    expect(gatewayRequests.get(id)).toBe(1)
    expect(upstreamRequests.get(id)).toBe(1)
    expect(upstreamConnections.get(id)).toBe('close')
    expect(gatewayVersions.get(id)).toBe('1.1')
  }
  expect(new Set(requestIds.map(id => gatewaySockets.get(id))).size).toBe(requestIds.length)
  expect(new Set(requestIds.map(id => upstreamSockets.get(id))).size).toBe(requestIds.length)
  const csrfCookie = paired.headers['set-cookie']?.find(value => value.startsWith(CSRF_COOKIE + '='))?.split(';')[0]
  const csrf = parseCookies(csrfCookie)?.get(CSRF_COOKIE)
  expect(csrf).toBeDefined()
  for (const method of ['GET', 'POST']) {
    const id = 'reset-after-consumption-' + method
    const failed = await step(() => exchange(signal, port, ca, '/api/caddy-test-reset?requestId=' + id, method,
      { cookie: cookie!, [CSRF_HEADER]: csrf!, 'content-type': 'application/json' }, method === 'POST' ? '{"sideEffect":true}' : ''))
    expect(failed.status).toBe(502)
    expect(JSON.parse(failed.body)).toEqual({ error: 'upstream_unavailable' })
    expect(gatewayRequests.get(id)).toBe(1)
    expect(upstreamRequests.get(id)).toBe(1)
    expect(consumedBodies.get(id)).toEqual(Buffer.from(method === 'POST' ? '{"sideEffect":true}' : ''))
  }
  for (const method of ['GET', 'POST']) {
    const id = 'gateway-reset-after-side-effect-' + method
    const failed = await step(() => exchange(signal, port, ca, '/api/caddy-test-gateway-reset?requestId=' + id, method,
      { cookie: cookie!, [CSRF_HEADER]: csrf!, 'content-type': 'application/json' }, method === 'POST' ? '{"sideEffect":true}' : ''))
    expect(failed.status).toBe(502)
    expect(gatewayRequests.get(id)).toBe(1)
    expect(upstreamRequests.get(id)).toBe(1)
    expect(consumedBodies.get(id)).toEqual(Buffer.from(method === 'POST' ? '{"sideEffect":true}' : ''))
    expect(gatewayVersions.get(id)).toBe('1.1')
  }
  const socketOptions: WebSocket.ClientOptions & { servername: string } = { ca, servername: 'phone.example.com',
    headers: { host: 'phone.example.com', origin: 'https://phone.example.com', cookie: cookie! },
  }
  signal.throwIfAborted()
  const socket = new WebSocket('wss://127.0.0.1:' + String(port) + '/api/events.mux', socketOptions)
  cleanups.push(async () => { if (socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, 'close', { signal: AbortSignal.timeout(5_000) }); socket.terminate(); await closed } })
  await step(() => once(socket, 'open', { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }))
  signal.throwIfAborted()
  const received = once(socket, 'message', { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }); socket.send('CADDY_WSS_ROUNDTRIP')
  const [echo] = await received; signal.throwIfAborted(); expect(String(echo)).toBe('CADDY_WSS_ROUNDTRIP')
  const socketClosed = once(socket, 'close', { signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) }); socket.terminate(); await socketClosed
  signal.throwIfAborted()
  await step(() => stopChild())
  const pairedBody = JSON.parse(paired.body) as { paired: boolean; deviceId: string; deviceToken?: unknown; sessionExpiresAt: number }
  expect(pairedBody.paired).toBe(true)
  expect(pairedBody.deviceId).toMatch(/^[a-f\d]{32}$/u)
  expect(pairedBody.sessionExpiresAt).toBeGreaterThan(Date.now())
  // Browser pairing withholds the device credential from JSON; durable state stores only its digest.
  expect(pairedBody.deviceToken === undefined).toBe(true)
  signal.throwIfAborted()
  const restartedChild = spawn(executable, ['run', '--config', testConfig, '--adapter', 'caddyfile'], { env: environment, shell: false, windowsHide: true, stdio: 'pipe' })
  const stopRestartedChild = ownChild(restartedChild)
  restartedChild.stdout.resume(); restartedChild.stderr.resume(); restartedChild.stdin.end()
  await step(() => once(restartedChild, 'spawn', { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) }))
  if (restartedChild.pid === undefined) throw new Error('Missing restarted child PID')
  await step(() => vi.waitFor(async () => { port = await step(() => ownedPort(restartedChild.pid!, signal)) }, { timeout: 20_000, interval: 100 }))
  expect((await step(() => exchange(signal, port, ca, '/api/caddy-test-resource', 'GET', { cookie: cookie! }))).rawBody).toEqual(Buffer.from([0, 1, 2, 250]))
  await step(() => stopRestartedChild())
  await step(() => gateway.close())
  const snapshot = await step(() => store.load())
  const deviceBytes = await step(() => readFile(template.stateFile))
  expect(snapshot.devices).toHaveLength(1)
  expect(snapshot.devices[0]).toMatchObject({ id: pairedBody.deviceId, label: 'Isolated Caddy test' })
  expect(snapshot.devices[0]?.tokenDigest === createHash('sha256').update(deviceToken!, 'utf8').digest('hex')).toBe(true)
  expect(deviceBytes.toString().includes(deviceToken!)).toBe(false)
  expect(deviceBytes.toString().includes(cookie!.slice((SESSION_COOKIE + '=').length))).toBe(false)
  const restartedGateway = new MobileAccessGateway(gatewayConfig, new JsonDeviceStore(template.stateFile))
  cleanups.push(() => restartedGateway.close())
  await step(() => restartedGateway.start())
  expect(restartedGateway.access.listDevices()).toEqual([expect.objectContaining({ id: pairedBody.deviceId, label: 'Isolated Caddy test' })])
  expect(restartedGateway.access.authorizeDevice(deviceToken!).deviceId).toBe(pairedBody.deviceId)
  await step(() => restartedGateway.close())
  expect(await step(() => new JsonDeviceStore(template.stateFile).load())).toEqual(snapshot)
  if (fixture !== undefined) {
    const privateKey = join(config.dataDirectory, 'pki', 'authorities', 'local', 'root.key')
    expect((await step(() => readFile(privateKey))).byteLength).toBeGreaterThan(0)
    const cache = join(config.configDirectory, 'owned-test-cache')
    await step(() => writeFile(cache, 'isolated-cache'))
    const providerMarker = join(root, 'components', 'neighbor-provider', 'marker')
    await step(() => mkdir(join(root, 'components', 'neighbor-provider')))
    const dataMarker = join(root, 'neighbor-data')
    await step(() => writeFile(providerMarker, 'provider-preserved'))
    await step(() => writeFile(dataMarker, 'data-preserved'))
    // All owned WSS clients, children and gateways are stopped before mutation or purge.
    expect(ownedChildren.every(owned => owned.closed)).toBe(true)
    await step(() => fixture.corruptAndPurge())
    await step(() => config.purge())
    for (const path of [config.rootDirectory, privateKey, cache]) await step(() => expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' }))
    expect(config.status().configured).toBe(false)
    expect(await step(() => readFile(template.stateFile))).toEqual(deviceBytes)
    expect(await step(() => new JsonDeviceStore(template.stateFile).load())).toEqual(snapshot)
    expect(await step(() => readFile(providerMarker, 'utf8'))).toBe('provider-preserved')
    expect(await step(() => readFile(dataMarker, 'utf8'))).toBe('data-preserved')
  }
  }
  activeBodyTask = body()
  try { await activeBodyTask } finally { clearTimeout(deadline) }
}, 120_000)
