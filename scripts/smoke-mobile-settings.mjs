/** Mounted DSH General settings with local typography and a narrowly simulated native scale bridge. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { packBundle } from './packed-profile.mjs'
import { createMobileProfile, launchDsh, removeTemporaryRoot, openPairing, pairMobilePage,
  dismissOnboarding, openMobileSettings, CLIENT_TIMEOUT_MS, sanitized } from './mobile-boot-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined ? repository : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const prefix = 'dsh-mobile-settings-smoke-'
const root = await mkdtemp(join(tmpdir(), prefix))
const cases = []
let dsh
let browser
let failure
let tarballSha256

async function openSettings(page) {
  await openMobileSettings(page)
  await page.locator('[data-mobile-font-setting]').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
}

async function touchTarget(page, locator, description) {
  await locator.scrollIntoViewIfNeeded()
  const result = await locator.evaluate(node => {
    const box = node.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    const edgeHits = [box.x + 4, box.right - 4].every(x => {
      const edge = document.elementFromPoint(x, box.y + box.height / 2)
      return edge !== null && (edge === node || node.contains(edge))
    })
    return { width: box.width, height: box.height, left: box.left, right: box.right,
      viewport: innerWidth, hit: hit !== null && (hit === node || node.contains(hit)), edgeHits }
  })
  assert(result.height >= 48 && result.width >= 44, `${description}: small touch target ${JSON.stringify(result)}`)
  assert(result.left >= -1 && result.right <= result.viewport + 1 && result.hit, `${description}: clipped or blocked ${JSON.stringify(result)}`)
  assert(result.edgeHits, `${description}: touch target edges are blocked ${JSON.stringify(result)}`)
}

async function runCase({ width, height = 900, locale, bridgeMode }) {
  const context = await browser.newContext({ viewport: { width, height }, locale, isMobile: true,
    hasTouch: true, reducedMotion: 'reduce' })
  const errors = []
  const settingsWrites = []
  const settingsWire = []
  const wireReads = new Set()
  try {
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/.*settings.*mutate/u.test(new URL(request.url()).pathname)) settingsWrites.push(new URL(request.url()).pathname)
    })
    page.on('response', response => {
      const path = new URL(response.url()).pathname
      if (!/\/api\/.*settings.*mutate/u.test(path)) return
      const task = (async () => {
        const body = await response.json().catch(() => undefined)
        const value = body?.result ?? body
        const result = value !== null && typeof value === 'object' ? value : undefined
        settingsWire.push({ path, status: response.status(), ok: result?.ok,
          errorCode: result?.error?.code ?? result?.code,
          errorMessage: typeof result?.error?.message === 'string'
            ? sanitized(result.error.message).replaceAll(root, '<owned-profile>').slice(0, 240) : undefined,
          fields: result === undefined ? [] : Object.keys(result) })
      })().catch(() => { settingsWire.push({ path, status: response.status(), unavailable: true }) })
      wireReads.add(task)
      void task.finally(() => wireReads.delete(task))
    })
    await page.addInitScript(({ bridgeMode }) => {
      let moduleLoader
      Object.defineProperty(window, '__ModuleLoader__', {
        configurable: true,
        get: () => moduleLoader,
        set: value => {
          moduleLoader = value
          const create = value.create
          value.create = function (...args) {
            const modules = create.apply(this, args)
            window.__settingsModules = modules
            return modules
          }
        },
      })
      if (bridgeMode === 'browser') return
      const state = { percent: 100, calls: [], failNextSet: false }
      window.__settingsScaleFixture = state
      // Only this native operation is simulated; DSH, React, slots, local storage and pairing are real.
      window.__DSH_MOBILE_NATIVE__ = {
        capabilities: () => Promise.resolve(bridgeMode === 'old-app' ? ['files.pick'] : ['mobile.display-scale.get', 'mobile.display-scale.set']),
        invoke: async (action, input) => {
          if (!action.startsWith('mobile.display-scale.')) throw new Error('Unexpected native action')
          state.calls.push({ action, input })
          if (action === 'mobile.display-scale.set') {
            if (state.failNextSet) { state.failNextSet = false; throw new Error('Simulated native set failure') }
            if (!Number.isInteger(input?.percent) || input.percent < 80 || input.percent > 125) throw new Error('Invalid native scale')
            state.percent = input.percent
          }
          return { percent: state.percent, minPercent: 80, maxPercent: 125 }
        },
      }
    }, { bridgeMode })
    const pairUrl = await openPairing(desktop, undefined, dsh.logs)
    await pairMobilePage(page, pairUrl, dsh.logs, {
      beforeSubmit: async paired => { await paired.evaluate(() => { localStorage.setItem('dsh-mobile.content-font-size.v1', '20') }) },
    })
    await dismissOnboarding(page)
    await openSettings(page)
    const close = page.locator('[data-dsh-mobile-settings-header] button[class*="_close"]')
    await touchTarget(page, close, 'Settings close')
    const headerGeometry = await close.locator('..').evaluate(node => {
      const box = node.getBoundingClientRect()
      return { left: box.left, right: box.right, viewport: innerWidth }
    })
    assert(headerGeometry.left >= -1 && headerGeometry.right <= headerGeometry.viewport + 1, `Settings header clipped ${JSON.stringify(headerGeometry)}`)
    const gridGeometry = await close.evaluate(node => {
      const panel = node.closest('[data-dsh-mobile-settings="grid"]')
      if (panel === null) return null
      const children = [...panel.children]
      const seat = suffix => children.find(child => [...child.classList].some(token => token.endsWith(suffix)))
      const rect = element => {
        const box = element.getBoundingClientRect()
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
      }
      return { display: getComputedStyle(panel).display, panel: rect(panel), nav: rect(seat('_nav')),
        options: rect(seat('_options')), viewport: innerWidth }
    })
    if (gridGeometry !== null) {
      assert.equal(gridGeometry.display, 'grid', 'Mobile must retain the upstream four-seat settings grid')
      assert(gridGeometry.panel.left >= -1 && gridGeometry.panel.right <= gridGeometry.viewport + 1,
        `Settings grid clipped ${JSON.stringify(gridGeometry)}`)
      assert(gridGeometry.nav.bottom <= gridGeometry.options.top + 1 || gridGeometry.nav.right <= gridGeometry.options.left + 1,
        `Settings navigation overlaps its content ${JSON.stringify(gridGeometry)}`)
    }
    // First-run dismissal owns its own settings write; measure only the controls under test.
    settingsWrites.length = 0
    const row = page.locator('[data-mobile-font-setting]')
    await page.evaluate(async () => {
      const modules = window.__settingsModules
      const [react, reactDom, primitives] = await Promise.all([
        modules.import('react'), modules.import('react-dom/client'), modules.import('@deepseek-ai/dsh-client-ui-primitives'),
      ])
      const container = document.createElement('section')
      container.dataset.settingsFontProof = 'true'
      document.querySelector('[data-mobile-font-setting]').append(container)
      const root = reactDom.createRoot(container)
      root.render(react.createElement(primitives.MarkdownText, {
        text: 'Mobile typography preview.\n\n```js\nconst localFont = true;\n```',
        labels: { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' },
      }))
      window.__settingsMarkdownRoot = root
    })
    await page.locator('[data-settings-font-proof] pre code').waitFor({ state: 'visible' })
    const renderedFonts = () => page.locator('[data-settings-font-proof]').evaluate(node => {
      const paragraph = getComputedStyle(node.querySelector('p'))
      const code = getComputedStyle(node.querySelector('pre code'))
      return { textSize: paragraph.fontSize, textFamily: paragraph.fontFamily, codeSize: code.fontSize, codeFamily: code.fontFamily }
    })
    const typographySupport = await page.locator('[data-settings-font-proof]').evaluate(node => {
      // Check the mounted primitives rather than trusting the plugin's own capability flags.
      const style = document.body.style
      const inputs = ['--dsh-code-font-size', '--dsh-font-family-text', '--dsh-font-family-code']
      const previous = inputs.map(property => ({ property, value: style.getPropertyValue(property), priority: style.getPropertyPriority(property) }))
      try {
        style.setProperty(inputs[0], '23px')
        style.setProperty(inputs[1], '"Mounted Fixture Text"')
        style.setProperty(inputs[2], '"Mounted Fixture Code"')
        return {
          codeSize: getComputedStyle(node.querySelector('pre code')).fontSize === '23px',
          textFamily: getComputedStyle(node.querySelector('p')).fontFamily.includes('Mounted Fixture Text'),
          codeFamily: getComputedStyle(node.querySelector('pre code')).fontFamily.includes('Mounted Fixture Code'),
        }
      } finally {
        for (const { property, value, priority } of previous) {
          if (value === '') style.removeProperty(property)
          else style.setProperty(property, value, priority)
        }
      }
    })
    const text = row.locator('[data-mobile-font-role="text"]')
    assert.equal(await text.locator('output').textContent(), '20px', 'Legacy font size did not migrate on a real mounted page')
    const hasAdvanced = Object.values(typographySupport).some(Boolean)
    assert.equal(await row.locator('details').count(), hasAdvanced ? 1 : 0, 'Advanced options do not match real theme support')
    if (hasAdvanced) assert.equal(await row.locator('details').getAttribute('open'), null, 'Advanced typography should start collapsed')
    assert.equal(await row.locator('[data-mobile-font-limited]').count(), Object.values(typographySupport).every(Boolean) ? 0 : 1)
    assert.equal(await row.locator('[data-mobile-font-role="code"]').count(), typographySupport.codeSize ? 1 : 0)
    for (const role of ['text', 'code']) assert.equal(await row.locator(`[data-mobile-font-family="${role}"]`).count(), typographySupport[`${role}Family`] ? 1 : 0)
    await touchTarget(page, text.getByRole('button').first(), 'Text decrease')
    await text.getByRole('button').first().click()
    await page.waitForFunction(() => document.body.style.getPropertyValue('--dsh-content-font-size') === '19px')
    assert.equal((await renderedFonts()).textSize, '19px', 'Actual Markdown body did not consume the mobile text size')
    if (hasAdvanced) await row.locator('summary').click()
    for (const [role, initial] of typographySupport.codeSize ? [['code', 11]] : []) {
      const controls = row.locator(`[data-mobile-font-role="${role}"]`)
      assert.equal(await controls.locator('output').textContent(), `${initial}px`)
      await touchTarget(page, controls.getByRole('button').last(), `${role} increase`)
      await controls.getByRole('button').last().click()
      await page.waitForFunction(({ role, expected }) => document.body.style.getPropertyValue(`--dsh-${role}-font-size`) === expected,
        { role, expected: `${initial + 1}px` })
    }
    assert.equal((await renderedFonts()).codeSize, typographySupport.codeSize ? '12px' : '11px', 'Actual Markdown code block does not match supported settings')
    for (const role of ['text', 'code'].filter(role => typographySupport[`${role}Family`])) {
      const input = row.locator(`[data-mobile-font-family="${role}"]`)
      await touchTarget(page, input, `${role} font input`)
      await input.fill('Local Fixture Font, monospace')
      await input.evaluate(node => { node.blur() })
      await page.waitForFunction(role => document.body.style.getPropertyValue(`--dsh-font-family-${role}`) === '"Local Fixture Font", monospace', role)
    }
    const changedFonts = await renderedFonts()
    assert.equal(changedFonts.textFamily.includes('Local Fixture Font'), typographySupport.textFamily, 'Actual Markdown body does not match supported text family')
    assert.equal(changedFonts.codeFamily.includes('Local Fixture Font'), typographySupport.codeFamily, 'Actual Markdown code block does not match supported code family')
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-mobile.typography.v1')))
    assert.deepEqual(persisted.sizes, { text: 19, code: typographySupport.codeSize ? 12 : 11 })
    assert.equal(persisted.families.code, typographySupport.codeFamily ? '"Local Fixture Font", monospace' : '')
    const reset = row.locator('[data-mobile-font-reset]')
    await touchTarget(page, reset, 'Restore font defaults')
    await reset.click()
    await page.waitForFunction(() => document.body.style.getPropertyValue('--dsh-content-font-size') === '16px')
    if (typographySupport.codeSize) assert.equal(await page.evaluate(() => document.body.style.getPropertyValue('--dsh-code-font-size')), '11px')
    for (const role of ['text', 'code'].filter(role => typographySupport[`${role}Family`])) {
      await page.waitForFunction(role => document.querySelector(`[data-mobile-font-family="${role}"]`)?.value === '', role)
      assert.equal(await row.locator(`[data-mobile-font-family="${role}"]`).inputValue(), '')
    }
    const restoredFonts = await renderedFonts()
    assert.equal(restoredFonts.textSize, '16px')
    assert.equal(restoredFonts.codeSize, '11px')
    assert(!restoredFonts.textFamily.includes('Local Fixture Font') && !restoredFonts.codeFamily.includes('Local Fixture Font'))
    assert.equal(await page.evaluate(() => localStorage.getItem('dsh-mobile.content-font-size.v1')), '16')

    if (width === 375 && Object.values(typographySupport).every(Boolean)) {
      await row.locator('[data-mobile-font-role="code"]').getByRole('button').last().click()
      for (const role of ['text', 'code']) {
        const input = row.locator(`[data-mobile-font-family="${role}"]`)
        await input.fill('Retained Fixture Font')
        await input.evaluate(node => { node.blur() })
      }
      const beforeThemeChange = await page.evaluate(() => localStorage.getItem('dsh-mobile.typography.v1'))
      await page.evaluate(() => {
        window.__settingsThemeRetainedDocument = true
        const sheet = document.createElement('style')
        sheet.dataset.settingsFixedTypography = 'true'
        sheet.textContent = 'body { --dsw-font-markdown-code-block:11px/19px monospace; --dsw-font-markdown-base:var(--dsh-content-font-size,14px)/24px sans-serif; }'
        document.head.append(sheet)
      })
      await row.locator('details').waitFor({ state: 'hidden' })
      assert.equal(await page.evaluate(() => localStorage.getItem('dsh-mobile.typography.v1')), beforeThemeChange, 'Theme capability withdrawal erased saved preferences')
      await reset.click()
      assert.equal(await page.evaluate(() => localStorage.getItem('dsh-mobile.typography.v1')), beforeThemeChange, 'Reset erased hidden unsupported preferences')
      await page.evaluate(() => { document.querySelector('[data-settings-fixed-typography]').remove() })
      await row.locator('details').waitFor({ state: 'visible' })
      await row.locator('summary').click()
      assert.equal(await row.locator('[data-mobile-font-role="code"] output').textContent(), '12px', 'Supported theme did not resume retained code size')
      assert.equal((await renderedFonts()).codeSize, '12px')
      assert((await renderedFonts()).textFamily.includes('Retained Fixture Font') && (await renderedFonts()).codeFamily.includes('Retained Fixture Font'))
      assert.equal(await page.evaluate(() => window.__settingsThemeRetainedDocument), true, 'Theme capability update replaced the DSH document')
      await reset.click()
      await page.waitForFunction(() => document.body.style.getPropertyValue('--dsh-code-font-size') === '11px')
    }

    const scale = page.locator('[data-mobile-display-scale-setting]')
    if (bridgeMode !== 'scale-app') {
      assert.equal(await scale.count(), 0, `${bridgeMode} exposes an unsupported native scale control`)
      if (bridgeMode === 'old-app') assert.deepEqual(await page.evaluate(() => window.__settingsScaleFixture.calls), [])
    } else {
      await scale.locator('select').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
      await touchTarget(page, scale.locator('select'), 'Page scale selector')
      for (const percent of [80, 125]) {
        await scale.locator('select').selectOption(String(percent))
        await page.waitForFunction(percent => window.__settingsScaleFixture.percent === percent, percent)
        await scale.locator('select:not(:disabled)').waitFor()
        assert.equal(await scale.locator('select').inputValue(), String(percent))
      }
      const resetScale = scale.getByRole('button').last()
      await touchTarget(page, resetScale, 'Reset page scale')
      await resetScale.click()
      await page.waitForFunction(() => window.__settingsScaleFixture.percent === 100)
      await page.waitForFunction(() => document.querySelector('[data-mobile-display-scale-setting] select')?.value === '100')
      await page.evaluate(() => { window.__settingsScaleFixture.failNextSet = true })
      await scale.locator('select').selectOption('80')
      await scale.getByRole('button').last().waitFor({ state: 'visible' })
      await page.waitForFunction(() => document.querySelector('[data-mobile-display-scale-setting] select:not(:disabled)')?.value === '100')
      assert.equal(await page.evaluate(() => window.__settingsScaleFixture.percent), 100)
      await scale.getByRole('button').last().click()
      await page.waitForFunction(() => document.querySelector('[data-mobile-display-scale-setting] select:not(:disabled)')?.value === '100'
        && document.querySelector('[data-mobile-display-scale-setting] button')?.disabled === true)
    }
    const geometry = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth,
      language: document.documentElement.lang, fontRowLanguage: document.querySelector('[data-mobile-font-setting]')?.getAttribute('lang') }))
    const expectedLanguage = locale.startsWith('zh') ? 'zh' : 'en'
    assert.equal(geometry.language.toLowerCase().split(/[-_]/u)[0], expectedLanguage, 'Stored Host language displaced the browser-derived settings matrix')
    assert.equal(geometry.fontRowLanguage, expectedLanguage, 'Mobile settings did not follow the active DSH language')
    assert(geometry.body <= geometry.viewport + 1 && geometry.root <= geometry.viewport + 1, `Settings overflow ${JSON.stringify(geometry)}`)
    assert.equal(settingsWrites.length, 0, `Local settings wrote Host preferences: ${settingsWrites.join(', ')}`)
    assert.deepEqual(errors, [], 'Settings generated unhandled page errors')
    await page.evaluate(() => { window.__settingsMarkdownRoot.unmount() })
    await page.evaluate(() => { window.__settingsRetainedDocument = 'retain settings navigation' })
    assert.equal(await page.evaluate(() => {
      const event = new Event('dsh-mobile:native-back', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    }), true, 'Native Back did not claim General settings')
    await row.waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.__settingsRetainedDocument), 'retain settings navigation', 'Native Back replaced the DSH document')
    await openSettings(page)
    await close.click()
    await row.waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.__settingsRetainedDocument), 'retain settings navigation', 'Closing settings replaced the DSH document')
    await page.locator('.dshm-main').waitFor({ state: 'visible' })
    cases.push({ width, height, locale, bridgeMode, expectedLanguage, language: geometry.fontRowLanguage, typographySupport })
  } catch (error) {
    await Promise.allSettled(wireReads)
    const httpEvents = dsh.logs().split(/\r?\n/u).filter(line => /http failure|auth failure/u.test(line)).slice(-12)
    console.error('SETTINGS_SMOKE_FAILURE_CONTEXT', JSON.stringify({ width, height, locale, bridgeMode, settingsWire: settingsWire.slice(-20), httpEvents }))
    throw error
  } finally { await context.close() }
}

async function runLanguageCase() {
  const context = await browser.newContext({ locale: 'zh-HK', extraHTTPHeaders: { 'Accept-Language': 'zh-HK,en;q=0.8' } })
  const fresh = await browser.newContext({ locale: 'zh-HK' })
  const blocked = await browser.newContext({ locale: 'zh-HK' })
  try {
    const page = await context.newPage()
    const pairUrl = await openPairing(desktop, undefined, dsh.logs)
    await pairMobilePage(page, pairUrl, dsh.logs)
    await dismissOnboarding(page)
    const origin = new URL(page.url()).origin
    const selectLanguage = async (label, language) => {
      if (!await page.locator('[data-mobile-font-setting]').isVisible()) await openSettings(page)
      await page.getByRole('button', { name: /^(English|中文)$/u }).click()
      await page.getByRole('menuitem', { name: label, exact: true }).click()
      await page.waitForFunction(language => document.documentElement.lang === language, language)
      const expectedLocale = language === 'zh-CN' ? 'zh' : language
      const cookieDeadline = Date.now() + CLIENT_TIMEOUT_MS
      let cookie
      // DOM language and the browser-process Cookie store have separate commits.
      // Observe the latter before testing its fields or opening the login page.
      do {
        cookie = (await context.cookies(`${origin}/mobile-access/login`)).find(value => value.name === 'dsh_ma_ui_locale')
        if (cookie?.value === expectedLocale) break
        await new Promise(resolve => setTimeout(resolve, 20))
      } while (Date.now() < cookieDeadline)
      assert(cookie, 'DSH language was not remembered in the browser')
      assert.equal(cookie.value, expectedLocale, 'Remembered language did not settle in the browser Cookie store')
      assert.equal(cookie.path, '/mobile-access')
      assert.equal(cookie.domain, new URL(origin).hostname, 'Preference must be host-only')
      assert.equal(cookie.secure, new URL(origin).protocol === 'https:')
      assert.equal(cookie.httpOnly, false)
      assert.equal(cookie.sameSite, 'Lax')
      assert(cookie.expires > Date.now() / 1000 + 3600 * 24 * 300, 'Preference must outlive the short session')
    }
    await selectLanguage('English', 'en')
    const sessions = ['dsh_ma_session', '__Host-dsh_ma_session', 'dsh_ma_csrf', '__Host-dsh_ma_csrf']
    const retained = (await context.cookies()).filter(cookie => !sessions.includes(cookie.name))
    await context.clearCookies({ name: /^(?:__Host-)?dsh_ma_(?:session|csrf)$/u })
    assert(retained.some(cookie => cookie.name === 'dsh_ma_ui_locale'))
    assert((await context.cookies()).some(cookie => cookie.name === 'dsh_ma_ui_locale'), 'Session expiry erased UI preference')
    const login = await context.newPage()
    // Hold the real renewal request so the server-rendered initial language can be observed.
    let failRenew
    const held = new Promise(resolve => { failRenew = resolve })
    await login.route('**/mobile-access/auth/renew', async route => { await held; await route.abort('failed') })
    await login.goto(`${origin}/mobile-access/login`, { waitUntil: 'domcontentloaded' })
    assert.equal(await login.locator('h1').textContent(), 'Reconnect this device')
    assert.equal(await login.locator('#login-progress').textContent(), 'Restoring the secure Session…')
    failRenew()
    await login.getByText('The computer is unavailable. Check the connection and try again.', { exact: true }).waitFor()
    // A rejected renewal exposes the genuine pairing link, whose destination shares the preference.
    await login.unroute('**/mobile-access/auth/renew')
    await login.route('**/mobile-access/auth/renew', route => route.fulfill({ status: 401, body: '{}' }))
    await login.reload()
    await login.locator('#login-failed:not([hidden])').waitFor()
    await openPairing(desktop, undefined, dsh.logs)
    await login.getByRole('link', { name: 'Open pairing', exact: true }).click()
    assert.equal(await login.locator('h1').textContent(), 'Pair this device')
    const renewed = await context.request.post(`${origin}/mobile-access/auth/renew`, { data: {}, headers: { origin } })
    assert(renewed.ok(), 'Owned fixture could not renew the retained device session')
    await page.locator('[data-dsh-mobile-settings-header] button[class*="_close"]').click()
    // The original authenticated document can still update its display preference without a reload.
    await selectLanguage('中文', 'zh-CN')
    const chinese = await context.request.get(`${origin}/mobile-access/login`)
    assert((await chinese.text()).includes('重新连接此设备'))
    await selectLanguage('English', 'en')
    const freshPage = await fresh.newPage()
    await freshPage.route('**/mobile-access/auth/renew', route => route.abort('failed'))
    await freshPage.goto(`${origin}/mobile-access/login`)
    assert.equal(await freshPage.locator('h1').textContent(), '重新连接此设备', 'Fresh context must retain browser negotiation')
    await blocked.addInitScript(() => {
      const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
      Object.defineProperty(Document.prototype, 'cookie', { ...descriptor,
        set(value) { if (!value.startsWith('dsh_ma_ui_locale=')) descriptor.set.call(this, value) },
      })
    })
    const blockedPage = await blocked.newPage()
    await pairMobilePage(blockedPage, await openPairing(desktop, undefined, dsh.logs), dsh.logs)
    await dismissOnboarding(blockedPage)
    await blockedPage.locator('.dshm-main').waitFor({ state: 'visible' })
    await blockedPage.waitForFunction(() => document.documentElement.lang === 'en')
    assert(!(await blocked.cookies()).some(cookie => cookie.name === 'dsh_ma_ui_locale'))
    await blockedPage.route('**/mobile-access/auth/renew', route => route.abort('failed'))
    await blockedPage.goto(`${origin}/mobile-access/login`)
    assert.equal(await blockedPage.locator('h1').textContent(), '重新连接此设备', 'Blocked persistence must retain browser fallback')
    cases.push({ language: 'DSH EN/中文 selection, session expiry, reconnect initial/error text, pairing destination, fresh/blocked contexts' })
  } finally {
    await context.close()
    await fresh.close()
    await blocked.close()
  }
}

