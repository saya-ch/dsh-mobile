import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, shouldRenewSession } from '../src/client.js'
import { installMobileConnectionRecovery, shouldRenewAfterRejection } from '../src/client-recovery.js'
import type { MobileConnectionState, MobileRecoveryBridge } from '../src/client-recovery.js'

const releases: Array<() => void> = []

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  void promise.catch(() => undefined)
  releases.push(() => { reject(new Error('held recovery fixture released during cleanup')) })
  return { promise, resolve, reject }
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

const disposers: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function native(invoke: MobileRecoveryBridge['invoke'] = vi.fn(async () => ({ renewed: true })),
  capabilities: MobileRecoveryBridge['capabilities'] = vi.fn(() => ['auth.renew'])) {
  return { capabilities, invoke }
}

/** Mount the production apply() effect, not a substitute timer or pure predicate. */
function fixture(bridge?: MobileRecoveryBridge, initial: MobileConnectionState = 'disconnected',
  service: 'present' | 'absent' | 'no-state' | 'no-reconnect' = 'present',
  owner: 'dedicated' | 'gateway' | 'desktop' = 'dedicated') {
  vi.useFakeTimers()
  let snapshot: MobileConnectionState = initial
  const listeners = new Set<() => void>()
  const state = {
    getSnapshot: () => snapshot,
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
  }
  const reconnect = vi.fn()
  const connection = { isLoopback: false, state, reconnect }
  let currentConnection: { isLoopback: boolean; readonly state?: typeof state; reconnect?: () => void } | undefined
    = service === 'absent' ? undefined : service === 'no-state' ? { isLoopback: false, reconnect }
      : service === 'no-reconnect' ? { isLoopback: false, state } : connection
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible', cookie: 'dsh_ma_csrf=before',
    querySelector: (selector: string) => owner === 'gateway'
      && selector === 'meta[name="dsh-mobile-gateway"][content="authenticated"]' ? {} : null,
  })
  const page = Object.assign(new EventTarget(), {
    document,
    location: { origin: 'https://computer.example' },
    __DSH_MOBILE_NATIVE__: bridge,
    __DSH_MOBILE_FRONTEND__: owner === 'dedicated' ? 'dedicated' : undefined,
  })
  vi.stubGlobal('document', document)
  vi.stubGlobal('window', page)
  let remove: (() => void) | undefined
  let rejected: ((status: number) => void) | undefined
  apply({
    effect(install, label) {
      if (label !== 'dsh-mobile: connection recovery') return
      // The owner now takes an out-parameter for the rejection signal, because
      // `ctx.effect` accepts only a void or disposer return.
      const cleanup = install()
      if (cleanup !== undefined) remove = cleanup
    },
    get: () => currentConnection,
    slots: { inject: vi.fn(), register: vi.fn() },
  })
  let cleanup: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    cleanup ??= Promise.resolve(remove?.())
    return cleanup
  }
  disposers.push(dispose)
  return {
    page, document, connection, listeners, dispose,
    rejected: (status: number) => { rejected?.(status) },
    setState(next: MobileConnectionState) {
      snapshot = next
      for (const listener of listeners) listener()
    },
    replaceConnection() { currentConnection = { ...connection, reconnect: vi.fn() } },
    visibility(value: 'visible' | 'hidden') {
      document.visibilityState = value
      document.dispatchEvent(new Event('visibilitychange'))
    },
  }
}

