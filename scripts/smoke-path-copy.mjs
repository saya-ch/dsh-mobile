/**
 * Verify preview-path tap-to-copy against the real built client, not source strings.
 *
 * The stock DSH preview header renders PathLabel as a titled outer span with
 * nested directory/name spans that receive the taps, and the delivered-file card
 * is a full-card button that is a pure open action by design. This smoke drives the
 * full mobileClient.apply bootstrap on an owned fixture and checks, in real
 * Chromium: owner resolution through the nested spans, the card's open-only
 * action, the changes-review exclusion, both clipboard fallback branches and
 * their failure toast, computed toast visibility at portrait, landscape and
 * tablet touch widths, the fine-pointer no-op with an un-suppressed
 * contextmenu, the real locale-rebind teardown (dispose→install), and focus
 * hygiene after the textarea fallback.
 *
 * Scope: built lib/client.js plus an owned DOM fixture on a fulfilled https
 * origin with granted clipboard permissions. Not a real DSH runtime and not a
 * physical device; iOS Safari permission and activation behavior stays unverified.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const browser = await chromium.launch({ headless: true })
const ORIGIN = 'https://pathcopy.test/'
const TOAST_WAIT = 5000

const fixture = lang => `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<button id="focus-anchor" type="button">anchor</button>
<span id="preview-path" data-textpreview-path title="topics/x/artifacts/report.md" tabindex="0"><span data-path-label><span id="path-dir">topics/x/artifacts/</span><span id="path-name">report.md</span></span></span>
<span id="rel-path" data-textpreview-path title="src/a.ts" tabindex="0"><span>src/a.ts</span></span>
<span id="long-path" data-textpreview-path title="${'deep/'.repeat(24)}report.md" tabindex="0"><span>long</span></span>
<div data-presented-file><button id="card" type="button" title="/abs/pickup.md"></button><div class="fileBody"><div class="actions"></div></div></div>
<div data-changes-review><button id="switcher" type="button" title="src/a.ts" data-review-file></button></div>
<div id="port" style="height:120px;overflow:auto"><div style="height:2000px;padding-top:800px"><input id="in-port"></div></div>
<script>
  window.previewOpened = 0; window.switcherTaps = 0; window.contextMenuTaps = 0; window.writes = 0; window.__errors = []
  addEventListener('unhandledrejection', event => { window.__errors.push(String(event.reason)) })
  document.getElementById('card').addEventListener('click', () => { window.previewOpened++ })
  document.getElementById('switcher').addEventListener('click', () => { window.switcherTaps++ })
  document.getElementById('preview-path').addEventListener('contextmenu', () => { window.contextMenuTaps++ })
</script></body></html>`

/** Boot one fixture page with the built client applied and cleanup captured. */
async function bootPage(context, lang = 'en') {
  const page = await context.newPage()
  await page.route(`${ORIGIN}**`, route => route.fulfill({ contentType: 'text/html', body: fixture(lang) }))
  await page.goto(ORIGIN)
  await page.evaluate(() => {
    const clipboard = navigator.clipboard
    window.__readText = clipboard?.readText?.bind(clipboard)
    if (clipboard?.writeText) {
      const original = clipboard.writeText.bind(clipboard)
      clipboard.writeText = async text => { window.writes++; await original(text) }
    }
    window.__ModuleLoader__ = { load: ({ factory }) => { window.mobile = factory(name => { if (name === 'react') return {}; throw new Error(name) }) } }
    window.__execCommand = document.execCommand.bind(document)
  })
  await page.addScriptTag({ content: client })
  await page.evaluate(() => {
    const cleanup = []
    window.mobile.apply({ effect: effect => { const dispose = effect(); if (typeof dispose === 'function') cleanup.push(dispose) }, get: () => undefined, slots: { inject: () => () => {}, register: () => () => {} } })
    window.disposeMobile = () => cleanup.reverse().forEach(dispose => dispose())
  })
  await page.waitForSelector('.dsh-mobile-path-toast', { state: 'attached', timeout: TOAST_WAIT })
  return page
}

const touchContext = (browser2, viewport) => browser2.newContext({
  viewport, isMobile: true, hasTouch: true,
}).then(context => context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN.slice(0, -1) }).then(() => context))

const toastState = page => page.evaluate(() => {
  const toast = document.querySelector('.dsh-mobile-path-toast')
  if (toast === null) return { exists: false }
  const style = getComputedStyle(toast)
  const rect = toast.getBoundingClientRect()
  return { exists: true, text: toast.textContent, display: style.display, visibility: style.visibility,
    box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, vw: innerWidth, vh: innerHeight }
})

