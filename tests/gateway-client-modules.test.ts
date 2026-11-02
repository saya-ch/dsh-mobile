import { createServer, request as requestHttp, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_MODULE_MEASUREMENT_BUDGET_MS, ClientModuleConflictError, MobileAccessGateway, clientModuleCatalogRevision, sanitizeModuleDescription } from '../src/gateway.js'
import { ClientModulePreferenceStore, type ClientModulePreferenceView } from '../src/client-module-preferences.js'
import { parseGatewayConfig } from '../src/config.js'
import { MemoryDeviceStore } from '../src/storage.js'
import { type PairingResult } from '../src/access.js'
import { SESSION_COOKIE, CSRF_HEADER } from '../src/http-security.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const layoutId = '@deepseek-ai/dsh-client-ui-layout'
const core = ['@deepseek-ai/dsh-client-locale', ...['renderer', 'session', 'theme'].map(name => `@deepseek-ai/dsh-client-ui-${name}`)]
const path = '/mobile-access/client-modules'

function manifest(legacy = false) {
  const entries = [
    ...core.map(id => ({ id, url: `/plugins/${id.split('-').at(-1)!}.js?rev=v1234`, rev: 'v1234', inject: [] as string[] })),
    { id: layoutId, url: '/plugins/layout.js?rev=v1234', rev: 'v1234', inject: [...core] },
    { id: 'base', url: '/plugins/base.js?rev=v1234', rev: 'v1234', inject: [] as string[] },
    { id: 'dependent', url: '/plugins/dependent.js?rev=v1234', rev: 'v1234', inject: ['base/client'] },
    { id: 'feature', url: '/plugins/feature.js?rev=v1234', rev: 'v1234', inject: [] as string[] },
  ]
  return {
    rev: 'graph1234', entries,
    ...(legacy ? {} : { batches: [
      { phase: 'bootstrap', url: '/plugins/bootstrap.js?rev=v1234', rev: 'v1234', entries: [...core] },
      { phase: 'application', url: '/plugins/application.js?rev=v1234', rev: 'v1234', entries: [layoutId, 'base', 'dependent', 'feature'] },
    ] }),
  }
}

interface Result { readonly status: number; readonly body: string; readonly headers: IncomingHttpHeaders }

async function fixture(defaults: readonly string[] = [], legacy = false, upstreamTimeoutMs = 1_000) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-module-gateway-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const mobileLayoutFile = join(root, 'mobile-layout.js')
  await writeFile(mobileLayoutFile, 'globalThis.dedicatedLayout = true;')
  let graph = manifest(legacy)
  let indexRequests = 0
  let pluginRequests = 0
  let indexOverride: ((request: IncomingMessage, response: ServerResponse) => void) | undefined
  let pluginOverride: ((request: IncomingMessage, response: ServerResponse) => void) | undefined
  const server: Server = createServer((incoming, response) => {
    if (incoming.url === '/') {
      indexRequests += 1
      if (indexOverride !== undefined) { indexOverride(incoming, response); return }
      const body = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)};</script></head><body></body></html>`
      response.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) })
      response.end(body)
    } else if (incoming.url?.startsWith('/plugins/')) {
      pluginRequests += 1
      if (pluginOverride !== undefined) pluginOverride(incoming, response)
      else response.end(`globalThis.modules = ${JSON.stringify(incoming.url)};`)
    }
    else { response.writeHead(404); response.end() }
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>(resolve => { server.close(() => resolve()) })
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test upstream has no TCP address')
  const preferences = new ClientModulePreferenceStore(join(root, 'preferences.json'), defaults)
  const config = parseGatewayConfig({
    listenHost: '127.0.0.1', listenPort: 0, tls: { mode: 'disabled' },
    upstreamOrigin: `http://127.0.0.1:${String(address.port)}`, publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(root, 'devices.json'), mobileLayoutFile, excludedClientModules: [...defaults], upstreamTimeoutMs,
  })
  const gateway = new MobileAccessGateway(Object.freeze({ ...config, discovery: false }), new MemoryDeviceStore(), undefined, undefined, undefined, undefined, undefined, preferences)
  cleanups.push(() => gateway.close())
  await gateway.start()
  const pair = async (): Promise<PairingResult> => {
    const pairing = await gateway.access.openPairing()
    return gateway.access.pair('fixture', pairing.token, 'Module phone')
  }
  const first = await pair()
  const second = await pair()
  const origin = gateway.address().origin
  let latestRequest: ClientRequest | undefined
  const request = (target: string, credential?: PairingResult, body?: unknown, headers: Record<string, string | undefined> = {}): Promise<Result> => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body)
    const requestHeaders: Record<string, string | number | undefined> = {
      host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', accept: 'application/json',
      ...(credential === undefined ? {} : { cookie: `${SESSION_COOKIE}=${credential.sessionToken}`, [CSRF_HEADER]: credential.csrfToken }),
      ...(data === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...headers,
    }
    for (const key of Object.keys(requestHeaders)) if (requestHeaders[key] === undefined) delete requestHeaders[key]
    const outgoing = requestHttp({
      host: '127.0.0.1', port: gateway.address().port, path: target,
      method: data === undefined ? 'GET' : 'POST', agent: false,
      headers: requestHeaders,
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: response.headers }))
    })
    outgoing.once('error', reject)
    latestRequest = outgoing
    outgoing.end(data)
  })
  const view = async (device: PairingResult): Promise<ClientModulePreferenceView> => {
    const result = await request(path, device)
    expect(result.status).toBe(200)
    return JSON.parse(result.body) as ClientModulePreferenceView
  }
  return {
    gateway, preferences, first, second, request, view, root,
    pluginRequests: () => pluginRequests,
    graph: () => graph, replaceGraph: (next: ReturnType<typeof manifest>) => { graph = next }, indexRequests: () => indexRequests,
    overrideIndex: (handler: (request: IncomingMessage, response: ServerResponse) => void) => { indexOverride = handler },
    overridePlugins: (handler: (request: IncomingMessage, response: ServerResponse) => void) => { pluginOverride = handler },
    latestRequest: () => latestRequest,
  }
}

