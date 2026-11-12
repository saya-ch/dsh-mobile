import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPushHost } from '../src/mobile-push/host.js'
import { REQUEST_SETTLE_MS } from '../src/mobile-push/contracts.js'
import type { ContextLike, PublicAgentLike, PushHost, PushSource } from '../src/mobile-push/contracts.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(close => close())) })

type Listener = (...args: any[]) => unknown
function context(overrides: Partial<ContextLike> = {}) {
  const listeners = new Map<string, Listener[]>()
  const emitted: PushSource[] = []
  const changed: string[] = []
  let host: PushHost | undefined
  const defaultProjections = {
    stateOf: () => undefined,
    snapshot: () => ({ asOfSeq: 0, values: { userQuestions: { active: [], settled: [] }, inbox: { 'next-turn': [], 'next-step': [] }, goal: null, mobilePushLifecycle: { latestTurn: 0, openTurn: null, lastTurnEnd: null, latestGoalChange: null } } }),
    register: () => () => undefined,
  }
  const ctx: ContextLike = {
    on(event, listener, options){
      const current = listeners.get(event) ?? []
      if (typeof options === 'object' && options.prepend) current.unshift(listener)
      else current.push(listener)
      listeners.set(event, current)
      return () => listeners.set(event, current.filter(item => item !== listener))
    },
    userQuestions: { pending: () => [] },
    approval: {},
    agents: { get: () => undefined, list: () => [], roots: () => [], isOwnedBy: () => false },
    ...overrides,
    sessionProjections: { ...defaultProjections, ...overrides.sessionProjections },
    sessionQuery: { observeSession: async () => ({ source: 'prepared', projections: { asOfSeq: 0, values: defaultProjections.snapshot().values }, [Symbol.dispose]: () => undefined }), ...overrides.sessionQuery },
  }
  return {
    ctx,
    emitted,
    changed,
    emit(event: string, ...args: unknown[]) {
      const chain = [...(listeners.get(event) ?? [])]
      if (event === 'user-questions/request' || event === 'approval/request') {
        const next = args.pop() as (...values: unknown[]) => unknown
        const receiver = args[0] && typeof args[0] === 'object' ? args[0] : undefined
        const invoke = (index: number): unknown => chain[index]
          ? chain[index]!.apply(receiver, [...args, () => invoke(index + 1)])
          : next(...args)
        return invoke(0)
      }
      let result: unknown
      for (const listener of chain) result = listener.apply(args[0] && typeof args[0] === 'object' ? args[0] : undefined, args)
      return result
    },
    listenerCount(event: string) { return listeners.get(event)?.length ?? 0 },
    start(hostContext: ContextLike = ctx) {
      if (!host) {
        host = createPushHost(hostContext)
        cleanups.push(() => host!.close())
        host.subscribe(source => emitted.push(source), id => changed.push(id))
      }
      return host
    },
  }
}

const agent = (id: string, parentSession?: string) => ({ id, session: { id, header: parentSession ? { parentSession } : {} } })
const questionRequest = (id: string, extra: Record<string, unknown> = {}) => ({
  questions: [{ id: 'q1', question: 'Continue?', ...(extra.intent ? { intent: extra.intent } : {}) }],
  agent: agent(id), signal: new AbortController().signal, ...extra,
})

