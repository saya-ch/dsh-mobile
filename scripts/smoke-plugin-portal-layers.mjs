/**
 * Verify the published mobile shell against a real browser: a third-party plugin
 * that portals a menu into `document.body` must stay reachable while the
 * navigation drawer is open, and a dialog a plugin mounts inside the conversation
 * column must not be clipped by the wide navigation rail. Browser top-layer
 * dialogs retain focus and hits.
 *
 * This is the regression for issues #288 and #309. It drives the built stylesheet
 * from `lib/mobile-layout.js` and a real Chromium layout engine, so it fails on
 * the reported defects instead of on a source string.
 *
 * The decisive property for #288 is that `.dshm-shell` is an isolated stacking
 * context. A positioned positive-z-index portal outranks the whole shell, which
 * is why this smoke sweeps several portal levels instead of checking one
 * documented band. Lowering the drawer instead only helps a portal that happens
 * to pick a bigger number: measured, that approach still failed at 10 and 45.
 *
 * The decisive property for #309 is that the wide drawer is a static grid column
 * with no layer of its own, while the conversation column outranks it and stays
 * below the scrim. A plugin dialog mounted inside the composer's own stacking
 * context therefore keeps its left edge; on a phone the drawer is a floating
 * overlay and must keep covering the conversation.
 *
 * Scope: built stylesheet plus an owned DOM fixture. Not a full DSH runtime, a
 * real third-party plugin, or a physical device.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url))
  : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const client = await readFile(resolve(mobileRoot, 'lib/mobile-layout.js'), 'utf8')

/**
 * Portal levels to sweep. 10 and 45 are below any band a plugin could be told to
 * use, 60 is the level the reporter's menu uses, and 2000 is a plugin that
 * "plays it safe". All must be reachable: the shell's isolation, not the number,
 * is what keeps them visible.
 */
const PORTAL_LEVELS = Object.freeze([10, 45, 60, 2000])

const VIEWPORTS = Object.freeze({
  // Below the 900px breakpoint the drawer is a fixed overlay.
  portrait: { width: 390, height: 844 },
  // At and above it the drawer becomes a real grid column.
  landscape: { width: 1024, height: 768 },
})

/**
 * Mirror the shell's own scrim rule (`isMobileScrimOpen`): a wide persistent
 * column is never dimmed, and a phone overlay drawer always is. The fixture has
 * to model that, otherwise it would assert hits against a scrim the real shell
 * does not open.
 */
function scrimOpen(narrow, drawerOpen, detailsOpen) {
  return narrow ? drawerOpen || detailsOpen : detailsOpen
}

