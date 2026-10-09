import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const client = await readFile(resolve(mobileRoot, 'lib/client.js'), 'utf8')
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
const layouts = []
for (const width of [288, 320, 375, 390, 393, 720, 844, 900]) {
  for (const font of [16, 20, 24, 32]) {
    for (const theme of ['light', 'dark']) layouts.push({ width, height: 900, font, theme, mode: 'extensions', compact: false })
  }
}
for (const [width, height] of [[288, 900], [320, 900], [360, 900], [375, 900], [390, 900], [360, 453], [320, 375], [720, 390]]) {
  for (const font of [16, 24, 32]) {
    for (const theme of ['light', 'dark']) {
      for (const mode of ['ordinary', 'dual', 'activity', ...(height < 500 ? ['extensions'] : [])]) {
        layouts.push({ width, height, font, theme, mode, compact: true })
      }
    }
  }
}

/** Stock toolbar groups and scrollport, with owner-local extension controls. */
function fixture({ font, theme, mode, compact, height }) {
  const extensions = mode === 'extensions'
  const activity = mode === 'activity'
  const modes = mode === 'ordinary' || mode === 'dual'
  const hidden = activity ? ' hidden' : ''
  const draft = height < 500
    ? Array.from({ length: 24 }, (_, index) => '<p>Held draft line ' + index + '</p>').join('') : '<p>Held draft</p>'
  return '<!doctype html><html class="dsh-native-mobile-active"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' +
    '*{box-sizing:border-box}body{margin:0;font:16px/1.5 Arial;background:' + (theme === 'light' ? '#fff' : '#171a21') + ';color:' + (theme === 'light' ? '#171a21' : '#fff') + '}main{padding:8px;width:100%;max-width:700px;margin:auto}' +
    'button{font:inherit;min-width:44px;min-height:44px;border:1px solid;padding:4px 8px;background:transparent;color:inherit}' +
    '.InputBar_fixture_icon{display:flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;padding:4px}.InputBar_fixture_icon svg{width:16px;height:16px}.InputBar_fixture_modes{display:flex;align-items:center;gap:6px;min-width:0}' +
    '[data-composer-card]{display:flex;flex-direction:column;gap:12px;padding-top:8px;font-size:' + font + 'px;line-height:1.5}' +
    '[data-input-scroll]{max-height:336px;overflow-y:auto;margin-right:4px}[data-composer-input]{min-height:36px;padding:4px 8px 0 14px;white-space:pre-wrap;overflow-wrap:anywhere}[data-composer-input] p{margin:0}' +
    '[data-composer-chip]{font-size:14px;white-space:nowrap}[data-slot="conversation.input.attachments"] img{display:block;width:44px;height:44px}' +
    '.InputBar_fixture_row,.InputBar_fixture_tools,.InputBar_fixture_trailing,.InputBar_fixture_standardControls{display:flex;align-items:center;gap:6px;min-width:0}.InputBar_fixture_row{flex-wrap:wrap;justify-content:space-between;padding:2px 8px 6px;container-type:inline-size}.InputBar_fixture_trailing{flex:none;margin-left:auto}.InputBar_fixture_standardControls{min-width:0}.InputBar_fixture_tools[hidden],.InputBar_fixture_standardControls[hidden]{display:none}.InputBar_fixture_primary{width:44px;height:44px;padding:4px;flex:none}[data-slot]{display:contents}.InputBar_fixture_activity:empty{display:none}.InputBar_fixture_activityExpanded{display:flex;flex:1;min-width:0;gap:6px}' +
    '.Model_fixture_root{position:relative;min-width:0}.Model_fixture_root button{display:flex;align-items:center;gap:4px;max-width:min(360px,45cqw);font-size:13px;line-height:20px;min-width:0}.Model_fixture_label{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.Model_fixture_icon{display:none;flex:none;width:16px;height:16px}.InputBar_fixture_row[data-model-compact] .Model_fixture_label{display:none}.InputBar_fixture_row[data-model-compact] .Model_fixture_icon{display:block}' +
    '</style></head><body><main data-dsh-mobile-center><div data-conversation-session="overflow"><div class="InputBar_fixture_root"><div data-composer-card>' +
    '<div data-slot="conversation.input.attachments"><div role="group"><img alt="held-image.png" src="' + image + '"></div></div>' +
    '<div data-input-scroll><div data-composer-input contenteditable="true"><span data-composer-chip="file" data-reference-path="held-reference.txt" contenteditable="false">held-reference.txt</span>' + draft + '</div></div>' +
    '<div class="InputBar_fixture_row" data-dsh-mobile-composer-row' + (compact ? ' data-model-compact' : '') + '>' +
    '<div class="InputBar_fixture_tools" data-dsh-mobile-composer-tools' + hidden + '><button id="add" class="InputBar_fixture_icon" aria-label="Add"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v12M2 8h12" stroke="currentColor"></path></svg></button>' +
    (modes ? '<div class="InputBar_fixture_modes"><div data-slot="conversation.input.permission"><button id="permission" class="InputBar_fixture_icon" aria-label="Permissions"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10v10H3z" fill="currentColor"></path></svg></button></div><div data-slot="conversation.input.plan"><button id="plan" class="InputBar_fixture_icon" aria-label="Plan"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3h10M3 8h10M3 13h10" stroke="currentColor"></path></svg></button></div></div>' : '') +
    '<div data-slot="conversation.input.left">' + (extensions ? '<button id="skill">技能</button><button id="memory">记忆·智能</button><button id="expert">专家提示词</button>' : '') + '</div></div>' +
    '<div class="InputBar_fixture_trailing" data-dsh-mobile-composer-trailing><div class="InputBar_fixture_standardControls" data-dsh-mobile-composer-controls' + hidden + '><div data-slot="conversation.input.right">' + (extensions ? '<button id="right-extra">' + (compact ? '更多' : 'Extra control') + '</button>' : '') + '</div><div class="Model_fixture_root" data-dsh-mobile-composer-model><button id="model" aria-label="Select model" data-dsh-mobile-composer-model-trigger><svg class="Model_fixture_icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2h12v12H2z" fill="currentColor"></path></svg><span class="Model_fixture_label" data-dsh-mobile-composer-model-label>' + (compact ? 'DeepSeek' : 'deepseek/example-long-model-name') + '</span></button></div></div>' +
    '<div class="' + (activity ? 'InputBar_fixture_activityExpanded' : 'InputBar_fixture_activity') + '">' + (activity ? '<button id="activity-action" aria-label="Finish recording">■</button>' : '') + '</div>' +
    (mode !== 'ordinary' ? '<button id="stop" class="InputBar_fixture_primary" aria-label="Stop">■</button>' : '') + '<button id="send" class="InputBar_fixture_primary" aria-label="Send">↑</button></div></div></div></div></div>' +
    '<div data-slot="settings.general.item"><div class="gUzyzq_row" id="host-font"><div class="gUzyzq_control"><div class="gUzyzq_stepper"><div class="gUzyzq_arrows"><button>Host font</button></div></div></div></div><div data-mobile-font-setting>Local font</div></div></main></body></html>'
}

