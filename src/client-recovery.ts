/** Connection state exposed by DSH's public client connection handle. */
export type MobileConnectionState = 'connected' | 'connecting' | 'disconnected' | undefined

/** Public connection operations used without replacing DSH's transport. */
export interface MobileRecoveryConnection {
  readonly state?: {
    getSnapshot(): MobileConnectionState
    subscribe(listener: () => void): () => void
  }
  reconnect?: () => void
}

/** A supporting App settles renewal only after installing the current cookies. */
export interface MobileRecoveryBridge {
  capabilities(): Promise<readonly string[]> | readonly string[]
  invoke(action: string, input?: unknown, options?: { readonly signal?: AbortSignal }): Promise<unknown>
}

/** Only a visible, disconnected public transport needs an immediate resume nudge. */
export function shouldNudgeReconnect(visibility: string, connection: MobileConnectionState): boolean {
  return visibility === 'visible' && connection !== 'connected'
}

/** A persistent, known disconnection can request native renewal. */
export function shouldRenewSession(connection: MobileConnectionState, downForMs: number): boolean {
  return isDisconnected(connection) && downForMs >= 5000
}

/**
 * Authentication rejection can warrant one renewal even while transport appears
 * connected. A 403 can also indicate a permission failure, so it is not proof
 * that the Session expired.
 *
 * Issue #298: DSH keeps Sessions in memory, so a Host restart kills every phone
 * Session while the device credential survives. The live WebSocket can keep
 * reporting `connected` for a while, so waiting for a disconnect never fires and
 * the customization channel stays dark. A 401/403 on an authenticated gateway
 * request is the signal that actually arrives, and it must be able to start the
 * same renewal the disconnect path uses.
 * @param status - HTTP status of a rejected gateway request.
 * @param connection - current public connection state, if known.
 * @returns whether this rejection should request a renewal.
 */
export function shouldRenewAfterRejection(status: number, connection: MobileConnectionState): boolean {
  if (status !== 401 && status !== 403) return false
  // A transport that is already known to be down renews through that path; this
  // signal exists for the "still looks connected" case.
  return !isDisconnected(connection) || connection === undefined
}

function isDisconnected(connection: MobileConnectionState): boolean {
  return connection === 'connecting' || connection === 'disconnected'
}

interface RecoveryPage extends EventTarget {
  readonly location: { readonly origin: string }
  readonly document: Document
  readonly __DSH_MOBILE_NATIVE__?: MobileRecoveryBridge
}

const TRANSIENT_RENEWAL_BACKOFF_MS = 2_000

/**
 * Own resume nudges and native renewal, with one follow-up after a transient
 * native failure during a continuous disconnection.
 * @param getConnection - Resolve the current service to reject a replaced owner.
 * @param page - The document's window and advertised native adapter.
 * @param document - The mounted document; page replacement withdraws its work.
 * @param onRejected - receives the rejection signal, so a caller that observes a
 * 401 can ask this same owner for one renewal instead of starting its own.
 * @param onRenewed - refresh read-only customization after confirmed Cookie installation.
 * @param onReconnected - revalidate customization after a visible transport recovery.
 * @returns An awaited disposer, or nothing when no public connection is present.
 */