describe('public host lifecycle', () => {
  it('delegates exactly once and preserves answer/error/abort', async () => {
    const h = context(); h.start()
    const answer = { answers: [{ id: 'q1', selected: ['Yes'] }] }
    const next = vi.fn(async () => answer)
    const outcome = await h.emit('user-questions/request', questionRequest('s1'), next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(outcome).toBe(answer)
    const error = new Error('source failure')
    const failing = vi.fn(async () => { throw error })
    await expect(h.emit('user-questions/request', questionRequest('s2'), failing)).rejects.toBe(error)
    expect(failing).toHaveBeenCalledTimes(1)
  })

  it('ignores audit-only never/unavailable decisions', async () => {
    const h = context(); h.start()
    h.emit('session/event', agent('s1'), { type: 'approval/asked', data: { id: 'audit' } })
    h.emit('session/event', agent('s1'), { type: 'approval/decided', data: { id: 'audit', outcome: 'unavailable' } })
    expect(h.emitted).toHaveLength(0)
    const outcome = await h.emit('approval/request', { agent: agent('s1'), toolName: 'write', signal: new AbortController().signal }, async () => 'unavailable')
    expect(outcome).toBe('unavailable')
    expect(h.emitted).toHaveLength(0)
  })

  it('re-prepends one global observer after root and child Agent setup answerers', async () => {
    const root = agent('root-agent')
    const child = agent('child-agent')
    const agents: typeof root[] = []
    const active = [{ callId: 'call-root', questions: [{ id: 'q1', question: '?' }], state: 'continued' as const }]
    const h = context({
      agents: {
        get: id => agents.find(candidate => candidate.id === id),
        list: () => agents,
        roots: () => agents.filter(candidate => candidate.id === root.id),
        isOwnedBy: (id, owner) => id === child.id && owner.id === root.id,
      },
      sessionProjections: { stateOf: () => ({ questions: { active, settled: [] } }) },
    })
    const hostEntries = new Map<string, number>()
    const instrumentedContext: ContextLike = {
      ...h.ctx,
      on(event, listener, options) {
        return h.ctx.on(event, function (this: unknown, ...args: any[]) {
          hostEntries.set(event, (hostEntries.get(event) ?? 0) + 1)
          return listener.apply(this, args)
        }, options)
      },
    }
    h.start(instrumentedContext)
    const noAnswerer = Object.assign(new Error('no composed answerer'), { code: 'NO_PROVIDER' })
    h.ctx.on('user-questions/request', async (request) => {
      if (request.agent.id === root.id) throw noAnswerer
    }, { global: true, prepend: true })
    agents.push(root)
    h.emit('agent/created', { agent: root, source: { kind: 'fresh' } })
    expect(h.listenerCount('user-questions/request')).toBe(2)

    const timedOut = Object.assign(new Error('continued'), { code: 'ASK_TIMED_OUT' })
    const controller = new AbortController()
    const pending = h.emit('user-questions/request', questionRequest(root.id, {
      wait: { callId: 'call-root', timed: true }, signal: controller.signal,
    }), async () => { throw noAnswerer })
    await expect(Promise.resolve(pending)).rejects.toBe(noAnswerer)
    expect(hostEntries.get('user-questions/request')).toBe(1)
    controller.abort(timedOut)
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    expect(h.emitted[0]?.category).toBe('question')
    expect(await h.start().eligible(h.emitted[0]!)).toBe(true)

    let settleChildApproval!: (decision: string) => void
    h.ctx.on('approval/request', (request, _next) => request.agent.id === child.id
      ? new Promise<string>(resolve => { settleChildApproval = resolve })
      : undefined, { global: true, prepend: true })
    agents.push(child)
    h.emit('agent/created', { agent: child, source: { kind: 'child' } })
    expect(h.listenerCount('approval/request')).toBe(2)
    const childApproval = Promise.resolve(h.emit('approval/request', {
      agent: child, callId: 'approval-child', toolName: 'fixture-write', reason: 'hold', signal: new AbortController().signal,
    }, async () => 'unavailable'))
    expect(hostEntries.get('approval/request')).toBe(1)
    await vi.waitFor(() => expect(h.emitted).toHaveLength(2), { timeout: 3_000 })
    const approvalSource = h.emitted[1]!
    expect(approvalSource.category).toBe('approval')
    expect(approvalSource.sessionId).toBe(child.id)
    expect(approvalSource.targetSessionId).toBe(root.id)
    settleChildApproval('granted')
    await expect(childApproval).resolves.toBe('granted')
  })

  it('continued remains eligible once, queued reply suppresses, and retains original expiry', async () => {
    const active: Array<{ callId: string; questions: unknown[]; state: 'open' | 'continued' }> = [{ callId: 'call-1', questions: [{ id: 'q', question: '?' }], state: 'continued' }]
    const h = context({
      sessionProjections: { stateOf: () => ({ questions: { active, settled: [] } }) },
    })
    h.start()
    const timeoutSignal = new AbortController()
    const timeout = Object.assign(new Error('timed request entered continued state'), { code: 'ASK_TIMED_OUT' })
    const noAnswerer = Object.assign(new Error('no composed user-question answerer'), { code: 'NO_PROVIDER' })
    void Promise.resolve(h.emit('user-questions/request', questionRequest('s1', { wait: { callId: 'call-1', timed: true }, signal: timeoutSignal.signal }), async () => {
      timeoutSignal.abort(timeout)
      throw noAnswerer
    })).catch(() => {})
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    const source = h.emitted[0]!
    expect(source.category).toBe('question')
    expect(await h.start().eligible(source)).toBe(true)
    h.emit('session/event', agent('s1'), { type: 'user/message', data: { source: { kind: 'user-question-reply', callId: 'call-1' } } })
    expect(await h.start().eligible(source)).toBe(false)
    expect(source.expiresAt - source.createdAt).toBe(300_000)
  })

  it('keeps a continued question eligible across later turns and unrelated inbox activity, then stales its exact reply', async () => {
    const active = [{ callId: 'call-newer-turn', questions: [{ id: 'q1', question: '?' }], state: 'continued' as const }]
    const boundary = { openTurnStartSeq: 1, lastTurn: 1 }
    const h = context({ sessionProjections: { stateOf: (_session, key) => key === 'turnBoundary' ? boundary : key === 'userQuestions' ? { questions: { active, settled: [] } } : undefined } })
    const host = h.start()
    await h.emit('user-questions/request', questionRequest('newer-turn', { wait: { callId: 'call-newer-turn', timed: true } }), async () => ({ pending: true }))
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    const source = h.emitted[0]!
    expect(await host.reconcile(source)).toBe('eligible')
    boundary.openTurnStartSeq = 2
    boundary.lastTurn = 2
    h.emit('session/event', agent('newer-turn'), { type: 'turn/start', data: { turn: 2 } })
    expect(await host.reconcile(source)).toBe('eligible')
    h.emit('agent/inbox/inserted', { agent: agent('newer-turn'), message: { id: 'unrelated', role: 'user', source: { kind: 'user' }, content: [] } })
    expect(await host.reconcile(source)).toBe('eligible')
    h.emit('agent/inbox/inserted', { agent: agent('newer-turn'), message: { id: 'reply', role: 'user', source: { kind: 'user-question-reply', callId: 'call-newer-turn', outcome: 'answered' }, content: [] } })
    expect(await host.reconcile(source)).toBe('stale')
  })

  it('keeps a callId-less timed question unverifiable even while its live request remains', async () => {
    const h = context(); const host = h.start()
    await h.emit('user-questions/request', questionRequest('opaque-timed', { wait: { timed: true } }), async () => ({ pending: true }))
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    const source = h.emitted[0]!
    expect(source.callId).toBeUndefined()
    expect(await host.reconcile(source)).toBe('unverifiable')
  })

  it('keeps an actually aborted timed request stale after newer-turn preservation', async () => {
    const active = [{ callId: 'call-aborted', questions: [{ id: 'q1', question: '?' }], state: 'continued' as const }]
    const h = context({ sessionProjections: { stateOf: () => ({ questions: { active, settled: [] } }) } })
    const host = h.start()
    const controller = new AbortController()
    await h.emit('user-questions/request', questionRequest('aborted-timed', { wait: { callId: 'call-aborted', timed: true }, signal: controller.signal }), async () => ({ pending: true }))
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    const source = h.emitted[0]!
    expect(await host.reconcile(source)).toBe('eligible')
    controller.abort(new Error('the foreground request was cancelled'))
    expect(await host.reconcile(source)).toBe('stale')
  })

  it('still invalidates a live legacy plan wait on unrelated inbox activity', async () => {
    const h = context(); const host = h.start()
    let settle!: (value: unknown) => void
    const request = questionRequest('legacy-inbox', { questions: [{ id: 'review', question: 'Review?', intent: { kind: 'plan-review', approve: 'Approve', callId: 'legacy-plan' } }] })
    const pending = h.emit('user-questions/request', request, () => new Promise(resolve => { settle = resolve }))
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    const source = h.emitted[0]!
    expect(await host.reconcile(source)).toBe('eligible')
    h.emit('agent/inbox/inserted', { agent: agent('legacy-inbox'), message: { id: 'unrelated', role: 'user', source: { kind: 'user' }, content: [] } })
    expect(await host.reconcile(source)).toBe('stale')
    settle({ answers: [] })
    await expect(pending).resolves.toEqual({ answers: [] })
  })

  it('retains timed continuation when the real waterfall rejects with ASK_TIMED_OUT', async () => {
    const active = [{ callId: 'call-timeout-result', questions: [{ id: 'q1', question: '?' }], state: 'continued' as const }]
    const h = context({ sessionProjections: { stateOf: () => ({ questions: { active, settled: [] } }) } })
    h.start()
    const controller = new AbortController()
    const timedOut = Object.assign(new Error('timed request expired'), { code: 'ASK_TIMED_OUT' })
    const result = h.emit('user-questions/request', questionRequest('s-timeout', {
      wait: { callId: 'call-timeout-result', timed: true }, signal: controller.signal,
    }), async () => {
      controller.abort(timedOut)
      throw timedOut
    })
    await expect(Promise.resolve(result)).rejects.toBe(timedOut)
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    expect(h.emitted[0]?.callId).toBe('call-timeout-result')
    expect(await h.start().eligible(h.emitted[0]!)).toBe(true)
  })

  it('legacy plan survives projection absence until its live request settles', async () => {
    const h = context(); h.start()
    const request = questionRequest('s1', { questions: [{ id: 'q', question: 'review', intent: { kind: 'plan-review', approve: 'Approve', callId: 'plan-call' } }] })
    let settle!: (v: unknown) => void
    h.emit('user-questions/request', request, () => new Promise(resolve => { settle = resolve }))
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    expect(h.emitted[0]?.category).toBe('plan')
    expect(h.emitted[0]?.callId).toBe('plan-call')
    expect(await h.start().eligible(h.emitted[0]!)).toBe(true)
    settle({ answers: [] })
    await vi.waitFor(async () => expect(await h.start().eligible(h.emitted[0]!)).toBe(false))
  })

  it('verifies stored Session existence with a disposed read-only observation', async () => {
    const dispose = vi.fn()
    const observeSession = vi.fn(async () => ({ source: 'prepared' as const, [Symbol.dispose]: dispose }))
    const getAgent = vi.fn()
    const h = context({
      agents: { get: getAgent, list: () => [], roots: () => [], isOwnedBy: () => false },
      sessionQuery: { observeSession },
    })
    const host = h.start()

    await expect(host.sessionExists('stored-session')).resolves.toBe(true)
    expect(observeSession).toHaveBeenCalledWith('stored-session', { projectionMode: 'all' })
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(getAgent).not.toHaveBeenCalled()
  })

  it.each([
    ['missing session', async () => { throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }) }],
    ['observation failure', async () => { throw new Error('query unavailable') }],
    ['disposal failure', async () => ({ source: 'prepared' as const, [Symbol.dispose]: () => { throw new Error('dispose failed') } })],
  ])('fails closed on %s while verifying stored Session existence', async (_label, observeSession) => {
    const h = context({ sessionQuery: { observeSession } })
    const host = h.start()
    await expect(host.sessionExists('stored-session')).resolves.toBe(false)
  })

  it('returns false without querying when the host is closed or its contract unavailable', async () => {
    const observeSession = vi.fn(async () => ({ source: 'prepared' as const, [Symbol.dispose]: () => undefined }))
    const closedHost = context({ sessionQuery: { observeSession } }).start()
    await closedHost.close()
    await expect(closedHost.sessionExists('stored-session')).resolves.toBe(false)
    expect(observeSession).not.toHaveBeenCalled()

    const unavailable = context()
    const unavailableHost = unavailable.start({ ...unavailable.ctx, userQuestions: undefined } as unknown as ContextLike)
    expect(unavailableHost.available).toBe(false)
    await expect(unavailableHost.sessionExists('stored-session')).resolves.toBe(false)
    expect(observeSession).not.toHaveBeenCalled()
  })

  it('distinguishes ordinary forks from owned children and resolves approvals to runtime root', async () => {
    const root = agent('root')
    const fork = agent('fork', 'root')
    const child = agent('child', 'root')
    const nested = agent('nested', 'child')
    const h = context({ agents: {
      get: id => ({ root, fork, child, nested } as Record<string, any>)[id],
      list: () => [root, fork, child, nested], roots: () => [root, fork],
      isOwnedBy: (id, owner) => (id === 'child' && owner === root) || (id === 'nested' && owner === child),
    } })
    h.start()
    h.emit('session/event', fork, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    h.emit('session/event', child, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    expect(h.emitted[0]?.sessionId).toBe('fork')
    const approval = { agent: nested, toolName: 'write', signal: new AbortController().signal }
    let settleApproval!: (outcome: string) => void
    h.emit('approval/request', approval, () => new Promise(resolve => { settleApproval = resolve }))
    await vi.waitFor(() => expect(h.emitted.some(source => source.category === 'approval')).toBe(true), { timeout: 3_000 })
    expect((await h.start().resolveTarget(h.emitted.find(source => source.category === 'approval')!))?.sessionId).toBe('root')
    settleApproval('unavailable')
  })

  it('does not turn an active goal continuation round into a response notification', async () => {
    const h = context(); h.start()
    h.emit('goal/changed', { agent: agent('rounds'), change: { operation: 'create', ref: { id: 'goal-rounds', revision: 1 }, goal: { id: 'goal-rounds', revision: 1, objective: 'continue', phase: 'active', maxGoalRounds: 3 } } })
    h.emit('session/event', agent('rounds'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 1_050))
    expect(h.emitted).toHaveLength(0)
  })

  it('uses the current public goal projection when attached after goal creation', async () => {
    const h = context({ sessionProjections: { stateOf: (_session, key) => key === 'goal' ? { current: { goal: { id: 'already-active', revision: 4, phase: 'active' } } } : undefined } })
    h.start()
    h.emit('session/event', { id: 'late-attached' }, { type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 1_050))
    expect(h.emitted).toHaveLength(0)
  })

  it('waits for a committed final goal outcome and coalesces its turn', async () => {
    const h = context(); h.start()
    h.emit('goal/changed', { agent: agent('s1'), change: { operation: 'complete', ref: { id: 'g1', revision: 2 }, goal: { id: 'g1', revision: 2, objective: 'do task', phase: 'complete', maxGoalRounds: 4 } } })
    expect(h.emitted).toHaveLength(0)
    h.emit('session/event', agent('s1'), { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
    await vi.waitFor(() => expect(h.emitted.filter(item => item.category === 'goal')).toHaveLength(1), { timeout: 3_000 })
    expect(h.emitted.some(item => item.category === 'response')).toBe(false)
    expect(await h.start().eligible(h.emitted[0]!)).toBe(true)
  })

  it('coalesces a blocked goal with its enclosing completed turn', async () => {
    const h = context({ sessionProjections: { stateOf: (_session, key) => key === 'turnBoundary' ? { openTurnStartSeq: 0, lastTurn: 1 } : undefined } }); h.start()
    const session = agent('blocked-completed')
    h.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    h.emit('goal/changed', { agent: session, change: { operation: 'block', ref: { id: 'blocked-completed-goal', revision: 1 }, goal: { id: 'blocked-completed-goal', revision: 1, objective: 'needs input', phase: 'blocked', maxGoalRounds: 1 } } })
    h.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 1_050))
    expect(h.emitted.map(source => source.category)).toEqual(['goal'])
  })

  it('coalesces a blocked goal with its enclosing error turn', async () => {
    const h = context({ sessionProjections: { stateOf: (_session, key) => key === 'turnBoundary' ? { openTurnStartSeq: 0, lastTurn: 1 } : undefined } }); h.start()
    const session = agent('blocked-error')
    h.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    h.emit('goal/changed', { agent: session, change: { operation: 'block', ref: { id: 'blocked-error-goal', revision: 1 }, goal: { id: 'blocked-error-goal', revision: 1, objective: 'needs input', phase: 'blocked', maxGoalRounds: 1 } } })
    h.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'FIXTURE', message: 'hidden diagnostic' } } } })
    await new Promise(resolve => setTimeout(resolve, 1_050))
    expect(h.emitted.map(source => source.category)).toEqual(['goal'])
  })

  it('reports an ordinary later turn instead of replaying an observed completed goal', async () => {
    const goal = { id: 'completed-on-prior-turn', revision: 3, phase: 'complete' }
    const h = context({ sessionProjections: { stateOf: (_session, key) => key === 'goal' ? { current: { goal } } : undefined } })
    h.start()
    const session = agent('completed-then-ordinary')
    h.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } })
    h.emit('goal/changed', { agent: session, change: { operation: 'complete', ref: { id: goal.id, revision: goal.revision }, goal: { ...goal, objective: 'done' } } })
    h.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.waitFor(() => expect(h.emitted.filter(source => source.category === 'goal')).toHaveLength(1), { timeout: 3_000 })
    h.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } })
    h.emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 1_050))
    expect(h.emitted.map(source => source.category).sort()).toEqual(['goal', 'response'])
  })

  it('does not manufacture a goal outcome from a terminal projection when attached late', async () => {
    const goal = { id: 'already-complete', revision: 2, phase: 'complete' }
    const h = context({ sessionProjections: { stateOf: (_session, key) => key === 'goal' ? { current: { goal } } : undefined } })
    h.start()
    const session = agent('late-complete')
    h.emit('session/event', session, { type: 'turn/start', data: { turn: 4 } })
    h.emit('session/event', session, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 1_050))
    expect(h.emitted.map(source => source.category)).toEqual(['response'])
  })

  it('notifies once for committed actionable block and unrecovered live failure, never diagnostic detail', async () => {
    const h = context(); h.start()
    h.emit('goal/changed', { agent: agent('s1'), change: { operation: 'block', ref: { id: 'g1', revision: 2 }, goal: { id: 'g1', revision: 2, objective: 'do task', phase: 'blocked', blockedReason: { code: 'input', message: 'Need input' }, maxGoalRounds: 4 } } })
    h.emit('session/event', agent('s2'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'secret', code: 'X' } } } })
    await vi.waitFor(() => expect(h.emitted).toHaveLength(2), { timeout: 3_000 })
    expect(h.emitted.map(item => item.category).sort()).toEqual(['failure', 'goal'])
    expect(JSON.stringify(h.emitted)).not.toContain('Need input')
    expect(JSON.stringify(h.emitted)).not.toContain('secret')
  })

  it('recovery and intentional stops invalidate outcomes; only genuine terminal failure notifies', async () => {
    const h = context(); h.start()
    h.emit('session/event', agent('s1'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    h.emit('session/event', agent('s1'), { type: 'turn/start', data: { turn: 2 } })
    await new Promise(resolve => setTimeout(resolve, 275))
    expect(h.emitted).toHaveLength(0)
    h.emit('session/event', agent('s2'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: 'user' } } })
    h.emit('session/event', agent('s3'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: 'parent' } } })
    h.emit('session/event', agent('s4'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } })
    h.emit('session/event', agent('s5'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'interrupted' } } })
    expect(h.emitted).toHaveLength(0)
    h.emit('session/event', agent('s6'), { type: 'turn/end', data: { turn: 3, reason: { kind: 'error', error: { message: 'x', code: 'X' } } } })
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    expect(h.emitted[0]?.category).toBe('failure')
  })
})

