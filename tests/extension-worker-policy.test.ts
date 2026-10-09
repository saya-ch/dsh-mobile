import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveHostExecution } from '../src/extension-worker-config.js'
import { Config, parseGatewayConfig } from '../src/config.js'
import { ExtensionWorkerBudget, ExtensionWorkerHost, PreparedJsonResult } from '../src/extension-worker.js'
import { MobileAccessService } from '../src/extensions.js'
import { buildExtensionWorkerEntry } from './helpers/extension-worker-build.js'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture(source: string, id = 'example'): Promise<{ readonly root: string; readonly directory: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worker-policy-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, id)
  await mkdir(directory)
  await writeFile(join(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id, name: id, version: '1.0.0' }))
  await writeFile(join(directory, 'host.mjs'), source)
  return { root, directory }
}
async function host(source: string, limits = {}): Promise<ExtensionWorkerHost> {
  const files = await fixture(source)
  const instance = new ExtensionWorkerHost({ workerModule: await buildExtensionWorkerEntry(), hostFile: join(files.directory, 'host.mjs'), manifest: { schemaVersion: 1, id: 'example', name: 'example', version: '1.0.0' }, generation: 'same-generation', logger: { debug() {}, info() {}, warn() {}, error() {} }, limits })
  cleanups.push(() => instance.dispose())
  await instance.activate()
  return instance
}
const caller = (): { readonly signal: AbortSignal; readonly deviceId: string } => ({ signal: new AbortController().signal, deviceId: 'device' })
const routeRequest = () => ({ ...caller(), method: 'GET', pathname: '/data', query: new URLSearchParams(), headers: {}, body: Buffer.alloc(0) })

