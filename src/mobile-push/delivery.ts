import { randomBytes, randomUUID } from 'node:crypto'
import {
  ATTEMPT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  MAX_CONCURRENT_SENDS,
  MAX_PENDING_PER_SCOPE,
  type PushIntent,
  type PushOwner,
  type PushPreferences,
  type PushReceipt,
  type PushRecipientKey,
  type PushRegistration,
  type PushReconcileResult,
  type PushSnapshot,
  type PushSource,
  type PushTarget,
  type VapidKeys,
} from './contracts.js'
import { buildDeclarativePayload } from './payload.js'
import type { PushRegistry } from './registry.js'
import { pruneOrphanedDeferrals } from './retention.js'
import { PushSender, type PushSendResult } from './sender.js'
import type { PushHost } from './contracts.js'

const RECONCILE_INTERVAL_MS = 30_000
const RETRY_BACKOFF_MS = [1_000, 5_000] as const
const MAX_RECEIPTS_PER_SCOPE = 1_024
const MAX_REFERENCES_PER_SCOPE = 1_024
const MAX_TEST_QUEUE = 64
const TEST_RATE_LIMIT_MS = 60_000
const UNVERIFIABLE_RECHECK_MS = 30_000

type AuthorizedDevice = Readonly<{ id: string; expiresAt: number }>
type OriginInput = Readonly<{
  scopeId: string
  origin: string
  authorizedDevices: () => Promise<readonly AuthorizedDevice[]>
}>
type Origin = OriginInput & { active: boolean; generation: number }
type GuardResult = 'allowed' | 'denied' | 'unverifiable'
type Work =
  | { kind: 'intent'; intent: PushIntent }
  | { kind: 'test'; key: PushRecipientKey; resolve: () => void; reject: (error: Error) => void }

export interface PushDeliveryOptions {
  readonly host: PushHost
  readonly registry: PushRegistry
  readonly sender: PushSender
  readonly now?: () => number
}

function ownerId(value: PushOwner): string { return JSON.stringify([value.scopeId, value.deviceId, value.origin]) }
function keyId(value: PushRecipientKey): string { return JSON.stringify([value.scopeId, value.deviceId, value.origin, value.installationId]) }
function sameKey(a: PushRecipientKey, b: PushRecipientKey): boolean { return keyId(a) === keyId(b) }
function sourceId(source: PushSource, key: PushRecipientKey): string { return `${source.sourceId}\u0000${keyId(key)}` }
function isPreferenceEnabled(preferences: PushPreferences, category: PushSource['category']): boolean { return preferences[category] === true }
function pendingHas(snapshot: PushSnapshot, intent: PushIntent): boolean { return snapshot.pending.some(item => item.id === intent.id && sameKey(item.key, intent.key)) }
function recipientCurrent(snapshot: PushSnapshot, intent: PushIntent): boolean {
  const registration = snapshot.registrations.find(row => sameKey(row, intent.key))
  return !!registration && registration.enabled && registration.health === 'ready'
    && registration.generation === intent.recipientGeneration && registration.keyFingerprint === snapshot.keys?.fingerprint
    && isPreferenceEnabled(registration.preferences, intent.source.category)
}
function boundedSnapshot(snapshot: PushSnapshot, now: number): PushSnapshot {
  return {
    ...snapshot,
    pending: snapshot.pending.filter(item => item.source.expiresAt > now),
    receipts: snapshot.receipts.filter(item => item.expiresAt > now),
    references: snapshot.references.filter(item => item.expiresAt > now),
  }
}
function uniqueIds(items: readonly { readonly id: string }[]): Set<string> { return new Set(items.map(item => item.id)) }

/** Coordinates bounded, consent-checked delivery while all durable writes remain registry-owned. */
export class PushDelivery {
  readonly #host: PushHost
  readonly #registry: PushRegistry
  readonly #sender: PushSender
  readonly #now: () => number
  readonly #origins = new Map<string, Origin>()
  readonly #inFlight = new Map<string, { controller: AbortController; key: PushRecipientKey; origin: Origin }>()
  readonly #inFlightIds = new Set<string>()
  readonly #tasks = new Set<Promise<void>>()
  readonly #tests: Array<Extract<Work, { kind: 'test' }>> = []
  readonly #testAttempts = new Map<string, number>()
  readonly #deferredUntil = new Map<string, number>()
  readonly #purgeTasks = new Map<string, Promise<void>>()
  #writeQueue: Promise<void> = Promise.resolve()
  #unsubscribe: (() => void) | undefined
  #interval: ReturnType<typeof setInterval> | undefined
  #wakeTimer: ReturnType<typeof setTimeout> | undefined
  #started = false
  #closed = false
  #admitting = true
  #pumping = false
  #active = 0

