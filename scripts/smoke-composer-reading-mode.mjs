#!/usr/bin/env node
/**
 * Browser fixture for reading mode (issue #194): the real built client and
 * layout bundles in one page, so the settings switch (client bundle) and the
 * collapse installer (layout bundle) are two independent module instances, the
 * shipped shape. Asserts the toggle applies without a reload, that the real
 * [data-conversation-scroll] container drives the sample, and that the guards
 * (draft, running reply, send/stop reachability, scroll back up) hold.
 *
 * Usage: node scripts/smoke-composer-reading-mode.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const layout = await readFile(resolve(mobileRoot, 'lib/mobile-layout.js'), 'utf8')
const client = await readFile(resolve(mobileRoot, 'lib/client.js'), 'utf8')

// The fixture keeps DSH's geometry contract: html/body/#root never scroll, the
// conversation scrolls inside [data-conversation-scroll], and the composer card
// keeps the upstream Send/Stop row plus a contenteditable editor.
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}
#root{display:flex;flex-direction:column}
[data-conversation-scroll]{flex:1;overflow-y:auto;padding:8px}
.turn{height:120px;border-bottom:1px solid #ddd}
[data-composer-card]{border:1px solid #ccc;padding:8px;margin:8px}
#editor{min-height:24px}</style></head><body><div id="root">
<div data-conversation-scroll>${Array.from({ length: 40 }, (_, i) => `<div class="turn">Turn ${i}</div>`).join('')}</div>
<div data-composer-card><div id="editor" contenteditable="true" data-phase="plain"></div>
<button id="stop" aria-label="Stop">Stop</button><button id="send" aria-label="Send">Send</button></div>
</div></body></html>`

const browser = await chromium.launch({ headless: true })
let cases = 0
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.route('https://composer-reading-mode.test/**', route => route.fulfill({ contentType: 'text/html', body: fixture }))
  await page.goto('https://composer-reading-mode.test/')
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load: ({ id, factory }) => {
      const exports = factory(name => { if (name === 'react') return {}; throw new Error(`Unexpected dependency ${name}`) })
      if (id === 'dsh-mobile') window.mobileClient = exports
      else window.mobileLayout = exports
    } }
  })
  await page.addScriptTag({ content: layout })
  await page.addScriptTag({ content: client })
  // The collapse is a presentation attribute plus the shipped stylesheet; inject
  // the real one so the assertions cover the released rule, not a fixture copy.
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.textContent = window.mobileLayout.MOBILE_LAYOUT_STYLES
    document.head.append(style)
  })
  const crossBundle = await page.evaluate(() => {
    window.disposeReadingMode = window.mobileLayout.installComposerReadingMode({
      restoreLabel: 'Show composer',
      isRunning: () => window.__running === true,
    }).dispose;
    window.__running = false;
    // The two bundles inline their own copy of composer-collapse.ts; this is the
    // shipped shape, so the toggle has to travel through the persisted flag.
    return window.mobileClient !== window.mobileLayout
  })
  assert.equal(crossBundle, true, 'expected two independent bundles')

  const readAttribute = async () => page.evaluate(() => document.documentElement.getAttribute('data-dsh-mobile-composer-collapsed'))
  const scrollBy = async (delta) => page.evaluate(async pixels => {
    document.querySelector('[data-conversation-scroll]').scrollTop += pixels
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }, delta)

  // Off by default: the same scroll that later collapses must do nothing here.
  await scrollBy(600)
  assert.equal(await readAttribute(), null, 'disabled reading mode must not collapse')
  cases += 1

  // Flip the switch through the client bundle, exactly as the settings row does,
  // and keep the same page: no reload may be needed.
  const toggled = await page.evaluate(() => {
    window.mobileClient.writeComposerCollapseEnabled(true)
    return window.mobileLayout.readComposerCollapseEnabled()
  })
  assert.equal(toggled, true, 'layout bundle must observe the switch without a reload')
  cases += 1

  await scrollBy(600)
  assert.equal(await readAttribute(), 'true', 'scrolling the real scroller must collapse the composer')
  const painted = await page.evaluate(() => {
    const editor = document.querySelector('#editor')
    const stop = document.querySelector('#stop')
    const card = document.querySelector('[data-composer-card]')
    const label = getComputedStyle(card, '::before').content
    const box = stop.getBoundingClientRect()
    const atCenter = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return {
      editor: getComputedStyle(editor).display,
      stopBox: box.height,
      stopHit: atCenter !== null && atCenter.closest('#stop') !== null,
      label,
    }
  })
  assert.equal(painted.editor, 'none', 'the editor must be hidden')
  assert.ok(painted.stopBox > 0 && painted.stopHit, 'Send/Stop must stay reachable while collapsed')
  assert.ok(painted.label.includes('Show composer'), 'the restore label must come from the custom property')
  cases += 1

  // A draft means the composer is in use: it must never collapse away.
  await page.evaluate(async () => {
    document.querySelector('[data-conversation-scroll]').scrollTop = 0
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const editor = document.querySelector('#editor')
    editor.textContent = 'half-typed draft'
  })
  await scrollBy(600)
  assert.equal(await readAttribute(), 'false', 'a draft must keep the composer open')
  cases += 1

  // A streaming reply: data-phase is back to plain, so only the Session flag can
  // keep Stop where the user expects it.
  await page.evaluate(async () => {
    document.querySelector('#editor').textContent = ''
    window.__running = true
    document.querySelector('[data-conversation-scroll]').scrollTop = 0
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await scrollBy(600)
  assert.equal(await readAttribute(), 'false', 'a running reply must keep the composer open')
  cases += 1

  // Scrolling back up past the dead zone restores it.
  await page.evaluate(async () => {
    window.__running = false
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  await scrollBy(600)
  assert.equal(await readAttribute(), 'true', 'collapsed again for the restore case')
  await scrollBy(-90)
  assert.equal(await readAttribute(), 'false', 'scrolling back up past the dead zone must restore')
  cases += 1

  // Switching the opt-in off restores immediately.
  await scrollBy(600)
  assert.equal(await readAttribute(), 'true', 'collapsed before disabling')
  await page.evaluate(async () => {
    window.mobileClient.writeComposerCollapseEnabled(false)
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  assert.equal(await readAttribute(), 'false', 'disabling the switch must restore the composer')
  cases += 1

  await context.close()
  console.log(`composer reading mode fixture: ${cases} groups passed`)
} finally { await browser.close() }
