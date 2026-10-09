import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { isIP } from './ip.js'
import { isLoopbackAddress, parseAuthority, parseCidr, type AuthoritySpec, type ParsedCidr } from './network.js'
import { normalizeWebSocketPaths } from './websocket-paths.js'
import { resolveHostExecution, type HostExecutionConfig, type ResolvedHostExecutionConfig } from './extension-worker-config.js'

/** Optional compression for exact, already authorized WebSocket paths. */
export interface WebSocketCompressionConfig {
  paths?: string[]
  maxMessageBytes?: number
  maxQueuedBytes?: number
  thresholdBytes?: number
  concurrencyLimit?: number
  level?: number
}

/** Validated compression settings; an empty path list keeps the raw transport. */
export interface ResolvedWebSocketCompressionConfig {
  readonly paths: readonly string[]
  readonly maxMessageBytes: number
  readonly maxQueuedBytes: number
  readonly thresholdBytes: number
  readonly concurrencyLimit: number
  readonly level: number
}

/** TLS source accepted by the LAN listener. */
export interface ProvidedTlsConfig {
  readonly mode: 'provided'
  /** PEM server leaf followed by any intermediate certificate chain. */
  readonly certFile: string
  readonly keyFile: string
  /** Optional PEM intermediates appended after the chain in `certFile`; roots are rejected. */
  readonly caFile?: string
}

/** HTTP is available only for an explicitly loopback-bound listener. */
export interface DisabledTlsConfig {
  readonly mode: 'disabled'
}

export type TlsConfig = ProvidedTlsConfig | DisabledTlsConfig

/** Operator-facing plugin configuration. */
export interface PluginConfig {
  /** Local host execution mode and owned worker budgets; defaults to in-process. */
  hostExecution?: HostExecutionConfig
  /** Optional setup JSON written by the packaged CLI. */
  setupFile?: string
  /** Preferred HTTPS origin used to derive the public authority and listener port. */
  publicOrigin?: string
  listenHost?: string
  listenPort?: number
  upstreamOrigin?: string
  publicAuthorities?: string[]
  allowedCidrs?: string[]
  stateFile: string
  /** Internal persisted on/off preference managed by the DSH plugin card. */
  controlFile: string
  /** Optional user stylesheet served to the authenticated mobile UI. */
  customCssFile?: string
  /** Optional user script that mounts authenticated mobile-only Web features. */
  customScriptFile?: string
  /** Internal dedicated mobile layout browser bundle. */
  mobileLayoutFile?: string
  /** Standalone browser compatibility bundle used before DSH boot. */
  mobileCompatibilityFile?: string
  /** Optional application-phase client package ids omitted only from the mobile boot graph. */
  excludedClientModules?: string[]
  /** Compression is opt-in; it does not authorize additional WebSocket paths. */
  websocketCompression?: WebSocketCompressionConfig
  /** Stable public discovery identifier; it is not an authentication secret. */
  instanceId?: string
  /** Managed CA certificate offered to the Android installer after fingerprint binding. */
  pairingCaFile?: string
  /** First-run state used only while the control file does not exist. */
  initiallyEnabled: boolean
  tls?: {
    mode?: 'provided' | 'disabled'
    certFile?: string
    keyFile?: string
    caFile?: string
  }
  pairingTtlMs?: number
  deviceTtlMs?: number
  sessionTtlMs?: number
  maxDevices?: number
  maxSessions?: number
  maxConnections?: number
  maxActiveRequests?: number
  maxWebSockets?: number
  maxBodyBytes?: number
  /** Transport, upload, static-response and WebSocket-handshake idle timeout. */
  upstreamTimeoutMs?: number
  /** Authenticated /api response idle timeout after upload; zero disables it. */
  upstreamApiTimeoutMs?: number
  rateLimitWindowMs?: number
  maxPairingAttempts?: number
  maxRateLimitKeys?: number
}