export function installMobileConnectionRecovery(
  getConnection: () => MobileRecoveryConnection | undefined,
  page: RecoveryPage,
  document: Document,
  onRejected?: (rejected: (status: number) => void, retry: () => boolean) => void,
  onRenewed?: () => void,
  onReconnected?: () => void,
): (() => Promise<void>) | undefined {
  const connection = getConnection()
  const state = connection?.state
  if (connection === undefined || state === undefined || typeof connection.reconnect !== 'function') return
  const origin = page.location.origin
  let disposed = false
  let generation = 0
  let currentState = state.getSnapshot()
  let hasConnected = currentState === 'connected'
  let downSince = isDisconnected(currentState) ? Date.now() : undefined
  let attempted = false
  let retryAfter: number | undefined
  let credentialsRejected = false
  // A rejected gateway request is the only signal that arrives when the live
  // transport still reports `connected` but the Session is gone (issue #298).
  let rejectedSince: number | undefined
  let bridge = page.__DSH_MOBILE_NATIVE__
  let pending: Promise<void> | undefined
  let pendingAbort: AbortController | undefined
  let cleanup: Promise<void> | undefined

  const current = (): boolean => !disposed && page.document === document
    && page.location.origin === origin && getConnection() === connection && connection.state === state
  const cancelPending = (): void => {
    generation += 1
    retryAfter = undefined
    pendingAbort?.abort(new DOMException('mobile recovery owner ended', 'AbortError'))
  }
  const updateState = (): void => {
    const next = state.getSnapshot()
    // A released Connection loop can report undefined before its replacement
    // connects. Revalidate after that gap without treating it as an auth outage.
    const reconnected = next === 'connected' && currentState !== 'connected'
      && (hasConnected || isDisconnected(currentState))
    if (next === 'connected') hasConnected = true
    if (!isDisconnected(next)) {
      downSince = undefined
      // A transport that *became* connected again clears the rejection evidence,
      // so a later outage can request a fresh renewal. It must not clear on every
      // refresh: a rejected-but-still-connected page reports `connected` forever,
      // and clearing there would erase the only signal it ever produces.
      //
      // `attempted` follows the same rule. Resetting it on every refresh would let
      // a refused renewal (a revoked device also answers 401) retry forever.
      if (currentState !== next) {
        if (next === 'connected') { rejectedSince = undefined; attempted = false }
        cancelPending()
      }
    } else if (downSince === undefined) {
      downSince = Date.now()
      attempted = false
    }
    currentState = next
    if (reconnected && document.visibilityState === 'visible' && current()) onReconnected?.()
  }
  const updateBridge = (): void => {
    const next = page.__DSH_MOBILE_NATIVE__
    if (bridge === next) return
    cancelPending()
    bridge = next
    attempted = false
  }
  const renew = (manual = false): boolean => {
    if (!current()) { void dispose(); return false }
    updateState()
    updateBridge()
    const adapter = bridge
    const now = Date.now()
    // Two independent signals can justify one renewal: a transport that has been
    // down long enough, or an authenticated request the gateway just rejected.
    // The rejected case covers a Host restart, where the Session dies but the
    // live transport can still report `connected`.
    //
    const downLongEnough = downSince !== undefined && shouldRenewSession(currentState, now - downSince)
    const rejectionPending = rejectedSince !== undefined
    // The existing interval (or foreground event) can spend this one follow-up
    // only while the same transport is still down, never for an auth-only failure.
    const followUpDue = downLongEnough && retryAfter !== undefined && now >= retryAfter
    if (document.visibilityState !== 'visible' || adapter === undefined || pending !== undefined || credentialsRejected
      || (attempted && !manual && !followUpDue) || (!downLongEnough && !rejectionPending)) return false
    const isFollowUp = !manual && attempted
    const canScheduleFollowUp = !manual && !attempted && downLongEnough
    attempted = true
    retryAfter = undefined
    const owner = generation
    const abort = new AbortController()
    pendingAbort = abort
    // The attempt must still own the page, the adapter and the generation. It no
    // longer requires a disconnected transport, because the rejected case is
    // precisely the one where the transport still looks connected.
    const owns = (): boolean => current() && !abort.signal.aborted && generation === owner
      && page.__DSH_MOBILE_NATIVE__ === adapter
    let invokingRenewal = false
    const task = Promise.resolve().then(async () => {
      if (!owns()) return
      const capabilities = await adapter.capabilities()
      if (!owns() || !capabilities.includes('auth.renew')) return
      if (isFollowUp) {
        if (!isDisconnected(state.getSnapshot())) return
        if (document.visibilityState !== 'visible') {
          // Capability discovery can finish after the page went to the background.
          retryAfter = now
          return
        }
      }
      invokingRenewal = true
      const result = await adapter.invoke('auth.renew', {}, { signal: abort.signal })
      invokingRenewal = false
      if (!owns() || typeof result !== 'object' || result === null
        || !('renewed' in result) || result.renewed !== true) return
      rejectedSince = undefined
      connection.reconnect?.()
      if (current()) onRenewed?.()
    }).catch((error: unknown) => {
      if (!owns() || typeof error !== 'object' || error === null || !('code' in error)) return
      const code = error.code
      credentialsRejected = code === 'device_revoked' || code === 'device_expired' || code === 'authentication_failed'
      if (invokingRenewal && canScheduleFollowUp && code === 'transient' && isDisconnected(state.getSnapshot())) {
        retryAfter = Date.now() + TRANSIENT_RENEWAL_BACKOFF_MS
      }
    }).finally(() => {
      if (pending !== task) return
      pending = undefined
      pendingAbort = undefined
    })
    pending = task
    return true
  }
  const retry = (): boolean => {
    if (!current()) return false
    updateState()
    updateBridge()
    if (!current() || pending !== undefined || credentialsRejected || bridge === undefined
      || (rejectedSince === undefined && downSince === undefined)) return false
    return renew(true)
  }
  /**
   * Record a rejected authenticated request and try the same single renewal.
   *
   * Only an owner that is still current and has not already attempted may act, so
   * a burst of 401s cannot start parallel renewals, and a revoked device cannot
   * keep retrying: revocation arrives as 401 too, but the native bridge refuses
   * `auth.renew` and the attempt is not restarted.
   * @param status - HTTP status the gateway returned.
   */
  const rejected = (status: number): void => {
    if (!current()) return
    updateState()
    // The bridge can appear after the page booted (the App injects it), so refresh
    // it here before the attempt decides whether a renewal is possible at all.
    updateBridge()
    if (!shouldRenewAfterRejection(status, state.getSnapshot())) return
    rejectedSince ??= Date.now()
    renew()
  }
  const resume = (): void => {
    if (!current()) { void dispose(); return }
    updateState()
    updateBridge()
    if (shouldNudgeReconnect(document.visibilityState, currentState)) connection.reconnect?.()
    renew()
  }
  const stopState = state.subscribe(updateState)
  const timer = setInterval(renew, 2000)
  const pagehide = (): void => { void dispose() }
  const dispose = (): Promise<void> => {
    if (cleanup !== undefined) return cleanup
    disposed = true
    cancelPending()
    clearInterval(timer)
    stopState()
    document.removeEventListener('visibilitychange', resume)
    page.removeEventListener('dsh-mobile-native-ready', updateBridge)
    page.removeEventListener('pagehide', pagehide)
    cleanup = Promise.resolve(pending)
    return cleanup
  }
  document.addEventListener('visibilitychange', resume)
  page.addEventListener('dsh-mobile-native-ready', updateBridge)
  page.addEventListener('pagehide', pagehide)
  // Publish the rejection signal so the customization loader can hand a 401 to
  // this owner rather than starting a second renewal implementation.
  onRejected?.(rejected, retry)
  return dispose
}
