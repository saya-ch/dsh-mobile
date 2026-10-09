/**
 * Worker-side runtime for opt-in local extension hosts.
 *
 * This file is a standalone tsdown entry (lib/extension-worker-runtime.mjs).
 * It executes ALL host behavior inside the worker thread — module import,
 * activation, input validation, actions, effects and cleanup — and answers the
 * parent with metadata and pre-serialized bytes only. It must never import
 * Cordis or any DSH service.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { inspect } from 'node:util'
import { resolveHostExecution } from './extension-worker-config.js'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  businessErrorShape,
  normalizeWorkerRoutePath,
  serializeWorkerResult,
  validOperationTimeout,
  WORKER_RESPONSE_METADATA_MAX_BYTES,
  type ParentMessage,
  type WorkerActionMetadata,
  type WorkerRouteMetadata,
} from './extension-worker-protocol.js'

interface RuntimeActionSpec {
  readonly timeoutMs?: number
  readonly input?: ((value: unknown) => unknown) | { parse(value: unknown): unknown }
  readonly run: (context: { readonly signal: AbortSignal; readonly deviceId: string }, input: unknown) => unknown
}

interface RuntimeRouteSpec {
  readonly method: string
  readonly path: string
  readonly kind?: 'exact' | 'prefix'
  readonly timeoutMs?: number
  readonly handle: (request: {
    readonly method: string
    readonly pathname: string
    readonly query: URLSearchParams
    readonly headers: Readonly<Record<string, string>>
    readonly body: Buffer
    readonly signal: AbortSignal
    readonly deviceId: string
  }) => { status?: number; contentType?: string; headers?: Record<string, string>; body: string | Uint8Array | import('node:stream').Readable } | Promise<{ status?: number; contentType?: string; headers?: Record<string, string>; body: string | Uint8Array | import('node:stream').Readable }>
}

type HostModule = { readonly default?: (api: RuntimeHostApi) => void | Promise<void> }

/**
 * The worker-side host API. `context` is a documented LOGGER-ONLY adapter —
 * it is deliberately not typed or advertised as a Cordis Context.
 */
interface RuntimeHostApi {
  readonly manifest: { readonly id: string }
  readonly context: { readonly logger: Record<'debug' | 'info' | 'warn' | 'error', (...args: unknown[]) => void> }
  readonly schema: typeof z
  readonly signal: AbortSignal
  action(name: string, spec: RuntimeActionSpec): void
  route(spec: RuntimeRouteSpec): void
  effect(setup: () => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>): void
}

const parentChannel = parentPort
if (parentChannel === null) throw new Error('extension-worker-runtime must run inside a Worker')
const port = parentChannel
const limits = resolveHostExecution((workerData as { readonly limits?: unknown } | undefined)?.limits)

/** Logger-adapter burst budget per time window; the budget resets each window. */
const LOG_QUEUE_LIMIT = limits.logMessagesPerWindow

const runtimeId = randomUUID()
const generationController = new AbortController()
const actions = new Map<string, RuntimeActionSpec>()
const routes: RuntimeRouteSpec[] = []
const cleanups: (() => void | Promise<void>)[] = []
let logWindowCount = 0
let logWindowStartedAt = Date.now()

function send(message: unknown): void {
  port.postMessage(message)
}

/** Upper bound for one stringified log argument forwarded to the parent. */
const LOG_ARG_MAX_CHARS = limits.logMessageBytes

/** Render a log argument that structured cloning cannot carry (or that is huge). */
function sanitizeLogArg(value: unknown): string {
  const rendered = typeof value === 'string' ? value : inspect(value, { depth: 2, maxArrayLength: 16, maxStringLength: 256, customInspect: false, getters: false })
  return rendered.slice(0, LOG_ARG_MAX_CHARS)
}

