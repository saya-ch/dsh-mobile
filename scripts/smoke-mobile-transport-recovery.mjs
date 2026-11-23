/** Real packed DSH transport recovery; all profiles, proxy sockets and questions are owned fixtures. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { installPackedBundle, packBundle, runPackagingCommand } from './packed-profile.mjs'
import { finishNegativeControl, observeMobileBootDiagnostics, summarizeMobileBootDiagnostics, writeMobileBootEvidence } from './mobile-boot-diagnostics.mjs'
import {
  CLIENT_TIMEOUT_MS, createMobileProfile, dismissOnboarding, launchDsh, observePluginEvents,
  observeWorkspaceStream, openPairing, pairMobilePage, removeTemporaryRoot, sanitized, within,
} from './mobile-boot-fixture.mjs'

const source = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN
  ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const prefix = 'dsh-mobile-recovery-smoke-'
const blockedRecovery = process.argv.includes('--negative-control-mux')
const interactions = process.argv.includes('--interactions')
const failedClientEvaluation = process.argv.includes('--negative-control-import')
const fixtureModuleId = 'dsh-mobile-recovery-fixture'
const evaluationMarker = `owned-client-evaluation-failure:${fixtureModuleId}`
const root = await mkdtemp(join(tmpdir(), prefix))
let dsh, browser, proxy, failure, desktop, phone, bootDiagnostics
let evaluationFailureEvidence = false
let muxFailureEvidence = false
let evidenceFailure
let stage = 'profile installation'
let rpcSequence = 0

/** A loopback-only reverse proxy whose HTTP path stays live while owned mux sockets are dropped. */
async function createProxy(targetOrigin) {
  const target = new URL(targetOrigin)
  assert.equal(target.hostname, '127.0.0.1', 'Recovery proxy may forward only to its isolated loopback Gateway')
  const sockets = new Set()
  const muxSockets = new Set()
  const state = { blocked: false, rejectedUpgrades: 0 }
  // The Gateway remains the real authentication/WS implementation. Only this
  // fixture's outer Origin is translated to the already paired loopback Origin.
  const headersFor = headers => ({ ...headers, host: target.host,
    ...(headers.origin === undefined ? {} : { origin: target.origin }) })
  const server = createServer((request, response) => {
    const upstream = httpRequest(target, { method: request.method, path: request.url,
      headers: headersFor(request.headers), agent: false }, incoming => {
      response.writeHead(incoming.statusCode ?? 502, incoming.headers)
      incoming.pipe(response)
      incoming.once('error', () => response.destroy())
    })
    upstream.once('error', () => {
      if (response.headersSent) response.destroy()
      else { response.writeHead(502); response.end() }
    })
    response.once('close', () => upstream.destroy())
    request.once('error', () => upstream.destroy())
    request.pipe(upstream)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, client, head) => {
    if (new URL(request.url, target).pathname !== '/api/remote.mux') {
      client.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    if (state.blocked) {
      state.rejectedUpgrades++
      client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const upstream = connect({ host: target.hostname, port: Number(target.port) })
    sockets.add(upstream)
    muxSockets.add(client)
    muxSockets.add(upstream)
    const closeBoth = () => { client.destroy(); upstream.destroy() }
    client.once('error', closeBoth)
    upstream.once('error', closeBoth)
    for (const socket of [client, upstream]) socket.once('close', () => {
      sockets.delete(socket); muxSockets.delete(socket); closeBoth()
    })
    client.pause()
    upstream.once('connect', () => {
      const headers = headersFor(request.headers)
      upstream.write([`GET ${request.url} HTTP/1.1`,
        ...Object.entries(headers).flatMap(([name, values]) => (Array.isArray(values) ? values : [values])
          .filter(value => value !== undefined).map(value => `${name}: ${value}`)), '', '',
      ].join('\r\n'))
      if (head.length > 0) upstream.write(head)
      client.pipe(upstream); upstream.pipe(client); client.resume()
    })
  })
  await new Promise((resolveListening, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListening)
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    origin, state,
    interrupt() { state.blocked = true; for (const socket of muxSockets) socket.destroy() },
    resume() { state.blocked = false },
    close: async () => {
      const closed = new Promise((resolveClosed, reject) => server.close(error => error === undefined ? resolveClosed() : reject(error)))
      for (const socket of sockets) socket.destroy()
      server.closeAllConnections()
      await closed
    },
  }
}

/** Observe real Chromium handshake responses, with no replacement browser WebSocket. */
async function observeUpgrades(page) {
  const cdp = await page.context().newCDPSession(page)
  const ids = new Set()
  const upgrades = []
  cdp.on('Network.webSocketCreated', event => {
    if (new URL(event.url).pathname === '/api/remote.mux') ids.add(event.requestId)
  })
  cdp.on('Network.webSocketHandshakeResponseReceived', event => {
    if (ids.has(event.requestId)) upgrades.push({ id: event.requestId, status: event.response.status })
  })
  await cdp.send('Network.enable')
  return { upgrades, close: () => cdp.detach() }
}

/** Bounded observable polling; the predicate, rather than elapsed sleep, establishes completion. */
async function eventually(predicate, message, timeout = CLIENT_TIMEOUT_MS) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise(next => setTimeout(next, 50))
  }
  throw new Error(message())
}

