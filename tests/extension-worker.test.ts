import { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { buildExtensionWorkerArtifacts, buildExtensionWorkerEntry } from './helpers/extension-worker-build.js'
import { WORKER_STREAM_AGGREGATE_BYTES, WORKER_STREAM_CREDIT_BYTES } from '../src/extension-worker-protocol.js'
import { activeWorkerCount, ExtensionWorkerHost, PreparedJsonResult } from '../src/extension-worker.js'
import { MobileAccessService } from '../src/extensions.js'

const directories: string[] = []
const contexts: Context[] = []
const hosts: ExtensionWorkerHost[] = []
const services: MobileAccessService[] = []

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.terminate('test-end')
  await Promise.all(services.splice(0).map(service => service.stopLocal()))
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function createExtensionDirectory(root: string, id: string, host: string): Promise<string> {
  const directory = join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id, name: id, version: '1.0.0' }))
  await writeFile(join(directory, 'host.mjs'), host)
  return directory
}

function captureLogger(): { lines: unknown[][]; logger: { debug: (...args: unknown[]) => void; info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void } } {
  const lines: unknown[][] = []
  const logger = {
    debug: (...args: unknown[]) => { lines.push(['debug', ...args]) },
    info: (...args: unknown[]) => { lines.push(['info', ...args]) },
    warn: (...args: unknown[]) => { lines.push(['warn', ...args]) },
    error: (...args: unknown[]) => { lines.push(['error', ...args]) },
  }
  return { lines, logger }
}

const callerBase = () => ({ signal: new AbortController().signal, deviceId: 'device' })