describe('worker policy and genuine recovery', () => {
  it('keeps in-process as the default and validates selectors and budgets', () => {
    expect(resolveHostExecution(undefined).mode).toBe('in-process')
    expect(resolveHostExecution({ mode: 'worker', extensions: [] }).extensions).toEqual([])
    for (const config of [{ mode: 'other' }, { extensions: ['x', 'x'] }, { extensions: ['../x'] }, { extensions: { x: 'worker' } }, { maxWorkers: 0 }, { streamWindowBytes: 1024, streamChunkBytes: 2048 }, { streamWindowBytes: 2048, streamAggregateBytes: 1024 }, { resultMaxBytes: 5 * 1024 * 1024 }]) expect(() => resolveHostExecution(config)).toThrow()
    const parsed = parseGatewayConfig(Config({ stateFile: join(tmpdir(), 'worker-config.json'), controlFile: join(tmpdir(), 'worker-control.json'), initiallyEnabled: false, tls: { mode: 'disabled' }, hostExecution: { mode: 'worker', extensions: ['example'], maxWorkers: 2 } }))
    expect(parsed.hostExecution).toMatchObject({ mode: 'worker', extensions: ['example'], maxWorkers: 2 })
  })

  it('preserves omitted selectors and resource defaults through the Loader schema', () => {
    const base = { stateFile: join(tmpdir(), 'worker-config.json'), controlFile: join(tmpdir(), 'worker-control.json'), initiallyEnabled: false, tls: { mode: 'disabled' as const } }
    expect(parseGatewayConfig(Config(base)).hostExecution).toEqual(resolveHostExecution(undefined))
    const omitted = Config({ ...base, hostExecution: { mode: 'worker' } })
    expect(omitted.hostExecution?.extensions).toBeUndefined()
    expect(parseGatewayConfig(omitted).hostExecution).toEqual(resolveHostExecution({ mode: 'worker' }))
    expect(parseGatewayConfig(Config({ ...base, hostExecution: { mode: 'worker', extensions: [] } })).hostExecution.extensions).toEqual([])
    expect(parseGatewayConfig(Config({ ...base, hostExecution: { mode: 'worker', extensions: ['example'] } })).hostExecution.extensions).toEqual(['example'])
  })

  it('activates every local host when the Loader configuration omits the worker selector', async () => {
    const files = await fixture('import { isMainThread } from "node:worker_threads"; export default api => { api.action("probe", { run: () => ({ isMainThread }) }) }')
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context); cleanups.push(() => service.stopLocal())
    const parsed = parseGatewayConfig(Config({ stateFile: join(files.root, 'devices.json'), controlFile: join(files.root, 'control.json'), initiallyEnabled: false, tls: { mode: 'disabled' }, hostExecution: { mode: 'worker' } }))
    await service.startLocal(files.root, context, { hostExecution: { ...parsed.hostExecution, workerModule: await buildExtensionWorkerEntry() } })
    expect(service.hostStatus().hosts).toMatchObject([{ id: 'example', mode: 'worker', state: 'ready' }])
    expect((await service.invoke('example', 'probe', {}, caller()) as PreparedJsonResult).bytes.toString()).toBe('{"isMainThread":false}')
  })

  it('keeps a reserved worker charged through termination and releases only after exit', async () => {
    const files = await fixture('export default api => { api.action("probe", { run: () => ({ ok: true }) }) }')
    const budget = new ExtensionWorkerBudget(1)
    const options = { workerModule: await buildExtensionWorkerEntry(), hostFile: join(files.directory, 'host.mjs'), manifest: { schemaVersion: 1 as const, id: 'example', name: 'example', version: '1.0.0' }, generation: 'g', logger: { debug() {}, info() {}, warn() {}, error() {} }, budget }
    const first = new ExtensionWorkerHost(options); cleanups.push(() => first.dispose())
    await first.activate()
    expect(budget.current).toBe(1)
    expect(() => new ExtensionWorkerHost(options)).toThrow(expect.objectContaining({ code: 'extension_worker_limit' }))
    const terminating = first.terminate('test')
    expect(budget.current).toBe(1)
    await terminating
    expect(budget.current).toBe(0)
  })

  it('does not restart unchanged dead content until explicit recovery, and never replays an action', async () => {
    const files = await fixture(`import { appendFile } from 'node:fs/promises'; import { fileURLToPath } from 'node:url'
      const log = fileURLToPath(new URL('./runs', import.meta.url))
      export default api => {
        api.action('block', { timeoutMs: 80, run: async () => { await appendFile(log, 'once'); while (true) {} } })
        api.action('probe', { run: () => ({ ok: true }) })
      }`)
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context); cleanups.push(() => service.stopLocal())
    await service.startLocal(files.root, context, { hostExecution: { mode: 'worker', workerModule: await buildExtensionWorkerEntry(), cancelGraceMs: 100 } })
    const before = service.extension('example') as { readonly digest: string; readonly worker: ExtensionWorkerHost }
    await expect(service.invoke('example', 'block', {}, caller())).rejects.toMatchObject({ code: 'extension_action_timeout' })
    await expect(service.invoke('example', 'probe', {}, caller())).rejects.toMatchObject({ code: 'extension_busy' })
    await before.worker.whenExited()
    await service.refreshLocal()
    expect(service.extension('example')).toBe(before)
    await expect(service.invoke('example', 'probe', {}, caller())).rejects.toMatchObject({ code: 'extension_host_unavailable' })
    await service.recoverExtension('example')
    const after = service.extension('example') as { readonly digest: string; readonly worker: ExtensionWorkerHost }
    expect(after.digest).toBe(before.digest)
    expect(after.worker).not.toBe(before.worker)
    expect(await readFile(join(files.directory, 'runs'), 'utf8')).toBe('once')
    expect((await service.invoke('example', 'probe', {}, caller()) as PreparedJsonResult).bytes.toString()).toBe('{"ok":true}')
  })

  it('only selected local hosts enter workers; normal Cordis extension registrations stay in process', async () => {
    const files = await fixture('export default api => { api.action("kind", { run: () => Object.keys(api.context).includes("logger") }) }', 'selected')
    const other = join(files.root, 'ordinary'); await mkdir(other)
    await writeFile(join(other, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'ordinary', name: 'ordinary', version: '1.0.0' }))
    await writeFile(join(other, 'host.mjs'), 'export default api => { api.action("probe", { run: () => ({ ok: true }) }) }')
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context); cleanups.push(() => service.stopLocal())
    service.registerExtension({ schemaVersion: 1, id: 'cordis', name: 'cordis', version: '1', actions: { probe: { run: () => 'main' } } })
    await service.startLocal(files.root, context, { hostExecution: { mode: 'worker', extensions: ['selected'], workerModule: await buildExtensionWorkerEntry() } })
    expect(service.hostStatus().hosts.map(entry => [entry.id, entry.mode])).toEqual([['ordinary', 'in-process'], ['selected', 'worker']])
    expect(await service.invoke('cordis', 'probe', {}, caller())).toBe('main')
    expect(await service.invoke('ordinary', 'probe', {}, caller())).toEqual({ ok: true })
  })

  it('applies the configured V8 heap budget in the actual worker', async () => {
    const instance = await host('import { getHeapStatistics } from "node:v8"; export default api => { api.action("heap", {run: () => getHeapStatistics().heap_size_limit}) }', { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4 })
    const value = JSON.parse((await instance.invoke('heap', {}, caller())).bytes.toString()) as number
    expect(value).toBeGreaterThan(16 * 1024 * 1024)
    expect(value).toBeLessThan(80 * 1024 * 1024)
  })

  it('ends unresolved cleanup within the configured grace and waits for worker exit', async () => {
    const files = await fixture('export default api => { api.effect(() => () => new Promise(() => {})); api.action("probe", {run: () => true}) }')
    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context); cleanups.push(() => service.stopLocal())
    await service.startLocal(files.root, context, {hostExecution: {mode: 'worker', workerModule: await buildExtensionWorkerEntry(), disposeGraceMs: 100}})
    const current = service.extension('example') as { readonly worker: ExtensionWorkerHost }
    await service.stopLocal()
    await expect(current.worker.whenExited()).resolves.toBeUndefined()
    expect(current.worker.available()).toBe(false)
    expect(service.hostStatus().limits.workers).toBe(0)
  })

  it('snapshots methods and parser ownership, rejects invalid timeout and closes activation registration', async () => {
    const instance = await host(`export default api => {
      const parser = { prefix: 'bound', parse(input) { return this.prefix + input } }
      const action = { prefix: 'original', input: parser, timeoutMs: 1000, run(_ctx, input) { return this.prefix + ':' + input } }
      api.action('probe', action)
      action.run = () => 'mutated'; action.timeoutMs = 1; parser.parse = () => 'mutated'
      api.action('late', { run: () => { try { api.action('extra', {run: () => 1}) } catch { return 'closed' }; return 'open' } })
    }`)
    expect((await instance.invoke('probe', 'x', caller())).bytes.toString()).toBe('"original:boundx"')
    expect((await instance.invoke('late', {}, caller())).bytes.toString()).toBe('"closed"')
    const files = await fixture('export default api => { api.action("bad", { timeoutMs: 0, run: () => 1 }) }')
    const invalid = new ExtensionWorkerHost({ workerModule: await buildExtensionWorkerEntry(), hostFile: join(files.directory, 'host.mjs'), manifest: { schemaVersion: 1, id: 'example', name: 'example', version: '1' }, generation: 'bad', logger: { debug() {}, info() {}, warn() {}, error() {} } })
    cleanups.push(() => invalid.dispose())
    await expect(invalid.activate()).rejects.toMatchObject({ code: 'invalid_action', status: 400 })
  })

  it('retains finite unread EOF data in the aggregate budget and resumes waiting siblings after consumption', async () => {
    const instance = await host(`import { Readable } from 'node:stream'
      export default api => { api.route({ method: 'GET', path: '/data', handle: () => ({ body: Readable.from([Buffer.alloc(4096, 7)]) }) }) }`, { streamWindowBytes: 4096, streamChunkBytes: 1024, streamAggregateBytes: 8192 })
    const responses = await Promise.all(Array.from({ length: 5 }, () => instance.handleRoute(0, routeRequest())))
    const streams = responses.map(response => response.body as Readable)
    await expect.poll(() => instance.streamStats().bufferedBytes).toBe(8192)
    expect(streams.reduce((sum, stream) => sum + stream.readableLength, 0)).toBeLessThanOrEqual(8192)
    const buffers: Buffer[] = []
    for (const stream of streams) { const pieces: Buffer[] = []; for await (const piece of stream) pieces.push(Buffer.from(piece)); buffers.push(Buffer.concat(pieces)) }
    expect(buffers.map(buffer => buffer.length)).toEqual([4096, 4096, 4096, 4096, 4096])
    expect(buffers.every(buffer => buffer.every(byte => byte === 7))).toBe(true)
    expect(instance.streamStats().maxBufferedBytes).toBeLessThanOrEqual(8192)
    expect(instance.streamStats().bufferedBytes).toBe(0)
  })

  it('keeps cancellation connected after stream-start and confirms source cleanup without killing healthy runtime', async () => {
    const instance = await host(`import { Readable } from 'node:stream'
      let destroyed = false
      export default api => {
        api.route({ method: 'GET', path: '/data', handle: () => ({ body: new Readable({read() {}, destroy(error, done) {destroyed = true; done(error)} }) }) })
        api.action('probe', {run: () => ({ destroyed })})
      }`)
    const controller = new AbortController()
    const response = await instance.handleRoute(0, { ...routeRequest(), signal: controller.signal })
    controller.abort()
    await expect.poll(() => instance.streamStats().activeStreams).toBe(0)
    expect((response.body as Readable).destroyed).toBe(true)
    expect((await instance.invoke('probe', {}, caller())).bytes.toString()).toBe('{"destroyed":true}')
    expect(instance.available()).toBe(true)
  })

  it('gives a queued finite stream bytes while a continuous hot producer remains live', async () => {
    const instance = await host(`import { Readable } from 'node:stream'
      export default api => {
        api.route({method:'GET',path:'/hot',handle:()=>({body:new Readable({read(){this.push(Buffer.alloc(1024,3))}})})})
        api.route({method:'GET',path:'/finite',handle:()=>({body:Readable.from([Buffer.alloc(4096,9)])})})
      }`, {streamWindowBytes:4096,streamChunkBytes:1024,streamAggregateBytes:4096})
    const hotResponse = await instance.handleRoute(0, routeRequest())
    const hotStream = hotResponse.body as Readable
    await expect.poll(() => hotStream.readableLength).toBe(4096)
    const finiteResponse = await instance.handleRoute(1, {...routeRequest(),pathname:'/finite'})
    const finite = finiteResponse.body as Readable
    const collected = (async (): Promise<Buffer> => { const pieces:Buffer[]=[]; for await (const piece of finite) pieces.push(Buffer.from(piece)); return Buffer.concat(pieces) })()
    let hotBytes = 0
    hotStream.on('data', (chunk:Buffer) => {hotBytes += chunk.byteLength})
    const body = await collected
    expect(body).toEqual(Buffer.alloc(4096,9))
    expect(hotBytes).toBeGreaterThan(0)
    expect(hotStream.destroyed).toBe(false)
    expect(instance.streamStats().activeStreams).toBe(1)
    expect(instance.streamStats().maxBufferedBytes).toBeLessThanOrEqual(4096)
    hotStream.destroy()
    await expect.poll(() => instance.streamStats().activeStreams).toBe(0)
  })

  it('removes a cancelled aggregate waiter so the next queued stream can progress', async () => {
    const instance = await host(`import {Readable} from 'node:stream'; export default api => {api.route({method:'GET',path:'/data',handle:()=>({body:Readable.from([Buffer.alloc(4096,4)])})})}`, {streamWindowBytes:4096,streamChunkBytes:1024,streamAggregateBytes:4096})
    const held = (await instance.handleRoute(0, routeRequest())).body as Readable
    await expect.poll(() => held.readableLength).toBe(4096)
    const cancelled = new AbortController()
    const queued = (await instance.handleRoute(0, {...routeRequest(),signal:cancelled.signal})).body as Readable
    const next = (await instance.handleRoute(0, routeRequest())).body as Readable
    cancelled.abort()
    await expect.poll(() => queued.destroyed).toBe(true)
    held.destroy()
    const pieces:Buffer[]=[]; for await (const piece of next) pieces.push(Buffer.from(piece))
    expect(Buffer.concat(pieces)).toEqual(Buffer.alloc(4096,4))
    await expect.poll(() => instance.streamStats().bufferedBytes).toBe(0)
    expect(instance.available()).toBe(true)
  })

  it('bounds and snapshots response metadata inside the worker before any cross-thread cloning',async()=>{
    const instance=await host(`import {Readable} from 'node:stream'
      let closed=false
      export default api=>{
        api.route({method:'GET',path:'/safe',handle:()=>({body:'safe',headers:{ETag:'"v1"','x-ignored-function':()=>1,'cache-control':'no-store'}})})
        api.route({method:'GET',path:'/huge',handle:()=>({body:'safe',headers:{etag:'x'.repeat(17000)}})})
        api.route({method:'GET',path:'/stream-huge',handle:()=>({body:new Readable({read(){},destroy(error,done){closed=true;done(error)}}),headers:{etag:'x'.repeat(17000)}})})
        api.action('probe',{run:()=>({closed})})
      }`)
    const safe=await instance.handleRoute(0,{...routeRequest(),pathname:'/safe'})
    expect(safe.headers).toEqual({etag:'"v1"','cache-control':'no-store'})
    expect(Buffer.from(safe.body as Uint8Array).toString()).toBe('safe')
    await expect(instance.handleRoute(1,{...routeRequest(),pathname:'/huge'})).rejects.toMatchObject({code:'invalid_route_response',status:500})
    await expect(instance.handleRoute(2,{...routeRequest(),pathname:'/stream-huge'})).rejects.toMatchObject({code:'invalid_route_response',status:500})
    expect((await instance.invoke('probe',{},caller())).bytes.toString()).toBe('{"closed":true}')
    expect(instance.available()).toBe(true)
  })
})
