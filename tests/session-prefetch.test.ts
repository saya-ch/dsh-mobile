import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_PREFETCH_DEFAULTS,
  SESSION_PREFETCH_STORAGE_KEY,
  SessionPrefetchTracker,
  prefetchSession,
  readSessionPrefetchEnabled,
  sessionPrefetchConfigFrom,
  writeSessionPrefetchEnabled,
} from '../src/session-prefetch.js'

function makeTracker(overrides: Partial<typeof SESSION_PREFETCH_DEFAULTS> = {}): { tracker: SessionPrefetchTracker; now: () => number } {
  const config = { ...SESSION_PREFETCH_DEFAULTS, ...overrides }
  const now = () => 1_000_000
  const tracker = new SessionPrefetchTracker(config, { now })
  return { tracker, now }
}

describe('SessionPrefetchTracker', () => {
  it('skips when there is no previous session', () => {
    const { tracker } = makeTracker()
    expect(tracker.switchTo('session-a')).toEqual({ action: 'skip', reason: 'no-previous' })
  })

  it('records the first session without warming', () => {
    const { tracker } = makeTracker({ enabled: true })
    expect(tracker.switchTo('session-a')).toEqual({ action: 'skip', reason: 'no-previous' })
    expect(tracker.switchTo('session-b').action).toBe('warm')
  })

  it('skips the same-session no-op', () => {
    const { tracker } = makeTracker({ enabled: true })
    tracker.switchTo('session-a')
    expect(tracker.switchTo('session-a')).toEqual({ action: 'skip', reason: 'same-session' })
  })

  it('respects the disabled opt-in default', () => {
    const { tracker } = makeTracker() // enabled defaults to false
    tracker.switchTo('session-a')
    expect(tracker.switchTo('session-b')).toEqual({ action: 'skip', reason: 'disabled' })
  })

  it('enforces a per-session cooldown', () => {
    let now = 1_000_000
    const config = { ...SESSION_PREFETCH_DEFAULTS, enabled: true, cooldownMs: 60_000 }
    const tracker = new SessionPrefetchTracker(config, { now: () => now })
    tracker.switchTo('session-a')
    expect(tracker.switchTo('session-b').action).toBe('warm') // warms a, a enters cooldown
    // Switch back: warms b (the just-left session), b enters cooldown.
    expect(tracker.switchTo('session-a').action).toBe('warm')
    // Switch back again within the cooldown: a is still cooling down -> skipped.
    expect(tracker.switchTo('session-b')).toEqual({ action: 'skip', reason: 'cooldown' })
    // After the cooldown the session may be warmed again.
    now += 60_001
    expect(tracker.switchTo('session-a').action).toBe('warm') // warms b again
  })

  it('reports the settle window', () => {
    const now = () => 1_000_000
    const { tracker } = makeTracker({ enabled: true, settleMs: 1500 })
    tracker.switchTo('session-a')
    expect(tracker.settled(now() + 100)).toBe(false)
    expect(tracker.settled(now() + 1500)).toBe(true)
  })

  it('resets all state', () => {
    const { tracker } = makeTracker({ enabled: true })
    tracker.switchTo('session-a')
    tracker.switchTo('session-b')
    tracker.reset()
    expect(tracker.switchTo('session-c')).toEqual({ action: 'skip', reason: 'no-previous' })
  })
})

describe('prefetchSession', () => {
  it('does not throw when the gateway rejects the call', async () => {
    const request = vi.fn().mockResolvedValue(new Response('{"error":"gateway/arguments-invalid"}', { status: 400 }))
    const dispose = prefetchSession(request, 'session-1', 1000)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    dispose()
  })

  it('issues a read-only session/projections request', async () => {
    const request = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const dispose = prefetchSession(request, 'session-1', 1000)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    const [path, init] = request.mock.calls[0] as [string, RequestInit]
    expect(path).toBe('/api/session/projections')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body as string)
    expect(body.type).toBe('client-request')
    expect(body.method).toBe('session/projections')
    // The upstream takes a single `request` parameter and the gateway checks wire
    // names exactly; every other call site in this repo sends args.request.
    expect(body.payload.args).toEqual({ request: { sessionId: 'session-1' } })
    expect(typeof body.rpcId).toBe('string')
    expect(body.rpcId).not.toBe('dsh-mobile-prefetch-session-1')
    dispose()
  })

  it('silently swallows a failed prefetch', async () => {
    const request = vi.fn().mockRejectedValue(new Error('boom'))
    const dispose = prefetchSession(request as never, 'session-1', 1000)
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    dispose()
  })

  it('can be cancelled', async () => {
    let signal: AbortSignal | undefined
    const request = vi.fn().mockImplementation((_path: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return Promise.reject(new Error('aborted'))
    })
    const dispose = prefetchSession(request as never, 'session-1', 1000)
    dispose()
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
    expect(signal?.aborted).toBe(true)
  })
})





describe('opt-in persistence', () => {
  it('is off when nothing was stored', () => {
    const storage = { getItem: (): string | null => null }
    expect(readSessionPrefetchEnabled(storage)).toBe(false)
  })

  it('reads only the explicit true value', () => {
    const storage = { getItem: (key: string): string | null => (key === SESSION_PREFETCH_STORAGE_KEY ? 'true' : null) }
    expect(readSessionPrefetchEnabled(storage)).toBe(true)
    expect(readSessionPrefetchEnabled({ getItem: () => 'yes' })).toBe(false)
  })

  it('stays off when storage throws', () => {
    const storage = { getItem: (): string | null => { throw new Error('blocked') } }
    expect(readSessionPrefetchEnabled(storage)).toBe(false)
  })

  it('writes the flag under the shared key', () => {
    const written: Record<string, string> = {}
    writeSessionPrefetchEnabled(true, { setItem: (k: string, v: string): void => { written[k] = v } })
    expect(written[SESSION_PREFETCH_STORAGE_KEY]).toBe('true')
  })

  it('applies the persisted flag onto the config', () => {
    expect(sessionPrefetchConfigFrom(true).enabled).toBe(true)
    expect(sessionPrefetchConfigFrom(false).enabled).toBe(false)
    // Timing guardrails are untouched by the switch.
    expect(sessionPrefetchConfigFrom(true).cooldownMs).toBe(SESSION_PREFETCH_DEFAULTS.cooldownMs)
  })
})
