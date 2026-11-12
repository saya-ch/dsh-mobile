import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { atomicJsonPublisher } from './push-fixture-publication.mjs'

const PACKAGE_NAME = 'dsh-mobile-push-integration-fixture'

// The canonical atomic publisher is owned by scripts/push-fixture-publication.mjs and
// re-exported here so both generated Hosts embed one identical algorithm.
export { atomicJsonPublisher }

function hostSource() {
  return `import { randomUUID } from 'node:crypto'
import { watch } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const name = ${JSON.stringify(PACKAGE_NAME)}
export const inject = ['agents', 'sessions', 'userQuestions', 'sessionQuery']
const HOME = process.env.DSH_HOME
const CONTROL = process.env.DSH_PUSH_FIXTURE_CONTROL
const NONCE = process.env.DSH_PUSH_FIXTURE_NONCE
const RESULT = HOME === undefined ? undefined : join(HOME, 'push-integration-fixture-result.json')
const SETTLEMENT = HOME === undefined ? undefined : join(HOME, 'push-integration-fixture-settlement.json')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const safeErrorEvidence = error => ({ errorName: typeof error?.name === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(error.name) ? error.name : 'Error',
  errorCode: typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code) ? error.code : null })
const publishDocument = (${atomicJsonPublisher.toString()})({ mkdir, writeFile, rename, rm, dirname, randomUUID })
export const writeResult = async value => {
  if (RESULT === undefined) throw new Error('fixture_home_missing')
  await publishDocument(RESULT, value)
}
export const writeSettlement = async value => {
  if (SETTLEMENT === undefined) throw new Error('fixture_home_missing')
  await publishDocument(SETTLEMENT, value)
}
const publicMissingSessionObservation = async ctx => {
  const sessionId = 'task8-never-created-' + randomUUID()
  const sessionSnapshot = () => ctx.sessions.list().map(session => session.id).sort()
  const agentSnapshot = () => ctx.agents.list().map(agent => [agent.id, agent.status]).sort(([left], [right]) => left.localeCompare(right))
  const sessionsBefore = sessionSnapshot()
  const agentsBefore = agentSnapshot()
  const sessionPresentBefore = ctx.sessions.get(sessionId) !== undefined
  const agentPresentBefore = ctx.agents.get(sessionId) !== undefined
  let lease
  let outcome = 'threw'
  let errorName = null
  let errorCode = null
  let leaseDisposed = null
  try {
    lease = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'all', signal: AbortSignal.timeout(5_000) })
    outcome = 'returned'
  } catch (error) {
    errorName = error?.name || 'Error'
    const code = error?.code
    errorCode = typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : null
  } finally {
    if (lease !== undefined) {
      lease[Symbol.dispose]()
      leaseDisposed = true
    }
  }
  const sessionsAfter = sessionSnapshot()
  const agentsAfter = agentSnapshot()
  const sessionPresentAfter = ctx.sessions.get(sessionId) !== undefined
  const agentPresentAfter = ctx.agents.get(sessionId) !== undefined
  const sessionStoreUnchanged = JSON.stringify(sessionsBefore) === JSON.stringify(sessionsAfter)
  const agentStoreUnchanged = JSON.stringify(agentsBefore) === JSON.stringify(agentsAfter)
  const missingThrown = outcome === 'threw' && errorCode === 'SESSION_QUERY_SESSION_NOT_FOUND'
  return { name: 'public-observeSession-never-created-owned-fixture-id', projectionMode: 'all', outcome, errorName, errorCode,
    generatedIdWasNeverSubmittedForCreation: true, syntacticallyValidSessionId: true,
    sessionPresentBefore, sessionPresentAfter, agentPresentBefore, agentPresentAfter,
    sessionCountBefore: sessionsBefore.length, sessionCountAfter: sessionsAfter.length, sessionStoreUnchanged,
    agentCountBefore: agentsBefore.length, agentCountAfter: agentsAfter.length, agentStoreUnchanged,
    leaseReturned: lease !== undefined, leaseDisposed, noSessionOrAgentCreationOrWake: sessionStoreUnchanged && agentStoreUnchanged
      && !sessionPresentBefore && !sessionPresentAfter && !agentPresentBefore && !agentPresentAfter,
    ok: missingThrown && sessionStoreUnchanged && agentStoreUnchanged && !sessionPresentBefore && !sessionPresentAfter
      && !agentPresentBefore && !agentPresentAfter }
}
const publicQuestionProjectionEvidence = async (ctx, sessionId, callId) => {
  const deadline = Date.now() + 5_000
  let attempts = 0
  let last
  while (Date.now() < deadline) {
    attempts++
    let observation
    let evidence
    let leaseDisposed = false
    try {
      observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'all', signal: AbortSignal.timeout(5_000) })
      const view = observation.projections?.values?.userQuestions
      const active = Array.isArray(view?.active) ? view.active : []
      const matched = active.find(row => row.callId === callId)
      evidence = { outcome: 'returned', source: observation.source, projectionAvailable: view !== undefined,
        activeQuestionCount: active.length, settledQuestionCount: Array.isArray(view?.settled) ? view.settled.length : null,
        matchingCallActive: matched !== undefined, matchingCallState: matched && ['open', 'continued'].includes(matched.state) ? matched.state : null }
    } catch (error) {
      evidence = { outcome: 'threw', source: null, projectionAvailable: false, activeQuestionCount: null, settledQuestionCount: null,
        matchingCallActive: false, matchingCallState: null,
        errorName: error?.name || 'Error', errorCode: typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code) ? error.code : null }
    } finally {
      if (observation !== undefined) {
        try { observation[Symbol.dispose](); leaseDisposed = true } catch { leaseDisposed = false }
      }
    }
    last = { ...evidence, attempts, leaseDisposed }
    if (evidence.outcome === 'threw' || evidence.projectionAvailable !== true || evidence.matchingCallActive) return last
    await delay(100)
  }
  return last ?? { outcome: 'missing', source: null, projectionAvailable: false, activeQuestionCount: null,
    settledQuestionCount: null, matchingCallActive: false, matchingCallState: null, attempts, leaseDisposed: null }
}

export function apply(ctx) {
  let watcher
  let handle
  const handles = new Map()
  const askControllers = new Map()
  let askController
  let askPromise
  let askSettlementObserved
  let running = false
  let closing = false
  let disposed = false
  let activeNonce
  let lastCommandId
  const timeout = promise => Promise.race([promise, delay(15_000).then(() => { throw new Error('fixture_teardown_timeout') })])
  const execute = async command => {
    if (typeof command?.commandId === 'string' && command.commandId === lastCommandId) return
    if (typeof command?.commandId === 'string') lastCommandId = command.commandId
    if (command?.command === 'close-question') {
      const result = { commandId: command.commandId, phase: 'closing-question', ok: false }
      if (command.nonce !== NONCE || !running || handle === undefined || askController === undefined) {
        result.phase = 'fixture-failed'
        await writeResult(result)
        return
      }
      closing = true
      try {
        activeNonce = command.nonce
        askController.abort(new Error('owned push fixture question closed'))
        if (askPromise) await timeout(askPromise.then(() => undefined, () => undefined)).catch(() => {})
        if (askSettlementObserved) await timeout(askSettlementObserved).catch(() => {})
        await timeout(handle.dispose())
        handles.delete(handle.agent.session.id)
        askControllers.delete(handle.agent.session.id)
        handle = undefined
        askController = undefined
        askPromise = undefined
        askSettlementObserved = undefined
        running = false
        result.phase = 'question-closed'
        result.ok = true
      } catch {
        result.phase = 'fixture-failed'
      } finally { closing = false }
      await writeResult(result)
      return
    }
    if (command?.command === 'observe-question') {
      const result = { commandId: command.commandId, phase: 'observe-question', ok: false }
      if (command.nonce !== NONCE || typeof command.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.sessionId)) {
        result.phase = 'fixture-failed'
        await writeResult(result)
        return
      }
      let observation
      const evidence = { }
      try {
        try {
          const live = ctx.sessions.get?.(command.sessionId)
          evidence.liveEventTypes = typeof live?.snapshotEvents === 'function'
            ? live.snapshotEvents().map(event => typeof event?.type === 'string' ? event.type.slice(0, 48) : null).slice(0, 32)
            : live === undefined ? 'session-not-live' : 'snapshotEvents-unavailable'
        } catch (error) {
          evidence.liveEventsErrorName = error?.name || 'Error'
        }
        try {
          observation = await ctx.sessionQuery.observeSession(command.sessionId, { projectionMode: 'all', signal: AbortSignal.timeout(5_000) })
          const view = observation.projections?.values?.userQuestions
          evidence.projectionAvailable = view !== undefined
          evidence.activeCount = Array.isArray(view?.active) ? view.active.length : null
          evidence.settledCount = Array.isArray(view?.settled) ? view.settled.length : null
          evidence.activeStates = Array.isArray(view?.active)
            ? view.active.map(row => ({ callId: typeof row?.callId === 'string' ? row.callId.slice(0, 48) : null,
              state: typeof row?.state === 'string' ? row.state : null })).slice(0, 8) : null
          const events = Array.isArray(observation?.events) ? observation.events : []
          evidence.eventTypes = events.map(event => typeof event?.type === 'string' ? event.type.slice(0, 48) : null).slice(0, 32)
          evidence.eventCount = events.length
        } catch (error) {
          evidence.observeErrorName = error?.name || 'Error'
          evidence.observeErrorCode = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(error.code) ? error.code : null
          evidence.observeErrorMessage = typeof error?.message === 'string' ? error.message.slice(0, 200) : null
        } finally {
          if (observation !== undefined) { try { observation[Symbol.dispose]() } catch {} }
        }
        result.evidence = evidence
        result.ok = true
        await writeResult(result)
      } catch {
        result.phase = 'fixture-failed'
        await writeResult(result)
      }
      return
    }
    running = true
    activeNonce = command?.nonce
    const result = { commandId: command?.commandId, phase: 'starting', ok: false }
    await writeResult(result)
    try {
      if (!command || command.command !== 'emit-question' || command.nonce !== NONCE
        || typeof command.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(command.sessionId)) throw new Error('fixture_command_rejected')
      const waitMs = Number.isSafeInteger(command.timeout) ? command.timeout : 120_000
      if (waitMs !== 0 && (waitMs < 5_000 || waitMs > 600_000)) throw new Error('fixture_command_rejected')
      const agentSessionId = command.sessionId
      handle = await ctx.agents.create({
        sessionId: agentSessionId,
        agentOptions: { provider: 'push-integration-no-provider', model: 'never-invoked' },
      })
      handles.set(agentSessionId, handle)
      const agentIdentity = (() => {
        const base = { sessionMatchesTarget: handle.agent.session.id === agentSessionId,
          sameRegisteredAgent: ctx.agents.get(handle.agent.id) === handle.agent }
        if (typeof ctx.agents.roots === 'function' && typeof ctx.agents.isOwnedBy === 'function') {
          return { ...base, isRuntimeRoot: ctx.agents.roots().includes(handle.agent),
            hasLiveOwner: ctx.agents.list().some(owner => ctx.agents.isOwnedBy(handle.agent.id, owner)) }
        }
        // DSH 0.2.2-rc.2 removed AgentRegistry#roots()/#isOwnedBy(); use the durable header.
        const header = handle.agent.session?.header
        const parentSession = header?.origin === 'subagent' ? header?.parentSession : undefined
        return { ...base, isRuntimeRoot: parentSession === undefined,
          hasLiveOwner: typeof parentSession === 'string' && ctx.agents.get(parentSession) !== undefined }
      })()
      result.agentIdentity = agentIdentity
      if (!agentIdentity.sessionMatchesTarget || !agentIdentity.sameRegisteredAgent || !agentIdentity.isRuntimeRoot || agentIdentity.hasLiveOwner) {
        throw new Error('fixture_agent_unavailable')
      }
      const callId = 'push-integration-' + randomUUID()
      const question = { id: 'push-integration-question-' + randomUUID(), question: 'Continue the isolated push smoke?', header: 'Test fixture' }
      await handle.agent.session.append('turn/start', { turn: 1 })
      await handle.agent.session.append('step/start', { turn: 1, step: 1 })
      // Session format v4 accepts request/header only inside an open turn and tool/call only inside
      // an open turn+step; this order keeps the stored log rehydratable while the live projection
      // keeps its tool schema for the synthetic ask call.
      await handle.agent.session.append('request/header', {
        header: { config: { provider: 'push-integration-no-provider', model: 'never-invoked' },
          tools: [{ name: 'ask_user_question', description: 'isolated fixture only', parameters: { type: 'object',
            properties: { questions: { type: 'array' }, timeout: { type: 'integer' } } } }] },
        reason: 'initial',
      })
      const askArguments = JSON.stringify(waitMs === 0 ? { questions: [question] } : { questions: [question], timeout: waitMs })
      // Session format v4 requires a tool/call to match a call advertised by an assistant message
      // (exact id/name/arguments), so the synthetic ask is advertised before it is called.
      await handle.agent.session.append('assistant/message', { turn: 1, step: 1,
        message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'push-integration-no-provider', model: 'never-invoked' }, content: [{ type: 'tool-call', id: callId, name: 'ask_user_question', arguments: askArguments }] }, stream: [] },
      { surfaceOp: 'append' })
      await handle.agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: askArguments })
      askController = new AbortController()
      askControllers.set(agentSessionId, askController)
      const requestProbe = { questionEntryCount: 0, nextCallCount: 0, agentMatchesTarget: null, callIdMatches: null,
        timed: null, signalAborted: null, downstreamOutcome: 'not-entered', downstreamErrorName: null,
        downstreamErrorCode: null, disposerAvailable: false, disposed: false }
      const removeQuestionProbe = ctx.on('user-questions/request', function (request, next) {
        const sameQuestion = Array.isArray(request?.questions) && request.questions.some(item => item?.id === question.id)
        if (!sameQuestion) return next()
        requestProbe.questionEntryCount++
        requestProbe.agentMatchesTarget = request?.agent?.session?.id === agentSessionId
        requestProbe.callIdMatches = request?.wait?.callId === callId
        requestProbe.timed = request?.wait?.timed === true
        requestProbe.signalAborted = request?.signal?.aborted === true
        requestProbe.downstreamOutcome = 'pending'
        requestProbe.nextCallCount++
        try {
          const downstream = next()
          return Promise.resolve(downstream).then(value => {
            requestProbe.downstreamOutcome = 'resolved'
            return value
          }, error => {
            requestProbe.downstreamOutcome = 'rejected'
            Object.assign(requestProbe, { downstreamErrorName: safeErrorEvidence(error).errorName,
              downstreamErrorCode: safeErrorEvidence(error).errorCode })
            throw error
          })
        } catch (error) {
          requestProbe.downstreamOutcome = 'threw'
          Object.assign(requestProbe, { downstreamErrorName: safeErrorEvidence(error).errorName,
              downstreamErrorCode: safeErrorEvidence(error).errorCode })
          throw error
        }
      }, { global: true, prepend: true })
      requestProbe.disposerAvailable = typeof removeQuestionProbe === 'function'
      let askSettlement = { outcome: 'pending', resultPending: null, resultCallIdMatches: null, answersPresent: null,
        errorName: null, errorCode: null }
      try {
        await writeSettlement(askSettlement)
        try {
          askPromise = waitMs === 0
            ? ctx.userQuestions.ask({ agent: handle.agent, questions: [question], signal: askController.signal })
            : ctx.userQuestions.askTimed({ agent: handle.agent, questions: [question], signal: askController.signal }, callId, waitMs)
          askSettlementObserved = Promise.resolve(askPromise).then(value => {
            askSettlement = { outcome: 'resolved', resultPending: value?.pending === true, resultCallIdMatches: value?.callId === callId,
              answersPresent: Array.isArray(value?.answers), errorName: null, errorCode: null }
            return writeSettlement(askSettlement)
          }, error => {
            askSettlement = { outcome: 'rejected', resultPending: null, resultCallIdMatches: null, answersPresent: null,
              ...safeErrorEvidence(error) }
            return writeSettlement(askSettlement)
          }).catch(() => {})
        } catch (error) {
          askSettlement = { outcome: 'threw', resultPending: null, resultCallIdMatches: null, answersPresent: null,
            ...safeErrorEvidence(error) }
          await writeSettlement(askSettlement)
        }
        result.publicQuestionProjection = await publicQuestionProjectionEvidence(ctx, agentSessionId, callId)
        await delay(25)
      } finally {
        try {
          if (typeof removeQuestionProbe === 'function') {
            removeQuestionProbe()
            requestProbe.disposed = true
          }
        } catch (error) { requestProbe.disposeErrorName = safeErrorEvidence(error).errorName }
        result.questionRequestEvidence = { ...requestProbe }
        result.askSettlementAtCapture = { ...askSettlement }
      }
      result.phase = 'question-probe-recorded'
      result.fixtureCommandProcessed = true
      result.ok = true
      result.targetSessionId = agentSessionId
      await writeResult(result)
    } catch (error) {
      result.phase = 'fixture-failed'
      result.ok = false
      Object.assign(result, safeErrorEvidence(error))
      await writeResult(result)
    }
  }
  const check = async () => {
    if (disposed || closing || CONTROL === undefined) return
    let command
    try { command = JSON.parse(await readFile(CONTROL, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (command?.nonce !== NONCE || (running && command.command !== 'close-question' && command.command !== 'emit-question' && command.command !== 'observe-question')) return
    await execute(command)
  }
  let probePromise
  ctx.effect(() => {
    if (HOME === undefined || CONTROL === undefined || NONCE === undefined || RESULT === undefined) {
      void writeResult({ phase: 'fixture-configuration-invalid', ok: false })
      return
    }
    watcher = watch(HOME, { persistent: false })
    watcher.on('change', (_event, filename) => {
      if (filename === undefined || String(filename) === basename(CONTROL)) void check().catch(() => {})
    })
    probePromise = (async () => {
      let sessionObservationProbe
      await writeResult({ phase: 'fixture-probe-started', ok: false, probeName: 'public-observeSession-never-created-owned-fixture-id' })
      try { sessionObservationProbe = await publicMissingSessionObservation(ctx) }
      catch (error) {
        sessionObservationProbe = { name: 'public-observeSession-never-created-owned-fixture-id', outcome: 'probe-failed',
          errorName: error?.name || 'Error', errorCode: null, ok: false }
      }
      await writeResult({ phase: 'fixture-ready', ok: true, publicSessionObservation: sessionObservationProbe })
      await check().catch(() => {})
    })()
    return async () => {
      disposed = true
      watcher?.close()
      await timeout(probePromise ?? Promise.resolve())
      for (const controller of askControllers.values()) controller.abort(new Error('owned push fixture teardown'))
      if (askPromise) await timeout(askPromise.then(() => undefined, () => undefined)).catch(() => {})
      if (askSettlementObserved) await timeout(askSettlementObserved).catch(() => {})
      for (const liveHandle of handles.values()) await timeout(liveHandle.dispose())
      if (activeNonce !== undefined) await writeResult({ phase: 'fixture-disposed', ok: true })
    }
  }, 'owned push integration source fixture')
}
`
}

