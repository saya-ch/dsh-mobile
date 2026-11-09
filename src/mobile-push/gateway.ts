import type {
  PushConfig,
  PushEnrollment,
  PushEnrollmentResult,
  PushHost,
  PushMutationGuard,
  PushOwner,
  PushPreferences,
  PushRegistration,
  PushTarget,
  PushRecipientKey,
} from './contracts.js'
import type { PersistentDeviceAuthorization } from '../access.js'
import type { PushDelivery } from './delivery.js'
import type { PushRegistry } from './registry.js'
import { validatePushSubscription } from './endpoint.js'

/** Trusted per-Gateway binding; authorization is freshly loaded from durable device storage. */
export interface PushGatewayOriginBinding {
  readonly scopeId: string
  readonly origin: string
  readonly authorizedDevices: () => Promise<readonly PersistentDeviceAuthorization[]>
}

/** Authenticated Gateway facade; ownership fields are derived by trusted server code. */
export interface PushGatewayService {
  /** Attaches one exact scope/origin lane and returns its idempotent detach disposer. */
  attachOrigin?(binding: PushGatewayOriginBinding): () => void
  /** Persistently removes notification state after a durable device-auth removal. */
  invalidateDevices?(scopeId: string, deviceIds: readonly string[]): Promise<void>
  /** Explicit desktop-admin key reset; does not mutate pairing/device authorization. */
  reset?(): Promise<void>
  config(owner: PushOwner, installationId: string): Promise<PushConfig>
  enroll(owner: PushOwner, input: PushEnrollment): Promise<PushEnrollmentResult>
  preferences(
    owner: PushOwner,
    installationId: string,
    value: PushPreferences,
    guard: PushMutationGuard,
  ): Promise<PushRegistration>
  /** No generation is an unconditional owner disable; ifGeneration is stale-attempt cleanup only. */
  disable(owner: PushOwner, installationId: string, ifGeneration?: number): Promise<void>
  /** Explicit logout disables persistent consent before the session is cleared. */
  logout(owner: PushOwner): Promise<void>
  /** Resolves only an owned, still-valid opaque reference. */
  test(owner: PushOwner, installationId: string): Promise<void>
  resolve(owner: PushOwner, reference: string): Promise<PushTarget | undefined>
}

interface BoundOrigin {
  readonly binding: PushGatewayOriginBinding
  readonly detachDelivery: () => void
}

const ownerId = (owner: PushOwner): string => JSON.stringify([owner.scopeId, owner.deviceId, owner.origin])

/** One service shared by every Gateway while each Gateway owns a separate auth/origin attachment. */
export class PushGatewayCoordinator implements PushGatewayService {
  private readonly origins = new Map<string, BoundOrigin>()
  private closed = false

  constructor(
    private readonly host: PushHost,
    private readonly registry: PushRegistry,
    private readonly delivery: PushDelivery,
  ) {}

  attachOrigin(binding: PushGatewayOriginBinding): () => void {
    if (this.closed) return () => undefined
    if (!binding.scopeId || !binding.origin) throw new Error('push_origin_invalid')
    let parsed: URL
    try { parsed = new URL(binding.origin) } catch { throw new Error('push_origin_invalid') }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== binding.origin
      || parsed.username !== '' || parsed.password !== '' || parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      throw new Error('push_origin_invalid')
    }
    const id = JSON.stringify([binding.scopeId, binding.origin])
    if (this.origins.has(id)) throw new Error('push_origin_already_attached')
    const detachDelivery = this.delivery.attachOrigin(binding)
    const row = { binding, detachDelivery }
    this.origins.set(id, row)
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.origins.get(id) === row) this.origins.delete(id)
      detachDelivery()
    }
  }

  async invalidateDevices(scopeId: string, deviceIds: readonly string[]): Promise<void> {
    await this.delivery.invalidateDevices(scopeId, deviceIds)
  }

  async reset(): Promise<void> {
    await this.registry.resetKeys()
  }

  async config(owner: PushOwner, installationId: string): Promise<PushConfig> {
    const authorized = await this.authorize(owner)
    const config = await this.registry.config(owner, installationId)
    return { ...config, available: config.available && this.host.available && authorized }
  }

  async enroll(owner: PushOwner, input: PushEnrollment): Promise<PushEnrollmentResult> {
    if (!this.host.available) throw new Error('push_unavailable')
    await this.authorize(owner)
    let subscription
    try { subscription = validatePushSubscription(input.subscription) }
    catch (error) { throw new Error(error instanceof Error ? error.message : 'push_subscription_invalid') }
    return this.registry.upsert(owner, { ...input, subscription })
  }

  async preferences(
    owner: PushOwner,
    installationId: string,
    value: PushPreferences,
    guard: PushMutationGuard,
  ): Promise<PushRegistration> {
    await this.authorize(owner)
    return this.registry.preferences({ ...owner, installationId }, value, guard)
  }

  async disable(owner: PushOwner, installationId: string, ifGeneration?: number): Promise<void> {
    await this.authorize(owner)
    await this.registry.disable({ ...owner, installationId }, ifGeneration)
  }

  async logout(owner: PushOwner): Promise<void> {
    await this.authorize(owner)
    await this.registry.disableOwner(owner)
  }

  async test(owner: PushOwner, installationId: string): Promise<void> {
    if (!this.host.available) throw new Error('push_unavailable')
    await this.authorize(owner)
    await this.delivery.test({ ...owner, installationId })
  }

  async resolve(owner: PushOwner, reference: string): Promise<PushTarget | undefined> {
    if (!this.host.available || !await this.authorize(owner, true)) return undefined
    return this.delivery.resolve(owner, reference)
  }

  /** Close only this service's origin attachments; its owning plugin closes shared Delivery/Host/Registry. */
  close(): void {
    if (this.closed) return
    this.closed = true
    for (const row of this.origins.values()) row.detachDelivery()
    this.origins.clear()
  }

  private async authorize(owner: PushOwner, neutralMissing = false): Promise<boolean> {
    const row = this.origins.get(JSON.stringify([owner.scopeId, owner.origin]))
    if (!row) {
      if (neutralMissing) return false
      throw new Error('push_unavailable')
    }
    let devices: readonly PersistentDeviceAuthorization[]
    try { devices = await row.binding.authorizedDevices() } catch { throw new Error('push_unavailable') }
    if (!devices.some(device => device.id === owner.deviceId && device.expiresAt > Date.now())) {
      if (neutralMissing) return false
      throw new Error('push_unauthorized')
    }
    return true
  }
}