function boot(body: string): { entries: Array<{ id: string }>; batches: Array<{ url: string; entries: string[] }> } {
  const match = /globalThis\["__DSH_BOOT__"\]\s*=\s*(\{.*\});/u.exec(body)
  if (match?.[1] === undefined) throw new Error('served page contains no boot graph')
  return JSON.parse(match[1]) as { entries: Array<{ id: string }>; batches: Array<{ url: string; entries: string[] }> }
}

describe('installed module descriptions', () => {
  it('keeps one readable line and drops control characters and URLs', () => {
    expect(sanitizeModuleDescription('  Manage\nDeepSeek login\tand billing  ')).toBe('Manage DeepSeek login and billing')
    expect(sanitizeModuleDescription('See https://example.com/path for details')).toBe('See for details')
    expect(sanitizeModuleDescription('')).toBeUndefined()
    expect(sanitizeModuleDescription(42)).toBeUndefined()
    const truncated = sanitizeModuleDescription('x'.repeat(400))
    expect(truncated?.length).toBeLessThanOrEqual(200)
    expect(truncated?.endsWith('…')).toBe(true)
  })
})

describe('authenticated client module selection', () => {
  it('lists only module ids, installed dependencies and required flags without URL or credential metadata', async () => {
    const setup = await fixture()
    const view = await setup.view(setup.first)
    expect(view).toMatchObject({ source: 'plugin', excludedClientModules: [], defaultExcludedClientModules: [], reloadRequired: true })
    expect(view.entries.find(entry => entry.id === layoutId)?.required).toBe(true)
    expect(view.entries.find(entry => entry.id === core[0])?.required).toBe(true)
    expect(view.entries.find(entry => entry.id === 'dependent')).toMatchObject({ id: 'dependent', required: false, dependencies: ['base'] })
    expect(view.entries.find(entry => entry.id === 'feature')?.required).toBe(false)
    // The panel exists to choose what the phone loads, so measured entries report
    // both source and gzipped bytes; a failed probe leaves both fields absent.
    expect(setup.pluginRequests()).toBe(0)
    expect(view.entries.every(entry => entry.bytes === undefined)).toBe(true)
    const measured = await setup.request(path, setup.first, { measure: true })
    expect(measured.status).toBe(200)
    const measuredView = JSON.parse(measured.body) as ClientModulePreferenceView
    const sized = measuredView.entries.filter(entry => entry.bytes !== undefined)
    expect(sized.length).toBe(view.entries.length)
    expect(measuredView.entries.find(entry => entry.id === layoutId)?.bytes).toBe(Buffer.byteLength('globalThis.dedicatedLayout = true;'))
    for (const entry of sized) expect(entry.gzipBytes).toBeGreaterThan(0)
    for (const entry of measuredView.entries.filter(entry => entry.bytes === undefined)) expect(entry.gzipBytes).toBeUndefined()
    for (const entry of measuredView.entries) {
      if (entry.description === undefined) continue
      expect(entry.description.length).toBeLessThanOrEqual(200)
      expect(entry.description).not.toMatch(/[\u0000-\u001f\u007f]/u)
    }
    const body = JSON.stringify(view)
    expect(body).not.toContain('/plugins/')
    expect(body).not.toContain('127.0.0.1')
    expect(body).not.toContain(setup.first.sessionToken)
    expect(body).not.toContain(setup.first.deviceToken)
    expect(body).not.toContain(setup.first.deviceId)
  })

  it('does not fetch optional bundles while reading, saving or resetting selections', async () => {
    const setup = await fixture()
    setup.overridePlugins(() => { throw new Error('ordinary settings must not measure a bundle') })
    expect((await setup.request(path, setup.first)).status).toBe(200)
    expect((await setup.request(path, setup.first, { excludedClientModules: ['feature'] })).status).toBe(200)
    expect(await setup.preferences.read(setup.first.deviceId)).toMatchObject({ excludedClientModules: ['feature'] })
    expect((await setup.request(path, setup.first, { reset: true })).status).toBe(200)
    expect(setup.pluginRequests()).toBe(0)
  })

  it('drains rejected measurement response streams before completing the operation', async () => {
    const setup = await fixture()
    const closed: Promise<void>[] = []
    setup.overridePlugins((_request, response) => {
      closed.push(new Promise<void>(resolve => { response.once('close', resolve) }))
      response.writeHead(503); response.flushHeaders()
    })
    const measured = await setup.gateway.measureClientModules()
    await Promise.all(closed)
    expect(closed.length).toBeGreaterThan(0)
    expect(measured.entries.filter(entry => entry.id !== layoutId).every(entry => entry.bytes === undefined)).toBe(true)
    expect((await setup.gateway.describeClientModules()).entries.find(entry => entry.id === layoutId)?.bytes).toBeGreaterThan(0)
  })

  it('cancels admitted measurement requests and admits a later measurement only after draining them', async () => {
    const setup = await fixture([], false, 30_000)
    let ready: () => void = () => {}
    const started = new Promise<void>(resolve => { ready = resolve })
    const closed: Promise<void>[] = []
    setup.overridePlugins((_request, response) => {
      closed.push(new Promise<void>(resolve => { response.once('close', resolve) }))
      response.writeHead(200); response.write('held bundle'); ready()
    })
    const controller = new AbortController()
    const pending = setup.gateway.measureClientModules(undefined, controller.signal)
    const rejection = expect(pending).rejects.toBeDefined()
    await started
    await expect(setup.gateway.measureClientModules()).rejects.toMatchObject({ status: 429 })
    controller.abort(); await rejection; await Promise.all(closed)
    setup.overridePlugins((_request, response) => { response.end('fresh bundle') })
    expect((await setup.gateway.measureClientModules()).entries.find(entry => entry.id === 'feature')?.bytes).toBeGreaterThan(0)
  })

  it('returns completed sizes at the overall measurement deadline and closes stalled upstreams', async () => {
    const setup = await fixture([], false, 30_000)
    const closed: Promise<void>[] = []
    setup.overridePlugins((_request, response) => {
      closed.push(new Promise<void>(resolve => { response.once('close', resolve) }))
      response.writeHead(200); response.write('held bundle')
    })
    const measured = await setup.gateway.measureClientModules()
    await Promise.all(closed)
    expect(CLIENT_MODULE_MEASUREMENT_BUDGET_MS).toBeLessThan(15_000)
    expect(closed.length).toBeGreaterThan(0)
    expect(measured.entries.find(entry => entry.id === layoutId)?.bytes).toBeGreaterThan(0)
    expect(measured.entries.find(entry => entry.id === 'feature')?.bytes).toBeUndefined()
  })

  it('looks up exported package metadata from the profile context and refreshes changed descriptions explicitly', async () => {
    const setup = await fixture()
    const directory = join(setup.root, 'node_modules', 'feature')
    await mkdir(directory, { recursive: true })
    const file = join(directory, 'package.json')
    await writeFile(file, JSON.stringify({ name: 'feature', description: 'First description' }))
    expect((await setup.gateway.measureClientModules()).entries.find(entry => entry.id === 'feature')?.description).toBe('First description')
    await writeFile(file, JSON.stringify({ name: 'feature', description: 'Second description' }))
    expect((await setup.gateway.describeClientModules()).entries.find(entry => entry.id === 'feature')?.description).toBe('First description')
    expect((await setup.gateway.measureClientModules()).entries.find(entry => entry.id === 'feature')?.description).toBe('Second description')
  })

  it('changes only the authenticated device and distinguishes its immutable boot batch from another device', async () => {
    const setup = await fixture()
    const response = await setup.request(path, setup.first, { excludedClientModules: ['feature'] })
    expect(response.status).toBe(200)
    expect(await setup.view(setup.first)).toMatchObject({ source: 'device', excludedClientModules: ['feature'] })
    expect(await setup.view(setup.second)).toMatchObject({ source: 'plugin', excludedClientModules: [] })
    const firstPage = await setup.request('/', setup.first, undefined, { accept: 'text/html' })
    const secondPage = await setup.request('/', setup.second, undefined, { accept: 'text/html' })
    expect(firstPage.status).toBe(200)
    expect(secondPage.status).toBe(200)
    const firstBoot = boot(firstPage.body)
    const secondBoot = boot(secondPage.body)
    expect(firstBoot.entries.some(entry => entry.id === 'feature')).toBe(false)
    expect(secondBoot.entries.some(entry => entry.id === 'feature')).toBe(true)
    const firstBatch = firstBoot.batches.find(batch => batch.url.startsWith('/mobile-access/mobile-boot/'))!
    const secondBatch = secondBoot.batches.find(batch => batch.url.startsWith('/mobile-access/mobile-boot/'))!
    expect(firstBatch.url).not.toBe(secondBatch.url)
    expect((await setup.request(firstBatch.url, setup.first)).body).not.toContain('/plugins/feature.js')
    expect((await setup.request(secondBatch.url, setup.second)).body).toContain('/plugins/feature.js')
    expect((await setup.request(firstBatch.url, setup.first)).body).not.toContain('/plugins/feature.js')
  })

  it('uses a computer default, retains explicit device choices, and resets to the current fallback', async () => {
    const setup = await fixture(['feature'])
    expect(await setup.view(setup.first)).toMatchObject({ source: 'plugin', excludedClientModules: ['feature'] })
    await setup.request(path, setup.first, { excludedClientModules: [] })
    await setup.gateway.configureClientModules(['dependent'])
    expect(await setup.view(setup.first)).toMatchObject({ source: 'device', excludedClientModules: [], defaultExcludedClientModules: ['dependent'] })
    expect(await setup.view(setup.second)).toMatchObject({ source: 'computer', excludedClientModules: ['dependent'] })
    expect((await setup.request(path, setup.first, { reset: true })).status).toBe(200)
    expect(await setup.view(setup.first)).toMatchObject({ source: 'computer', excludedClientModules: ['dependent'] })
    await setup.gateway.resetClientModules()
    expect(await setup.view(setup.first)).toMatchObject({ source: 'plugin', excludedClientModules: ['feature'] })
  })

  it.each([['missing'], [layoutId], [core[0]!], ['base']].map(excluded => [excluded]))('rejects an unavailable, required or still-dependent selection %j without overwriting the old one', async excluded => {
    const setup = await fixture()
    await setup.request(path, setup.first, { excludedClientModules: ['feature'] })
    const conflict = await setup.request(path, setup.first, { excludedClientModules: excluded })
    expect(conflict.status).toBe(409)
    expect(JSON.parse(conflict.body)).toMatchObject({ error: 'excluded_client_modules_invalid', detail: expect.stringContaining(excluded![0]!) })
    expect(await setup.view(setup.first)).toMatchObject({ source: 'device', excludedClientModules: ['feature'] })
    expect((await setup.request(path, setup.first, { excludedClientModules: ['base', 'dependent'] })).status).toBe(200)
  })

  it('fetches the current graph again before saving rather than accepting a selection from an older description', async () => {
    const setup = await fixture()
    await setup.view(setup.first)
    const next = setup.graph()
    next.entries = next.entries.filter(entry => entry.id !== 'feature')
    for (const batch of next.batches ?? []) batch.entries = batch.entries.filter(id => id !== 'feature')
    setup.replaceGraph(next)
    const previousReads = setup.indexRequests()
    expect((await setup.request(path, setup.first, { excludedClientModules: ['feature'] })).status).toBe(409)
    expect(setup.indexRequests()).toBe(previousReads + 1)
    expect(await setup.preferences.read(setup.first.deviceId)).toMatchObject({ source: 'plugin', excludedClientModules: [] })
  })

  it.each(['removed', 'required', 'dependency', 'legacy', 'computer'] as const)('offers explicit device-only recovery after a saved selection becomes invalid: %s', async change => {
    const setup = await fixture()
    if (change === 'computer') await setup.gateway.configureClientModules(['feature'])
    else {
      await setup.gateway.configureClientModules(['dependent'])
      expect((await setup.request(path, setup.first, { excludedClientModules: ['feature'] })).status).toBe(200)
    }
    expect((await setup.request(path, setup.second, { excludedClientModules: [] })).status).toBe(200)
    const otherBefore = await setup.preferences.read(setup.second.deviceId)
    const computerBefore = await setup.preferences.read()
    const firstBefore = await setup.preferences.read(setup.first.deviceId)
    const next = setup.graph()
    if (change === 'removed' || change === 'computer') {
      next.entries = next.entries.filter(entry => entry.id !== 'feature')
      for (const batch of next.batches ?? []) batch.entries = batch.entries.filter(id => id !== 'feature')
    } else if (change === 'required') Object.assign(next.entries.find(entry => entry.id === 'feature')!, { immediately: true })
    else if (change === 'dependency') {
      next.entries.push({ id: 'new-consumer', url: '/plugins/new-consumer.js?rev=v1234', rev: 'v1234', inject: ['feature/client'] })
      next.batches![1]!.entries.push('new-consumer')
    } else delete next.batches
    setup.replaceGraph(next)
    const recovery = await setup.request('/', setup.first, undefined, { accept: 'text/html', 'accept-language': 'zh-CN' })
    expect(recovery.status).toBe(200)
    expect(recovery.headers['content-type']).toContain('text/html')
    expect(recovery.headers['cache-control']).toBe('no-store')
    expect(recovery.headers['x-frame-options']).toBe('DENY')
    expect(recovery.body).toContain('id="load-all-modules"')
    expect(recovery.body).toContain('为本设备加载全部模块并重试')
    expect(recovery.body).not.toContain('__DSH_BOOT__')
    expect(recovery.body).not.toContain(setup.first.deviceId)
    expect(recovery.body).not.toContain(setup.first.deviceToken)
    expect(recovery.body).not.toContain(setup.first.sessionToken)
    expect(await setup.preferences.read(setup.first.deviceId)).toEqual(firstBefore)
    expect((await setup.request(path, setup.first, { excludedClientModules: ['feature'] })).status).toBe(409)
    expect((await setup.request(path, setup.first, { excludedClientModules: [] }, { [CSRF_HEADER]: undefined })).status).toBe(403)
    expect((await setup.request(path, undefined, { excludedClientModules: [] })).status).toBe(401)
    expect((await setup.request('/', undefined, undefined, { accept: 'text/html' })).status).toBe(302)
    expect((await setup.request(path, setup.first, { excludedClientModules: [] })).status).toBe(200)
    expect(await setup.preferences.read(setup.first.deviceId)).toMatchObject({ source: 'device', excludedClientModules: [] })
    expect(await setup.preferences.read(setup.second.deviceId)).toEqual(otherBefore)
    expect(await setup.preferences.read()).toEqual(computerBefore)
    const reopened = await setup.request('/', setup.first, undefined, { accept: 'text/html' })
    expect(reopened.status).toBe(200)
    expect(reopened.body).toContain('__DSH_BOOT__')
    expect(reopened.body).not.toContain('id="load-all-modules"')
  })

  it('offers the owned recovery document when a stale plugin-level default cannot boot the graph', async () => {
    const setup = await fixture(['feature'])
    expect(await setup.view(setup.first)).toMatchObject({ source: 'plugin', excludedClientModules: ['feature'] })
    const computerBefore = await setup.preferences.read()
    const firstBefore = await setup.preferences.read(setup.first.deviceId)
    const secondBefore = await setup.preferences.read(setup.second.deviceId)
    const next = setup.graph()
    next.entries = next.entries.filter(entry => entry.id !== 'feature')
    for (const batch of next.batches ?? []) batch.entries = batch.entries.filter(id => id !== 'feature')
    setup.replaceGraph(next)
    const recovery = await setup.request('/', setup.first, undefined, { accept: 'text/html' })
    expect(recovery.status).toBe(200)
    expect(recovery.headers['content-type']).toContain('text/html')
    expect(recovery.headers['cache-control']).toBe('no-store')
    expect(recovery.headers['x-frame-options']).toBe('DENY')
    expect(recovery.body).toContain('id="load-all-modules"')
    expect(recovery.body).not.toContain('__DSH_BOOT__')
    expect(recovery.body).not.toContain(setup.first.deviceId)
    expect(recovery.body).not.toContain(setup.first.deviceToken)
    expect(recovery.body).not.toContain(setup.first.sessionToken)
    expect(await setup.preferences.read()).toEqual(computerBefore)
    expect(await setup.preferences.read(setup.first.deviceId)).toEqual(firstBefore)
    expect((await setup.request(path, setup.first, { excludedClientModules: [] }, { [CSRF_HEADER]: undefined })).status).toBe(403)
    expect(await setup.preferences.read(setup.first.deviceId)).toEqual(firstBefore)
    expect((await setup.request(path, setup.first, { excludedClientModules: [] })).status).toBe(200)
    expect(await setup.preferences.read(setup.first.deviceId)).toMatchObject({ source: 'device', excludedClientModules: [] })
    expect(await setup.preferences.read()).toEqual(computerBefore)
    expect(await setup.preferences.read(setup.second.deviceId)).toEqual(secondBefore)
    const reopened = await setup.request('/', setup.first, undefined, { accept: 'text/html' })
    expect(reopened.status).toBe(200)
    expect(reopened.body).toContain('__DSH_BOOT__')
    expect(reopened.body).not.toContain('id="load-all-modules"')
    const otherPage = await setup.request('/', setup.second, undefined, { accept: 'text/html' })
    expect(otherPage.status).toBe(200)
    expect(otherPage.body).toContain('id="load-all-modules"')
  })

  it('does not reflect a stale device module id into the owned recovery document', async () => {
    const setup = await fixture()
    const stale = '<img src=x onerror=alert(1)> & "private-module"'
    await setup.preferences.configure([stale], setup.first.deviceId, async () => undefined)
    const recovery = await setup.request('/', setup.first, undefined, { accept: 'text/html' })
    expect(recovery.status).toBe(200)
    expect(recovery.body).toContain('id="load-all-modules"')
    expect(recovery.body).not.toContain(stale)
    expect(recovery.body).not.toContain('onerror=')
  })

  it('requires a valid Session, same-origin POST and CSRF, and rejects caller-selected device identities', async () => {
    const setup = await fixture()
    expect((await setup.request(path)).status).toBe(401)
    expect((await setup.request(path, undefined, { excludedClientModules: ['feature'] })).status).toBe(401)
    expect((await setup.request(path, setup.first, { excludedClientModules: ['feature'] }, { [CSRF_HEADER]: undefined })).status).toBe(403)
    expect((await setup.request(path, setup.first, { excludedClientModules: ['feature'] }, { origin: 'https://other.example' })).status).toBe(403)
    expect((await setup.request(path, setup.first, { excludedClientModules: ['feature'], deviceId: setup.second.deviceId })).status).toBe(400)
    expect((await setup.request(path, setup.first, { reset: true, deviceId: setup.second.deviceId })).status).toBe(400)
    expect((await setup.request(path, setup.first, { excludedClientModules: ['feature', 'feature'] })).status).toBe(400)
    expect(await setup.view(setup.first)).toMatchObject({ source: 'plugin', excludedClientModules: [] })
    expect(await setup.view(setup.second)).toMatchObject({ source: 'plugin', excludedClientModules: [] })
  })

  it('offers an empty selection and marks all entries required for legacy unbatched boot graphs', async () => {
    const setup = await fixture([], true)
    expect((await setup.view(setup.first)).entries.every(entry => entry.required)).toBe(true)
    expect((await setup.request(path, setup.first, { excludedClientModules: [] })).status).toBe(200)
    expect((await setup.request(path, setup.first, { excludedClientModules: ['feature'] })).status).toBe(409)
    expect(await setup.view(setup.first)).toMatchObject({ excludedClientModules: [], defaultExcludedClientModules: [] })
  })

  it('reports a catalog revision and refuses a selection computed against an older one', async () => {
    const setup = await fixture()
    const view = await setup.view(setup.first)
    expect(view.revision).toMatch(/^[0-9a-f]{16}$/)
    expect(view.revision).toBe(clientModuleCatalogRevision(view.entries))
    const stale = await setup.request(path, setup.first, { excludedClientModules: ['feature'], revision: '0123456789abcdef' })
    expect(stale.status).toBe(409)
    expect(JSON.parse(stale.body)).toMatchObject({ error: 'client_module_catalog_changed' })
    expect(await setup.view(setup.first)).toMatchObject({ excludedClientModules: [] })
    const current = await setup.request(path, setup.first, { excludedClientModules: ['feature'], revision: view.revision })
    expect(current.status).toBe(200)
    expect(JSON.parse(current.body)).toMatchObject({ excludedClientModules: ['feature'] })
  })

  it('changes the revision when the installed catalog changes', async () => {
    const setup = await fixture()
    const before = (await setup.view(setup.first)).revision
    const graph = setup.graph()
    graph.entries.push({ id: 'late-module', url: '/plugins/late.js?rev=v1234', rev: 'v1234', inject: [] })
    graph.batches![1]!.entries.push('late-module')
    const after = (await setup.view(setup.first)).revision
    expect(after).not.toBe(before)
  })

  it('does not broadcast a reload event or refetch the document after saving until it is requested again', async () => {
    const setup = await fixture()
    const broadcast = vi.fn()
    Reflect.set(setup.gateway, 'broadcastExtensionChange', broadcast)
    const initial = setup.indexRequests()
    const changed = await setup.request(path, setup.first, { excludedClientModules: ['feature'] })
    expect(changed.status).toBe(200)
    expect(JSON.parse(changed.body)).toMatchObject({ reloadRequired: true })
    expect(setup.indexRequests()).toBe(initial + 1)
    expect(broadcast).not.toHaveBeenCalled()
    expect((await setup.request('/', setup.first, undefined, { accept: 'text/html' })).status).toBe(200)
    expect(setup.indexRequests()).toBe(initial + 2)
  })

  it('accepts many installed module ids without an extra count, id length, or 4096-byte restriction', async () => {
    const setup = await fixture()
    const graph = setup.graph()
    const ids = Array.from({ length: 300 }, (_, index) => `optional-${String(index)}-${'x'.repeat(32)}`)
    ids.push('long-id-'.repeat(80))
    graph.entries.push(...ids.map(id => ({ id, url: '/plugins/optional.js?rev=v1234', rev: 'v1234', inject: [] })))
    graph.batches![1]!.entries.push(...ids)
    expect(Buffer.byteLength(JSON.stringify({ excludedClientModules: ids }))).toBeGreaterThan(4096)
    expect((await setup.request(path, setup.first, { excludedClientModules: ids })).status).toBe(200)
    expect((await setup.view(setup.first)).excludedClientModules).toEqual(ids)
  })

  it('marks immediately loaded application modules as required using the exclusion validator', async () => {
    const setup = await fixture()
    Object.assign(setup.graph().entries.find(entry => entry.id === 'feature')!, { immediately: true })
    expect((await setup.view(setup.first)).entries.find(entry => entry.id === 'feature')?.required).toBe(true)
    expect((await setup.request(path, setup.first, { excludedClientModules: ['feature'] })).status).toBe(409)
  })

  it('removes the revoked device preference without pruning other devices sharing the store', async () => {
    const setup = await fixture()
    await setup.request(path, setup.first, { excludedClientModules: ['feature'] })
    await setup.request(path, setup.second, { excludedClientModules: ['dependent'] })
    await setup.gateway.access.revokeDevice(setup.first.deviceId)
    expect(await setup.preferences.read(setup.first.deviceId)).toMatchObject({ source: 'plugin', excludedClientModules: [] })
    expect(await setup.preferences.read(setup.second.deviceId)).toMatchObject({ source: 'device', excludedClientModules: ['dependent'] })
    expect((await setup.request(path, setup.first)).status).toBe(401)
    expect(await setup.view(setup.second)).toMatchObject({ excludedClientModules: ['dependent'] })
  })

  it('also clears an offline device on the real admin revoke route and preserves unrelated shared records on reset', async () => {
    const setup = await fixture()
    await setup.request(path, setup.first, { excludedClientModules: ['feature'] })
    await setup.request(path, setup.second, { excludedClientModules: ['dependent'] })
    const otherGatewayDevice = 'c'.repeat(32)
    await setup.preferences.configure(['feature'], otherGatewayDevice, async () => undefined)
    setup.gateway.access.logout(setup.gateway.access.authorizeSession(setup.first.sessionToken))
    const route = setup.gateway.localAdminRoute()
    const admin = createServer((incoming, response) => { void route.handler(incoming, response) })
    cleanups.push(async () => {
      admin.closeAllConnections()
      if (admin.listening) await new Promise<void>(resolve => { admin.close(() => resolve()) })
    })
    await new Promise<void>((resolve, reject) => { admin.once('error', reject); admin.listen(0, '127.0.0.1', resolve) })
    const address = admin.address()
    if (address === null || typeof address === 'string') throw new Error('admin fixture has no TCP address')
    const post = (target: string, body: object): Promise<number> => new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const authority = `127.0.0.1:${String(address.port)}`
      const outgoing = requestHttp({
        host: '127.0.0.1', port: address.port, path: target, method: 'POST', agent: false,
        headers: { host: authority, origin: `http://${authority}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      }, response => { response.resume(); response.once('end', () => resolve(response.statusCode ?? 0)) })
      outgoing.once('error', reject)
      outgoing.end(data)
    })
    expect(await post('/api/mobile-access/devices/revoke', { deviceId: setup.first.deviceId })).toBe(200)
    expect(await setup.preferences.read(setup.first.deviceId)).toMatchObject({ source: 'plugin', excludedClientModules: [] })
    expect(await setup.preferences.read(setup.second.deviceId)).toMatchObject({ source: 'device', excludedClientModules: ['dependent'] })
    expect(await post('/api/mobile-access/devices/reset', { confirm: true })).toBe(200)
    expect(await setup.preferences.read(setup.second.deviceId)).toMatchObject({ source: 'plugin', excludedClientModules: [] })
    expect(await setup.preferences.read(otherGatewayDevice)).toMatchObject({ source: 'device', excludedClientModules: ['feature'] })
  })

  it.each(['caller', 'gateway', 'admin'] as const)('aborts catalog reads and awaits upstream teardown when the %s closes', async cancelledBy => {
    const setup = await fixture()
    let entered!: () => void
    let closed!: () => void
    const indexEntered = new Promise<void>(resolve => { entered = resolve })
    const upstreamClosed = new Promise<void>(resolve => { closed = resolve })
    const adminAbort = new AbortController()
    setup.overrideIndex(incoming => { incoming.socket.once('close', closed); entered() })
    const pending = cancelledBy === 'caller'
      ? setup.request(path, setup.first).catch((error: unknown) => error)
      : setup.gateway.describeClientModules(cancelledBy === 'admin' ? undefined : setup.first.deviceId, adminAbort.signal).catch((error: unknown) => error)
    await indexEntered
    if (cancelledBy === 'caller') setup.latestRequest()!.destroy()
    else if (cancelledBy === 'admin') adminAbort.abort()
    else await setup.gateway.close()
    await upstreamClosed
    expect(await pending).toBeInstanceOf(Error)
    await setup.gateway.close()
  })

  it('exposes bounded conflict details without stack, URLs or absolute Windows paths', () => {
    const error = new ClientModuleConflictError(`module example depends on https://example.invalid/?secret=abc C:\\private\\file ${'x'.repeat(600)}`)
    expect(error).toMatchObject({ status: 409, code: 'excluded_client_modules_invalid' })
    expect(error.detail.length).toBeLessThanOrEqual(512)
    expect(error.detail).not.toContain('secret=abc')
    expect(error.detail).not.toContain('C:\\private')
  })

  it('rejects an oversized otherwise valid index before parsing or saving its graph', async () => {
    const setup = await fixture()
    setup.overrideIndex((_incoming, response) => {
      response.end(`<!--${'x'.repeat(4 * 1024 * 1024)}--><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(setup.graph())};</script>`)
    })
    expect((await setup.request(path, setup.first)).status).toBe(502)
    expect(await setup.preferences.read(setup.first.deviceId)).toMatchObject({ source: 'plugin', excludedClientModules: [] })
  })

  it('keeps authenticated catalog fetches under the transport idle budget', async () => {
    const setup = await fixture()
    setup.overrideIndex(() => undefined)
    await expect(setup.gateway.describeClientModules()).rejects.toMatchObject({ status: 504, code: 'upstream_timeout' })
  })

  it('cancels every in-flight size probe when the document requester leaves', async () => {
    const setup = await fixture()
    let entered!: () => void
    let closed!: () => void
    const allEntered = new Promise<void>(resolve => { entered = resolve })
    const allClosed = new Promise<void>(resolve => { closed = resolve })
    let started = 0
    let ended = 0
    setup.overridePlugins(incoming => {
      expect(incoming.headers['x-dsh-mobile-size-probe']).toBe('1')
      started += 1
      incoming.socket.once('close', () => { ended += 1; if (ended === 3) closed() })
      if (started === 3) entered()
    })
    const pending = setup.request('/', setup.first, undefined, { accept: 'text/html' }).catch((error: unknown) => error)
    await allEntered
    setup.latestRequest()!.destroy()
    await allClosed
    expect(await pending).toBeInstanceOf(Error)
    await setup.gateway.close()
    expect(started).toBe(3)
    expect(ended).toBe(3)
  })
})
