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

/** Fire a read-only `session/projections` prefetch, silently ignoring failures. */
export function prefetchSession(request: (path: string, init?: RequestInit) => Promise<Response>, sessionId: string, timeoutMs: number): () => void {
  let cancelled = false
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  void (async () => {
    try {
      await request('/api/session/projections', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: `dsh-mobile-prefetch-${sessionId}`,
          method: 'session/projections',
          payload: { args: { sessionId } },
        }),
        signal: controller.signal,
      })
    } catch {
      /* Prefetch is best-effort and never affects normal requests. */
    } finally {
      clearTimeout(timer)
    }
  })()
  return () => {
    if (cancelled) return
    cancelled = true
    controller.abort()
    clearTimeout(timer)
  }
}

