/**
 * Message protocol for opt-in extension worker
 * execution mode. This module is imported by BOTH the parent supervisor and
 * the worker runtime, so it must stay pure: types and dependency-free helpers
 * only — no Cordis, no node:worker_threads.
 */

/** Upper bound for a per-operation `timeoutMs` override (mirrors extensions.ts). */
export const WORKER_OPERATION_TIMEOUT_MAX_MS = 300_000

/** Ceiling for one serialized action result, enforced worker-side. */
export const WORKER_RESULT_MAX_BYTES = 4 * 1024 * 1024
/** HTTP response metadata crossing threads stays within the ordinary HTTP header budget. */
export const WORKER_RESPONSE_METADATA_MAX_BYTES = 16 * 1024

/** Per-stream credit window: the worker may send at most this many unacknowledged bytes. */
export const WORKER_STREAM_CREDIT_BYTES = 256 * 1024

/** The worker splits source chunks larger than this before credit control. */
export const WORKER_STREAM_MAX_CHUNK_BYTES = 64 * 1024

/** Per-worker aggregate bound: total unacknowledged bytes across ALL streams. */
export const WORKER_STREAM_AGGREGATE_BYTES = 1024 * 1024

/** Logger-adapter budget per time window: bursts are allowed, silence is not permanent. */
export const WORKER_LOG_WINDOW_MS = 1_000

/** If a cancelled stream is not ended by the worker within this grace, the supervisor terminates it. */
export const WORKER_STREAM_CANCEL_GRACE_MS = 1_000

/** Default budget for one worker action when the action sets no override. */
export const WORKER_OPERATION_TIMEOUT_MS = 30_000

/** After a deadline-detached action fails to settle within this grace, the worker is terminated. */
export const WORKER_DEADLINE_GRACE_MS = 250

/** Parent → worker: activate one extension generation inside this runtime. */
export interface WorkerActivateMessage {
  readonly kind: 'activate'
  readonly id: string
  readonly hostFile: string
  readonly generation: string
  /** Full manifest so `api.manifest` matches the in-process contract. */
  readonly manifest: WorkerActivationManifest
}

/** Manifest shape crossing the boundary (structural, Cordis-free). */
export interface WorkerActivationManifest {
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description?: string
}

/** Parent → worker: run one action; reply with worker-serialized bytes. */
export interface WorkerInvokeMessage {
  readonly kind: 'invoke'
  readonly id: string
  readonly action: string
  readonly deviceId: string
  readonly input: unknown
}

/** Parent → worker: the caller detached; stop the identified operation. */
export interface WorkerCancelMessage {
  readonly kind: 'cancel'
  readonly id: string
}

/** Parent → worker: run generation teardown inside the runtime. */
export interface WorkerDisposeMessage {
  readonly kind: 'dispose'
  readonly id: string
}

/** Parent → worker: run one route handler; the body crosses as bytes. */
export interface WorkerRouteMessage {
  readonly kind: 'route'
  readonly id: string
  readonly routeIndex: number
  readonly method: string
  readonly path: string
  readonly query: readonly (readonly [string, string])[]
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly deviceId: string
}

/** Parent → worker: the consumer took this many streamed bytes; grant credit. */
export interface WorkerStreamAckMessage {
  readonly kind: 'stream-ack'
  readonly id: string
  readonly bytes: number
}

/** Parent → worker: the consumer is gone; stop this stream. */
export interface WorkerStreamCancelMessage {
  readonly kind: 'stream-cancel'
  readonly id: string
}

export type ParentMessage = WorkerActivateMessage | WorkerInvokeMessage | WorkerCancelMessage | WorkerDisposeMessage | WorkerRouteMessage | WorkerStreamAckMessage | WorkerStreamCancelMessage

/** Metadata for one action, crossing the boundary without its functions. */
export interface WorkerActionMetadata {
  readonly name: string
  readonly timeoutMs?: number
}

/** Metadata for one route, crossing the boundary without its functions. */
export interface WorkerRouteMetadata {
  readonly method: string
  readonly path: string
  readonly kind?: 'exact' | 'prefix'
  readonly timeoutMs?: number
}

