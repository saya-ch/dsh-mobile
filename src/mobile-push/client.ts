import type { PushConfig, PushEnrollment, PushEnrollmentResult, PushLocale, PushPreferences, PushSubscriptionData } from './contracts.js'
import { isPushInstallationId } from './installation-id.js'

export type MobilePushState = 'unsupported' | 'install' | 'denied' | 'ready' | 'pending' | 'failed' | 'enabled' | 'suspended' | 'disabled'
export interface MobilePushSnapshot { readonly state: MobilePushState; readonly error?: string; readonly preferences?: PushPreferences; readonly testInFlight?: boolean }
export interface MobilePushController {
  start(): void
  stop(): void
  refresh(): void
  enableFromGesture(): Promise<void>
  disable(): Promise<void>
  updatePreferences(value: PushPreferences): Promise<void>
  sendTest(): Promise<void>
  getSnapshot(): MobilePushSnapshot
  subscribe(listener: () => void): () => void
}
export interface MobilePushApiAdapter {
  /** Read config for this generated id; host auth must verify any returned canonical id is same-owner. The id is never authorization. */
  getConfig(installationId: string): Promise<PushConfig>
  enroll(value: PushEnrollment): Promise<PushEnrollmentResult>
  disable(value: { readonly installationId: string; readonly ifGeneration?: number }): Promise<void>
  updatePreferences(value: { readonly installationId: string; readonly ownerGeneration: number; readonly registrationGeneration: number; readonly preferences: PushPreferences }): Promise<void>
  sendTest(value: { readonly installationId: string; readonly ownerGeneration: number; readonly registrationGeneration: number }): Promise<void>
}
export interface BrowserPushSubscription {
  readonly endpoint: string
  readonly options: { readonly applicationServerKey?: ArrayBuffer | ArrayBufferView | null }
  toJSON(): PushSubscriptionData
  unsubscribe(): Promise<boolean>
}
export interface BrowserPushManager {
  getSubscription(): Promise<BrowserPushSubscription | null>
  subscribe(options: { readonly userVisibleOnly: true; readonly applicationServerKey: Uint8Array }): Promise<BrowserPushSubscription>
}
export interface MobilePushEnvironment {
  readonly secureContext: boolean
  readonly isTopLevel: boolean
  readonly standalone: boolean
  readonly permission: NotificationPermission | 'unsupported'
  readonly pushManager?: BrowserPushManager | undefined
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined
  readonly origin: string
  readonly randomUUID?: () => string
  readonly locale?: PushLocale
}
const ID_KEY = 'dsh-mobile-push-installation'
const defaults: PushPreferences = Object.freeze({ question: true, plan: true, approval: true, response: true, goal: true, failure: true })
function decodeKey(encoded: string): Uint8Array {
  const normalized = encoded.replace(/-/gu, '+').replace(/_/gu, '/')
  const raw = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  return Uint8Array.from(raw, char => char.charCodeAt(0))
}
function safeError(error: unknown): string {
  const value = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
  return value === 'stale_generation' ? 'push.error.stale' : 'push.error.generic'
}
function sameKey(subscription: BrowserPushSubscription, key: Uint8Array): boolean {
  const raw = subscription.options.applicationServerKey
  if (!raw) return false
  const bytes = new Uint8Array(raw instanceof ArrayBuffer ? raw : raw.buffer, raw instanceof ArrayBuffer ? 0 : raw.byteOffset, raw instanceof ArrayBuffer ? raw.byteLength : raw.byteLength)
  return bytes.length === key.length && bytes.every((value, index) => value === key[index])
}
/** Construct with a caller-owned authenticated API adapter and an explicit public window environment. */
export function createMobilePushController(api: MobilePushApiAdapter, environment: MobilePushEnvironment): MobilePushController {
  let snapshot: MobilePushSnapshot = Object.freeze({ state: 'unsupported' })
  const listeners = new Set<() => void>()
  let active = false
  let generation = 0
  let config: PushConfig | undefined
  let preparedKey: Uint8Array | undefined
  let existing: BrowserPushSubscription | null = null
  let preparedInstallId = ''
  let memoryInstallId = ''
  let mutationBusy = false
  // Call-scoped: a Test deliberately captures `attempt` without incrementing it (a Test never fences out
  // Disable), so this flag must never clear behind that fence. It clears when THIS call settles and still
  // owns the in-flight slot, or on stop() — which invalidates the slot so a stale Test cannot clear a newer one.
  let testInFlight = false
  let testOwner = 0
  let attempt = 0
  let ownedSubscription: BrowserPushSubscription | undefined
  let currentHostSubscription: BrowserPushSubscription | undefined
  const consentedSubscriptions = new WeakSet<BrowserPushSubscription>()
  const pendingEnrollments = new WeakMap<BrowserPushSubscription, Set<number>>()
  const trackPendingEnrollment = (subscription: BrowserPushSubscription, operation: number): void => {
    let pending = pendingEnrollments.get(subscription)
    if (!pending) { pending = new Set(); pendingEnrollments.set(subscription, pending) }
    pending.add(operation)
  }
  const finishPendingEnrollment = (subscription: BrowserPushSubscription, operation: number): void => {
    const pending = pendingEnrollments.get(subscription)
    pending?.delete(operation)
    if (pending?.size === 0) pendingEnrollments.delete(subscription)
  }
  const mayUnsubscribeCreatedSubscription = (subscription: BrowserPushSubscription): boolean =>
    !consentedSubscriptions.has(subscription) && (pendingEnrollments.get(subscription)?.size ?? 0) === 0
  const publish = (value: MobilePushSnapshot): void => {
    // The live in-flight flag attaches last so every snapshot reflects it, whatever else is published.
    snapshot = Object.freeze({ ...value, testInFlight })
    for (const listener of listeners) listener()
  }
  const current = (token: number): boolean => active && generation === token
  const getInstallationId = (): string => {
    if (memoryInstallId) return memoryInstallId
    try {
      const saved = environment.storage?.getItem(ID_KEY)
      // Only a Gateway-valid UUID survives; a malformed saved value regenerates one fresh id.
      if (isPushInstallationId(saved)) return memoryInstallId = saved
    } catch { /* Storage is optional; retain an in-memory installation id. */ }
    const fresh = environment.randomUUID?.() ?? globalThis.crypto?.randomUUID?.()
    if (!isPushInstallationId(fresh)) throw new Error('uuid unavailable')
    memoryInstallId = fresh
    try { environment.storage?.setItem(ID_KEY, fresh) } catch { /* Private browsing may deny writes. */ }
    return fresh
  }
  const detect = (): MobilePushState | undefined => {
    if (!environment.secureContext || !environment.isTopLevel || !environment.pushManager || environment.permission === 'unsupported') return 'unsupported'
    if (!environment.standalone) return 'install'
    if (environment.permission === 'denied') return 'denied'
    return undefined
  }
  const refresh = async (token: number): Promise<boolean> => {
    const blocked = detect()
    if (blocked) { if (current(token)) publish({ state: blocked }); return false }
    try {
      const requestedInstallId = getInstallationId()
      const [nextConfig, subscription] = await Promise.all([api.getConfig(requestedInstallId), environment.pushManager!.getSubscription()])
      if (!current(token)) return false
      config = nextConfig
      existing = subscription
      preparedInstallId = nextConfig.installationId || requestedInstallId
      memoryInstallId = preparedInstallId
      try { environment.storage?.setItem(ID_KEY, preparedInstallId) } catch { /* Canonical identity remains in memory when storage is unavailable. */ }
      preparedKey = nextConfig.publicKey ? decodeKey(nextConfig.publicKey) : undefined
      if (!nextConfig.available || !preparedKey) publish({ state: 'unsupported', preferences: nextConfig.preferences })
      else if (nextConfig.status === 'enabled') {
        if (subscription) { currentHostSubscription = subscription; consentedSubscriptions.add(subscription) }
        publish({ state: nextConfig.status, preferences: nextConfig.preferences })
      }
      else if (nextConfig.status === 'suspended') {
        if (subscription) { currentHostSubscription = subscription; consentedSubscriptions.add(subscription) }
        publish({ state: 'suspended', preferences: nextConfig.preferences })
      }
      else {
        if (nextConfig.status === 'disabled' && currentHostSubscription) {
          consentedSubscriptions.delete(currentHostSubscription)
          currentHostSubscription = undefined
        }
        publish({ state: 'ready', preferences: nextConfig.preferences })
      }
      return true
    } catch (error) { if (current(token)) publish({ state: 'failed', error: safeError(error) }); return false }
  }
  const refreshNow = (): void => { if (active) void refresh(generation) }
  return {
    start() { active = true; generation += 1; config = undefined; ownedSubscription = undefined; publish({ state: 'pending' }); refreshNow() },
    stop() {
      active = false; generation += 1; attempt += 1; mutationBusy = false
      testOwner += 1
      if (testInFlight) { testInFlight = false; publish({ ...snapshot }) }
      config = undefined; preparedKey = undefined; existing = null; ownedSubscription = undefined
    },
    refresh: refreshNow,
    async enableFromGesture() {
      if (!active || mutationBusy || (snapshot.state !== 'ready' && snapshot.state !== 'failed' && snapshot.state !== 'disabled') || !config || !preparedKey || !environment.pushManager) return
      const token = generation, operation = ++attempt, base = config
      mutationBusy = true; publish({ state: 'pending', preferences: base.preferences })
      let subscription = existing
      let created = false
      let pendingSubscription: BrowserPushSubscription | undefined
      try {
        if (subscription && !sameKey(subscription, preparedKey)) { publish({ state: 'failed', error: 'push.error.subscriptionConflict', preferences: base.preferences }); return }
        if (!subscription) { subscription = await environment.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: preparedKey }); created = true }
        if (created) ownedSubscription = subscription
        if (!current(token) || operation !== attempt) {
          if (created && mayUnsubscribeCreatedSubscription(subscription)) {
            const removed = await subscription.unsubscribe().catch(() => false)
            if (removed && ownedSubscription === subscription) ownedSubscription = undefined
          }
          return
        }
        trackPendingEnrollment(subscription, operation)
        pendingSubscription = subscription
        const browserSubscription = subscription.toJSON()
        const result = await api.enroll({
          installationId: preparedInstallId || base.installationId,
          subscription: { endpoint: browserSubscription.endpoint, keys: { p256dh: browserSubscription.keys.p256dh, auth: browserSubscription.keys.auth } },
          locale: environment.locale ?? 'en', preferences: base.preferences ?? defaults, keyFingerprint: base.keyFingerprint ?? '',
          ownerGeneration: base.ownerGeneration, registrationGeneration: base.registrationGeneration,
        })
        finishPendingEnrollment(subscription, operation)
        pendingSubscription = undefined
        if (!current(token) || operation !== attempt) {
          if (result.mutationGeneration !== undefined) await api.disable({ installationId: result.registration.installationId, ifGeneration: result.mutationGeneration }).catch(() => undefined)
          if (created && mayUnsubscribeCreatedSubscription(subscription)) {
            const removed = await subscription.unsubscribe().catch(() => false)
            if (removed && ownedSubscription === subscription) ownedSubscription = undefined
          }
          return
        }
        if (created) ownedSubscription = subscription
        consentedSubscriptions.add(subscription)
        currentHostSubscription = subscription
        if (result.registration.origin === environment.origin && result.registration.installationId) {
          memoryInstallId = result.registration.installationId
          preparedInstallId = memoryInstallId
          try { environment.storage?.setItem(ID_KEY, memoryInstallId) } catch { /* The host's canonical id remains usable for this page. */ }
        }
        config = { ...base, installationId: preparedInstallId || result.registration.installationId, registrationGeneration: result.registration.generation, status: result.registration.health === 'suspended' ? 'suspended' : 'enabled', preferences: result.registration.preferences }
        publish({ state: result.registration.health === 'suspended' ? 'suspended' : 'enabled', preferences: result.registration.preferences })
      } catch (error) {
        if (pendingSubscription) finishPendingEnrollment(pendingSubscription, operation)
        if (created && subscription && mayUnsubscribeCreatedSubscription(subscription)) {
          const removed = await subscription.unsubscribe().catch(() => false)
          if (removed && ownedSubscription === subscription) ownedSubscription = undefined
        }
        if (current(token) && operation === attempt) {
          const isStale = safeError(error) === 'push.error.stale'
          publish({ state: 'failed', error: safeError(error), preferences: base.preferences })
          if (isStale) void refresh(token)
        }
      } finally { if (current(token) && operation === attempt) mutationBusy = false }
    },
    async disable() {
      if (!active || !config) return
      const token = generation, operation = ++attempt, base = config
      mutationBusy = true; publish({ state: 'pending', preferences: base.preferences })
      try {
        await api.disable({ installationId: preparedInstallId || base.installationId })
        if (!current(token) || operation !== attempt) return
        config = { ...base, status: 'disabled' }; publish({ state: 'disabled', preferences: base.preferences })
        if (currentHostSubscription) consentedSubscriptions.delete(currentHostSubscription)
        currentHostSubscription = undefined
        const sub = ownedSubscription
        if (sub) {
          const removed = await sub.unsubscribe().catch(() => false)
          if (removed && ownedSubscription === sub) ownedSubscription = undefined
        }
        if (await refresh(token) && current(token) && operation === attempt && config?.status === 'disabled') {
          publish({ state: 'disabled', preferences: config.preferences })
        }
      } catch (error) {
        if (current(token) && operation === attempt) { publish({ state: 'failed', error: safeError(error), preferences: base.preferences }); if (safeError(error) === 'push.error.stale') void refresh(token) }
      } finally { if (current(token) && operation === attempt) mutationBusy = false }
    },
    async updatePreferences(value) {
      if (!active || !config || mutationBusy) return
      const token = generation, operation = ++attempt, base = config
      mutationBusy = true; publish({ state: 'pending', preferences: value })
      try {
        await api.updatePreferences({ installationId: preparedInstallId || base.installationId, ownerGeneration: base.ownerGeneration, registrationGeneration: base.registrationGeneration, preferences: value })
        if (current(token) && operation === attempt) {
          config = { ...base, preferences: value }
          publish({ state: base.status === 'enabled' ? 'enabled' : 'ready', preferences: value })
          // Read back the host's current guard generation; never replay the preference mutation.
          await refresh(token)
        }
      } catch (error) { if (current(token) && operation === attempt) { publish({ state: 'failed', error: safeError(error), preferences: base.preferences }); if (safeError(error) === 'push.error.stale') void refresh(token) } }
      finally { if (current(token) && operation === attempt) mutationBusy = false }
    },
    async sendTest() {
      if (!active || !config || config.status !== 'enabled' || mutationBusy || testInFlight) return
      const token = generation, operation = attempt, base = config
      const owner = ++testOwner
      testInFlight = true
      publish({ state: 'enabled', preferences: base.preferences })
      try {
        await api.sendTest({ installationId: preparedInstallId || base.installationId, ownerGeneration: base.ownerGeneration, registrationGeneration: base.registrationGeneration })
        if (current(token) && operation === attempt) publish({ state: 'enabled', error: 'push.test.accepted', preferences: base.preferences })
      } catch (error) {
        // Test feedback stays separate from consent truth: a failed or throttled Test never disables controls.
        if (!current(token) || operation !== attempt) return
        const message = (error as { readonly code?: unknown })?.code === 'rate_limited' ? 'push.test.rateLimited' : 'push.test.failed'
        // One read-only read-back reflects provider health settled by the Test; never a send or mutation retry.
        const refreshed = await refresh(token)
        if (!current(token) || operation !== attempt) return
        if (refreshed && config?.status === 'enabled') publish({ state: 'enabled', error: message, preferences: config.preferences })
        // Otherwise the read-back already published the truthful newer state (suspended, ready, …).
      } finally {
        // Clear and re-emit only while this call still owns the in-flight slot: a superseding
        // Disable/preferences/stop() keeps the fence from publishing results, and stop() has
        // invalidated the slot so a stale Test cannot clear a newer Test's flag.
        if (owner === testOwner) {
          testInFlight = false
          publish({ ...snapshot })
        }
      }
    },
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
/** Adapter factory uses only the page's public PushManager; it deliberately has no service-worker path. */
export function browserPushEnvironment(view: Window = window): MobilePushEnvironment {
  const nav = view.navigator as Navigator & { standalone?: boolean }
  const pushManager = (view as Window & { readonly pushManager?: BrowserPushManager }).pushManager
  const storage = (() => { try { return view.localStorage } catch { return undefined } })()
  const isInstalled = (): boolean => {
    try { return nav.standalone === true || view.matchMedia('(display-mode: standalone)').matches || view.matchMedia('(display-mode: fullscreen)').matches }
    catch { return nav.standalone === true }
  }
  return {
    secureContext: view.isSecureContext, isTopLevel: view.top === view.self,
    get standalone() { return isInstalled() },
    get permission() { return 'Notification' in view ? (view as Window & { readonly Notification: typeof Notification }).Notification.permission : 'unsupported' },
    pushManager, storage, origin: view.location.origin, randomUUID: () => view.crypto.randomUUID(),
    locale: view.document.documentElement.lang.toLowerCase().startsWith('zh') ? 'zh-CN' : view.document.documentElement.lang.toLowerCase().startsWith('it') ? 'it' : 'en',
  }
}