function log(level: 'debug' | 'info' | 'warn' | 'error', args: readonly unknown[]): void {
  const now = Date.now()
  if (now - logWindowStartedAt >= limits.logWindowMs) {
    logWindowStartedAt = now
    logWindowCount = 0
  }
  if (logWindowCount >= LOG_QUEUE_LIMIT) return
  logWindowCount += 1
  try {
    // Logging must never fail the host's calling code: clone-unsafe values are
    // rendered, oversized strings are truncated, and a postMessage failure
    // (deep non-cloneable objects) is swallowed.
    let remaining = limits.logMessageBytes
    const rendered: string[] = []
    for (const arg of args) {
      if (remaining <= 0) break
      const bytes = Buffer.from(sanitizeLogArg(arg)).subarray(0, remaining)
      const text = bytes.toString('utf8').replace(/\uFFFD$/u, '')
      rendered.push(text); remaining -= Buffer.byteLength(text)
    }
    send({ kind: 'log', level, args: rendered })
  } catch (error) { void error /* Logging cannot fail host execution. */ }
}

/** Bound a forwarded error message so it cannot carry unbounded text. */
function boundedMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > 500 ? text.slice(0, 500) : text
}

const loggerAdapter = {
  debug: (...args: unknown[]) => { log('debug', args) },
  info: (...args: unknown[]) => { log('info', args) },
  warn: (...args: unknown[]) => { log('warn', args) },
  error: (...args: unknown[]) => { log('error', args) },
}

/** The lifecycle RPC id currently in flight, for outer-catch replies. */
let lifecycleReplyId = 'lifecycle'

port.on('message', (message: ParentMessage) => {
  void handleMessage(message).catch((error: unknown) => {
    send({ kind: 'error', runtimeId, id: lifecycleReplyId, code: 'extension_failed', message: boundedMessage(error), status: 500 })
  })
})

/** Live per-request controllers, so parent cancel messages abort running work. */
const requestControllers = new Map<string, AbortController>()

function abortRequest(id: string): void {
  requestControllers.get(id)?.abort(new Error('request cancelled'))
}

/** Live stream sources by request id, so generation abort can destroy them. */
const activeSources = new Map<string, import('node:stream').Readable>()

/** Credit per stream id; the worker pauses a source when its window is exhausted. */
const streamCredit = new Map<string, number>()

/** Sent and acknowledged bytes per stream; their difference is in-flight load. */
const streamSent = new Map<string, number>()
const streamAcked = new Map<string, number>()

/** FIFO demands reserve aggregate bytes before waking a source pump. */
const sendBudgetWaiters: { readonly id: string; readonly length: number; readonly bail: () => boolean; readonly resolve: (granted: boolean) => void }[] = []
const finishedStreams = new Set<string>()
let drainingBudget = false

/** Bytes sent but not yet acknowledged, across all live streams. */
function inFlightTotal(): number {
  let total = 0
  for (const [id, sent] of streamSent) total += sent - (streamAcked.get(id) ?? 0)
  return total
}

function wakeSendBudgetWaiters(): void {
  if (drainingBudget) return
  drainingBudget = true
  try {
    for (let index = 0; index < sendBudgetWaiters.length;) {
      const waiter = sendBudgetWaiters[index]!
      if (waiter.bail()) { sendBudgetWaiters.splice(index, 1); waiter.resolve(false); continue }
      // An unconsumed full stream does not block siblings that have their own window credit.
      if ((streamCredit.get(waiter.id) ?? 0) < waiter.length) { index += 1; continue }
      // Protect headroom for the oldest eligible demand: a hot small-chunk producer cannot continually steal it.
      if (inFlightTotal() + waiter.length > limits.streamAggregateBytes) break
      if (!tryReserve(waiter.id, waiter.length)) throw new Error('worker stream reservation failed')
      sendBudgetWaiters.splice(index, 1)
      waiter.resolve(true)
    }
  } finally { drainingBudget = false }
}

/**
 * Atomically check and debit send budget for one piece: the per-stream window
 * must hold it AND the per-worker aggregate in-flight bound must hold. Check
 * and debit are one synchronous step, so concurrently awakened pumps can never
 * double-reserve the same freed capacity.
 */
function tryReserve(id: string, length: number): boolean {
  const credit = streamCredit.get(id) ?? 0
  if (credit < length) return false
  if (inFlightTotal() + length > limits.streamAggregateBytes) return false
  streamCredit.set(id, credit - length)
  streamSent.set(id, (streamSent.get(id) ?? 0) + length)
  return true
}

