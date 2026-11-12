import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { launchDsh, removeTemporaryRoot, within } from './mobile-boot-fixture.mjs'
import { npmCli, runPackagingCommand } from './packed-profile.mjs'
import { createPushContractFixture } from './push-contract-fixture.mjs'

const repository = fileURLToPath(new URL('../', import.meta.url))
const dshBin = process.env.DSH_BOOT_SMOKE_BIN
if (typeof dshBin !== 'string' || dshBin.trim() === '') throw new Error('Set DSH_BOOT_SMOKE_BIN to the explicit owned @deepseek-ai/dsh/lib/bin.js path')
const binary = resolve(dshBin)
const metadata = await lstat(binary)
if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('DSH_BOOT_SMOKE_BIN must resolve to a regular explicit DSH CLI file')
const expectedVersion = createRequire(binary)('@deepseek-ai/dsh/package.json').version
// Allowed DSH runtimes for the packed push lanes (kept identical to scripts/smoke-mobile-push.mjs).
const RUNTIME_VERSIONS = ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.2']
assert(RUNTIME_VERSIONS.includes(expectedVersion), `The push contract evidence requires an allowed DSH runtime (got ${expectedVersion}, allowed ${RUNTIME_VERSIONS.join('/')})`)

const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-push-contract-'))
let server
let envSnapshot
let activeHome
let runnerProgressPath
let terminalError
let successSummary
const runnerTimeline = []
const logRunner = async (event, details = {}) => {
  const record = { event, at: Date.now(), ...details }
  runnerTimeline.push(record)
  if (runnerProgressPath) await writeFile(runnerProgressPath, JSON.stringify(runnerTimeline, null, 2) + '\\n', { mode: 0o600 })
}
const configNames = ['NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_GLOBALCONFIG', 'npm_config_userconfig', 'npm_config_globalconfig', 'NPM_CONFIG_ALLOW_SCRIPTS', 'npm_config_allow_scripts']
try {
  const home = join(root, 'home')
  activeHome = home
  runnerProgressPath = join(home, 'push-contract-runner-progress.json')
  const profile = join(home, 'profiles', 'web')
  const privateStore = join(root, 'pnpm-store')
  const userConfig = join(root, 'npm-user-config')
  const globalConfig = join(root, 'npm-global-config')
  await mkdir(profile, { recursive: true })
  await logRunner('smoke-start', { binary, expectedVersion })
  await mkdir(privateStore, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2) + '\n')
  await writeFile(join(profile, 'pnpm-workspace.yaml'), `packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\nstoreDir: ${JSON.stringify(privateStore)}\npackageImportMethod: copy\n`)
  await writeFile(userConfig, '# owned push contract fixture\n', { mode: 0o600 })
  await writeFile(globalConfig, '# owned push contract fixture\n', { mode: 0o600 })
  envSnapshot = new Map(configNames.map(name => [name, process.env[name]]))
  for (const name of configNames) delete process.env[name]
  process.env.NPM_CONFIG_USERCONFIG = userConfig
  process.env.NPM_CONFIG_GLOBALCONFIG = globalConfig

  const fixture = await createPushContractFixture({ root, repository, tsdown: process.platform === 'win32' ? join(repository, 'node_modules/.bin/tsdown.CMD') : join(repository, 'node_modules/.bin/tsdown') })
  const npm = await npmCli()
  const packedOutput = await runPackagingCommand(process.execPath, [
    npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', root,
  ], fixture.packageRoot)
  const [packedFixture] = JSON.parse(packedOutput)
  if (typeof packedFixture?.filename !== 'string' || /[/\\]/u.test(packedFixture.filename)) throw new Error('Fixture npm pack returned no package filename')
  const fixtureTarball = join(root, packedFixture.filename)
  await runPackagingCommand(process.execPath, [binary, 'plugin', '--profile', 'web', 'add', resolve(fixtureTarball), '--ignore-scripts'], profile, {
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(root, '.agents'),
    DSH_TELEMETRY_DISABLED: '1',
    NPM_CONFIG_USERCONFIG: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
  })
  const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.ok(profileManifest.dsh.profile.bundles.includes(fixture.packageName), 'Owned profile must select the test-only Host bundle')
  assert.ok(profileManifest.dependencies[fixture.packageName], 'Owned profile must install the bundled Host fixture')
  const dshRoot = dirname(dirname(binary))
  const appBoot = await import(pathToFileURL(createRequire(binary).resolve('@deepseek-ai/dsh-app-boot')).href)
  const loadedProfile = appBoot.loadProfileDirectory('dsh', profile, join(dshRoot, 'package.json'), home)
  assert.ok(loadedProfile.layers.some(layer => layer.packageName === fixture.packageName), `DSH app-boot did not load the Host fixture layer; skipped=${JSON.stringify(loadedProfile.skippedBundles)}`)
  const composedEntries = appBoot.composeEntries([...loadedProfile.layers.map(layer => layer.patches), loadedProfile.patches])
  assert.ok(composedEntries.some(entry => entry.id === fixture.packageName), `Real DSH Cordis patch composition omitted the test Host entry: ${JSON.stringify(composedEntries.slice(-8))}`)
  const composedConfig = await runPackagingCommand(process.execPath, [binary, '--profile', 'web', '--dump-config'], profile, {
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(root, '.agents'),
    DSH_TELEMETRY_DISABLED: '1',
  })
  assert.ok(composedConfig.includes(fixture.packageName), `Real DSH app-boot composition must include the test-only Host plugin; manifest=${JSON.stringify(profileManifest)}; loaded=${JSON.stringify(loadedProfile.layers.filter(layer => layer.packageName === fixture.packageName).map(layer => ({ packageName: layer.packageName, patches: layer.patches })))}; configPrefix=${composedConfig.slice(0, 5000)}; configSuffix=${composedConfig.slice(-4000)}`)
  assert.equal(process.env.DSH_BOOT_SMOKE_BIN, dshBin, 'The explicit runtime selector must remain unchanged')

  await logRunner('dsh-launch-start')
  server = launchDsh(root, home, binary)
  await logRunner('dsh-process-launched')
  let baseUrl
  try {
    baseUrl = await server.ready()
    await logRunner('dsh-ready', { baseUrl })
  } catch (error) {
    await logRunner('dsh-ready-failed', { message: error.message })
    let progress = '<no Host fixture progress record>'
    let resultRecord = '<no Host fixture result record>'
    let runnerProgress = '<no runner progress record>'
    try { progress = await readFile(join(home, 'push-contract-progress.json'), 'utf8') } catch {}
    try { resultRecord = await readFile(join(home, 'push-contract-result.json'), 'utf8') } catch {}
    try { runnerProgress = await readFile(runnerProgressPath, 'utf8') } catch {}
    throw new Error(`${error.message}\\nfixture progress=${progress}\\nfixture result=${resultRecord}\\nrunner timeline=${runnerProgress}`)
  }
  const evidencePath = join(home, 'push-contract-result.json')
  const fixtureTimeoutMs = Number(process.env.DSH_PUSH_CONTRACT_WAIT_MS ?? 90_000)
  const resultWaitStartedAt = Date.now()
  const resultWaitDeadlineAt = resultWaitStartedAt + fixtureTimeoutMs
  await logRunner('fixture-result-wait-start', { fixtureTimeoutMs, resultWaitStartedAt, resultWaitDeadlineAt })
  const evidence = await within((async () => {
    while (Date.now() < resultWaitDeadlineAt) {
      try {
        const parsed = JSON.parse(await readFile(evidencePath, 'utf8'))
        await logRunner('fixture-result-received', { stage: parsed.stage, stageBeforeDeadlineCancellation: parsed.stageBeforeDeadlineCancellation, cancelReason: parsed.cancelReason, jobStartedAt: parsed.jobStartedAt, cancelledAt: parsed.cancelledAt })
        return parsed
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
    }
    let progress = '<no Host fixture progress record>'
    let profilePatch = '<no profile cordis.patch.yml>'
    let pluginManifest = '<no fixture package>'
    try { progress = await readFile(join(home, 'push-contract-progress.json'), 'utf8') } catch {}
    try { profilePatch = await readFile(join(profile, 'cordis.patch.yml'), 'utf8') } catch {}
    try { pluginManifest = JSON.stringify(JSON.parse(await readFile(join(profile, 'node_modules', fixture.packageName, 'package.json'), 'utf8'))) } catch {}
    throw new Error(`Timed out waiting for the real Host fixture evidence at ${evidencePath}; progress=${progress}; profilePatch=${profilePatch}; pluginManifest=${pluginManifest}`)
  })(), fixtureTimeoutMs + 5_000, () => `DSH Host contract fixture did not complete; logs: ${server?.logs()}`)

  assert.equal(evidence.runtime, 'dsh-cordis-host')
  assert.equal(evidence.available, true)
  assert.equal(evidence.ok, true, JSON.stringify(evidence, null, 2))
  const required = [
    'required public DSH services available',
    'real public timed question returns continued result',
    'real userQuestions projection reports continued',
    'the registered Host question callback enters the scoped waterfall exactly once',
    'timed question remains eligible after continued projection',
    'public Agent inbox late reply suppresses attention without waking a model turn',
    'legacy plan source uses intent.callId and remains eligible without timed projection',
    'ordinary fork completes but runtime-owned child completion is silent',
    'completed root turn response is recorded as an expected source',
    'registered Host approval callback enters the nested scoped waterfall exactly once',
    'public nested approval settles as unavailable from its setup-installed answerer before fallback abort',
    'nested public approval targets runtime root',
    'active goal round does not produce ordinary response source',
    'goal completion waits for final turn and coalesces to one goal outcome',
    'an ordinary turn after goal completion emits response instead of replaying the goal',
    'blocked goal plus enclosing turn produces exactly one generic goal outcome',
    'blocked goal source is generic and has no raw blocked reason',
    'terminal failure outcome excludes diagnostic detail',
    'Host B requires the complete public reconciliation contract',
    'Host A keeps a continued timed question eligible after a later completed turn',
    'Host A keeps a queued-reply question eligible after a later completed turn',
    'Host B cold-reconciles a continued question without a live Agent',
    'Host B keeps the continued question eligible after restart before a reply',
    'Host B post-restart reconciliation marks a queued inbox reply stale',
    'Host B verifies current goal and rejects an outcome superseded by a later turn',
    'Host B cold-verifies a committed ordinary response from public turn metadata',
    'Host B cold-verifies a terminal failure without retaining diagnostic detail',
    'Host B drops legacy plan and approval without live proof as unverifiable',
    'reconciliation does not emit or replay historical sources',
    'all candidate source identities are unique',
    'no unexpected extra sources',
  ]
  for (const name of required) assert.ok(evidence.checks.some(check => check.name === name && check.ok === true), `Missing successful runtime evidence: ${name}`)
  successSummary = {
    status: 'PASS',
    runtime: expectedVersion,
    cli: binary,
    baseUrl,
    evidence: evidence.checks,
    sources: evidence.sources,
    isolation: { dshHome: home, pnpmStore: privateStore, npmUserConfig: userConfig, npmGlobalConfig: globalConfig },
  }
} catch (error) {
  terminalError = error
  await logRunner('runner-failure', { message: String(error?.message ?? error).slice(0, 500) })
  if (server) terminalError.message = `${terminalError.message}\nOwned DSH fixture logs:\n${server.logs()}`
} finally {
  await logRunner('server-close-start')
  await server?.close()
  await logRunner('server-close-complete')
  if (envSnapshot) {
    for (const [name, value] of envSnapshot) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  await removeTemporaryRoot(root, 'dsh-mobile-push-contract-')
}
if (terminalError) {
  terminalError.message = `${terminalError.message}\nRunner timeline=${JSON.stringify(runnerTimeline)}`
  throw terminalError
}
assert.ok(successSummary, 'Successful runtime evidence was not retained through owned DSH cleanup')
const resultReceived = runnerTimeline.find(event => event.event === 'fixture-result-received')
const closeStart = runnerTimeline.find(event => event.event === 'server-close-start')
const closeComplete = runnerTimeline.find(event => event.event === 'server-close-complete')
assert.ok(resultReceived && closeStart && closeComplete, 'Runner timeline must include fixture result and owned server close start/completion')
assert.ok(resultReceived.at <= closeStart.at && closeStart.at <= closeComplete.at, 'Fixture result receipt must precede the bounded owned server close')
successSummary.runnerTimeline = runnerTimeline
console.log(JSON.stringify(successSummary, null, 2))