  constructor(options: PushDeliveryOptions) {
    this.#host = options.host
    this.#registry = options.registry
    this.#sender = options.sender
    this.#now = options.now ?? Date.now
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('push delivery is closed')
    if (this.#started) return
    this.#started = true
    this.#unsubscribe = this.#host.subscribe(
      source => this.observe(source),
      sessionId => { void this.#reconcileSession(sessionId).catch(() => undefined) },
    )
    await this.#reconcileKnownScopes()
    await this.#reconcilePending()
    if (this.#closed) return
    this.#interval = setInterval(() => { void this.#periodicReconcile().catch(() => undefined) }, RECONCILE_INTERVAL_MS)
    this.#kick()
  }

  /** Nonblocking host-observer boundary: admission and durable outbox writes happen later. */
  observe(source: PushSource): void {
    if (!this.#admitting || !this.#started || this.#closed) return
    void this.#admit(source).catch(() => { /* Observer failures never escape into Host execution. */ })
  }

  attachOrigin(input: OriginInput): () => void {
    if (this.#closed) return () => undefined
    const id = this.#originId(input)
    const previous = this.#origins.get(id)
    if (previous?.active) {
      previous.active = false
      previous.generation += 1
      for (const work of this.#inFlight.values()) if (work.origin === previous) work.controller.abort()
    }
    const origin: Origin = { ...input, active: true, generation: (previous?.generation ?? 0) + 1 }
    this.#origins.set(id, origin)
    // Re-attachment is a state change: intents deferred while this origin was detached may deliver now.
    this.#clearOriginDeferrals(origin)
    this.#kick()
    return () => {
      if (!origin.active || this.#origins.get(id) !== origin) return
      origin.active = false
      origin.generation += 1
      for (const work of this.#inFlight.values()) {
        if (work.origin === origin) work.controller.abort()
      }
    }
  }

  async invalidateDevices(scopeId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0 || this.#closed) return
    const selected = new Set(ids)
    for (const work of this.#inFlight.values()) {
      if (work.key.scopeId === scopeId && selected.has(work.key.deviceId)) work.controller.abort()
    }
    await this.#purgeDevices(scopeId, ids)
    this.#kick()
  }

  async test(key: PushRecipientKey): Promise<void> {
    if (!this.#started || this.#closed || this.#tests.length >= MAX_TEST_QUEUE) throw new Error('push_test_unavailable')
    const identity = keyId(key)
    const now = this.#now()
    const last = this.#testAttempts.get(identity)
    if (last !== undefined && now - last < TEST_RATE_LIMIT_MS) throw new Error('push_test_rate_limited')
    this.#testAttempts.set(identity, now)
    while (this.#testAttempts.size > 512) this.#testAttempts.delete(this.#testAttempts.keys().next().value as string)
    return new Promise<void>((resolve, reject) => {
      this.#tests.push({ kind: 'test', key: { ...key }, resolve, reject })
      this.#kick()
    })
  }

  async resolve(owner: PushOwner, reference: string): Promise<PushTarget | undefined> {
    if (this.#closed || !reference) return undefined
    let snapshot: PushSnapshot
    try { snapshot = this.#registry.snapshot() } catch { return undefined }
    const row = snapshot.references.find(item => item.reference === reference && ownerId(item.key) === ownerId(owner) && item.expiresAt > this.#now())
    if (!row || row.source.expiresAt <= this.#now()) return undefined
    const origin = this.#originFor(row.key)
    if (!origin?.active || await this.#guardKey(row.key, row.source, origin, true) !== 'allowed') return undefined
    try {
      if (!await this.#host.sessionExists(row.source.targetSessionId)) return undefined
      return await this.#host.resolveTarget(row.source)
    } catch { return undefined }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#admitting = false
    this.#closed = true
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    if (this.#interval) clearInterval(this.#interval)
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer)
    this.#interval = undefined
    this.#wakeTimer = undefined
    for (const work of this.#inFlight.values()) work.controller.abort()
    for (const item of this.#tests.splice(0)) item.reject(new Error('push_test_unavailable'))
    await Promise.allSettled([...this.#tasks])
    await this.#writeQueue
    await Promise.allSettled([...new Set(this.#purgeTasks.values())])
    this.#deferredUntil.clear()
    for (const origin of this.#origins.values()) origin.active = false
    this.#origins.clear()
  }

  async #admit(source: PushSource): Promise<void> {
    if (!this.#admitting || source.expiresAt <= this.#now()) return
    let eligible = false
    try { eligible = this.#host.available && await this.#host.eligible(source) } catch { eligible = false }
    if (!eligible || source.expiresAt <= this.#now()) return
    for (const origin of this.#origins.values()) {
      if (!origin.active || this.#closed) continue
      const devices = await this.#readAuthorized(origin)
      if (!devices || !this.#admitting || this.#closed || !origin.active || this.#origins.get(this.#originId(origin)) !== origin) continue
      let snapshot: PushSnapshot
      try { snapshot = this.#registry.snapshot() } catch { return }
      const registrations = snapshot.registrations.filter(reg => reg.scopeId === origin.scopeId && reg.origin === origin.origin
        && devices.has(reg.deviceId) && reg.enabled && reg.health === 'ready' && isPreferenceEnabled(reg.preferences, source.category)
        && snapshot.keys?.fingerprint === reg.keyFingerprint)
      if (registrations.length === 0) continue
      await this.#write(current => {
        const clean = boundedSnapshot(current, this.#now())
        if (!this.#admitting || this.#closed || !origin.active || this.#origins.get(this.#originId(origin)) !== origin) return clean
        const pending = [...clean.pending]
        for (const registration of registrations) {
          const key: PushRecipientKey = { scopeId: registration.scopeId, deviceId: registration.deviceId, origin: registration.origin, installationId: registration.installationId }
          const currentRegistration = clean.registrations.find(row => sameKey(row, key))
          if (!currentRegistration || !currentRegistration.enabled || currentRegistration.health !== 'ready'
            || currentRegistration.generation !== registration.generation || currentRegistration.keyFingerprint !== registration.keyFingerprint
            || clean.keys?.fingerprint !== currentRegistration.keyFingerprint || !isPreferenceEnabled(currentRegistration.preferences, source.category)) continue
          if (clean.receipts.some(item => item.sourceId === source.sourceId && sameKey(item.key, key))) continue
          if (pending.some(item => item.source.sourceId === source.sourceId && sameKey(item.key, key))) continue
          const count = pending.filter(item => item.key.scopeId === origin.scopeId).length
          if (count >= MAX_PENDING_PER_SCOPE) continue
          pending.push({
            id: randomUUID(), key, source: structuredClone(source),
            ownerGeneration: current.ownerGenerations.find(row => ownerId(row) === ownerId(key))?.generation ?? 0,
            recipientGeneration: registration.generation,
            attempts: 0, nextAttemptAt: this.#now(),
          })
        }
        return { ...clean, pending }
      })
    }
    this.#kick()
  }

  async #reconcileKnownScopes(): Promise<void> {
    let snapshot: PushSnapshot
    try { snapshot = this.#registry.snapshot() } catch { return }
    const scopes = new Set<string>([
      ...snapshot.ownerGenerations.map(row => row.scopeId),
      ...snapshot.registrations.map(row => row.scopeId),
      ...snapshot.pending.map(row => row.key.scopeId),
      ...snapshot.receipts.map(row => row.key.scopeId),
      ...snapshot.references.map(row => row.key.scopeId),
      ...[...this.#origins.values()].map(row => row.scopeId),
    ])
    for (const scopeId of scopes) {
      if (this.#closed) return
      const scopeOrigins = [...this.#origins.values()].filter(row => row.scopeId === scopeId)
      const origin = scopeOrigins.find(row => row.active) ?? scopeOrigins[0]
      if (!origin) continue
      const authorized = await this.#readAuthorized(origin)
      if (this.#closed) return
      if (!authorized) continue
      const current = this.#registry.snapshot()
      const candidates = new Set<string>()
      for (const row of current.ownerGenerations) if (row.scopeId === scopeId) candidates.add(row.deviceId)
      for (const row of current.registrations) if (row.scopeId === scopeId) candidates.add(row.deviceId)
      for (const row of current.pending) if (row.key.scopeId === scopeId) candidates.add(row.key.deviceId)
      for (const row of current.receipts) if (row.key.scopeId === scopeId) candidates.add(row.key.deviceId)
      for (const row of current.references) if (row.key.scopeId === scopeId) candidates.add(row.key.deviceId)
      const removed = [...candidates].filter(id => !authorized.has(id))
      if (removed.length) await this.#purgeDevices(scopeId, removed)
    }
  }

  async #purgeDevices(scopeId: string, ids: readonly string[]): Promise<void> {
    const waiting: Promise<void>[] = []
    const fresh: string[] = []
    for (const id of new Set(ids)) {
      const key = JSON.stringify([scopeId, id])
      const ongoing = this.#purgeTasks.get(key)
      if (ongoing) waiting.push(ongoing)
      else fresh.push(id)
    }
    if (fresh.length) {
      const task = this.#registry.purgeDevices(scopeId, fresh)
      for (const id of fresh) this.#purgeTasks.set(JSON.stringify([scopeId, id]), task)
      const release = () => { for (const id of fresh) if (this.#purgeTasks.get(JSON.stringify([scopeId, id])) === task) this.#purgeTasks.delete(JSON.stringify([scopeId, id])) }
      void task.then(release, release)
      waiting.push(task)
    }
    await Promise.all(waiting)
  }

  async #reconcilePending(): Promise<void> {
    let snapshot: PushSnapshot
    try { snapshot = this.#registry.snapshot() } catch { return }
    for (const intent of snapshot.pending) {
      if (this.#closed) return
      if (intent.source.expiresAt <= this.#now()) { await this.#removeIntent(intent); continue }
      const duplicate = snapshot.receipts.some(row => row.sourceId === intent.source.sourceId && sameKey(row.key, intent.key))
      if (duplicate) { await this.#removePending(intent); continue }
      const guard = await this.#sourceGuard(intent.source)
      if (this.#closed) return
      // Transient uncertainty keeps durable work for the existing bounded recheck; only proof-backed denial drops it.
      if (guard === 'denied') await this.#removeIntent(intent)
      else if (guard === 'unverifiable') this.#defer(intent)
    }
  }

  async #periodicReconcile(): Promise<void> {
    if (this.#closed) return
    this.#pruneDeferred()
    await this.#reconcileKnownScopes()
    await this.#reconcilePending()
    this.#kick()
  }

  async #reconcileSession(sessionId: string): Promise<void> {
    if (this.#closed) return
    let snapshot: PushSnapshot
    try { snapshot = this.#registry.snapshot() } catch { return }
    for (const intent of snapshot.pending) {
      if (intent.source.sessionId !== sessionId) continue
      const guard = await this.#sourceGuard(intent.source)
      if (this.#closed) return
      if (guard === 'denied') await this.#removeIntent(intent)
      else if (guard === 'unverifiable') this.#defer(intent)
    }
    this.#kick()
  }

  #kick(): void {
    if (!this.#started || this.#closed || this.#pumping) return
    this.#pumping = true
    void this.#pump().finally(() => {
      this.#pumping = false
      this.#scheduleWake()
    })
  }

  async #pump(): Promise<void> {
    while (!this.#closed && this.#active < MAX_CONCURRENT_SENDS) {
      const test = this.#tests.shift()
      if (test) {
        this.#launchTest(test)
        continue
      }
      let intents: readonly PushIntent[]
      try { intents = this.#registry.snapshot().pending } catch { return }
      const now = this.#now()
      const intent = [...intents]
        .filter(item => item.nextAttemptAt <= now && !this.#inFlightIds.has(item.id) && (this.#deferredUntil.get(item.id) ?? 0) <= now)
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.source.createdAt - b.source.createdAt)[0]
      if (!intent) return
      this.#deferredUntil.delete(intent.id)
      this.#launchIntent(intent)
    }
  }

  #launchIntent(intent: PushIntent): void {
    this.#active += 1
    this.#inFlightIds.add(intent.id)
    const task = this.#sendIntent(intent).catch(() => { this.#defer(intent) }).finally(() => {
      this.#inFlightIds.delete(intent.id)
      this.#inFlight.delete(intent.id)
      this.#active -= 1
      this.#kick()
    })
    this.#tasks.add(task)
    void task.finally(() => this.#tasks.delete(task))
  }

  #launchTest(work: Extract<Work, { kind: 'test' }>): void {
    this.#active += 1
    const task = this.#sendTest(work).catch(() => undefined).finally(() => {
      this.#active -= 1
      this.#kick()
    })
    this.#tasks.add(task)
    void task.finally(() => this.#tasks.delete(task))
  }

  async #sendIntent(intent: PushIntent): Promise<void> {
    if (this.#closed) return
    const origin = this.#originFor(intent.key)
    if (!origin || this.#originDetached(origin)) { this.#defer(intent); return }
    const initial = await this.#guard(intent, origin)
    if (initial === 'denied') { await this.#denyOrDefer(intent, origin); return }
    if (initial === 'unverifiable') { this.#defer(intent); return }
    const setup = await this.#ensureReference(intent)
    if (!setup) return
    const { registration, keys, reference } = setup
    const controller = new AbortController()
    this.#inFlight.set(intent.id, { controller, key: intent.key, origin })
    if (this.#closed) controller.abort()
    const remaining = Math.floor((intent.source.expiresAt - this.#now()) / 1000)
    if (remaining < 1) { await this.#removeIntent(intent); return }
    const payload = buildDeclarativePayload(intent.source.category, registration.locale, `/?mobile-push=${reference}`, intent.source.sourceId.replace(/[^A-Za-z0-9._:-]/gu, '_').slice(0, 128) || 'push')
    let result: PushSendResult
    try {
      result = await this.#sender.send({
        registration, payload, ttlSeconds: Math.min(remaining, 1_800), subject: origin.origin, keys, signal: controller.signal,
        beforeRequest: async signal => signal.aborted || controller.signal.aborted ? false : await this.#guard(intent, origin) === 'allowed',
      })
    } catch {
      result = { kind: 'retry' }
    }
    if (this.#closed) return
    // A provider-accepted send is terminal: settle (or drop if the recipient is no longer current)
    // without a further guard — deferring here could re-send a notification the provider already has.
    if (result.kind === 'accepted') { await this.#settleIntent(intent, result); return }
    if (result.kind === 'cancelled') {
      const current = await this.#guard(intent, origin)
      if (current === 'denied') await this.#denyOrDefer(intent, origin)
      else if (current === 'unverifiable') this.#defer(intent)
      // Still-allowed cancellation is an admission-budget miss, not new permission: bounded retry accounting applies.
      else await this.#settleIntent(intent, { kind: 'retry' })
      return
    }
    const current = await this.#guard(intent, origin)
    if (current === 'denied') { await this.#denyOrDefer(intent, origin); return }
    if (current === 'unverifiable') { this.#defer(intent); return }
    await this.#settleIntent(intent, result)
  }

  async #sendTest(work: Extract<Work, { kind: 'test' }>): Promise<void> {
    if (this.#closed) { work.reject(new Error('push_test_unavailable')); return }
    const origin = this.#originFor(work.key)
    if (!origin) { work.reject(new Error('push_test_unavailable')); return }
    const fakeSource: PushSource = {
      sourceId: `test:${randomUUID()}`, sessionId: '', targetSessionId: '', category: 'response',
      createdAt: this.#now(), expiresAt: this.#now() + 60_000, lifetime: 'committed',
    }
    const guard = await this.#guardKey(work.key, fakeSource, origin, false)
    if (guard !== 'allowed') { work.reject(new Error('push_test_unavailable')); return }
    let snapshot: PushSnapshot
    try { snapshot = this.#registry.snapshot() } catch { work.reject(new Error('push_test_unavailable')); return }
    const registration = snapshot.registrations.find(row => sameKey(row, work.key))
    const keys = snapshot.keys
    if (!registration || !keys) { work.reject(new Error('push_test_unavailable')); return }
    // A Test notification has no source Session: it navigates to the bare same-origin app root
    // with no mobile-push reference, so a tap can never hit the resolver or a fabricated target.
    const controller = new AbortController()
    const workId = `test:${randomUUID()}`
    this.#inFlight.set(workId, { controller, key: work.key, origin })
    let result: PushSendResult
    try {
      result = await this.#sender.send({
        registration,
        payload: buildDeclarativePayload('test', registration.locale, '/', `test-${randomUUID()}`),
        ttlSeconds: 60, subject: origin.origin, keys, signal: controller.signal,
        beforeRequest: async signal => !signal.aborted && !controller.signal.aborted && await this.#guardKey(work.key, fakeSource, origin, false, registration.generation) === 'allowed',
      })
    } catch {
      result = { kind: 'retry' }
    } finally {
      this.#inFlight.delete(workId)
    }
    // A dead or suspended provider subscription settles only the captured generation before failure reporting.
    if (!this.#closed && (result.kind === 'gone' || result.kind === 'suspended')) {
      try { await this.#registry.settleRecipient(work.key, registration.generation, result.kind) } catch { /* Settlement failure still rejects the Test. */ }
    }
    const finalGuard = result.kind === 'accepted' && !this.#closed
      ? await this.#guardKey(work.key, fakeSource, origin, false, registration.generation)
      : 'denied'
    if (result.kind === 'accepted' && finalGuard === 'allowed' && !this.#closed) work.resolve()
    // Every non-accepted Test rejects generically (finalGuard is 'denied' for all of them); no per-kind error contract exists.
    else work.reject(new Error('push_test_unavailable'))
  }

  async #guard(intent: PushIntent, origin: Origin): Promise<GuardResult> {
    return this.#guardKey(intent.key, intent.source, origin, true, intent.recipientGeneration)
  }

  /** Maps the Host tri-state for durable-work decisions; boolean eligible() would collapse transient uncertainty into denial. */
  async #sourceGuard(source: PushSource): Promise<GuardResult> {
    if (!this.#host.available) return 'unverifiable'
    let result: PushReconcileResult
    try { result = await this.#host.reconcile(source) } catch { return 'unverifiable' }
    if (result === 'eligible') return 'allowed'
    if (result === 'stale') return 'denied'
    // Returned plan/approval/callId-less-question uncertainty is deliberately non-reconstructible cold proof.
    if (source.category === 'plan' || source.category === 'approval' || (source.category === 'question' && typeof source.callId !== 'string')) return 'denied'
    return 'unverifiable'
  }

  async #guardKey(key: PushRecipientKey, source: PushSource, origin: Origin, requireEligible: boolean, expectedGeneration?: number): Promise<GuardResult> {
    const epoch = origin.generation
    if (this.#closed || !origin.active || this.#origins.get(this.#originId(origin)) !== origin || source.expiresAt <= this.#now()) return 'denied'
    if (!this.#host.available) return 'unverifiable'
    let first: PushRegistration | undefined
    try { first = this.#registration(key) } catch { return 'unverifiable' }
    if (!first || !first.enabled || first.health !== 'ready' || (expectedGeneration !== undefined && first.generation !== expectedGeneration)
      || (requireEligible && !isPreferenceEnabled(first.preferences, source.category))) return 'denied'
    if (requireEligible) {
      const guard = await this.#sourceGuard(source)
      if (guard === 'denied') return 'denied'
      if (guard === 'unverifiable') return 'unverifiable'
    }
    const auth = await this.#readAuthorized(origin)
    if (!auth) return 'unverifiable'
    const device = auth.get(key.deviceId)
    if (!device || device.expiresAt <= this.#now()) return 'denied'
    if (this.#closed || !origin.active || origin.generation !== epoch || this.#origins.get(this.#originId(origin)) !== origin || source.expiresAt <= this.#now()) return 'denied'
    let latest: PushRegistration | undefined
    let latestFingerprint: string | undefined
    try { latest = this.#registration(key); latestFingerprint = this.#registry.snapshot().keys?.fingerprint } catch { return 'unverifiable' }
    if (!latest || !latest.enabled || latest.health !== 'ready' || latest.generation !== first.generation
      || latest.keyFingerprint !== first.keyFingerprint || latestFingerprint !== latest.keyFingerprint
      || (expectedGeneration !== undefined && latest.generation !== expectedGeneration)
      || (requireEligible && !isPreferenceEnabled(latest.preferences, source.category))) return 'denied'
    return 'allowed'
  }

  async #ensureReference(intent: PushIntent): Promise<{ registration: PushRegistration; keys: VapidKeys; reference: string } | undefined> {
    let reference = ''
    let registration: PushRegistration | undefined
    let keys: VapidKeys | undefined
    try {
      await this.#write(snapshot => {
        const clean = boundedSnapshot(snapshot, this.#now())
        if (!pendingHas(clean, intent)) return clean
        registration = clean.registrations.find(row => sameKey(row, intent.key) && row.generation === intent.recipientGeneration)
        keys = clean.keys
        if (!registration || !keys) return clean
        const old = clean.references.find(row => row.source.sourceId === intent.source.sourceId && sameKey(row.key, intent.key) && row.expiresAt > this.#now())
        reference = old?.reference ?? randomBytes(24).toString('base64url')
        if (!old) {
          const rows = clean.references.filter(row => row.key.scopeId !== intent.key.scopeId)
          const sameScope = clean.references.filter(row => row.key.scopeId === intent.key.scopeId)
          const kept = sameScope.slice(-(MAX_REFERENCES_PER_SCOPE - 1))
          return { ...clean, references: [...rows, ...kept, { reference, key: intent.key, source: structuredClone(intent.source), expiresAt: intent.source.expiresAt }] }
        }
        return clean
      })
    } catch { this.#defer(intent); return undefined }
    return registration && keys && reference ? { registration, keys, reference } : undefined
  }

  async #settleIntent(intent: PushIntent, result: PushSendResult): Promise<void> {
    if (result.kind === 'accepted') {
      await this.#write(snapshot => {
        const clean = boundedSnapshot(snapshot, this.#now())
        if (!pendingHas(clean, intent) || intent.source.expiresAt <= this.#now()) return clean
        if (!recipientCurrent(clean, intent)) return {
          ...clean,
          pending: clean.pending.filter(row => row.id !== intent.id),
          references: clean.references.filter(row => !(row.source.sourceId === intent.source.sourceId && sameKey(row.key, intent.key))),
        }
        const duplicate = clean.receipts.some(row => row.sourceId === intent.source.sourceId && sameKey(row.key, intent.key))
        const rows = clean.receipts.filter(row => row.key.scopeId !== intent.key.scopeId)
        const sameScope = clean.receipts.filter(row => row.key.scopeId === intent.key.scopeId)
        const receipt: PushReceipt = { sourceId: intent.source.sourceId, key: intent.key, recipientGeneration: intent.recipientGeneration, expiresAt: intent.source.expiresAt }
        const receipts = duplicate ? clean.receipts : [...rows, ...sameScope.slice(-(MAX_RECEIPTS_PER_SCOPE - 1)), receipt]
        return { ...clean, pending: clean.pending.filter(row => row.id !== intent.id), receipts }
      })
      return
    }
    if (result.kind === 'gone' || result.kind === 'suspended') {
      await this.#registry.settleRecipient(intent.key, intent.recipientGeneration, result.kind)
      await this.#removeIntent(intent)
      return
    }
    if (result.kind === 'permanent') { await this.#removeIntent(intent); return }
    if (result.kind !== 'retry') { await this.#removeIntent(intent); return }
    const attempt = intent.attempts + 1
    const remainingMs = intent.source.expiresAt - this.#now()
    if (attempt >= MAX_ATTEMPTS || remainingMs <= 0) { await this.#removeIntent(intent); return }
    const retryAfter = result.retryAfterMs
    const backoff = RETRY_BACKOFF_MS[attempt - 1] ?? 5_000
    const delay = Number.isFinite(retryAfter) && retryAfter! >= 0 ? retryAfter! : backoff
    if (delay >= remainingMs) { await this.#removeIntent(intent); return }
    await this.#write(snapshot => {
      const clean = boundedSnapshot(snapshot, this.#now())
      if (!pendingHas(clean, intent)) return clean
      if (!recipientCurrent(clean, intent)) return {
        ...clean,
        pending: clean.pending.filter(row => row.id !== intent.id),
        references: clean.references.filter(row => !(row.source.sourceId === intent.source.sourceId && sameKey(row.key, intent.key))),
      }
      return { ...clean, pending: clean.pending.map(row => row.id === intent.id ? { ...row, attempts: attempt, nextAttemptAt: this.#now() + delay } : row) }
    })
  }

  async #removePending(intent: PushIntent): Promise<void> {
    await this.#write(snapshot => ({
      ...boundedSnapshot(snapshot, this.#now()),
      pending: snapshot.pending.filter(row => row.id !== intent.id),
    }))
  }

  async #removeIntent(intent: PushIntent): Promise<void> {
    await this.#write(snapshot => ({
      ...boundedSnapshot(snapshot, this.#now()),
      pending: snapshot.pending.filter(row => row.id !== intent.id),
      references: snapshot.references.filter(row => !(row.source.sourceId === intent.source.sourceId && sameKey(row.key, intent.key))),
    }))
  }

  #defer(intent: PushIntent): void {
    this.#deferredUntil.set(intent.id, this.#now() + UNVERIFIABLE_RECHECK_MS)
  }

  /** Defer keys live only as long as their owning pending intent survives every removal path. */
  #pruneDeferred(): void {
    let pending: readonly PushIntent[]
    try { pending = this.#registry.snapshot().pending } catch { return }
    pruneOrphanedDeferrals(this.#deferredUntil, pending)
  }

  async #readAuthorized(origin: Origin): Promise<Map<string, AuthorizedDevice> | undefined> {
    try {
      const rows = await origin.authorizedDevices()
      if (!Array.isArray(rows)) return undefined
      const result = new Map<string, AuthorizedDevice>()
      for (const row of rows) {
        if (!row || typeof row.id !== 'string' || row.id.length === 0 || !Number.isFinite(row.expiresAt)) return undefined
        result.set(row.id, row)
      }
      return result
    } catch { return undefined }
  }

  #registration(key: PushRecipientKey): PushRegistration | undefined {
    const snapshot = this.#registry.snapshot()
    const registration = snapshot.registrations.find(row => sameKey(row, key))
    if (!registration || snapshot.keys?.fingerprint !== registration.keyFingerprint) return undefined
    return registration
  }

  #originFor(key: PushOwner): Origin | undefined { return this.#origins.get(JSON.stringify([key.scopeId, key.origin])) }
  #originId(origin: Pick<OriginInput, 'scopeId' | 'origin'>): string { return JSON.stringify([origin.scopeId, origin.origin]) }
  /** True when the origin object is inactive or has been replaced — a transient state, never authorization evidence. */
  #originDetached(origin: Origin): boolean { return !origin.active || this.#origins.get(this.#originId(origin)) !== origin }
  /** Defers rather than removes when the denial could stem from origin state; removal stays reserved for authorization-backed denial. */
  async #denyOrDefer(intent: PushIntent, origin: Origin): Promise<void> {
    if (this.#originDetached(origin)) this.#defer(intent)
    else await this.#removeIntent(intent)
  }
  #clearOriginDeferrals(origin: Origin): void {
    if (this.#deferredUntil.size === 0) return
    let pending: readonly PushIntent[]
    try { pending = this.#registry.snapshot().pending } catch { return }
    for (const intent of pending) {
      if (intent.key.scopeId === origin.scopeId && intent.key.origin === origin.origin) this.#deferredUntil.delete(intent.id)
    }
  }

  #write(update: (snapshot: PushSnapshot) => PushSnapshot): Promise<void> {
    const operation = this.#writeQueue.then(() => this.#registry.transact(snapshot => update(boundedSnapshot(snapshot, this.#now()))))
    this.#writeQueue = operation.catch(() => undefined)
    return operation
  }

  #scheduleWake(): void {
    if (this.#closed) return
    if (this.#wakeTimer) clearTimeout(this.#wakeTimer)
    this.#wakeTimer = undefined
    this.#pruneDeferred()
    let nextAt = Number.POSITIVE_INFINITY
    try {
      for (const intent of this.#registry.snapshot().pending) {
        if (this.#inFlightIds.has(intent.id)) continue
        nextAt = Math.min(nextAt, Math.max(intent.nextAttemptAt, this.#deferredUntil.get(intent.id) ?? 0))
      }
    } catch { return }
    if (this.#tests.length) nextAt = this.#now()
    if (!Number.isFinite(nextAt)) return
    const delay = Math.max(0, nextAt - this.#now())
    this.#wakeTimer = setTimeout(() => { this.#wakeTimer = undefined; this.#kick() }, delay)
  }
}
