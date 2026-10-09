import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const client = await readFile(resolve(mobileRoot, 'lib/client.js'), 'utf8')
const icon = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5" fill="currentColor"/></svg>'
const usage = '用量 123,456,789 token · 缓存命中 99.9%'
const counts = '123,456 轮 · 987,654 步 · 1234.56 tok/s'
const button = (id, text) => `<span class="StatsPills_fixture_anchor"><button id="${id}" class="StatsPills_fixture_pill" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="${text}">${icon}<span class="StatsPills_fixture_label">${text}</span></button></span>`
const stats = mode => mode === 'detailed' ? `${button('time-pill', counts)}${button('usage-pill', usage)}`
  : mode === 'compact' ? `<span class="StatsPills_fixture_pill">${icon}1234.56 tok/s</span><span class="StatsPills_fixture_pill">${icon}缓存命中 99.9%</span>`
    : `<span class="StatsPills_fixture_anchor"><span class="StatsPills_fixture_pill">${icon}<span class="StatsPills_fixture_label">${counts}</span></span></span>${button('usage-pill', usage)}`
const extras = {
  none: '',
  full: '<div id="extra" class="Community_fixture_root" style="width:100%;flex:none">Community cost meter · $12.34</div>',
  auto: '<div id="extra" style="width:100px;flex:none">cost $12.34</div>',
  dialog: '<div id="extra" class="Community_fixture_root"><button class="Community_fixture_trigger" aria-haspopup="dialog">Community cost details</button></div>',
}

// These owner-local fixtures retain DSH's hidden-seat sibling rule, the
// display:contents slot anchor and all three StatsPills render forms.
const fixtureStyles = `
  *{box-sizing:border-box}html,body{margin:0;font:16px/1.5 Arial,sans-serif}
  body{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
  html{--dsw-alias-label-primary:#171a21;--dsw-alias-label-tertiary:#596273;--dsw-alias-bg-layer-1:#fff;--dsh-content-font-size-secondary:13px}
  html[data-theme="dark"]{--dsw-alias-label-primary:#f4f5f7;--dsw-alias-label-tertiary:#c0c6d0;--dsw-alias-bg-layer-1:#171a21}
  main{width:100%;padding:0 8px}.ChatView_fixture_column{display:flex;flex-direction:column;width:100%;margin:0 auto}
  .ChatView_fixture_column>.ChatView_fixture_flowItem:empty,.ChatView_fixture_column>.ChatView_fixture_flowItem:has(>[data-slot="conversation.chat.node"]:empty){height:0}
  .ChatView_fixture_column>:not([hidden]):not(.ChatView_fixture_flowItem:is(:empty,:has(>[data-slot="conversation.chat.node"]:empty)))~:not([hidden]):not(.ChatView_fixture_flowItem:is(:empty,:has(>[data-slot="conversation.chat.node"]:empty))){margin-top:var(--dsh-chat-flow-gap,6px)}
  #turn-title{height:32px}#reply{height:40px}.step-body{height:42px}
  .InputBar_fixture_root{display:flex;flex-direction:column;align-items:center;padding:0 8px 4px}
  [data-composer-card]{width:100%;height:40px}.InputBar_fixture_dock{display:flex;align-items:center;justify-content:center;gap:12px;max-width:100%;padding-top:4px}
  [data-slot="conversation.composer.dock"]{display:contents}
  .StatsPills_fixture_root{display:flex;justify-content:center;gap:12px;min-width:0;max-width:100%;font-size:12px;line-height:20px}
  .StatsPills_fixture_anchor{display:inline-flex;min-width:0}
  .StatsPills_fixture_pill{display:inline-flex;align-items:center;gap:6px;max-width:100%;padding:1px 8px;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;line-height:inherit;white-space:nowrap}
  .StatsPills_fixture_pill svg{width:14px;height:14px;flex:none}
  .StatsPills_fixture_label{min-width:0;overflow:hidden;text-overflow:ellipsis}
  .ContextMeter_fixture_root{display:inline-flex;flex:none}
  .ContextMeter_fixture_trigger{display:inline-flex;align-items:center;gap:6px;flex:none;padding:1px 8px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:13px/20px Arial,sans-serif;white-space:nowrap}
  #extra{color:var(--dsw-alias-label-tertiary)}#extra button{font:inherit;color:inherit;background:transparent;border:0}
  #stat-dialog{position:fixed;z-index:1100;inset:20px 16px auto;padding:16px;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
`