/**
 * Build a private test-only Host package. It uses public SessionQuery/Agent/session/UserQuestions
 * APIs only, creates no model turn, and waits for an owned control file before emit.
 */
export async function createPushIntegrationFixture({ root }) {
  const packageRoot = resolve(root, 'push-integration-fixture-package')
  const libRoot = join(packageRoot, 'lib')
  await mkdir(libRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: PACKAGE_NAME,
    version: '1.0.0',
    private: true,
    type: 'module',
    main: './lib/index.mjs',
    exports: { '.': './lib/index.mjs', './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n')
  await writeFile(join(packageRoot, 'cordis.patch.yml'), JSON.stringify([{ insert: [{
    id: PACKAGE_NAME, name: PACKAGE_NAME, inject: ['agents', 'sessions', 'userQuestions', 'sessionQuery'],
  }] }]) + '\n')
  await writeFile(join(libRoot, 'index.mjs'), hostSource())
  return { packageRoot, packageName: PACKAGE_NAME }
}

export async function packPushIntegrationFixture({ fixture, root, repository }) {
  const { npmCli, runPackagingCommand } = await import('./packed-profile.mjs')
  const npm = await npmCli()
  const output = await runPackagingCommand(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', root], fixture.packageRoot)
  const [packed] = JSON.parse(output)
  if (typeof packed?.filename !== 'string' || /[/\\]/u.test(packed.filename)) throw new Error('Host fixture pack returned no package file')
  const tarball = join(root, packed.filename)
  if (dirname(resolve(tarball)) !== resolve(root)) throw new Error('Host fixture tarball escaped the owned temporary root')
  return { tarball, packageName: fixture.packageName, repository }
}