/** Resolved, validated security and resource limits. */
export interface ResolvedGatewayConfig {
  readonly hostExecution: ResolvedHostExecutionConfig
  readonly listenHost: string
  readonly listenPort: number
  readonly upstreamOrigin: URL
  readonly authorities: readonly AuthoritySpec[]
  readonly allowedCidrs: readonly ParsedCidr[]
  readonly stateFile: string
  /** Local extension root adjacent to the mobile-access state file. */
  readonly extensionsDir: string
  readonly customCssFile: string
  readonly customScriptFile: string
  readonly mobileLayoutFile: string
  readonly mobileCompatibilityFile: string
  readonly excludedClientModules: readonly string[]
  readonly websocketCompression: ResolvedWebSocketCompressionConfig
  readonly instanceId: string
  readonly pairingCaFile?: string
  readonly tls: TlsConfig
  /** Whether the public hop is HTTPS, even when a trusted loopback proxy terminates TLS. */
  readonly publicTls: boolean
  /** LAN discovery is disabled for private proxy listeners such as Funnel ingress. */
  readonly discovery: boolean
  readonly pairingTtlMs: number
  readonly deviceTtlMs: number
  readonly sessionTtlMs: number
  readonly maxDevices: number
  readonly maxSessions: number
  readonly maxConnections: number
  readonly maxActiveRequests: number
  readonly maxWebSockets: number
  readonly maxBodyBytes: number
  readonly upstreamTimeoutMs: number
  readonly upstreamApiTimeoutMs: number
  readonly rateLimitWindowMs: number
  readonly maxPairingAttempts: number
  readonly maxRateLimitKeys: number
}

/** Loader-facing defaults; {@link parseGatewayConfig} enforces cross-field security rules. */
export const Config: z<PluginConfig> = z.object({
  hostExecution: z.object({
    mode: z.union([z.const('in-process'), z.const('worker')]),
    // Omission selects every local host; an explicit empty array selects none.
    extensions: z.union([z.const(undefined), z.array(String)]),
    maxWorkers: z.natural(), maxRegistrations: z.natural(), maxOldGenerationSizeMb: z.natural(), maxYoungGenerationSizeMb: z.natural(), stackSizeMb: z.natural(),
    activationTimeoutMs: z.natural(), operationTimeoutMs: z.natural(), cancelGraceMs: z.natural(), streamCancelGraceMs: z.natural(), disposeGraceMs: z.natural(),
    resultMaxBytes: z.natural(), streamWindowBytes: z.natural(), streamChunkBytes: z.natural(), streamAggregateBytes: z.natural(),
    logWindowMs: z.natural(), logMessagesPerWindow: z.natural(), logMessageBytes: z.natural(),
  }) as z<HostExecutionConfig>,
  setupFile: z.string().hidden(),
  publicOrigin: z.string(),
  listenHost: z.string(),
  listenPort: z.natural().max(65535),
  upstreamOrigin: z.string(),
  publicAuthorities: z.array(String).default(undefined as unknown as string[]),
  allowedCidrs: z.array(String).default(undefined as unknown as string[]),
  stateFile: String,
  controlFile: z.string().hidden().required(),
  customCssFile: z.string().hidden(),
  customScriptFile: z.string().hidden(),
  mobileLayoutFile: z.string().hidden(),
  mobileCompatibilityFile: z.string().hidden(),
  excludedClientModules: z.array(String).default([]),
  websocketCompression: z.object({
    paths: z.array(String).default([]),
    maxMessageBytes: z.natural(),
    maxQueuedBytes: z.natural(),
    thresholdBytes: z.natural(),
    concurrencyLimit: z.natural(),
    level: z.natural().max(9),
  }),
  instanceId: z.string().hidden(),
  pairingCaFile: z.string().hidden(),
  initiallyEnabled: z.boolean().hidden().required(),
  tls: z.object({
    mode: z.union([z.const('provided'), z.const('disabled')]),
    certFile: z.string(),
    keyFile: z.string(),
    caFile: z.string(),
  }),
  pairingTtlMs: z.natural(),
  deviceTtlMs: z.natural(),
  sessionTtlMs: z.natural(),
  maxDevices: z.natural(),
  maxSessions: z.natural(),
  maxConnections: z.natural(),
  maxActiveRequests: z.natural(),
  maxWebSockets: z.natural(),
  maxBodyBytes: z.natural(),
  upstreamTimeoutMs: z.natural(),
  upstreamApiTimeoutMs: z.natural(),
  rateLimitWindowMs: z.natural(),
  maxPairingAttempts: z.natural(),
  maxRateLimitKeys: z.natural(),
})

