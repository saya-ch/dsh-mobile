/**
 * Narrow stale-while-revalidate cache for the two model-catalog RPCs.
 *
 * Pure policy module: eligibility, envelope validation, per-caller rpcId
 * restamping, generation-aware single-flight fills, TTL intervals, admission
 * and resident bounds. All I/O is injected; no Node HTTP imports here. The
 * gateway owns sockets, headers, status codes, compression and the ordinary
 * per-caller fallback path.
 */

/** The two cacheable, parameterless, host-global catalog reads. */
export type CatalogMethod =
  | 'llm/listProviders'
  | 'session/modelCatalog'

export interface CatalogCacheLimits {
  readonly freshMs: number
  readonly staleMs: number
  readonly maxEntries: number
  readonly maxEntryBytes: number
  readonly maxTotalBytes: number
  readonly maxInFlightFills: number
}

/** Host RPCs whose successful completion can change catalog results. */
export const CATALOG_MUTATION_METHODS: ReadonlySet<string> = new Set([
  'account/signOut',
  'account/startSignIn',
  'credentials/set',
  'credentials/unset',
  'pluginManager/installBundle',
  'pluginManager/removeBundle',
  'pluginManager/setBundleEnabled',
  'pluginManager/setPluginEnabled',
  'pluginManager/setVersionExemption',
  'pluginManager/updateBundle',
  'session/initializeDefaultModel',
  'session/selectModel',
  'settings/mutate',
  'settings/replace',
  'settings/update',
])

export const CATALOG_CACHE_METHODS: ReadonlySet<string> = new Set<CatalogMethod>([
  'llm/listProviders',
  'session/modelCatalog',
])

export const DEFAULT_CATALOG_CACHE_LIMITS: Readonly<CatalogCacheLimits> = Object.freeze({
  freshMs: 5_000,
  staleMs: 60_000,
  maxEntries: 4,
  maxEntryBytes: 2_097_152,
  maxTotalBytes: 8_388_608,
  maxInFlightFills: 2,
})

/** Identity + invalidation epoch identifying one cache generation. */
export type CatalogGeneration = Readonly<{
  identityDigest: string
  epoch: number
}>

/** A completed gateway-owned fill: shareable validated JSON, or nothing. */
export type CatalogFillOutcome =
  | {
      readonly shareable: true
      readonly envelopeJson: string
      readonly upstreamRpcId: string
    }
  | { readonly shareable: false }

/** A replayable cached response body serialized for one caller. */
export type CatalogReplayResult = Readonly<{
  readonly kind: 'hit' | 'stale' | 'replay'
  readonly body: string
  readonly generation: CatalogGeneration
  readonly validUntil: number
}>

export type CatalogServeResult =
  | CatalogReplayResult
  | { readonly kind: 'passthrough' }

const REQUEST_KEYS: ReadonlySet<string> = new Set(['type', 'rpcId', 'method', 'payload'])
const RESPONSE_KEYS: ReadonlySet<string> = new Set(['type', 'rpcId', 'result'])
const encoder = new TextEncoder()

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const hasExactKeys = (value: Record<string, unknown>, keys: ReadonlySet<string>): boolean => {
  const present = Object.keys(value)
  if (present.length !== keys.size) return false
  for (const key of present) if (!keys.has(key)) return false
  return true
}

/**
 * Validate one catalog request against the captured wire contract.
 * @param routeMethod - The `/api/<method>` route segment.
 * @param bodyJson - The exact buffered request body.
 * @returns The eligible method and its live rpcId, or undefined for anything else.
 */
export function checkCatalogRequest(
  routeMethod: string,
  bodyJson: string,
): Readonly<{ method: CatalogMethod; rpcId: string }> | undefined {
  if (!CATALOG_CACHE_METHODS.has(routeMethod)) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyJson)
  } catch {
    return undefined
  }
  if (!isObject(parsed) || !hasExactKeys(parsed, REQUEST_KEYS)) return undefined
  if (parsed.type !== 'client-request') return undefined
  if (parsed.method !== routeMethod) return undefined
  if (typeof parsed.rpcId !== 'string' || parsed.rpcId.length === 0 || parsed.rpcId.length > 512) return undefined
  const payload = parsed.payload
  if (!isObject(payload) || !hasExactKeys(payload, new Set(['args']))) return undefined
  const args = payload.args
  if (!isObject(args) || Array.isArray(args) || Object.keys(args).length !== 0) return undefined
  return { method: routeMethod as CatalogMethod, rpcId: parsed.rpcId }
}

/**
 * Validate a fill response against the captured success schema.
 * @param envelopeJson - The buffered upstream response body.
 * @param expectedRpcId - The gateway-generated rpcId the fill sent.
 * @returns Whether the envelope is the shareable success variant for that id.
 */
