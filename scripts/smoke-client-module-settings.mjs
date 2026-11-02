/** Real packed DSH, unmodified published skin, and device-local module settings acceptance. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { packBundle, runPackagingCommand } from './packed-profile.mjs'
import { observeMobileBootDiagnostics, summarizeMobileBootDiagnostics } from './mobile-boot-diagnostics.mjs'
import { CLIENT_TIMEOUT_MS, createMobileProfile, dismissOnboarding, launchDsh, openMobileSettings, openPairing,
  pairMobilePage, removeTemporaryRoot, sanitized } from './mobile-boot-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined ? repository : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN ?? join(repository, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
await access(dshBin).catch(error => { throw new Error('Set DSH_BOOT_SMOKE_BIN to the installed DSH CLI used by this isolated test.', { cause: error }) })
const skinId = '@smalltailqwq/dsh-client-ui-skin-maid-atelier'
const skinVersion = '0.1.7'
const skinSha256 = 'd4ee729dd61341e7190dca3447522b65685951afc6ea759a2b4c327412a9e7ba'
const modulePath = '/mobile-access/client-modules'
const prefix = 'dsh-mobile-module-settings-smoke-'
const root = await mkdtemp(join(tmpdir(), prefix))
const evidence = process.env.DSH_MODULE_SETTINGS_EVIDENCE_DIR === undefined
  ? join(repository, 'local/client-module-settings-smoke', randomUUID()) : resolve(process.env.DSH_MODULE_SETTINGS_EVIDENCE_DIR)
const originalCache = process.env.NPM_CONFIG_CACHE
process.env.NPM_CONFIG_CACHE = join(root, 'npm-cache')
const record = { skin: { package: skinId, version: skinVersion, sha256: skinSha256 }, checks: [], geometry: [], pageErrors: [], requests: [], prompts: 0 }
let dsh
let browser
let phone
let failure
let bootDiagnostics
let stage = 'profile-installation'

async function createWorkspace(desktop, path) {
  const result = await desktop.evaluate(async path => {
    const response = await fetch('/api/workspace/create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'module-settings-workspace', method: 'workspace/create', payload: { args: { request: { path } } } }),
      signal: AbortSignal.timeout(60_000),
    })
    return { status: response.status, body: await response.json() }
  }, path)
  assert.equal(result.status, 200, 'Owned workspace creation HTTP failure')
  assert.equal(result.body.result?.ok, true, `Owned workspace creation failed: ${sanitized(JSON.stringify(result.body))}`)
  assert.equal(typeof result.body.result.value.workspace?.workspaceId, 'string')
  return result.body.result.value.workspace.workspaceId
}

async function openOwnedSession(workspaceId) {
  const drawer = phone.locator('.dshm-drawer')
  if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  const row = drawer.locator(`[role="treeitem"][data-row-key="workspace:${workspaceId}"]`)
  await row.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  const [created] = await Promise.all([
    phone.waitForResponse(response => new URL(response.url()).pathname === '/api/session/create'
      && response.request().postDataJSON()?.payload?.args?.request?.workspaceId === workspaceId, { timeout: CLIENT_TIMEOUT_MS }),
    row.getByRole('button').last().click(),
  ])
  assert.equal(created.status(), 200, 'Owned Session creation HTTP failure')
  const result = await created.json()
  assert.equal(result.result?.ok, true, `Owned Session creation failed: ${sanitized(JSON.stringify(result))}`)
  const sessionId = result.result.value.sessionId
  assert.equal(typeof sessionId, 'string')
  await phone.waitForFunction(id => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === id, sessionId, { timeout: CLIENT_TIMEOUT_MS })
  if (await drawer.getAttribute('data-open') === 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  return sessionId
}

const frames = page => page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
const dialog = () => phone.locator('.dsh-module-dialog[open]')
const save = () => dialog().getByRole('button', { name: /^(?:保存选择|Save selection|Salva selezione)$/u })
const close = () => dialog().getByRole('button', { name: /^(?:关闭|Close|Chiudi)$/u })
const reread = () => dialog().getByRole('button', { name: /^(?:重新读取|Reread settings|Rileggi impostazioni)$/u })
const reset = () => dialog().getByRole('button', { name: /^(?:恢复默认|Restore defaults|Ripristina predefiniti)$/u })
const skinRow = () => dialog().locator(`[data-client-module-id="${skinId}"]`)

function contrast(foreground, background) {
  const rgb = value => {
    const parts = /^rgba?\(([^)]+)\)$/u.exec(value)?.[1]?.split(/[ ,/]+/u).map(Number)
    assert(parts?.length >= 3 && parts.slice(0, 3).every(Number.isFinite), `Unexpected computed CSS color: ${value}`)
    return parts
  }
  const fg = rgb(foreground), bg = rgb(background)
  assert(bg.length === 3 || bg[3] === 1, 'Native theme test requires the actual opaque dialog background')
  const alpha = fg[3] ?? 1
  const blended = fg.slice(0, 3).map((value, index) => value * alpha + bg[index] * (1 - alpha))
  const luminance = values => values.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  const a = luminance(blended), b = luminance(bg.slice(0, 3))
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

async function nativeBack() {
  return phone.evaluate(() => { const event = new Event('dsh-mobile:native-back', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })
}

async function confirm(action, operation) {
  const prompt = phone.waitForEvent('dialog', { timeout: 10_000 }).then(async confirmation => {
    assert.equal(confirmation.type(), 'confirm')
    const message = confirmation.message()
    if (action === 'accept') await confirmation.accept()
    else await confirmation.dismiss()
    return message
  })
  const [message, result] = await Promise.all([prompt, operation()])
  return { message, result }
}

async function openSettings() {
  await openMobileSettings(phone)
  await phone.locator('.dsh-module-row').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
}

async function openManager() {
  const [response] = await Promise.all([
    phone.waitForResponse(response => new URL(response.url()).pathname === modulePath && response.request().method() === 'GET'),
    phone.locator('.dsh-module-row').getByRole('button', { name: /^(?:管理|Manage|Gestisci)$/u }).click(),
  ])
  await dialog().waitFor({ state: 'visible' })
  if (response.status() === 200) await dialog().locator('[data-client-module-id]').first().waitFor({ state: 'attached' })
  return { status: response.status(), body: await response.json() }
}

async function writeSelection(operation) {
  const [response] = await Promise.all([
    phone.waitForResponse(response => new URL(response.url()).pathname === modulePath && response.request().method() === 'POST'),
    operation(),
  ])
  const body = await response.json()
  await phone.waitForFunction(() => document.querySelector('.dsh-module-save')?.textContent !== 'Saving…'
    && document.querySelector('.dsh-module-save')?.textContent !== '正在保存…'
    && document.querySelector('.dsh-module-save')?.textContent !== 'Salvataggio…')
  return { status: response.status(), body, request: response.request().postDataJSON() }
}

async function retained() {
  return phone.evaluate(() => {
    const editor = document.querySelector('[data-composer-input][contenteditable="true"]')
    if (editor === null || typeof editor.__lexicalEditor?.getEditorState !== 'function') throw new Error('Real DSH composer editor was not retained')
    return { origin: performance.timeOrigin, identity: window.__moduleSettingsRetainedDocument,
      draft: editor.__lexicalEditor.getEditorState().toJSON(), text: editor.textContent }
  })
}

async function leaveSettings() {
  if (await dialog().count()) { await close().click(); await dialog().waitFor({ state: 'detached' }) }
  assert.equal(await nativeBack(), true, 'Back did not close the real General settings')
  await phone.locator('.dsh-module-row').waitFor({ state: 'hidden' })
  const drawer = phone.locator('.dshm-drawer')
  if (await drawer.getAttribute('data-open') === 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
}

async function reopen(skinLoaded) {
  await leaveSettings()
  await phone.reload({ waitUntil: 'domcontentloaded' })
  await phone.waitForFunction(({ skinId, skinLoaded }) => {
    const root = document.querySelector('#root .dshm-shell')
    const boot = document.querySelector('[data-dsh-boot]')
    return root !== null && boot === null && window.__DSH_BOOT__?.entries?.some(entry => entry.id === skinId) === skinLoaded
  }, { skinId, skinLoaded }, { timeout: CLIENT_TIMEOUT_MS })
  await dismissOnboarding(phone)
  await frames(phone)
  assert.equal(await phone.locator('body[data-dsh-maid-atelier]').count(), skinLoaded ? 1 : 0,
    'Skin rendering did not match the actual boot manifest after manual reopening')
}

async function geometry({ width, height, scheme, largeText = false, skinLoaded = false }) {
  await phone.setViewportSize({ width, height })
  if (largeText) await phone.addStyleTag({ content: '.dsh-module-dialog{font-size:24px}.dsh-module-dialog :is(h2,h3,label,summary,p,small,span,button,input,select,code){font-size:24px!important;line-height:1.5!important}' }).then(style => style.evaluate(node => { node.dataset.moduleLargeTextFixture = 'true' }))
  await frames(phone)
  const bounds = await dialog().evaluate(node => {
    const body = node.querySelector('.dsh-module-body'), footer = node.querySelector('.dsh-module-footer')
    const box = node.getBoundingClientRect(), content = body.getBoundingClientRect(), bottom = footer.getBoundingClientRect()
    const css = getComputedStyle(node), color = getComputedStyle(node.querySelector('.dsh-module-choiceName')).color
    const secondary = getComputedStyle(node.querySelector('.dsh-module-groupHint')).color
    const controls = [...node.querySelectorAll('.dsh-module-header button,.dsh-module-footer button')].map(button => {
      const rect = button.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return { text: button.textContent, width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        hit: hit !== null && (hit === button || button.contains(hit)), disabled: button.disabled }
    })
    return { viewport: { width: innerWidth, height: innerHeight }, dark: document.body.hasAttribute('data-ds-dark-theme'),
      dialog: { left: box.left, right: box.right, top: box.top, bottom: box.bottom }, content: { height: content.height, bottom: content.bottom, client: body.clientHeight, scroll: body.scrollHeight },
      footer: { top: bottom.top, bottom: bottom.bottom }, overflow: { width: node.clientWidth, scroll: node.scrollWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth },
      color, secondary, background: css.backgroundColor, controls }
  })
  const label = `${skinLoaded ? 'published-skin' : scheme} ${width}x${height}${largeText ? ' large-text' : ''}`
  assert(bounds.dialog.left >= -1 && bounds.dialog.right <= width + 1 && bounds.dialog.top >= -1 && bounds.dialog.bottom <= height + 1, `${label}: modal clipped ${JSON.stringify(bounds)}`)
  assert(bounds.overflow.scroll <= bounds.overflow.width + 1 && bounds.overflow.body <= width + 1 && bounds.overflow.root <= width + 1, `${label}: horizontal overflow ${JSON.stringify(bounds)}`)
  assert(bounds.content.height > 0 && bounds.content.bottom <= bounds.footer.top + 1, `${label}: footer covered the list ${JSON.stringify(bounds)}`)
  for (const button of bounds.controls) {
    assert(button.width >= 48 && button.height >= 48 && button.hit, `${label}: small or blocked action ${JSON.stringify(button)}`)
    assert(button.left >= -1 && button.right <= width + 1 && button.top >= -1 && button.bottom <= height + 1, `${label}: unreachable action ${JSON.stringify(button)}`)
  }
  if (!skinLoaded) {
    assert.equal(bounds.dark, scheme === 'dark', `${label}: the real DSH theme was not applied`)
    bounds.primaryContrast = contrast(bounds.color, bounds.background)
    bounds.secondaryContrast = contrast(bounds.secondary, bounds.background)
    assert(bounds.primaryContrast >= 4.5, `${label}: unreadable module title ${JSON.stringify(bounds)}`)
    assert(bounds.secondaryContrast >= 4.5, `${label}: unreadable module hint ${JSON.stringify(bounds)}`)
  }
  if (bounds.content.scroll > bounds.content.client + 20) {
    const scroll = await dialog().locator('.dsh-module-body').evaluate(node => { node.scrollTop = Math.min(240, node.scrollHeight - node.clientHeight); return node.scrollTop })
    assert(scroll > 0, `${label}: module list did not scroll internally`)
    await dialog().locator('.dsh-module-body').evaluate(node => { node.scrollTop = 0 })
  }
  await phone.screenshot({ path: join(evidence, `${skinLoaded ? 'skin' : scheme}-${width}x${height}${largeText ? '-large-text' : ''}.png`) })
  record.geometry.push({ label, ...bounds })
  if (largeText) await phone.locator('style[data-module-large-text-fixture]').evaluateAll(nodes => nodes.forEach(node => node.remove()))
}

try {
  await mkdir(evidence, { recursive: true })
  const workspacePath = join(root, 'owned-workspace')
  await mkdir(workspacePath)
  const tarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL === undefined ? await packBundle(mobileRoot, root) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL)
  record.tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  const home = await createMobileProfile(root, { tarball, dshBin, packageStoreDirectory: join(root, 'pnpm-store'),
    extraPatches: [{ id: 'llm-deepseek', config: {
      // Declarative metadata keeps this draft-only fixture independent of provider credentials.
      models: [{ id: 'module-settings-model', name: 'Owned module settings model', contextWindow: 128000, inputModalities: ['text'] }],
    } }],
  })
  const profile = join(home, 'profiles/web')
  await runPackagingCommand(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', `${skinId}@${skinVersion}`, '--ignore-scripts'], profile,
    { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', NPM_CONFIG_CACHE: join(root, 'npm-cache') })
  const skinRoot = join(profile, 'node_modules', skinId)
  assert.equal(JSON.parse(await readFile(join(skinRoot, 'package.json'), 'utf8')).version, skinVersion)
  assert.equal(createHash('sha256').update(await readFile(join(skinRoot, 'lib/client.js'))).digest('hex'), skinSha256,
    'The installed published skin client differs from the reviewed npm artifact')
  record.pluginVersion = JSON.parse(await readFile(join(profile, 'node_modules/dsh-mobile/package.json'), 'utf8')).version
  stage = 'dsh-startup'
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
  const pairing = await openPairing(desktop, await dsh.ready(), dsh.logs)
  await desktop.locator('body[data-dsh-maid-atelier]').waitFor({ state: 'attached', timeout: CLIENT_TIMEOUT_MS })
  stage = 'owned-workspace-create'
  const workspaceId = await createWorkspace(desktop, workspacePath)
  phone = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'en-US', isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  bootDiagnostics = observeMobileBootDiagnostics(phone)
  phone.on('pageerror', error => record.pageErrors.push(error.message))
  phone.on('request', request => { if (new URL(request.url()).pathname === modulePath) record.requests.push({ method: request.method() }) })
  await phone.route('**/api/session/prompt', async route => { record.prompts++; await route.abort('blockedbyclient') })
  stage = 'mobile-pairing'
  const baseline = await pairMobilePage(phone, pairing, dsh.logs)
  assert(baseline.value.items.some(workspace => workspace.workspaceId === workspaceId), 'The actual Workspace baseline omitted the owned fixture')
  await dismissOnboarding(phone)
  await phone.locator('body[data-dsh-maid-atelier]').waitFor({ state: 'attached', timeout: CLIENT_TIMEOUT_MS })
  stage = 'owned-session-navigation'
  record.ownedSessionId = await openOwnedSession(workspaceId)
  stage = 'owned-session-editor'
  const editor = phone.locator('[data-composer-input][contenteditable="true"]').first()
  await editor.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  await editor.fill('Owned module-settings draft; never submitted to a model.')
  await phone.evaluate(() => { window.__moduleSettingsRetainedDocument = 'Owned module-settings document identity' })
  const before = await retained()
  stage = 'module-selection-behavior'
  await openSettings()
  let failGet = 1, failPost = 0
  await phone.route(`**${modulePath}`, async route => {
    const method = route.request().method()
    if ((method === 'GET' && failGet-- > 0) || (method === 'POST' && failPost-- > 0)) await route.fulfill({ status: 503, json: { error: 'owned_settings_failure' } })
    else await route.continue()
  })
  assert.equal((await openManager()).status, 503)
  await dialog().locator('.dsh-module-error').waitFor({ state: 'visible' })
  await frames(phone)
  assert.equal(record.requests.filter(item => item.method === 'GET').length, 1, 'A failed catalog read retried without user action')
  const [retryReceived] = await Promise.all([
    phone.waitForResponse(response => new URL(response.url()).pathname === modulePath && response.request().method() === 'GET'), reread().click(),
  ])
  const catalog = await retryReceived.json()
  assert(catalog.entries.some(entry => entry.id === skinId && !entry.required), 'Actual published skin is not an optional catalog module')
  await skinRow().waitFor({ state: 'visible' })
  assert.equal(await save().isDisabled(), true)
  assert.deepEqual(await dialog().locator('[data-client-module-group]').evaluateAll(nodes => nodes.map(node => node.dataset.clientModuleGroup)), ['extensions', 'system', 'required'])
  assert.equal(await dialog().locator('details[data-client-module-group="system"]').getAttribute('open'), null)
  assert.equal(await dialog().locator('details[data-client-module-group="required"]').getAttribute('open'), null)
  const presetPosts = record.requests.filter(item => item.method === 'POST').length
  await confirm('accept', () => dialog().getByRole('button', { name: /^(?:仅必需（最小加载）|Required only \(minimal load\)|Solo obbligatori \(caricamento minimo\))$/u }).click())
  assert.equal(record.requests.filter(item => item.method === 'POST').length, presetPosts,
    'The required-only preset persisted choices without an explicit save')
  assert.equal(await skinRow().getByRole('checkbox').isChecked(), false)
  const presetRequired = catalog.entries.find(entry => entry.required)
  assert(presetRequired !== undefined)
  await dialog().getByRole('searchbox').fill(presetRequired.id)
  assert.equal(await dialog().locator('[data-client-module-id]').getByRole('checkbox').isChecked(), true)
  assert.equal(await dialog().locator('[data-client-module-id]').getByRole('checkbox').isDisabled(), true)
  await confirm('accept', () => close().click())
  await dialog().waitFor({ state: 'detached' })
  await openManager()
  assert.equal(await skinRow().getByRole('checkbox').isChecked(), true, 'Discarding the preset changed saved choices')
  record.checks.push('required-only preset protects required modules, stays draft-only and can be discarded')
  const search = dialog().getByRole('searchbox')
  await search.fill('no-matching-owned-module')
  await dialog().getByRole('button', { name: /Clear filters|清除筛选|Cancella filtri/u }).waitFor({ state: 'visible' })
  assert.equal(await dialog().locator('[data-client-module-id]').count(), 0)
  await search.fill(skinId)
  const selected = await skinRow().getByRole('checkbox').isChecked()
  await skinRow().locator('summary').click()
  assert.equal(await skinRow().getByRole('checkbox').isChecked(), selected, 'Module details changed the loading choice')
  await skinRow().getByRole('checkbox').uncheck()
  assert.equal(await save().isEnabled(), true)
  const [measuredResponse] = await Promise.all([
    phone.waitForResponse(response => new URL(response.url()).pathname === modulePath
      && response.request().method() === 'POST' && response.request().postDataJSON()?.measure === true),
    dialog().locator('[data-client-module-measure]').click(),
  ])
  assert.equal(measuredResponse.status(), 200, 'Explicit module measurement HTTP failure')
  const measuredCatalog = await measuredResponse.json()
  assert(measuredCatalog.entries.some(entry => entry.gzipBytes > 0), 'Explicit measurement produced no real transfer sizes')
  assert(measuredCatalog.entries.some(entry => entry.id === '@deepseek-ai/dsh-client-ui-layout' && entry.gzipBytes > 0),
    'Measurement did not include the actual Mobile layout')
  await phone.waitForFunction(() => document.querySelector('.dsh-module-save')?.disabled === false)
  assert.equal(await skinRow().getByRole('checkbox').isChecked(), false, 'Measurement discarded an unsaved module choice')
  assert(!measuredCatalog.excludedClientModules.includes(skinId), 'A read-only measurement persisted the unsaved choice')
  assert.deepEqual(await retained(), before, 'Measurement replaced the document or the actual unsent draft')
  record.checks.push('explicit real size measurement includes Mobile layout and preserves unsaved choices, persisted defaults and the live draft')
  assert.match(await dialog().locator('.dsh-module-footer > p').first().textContent(), /(?:1 changes|1 项改动|1 modifiche)/u)
  await dialog().locator('[data-client-module-filter]').selectOption('excluded')
  assert.equal(await skinRow().count(), 1)
  await dialog().locator('[data-client-module-filter]').selectOption('loaded')
  assert.equal(await skinRow().count(), 0)
  await dialog().locator('[data-client-module-filter]').selectOption('all')
  assert.equal(await skinRow().getByRole('checkbox').isChecked(), false, 'Filtering discarded the unsaved choice')
  await confirm('dismiss', () => close().click())
  assert.equal(await dialog().isVisible(), true)
  assert.equal(await phone.locator('.dsh-module-row').isVisible(), true, 'Cancelled closing affected the underlying General settings')
  assert.equal((await confirm('dismiss', () => nativeBack())).result, true)
  assert.equal(await dialog().isVisible(), true, 'Cancelled native Back closed settings')
  assert.equal(await phone.locator('.dsh-module-row').isVisible(), true, 'Cancelled native Back closed the underlying General settings')
  record.escapeBefore = await phone.evaluate(() => ({ active: { tag: document.activeElement?.tagName, className: document.activeElement?.className }, settings: document.querySelector('.dsh-module-row')?.textContent, moduleDialogOpen: document.querySelector('.dsh-module-dialog')?.open }))
  await close().focus()
  await confirm('dismiss', () => phone.keyboard.press('Escape'))
  assert.equal(await dialog().isVisible(), true, 'Cancelled Escape closed settings')
  assert.equal(await phone.locator('.dsh-module-row').isVisible(), true, 'Cancelled Escape closed the underlying General settings')
  const required = catalog.entries.find(entry => entry.required)
  assert(required !== undefined)
  await search.fill(required.id)
  assert.equal(await dialog().locator('[data-client-module-id]').getByRole('checkbox').isDisabled(), true)
  assert.equal(await dialog().locator('[data-client-module-id]').getByRole('checkbox').isChecked(), true)
  await search.fill(skinId)
  for (const viewport of [{ width: 288, height: 812 }, { width: 375, height: 812 }, { width: 844, height: 393 }]) await geometry({ ...viewport, scheme: 'light', skinLoaded: true })
  const saved = await writeSelection(() => save().click())
  assert.equal(saved.status, 200); assert.equal(saved.body.source, 'device'); assert(saved.body.excludedClientModules.includes(skinId))
  assert.deepEqual(await retained(), before, 'Module save replaced the document or the real Lexical draft')
  assert.equal(await phone.locator('body[data-dsh-maid-atelier]').count(), 1, 'Saving immediately removed the live skin')
  assert.equal(await desktop.locator('body[data-dsh-maid-atelier]').count(), 1, 'Device save removed the desktop skin')
  record.checks.push('catalog retry; grouping, search/filter, detail semantics, dirty close/native Back/Escape, required protection, skin save and draft retention')
  stage = 'manual-skin-reopen'
  await reopen(false)
  assert.equal(await desktop.locator('body[data-dsh-maid-atelier]').count(), 1)
  await openSettings(); await openManager()
  const restored = await writeSelection(() => confirm('accept', () => reset().click()))
  assert.equal(restored.status, 200); assert(!restored.body.excludedClientModules.includes(skinId))
  assert.equal(await phone.locator('body[data-dsh-maid-atelier]').count(), 0, 'Reset reloaded the live document instead of waiting for manual open')
  await reopen(true)
  record.checks.push('manual reopening omits the real skin; desktop retained; explicit defaults reset and manual reopening restores the skin')

  stage = 'module-save-failure-recovery'
  await openSettings(); await openManager(); await dialog().getByRole('searchbox').fill(skinId)
  await skinRow().getByRole('checkbox').uncheck()
  const postsBefore = record.requests.filter(item => item.method === 'POST').length
  failPost = 1
  const rejected = await writeSelection(() => save().click())
  assert.equal(rejected.status, 503)
  await dialog().locator('.dsh-module-error').waitFor({ state: 'visible' }); await frames(phone)
  assert.equal(record.requests.filter(item => item.method === 'POST').length, postsBefore + 1, 'Failed save was replayed automatically')
  assert.equal(await skinRow().getByRole('checkbox').isChecked(), false, 'Failed save discarded the draft choice')
  assert.equal(await save().isEnabled(), true)
  assert.equal((await writeSelection(() => save().click())).status, 200)
  assert.equal(record.requests.filter(item => item.method === 'POST').length, postsBefore + 2)
  record.checks.push('injected single POST 503 retains choices, no automatic replay, explicit retry succeeds')
  await reopen(false)
  await openSettings()
  stage = 'native-theme-layout-matrix'
  for (const scheme of ['light', 'dark']) {
    const theme = phone.getByRole('button', { name: scheme === 'light' ? /^(?:Light|浅色)$/u : /^(?:Dark|深色)$/u })
    await theme.click()
    await phone.waitForFunction(dark => document.body.hasAttribute('data-ds-dark-theme') === dark, scheme === 'dark')
    await openManager()
    for (const viewport of [{ width: 288, height: 812 }, { width: 375, height: 812 }, { width: 844, height: 393 }]) await geometry({ ...viewport, scheme })
    await geometry({ width: 375, height: 812, scheme, largeText: true })
    await close().click(); await dialog().waitFor({ state: 'detached' })
  }
  record.checks.push('native DSH light/dark themes, 288/375/844 widths, large-text controlled fixture, action hit targets, no horizontal overflow and internal list scrolling')
  stage = 'outdated-selection-recovery'
  const existing = await phone.evaluate(async path => {
    const response = await fetch(path)
    return { status: response.status, body: await response.json() }
  }, modulePath)
  assert.equal(existing.status, 200)
  const protectedId = existing.body.entries.find(entry => entry.required)?.id
  assert.equal(typeof protectedId, 'string')
  const obsoleteId = 'retired-module <missing>&plugin'
  let obsoleteReads = 1
  await phone.route(`**${modulePath}`, async route => {
    if (route.request().method() === 'GET' && obsoleteReads-- > 0) await route.fulfill({ status: 200, json: { ...existing.body, excludedClientModules: [...existing.body.excludedClientModules, obsoleteId, protectedId] } })
    else await route.fallback()
  })
  await openManager()
  const stale = dialog().locator('[data-invalid-client-module-id]')
  assert.equal(await stale.count(), 2, 'Retained obsolete exclusions were silently dropped or hidden')
  const literal = stale.filter({ hasText: obsoleteId })
  assert.equal(await literal.locator('code').textContent(), obsoleteId)
  assert.equal(await literal.locator('missing').count(), 0, 'An obsolete module ID became markup')
  const requiredOld = stale.filter({ hasText: protectedId })
  await dialog().getByRole('searchbox').fill(protectedId)
  assert.equal(await dialog().locator('[data-client-module-id]').getByRole('checkbox').isChecked(), true)
  assert.equal(await dialog().locator('[data-client-module-id]').getByRole('checkbox').isDisabled(), true)
  await dialog().getByRole('searchbox').fill('')
  await dialog().locator('[data-client-module-filter]').selectOption('loaded')
  assert.equal(await stale.count(), 0)
  await dialog().locator('[data-client-module-filter]').selectOption('all')
  const postsBeforeCleaning = record.requests.filter(item => item.method === 'POST').length
  for (const old of [literal, requiredOld]) {
    const button = old.getByRole('button')
    await button.scrollIntoViewIfNeeded()
    const target = await button.boundingBox()
    assert(target !== null && target.width >= 48 && target.height >= 48, 'Obsolete-selection repair action is too small')
    await button.click()
  }
  assert.equal(await stale.count(), 0)
  assert.equal(await save().isEnabled(), true)
  assert.equal(record.requests.filter(item => item.method === 'POST').length, postsBeforeCleaning, 'Cleaning old draft exclusions wrote without explicit save')
  const cleaned = await writeSelection(() => save().click())
  assert.equal(cleaned.status, 200)
  assert(!cleaned.request.excludedClientModules.includes(obsoleteId) && !cleaned.request.excludedClientModules.includes(protectedId))
  assert(cleaned.request.excludedClientModules.includes(skinId), 'Cleaning obsolete exclusions changed the ordinary skin selection')
  record.checks.push('controlled old-selection catalog fields: missing/now-required exclusions visible as literal IDs, explicit cleanup is draft-only, required remains protected, actual device save succeeds')
  stage = 'minimal-preset'
  const beforeMinimal = record.requests.filter(item => item.method === 'POST').length
  const minimal = await confirm('accept', () => dialog().getByRole('button', { name: /^(?:仅必需（最小加载）|Required only \(minimal load\)|Solo obbligatori \(caricamento minimo\))$/u }).click())
  assert.match(minimal.message, /unmeasured|体积未知|non misurati/u, 'Minimal confirmation hides unmeasured sizes')
  assert.equal(record.requests.filter(item => item.method === 'POST').length, beforeMinimal, 'Minimal preset saved without explicit confirmation')
  const minimized = await writeSelection(() => save().click())
  assert.equal(minimized.status, 200)
  assert.match(minimized.request.revision, /^[a-f0-9]{16}$/u)
  assert(minimized.body.entries.filter(entry => entry.required).every(entry => !minimized.body.excludedClientModules.includes(entry.id)), 'Minimal preset excluded a required module')
  await reopen(false)
  await openSettings()
  const reopenedMinimal = await openManager()
  assert.equal(reopenedMinimal.status, 200)
  for (const id of ['dsh-mobile', '@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-ui-settings']) {
    assert(reopenedMinimal.body.entries.some(entry => entry.id === id && entry.required), `Missing required mobile surface: ${id}`)
    assert(!reopenedMinimal.body.excludedClientModules.includes(id), `Required mobile surface excluded after reopen: ${id}`)
  }
  record.checks.push('actual minimal preset: measured/unknown confirmation, draft-only edit, revision-bound save, required shell/settings remain loaded and settings remain reachable after reopening')
  assert.equal(record.prompts, 0, 'The acceptance test attempted a model submission')
  assert.deepEqual(record.pageErrors, [], 'Module settings emitted a page error')
  stage = 'completed'
  record.completed = true
} catch (error) {
  failure = error
  record.failureStage = stage
  record.failure = sanitized(error instanceof Error ? error.stack ?? error.message : String(error))
  if (phone !== undefined) {
    record.failurePage = new URL(phone.url()).pathname
    record.bootDiagnostics = await bootDiagnostics?.snapshot().catch(cause => ({ unavailable: sanitized(String(cause)) }))
    if (record.bootDiagnostics !== undefined && !('unavailable' in record.bootDiagnostics)) record.bootSummary = summarizeMobileBootDiagnostics(record.bootDiagnostics)
    record.failureDom = await phone.evaluate(() => ({ active: { tag: document.activeElement?.tagName, className: document.activeElement?.className }, settings: document.querySelector('.dsh-module-row')?.textContent, moduleDialogOpen: document.querySelector('.dsh-module-dialog')?.open })).catch(() => undefined)
    await phone.screenshot({ path: join(evidence, 'failure.png'), mask: [phone.locator('#pair-token'), phone.locator('input[type="password"]')], maskColor: '#e2e8f0' }).catch(_error => {
      // A diagnostic screenshot must not replace the original failure.
    })
  }
} finally {
  const failures = failure === undefined ? [] : [failure]
  bootDiagnostics?.dispose()
  if (browser !== undefined) await browser.close().catch(error => failures.push(error))
  if (dsh !== undefined) {
    try {
      record.hostExit = await dsh.close()
      if (record.hostExit.forced || (record.hostExit.code !== 0 && record.hostExit.signal !== 'SIGTERM')) throw new Error(`Module-settings DSH fixture did not stop normally: ${sanitized(JSON.stringify(record.hostExit))}`)
    } catch (error) { failures.push(error) }
  }
  await removeTemporaryRoot(root, prefix).catch(error => failures.push(error))
  if (originalCache === undefined) delete process.env.NPM_CONFIG_CACHE
  else process.env.NPM_CONFIG_CACHE = originalCache
  record.cleanup = failures.length === (failure === undefined ? 0 : 1) ? 'completed' : 'failed'
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify(record, null, 2) + '\n')
  console.log(JSON.stringify({ completed: record.completed ?? false, geometryCases: record.geometry.length, evidence, hostExit: record.hostExit, failure: record.failure, failureStage: record.failureStage,
    pageErrors: record.pageErrors, bootSummary: record.bootSummary,
    scope: 'actual DSH and published skin; owned profile and loopback browser, not physical Android or public tunnel' }))
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Module settings acceptance and cleanup failed')
}