function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new Error(`${name} must be an integer from ${String(minimum)} through ${String(maximum)}`)
  }
  return resolved
}

function parseWebSocketCompression(raw: unknown): ResolvedWebSocketCompressionConfig {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    throw new Error('websocketCompression must be an object')
  }
  const value = (raw ?? {}) as WebSocketCompressionConfig
  const maxMessageBytes = integer(value.maxMessageBytes, 'websocketCompression.maxMessageBytes', 32 * 1024 * 1024, 1024, 256 * 1024 * 1024)
  const maxQueuedBytes = integer(value.maxQueuedBytes, 'websocketCompression.maxQueuedBytes', 64 * 1024 * 1024, 1024, 256 * 1024 * 1024)
  if (maxQueuedBytes < maxMessageBytes + 14) throw new Error('websocketCompression.maxQueuedBytes must cover maxMessageBytes and the frame header')
  return Object.freeze({
    paths: Object.freeze(normalizeWebSocketPaths(value.paths ?? [])),
    maxMessageBytes,
    maxQueuedBytes,
    thresholdBytes: integer(value.thresholdBytes, 'websocketCompression.thresholdBytes', 1024, 0, maxMessageBytes),
    concurrencyLimit: integer(value.concurrencyLimit, 'websocketCompression.concurrencyLimit', 4, 1, 32),
    level: integer(value.level, 'websocketCompression.level', 3, 0, 9),
  })
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`${name} must be a non-empty string array`)
  }
  return value as string[]
}

function absoluteFile(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new Error(`${name} must be an absolute file path`)
  }
  return resolve(value)
}

function excludedClientModules(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || id.length === 0 || id.trim() !== id)) {
    throw new Error('excludedClientModules must be an array of exact, non-empty client module ids')
  }
  const ids = value as string[]
  if (new Set(ids).size !== ids.length) throw new Error('excludedClientModules must not contain duplicate ids')
  return Object.freeze([...ids])
}

/** Resolve the hidden runtime-control file independently from gateway configuration. */
export function parseControlFile(value: unknown): string {
  return absoluteFile(value, 'controlFile')
}

function parseUpstream(value: unknown): URL {
  const source = value ?? 'http://127.0.0.1:3080'
  if (typeof source !== 'string') throw new Error('upstreamOrigin must be a string')
  let url: URL
  try {
    url = new URL(source)
  } catch {
    throw new Error('upstreamOrigin must be an HTTP loopback origin')
  }
  if (url.protocol !== 'http:' || !isLoopbackAddress(url.hostname) || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.port === '') {
    throw new Error('upstreamOrigin must be an HTTP loopback origin with an explicit port and no path or credentials')
  }
  return url
}

function parsePublicOrigin(value: unknown): { readonly authority: AuthoritySpec; readonly port: number } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error('publicOrigin must be an HTTPS origin')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('publicOrigin must be an HTTPS origin')
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error('publicOrigin must be an HTTPS origin with no path or credentials')
  }
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') {
    throw new Error('publicOrigin must name a reachable host')
  }
  return Object.freeze({
    authority: parseAuthority(url.host),
    port: Number(url.port || '443'),
  })
}