let desktop
try {
  const suppliedTarball = process.env.DSH_SETTINGS_SMOKE_TARBALL ?? process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL
  const tarball = suppliedTarball === undefined ? await packBundle(mobileRoot, root) : resolve(suppliedTarball)
  tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  const home = await createMobileProfile(root, { tarball, dshBin, packageStoreDirectory: join(root, 'package-store') })
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  desktop = await browser.newPage({ locale: 'en-US' })
  await openPairing(desktop, await dsh.ready(), dsh.logs)
  for (const width of [320, 288]) {
    for (const [locale, bridgeMode] of [['en-US', 'browser'], ['zh-CN', 'old-app'], ['it-IT', 'scale-app']]) await runCase({ width, locale, bridgeMode })
  }
  await runCase({ width: 375, height: 812, locale: 'en-US', bridgeMode: 'browser' })
  await runCase({ width: 844, height: 393, locale: 'zh-CN', bridgeMode: 'scale-app' })
  // Explicit language selection persists on the fixture Host, unlike browser-derived preferences above.
  await runLanguageCase()
  console.log(JSON.stringify({ passed: cases.length, tarballSha256, cases, nativeScaleBridge: 'simulated; actual Android viewport reflow is device-tested separately',
    typography: 'real mounted React/DSH settings, local storage migration, role writes, reset, touch targets and no Host writes' }))
} catch (error) {
  failure = error
  throw error
} finally {
  await browser?.close()
  const stopped = await dsh?.close()
  await removeTemporaryRoot(root, prefix)
  if (failure === undefined && stopped?.forced) throw new Error('DSH settings fixture needed forced termination')
}
