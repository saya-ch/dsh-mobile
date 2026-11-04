/**
 * Verify that the three fixed mobile chrome surfaces stay opaque in a real
 * browser when a skin makes the theme tokens translucent, transparent or
 * invalid.
 *
 * This is the regression for PR #286 (f533df4). The navigation drawer, the
 * right detail panel and the panel return bar paint above the conversation, so
 * a translucent `--dsw-alias-bg-layer-1` / `--dsw-alias-bg-base` used to let
 * conversation text show through the sidebar labels; an unresolvable token is
 * invalid at computed-value time and dropped the surface entirely. The fix
 * composites the skin tint over the CSS `Canvas` system color.
 *
 * The script drives the built stylesheet from `lib/mobile-layout.js` and reads
 * real computed styles in Chromium, so it fails on the reported defect instead
 * of on a source string. Every case prints the actual computed
 * `backgroundColor` so the evidence can be quoted in review.
 *
 * Scope: built stylesheet plus an owned DOM fixture. Not a full DSH runtime, a
 * real skin package, or a physical device.
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url))
  : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const stylesheetPath = resolve(mobileRoot, 'lib/mobile-layout.js')
let client
try {
  client = await readFile(stylesheetPath, 'utf8')
} catch (error) {
  throw new Error(`Cannot read the built layout stylesheet at ${stylesheetPath}; run npm run build first (${error.code ?? error.message})`)
}

const VIEWPORTS = Object.freeze({
  // Below the 900px breakpoint the drawer is a fixed overlay.
  portrait: { width: 390, height: 844 },
  // At and above it the drawer becomes a real grid column.
  landscape: { width: 1024, height: 768 },
})

const COLOR_SCHEMES = Object.freeze(['light', 'dark'])

/**
 * Token values that made the chrome translucent before #286.
 *
 * `gradientAlpha` is the alpha the first gradient stop must report once the
 * token is set. It is the self-check that the token actually reached the
 * stylesheet: without it a fixture that silently failed to apply the custom
 * property would still read an opaque `backgroundColor` and pass for the wrong
 * reason. `invalid` is unresolvable at computed-value time, so Chromium drops
 * the whole gradient and only the Canvas base is left.
 */
const TOKEN_VALUES = Object.freeze([
  { label: 'translucent', value: 'rgba(255, 255, 255, 0.34)', gradientAlpha: 0.34 },
  { label: 'transparent', value: 'transparent', gradientAlpha: 0 },
  { label: 'invalid', value: 'nonsense', gradientAlpha: null },
])

const SURFACES = Object.freeze([
  // The drawer and the details panel composite --dsw-alias-bg-layer-1.
  { selector: '.dshm-drawer', token: '--dsw-alias-bg-layer-1', state: 'drawer', label: 'drawer' },
  { selector: '.dshm-details', token: '--dsw-alias-bg-layer-1', state: 'details', label: 'details' },
  // The return bar composites --dsw-alias-bg-base.
  { selector: '.dshm-panelNav', token: '--dsw-alias-bg-base', state: 'collapsed', label: 'panelNav' },
])

/**
 * The three surfaces are handwritten because the real shell renders the return
 * bar only while a panel is active on a narrow viewport. Keeping them in the
 * fixture lets one page cover both breakpoints without driving the controller.
 */
// `data-dshm-wide` is the layout's own wide/narrow decision, which the stylesheet
// follows instead of a media query; this static fixture states it per viewport.
const fixture = wide => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<div id="root"><div data-slot="root"><div class="dshm-shell" data-dshm-wide="${wide ? '1' : '0'}">
  <main class="dshm-main" data-pane="conversation">
    <div class="dshm-panelNav">
      <button class="dshm-panelBack" type="button" aria-label="Back to conversation"><span>Owned back action</span></button>
    </div>
    <div class="dshm-mainContent"><div data-slot="main"><div data-slot="main.conversation">
      <div id="conversation-content">Owned conversation content that must never show through the chrome</div>
    </div></div></div>
  </main>
  <aside class="dshm-drawer" data-pane="sidebar" data-open="true">
    <div id="sidebar-root"><button id="sidebar-action" type="button">Owned sidebar action</button></div>
  </aside>
  <aside class="dshm-details" data-open="false" inert>
    <div id="details-root">Owned details content</div>
  </aside>