/** Draft DOM, reference metadata and decoded attachment survive layout and control clicks. */
async function retained(page) {
  return page.evaluate(() => ({
    draft: document.querySelector('[data-composer-input]').innerHTML,
    references: Array.from(document.querySelectorAll('[data-composer-chip]'), chip => ({
      type: chip.getAttribute('data-composer-chip'), path: chip.getAttribute('data-reference-path'), text: chip.textContent,
    })),
    images: Array.from(document.querySelectorAll('[data-slot="conversation.input.attachments"] img'), img => ({
      name: img.alt, source: img.src, decoded: img.complete && img.naturalWidth > 0, width: img.naturalWidth, height: img.naturalHeight,
    })),
  }))
}

/** Every visible toolbar button must be inside the viewport and own its touch target. */
async function geometry(page, label) {
  const result = await page.locator('[data-dsh-mobile-composer-row] button').evaluateAll(buttons => buttons.flatMap(button => {
    const { x, y, right, bottom, width, height } = button.getBoundingClientRect()
    if (width === 0 || height === 0) return []
    const points = [[x + width / 2, y + height / 2], [x + 4, y + 4], [right - 4, bottom - 4]]
    return [{ id: button.id, x, y, right, bottom, width, height,
      hit: points.every(([left, top]) => { const target = document.elementFromPoint(left, top); return target === button || button.contains(target) }) }]
  }))
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  for (const rect of result) {
    assert(rect.x >= -0.5 && rect.right <= viewport.width + 0.5 && rect.y >= -0.5 && rect.bottom <= viewport.height + 0.5,
      label + ': ' + rect.id + ' leaves viewport ' + JSON.stringify({ rect, viewport, buttons: result }))
    assert(rect.height >= 44 && (viewport.width > 720 || rect.width >= 44),
      label + ': ' + rect.id + ' lost its mobile touch target ' + JSON.stringify(rect))
    assert(rect.hit, label + ': ' + rect.id + ' does not own its visible touch target ' + JSON.stringify(rect))
  }
  for (let index = 0; index < result.length; index++) for (const right of result.slice(index + 1)) {
    const left = result[index]
    const overlapX = Math.min(left.right, right.right) - Math.max(left.x, right.x)
    const overlapY = Math.min(left.bottom, right.bottom) - Math.max(left.y, right.y)
    assert(overlapX <= 0.5 || overlapY <= 0.5, label + ': controls overlap ' + JSON.stringify({ left, right, result }))
  }
  return result
}