/** Wait until a piece may be sent; resolves false when the caller bailed. */
async function acquireSendBudget(id: string, length: number, bail: () => boolean): Promise<boolean> {
  if (bail()) return false
  return new Promise<boolean>(resolve => { sendBudgetWaiters.push({ id, length, bail, resolve }); wakeSendBudgetWaiters() })
}

async function handleMessage(message: ParentMessage): Promise<void> {
  if (message.kind === 'activate') {
    lifecycleReplyId = message.id
    await activate(message.id, message.hostFile, message.generation, message.manifest)
    return
  }
  if (message.kind === 'invoke') {
    await runAction(message.id, message.action, message.deviceId, message.input)
    return
  }
  if (message.kind === 'route') {
    await runRoute(message)
    return
  }
  if (message.kind === 'stream-ack') {
    if (!streamSent.has(message.id) || !Number.isInteger(message.bytes) || message.bytes < 0 || message.bytes > (streamSent.get(message.id) ?? 0) - (streamAcked.get(message.id) ?? 0)) return
    streamAcked.set(message.id, (streamAcked.get(message.id) ?? 0) + message.bytes)
    if (!finishedStreams.has(message.id)) streamCredit.set(message.id, (streamCredit.get(message.id) ?? 0) + message.bytes)
    if (finishedStreams.has(message.id) && streamSent.get(message.id) === streamAcked.get(message.id)) releaseStreamAccounting(message.id)
    // Freed aggregate headroom may unblock streams that opened starved.
    wakeSendBudgetWaiters()
    return
  }
  if (message.kind === 'stream-cancel') {
    const source = activeSources.get(message.id)
    source?.destroy()
    if (finishedStreams.has(message.id)) releaseStreamAccounting(message.id)
    // A pump parked on exhausted budget must wake up and observe the destroy.
    wakeSendBudgetWaiters()
    return
  }
  if (message.kind === 'cancel') {
    abortRequest(message.id)
    return
  }
  if (message.kind === 'dispose') {
    lifecycleReplyId = message.id
    generationController.abort()
    for (const source of activeSources.values()) source.destroy()
    const pending: Promise<unknown>[] = []
    for (const cleanup of [...cleanups].reverse()) {
      try { pending.push(Promise.resolve(cleanup())) } catch { /* teardown cannot block the parent */ }
    }
    await Promise.allSettled(pending)
    send({ kind: 'result', runtimeId, id: message.id, bytes: new Uint8Array() })
    return
  }
}

async function runRoute(message: {
  readonly id: string
  readonly routeIndex: number
  readonly method: string
  readonly path: string
  readonly query: readonly (readonly [string, string])[]
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly deviceId: string
}): Promise<void> {
  const spec = routes[message.routeIndex]
  if (spec === undefined) {
    send({ kind: 'error', runtimeId, id: message.id, code: 'route_not_found', message: 'route not found', status: 404 })
    return
  }
  const controller = new AbortController()
  requestControllers.set(message.id, controller)
  const onGenerationAbort = (): void => { controller.abort(generationController.signal.reason) }
  if (generationController.signal.aborted) controller.abort()
  else generationController.signal.addEventListener('abort', onGenerationAbort, { once: true })
  try {
    const response = await spec.handle({
      method: message.method,
      pathname: message.path,
      query: new URLSearchParams([...message.query].map(([key, value]) => [key, value] as [string, string])),
      headers: message.headers,
      body: Buffer.from(message.body),
      signal: controller.signal,
      deviceId: message.deviceId,
    })
    if (response === null || typeof response !== 'object') {
      send({ kind: 'error', runtimeId, id: message.id, code: 'invalid_route_response', message: 'extension returned an invalid response', status: 500 })
      return
    }
    const body:unknown = response.body
    if (typeof body !== 'string' && !(body instanceof Uint8Array) && !isStream(body)) throw Object.assign(new Error('extension returned an invalid response'), {code:'invalid_route_response',status:500})
    let wireMeta:ReturnType<typeof snapshotResponseMetadata>
    try {wireMeta = snapshotResponseMetadata(response)} catch(error) {
      if(isStream(body)){body.once('error',()=>undefined);body.destroy()}
      throw error
    }
    if (isStream(body)) {
      await pumpStream(message.id, body, wireMeta)
      return
    }
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body)
    if (bytes.byteLength > limits.resultMaxBytes) {
      send({ kind: 'error', runtimeId, id: message.id, code: 'extension_result_too_large', message: 'extension response is too large', status: 500 })
      return
    }
    send({
      kind: 'route-response', runtimeId, id: message.id,
      ...wireMeta,
      bytes,
    })
  } catch (error) {
    const business = businessErrorShape(error)
    if (business !== undefined) {
      send({ kind: 'error', runtimeId, id: message.id, code: business.code, message: business.message, status: business.status })
      return
    }
    send({ kind: 'error', runtimeId, id: message.id, code: 'extension_failed', message: boundedMessage(error), status: 500 })
  } finally {
    requestControllers.delete(message.id)
    generationController.signal.removeEventListener('abort', onGenerationAbort)
  }
}

