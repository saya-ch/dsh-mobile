/** Operator-owned limits for opt-in local extension worker execution. */
export interface HostExecutionConfig {
  readonly mode?: 'in-process' | 'worker'
  /** Apply worker mode only to these exact local ids; omitted selects every local host. */
  readonly extensions?: readonly string[] | undefined
  readonly maxWorkers?: number
  readonly maxRegistrations?: number
  readonly maxOldGenerationSizeMb?: number
  readonly maxYoungGenerationSizeMb?: number
  readonly stackSizeMb?: number
  readonly activationTimeoutMs?: number
  readonly operationTimeoutMs?: number
  readonly cancelGraceMs?: number
  readonly streamCancelGraceMs?: number
  readonly disposeGraceMs?: number
  readonly resultMaxBytes?: number
  readonly streamWindowBytes?: number
  readonly streamChunkBytes?: number
  readonly streamAggregateBytes?: number
  readonly logWindowMs?: number
  readonly logMessagesPerWindow?: number
  readonly logMessageBytes?: number
}

/** Complete settings passed to each owned worker; Node limits do not isolate filesystem access. */
export interface ResolvedHostExecutionConfig extends Required<Omit<HostExecutionConfig, 'extensions'>> {
  readonly extensions: readonly string[] | undefined
}

function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`hostExecution.${name} must be an integer from ${minimum} through ${maximum}`)
  }
  return resolved
}

/** Resolve configuration once; reject malformed modes, ids and incoherent stream windows. */
export function resolveHostExecution(raw: unknown): ResolvedHostExecutionConfig {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) throw new Error('hostExecution must be an object')
  const value = (raw ?? {}) as HostExecutionConfig
  const mode = value.mode ?? 'in-process'
  if (mode !== 'worker' && mode !== 'in-process') throw new Error('hostExecution.mode is invalid')
  if (value.extensions !== undefined && (!Array.isArray(value.extensions) || value.extensions.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(id)) || new Set(value.extensions).size !== value.extensions.length)) throw new Error('hostExecution.extensions must contain unique local extension ids')
  const streamWindowBytes = integer(value.streamWindowBytes, 'streamWindowBytes', 256 * 1024, 1024, 4 * 1024 * 1024)
  const streamChunkBytes = integer(value.streamChunkBytes, 'streamChunkBytes', 64 * 1024, 1024, streamWindowBytes)
  const streamAggregateBytes = integer(value.streamAggregateBytes, 'streamAggregateBytes', 1024 * 1024, streamWindowBytes, 32 * 1024 * 1024)
  return Object.freeze({
    mode, extensions: value.extensions === undefined ? undefined : Object.freeze([...value.extensions]),
    maxWorkers: integer(value.maxWorkers, 'maxWorkers', 8, 1, 128),
    maxRegistrations: integer(value.maxRegistrations, 'maxRegistrations', 256, 1, 4096),
    maxOldGenerationSizeMb: integer(value.maxOldGenerationSizeMb, 'maxOldGenerationSizeMb', 128, 16, 4096),
    maxYoungGenerationSizeMb: integer(value.maxYoungGenerationSizeMb, 'maxYoungGenerationSizeMb', 16, 1, 512),
    stackSizeMb: integer(value.stackSizeMb, 'stackSizeMb', 4, 1, 64),
    activationTimeoutMs: integer(value.activationTimeoutMs, 'activationTimeoutMs', 5000, 1, 300_000),
    operationTimeoutMs: integer(value.operationTimeoutMs, 'operationTimeoutMs', 30_000, 1, 300_000),
    cancelGraceMs: integer(value.cancelGraceMs, 'cancelGraceMs', 250, 1, 30_000),
    streamCancelGraceMs: integer(value.streamCancelGraceMs, 'streamCancelGraceMs', 1000, 1, 30_000),
    disposeGraceMs: integer(value.disposeGraceMs, 'disposeGraceMs', 2000, 1, 30_000),
    resultMaxBytes: integer(value.resultMaxBytes, 'resultMaxBytes', 4 * 1024 * 1024, 1024, 4 * 1024 * 1024),
    streamWindowBytes, streamChunkBytes, streamAggregateBytes,
    logWindowMs: integer(value.logWindowMs, 'logWindowMs', 1000, 1, 60_000),
    logMessagesPerWindow: integer(value.logMessagesPerWindow, 'logMessagesPerWindow', 64, 1, 1024),
    logMessageBytes: integer(value.logMessageBytes, 'logMessageBytes', 4096, 128, 64 * 1024),
  })
}
