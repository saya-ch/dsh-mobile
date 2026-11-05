/**
 * Verify the fullscreen right panel against a real browser, not source strings.
 *
 * PR #299 fixed a clipped fullscreen panel: the stock `sidebar-right` paints
 * itself at `100vw` once it enters fullscreen, but the dedicated Mobile layout
 * mounted it inside the docked overlay (`min(94vw, 460px)` with `overflow:hidden`),
 * so on a wide viewport only the right strip was visible — header off-canvas and
 * body line tails cut. The fix lets the overlay span the viewport while a
 * fullscreen panel is mounted.
 *
 * What this checks, on the built stylesheet in real Chromium:
 *
 *   - narrow viewport keeps its existing full-width overlay (no regression);
 *   - wide viewport: floating, docked and fullscreen each measure correctly;
 *   - a fullscreen panel spans the whole viewport and its header, body and close
 *     control are reachable by hit test;
 *   - leaving fullscreen restores the docked width;
 *   - the conversation behind a fullscreen panel is inert and needs no scrim.
 *
 * Scope: built stylesheet plus an owned DOM fixture. Not a real DSH runtime, not a
 * physical device; the PR author's own equivalent-CSS device feedback is not used
 * as evidence here.
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

const VIEWPORTS = Object.freeze({
  narrow: { width: 390, height: 844 },
  wide: { width: 1024, height: 768 },
})

/**
 * One fixture per right-panel state. `data-rightbar-fullscreen` is the attribute
 * the layout sets; the docked column width comes from `--dshm-rightbar-width`.
 */
function fixture({ detailsOpen, fullscreen, docked, rightbarWidth, wide }) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<div id="root"><div data-slot="root"><div class="dshm-shell" data-dshm-wide="${wide ? '1' : '0'}" data-rightbar-docked="${docked}" data-rightbar-fullscreen="${fullscreen}"
  style="--dshm-rightbar-width:${rightbarWidth}px">
  <main class="dshm-main" data-pane="conversation"${fullscreen ? ' inert aria-hidden="true"' : ''}>
    <div class="dshm-mainContent"><div data-slot="main">
      <button id="conversation-action" type="button" style="width:100%;height:44px">Conversation</button>
    </div></div>
  </main>
  <button class="dshm-scrim" data-open="false" aria-label="Close panels" type="button"></button>
  <aside class="dshm-drawer" data-pane="sidebar" data-open="false"><div id="sidebar-root"></div></aside>
  <aside class="dshm-details" data-open="${detailsOpen}">
    <div id="details-panel" style="display:flex;flex-direction:column;height:100%">
      <header id="details-header" style="flex:none;height:48px">Panel header</header>
      <div id="details-body" style="flex:1;overflow:auto">Panel body</div>
      <footer style="flex:none;height:48px"><button id="details-close" type="button" style="width:100%;height:100%">Close</button></footer>
    </div>
  </aside>
  <div class="dshm-overlay"></div>
