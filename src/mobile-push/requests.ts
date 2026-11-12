import { ATTENTION_TTL_MS, REQUEST_SETTLE_MS } from './contracts.js'
import type { ContextLike, PublicAgentLike, PushCategory, PushReconcileResult, PushSource } from './contracts.js'
import { pushRootAgent } from './ownership.js'

type RequestRecord = { source: PushSource; settled: boolean; queuedReply: boolean; timed: boolean; timer?: ReturnType<typeof setTimeout> | undefined; live: boolean; disposeAbort?: (() => void) | undefined }
type Emit = (source: PushSource) => void

export class RequestLifetimes {
  readonly #records = new Map<string, RequestRecord>()
  readonly #byCall = new Map<string, RequestRecord>()
  readonly #clock: () => number
  readonly #emit: Emit
  readonly #ctx: ContextLike
  #closed = false

  constructor(ctx: ContextLike, emit: Emit, clock = Date.now) {
    this.#ctx = ctx
    this.#emit = emit
    this.#clock = clock
  }

  observeQuestion(agent: PublicAgentLike, request: any, next: () => Promise<unknown>): Promise<unknown> {
    const question = Array.isArray(request?.questions) ? request.questions[0] : undefined
    if (!question || !request?.signal?.aborted) {
      const intent = question?.intent
      const category: PushCategory = intent?.kind === 'plan-review' ? 'plan' : 'question'
      const callId = intent?.kind === 'plan-review' && typeof intent.callId === 'string'
        ? intent.callId
        : typeof request?.wait?.callId === 'string' ? request.wait.callId : undefined
      const sessionId = String(agent?.id ?? request?.agent?.id ?? '')
      const rec = sessionId ? this.#record(agent, sessionId, category, callId, request?.signal, ATTENTION_TTL_MS, request?.wait?.timed === true) : undefined
      if (rec) this.#arm(rec)
      // Cordis waterfall observers delegate once and preserve the exact result/error.
      return Promise.resolve().then(next).then(result => {
        if (rec && !(rec.timed && result && typeof result === 'object' && (result as any).pending === true)) {
          rec.settled = true
          rec.live = false
        }
        return result
      }, error => {
        if (rec && !(rec.timed && ['NO_PROVIDER', 'ASK_TIMED_OUT'].includes((error as any)?.code))) {
          rec.settled = true
          rec.live = false
        }
        throw error
      })
    }
    return Promise.resolve().then(next)
  }

  observeApproval(agent: PublicAgentLike, request: any, next: () => Promise<unknown>): Promise<unknown> {
    const sessionId = String(agent?.id ?? request?.agent?.id ?? '')
    const rec = !request?.signal?.aborted && sessionId
      ? this.#record(agent, sessionId, 'approval', request?.callId, request?.signal, ATTENTION_TTL_MS) : undefined
    if (rec) this.#arm(rec)
    return Promise.resolve().then(next).finally(() => { if (rec) { rec.settled = true; rec.live = false } })
  }

  queuedReply(sessionId: string, callId: string): void {
    const rec = this.#byCall.get(`${sessionId}\u0000${callId}`)
    if (rec) this.#invalidate(rec, true)
  }

  invalidateSession(sessionId: string, options: { readonly preserveTimed?: boolean } = {}): void {
    for (const rec of this.#records.values()) {
      if (rec.source.sessionId === sessionId && !(options.preserveTimed && rec.timed)) this.#invalidate(rec, false)
    }
  }

