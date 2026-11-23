import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, request as requestHttp, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { type AddressInfo, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { LEGACY_CUSTOM_ASSET_LIMIT } from '../src/extension-limits.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { CSRF_HEADER, SESSION_COOKIE } from '../src/http-security.js'
import { DSH_MOBILE_VERSION } from '../src/version.js'
import { MemoryDeviceStore } from '../src/storage.js'
import { startWithMappedUdpDiscovery } from './udp-discovery-fixture.js'

const cleanups: Array<() => Promise<void>> = []
const TRANSPORT_IDLE_MS = 1000
const VIEW_HEADER = 'x-dsh-mobile-view'
const LAYOUT_ID = '@deepseek-ai/dsh-client-ui-layout'
const HMR_ID = '@deepseek-ai/dsh-client-hmr'
const FOLLOWER_URL = '/mobile-access/mobile-graph-follower.js'

function graph(featureRev = 'feature', modern = false) {
  const entries = [
    { id: '@deepseek-ai/dsh-client-ui-renderer', rev: 'renderer', url: '/plugins/renderer.js?rev=renderer' },
    { id: LAYOUT_ID, rev: 'stock-layout', url: '/plugins/layout.js?rev=stock-layout', inject: [
      '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-theme'] },
    { id: '@deepseek-ai/dsh-client-connection', rev: 'connection', url: '/plugins/connection.js?rev=connection', inject: [] },
    { id: '@deepseek-ai/dsh-api-gateway', rev: 'gateway', url: '/plugins/gateway.js?rev=gateway', inject: ['@deepseek-ai/dsh-client-connection'] },
    { id: '@deepseek-ai/dsh-api-remotes', rev: 'remotes', url: '/plugins/remotes.js?rev=remotes', inject: ['@deepseek-ai/dsh-api-gateway'] },
    { id: '@deepseek-ai/dsh-client-ui-settings', rev: 'settings', url: '/plugins/settings.js?rev=settings', inject: ['@deepseek-ai/dsh-api-remotes'] },
    { id: 'dsh-mobile', rev: 'mobile', url: '/plugins/mobile.js?rev=mobile', inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'] },
    { id: 'feature', rev: featureRev, url: `/plugins/feature.js?rev=${featureRev}` },
    // DSH 0.2.3+ ships plugin graph changes over the authenticated Remote stream.
    ...(modern ? [{ id: HMR_ID, rev: 'hmr', url: '/plugins/hmr.js?rev=hmr', inject: [
      '@deepseek-ai/dsh-api-gateway', '@deepseek-ai/dsh-api-remote-access', '@deepseek-ai/dsh-client-modules'] }] : []),
  ]
  return { rev: 'upstream', entries, batches: [{ phase: 'application', rev: 'upstream-batch', url: '/plugins/all.js?rev=upstream', entries: entries.map(entry => entry.id) }] }
}

afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Event-stream fixture cleanup failed')
})

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>(settle => { resolve = settle }), resolve: value => { resolve(value) } }
}

async function within<T>(promise: Promise<T>, detail: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(detail)), 5000)
    })])
  } finally { clearTimeout(timer) }
}

interface Route {
  readonly arrived: Promise<ServerResponse>
  readonly closed: Promise<void>
}

interface Probe {
  readonly request: ClientRequest
  readonly response: Promise<IncomingMessage>
  readonly closed: Promise<void>
  readonly text: () => string
  readonly body: () => Buffer
  readonly received: (marker: string) => Promise<void>
}