function fixture({ narrow, drawerOpen, detailsOpen, portalZ, dialog }) {
  // The shell carries the layout's wide/narrow decision; this static fixture
  // states the band its viewport would produce.
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<div id="root"><div data-slot="root"><div class="dshm-shell" data-dshm-wide="${narrow ? '0' : '1'}">
  <main class="dshm-main" data-pane="conversation"><div class="dshm-mainContent">
    <div data-slot="main"><div data-slot="main.conversation">
      <div id="conversation-content">Owned conversation content</div>
      ${dialog ? `<div id="composer-scope" style="position:relative;isolation:isolate;height:80px">
        <!-- A community plugin modal inside the composer's own stacking context. -->
        <div id="plugin-dialog-backdrop" style="position:fixed;inset:0;background:rgb(0 0 0 / 40%)"></div>
        <div id="plugin-dialog" role="dialog" aria-modal="true" style="position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(600px,calc(100vw - 32px));height:320px;background:#fff;color:#000;z-index:2">
          <button id="plugin-dialog-action" type="button" style="width:100%;height:48px">Owned plugin dialog action</button>
        </div>
      </div>` : ''}
    </div></div>
  </div></main>
  <button class="dshm-scrim" data-open="${scrimOpen(narrow, drawerOpen, detailsOpen)}" aria-label="Close panels" type="button"></button>
  <aside class="dshm-drawer" data-pane="sidebar" data-open="${drawerOpen}">
    <div id="sidebar-root"><button id="sidebar-action" type="button" style="width:100%;height:44px">Owned sidebar action</button></div>
  </aside>
  <aside class="dshm-details" data-open="${detailsOpen}">
    <div id="details-root"><button id="details-action" type="button" style="width:100%;height:44px">Owned details action</button></div>
  </aside>
  <div class="dshm-overlay"></div>
</div></div></div>
<!-- The third-party plugin's own portal: a sibling of the shell in body. -->
<div id="plugin-portal" role="menu" style="position:fixed;left:8px;bottom:8px;z-index:${portalZ};width:200px;height:120px;background:#fff">
  <button id="plugin-menu-item" type="button" style="width:100%;height:44px">Owned plugin menu item</button>
</div>
<!-- DSH's own settings overlay (900), which the shell must never cover. A plain
     div, not a <dialog>: a closed dialog is display:none and would not paint. -->
<div id="stock-settings" role="dialog" aria-modal="true" style="z-index:900;position:fixed;right:20px;bottom:20px;width:120px;height:60px;background:#fff">
  <button id="stock-settings-action" type="button" style="width:100%;height:100%">Owned settings action</button>
</div>
<dialog id="top-dialog"><button id="top-action" type="button">Close modal</button></dialog>
</body></html>`
}

async function mount(page, options) {
  await page.setContent(fixture(options))
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
  await page.evaluate(() => {
    window.layoutClient.apply({
      effect: effect => { effect() },
      get: () => undefined,
      on: () => () => {},
      reflect: { provide: () => () => {} },
      slots: { entries: () => [], subscribe: () => () => {}, register: () => () => {}, provideRoot: () => () => {} },
      theme: { getTheme: () => ({ active: { colorScheme: 'light', tokens: {} } }) },
    })
  })
}

/** Hit-test helper shared by both matrices: 'self', 'none' or the covering node. */
const HIT = `(node, fx = 0.5, fy = 0.5) => {
  const box = node.getBoundingClientRect()
  const found = document.elementFromPoint(box.left + box.width * fx, box.top + box.height * fy)
  return found === null ? 'none' : found === node || node.contains(found) ? 'self' : (found.id || found.className || found.tagName)
}`

const browser = await chromium.launch()
const failures = []
let cases = 0

try {
  // Matrix 1: body-portal layering (issue #288).
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const narrow = viewport.width < 900
    for (const drawerOpen of [true, false]) {
      for (const detailsOpen of [true, false]) {
        for (const portalZ of PORTAL_LEVELS) {
          cases++
          const at = `${label} drawer=${drawerOpen} details=${detailsOpen} portal=${portalZ}`
          const context = await browser.newContext({ viewport })
          try {
            const page = await context.newPage()
            const pageErrors = []
            page.on('pageerror', error => pageErrors.push(error.message))
            await mount(page, { narrow, drawerOpen, detailsOpen, portalZ, dialog: false })
            await page.locator('#plugin-menu-item').waitFor({ state: 'visible', timeout: 10_000 })
            assert.deepEqual(pageErrors, [], `${at}: page errors`)

            const probe = await page.evaluate(`(() => {
              const hit = ${HIT};
              const q = selector => document.querySelector(selector)
              const zOf = node => {
                if (node === null) return null
                const parsed = Number.parseInt(getComputedStyle(node).zIndex, 10)
                return Number.isFinite(parsed) ? parsed : null
              }
              const shell = q('.dshm-shell')
              const drawer = q('.dshm-drawer')
              return {
                shellIsolation: getComputedStyle(shell).isolation,
                drawerZ: zOf(drawer), drawerPosition: getComputedStyle(drawer).position,
                mainZ: zOf(q('.dshm-main')),
                detailsZ: zOf(q('.dshm-details')), overlayZ: zOf(q('.dshm-overlay')), scrimZ: zOf(q('.dshm-scrim')),
                portalHit: hit(q('#plugin-portal')), itemHit: hit(q('#plugin-menu-item')),
                settingsActionHit: hit(q('#stock-settings-action')), settingsZ: zOf(q('#stock-settings')),
                drawerActionHit: hit(q('#sidebar-action')),
                scrimActive: q('.dshm-scrim').dataset.open === 'true',
              }
            })()`)

            // The property that makes every portal level work.
            assert.equal(probe.shellIsolation, 'isolate',
              `${at}: the shell must be an isolated stacking context, got ${probe.shellIsolation}`)
            // The plugin's own portal must be reachable whenever the shell has no
            // modal surface over it. A body-portal menu is how community plugins
            // draw menus, so covering it makes their controls dead (#288).
            assert.equal(probe.portalHit, 'self', `${at}: the plugin portal is covered by ${probe.portalHit}`)
            assert.equal(probe.itemHit, 'self', `${at}: the plugin menu item is covered by ${probe.itemHit}`)
            // The drawer must still own its own area; isolation must not turn the
            // shell into a surface a portal always wins over everywhere. Skip it
            // while the scrim is active, which legitimately covers the drawer.
            if (drawerOpen && !probe.scrimActive) {
              assert.equal(probe.drawerActionHit, 'self',
                `${at}: the open drawer no longer owns its own hit area (${probe.drawerActionHit})`)
            }
            // Internal shell order must hold regardless of isolation. On a phone
            // the drawer is an overlay above the scrim; on a wide viewport it is a
            // static column with no layer, and the conversation column outranks it
            // while the scrim still covers both when a modal surface opens (#309).
            if (narrow) {
              assert.ok(probe.scrimZ < probe.drawerZ, `${at}: scrim ${probe.scrimZ} must paint behind drawer ${probe.drawerZ}`)
            } else {
              assert.equal(probe.drawerZ, null, `${at}: the wide drawer must not own a layer, got ${probe.drawerZ}`)
              assert.ok(probe.drawerZ ?? 0 < probe.mainZ, `${at}: the wide conversation column must outrank the rail`)
              assert.ok(probe.mainZ < probe.scrimZ, `${at}: the conversation column ${probe.mainZ} must stay below the scrim ${probe.scrimZ}`)
            }
            assert.ok(probe.drawerZ ?? 0 < probe.detailsZ, `${at}: drawer ${probe.drawerZ} must stay below details ${probe.detailsZ}`)
            assert.ok(probe.detailsZ < probe.overlayZ, `${at}: details ${probe.detailsZ} must stay below overlay ${probe.overlayZ}`)
            assert.ok(probe.overlayZ < probe.settingsZ, `${at}: overlay ${probe.overlayZ} must stay below DSH settings ${probe.settingsZ}`)
            assert.equal(probe.settingsActionHit, 'self', `${at}: settings stand-in covered by ${probe.settingsActionHit}`)
            await page.evaluate(() => {
              const button = document.querySelector('#plugin-menu-item')
              button.addEventListener('click', () => { button.dataset.clicked = 'true' })
            })
            await page.locator('#plugin-menu-item').click()
            assert.equal(await page.locator('#plugin-menu-item').getAttribute('data-clicked'), 'true')
            await page.evaluate(() => document.querySelector('#top-dialog').showModal())
            const modal = await page.evaluate(() => {
              const button = document.querySelector('#top-action')
              const rect = button.getBoundingClientRect()
              return { focused: document.activeElement === button, hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === button }
            })
            assert.deepEqual(modal, { focused: true, hit: true }, `${at}: top-layer modal lost focus or hit target`)
            await page.evaluate(() => document.querySelector('#top-dialog').close())
            // The wide grid must keep ordering the drawer; a static grid item still
            // honours z-index when it has one, which is why the wide column drops it.
            if (label === 'landscape') assert.equal(probe.drawerPosition, 'static', `${at}: expected the wide grid drawer`)
            else assert.equal(probe.drawerPosition, 'fixed', `${at}: expected the narrow overlay drawer`)
          } catch (error) {
            failures.push(error)
          } finally { await context.close() }
        }
      }
    }
  }

  // Matrix 2: a plugin dialog mounted inside the composer's stacking context
  // (issue #309). It must not be clipped by the wide navigation rail, and the
  // phone overlay drawer must keep covering the conversation.
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    const narrow = viewport.width < 900
    for (const drawerOpen of [true, false]) {
      for (const detailsOpen of [true, false]) {
        cases++
        const at = `dialog ${label} drawer=${drawerOpen} details=${detailsOpen}`
        const context = await browser.newContext({ viewport })
        try {
          const page = await context.newPage()
          const pageErrors = []
          page.on('pageerror', error => pageErrors.push(error.message))
          await mount(page, { narrow, drawerOpen, detailsOpen, portalZ: 60, dialog: true })
          await page.locator('#plugin-dialog-action').waitFor({ state: 'visible', timeout: 10_000 })
          assert.deepEqual(pageErrors, [], `${at}: page errors`)
          const probe = await page.evaluate(`(() => {
            const hit = ${HIT};
            const dialog = document.querySelector('#plugin-dialog')
            const action = document.querySelector('#plugin-dialog-action')
            const scrim = document.querySelector('.dshm-scrim')
            action.focus()
            return {
              leftEdge: hit(dialog, 0.02), centre: hit(dialog), action: hit(action),
              focused: document.activeElement === action,
              scrimActive: scrim.dataset.open === 'true',
              drawerAction: hit(document.querySelector('#sidebar-action')),
            }
          })()`)
          // Focus must never be stolen by the layering fix.
          assert.equal(probe.focused, true, `${at}: the dialog action lost focus`)
          if (!probe.scrimActive) {
            // Nothing modal covers the shell: the dialog must own every point it
            // is meant to reach. The dialog's own backdrop legitimately covers the
            // rest of the page, so the drawer's action is not asserted here.
            assert.equal(probe.centre, 'self', `${at}: the dialog centre is covered by ${probe.centre}`)
            assert.equal(probe.action, 'self', `${at}: the dialog action is covered by ${probe.action}`)
            if (narrow) {
              // A phone keeps its floating rail over the conversation; the dialog
              // only has to be reachable where it does not overlap that rail.
              assert.ok(probe.leftEdge === 'self' || probe.leftEdge === 'sidebar-root',
                `${at}: unexpected left-edge owner ${probe.leftEdge}`)
            } else {
              // The wide rail is a static column: it must not clip the dialog.
              assert.equal(probe.leftEdge, 'self', `${at}: the rail clipped the dialog's left edge (${probe.leftEdge})`)
            }
          } else {
            // A modal shell surface covers the whole shell: the scrim, the detail
            // panel above it, or a phone drawer that is open over the content.
            assert.notEqual(probe.action, 'self', `${at}: a shell surface no longer covers the dialog`)
            assert.ok(['dshm-scrim', 'dshm-details', 'sidebar-root'].includes(probe.action),
              `${at}: unexpected covering surface ${probe.action}`)
          }
        } catch (error) {
          failures.push(error)
        } finally { await context.close() }
      }
    }
  }
} finally {
  await browser.close()
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure instanceof Error ? failure.message : failure)
  console.error(`Plugin portal layering failed after ${cases} owned browser cases.`)
  process.exit(1)
}
console.log(`Plugin portal layering passed ${cases} owned browser cases: positive-z-index body menus receive clicks, an in-shell composer dialog keeps its left edge over the wide rail while the phone overlay drawer still covers the conversation, internal shell order holds, and a top-layer modal retains focus and hit testing. This is not a full DSH runtime, real settings or physical-device acceptance.`)
