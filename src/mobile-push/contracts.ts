import type { ZodType } from 'zod'

export type PushCategory = 'question' | 'plan' | 'approval' | 'response' | 'goal' | 'failure' | 'test'
export type PushPreferences = Readonly<Record<Exclude<PushCategory, 'test'>, boolean>>
export type PushLocale = 'en' | 'zh-CN' | 'it'
export interface VapidKeys { readonly publicKey: string; readonly privateKey: string }
export interface PushMutationGuard { readonly ownerGeneration: number; readonly registrationGeneration: number }
export interface PushSource {
  readonly sourceId: string
  readonly sessionId: string
  readonly targetSessionId: string
  readonly category: Exclude<PushCategory, 'test'>
  readonly createdAt: number
  readonly expiresAt: number
  readonly lifetime: 'live' | 'projected' | 'committed'
  readonly turn?: number
  readonly callId?: string
  readonly goal?: { readonly id: string; readonly revision: number }
}
export interface PushOwner { readonly scopeId: string; readonly deviceId: string; readonly origin: string }
export interface PushRecipientKey extends PushOwner { readonly installationId: string }
export interface PushSubscriptionData {
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
}
export interface PushRegistration extends PushRecipientKey {
  readonly subscription: PushSubscriptionData
  readonly locale: PushLocale
  readonly preferences: PushPreferences
  readonly generation: number
  readonly keyFingerprint: string
  readonly enabled: boolean
  readonly health: 'ready' | 'suspended' | 'repair-required'
}
export interface PushIntent {
  readonly id: string
  readonly key: PushRecipientKey
  readonly source: PushSource
  readonly ownerGeneration: number
  readonly recipientGeneration: number
  readonly attempts: number
  readonly nextAttemptAt: number
}
export interface PushReceipt { readonly sourceId: string; readonly key: PushRecipientKey; readonly recipientGeneration: number; readonly expiresAt: number }
export interface PushTapReference { readonly reference: string; readonly key: PushRecipientKey; readonly source: PushSource; readonly expiresAt: number }
export interface PushSnapshot {
  readonly version: 1
  readonly keys?: VapidKeys & { readonly fingerprint: string }
  readonly ownerGenerations: readonly (PushOwner & { readonly generation: number })[]
  readonly ownerGenerationFloor?: number
  readonly registrations: readonly PushRegistration[]
  readonly pending: readonly PushIntent[]
  readonly receipts: readonly PushReceipt[]
  readonly references: readonly PushTapReference[]
}
export interface PushTarget { readonly sessionId: string; readonly interaction: 'current' | 'resolved' }
export type PushReconcileResult = 'eligible' | 'stale' | 'unverifiable'
export interface PushHost {
  readonly available: boolean
  subscribe(onSource: (source: PushSource) => void, onChange: (sessionId: string) => void): () => void
  reconcile(source: PushSource): Promise<PushReconcileResult>
  eligible(source: PushSource): Promise<boolean>
  /** Checks stored Session existence via a read-only public observation; never creates or wakes an Agent. */
  sessionExists(sessionId: string): Promise<boolean>
  resolveTarget(source: PushSource): Promise<PushTarget | undefined>
  close(): Promise<void>
}
export interface PushEnrollment extends PushMutationGuard {
  readonly installationId: string
  readonly subscription: PushSubscriptionData
  readonly locale: PushLocale
  readonly preferences: PushPreferences
  readonly keyFingerprint: string
}
export interface PushEnrollmentResult { readonly registration: PushRegistration; readonly mutationGeneration?: number }
export interface PushConfig {
  readonly available: boolean
  readonly publicKey?: string
  readonly keyFingerprint?: string
  readonly installationId: string
  readonly ownerGeneration: number
  readonly registrationGeneration: number
  readonly status: 'disabled' | 'enabled' | 'suspended' | 'repair-required'
  readonly preferences: PushPreferences
}

export const REQUEST_SETTLE_MS = 250
export const OUTCOME_COALESCE_MS = 1_000
export const ATTENTION_TTL_MS = 300_000
export const OUTCOME_TTL_MS = 1_800_000
export const MAX_REGISTRATIONS_PER_DEVICE = 4
export const MAX_REGISTRATIONS_PER_SCOPE = 256
export const MAX_PENDING_PER_SCOPE = 256
export const MAX_CONCURRENT_SENDS = 4
export const MAX_ATTEMPTS = 3
export const ATTEMPT_TIMEOUT_MS = 10_000
export const MAX_PUSH_BODY_BYTES = 16_384
export const MAX_PAYLOAD_BYTES = 3_072

export interface PublicInboxLike {
  readonly nextTurn?: readonly unknown[]
  readonly nextStep?: readonly unknown[]
}
export interface PublicAgentLike {
  readonly id: string
  readonly session?: { readonly id?: string; readonly header?: { readonly parentSession?: string } }
  readonly inbox?: PublicInboxLike
}
export interface PublicProjectionDefinition<State = unknown, Wire = unknown> {
  readonly key: string
  readonly stateSchema: ZodType<State>
  init(header: unknown, inheritedEventCount: number): State
  apply(state: State, event: unknown): State
  readonly wire: { readonly viewSchema: ZodType<Wire>; readonly view: (state: State) => Wire }
  readonly stateVersion: number
}
export interface PublicProjectionSnapshot {
  readonly asOfSeq: number
  readonly values: Record<string, unknown>
}
export interface PublicSessionObservation {
  readonly source: 'live' | 'prepared'
  readonly projections?: PublicProjectionSnapshot
  [Symbol.dispose](): void
}
export interface PublicEventContext {
  on(event: string, listener: (...args: any[]) => unknown, options?: boolean | { readonly prepend?: boolean; readonly global?: boolean }): (() => void) | void
  userQuestions?: Record<string, unknown>
  approval?: Record<string, unknown>
  sessionProjections?: {
    stateOf?: (session: unknown, key: string) => unknown
    snapshot?: (session: unknown) => PublicProjectionSnapshot
    register?: <State, Wire>(definition: PublicProjectionDefinition<State, Wire>) => () => void
  }
  sessionQuery?: {
    observeSession?: (id: string, options: { readonly projectionMode: 'all'; readonly signal?: AbortSignal }) => Promise<PublicSessionObservation>
  }
  agents?: {
    get?: (id: string) => PublicAgentLike | undefined
    list?: () => PublicAgentLike[]
    roots?: () => PublicAgentLike[]
    isOwnedBy?: (id: string, owner: PublicAgentLike) => boolean
  }
}
/** Public structural context keeps the adapter optional on older DSH runtimes. */
export type ContextLike = PublicEventContext
