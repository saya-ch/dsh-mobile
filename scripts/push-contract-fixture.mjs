import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { spawn } from 'node:child_process'
import { atomicJsonPublisher } from './push-fixture-publication.mjs'

/** Run an owned fixture build command and retain bounded diagnostics. */
async function run(command, args, cwd, env = process.env) {
  // Windows resolves npm bin shims through their .CMD launcher, which requires a shell.
  const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-12_000) })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-12_000) })
  const result = await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolveExit({ code, signal }))
  })
  if (result.code !== 0 || result.signal !== null) throw new Error(`Fixture command failed: ${command} ${args.join(' ')}\n${stdout}\n${stderr}`)
  return stdout
}

function hostEntrySource(repository) {
  const hostPath = pathToFileURL(join(repository, 'src/mobile-push/host.ts')).href
  return `
import { createPushHost } from ${JSON.stringify(hostPath)}
import { ATTENTION_TTL_MS, OUTCOME_COALESCE_MS } from ${JSON.stringify(pathToFileURL(join(repository, 'src/mobile-push/contracts.ts')).href)}
import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const name = 'dsh-mobile-push-contract-fixture'
export const inject = ['agents', 'sessions', 'sessionProjections', 'sessionQuery', 'userQuestions', 'approval', 'goals']
const publishDocument = (${atomicJsonPublisher.toString()})({ mkdir, writeFile, rename, rm, dirname, randomUUID })
export const writeProgress = async (target, value, hold) => { await publishDocument(target, value, hold) }
export const writeResult = async (target, value, hold) => { await publishDocument(target, value, hold) }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, label, timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = predicate()
    if (value) return value
    await pause(20)
  }
  throw new Error('Timed out waiting for ' + label)
}
const sourceSummary = source => ({ sourceId: source.sourceId, sessionId: source.sessionId, targetSessionId: source.targetSessionId, category: source.category, createdAt: source.createdAt, expiresAt: source.expiresAt, lifetime: source.lifetime, ...(Number.isSafeInteger(source.turn) ? { turn: source.turn } : {}), ...(source.callId ? { callId: source.callId } : {}), ...(source.goal ? { goal: source.goal } : {}) })
const withinTimeout = async (operation, timeoutMs, label) => {
  let timer
  try {
    return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + ' timed out')), timeoutMs) })])
  } finally { clearTimeout(timer) }
}

async function runFixtureJob(ctx, controls) {
  const result = { runtime: 'dsh-cordis-host', checks: [], sources: [], available: false, stage: 'job-started', applyEnteredAt: controls.applyEnteredAt, jobStartedAt: controls.jobStartedAt ?? Date.now(), stageHistory: [{ stage: 'job-started', at: controls.jobStartedAt ?? Date.now() }], approvalAnswererEntries: 0 }
  const home = process.env.DSH_HOME ?? process.cwd()
  const progressPath = join(home, 'push-contract-progress.json')
  const persistProgress = async () => { await writeProgress(progressPath, result) }
  controls.result = result
  controls.persistProgress = persistProgress
  await mkdir(home, { recursive: true })
  await persistProgress()
  const check = (name, ok, details = {}) => result.checks.push({ name, ok: ok === true, ...details })
  const handles = []
  const trackedController = () => {
    const controller = new AbortController()
    controls.controllers.add(controller)
    return controller
  }
  const stage = async name => {
    if (controls.cancelled) throw new Error('fixture job cancelled')
    result.stage = name
    result.stageHistory.push({ stage: name, at: Date.now() })
    await persistProgress()
  }
  const waitForOwned = (predicate, label, timeoutMs = 6_000) => waitFor(() => {
    if (controls.cancelled) throw new Error('fixture job cancelled')
    return predicate()
  }, label, timeoutMs)
  let rootFixtureAgent
  let rootTurnOpen = false
  let releasePlan
  let releaseApproval
  let removePlanAnswerer
  let removeApprovalAnswerer
  const observerEntries = { question: 0, approval: 0 }
  const instrumentedHostContext = {
    on(event, listener, options) {
      const wrapped = function (...args) {
        if (event === 'user-questions/request') observerEntries.question++
        if (event === 'approval/request') observerEntries.approval++
        return Reflect.apply(listener, this, args)
      }
      return ctx.on(event, wrapped, options)
    },
    userQuestions: ctx.userQuestions,
    approval: ctx.approval,
    sessionProjections: ctx.sessionProjections,
    sessionQuery: ctx.sessionQuery,
    agents: ctx.agents,
  }
  let host = createPushHost(instrumentedHostContext)
  const seen = []
  host.subscribe(source => seen.push(source), () => {})
  result.available = host.available
  try {
    check('required public DSH services available', host.available)
    const planCallId = 'push-contract-plan-' + randomUUID()
    const planBarrier = new Promise(resolve => { releasePlan = resolve })
    controls.releasePlan = releasePlan
    removePlanAnswerer = ctx.on('user-questions/request', function (request, next) {
      if (request.questions?.some(item => item.intent?.kind === 'plan-review')) return planBarrier
      return next()
    }, { global: true, prepend: true })
    const approvalBarrier = new Promise(resolve => { releaseApproval = resolve })
    controls.releaseApproval = releaseApproval
    removeApprovalAnswerer = ctx.on('approval/request', function (_request, _next) {
      result.approvalAnswererEntries++
      result.approvalAnswererEnteredAt ??= Date.now()
      return approvalBarrier
    }, { global: true, prepend: true })
    const rootId = 'push-contract-root-' + randomUUID()
    let setupAgent
    let setupAgentRoot
    let setupSawUnpublishedAgent = false
    const rootHandle = await ctx.agents.create({
      sessionId: rootId,
      agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' },
      setup(agentCtx, agent) {
        setupAgent = agent
        setupAgentRoot = agentCtx.root
        setupSawUnpublishedAgent = ctx.agents.get(agent.id) === undefined
      },
    })
    await stage('root-agent-created')
    handles.push(rootHandle)
    const root = rootHandle.agent
    rootFixtureAgent = root
    const fixtureCtxRoot = ctx.root
    const agentCtxRoot = root.ctx.root
    // DSH 0.2.2-rc.2 removed AgentRegistry#roots()/#isOwnedBy(); the durable subagent
    // header is the public fallback for identifying an owned child. The fixture Agent is
    // top-level either way, so this check stays meaningful on both API shapes.
    const fixtureOwnership = (() => {
      if (typeof ctx.agents.roots === 'function' && typeof ctx.agents.isOwnedBy === 'function') {
        return {
          isRuntimeRoot: ctx.agents.roots().includes(root),
          hasLiveOwner: ctx.agents.list().some(owner => ctx.agents.isOwnedBy(root.id, owner)),
        }
      }
      const header = root.session?.header
      const parentSession = header?.origin === 'subagent' ? header?.parentSession : undefined
      return {
        isRuntimeRoot: parentSession === undefined,
        hasLiveOwner: typeof parentSession === 'string' && ctx.agents.get(parentSession) !== undefined,
      }
    })()
    result.contextIdentity = {
      fixtureRootExposed: 'root' in ctx,
      fixtureRootIsSelfRoot: fixtureCtxRoot.root === fixtureCtxRoot,
      agentRootIsSelfRoot: agentCtxRoot.root === agentCtxRoot,
      fixtureAndAgentShareRootIdentity: fixtureCtxRoot === agentCtxRoot,
      fixtureAndAgentShareEventBus: ctx.events === root.ctx.events,
      agentSetupRootExposed: setupAgentRoot !== undefined,
      setupRootMatchesPublicAgentCtxRoot: setupAgentRoot === agentCtxRoot,
      setupAgentMatchesFactoryResult: setupAgent === root,
      factoryWasUnpublishedDuringSetup: setupSawUnpublishedAgent,
      exactFactoryAgentLive: ctx.agents.get(root.id) === root,
      exactFactoryAgentIsRuntimeRoot: fixtureOwnership.isRuntimeRoot,
      exactFactoryAgentHasNoLiveOwner: !fixtureOwnership.hasLiveOwner,
    }
    let runtimeSessionEvents = 0
    const removeSessionProbe = ctx.on('session/event', () => { runtimeSessionEvents++ }, { global: true })
    const callId = 'push-contract-question-' + randomUUID()
    const question = { id: 'q1', question: 'Continue the fixture?', header: 'Fixture' }
    await root.session.append('request/header', {
      header: {
        config: { provider: 'push-contract-no-provider', model: 'no-network-fixture' },
        tools: [{ name: 'ask_user_question', description: 'fixture only', parameters: { type: 'object', properties: { timeout: { type: 'integer' } } } }],
      },
      reason: 'initial',
    })
    await root.session.append('turn/start', { turn: 1 })
    rootTurnOpen = true
    await root.session.append('tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: JSON.stringify({ questions: [question], timeout: 25 }) })
    check('public Session events dispatch to Host Cordis observers', runtimeSessionEvents > 0, { count: runtimeSessionEvents })
    const openState = ctx.sessionProjections.stateOf(root.session, 'userQuestions')
    check('real tool call projection opens active question', openState?.questions?.active?.some(item => item.callId === callId && item.state === 'open'), { state: openState })
    let unscopedQuestionDispatched = false
    const removeUnscopedProbe = ctx.on('user-questions/request', function (request, next) {
      if (request.questions?.some(item => item.id === 'host-event-probe')) {
        unscopedQuestionDispatched = true
        return { answers: [{ id: 'host-event-probe', selected: ['Observed'] }] }
      }
      return next()
    }, { global: true })
    const unscopedAnswer = await ctx.userQuestions.ask({ questions: [{ id: 'host-event-probe', question: 'Observe public Host dispatch?' }], signal: trackedController().signal })
    if (typeof removeUnscopedProbe === 'function') removeUnscopedProbe()
    check('unscoped public userQuestions request reaches global Host waterfall', unscopedQuestionDispatched && unscopedAnswer?.answers?.[0]?.selected?.[0] === 'Observed')
    const hostQuestionEntriesBeforeScopedAsk = observerEntries.question
    let publicQuestionDispatched = false
    const removeQuestionProbe = ctx.on('user-questions/request', function (_request, next) {
      publicQuestionDispatched = true
      return next()
    }, { global: true, prepend: true })
    const timedResult = await ctx.userQuestions.askTimed({ agent: root, questions: [question], signal: trackedController().signal }, callId, 25)
    if (typeof removeQuestionProbe === 'function') removeQuestionProbe()
    check('actual public timed question request uses a post-creation prepended Host observer', publicQuestionDispatched, { publicQuestionDispatched })
    check('the registered Host question callback enters the scoped waterfall exactly once', observerEntries.question === hostQuestionEntriesBeforeScopedAsk + 1, { before: hostQuestionEntriesBeforeScopedAsk, after: observerEntries.question })
    check('real public timed question returns continued result', timedResult?.pending === true && timedResult.callId === callId)
    await root.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: { id: randomUUID(), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(timedResult) }] },
    }, { surfaceOp: 'append' })
    const projected = ctx.sessionProjections.stateOf(root.session, 'userQuestions')?.questions?.active?.find(question => question.callId === callId)
    check('real userQuestions projection reports continued', projected?.state === 'continued')
    const eligibilityNow = Date.now()
    const expectedSource = { sourceId: 'request:' + root.id + ':question:' + callId, sessionId: root.id, targetSessionId: root.id, category: 'question', createdAt: eligibilityNow, expiresAt: eligibilityNow + ATTENTION_TTL_MS, lifetime: 'live', callId }
    check('public Host policy considers the continued timed request eligible', await host.eligible(expectedSource), { hostAvailable: host.available, sourceId: expectedSource.sourceId })
    if (typeof removeSessionProbe === 'function') removeSessionProbe()
    const questionSource = await waitForOwned(() => seen.find(source => source.callId === callId), 'real timed question observer')
    result.sources.push(sourceSummary(questionSource))
    await stage('question-source-observed')
    await persistProgress()
    check('timed question remains eligible after continued projection', await host.eligible(questionSource))
    root.inbox.append('next-turn', {
      id: randomUUID(),
      role: 'user',
      source: { kind: 'user-question-reply', callId, outcome: 'answered' },
      content: [{ type: 'text', text: JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId, questions: [question], answers: [{ id: 'q1', selected: ['Yes'] }] }) }],
    })
    check('public Agent inbox late reply suppresses attention without waking a model turn', !(await host.eligible(questionSource)))

    const planQuestion = { id: 'plan', question: 'Review this plan?', detail: '# owned fixture plan', options: [{ label: 'Approve' }, { label: 'Decline' }], intent: { kind: 'plan-review', approve: 'Approve', callId: planCallId } }
    const planPromise = ctx.userQuestions.ask({ agent: root, questions: [planQuestion], signal: trackedController().signal })
    const planSource = await waitForOwned(() => seen.find(source => source.callId === planCallId), 'retained legacy plan request')
    result.sources.push(sourceSummary(planSource))
    await stage('plan-source-observed')
    check('legacy plan source uses intent.callId and remains eligible without timed projection', planSource.category === 'plan' && planSource.callId === planCallId && await host.eligible(planSource))
    releasePlan({ answers: [{ id: 'plan', selected: ['Decline'] }] })
    await planPromise
    check('legacy plan stops being eligible when source request settles', !(await host.eligible(planSource)))
    if (typeof removePlanAnswerer === 'function') removePlanAnswerer()

    await root.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    rootTurnOpen = false
    await stage('root-turn-closed')
    const rootResponse = await waitForOwned(() => seen.find(source => source.sessionId === root.id && source.category === 'response' && source.turn === 1), 'completed root turn response')
    result.sources.push(sourceSummary(rootResponse))
    check('completed root turn response is recorded as an expected source', rootResponse.turn === 1)
    // DSH 0.2.2-rc.2 removed CreateAgentOptions#parentAgent and the registry ownership
    // walk; real subagents carry the durable origin "subagent" header instead. Keep the
    // old creation shape on hosts that still own children through the registry.
    const legacyOwnershipApi = typeof ctx.agents.roots === 'function' && typeof ctx.agents.isOwnedBy === 'function'
    const childOptions = (parent, sessionId, depth) => legacyOwnershipApi
      ? { sessionId, parentAgent: parent, agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' } }
      : { sessionId, meta: { parentSession: parent.session.id, origin: 'subagent', delegationDepth: depth }, agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' } }
    const childHandle = await ctx.agents.create(childOptions(root, 'push-contract-child-' + randomUUID(), 1))
    handles.push(childHandle)
    const forkHandle = await ctx.agents.create({ sessionId: 'push-contract-fork-' + randomUUID(), meta: { parentSession: root.session.id }, agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' } })
    handles.push(forkHandle)
    const nestedHandle = await ctx.agents.create(childOptions(childHandle.agent, 'push-contract-nested-' + randomUUID(), 2))
    handles.push(nestedHandle)
    await forkHandle.agent.session.append('turn/start', { turn: 1 })
    await forkHandle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await childHandle.agent.session.append('turn/start', { turn: 1 })
    await childHandle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const forkSource = await waitForOwned(() => seen.find(source => source.sessionId === forkHandle.agent.id && source.category === 'response'), 'ordinary fork outcome')
    result.sources.push(sourceSummary(forkSource))
    await stage('ordinary-fork-outcome-observed')
    check('ordinary fork completes but runtime-owned child completion is silent', forkSource.sessionId === forkHandle.agent.id && !seen.some(source => source.sessionId === childHandle.agent.id))

    await nestedHandle.agent.session.append('turn/start', { turn: 1 })
    const hostApprovalEntriesBeforeRequest = observerEntries.approval
    const approvalController = trackedController()
    const approvalPromise = ctx.approval.request({ agent: nestedHandle.agent, toolName: 'fixture-write', reason: 'push-contract-retained', signal: approvalController.signal })
    const approvalSource = await waitForOwned(() => seen.find(source => source.category === 'approval' && source.sessionId === nestedHandle.agent.id), 'actual nested approval request')
    result.sources.push(sourceSummary(approvalSource))
    await stage('nested-approval-source-observed')
    check('registered Host approval callback enters the nested scoped waterfall exactly once', observerEntries.approval === hostApprovalEntriesBeforeRequest + 1, { before: hostApprovalEntriesBeforeRequest, after: observerEntries.approval })
    await stage('approval-target-resolving')
    const approvalTarget = await host.resolveTarget(approvalSource)
    await stage('approval-target-resolved')
    check('nested public approval targets runtime root', approvalTarget?.sessionId === root.id && approvalTarget.interaction === 'current')
    controls.approvalBarrierReleasedAt = Date.now()
    result.approvalBarrierReleasedAt = controls.approvalBarrierReleasedAt
    releaseApproval('unavailable')
    await stage('approval-answerer-released')
    const approvalObserved = approvalPromise.then(outcome => {
      result.approvalPromiseSettledAt = Date.now()
      result.approvalOutcome = outcome
      void persistProgress()
      return { kind: 'resolved', outcome }
    }, error => {
      result.approvalPromiseSettledAt = Date.now()
      result.approvalErrorCode = error?.code
      result.approvalErrorName = error?.name
      void persistProgress()
      return { kind: 'rejected', code: error?.code, name: error?.name }
    })
    await stage('awaiting-approval-decision')
    const approvalResolutionBeforeAbort = await Promise.race([approvalObserved, pause(2_000).then(() => ({ kind: 'timeout-before-abort' }))])
    result.approvalResolutionBeforeAbort = approvalResolutionBeforeAbort
    result.approvalControllerAbortedBeforeFallback = approvalController.signal.aborted
    let approvalResolution = approvalResolutionBeforeAbort
    if (approvalResolutionBeforeAbort.kind === 'timeout-before-abort') {
      result.approvalTimedOutBeforeAbortAt = Date.now()
      approvalController.abort(new Error('fixture approval decision did not settle after answerer release'))
      approvalResolution = await Promise.race([approvalObserved, pause(2_000).then(() => ({ kind: 'timeout-after-abort' }))])
    }
    result.approvalResolution = approvalResolution
    const approvalPassed = approvalResolutionBeforeAbort.kind === 'resolved'
      && approvalResolutionBeforeAbort.outcome === 'unavailable'
      && result.approvalAnswererEntries === 1
      && approvalController.signal.aborted === false
    check('public nested approval settles as unavailable from its setup-installed answerer before fallback abort', approvalPassed, { answererEntries: result.approvalAnswererEntries, resolutionBeforeAbort: approvalResolutionBeforeAbort, signalAborted: approvalController.signal.aborted, barrierReleasedAt: result.approvalBarrierReleasedAt, settledAt: result.approvalPromiseSettledAt })
    await stage('approval-resolution-observed')
    await nestedHandle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await stage('nested-approval-settled')

    await stage('goal-agent-create-started')
    const goalHandle = await ctx.agents.create({ sessionId: 'push-contract-goal-' + randomUUID(), agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' } })
    handles.push(goalHandle)
    await stage('goal-agent-created')
    const goal = ctx.goals.create(goalHandle.agent, { objective: 'Complete a fixture goal', maxGoalRounds: 2 })
    ctx.goals.disarm(goalHandle.agent)
    await stage('goal-created-and-disarmed')
    await goalHandle.agent.session.append('turn/start', { turn: 1 })
    await stage('goal-first-turn-started')
    await goalHandle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await stage('goal-first-turn-ended')
    await pause(OUTCOME_COALESCE_MS + 50)
    await stage('goal-first-round-coalesced')
    check('active goal round does not produce ordinary response source', !seen.some(source => source.sessionId === goalHandle.agent.id && (source.category === 'response' || source.category === 'goal')))
    await stage('completing-goal')
    const completed = ctx.goals.complete(goalHandle.agent, { id: goal.id, revision: goal.revision })
    await stage('goal-completed')
    await goalHandle.agent.session.append('turn/start', { turn: 2 })
    await stage('final-goal-turn-started')
    await goalHandle.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await stage('final-goal-turn-ended')
    await stage('waiting-for-final-goal-source')
    const goalSource = await waitForOwned(() => seen.find(source => source.sessionId === goalHandle.agent.id && source.category === 'goal' && source.goal?.revision === completed.revision), 'committed final goal outcome')
    result.sources.push(sourceSummary(goalSource))
    await stage('final-goal-source-observed')
    check('goal completion waits for final turn and coalesces to one goal outcome', seen.filter(source => source.sessionId === goalHandle.agent.id && source.category === 'goal').length === 1 && !seen.some(source => source.sessionId === goalHandle.agent.id && source.category === 'response'))
    await goalHandle.agent.session.append('turn/start', { turn: 3 })
    await stage('post-goal-ordinary-turn-started')
    await goalHandle.agent.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await stage('post-goal-ordinary-turn-ended')
    const laterOutcome = await waitForOwned(() => seen.find(source => source.sessionId === goalHandle.agent.id && source.turn === 3), 'ordinary outcome after completed goal')
    result.sources.push(sourceSummary(laterOutcome))
    await stage('post-goal-ordinary-outcome-observed')
    check('an ordinary turn after goal completion emits response instead of replaying the goal', laterOutcome.category === 'response' && seen.filter(source => source.sessionId === goalHandle.agent.id && source.category === 'goal').length === 1)

    await stage('blocked-goal-agent-create-started')
    const blockedHandle = await ctx.agents.create({ sessionId: 'push-contract-blocked-' + randomUUID(), agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' } })
    handles.push(blockedHandle)
    await stage('blocked-goal-agent-created')
    const blockedGoal = ctx.goals.create(blockedHandle.agent, { objective: 'Blocked fixture goal', maxGoalRounds: 1 })
    ctx.goals.disarm(blockedHandle.agent)
    await stage('blocked-goal-created-and-disarmed')
    await blockedHandle.agent.session.append('turn/start', { turn: 1 })
    await stage('blocked-enclosing-turn-started')
    const blocked = ctx.goals.block(blockedHandle.agent, { id: blockedGoal.id, revision: blockedGoal.revision }, { code: 'fixture-blocked', message: 'do not expose this detail' })
    await stage('blocked-goal-committed')
    await blockedHandle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await stage('blocked-enclosing-turn-ended')
    const blockSource = await waitForOwned(() => seen.find(source => source.sessionId === blockedHandle.agent.id && source.category === 'goal' && source.goal?.revision === blocked.revision), 'committed blocked goal')
    result.sources.push(sourceSummary(blockSource))
    await stage('blocked-goal-source-observed')
    await pause(OUTCOME_COALESCE_MS + 50)
    const blockedOutcomes = seen.filter(source => source.sessionId === blockedHandle.agent.id)
    check('blocked goal plus enclosing turn produces exactly one generic goal outcome', blockedOutcomes.length === 1 && blockedOutcomes[0]?.category === 'goal')
    check('blocked goal source is generic and has no raw blocked reason', !JSON.stringify(blockSource).includes('do not expose this detail'))

    await stage('failure-agent-create-started')
    const failedHandle = await ctx.agents.create({ sessionId: 'push-contract-failed-' + randomUUID(), agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' } })
    handles.push(failedHandle)
    await stage('failure-agent-created')
    await failedHandle.agent.session.append('turn/start', { turn: 1 })
    await stage('failure-turn-started')
    await failedHandle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'FIXTURE_ERROR', message: 'fixture diagnostic secret' } } })
    await stage('failure-turn-ended')
    const failureSource = await waitForOwned(() => seen.find(source => source.sessionId === failedHandle.agent.id && source.category === 'failure'), 'committed terminal failure')
    result.sources.push(sourceSummary(failureSource))
    await stage('terminal-failure-source-observed')
    check('terminal failure outcome excludes diagnostic detail', !JSON.stringify(failureSource).includes('fixture diagnostic secret'))

    const createContinuedQuestion = async label => {
      const handle = await ctx.agents.create({ sessionId: 'push-contract-' + label + '-' + randomUUID(), agentOptions: { provider: 'push-contract-no-provider', model: 'no-network-fixture' } })
      handles.push(handle)
      const callId = 'push-contract-' + label + '-call-' + randomUUID()
      const question = { id: label, question: 'Continue this isolated reconciliation fixture?', header: 'Reconcile', options: [{ label: 'Yes' }] }
      const argumentsText = JSON.stringify({ questions: [question], timeout: 25 })
      await handle.agent.session.append('turn/start', { turn: 1 })
      await handle.agent.session.append('step/start', { turn: 1, step: 1 })
      await handle.agent.session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Fixture input for a public pending-question call.' }] }, { surfaceOp: 'append' })
      await handle.agent.session.append('request/header', {
        header: {
          config: { provider: 'push-contract-no-provider', model: 'no-network-fixture' },
          tools: [{ name: 'ask_user_question', description: 'fixture only', parameters: { type: 'object', properties: { timeout: { type: 'integer' } } } }],
        },
        reason: 'initial',
      })
      const streamTime = Date.now()
      await handle.agent.session.append('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: randomUUID(),
          role: 'assistant',
          source: { kind: 'model', provider: 'push-contract-no-provider', model: 'no-network-fixture' },
          content: [{ type: 'tool-call', id: callId, name: 'ask_user_question', arguments: argumentsText }],
        },
        stream: [
          { type: 'tool-call-chunks', time0: streamTime, index: 0, dt: [0], id: callId, name: 'ask_user_question', args: [argumentsText] },
          { type: 'chunk', time: streamTime + 1, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
        ],
      }, { surfaceOp: 'append' })
      await handle.agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: argumentsText })
      const timed = await ctx.userQuestions.askTimed({ agent: handle.agent, questions: [question], signal: trackedController().signal }, callId, 25)
      await handle.agent.session.append('tool/result', {
        turn: 1,
        step: 1,
        message: { id: randomUUID(), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(timed) }] },
      }, { surfaceOp: 'append' })
      await handle.agent.session.append('step/end', { turn: 1, step: 1 })
      await handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } })
      const active = ctx.sessionProjections.stateOf(handle.agent.session, 'userQuestions')?.questions?.active?.find(item => item.callId === callId)
      const liveProjectionValues = ctx.sessionProjections.snapshot(handle.agent.session)?.values
      const flushed = await ctx.sessions.flush(handle.agent.session)
      check(label + ' fixture records a continued timed question in public projection', timed?.pending === true && active?.state === 'continued' && flushed === true, { liveProjectionKeys: Object.keys(liveProjectionValues ?? {}), liveInboxKeys: Object.keys(liveProjectionValues?.inbox ?? {}), flushed })
      const source = await waitForOwned(() => seen.find(item => item.sessionId === handle.agent.id && item.callId === callId), label + ' persisted question source')
      result.sources.push(sourceSummary(source))
      return { handle, callId, question, source }
    }
    const coldContinued = await createContinuedQuestion('cold-continued')
    await coldContinued.handle.agent.session.append('turn/start', { turn: 2 })
    await coldContinued.handle.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const laterTurnFlushed = await ctx.sessions.flush(coldContinued.handle.agent.session)
    const liveAfterLaterTurn = await host.reconcile(coldContinued.source)
    check('Host A keeps a continued timed question eligible after a later completed turn', laterTurnFlushed === true && liveAfterLaterTurn === 'eligible', { flushed: laterTurnFlushed, sourceTurn: coldContinued.source.turn, liveResult: liveAfterLaterTurn })
    const laterResponse = await waitForOwned(() => seen.find(item => item.sessionId === coldContinued.handle.agent.id && item.category === 'response' && item.turn === 2), 'later ordinary turn response')
    result.sources.push(sourceSummary(laterResponse))
    const coldQueued = await createContinuedQuestion('cold-queued')
    await coldQueued.handle.agent.session.append('turn/start', { turn: 2 })
    await coldQueued.handle.agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const coldQueuedLaterTurnFlushed = await ctx.sessions.flush(coldQueued.handle.agent.session)
    const coldQueuedLiveAfterLaterTurn = await host.reconcile(coldQueued.source)
    check('Host A keeps a queued-reply question eligible after a later completed turn', coldQueuedLaterTurnFlushed === true && coldQueuedLiveAfterLaterTurn === 'eligible', { flushed: coldQueuedLaterTurnFlushed, sourceTurn: coldQueued.source.turn, liveResult: coldQueuedLiveAfterLaterTurn })
    const coldQueuedLaterResponse = await waitForOwned(() => seen.find(item => item.sessionId === coldQueued.handle.agent.id && item.category === 'response' && item.turn === 2), 'queued-reply later ordinary turn response')
    result.sources.push(sourceSummary(coldQueuedLaterResponse))
    const hostA = host
    await hostA.close()
    await stage('reconcile-host-a-closed')
    const disposeForColdRead = async (handle, label) => {
      const index = handles.indexOf(handle)
      if (index >= 0) handles.splice(index, 1)
      await withinTimeout(handle.dispose(), 5_000, 'disposing ' + label + ' before cold reconciliation')
    }
    for (const [handle, label] of [
      [coldContinued.handle, 'continued question Agent'],
      [blockedHandle, 'blocked goal Agent'],
      [goalHandle, 'completed goal Agent'],
      [forkHandle, 'completed response Agent'],
      [failedHandle, 'terminal failure Agent'],
    ]) await disposeForColdRead(handle, label)
    await stage('reconcile-agents-unpublished')
    const hostB = createPushHost(instrumentedHostContext)
    host = hostB
    const sourcesAfterRestart = []
    hostB.subscribe(source => sourcesAfterRestart.push(source), () => {})
    check('Host B requires the complete public reconciliation contract', hostB.available && typeof hostB.reconcile === 'function')
    const reconcile = async source => typeof hostB.reconcile === 'function' ? hostB.reconcile(source) : 'missing'
    const queryCold = async sessionId => {
      let observation
      try {
        observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'all' })
        return { source: observation.source, values: structuredClone(observation.projections?.values), asOfSeq: observation.projections?.asOfSeq, cursor: observation.cursor }
      } catch (error) {
        return { errorCode: error?.code, errorName: error?.name }
      } finally { observation?.[Symbol.dispose]() }
    }
    const coldContinuedView = await queryCold(coldContinued.handle.agent.id)
    const coldContinuedLatestTurn = coldContinuedView.values?.mobilePushLifecycle?.latestTurn
    const continuedCallActive = coldContinuedView.values?.userQuestions?.active?.some(item => item.callId === coldContinued.callId && item.state === 'continued')
    const continuedCallQueued = ['next-turn', 'next-step'].some(key => (coldContinuedView.values?.inbox?.[key] ?? []).some(message => message?.source?.kind === 'user-question-reply' && message.source.callId === coldContinued.callId && message.source.outcome === 'answered'))
    const continuedResult = await reconcile(coldContinued.source)
    check('Host B cold-reconciles a continued question without a live Agent', coldContinuedView.source === 'prepared' && continuedCallActive && !continuedCallQueued && ctx.agents.get(coldContinued.handle.agent.id) === undefined && coldContinued.source.turn === 1 && coldContinuedLatestTurn === 2 && continuedResult === 'eligible', { observation: coldContinuedView.source, queryErrorCode: coldContinuedView.errorCode, queryErrorName: coldContinuedView.errorName, cursor: coldContinuedView.cursor, asOfSeq: coldContinuedView.asOfSeq, valuesPresent: Boolean(coldContinuedView.values), result: continuedResult, active: continuedCallActive, activeQuestionProjected: continuedCallActive, matchingReplyQueued: continuedCallQueued, sourceTurn: coldContinued.source.turn, latestTurn: coldContinuedLatestTurn, projectionKeys: Object.keys(coldContinuedView.values ?? {}), userQuestionKeys: Object.keys(coldContinuedView.values?.userQuestions ?? {}), inboxKeys: Object.keys(coldContinuedView.values?.inbox ?? {}), lifecycle: coldContinuedView.values?.mobilePushLifecycle })
    const queuedBeforeReplyResult = await reconcile(coldQueued.source)
    check('Host B keeps the continued question eligible after restart before a reply', queuedBeforeReplyResult === 'eligible' && ctx.agents.get(coldQueued.handle.agent.id) === coldQueued.handle.agent, { result: queuedBeforeReplyResult, liveAgentRetained: ctx.agents.get(coldQueued.handle.agent.id) === coldQueued.handle.agent })
    coldQueued.handle.agent.inbox.append('next-turn', {
      id: randomUUID(), role: 'user', source: { kind: 'user-question-reply', callId: coldQueued.callId, outcome: 'answered' },
      content: [{ type: 'text', text: JSON.stringify({ callId: coldQueued.callId, answers: [{ id: coldQueued.question.id, selected: ['Yes'] }] }) }],
    })
    const queuedInboxFlushed = await ctx.sessions.flush(coldQueued.handle.agent.session)
    const liveQueuedValues = ctx.sessionProjections.snapshot(coldQueued.handle.agent.session)?.values
    const queuedCallPresent = ['next-turn', 'next-step'].some(key => (liveQueuedValues?.inbox?.[key] ?? []).some(message => message?.source?.kind === 'user-question-reply' && message.source.callId === coldQueued.callId && message.source.outcome === 'answered'))
    const queuedResult = await reconcile(coldQueued.source)
    check('Host B post-restart reconciliation marks a queued inbox reply stale', queuedInboxFlushed === true && queuedCallPresent && ctx.agents.get(coldQueued.handle.agent.id) === coldQueued.handle.agent && queuedResult === 'stale', { result: queuedResult, matchingReplyQueued: queuedCallPresent, liveAgentRetained: ctx.agents.get(coldQueued.handle.agent.id) === coldQueued.handle.agent, inboxQueueSizes: Object.fromEntries(['next-turn', 'next-step'].map(key => [key, Array.isArray(liveQueuedValues?.inbox?.[key]) ? liveQueuedValues.inbox[key].length : null])) })
    const coldBlockedView = await queryCold(blockedHandle.agent.id)
    const coldGoalView = await queryCold(goalHandle.agent.id)
    const coldBlockResult = await reconcile(blockSource)
    const oldGoalResult = await reconcile(goalSource)
    check('Host B verifies current goal and rejects an outcome superseded by a later turn', coldBlockedView.source === 'prepared' && coldBlockedView.values?.goal?.goal?.id === blockSource.goal?.id && coldBlockResult === 'eligible' && coldGoalView.source === 'prepared' && coldGoalView.values?.goal?.goal?.id === goalSource.goal?.id && oldGoalResult === 'stale', { blockedObservation: coldBlockedView.source, blockedResult: coldBlockResult, completedObservation: coldGoalView.source, completedResult: oldGoalResult })
    const coldResponseView = await queryCold(forkHandle.agent.id)
    const coldFailureView = await queryCold(failedHandle.agent.id)
    const responseResult = await reconcile(forkSource)
    const failureResult = await reconcile(failureSource)
    check('Host B cold-verifies a committed ordinary response from public turn metadata', coldResponseView.source === 'prepared' && coldResponseView.values?.mobilePushLifecycle?.lastTurnEnd?.reason === 'completed' && responseResult === 'eligible', { observation: coldResponseView.source, sourceTurn: forkSource.turn, latestTurn: coldResponseView.values?.mobilePushLifecycle?.latestTurn, turnEndReason: coldResponseView.values?.mobilePushLifecycle?.lastTurnEnd?.reason, result: responseResult })
    check('Host B cold-verifies a terminal failure without retaining diagnostic detail', coldFailureView.source === 'prepared' && coldFailureView.values?.mobilePushLifecycle?.lastTurnEnd?.reason === 'error' && failureResult === 'eligible', { observation: coldFailureView.source, sourceTurn: failureSource.turn, latestTurn: coldFailureView.values?.mobilePushLifecycle?.latestTurn, turnEndReason: coldFailureView.values?.mobilePushLifecycle?.lastTurnEnd?.reason, result: failureResult })
    const persistedPlanResult = await reconcile(planSource)
    const persistedApprovalResult = await reconcile(approvalSource)
    check('Host B drops legacy plan and approval without live proof as unverifiable', persistedPlanResult === 'unverifiable' && persistedApprovalResult === 'unverifiable', { plan: persistedPlanResult, approval: persistedApprovalResult })
    check('reconciliation does not emit or replay historical sources', sourcesAfterRestart.length === 0)

    check('all candidate source identities are unique', new Set(result.sources.map(source => source.sourceId)).size === result.sources.length)
    const recordedSourceIds = new Set(result.sources.map(source => source.sourceId))
    const unrecordedSources = seen.filter(source => !recordedSourceIds.has(source.sourceId)).map(sourceSummary)
    check('no unexpected extra sources', unrecordedSources.length === 0, { seen: seen.length, recorded: result.sources.length, unrecorded: unrecordedSources })
    result.observerEntries = { ...observerEntries }
    result.ok = result.checks.every(check => check.ok)
  } catch (error) {
    result.ok = false
    result.stageAtFailure = result.stage
    result.cancelReason = controls.cancelReason
    result.error = String(error?.stack ?? error?.message ?? error).slice(0, 4000)
    result.observerEntries = { ...observerEntries }
    result.sourcesAtFailure = seen.map(sourceSummary)
  } finally {
    try { releasePlan?.({ answers: [{ id: 'plan', selected: ['Decline'] }] }) } catch {}
    try { releaseApproval?.('unavailable') } catch {}
    try { removePlanAnswerer?.() } catch {}
    try { removeApprovalAnswerer?.() } catch {}
    result.stage = 'teardown-aborting-requests'
    await persistProgress()
    for (const controller of controls.controllers) controller.abort(new Error('fixture job cleanup'))
    if (rootTurnOpen && rootFixtureAgent) {
      try {
        await withinTimeout(rootFixtureAgent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: 'fixture cleanup' } }), 5_000, 'closing fixture root turn')
        rootTurnOpen = false
      } catch (error) { result.cleanupError = String(error?.message ?? error).slice(0, 500) }
    }
    try { await withinTimeout(host.close(), 5_000, 'closing Host listeners') } catch (error) { result.cleanupError = String(error?.message ?? error).slice(0, 500) }
    for (const [index, owned] of handles.reverse().entries()) {
      result.stage = 'disposing-fixture-agent-' + index
      await persistProgress()
      try { await withinTimeout(owned.dispose(), 5_000, 'disposing fixture Agent ' + index) } catch (error) { result.cleanupError = String(error?.message ?? error).slice(0, 500) }
    }
    if (result.cleanupError) {
      result.ok = false
      result.stage = 'teardown-failed'
    }
    const home = process.env.DSH_HOME ?? process.cwd()
    const destination = join(home, 'push-contract-result.json')
    await writeResult(destination, result)
    if (!result.ok) throw new Error('public push host contract fixture failed; see owned push-contract-result.json')
  }
}

const FIXTURE_JOB_TIMEOUT_MS = 60_000
const FIXTURE_TEARDOWN_TIMEOUT_MS = 20_000

export async function apply(ctx) {
  const controls = { controllers: new Set(), cancelled: false, applyEnteredAt: Date.now() }
  let startTimer
  let deadlineTimer
  let job
  const cancelOwnedWork = reason => {
    controls.cancelReason ??= reason
    controls.cancelAt ??= Date.now()
    controls.cancelled = true
    if (controls.result) {
      controls.result.cancelReason = controls.cancelReason
      controls.result.cancelledAt = controls.cancelAt
      controls.result.stageBeforeCancellation ??= controls.result.stage
      void controls.persistProgress?.()
    }
    try { controls.releasePlan?.({ answers: [{ id: 'plan', selected: ['Decline'] }] }) } catch {}
    try { controls.releaseApproval?.('unavailable') } catch {}
    for (const controller of controls.controllers) controller.abort(new Error('fixture job cancelled'))
  }
  ctx.effect(() => {
    startTimer = setTimeout(() => {
      startTimer = undefined
      if (controls.cancelled) return
      controls.jobStartedAt = Date.now()
      controls.jobDeadlineAt = controls.jobStartedAt + FIXTURE_JOB_TIMEOUT_MS
      job = runFixtureJob(ctx, controls)
      deadlineTimer = setTimeout(() => {
        if (controls.result) {
          controls.result.stageBeforeDeadlineCancellation = controls.result.stage
          controls.result.stage = 'job-deadline-cancelling'
          controls.result.ok = false
          controls.result.error = 'bounded public Host fixture job deadline exceeded'
          void controls.persistProgress?.()
        }
        cancelOwnedWork('job-deadline')
      }, FIXTURE_JOB_TIMEOUT_MS)
      void job.catch(() => {}).finally(() => clearTimeout(deadlineTimer))
    }, 0)
    return async () => {
      if (startTimer !== undefined) clearTimeout(startTimer)
      startTimer = undefined
      cancelOwnedWork('root-effect-disposed')
      if (!job) return
      try {
        await withinTimeout(job.then(() => undefined, () => undefined), FIXTURE_TEARDOWN_TIMEOUT_MS, 'public Host fixture teardown')
      } catch (error) {
        if (controls.result) {
          controls.result.ok = false
          controls.result.stage = 'teardown-timeout'
          controls.result.cleanupError = String(error?.message ?? error).slice(0, 500)
          await controls.persistProgress?.()
        }
        throw error
      }
    }
  }, 'dsh-mobile public Host contract fixture')
}
`
}