async function rpc(page, method, request, argumentName = 'request') {
  const response = await page.evaluate(async ({ method, request, argumentName, rpcId }) => {
    const result = await fetch(`/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { [argumentName]: request } } }),
      signal: AbortSignal.timeout(60000),
    })
    return { status: result.status, body: await result.json() }
  }, { method, request, argumentName, rpcId: `recovery-smoke-${++rpcSequence}` })
  assert.equal(response.status, 200, `${method}: ${sanitized(JSON.stringify(response))}`)
  assert.equal(response.body.result?.ok, true, `${method}: ${sanitized(JSON.stringify(response))}`)
  return response.body.result.value
}

/** Install public Client navigation and a Host asker through the real Loader. No model or tool executes. */
async function installQuestionFixture(home) {
  const name = fixtureModuleId
  const directory = join(root, name)
  await mkdir(join(directory, 'lib'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module',
    main: './lib/index.mjs', exports: { '.': './lib/index.mjs', './package.json': './package.json', './client': './lib/client.js' },
    dsh: { bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-workspace'], immediately: true } },
  }) + '\n')
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'recovery-fixture', name }] }]) + '\n')
  await writeFile(join(directory, 'lib', 'index.mjs'), `
export const inject=['webServer','sessionController','userQuestions'];
export function apply(ctx){
  const records=[];
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/mobile-recovery-fixture',handler:async(request,response)=>{
    const query=new URL(request.url,'http://fixture.invalid').searchParams;
    const action=query.get('action');
    if(action==='ask'&&request.method==='POST'){
      const resolved=await ctx.sessionController.resolveAgent(query.get('sessionId'));
      if(resolved.agent===undefined){response.writeHead(409,{'Content-Type':'application/json'});response.end(JSON.stringify({error:resolved.error}));return}
      const agent=resolved.agent;
      const id='recovery-question-'+records.length;
      const controller=new AbortController();
      const record={id,controller,state:'pending'};records.push(record);
      record.done=ctx.userQuestions.ask({agent,signal:controller.signal,questions:[{
        id,question:'Recovery fixture question '+id,options:[{label:'Keep the answer'},{label:'Other answer'}]
      }]}).then(answer=>{record.state='answered';record.answer=answer},error=>{record.state='rejected';record.error=error.message});
      response.writeHead(202,{'Content-Type':'application/json'});response.end(JSON.stringify({id}));return
    }
    if(action==='cancel'&&request.method==='POST'){
      for(const record of records)record.controller.abort(new Error('Owned recovery fixture cleanup'));
      await Promise.all(records.map(record=>record.done));
    }
    response.writeHead(200,{'Content-Type':'application/json'});
    response.end(JSON.stringify(records.map(({id,state,answer,error})=>({id,state,answer,error}))));
  }}));
  ctx.effect(()=>async()=>{for(const record of records)record.controller.abort(new Error('Owned recovery fixture disposed'));await Promise.all(records.map(record=>record.done))});
}
`)
  // DSH's real transport loads classic scripts. A top-level throw therefore
  // reaches pageerror and prevents factory registration; no apply/factory is called.
  await writeFile(join(directory, 'lib', 'client.js'), `${failedClientEvaluation ? `throw new Error(${JSON.stringify(evaluationMarker)});\n` : ''}window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:()=>({
    inject:['uiWorkspace'],apply(ctx){ctx.effect(()=>{
      window.__recoveryFixture={openSession:id=>ctx.uiWorkspace.openSession(id)};
      return()=>{delete window.__recoveryFixture};
    })}
  })});\n`)
  await runPackagingCommand(process.execPath, ['--check', join(directory, 'lib', 'index.mjs')], directory)
  await runPackagingCommand(process.execPath, ['--check', join(directory, 'lib', 'client.js')], directory)
  await installPackedBundle(await packBundle(directory, root), join(home, 'profiles', 'web'), { dshBin })
}

async function fixtureRequest(page, action, sessionId) {
  return page.evaluate(async ({ action, sessionId }) => {
    const query = new URLSearchParams({ action, ...(sessionId === undefined ? {} : { sessionId }) })
    const response = await fetch(`/api/mobile-recovery-fixture?${query}`, {
      method: action === 'state' ? 'GET' : 'POST', signal: AbortSignal.timeout(60000),
    })
    return { status: response.status, body: await response.json() }
  }, { action, sessionId })
}

async function openSession(page, sessionId) {
  await page.waitForFunction(() => typeof window.__recoveryFixture?.openSession === 'function', undefined, { timeout: CLIENT_TIMEOUT_MS })
  await page.evaluate(id => window.__recoveryFixture.openSession(id), sessionId)
  await page.waitForFunction(id => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === id, sessionId)
  await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
}

try {
  await readFile(dshBin)
  const tarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL === undefined
    ? await packBundle(source, root) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL)
  const home = await createMobileProfile(root, { tarball, dshBin })
  await installQuestionFixture(home)
  console.log('Packed candidate and optional real Host question fixture installed in the owned profile.')
  const workspacePath = join(root, 'workspace')
  const secondWorkspacePath = join(root, 'workspace-after-interruption')
  await mkdir(workspacePath); await mkdir(secondWorkspacePath)
  dsh = launchDsh(root, home, dshBin)
  console.log(`Owned recovery fixture ${JSON.stringify({ namespace: root.split(/[\\/]/u).at(-1), processId: process.pid })}`)
  browser = await chromium.launch({ headless: true })
  desktop = await browser.newPage({ locale: 'en-US' })
  const pairUrl = await openPairing(desktop, await dsh.ready(), dsh.logs)
  const workspace = await rpc(desktop, 'workspace/create', { path: workspacePath })
  const createdSession = await rpc(desktop, 'session/create', { workspaceId: workspace.workspace.workspaceId })
  proxy = await createProxy(new URL(pairUrl).origin)
  phone = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US', isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  bootDiagnostics = observeMobileBootDiagnostics(phone)
  const prompts = []
  for (const page of [desktop, phone]) {
    await page.route('**/api/session/prompt', async route => { prompts.push(route.request().url()); await route.abort('blockedbyclient') })
  }
  const upgrades = await observeUpgrades(phone)
  try {
    const pairing = new URL(pairUrl)
    pairing.host = new URL(proxy.origin).host
    stage = 'initial-mobile-boot'
    // Attach before boot: whether the page ever opens the plugin graph stream tells a
    // DSH 0.2.3+ host apart from a legacy one after the outage too.
    const pluginEvents = observePluginEvents(phone)
    const initial = await pairMobilePage(phone, pairing.href, dsh.logs)
    if (failedClientEvaluation) throw new Error('Owned Client evaluation negative control unexpectedly booted')
    assert(initial.value.items.some(item => item.workspaceId === workspace.workspace.workspaceId), 'Initial baseline missed the real fixture Workspace')
    await eventually(() => upgrades.upgrades.some(upgrade => upgrade.status === 101), () => 'Initial real mux did not report an HTTP 101 handshake')
    await dismissOnboarding(phone)
    stage = 'real Session composer readiness'
    await openSession(phone, createdSession.sessionId)
    const editor = phone.locator('[data-composer-input][contenteditable="true"]').first()
    await editor.fill('Held draft during actual socket loss; do not submit')
    const identity = await phone.evaluate(() => {
      window.__recoveryOriginalEditor = document.querySelector('[data-composer-input]')
      return performance.timeOrigin
    })
    const recoveredStream = observeWorkspaceStream(phone)
    const oldUpgradeCount = upgrades.upgrades.filter(upgrade => upgrade.status === 101).length
    const pluginGraphOpens = pluginEvents.state.opens
    const pluginGraphLegacy = pluginEvents.state.legacyStreams
    stage = 'actual mux interruption and recovery'
    proxy.interrupt()
    await eventually(() => initial.socket.isClosed(), () => 'Proxy interruption did not close the original browser mux')
    await eventually(() => proxy.state.rejectedUpgrades > 0, () => 'Client did not retry its lost mux through the real proxy')
    const health = await phone.evaluate(async () => {
      const response = await fetch('/mobile-access/health', { signal: AbortSignal.timeout(60000) })
      return { status: response.status, body: await response.json() }
    })
    assert.equal(health.status, 200, 'HTTP health failed during the intentional mux-only outage')
    const sessionsDuringOutage = await rpc(phone, 'session/list', {}, '_request')
    assert(Array.isArray(sessionsDuringOutage.items), 'Authenticated mobile HTTP API did not return its Session catalog during the mux-only outage')
    // This successful API write proves HTTP is alive and creates state which
    // only a fresh Workspace baseline can include after reconnecting.
    const added = await rpc(desktop, 'workspace/create', { path: secondWorkspacePath })
    if (!blockedRecovery) proxy.resume()
    const restored = await within(recoveredStream.baseline, blockedRecovery ? 12_000 : CLIENT_TIMEOUT_MS,
      () => {
        muxFailureEvidence = blockedRecovery && proxy.state.blocked && proxy.state.rejectedUpgrades > 0
          && recoveredStream.state.receivedFrames === 0
          && upgrades.upgrades.filter(upgrade => upgrade.status === 101).length === oldUpgradeCount
        return `No fresh Workspace baseline after mux loss; HTTP remained 200. ${sanitized(JSON.stringify(recoveredStream.state))}`
      })
    assert.notEqual(restored.socket, initial.socket, 'Recovery reused the closed mux')
    assert(!restored.socket.isClosed(), 'Recovered mux closed after its baseline')
    assert(restored.value.items.some(item => item.workspaceId === added.workspace.workspaceId), 'Recovery returned a stale Workspace baseline')
    await eventually(() => upgrades.upgrades.filter(upgrade => upgrade.status === 101).length > oldUpgradeCount,
      () => 'Recovered actual mux did not complete a fresh HTTP 101 handshake')
    assert.equal(await phone.evaluate(() => performance.timeOrigin), identity, 'Mux recovery reloaded the document')
    assert(await editor.evaluate(node => node === window.__recoveryOriginalEditor), 'Mux recovery remounted the stock editor')
    assert.equal(await editor.textContent(), 'Held draft during actual socket loss; do not submit', 'Mux recovery lost the draft')
    console.log('Actual packed DSH: mux-only outage retained HTTP 200; a new HTTP 101 and fresh Workspace baseline restored the unchanged document/editor/draft.')
    // DSH 0.2.3+ hosts deliver plugin graph changes on the same mux, and the follower
    // must reopen that stream after recovery. Its new baseline carries the full Host
    // graph, which must not unload the dedicated layout. A legacy host never opened
    // the stream, so only a page that opened it before the outage owes a new baseline;
    // a page that used neither route has already lost its graph transport.
    if (pluginGraphOpens === 0 && pluginGraphLegacy === 0) {
      throw new Error('Paired page used neither the Remote plugin graph stream nor /plugins/events before the outage')
    }
    if (pluginGraphOpens > 0) {
      stage = 'plugin graph re-baseline after mux recovery'
      await eventually(() => pluginEvents.state.sockets.some(record => record.socket === restored.socket && record.baselines > 0),
        () => 'Recovered mux did not reopen the plugin graph stream with a fresh baseline')
      assert(await phone.locator('.dshm-drawer button[data-dsh-mobile-toggle]').isVisible(),
        'Plugin graph re-baseline after mux recovery lost the dedicated drawer')
      console.log('Plugin graph stream reopened with a fresh baseline on the recovered mux; the dedicated drawer was retained.')
    } else {
      console.log('Legacy plugin event route: the recovered mux carries no plugin graph stream to reopen.')
    }

    if (interactions) {
      stage = 'desktop question navigation'
      await dismissOnboarding(desktop)
      await openSession(desktop, createdSession.sessionId)
      stage = 'Host question request'
      const asked = await fixtureRequest(desktop, 'ask', createdSession.sessionId)
      assert.equal(asked.status, 202, sanitized(JSON.stringify(asked)))
      const pendingRecords = (await fixtureRequest(desktop, 'state')).body
      assert.equal(pendingRecords[0]?.state, 'pending', `Host asker rejected the request: ${sanitized(JSON.stringify(pendingRecords))}`)
      console.log(`Real Host question is pending: ${sanitized(JSON.stringify(pendingRecords))}`)
      const question = page => page.locator('[data-question-key]').filter({ hasText: `Recovery fixture question ${asked.body.id}` })
      stage = 'desktop pending question'
      await question(desktop).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
      stage = 'mobile pending question'
      await question(phone).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
      console.log('One real Host question reached both selected desktop and mobile Sessions.')
      stage = 'pending question socket loss'
      const questionRecovery = observeWorkspaceStream(phone)
      proxy.interrupt()
      await eventually(() => restored.socket.isClosed(), () => 'Question test did not interrupt the current actual mux')
      await question(phone).waitFor({ state: 'detached', timeout: CLIENT_TIMEOUT_MS })
      assert(await question(desktop).isVisible(), 'Dropping the phone mux removed the other client pending question')
      proxy.resume()
      await within(questionRecovery.baseline, CLIENT_TIMEOUT_MS, () => 'Pending question reconnect did not restore Workspace transport')
      await question(phone).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
      const records = await fixtureRequest(desktop, 'state')
      assert.equal(records.body[0].state, 'pending', 'Disconnect silently settled the Host question')
      console.log('Pending Host question stayed live on desktop and was replayed to mobile after actual mux loss.')

      stage = 'question-result failure and recovery'
      let rejected = false
      let answerRequests = 0
      const failedResult = '**/api/$events/result'
      phone.on('request', request => {
        if (new URL(request.url()).pathname !== '/api/$events/result' || request.method() !== 'POST') return
        const outcome = request.postDataJSON()?.payload?.args?.outcome
        if (outcome?.kind === 'result' && outcome.value?.answers?.some(answer => answer.id === asked.body.id)) answerRequests++
      })
      await phone.route(failedResult, async route => {
        if (!rejected) { rejected = true; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'owned-fixture-result-unavailable' }) }) }
        else await route.continue()
      })
      await question(phone).getByRole('radio', { name: 'Keep the answer', exact: true }).click()
      await question(phone).getByRole('button', { name: /^(Submit|提交)$/u, exact: true }).click()
      await eventually(() => rejected, () => 'The actual pending question did not use the forwarded-event result API')
      await question(phone).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
      assert.equal((await fixtureRequest(desktop, 'state')).body[0].state, 'pending', 'Failed result was reported as a Host answer')
      assert.equal(answerRequests, 1, 'Question answer was automatically replayed after its failed result POST')
      await phone.unroute(failedResult)
      // The retry is a new human action, not an automatically replayed answer.
      stage = 'explicit question answer retry'
      await question(phone).getByRole('radio', { name: 'Keep the answer', exact: true }).click()
      await question(phone).getByRole('button', { name: /^(Submit|提交)$/u, exact: true }).click()
      const answered = await eventually(async () => {
        const state = await fixtureRequest(desktop, 'state')
        return state.body[0].state === 'answered' ? state.body[0] : false
      }, () => 'Retry never delivered the question answer to its real Host asker')
      assert.equal(answerRequests, 2, 'Explicit answer retry did not produce exactly one additional result POST')
      assert.deepEqual(answered.answer, { answers: [{ id: asked.body.id, selected: ['Keep the answer'] }] })
      await question(phone).waitFor({ state: 'detached', timeout: CLIENT_TIMEOUT_MS })
      await question(desktop).waitFor({ state: 'detached', timeout: CLIENT_TIMEOUT_MS })
      assert.equal(await editor.textContent(), 'Held draft during actual socket loss; do not submit', 'Question handoff lost the underlying composer draft')
      console.log('Real Host question: desktop/mobile pending delivery, mux-loss replay, failed result remaining pending and explicit successful answer retry passed. No approval/tool/model request was simulated.')
      await fixtureRequest(desktop, 'cancel')
    }
    assert.equal(prompts.length, 0, 'Recovery fixture attempted a model prompt')
  } finally { await upgrades.close() }
} catch (error) {
  let state
  if (interactions && desktop !== undefined && !desktop.isClosed()) {
    state = await desktop.evaluate(async () => {
      const response = await fetch('/api/mobile-recovery-fixture?action=state', { signal: AbortSignal.timeout(3000) })
      return { status: response.status, body: await response.json() }
    }).catch(cause => ({ unavailable: sanitized(String(cause)) }))
  }
  const questionState = state === undefined ? 'not requested' : sanitized(JSON.stringify(state))
  const diagnostics = bootDiagnostics === undefined ? undefined : await bootDiagnostics.snapshot().catch(cause => {
    evidenceFailure = new Error('Could not collect owned browser startup evidence', { cause })
    return { unavailable: sanitized(String(cause)) }
  })
  if (failedClientEvaluation && diagnostics !== undefined && !('unavailable' in diagnostics)) {
    evaluationFailureEvidence = stage === 'initial-mobile-boot'
      && diagnostics.boot.some(text => text.includes('Failed to load plugins') && text.includes(fixtureModuleId))
      && diagnostics.scripts.some(script => script.status === 200 && script.entries.includes(fixtureModuleId))
      && diagnostics.errors.some(error => error.source === 'pageerror' && error.message.includes(evaluationMarker))
  }
  let summary, evidenceFile
  if (diagnostics !== undefined && !('unavailable' in diagnostics)) {
    summary = summarizeMobileBootDiagnostics(diagnostics)
    evidenceFile = await writeMobileBootEvidence(source, root.split(/[\\/]/u).at(-1), {
      stage, questionState, processId: process.pid, runtime: dshBin,
      candidate: process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL, diagnostics,
    }).catch(cause => {
      evidenceFailure = new Error('Could not persist owned browser startup evidence', { cause })
      return { unavailable: sanitized(String(cause)) }
    })
  }
  const bootPrefix = diagnostics !== undefined && !('unavailable' in diagnostics)
    ? diagnostics.boot.map(text => text.slice(0, 3000)) : diagnostics
  failure = new Error(`${sanitized(error instanceof Error ? error.stack ?? error.message : String(error))}\nstage=${stage}; questionState=${questionState}\nrootEvidence=${JSON.stringify(summary)}\nevidenceFile=${JSON.stringify(evidenceFile)}\nbootPrefix=${JSON.stringify(bootPrefix)}\n${dsh?.logs() ?? ''}`)
} finally {
  const failures = failure === undefined ? [] : [failure]
  if (evidenceFailure !== undefined) failures.push(evidenceFailure)
  const cleanup = { browserClosed: browser === undefined, proxyClosed: proxy === undefined, dshExit: undefined, temporaryRootRemoved: false }
  bootDiagnostics?.dispose()
  if (browser !== undefined) await browser.close().then(() => { cleanup.browserClosed = true }, error => failures.push(error))
  if (proxy !== undefined) await proxy.close().then(() => { cleanup.proxyClosed = true }, error => failures.push(error))
  if (dsh !== undefined) {
    try {
      const stopped = await dsh.close()
      cleanup.dshExit = stopped
      if (stopped.forced || (stopped.code !== 0 && stopped.signal !== 'SIGTERM')) {
        failures.push(new Error(`Recovery DSH fixture did not stop quiescently: ${sanitized(JSON.stringify(stopped))}`))
      }
    } catch (error) { failures.push(error) }
  }
  await removeTemporaryRoot(root, prefix).then(() => { cleanup.temporaryRootRemoved = true }, error => failures.push(error))
  console.log(`Recovery fixture cleanup ${JSON.stringify(cleanup)}`)
  const negativeFailure = finishNegativeControl(failures, 'Module evaluation negative control detected', evaluationFailureEvidence)
    ?? finishNegativeControl(failures, 'Mux recovery negative control detected', muxFailureEvidence)
  if (negativeFailure !== undefined) throw negativeFailure
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Transport recovery acceptance and cleanup failed')
}
