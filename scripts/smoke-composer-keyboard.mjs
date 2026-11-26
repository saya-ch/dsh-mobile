import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const layout = await readFile(resolve(mobileRoot, 'lib/mobile-layout.js'), 'utf8')
const client = await readFile(resolve(mobileRoot, 'lib/client.js'), 'utf8')
const fixture = `<!doctype html><html class="dsh-native-mobile-active"><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{margin:8px;font:14px/1.5 Arial}main{max-width:800px}section{padding:8px}button{min-height:48px;min-width:48px}input,textarea,[contenteditable]{font:inherit}svg{width:20px;height:20px}</style></head><body>
  <main class="dshm-shell" data-dsh-mobile-center><div id="session-owner" data-conversation-session="first-session"><section id="first" data-composer-card>
    <div data-slot="conversation.input.attachments"></div><div id="editor" contenteditable="true" data-phase="plain">Draft</div>
    <button id="add" aria-haspopup="listbox">Add</button><button id="stop" class="InputBar_fixture_primary"><svg><rect width="10" height="10"/></svg></button>
    <button id="plugin">Plugin</button><button id="send" class="InputBar_fixture_primary"><svg><path d="M0 10L10 0L20 10"/></svg></button></section></div>
    <section id="second" data-composer-card><div id="other-editor" contenteditable="plaintext-only">Other draft</div>
      <button id="other-send" class="InputBar_fixture_primary"><svg><path d="M0 10L10 0"/></svg></button></section>
    <input id="field"><textarea id="area"></textarea><div id="empty-attribute" contenteditable="">Editable</div>
    <div style="font-size:20px"><div id="inherited" contenteditable="true">Large inherited text</div></div>
    <div contenteditable="true"><span id="inherited-child">Inherited editable child</span></div>
  </main></body></html>`

