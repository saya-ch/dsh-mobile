/**
 * Session prefetch for the dedicated Mobile frontend.
 *
 * Switching sessions tears down the client Session instance and its live
 * stream; switching back performs a full re-open. On the host, if the target
 * was evicted from DSH session-query's prepared-session LRU, the gateway must
 * decompress and parse the whole session log before `session/follow` can
 * answer. This module warms that cache for the session the user just left (the
 * most likely switch-back target) after a switch settles, so a follow-back hits
 * warm.
 *
 * Guardrails (per issue #291): read-only (never activates an Agent), at most one
 * target per switch, per-session cooldown, bounded settle/timeout, and silent
 * failure that never affects normal requests or live streams. The feature is
 * opt-in and disabled by default.
 */

export interface SessionPrefetchConfig {
  /** Master switch; disabled by default so the behavior is opt-in. */
  readonly enabled: boolean
  /** How long to wait for further switches before warming the MRU session (ms). */
  readonly settleMs: number
  /** Per-session cooldown between prefetches of the same session (ms). */
  readonly cooldownMs: number
  /** Hard deadline for one prefetch request (ms). */
  readonly timeoutMs: number
  /** Maximum number of targets warmed per switch (bounded to avoid bursty work). */
  readonly maxTargetsPerSwitch: number
}

export const SESSION_PREFETCH_DEFAULTS: Readonly<SessionPrefetchConfig> = {
  enabled: false,
  settleMs: 1500,
  cooldownMs: 60_000,
  timeoutMs: 20_000,
  maxTargetsPerSwitch: 1,
}

/**
 * Storage key for the opt-in switch.
 *
 * The setting row lives in the client bundle while the tracker lives in the
 * layout bundle (tsdown.config.ts emits them separately and inlines this module
 * into each), so a module-level singleton cannot carry the value across. The
 * layout bundle owns the persisted state instead; the row notifies it through
 * both the storage event (other tabs) and a custom event (same page).
 */
export const SESSION_PREFETCH_STORAGE_KEY = 'dsh-mobile.session-prefetch.enabled'
export const SESSION_PREFETCH_EVENT = 'dsh-mobile:session-prefetch-change'

/** Read the persisted opt-in. Defaults to off; unreadable storage keeps it off. */
export function readSessionPrefetchEnabled(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(SESSION_PREFETCH_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** Persist the opt-in and notify the layout bundle in the same page. */
export function writeSessionPrefetchEnabled(enabled: boolean, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(SESSION_PREFETCH_STORAGE_KEY, String(enabled))
  } catch {
    /* Blocked storage still lets this page react through the event below. */
  }
  try {
    globalThis.dispatchEvent?.(new CustomEvent(SESSION_PREFETCH_EVENT, { detail: { enabled } }))
  } catch {
    /* CustomEvent is missing in some test environments; the storage event still applies. */
  }
}

/**
 * Subscribe to opt-in changes coming from either bundle. The listener is not
 * called with the initial value; read it once with readSessionPrefetchEnabled().
 */
export function subscribeSessionPrefetchEnabled(listener: (enabled: boolean) => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== SESSION_PREFETCH_STORAGE_KEY) return
    listener(readSessionPrefetchEnabled())
  }
  const onCustom = (event: Event): void => {
    const detail = (event as CustomEvent<{ enabled?: boolean }>).detail
    listener(detail?.enabled ?? readSessionPrefetchEnabled())
  }
  globalThis.addEventListener?.('storage', onStorage)
  globalThis.addEventListener?.(SESSION_PREFETCH_EVENT, onCustom)
  return () => {
    globalThis.removeEventListener?.('storage', onStorage)
    globalThis.removeEventListener?.(SESSION_PREFETCH_EVENT, onCustom)
  }
}

/** Apply the persisted opt-in onto a base config. */
export function sessionPrefetchConfigFrom(enabled: boolean, base: Readonly<SessionPrefetchConfig> = SESSION_PREFETCH_DEFAULTS): SessionPrefetchConfig {
  return { ...base, enabled }
}

/** Outcome of deciding whether a session switch should warm an MRU target. */
export type PrefetchDecision =
  | { readonly action: 'warm'; readonly target: string }
  | { readonly action: 'skip'; readonly reason: 'disabled' | 'no-previous' | 'same-session' | 'cooldown' | 'limit' }

export interface PrefetchClock {
  now(): number
}

/** In-memory per-session cooldown ledger plus MRU switch tracking (pure). */
export class SessionPrefetchTracker {
  private readonly cooldownUntil = new Map<string, number>()
  private previousSession: string | undefined
  private lastSwitchAt = 0

  constructor(
    private readonly config: Readonly<SessionPrefetchConfig>,
    private readonly clock: PrefetchClock = { now: () => Date.now() },
  ) {}

  /** The effective opt-in this tracker was built with (read-only, for rebuilds). */
  get enabled(): boolean {
    return this.config.enabled
  }

  /** Record that the UI switched to `sessionId`; returns the switch outcome. */
  switchTo(sessionId: string): PrefetchDecision {
    if (sessionId === '') return { action: 'skip', reason: 'no-previous' }
    const previous = this.previousSession
    this.previousSession = sessionId
    this.lastSwitchAt = this.clock.now()
    if (previous === undefined) return { action: 'skip', reason: 'no-previous' }
    if (previous === sessionId) return { action: 'skip', reason: 'same-session' }
    if (!this.config.enabled) return { action: 'skip', reason: 'disabled' }
    const cooldownUntil = this.cooldownUntil.get(previous) ?? 0
    if (this.clock.now() < cooldownUntil) return { action: 'skip', reason: 'cooldown' }
    this.cooldownUntil.set(previous, this.clock.now() + this.config.cooldownMs)
    return { action: 'warm', target: previous }
  }

  /** Whether the switch already passed the settle window (pure predicate). */
  settled(now = this.clock.now()): boolean {
    return now - this.lastSwitchAt >= this.config.settleMs
  }

  /** Forget state (used when the client unmounts). */
  reset(): void {
    this.cooldownUntil.clear()
    this.previousSession = undefined
    this.lastSwitchAt = 0
  }
}

/**
 * Fire a read-only `session/projections` prefetch, silently ignoring failures.
 *
 * The upstream RPC takes a single `request` parameter and the gateway validates
 * wire names exactly (`assertExactArguments`), so the envelope must be
 * `payload.args.request.sessionId` — the same shape every other call site in
 * this repo uses (scripts/smoke-client-module-settings.mjs, smoke-draft-transfer.mjs).
 * A bare `args.sessionId` is rejected with `gateway/arguments-invalid`.
 */
export function prefetchSession(request: (path: string, init?: RequestInit) => Promise<Response>, sessionId: string, timeoutMs: number): () => void {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  void (async () => {
    try {
      const response = await request('/api/session/projections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: prefetchRpcId(),
          method: 'session/projections',
          payload: { args: { request: { sessionId } } },
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        // Best-effort: a rejected prefetch is not an error the user should see,
        // but it must not be mistaken for a warm cache either.
        return
      }
    } catch {
      /* Prefetch is best-effort and never affects normal requests. */
    } finally {
      clearTimeout(timer)
    }
  })()
  return () => {
    controller.abort()
    clearTimeout(timer)
  }
}

/** Unique per attempt; the upstream does not document a format, so prefer a real UUID. */
function prefetchRpcId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined
  if (cryptoApi?.randomUUID !== undefined) return cryptoApi.randomUUID()
  return `dsh-mobile-prefetch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
