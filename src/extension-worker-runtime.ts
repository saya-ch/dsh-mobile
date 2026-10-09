/**
 * Spike (Phase 2 de-risking): worker-side runtime for local extension hosts.
 *
 * This file is a standalone tsdown entry (lib/extension-worker-runtime.mjs).
 * It executes ALL host behavior inside the worker thread — module import,
 * activation, input validation, actions, effects and cleanup — and answers the
 * parent with metadata and pre-serialized bytes only. It must never import
 * Cordis or any DSH service.
 */
import { parentPort } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import z from '@deepseek-ai/schemastery'
import {
  businessErrorShape,
  normalizeWorkerRoutePath,
  serializeWorkerResult,
  validOperationTimeout,
  WORKER_LOG_WINDOW_MS,
  WORKER_RESULT_MAX_BYTES,
  WORKER_STREAM_AGGREGATE_BYTES,
  WORKER_STREAM_CREDIT_BYTES,
  WORKER_STREAM_MAX_CHUNK_BYTES,
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

/** Logger-adapter burst budget per time window; the budget resets each window. */
const LOG_QUEUE_LIMIT = 64

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
const LOG_ARG_MAX_CHARS = 4_096

/** Render a log argument that structured cloning cannot carry (or that is huge). */
function sanitizeLogArg(value: unknown): unknown {
  if (typeof value === 'function' || typeof value === 'symbol') return `[${typeof value}]`
  if (typeof value === 'string' && value.length > LOG_ARG_MAX_CHARS) {
    return `${value.slice(0, LOG_ARG_MAX_CHARS)}…(+${value.length - LOG_ARG_MAX_CHARS} chars)`
  }
  return value
}

function log(level: 'debug' | 'info' | 'warn' | 'error', args: readonly unknown[]): void {
  const now = Date.now()
  if (now - logWindowStartedAt >= WORKER_LOG_WINDOW_MS) {
    logWindowStartedAt = now
    logWindowCount = 0
  }
  if (logWindowCount >= LOG_QUEUE_LIMIT) return
  logWindowCount += 1
  try {
    // Logging must never fail the host's calling code: clone-unsafe values are
    // rendered, oversized strings are truncated, and a postMessage failure
    // (deep non-cloneable objects) is swallowed.
    send({ kind: 'log', level, args: args.map(sanitizeLogArg) })
  } catch { /* dropped */ }
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

/** Resolvers waiting for send budget (window credit or aggregate headroom). */
let sendBudgetWaiters: (() => void)[] = []

/** Bytes sent but not yet acknowledged, across all live streams. */
function inFlightTotal(): number {
  let total = 0
  for (const [id, sent] of streamSent) total += sent - (streamAcked.get(id) ?? 0)
  return total
}

function wakeSendBudgetWaiters(): void {
  for (const wake of sendBudgetWaiters) wake()
  sendBudgetWaiters = []
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
  if (inFlightTotal() + length > WORKER_STREAM_AGGREGATE_BYTES) return false
  streamCredit.set(id, credit - length)
  streamSent.set(id, (streamSent.get(id) ?? 0) + length)
  return true
}

/**
 * Grant freed aggregate headroom to starved streams (oldest first): each may
 * receive up to one max chunk, bounded by its remaining window. Without this,
 * a stream that opened while the aggregate was exhausted (initial credit 0)
 * could never send, because only its own acknowledgments replenish it.
 */
function redistributeAggregate(): void {
  let headroom = WORKER_STREAM_AGGREGATE_BYTES - inFlightTotal()
  if (headroom <= 0) return
  for (const id of streamCredit.keys()) {
    const credit = streamCredit.get(id) ?? 0
    if (credit >= WORKER_STREAM_MAX_CHUNK_BYTES) continue
    const ownInFlight = (streamSent.get(id) ?? 0) - (streamAcked.get(id) ?? 0)
    const windowHeadroom = WORKER_STREAM_CREDIT_BYTES - ownInFlight - credit
    const grant = Math.min(headroom, WORKER_STREAM_MAX_CHUNK_BYTES - credit, windowHeadroom)
    if (grant <= 0) continue
    streamCredit.set(id, credit + grant)
    headroom -= grant
    if (headroom <= 0) break
  }
  wakeSendBudgetWaiters()
}

/** Wait until a piece may be sent; resolves false when the caller bailed. */
async function acquireSendBudget(id: string, length: number, bail: () => boolean): Promise<boolean> {
  while (!tryReserve(id, length)) {
    if (bail()) return false
    await new Promise<void>(resolve => { sendBudgetWaiters.push(resolve) })
  }
  return true
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
    streamAcked.set(message.id, (streamAcked.get(message.id) ?? 0) + message.bytes)
    streamCredit.set(message.id, (streamCredit.get(message.id) ?? 0) + message.bytes)
    // Freed aggregate headroom may unblock streams that opened starved.
    redistributeAggregate()
    wakeSendBudgetWaiters()
    return
  }
  if (message.kind === 'stream-cancel') {
    const source = activeSources.get(message.id)
    source?.destroy()
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
    await Promise.race([Promise.allSettled(pending), new Promise(resolve => { setTimeout(resolve, 2_000).unref?.() })])
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
    if (response === null || typeof response !== 'object' || typeof (response as { body?: unknown }).body !== 'string' && !((response as { body?: unknown }).body instanceof Uint8Array) && !isStream((response as { body?: unknown }).body)) {
      send({ kind: 'error', runtimeId, id: message.id, code: 'invalid_route_response', message: 'extension returned an invalid response', status: 500 })
      return
    }
    const meta = response as { status?: number; contentType?: string; headers?: Record<string, string>; body: string | Uint8Array | import('node:stream').Readable }
    if (isStream(meta.body)) {
      await pumpStream(message.id, meta.body, meta)
      return
    }
    const bytes = typeof meta.body === 'string' ? new TextEncoder().encode(meta.body) : new Uint8Array(meta.body)
    if (bytes.byteLength > WORKER_RESULT_MAX_BYTES) {
      send({ kind: 'error', runtimeId, id: message.id, code: 'extension_result_too_large', message: 'extension response is too large', status: 500 })
      return
    }
    send({
      kind: 'route-response', runtimeId, id: message.id,
      ...(meta.status === undefined ? {} : { status: meta.status }),
      ...(meta.contentType === undefined ? {} : { contentType: meta.contentType }),
      ...(meta.headers === undefined ? {} : { headers: meta.headers }),
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
  streamCredit.set(id, Math.max(0, Math.min(WORKER_STREAM_CREDIT_BYTES, WORKER_STREAM_AGGREGATE_BYTES - inFlightTotal())))
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
    streamSent.delete(id)
    streamAcked.delete(id)
    // Freed aggregate budget may unblock other streams.
    redistributeAggregate()
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
        const piece = bytes.subarray(offset, Math.min(offset + WORKER_STREAM_MAX_CHUNK_BYTES, bytes.byteLength))
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
  } catch {
    if (ended) return
    finish()
    send({ kind: 'stream-end', runtimeId, id })
  }
}

async function activate(replyId: string, hostFile: string, generation: string, manifest: import('./extension-worker-protocol.js').WorkerActivationManifest): Promise<void> {
  // Async effect setups gate activation exactly like the in-process path: a
  // rejection fails activation instead of vanishing.
  const pendingEffects: Promise<void>[] = []
  const api: RuntimeHostApi = {
    manifest,
    context: { logger: loggerAdapter },
    schema: z,
    signal: generationController.signal,
    action(name, spec) {
      if (typeof spec?.run !== 'function') throw new Error(`invalid action ${name}`)
      if (actions.has(name)) throw new Error(`duplicate action ${name}`)
      actions.set(name, spec)
    },
    route(spec) {
      if (typeof spec?.handle !== 'function') throw new Error('invalid route')
      routes.push(spec)
    },
    effect(setup) {
      const result = setup()
      if (result instanceof Promise) {
        pendingEffects.push(result.then(cleanup => { if (typeof cleanup === 'function') cleanups.push(cleanup) }))
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
    send({ kind: 'error', runtimeId, id: replyId, code: 'host_activation_failed', message: boundedMessage(error), status: 500 })
    return
  }
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
        parsed = typeof spec.input === 'function' ? spec.input(input) : spec.input.parse(input)
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
    if (bytes.byteLength > WORKER_RESULT_MAX_BYTES) {
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
