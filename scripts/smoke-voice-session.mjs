import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const client = await readFile(resolve(mobileRoot, 'lib/client.js'), 'utf8')
const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
  <main><section data-composer-card id="card-first"><div id="editor-first" data-composer-input contenteditable="true">First draft</div><div id="voice-first" data-voice-activity="idle"></div></section>
  <section data-composer-card id="card-second"><div id="editor-second" data-composer-input contenteditable="true">Second draft</div><div id="voice-second" data-voice-activity="idle"></div></section>
  <input id="settings-field" value="Unrelated settings"><div id="noise"></div></main></body></html>`

// Wake Lock requests are controlled test promises. This verifies browser focus
// and resource ownership; physical Android screen/IME behavior remains a device check.
const browser = await chromium.launch({ headless: true })
let cases = 0
try {
  const withClient = async (options, run) => {
    const context = await browser.newContext({
      viewport: { width: options.touch === false ? 980 : 393, height: 844 },
      hasTouch: options.touch !== false,
      isMobile: options.touch !== false,
      reducedMotion: 'reduce',
    })
    try {
      const page = await context.newPage()
      await page.route('**/*', route => route.fulfill({
        status: route.request().resourceType() === 'document' ? 200 : 404,
        contentType: 'text/html', body: route.request().resourceType() === 'document' ? fixture : '',
      }))
      await page.goto(options.admin === true ? 'https://127.0.0.1/' : 'https://voice-session.test/')
      await page.evaluate(options => {
        window.wakeRequests = []
        window.wakeLocks = []
        window.fixtureHidden = false
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.fixtureHidden })
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.fixtureHidden ? 'hidden' : 'visible' })
        const createLock = () => {
          const lock = new EventTarget()
          lock.released = false
          lock.releaseCalls = 0
          lock.release = async () => {
            lock.releaseCalls++
            if (!lock.released) {
              lock.released = true
              lock.dispatchEvent(new Event('release'))
            }
          }
          window.wakeLocks.push(lock)
          return lock
        }
        Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: options.api === false ? undefined : {
          request: type => new Promise((resolveRequest, rejectRequest) => {
            if (type !== 'screen') throw new Error(`Unexpected Wake Lock type: ${type}`)
            window.wakeRequests.push({
              resolve: () => { resolveRequest(createLock()) },
              resolveReleased: () => { const lock = createLock(); void lock.release(); resolveRequest(lock) },
              reject: () => { rejectRequest(new DOMException('Denied by test', 'NotAllowedError')) },
            })
          }),
        } })
        if (options.native === true) {
          window.__DSH_MOBILE_NATIVE__ = { capabilities: () => [], invoke: async () => undefined }
          if (options.keyboard !== null) window.__DSH_MOBILE_KEYBOARD_STATE__ = options.keyboard
        }
        window.__ModuleLoader__ = { load: ({ factory }) => { window.mobileClient = factory(name => {
          if (name === 'react') return {}
          throw new Error(`Unexpected browser dependency: ${name}`)
        }) } }
        window.mountClient = () => {
          const disposers = []
          window.mobileClient.apply({
            effect: effect => { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) },
            get: () => undefined,
            slots: { inject: () => () => {}, register: () => () => {} },
          })
          window.disposeClient = () => { while (disposers.length > 0) disposers.pop()() }
        }
      }, options)
      await page.addScriptTag({ content: client })
      await page.evaluate(() => { window.mountClient() })
      const flush = () => page.evaluate(() => new Promise(resolveFlush => { setTimeout(resolveFlush, 0) }))
      const phase = async (value, row = 'first') => {
        await page.locator(`#voice-${row}`).evaluate((node, next) => { node.setAttribute('data-voice-activity', next) }, value)
        await flush()
      }
      const focus = selector => page.locator(selector).evaluate(node => { node.focus() })
      const focused = () => page.evaluate(() => document.activeElement?.id ?? '')
      const state = () => page.evaluate(() => ({
        requests: window.wakeRequests.length,
        locks: window.wakeLocks.map(lock => ({ released: lock.released, releases: lock.releaseCalls })),
      }))
      const noise = async () => {
        for (let index = 0; index < 3; index++) {
          await page.locator('#noise').evaluate(node => { node.append(document.createElement('span')) })
          await flush()
        }
      }
      const resolveRequest = async (index = 0) => {
        await page.evaluate(index => { window.wakeRequests[index].resolve() }, index)
        await flush()
      }
      const visibility = async hidden => {
        await page.evaluate(hidden => {
          window.fixtureHidden = hidden
          document.dispatchEvent(new Event('visibilitychange'))
        }, hidden)
        await flush()
      }
      const dispose = async () => { await page.evaluate(() => { window.disposeClient() }); await flush() }
      await run({ page, phase, focus, focused, state, flush, noise, resolveRequest, visibility, dispose })
      await dispose()
      cases++
    } finally { await context.close() }
  }
  const native = { native: true, keyboard: { imeVisible: false, noHardwareKeyboard: true } }

  await withClient(native, async ({ phase, focus, focused, state, noise, resolveRequest }) => {
    await focus('#editor-first')
    await phase('requesting')
    assert.notEqual(await focused(), 'editor-first', 'Native composer retained focus while requesting microphone access')
    await noise()
    await phase('recording')
    await phase('transcribing')
    assert.equal((await state()).requests, 1, 'DOM changes or active phases duplicated a pending screen request')
    await resolveRequest()
    await noise()
    assert.equal((await state()).requests, 1, 'Held screen lock was requested again')
    await phase('feedback')
    assert.deepEqual((await state()).locks, [{ released: true, releases: 1 }], 'Finished dictation retained a screen lock')
  })

  for (const ending of ['feedback', 'idle', 'unrecognized-phase']) {
    await withClient(native, async ({ phase, resolveRequest, state }) => {
      await phase('recording')
      await phase(ending)
      await resolveRequest()
      assert.deepEqual((await state()).locks, [{ released: true, releases: 1 }], `${ending} did not release a late screen lock`)
    })
  }
  await withClient(native, async ({ phase, resolveRequest, dispose, state, noise }) => {
    await phase('recording')
    await dispose()
    await resolveRequest()
    await noise()
    assert.deepEqual((await state()).locks, [{ released: true, releases: 1 }], 'Plugin unload retained a late screen lock')
    assert.equal((await state()).requests, 1, 'Disposed plugin still requested a screen lock')
  })
  await withClient(native, async ({ page, phase, resolveRequest, state, flush }) => {
    await phase('recording')
    await page.locator('#voice-first').evaluate(node => { node.remove() })
    await flush()
    await resolveRequest()
    assert.deepEqual((await state()).locks, [{ released: true, releases: 1 }], 'Removed voice row retained a late screen lock')
  })
  await withClient(native, async ({ phase, visibility, resolveRequest, state }) => {
    await phase('recording')
    await visibility(true)
    await resolveRequest()
    assert.deepEqual((await state()).locks, [{ released: true, releases: 1 }], 'Hidden page retained a late screen lock')
    await visibility(false)
    assert.equal((await state()).requests, 2, 'Visible dictation did not request a fresh screen lock')
    await resolveRequest(1)
    await phase('idle')
    assert.equal((await state()).locks.every(lock => lock.released), true, 'Visibility recovery leaked a screen lock')
  })
  await withClient(native, async ({ page, phase, resolveRequest, visibility, state, flush }) => {
    await phase('recording')
    await resolveRequest()
    await page.evaluate(() => { void window.wakeLocks[0].release() })
    await flush()
    await visibility(true)
    await visibility(false)
    assert.equal((await state()).requests, 2, 'Browser-released sentinel blocked visibility recovery')
    await resolveRequest(1)
    await phase('idle')
    assert.equal((await state()).locks.every(lock => lock.released), true)
  })
  await withClient(native, async ({ page, phase, visibility, state, flush, resolveRequest }) => {
    await phase('recording')
    await page.evaluate(() => { window.wakeRequests[0].resolveReleased() })
    await flush()
    await visibility(true)
    await visibility(false)
    assert.equal((await state()).requests, 2, 'Already-released result blocked a later visibility request')
    await resolveRequest(1)
    await phase('idle')
    assert.equal((await state()).locks.every(lock => lock.released), true)
  })
  await withClient(native, async ({ page, phase, state, noise, flush, visibility, resolveRequest }) => {
    await phase('recording')
    await page.evaluate(() => { window.wakeRequests[0].reject() })
    await flush()
    await noise()
    await phase('transcribing')
    assert.equal((await state()).requests, 1, 'Denied request retried on unrelated DOM or active phase changes')
    await visibility(true)
    await visibility(false)
    assert.equal((await state()).requests, 2, 'Visibility recovery could not retry a denied request')
    await resolveRequest(1)
    await phase('idle')
  })
  await withClient(native, async ({ phase, resolveRequest, state }) => {
    await phase('recording')
    await phase('idle')
    await phase('recording')
    await resolveRequest()
    const afterOld = await state()
    assert.equal(afterOld.locks[0].released, true, 'Previous dictation request was adopted by a later recording')
    assert.equal(afterOld.requests, 2, 'Later dictation did not get its own screen request after the old one settled')
    await resolveRequest(1)
    await phase('idle')
    assert.equal((await state()).locks.every(lock => lock.released), true)
  })

  for (const options of [{ ...native, api: false }, { api: false, native: false }, { native: false }]) {
    await withClient(options, async ({ focus, focused, phase, state }) => {
      await focus('#editor-first')
      await phase('recording')
      assert.notEqual(await focused(), 'editor-first', 'Optional Wake Lock support disabled touch composer keyboard dismissal')
      assert.equal((await state()).requests, options.api === false ? 0 : 1)
    })
  }
  for (const options of [
    { native: true, keyboard: null },
    { native: true, keyboard: { imeVisible: true, noHardwareKeyboard: false } },
    { native: false, touch: false },
    { ...native, admin: true },
  ]) {
    await withClient(options, async ({ focus, focused, phase }) => {
      await focus('#editor-first')
      await phase('recording')
      assert.equal(await focused(), 'editor-first', 'Desktop or unconfirmed soft-keyboard focus was removed')
    })
  }
  for (const selector of ['#settings-field', '#editor-second']) {
    await withClient(native, async ({ focus, focused, phase }) => {
      await focus(selector)
      await phase('recording')
      assert.equal(await focused(), selector.slice(1), 'Dictation removed focus outside its composer')
    })
  }
  await withClient(native, async ({ focus, focused, phase, state }) => {
    await focus('#editor-second')
    await phase('recording', 'second')
    assert.notEqual(await focused(), 'editor-second', 'An earlier idle voice row hid the active composer')
    assert.equal((await state()).requests, 1, 'An earlier idle voice row hid active dictation')
  })
  await withClient(native, async ({ focus, focused, phase }) => {
    await phase('recording')
    await focus('#editor-first')
    await phase('transcribing')
    assert.equal(await focused(), 'editor-first', 'Active phase changes prevented deliberate composer focus')
  })
  for (const replacement of [false, true]) {
    await withClient(native, async ({ page }) => {
      await page.evaluate(replacement => {
        window.queuedNativeCalls = []
        window.__DSH_MOBILE_NATIVE__ = { capabilities: () => [], invoke: async action => { window.queuedNativeCalls.push(action); return { ok: true } } }
        window.dshMobile.define({ apiVersion: 1, id: 'queued-native-owner', activate(api) {
          const call = api.native.invoke('clipboard.write', { text: 'must not reach native' })
          window.queuedNativeResult = call.then(() => 'resolved', error => error.name)
          if (replacement) window.__DSH_MOBILE_NATIVE__ = { capabilities: () => [], invoke: async action => { window.queuedNativeCalls.push('replacement:' + action); return { ok: true } } }
          else window.disposeClient()
        } })
      }, replacement)
      await page.waitForFunction(() => window.queuedNativeResult !== undefined)
      assert.equal(await page.evaluate(() => window.queuedNativeResult), 'AbortError', 'Disposed/replaced native call was not cancelled')
      assert.deepEqual(await page.evaluate(() => window.queuedNativeCalls), [], 'Cancelled queued SDK call still started a native side effect')
    })
  }
  console.log(`Voice-session browser smoke passed (${cases} cases; Wake Lock API simulated).`)
} finally { await browser.close() }
