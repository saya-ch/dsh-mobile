import { OUTCOME_COALESCE_MS, OUTCOME_TTL_MS } from './contracts.js'
import type { ContextLike, PublicAgentLike, PushReconcileResult, PushSource } from './contracts.js'
import { isPushRuntimeChild, pushRootAgent } from './ownership.js'

type Candidate = { source: PushSource; timer?: ReturnType<typeof setTimeout> | undefined; active: boolean }
type Emit = (source: PushSource) => void
const isCompletedGoalPhase = (phase: string | undefined): boolean => phase === 'complete'

export class OutcomeLifetimes {
  readonly #ctx: ContextLike
  readonly #emit: Emit
  readonly #pending = new Map<string, Candidate>()
  readonly #goals = new Map<string, { id: string; revision: number; phase: string }>()
  readonly #blockedTurns = new Map<string, { id: string; revision: number; turn: number }>()
  readonly #sent = new Map<string, number>()
  #closed = false

  constructor(ctx: ContextLike, emit: Emit) { this.#ctx = ctx; this.#emit = emit }

  onGoal(payload: any): void {
    const agent: PublicAgentLike | undefined = payload?.agent
    const change = payload?.change
    const goal = change?.goal
    const op = change?.operation
    if (!agent?.id || !change) return
    this.#cancel(agent.id)
    if (op === 'clear' || !goal) {
      this.#goals.delete(agent.id)
      return
    }
    const id = String(goal.id ?? change?.ref?.id ?? '')
    const revision = Number(goal.revision ?? change?.ref?.revision)
    if (!id || !Number.isFinite(revision)) return
    const record = { id, revision, phase: String(goal.phase ?? op ?? '') }
    this.#goals.set(agent.id, record)
    // `goal/changed` follows its durable goal/change append. Active continuation
    // rounds suppress ordinary responses; completed goals wait for turn/end.
    if (op === 'block') {
      const boundary = this.#ctx.sessionProjections?.stateOf?.(agent.session ?? agent, 'turnBoundary') as any
      const turn = boundary?.openTurnStartSeq != null && Number.isSafeInteger(boundary?.lastTurn) ? boundary.lastTurn as number : undefined
      if (turn !== undefined) this.#blockedTurns.set(agent.id, { id, revision, turn })
      this.#schedule(agent, 'goal', turn, { id, revision })
    }
  }

  onSessionEvent(session: PublicAgentLike, event: any): void {
    const type = event?.type
    const data = event?.data ?? event
    if (!session?.id || !data) return
    const id = session.id
    if (type === 'agent/inbox/inserted' || type === 'agent/inbox/spliced' || type === 'turn/start') {
      this.#cancel(id)
      return
    }
    if (type !== 'turn/end') return
    const reason = data.reason?.kind
    const blockedTurn = this.#blockedTurns.get(id)
    const closesBlockedTurn = blockedTurn?.turn === data.turn
    if (closesBlockedTurn) this.#blockedTurns.delete(id)
    if (closesBlockedTurn && ['completed', 'blocked', 'error'].includes(reason)) return
    if (reason === 'completed') {
      const observedGoal = this.#goals.get(id)
      const activeGoal = observedGoal?.phase === 'active' ? observedGoal : this.#projectedActiveGoal(session)
      if (observedGoal && isCompletedGoalPhase(observedGoal.phase)) {
        this.#schedule(session, 'goal', data.turn, { id: observedGoal.id, revision: observedGoal.revision })
        this.#goals.delete(id)
      } else if (!activeGoal) this.#schedule(session, 'response', data.turn)
    } else if (reason === 'blocked' || reason === 'error') {
      this.#schedule(session, 'failure', data.turn)
    }
    // aborted/user, max-tokens, interrupted, forked are intentionally silent.
  }

  #projectedActiveGoal(session: PublicAgentLike): { id: string; revision: number; phase: 'active' } | undefined {
    const state = this.#ctx.sessionProjections?.stateOf?.(session.session ?? session, 'goal') as any
    const goal = state?.current?.goal
    if (!goal || typeof goal.id !== 'string' || !Number.isSafeInteger(goal.revision) || goal.phase !== 'active') return undefined
    return { id: goal.id, revision: goal.revision, phase: 'active' }
  }

  onAgentError(_payload: unknown): void {
    // Agent errors are diagnostics. Only a live committed turn/end error is actionable.
  }

  reconcileLive(source: PushSource): PushReconcileResult {
    if (source.expiresAt <= Date.now()) return 'stale'
    if (this.#closed) return 'stale'
    const candidate = this.#pending.get(source.sourceId)
    if (!candidate) return 'unverifiable'
    return candidate.active ? 'eligible' : 'stale'
  }

  eligible(source: PushSource): boolean { return this.reconcileLive(source) === 'eligible' }

  /** Retires expired candidates and sent-dedupe records at their original TTL; returns how many were removed. */
  sweep(now: number = Date.now()): number {
    let removed = 0
    for (const [id, candidate] of this.#pending) {
      if (candidate.source.expiresAt > now) continue
      if (candidate.timer) { clearTimeout(candidate.timer); candidate.timer = undefined }
      this.#pending.delete(id)
      removed += 1
    }
    for (const [id, expiresAt] of this.#sent) {
      if (expiresAt > now) continue
      this.#sent.delete(id)
      removed += 1
    }
    return removed
  }

  close(): void {
    this.#closed = true
    for (const item of this.#pending.values()) if (item.timer) clearTimeout(item.timer)
    this.#pending.clear()
    this.#blockedTurns.clear()
    this.#goals.clear()
    this.#sent.clear()
  }

  #schedule(agent: PublicAgentLike, category: PushSource['category'], turn?: number, goal?: { id: string; revision: number }): void {
    if (this.#closed || this.#isRuntimeChild(agent)) return
    const createdAt = Date.now()
    const goalKey = goal ? `${goal.id}:${goal.revision}` : ''
    const sourceId = `${category}:${agent.id}:${turn ?? 'goal'}:${goalKey}`
    if (this.#sent.has(sourceId) || this.#pending.has(sourceId)) return
    const source: PushSource = {
      sourceId, sessionId: agent.id, targetSessionId: this.#root(agent).id, category,
      createdAt, expiresAt: createdAt + OUTCOME_TTL_MS, lifetime: 'committed',
      ...(turn === undefined ? {} : { turn }), ...(goal === undefined ? {} : { goal }),
    }
    const candidate: Candidate = { source, active: true }
    candidate.timer = setTimeout(() => {
      candidate.timer = undefined
      if (this.#closed || !candidate.active) return
      // Sent records keep their original expiry; the maintenance sweep reclaims them, not a per-record timer.
      this.#sent.set(sourceId, source.expiresAt)
      this.#emit(source)
    }, OUTCOME_COALESCE_MS)
    this.#pending.set(sourceId, candidate)
  }

  #cancel(sessionId: string): void {
    this.#blockedTurns.delete(sessionId)
    for (const [id, candidate] of this.#pending) {
      if (candidate.source.sessionId !== sessionId) continue
      clearTimeout(candidate.timer)
      candidate.active = false
      this.#pending.delete(id)
    }
  }
  #isRuntimeChild(agent: PublicAgentLike): boolean {
    return isPushRuntimeChild(this.#ctx.agents, agent)
  }
  #root(agent: PublicAgentLike): PublicAgentLike {
    return pushRootAgent(this.#ctx.agents, agent)
  }
}
