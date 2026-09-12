import { Context } from '@deepseek-ai/cordis'
import { createServer, request as requestHttp, type ClientRequest, type IncomingMessage } from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessService } from '../src/extensions.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { CSRF_HEADER, SESSION_COOKIE } from '../src/http-security.js'
import { MemoryDeviceStore } from '../src/storage.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

async function request(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body
    const headers = { ...options.headers, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) }
    const outgoing = requestHttp({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error', reject); outgoing.end(body)
  })
}

function cookie(headers: Record<string, string | string[] | undefined>, name: string): string {
  const values = headers['set-cookie']; const list = Array.isArray(values) ? values : values === undefined ? [] : [values]
  return list.find(value => value.startsWith(`${name}=`))?.split(';', 1)[0] ?? ''
}

function pendingRequest(port: number, path: string, method: string, headers: Record<string, string>): {
  outgoing: ClientRequest
  result: Promise<{ status: number; body: string }>
} {
  let settle: ((response: IncomingMessage) => void) | undefined
  let fail: ((error: Error) => void) | undefined
  const received = new Promise<IncomingMessage>((resolve, reject) => { settle = resolve; fail = reject })
  const outgoing = requestHttp({ host: '127.0.0.1', port, path, method, headers, agent: false }, response => settle?.(response))
  outgoing.once('error', error => fail?.(error))
  const result = received.then(response => new Promise<{ status: number; body: string }>((resolve) => {
    const chunks: Buffer[] = []
    response.on('data', chunk => chunks.push(Buffer.from(chunk)))
    response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
  }))
  return { outgoing, result }
}

async function openEventStream(port: number, headers: Record<string, string>): Promise<{
  readonly response: IncomingMessage
  readonly waitFor: (value: string) => Promise<string>
  readonly close: () => void
}> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = requestHttp({
      host: '127.0.0.1', port, path: '/mobile-access/extensions/events',
      method: 'GET', headers, agent: false,
    }, resolve)
    outgoing.once('error', reject)
    outgoing.end()
  })
  response.setEncoding('utf8')
  let body = ''
  response.on('data', chunk => { body += String(chunk) })
  const waitFor = (value: string): Promise<string> => new Promise((resolve, reject) => {
    if (body.includes(value)) { resolve(body); return }
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`event stream did not contain ${value}`)) }, 4_000)
    const data = (): void => { if (body.includes(value)) { cleanup(); resolve(body) } }
    const ended = (): void => { cleanup(); reject(new Error('event stream ended early')) }
    const cleanup = (): void => {
      clearTimeout(timeout)
      response.removeListener('data', data)
      response.removeListener('end', ended)
      response.removeListener('aborted', ended)
    }
    response.on('data', data)
    response.once('end', ended)
    response.once('aborted', ended)
  })
  return { response, waitFor, close: () => { response.destroy() } }
}