function isStream(value: unknown): value is import('node:stream').Readable {
  return value !== null && typeof value === 'object' && typeof (value as { pipe?: unknown }).pipe === 'function'
}

async function pumpStream(id: string, source: import('node:stream').Readable, meta: { status?: number; contentType?: string; headers?: Record<string, string> }): Promise<void> {
  activeSources.set(id, source)
  streamCredit.set(id, limits.streamWindowBytes)
  streamSent.set(id, 0)
  streamAcked.set(id, 0)
  send({
    kind: 'stream-start', runtimeId, id,
    ...(meta.status === undefined ? {} : { status: meta.status }),
    ...(meta.contentType === undefined ? {} : { contentType: meta.contentType }),
    ...(meta.headers === undefined ? {} : { headers: meta.headers }),
  })
  let ended = false
  const finish = (): void => {
    if (ended) return
    ended = true
    activeSources.delete(id)
    streamCredit.delete(id)
    finishedStreams.add(id)
    if (source.destroyed && !source.readableEnded || streamSent.get(id) === streamAcked.get(id)) releaseStreamAccounting(id)
    // Freed aggregate budget may unblock other streams.
    wakeSendBudgetWaiters()
  }
  source.once('error', error => {
    if (ended) return
    finish()
    send({ kind: 'stream-error', runtimeId, id, message: boundedMessage(error) })
  })
  try {
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      if (ended) return
      // A chunk larger than the whole window can never be granted: split it.
      for (let offset = 0; offset < bytes.byteLength;) {
        const piece = bytes.subarray(offset, Math.min(offset + limits.streamChunkBytes, bytes.byteLength))
        // Explicit pull/credit flow control plus the per-worker aggregate bound;
        // reservation is atomic, so competing wakes cannot over-send.
        if (!(await acquireSendBudget(id, piece.byteLength, () => source.destroyed || ended))) {
          finish()
          send({ kind: 'stream-end', runtimeId, id })
          source.destroy()
          return
        }
        send({ kind: 'stream-chunk', runtimeId, id, bytes: new Uint8Array(piece) })
        offset += piece.byteLength
      }
    }
    finish()
    send({ kind: 'stream-end', runtimeId, id })
  } catch (error) {
    if (ended) return
    finish()
    send({ kind: 'stream-error', runtimeId, id, message: boundedMessage(error) })
  }
}