// Accessibility text enlargement overrides the app's compact px font in this
// fixture; the same rule also applies to the stock desktop comparison.
const enlargedTextStyles = '.large-text [data-composer-stats],.large-text [data-composer-stats] [class*="_pill"]{font-size:15px!important;line-height:24px!important}.large-text .ContextMeter_fixture_trigger{font-size:19.5px;line-height:30px}'

const fixture = (mode, extra, theme, large) => `<!doctype html><html class="dsh-native-mobile-active${large ? ' large-text' : ''}" data-theme="${theme}"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fixtureStyles}</style></head><body><main data-dsh-mobile-center>
  <div class="ChatView_fixture_column" data-dsh-mobile-message-column><div id="turn-title" class="ChatView_fixture_flowItem">Folded turn</div>
  ${Array.from({ length: 18 }, (_, index) => `<div id="step-${index}" class="ChatView_fixture_flowItem" hidden="until-found"><div class="step-body">Process ${index}</div></div>`).join('')}
  <div class="ChatView_fixture_flowItem"></div><div class="ChatView_fixture_flowItem"><div data-slot="conversation.chat.node"></div></div>
  <div id="reply" class="ChatView_fixture_flowItem">Assistant response</div></div>
  <div class="InputBar_fixture_root"><div data-composer-card></div><div id="dock" class="InputBar_fixture_dock"><div data-slot="conversation.composer.dock"><div class="StatsPills_fixture_root" data-composer-stats>${stats(mode)}</div>${extras[extra]}</div><div id="context-ring" class="ContextMeter_fixture_root"><button class="ContextMeter_fixture_trigger" type="button" aria-haspopup="dialog" aria-label="Context usage">${icon}99.9%</button></div></div></div>
  </main></body></html>`