describe('session renewal admission', () => {
  it('waits out brief blips and requires a known disconnected state', () => {
    expect(shouldRenewSession('connecting', 5000)).toBe(true)
    expect(shouldRenewSession('disconnected', 6000)).toBe(true)
    expect(shouldRenewSession('connecting', 4999)).toBe(false)
    expect(shouldRenewSession(undefined, 60_000)).toBe(false)
    expect(shouldRenewSession('connected', 60_000)).toBe(false)
  })

  it('requires the App to advertise renewal and ignores ordinary browsers', async () => {
    const unsupported = native(vi.fn(), vi.fn(() => []))
    const withoutCapability = fixture(unsupported)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(unsupported.invoke).not.toHaveBeenCalled()
    await withoutCapability.dispose()
    const browser = fixture()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(browser.connection.reconnect).not.toHaveBeenCalled()
  })

  it('does not change ordinary DSH desktop resume or renewal, even with an advertised native adapter', async () => {
    const bridge = native(vi.fn(async () => ({ renewed: true })))
    const desktop = fixture(bridge, 'disconnected', 'present', 'desktop')
    expect(desktop.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    desktop.visibility('hidden')
    desktop.visibility('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(desktop.connection.reconnect).not.toHaveBeenCalled()
    expect(bridge.capabilities).not.toHaveBeenCalled()
    expect(bridge.invoke).not.toHaveBeenCalled()
  })

  it.each(['browser', 'old-app'] as const)('retains public resume on authenticated stock Gateway pages for %s', async kind => {
    const bridge = kind === 'browser' ? undefined : native(vi.fn(), vi.fn(() => []))
    const stock = fixture(bridge, 'disconnected', 'present', 'gateway')
    stock.visibility('hidden')
    stock.visibility('visible')
    expect(stock.connection.reconnect).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(stock.connection.reconnect).toHaveBeenCalledTimes(1)
    if (bridge !== undefined) expect(bridge.invoke).not.toHaveBeenCalled()
  })

  it.each(['absent', 'no-state', 'no-reconnect'] as const)('does not acquire recovery effects for a %s connection service', async service => {
    const bridge = native(vi.fn(async () => ({ renewed: true })))
    const mounted = fixture(bridge, 'disconnected', service)
    expect(mounted.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    mounted.visibility('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(bridge.invoke).not.toHaveBeenCalled()
    expect(mounted.connection.reconnect).not.toHaveBeenCalled()
  })

  it('does not renew in the background or disturb a healthy connection', async () => {
    const bridge = native(vi.fn(async () => ({ renewed: true })))
    const mounted = fixture(bridge, 'connected')
    await vi.advanceTimersByTimeAsync(60_000)
    mounted.setState('disconnected')
    mounted.visibility('hidden')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(bridge.invoke).not.toHaveBeenCalled()
    mounted.visibility('visible')
    await flush()
    expect(bridge.invoke).toHaveBeenCalledTimes(1)
  })

  it('starts the disconnection budget at the first known outcome, not during initial unknown state', async () => {
    const bridge = native(vi.fn(async () => ({ renewed: true })))
    const mounted = fixture(bridge)
    mounted.setState(undefined)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(bridge.invoke).not.toHaveBeenCalled()
    mounted.setState('connecting')
    await vi.advanceTimersByTimeAsync(4000)
    expect(bridge.invoke).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(bridge.invoke).toHaveBeenCalledTimes(1)
  })
})

describe('production recovery effect ownership', () => {
  it('nudges only a visible, unhealthy browser transport and removes its listener on disposal', async () => {
    const mounted = fixture(undefined, 'connected')
    mounted.visibility('visible')
    expect(mounted.connection.reconnect).not.toHaveBeenCalled()
    mounted.setState('disconnected')
    mounted.visibility('hidden')
    expect(mounted.connection.reconnect).not.toHaveBeenCalled()
    mounted.visibility('visible')
    expect(mounted.connection.reconnect).toHaveBeenCalledTimes(1)
    await mounted.dispose()
    mounted.visibility('hidden')
    mounted.visibility('visible')
    expect(mounted.connection.reconnect).toHaveBeenCalledTimes(1)
    expect(mounted.listeners.size).toBe(0)
  })

  it('retains one in-flight renewal across many former retry windows and drains it on disposal', async () => {
    const response = deferred<unknown>()
    let signal: AbortSignal | undefined
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>((_action, _input, options) => {
      signal = options?.signal
      return response.promise
    })
    const mounted = fixture(native(invoke))
    await vi.advanceTimersByTimeAsync(24_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(signal?.aborted).toBe(false)
    let drained = false
    const disposal = mounted.dispose().then(() => { drained = true })
    await flush()
    expect(signal?.aborted).toBe(true)
    expect(drained).toBe(false)
    expect(mounted.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    response.resolve({ renewed: true })
    await disposal
    mounted.visibility('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mounted.connection.reconnect).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it.each(['cancelled', 'timeout', 'unavailable'] as const)('does not silently restart after native %s', async code => {
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
      .mockRejectedValueOnce(Object.assign(new Error('native recovery stopped'), { code }))
      .mockResolvedValue({ renewed: true })
    const mounted = fixture(native(invoke))
    await vi.advanceTimersByTimeAsync(120_000)
    mounted.visibility('hidden')
    mounted.visibility('visible')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    mounted.setState('connected')
    mounted.setState('disconnected')
    await vi.advanceTimersByTimeAsync(6000)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(mounted.connection.reconnect).toHaveBeenCalledTimes(2)
  })

  it('reconnects after current native cookie installation without polling or writing a CSRF token', async () => {
    const response = deferred<unknown>()
    const invoke = vi.fn(() => response.promise)
    const mounted = fixture(native(invoke))
    await vi.advanceTimersByTimeAsync(6000)
    expect(mounted.connection.reconnect).not.toHaveBeenCalled()
    mounted.document.cookie = 'dsh_ma_csrf=after'
    response.resolve({ renewed: true })
    await flush()
    expect(mounted.connection.reconnect).toHaveBeenCalledTimes(1)
    expect(mounted.document.cookie).toBe('dsh_ma_csrf=after')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it.each(['success', 'failure'] as const)('withdraws an old bridge before its late %s', async outcome => {
    const oldResponse = deferred<unknown>()
    let oldSignal: AbortSignal | undefined
    const oldInvoke = vi.fn<MobileRecoveryBridge['invoke']>((_action, _input, options) => {
      oldSignal = options?.signal
      return oldResponse.promise
    })
    const mounted = fixture(native(oldInvoke))
    await vi.advanceTimersByTimeAsync(6000)
    const replacement = native(vi.fn(async () => ({ renewed: true })))
    mounted.page.__DSH_MOBILE_NATIVE__ = replacement
    mounted.page.dispatchEvent(new Event('dsh-mobile-native-ready'))
    await vi.advanceTimersByTimeAsync(12_000)
    expect(oldSignal?.aborted).toBe(true)
    expect(replacement.invoke).not.toHaveBeenCalled()
    if (outcome === 'success') oldResponse.resolve({ renewed: true })
    else oldResponse.reject(new Error('old native failed'))
    await flush()
    expect(mounted.connection.reconnect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(replacement.invoke).toHaveBeenCalledTimes(1)
    expect(mounted.connection.reconnect).toHaveBeenCalledTimes(1)
  })

  it.each(['connection', 'document', 'origin', 'pagehide'] as const)('rejects a late result after %s ownership changes', async owner => {
    const response = deferred<unknown>()
    let signal: AbortSignal | undefined
    const mounted = fixture(native((_action, _input, options) => {
      signal = options?.signal
      return response.promise
    }))
    await vi.advanceTimersByTimeAsync(6000)
    if (owner === 'connection') mounted.replaceConnection()
    if (owner === 'document') mounted.page.document = Object.assign(new EventTarget(), {
      visibilityState: 'visible', cookie: '', querySelector: () => null,
    })
    if (owner === 'origin') mounted.page.location.origin = 'https://other-computer.example'
    if (owner === 'pagehide') mounted.page.dispatchEvent(new Event('pagehide'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(signal?.aborted).toBe(true)
    response.resolve({ renewed: true })
    await flush()
    expect(mounted.connection.reconnect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels an obsolete renewal when the public transport recovers independently', async () => {
    const response = deferred<unknown>()
    let signal: AbortSignal | undefined
    const mounted = fixture(native((_action, _input, options) => {
      signal = options?.signal
      return response.promise
    }))
    await vi.advanceTimersByTimeAsync(6000)
    mounted.setState('connected')
    expect(signal?.aborted).toBe(true)
    response.resolve({ renewed: true })
    await flush()
    expect(mounted.connection.reconnect).not.toHaveBeenCalled()
  })

  it('cancels renewal when the public Connection owner stops and publishes undefined', async () => {
    const response = deferred<unknown>()
    let signal: AbortSignal | undefined
    const mounted = fixture(native((_action, _input, options) => {
      signal = options?.signal
      return response.promise
    }))
    await vi.advanceTimersByTimeAsync(6000)
    mounted.setState(undefined)
    expect(signal?.aborted).toBe(true)
    response.resolve({ renewed: true })
    await flush()
    expect(mounted.connection.reconnect).not.toHaveBeenCalled()
  })

  it.each(['success', 'failure'] as const)('keeps a new outage eligible after a brief connected state and the old task\'s late %s', async outcome => {
    const response = deferred<unknown>()
    let oldSignal: AbortSignal | undefined
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
      .mockImplementationOnce((_action, _input, options) => {
        oldSignal = options?.signal
        return response.promise
      })
      .mockResolvedValue({ renewed: true })
    const mounted = fixture(native(invoke))
    await vi.advanceTimersByTimeAsync(6000)
    mounted.setState('connected')
    mounted.setState('disconnected')
    expect(oldSignal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(6000)
    expect(invoke).toHaveBeenCalledTimes(1)
    if (outcome === 'success') response.resolve({ renewed: true })
    else response.reject(new Error('old renewal failed'))
    await flush()
    expect(mounted.connection.reconnect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(mounted.connection.reconnect).toHaveBeenCalledTimes(1)
  })

  it('rejects unconfirmed results rather than reconnecting before installed cookies', async () => {
    const mounted = fixture(native(vi.fn(async () => ({ ok: true }))))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mounted.connection.reconnect).not.toHaveBeenCalled()
  })

  it('withdraws capability discovery before a disposed page can start native work', async () => {
    const capabilities = deferred<readonly string[]>()
    const invoke = vi.fn()
    const mounted = fixture(native(invoke, () => capabilities.promise))
    await vi.advanceTimersByTimeAsync(6000)
    const disposal = mounted.dispose()
    capabilities.resolve(['auth.renew'])
    await disposal
    expect(invoke).not.toHaveBeenCalled()
    expect(mounted.connection.reconnect).not.toHaveBeenCalled()
  })
})

describe('native renewal after disconnection or Gateway rejection', () => {
  // Issue #298: DSH keeps Sessions in memory, so a Host restart kills every phone
  // Session while the device credential survives. The live transport can keep
  // reporting `connected`, so waiting for a disconnect never fires.
  it('admits a 401/403 while the transport still looks connected', () => {
    expect(shouldRenewAfterRejection(401, 'connected')).toBe(true)
    expect(shouldRenewAfterRejection(403, 'connected')).toBe(true)
    expect(shouldRenewAfterRejection(401, undefined)).toBe(true)
    // A transport already known to be down renews through the disconnect path, so
    // the rejection signal must not start a second attempt.
    expect(shouldRenewAfterRejection(401, 'disconnected')).toBe(false)
    expect(shouldRenewAfterRejection(401, 'connecting')).toBe(false)
    // Only an authentication rejection is evidence of a dead Session.
    expect(shouldRenewAfterRejection(500, 'connected')).toBe(false)
    expect(shouldRenewAfterRejection(404, 'connected')).toBe(false)
    expect(shouldRenewAfterRejection(200, 'connected')).toBe(false)
  })

  /** Mount the real recovery owner directly and hand back its rejection signal. */
  function owner(bridge: MobileRecoveryBridge | undefined, initial: MobileConnectionState = 'connected') {
    vi.useFakeTimers()
    let snapshot: MobileConnectionState = initial
    const listeners = new Set<() => void>()
    const state = { getSnapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
    const reconnect = vi.fn()
    const connection = { isLoopback: false, state, reconnect }
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible', cookie: 'dsh_ma_csrf=before' })
    const page = Object.assign(new EventTarget(), { document, location: { origin: 'https://computer.example' }, __DSH_MOBILE_NATIVE__: bridge })
    let rejected: ((status: number) => void) | undefined
    let retry: (() => boolean) | undefined
    const renewed = vi.fn()
    // The owner only reads visibility, the origin and the native bridge, so the
    // owned stub is cast at the boundary exactly like the existing fixture does.
    const dispose = installMobileConnectionRecovery(
      () => connection, page as unknown as Parameters<typeof installMobileConnectionRecovery>[1],
      document as unknown as Document, (signal, manual) => { rejected = signal; retry = manual }, renewed,
    )
    disposers.push(async () => { await dispose?.() })
    return {
      connection, reconnect,
      reject: (status: number) => rejected?.(status),
      retry: () => retry?.() ?? false,
      dispose, renewed,
      setState(next: MobileConnectionState) { snapshot = next; for (const listener of listeners) listener() },
      // Move the observed store without notifying listeners, which is what a store update
      // that lands while an awaited capability discovery is still in flight looks like.
      setStateQuietly(next: MobileConnectionState) { snapshot = next },
      setVisibility(next: string) { document.visibilityState = next; document.dispatchEvent(new Event('visibilitychange')) },
      setBridge(next: MobileRecoveryBridge) { page.__DSH_MOBILE_NATIVE__ = next; page.dispatchEvent(new Event('dsh-mobile-native-ready')) },
    }
  }

  it('automatically renews once more after a transient native failure during a disconnect', async () => {
    const first = deferred<{ renewed: boolean }>()
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ renewed: true })
    const mounted = owner(native(invoke), 'connecting')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(mounted.renewed).not.toHaveBeenCalled()
    first.reject(Object.assign(new Error('carrier temporarily unavailable'), { code: 'transient' }))
    await flush()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(invoke).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(mounted.reconnect).toHaveBeenCalledTimes(1)
    expect(mounted.renewed).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('keeps each disconnect bounded and leaves explicit retry available after exhaustion', async () => {
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
      .mockRejectedValue(Object.assign(new Error('temporary'), { code: 'transient' }))
    const mounted = owner(native(invoke), 'connecting')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(mounted.renewed).not.toHaveBeenCalled()
    expect(mounted.retry()).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invoke).toHaveBeenCalledTimes(3)
    mounted.setState('connected')
    mounted.setState('connecting')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invoke).toHaveBeenCalledTimes(5)
  })

  it('does not renew in the background and resumes the available follow-up on foreground', async () => {
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
      .mockRejectedValue(Object.assign(new Error('temporary'), { code: 'transient' }))
    const mounted = owner(native(invoke), 'connecting')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    mounted.setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(20_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(mounted.retry()).toBe(false)
    mounted.setVisibility('visible')
    await flush()
    expect(invoke).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('defers the follow-up if the page goes hidden during capability discovery', async () => {
    const capabilities = deferred<readonly string[]>()
    const discover = vi.fn<MobileRecoveryBridge['capabilities']>()
      .mockReturnValueOnce(['auth.renew'])
      .mockReturnValueOnce(capabilities.promise)
      .mockReturnValue(['auth.renew'])
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
      .mockRejectedValueOnce(Object.assign(new Error('temporary'), { code: 'transient' }))
      .mockResolvedValue({ renewed: true })
    const mounted = owner(native(invoke, discover), 'connecting')
    await vi.advanceTimersByTimeAsync(8_000)
    expect(discover).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledTimes(1)
    mounted.setVisibility('hidden')
    capabilities.resolve(['auth.renew'])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    mounted.setVisibility('visible')
    await flush()
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(mounted.renewed).toHaveBeenCalledTimes(1)
  })

  it('drops the follow-up when the transport recovers during capability discovery', async () => {
    // The follow-up re-checks that the transport is still down after capability discovery
    // resolves. Without that check a transport that came back mid-discovery would be renewed
    // anyway, which is exactly the state the recovery is supposed to leave alone.
    const capabilities = deferred<readonly string[]>()
    const discover = vi.fn<MobileRecoveryBridge['capabilities']>()
      .mockReturnValueOnce(['auth.renew'])
      .mockReturnValueOnce(capabilities.promise)
      .mockReturnValue(['auth.renew'])
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
      .mockRejectedValueOnce(Object.assign(new Error('temporary'), { code: 'transient' }))
      .mockResolvedValue({ renewed: true })
    const mounted = owner(native(invoke, discover), 'connecting')
    await vi.advanceTimersByTimeAsync(8_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(discover).toHaveBeenCalledTimes(2)
    // The transport recovers while the follow-up is still discovering capabilities. The
    // store is moved without notifying this loop, so its own listener has not cancelled the
    // task yet and the executed-time check is the only thing that can stop it.
    mounted.setStateQuietly('connected')
    capabilities.resolve(['auth.renew'])
    await vi.advanceTimersByTimeAsync(20_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(mounted.renewed).not.toHaveBeenCalled()
  })

  it('does not treat a capability discovery error as a transient renewal failure', async () => {
    const discover = vi.fn<MobileRecoveryBridge['capabilities']>()
      .mockRejectedValue(Object.assign(new Error('capability error'), { code: 'transient' }))
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
    owner(native(invoke, discover), 'connecting')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(discover).toHaveBeenCalledTimes(1)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('lets an explicit retry replace the scheduled automatic follow-up', async () => {
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
      .mockRejectedValue(Object.assign(new Error('temporary'), { code: 'transient' }))
    const mounted = owner(native(invoke), 'connecting')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(mounted.retry()).toBe(true)
    expect(mounted.retry()).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it.each(['connected', 'owner gap', 'bridge replacement', 'disposal'] as const)('withdraws the pending follow-up after %s', async cause => {
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
      .mockRejectedValue(Object.assign(new Error('temporary'), { code: 'transient' }))
    const mounted = owner(native(invoke), 'connecting')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    const replacement = vi.fn(async () => ({ renewed: true }))
    if (cause === 'connected') mounted.setState('connected')
    if (cause === 'owner gap') mounted.setState(undefined)
    if (cause === 'bridge replacement') mounted.setBridge(native(replacement))
    if (cause === 'disposal') await mounted.dispose?.()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(replacement).toHaveBeenCalledTimes(cause === 'bridge replacement' ? 1 : 0)
  })

  it.each(['busy', 'timeout', 'device_revoked', 'device_expired', 'authentication_failed'])('does not automatically retry %s during a disconnect', async code => {
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
      .mockRejectedValue(Object.assign(new Error('native rejected'), { code }))
    const mounted = owner(native(invoke), 'connecting')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(mounted.renewed).not.toHaveBeenCalled()
  })

  it('does not retry a transient renewal after an isolated HTTP 401 on a connected transport', async () => {
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
      .mockRejectedValue(Object.assign(new Error('temporary'), { code: 'transient' }))
    const mounted = owner(native(invoke))
    mounted.reject(401)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(mounted.renewed).not.toHaveBeenCalled()
  })

  it('allows explicit retry after a transient failure and refreshes only after confirmed renewal', async () => {
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
      .mockRejectedValueOnce(Object.assign(new Error('deadline'), { code: 'timeout' }))
      .mockResolvedValue({ renewed: true })
    const mounted = owner(native(invoke))
    mounted.reject(401)
    await flush()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(mounted.renewed).not.toHaveBeenCalled()
    mounted.reject(401)
    await flush()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(mounted.retry()).toBe(true)
    expect(mounted.retry()).toBe(false)
    await flush()
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(mounted.renewed).toHaveBeenCalledTimes(1)
    await mounted.dispose?.()
    expect(mounted.retry()).toBe(false)
  })

  it.each(['device_revoked', 'device_expired', 'authentication_failed'])('does not rearm rejected credentials after %s', async code => {
    const invoke = vi.fn<MobileRecoveryBridge['invoke']>()
      .mockRejectedValue(Object.assign(new Error('credentials rejected'), { code }))
    const mounted = owner(native(invoke))
    mounted.reject(401)
    await flush()
    mounted.setState('connecting')
    mounted.setState('connected')
    mounted.reject(401)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mounted.retry()).toBe(false)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(mounted.renewed).not.toHaveBeenCalled()
  })

  it('keeps independently mounted recovery owners separate', async () => {
    const firstInvoke = vi.fn(async () => ({ renewed: true }))
    const secondInvoke = vi.fn(async () => ({ renewed: true }))
    const first = owner(native(firstInvoke))
    const second = owner(native(secondInvoke))
    await first.dispose?.()
    second.reject(401)
    await flush()
    expect(firstInvoke).not.toHaveBeenCalled()
    expect(secondInvoke).toHaveBeenCalledTimes(1)
    expect(second.renewed).toHaveBeenCalledTimes(1)
  })

  it('does not request a renewal from a page with no native bridge', async () => {
    // An ordinary browser must not promise automatic recovery it cannot perform.
    const mounted = owner(undefined)
    mounted.reject(401)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mounted.reconnect).not.toHaveBeenCalled()
  })

  it('renews once for a burst of rejections and reconnects after the result', async () => {
    const invoke = vi.fn(async () => ({ renewed: true }))
    const mounted = owner(native(invoke))
    for (let attempt = 0; attempt < 5; attempt += 1) mounted.reject(401)
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(mounted.reconnect).toHaveBeenCalledTimes(1)
  })

  it('stops retrying after the App refuses to renew a revoked device', async () => {
    // Revocation also surfaces as 401. The bridge refuses, and the page must not
    // keep trying: an unattended retry loop on a revoked device is not recovery.
    const invoke = vi.fn(async () => ({ renewed: false }))
    const mounted = owner(native(invoke))
    mounted.reject(401)
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    mounted.reject(401)
    mounted.reject(401)
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(mounted.reconnect).not.toHaveBeenCalled()
  })

  it('allows a fresh attempt after the transport reconnects', async () => {
    const invoke = vi.fn(async () => ({ renewed: true }))
    const mounted = owner(native(invoke))
    mounted.reject(401)
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(invoke).toHaveBeenCalledTimes(1)
    // A real reconnect goes through a non-connected state first. Only that
    // transition clears the evidence and re-arms the attempt: a page that stays
    // `connected` while being rejected must not retry forever.
    mounted.setState('connecting')
    mounted.setState('connected')
    mounted.reject(401)
    await vi.advanceTimersByTimeAsync(1000)
    await flush()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('does not re-arm while the transport keeps reporting connected', async () => {
    // Guards the revoked-device case: repeated 401s on a still-connected page must
    // not become an unattended retry loop.
    const invoke = vi.fn(async () => ({ renewed: false }))
    const mounted = owner(native(invoke))
    for (let round = 0; round < 3; round += 1) {
      mounted.reject(401)
      mounted.setState('connected')
      await vi.advanceTimersByTimeAsync(5000)
      await flush()
    }
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