async function fixture(options: { upstreamApiTimeoutMs?: number; transportIdleMs?: number; sessionTtlMs?: number; maxActiveRequests?: number; maxSessions?: number; excluded?: readonly string[]; modern?: boolean; directStart?: boolean; followerBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-sse-'))
  cleanups.push(async () => {
    const inside = relative(tmpdir(), directory)
    if (isAbsolute(inside) || inside.startsWith('..') || !inside.startsWith('dsh-mobile-sse-')) throw new Error('Unsafe SSE fixture root')
    await rm(directory, { recursive: true, force: true })
  })
  const routes = new Map<string, {
    resolve(response: ServerResponse): void
    close(): void
    readonly status: number
    readonly contentType: string
    readonly holdHeaders: boolean
    readonly initial: string | Buffer
    readonly contentEncoding: string | undefined
  }>()
  const sockets = new Set<Socket>()
  let requests = 0
  let indexStatus = 200
  const upstream = createServer((request, response) => {
    requests++
    if (request.url === '/' && request.headers.accept?.includes('text/html')) {
      if (indexStatus !== 200) {
        const status = indexStatus
        indexStatus = 200
        response.writeHead(status)
        response.end()
        return
      }
      const body = `<!doctype html><html><head><script>window.__DSH_BOOT__=${JSON.stringify(graph('feature', options.modern === true))};</script></head><body></body></html>`
      response.writeHead(200, { 'content-type': 'text/html' }); response.end(body); return
    }
    const route = routes.get(request.url ?? '')
    if (route === undefined && request.url?.startsWith('/plugins/')) {
      const body = 'globalThis.__ownedGraphFixture = true;\n'
      response.writeHead(200, { 'content-type': 'text/javascript', 'content-length': String(Buffer.byteLength(body)) })
      response.end(request.method === 'HEAD' ? undefined : body); return
    }
    if (route === undefined) { response.writeHead(404); response.end(); return }
    response.once('close', () => { route.close() })
    route.resolve(response)
    if (route.holdHeaders) return
    response.writeHead(route.status, { 'content-type': route.contentType, 'cache-control': 'no-cache',
      ...(route.contentEncoding === undefined ? {} : { 'content-encoding': route.contentEncoding }) })
    response.write(route.initial)
  })
  upstream.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => { sockets.delete(socket) })
  })
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy()
    if (upstream.listening) await new Promise<void>((resolve, reject) => { upstream.close(error => error ? reject(error) : resolve()) })
  })
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject)
    upstream.listen(0, '127.0.0.1', resolve)
  })
  const upstreamPort = (upstream.address() as AddressInfo).port
  const mobileLayoutFile = join(directory, 'mobile-layout.js')
  await writeFile(mobileLayoutFile, '// owned layout\n')
  const mobileGraphFollowerFile = join(directory, 'mobile-graph-follower.js')
  const followerHead = '// owned follower\n'
  await writeFile(mobileGraphFollowerFile, options.followerBytes === undefined ? followerHead
    : followerHead + ' '.repeat(Math.max(0, options.followerBytes - Buffer.byteLength(followerHead))))
  const config = parseGatewayConfig({ listenHost: '127.0.0.1', listenPort: 0,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`, publicAuthorities: ['127.0.0.1'],
    allowedCidrs: ['127.0.0.0/8'], stateFile: join(directory, 'devices.json'), tls: { mode: 'disabled' },
    upstreamTimeoutMs: options.transportIdleMs ?? TRANSPORT_IDLE_MS, upstreamApiTimeoutMs: options.upstreamApiTimeoutMs ?? 0,
    maxActiveRequests: options.maxActiveRequests ?? 32, maxSessions: options.maxSessions ?? 64,
    mobileLayoutFile, mobileGraphFollowerFile, excludedClientModules: options.excluded ?? [] })
  const gateway = new MobileAccessGateway(options.sessionTtlMs === undefined ? config
    : Object.freeze({ ...config, sessionTtlMs: options.sessionTtlMs }), new MemoryDeviceStore())
  cleanups.push(() => gateway.close())
  // The document cases below exercise HTTP only; the mapped fixture throws on a
  // host that has no broadcast address, which says nothing about these paths.
  if (options.directStart === true) await gateway.start()
  else await startWithMappedUdpDiscovery(gateway)
  const address = gateway.address()
  const pair = async () => gateway.access.pair('owned-stream-client', (await gateway.access.openPairing()).token, 'Event stream test')
  const device = await pair()
  const headers = (session = device.sessionToken, csrf = device.csrfToken): Record<string, string> => ({
    host: new URL(address.origin).host, origin: address.origin, accept: 'text/event-stream',
    cookie: `${SESSION_COOKIE}=${session}`, [CSRF_HEADER]: csrf,
  })
  const route = (path: string, routeOptions: { status?: number; contentType?: string; holdHeaders?: boolean; initial?: string | Buffer; contentEncoding?: string } = {}): Route => {
    const arrived = deferred<ServerResponse>(), closed = deferred<void>()
    routes.set(path, { resolve: arrived.resolve, close: () => { closed.resolve() },
      status: routeOptions.status ?? 200, contentType: routeOptions.contentType ?? 'text/event-stream; charset=utf-8',
      holdHeaders: routeOptions.holdHeaders ?? false, initial: routeOptions.initial ?? ': connected\n\n', contentEncoding: routeOptions.contentEncoding })
    return { arrived: arrived.promise, closed: closed.promise }
  }
  let defaultViewId: string | undefined
  const probe = (path: string, requestOptions: { method?: string; headers?: Record<string, string>; unfinishedBody?: boolean; view?: string | false } = {}): Probe => {
    const received = deferred<IncomingMessage>(), closed = deferred<void>()
    let failed: Error | undefined
    let response: IncomingMessage | undefined
    let body = ''
    const chunks: Buffer[] = []
    const waiting: Array<{ marker: string; resolve(): void; reject(error: Error): void }> = []
    const selectedHeaders = { ...(requestOptions.headers ?? headers()) }
    if (path.split('?', 1)[0] === '/plugins/events' && (requestOptions.method ?? 'GET') === 'GET'
      && requestOptions.unfinishedBody !== true && selectedHeaders.cookie !== undefined && requestOptions.view !== false) {
      const view = requestOptions.view ?? defaultViewId
      if (view !== undefined && selectedHeaders[VIEW_HEADER] === undefined) selectedHeaders[VIEW_HEADER] = view
    }
    const request = requestHttp({ hostname: '127.0.0.1', port: address.port, path, method: requestOptions.method ?? 'GET',
      headers: selectedHeaders, agent: false }, incoming => {
      response = incoming
      received.resolve(incoming)
      incoming.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
        body += chunk.toString('utf8')
        for (const waiter of waiting) if (body.includes(waiter.marker)) waiter.resolve()
      })
      incoming.on('error', error => { failed = error })
    })
    request.on('error', error => { failed = error })
    request.once('close', () => {
      closed.resolve()
      for (const waiter of waiting) if (!body.includes(waiter.marker)) waiter.reject(failed ?? new Error('Stream closed before frame'))
    })
    cleanups.push(async () => { request.destroy(); await within(closed.promise, 'Client request did not close') })
    if (requestOptions.unfinishedBody === true) request.write('x')
    else request.end()
    return { request, response: within(received.promise, 'Upstream headers did not arrive'), closed: closed.promise,
      text: () => body, body: () => Buffer.concat(chunks),
      received: async marker => {
        if (body.includes(marker)) return
        if (response?.destroyed || request.destroyed) throw failed ?? new Error('Response already closed')
        await within(new Promise<void>((resolve, reject) => { waiting.push({ marker, resolve, reject }) }), 'Stream frame did not arrive')
      } }
  }
  const openDocument = async (session = device.sessionToken, csrf = device.csrfToken, stock = false) => {
    const document = probe(stock ? '/?frontend=stock' : '/', { headers: { ...headers(session, csrf), accept: 'text/html' } })
    expect((await document.response).statusCode).toBe(200)
    await within(document.closed, 'Owned HTML did not complete')
    const html = document.text()
    const viewId = /headers\.set\("x-dsh-mobile-view","([a-f0-9]{32})"\)/u.exec(html)?.[1]
    const source = /window\.__DSH_BOOT__=(\{[^<]+\});<\/script>/u.exec(html)?.[1]
    if (source === undefined) throw new Error('Owned HTML graph was not found')
    return { viewId, graph: JSON.parse(source) as ReturnType<typeof graph>, html }
  }
  const initialDocument = await openDocument()
  defaultViewId = initialDocument.viewId
  expect(defaultViewId).toMatch(/^[a-f0-9]{32}$/u)
  requests = 0
  return { gateway, device, route, probe, headers, pair, openDocument, initialDocument, graph, requests: () => requests,
    failNextIndex: (status: number) => { indexStatus = status } }
}

describe('dedicated document graph refresh', () => {
  const GRAPH_PATH = '/mobile-access/client-graph'

  it('returns the projected graph only to the document’s paired Session', async () => {
    const test = await fixture({ excluded: ['feature'], directStart: true })
    const view = test.initialDocument.viewId!
    // Every pairing creates its own device, so this is another device's Session.
    const other = await test.pair()
    for (const [headers, status] of [
      [{ ...test.headers(), cookie: '', [VIEW_HEADER]: view }, 401],
      [test.headers(), 409],
      [{ ...test.headers(other.sessionToken, other.csrfToken), [VIEW_HEADER]: view }, 409],
      [{ ...test.headers(), [VIEW_HEADER]: '0'.repeat(32) }, 409],
    ] as const) {
      const rejected = test.probe(GRAPH_PATH, { headers })
      expect((await rejected.response).statusCode).toBe(status)
    }
    expect(test.requests()).toBe(0)
    const permitted = test.probe(GRAPH_PATH, { headers: { ...test.headers(), [VIEW_HEADER]: view } })
    const response = await permitted.response
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toContain('no-store')
    expect(response.headers['set-cookie']).toBeUndefined()
    await within(permitted.closed, 'Graph response did not finish')
    const refreshed = JSON.parse(permitted.text()) as ReturnType<typeof graph>
    expect(refreshed.entries.find(row => row.id === LAYOUT_ID)?.rev).toBe(`dsh-mobile-layout-${DSH_MOBILE_VERSION}`)
    expect(refreshed.entries.map(row => row.id)).not.toContain('feature')
    expect(refreshed).toEqual(test.initialDocument.graph)
  })

  it('serves the Mobile graph follower only as an authenticated script asset', async () => {
    const test = await fixture({ directStart: true })
    const anonymous = test.probe(FOLLOWER_URL, { headers: { ...test.headers(), cookie: '' } })
    expect((await anonymous.response).statusCode).toBe(401)
    await within(anonymous.closed, 'Anonymous follower request did not complete')
    const served = test.probe(FOLLOWER_URL, { headers: { ...test.headers(), accept: '*/*' } })
    const response = await served.response
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8')
    await within(served.closed, 'Follower asset did not complete')
    expect(served.text()).toBe('// owned follower\n')
  })

  it('serves a follower bundle larger than the customization asset cap', async () => {
    // The built follower is hundreds of KB, while user CSS/JS assets stop at 256 KiB.
    // The asset route is what an overflow batch or a client retry fetches.
    const size = LEGACY_CUSTOM_ASSET_LIMIT + 64 * 1024
    const test = await fixture({ directStart: true, followerBytes: size })
    const served = test.probe(FOLLOWER_URL, { headers: { ...test.headers(), accept: '*/*' } })
    const response = await served.response
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-encoding']).toBeUndefined()
    await within(served.closed, 'Follower asset did not complete')
    expect(served.body().byteLength).toBe(size)
  })

  it('still refuses a follower bundle above the boot entry cap', async () => {
    const test = await fixture({ directStart: true, followerBytes: 8 * 1024 * 1024 + 1 })
    const served = test.probe(FOLLOWER_URL, { headers: { ...test.headers(), accept: '*/*' } })
    const response = await served.response
    expect(response.statusCode).toBe(413)
    await within(served.closed, 'Oversized follower response did not complete')
    expect(JSON.parse(served.text())).toEqual({ error: 'payload_too_large' })
  })

  it('binds a modern Remote graph host to the Mobile follower and this document’s view', async () => {
    const test = await fixture({ modern: true, directStart: true })
    const { viewId, html, graph: boot } = test.initialDocument
    expect(viewId).toMatch(/^[a-f0-9]{32}$/u)
    expect(html).toContain(`window.__DSH_MOBILE_GRAPH_VIEW__="${viewId}";`)
    const follower = boot.entries.find(row => row.id === HMR_ID)
    expect(follower?.url).toBe(FOLLOWER_URL)
    expect(follower?.rev).toBe(`dsh-mobile-graph-${DSH_MOBILE_VERSION}`)
    expect(boot.entries.find(row => row.id === LAYOUT_ID)?.url).toBe('/mobile-access/mobile-layout.js')
    // The follower code ships inside a Mobile-owned merged batch, never as a stock pass-through row.
    const carriers = boot.batches.filter(batch => batch.entries.includes(HMR_ID))
    expect(carriers).toHaveLength(1)
    expect(carriers[0]?.url).toMatch(/^\/mobile-access\/mobile-boot\/[a-f0-9]{64}\.js$/u)
    const refreshed = test.probe(GRAPH_PATH, { headers: { ...test.headers(), [VIEW_HEADER]: viewId! } })
    expect((await refreshed.response).statusCode).toBe(200)
    await within(refreshed.closed, 'Modern graph refresh did not complete')
    expect(JSON.parse(refreshed.text())).toEqual(boot)
  })

  it('keeps a legacy graph host on its event stream without a follower or view binding', async () => {
    const test = await fixture({ directStart: true })
    const { viewId, html, graph: boot } = test.initialDocument
    expect(viewId).toMatch(/^[a-f0-9]{32}$/u)
    expect(html).not.toContain('__DSH_MOBILE_GRAPH_VIEW__')
    expect(boot.entries.some(row => row.url === FOLLOWER_URL)).toBe(false)
  })

  it('answers 502 once and stays usable when the upstream index fails', async () => {
    const test = await fixture({ directStart: true })
    const headers = { ...test.headers(), [VIEW_HEADER]: test.initialDocument.viewId! }
    test.failNextIndex(500)
    const failed = test.probe(GRAPH_PATH, { headers })
    expect((await failed.response).statusCode).toBe(502)
    await within(failed.closed, 'Failed graph refresh did not complete')
    expect(JSON.parse(failed.text())).toEqual({ error: 'upstream_unavailable' })
    const recovered = test.probe(GRAPH_PATH, { headers })
    expect((await recovered.response).statusCode).toBe(200)
    await within(recovered.closed, 'Recovered graph refresh did not complete')
  })
})

describe('authenticated DSH graph event streams', () => {
  it.each(['identity', 'gzip'])('delivers a graph after transport idle with %s accepted', async encoding => {
    const test = await fixture({ maxActiveRequests: 2 })
    const events = test.route('/plugins/events', { contentType: 'Text/Event-Stream; Charset=UTF-8' })
    const ordinary = test.route('/plugins/ordinary.js', { contentType: 'text/event-stream' })
    const stream = test.probe('/plugins/events', { headers: { ...test.headers(), 'accept-encoding': encoding } })
    const control = test.probe('/plugins/ordinary.js')
    const response = await stream.response
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-encoding']).toBeUndefined()
    await stream.received(': connected')
    await control.response
    await within(control.closed, 'Ordinary route lost its transport timeout')
    await within(ordinary.closed, 'Ordinary upstream stayed open after timeout')
    const marker = `data: ${JSON.stringify({ type: 'graph', graph: test.graph('after-idle') })}\n\n`
    const upstream = await events.arrived
    upstream.write(marker)
    await stream.received('"rev":"after-idle"')
    expect(stream.request.destroyed).toBe(false)
    stream.request.destroy()
    await within(stream.closed, 'Cancelled SSE client stayed open')
    await within(events.closed, 'Cancelled SSE upstream stayed open')
  })

  it.each([
    { label: 'a non-SSE response', path: '/plugins/events', status: 200, contentType: 'application/json', method: 'GET' },
    { label: 'a lookalike media type', path: '/plugins/events', status: 200, contentType: 'text/event-streaming', method: 'GET' },
    { label: 'a non-200 response', path: '/plugins/events', status: 201, contentType: 'text/event-stream', method: 'GET' },
    { label: 'a different plugin path', path: '/plugins/events-extra', status: 200, contentType: 'text/event-stream', method: 'GET' },
    { label: 'a write request', path: '/plugins/events', status: 200, contentType: 'text/event-stream', method: 'POST' },
  ])('keeps the ordinary deadline for $label', async ({ path, status, contentType, method }) => {
    const test = await fixture()
    const route = test.route(path, { status, contentType })
    const stream = test.probe(path, { method, view: false })
    expect((await stream.response).statusCode).toBe(status)
    await stream.received(': connected')
    await within(stream.closed, 'Unrecognized event route lost its deadline')
    await within(route.closed, 'Rejected event upstream remained open')
  })

  it('does not disable the header or unfinished-body deadline for the event path', async () => {
    const test = await fixture()
    const delayed = test.route('/plugins/events', { holdHeaders: true })
    const beforeHeaders = test.probe('/plugins/events')
    await within(delayed.arrived, 'Held header request did not reach upstream')
    expect((await beforeHeaders.response).statusCode).toBe(504)
    await within(delayed.closed, 'Timed-out header request stayed open upstream')
    const sending = test.route('/plugins/events')
    const withBody = test.probe('/plugins/events', { headers: { ...test.headers(), 'content-length': '2' }, unfinishedBody: true })
    expect((await withBody.response).statusCode).toBe(200)
    await withBody.received(': connected')
    await within(withBody.closed, 'Unfinished GET body lost its transport deadline')
    await within(sending.closed, 'Unfinished GET upstream stayed open')
  })

  it('honors the configured authenticated-response idle budget', async () => {
    const test = await fixture({ upstreamApiTimeoutMs: 100 })
    const ordinary = test.route('/plugins/ordinary.js')
    const control = test.probe('/plugins/ordinary.js')
    await control.response
    await control.received(': connected')
    const route = test.route('/plugins/events')
    const stream = test.probe('/plugins/events')
    await stream.response
    await stream.received(': connected')
    await within(stream.closed, 'Configured event response idle budget was ignored')
    await within(route.closed, 'Expired configured event stream remained upstream')
    expect(control.request.destroyed).toBe(false)
    await within(control.closed, 'Ordinary control never reached its later deadline')
    await within(ordinary.closed, 'Ordinary control remained open upstream')
  })

  it('retains active-request limits and frees the slot after client cancellation', async () => {
    const test = await fixture({ maxActiveRequests: 1 })
    const route = test.route('/plugins/events')
    const stream = test.probe('/plugins/events')
    await stream.response
    await stream.received(': connected')
    const busy = test.probe('/plugins/events')
    expect((await busy.response).statusCode).toBe(429)
    await within(busy.closed, 'Busy response did not end')
    expect(test.requests()).toBe(1)
    stream.request.destroy()
    await within(stream.closed, 'Cancelled stream did not close')
    await within(route.closed, 'Cancelled upstream did not close')
    const again = test.route('/plugins/events?retry=explicit')
    const retried = test.probe('/plugins/events?retry=explicit')
    expect((await retried.response).statusCode).toBe(200)
    await retried.received(': connected')
    retried.request.destroy()
    await within(retried.closed, 'Retried stream did not close')
    await within(again.closed, 'Retried upstream did not close')
  })

  it('still compresses ordinary plugin scripts when gzip is accepted', async () => {
    const test = await fixture()
    const route = test.route('/plugins/ordinary.js', { contentType: 'text/javascript; charset=utf-8' })
    const script = test.probe('/plugins/ordinary.js', { headers: { ...test.headers(), 'accept-encoding': 'gzip' } })
    const upstream = await route.arrived
    upstream.end('globalThis.__ordinaryScript = true;\n')
    const response = await script.response
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-encoding']).toBe('gzip')
    await within(script.closed, 'Ordinary script did not finish')
    expect(gunzipSync(script.body()).toString('utf8')).toContain('globalThis.__ordinaryScript = true;')
    await within(route.closed, 'Ordinary script remained upstream')
  })

  it('does not replay an event stream after upstream disconnects following its first frame', async () => {
    const test = await fixture({ maxActiveRequests: 1 })
    const route = test.route('/plugins/events')
    const stream = test.probe('/plugins/events')
    await stream.response
    await stream.received(': connected')
    const upstream = await route.arrived
    upstream.destroy()
    await within(stream.closed, 'Broken upstream retained the downstream stream')
    await within(route.closed, 'Broken upstream did not close')
    expect(test.requests()).toBe(1)
    const followUpRoute = test.route('/plugins/after-disconnect.js')
    const followUp = test.probe('/plugins/after-disconnect.js')
    expect((await followUp.response).statusCode).toBe(200)
    const response = await followUpRoute.arrived
    response.end('// explicit follow-up\n')
    await within(followUp.closed, 'Explicit follow-up did not finish')
    await within(followUpRoute.closed, 'Explicit follow-up stayed upstream')
    expect(test.requests()).toBe(2)
  })

  it('rejects missing authentication without connecting to the event upstream', async () => {
    const test = await fixture()
    test.route('/plugins/events')
    const rejected = test.probe('/plugins/events', { headers: { host: new URL(test.gateway.address().origin).host, accept: 'text/event-stream' } })
    expect((await rejected.response).statusCode).toBe(401)
    await within(rejected.closed, 'Unauthorized response did not end')
    expect(test.requests()).toBe(0)
  })

  it('closes an established stream when its Session expires', async () => {
    const test = await fixture({ sessionTtlMs: 2000 })
    const route = test.route('/plugins/events')
    const stream = test.probe('/plugins/events')
    await stream.response
    await stream.received(': connected')
    await within(stream.closed, 'Expired Session kept its SSE client')
    await within(route.closed, 'Expired Session kept its SSE upstream')
    expect(() => test.gateway.access.authorizeSession(test.device.sessionToken)).toThrow()
    const rejected = test.probe('/plugins/events')
    expect((await rejected.response).statusCode).toBe(401)
  })

  it('revokes only the selected device stream and preserves another device', async () => {
    const test = await fixture()
    const first = test.route('/plugins/events?device=first')
    const stream = test.probe('/plugins/events?device=first')
    await stream.response
    await stream.received(': connected')
    const other = await test.pair()
    const otherDocument = await test.openDocument(other.sessionToken, other.csrfToken)
    const second = test.route('/plugins/events?device=second')
    const retained = test.probe('/plugins/events?device=second', { headers: test.headers(other.sessionToken, other.csrfToken), view: otherDocument.viewId! })
    await retained.response
    await retained.received(': connected')
    expect(await test.gateway.access.revokeDevice(test.device.deviceId)).toBe(true)
    await within(stream.closed, 'Revoked device SSE stayed open')
    await within(first.closed, 'Revoked device upstream stayed open')
    const upstream = await second.arrived
    upstream.write(`data: ${JSON.stringify({ type: 'graph', graph: test.graph('retained') })}\n\n`)
    await retained.received('"rev":"retained"')
    expect(retained.request.destroyed).toBe(false)
  })

  it('drains event streams and releases its listener on Gateway close', async () => {
    const test = await fixture()
    const route = test.route('/plugins/events')
    const stream = test.probe('/plugins/events')
    await stream.response
    await stream.received(': connected')
    const address = test.gateway.address()
    const activeRequests: unknown = Reflect.get(test.gateway, 'activeRequests')
    if (!(activeRequests instanceof Map)) throw new Error('Gateway active-request owner changed')
    const active: unknown = activeRequests.values().next().value
    if (active === null || typeof active !== 'object') throw new Error('Live request owner missing')
    const timer: unknown = Reflect.get(active, 'timer')
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    try {
      await within(test.gateway.close(), 'Gateway close did not settle')
      expect(clear).toHaveBeenCalledWith(timer)
    } finally { clear.mockRestore() }
    await within(stream.closed, 'Gateway close retained its SSE client')
    await within(route.closed, 'Gateway close retained its SSE upstream')
    const replacement = createServer()
    cleanups.push(async () => { if (replacement.listening) await new Promise<void>(resolve => { replacement.close(() => resolve()) }) })
    await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(address.port, '127.0.0.1', resolve) })
    expect(replacement.listening).toBe(true)
  })

  it('projects the initial graph identically to its document and strips the private view header', async () => {
    const test = await fixture()
    const route = test.route('/plugins/events')
    const stream = test.probe('/plugins/events', { headers: { ...test.headers(), 'accept-encoding': 'gzip' } })
    await stream.response
    await stream.received(': connected')
    const upstream = await route.arrived
    expect(upstream.req.headers[VIEW_HEADER]).toBeUndefined()
    expect(upstream.req.headers['accept-encoding']).toBe('identity')
    const raw = test.graph()
    upstream.write(`data: ${JSON.stringify({ type: 'graph', graph: raw })}\n\n`)
    await stream.received(`data: ${JSON.stringify({ type: 'graph', graph: test.initialDocument.graph })}\n\n`)
    expect(raw.entries.find(entry => entry.id === LAYOUT_ID)?.rev).toBe('stock-layout')
    expect(test.initialDocument.graph.entries.find(entry => entry.id === LAYOUT_ID)?.rev).toBe(`dsh-mobile-layout-${DSH_MOBILE_VERSION}`)
    const batch = test.initialDocument.graph.batches.find(value => value.url.startsWith('/mobile-access/mobile-boot/'))
    expect(batch).toBeDefined()
    if (batch === undefined) throw new Error('Projected batch missing')
    const servedBatch = test.probe(batch.url)
    expect((await servedBatch.response).statusCode).toBe(200)
    await within(servedBatch.closed, 'Projected batch did not complete')
    expect(servedBatch.text()).toContain('__ownedGraphFixture')
    stream.request.destroy()
    await within(stream.closed, 'Projected stream did not close')
    await within(route.closed, 'Projected upstream did not close')
  })

  it('keeps the current document selection frozen while new documents use saved preferences', async () => {
    const test = await fixture({ excluded: ['feature'] })
    const route = test.route('/plugins/events')
    const stream = test.probe('/plugins/events')
    await stream.response
    await stream.received(': connected')
    await test.gateway.configureClientModules([], test.device.deviceId)
    const newlyOpened = await test.openDocument()
    expect(newlyOpened.graph.entries.some(entry => entry.id === 'feature')).toBe(true)
    expect(test.initialDocument.graph.entries.some(entry => entry.id === 'feature')).toBe(false)
    const upstream = await route.arrived
    upstream.write(`data: ${JSON.stringify({ type: 'graph', graph: test.graph() })}\n\n`)
    await stream.received(`data: ${JSON.stringify({ type: 'graph', graph: test.initialDocument.graph })}\n\n`)
    expect(stream.text()).not.toContain('"id":"feature"')
  })

  it('ignores only upstream layout rebuilds and retains optional-module rebuild delivery', async () => {
    const test = await fixture()
    const route = test.route('/plugins/events')
    const stream = test.probe('/plugins/events')
    await stream.response
    await stream.received(': connected')
    const upstream = await route.arrived
    upstream.write(`data: ${JSON.stringify({ type: 'rebuilt', id: LAYOUT_ID, rev: 'foreign-layout-rebuild' })}\n\n`)
    const featureFrame = JSON.stringify({ type: 'rebuilt', id: 'feature', rev: 'feature-updated' })
    upstream.write(`data: ${featureFrame}\n\n`)
    await stream.received(`data: ${featureFrame}\n\n`)
    expect(stream.text()).not.toContain('foreign-layout-rebuild')
  })

  it('keeps raw stock events independent of a simultaneous Mobile document view', async () => {
    const test = await fixture({ maxSessions: 1, excluded: ['feature'] })
    const stockDocument = await test.openDocument(test.device.sessionToken, test.device.csrfToken, true)
    expect(stockDocument.viewId).toBeUndefined()
    expect(stockDocument.graph.entries.some(entry => entry.id === 'feature')).toBe(true)
    const mobileRoute = test.route('/plugins/events?document=mobile')
    const stockRoute = test.route('/plugins/events?document=stock')
    const mobile = test.probe('/plugins/events?document=mobile')
    const stock = test.probe('/plugins/events?document=stock', { view: false })
    await Promise.all([mobile.response, stock.response])
    await Promise.all([mobile.received(': connected'), stock.received(': connected')])
    const rawFrame = `data: ${JSON.stringify({ type: 'graph', graph: test.graph() })}\n\n`
    ;(await mobileRoute.arrived).write(rawFrame)
    ;(await stockRoute.arrived).write(rawFrame)
    await mobile.received(`data: ${JSON.stringify({ type: 'graph', graph: test.initialDocument.graph })}\n\n`)
    await stock.received(rawFrame)
    expect(mobile.text()).not.toContain('"id":"feature"')
    expect(stock.text()).toContain('"rev":"stock-layout"')
  })

  it('rejects unknown, cross-device and renewed-Session view ids without upstream requests', async () => {
    const test = await fixture()
    test.route('/plugins/events')
    const unknown = test.probe('/plugins/events', { view: '0'.repeat(32) })
    expect((await unknown.response).statusCode).toBe(409)
    await within(unknown.closed, 'Unknown view response did not end')
    const other = await test.pair()
    const crossDevice = test.probe('/plugins/events', { headers: test.headers(other.sessionToken, other.csrfToken) })
    expect((await crossDevice.response).statusCode).toBe(409)
    await within(crossDevice.closed, 'Cross-device view response did not end')
    const renewed = await test.gateway.access.renew(test.device.deviceToken)
    const crossSession = test.probe('/plugins/events', { headers: test.headers(renewed.sessionToken, renewed.csrfToken) })
    expect((await crossSession.response).statusCode).toBe(409)
    await within(crossSession.closed, 'Renewed Session view response did not end')
    expect(test.requests()).toBe(0)
    const fresh = await test.openDocument(renewed.sessionToken, renewed.csrfToken)
    if (fresh.viewId === undefined) throw new Error('New Session document view missing')
    const reconnected = test.probe('/plugins/events', { headers: test.headers(renewed.sessionToken, renewed.csrfToken), view: fresh.viewId })
    expect((await reconnected.response).statusCode).toBe(200)
    await reconnected.received(': connected')
  })

  it('bounds document views, aborts an evicted stream and refuses its old id', async () => {
    const test = await fixture({ maxSessions: 1 })
    const route = test.route('/plugins/events')
    const stream = test.probe('/plugins/events')
    await stream.response
    await stream.received(': connected')
    const replacement = await test.openDocument()
    expect(replacement.viewId).not.toBe(test.initialDocument.viewId)
    await within(stream.closed, 'Evicted document retained its stream')
    await within(route.closed, 'Evicted document retained upstream work')
    const stale = test.probe('/plugins/events')
    expect((await stale.response).statusCode).toBe(409)
    await within(stale.closed, 'Evicted view response did not end')
    const validRoute = test.route('/plugins/events?new-document')
    const valid = test.probe('/plugins/events?new-document', { view: replacement.viewId! })
    expect((await valid.response).statusCode).toBe(200)
    await valid.received(': connected')
    valid.request.destroy()
    await within(valid.closed, 'New document stream did not close')
    await within(validRoute.closed, 'New document upstream did not close')
  })

  it('terminates malformed graph projection instead of forwarding the raw frame', async () => {
    const test = await fixture()
    const route = test.route('/plugins/events')
    const stream = test.probe('/plugins/events')
    await stream.response
    await stream.received(': connected')
    const upstream = await route.arrived
    upstream.write('data: {"type":"graph","graph":{"rev":"raw-invalid"}}\n\n')
    await within(stream.closed, 'Malformed graph did not terminate its stream')
    await within(route.closed, 'Malformed graph left upstream open')
    expect(stream.text()).not.toContain('raw-invalid')
  })

  it.each([
    { label: 'non-200 SSE', status: 201, contentType: 'text/event-stream' },
    { label: 'plain text', status: 200, contentType: 'text/plain' },
    { label: 'lookalike SSE', status: 200, contentType: 'text/event-streaming' },
  ])('refuses a marked view $label response instead of forwarding raw graph bytes', async ({ status, contentType }) => {
    const test = await fixture()
    const route = test.route('/plugins/events', { status, contentType,
      initial: 'data: {"type":"graph","graph":{"rev":"raw-must-not-leak"}}\n\n' })
    const stream = test.probe('/plugins/events')
    expect((await stream.response).statusCode).toBe(502)
    await within(stream.closed, 'Invalid marked stream did not end')
    await within(route.closed, 'Invalid marked stream retained upstream')
    expect(stream.text()).not.toContain('raw-must-not-leak')
  })

  it('keeps marked graph streams non-cacheable even when their query resembles a static revision', async () => {
    const test = await fixture()
    const route = test.route('/plugins/events?rev=owned-revision')
    const stream = test.probe('/plugins/events?rev=owned-revision')
    const response = await stream.response
    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    await stream.received(': connected')
    stream.request.destroy()
    await within(stream.closed, 'Revisioned graph stream did not close')
    await within(route.closed, 'Revisioned graph upstream did not close')
  })

  it('rejects an encoded marked upstream that ignores the identity request', async () => {
    const test = await fixture()
    const route = test.route('/plugins/events', { contentEncoding: 'gzip',
      initial: gzipSync(Buffer.from(`data: ${JSON.stringify({ type: 'graph', graph: test.graph() })}\n\n`)) })
    const stream = test.probe('/plugins/events')
    expect((await stream.response).statusCode).toBe(502)
    await within(stream.closed, 'Encoded marked stream did not end')
    await within(route.closed, 'Encoded marked stream retained upstream')
    expect(stream.text()).not.toContain('stock-layout')
    expect(stream.text()).not.toContain('"type":"graph"')
  })

  it.each(['client cancellation', 'Gateway close'])('drains held graph-size probes on %s without publishing late work', async ending => {
    const test = await fixture({ maxActiveRequests: 1, transportIdleMs: 5000 })
    const eventRoute = test.route('/plugins/events')
    const stream = test.probe('/plugins/events')
    await stream.response
    await stream.received(': connected')
    const next = test.graph('held-projection')
    const held: Route[] = []
    let sequence = 0
    for (const entry of next.entries) {
      if (entry.id === LAYOUT_ID) continue
      entry.url = `/plugins/held-${++sequence}.js?rev=held-projection`
      entry.rev = 'held-projection'
      held.push(test.route(entry.url, { holdHeaders: true }))
    }
    const upstream = await eventRoute.arrived
    upstream.write(`data: ${JSON.stringify({ type: 'graph', graph: next })}\n\n`)
    const heldResponses = await within(Promise.all(held.map(route => route.arrived)), 'Projection probes never entered their held responses')
    expect(heldResponses).toHaveLength(7)
    expect(heldResponses.every(response => !response.destroyed)).toBe(true)
    if (ending === 'Gateway close') await within(test.gateway.close(), 'Gateway close did not drain graph projection')
    else stream.request.destroy()
    await within(stream.closed, 'Terminated projection kept its client open')
    await within(eventRoute.closed, 'Terminated projection kept its event upstream open')
    await within(Promise.all(held.map(route => route.closed)), 'Terminated projection kept size probes open')
    expect(heldResponses.every(response => response.destroyed)).toBe(true)
    expect(stream.text()).not.toContain('held-projection')
    if (ending === 'client cancellation') {
      const followUp = test.probe('/plugins/after-projection.js')
      expect((await followUp.response).statusCode).toBe(200)
      await within(followUp.closed, 'Drained projection did not release its request slot')
    }
  })
})