export function validateCatalogEnvelope(envelopeJson: string, expectedRpcId: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(envelopeJson)
  } catch {
    return false
  }
  if (!isObject(parsed) || !hasExactKeys(parsed, RESPONSE_KEYS)) return false
  if (parsed.type !== 'server-response') return false
  if (parsed.rpcId !== expectedRpcId) return false
  const result = parsed.result
  if (!isObject(result)) return false
  return result.ok === true && 'value' in result
}

/**
 * Re-stamp a validated envelope for one caller.
 * @param envelopeJson - The cached upstream envelope.
 * @param expectedRpcId - The fill rpcId the envelope must carry.
 * @param liveRpcId - The caller's rpcId to serialize into the response.
 * @returns The per-caller JSON body, or undefined when validation fails.
 */
export function restampEnvelope(envelopeJson: string, expectedRpcId: string, liveRpcId: string): string | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(envelopeJson)
  } catch {
    return undefined
  }
  if (!validateCatalogEnvelope(envelopeJson, expectedRpcId)) return undefined
  const body = parsed as { type: string; rpcId: string; result: unknown }
  body.rpcId = liveRpcId
  return JSON.stringify(body)
}

interface CacheEntry {
  readonly identityDigest: string
  readonly method: CatalogMethod
  readonly envelopeJson: string
  readonly upstreamRpcId: string
  readonly completedAt: number
  readonly validUntil: number
  readonly bytes: number
  lastServedAt: number
}

interface FillFlight {
  readonly generation: CatalogGeneration
  readonly method: CatalogMethod
  readonly promise: Promise<CatalogFillOutcome>
  settled: boolean
}

/**
 * Generation-aware SWR cache over the injected fill transport.
 * @typeParam TUpstreamSnapshot - Opaque immutable upstream identity snapshot the gateway captures per request.
 */