function parseTls(value: PluginConfig['tls'], listenHost: string): TlsConfig {
  if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('tls must be an object')
  }
  const mode = value?.mode ?? 'provided'
  if (value?.mode === null || (mode !== 'provided' && mode !== 'disabled')) throw new Error('tls.mode must be provided or disabled')
  if (mode === 'disabled') {
    if (!isLoopbackAddress(listenHost)) throw new Error('TLS may be disabled only on an IP loopback listener')
    return Object.freeze({ mode })
  }
  return Object.freeze({
    mode,
    certFile: absoluteFile(value?.certFile, 'tls.certFile'),
    keyFile: absoluteFile(value?.keyFile, 'tls.keyFile'),
    ...(value?.caFile === undefined ? {} : { caFile: absoluteFile(value.caFile, 'tls.caFile') }),
  })
}

/** Parse configuration and reject unsafe topology, credential, and resource combinations. */
export function parseGatewayConfig(raw: unknown): ResolvedGatewayConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('mobile-access config must be an object')
  const value = raw as PluginConfig
  const publicOrigin = parsePublicOrigin(value.publicOrigin)
  if (publicOrigin !== undefined && value.listenPort !== undefined) {
    throw new Error('publicOrigin cannot be combined with listenPort')
  }
  if (publicOrigin !== undefined && value.publicAuthorities !== undefined) {
    throw new Error('publicOrigin cannot be combined with publicAuthorities')
  }
  const listenHost = value.listenHost ?? (publicOrigin === undefined ? '127.0.0.1' : '0.0.0.0')
  if (isIP(listenHost) === 0) throw new Error('listenHost must be an IP literal')
  const listenPort = publicOrigin?.port ?? integer(value.listenPort, 'listenPort', 3443, 0, 65535)
  const upstreamOrigin = parseUpstream(value.upstreamOrigin)
  const tls = parseTls(value.tls, listenHost)
  if (publicOrigin !== undefined && tls.mode !== 'provided') {
    throw new Error('publicOrigin requires TLS')
  }

  let authorities: AuthoritySpec[]
  if (publicOrigin !== undefined) {
    authorities = [publicOrigin.authority]
  } else {
    let authoritySources = value.publicAuthorities
    if (authoritySources === undefined || authoritySources.length === 0) {
      if (!isLoopbackAddress(listenHost)) throw new Error('publicAuthorities is required for a non-loopback listener')
      authoritySources = [listenHost]
    }
    authorities = authoritySources.map(parseAuthority)
  }
  for (const authority of authorities) {
    if (listenPort === 0 && authority.port !== undefined) {
      throw new Error('explicit public authority ports require a non-zero listenPort')
    }
    if (authority.port !== undefined && listenPort !== 0 && authority.port !== listenPort) {
      throw new Error('every explicit public authority port must equal listenPort')
    }
  }
  if (new Set(authorities.map(entry => `${entry.hostname}:${String(entry.port ?? listenPort)}`)).size !== authorities.length) {
    throw new Error('publicAuthorities must not contain duplicates')
  }

  const cidrSources = value.allowedCidrs
    ?? (isLoopbackAddress(listenHost) ? ['127.0.0.0/8', '::1/128'] : undefined)
  const allowedCidrs = stringArray(cidrSources, 'allowedCidrs').map(parseCidr)
  if (new Set(allowedCidrs.map(entry => `${String(entry.bits)}:${entry.network.toString(16)}:${String(entry.prefix)}`)).size !== allowedCidrs.length) {
    throw new Error('allowedCidrs must not contain duplicates')
  }
  const deviceTtlMs = integer(value.deviceTtlMs, 'deviceTtlMs', 90 * 24 * 60 * 60_000, 60_000, 366 * 24 * 60 * 60_000)
  const sessionTtlMs = integer(value.sessionTtlMs, 'sessionTtlMs', 8 * 60 * 60_000, 30_000, 24 * 60 * 60_000)
  if (sessionTtlMs > deviceTtlMs) throw new Error('sessionTtlMs must not exceed deviceTtlMs')

  return Object.freeze({
    listenHost,
    hostExecution: resolveHostExecution(value.hostExecution),
    listenPort,
    upstreamOrigin,
    authorities: Object.freeze(authorities),
    allowedCidrs: Object.freeze(allowedCidrs),
    stateFile: absoluteFile(value.stateFile, 'stateFile'),
    extensionsDir: join(dirname(absoluteFile(value.stateFile, 'stateFile')), 'extensions'),
    customCssFile: value.customCssFile === undefined
      ? join(dirname(absoluteFile(value.stateFile, 'stateFile')), 'mobile.css')
      : absoluteFile(value.customCssFile, 'customCssFile'),
    customScriptFile: value.customScriptFile === undefined
      ? join(dirname(absoluteFile(value.stateFile, 'stateFile')), 'mobile.js')
      : absoluteFile(value.customScriptFile, 'customScriptFile'),
    mobileLayoutFile: value.mobileLayoutFile === undefined
      ? fileURLToPath(new URL('./mobile-layout.js', import.meta.url))
      : absoluteFile(value.mobileLayoutFile, 'mobileLayoutFile'),
    mobileCompatibilityFile: value.mobileCompatibilityFile === undefined
      ? fileURLToPath(new URL('./mobile-compat.js', import.meta.url))
      : absoluteFile(value.mobileCompatibilityFile, 'mobileCompatibilityFile'),
    excludedClientModules: excludedClientModules(value.excludedClientModules),
    websocketCompression: parseWebSocketCompression(value.websocketCompression),
    instanceId: value.instanceId === undefined
      ? createHash('sha256').update(absoluteFile(value.stateFile, 'stateFile')).digest('hex')
      : /^[a-f\d]{64}$/u.test(value.instanceId)
        ? value.instanceId
        : (() => { throw new Error('instanceId must be a lowercase SHA-256 value') })(),
    ...(value.pairingCaFile === undefined ? {} : { pairingCaFile: absoluteFile(value.pairingCaFile, 'pairingCaFile') }),
    tls,
    publicTls: tls.mode === 'provided',
    discovery: true,
    pairingTtlMs: integer(value.pairingTtlMs, 'pairingTtlMs', 120_000, 10_000, 600_000),
    deviceTtlMs,
    sessionTtlMs,
    maxDevices: integer(value.maxDevices, 'maxDevices', 32, 1, 256),
    maxSessions: integer(value.maxSessions, 'maxSessions', 64, 1, 1024),
    maxConnections: integer(value.maxConnections, 'maxConnections', 64, 1, 1024),
    maxActiveRequests: integer(value.maxActiveRequests, 'maxActiveRequests', 32, 1, 1024),
    maxWebSockets: integer(value.maxWebSockets, 'maxWebSockets', 16, 1, 256),
    maxBodyBytes: integer(value.maxBodyBytes, 'maxBodyBytes', 160 * 1024 * 1024, 1024, 256 * 1024 * 1024),
    upstreamTimeoutMs: integer(value.upstreamTimeoutMs, 'upstreamTimeoutMs', 30_000, 1_000, 300_000),
    upstreamApiTimeoutMs: integer(value.upstreamApiTimeoutMs, 'upstreamApiTimeoutMs', 0, 0, 2_147_483_647),
    rateLimitWindowMs: integer(value.rateLimitWindowMs, 'rateLimitWindowMs', 60_000, 1_000, 3_600_000),
    maxPairingAttempts: integer(value.maxPairingAttempts, 'maxPairingAttempts', 8, 1, 100),
    maxRateLimitKeys: integer(value.maxRateLimitKeys, 'maxRateLimitKeys', 256, 1, 4096),
  })
}
