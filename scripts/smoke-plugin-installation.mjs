/** Install real tarballs through the live DSH plugin manager and verify the embedded component. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { packBundle, packedManifest, assertProfileComponents, runPackagingCommand } from './packed-profile.mjs'
import { launchDsh, removeTemporaryRoot } from './mobile-boot-fixture.mjs'
import { tarballRegistry } from './npm-tarball-registry.mjs'

const source = fileURLToPath(new URL('../', import.meta.url))
const dshBin = resolve(process.env.DSH_BOOT_SMOKE_BIN ?? join(source, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-installation-smoke-'))
let processOwner
let browser
let registry
try {
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }) + '\n')
  const linker = process.env.DSH_BOOT_SMOKE_NODE_LINKER ?? 'hoisted'
  assert.ok(['hoisted', 'isolated'].includes(linker))
  const registryInstallation = process.env.DSH_BOOT_SMOKE_INSTALL_SOURCE === 'registry'
  const privateStore = registryInstallation ? `storeDir: ${JSON.stringify(join(root, 'pnpm-store'))}\n` : ''
  await writeFile(join(profile, 'pnpm-workspace.yaml'), `packages:\n  - .\nnodeLinker: ${linker}\nautoInstallPeers: false\n${privateStore}`)
  const tarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL ?? await packBundle(source, root)
  const manifest = await packedManifest(tarball)
  assert.equal(manifest.dependencies?.['dsh-mobile-question-fixes'], undefined)
  assert.equal(manifest.bundledDependencies, undefined)
  if (registryInstallation) registry = await tarballRegistry(tarball)
  const previous = process.env.DSH_BOOT_SMOKE_PREVIOUS_MOBILE_TARBALL
  if (previous !== undefined) {
    const previousManifest = await packedManifest(previous)
    assert.equal(previousManifest.name, 'dsh-mobile')
    assert.notEqual(previousManifest.version, manifest.version)
    await runPackagingCommand(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', resolve(previous), '--ignore-scripts'], profile, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' })
  }
  processOwner = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  await page.goto(await processOwner.ready(), { waitUntil: 'domcontentloaded' })
  const rpc = async (method, args) => page.evaluate(async ({ method, args }) => {
    const response = await fetch(`/api/pluginManager/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: `pluginManager/${method}`, payload: { args } }), signal: AbortSignal.timeout(90_000) })
    const body = await response.json()
    if (!response.ok || body.result?.ok !== true) throw new Error(`Plugin-manager RPC failed: ${JSON.stringify(body)}`)
    return body.result.value
  }, { method, args })
  const installed = await rpc('installBundle', registryInstallation ? { spec: `dsh-mobile@${manifest.version}`, options: { registry: registry.origin } } : { spec: resolve(tarball) })
  assert.equal(installed.packageResult?.exitCode, 0, JSON.stringify(installed))
  if (previous === undefined) assert.equal(installed.application, 'applied', JSON.stringify(installed))
  else assert.ok(['applied', 'restart-required'].includes(installed.application), JSON.stringify(installed))
  assert.equal(installed.error, undefined)
  if (registryInstallation) {
    assert.ok(registry.requests.includes('/dsh-mobile'))
    assert.ok(registry.requests.includes(`/dsh-mobile/-/dsh-mobile-${manifest.version}.tgz`))
  }
  const mobile = join(profile, 'node_modules', 'dsh-mobile')
  await assertProfileComponents(mobile)
  const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  assert.ok(profileManifest.dsh.profile.bundles.includes('dsh-mobile'))
  assert.ok(profileManifest.dependencies['dsh-mobile'])
  const require = createRequire(join(mobile, 'packages', 'question-fixes', 'package.json'))
  assert.ok(require.resolve('dsh-mobile-question-fixes').includes('packages'))
  const lockfile = await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')
  assert.ok(!lockfile.includes('dsh-mobile-question-fixes@'), 'No separate companion installation is required')
  if (installed.application === 'restart-required') {
    await processOwner.close()
    processOwner = launchDsh(root, home, dshBin)
    await page.goto(await processOwner.ready(), { waitUntil: 'domcontentloaded' })
  }
  const rows = await rpc('listPlugins', {})
  const row = rows.find(candidate => candidate.patchId === 'dsh-ui-fixes')
  assert.ok(row?.entryId, 'The independently toggled question-card component must appear in the live plugin inventory')
  assert.equal(row.enabled, true)
  for (const enabled of [false, true]) {
    const toggle = await rpc('setPluginEnabled', { id: row.entryId, enabled })
    assert.equal(toggle.error, undefined, JSON.stringify(toggle))
    const refreshed = (await rpc('listPlugins', {})).find(candidate => candidate.entryId === row.entryId)
    assert.equal(refreshed.enabled, enabled)
  }
  await runPackagingCommand(process.execPath, [fileURLToPath(new URL('./check-packed-profile.mjs', import.meta.url)), dshBin, profile, home], root)
  console.log(`Live packed plugin ${previous === undefined ? 'installation' : 'upgrade'} passed: ${linker} pnpm, ${registryInstallation ? 'registry spec' : 'local tarball'}, self-contained component, activation, Host/Client discovery and component toggle`)
} finally {
  await browser?.close()
  await processOwner?.close()
  await registry?.close()
  await removeTemporaryRoot(root, 'dsh-mobile-installation-smoke-')
}