/** Create a self-contained test-only DSH Host bundle containing the current adapter. */
export async function createPushContractFixture({ root, repository, tsdown }) {
  const packageRoot = resolve(root, 'push-contract-fixture-package')
  const sourceRoot = join(packageRoot, 'src')
  const outputRoot = join(packageRoot, 'lib')
  await mkdir(sourceRoot, { recursive: true })
  await mkdir(outputRoot, { recursive: true })
  await writeFile(join(sourceRoot, 'index.ts'), hostEntrySource(resolve(repository)))
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'dsh-mobile-push-contract-fixture',
    version: '1.0.0',
    private: true,
    type: 'module',
    main: './lib/index.js',
    exports: { '.': './lib/index.js', './package.json': './package.json' },
    dependencies: { zod: '4.6.7' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n')
  await writeFile(join(packageRoot, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: dsh-mobile-push-contract-fixture',
    '      name: dsh-mobile-push-contract-fixture',
    '      inject: [agents, sessions, sessionProjections, sessionQuery, userQuestions, approval, goals]',
    '',
  ].join('\n'))
  await run(tsdown, [join(sourceRoot, 'index.ts'), '--no-config', '--format', 'esm', '--platform', 'node', '--target', 'node22', '--out-dir', outputRoot, '--clean'], packageRoot)
  const outputs = await readdir(outputRoot)
  const entryFile = outputs.find(file => file === 'index.js' || file === 'index.mjs')
  if (!entryFile) throw new Error(`No bundled Host fixture entry in ${outputRoot}; outputs=${outputs.join(',')}`)
  const manifestPath = join(packageRoot, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.main = `./lib/${entryFile}`
  manifest.exports['.'] = `./lib/${entryFile}`
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return { packageRoot, entry: join(outputRoot, entryFile), packageName: 'dsh-mobile-push-contract-fixture' }
}
