import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { packBundle } from './packed-profile.mjs'
import {
  createMobileProfile, launchDsh, removeTemporaryRoot, openPairing,
  pairMobilePage, dismissOnboarding, CLIENT_TIMEOUT_MS, sanitized,
} from './mobile-boot-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined ? repository : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const prefix = 'dsh-mobile-composer-smoke-'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const referenceName = 'composer-reference.txt'
const root = await mkdtemp(join(tmpdir(), prefix))
let dsh
let browser
let phone
let failure
let rpcSequence = 0

async function rpc(page, method, request) {
  const response = await page.evaluate(async ({ method, request, rpcId }) => {
    const result = await fetch(`/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }),
      signal: AbortSignal.timeout(60000),
    })
    return { status: result.status, body: await result.json() }
  }, { method, request, rpcId: `composer-smoke-${++rpcSequence}` })
  assert.equal(response.status, 200, `${method} HTTP failure: ${sanitized(JSON.stringify(response))}`)
  assert.equal(response.body.result?.ok, true, `${method} RPC failure: ${sanitized(JSON.stringify(response))}`)
  return response.body.result.value
}

const frames = page => page.evaluate(() => new Promise(resolveFrame => { requestAnimationFrame(() => { requestAnimationFrame(resolveFrame) }) }))
const nativeBack = page => page.evaluate(() => {
  const event = new Event('dsh-mobile:native-back', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
})
async function setMobileFontSize(page, size) {
  const drawer = page.locator('.dshm-drawer')
  if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  await drawer.locator('button:has([data-slot="settings.trigger"])').click()
  const row = page.locator('[data-mobile-font-setting]')
  await row.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  for (let steps = 0; steps < 32; steps++) {
    const current = Number.parseInt(await row.locator('[data-mobile-font-role="text"] output').textContent(), 10)
    if (current === size) break
    await row.getByRole('button', { name: current < size ? /增大移动端字号|Increase mobile font size/u : /减小移动端字号|Decrease mobile font size/u }).click()
  }
  assert.equal(await row.locator('[data-mobile-font-role="text"] output').textContent(), `${size}px`)
  assert.equal(await nativeBack(page), true, 'Mobile Back did not close settings')
  await row.waitFor({ state: 'hidden', timeout: CLIENT_TIMEOUT_MS })
  if (await drawer.getAttribute('data-open') === 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
}
async function retained(page, expected) {
  const current = await page.evaluate(() => {
    const editor = document.querySelector('[data-composer-card] [data-composer-input]')
    const rail = document.querySelector('[data-composer-card] [data-slot="conversation.input.attachments"]')
    return {
      text: editor.textContent,
      chips: Array.from(editor.querySelectorAll('[data-composer-chip]'), chip => ({ source: chip.getAttribute('data-composer-chip'), text: chip.textContent })),
      images: Array.from(rail?.querySelectorAll('img') ?? [], image => ({ alt: image.alt, src: image.getAttribute('src') })),
    }
  })
  if (expected !== undefined) assert.deepEqual(current, expected, 'DSH changed the held draft, reference, or attachment during focus changes')
  return current
}

async function lexicalDraft(editor) {
  return editor.evaluate(node => {
    const lexical = node.__lexicalEditor
    if (typeof lexical?.getEditorState !== 'function') throw new Error('The stock composer did not expose its Lexical editor')
    return lexical.getEditorState().toJSON()
  })
}

function lineBreaks(node) {
  return (node.type === 'linebreak' ? 1 : 0) + (node.children ?? []).reduce((count, child) => count + lineBreaks(child), 0)
}

try {
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath)
  await writeFile(join(workspacePath, referenceName), 'Reference-only composer acceptance fixture.\n')
  const tarball = await packBundle(mobileRoot, root)
  const home = await createMobileProfile(root, {
    tarball, dshBin,
    extraPatches: [{ id: 'llm-deepseek', config: {
      // Static provider metadata exercises the real search UI without an API key or model request.
      models: Array.from({ length: 6 }, (_, index) => ({ id: `composer-model-${index}`, name: `Composer model ${index}`, contextWindow: 128000, inputModalities: ['text', 'image'] })),
    } }],
  })
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const desktop = await browser.newPage({ locale: 'en-US' })
  const pairUrl = await openPairing(desktop, await dsh.ready(), dsh.logs)
  const workspace = await rpc(desktop, 'workspace/create', { path: workspacePath })
  assert.equal(typeof workspace.workspace?.workspaceId, 'string')
  phone = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'en-US', isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  const prompts = []
  await phone.route('**/api/session/prompt', async route => { prompts.push(route.request().url()); await route.abort('blockedbyclient') })
  await pairMobilePage(phone, pairUrl, dsh.logs)
  await dismissOnboarding(phone)
  const drawer = phone.locator('.dshm-drawer')
  await drawer.locator('button[data-dsh-mobile-toggle]').click()
  await phone.waitForFunction(() => document.querySelector('.dshm-scrim')?.getAttribute('data-open') === 'true')
  // Let the actual Workspace navigation create/open its own Session, including
  // any first-use blank-session reuse. Do not depend on cold summary titles.
  const workspaceRow = drawer.locator(`[role="treeitem"][data-row-key="workspace:${workspace.workspace.workspaceId}"]`)
  const created = phone.waitForResponse(response => {
    if (new URL(response.url()).pathname !== '/api/session/create') return false
    return response.request().postDataJSON()?.payload?.args?.request?.workspaceId === workspace.workspace.workspaceId
  }, { timeout: CLIENT_TIMEOUT_MS })
  try { await workspaceRow.getByRole('button').last().click() } catch (error) {
    void created.catch(() => {})
    const rows = await drawer.getByRole('treeitem').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, expanded: node.getAttribute('aria-expanded'), selected: node.getAttribute('aria-selected'), key: node.getAttribute('data-row-key') })))
    throw new Error(`Created Workspace was not selectable: ${sanitized(JSON.stringify(rows))}`, { cause: error })
  }
  const createdSession = await (await created).json()
  assert.equal(createdSession.result?.ok, true)
  const sessionId = createdSession.result.value.sessionId
  assert.equal(typeof sessionId, 'string')
  await phone.waitForFunction(id => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === id, sessionId)
  const card = phone.locator('[data-composer-card]').first()
  const editor = card.locator('[data-composer-input][contenteditable="true"]')
  await editor.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })

  const ordinaryRow = await card.evaluate(node => {
    const add = node.querySelector('[data-dsh-mobile-composer-tools] button')?.getBoundingClientRect()
    const send = node.querySelector('button[class*="_primary"]')?.getBoundingClientRect()
    if (add === undefined || send === undefined) throw new Error('Ordinary composer actions were not found')
    return { addCenter: add.y + add.height / 2, sendCenter: send.y + send.height / 2 }
  })
  assert(Math.abs(ordinaryRow.addCenter - ordinaryRow.sendCenter) <= 4,
    `Ordinary narrow DSH composer was forced into separate toolbar rows: ${JSON.stringify(ordinaryRow)}`)

  await editor.fill('Browser Enter acceptance')
  const initialBreaks = lineBreaks((await lexicalDraft(editor)).root)
  await phone.keyboard.press('Enter')
  await phone.waitForFunction(() => {
    const editor = document.querySelector('[data-composer-input]')?.__lexicalEditor
    const hasBreak = node => node.type === 'linebreak' || (node.children ?? []).some(hasBreak)
    return editor !== undefined && hasBreak(editor.getEditorState().toJSON().root)
  })
  assert.equal(lineBreaks((await lexicalDraft(editor)).root), initialBreaks + 1, 'Phone-browser Enter did not update the real Lexical draft')
  await phone.keyboard.type('Second browser line')
  assert.equal(prompts.length, 0, 'Phone-browser Enter attempted a model submission')
  await phone.keyboard.press('ControlOrMeta+A')
  await phone.keyboard.press('Backspace')
  await phone.waitForFunction(() => {
    const node = document.querySelector('[data-composer-input]')
    const editor = node?.__lexicalEditor
    const nonempty = value => value.type === 'linebreak' || (typeof value.text === 'string' && value.text.length > 0)
      || (value.children ?? []).some(nonempty)
    return editor !== undefined && node.textContent === '' && !nonempty(editor.getEditorState().toJSON().root)
  }, undefined, { timeout: CLIENT_TIMEOUT_MS })
  const emptyDraft = await lexicalDraft(editor)
  await phone.keyboard.press('Enter')
  await frames(phone)
  assert.deepEqual(await lexicalDraft(editor), emptyDraft, 'Empty browser Enter inserted a hidden line break')

  // Use the real input trigger to insert a real Lexical reference chip.
  await editor.fill('@composer-reference')
  const reference = phone.getByRole('option').filter({ hasText: referenceName })
  await reference.first().waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  await reference.first().click()
  await editor.locator('[data-composer-chip]').waitFor({ state: 'attached', timeout: CLIENT_TIMEOUT_MS })
  const editorBounds = await editor.boundingBox()
  assert(editorBounds !== null)
  // Click trailing editable whitespace, not the non-editable reference capsule,
  // whose activation legitimately opens the referenced file instead of typing.
  await editor.click({ position: { x: editorBounds.width - 4, y: editorBounds.height / 2 } })
  assert(await editor.evaluate(node => document.activeElement === node), 'Trailing draft whitespace did not focus the real editor')
  await phone.keyboard.press('End')
  assert(await editor.evaluate(node => document.activeElement === node), 'End moved focus outside the real editor')
  for (let index = 0; index < 22; index++) {
    await phone.keyboard.press('Shift+Enter')
    await phone.keyboard.type(`Kept draft line ${index}`)
  }
  try {
    await phone.waitForFunction(() => document.querySelector('[data-composer-input]')?.textContent?.includes('Kept draft line 21'))
  } catch (error) {
    const state = await editor.evaluate(node => ({ text: node.textContent, phase: node.getAttribute('data-phase'), focused: document.activeElement === node, activeTag: document.activeElement?.tagName }))
    throw new Error(`Real draft did not retain typed lines: ${sanitized(JSON.stringify(state))}; attemptedSubmissions=${prompts.length}`, { cause: error })
  }
  await card.locator('input[type="file"]').setInputFiles({ name: 'composer-image.png', mimeType: 'image/png', buffer: png })
  await card.getByRole('img', { name: 'composer-image.png' }).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  let expected = await retained(phone)
  assert.equal(expected.chips.length, 1)
  assert.equal(expected.images.length, 1)
  assert(expected.text.includes('Kept draft line 21'))

  const panelGeometry = []
  for (const [index, viewport] of [{ width: 375, height: 812 }, { width: 844, height: 393 }].entries()) {
    await phone.setViewportSize(viewport)
    await drawer.locator('button[data-dsh-mobile-toggle]').click()
    await phone.waitForFunction(() => document.querySelector('.dshm-drawer')?.getAttribute('data-open') === 'true')
    await drawer.getByRole('button', { name: 'Plugins', exact: true }).click()
    await phone.waitForFunction(() => document.querySelector('.dshm-drawer')?.getAttribute('data-open') === 'false')
    const back = phone.getByRole('button', { name: 'Back to conversation', exact: true })
    await back.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    const geometry = await phone.evaluate(() => {
      const rect = selector => {
        const node = document.querySelector(selector)
        if (node === null) throw new Error(`Missing panel region ${selector}`)
        const { x, y, width, height, bottom } = node.getBoundingClientRect()
        return { x, y, width, height, bottom }
      }
      return { navigation: rect('.dshm-panelNav'), content: rect('.dshm-mainContent'), main: rect('.dshm-main'), back: rect('.dshm-panelBack') }
    })
    assert(geometry.navigation.height >= 48 && geometry.back.height >= 48)
    assert(geometry.content.y >= geometry.navigation.bottom - 0.5, 'Panel navigation overlaps the real plugin content')
    assert(geometry.content.height > 0 && geometry.content.bottom <= geometry.main.bottom + 0.5, 'Panel content escaped its reserved space')
    panelGeometry.push({ ...viewport, ...geometry })
    if (index === 0) await back.click()
    else assert.equal(await nativeBack(phone), true, 'Native Back did not return from the actual main panel')
    await editor.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    await phone.waitForFunction(id => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === id, sessionId)
    await frames(phone)
    assert.equal(await drawer.getAttribute('data-open'), String(!(await drawer.evaluate(node => node.hasAttribute('data-sidebar-collapsed')))),
      'Native adapter overwrote the dedicated drawer logical state')
    assert.equal(await editor.evaluate(node => document.activeElement === node), false, 'A panel exit summoned the composer keyboard')
    const current = await retained(phone)
    assert.equal(current.text, expected.text)
    assert.deepEqual(current.chips, expected.chips)
    // Remounting an image may legitimately allocate a fresh URL for the same File.
    assert.deepEqual(current.images.map(image => image.alt), expected.images.map(image => image.alt))
    await card.getByRole('img', { name: 'composer-image.png' }).waitFor({ state: 'visible' })
    assert(await card.getByRole('img', { name: 'composer-image.png' }).evaluate(image => image.complete && image.naturalWidth > 0))
    expected = current
    const bounds = await editor.boundingBox()
    assert(bounds !== null)
    await editor.click({ position: { x: bounds.width - 4, y: bounds.height / 2 } })
    assert(await editor.evaluate(node => document.activeElement === node), 'Explicit composer tap remained blocked after panel return')
  }

  await phone.setViewportSize({ width: 1000, height: 812 })
  await phone.waitForFunction(() => window.matchMedia('(min-width: 900px)').matches, undefined, { timeout: CLIENT_TIMEOUT_MS })
  await frames(phone)
  if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  await phone.waitForFunction(() => document.querySelector('.dshm-drawer')?.getAttribute('data-open') === 'true', undefined, { timeout: CLIENT_TIMEOUT_MS })
  await drawer.getByRole('button', { name: 'Plugins', exact: true }).click()
  await frames(phone)
  const widePanelState = await phone.evaluate(() => ({
    width: window.innerWidth,
    wide: window.matchMedia('(min-width: 900px)').matches,
    drawer: document.querySelector('.dshm-drawer')?.getAttribute('data-open'),
    phoneNavigation: document.querySelectorAll('.dshm-panelNav').length,
    collapsed: document.querySelector('.dshm-drawer')?.hasAttribute('data-sidebar-collapsed'),
    sidebarClasses: document.querySelector('[data-dsh-mobile-sidebar-root]')?.className,
    toggle: document.querySelector('[data-dsh-mobile-toggle]')?.getAttribute('aria-label'),
  }))
  assert.equal(widePanelState.drawer, 'true', `Wide panel selection collapsed the docked sidebar: ${JSON.stringify(widePanelState)}`)
  assert.equal(await phone.locator('.dshm-panelNav').count(), 0, 'Wide panel unexpectedly gained phone navigation')
  assert.equal(await nativeBack(phone), true)
  await editor.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  await phone.waitForFunction(text => document.querySelector('[data-composer-input]')?.textContent === text, expected.text)
  const wideReturn = await retained(phone)
  assert.equal(wideReturn.text, expected.text)
  assert.deepEqual(wideReturn.chips, expected.chips)
  assert.deepEqual(wideReturn.images.map(image => image.alt), expected.images.map(image => image.alt))
  expected = wideReturn
  const wideEditorBounds = await editor.boundingBox()
  assert(wideEditorBounds !== null)
  // A user tap ends the return-only autofocus suppression before geometry checks.
  await editor.click({ position: { x: wideEditorBounds.width - 4, y: wideEditorBounds.height / 2 } })
  assert(await editor.evaluate(node => document.activeElement === node))
  await drawer.locator('button[data-dsh-mobile-toggle]').click()
  await phone.waitForFunction(() => document.querySelector('.dshm-drawer')?.getAttribute('data-open') === 'false')
  const scroll = card.locator('[data-input-scroll]')
  const expandedHeight = async () => scroll.evaluate(node => node.getBoundingClientRect().height)

  const geometry = []
  for (const viewport of [{ width: 375, height: 812 }, { width: 360, height: 453 }, { width: 320, height: 375 }, { width: 844, height: 393 }]) {
    for (const font of [16, 20, 32]) {
      await phone.setViewportSize(viewport)
      await setMobileFontSize(phone, font)
      await editor.focus()
      await frames(phone)
      const expanded = await expandedHeight()
      const shortViewport = viewport.width <= 720 && viewport.height <= 500
      const scrollCap = viewport.height <= 400 ? 48 : 72
      if (shortViewport) assert(expanded <= scrollCap + 0.1, 'Short focused viewport did not scroll the held draft')
      else assert(expanded > 72)
      const model = card.locator('[data-dsh-mobile-composer-model-trigger]')
      const selectedModel = await model.textContent()
      await model.click()
      const menuId = await model.getAttribute('aria-controls')
      assert(menuId !== null, 'DSH model trigger did not open its own menu')
      const menu = phone.locator(`[id="${menuId}"]`)
      await menu.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
      if (await menu.getByRole('menuitem').count() > 0) await menu.getByRole('menuitem').first().click()
      const search = menu.getByRole('searchbox')
      await search.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
      await search.focus()
      await frames(phone)
      assert.equal(await search.evaluate(node => node.closest('[data-composer-card]')), null, 'Search is not the actual body portal')
      assert.equal(await search.evaluate(node => getComputedStyle(node).fontSize), `${font}px`, 'Actual model search did not preserve the mobile editable font floor')
      const folded = await expandedHeight()
      if (viewport.width <= 720) assert(folded <= (shortViewport ? scrollCap : 72) + 0.1, `Inactive real DSH composer remained ${folded}px`)
      else assert.equal(folded, expanded)
      await retained(phone, expected)
      await search.fill('Composer model 2')
      await menu.getByRole('menuitemradio').filter({ hasText: 'Composer model 2' }).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
      await retained(phone, expected)
      const bounds = await menu.boundingBox()
      assert(bounds !== null && bounds.width > 0 && bounds.height > 0, 'Actual model portal has no usable bounds')
      geometry.push({ ...viewport, font, expanded, folded, menu: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } })
      assert.equal(await nativeBack(phone), true, 'Mobile Back did not consume the actual model search pane')
      await search.waitFor({ state: 'hidden', timeout: CLIENT_TIMEOUT_MS })
      assert.equal(await menu.isVisible(), true, 'Mobile Back closed the whole menu instead of returning to its root')
      assert(await menu.getByRole('menuitem').count() > 0, 'Mobile Back did not restore the stock root menu')
      await retained(phone, expected)
      assert.equal(await nativeBack(phone), true, 'Mobile Back did not consume the root model menu')
      await menu.waitFor({ state: 'detached', timeout: CLIENT_TIMEOUT_MS })
      assert.equal(await model.textContent(), selectedModel, 'Mobile Back changed the model selection')
      assert.equal(await nativeBack(phone), false, 'Mobile Back consumed the conversation without an open layer')
      await editor.focus()
      await frames(phone)
      assert.equal(await expandedHeight(), expanded)
      await retained(phone, expected)
      const action = card.locator('button[class*="_primary"]').last()
      const actionBounds = await action.boundingBox()
      assert(actionBounds !== null && actionBounds.x >= 0 && actionBounds.x + actionBounds.width <= viewport.width + 0.5,
        'Actual primary action leaves the viewport')
      if (viewport.width <= 720) {
        const bounds = await action.boundingBox()
        assert(bounds !== null && bounds.width >= 44 && bounds.height >= 44, 'Real primary action did not retain its 44px touch target')
        assert(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 0.5, 'Real primary action leaves the visible viewport vertically')
        assert(await action.evaluate(node => {
          const rect = node.getBoundingClientRect()
          return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
        }), 'Real primary action was covered by another surface')
      }
    }
  }
  assert.equal(prompts.length, 0, 'Composer acceptance attempted a model submission')
  await phone.setViewportSize({ width: 375, height: 812 })
  if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  await drawer.locator('button:has([data-slot="settings.trigger"])').click()
  const moduleRow = phone.locator('.dsh-module-row')
  await moduleRow.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  const moduleCatalog = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/client-modules' && response.request().method() === 'GET')
  const timeOrigin = await phone.evaluate(() => performance.timeOrigin)
  await moduleRow.getByRole('button', { name: 'Manage', exact: true }).click()
  const catalog = await (await moduleCatalog).json()
  const moduleDialog = phone.locator('.dsh-module-dialog')
  await moduleDialog.getByRole('button', { name: 'Save for next open', exact: true }).waitFor({ state: 'visible' })
  await phone.waitForFunction(() => !document.querySelector('.dsh-module-dialog .dsh-module-actions button')?.disabled)
  const optional = catalog.entries.find(entry => !entry.required && !catalog.entries.some(other => other.dependencies.includes(entry.id)))
  assert(optional !== undefined, 'Packed DSH profile had no optional leaf module to configure')
  await moduleDialog.locator('label').filter({ hasText: optional.id }).getByRole('checkbox').uncheck()
  const configured = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/client-modules' && response.request().method() === 'POST')
  await moduleDialog.getByRole('button', { name: 'Save for next open', exact: true }).click()
  const saved = await (await configured).json()
  assert.equal(saved.source, 'device')
  assert(saved.excludedClientModules.includes(optional.id))
  assert.equal(await phone.evaluate(() => performance.timeOrigin), timeOrigin, 'Saving a module selection reloaded the page')
  await moduleDialog.getByText('Saved. This page is not reloaded automatically. Reopen DSH to apply.').waitFor()
  phone.once('dialog', dialog => dialog.accept())
  const reset = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/client-modules' && response.request().method() === 'POST')
  await moduleDialog.getByRole('button', { name: 'Restore defaults', exact: true }).click()
  assert(!(await (await reset).json()).excludedClientModules.includes(optional.id))
  assert.equal(await nativeBack(phone), true, 'Native Back did not close the module-selection dialog')
  await moduleDialog.waitFor({ state: 'detached' })
  assert.equal(await nativeBack(phone), true, 'Native Back did not return from General settings')
  if (await drawer.getAttribute('data-open') === 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  await editor.waitFor({ state: 'visible' })
  const afterModules = await retained(phone)
  assert.equal(afterModules.text, expected.text)
  assert.deepEqual(afterModules.chips, expected.chips)
  assert.deepEqual(afterModules.images.map(image => image.alt), expected.images.map(image => image.alt))
  assert.equal(await phone.evaluate(() => performance.timeOrigin), timeOrigin)
  assert.equal(prompts.length, 0)
  console.log(`Packed DSH composer acceptance passed: ordinary single toolbar row, real browser Enter/empty draft, Lexical reference/image retention, panel button/native Back without autofocus, model body-portal/search/native Back, portrait/short-viewport/landscape and 16px/20px/32px fonts (${geometry.length} layouts).`)
  console.log('Real DSH module settings: catalog, device-local save/reset, CSRF, Native Back and no automatic reload/draft loss passed.')
  console.log(JSON.stringify(panelGeometry))
  console.log(JSON.stringify(geometry))
} catch (error) {
  failure = new Error(`${sanitized(error instanceof Error ? error.stack ?? error.message : String(error))}\n${dsh?.logs() ?? ''}`)
} finally {
  const failures = failure === undefined ? [] : [failure]
  if (browser !== undefined) await browser.close().catch(error => { failures.push(error) })
  if (dsh !== undefined) {
    try {
      const stopped = await dsh.close()
      if (stopped.forced || (stopped.code !== 0 && stopped.signal !== 'SIGTERM')) {
        throw new Error(`Composer DSH fixture did not stop quiescently: ${sanitized(JSON.stringify(stopped))}\n${dsh.logs()}`)
      }
    } catch (error) { failures.push(error) }
  }
  await removeTemporaryRoot(root, prefix).catch(error => { failures.push(error) })
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Composer acceptance and cleanup failed')
}
