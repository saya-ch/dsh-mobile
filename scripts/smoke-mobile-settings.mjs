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
  dismissOnboarding, CLIENT_TIMEOUT_MS, sanitized } from './mobile-boot-fixture.mjs'

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
  const drawer = page.locator('.dshm-drawer')
  if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  await drawer.locator('button:has([data-slot="settings.trigger"])').click()
  await page.locator('[data-mobile-font-setting]').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
}

async function touchTarget(page, locator, description) {
  await locator.scrollIntoViewIfNeeded()
  const result = await locator.evaluate(node => {
    const box = node.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return { width: box.width, height: box.height, left: box.left, right: box.right,
      viewport: innerWidth, hit: hit !== null && (hit === node || node.contains(hit)) }
  })
  assert(result.height >= 48 && result.width >= 44, `${description}: small touch target ${JSON.stringify(result)}`)
  assert(result.left >= -1 && result.right <= result.viewport + 1 && result.hit, `${description}: clipped or blocked ${JSON.stringify(result)}`)
}

async function runCase({ width, locale, bridgeMode }) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale, isMobile: true,
    hasTouch: true, reducedMotion: 'reduce' })
  const errors = []
  const settingsWrites = []
  try {
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/.*settings.*mutate/u.test(new URL(request.url()).pathname)) settingsWrites.push(new URL(request.url()).pathname)
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
    const text = row.locator('[data-mobile-font-role="text"]')
    assert.equal(await text.locator('output').textContent(), '20px', 'Legacy font size did not migrate on a real mounted page')
    assert.equal(await row.locator('details').getAttribute('open'), null, 'Advanced typography should start collapsed')
    await touchTarget(page, text.getByRole('button').first(), 'Text decrease')
    await text.getByRole('button').first().click()
    await page.waitForFunction(() => document.body.style.getPropertyValue('--dsh-content-font-size') === '19px')
    assert.equal((await renderedFonts()).textSize, '19px', 'Actual Markdown body did not consume the mobile text size')
    await row.locator('summary').click()
    for (const [role, initial] of [['code', 11]]) {
      const controls = row.locator(`[data-mobile-font-role="${role}"]`)
      assert.equal(await controls.locator('output').textContent(), `${initial}px`)
      await touchTarget(page, controls.getByRole('button').last(), `${role} increase`)
      await controls.getByRole('button').last().click()
      await page.waitForFunction(({ role, expected }) => document.body.style.getPropertyValue(`--dsh-${role}-font-size`) === expected,
        { role, expected: `${initial + 1}px` })
    }
    assert.equal((await renderedFonts()).codeSize, '12px', 'Actual Markdown code block did not consume the mobile code size')
    for (const role of ['text', 'code']) {
      const input = row.locator(`[data-mobile-font-family="${role}"]`)
      await touchTarget(page, input, `${role} font input`)
      await input.fill('Local Fixture Font, monospace')
      await input.evaluate(node => { node.blur() })
      await page.waitForFunction(role => document.body.style.getPropertyValue(`--dsh-font-family-${role}`) === '"Local Fixture Font", monospace', role)
    }
    const changedFonts = await renderedFonts()
    assert(changedFonts.textFamily.includes('Local Fixture Font'), 'Actual Markdown body did not consume the mobile text family')
    assert(changedFonts.codeFamily.includes('Local Fixture Font'), 'Actual Markdown code block did not consume the mobile code family')
    const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('dsh-mobile.typography.v1')))
    assert.deepEqual(persisted.sizes, { text: 19, code: 12 })
    assert.equal(persisted.families.code, '"Local Fixture Font", monospace')
    const reset = row.locator('details').getByRole('button').last()
    await touchTarget(page, reset, 'Restore font defaults')
    await reset.click()
    await page.waitForFunction(() => document.body.style.getPropertyValue('--dsh-content-font-size') === '16px'
      && document.body.style.getPropertyValue('--dsh-code-font-size') === '11px'
      && document.body.style.getPropertyValue('--dsh-font-family-text') === '')
    await page.waitForFunction(() => document.querySelector('[data-mobile-font-family="code"]')?.value === '')
    assert.equal(await row.locator('[data-mobile-font-family="code"]').inputValue(), '')
    const restoredFonts = await renderedFonts()
    assert.equal(restoredFonts.textSize, '16px')
    assert.equal(restoredFonts.codeSize, '11px')
    assert(!restoredFonts.textFamily.includes('Local Fixture Font') && !restoredFonts.codeFamily.includes('Local Fixture Font'))
    assert.equal(await page.evaluate(() => localStorage.getItem('dsh-mobile.content-font-size.v1')), '16')

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
    assert(geometry.body <= geometry.viewport + 1 && geometry.root <= geometry.viewport + 1, `Settings overflow ${JSON.stringify(geometry)}`)
    assert.equal(settingsWrites.length, 0, `Local settings wrote Host preferences: ${settingsWrites.join(', ')}`)
    assert.deepEqual(errors, [], 'Settings generated unhandled page errors')
    await page.evaluate(() => { window.__settingsMarkdownRoot.unmount() })
    cases.push({ width, locale, bridgeMode, language: geometry.fontRowLanguage })
  } finally { await context.close() }
}

let desktop
try {
  const tarball = process.env.DSH_SETTINGS_SMOKE_TARBALL === undefined ? await packBundle(mobileRoot, root) : resolve(process.env.DSH_SETTINGS_SMOKE_TARBALL)
  tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  const home = await createMobileProfile(root, { tarball, dshBin })
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  desktop = await browser.newPage({ locale: 'en-US' })
  await openPairing(desktop, await dsh.ready(), dsh.logs)
  for (const width of [320, 288]) {
    for (const [locale, bridgeMode] of [['en-US', 'browser'], ['zh-CN', 'old-app'], ['en-US', 'scale-app']]) await runCase({ width, locale, bridgeMode })
  }
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