describe('public ownership on hosts without roots/isOwnedBy (DSH 0.2.2-rc.2)', () => {
  const subagent = (id: string, parentSession: string): PublicAgentLike => ({ id, session: { id, header: { parentSession, origin: 'subagent' } } })
  const historicalFork = (id: string, parentSession: string): PublicAgentLike => ({ id, session: { id, header: { parentSession } } })

  it('keeps push available and routes a nested subagent request to its root session', async () => {
    const root = agent('root')
    const child = subagent('child', 'root')
    const nested = subagent('nested', 'child')
    const live = [root, child, nested]
    const h = context({ agents: { get: id => live.find(candidate => candidate.id === id), list: () => live } })
    const host = h.start()
    expect(host.available).toBe(true)
    let settle!: (value: string) => void
    h.emit('approval/request', { agent: nested, toolName: 'fixture-write', signal: new AbortController().signal }, () => new Promise(resolve => { settle = resolve }))
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    expect(h.emitted[0]?.sessionId).toBe('nested')
    expect(h.emitted[0]?.targetSessionId).toBe('root')
    expect((await host.resolveTarget(h.emitted[0]!))?.sessionId).toBe('root')
    settle('unavailable')
  })

  it('does not reparent a historical fork and suppresses subagent turn chatter', async () => {
    const root = agent('root')
    const fork = historicalFork('fork', 'root')
    const child = subagent('child', 'root')
    const live = [root, fork, child]
    const h = context({ agents: { get: id => live.find(candidate => candidate.id === id), list: () => live } })
    const host = h.start()
    expect(host.available).toBe(true)
    h.emit('session/event', fork, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    h.emit('session/event', child, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    await new Promise(resolve => setTimeout(resolve, 1_050))
    expect(h.emitted.map(source => source.sessionId)).toEqual(['fork'])
    expect(h.emitted[0]?.targetSessionId).toBe('fork')
  })

  it('treats a subagent whose parent Agent is no longer live as its own root', async () => {
    const orphan = subagent('orphan', 'gone')
    const h = context({ agents: { get: () => undefined, list: () => [orphan] } })
    const host = h.start()
    expect(host.available).toBe(true)
    h.emit('session/event', orphan, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    expect(h.emitted[0]?.sessionId).toBe('orphan')
    expect(h.emitted[0]?.targetSessionId).toBe('orphan')
  })

  it('resolves ownership from the live registry for Session-shaped event subjects', async () => {
    const root = agent('root')
    const child = subagent('child', 'root')
    const live = [root, child]
    const h = context({ agents: { get: id => live.find(candidate => candidate.id === id), list: () => live } })
    h.start()
    // session/event delivers the Session, whose header lives one level up on the live Agent.
    h.emit('session/event', { id: 'child' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    await new Promise(resolve => setTimeout(resolve, 1_050))
    expect(h.emitted).toHaveLength(0)
    // A request can carry an Agent-shaped identity without the Session object attached.
    h.emit('approval/request', { agent: { id: 'child' }, toolName: 'fixture-write', signal: new AbortController().signal }, () => new Promise(() => undefined))
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    expect(h.emitted[0]?.targetSessionId).toBe('root')
  })

  it('keeps the legacy ownership methods bound to the live registry', async () => {
    const root = agent('root')
    const child = subagent('child', 'root')
    // Mirrors a Cordis service: list/get/isOwnedBy read state through `this`.
    const registry = {
      live: [root, child] as PublicAgentLike[],
      ownership: new Set(['child\u0000root']),
      get(this: { live: PublicAgentLike[] }, id: string) { return this.live.find(candidate => candidate.id === id) },
      list(this: { live: PublicAgentLike[] }) { return this.live },
      roots(this: { live: PublicAgentLike[] }) { return this.live.filter(candidate => candidate.id === 'root') },
      isOwnedBy(this: { ownership: Set<string> }, id: string, owner: PublicAgentLike) { return this.ownership.has(`${id}\u0000${owner.id}`) },
    }
    const h = context({ agents: registry as any })
    const host = h.start()
    expect(host.available).toBe(true)
    let settle!: (value: string) => void
    h.emit('approval/request', { agent: child, toolName: 'fixture-write', signal: new AbortController().signal }, () => new Promise(resolve => { settle = resolve }))
    await vi.waitFor(() => expect(h.emitted).toHaveLength(1), { timeout: 3_000 })
    expect(h.emitted[0]?.targetSessionId).toBe('root')
    settle('unavailable')
  })

  it('still fails closed when the registry cannot look up or list live Agents', () => {
    const missingGet = context({ agents: { list: () => [] } as any })
    expect(missingGet.start().available).toBe(false)
    const missingList = context({ agents: { get: () => undefined } as any })
    expect(missingList.start().available).toBe(false)
  })
})

describe('push host maintenance', () => {
  afterEach(() => { vi.useRealTimers() })

  it('owns a recurring maintenance sweep timer disposed on close', async () => {
    vi.useFakeTimers()
    const h = context()
    const host = h.start()
    await h.emit('user-questions/request', questionRequest('s1'), vi.fn(async () => ({ answers: [] })))
    await vi.advanceTimersByTimeAsync(REQUEST_SETTLE_MS)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await host.close()
    expect(vi.getTimerCount()).toBe(0)
  })
})
