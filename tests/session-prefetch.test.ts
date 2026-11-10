import { describe, expect, it, vi } from 'vitest'
import {
  SESSION_PREFETCH_DEFAULTS,
  SessionPrefetchTracker,
  prefetchSession,
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
    expect(body.payload.args).toEqual({ sessionId: 'session-1' })
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