// Real trusted browser pointer/keyboard events exercise the built policy against
// stock composer markers. The fixture controls submission settlement only; IME
// visibility and Safari auto-zoom still require a physical device.
const browser = await chromium.launch({ headless: true })
let cases = 0
try {
  async function withPage(options, run) {
    const context = await browser.newContext({ viewport: { width: options.width ?? 393, height: options.height ?? 844 }, hasTouch: options.touch !== false, isMobile: options.touch !== false, reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      await page.route('https://composer-keyboard.test/**', route => route.fulfill({ contentType: 'text/html', body: fixture }))
      await page.goto('https://composer-keyboard.test/')
      await page.evaluate(() => {
        window.__ModuleLoader__ = { load: ({ id, factory }) => {
          const exports = factory(name => { if (name === 'react') return {}; throw new Error(`Unexpected dependency ${name}`) })
          if (id === 'dsh-mobile') window.mobileClient = exports
          else window.mobileLayout = exports
        } }
      })
      await page.addScriptTag({ content: layout })
      await page.addScriptTag({ content: client })
      if (options.enter) await page.evaluate(() => {
        const main = document.querySelector('main')
        main.classList.add('dshm-main')
        const editor = document.querySelector('#editor')
        editor.setAttribute('data-composer-input', '')
        const scroll = document.createElement('div')
        scroll.setAttribute('data-input-scroll', '')
        editor.before(scroll)
        scroll.append(editor)
        const row = document.createElement('div')
        row.append(document.createElement('div'))
        scroll.after(row)
        const area = document.createElement('textarea')
        area.id = 'composer-area'
        document.querySelector('#first').append(area)
      })
      await page.evaluate(keepNative => {
        const cleanup = []
        try {
          window.mobileClient.apply({
            effect: effect => { const dispose = effect(); if (typeof dispose === 'function') cleanup.push(dispose) },
            get: () => undefined,
            slots: { inject: () => () => {}, register: () => () => {} },
          })
          window.nativeStyles = document.querySelector('style[data-plugin="dsh-mobile"]')?.textContent
          if (window.nativeStyles === undefined) throw new Error('Built client did not install native styles')
        } finally { if (!keepNative) cleanup.reverse().forEach(dispose => dispose()) }
        window.collapses = 0
        window.disposePolicy = window.mobileLayout.installComposerSendKeyboardPolicy(() => { window.collapses++ })
        window.mode = 'immediate'
        const commit = () => {
          const editor = document.querySelector('#editor')
          editor.replaceChildren(document.createElement('p'))
          editor.dataset.phase = 'plain'
          document.querySelector('[data-slot="conversation.input.attachments"]').replaceChildren()
        }
        for (const button of document.querySelectorAll('button')) {
          button.addEventListener('mousedown', event => { event.preventDefault() })
        }
        document.querySelector('#send').addEventListener('click', () => {
          if (window.mode === 'no-consumption') return
          if (window.mode === 'async') {
            document.querySelector('#editor').dataset.phase = 'submitting'
            window.finishSend = commit
            return
          }
          commit()
          if (window.mode === 'immediate-failure') queueMicrotask(() => { document.querySelector('#editor').textContent = 'Restored draft' })
        })
      }, options.enter === true)
      await run(page)
      cases++
    } finally { await context.close() }
  }
  const mountStyles = async (page, surface = 'native') => {
    const css = await page.evaluate(surface => surface === 'native' ? window.nativeStyles : window.mobileLayout.MOBILE_LAYOUT_STYLES, surface)
    await page.addStyleTag({ content: css })
    // The capture above disposes the client, including its root marker. Model
    // an active native surface again when testing its body-level portal rules.
    await page.evaluate(surface => { document.documentElement.classList.toggle('dsh-native-mobile-active', surface === 'native') }, surface)
  }
  for (const width of [320, 393, 768, 980]) {
    await withPage({ width }, async page => {
      await mountStyles(page)
      await page.evaluate(() => {
        const editor = document.querySelector('#editor')
        editor.textContent = Array.from({ length: 20 }, (_, i) => `Draft line ${i}`).join('\n')
        editor.style.whiteSpace = 'pre-wrap'
        const scroll = document.createElement('div')
        scroll.setAttribute('data-input-scroll', '')
        editor.before(scroll)
        scroll.append(editor)
        const row = document.createElement('div')
        row.setAttribute('data-dsh-mobile-composer-row', '')
        scroll.after(row)
        row.append(document.querySelector('#stop'), document.querySelector('#send'))
        for (const button of row.querySelectorAll('button')) button.style.cssText = 'min-width:20px;min-height:20px;width:20px;height:20px;padding:0'
        document.querySelector('#send').disabled = true
        window.initialDraft = editor.innerHTML
        window.stops = 0
        document.querySelector('#stop').addEventListener('click', () => { window.stops++ })
      })
      const height = () => page.locator('[data-input-scroll]').evaluate(node => node.getBoundingClientRect().height)
      const collapsed = await height()
      if (width <= 768) assert(collapsed <= 72)
      else assert(collapsed > 72)
      await page.locator('#editor').focus()
      assert(await height() > 72)
      await page.locator('#stop').focus()
      assert(await height() > 72)
      await page.locator('#field').focus()
      assert.equal(await height(), collapsed)
      assert(await page.evaluate(() => document.querySelector('#editor').innerHTML === window.initialDraft))
      if (width <= 768) {
        for (const selector of ['#stop', '#send']) { const box = await page.locator(selector).boundingBox(); assert(box.width >= 44 && box.height >= 44) }
        await page.locator('#stop').tap()
        assert.equal(await page.evaluate(() => window.stops), 1)
        assert.equal(await page.locator('#send').isDisabled(), true)
        await page.evaluate(() => {
          window.disabledSends = 0
          document.querySelector('#send').addEventListener('click', () => { window.disabledSends++ })
        })
        const disabledBounds = await page.locator('#send').boundingBox()
        await page.touchscreen.tap(disabledBounds.x + disabledBounds.width / 2, disabledBounds.y + disabledBounds.height / 2)
        assert.equal(await page.evaluate(() => window.disabledSends), 0)
        assert(await page.evaluate(() => document.querySelector('#editor').innerHTML === window.initialDraft))
        await page.evaluate(() => {
          const queue = document.querySelector('#send')
          queue.disabled = false
          queue.setAttribute('aria-label', 'Queue message')
          window.mode = 'no-consumption'
          window.queues = 0
          queue.addEventListener('click', () => { window.queues++ })
        })
        await page.locator('#send').tap()
        assert.equal(await page.evaluate(() => window.queues), 1)
        assert(await page.evaluate(() => document.querySelector('#editor').innerHTML === window.initialDraft))
        await page.locator('#send').evaluate(button => { button.setAttribute('aria-label', 'Steer message') })
        await page.locator('#send').tap()
        assert.equal(await page.evaluate(() => window.queues), 2, 'Steer activation changed the stock primary-button handler')
        assert(await page.evaluate(() => document.querySelector('#editor').innerHTML === window.initialDraft))
      }
    })
  }
  // The stock dock is bottom-anchored. A body portal changes :focus-within
  // without moving its toolbar anchor; reference and attachment DOM stays owned
  // by the composer throughout collapse, search, and focus return.
  for (const viewport of [{ width: 375, height: 812 }, { width: 844, height: 393 }]) {
    for (const size of [14, 20]) {
      await withPage(viewport, async page => {
        await mountStyles(page)
        await page.addStyleTag({ content: `#first{position:fixed;bottom:0;left:0;box-sizing:border-box;width:100%;background:white;display:flex;flex-direction:column;gap:12px}#first [data-input-scroll]{max-height:336px;overflow-y:auto}#editor{white-space:pre-wrap}#portal{position:fixed;left:8px;width:calc(100% - 16px);height:96px;background:white}` })
        await page.evaluate(size => {
          document.documentElement.style.setProperty('--dsh-content-font-size', `${size}px`)
          const editor = document.querySelector('#editor')
          editor.textContent = Array.from({ length: 24 }, (_, index) => `Preserved draft ${index}`).join('\n')
          const reference = document.createElement('span')
          reference.contentEditable = 'false'
          reference.setAttribute('data-lexical-decorator', 'true')
          reference.textContent = '@saved-reference'
          editor.append(reference)
          const scroll = document.createElement('div')
          scroll.setAttribute('data-input-scroll', '')
          editor.before(scroll)
          scroll.append(editor)
          const row = document.createElement('div')
          row.setAttribute('data-dsh-mobile-composer-row', '')
          const tools = document.createElement('div')
          tools.setAttribute('data-dsh-mobile-composer-tools', '')
          const trailing = document.createElement('div')
          trailing.setAttribute('data-dsh-mobile-composer-trailing', '')
          row.append(tools, trailing)
          tools.append(document.querySelector('#add'))
          const model = document.createElement('button')
          model.id = 'model-trigger'
          model.textContent = 'Model'
          model.setAttribute('aria-haspopup', 'menu')
          model.setAttribute('aria-expanded', 'true')
          trailing.append(model, document.querySelector('#stop'), document.querySelector('#send'))
          scroll.after(row)
          const attachments = document.querySelector('[data-slot="conversation.input.attachments"]')
          attachments.innerHTML = '<div role="group"><span data-attachment-id="saved">Saved image</span></div>'
          const portal = document.createElement('div')
          portal.id = 'portal'
          portal.setAttribute('role', 'menu')
          portal.innerHTML = '<button id="portal-option">Model option</button><input id="portal-search" aria-label="Search models">'
          document.body.append(portal)
          window.preservedDraft = editor.innerHTML
          window.preservedAttachments = attachments.innerHTML
        }, size)
        await page.locator('#editor').focus()
        await page.locator('#first [data-input-scroll]').evaluate(scroll => { scroll.scrollTop = scroll.scrollHeight })
        await page.locator('#model-trigger').focus()
        const geometry = () => page.locator('#model-trigger').evaluate(trigger => {
          const scroll = document.querySelector('#first [data-input-scroll]')
          return { top: trigger.getBoundingClientRect().top, height: scroll.getBoundingClientRect().height, scrollTop: scroll.scrollTop }
        })
        const expanded = await geometry()
        assert(expanded.height > 72)
        await page.locator('#portal').evaluate(portal => { portal.style.top = `${document.querySelector('#model-trigger').getBoundingClientRect().top - 104}px` })
        const menuTop = await page.locator('#portal').evaluate(portal => portal.getBoundingClientRect().top)
        for (const selector of ['#portal-option', '#portal-search']) {
          await page.locator(selector).focus()
          if (selector === '#portal-search') {
            assert.equal(await page.locator(selector).evaluate(node => getComputedStyle(node).fontSize), `${Math.max(16, size)}px`)
          }
          const folded = await geometry()
          assert.equal(folded.height, viewport.width <= 768 ? 72 : expanded.height)
          assert(Math.abs(folded.top - expanded.top) <= 1, `Toolbar anchor moved on portal focus: ${JSON.stringify({ expanded, folded })}`)
          assert.equal(folded.scrollTop, expanded.scrollTop)
          assert.equal(await page.locator('#portal').evaluate(portal => portal.getBoundingClientRect().top), menuTop)
          assert(await page.evaluate(() => document.querySelector('#editor').innerHTML === window.preservedDraft))
          assert(await page.evaluate(() => document.querySelector('[data-slot="conversation.input.attachments"]').innerHTML === window.preservedAttachments))
        }
        await page.locator('#editor').focus()
        assert.equal((await geometry()).height, expanded.height)
        assert(await page.evaluate(() => document.querySelector('#editor').innerHTML === window.preservedDraft))
      })
    }
  }
  const frames = page => page.evaluate(() => new Promise(resolveFrames => { requestAnimationFrame(() => { requestAnimationFrame(() => { requestAnimationFrame(resolveFrames) }) }) }))
  const focused = page => page.evaluate(() => document.activeElement.id)
  const prepare = async (page, mode = 'immediate') => {
    await page.evaluate(mode => { window.mode = mode }, mode)
    await page.locator('#editor').focus()
  }
  const tap = async (page, selector) => {
    const box = await page.locator(selector).boundingBox()
    assert(box !== null)
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
  }
  const expectCollapsed = async page => {
    await page.waitForFunction(() => window.collapses === 1)
    assert.notEqual(await focused(page), 'editor')
  }
  const expectPreserved = async page => {
    await frames(page)
    assert.equal(await focused(page), 'editor')
    assert.equal(await page.evaluate(() => window.collapses), 0)
  }

  for (const width of [393, 980]) {
    for (const surface of ['native', 'shell']) {
      await withPage({ width }, async page => {
        await page.evaluate(surface => {
          if (surface === 'native') document.querySelector('main').classList.remove('dshm-shell')
          else document.querySelector('main').removeAttribute('data-dsh-mobile-center')
          const portal = document.createElement('div')
          portal.id = 'font-portal'
          portal.style.fontSize = '12px'
          portal.innerHTML = '<input id="body-portal-search" role="searchbox"><textarea id="body-portal-textarea"></textarea><div id="body-portal-editor" contenteditable="true">Portal text</div>'
          document.body.append(portal)
          if (surface === 'native') {
            const hint = document.createElement('input')
            hint.id = 'editable-hint'
            hint.className = 'Fixture_root'
            document.querySelector('main').append(hint)
            const dock = document.createElement('div')
            dock.setAttribute('data-slot', 'conversation.composer.dock')
            dock.innerHTML = '<input id="editable-stats" class="Fixture_root"><div id="static-stats" class="Fixture_root">Stats</div>'
            document.querySelector('main').append(dock)
          }
        }, surface)
        await mountStyles(page, surface)
        assert.equal(await page.locator('#font-portal').evaluate(node => node.closest('.dshm-shell,[data-dsh-mobile-center]')), null)
        for (const size of [14, 18, 20]) {
          await page.evaluate(size => { document.documentElement.style.setProperty('--dsh-content-font-size', `${size}px`) }, size)
          const sizes = await page.locator('#editor,#other-editor,#field,#area,#empty-attribute,#inherited-child,#body-portal-search,#body-portal-textarea,#body-portal-editor').evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).fontSize)))
          assert(sizes.every(value => value === Math.max(16, size)), `${surface} ${width}px: editable font did not preserve ${size}px preference: ${sizes}`)
          if (surface === 'native') {
            const metadataSizes = await page.locator('#editable-hint,#editable-stats').evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).fontSize)))
            assert(metadataSizes.every(value => value === Math.max(16, size)), `Native metadata rules overrode editable fonts: ${metadataSizes}`)
            if (width <= 768) assert.equal(await page.locator('#static-stats').evaluate(node => getComputedStyle(node).fontSize), '10px')
          }
          assert.equal(await page.locator('#inherited').evaluate(node => getComputedStyle(node).fontSize), '20px')
        }
        await page.evaluate(() => { document.documentElement.style.removeProperty('--dsh-content-font-size') })
        assert.equal(await page.locator('#inherited').evaluate(node => getComputedStyle(node).fontSize), '20px')
      })
    }
  }
  await withPage({ width: 980, touch: false }, async page => {
    await page.evaluate(() => {
      document.querySelector('main').classList.remove('dshm-shell')
      document.querySelector('main').removeAttribute('data-dsh-mobile-center')
      const portal = document.createElement('div')
      portal.style.fontSize = '12px'
      portal.innerHTML = '<input id="desktop-portal-search" role="searchbox">'
      document.body.append(portal)
    })
    await mountStyles(page, 'shell')
    await page.addStyleTag({ content: await page.evaluate(() => window.nativeStyles) })
    const before = await page.locator('#desktop-portal-search').evaluate(node => getComputedStyle(node).fontSize)
    assert.equal(before, '12px', 'Mobile stylesheet changed an ordinary desktop portal')
    await page.evaluate(() => { document.documentElement.style.setProperty('--dsh-content-font-size', '20px') })
    assert.equal(await page.locator('#desktop-portal-search').evaluate(node => getComputedStyle(node).fontSize), before)
    assert.equal(await page.locator('#editor').evaluate(node => getComputedStyle(node).fontSize), '14px')
  })
  await withPage({}, async page => { await prepare(page); await tap(page, '#send'); await expectCollapsed(page) })
  await withPage({ width: 980 }, async page => { await prepare(page); await tap(page, '#send'); await expectCollapsed(page) })
  await withPage({}, async page => {
    await page.locator('#editor').fill('')
    await prepare(page); await tap(page, '#send'); await expectPreserved(page)
  })
  await withPage({}, async page => {
    await page.locator('#send').evaluate(node => { node.disabled = true })
    await prepare(page); await tap(page, '#send'); await frames(page)
    assert.equal(await page.evaluate(() => window.collapses), 0)
    assert.equal(await page.locator('#editor').textContent(), 'Draft')
  })
  await withPage({}, async page => {
    await prepare(page, 'async'); await tap(page, '#send'); await expectPreserved(page)
    await page.evaluate(() => { window.finishSend() }); await expectCollapsed(page)
  })
  await withPage({}, async page => {
    await page.locator('#editor').fill('')
    await page.evaluate(() => { document.querySelector('[data-slot="conversation.input.attachments"]').innerHTML = '<div role="group"><div><img alt="photo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></div></div>' })
    await prepare(page); await tap(page, '#send'); await expectCollapsed(page)
  })
  await withPage({}, async page => {
    await page.locator('#editor').evaluate(node => { node.innerHTML = '<span contenteditable="false" data-lexical-decorator="true"><img alt="reference"></span>' })
    await prepare(page); await tap(page, '#send'); await expectCollapsed(page)
  })
  for (const selector of ['#add', '#stop', '#plugin', '#other-send']) {
    await withPage({}, async page => { await prepare(page); await tap(page, selector); await expectPreserved(page) })
  }
  for (const mode of ['no-consumption', 'immediate-failure']) {
    await withPage({}, async page => { await prepare(page, mode); await tap(page, '#send'); await expectPreserved(page); assert.notEqual(await page.locator('#editor').textContent(), '') })
  }
  await withPage({}, async page => { await prepare(page); await page.locator('#send').evaluate(node => { node.click() }); await expectPreserved(page) })
  await withPage({}, async page => {
    await prepare(page)
    await page.locator('#editor').evaluate(node => { node.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); document.querySelector('#send').click() } }) })
    await page.keyboard.press('Enter'); await expectPreserved(page)
  })
  await withPage({ touch: false, width: 980 }, async page => { await prepare(page); await page.locator('#send').click(); await expectPreserved(page) })
  await withPage({}, async page => {
    await page.evaluate(() => { window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = { imeVisible: true, noHardwareKeyboard: false } })
    await prepare(page); await tap(page, '#send'); await expectPreserved(page)
  })
  await withPage({}, async page => {
    await page.evaluate(() => { window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = { imeVisible: true, noHardwareKeyboard: true } })
    await prepare(page); await tap(page, '#send'); await expectCollapsed(page)
  })
  for (const nativeState of [undefined, { imeVisible: false, noHardwareKeyboard: true }]) {
    await withPage({}, async page => {
      await page.evaluate(nativeState => { window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = nativeState }, nativeState)
      await prepare(page); await tap(page, '#send'); await expectPreserved(page)
    })
  }
  await withPage({}, async page => {
    await prepare(page); await page.locator('#editor').evaluate(node => { node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
    await tap(page, '#send'); await expectPreserved(page)
  })
  for (const cancellation of ['type', 'focus', 'unmount', 'dispose', 'new-composer', 'session-change']) {
    await withPage({}, async page => {
      await prepare(page, 'async'); await tap(page, '#send')
      if (cancellation === 'type') await page.keyboard.type('suffix')
      if (cancellation === 'focus') await page.locator('#field').focus()
      if (cancellation === 'unmount') await page.locator('#first').evaluate(node => { node.remove() })
      if (cancellation === 'dispose') await page.evaluate(() => { window.disposePolicy() })
      if (cancellation === 'new-composer') await page.locator('#editor').evaluate(node => { document.querySelector('#second').append(node) })
      if (cancellation === 'session-change') await page.locator('#session-owner').evaluate(node => { node.dataset.conversationSession = 'new-session' })
      if (cancellation !== 'unmount') await page.evaluate(() => { window.finishSend() })
      await frames(page)
      assert.equal(await page.evaluate(() => window.collapses), 0, `Observation survived ${cancellation}`)
    })
  }
  await withPage({}, async page => {
    await prepare(page); await tap(page, '#send'); await expectCollapsed(page)
    await page.locator('#editor').evaluate(node => { node.textContent = 'Late API failure restored the draft' })
    assert.equal(await page.locator('#editor').textContent(), 'Late API failure restored the draft')
  })
  // Keep the built native surface alive alongside the send-collapse policy.
  // The fixture models the stock editor's Shift+Enter command with a real DOM
  // line break; plain Enter submits, and composition/menu Enter is consumed.
  const softState = { imeVisible: true, noHardwareKeyboard: true }
  const expectEnter = async (page, key, expected, safeguard) => {
    await page.evaluate(() => {
      window.enterCounts = { sends: 0, newlines: 0, menus: 0, compositions: 0 }
      window.mode = 'no-consumption'
      document.querySelector('#send').addEventListener('click', () => { window.enterCounts.sends++ })
      const editor = document.querySelector('#editor')
      window.fixtureComposing = false
      window.fixtureConfirming = false
      editor.addEventListener('compositionstart', () => { window.fixtureComposing = true })
      editor.addEventListener('compositionend', () => { window.fixtureComposing = false })
      editor.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return
        if (window.fixtureComposing || window.fixtureConfirming || editor.hasAttribute('data-composer-composing') || event.isComposing || event.keyCode === 229) {
          event.preventDefault(); window.enterCounts.compositions++; return
        }
        if (document.querySelector('#add').getAttribute('aria-expanded') === 'true' || document.querySelector('[data-trigger-menu]')) {
          event.preventDefault(); window.enterCounts.menus++; return
        }
        if (event.shiftKey) {
          event.preventDefault()
          document.execCommand('insertLineBreak')
          window.enterCounts.newlines++
        } else {
          event.preventDefault(); document.querySelector('#send').click()
        }
      })
    })
    await page.locator('#editor').focus()
    await page.keyboard.press('End')
    await page.evaluate(safeguard => {
      const editor = document.querySelector('#editor')
      if (safeguard === 'composition') editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      if (safeguard === 'composition-marker') editor.setAttribute('data-composer-composing', '')
      if (safeguard === 'recent-composition') {
        // Freeze only the policy clock to test the 10ms confirmation window
        // deterministically while the subsequent keyboard event stays trusted.
        performance.now = () => 100
        window.fixtureConfirming = true
        editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      }
      if (safeguard === 'menu') document.querySelector('#add').setAttribute('aria-expanded', 'true')
      if (safeguard === 'menu-marker') {
        const menu = document.createElement('div')
        menu.setAttribute('data-trigger-menu', '')
        document.querySelector('#first').append(menu)
      }
    }, safeguard)
    await page.keyboard.press(key)
    const { nativeNewline, ...counts } = { nativeNewline: 0, ...expected }
    assert.deepEqual(await page.evaluate(() => window.enterCounts), { sends: 0, newlines: 0, menus: 0, compositions: 0, ...counts })
    const text = await page.locator('#editor').innerText()
    if (expected.newlines || nativeNewline) assert(text.includes('\n'), `No DOM newline for ${key}: ${JSON.stringify(text)}`)
    else assert.equal(text, 'Draft')
  }
  for (const nativeState of [undefined, null, { imeVisible: true, noHardwareKeyboard: false }, { imeVisible: false, noHardwareKeyboard: true }, softState]) {
    await withPage({ enter: true }, async page => {
      await page.evaluate(nativeState => { window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = nativeState }, nativeState)
      await expectEnter(page, 'Enter', nativeState === softState ? { newlines: 1 } : { sends: 1 })
    })
  }
  // Without the App adapter a phone browser keeps Enter as the native newline:
  // stock submit (the fixture handler) never sees the keydown, and Chromium's
  // own beforeinput flow inserts the break — the same native path iOS Safari
  // takes, so the physical-device gate stays the WebKIt authority.
  await withPage({ enter: true }, async page => {
    assert.equal(await page.evaluate(() => window.matchMedia('(hover: none), (pointer: coarse)').matches), true,
      'mobile emulation must report a touch-primary pointer')
    await expectEnter(page, 'Enter', { nativeNewline: 1 })
  })
  // An empty draft keeps stock's no-op: Enter neither submits nor plants an
  // invisible line break that would lead the next typed message.
  await withPage({ enter: true }, async page => {
    await page.evaluate(() => {
      const editor = document.querySelector('#editor')
      editor.textContent = ''
      window.emptyEnters = 0
      editor.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); window.emptyEnters++ }
      })
    })
    await page.locator('#editor').focus()
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.emptyEnters), 1, 'stock must still see an empty-draft Enter')
    assert.equal(await page.locator('#editor').innerText(), '', 'empty-draft Enter must not insert a line break')
  })
  await withPage({ enter: true, touch: false, width: 980 }, async page => { await expectEnter(page, 'Enter', { sends: 1 }) })
  // Modified Enter keeps its stock path in browsers: Shift+Enter stays the
  // stock newline command, and Cmd/Ctrl+Enter keeps sending for keyboards
  // attached to touch-primary devices.
  for (const key of ['Shift+Enter', 'Control+Enter']) {
    await withPage({ enter: true }, async page => { await expectEnter(page, key, key === 'Shift+Enter' ? { newlines: 1 } : { sends: 1 }) })
  }
  // IME ownership and open menus consume Enter in browsers exactly as they do
  // through the App adapter.
  for (const safeguard of ['composition', 'recent-composition', 'menu', 'menu-marker']) {
    await withPage({ enter: true }, async page => {
      await expectEnter(page, 'Enter', safeguard.startsWith('menu') ? { menus: 1 } : { compositions: 1 }, safeguard)
    })
  }
  for (const key of ['Shift+Enter', 'Control+Enter', 'Alt+Enter', 'Meta+Enter']) {
    await withPage({ enter: true }, async page => {
      await page.evaluate(state => { window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = state }, softState)
      await expectEnter(page, key, key === 'Shift+Enter' ? { newlines: 1 } : { sends: 1 })
    })
  }
  for (const safeguard of ['composition', 'composition-marker', 'recent-composition', 'menu', 'menu-marker']) {
    await withPage({ enter: true }, async page => {
      await page.evaluate(state => { window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = state }, softState)
      // Install the fixture handler first, then arm the safeguard before Enter.
      await expectEnter(page, 'Enter', safeguard.startsWith('menu') ? { menus: 1 } : { compositions: 1 }, safeguard)
    })
  }
  await withPage({ enter: true }, async page => {
    await page.evaluate(state => {
      window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = state
      window.textareaSends = 0
      window.mode = 'no-consumption'
      document.querySelector('#send').addEventListener('click', () => { window.textareaSends++ })
      document.querySelector('#composer-area').addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); document.querySelector('#send').click() }
      })
    }, softState)
    await page.locator('#composer-area').fill('Area draft')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.textareaSends), 1)
    assert.equal(await page.locator('#composer-area').inputValue(), 'Area draft')
    await page.keyboard.press('Shift+Enter')
    assert.equal(await page.locator('#composer-area').inputValue(), 'Area draft\n')
    assert.equal(await page.evaluate(() => window.textareaSends), 1)
    await page.evaluate(() => {
      window.mode = 'immediate'
      const attachment = document.createElement('div')
      attachment.setAttribute('role', 'group')
      attachment.append(document.createElement('img'))
      document.querySelector('[data-slot="conversation.input.attachments"]').append(attachment)
    })
    await tap(page, '#send'); await frames(page)
    assert.equal(await page.locator('#composer-area').inputValue(), 'Area draft\n')
    assert.equal(await page.evaluate(() => window.collapses), 0)
    assert.equal(await focused(page), 'composer-area')
  })
  // A keyboard-sized layout viewport is what interactive-widget=resizes-content
  // produces. The full-height shell must keep its bottom-docked composer inside
  // that viewport instead of leaving it behind the IME.
  await withPage({ width: 393, height: 844 }, async page => {
    await page.evaluate(() => {
      document.body.style.margin = '0'
      document.body.innerHTML = '<main class="dshm-shell"><div class="dshm-main"><div class="dshm-mainContent"><div style="height:2000px"></div></div><section id="docked-composer" data-composer-card style="flex:none;height:140px">Draft</section></div></main>'
    })
    await mountStyles(page, 'shell')
    const composer = () => page.locator('#docked-composer').boundingBox()
    const bottom = box => box.y + box.height
    const portrait = await composer()
    assert(portrait !== null)
    assert(Math.abs(bottom(portrait) - 844) <= 1, `Composer did not start at the bottom: ${JSON.stringify(portrait)}`)
    await page.setViewportSize({ width: 393, height: 440 })
    await page.waitForFunction(() => window.innerHeight === 440)
    const keyboard = await composer()
    assert(keyboard !== null)
    assert(keyboard.y >= 0 && bottom(keyboard) <= 441, `Composer left the keyboard-sized viewport: ${JSON.stringify(keyboard)}`)
    assert.equal(Math.round(keyboard.height), Math.round(portrait.height))
    assert(Math.abs(bottom(keyboard) - 440) <= 1, 'Composer left the bottom edge after the viewport shrank')
    await page.setViewportSize({ width: 393, height: 844 })
    await page.waitForFunction(() => window.innerHeight === 844)
    const restored = await composer()
    assert(restored !== null)
    assert(Math.abs(bottom(restored) - 844) <= 1, 'Composer did not follow the restored viewport')
  })

  console.log(`Composer keyboard and editable-font smoke passed (${cases} browser cases).`)
} finally { await browser.close() }