export class CatalogCache<TUpstreamSnapshot> {
  readonly #limits: CatalogCacheLimits
  readonly #clock: () => number
  readonly #fetchFill: (input: Readonly<{
    method: CatalogMethod
    generation: CatalogGeneration
    upstream: TUpstreamSnapshot
  }>) => Promise<CatalogFillOutcome>
  readonly #entries = new Map<string, CacheEntry>()
  readonly #flights = new Map<string, FillFlight>()
  #identityDigest: string | undefined
  #epoch = 0
  #disposed = false

  constructor(deps: {
    fetchFill(input: Readonly<{ method: CatalogMethod; generation: CatalogGeneration; upstream: TUpstreamSnapshot }>): Promise<CatalogFillOutcome>
    clock(): number
    limits?: Partial<CatalogCacheLimits>
  }) {
    this.#fetchFill = deps.fetchFill
    this.#clock = deps.clock
    this.#limits = { ...DEFAULT_CATALOG_CACHE_LIMITS, ...deps.limits }
  }

  get entryCount(): number {
    return this.#entries.size
  }

  get residentBytes(): number {
    let total = 0
    for (const entry of this.#entries.values()) total += entry.bytes
    return total
  }

  get inFlightFills(): number {
    let active = 0
    for (const flight of this.#flights.values()) if (!flight.settled) active += 1
    return active
  }

  /**
   * Serve one eligible request from the current generation.
   * @param input - Method, caller rpcId, current identity digest and its snapshot.
   * @returns A per-caller replay, or passthrough when the ordinary path must run.
   */
  async serve(input: Readonly<{
    method: string
    rpcId: string
    identityDigest: string
    upstream: TUpstreamSnapshot
  }>): Promise<CatalogServeResult> {
    if (this.#disposed) return { kind: 'passthrough' }
    if (!CATALOG_CACHE_METHODS.has(input.method)) return { kind: 'passthrough' }
    const method = input.method as CatalogMethod
    this.#syncIdentity(input.identityDigest)
    const generation = this.#currentGeneration()
    const key = `${input.identityDigest}\u0000${method}`
    const entry = this.#entries.get(key)
    if (entry !== undefined) {
      const age = this.#clock() - entry.completedAt
      if (age < this.#limits.freshMs) {
        entry.lastServedAt = this.#clock()
        const body = restampEnvelope(entry.envelopeJson, entry.upstreamRpcId, input.rpcId)
        if (body !== undefined) return { kind: 'hit', body, generation, validUntil: entry.validUntil }
      } else if (age < this.#limits.staleMs) {
        entry.lastServedAt = this.#clock()
        const body = restampEnvelope(entry.envelopeJson, entry.upstreamRpcId, input.rpcId)
        if (body !== undefined) {
          this.#startBackgroundFill(method, input.identityDigest, input.upstream)
          return { kind: 'stale', body, generation, validUntil: entry.validUntil }
        }
      }
    }
    const flightKey = `${input.identityDigest}|${generation.epoch}|${method}`
    const existing = this.#flights.get(flightKey)
    if (existing === undefined && this.inFlightFills >= this.#limits.maxInFlightFills) {
      return { kind: 'passthrough' }
    }
    const flight = existing ?? this.#createFlight(method, generation, input.upstream)
    const outcome = await flight.promise
    if (!outcome.shareable) return { kind: 'passthrough' }
    if (!this.#isCurrent(generation)) return { kind: 'passthrough' }
    if (!validateCatalogEnvelope(outcome.envelopeJson, outcome.upstreamRpcId)) return { kind: 'passthrough' }
    const body = restampEnvelope(outcome.envelopeJson, outcome.upstreamRpcId, input.rpcId)
    if (body === undefined) return { kind: 'passthrough' }
    return { kind: 'replay', body, generation, validUntil: this.#clock() + this.#limits.staleMs }
  }

  /** Record the current upstream identity; a change clears entries and bumps the epoch. */
  noteIdentity(identityDigest: string): void {
    this.#syncIdentity(identityDigest)
  }

  /** Invalidate every entry after a catalog-affecting mutation. */
  noteCatalogMutation(): void {
    this.#epoch += 1
    this.#entries.clear()
  }

  /** Whether a generation is still the current one. */
  isCurrent(generation: CatalogGeneration): boolean {
    return this.#isCurrent(generation)
  }

  /** Final pre-commit check for a replay result: generation, disposal and age. */
  canCommit(result: CatalogReplayResult): boolean {
    if (this.#disposed) return false
    if (!this.#isCurrent(result.generation)) return false
    return this.#clock() < result.validUntil
  }

  /** Invalidate everything and refuse new fills or publication. */
  dispose(): void {
    this.#disposed = true
    this.#entries.clear()
  }

  #isCurrent(generation: CatalogGeneration): boolean {
    if (this.#disposed) return false
    return generation.identityDigest === this.#identityDigest && generation.epoch === this.#epoch
  }

  #currentGeneration(): CatalogGeneration {
    return { identityDigest: this.#identityDigest as string, epoch: this.#epoch }
  }

  #syncIdentity(identityDigest: string): void {
    if (identityDigest === this.#identityDigest) return
    this.#identityDigest = identityDigest
    this.#epoch += 1
    this.#entries.clear()
  }

  #createFlight(method: CatalogMethod, generation: CatalogGeneration, upstream: TUpstreamSnapshot): FillFlight {
    const flightKey = `${generation.identityDigest}|${generation.epoch}|${method}`
    const invoke = async (): Promise<CatalogFillOutcome> => this.#fetchFill({ method, generation, upstream })
    const flight: FillFlight = {
      generation,
      method,
      settled: false,
      promise: invoke()
        .catch(() => ({ shareable: false }) as CatalogFillOutcome)
        .then(outcome => {
          flight.settled = true
          if (this.#flights.get(flightKey) === flight) this.#flights.delete(flightKey)
          if (outcome.shareable && this.#isCurrent(generation)) this.#retain(method, generation, outcome)
          return outcome
        }),
    }
    this.#flights.set(flightKey, flight)
    return flight
  }

  #startBackgroundFill(method: CatalogMethod, identityDigest: string, upstream: TUpstreamSnapshot): void {
    if (this.#disposed) return
    const generation = this.#currentGeneration()
    const flightKey = `${identityDigest}|${generation.epoch}|${method}`
    if (this.#flights.has(flightKey)) return
    if (this.inFlightFills >= this.#limits.maxInFlightFills) return
    void this.#createFlight(method, generation, upstream).promise.catch(() => undefined)
  }

  #retain(method: CatalogMethod, generation: CatalogGeneration, outcome: { envelopeJson: string; upstreamRpcId: string }): void {
    if (!validateCatalogEnvelope(outcome.envelopeJson, outcome.upstreamRpcId)) return
    const bytes = encoder.encode(outcome.envelopeJson).length
    if (bytes > this.#limits.maxEntryBytes) return
    const key = `${generation.identityDigest}\u0000${method}`
    const now = this.#clock()
    if (this.#entries.has(key)) this.#entries.delete(key)
    const evict = (): void => {
      const candidates = [...this.#entries.entries()].sort(([, a], [, b]) => a.lastServedAt - b.lastServedAt)
      for (const [candidateKey] of candidates) {
        if (this.#entries.size < this.#limits.maxEntries && this.residentBytes + bytes <= this.#limits.maxTotalBytes) break
        this.#entries.delete(candidateKey)
      }
    }
    evict()
    if (this.#entries.size >= this.#limits.maxEntries) return
    if (this.residentBytes + bytes > this.#limits.maxTotalBytes) return
    this.#entries.set(key, {
      identityDigest: generation.identityDigest,
      method,
      envelopeJson: outcome.envelopeJson,
      upstreamRpcId: outcome.upstreamRpcId,
      completedAt: now,
      validUntil: now + this.#limits.staleMs,
      bytes,
      lastServedAt: now,
    })
  }
}
