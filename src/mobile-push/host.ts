import { RequestLifetimes } from './requests.js'
import { OutcomeLifetimes } from './outcomes.js'
import { PushReconciler } from './reconcile.js'
import type { ContextLike, PublicAgentLike, PublicSessionObservation, PushHost, PushReconcileResult, PushSource } from './contracts.js'

function hasContract(ctx: ContextLike): boolean {
  return typeof ctx.on === 'function'
    && typeof ctx.sessionProjections?.stateOf === 'function'
    && typeof ctx.sessionProjections.snapshot === 'function'
    && typeof ctx.sessionProjections.register === 'function'
    && typeof ctx.sessionQuery?.observeSession === 'function'
    && typeof ctx.agents?.get === 'function'
    && typeof ctx.agents.list === 'function'
    && ctx.userQuestions !== undefined && ctx.approval !== undefined
  }

const MAINTENANCE_INTERVAL_MS = 30_000

export function createPushHost(ctx: ContextLike): PushHost {
  let available = hasContract(ctx)
  const reconciler = new PushReconciler(ctx)
  let lifecycleProjectionDisposer: (() => void) | undefined
  const subscribers = new Set<(source: PushSource) => void>()
  const changeSubscribers = new Set<(sessionId: string) => void>()
  const disposers: Array<() => void> = []
  let questionDisposer: (() => void) | undefined
  let approvalDisposer: (() => void) | undefined
  const add = (source: PushSource): void => {
    if (closed || !available) return
    for (const callback of subscribers) {
      try { callback(source) } catch { /* Notification side effects are isolated from host work. */ }
    }
  }
  const requests = new RequestLifetimes(ctx, add)
  const outcomes = new OutcomeLifetimes(ctx, add)
  let closed = false
  // Lifetime reclamation is bounded by each record's original TTL plus at most one maintenance interval.
  const maintenanceTimer: ReturnType<typeof setInterval> | undefined = available
    ? setInterval(() => {
      try { requests.sweep(); outcomes.sweep() } catch { /* Maintenance never propagates into host work. */ }
    }, MAINTENANCE_INTERVAL_MS)
    : undefined
  if (available) {
    try { lifecycleProjectionDisposer = reconciler.registerProjection() } catch { available = false }
  }
  const disposeLifecycleProjection = (): void => {
    const dispose = lifecycleProjectionDisposer
    lifecycleProjectionDisposer = undefined
    try { dispose?.() } catch { /* A failed projection lease makes reconciliation unavailable. */ }
  }

  const register = (event: string, listener: (...args: any[]) => unknown, prepend = false): (() => void) | undefined => {
    try {
      const dispose = ctx.on(event, listener, { global: true, ...(prepend ? { prepend: true } : {}) })
      return typeof dispose === 'function' ? dispose : undefined
    } catch { return undefined }
  }
  const questionObserver = function (this: PublicAgentLike, request: any, next: () => Promise<unknown>) {
    return requests.observeQuestion(request?.agent ?? this, request, next)
  }
  const approvalObserver = function (this: PublicAgentLike, request: any, next: () => Promise<unknown>) {
    return requests.observeApproval(request?.agent ?? this, request, next)
  }
  const refreshWaterfallObservers = (): boolean => {
    questionDisposer?.()
    approvalDisposer?.()
    questionDisposer = undefined
    approvalDisposer = undefined
    const question = register('user-questions/request', questionObserver, true)
    const approval = register('approval/request', approvalObserver, true)
    if (!question || !approval) {
      try { question?.() } catch { /* Partial registration is rolled back. */ }
      try { approval?.() } catch { /* Partial registration is rolled back. */ }
      available = false
      return false
    }
    questionDisposer = question
    approvalDisposer = approval
    return true
  }
  const listen = (event: string, listener: (...args: any[]) => unknown): boolean => {
    const dispose = register(event, listener)
    if (!dispose) return false
    disposers.push(dispose)
    return true
  }
  const disable = (): void => {
    available = false
    disposeLifecycleProjection()
    questionDisposer?.()
    approvalDisposer?.()
    questionDisposer = undefined
    approvalDisposer = undefined
  }

  if (available && refreshWaterfallObservers()) {
    const agentCreated = listen('agent/created', () => {
      // Factory setup has completed before this public event. Re-registering
      // each global waterfall observer at prepend places it ahead of answerers
      // composed by this new Agent, without accumulating duplicate listeners.
      if (!refreshWaterfallObservers()) disable()
    })
    const sessionEvents = listen('session/event', (session: PublicAgentLike, event: any) => {
      if (event?.type === 'turn/start' || event?.type === 'agent/inbox/inserted' || event?.type === 'agent/inbox/spliced') requests.invalidateSession(session.id, { preserveTimed: true })
      outcomes.onSessionEvent(session, event)
      if (event?.type === 'user/message' && event?.data?.source?.kind === 'user-question-reply') {
        requests.queuedReply(session.id, event.data.source.callId)
      }
      for (const callback of changeSubscribers) {
        try { callback(session.id) } catch { /* Consumer callbacks are not host policy. */ }
      }
    })
    const goalEvents = listen('goal/changed', (payload: any) => {
      outcomes.onGoal(payload)
      const id = payload?.agent?.id
      if (id) for (const callback of changeSubscribers) {
        try { callback(id) } catch { /* Consumer callbacks are not host policy. */ }
      }
    })
    if (!agentCreated || !sessionEvents || !goalEvents) disable()
    listen('agent/inbox/inserted', (payload: any) => {
      const agent = payload?.agent
      const message = payload?.message
      if (agent?.id && message?.source?.kind === 'user-question-reply' && typeof message.source.callId === 'string') {
        requests.queuedReply(agent.id, message.source.callId)
      }
      if (agent?.id) {
        requests.invalidateSession(agent.id, { preserveTimed: true })
        outcomes.onSessionEvent(agent, { type: 'agent/inbox/inserted' })
      }
    })
    listen('agent/error', payload => outcomes.onAgentError(payload))
    listen('agent/aborted', (payload: any) => {
      const id = payload?.agent?.id
      if (id) {
        requests.invalidateSession(id)
        outcomes.onSessionEvent(payload.agent, { type: 'turn/end', data: { turn: payload.turn, reason: { kind: 'aborted', reason: payload.reason } } })
      }
    })
  } else disable()

  const reconcile = async (source: PushSource): Promise<PushReconcileResult> => {
    if (source.expiresAt <= Date.now()) return 'stale'
    if (!available || closed) return 'unverifiable'
    const liveProof = source.category === 'question' || source.category === 'plan' || source.category === 'approval'
      ? requests.reconcileLive(source)
      : outcomes.reconcileLive(source)
    return reconciler.reconcile(source, liveProof)
  }

  return {
    get available() { return available },
    subscribe(onSource, onChange) {
      if (closed) return () => undefined
      subscribers.add(onSource)
      changeSubscribers.add(onChange)
      return () => { subscribers.delete(onSource); changeSubscribers.delete(onChange) }
    },
    reconcile,
    async eligible(source) { return await reconcile(source) === 'eligible' },
    async sessionExists(sessionId) {
      if (!available || closed || !sessionId) return false
      let observation: PublicSessionObservation | undefined
      let exists = false
      try {
        observation = await ctx.sessionQuery?.observeSession?.(sessionId, { projectionMode: 'all' })
        exists = observation !== undefined
      } catch { exists = false }
      finally {
        try { observation?.[Symbol.dispose]() } catch { exists = false }
      }
      return exists && available && !closed
    },
    async resolveTarget(source) {
      if (!available) return undefined
      const current = ctx.agents?.get?.(source.targetSessionId)
      return current ? { sessionId: current.id, interaction: 'current' } : { sessionId: source.targetSessionId, interaction: 'resolved' }
    },
    async close() {
      if (closed) return
      closed = true
      if (maintenanceTimer) clearInterval(maintenanceTimer)
      subscribers.clear()
      changeSubscribers.clear()
      requests.close()
      outcomes.close()
      questionDisposer?.()
      approvalDisposer?.()
      questionDisposer = undefined
      approvalDisposer = undefined
      for (const dispose of disposers.splice(0)) {
        try { dispose() } catch { /* Detachment must not throw through plugin disposal. */ }
      }
      disposeLifecycleProjection()
    },
  }
}