/** Evaluate extension metadata only in the worker and forward the Gateway's existing safe headers. */
function snapshotResponseMetadata(response: {status?:number;contentType?:string;headers?:Record<string,string>}): {status?:number;contentType?:string;headers?:Record<string,string>} {
  const status = response.status
  const contentType = response.contentType
  if (status !== undefined && (!Number.isSafeInteger(status) || status < 200 || status > 599)) throw Object.assign(new Error('invalid HTTP status'), {code:'invalid_route_response',status:500})
  if (contentType !== undefined && (typeof contentType !== 'string' || contentType.length > 1024 || !/^[\x20-\x7e]+$/u.test(contentType) || !/^[\w!#$&+.^-]+\/[\w!#$&+.^-]+(?:;[\x20-\x7e]*)?$/u.test(contentType))) throw Object.assign(new Error('invalid content type'), {code:'invalid_route_response',status:500})
  const headers:Record<string,string> = {}
  const source = response.headers
  let bytes = Buffer.byteLength(contentType ?? '')
  if (source !== undefined) {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) throw Object.assign(new Error('invalid response headers'), {code:'invalid_route_response',status:500})
    for (const name of Object.keys(source)) {
      if (!/^(?:content-disposition|cache-control|etag)$/iu.test(name)) continue
      const value = source[name]
      if (typeof value !== 'string') throw Object.assign(new Error('invalid response header'), {code:'invalid_route_response',status:500})
      if (/[\r\n]/u.test(value)) continue
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value)
      if (bytes > WORKER_RESPONSE_METADATA_MAX_BYTES) throw Object.assign(new Error('response headers are too large'), {code:'invalid_route_response',status:500})
      headers[name.toLowerCase()] = value
    }
  }
  return {...(status === undefined ? {} : {status}),...(contentType === undefined ? {} : {contentType}),...(source === undefined ? {} : {headers})}
}

function releaseStreamAccounting(id: string): void {
  finishedStreams.delete(id); streamCredit.delete(id); streamSent.delete(id); streamAcked.delete(id)
  wakeSendBudgetWaiters()
}

async function activate(replyId: string, hostFile: string, generation: string, manifest: import('./extension-worker-protocol.js').WorkerActivationManifest): Promise<void> {
  // Async effect setups gate activation exactly like the in-process path: a
  // rejection fails activation instead of vanishing.
  const pendingEffects: Promise<void>[] = []
  let activationOpen = true
  const ensureOpen = (): void => { if (!activationOpen || generationController.signal.aborted) throw new Error('host activation is closed') }
  const api: RuntimeHostApi = {
    manifest: Object.freeze(manifest),
    context: Object.freeze({ logger: Object.freeze(loggerAdapter) }),
    schema: z,
    signal: generationController.signal,
    action(name, spec) {
      ensureOpen()
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name) || typeof spec?.run !== 'function') throw runtimeError('invalid_action', `invalid action ${name}`)
      if (actions.has(name)) throw runtimeError('duplicate_action', `duplicate action ${name}`)
      if (actions.size + routes.length >= limits.maxRegistrations) throw runtimeError('extension_registration_limit', 'local worker registration limit reached')
      const timeoutMs = checkedTimeout(spec.timeoutMs, 'invalid_action')
      const input = spec.input
      actions.set(name, Object.freeze({ run: spec.run.bind(spec), ...(input === undefined ? {} : { input: typeof input === 'function' ? input : Object.freeze({ parse: input.parse.bind(input) }) }), ...(timeoutMs === undefined ? {} : { timeoutMs }) }))
    },
    route(spec) {
      ensureOpen()
      if (typeof spec?.handle !== 'function') throw runtimeError('invalid_route', 'invalid route')
      if (actions.size + routes.length >= limits.maxRegistrations) throw runtimeError('extension_registration_limit', 'local worker registration limit reached')
      const method = spec.method.toUpperCase()
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || spec.kind !== undefined && spec.kind !== 'exact' && spec.kind !== 'prefix') throw new Error('invalid route')
      const path = normalizeWorkerRoutePath(spec.path)
      const kind = spec.kind ?? 'exact'
      if (routes.some(route => route.method === method && route.path === path && (route.kind ?? 'exact') === kind)) throw new Error('duplicate route')
      const timeoutMs = checkedTimeout(spec.timeoutMs, 'invalid_route')
      routes.push(Object.freeze({ method, path, kind, handle: spec.handle.bind(spec), ...(timeoutMs === undefined ? {} : { timeoutMs }) }))
    },
    effect(setup) {
      ensureOpen()
      const result = setup()
      if (result instanceof Promise) {
        const pending = result.then(async cleanup => {
          if (typeof cleanup !== 'function') return
          if (activationOpen && !generationController.signal.aborted) cleanups.push(cleanup)
          else await cleanup()
        })
        pendingEffects.push(pending)
        void pending.catch(() => undefined)
      } else if (typeof result === 'function') {
        cleanups.push(result)
      }
    },
  }
  let imported: HostModule
  try {
    imported = await import(`${pathToFileURL(hostFile).href}?dsh_generation=${generation}`) as HostModule
  } catch {
    send({ kind: 'error', runtimeId, id: replyId, code: 'host_load_failed', message: 'could not load host.mjs', status: 500 })
    return
  }
  if (generationController.signal.aborted) return
  try {
    if (imported.default !== undefined) await imported.default(api)
    await Promise.all(pendingEffects)
  } catch (error) {
    activationOpen = false
    const business = businessErrorShape(error)
    send({ kind: 'error', runtimeId, id: replyId, code: business?.code ?? 'host_activation_failed', message: boundedMessage(error), status: business?.status ?? 500 })
    return
  }
  activationOpen = false
  const actionMetadata: WorkerActionMetadata[] = [...actions.entries()].map(([name, spec]) => {
    const timeoutMs = validOperationTimeout(spec.timeoutMs)
    return { name, ...(timeoutMs === undefined ? {} : { timeoutMs }) }
  })
  const routeMetadata: WorkerRouteMetadata[] = routes.map(route => {
    const timeoutMs = validOperationTimeout(route.timeoutMs)
    return {
      method: String(route.method).toUpperCase(),
      path: normalizeWorkerRoutePath(route.path),
      kind: route.kind ?? 'exact',
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }
  })
  send({ kind: 'activated', runtimeId, actions: actionMetadata, routes: routeMetadata })
}