</div></div></div>
</body></html>`

function pad(value, width) {
  return String(value).padEnd(width)
}

/**
 * Read the alpha channel from a computed CSS color. Chromium serialises the
 * `Canvas` system color as `rgb(...)` and a dropped declaration as
 * `rgba(0, 0, 0, 0)`, so those two shapes are the ones that must parse.
 * @param {string} text Computed color value.
 * @returns {{alpha: number} | null} Parsed alpha, or null when unparseable.
 */
function parseComputedColor(text) {
  const value = text.trim().toLowerCase()
  if (value === 'transparent') return { alpha: 0 }
  const match = /^rgba?\((.*)\)$/u.exec(value)
  if (match === null) return null
  const [channels, alphaText] = match[1].split('/').map(part => part.trim())
  if (alphaText !== undefined) return { alpha: percentOrNumber(alphaText) }
  const parts = channels.split(/[\s,]+/u).filter(Boolean)
  if (parts.length === 3) return { alpha: 1 }
  if (parts.length === 4) return { alpha: percentOrNumber(parts[3]) }
  return null
}

function percentOrNumber(text) {
  const parsed = text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

/** First color stop of a computed gradient, or null when there is no gradient. */
function firstGradientColor(image) {
  const value = image.trim()
  if (value === 'none') return null
  const gradient = /^(?:repeating-)?(?:linear|radial|conic)-gradient\((.*)\)$/u.exec(value)
  if (gradient === null) return null
  const stop = /rgba?\([^()]*\)|transparent|#[0-9a-f]{3,8}/iu.exec(gradient[1])
  return stop === null ? null : stop[0]
}

/**
 * Alpha of the painted stack: the theme gradient composited over the Canvas
 * base. This is the number that decides whether conversation text bleeds
 * through, and it catches a removed `background-color:Canvas` even when the
 * gradient itself still parses.
 * @param {{backgroundColor: string, backgroundImage: string}} observed Computed styles.
 * @returns {number | null} Composited alpha, or null when a value is unparseable.
 */
function compositedAlpha(observed) {
  const base = parseComputedColor(observed.backgroundColor)
  if (base === null) return null
  if (observed.backgroundImage.trim() === 'none') return base.alpha
  const stop = firstGradientColor(observed.backgroundImage)
  if (stop === null) return null
  const overlay = parseComputedColor(stop)
  if (overlay === null) return null
  return overlay.alpha + base.alpha * (1 - overlay.alpha)
}

async function settle(page) {
  // Two frames let the breakpoint grid and the reduced-motion widths land
  // before geometry is read.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

/**
 * The drawer and the details panel overlap by design (the detail panel is a
 * modal surface above the drawer), so the hit test runs in one exclusive state
 * per surface instead of pretending all three paint at once.
 */
async function setOpenState(page, state) {
  await page.evaluate(next => {
    const drawer = document.querySelector('.dshm-drawer')
    const details = document.querySelector('.dshm-details')
    drawer.dataset.open = String(next === 'drawer')
    details.dataset.open = String(next === 'details')
    if (next === 'details') details.removeAttribute('inert')
    else details.setAttribute('inert', '')
  }, state)
  await settle(page)
}

async function readHit(page, selector) {
  return page.evaluate(needle => {
    const element = document.querySelector(needle)
    const rect = element.getBoundingClientRect()
    const found = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    const hit = found === null
      ? 'none'
      : found === element || element.contains(found)
        ? 'self'
        : found.id || found.getAttribute('class') || found.tagName
    return { hit, rect: { width: rect.width, height: rect.height } }
  }, selector)
}

async function readSurface(page, selector, token, value) {
  return page.evaluate(({ needle, property, next }) => {
    const shell = document.querySelector('.dshm-shell')
    shell.style.removeProperty('--dsw-alias-bg-layer-1')
    shell.style.removeProperty('--dsw-alias-bg-base')
    if (next !== null) shell.style.setProperty(property, next)
    const element = document.querySelector(needle)
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    const round = number => Math.round(number * 100) / 100
    return {
      backgroundColor: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      zIndex: style.zIndex,
      position: style.position,
      rect: { width: round(rect.width), height: round(rect.height) },
    }
  }, { needle: selector, property: token, next: value })
}

const COLUMNS = Object.freeze([
  { title: 'scheme', width: 6, value: row => row.scheme },
  { title: 'viewport', width: 9, value: row => row.viewport },
  { title: 'token', width: 23, value: row => row.token },
  { title: 'value', width: 12, value: row => row.value },
  { title: 'surface', width: 10, value: row => row.surface },
  { title: 'backgroundColor', width: 26, value: row => row.backgroundColor },
  { title: 'gradientStop', width: 26, value: row => row.gradientStop },
  { title: 'alpha', width: 6, value: row => row.alpha === null ? 'n/a' : String(row.alpha) },
  { title: 'composited', width: 11, value: row => row.composited === null ? 'n/a' : row.composited.toFixed(2) },
  { title: 'rect', width: 14, value: row => `${row.rect.width}x${row.rect.height}` },
  { title: 'hit', width: 8, value: row => row.hit },
])

function printTable(rows) {
  const line = values => values.map((value, index) => pad(value, COLUMNS[index].width)).join(' ').trimEnd()
  console.log(line(COLUMNS.map(column => column.title)))
  console.log(COLUMNS.map(column => '-'.repeat(column.width)).join(' '))
  for (const row of rows) console.log(line(COLUMNS.map(column => column.value(row))))
}

const browser = await chromium.launch()
const rows = []
const failures = []
let cases = 0

try {
  for (const [viewportLabel, viewport] of Object.entries(VIEWPORTS)) {
    for (const colorScheme of COLOR_SCHEMES) {
      cases++
      const at = `${colorScheme} ${viewportLabel}`
      const context = await browser.newContext({ viewport, colorScheme, reducedMotion: 'reduce' })
      try {
        const page = await context.newPage()
        const pageErrors = []
        page.on('pageerror', error => pageErrors.push(error.message))
        await page.setContent(fixture(viewport.width >= 900 && Math.min(viewport.width, viewport.height) >= 600))
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
        await page.evaluate(scheme => {
          // Install the stylesheet and deliberately never dispose the returned
          // effect: the `effect` callback below runs the installer and drops the
          // cleanup, so the <style> stays in the document for every probe.
          window.layoutClient.apply({
            effect: effect => { effect() },
            get: () => undefined,
            on: () => () => {},
            reflect: { provide: () => () => {} },
            slots: { entries: () => [], subscribe: () => () => {}, register: () => () => {}, provideRoot: () => () => {} },
            theme: { getTheme: () => ({ active: { colorScheme: scheme, tokens: {} } }) },
          })
        }, colorScheme)
        await page.locator('.dshm-shell').waitFor({ state: 'visible', timeout: 10_000 })
        assert.deepEqual(pageErrors, [], `${at}: page errors`)
        assert.equal(await page.evaluate(() => document.querySelector('style[data-plugin="dsh-mobile-layout"]') !== null), true,
          `${at}: the layout stylesheet was not installed`)

        // Hit tests run against the translucent token, the value that made the
        // original defect visible, and are reused by every row below because a
        // background never changes layout.
        await page.evaluate(() => {
          const shell = document.querySelector('.dshm-shell')
          shell.style.setProperty('--dsw-alias-bg-layer-1', 'rgba(255, 255, 255, 0.34)')
          shell.style.setProperty('--dsw-alias-bg-base', 'rgba(255, 255, 255, 0.34)')
        })
        const hitBySurface = new Map()
        for (const surface of SURFACES) {
          try {
            await setOpenState(page, surface.state)
            const { hit, rect } = await readHit(page, surface.selector)
            hitBySurface.set(surface.selector, hit)
            assert.equal(hit, 'self',
              `${at}: ${surface.selector} centre is covered by ${hit} while it is the visible surface`)
            assert.ok(rect.width > 0 && rect.height > 0,
              `${at}: ${surface.selector} collapsed to ${rect.width}x${rect.height}`)
          } catch (error) {
            failures.push(error)
            if (!hitBySurface.has(surface.selector)) hitBySurface.set(surface.selector, 'unmeasured')
          }
        }

        for (const surface of SURFACES) {
          for (const tokenValue of TOKEN_VALUES) {
            const observed = await readSurface(page, surface.selector, surface.token, tokenValue.value)
            const alpha = parseComputedColor(observed.backgroundColor)?.alpha ?? null
            const composited = compositedAlpha(observed)
            const gradientStop = firstGradientColor(observed.backgroundImage)
            const row = {
              scheme: colorScheme,
              viewport: viewportLabel,
              token: surface.token,
              value: tokenValue.label,
              surface: surface.label,
              backgroundColor: observed.backgroundColor,
              backgroundImage: observed.backgroundImage,
              gradientStop: gradientStop ?? 'none',
              alpha,
              composited,
              rect: observed.rect,
              hit: hitBySurface.get(surface.selector) ?? 'unmeasured',
            }
            rows.push(row)
            const where = `${at} ${surface.label} ${surface.token}=${tokenValue.label}`
            try {
              // Self-check first: the token must actually reach the rule, or an
              // opaque backgroundColor would prove nothing about skin tokens.
              // An invalid value drops the gradient, so absence is the evidence.
              if (tokenValue.gradientAlpha === null) {
                assert.equal(observed.backgroundImage.trim(), 'none',
                  `${where}: an unresolvable token must drop the gradient, got ${observed.backgroundImage}`)
              } else {
                const stopAlpha = gradientStop === null ? null : parseComputedColor(gradientStop)?.alpha ?? null
                assert.equal(stopAlpha, tokenValue.gradientAlpha,
                  `${where}: the token did not reach the rule; gradient stop ${gradientStop} has alpha ${stopAlpha}, expected ${tokenValue.gradientAlpha}`)
              }
              assert.notEqual(alpha, null,
                `${where}: cannot parse computed backgroundColor ${JSON.stringify(observed.backgroundColor)}`)
              assert.equal(alpha, 1,
                `${where}: computed backgroundColor ${observed.backgroundColor} is not opaque (alpha ${alpha})`)
              if (composited !== null) {
                assert.equal(Math.round(composited * 1e6) / 1e6, 1,
                  `${where}: the painted stack over ${observed.backgroundImage} is translucent (alpha ${composited})`)
              }
              assert.ok(observed.rect.width > 0 && observed.rect.height > 0,
                `${where}: ${surface.selector} measured ${observed.rect.width}x${observed.rect.height}`)
              assert.equal(row.hit, 'self',
                `${where}: ${surface.selector} is covered by ${row.hit}`)
            } catch (error) {
              failures.push(error)
            }
          }
        }
      } catch (error) {
        failures.push(error)
      } finally {
        await context.close()
      }
    }
  }
} finally {
  await browser.close()
}

console.log(`Built stylesheet: ${stylesheetPath} (${client.length} bytes)`)
printTable(rows)

if (failures.length > 0) {
  for (const failure of failures) console.error(failure instanceof Error ? failure.message : failure)
  console.error(`Opaque chrome failed after ${cases} owned browser cases and ${rows.length} computed-style rows.`)
  process.exit(1)
}
console.log(`Opaque chrome passed ${cases} owned browser cases and ${rows.length} computed-style rows: the drawer, the details panel and the panel return bar keep alpha 1 in light and dark schemes at 390px and 1024px while --dsw-alias-bg-layer-1 / --dsw-alias-bg-base are translucent, transparent or invalid. This is computed-style evidence from a real Chromium, not a full DSH runtime, a real skin package or a physical device.`)