</div></div></div>
</body></html>`
}

const browser = await chromium.launch()
const failures = []
let cases = 0

try {
  for (const [label, viewport] of Object.entries(VIEWPORTS)) {
    // The panel state matrix: closed, floating (overlay), docked column, fullscreen.
    const states = label === 'narrow'
      ? [
        { name: 'closed', detailsOpen: false, fullscreen: false, docked: false },
        // Below 900px the overlay is already 100% wide; fullscreen must not change it.
        { name: 'overlay', detailsOpen: true, fullscreen: false, docked: false },
        { name: 'fullscreen', detailsOpen: true, fullscreen: true, docked: false },
      ]
      : [
        { name: 'closed', detailsOpen: false, fullscreen: false, docked: false },
        { name: 'floating', detailsOpen: true, fullscreen: false, docked: false },
        { name: 'docked', detailsOpen: true, fullscreen: false, docked: true, rightbarWidth: 380 },
        { name: 'fullscreen', detailsOpen: true, fullscreen: true, docked: false, rightbarWidth: 380 },
      ]

    for (const state of states) {
      cases++
      const at = `${label}/${state.name}`
      const context = await browser.newContext({ viewport })
      try {
        const page = await context.newPage()
        const pageErrors = []
        page.on('pageerror', error => pageErrors.push(error.message))
        await page.setContent(fixture({
          detailsOpen: state.detailsOpen, fullscreen: state.fullscreen,
          docked: state.docked, rightbarWidth: state.rightbarWidth ?? 380,
          // The shell carries the layout's wide/narrow decision; this fixture is
          // static HTML, so it states the band the viewport would produce.
          wide: label === 'wide',
        }))
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
        await page.locator('#details-panel').waitFor({ state: 'visible', timeout: 10_000 })
        assert.deepEqual(pageErrors, [], `${at}: page errors`)

        const probe = await page.evaluate(() => {
          const details = document.querySelector('.dshm-details')
          const header = document.querySelector('#details-header')
          const close = document.querySelector('#details-close')
          const conversation = document.querySelector('#conversation-action')
          const main = document.querySelector('.dshm-main')
          const scrim = document.querySelector('.dshm-scrim')
          const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }
          const hit = node => {
            const r = node.getBoundingClientRect()
            const found = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
            return found === node || node.contains(found) ? 'self' : found === null ? 'none' : (found.id || found.className || found.tagName)
          }
          return {
            viewportWidth: window.innerWidth,
            details: rect(details),
            headerHit: hit(header),
            closeHit: hit(close),
            closeRect: rect(close),
            conversationHit: hit(conversation),
            mainInert: main.hasAttribute('inert'),
            scrimOpacity: getComputedStyle(scrim).opacity,
            scrimPointer: getComputedStyle(scrim).pointerEvents,
            dataFullscreen: document.querySelector('.dshm-shell')?.getAttribute('data-rightbar-fullscreen') ?? null,
          }
        })

        if (state.name === 'closed') {
          // The panel must not occupy space or intercept hits.
          assert.ok(probe.conversationHit === 'self',
            `${at}: a closed panel must leave the conversation reachable, got ${probe.conversationHit}`)
        }

        if (state.name === 'floating' || state.name === 'docked') {
          // A non-fullscreen panel keeps its own width and stays reachable.
          assert.ok(probe.details.w <= Math.min(probe.viewportWidth * 0.95, 470),
            `${at}: a non-fullscreen panel must not span the viewport, got ${probe.details.w}`)
          assert.equal(probe.headerHit, 'self', `${at}: panel header covered by ${probe.headerHit}`)
          assert.equal(probe.closeHit, 'self', `${at}: panel close control covered by ${probe.closeHit}`)
          assert.equal(probe.mainInert, false, `${at}: a non-fullscreen panel must not inert the conversation`)
        }

        if (state.name === 'fullscreen') {
          // The reported defect: the panel must own the whole viewport.
          assert.equal(Math.round(probe.details.w), probe.viewportWidth,
            `${at}: a fullscreen panel must span the viewport, got ${probe.details.w} of ${probe.viewportWidth}`)
          assert.equal(Math.round(probe.details.x), 0, `${at}: a fullscreen panel must start at x=0, got ${probe.details.x}`)
          assert.equal(probe.headerHit, 'self', `${at}: fullscreen header covered by ${probe.headerHit}`)
          assert.equal(probe.closeHit, 'self', `${at}: fullscreen close control covered by ${probe.closeHit}`)
          assert.ok(probe.closeRect.h >= 40, `${at}: fullscreen close control is too small (${probe.closeRect.h})`)
          // The conversation behind it is inert, so it needs no scrim to block taps.
          assert.equal(probe.mainInert, true, `${at}: a fullscreen panel must inert the conversation behind it`)
          assert.ok(probe.conversationHit !== 'self',
            `${at}: the conversation must not stay reachable behind a fullscreen panel`)
        }

        if (label === 'narrow' && state.name === 'overlay') {
          // Phones already had a full-width overlay; the fix must not shrink it.
          assert.equal(Math.round(probe.details.w), probe.viewportWidth,
            `${at}: the narrow overlay must stay full-width, got ${probe.details.w}`)
        }
      } catch (error) {
        failures.push(error)
      } finally { await context.close() }
    }
  }
} finally {
  await browser.close()
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure instanceof Error ? failure.message : failure)
  console.error(`Fullscreen right panel failed after ${cases} owned browser cases.`)
  process.exit(1)
}
console.log(`Fullscreen right panel passed ${cases} owned browser cases: narrow overlay unchanged, wide floating/docked keep their own width with header and close reachable, and a fullscreen panel spans the whole viewport with the conversation behind it inert and no scrim required. Built stylesheet in real Chromium; not a physical device.`)