describe('gateway extension namespace', () => {
  it('authenticates actions and routes while keeping the upstream proxy intact', async () => {
    const upstream = createServer((_, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><script>window.__DSH_BOOT__ = {"rev":"x","entries":[{"id":"@deepseek-ai/dsh-client-ui-layout","url":"/layout.js","rev":"x","inject":["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-theme"]}]};</script>') })
    const upstreamPort = await listen(upstream)
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-gateway-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context)
    service.registerExtension({
      schemaVersion: 1, id: 'hello', name: 'Hello', version: '1.0.0',
      actions: { echo: { run: async (_context, input) => ({ input }) } },
      routes: [
        { method: 'GET', path: 'status', handle: async () => ({ contentType: 'application/json', body: JSON.stringify({ ok: true }) }) },
        { method: 'GET', path: 'bad-status', handle: async () => ({ status: 99, body: 'invalid' }) },
        { method: 'GET', path: 'bad-content-type', handle: async () => ({ contentType: 'text/plain\r\nx-extension: injected', body: 'invalid' }) },
        { method: 'GET', path: 'bad-content-control', handle: async () => ({ contentType: 'text/plain\u0000', body: 'invalid' }) },
      ],
    })
    const config = parseGatewayConfig({ listenHost: '127.0.0.1', listenPort: 0, upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`, publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'], stateFile: join(directory, 'devices.json'), tls: { mode: 'disabled' } })
    const gateway = new MobileAccessGateway(config, new MemoryDeviceStore(), service)
    await gateway.start(); cleanups.push(() => gateway.close())
    const opened = await gateway.access.openPairing()
    const origin = gateway.address().origin
    const paired = await request(gateway.address().port, '/mobile-access/auth/pair', { method: 'POST', headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify({ token: opened.token }) })
    expect(paired.status).toBe(201)
    const session = cookie(paired.headers, SESSION_COOKIE); const csrf = JSON.parse(paired.body) as { csrfToken: string }
    const headers = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', cookie: session, [CSRF_HEADER]: csrf.csrfToken, 'content-type': 'application/json' }
    const action = await request(gateway.address().port, '/mobile-access/extensions/hello/actions/echo', { method: 'POST', headers, body: JSON.stringify({ value: 1 }) })
    expect(action.status).toBe(200); expect(JSON.parse(action.body)).toEqual({ input: { value: 1 } })
    const route = await request(gateway.address().port, '/mobile-access/extensions/hello/routes/status', { headers })
    expect(route.status).toBe(200); expect(JSON.parse(route.body)).toEqual({ ok: true })
    const invalidStatus = await request(gateway.address().port, '/mobile-access/extensions/hello/routes/bad-status', { headers })
    expect(invalidStatus.status).toBe(500); expect(JSON.parse(invalidStatus.body)).toEqual({ error: 'invalid_route_response' })
    const invalidContentType = await request(gateway.address().port, '/mobile-access/extensions/hello/routes/bad-content-type', { headers })
    expect(invalidContentType.status).toBe(500); expect(JSON.parse(invalidContentType.body)).toEqual({ error: 'invalid_route_response' })
    const invalidContentControl = await request(gateway.address().port, '/mobile-access/extensions/hello/routes/bad-content-control', { headers })
    expect(invalidContentControl.status).toBe(500); expect(JSON.parse(invalidContentControl.body)).toEqual({ error: 'invalid_route_response' })
  })

  it('routes old mobile UI requests to their retained Host and asset generation', async () => {
    const upstream = createServer((_, response) => { response.writeHead(200); response.end('ok') })
    const upstreamPort = await listen(upstream)
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
    const state = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-generation-gateway-'))
    cleanups.push(() => rm(state, { recursive: true, force: true }))
    const extensionRoot = join(state, 'extensions')
    const directory = join(extensionRoot, 'demo')
    await mkdir(join(directory, 'assets'), { recursive: true })
    await writeFile(join(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'demo', name: 'Demo', version: '1.0.0' }))
    await writeFile(join(directory, 'mobile.js'), 'window.dshMobile.define({apiVersion:1,id:"demo",activate(){}})')
    await writeFile(join(directory, 'assets', 'value.txt'), 'one')
    await writeFile(join(directory, 'host.mjs'), 'export default async api => api.action("ping", { async run() { return 1 } })')
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context)
    await service.startLocal(extensionRoot, context); cleanups.push(() => service.stopLocal())
    const first = service.manifest()[0]?.generation as string

    const config = parseGatewayConfig({ listenHost: '127.0.0.1', listenPort: 0, upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`, publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'], stateFile: join(state, 'devices.json'), tls: { mode: 'disabled' } })
    const gateway = new MobileAccessGateway(config, new MemoryDeviceStore(), service)
    await gateway.start(); cleanups.push(() => gateway.close())
    const origin = gateway.address().origin
    const opened = await gateway.access.openPairing()
    const paired = await request(gateway.address().port, '/mobile-access/auth/pair', { method: 'POST', headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify({ token: opened.token }) })
    const session = cookie(paired.headers, SESSION_COOKIE); const csrf = JSON.parse(paired.body) as { csrfToken: string }
    const headers = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', cookie: session, [CSRF_HEADER]: csrf.csrfToken, 'content-type': 'application/json' }

    await writeFile(join(directory, 'assets', 'value.txt'), 'two')
    await writeFile(join(directory, 'host.mjs'), 'export default async api => api.action("ping", { async run() { return 2 } })')
    await service.refreshLocal()
    const second = service.manifest()[0]?.generation as string
    expect(second).not.toBe(first)

    const oldAction = await request(gateway.address().port, '/mobile-access/extensions/demo/actions/ping', { method: 'POST', headers: { ...headers, 'x-dsh-mobile-extension-generation': first }, body: '{}' })
    const newAction = await request(gateway.address().port, '/mobile-access/extensions/demo/actions/ping', { method: 'POST', headers: { ...headers, 'x-dsh-mobile-extension-generation': second }, body: '{}' })
    expect(JSON.parse(oldAction.body)).toBe(1)
    expect(JSON.parse(newAction.body)).toBe(2)
    const oldAsset = await request(gateway.address().port, `/mobile-access/extensions/demo/assets/value.txt?generation=${first}`, { headers })
    const newAsset = await request(gateway.address().port, `/mobile-access/extensions/demo/assets/value.txt?generation=${second}`, { headers })
    expect(oldAsset.body).toBe('one')
    expect(newAsset.body).toBe('two')
    const invalid = await request(gateway.address().port, '/mobile-access/extensions/demo/actions/ping', { method: 'POST', headers: { ...headers, 'x-dsh-mobile-extension-generation': 'stale' }, body: '{}' })
    expect(invalid.status).toBe(400)
    expect(JSON.parse(invalid.body)).toEqual({ error: 'invalid_extension_generation' })
  })

  it('admits extension bodies before buffering and rejects oversized declarations first', async () => {
    const upstream = createServer((_, response) => { response.writeHead(200); response.end('ok') })
    const upstreamPort = await listen(upstream)
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-admission-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context)
    service.registerExtension({
      schemaVersion: 1, id: 'hello', name: 'Hello', version: '1.0.0',
      actions: { echo: { run: async (_context, input) => ({ input }) } },
      routes: [{ method: 'POST', path: 'echo', handle: async request => ({ contentType: 'application/octet-stream', body: request.body }) }],
    })
    const config = parseGatewayConfig({
      listenHost: '127.0.0.1', listenPort: 0,
      upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
      publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(directory, 'devices.json'), tls: { mode: 'disabled' },
      maxActiveRequests: 1, maxBodyBytes: 1024,
    })
    const gateway = new MobileAccessGateway(config, new MemoryDeviceStore(), service)
    await gateway.start(); cleanups.push(() => gateway.close())
    const opened = await gateway.access.openPairing()
    const origin = gateway.address().origin
    const paired = await request(gateway.address().port, '/mobile-access/auth/pair', {
      method: 'POST',
      headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: opened.token }),
    })
    const session = cookie(paired.headers, SESSION_COOKIE); const csrf = JSON.parse(paired.body) as { csrfToken: string }
    const headers = {
      host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', cookie: session,
      [CSRF_HEADER]: csrf.csrfToken, 'content-type': 'application/json',
    }

    const completeBody = JSON.stringify({ value: 1 })
    const first = pendingRequest(gateway.address().port, '/mobile-access/extensions/hello/actions/echo', 'POST', {
      ...headers, 'content-length': String(Buffer.byteLength(completeBody)),
    })
    cleanups.push(async () => { first.outgoing.destroy() })
    first.outgoing.write(completeBody.slice(0, 1))
    await new Promise(resolve => setTimeout(resolve, 25))

    const oversizedAction = pendingRequest(gateway.address().port, '/mobile-access/extensions/hello/actions/echo', 'POST', {
      ...headers, 'content-length': String(1024 * 1024 + 1),
    })
    oversizedAction.outgoing.flushHeaders()
    expect((await oversizedAction.result).status).toBe(413)
    oversizedAction.outgoing.destroy()

    const oversizedRoute = pendingRequest(gateway.address().port, '/mobile-access/extensions/hello/routes/echo', 'POST', {
      ...headers, 'content-length': '1025',
    })
    oversizedRoute.outgoing.flushHeaders()
    expect((await oversizedRoute.result).status).toBe(413)
    oversizedRoute.outgoing.destroy()

    const competing = await request(gateway.address().port, '/mobile-access/extensions/hello/routes/echo', {
      method: 'POST', headers, body: '{}',
    })
    expect(competing.status).toBe(429)
    expect(JSON.parse(competing.body)).toEqual({ error: 'busy' })

    first.outgoing.end(completeBody.slice(1))
    const completed = await first.result
    expect(completed.status).toBe(200)
    expect(JSON.parse(completed.body)).toEqual({ input: { value: 1 } })
  })

  it('serves the extension manifest on the canonical path the client requests', async () => {
    const upstream = createServer((_, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><script>window.__DSH_BOOT__ = {"rev":"x","entries":[{"id":"@deepseek-ai/dsh-client-ui-layout","url":"/layout.js","rev":"x","inject":["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-theme"]}]};</script>') })
    const upstreamPort = await listen(upstream)
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-manifest-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context)
    service.registerExtension({ schemaVersion: 1, id: 'hello', name: 'Hello', version: '1.0.0' })
    const config = parseGatewayConfig({ listenHost: '127.0.0.1', listenPort: 0, upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`, publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'], stateFile: join(directory, 'devices.json'), tls: { mode: 'disabled' } })
    const gateway = new MobileAccessGateway(config, new MemoryDeviceStore(), service)
    await gateway.start(); cleanups.push(() => gateway.close())
    const opened = await gateway.access.openPairing()
    const origin = gateway.address().origin
    const paired = await request(gateway.address().port, '/mobile-access/auth/pair', { method: 'POST', headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, body: JSON.stringify({ token: opened.token }) })
    const session = cookie(paired.headers, SESSION_COOKIE)
    const headers = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', cookie: session, 'content-type': 'application/json' }
    const manifest = await request(gateway.address().port, '/mobile-access/extensions/manifest', { headers })
    expect(manifest.status).toBe(200)
    expect(JSON.parse(manifest.body)).toMatchObject({
      protocol: 1,
      extensions: [{ id: 'hello' }],
      legacy: { scriptRevision: expect.any(String), styleRevision: expect.any(String) },
    })
    expect(manifest.headers.etag).toBeTruthy()
    const notModified = await request(gateway.address().port, '/mobile-access/extensions/manifest', { headers: { ...headers, 'if-none-match': String(manifest.headers.etag) } })
    expect(notModified.status).toBe(304)
    await writeFile(join(directory, 'mobile.js'), 'window.dshMobile?.register(() => undefined)\n// changed\n')
    const customized = await request(gateway.address().port, '/mobile-access/extensions/manifest', { headers: { ...headers, 'if-none-match': String(manifest.headers.etag) } })
    expect(customized.status).toBe(200)
    expect(JSON.parse(customized.body)).not.toMatchObject({ legacy: JSON.parse(manifest.body).legacy })
  })

  it('pushes task completions without user content over the same event stream', async () => {
    const upstream = createServer((_, response) => { response.writeHead(200); response.end('ok') })
    const upstreamPort = await listen(upstream)
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-task-events-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context)
    const config = parseGatewayConfig({
      listenHost: '127.0.0.1', listenPort: 38088,
      upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
      publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(directory, 'devices.json'), tls: { mode: 'disabled' },
    })
    const gateway = new MobileAccessGateway(config, new MemoryDeviceStore(), service)
    await gateway.start(); cleanups.push(() => gateway.close())
    const origin = gateway.address().origin
    const opened = await gateway.access.openPairing()
    const paired = await request(gateway.address().port, '/mobile-access/auth/pair', {
      method: 'POST',
      headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: opened.token }),
    })
    const pairedBody = JSON.parse(paired.body) as { csrfToken: string; deviceId: string }
    const session = cookie(paired.headers, SESSION_COOKIE)
    const stream = await openEventStream(gateway.address().port, {
      host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', cookie: session,
      accept: 'text/event-stream',
    })
    cleanups.push(async () => { stream.close() })
    await stream.waitFor(': ready')
    gateway.broadcastTaskEvent({ sessionId: 'session-9', turn: 4 })
    const eventBody = await stream.waitFor('event: task-notify')
    expect(eventBody).toContain('data: {"sessionId":"session-9","turn":4}')
    expect(eventBody).not.toContain(opened.token)
    expect(eventBody).not.toContain(pairedBody.csrfToken)
    expect(eventBody).not.toContain(session)
  })

  it('pushes credential-free extension changes and closes the stream when its device is revoked', async () => {    const upstream = createServer((_, response) => { response.writeHead(200); response.end('ok') })
    const upstreamPort = await listen(upstream)
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-extension-events-'))
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context)
    const config = parseGatewayConfig({
      listenHost: '127.0.0.1', listenPort: 0,
      upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
      publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(directory, 'devices.json'), tls: { mode: 'disabled' },
    })
    const gateway = new MobileAccessGateway(config, new MemoryDeviceStore(), service)
    await gateway.start(); cleanups.push(() => gateway.close())
    const origin = gateway.address().origin
    const opened = await gateway.access.openPairing()
    const paired = await request(gateway.address().port, '/mobile-access/auth/pair', {
      method: 'POST',
      headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: opened.token }),
    })
    const pairedBody = JSON.parse(paired.body) as { csrfToken: string; deviceId: string }
    const session = cookie(paired.headers, SESSION_COOKIE)
    const stream = await openEventStream(gateway.address().port, {
      host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', cookie: session,
      accept: 'text/event-stream',
    })
    cleanups.push(async () => { stream.close() })
    expect(stream.response.statusCode).toBe(200)
    await stream.waitFor(': ready')

    service.registerExtension({ schemaVersion: 1, id: 'pushed', name: 'Pushed', version: '1.0.0' })
    const eventBody = await stream.waitFor('event: extensions-changed')
    expect(eventBody).toContain('data: {"revision":')
    expect(eventBody).not.toContain(opened.token)
    expect(eventBody).not.toContain(pairedBody.csrfToken)
    expect(eventBody).not.toContain(session)

    await writeFile(join(directory, 'mobile.js'), 'window.dshMobile?.register(() => undefined)\n// pushed\n')
    await stream.waitFor('data: {"revision":2}')

    const disconnected = new Promise<void>(resolve => {
      stream.response.once('aborted', resolve)
      stream.response.once('close', resolve)
      stream.response.once('end', resolve)
    })
    expect(await gateway.access.revokeDevice(pairedBody.deviceId)).toBe(true)
    await expect(Promise.race([
      disconnected,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('event stream remained open after revocation')), 2_000)),
    ])).resolves.toBeUndefined()

    const unauthenticated = await request(gateway.address().port, '/mobile-access/extensions/events', {
      headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', accept: 'text/event-stream' },
    })
    expect(unauthenticated.status).toBe(401)
  })
})