const browser = await chromium.launch({ headless: true })
const failures = []
let cases = 0
try {
  for (const layout of layouts) {
    const { width, height, font, theme, mode, compact } = layout
    const label = width + 'x' + height + '/' + font + '/' + theme + '/' + mode + '/' + (compact ? 'compact' : 'text')
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      await page.route('https://overflow.test/**', route => route.fulfill({ contentType: 'text/html', body: fixture(layout) }))
      await page.goto('https://overflow.test/')
      await page.evaluate(font => {
        localStorage.setItem('dsh-mobile.content-font-size.v1', String(font))
        window.__ModuleLoader__ = { load: ({ factory }) => { window.mobileClient = factory(name => {
          if (name === 'react') return {}
          throw new Error('Unexpected dependency ' + name)
        }) } }
      }, font)
      await page.addScriptTag({ content: client })
      await page.evaluate(() => {
        const disposers = []
        window.mobileClient.apply({ effect: effect => { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) }, get: () => undefined, slots: { inject: () => () => {}, register: () => () => {} } })
        window.disposeMobile = () => disposers.reverse().forEach(dispose => dispose())
        window.clicks = []
        for (const button of document.querySelectorAll('[data-dsh-mobile-composer-row] button')) {
          button.addEventListener('mousedown', event => event.preventDefault())
          button.addEventListener('click', () => window.clicks.push(button.id))
        }
      })
      await page.waitForFunction(() => Array.from(document.images).every(img => img.complete && img.naturalWidth > 0))
      const expected = await retained(page)
      assert.equal(expected.references.length, 1, label + ': reference fixture was absent')
      assert.equal(expected.images.length, 1, label + ': attachment fixture was absent')
      assert(expected.images[0].decoded)
      if (mode === 'extensions') assert.equal(await page.locator('#skill').textContent(), '技能', label + ': UTF-8 control text was misdecoded')
      await page.locator('[data-composer-input]').focus()
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal(await page.locator('[data-composer-input]').evaluate(editor => document.activeElement === editor), true)
      if (height < 500) {
        const scroll = await page.locator('[data-input-scroll]').evaluate(node => {
          node.scrollTop = node.scrollHeight
          return { height: node.getBoundingClientRect().height, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop }
        })
        const cap = height <= 400 ? 48 : 72
        assert(scroll.height <= cap + 0.5 && scroll.scrollHeight > scroll.height && scroll.scrollTop > 0,
          label + ': focused long draft did not remain scrollable inside the short viewport ' + JSON.stringify(scroll))
        if (height <= 400) assert.equal(await page.locator('[data-composer-card]').evaluate(node => getComputedStyle(node).gap), '8px',
          label + ': short viewport did not retain compact card spacing')
      }
      if (mode === 'activity') {
        assert.equal(await page.locator('[data-dsh-mobile-composer-tools]').isVisible(), false, label + ': activity exposed tools')
        assert.equal(await page.locator('[data-dsh-mobile-composer-controls]').isVisible(), false, label + ': activity exposed model controls')
      }
      const buttons = await geometry(page, label)
      const add = buttons.find(rect => rect.id === 'add')
      const send = buttons.find(rect => rect.id === 'send')
      assert(send !== undefined, label + ': primary action disappeared')
      if (mode === 'ordinary') {
        assert(add !== undefined)
        assert(Math.abs((add.y + add.height / 2) - (send.y + send.height / 2)) <= 0.5,
          label + ': ordinary controls were forced onto separate rows ' + JSON.stringify(buttons))
      }
      if (mode === 'extensions' && width <= 375) {
        assert(add !== undefined && send.y > add.y + 0.5, label + ': extension demand did not wrap ' + JSON.stringify(buttons))
      }
      if (mode !== 'ordinary') assert(buttons.some(rect => rect.id === 'stop'), label + ': Stop disappeared')
      for (const button of buttons) {
        await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2)
        assert.deepEqual(await retained(page), expected, label + ': ' + button.id + ' changed the held draft, reference or image')
      }
      assert.deepEqual(await page.evaluate(() => window.clicks), buttons.map(button => button.id), label + ': a touch activated another control')
      if (height < 500) {
        const editor = page.locator('[data-composer-input]')
        const cap = height <= 400 ? 48 : 72
        for (const focused of [false, true]) {
          if (focused) await editor.focus()
          else await editor.evaluate(node => node.blur())
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
          const stage = label + (focused ? '/refocused' : '/blurred')
          assert.equal(await editor.evaluate(node => document.activeElement === node), focused, stage + ': editor focus did not change')
          const scroll = await page.locator('[data-input-scroll]').evaluate(node => ({
            height: node.getBoundingClientRect().height, cap: getComputedStyle(node).maxHeight,
          }))
          assert.equal(scroll.cap, cap + 'px', stage + ': draft height cap changed ' + JSON.stringify(scroll))
          assert(scroll.height <= cap + 0.5, stage + ': draft escaped its height cap ' + JSON.stringify(scroll))
          const currentButtons = await geometry(page, stage)
          assert.deepEqual(currentButtons.map(button => button.id), buttons.map(button => button.id), stage + ': visible controls changed')
          assert.deepEqual(await retained(page), expected, stage + ': draft, reference or image changed')
        }
      }
      assert.equal(await page.locator('#host-font').evaluate(node => getComputedStyle(node).display), 'none', label + ': Host font row was not replaced')
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, label + ': horizontal document overflow')
      await page.evaluate(async font => {
        document.body.style.setProperty('--dsh-content-font-size', '17px')
        await new Promise(resolve => requestAnimationFrame(resolve))
        if (document.body.style.getPropertyValue('--dsh-content-font-size') !== font + 'px') throw new Error('Host changed mobile typography')
        window.disposeMobile()
        if (document.body.style.getPropertyValue('--dsh-content-font-size') !== '17px') throw new Error('Disposal did not restore latest Host typography')
      }, font)
      assert.deepEqual(await retained(page), expected, label + ': disposal changed retained content')
      cases++
    } catch (error) {
      failures.push(label + ': ' + String(error))
    } finally { await context.close() }
  }
  assert.equal(failures.length, 0, cases + '/' + layouts.length + ' layouts passed; failures:\n' + failures.join('\n'))
  console.log('Composer ordinary single-row controls, extension wrapping, Stop/Send, 360x453 and 320x375 focused/blurred/refocused drafts, activity, typography and disposal passed in all ' + cases + ' layouts')
} finally { await browser.close() }