/** Worker → parent: activation finished; registration crossed as metadata only. */
export interface WorkerActivatedMessage {
  readonly kind: 'activated'
  readonly runtimeId: string
  readonly actions: readonly WorkerActionMetadata[]
  readonly routes: readonly WorkerRouteMetadata[]
}

/** Worker → parent: an action produced size-checked JSON bytes. */
export interface WorkerResultMessage {
  readonly kind: 'result'
  readonly runtimeId: string
  readonly id: string
  readonly bytes: Uint8Array
}

/** Worker → parent: an operation failed with a controlled business error. */
export interface WorkerErrorMessage {
  readonly kind: 'error'
  readonly runtimeId: string
  readonly id: string
  readonly code: string
  readonly message: string
  readonly status: number
}

/** Worker → parent: bounded logger-adapter traffic. */
export interface WorkerLogMessage {
  readonly kind: 'log'
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly args: readonly unknown[]
}

/** Worker → parent: a route produced a complete buffered response as bytes. */
export interface WorkerRouteResponseMessage {
  readonly kind: 'route-response'
  readonly runtimeId: string
  readonly id: string
  readonly status?: number
  readonly contentType?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly bytes?: Uint8Array
}

/** Worker → parent: a route produced a stream; chunks follow under credit control. */
export interface WorkerStreamStartMessage {
  readonly kind: 'stream-start'
  readonly runtimeId: string
  readonly id: string
  readonly status?: number
  readonly contentType?: string
  readonly headers?: Readonly<Record<string, string>>
}

/** Worker → parent: one stream chunk, sent only while credit remains. */
export interface WorkerStreamChunkMessage {
  readonly kind: 'stream-chunk'
  readonly runtimeId: string
  readonly id: string
  readonly bytes: Uint8Array
}

/** Worker → parent: the stream finished normally. */
export interface WorkerStreamEndMessage {
  readonly kind: 'stream-end'
  readonly runtimeId: string
  readonly id: string
}

/** Worker → parent: the stream failed. */
export interface WorkerStreamErrorMessage {
  readonly kind: 'stream-error'
  readonly runtimeId: string
  readonly id: string
  readonly message: string
}

export type WorkerMessage = WorkerActivatedMessage | WorkerResultMessage | WorkerErrorMessage | WorkerLogMessage | WorkerRouteResponseMessage | WorkerStreamStartMessage | WorkerStreamChunkMessage | WorkerStreamEndMessage | WorkerStreamErrorMessage

/** Validate an optional per-operation timeout override against the same bounds as in-process. */
export function validOperationTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > WORKER_OPERATION_TIMEOUT_MAX_MS) return undefined
  return value
}

/** Normalize an extension route path exactly like the in-process registry. */
export function normalizeWorkerRoutePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.includes('?') || value.includes('#') || value.includes('\\') || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('invalid route path')
  const normalizedInput = value.startsWith('/') ? value : `/${value}`
  const parts = normalizedInput.split('/')
  if (parts.some(part => part === '..' || part === '.')) throw new Error('invalid route path')
  return normalizedInput === '/' ? '/' : normalizedInput.replace(/\/+$/u, '')
}

/**
 * Recognize a controlled business error (MobileExtensionError shape) thrown by
 * host code so its code/status survive the boundary instead of collapsing to
 * a generic 500. Pure duck-typing keeps the runtime Cordis-free.
 */
export function businessErrorShape(error: unknown): { readonly code: string; readonly message: string; readonly status: number } | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const candidate = error as { readonly code?: unknown; readonly message?: unknown; readonly status?: unknown }
  if (typeof candidate.code !== 'string' || candidate.code.length === 0 || candidate.code.length > 64) return undefined
  if (typeof candidate.message !== 'string' || candidate.message.length > 500) return undefined
  if (typeof candidate.status !== 'number' || !Number.isInteger(candidate.status) || candidate.status < 400 || candidate.status > 599) return undefined
  return { code: candidate.code, message: candidate.message, status: candidate.status }
}

/**
 * Serialize an action result to JSON bytes worker-side.
 *
 * Plain JSON.stringify, matching the in-process gateway contract exactly:
 * non-JSON-serializable values (e.g. BigInt) throw and surface as
 * `extension_failed`, same as in-process mode today.
 */
export function serializeWorkerResult(value: unknown): Uint8Array {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('extension result is not JSON serializable')
  return new TextEncoder().encode(serialized)
}