const browser = await chromium.launch({ headless: true })
let cases = 0
try {
  const bootstrap = await browser.newContext()
  let nativeStyles
  try {
    const page = await bootstrap.newPage()
    await page.route('http://native-layout.test/**', route => route.fulfill({ status: 404, body: '' }))
    await page.goto('http://native-layout.test/')
    await page.evaluate(() => {
      window.__ModuleLoader__ = { load: ({ factory }) => { window.mobileClient = factory(name => {
        if (name === 'react') return {}
        throw new Error(`Unexpected client dependency: ${name}`)
      }) } }
    })
    await page.addScriptTag({ content: client })
    nativeStyles = await page.evaluate(() => {
      const cleanup = []
      try {
        window.mobileClient.apply({
          effect: effect => { const dispose = effect(); if (typeof dispose === 'function') cleanup.push(dispose) },
          get: () => undefined,
          slots: { inject: () => () => {}, register: () => () => {} },
        })
        const style = document.querySelector('style[data-plugin="dsh-mobile"]')
        if (style === null || !style.textContent.includes('data-dsh-mobile-message-column')) throw new Error('Built client did not install the native stylesheet')
        return style.textContent
      } finally { cleanup.reverse().forEach(dispose => dispose()) }
    })
  } finally { await bootstrap.close() }

  // Match stock row semantics: a passive pinned marker plus a pin/unpin action.
  // Desktop swaps them on hover; mobile keeps actions visible without hover.
  for (const width of [393, 720, 900]) {
    for (const native of [true, false]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true })
      try {
        const page = await context.newPage()
        await page.setContent(`<!doctype html><html class="${native ? 'dsh-native-mobile-active' : ''}"><head><style>
          .Rows_fixture_sessionRow{display:flex;align-items:center;height:40px}
          .Rows_fixture_pinIndicator{display:inline-flex;width:16px;height:20px}
          .Rows_fixture_rowActions{display:none}
          .Rows_fixture_sessionRow:hover .Rows_fixture_rowActions{display:inline-flex}
          .Rows_fixture_sessionRow:hover .Rows_fixture_pinIndicator{display:none}
        </style></head><body>
          <aside data-dsh-mobile-sidebar data-open="true"><div data-dsh-mobile-sidebar-root><div class="Rows_fixture_sessionRow" id="pinned-row">
            <span>Pinned session</span><span id="pin-marker" class="Rows_fixture_pinIndicator" aria-label="Pinned">${icon}</span>
            <span class="Rows_fixture_rowActions"><button id="unpin" aria-label="Unpin session">${icon}</button></span>
          </div><div class="Rows_fixture_sessionRow" id="unpinned-row"><span>Other session</span>
            <span class="Rows_fixture_rowActions"><button id="pin" aria-label="Pin session">${icon}</button></span>
          </div></div></aside>
          <div class="Rows_fixture_sessionRow"><span id="outside-marker" class="Rows_fixture_pinIndicator">${icon}</span></div>
        </body></html>`)
        await page.addStyleTag({ content: nativeStyles })
        const mobile = native && width <= 720
        const display = selector => page.locator(selector).evaluate(node => getComputedStyle(node).display)
        assert.equal(await display('#pin-marker'), mobile ? 'none' : 'flex', `${width}/${native}: passive pinned marker`)
        assert.equal(await display('#outside-marker'), 'flex', `${width}/${native}: unrelated row changed`)
        for (const selector of ['#unpin', '#pin']) {
          assert.equal(await page.locator(selector).isVisible(), mobile, `${width}/${native}: action visibility`)
        }
        if (mobile) {
          await page.evaluate(() => {
            document.querySelector('#unpin').addEventListener('click', () => {
              document.querySelector('#unpin').setAttribute('aria-label', 'Pin session')
              document.querySelector('#pin-marker').remove()
              document.querySelector('#pinned-row').dataset.unpinned = 'true'
            })
          })
          await page.locator('#unpin').tap()
          assert.equal(await page.locator('#pinned-row').getAttribute('data-unpinned'), 'true')
          assert.equal(await page.locator('#unpin').getAttribute('aria-label'), 'Pin session')
          assert.equal(await page.locator('#unpin').isVisible(), true)
        } else {
          await page.locator('#pinned-row').hover()
          assert.equal(await display('#pin-marker'), 'none', `${width}/${native}: desktop hover marker`)
          assert.equal(await page.locator('#unpin').isVisible(), true, `${width}/${native}: desktop hover action`)
        }
        cases++
      } finally { await context.close() }
    }
  }

  for (const viewport of [
    { width: 320, height: 844 }, { width: 375, height: 812 }, { width: 393, height: 844 },
    { width: 720, height: 900 }, { width: 900, height: 720 }, { width: 844, height: 393 },
  ]) {
    for (const theme of ['light', 'dark']) {
      for (const large of [false, true]) {
        const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: 'reduce' })
        try {
          const page = await context.newPage()
          for (const mode of ['detailed', 'compact', 'untimed']) {
            for (const extra of Object.keys(extras)) {
              const name = `${viewport.width}x${viewport.height}/${theme}/${large ? '150%' : '100%'}/${mode}/${extra}`
              await page.setContent(fixture(mode, extra, theme, large))
              if (large) await page.addStyleTag({ content: enlargedTextStyles })
              const geometry = () => page.evaluate(() => {
                const rect = selector => {
                  const node = document.querySelector(selector)
                  if (node === null) return null
                  const { x, y, width, height, bottom, right } = node.getBoundingClientRect()
                  const css = getComputedStyle(node)
                  return { x, y, width, height, bottom, right, order: css.order, wrap: css.flexWrap, fontSize: css.fontSize }
                }
                return { dock: rect('#dock'), stats: rect('[data-composer-stats]'), ring: rect('#context-ring'), extra: rect('#extra'),
                  gap: document.querySelector('#reply').getBoundingClientRect().top - document.querySelector('#turn-title').getBoundingClientRect().bottom }
              })
              const stock = await geometry()
              await page.addStyleTag({ content: nativeStyles })
              if (large) await page.addStyleTag({ content: enlargedTextStyles })
              const result = await geometry()
              if (viewport.width > 720) {
                assert.deepEqual(result, stock, `${name}: native styles changed desktop layout`)
                cases++
                continue
              }
              assert(Math.abs(result.gap - 10) <= 1, `${name}: folded/empty seats retained spacing ${JSON.stringify(result)}`)
              assert.equal(result.ring.order, '-1', `${name}: context ring lost its core row`)
              assert.equal(result.stats.order, '-2', `${name}: stats lost their core row`)
              assert(result.ring.y < result.stats.bottom && result.stats.y < result.ring.bottom, `${name}: context ring was stranded on another row`)
              assert(result.stats.right <= result.ring.x + 1, `${name}: statistics overlap the ring`)
              if (result.extra !== null) {
                assert.equal(result.extra.order, '0', `${name}: third-party dialog was mistaken for the context ring`)
                assert(result.extra.y >= Math.max(result.stats.bottom, result.ring.bottom) - 1, `${name}: extra dock entry overlaps the core row`)
                assert(result.extra.width <= result.dock.width + 1, `${name}: extra dock entry exceeds dock width`)
              }
              const statics = await page.locator('[data-composer-stats] span[class*="_pill"]').evaluateAll(elements => elements.map(element => {
                const box = element.getBoundingClientRect()
                const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
                const textBoxes = []
                while (walker.nextNode()) {
                  if (!walker.currentNode.textContent.trim()) continue
                  const range = document.createRange()
                  range.selectNodeContents(walker.currentNode)
                  textBoxes.push(...Array.from(range.getClientRects(), rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })))
                }
                return { text: element.textContent, overflow: getComputedStyle(element).overflow, width: element.clientWidth, scrollWidth: element.scrollWidth,
                  contained: textBoxes.every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1) }
              }))
              for (const value of statics) {
                assert.equal(value.overflow, 'visible', `${name}: static statistic has no disclosure but is clipped: ${JSON.stringify(value)}`)
                assert(value.contained && value.scrollWidth <= value.width + 1, `${name}: static statistic text is outside its visible box: ${JSON.stringify(value)}`)
              }
              await page.evaluate(() => {
                for (const button of document.querySelectorAll('[data-composer-stats] button')) {
                  button.addEventListener('click', () => {
                    const dialog = document.createElement('div')
                    dialog.id = 'stat-dialog'; dialog.setAttribute('role', 'dialog'); dialog.textContent = button.getAttribute('aria-label')
                    document.body.append(dialog); button.setAttribute('aria-expanded', 'true')
                  }, { once: true })
                }
              })
              for (const pill of await page.locator('[data-composer-stats] button').all()) {
                const label = await pill.getAttribute('aria-label')
                assert(label !== null && label.length > 12, `${name}: interactive statistic lost its complete accessible label`)
                await pill.click()
                assert.equal(await page.locator('#stat-dialog').textContent(), label, `${name}: full statistic is not available after tapping`)
                await page.locator('#stat-dialog').evaluate(element => element.remove())
              }
              await page.locator('#step-0').evaluate(element => element.removeAttribute('hidden'))
              assert((await page.locator('#step-0').boundingBox()).height >= 42, `${name}: revealing a folded process no longer restores content height`)
              cases++
            }
          }
        } finally { await context.close() }
      }
    }
  }
  console.log(`Native folded flow, dock entries, static values, accessible disclosures and desktop geometry passed in ${cases} layouts`)
} finally { await browser.close() }