describe('extension worker rpc bridge', () => {
  it('activates with metadata-only registration and a logger-only context adapter', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const directory = await createExtensionDirectory(await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-')), 'demo', `
export default (api) => {
  api.action('meta', { run: () => ({ contextKeys: Object.keys(api.context).sort(), schemaType: typeof api.schema, signalBrand: typeof api.signal }) })
  api.action('echo', { timeoutMs: 1234, run: (_context, input) => input })
  api.route({ method: 'GET', path: 'status', handle: () => ({ body: 'ok' }) })
  api.route({ method: 'GET', path: 'files', kind: 'prefix', timeoutMs: 5000, handle: () => ({ body: 'ok' }) })
  api.effect(() => () => {})
  api.context.logger.info('from-worker', { n: 1 })
}
`)
    const { lines, logger } = captureLogger()
    const host = new ExtensionWorkerHost({
      workerModule,
      hostFile: join(directory, 'host.mjs'),
      manifest: { schemaVersion: 1, id: 'demo', name: 'demo', version: '1.0.0' },
      generation: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      logger,
    })
    hosts.push(host)

    const activated = await host.activate()
    // Registration crosses as plain metadata only — no functions, no schemas.
    expect(activated.actions).toEqual([{ name: 'meta' }, { name: 'echo', timeoutMs: 1234 }])
    expect(activated.routes).toEqual([
      { method: 'GET', path: '/status', kind: 'exact' },
      { method: 'GET', path: '/files', kind: 'prefix', timeoutMs: 5000 },
    ])
    // Runtime identity is distinct from the content-generation hash.
    expect(activated.runtimeId).toMatch(/^[0-9a-f-]{16,}$/u)
    expect(activated.runtimeId).not.toBe('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef')

    const meta = await host.invoke('meta', { value: 1 }, callerBase())
    // The action result crosses as worker-serialized bytes, never as a value.
    expect(meta).toBeInstanceOf(PreparedJsonResult)
    expect((meta as PreparedJsonResult).bytes.toString('utf8'))
      .toBe('{"contextKeys":["logger"],"schemaType":"function","signalBrand":"object"}')

    // The worker context adapter is logger-only and forwards to the parent logger.
    expect(lines).toContainEqual(['info', 'from-worker', '{ n: 1 }'])
  })
})

describe('extension worker streams', () => {
  it('bounds buffering for a slow consumer and propagates cancellation to the worker', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-stream-'))
    directories.push(root)
    const directory = await createExtensionDirectory(root, 'wstream', `
import { Readable } from 'node:stream'
export default (api) => {
  api.route({
    method: 'GET',
    path: 'download',
    handle: (request) => {
      function* chunks() { while (true) yield Buffer.alloc(64 * 1024, 1) }
      const source = Readable.from(chunks())
      request.signal.addEventListener('abort', () => { source.destroy() })
      return { contentType: 'application/octet-stream', body: source }
    },
  })
}
`)
    void directory
    const context = new Context(); contexts.push(context)
    const service = new MobileAccessService(context)
    services.push(service)
    await service.startLocal(root, context, { hostExecution: { mode: 'worker', workerModule } })

    const active = service.extension('wstream') as { readonly worker: ExtensionWorkerHost } | undefined
    if (active === undefined) throw new Error('wstream extension did not load')
    expect(active.worker).toBeInstanceOf(ExtensionWorkerHost)

    const result = await service.route('wstream', 'GET', '/download', {
      method: 'GET', pathname: '/download', query: new URLSearchParams(), headers: {},
      body: Buffer.alloc(0), signal: new AbortController().signal, deviceId: 'device',
    })
    const stream = result.body as Readable
    expect(typeof stream.pipe).toBe('function')

    // Slow consumer: read until 6 x 64KiB = 384KiB has been taken — MORE than
    // one 256KiB credit window. Delivery past the window proves acks actually
    // refill worker credit. (Chunk boundaries are not a byte-stream contract;
    // read() may merge buffered pushes, so assert byte totals and values.)
    let receivedBytes = 0
    const chunkSizes: number[] = []
    const watchdog = setTimeout(() => { throw new Error(`stream stalled at ${String(receivedBytes)} bytes`) }, 8_000)
    try {
      await new Promise<void>((resolveDone, rejectDone) => {
        const readOne = (): void => {
          const chunk = stream.read() as Buffer | null
          if (chunk === null) {
            const onReadable = (): void => { stream.removeListener('readable', onReadable); readOne() }
            stream.once('readable', onReadable)
            return
          }
          expect([...chunk].every(byte => byte === 1)).toBe(true)
          receivedBytes += chunk.byteLength
          chunkSizes.push(chunk.byteLength)
          if (receivedBytes >= 6 * 64 * 1024) { resolveDone(); return }
          setTimeout(readOne, 20)
        }
        stream.on('error', rejectDone)
        setTimeout(readOne, 25)
      })
    } finally {
      clearTimeout(watchdog)
    }
    expect(receivedBytes).toBeGreaterThanOrEqual(6 * 64 * 1024)
    expect(chunkSizes.length).toBeGreaterThanOrEqual(2)
    expect(active.worker.streamStats().maxBufferedBytes).toBeLessThanOrEqual(WORKER_STREAM_CREDIT_BYTES)

    // Cancellation must reach the worker and drain the stream.
    const closed = new Promise<void>(resolve => { stream.once('close', resolve) })
    stream.destroy()
    await closed
    await new Promise(resolve => { setTimeout(resolve, 150) })
    expect(active.worker.streamStats().activeStreams).toBe(0)
    expect(active.worker.streamStats().cancelledStreams).toBe(1)
  })

  it('delivers a chunk larger than the whole credit window', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-fat-'))
    directories.push(root)
    await createExtensionDirectory(root, 'fat', `
import { Readable } from 'node:stream'
export default (api) => {
  api.route({
    method: 'GET',
    path: 'fat-chunk',
    handle: () => {
      // First chunk is larger than the entire credit window.
      function* chunks() { yield Buffer.alloc(300 * 1024, 2); while (true) yield Buffer.alloc(64 * 1024, 3) }
      return { contentType: 'application/octet-stream', body: Readable.from(chunks()) }
    },
  })
}
`)
    const context = new Context(); contexts.push(context)
    const service = new MobileAccessService(context)
    services.push(service)
    await service.startLocal(root, context, { hostExecution: { mode: 'worker', workerModule } })

    const result = await service.route('fat', 'GET', '/fat-chunk', {
      method: 'GET', pathname: '/fat-chunk', query: new URLSearchParams(), headers: {},
      body: Buffer.alloc(0), signal: new AbortController().signal, deviceId: 'device',
    })
    const fat = result.body as Readable
    const total = await new Promise<number>((resolveDone, rejectDone) => {
      let sum = 0
      const watchdog = setTimeout(() => rejectDone(new Error(`fat stream stalled at ${String(sum)} bytes`)), 8_000)
      const readOne = (): void => {
        const chunk = fat.read() as Buffer | null
        if (chunk === null) {
          const onReadable = (): void => { fat.removeListener('readable', onReadable); readOne() }
          fat.once('readable', onReadable)
          return
        }
        expect([...chunk].every(byte => byte === 2 || byte === 3)).toBe(true)
        sum += chunk.byteLength
        if (sum >= 300 * 1024) { clearTimeout(watchdog); resolveDone(sum); return }
        setTimeout(readOne, 10)
      }
      fat.on('error', rejectDone)
      setTimeout(readOne, 25)
    })
    expect(total).toBeGreaterThanOrEqual(300 * 1024)
    fat.destroy()
  })

  it('delivers a complete finite stream to a delayed consumer', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-eof-'))
    directories.push(root)
    await createExtensionDirectory(root, 'finstream', `
import { Readable } from 'node:stream'
export default (api) => {
  const build = (size, filler) => Readable.from([Buffer.alloc(size, filler)])
  api.route({ method: 'GET', path: 'small', handle: () => ({ contentType: 'application/octet-stream', body: build(192 * 1024, 7) }) })
  api.route({ method: 'GET', path: 'large', handle: () => ({ contentType: 'application/octet-stream', body: build(700 * 1024, 8) }) })
}
`)
    const context = new Context(); contexts.push(context)
    const service = new MobileAccessService(context)
    services.push(service)
    await service.startLocal(root, context, { hostExecution: { mode: 'worker', workerModule } })

    const openRoute = async (path: string): Promise<Readable> => {
      const result = await service.route('finstream', 'GET', path, {
        method: 'GET', pathname: path, query: new URLSearchParams(), headers: {},
        body: Buffer.alloc(0), signal: new AbortController().signal, deviceId: 'device',
      })
      return result.body as Readable
    }

    for (const [path, filler, expectedBytes] of [['/small', 7, 192 * 1024], ['/large', 8, 700 * 1024]] as const) {
      const stream = await openRoute(path)
      // Delay reading until the worker has fully finished and sent stream-end.
      await new Promise(resolve => { setTimeout(resolve, 400) })
      const received = await new Promise<{ bytes: number; ended: boolean }>((resolveDone, rejectDone) => {
        let sum = 0
        const watchdog = setTimeout(() => rejectDone(new Error(`${path} stalled at ${String(sum)} of ${String(expectedBytes)} bytes`)), 8_000)
        const readOne = (): void => {
          const chunk = stream.read() as Buffer | null
          if (chunk === null) {
            stream.once('readable', () => { stream.removeListener('end', onEnd); readOne() })
            stream.once('end', onEnd)
            return
          }
          expect([...chunk].every(byte => byte === filler)).toBe(true)
          sum += chunk.byteLength
          setTimeout(readOne, 5)
        }
        const onEnd = (): void => { clearTimeout(watchdog); resolveDone({ bytes: sum, ended: true }) }
        stream.on('end', onEnd)
        stream.on('error', rejectDone)
        readOne()
      })
      // The entire payload must survive EOF, including bytes still queued in
      // the bridge when the worker finished.
      expect(received.bytes).toBe(expectedBytes)
      expect(received.ended).toBe(true)
    }
  })
})

describe('extension worker termination contract', () => {
  it('keeps the deadline result, settles siblings unavailable, and never replays', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-sibling-'))
    directories.push(root)
    const directory = await createExtensionDirectory(root, 'stalled', `
import { appendFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const log = fileURLToPath(new URL('./exec.log', import.meta.url))
export default (api) => {
  api.action('stall', { timeoutMs: 50, run: async () => { await appendFile(log, 'stall\\n'); await new Promise(() => {}) } })
  api.action('slowpoke', { run: async () => { await appendFile(log, 'slowpoke\\n'); await new Promise(resolve => { setTimeout(resolve, 400) }); return { ok: true } } })
}
`)
    void directory
    const context = new Context(); contexts.push(context)
    const service = new MobileAccessService(context)
    services.push(service)
    await service.startLocal(root, context, { hostExecution: { mode: 'worker', workerModule } })

    const caller = (): { signal: AbortSignal; deviceId: string } => ({ signal: new AbortController().signal, deviceId: 'device' })
    const trigger = service.invoke('stalled', 'stall', {}, caller())
    const sibling = service.invoke('stalled', 'slowpoke', {}, caller())
    const siblingOutcome = sibling.catch((error: unknown) => error)

    // The invocation that triggered the deadline keeps its timeout result.
    await expect(trigger).rejects.toMatchObject({ code: 'extension_action_timeout', status: 500 })
    // Other pending invocations in that worker settle unavailable.
    await expect(siblingOutcome).resolves.toMatchObject({ code: 'extension_host_unavailable', status: 503 })

    // No interrupted action is replayed: execution log stays exactly one entry
    // per action even after slowpoke's natural completion time has passed.
    await new Promise(resolve => { setTimeout(resolve, 450) })
    const lines = (await readFile(join(root, 'stalled', 'exec.log'), 'utf8')).trim().split('\n').sort()
    expect(lines).toEqual(['slowpoke', 'stall'])

    // The dead runtime is not silently resurrected for new work.
    await expect(service.invoke('stalled', 'slowpoke', {}, caller())).rejects.toMatchObject({ code: 'extension_host_unavailable', status: 503 })
  })
})

describe('extension worker review fixes', () => {
  const caller = (): { signal: AbortSignal; deviceId: string } => ({ signal: new AbortController().signal, deviceId: 'device' })

  it('bounds aggregate buffering across concurrent unconsumed streams', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-agg-'))
    directories.push(root)
    await createExtensionDirectory(root, 'fanout', `
import { Readable } from 'node:stream'
export default (api) => {
  api.route({
    method: 'GET',
    path: 'firehose',
    handle: () => {
      function* chunks() { while (true) yield Buffer.alloc(64 * 1024, 9) }
      return { contentType: 'application/octet-stream', body: Readable.from(chunks()) }
    },
  })
}
`)
    const context = new Context(); contexts.push(context)
    const service = new MobileAccessService(context)
    services.push(service)
    await service.startLocal(root, context, { hostExecution: { mode: 'worker', workerModule } })
    const active = service.extension('fanout') as { readonly worker: ExtensionWorkerHost } | undefined
    if (active === undefined) throw new Error('fanout extension did not load')

    // Five eager streams with NO consumer: 5 x 256KiB windows would be 1.25MiB;
    // the per-worker aggregate bound (1MiB) must cap parent-side buffering.
    const bridges: Readable[] = []
    for (let index = 0; index < 5; index += 1) {
      const result = await service.route('fanout', 'GET', '/firehose', {
        method: 'GET', pathname: '/firehose', query: new URLSearchParams(), headers: {},
        body: Buffer.alloc(0), signal: new AbortController().signal, deviceId: 'device',
      })
      bridges.push(result.body as Readable)
    }
    await new Promise(resolve => { setTimeout(resolve, 300) })
    expect(active.worker.streamStats().activeStreams).toBe(5)
    expect(active.worker.streamStats().maxBufferedBytes).toBeLessThanOrEqual(WORKER_STREAM_AGGREGATE_BYTES)
    expect(active.worker.streamStats().maxBufferedBytes).toBeGreaterThan(WORKER_STREAM_CREDIT_BYTES)
    for (const bridge of bridges) bridge.destroy()
    await new Promise(resolve => { setTimeout(resolve, 100) })
  })

  it('recovers from aggregate saturation: a starved stream progresses once budget frees', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-starve-'))
    directories.push(root)
    await createExtensionDirectory(root, 'fanout2', `
import { Readable } from 'node:stream'
export default (api) => {
  api.route({
    method: 'GET',
    path: 'firehose',
    handle: () => {
      function* chunks() { while (true) yield Buffer.alloc(64 * 1024, 5) }
      return { contentType: 'application/octet-stream', body: Readable.from(chunks()) }
    },
  })
}
`)
    const context = new Context(); contexts.push(context)
    const service = new MobileAccessService(context)
    services.push(service)
    await service.startLocal(root, context, { hostExecution: { mode: 'worker', workerModule } })
    const active = service.extension('fanout2') as { readonly worker: ExtensionWorkerHost } | undefined
    if (active === undefined) throw new Error('fanout2 extension did not load')

    // Saturate the aggregate with four unconsumed streams, then open a fifth.
    const saturated: Readable[] = []
    for (let index = 0; index < 4; index += 1) {
      const result = await service.route('fanout2', 'GET', '/firehose', {
        method: 'GET', pathname: '/firehose', query: new URLSearchParams(), headers: {},
        body: Buffer.alloc(0), signal: new AbortController().signal, deviceId: 'device',
      })
      saturated.push(result.body as Readable)
    }
    await new Promise(resolve => { setTimeout(resolve, 250) })
    const fifth = (await service.route('fanout2', 'GET', '/firehose', {
      method: 'GET', pathname: '/firehose', query: new URLSearchParams(), headers: {},
      body: Buffer.alloc(0), signal: new AbortController().signal, deviceId: 'device',
    })).body as Readable

    // Now drain the four saturating streams: the fifth must eventually send
    // (a zero-initial-credit stream may not starve forever), and the
    // aggregate bound must hold throughout recovery.
    for (const stream of saturated) {
      const read = stream.read()
      void read
    }
    const progress = await new Promise<number>((resolveDone, rejectDone) => {
      let sum = 0
      const watchdog = setTimeout(() => rejectDone(new Error(`fifth stream starved at ${String(sum)} bytes`)), 6_000)
      const readOne = (): void => {
        const chunk = fifth.read() as Buffer | null
        if (chunk === null) {
          const onReadable = (): void => { fifth.removeListener('readable', onReadable); readOne() }
          fifth.once('readable', onReadable)
          return
        }
        sum += chunk.byteLength
        if (sum >= 64 * 1024) { clearTimeout(watchdog); resolveDone(sum); return }
        setTimeout(readOne, 10)
      }
      fifth.on('error', rejectDone)
      setTimeout(readOne, 25)
    })
    expect(progress).toBeGreaterThanOrEqual(64 * 1024)
    expect(active.worker.streamStats().maxBufferedBytes).toBeLessThanOrEqual(WORKER_STREAM_AGGREGATE_BYTES)
    fifth.destroy()
    for (const stream of saturated) stream.destroy()
  })

  it('enforces a parent-owned deadline for buffered route responses', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-rdeadline-'))
    directories.push(root)
    await createExtensionDirectory(root, 'slowroute', `
export default (api) => {
  api.route({ method: 'GET', path: 'hang', timeoutMs: 100, handle: () => new Promise(() => {}) })
}
`)
    const context = new Context(); contexts.push(context)
    const service = new MobileAccessService(context)
    services.push(service)
    await service.startLocal(root, context, { hostExecution: { mode: 'worker', workerModule } })
    const active = service.extension('slowroute') as { readonly worker: ExtensionWorkerHost } | undefined
    if (active === undefined) throw new Error('slowroute extension did not load')

    const hung = service.route('slowroute', 'GET', '/hang', {
      method: 'GET', pathname: '/hang', query: new URLSearchParams(), headers: {},
      body: Buffer.alloc(0), signal: new AbortController().signal, deviceId: 'device',
    })
    await expect(hung).rejects.toMatchObject({ code: 'extension_route_timeout', status: 500 })
    // Deadline fired and the handler never settles: cleanup grace terminates.
    await expect(Promise.race([active.worker.whenExited().then(() => true), new Promise(resolve => { setTimeout(() => resolve(false), 3_000) })])).resolves.toBe(true)
  })

  it('does not leak worker threads when activation fails or the service stops', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const brokenRoot = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-broken-'))
    directories.push(brokenRoot)
    const broken = join(brokenRoot, 'broken')
    await mkdir(broken, { recursive: true })
    await writeFile(join(broken, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'broken', name: 'broken', version: '1.0.0' }))
    await writeFile(join(broken, 'host.mjs'), 'throw new Error("boom at import")\n')

    const before = activeWorkerCount.current
    // Broken activation: the watcher retries every 2s; every spawned worker
    // must be terminated instead of accumulating. (Staging is atomic upstream:
    // one broken extension fails the pass, so it lives alone in this root.)
    const brokenContext = new Context(); contexts.push(brokenContext)
    const brokenService = new MobileAccessService(brokenContext)
    services.push(brokenService)
    await brokenService.startLocal(brokenRoot, brokenContext, { hostExecution: { mode: 'worker', workerModule } })
    await new Promise(resolve => { setTimeout(resolve, 2_400) })
    expect(activeWorkerCount.current).toBe(before)

    // stopLocal awaits worker disposal: nothing may outlive it.
    const healthyRoot = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-healthy-'))
    directories.push(healthyRoot)
    await createExtensionDirectory(healthyRoot, 'healthy', 'export default () => {}\n')
    const healthyContext = new Context(); contexts.push(healthyContext)
    const healthyService = new MobileAccessService(healthyContext)
    services.push(healthyService)
    await healthyService.startLocal(healthyRoot, healthyContext, { hostExecution: { mode: 'worker', workerModule } })
    expect(activeWorkerCount.current).toBe(before + 1)
    await healthyService.stopLocal()
    expect(activeWorkerCount.current).toBe(before)
  })

  it('preserves business error codes, statuses, and input-validation failures', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-errors-'))
    directories.push(root)
    await createExtensionDirectory(root, 'codes', `
export default (api) => {
  api.action('busy', { run: async () => { const error = new Error('nope'); error.code = 'custom_busy'; error.status = 429; throw error } })
  api.action('strict', { input: (value) => { if (typeof value !== 'string') throw new Error('want string'); return value }, run: async () => ({ ok: true }) })
}
`)
    const context = new Context(); contexts.push(context)
    const service = new MobileAccessService(context)
    services.push(service)
    await service.startLocal(root, context, { hostExecution: { mode: 'worker', workerModule } })

    await expect(service.invoke('codes', 'busy', {}, caller())).rejects.toMatchObject({ code: 'custom_busy', status: 429 })
    await expect(service.invoke('codes', 'strict', 42, caller())).rejects.toMatchObject({ code: 'invalid_action_input', status: 400 })
    await expect(service.invoke('codes', 'strict', 'fine', caller())).resolves.toBeInstanceOf(PreparedJsonResult)
  })

  it('recovers logger forwarding after a burst instead of muting forever', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-logs-'))
    directories.push(directory)
    const extensionDir = join(directory, 'chatty')
    await mkdir(extensionDir, { recursive: true })
    await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'chatty', name: 'chatty', version: '1.0.0' }))
    await writeFile(join(extensionDir, 'host.mjs'), `
export default (api) => {
  api.action('burst', { run: async () => {
    for (let index = 0; index < 100; index += 1) api.context.logger.info('burst', index)
    await new Promise(resolve => { setTimeout(resolve, 1200) })
    api.context.logger.info('after-window')
    return { ok: true }
  } })
}
`)
    const lines: unknown[][] = []
    const host = new ExtensionWorkerHost({
      workerModule,
      hostFile: join(extensionDir, 'host.mjs'),
      manifest: { schemaVersion: 1, id: 'chatty', name: 'chatty', version: '1.0.0' },
      generation: 'log-window',
      logger: { debug() {}, info: (...args: unknown[]) => { lines.push(args) }, warn() {}, error() {} },
    })
    hosts.push(host)
    await host.activate()
    await host.invoke('burst', {}, caller())
    // The burst was capped inside its window, but the budget reset afterwards.
    expect(lines.filter(args => args[0] === 'burst').length).toBeLessThanOrEqual(64)
    expect(lines.some(args => args[0] === 'after-window')).toBe(true)
  })

  it('survives malformed worker messages without crashing the parent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-fake-'))
    directories.push(directory)
    const fakeModule = join(directory, 'fake-worker.mjs')
    await writeFile(fakeModule, `
import { parentPort } from 'node:worker_threads'
parentPort.postMessage({ kind: 'log' })
parentPort.postMessage({ kind: 'result' })
parentPort.postMessage('not-an-object')
parentPort.postMessage({ kind: 'log', level: 'info', args: ['survived'] })
setInterval(() => {}, 60_000)
`)
    const lines: unknown[][] = []
    const host = new ExtensionWorkerHost({
      workerModule: fakeModule,
      hostFile: join(directory, 'host.mjs'),
      manifest: { schemaVersion: 1, id: 'fake', name: 'fake', version: '1.0.0' },
      generation: 'fake',
      activationTimeoutMs: 300,
      logger: { debug() {}, info: (...args: unknown[]) => { lines.push(args) }, warn() {}, error() {} },
    })
    hosts.push(host)
    // The fake worker never activates: expect the bounded timeout, not a crash.
    await expect(host.activate()).rejects.toMatchObject({ code: 'host_load_timeout' })
    expect(lines.some(args => args[0] === 'survived')).toBe(true)
  })

  it('boots a worker through the default resolver without an explicit module path', async () => {
    // The packaged path resolves the runtime entry next to the supervisor
    // bundle; the helper builds both into one directory, so the bundled
    // supervisor's own default resolver is exercised exactly as shipped.
    const artifacts = await buildExtensionWorkerArtifacts()
    const bundle = await import(artifacts.supervisorBundle) as typeof import('../src/extension-worker.js')
    const resolved = bundle.defaultExtensionWorkerModule()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-default-'))
    directories.push(directory)
    const extensionDir = join(directory, 'defres')
    await mkdir(extensionDir, { recursive: true })
    await writeFile(join(extensionDir, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'defres', name: 'defres', version: '1.0.0' }))
    await writeFile(join(extensionDir, 'host.mjs'), 'export default (api) => { api.action("ping", { run: async () => ({ via: "default" }) }) }')
    const host = new bundle.ExtensionWorkerHost({
      workerModule: resolved,
      hostFile: join(extensionDir, 'host.mjs'),
      manifest: { schemaVersion: 1, id: 'defres', name: 'defres', version: '1.0.0' },
      generation: 'default-resolver',
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    })
    hosts.push(host)
    const activated = await host.activate()
    expect(activated.actions.map(action => action.name)).toEqual(['ping'])
    const reply = await host.invoke('ping', {}, caller())
    expect(reply.bytes.toString('utf8')).toBe('{"via":"default"}')
  })

  it('cancels a late stream response whose caller already timed out', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-late-'))
    directories.push(root)
    await createExtensionDirectory(root, 'latestream', `
import { Readable } from 'node:stream'
export default (api) => {
  api.action('ping', { run: async () => ({ ok: true }) })
  api.route({
    method: 'GET',
    path: 'delayed-stream',
    timeoutMs: 150,
    handle: async () => {
      await new Promise(resolve => { setTimeout(resolve, 350) })
      return { contentType: 'application/octet-stream', body: Readable.from([Buffer.alloc(64 * 1024, 3)]) }
    },
  })
}
`)
    const context = new Context(); contexts.push(context)
    const service = new MobileAccessService(context)
    services.push(service)
    await service.startLocal(root, context, { hostExecution: { mode: 'worker', workerModule } })
    const active = service.extension('latestream') as { readonly worker: ExtensionWorkerHost } | undefined
    if (active === undefined) throw new Error('latestream extension did not load')

    const hung = service.route('latestream', 'GET', '/delayed-stream', {
      method: 'GET', pathname: '/delayed-stream', query: new URLSearchParams(), headers: {},
      body: Buffer.alloc(0), signal: new AbortController().signal, deviceId: 'device',
    })
    // The caller settles at its deadline; the handler returns a stream later.
    await expect(hung).rejects.toMatchObject({ code: 'extension_route_timeout', status: 500 })
    await new Promise(resolve => { setTimeout(resolve, 600) })

    // The late stream must be cancelled and supervised to an end — not left
    // as an orphaned bridge nobody consumes.
    expect(active.worker.streamStats().activeStreams).toBe(0)
    expect(active.worker.streamStats().cancelledStreams).toBeGreaterThanOrEqual(1)
    // Cleanup supervision disarms only on confirmed end, so the worker
    // (which cooperated) survives and still serves.
    await expect(service.invoke('latestream', 'ping', {}, caller())).resolves.toBeInstanceOf(PreparedJsonResult)
  })

  it('rejects a malformed route reply instead of orphaning the RPC', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-badreply-'))
    directories.push(directory)
    const fakeModule = join(directory, 'bad-reply-worker.mjs')
    await writeFile(fakeModule, `
import { parentPort } from 'node:worker_threads'
parentPort.on('message', (message) => {
  if (message.kind === 'activate') {
    parentPort.postMessage({ kind: 'activated', runtimeId: 'bad-reply', actions: [], routes: [{ method: 'GET', path: '/x', kind: 'exact' }] })
    return
  }
  if (message.kind === 'route') {
    // Malformed payload: bytes is not a Uint8Array.
    parentPort.postMessage({ kind: 'route-response', runtimeId: 'bad-reply', id: message.id, bytes: { bad: true } })
  }
})
setInterval(() => {}, 60_000)
`)
    const host = new ExtensionWorkerHost({
      workerModule: fakeModule,
      hostFile: join(directory, 'host.mjs'),
      manifest: { schemaVersion: 1, id: 'badreply', name: 'badreply', version: '1.0.0' },
      generation: 'bad-reply',
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    })
    hosts.push(host)
    await host.activate()
    // The malformed reply must reject the caller promptly — not hang for the
    // 30s default deadline.
    const reply = host.handleRoute(0, {
      method: 'GET', pathname: '/x', query: new URLSearchParams(), headers: {},
      body: Buffer.alloc(0), signal: new AbortController().signal, deviceId: 'device',
    })
    await expect(reply).rejects.toMatchObject({ code: 'invalid_route_response', status: 500 })
  })

  it('keeps logging clone-safe and bounded without failing the action', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-logsafe-'))
    directories.push(root)
    await createExtensionDirectory(root, 'logsafe', `
export default (api) => {
  api.action('loud', { run: async () => {
    api.context.logger.info(() => {}, Symbol('sym'), 'giant'.repeat(300_000))
    return { ok: true }
  } })
}
`)
    const lines: unknown[][] = []
    const context = new Context(); contexts.push(context)
    const service = new MobileAccessService(context)
    services.push(service)
    await service.startLocal(root, context, { hostExecution: { mode: 'worker', workerModule } })
    void lines
    // Logging a function, a symbol, and a 1.8MB string must neither throw into
    // the action nor clone-error the worker.
    const active = service.extension('logsafe') as { readonly worker: ExtensionWorkerHost } | undefined
    if (active === undefined) throw new Error('logsafe extension did not load')
    await expect(service.invoke('logsafe', 'loud', {}, caller())).resolves.toBeInstanceOf(PreparedJsonResult)
  })

  it('preserves api.manifest.id and awaits failing async effects at activation', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    // Staging is atomic: a failing extension aborts the whole pass, so the
    // parity and failing-effect extensions live in separate roots.
    const parityRoot = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-parity-'))
    directories.push(parityRoot)
    await createExtensionDirectory(parityRoot, 'parity', `
export default (api) => {
  api.action('whoami', { run: async () => ({ id: api.manifest.id }) })
}
`)
    const effectRoot = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-badeffect-'))
    directories.push(effectRoot)
    await createExtensionDirectory(effectRoot, 'badeffect', `
export default (api) => {
  api.effect(async () => { throw new Error('effect exploded') })
}
`)
    const context = new Context(); contexts.push(context)
    const service = new MobileAccessService(context)
    services.push(service)
    await service.startLocal(parityRoot, context, { hostExecution: { mode: 'worker', workerModule } })

    // api.manifest.id must be the extension id, exactly like in-process mode.
    const reply = await service.invoke('parity', 'whoami', {}, caller()) as PreparedJsonResult
    expect(reply.bytes.toString('utf8')).toBe('{"id":"parity"}')

    const effectContext = new Context(); contexts.push(effectContext)
    const effectService = new MobileAccessService(effectContext)
    services.push(effectService)
    await effectService.startLocal(effectRoot, effectContext, { hostExecution: { mode: 'worker', workerModule } })
    // A rejected async effect must fail activation (in-process contract).
    expect(effectService.extension('badeffect')).toBeUndefined()
    expect(effectService.status().failed).toBeGreaterThanOrEqual(1)
  })
})