  reconcileLive(source: PushSource): PushReconcileResult {
    if (source.expiresAt <= this.#clock()) return 'stale'
    const rec = this.#records.get(source.sourceId)
    if (!rec) return 'unverifiable'
    if (this.#closed || rec.settled || rec.queuedReply || !rec.live) return 'stale'
    const timed = this.#callForSource(source)
    if (rec.timed && !timed) return 'unverifiable'
    if (!timed) return 'eligible' // legacy waits are verifiable only while their live request exists
    const state = this.#projection(source.sessionId)
    const view = state?.questions ?? state
    const active = Array.isArray(view?.active) ? view.active : []
    if (active.some((item: any) => item.callId === timed && (item.state === 'open' || item.state === 'continued'))) return 'eligible'
    if (rec.timed) return 'stale'
    const settled = Array.isArray(view?.settled) ? view.settled : []
    if (settled.some((item: any) => item.callId === timed)) return 'stale'
    // Legacy blocking waits are not reconstructed by the timed projection.
    return 'eligible'
  }

  eligible(source: PushSource): boolean { return this.reconcileLive(source) === 'eligible' }

  /** Retires expired records at their original TTL; returns how many were removed. */
  sweep(now: number = this.#clock()): number {
    let removed = 0
    for (const [sourceId, rec] of this.#records) {
      if (rec.source.expiresAt > now) continue
      this.#retire(rec)
      this.#records.delete(sourceId)
      removed += 1
    }
    return removed
  }

  close(): void {
    this.#closed = true
    for (const rec of this.#records.values()) this.#retire(rec)
    this.#records.clear()
    this.#byCall.clear()
  }

  #projection(sessionId: string): any {
    const session = this.#ctx.agents?.get?.(sessionId)?.session ?? { id: sessionId }
    return this.#ctx.sessionProjections?.stateOf?.(session, 'userQuestions')
  }
  #retire(rec: RequestRecord): void {
    if (rec.timer) { clearTimeout(rec.timer); rec.timer = undefined }
    rec.disposeAbort?.()
    rec.disposeAbort = undefined
    if (typeof rec.source.callId === 'string') {
      const key = `${rec.source.sessionId}\u0000${rec.source.callId}`
      // A newer same-call record may own the index now; only delete what still points at this record.
      if (this.#byCall.get(key) === rec) this.#byCall.delete(key)
    }
  }
  #invalidate(rec: RequestRecord, queuedReply: boolean): void {
    rec.settled = true
    rec.live = false
    if (queuedReply) rec.queuedReply = true
    if (rec.timer) clearTimeout(rec.timer)
    rec.timer = undefined
  }
  #callForSource(source: PushSource): string | undefined { return source.callId }
  #record(agent: PublicAgentLike, sessionId: string, category: PushCategory, callId: unknown, signal: AbortSignal | undefined, ttl: number, timed = false): RequestRecord {
    const createdAt = this.#clock()
    const opaque = typeof callId === 'string' && callId ? callId : `dispatch-${crypto.randomUUID()}`
    const sourceId = `request:${sessionId}:${category}:${opaque}`
    // A repeated observation of one call dedupes onto its existing record; the original expiry never moves forward.
    const existing = this.#records.get(sourceId)
    if (existing && existing.source.expiresAt > createdAt) return existing
    // The replaced record is expired: retire it so its abort listener and settle timer do not outlive it.
    if (existing) this.#retire(existing)
    let turn: number | undefined
    try {
      const boundary = this.#ctx.sessionProjections?.stateOf?.(agent.session ?? agent, 'turnBoundary') as any
      if (boundary?.openTurnStartSeq != null && Number.isSafeInteger(boundary?.lastTurn)) turn = boundary.lastTurn
    } catch { /* Missing projection evidence leaves the request source unscoped. */ }
    const source: PushSource = {
      sourceId, sessionId, targetSessionId: this.#root(agent).id, category: category as Exclude<PushCategory, 'test'>,
      createdAt, expiresAt: createdAt + ttl, lifetime: 'live', ...(turn === undefined ? {} : { turn }), ...(typeof callId === 'string' ? { callId } : {}),
    }
    const rec: RequestRecord = { source, settled: false, queuedReply: false, timed, live: true }
    this.#records.set(sourceId, rec)
    if (typeof callId === 'string') this.#byCall.set(`${sessionId}\u0000${callId}`, rec)
    const onAbort = () => {
      if (rec.timed && (signal?.reason as any)?.code === 'ASK_TIMED_OUT') return
      rec.settled = true
      rec.live = false
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    rec.disposeAbort = () => { try { signal?.removeEventListener('abort', onAbort) } catch { /* Detached signals need no listener cleanup. */ } }
    return rec
  }
  #root(agent: PublicAgentLike): PublicAgentLike {
    return pushRootAgent(this.#ctx.agents, agent)
  }
  #arm(rec: RequestRecord): void {
    if (rec.timer) return
    rec.timer = setTimeout(() => {
      rec.timer = undefined
      if (this.#closed || rec.settled || rec.queuedReply) return
      this.#emit(rec.source)
    }, REQUEST_SETTLE_MS)
  }
}