function checkedTimeout(value: unknown, code: string): number | undefined {
  if (value === undefined) return undefined
  const timeout = validOperationTimeout(value)
  if (timeout === undefined) throw Object.assign(new Error('operation timeoutMs is invalid'), { code, status: 400 })
  return timeout
}

function runtimeError(code: string, message: string): Error & { readonly code: string; readonly status: number } {
  return Object.assign(new Error(message), { code, status: 400 })
}

async function runAction(id: string, name: string, deviceId: string, input: unknown): Promise<void> {
  const spec = actions.get(name)
  if (spec === undefined) {
    send({ kind: 'error', runtimeId, id, code: 'action_not_found', message: `action ${name} not found`, status: 404 })
    return
  }
  const controller = new AbortController()
  requestControllers.set(id, controller)
  const onGenerationAbort = (): void => { controller.abort(generationController.signal.reason) }
  if (generationController.signal.aborted) controller.abort()
  else generationController.signal.addEventListener('abort', onGenerationAbort, { once: true })
  const errorReply = (error: unknown): void => {
    const business = businessErrorShape(error)
    if (business !== undefined) {
      send({ kind: 'error', runtimeId, id, code: business.code, message: business.message, status: business.status })
      return
    }
    send({ kind: 'error', runtimeId, id, code: 'extension_failed', message: boundedMessage(error), status: 500 })
  }
  try {
    let parsed = input
    if (spec.input !== undefined) {
      try {
        parsed = typeof spec.input === 'function' ? spec.input(input) : spec.input.parse(input) ?? input
        parsed = await parsed
      } catch {
        // Input validation failures keep the in-process contract: 400.
        send({ kind: 'error', runtimeId, id, code: 'invalid_action_input', message: 'action input is invalid', status: 400 })
        return
      }
    }
    controller.signal.throwIfAborted()
    const value = await spec.run({ signal: controller.signal, deviceId }, parsed)
    const bytes = serializeWorkerResult(value)
    if (bytes.byteLength > limits.resultMaxBytes) {
      send({ kind: 'error', runtimeId, id, code: 'extension_result_too_large', message: 'extension result is too large', status: 500 })
      return
    }
    send({ kind: 'result', runtimeId, id, bytes })
  } catch (error) {
    errorReply(error)
  } finally {
    requestControllers.delete(id)
    generationController.signal.removeEventListener('abort', onGenerationAbort)
  }
}
