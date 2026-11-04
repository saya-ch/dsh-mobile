/** Check the built mobile shell's geometry and drawer layering with an owned slot/virtual-trace fixture, not a complete DSH or third-party skin runtime. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { completeSmoke, recordSmokeFailure } from './negative-control.mjs'

const args = process.argv.slice(2)
assert(args.length === 0 || args.length === 1 && args[0] === '--negative-control-ownership',
  'Usage: smoke-mobile-layout-ownership.mjs [--negative-control-ownership]')
const negative = args[0] === '--negative-control-ownership'
const marker = 'Mobile layout ownership negative control detected'
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const client = await readFile(resolve(mobileRoot, 'lib/mobile-layout.js'), 'utf8')
const failures = []
let observedNegative = false
let browser
let cases = 0

// Slot anchors remain display:contents, as in DSH. A virtualized view contributes
// no intrinsic content height: its absolute viewport must receive the shell's
// remaining height through ConversationRoot's percentage-height/flex chain.
const fixtureStyles = `
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font:16px/1.4 system-ui}
body{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
[data-slot]{display:contents}
.Conversation_fixture_root{position:relative;display:flex;flex-direction:column;height:100%;min-width:0;overflow:hidden}
.Conversation_fixture_header{flex:none;height:76px;padding:10px 16px}
.Conversation_fixture_body,.Conversation_fixture_scrollBody{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden}
.Conversation_fixture_viewArea{display:flex;flex:1;min-height:0;overflow:hidden}
.Trajectory_fixture_root{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden}
.Trajectory_fixture_ledger{position:relative;display:flex;flex:1;min-height:0;overflow:hidden}
.Trajectory_fixture_viewport{position:absolute;inset:0;overflow:auto;overscroll-behavior:contain}
.Trajectory_fixture_row{height:44px;padding:4px 16px}
.Trajectory_fixture_row button,#sidebar-action{min-height:32px;border:1px solid currentColor;background:var(--dsw-alias-bg-base);color:inherit;font:inherit}
#sidebar-root{padding-top:16px;background:var(--dsw-alias-bg-base)}
.Stock_fixture_frame{display:grid;grid-template-columns:100px minmax(0,1fr);grid-template-rows:100%;height:100%;overflow:hidden}
.Stock_fixture_main{display:flex;min-width:0;min-height:0;background:var(--dsw-alias-bg-base)}
`

// The observed failure is an unlayered stylesheet claiming every div beneath
// the root slot as its column-flex frame. The fixture deliberately avoids skin
// names, palette overrides and private stock CSS-module names.
const foreignStyles = `
html:not([data-fixture-nav=rail]) body[data-foreign-layout-fixture] [id=root]>div[data-slot=root]>div:not([data-sidebar-collapsed]){
display:flex!important;flex-direction:column!important;grid-template-rows:none!important;grid-template-columns:none!important;height:100%!important;min-height:0!important
}`

const views = [
  { width: 375, height: 844 },
  { width: 390, height: 844 },
  { width: 719, height: 844 },
  { width: 720, height: 844 },
  { width: 721, height: 844 },
  { width: 844, height: 390 },
  { width: 899, height: 844 },
  { width: 900, height: 844 },
  { width: 901, height: 844 },
  // A landscape phone is wider than the 900px threshold but its screen's short
  // side is a phone's, so it keeps the overlay drawer instead of a permanent rail.
  { width: 932, height: 430 },
  // The same rule in the other direction: both tablet orientations stay docked.
  { width: 909, height: 1314 },
  { width: 1363, height: 860 },
  // Pad 9 Pro Max landscape with the soft keyboard open: the viewport height
  // collapses to 441 while the screen is still 1364x909, so the docked layout
  // must survive the keyboard. A viewport-height rule undocked it here.
  { width: 1363, height: 441, screen: { width: 1364, height: 909 } },
  { width: 1100, height: 844 },
]
// Mirrors the layout's own rule: the window must be wide enough and the device's
// shorter side (screen, not viewport) must be tablet-sized.
const deviceShortSide = view => {
  const screen = view.screen ?? view
  return Math.min(screen.width, screen.height)
}
const docks = view => view.width >= 900 && deviceShortSide(view) >= 600
const themes = {
  light: { '--dsw-alias-label-primary': '#171a21', '--dsw-alias-bg-base': '#ffffff' },
  dark: { '--dsw-alias-label-primary': '#f4f5f7', '--dsw-alias-bg-base': '#171a21' },
}
const rows = Array.from({ length: 64 }, (_, index) =>
  `<div class="Trajectory_fixture_row">${index === 0 ? '<button id="trace-action" type="button">Owned trace action</button>' : `Owned synthetic trace row ${index}`}</div>`).join('')

function fixture(open, wide) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body data-foreign-layout-fixture><div id="root"><div data-slot="root"><div class="dshm-shell" data-dshm-wide="${wide ? '1' : '0'}">
<main class="dshm-main" data-pane="conversation"><div class="dshm-mainContent"><div data-slot="main"><div data-slot="main.conversation"><div class="Conversation_fixture_root" data-phase="active">
<header class="Conversation_fixture_header"><span>Owned populated session</span><div role="tablist"><button role="tab" aria-selected="false">Conversation</button><button role="tab" aria-selected="true">Trajectory</button></div></header>
<div class="Conversation_fixture_body"><div class="Conversation_fixture_scrollBody"><div data-slot="conversation.session"><div class="Conversation_fixture_viewArea"><div data-slot="conversation.view"><div class="Trajectory_fixture_root"><div class="Trajectory_fixture_ledger"><div class="Trajectory_fixture_viewport">${rows}</div></div></div></div></div></div></div></div>
</div></div></div></div></main>
<button class="dshm-scrim" data-open="${open && !wide}" aria-label="Close panels" type="button"></button>
<aside class="dshm-drawer" data-pane="sidebar" data-open="${open}"${open ? '' : ' data-sidebar-collapsed=""'}><div id="sidebar-root"><button id="sidebar-action" type="button">Close sidebar</button></div></aside>
<aside class="dshm-details" data-open="false" inert></aside><div class="dshm-overlay"></div>
</div></div></div></body></html>`
}

async function withContext(options, operation) {
  const context = await browser.newContext(options)
  const errors = []
  let result
  try { result = await operation(context) } catch (error) { errors.push(error) }
  try { await context.close() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, 'Layout acceptance and context cleanup failed')
  return result
}

async function captureStyles() {
  return withContext({}, async context => {
    const page = await context.newPage()
    await page.setContent('<!doctype html><html><head></head><body></body></html>')
    await page.evaluate(() => {
      window.__ModuleLoader__ = { load: ({ id, factory }) => {
        if (id !== '@deepseek-ai/dsh-client-ui-layout') throw new Error('Unexpected built layout identity')
        window.layoutClient = factory(name => {
          if (name === 'react') return {}
          throw new Error(`Unexpected layout dependency: ${name}`)
        })
      } }
    })
    await page.addScriptTag({ content: client })
    return page.evaluate(() => {
      const cleanups = []
      try {
        window.layoutClient.apply({
          effect: effect => { const dispose = effect(); if (typeof dispose === 'function') cleanups.push(dispose) },
          get: () => undefined,
          on: () => () => {},
          reflect: { provide: () => () => {} },
          slots: { entries: () => [], subscribe: () => () => {}, register: () => () => {}, provideRoot: () => () => {} },
          theme: { getTheme: () => ({ active: { colorScheme: 'light', tokens: {} } }) },
        })
        const style = document.querySelector('style[data-plugin="dsh-mobile-layout"]')
        if (style === null || !style.textContent.includes('.dshm-shell')) throw new Error('Built layout did not install its stylesheet')
        const layers = [...style.sheet.cssRules].filter(rule => rule.constructor.name === 'CSSLayerBlockRule'
          && [...rule.cssRules].some(child => child.selectorText === '.dshm-shell'
            && child.style.getPropertyValue('display') === 'grid' && child.style.getPropertyPriority('display') === 'important'))
        if (layers.length !== 1) throw new Error('Built layout does not have one owned shell-geometry layer')
        return { stylesheet: style.textContent, layerName: layers[0].name, ownershipLayer: layers[0].cssText }
      } finally { cleanups.reverse().forEach(dispose => dispose()) }
    })
  })
}

async function setup(page, styles, open, view, tokens, order) {
  await page.setContent(fixture(open, docks(view)))
  await page.addStyleTag({ content: fixtureStyles })
  await page.evaluate(theme => { for (const [key, value] of Object.entries(theme)) document.body.style.setProperty(key, value) }, tokens)
  if (order === 'before') await page.addStyleTag({ content: foreignStyles })
  const handle = await page.addStyleTag({ content: styles.stylesheet })
  if (order === 'after') await page.addStyleTag({ content: foreignStyles })
  await page.evaluate(() => {
    document.querySelector('#trace-action').addEventListener('click', () => {
      document.body.dataset.traceClicks = String(Number(document.body.dataset.traceClicks ?? '0') + 1)
    })
    const close = () => {
      document.querySelector('.dshm-drawer').dataset.open = 'false'
      document.querySelector('.dshm-scrim').dataset.open = 'false'
    }
    document.querySelector('#sidebar-action').addEventListener('click', close)
    document.querySelector('.dshm-scrim').addEventListener('click', close)
  })
  return handle
}

// A third-party menu portaled to document.body, the shape reported in #288: the
// open drawer must not swallow the hit.
async function portalLayering(page) {
  await page.evaluate(() => {
    const portal = document.createElement('div')
    portal.id = 'plugin-portal'
    portal.style.cssText = 'position:fixed;left:64px;bottom:24px;width:200px;height:140px;z-index:60;background:#fee'
    const action = document.createElement('button')
    action.id = 'portal-action'
    action.type = 'button'
    action.textContent = 'Plugin menu'
    action.style.cssText = 'width:100%;height:100%;border:0;background:transparent;font:inherit'
    portal.append(action)
    document.body.append(portal)
  })
  return page.evaluate(() => {
    const action = document.querySelector('#portal-action')
    const rect = action.getBoundingClientRect()
    const portalHit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('#plugin-portal') !== null
    const drawerHit = document.elementFromPoint(120, 200)?.closest('.dshm-drawer') !== null
    return { portalHit, drawerHit }
  })
}

async function geometry(page) {
  return page.evaluate(() => {
    const result = {}
    for (const selector of ['.dshm-shell', '.dshm-main', '.dshm-mainContent', '.Trajectory_fixture_ledger', '.Trajectory_fixture_viewport', '.dshm-drawer']) {
      const node = document.querySelector(selector), css = getComputedStyle(node), box = node.getBoundingClientRect()
      result[selector] = { display: css.display, width: box.width, height: box.height, x: box.x, y: box.y,
        clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, textLength: node.textContent.length }
    }
    return result
  })
}

// The band is one JS decision published as a shell attribute; CSS must never
// re-decide it from a viewport metric. This check sits exactly on the 900px
// boundary, forces a document scrollbar, and proves the rendering follows the
// marker even when the CSS viewport metrics could disagree with the JS read.
async function checkBandSource(styles) {
  for (const band of ['1', '0']) {
    await withContext({ viewport: { width: 900, height: 700 }, hasTouch: true }, async context => {
      const page = await context.newPage()
      await page.setContent(`<!doctype html><html><head></head><body><div class="dshm-shell" data-dshm-wide="${band}">
<main class="dshm-main"><div class="dshm-mainContent"><p style="height:4000px">tall owned content</p></div></main>
<aside class="dshm-drawer" data-pane="sidebar" data-open="false" data-sidebar-collapsed=""></aside>
</div></body></html>`)
      await page.addStyleTag({ content: styles.stylesheet })
      // Force a classic document scrollbar if this engine draws one.
      await page.addStyleTag({ content: 'html{overflow-y:scroll!important}' })
      const measured = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        clientWidth: document.documentElement.clientWidth,
        visualWidth: window.visualViewport?.width ?? null,
        mediaWidth: matchMedia('(min-width:900px)').matches,
        drawer: getComputedStyle(document.querySelector('.dshm-drawer')).position,
        tracks: getComputedStyle(document.querySelector('.dshm-shell')).gridTemplateColumns.trim().split(/\s+/u).length,
      }))
      cases++
      const at = `band=${band}/900x700`
      // The three viewport metrics may differ on an engine with space-taking
      // scrollbars; the band must still be exactly what the marker says.
      assert(measured.innerWidth === 900, `${at}: innerWidth ${measured.innerWidth}`)
      assert(measured.clientWidth <= measured.innerWidth, `${at}: clientWidth exceeded innerWidth`)
      assert.equal(measured.drawer, band === '1' ? 'static' : 'fixed', `${at}: drawer followed a viewport metric instead of the marker`)
      // A docked shell is a two-track grid; an overlay shell is one track plus a
      // fixed rail, so the track count is the second, geometry-free witness.
      assert.equal(measured.tracks, band === '1' ? 2 : 1, `${at}: shell grid followed a viewport metric instead of the marker`)
    })
  }
}

async function checkPanelTouch(styles) {
  for (const hasTouch of [false, true]) for (const optOut of [false, true]) {
    await withContext({ viewport: views[1], hasTouch }, async context => {
      const page = await context.newPage()
      await page.setContent(`<style>body{margin:0}[data-slot]{display:contents}button{box-sizing:border-box;width:28px;height:28px;padding:0}#panel{width:500px}input[type=range]{height:20px}</style>
        <div id="root"><div class="dshm-shell"><main class="dshm-main" data-dsh-panel="0"><div class="dshm-mainContent"><div data-slot="main"><section id="panel"${optOut ? ' data-dsh-adapt="off"' : ''}>
        <button id="action">Action</button><button role="switch" id="switch">Switch</button><input id="range" type="range"><div data-dsh-adapt="off"><button id="nested">Nested opt-out</button></div><p style="height:1200px">Owned long panel content</p></section></div></div></main></div></div>`)
      await page.addStyleTag({ content: styles.stylesheet })
      const measure = () => page.evaluate(() => {
        const box = selector => { const node = document.querySelector(selector); const rect = node.getBoundingClientRect();
          return { width: rect.width, height: rect.height, overflow: getComputedStyle(node).overflowY } }
        return { main: box('.dshm-main'), content: box('.dshm-mainContent'), panel: box('#panel'),
          action: box('#action'), switch: box('#switch'), range: box('#range'), nested: box('#nested') }
      })
      const before = await measure()
      await page.locator('.dshm-main').evaluate(node => { node.dataset.dshPanel = '1' })
      const after = await measure()
      if (!hasTouch || optOut) assert.deepEqual(after, before, 'Fine-pointer and opted-out panels must retain their geometry and scrolling')
      else {
        assert(after.action.width >= 44 && after.action.height >= 44, 'Compact actions need two-dimensional touch targets')
        for (const key of ['switch', 'range', 'nested', 'main']) assert.deepEqual(after[key], before[key], `${key}: touch adaptation reached an excluded owner`)
        assert(after.panel.width <= after.content.width, 'The panel exceeds its available width')
        await page.locator('#action').evaluate(node => { node.addEventListener('click', () => { node.dataset.clicked = 'true' }) })
        await page.locator('#action').click()
        assert.equal(await page.locator('#action').getAttribute('data-clicked'), 'true', 'The resized action is not hit-testable')
        await page.locator('.dshm-mainContent').hover()
        await page.mouse.wheel(0, 180)
        await page.waitForFunction(() => document.querySelector('.dshm-mainContent').scrollTop > 0)
      }
      cases++
    })
  }
  const guide = await readFile(resolve(mobileRoot, 'docs/MOBILE_PLUGIN_BASELINE.en.md'), 'utf8')
  const example = guide.match(/```css\r?\n([\s\S]*?)```/u)?.[1]
  assert(example, 'The shipped baseline guide has no CSS example')
  for (const narrow of [false, true]) {
    await withContext({ viewport: views[1], hasTouch: true }, async context => {
      const page = await context.newPage()
      await page.setContent(`<section class="plugin-panel" data-mobile="${narrow ? '1' : '0'}" style="display:flex;gap:8px">
        <button class="icon-button"><span aria-hidden="true">+</span><span class="action-label">Owned action</span></button>
        <label class="check-label"><input type="checkbox">Owned option</label></section>`)
      const action = page.getByRole('button', { name: 'Owned action', exact: true })
      const before = await action.boundingBox()
      await page.addStyleTag({ content: example })
      const after = await action.boundingBox()
      if (narrow) {
        assert(after.width >= 44 && after.height >= 44, 'The documented action is too small')
        await page.locator('label').click({ position: { x: 5, y: 5 } })
        assert.equal(await page.getByRole('checkbox').isChecked(), true, 'Label padding does not activate its checkbox')
      } else assert.deepEqual(after, before, 'The documented narrow styles changed the desktop action')
      assert.equal(await action.count(), 1, 'Collapsing the visible label removed the accessible name')
      cases++
    })
  }
}

try {
  browser = await chromium.launch({ headless: true })
  const styles = await captureStyles()
  if (negative) {
    await withContext({ viewport: views[1], hasTouch: true }, async context => {
      const page = await context.newPage()
      const handle = await setup(page, styles, false, views[1], themes.light, 'after')
      await handle.evaluate((style, name) => {
        const index = [...style.sheet.cssRules].findIndex(rule => rule.constructor.name === 'CSSLayerBlockRule' && rule.name === name)
        if (index < 0) throw new Error('Owned geometry layer was not found for the negative control')
        style.sheet.deleteRule(index)
      }, styles.layerName)
      const boxes = await geometry(page)
      assert.equal(boxes['.dshm-shell'].display, 'flex', 'The deliberate foreign-layout override was not applied')
      assert.equal(boxes['.Trajectory_fixture_ledger'].height, 0, 'Removing geometry ownership did not collapse the populated trace')
      assert(boxes['.Trajectory_fixture_ledger'].textLength > 1000, 'The negative control needs populated trace content')
      observedNegative = true
      failures.push(new Error(marker))
    })
  } else {
    await checkPanelTouch(styles)
    await checkBandSource(styles)
    for (const view of views) for (const open of [false, true]) for (const [theme, tokens] of Object.entries(themes)) for (const order of ['before', 'after']) {
      await withContext({ viewport: view, ...(view.screen === undefined ? {} : { screen: view.screen }), hasTouch: true }, async context => {
        const page = await context.newPage()
        await setup(page, styles, open, view, tokens, order)
        const key = `${view.width}x${view.height}/${open ? 'open' : 'closed'}/${theme}/${order}`
        const boxes = await geometry(page)
        assert.equal(boxes['.dshm-shell'].display, 'grid', `${key}: the shell ceased to own its grid`)
        assert(Math.abs(boxes['.dshm-main'].height - view.height) < 1, `${key}: main viewport collapsed`)
        assert(boxes['.Trajectory_fixture_ledger'].height > view.height / 2, `${key}: populated trace lacks visible height`)
        assert(boxes['.Trajectory_fixture_viewport'].scrollHeight > boxes['.Trajectory_fixture_viewport'].clientHeight, `${key}: trace has no scroll range`)
        assert.deepEqual(await page.locator('body').evaluate((node, names) => Object.fromEntries(names.map(name =>
          [name, getComputedStyle(node).getPropertyValue(name).trim()])), Object.keys(tokens)), tokens,
        `${key}: geometry ownership changed the theme tokens`)
        if (docks(view)) {
          const sidebarWidth = open ? 340 : 56
          assert.equal(boxes['.dshm-drawer'].height, view.height, `${key}: wide sidebar became a horizontal row`)
          assert.equal(boxes['.dshm-drawer'].width, sidebarWidth, `${key}: wide sidebar width`)
          assert.equal(boxes['.dshm-main'].x, sidebarWidth, `${key}: main was not placed after the sidebar`)
          assert.equal(boxes['.dshm-main'].width, view.width - sidebarWidth, `${key}: main column lost available width`)
        } else {
          if (!open && view.width > 720) {
            // The persistent rail starts above the phone drawer breakpoint.
            assert.equal(boxes['.dshm-main'].x, 56, `${key}: folded icon rail covered the main content`)
            assert.equal(boxes['.dshm-main'].width, view.width - 56, `${key}: main column lost folded-rail width`)
          } else {
            assert.equal(boxes['.dshm-main'].width, view.width, `${key}: narrow conversation width`)
          }
          if (open) {
            const hit = await page.locator('#trace-action').evaluate(node => {
              const rect = node.getBoundingClientRect()
              return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest('button')?.id
            })
            assert.notEqual(hit, 'trace-action', `${key}: open modal drawer failed to intercept the conversation`)
            const layering = await portalLayering(page)
            assert.equal(layering.portalHit, true, `${key}: a body-level plugin menu was covered by the open drawer`)
            assert.equal(layering.drawerHit, true, `${key}: the open drawer stopped owning its own hit area`)
          }
        }
        if (open) {
          await page.locator('#sidebar-action').click()
          assert.equal(await page.locator('.dshm-drawer').getAttribute('data-open'), 'false', `${key}: sidebar close is not reachable`)
        }
        await page.locator('#trace-action').click()
        assert.equal(await page.locator('body').getAttribute('data-trace-clicks'), '1', `${key}: trace action is not reachable`)
        const scrolled = await page.locator('.Trajectory_fixture_viewport').evaluate(node => { node.scrollTop = 600; return node.scrollTop })
        assert(scrolled > 0, `${key}: actual transcript scrolling failed`)
        cases++
      })
    }
    // Removing only the shell isolation must reproduce #288, proving the portal
    // assertion above detects the defect instead of passing for another reason.
    await withContext({ viewport: views[0], hasTouch: true }, async context => {
      const page = await context.newPage()
      const handle = await setup(page, styles, true, views[0], themes.light, 'after')
      const stripped = await handle.evaluate(style => {
        let found = false
        for (const rule of style.sheet.cssRules) {
          if (rule.selectorText === '.dshm-shell' && rule.style.getPropertyValue('isolation') !== '') {
            rule.style.removeProperty('isolation')
            found = true
          }
        }
        return found
      })
      assert.equal(stripped, true, 'Shell isolation was not found for the portal negative control')
      const layering = await portalLayering(page)
      assert.equal(layering.portalHit, false, 'Portal negative control did not reproduce a covered plugin menu')
      assert.equal(layering.drawerHit, true, 'Portal negative control changed drawer ownership')
      cases++
    })
    for (const view of [views[1], views[4]]) await withContext({ viewport: view }, async context => {
      const page = await context.newPage()
      await page.setContent('<!doctype html><html><head></head><body><div id="root"><div class="Stock_fixture_frame"><aside>Stock sidebar</aside><main class="Stock_fixture_main">Stock desktop</main></div></div></body></html>')
      await page.addStyleTag({ content: fixtureStyles })
      const measure = () => page.locator('.Stock_fixture_main').evaluate(node => {
        const box = node.getBoundingClientRect(), css = getComputedStyle(node)
        return { width: box.width, height: box.height, x: box.x, display: css.display, color: css.color }
      })
      const before = await measure()
      await page.addStyleTag({ content: styles.ownershipLayer })
      assert.deepEqual(await measure(), before, `${view.width}: shell geometry layer changed stock desktop`)
      cases++
    })
  }
} catch (error) { recordSmokeFailure(failures, error) } finally {
  try { await browser?.close() } catch (error) { recordSmokeFailure(failures, error) }
}
completeSmoke(failures, negative ? marker : undefined, observedNegative)
console.log(`Built mobile shell geometry passed ${cases} owned browser-fixture cases: populated virtual trace height/scroll/clicks, light/dark, viewport/sidebar states, the wide band following its shell marker on the 900px boundary instead of a viewport metric, stylesheet order, body-portal layering over the open drawer (with its negative control) and stock-desktop isolation. This is not full DSH/skin or physical-device acceptance.`)