const waitForToastText = (page, text) => page.waitForFunction(expected => document.querySelector('.dsh-mobile-path-toast')?.textContent === expected, text, { timeout: TOAST_WAIT })

const readClipboard = page => page.evaluate(() => window.__readText())

let checks = 0
const check = (name, condition) => { assert.ok(condition, name); checks++ }

try {
  // Touch context: checks 0-7 and 11 share one portrait phone.
  const context = await touchContext(browser, { width: 390, height: 844 })
  try {
    const page = await bootPage(context)
    await check('touch predicate matches in the emulated phone', await page.evaluate(() => matchMedia('(hover: none), (pointer: coarse)').matches))

    // 1. Nested-span taps resolve the titled owner.
    await page.locator('#path-dir').tap()
    await waitForToastText(page, 'Copied: topics/x/artifacts/report.md')
    check('directory-span tap copies the owner title', await readClipboard(page) === 'topics/x/artifacts/report.md')
    check('directory-span tap leaves the path focused', await page.evaluate(() => document.activeElement?.id) === 'preview-path')
    await page.locator('#path-name').tap()
    await page.waitForFunction(() => window.writes === 2, null, { timeout: TOAST_WAIT })
    check('name-span tap copies once more', await readClipboard(page) === 'topics/x/artifacts/report.md')

    // 2. The card is a pure open action: no copy, no toast of its own. Wait out
    //    check 1's toast first so "no toast" is observable, not inherited.
    await page.waitForFunction(() => document.querySelector('.dsh-mobile-path-toast')?.getAttribute('data-visible') == null, null, { timeout: TOAST_WAIT })
    const writesBeforeCard = await page.evaluate(() => window.writes)
    await page.locator('#card').tap()
    await page.waitForFunction(() => window.previewOpened === 1, null, { timeout: TOAST_WAIT })
    await page.waitForTimeout(400)
    check('card tap opens the preview without copying', await page.evaluate(() => window.writes) === writesBeforeCard)
    check('card tap raises no toast', await page.evaluate(() => document.querySelector('.dsh-mobile-path-toast')?.getAttribute('data-visible')) == null)

    // 3. A relative title copies exactly that value.
    await page.locator('#rel-path').tap()
    await waitForToastText(page, 'Copied: src/a.ts')
    check('relative title copies verbatim', await readClipboard(page) === 'src/a.ts')

    // 4. The changes-review switcher keeps its tap.
    const writesBeforeReview = await page.evaluate(() => window.writes)
    await page.locator('#switcher').tap()
    await page.waitForFunction(() => window.switcherTaps === 1, null, { timeout: TOAST_WAIT })
    check('review switcher tap does not copy', await page.evaluate(() => window.writes) === writesBeforeReview)

    // 5. Deleted clipboard API falls back to execCommand; 11. focus hygiene.
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }) })
    check('clipboard shadow took effect', await page.evaluate(() => navigator.clipboard === undefined))
    await page.evaluate(() => { document.getElementById('focus-anchor').focus() })
    await page.locator('#preview-path').tap()
    await waitForToastText(page, 'Copied: topics/x/artifacts/report.md')
    check('deleted api still copies via execCommand', await readClipboard(page) === 'topics/x/artifacts/report.md')
    check('fallback leaves no textarea behind', await page.evaluate(() => document.querySelector('textarea') === null))
    check('fallback leaves focus on a fixture element', await page.evaluate(() => ['focus-anchor', 'preview-path'].includes(document.activeElement?.id ?? '')))

    // 6. Present-but-empty clipboard object still falls back.
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true }) })
    check('empty clipboard object shadow took effect', await page.evaluate(() => navigator.clipboard?.writeText === undefined))
    await page.locator('#rel-path').tap()
    await waitForToastText(page, 'Copied: src/a.ts')
    check('writeText-less clipboard still copies', await readClipboard(page) === 'src/a.ts')

    // 7. Forced execCommand failure renders the failed template without throwing;
    //    a throwing execCommand is contained the same way (no unhandled rejection).
    await page.evaluate(() => { document.execCommand = () => false })
    await page.locator('#rel-path').tap()
    await waitForToastText(page, 'Could not copy the path.')
    check('failed copy reports the failed template', true)
    await page.evaluate(() => { document.execCommand = () => { throw new Error('SecurityError') } })
    await page.locator('#preview-path').tap()
    await waitForToastText(page, 'Could not copy the path.')
    check('throwing fallback is contained with failed feedback', await page.evaluate(() => window.__errors.length === 0))

    // 11. The fallback restores a focused element inside a scrolled scrollport.
    // A synthetic click keeps focus where the probe left it (a real tap focuses
    // the path span first), matching the reviewer's held-write scenario.
    await page.evaluate(() => {
      document.execCommand = window.__execCommand
      const port = document.getElementById('port')
      document.getElementById('in-port').focus()
      port.scrollTop = 100
      document.getElementById('rel-path').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitForToastText(page, 'Copied: src/a.ts')
    check('fallback keeps the nested scrollport position', await page.evaluate(() => document.getElementById('port').scrollTop === 100))
    check('fallback returns focus to the element inside the port', await page.evaluate(() => document.activeElement?.id) === 'in-port')
    check('no unhandled rejection anywhere in the run', await page.evaluate(() => window.__errors.length === 0))
  } finally { await context.close() }

  // 8. Computed, centered, viewport-contained toast at every touch width, for
  //    ordinary and long messages alike.
  for (const [name, viewport] of [['portrait phone', { width: 390, height: 844 }], ['landscape phone', { width: 844, height: 390 }], ['tablet', { width: 1024, height: 768 }]]) {
    const context = await touchContext(browser, viewport)
    try {
      const page = await bootPage(context)
      for (const [id, expected] of [['#path-name', 'Copied: topics/x/artifacts/report.md'], ['#long-path', `Copied: ${'deep/'.repeat(24)}report.md`]]) {
        await page.locator(id).tap()
        await waitForToastText(page, expected)
        const toast = await toastState(page)
        check(`${name} ${id}: toast is computed-visible`, toast.exists && toast.display !== 'none' && toast.visibility !== 'hidden')
        check(`${name} ${id}: toast is horizontally centered`, Math.abs(toast.box.x + toast.box.width / 2 - toast.vw / 2) <= 1.5)
        check(`${name} ${id}: toast stays inside the viewport`, toast.box.x >= 0 && toast.box.y >= 0 && toast.box.x + toast.box.width <= toast.vw && toast.box.y + toast.box.height <= toast.vh && toast.box.width > 0)
      }
    } finally { await context.close() }
  }

  // 9. Fine pointer: no copy, no toast, contextmenu un-suppressed.
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  try {
    const page = await bootPage(desktop)
    check('touch predicate does not match a fine pointer', await page.evaluate(() => !matchMedia('(hover: none), (pointer: coarse)').matches))
    await page.locator('#path-name').click()
    await page.waitForTimeout(300)
    check('fine-pointer click does not copy', await page.evaluate(() => window.writes) === 0)
    check('fine-pointer click shows no toast', (await toastState(page)).text !== 'Copied: topics/x/artifacts/report.md')
    await page.dispatchEvent('#preview-path', 'contextmenu')
    check('contextmenu sentinel still fires (non-interference fixture)', await page.evaluate(() => window.contextMenuTaps) === 1)
  } finally { await desktop.close() }

  // 10. Real locale rebind (dispose→install) leaves one listener and one toast.
  const rebind = await touchContext(browser, { width: 390, height: 844 })
  try {
    const page = await bootPage(rebind)
    await page.evaluate(() => { document.documentElement.lang = 'zh' })
    await page.waitForFunction(() => {
      const toasts = document.querySelectorAll('.dsh-mobile-path-toast')
      return toasts.length === 1 && toasts[0].lang === 'zh'
    }, null, { timeout: TOAST_WAIT })
    const writesBefore = await page.evaluate(() => window.writes)
    await page.locator('#path-name').tap()
    await waitForToastText(page, '已复制：topics/x/artifacts/report.md')
    check('rebound surface copies exactly once', await page.evaluate(() => window.writes) === writesBefore + 1)
    check('rebind leaves exactly one toast node', await page.evaluate(() => document.querySelectorAll('.dsh-mobile-path-toast').length) === 1)
    await page.evaluate(() => { document.documentElement.lang = 'en' })
    await page.waitForFunction(() => document.querySelectorAll('.dsh-mobile-path-toast').length === 1 && document.querySelector('.dsh-mobile-path-toast').lang === 'en', null, { timeout: TOAST_WAIT })
    await page.locator('#path-name').tap()
    await waitForToastText(page, 'Copied: topics/x/artifacts/report.md')
    check('rebind back to en copies with the en template', true)
  } finally { await rebind.close() }

  console.log(`smoke:path-copy passed (${checks} checks)`)
} finally {
  await browser.close()
}
