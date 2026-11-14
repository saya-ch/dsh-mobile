import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { packBundle } from './packed-profile.mjs'
import { completeSmoke, recordSmokeFailure } from './negative-control.mjs'
import {
  CLIENT_TIMEOUT_MS, createMobileProfile, dismissOnboarding, launchDsh, openMobileSettings,
  observeWorkspaceStream, openPairing, pairMobilePage, removeTemporaryRoot, sanitized, within,
} from './mobile-boot-fixture.mjs'
import { browsePickerOwnsFlow } from './directory-picker-composition.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? repository
  : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN
  ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const injectedFailure = process.argv.includes('--negative-control')
const blockedRemoteMux = process.argv.includes('--negative-control-mux')
const filePreview = process.argv.includes('--file-preview')
const missingCompanion = process.argv.includes('--negative-control-companion')
const compressedWebSocket = process.argv.includes('--compressed-websocket')
const checkDiagnostics = process.argv.includes('--diagnostics')
const blockedCompatibility = process.argv.includes('--negative-control-compat')
const legacyWebView = blockedCompatibility || process.argv.includes('--legacy-webview')
const compatibilityPath = '/mobile-access/compat.js'
// The gateway requests the bundle by content revision; both forms must be accepted.
const compatibilityPathPattern = /^\/mobile-access\/compat(?:-[a-f\d]{64})?\.js$/u
const compatibilityError = /AbortSignal\.any|throwIfAborted|AbortSignal getters|Promise\.withResolvers|Iterator.*(?:not defined|not a constructor|not a function)|Object\.hasOwn|(?:findLastIndex|findLast|toSorted|toReversed|structuredClone|\.at).*?(?:not defined|not a function)/u
const excludedClientModules = process.env.DSH_BOOT_SMOKE_EXCLUDED_MODULES?.split(',').map(id => id.trim()).filter(Boolean) ?? []
const startedAt = Date.now()
// A real preview is the only surface that drives a Gateway unary Remote:
// POST /api/<endpoint> through the paired mobile origin, including the
// multipart binary response. Attachment uploading never touches this path.
const PREVIEW_TIMEOUT_MS = 20_000
const PREVIEW_TEXT_FILE = 'preview-smoke.md'
const PREVIEW_BINARY_FILE = 'preview-smoke.bin'
const PREVIEW_TEXT_BYTES = 'DSH Mobile preview smoke token\n'
const PREVIEW_BINARY_BYTES = [0x00, 0x01, 0x7f, 0x80, 0xff, 0x0d, 0x0a]
const DOCUMENT_PREVIEW_MODULE = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
let rpcSequence = 0
// A native machine resolves the native interaction, so a browse host cannot be
// reproduced without one. This switch asks DSH for a non-loopback trusted authority,
// which resolves the browse interaction on the same machine.
const forceBrowse = process.env.DSH_BOOT_SMOKE_FORCE_BROWSE === '1'
let compatibilityFailureObserved = false
let companionFailureObserved = false
const companionFailureMessage = 'Packed bundle is missing embedded component dsh-mobile-question-fixes'

/**
 * POST one Gateway unary Remote from a paired page, the way DSH's own
 * `connection.rpc.call('/api', endpoint, { args })` does. The binary branch keeps
 * the multipart parse inside the page because a Blob cannot cross `page.evaluate`.
 */
async function mobileRpc(page, endpoint, args, { expectMultipart = false } = {}) {
  return page.evaluate(async ({ endpoint, args, expectMultipart, rpcId, timeoutMs }) => {
    const diagnostic = {
      csrfCookie: document.cookie.split(';').some(value => value.trim().startsWith('dsh_ma_csrf=')),
      transportOwnsHost: globalThis.__DSH_TRANSPORT__?.ownsHost === true,
    }
    const response = await fetch(`/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const contentType = response.headers.get('content-type') ?? ''
    if (!expectMultipart) {
      return { status: response.status, contentType, ...diagnostic, body: await response.json() }
    }
    const form = await response.formData()
    const metadata = JSON.parse(String(form.get('metadata')))
    const attachments = Array.isArray(metadata?.attachments) ? metadata.attachments : []
    const first = attachments[0]
    const blob = first === undefined ? undefined : form.get(first.part)
    const value = metadata?.result?.ok === true ? metadata.result.value : undefined
    return {
      status: response.status, contentType, ...diagnostic,
      envelopeType: metadata?.type, attachmentCount: attachments.length,
      codec: first?.codec, partIsBlob: blob instanceof Blob,
      bytes: blob instanceof Blob ? Array.from(new Uint8Array(await blob.arrayBuffer())) : undefined,
      error: metadata?.result?.ok === false ? metadata.result.error : undefined,
      offsets: value === undefined ? undefined : { offset: value.offset, eof: value.eof, bytes: value.bytes },
    }
  }, { endpoint, args, expectMultipart, rpcId: `file-preview-${++rpcSequence}`, timeoutMs: PREVIEW_TIMEOUT_MS })
}

/** Observe the actual Chromium upgrade headers without replacing the browser's WebSocket. */
async function observeWebSocketCompression(page) {
  const session = await page.context().newCDPSession(page)
  const sockets = new Map()
  const upgrades = []
  const waiters = []
  session.on('Network.webSocketCreated', event => {
    if (new URL(event.url).pathname === '/api/remote.mux') sockets.set(event.requestId, event.url)
  })
  session.on('Network.webSocketHandshakeResponseReceived', event => {
    const url = sockets.get(event.requestId)
    if (url === undefined) return
    const extensions = Object.entries(event.response.headers)
      .find(([name]) => name.toLowerCase() === 'sec-websocket-extensions')?.[1] ?? ''
    const upgrade = { url, status: event.response.status, extensions: String(extensions) }
    upgrades.push(upgrade)
    for (const waiter of waiters) {
      if (waiter.url === url && upgrade.status === 101) waiter.resolve(upgrade)
    }
  })
  await session.send('Network.enable')
  return {
    handshake(url) {
      const upgrade = upgrades.find(candidate => candidate.url === url && candidate.status === 101)
      return upgrade === undefined
        ? new Promise(resolve => { waiters.push({ url, resolve }) }) : Promise.resolve(upgrade)
    },
    close: () => session.detach(),
  }
}

async function inspectBrowser(baseUrl, logs, directoryRoot) {
  const browser = await chromium.launch({ headless: true })
  let compression
  const failures = []
  try {
    const desktop = await browser.newPage()
    await desktop.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    if (checkDiagnostics) {
      const result = await desktop.evaluate(async () => {
        const response = await fetch('/api/mobile-access/diagnostics')
        return { status: response.status, body: await response.json() }
      })
      if (result.status !== 200 || result.body.version !== 1 || result.body.coverage?.measuredFrom !== 'computer'
        || !result.body.coverage.unverified.includes('phone') || !Array.isArray(result.body.checks)
        || !result.body.checks.some(entry => entry.id === 'phone-network' && entry.scope === 'phone')
        || !result.body.checks.some(entry => entry.id === 'versions' && entry.scope === 'configuration')) {
        const entries = Array.isArray(result.body?.checks) ? result.body.checks.map(entry => ({ id: entry.id, scope: entry.scope })) : []
        const code = typeof result.body?.error === 'string' && /^[a-z_]{1,80}$/u.test(result.body.error) ? result.body.error : undefined
        throw new Error(`Packed diagnostic API omitted its measurement scope: ${JSON.stringify({ status: result.status, version: result.body?.version, hasCoverage: result.body?.coverage !== undefined, entries, code })}`)
      }
      console.log('Packed diagnostic API retained computer/configuration scope and explicitly unverified phone coverage')
    }
    const stockBatches = await desktop.evaluate(() => window.__DSH_BOOT__?.batches ?? [])
    const control = await desktop.evaluate(async () => {
      const response = await fetch('/api/mobile-access/lan/control')
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = undefined }
      return { status: response.status, body }
    })
    if (control.status !== 200 || control.body?.running !== true || typeof control.body?.origin !== 'string') {
      throw new Error(`Mobile plugin did not start through DSH Loader: status=${control.status} json=${String(control.body !== undefined)}\n${logs()}`)
    }
    const pairUrl = await openPairing(desktop, undefined, logs)

    // Back-layer assertions depend on open state, not on drawer animation timing.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    if (legacyWebView) {
      await phone.route('**/mobile-access/workspace-directories*', route => {
        const url = new URL(route.request().url())
        if (!url.searchParams.has('path')) url.searchParams.set('path', directoryRoot)
        return route.continue({ url: url.href })
      })
      await phone.addInitScript(() => {
        delete Promise.withResolvers
        delete AbortSignal.any
        delete AbortSignal.prototype.throwIfAborted
        delete AbortSignal.prototype.reason
        delete globalThis.Iterator
        delete Object.hasOwn
        delete Array.prototype.at
        delete String.prototype.at
        delete Array.prototype.findLast
        delete Array.prototype.findLastIndex
        delete Array.prototype.toSorted
        delete Array.prototype.toReversed
        delete globalThis.structuredClone
        globalThis.__DSH_BOOT_SMOKE_MISSING_APIS__ = {
          promise: typeof Promise.withResolvers,
          abort: typeof AbortSignal.any,
          abortCheck: typeof AbortSignal.prototype.throwIfAborted,
          abortReason: typeof Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get,
          iterator: typeof globalThis.Iterator,
          hasOwn: typeof Object.hasOwn,
          arrayAt: typeof Array.prototype.at,
          stringAt: typeof String.prototype.at,
          findLast: typeof Array.prototype.findLast,
          findLastIndex: typeof Array.prototype.findLastIndex,
          toSorted: typeof Array.prototype.toSorted,
          toReversed: typeof Array.prototype.toReversed,
          clone: typeof globalThis.structuredClone,
        }
      })
    }
    const workspaceStream = observeWorkspaceStream(phone)
    if (compressedWebSocket) compression = await observeWebSocketCompression(phone)
    const errors = []
    const failedBundles = []
    const failedRequests = []
    const responses = []
    let injected = false
    let compatibilityIntercepted = false
    let rejectApiFailure
    const apiFailure = new Promise((_resolve, reject) => { rejectApiFailure = reject })
    const reportError = message => {
      errors.push(message)
      if (compatibilityError.test(message)) rejectApiFailure(new Error(`Mobile compatibility API failed: ${message}`))
    }
    phone.on('pageerror', error => { reportError(error.message) })
    phone.on('console', message => { if (message.type() === 'error') reportError(message.text()) })
    phone.on('requestfailed', request => {
      failedRequests.push({ path: new URL(request.url()).pathname, type: request.resourceType(), failure: request.failure()?.errorText })
    })
    phone.on('response', response => {
      const url = new URL(response.url())
      responses.push({ path: `${url.pathname}${url.search}`, status: response.status(), type: response.request().resourceType(), contentType: response.headers()['content-type'] })
      if (response.status() >= 400 && /\/mobile-access\/mobile-boot\/|\/plugins\//u.test(response.url())) {
        failedBundles.push(`${response.status()} ${new URL(response.url()).pathname}`)
      }
    })
    if (injectedFailure) {
      await phone.route('**/*', async route => {
        if (new URL(route.request().url()).pathname === '/plugins/' && route.request().resourceType() === 'script') {
          injected = true
          await route.fulfill({ status: 200, contentType: 'text/javascript', body: 'import "node:net";\n' })
        } else await route.continue()
      })
    }
    if (blockedRemoteMux) {
      await phone.routeWebSocket('**/api/remote.mux', socket => { socket.close() })
    }
    if (blockedCompatibility) {
      await phone.route('**/mobile-access/compat*.js', async route => {
        compatibilityIntercepted = true
        await route.abort('blockedbyclient')
      })
    }
    let workspace
    try {
      workspace = await Promise.race([
        pairMobilePage(phone, pairUrl, logs, {
          workspaceStream, workspaceTimeoutMs: blockedRemoteMux ? 10_000 : CLIENT_TIMEOUT_MS,
        }),
        apiFailure,
      ])
    } catch (error) {
      const boot = await phone.locator('[data-dsh-boot]').allTextContents()
      const root = await phone.locator('#root').evaluate(element => ({ text: element.textContent?.slice(0, 500), html: element.innerHTML.slice(0, 500) })).catch(() => undefined)
      const missing = await phone.evaluate(() => globalThis.__DSH_BOOT_SMOKE_MISSING_APIS__).catch(() => undefined)
      compatibilityFailureObserved = blockedCompatibility && compatibilityIntercepted && errors.some(message => compatibilityError.test(message))
      throw new Error(`Mobile client did not become ready after pairing: ${String(error)}\nurl=${new URL(phone.url()).pathname}\nmissingAtInit=${JSON.stringify(missing)}\ncompatibilityIntercepted=${String(compatibilityIntercepted)}\nboot=${sanitized(JSON.stringify(boot))}\nroot=${sanitized(JSON.stringify(root))}\nerrors=${sanitized(JSON.stringify(errors))}\nfailedBundles=${sanitized(JSON.stringify(failedBundles))}\nfailedRequests=${sanitized(JSON.stringify(failedRequests))}\nresponses=${sanitized(JSON.stringify(responses))}\n${logs()}`)
    }
    if (blockedCompatibility) throw new Error(`Compatibility negative control unexpectedly booted: intercepted=${String(compatibilityIntercepted)}`)
    if (legacyWebView) {
      const features = await phone.evaluate(() => ({
        missingAtInit: globalThis.__DSH_BOOT_SMOKE_MISSING_APIS__,
        restored: {
          promise: typeof Promise.withResolvers,
          abort: typeof AbortSignal.any,
          abortCheck: typeof AbortSignal.prototype.throwIfAborted,
          abortReason: typeof Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get,
          iterator: typeof globalThis.Iterator,
          hasOwn: typeof Object.hasOwn,
          arrayAt: typeof Array.prototype.at,
          stringAt: typeof String.prototype.at,
          findLast: typeof Array.prototype.findLast,
          findLastIndex: typeof Array.prototype.findLastIndex,
          toSorted: typeof Array.prototype.toSorted,
          toReversed: typeof Array.prototype.toReversed,
          clone: typeof globalThis.structuredClone,
        },
        scripts: Array.from(document.scripts, script => script.src === '' ? '<inline>' : new URL(script.src).pathname),
      }))
      if (Object.values(features.missingAtInit ?? {}).length !== 13
        || Object.values(features.missingAtInit).some(value => value !== 'undefined')
        || Object.values(features.restored).some(value => value !== 'function')) {
        throw new Error(`Legacy WebView compatibility did not restore the missing APIs: ${JSON.stringify(features)}`)
      }
      const compatibilityResponse = responses.find(response => compatibilityPathPattern.test(response.path) && response.type === 'script')
      if (!compatibilityPathPattern.test(features.scripts[0] ?? '') || compatibilityResponse?.status !== 200
        || !compatibilityResponse.contentType?.startsWith('text/javascript')) {
        throw new Error(`Legacy WebView did not load the authenticated compatibility script before DSH: ${JSON.stringify({ features, compatibilityResponse })}`)
      }
      console.log('Legacy WebView APIs were absent at document start and restored before the packed DSH client booted')
    }
    if (compression !== undefined) {
      const upgrade = await within(compression.handshake(workspace.socket.url()), CLIENT_TIMEOUT_MS,
        () => 'Chromium did not report the Workspace WebSocket upgrade response')
      if (!upgrade.extensions.split(',').some(extension => extension.split(';')[0].trim() === 'permessage-deflate')) {
        throw new Error(`Workspace WebSocket did not negotiate compression: status=${String(upgrade.status)} extensions=${upgrade.extensions || '<none>'}`)
      }
      console.log(`Workspace WebSocket negotiated ${upgrade.extensions} and delivered its real baseline`)
    }
    const bootFailures = await phone.getByText('Failed to load plugins').count()
    if (bootFailures > 0 || failedBundles.length > 0 || errors.some(error => compatibilityError.test(error)
      || /Failed to load plugins|failed to import|node:net|ERR_UNSUPPORTED/u.test(error))) {
      throw new Error(`Mobile client import failed: errors=${sanitized(JSON.stringify(errors))} bundles=${sanitized(JSON.stringify(failedBundles))}\n${logs()}`)
    }
    const plan = await phone.evaluate(() => window.__DSH_BOOT__)
    if (injectedFailure && !injected) throw new Error('Negative control did not intercept any DSH client script')
    if (!Array.isArray(plan?.entries) || !plan.entries.some(row => row.id === 'dsh-mobile')) {
      throw new Error(`Real DSH boot manifest did not contain dsh-mobile: entries=${sanitized(JSON.stringify(plan?.entries?.map(row => row.id) ?? []))}`)
    }
    if (!excludedClientModules.includes('dsh-mobile-question-fixes')) {
      if (!plan.entries.some(row => row.id === 'dsh-mobile-question-fixes')) {
        throw new Error(`Bundled question-card component is absent from the boot manifest: ${JSON.stringify(plan.entries.map(row => row.id))}`)
      }
      const componentStyle = phone.locator('style[data-plugin="dsh-mobile-question-fixes"]')
      await componentStyle.waitFor({ state: 'attached', timeout: CLIENT_TIMEOUT_MS })
      if (await componentStyle.count() !== 1) {
        throw new Error('Bundled question-card component did not activate exactly once')
      }
    }
    if (excludedClientModules.length > 0) {
      for (const id of excludedClientModules) {
        if (!stockBatches.some(batch => batch.entries.includes(id))) throw new Error(`Selected module ${id} is absent from the stock DSH graph`)
        if (plan.entries.some(row => row.id === id)) throw new Error(`Selected module ${id} remains in the mobile graph`)
      }
    }
    const oldAffected = stockBatches.filter(batch => batch.phase === 'application'
      && batch.entries.some(id => id === '@deepseek-ai/dsh-client-ui-layout' || excludedClientModules.includes(id)))
    const downloadedScripts = new Set(responses.filter(item => item.type === 'script').map(item => item.path))
    for (const batch of oldAffected) {
      const url = new URL(batch.url, baseUrl)
      if (downloadedScripts.has(`${url.pathname}${url.search}`)) {
        throw new Error(`Stock application batch was still downloaded: ${batch.url}`)
      }
    }
    if (excludedClientModules.length > 0) {
      console.log(`Optional exclusion smoke: ${excludedClientModules.join(', ')}; ${String(oldAffected.length)} old application batches not downloaded; ${String(responses.filter(item => item.type === 'script' && item.path.startsWith('/mobile-access/mobile-boot/')).length)} mobile boot scripts fetched`)
    }
    const mobileFrontend = await phone.evaluate(() => window.__DSH_MOBILE_FRONTEND__)
    if (mobileFrontend !== 'dedicated') throw new Error('Mobile gateway did not select the dedicated frontend')
    if (filePreview) await verifyMobileFilePreview(phone, directoryRoot, logs)
    const back = () => phone.evaluate(() => {
      const event = new Event('dsh-mobile:native-back', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    })
    await dismissOnboarding(phone)
    if (await back()) throw new Error('Mobile Back consumed the root conversation without an open layer')
    const drawer = phone.locator('.dshm-drawer')
    const scrim = phone.locator('.dshm-scrim')
    const drawerToggle = drawer.locator('button[data-dsh-mobile-toggle]')
    if (legacyWebView) {
      await drawerToggle.click()
      await phone.waitForFunction(() => document.querySelector('.dshm-scrim')?.getAttribute('data-open') === 'true')
      // DSH resolves the directory interaction at boot. A headless or remotely
      // reachable host is a browse host: DSH's own web picker fills the same
      // directory-flow slots, so the plugin stands aside and its listing route is
      // never called. Only a native host keeps the plugin-owned flow that this
      // legacy-WebView check was written for.
      const browseHost = await browsePickerOwnsFlow(phone)
      if (browseHost) {
        await drawer.getByRole('button', { name: /^(?:Add workspace|添加工作区)$/u }).click()
        const upstreamDialog = phone.locator('[role="dialog"], dialog').filter({ hasText: /workspace directory|工作区目录/i }).first()
        await upstreamDialog.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
        if (await phone.locator('.dshm-picker').count() !== 0) {
          throw new Error('Legacy WebView mounted the plugin picker on a browse host')
        }
        await phone.getByRole('button', { name: /new folder|新建文件夹/i }).first().waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
        console.log('Legacy WebView on a browse host: DSH\'s own picker owns the flow and offers folder creation')
        await phone.keyboard.press('Escape')
        await upstreamDialog.waitFor({ state: 'hidden', timeout: CLIENT_TIMEOUT_MS })
        if (!await back()) throw new Error('Mobile Back did not close the drawer after the upstream picker')
        await phone.waitForFunction(() => document.querySelector('.dshm-scrim')?.getAttribute('data-open') === 'false')
      } else {
        const [listingResponse] = await Promise.all([
          phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/workspace-directories', { timeout: CLIENT_TIMEOUT_MS }),
          drawer.getByRole('button', { name: /^(?:Add workspace|添加工作区)$/u }).click(),
        ])
        const listing = await listingResponse.json()
        if (listingResponse.status() !== 200 || listing.path !== directoryRoot || !Array.isArray(listing.entries)) {
          throw new Error(`Legacy WebView Workspace directory listing failed: status=${String(listingResponse.status())}`)
        }
        const directoryDialog = phone.locator('.dshm-picker')
        await directoryDialog.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
        const openDirectory = directoryDialog.locator('[data-dshm-picker-confirm]')
        await phone.waitForFunction(() => {
          const button = document.querySelector('.dshm-picker [data-dshm-picker-confirm]')
          return button instanceof HTMLButtonElement && !button.disabled
        }, undefined, { timeout: CLIENT_TIMEOUT_MS })
        if (!await openDirectory.isEnabled() || await directoryDialog.getByRole('alert').count() !== 0) {
          throw new Error('Legacy WebView Workspace directory picker did not expose a usable selection')
        }
        await directoryDialog.locator('[data-dshm-picker-cancel]').click()
        await directoryDialog.waitFor({ state: 'detached', timeout: CLIENT_TIMEOUT_MS })
        if (!await back()) throw new Error('Mobile Back did not close the drawer after the Workspace directory picker')
        await phone.waitForFunction(() => document.querySelector('.dshm-scrim')?.getAttribute('data-open') === 'false')
        console.log(`Legacy WebView Workspace picker read ${String(listing.entries.length)} owned directory rows and enabled Open`)
      }
    }
    await drawerToggle.click()
    await phone.waitForFunction(() => document.querySelector('.dshm-scrim')?.getAttribute('data-open') === 'true')
    if (!await back()) throw new Error('Mobile Back did not consume the open drawer')
    await phone.waitForFunction(() => document.querySelector('.dshm-scrim')?.getAttribute('data-open') === 'false')
    await drawerToggle.click()
    await phone.waitForFunction(() => document.querySelector('.dshm-scrim')?.getAttribute('data-open') === 'true')
    await openMobileSettings(phone)
    const settingsDialog = phone.locator('[role="dialog"][aria-modal="true"]').first()
    await settingsDialog.waitFor({ state: 'visible' })
    if (!await back()) throw new Error('Mobile Back did not consume the settings dialog')
    await settingsDialog.waitFor({ state: 'detached' })
    // Let dialog teardown and React's layout update finish before the next gesture.
    await phone.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    // The stock adapter mirrors delayed sidebar classes onto the drawer wrapper.
    // The dedicated scrim is owned only by layout state and identifies its open layer.
    if (!await phone.locator('.dshm-main').isVisible()) throw new Error('Conversation surface did not return after settings closed')
    await phone.waitForFunction(() => document.querySelector('.dshm-details')?.getAttribute('data-open') === 'false')
    if (await scrim.getAttribute('data-open') === 'true') {
      if (!await back()) {
        const state = await phone.evaluate(() => ({
          width: window.innerWidth, clientWidth: document.documentElement.clientWidth,
          viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content'),
          drawerOpen: document.querySelector('.dshm-drawer')?.getAttribute('data-open'),
          drawerWidth: document.querySelector('.dshm-drawer')?.getBoundingClientRect().width,
        }))
        throw new Error(`Mobile Back did not consume the drawer below settings: ${JSON.stringify(state)}`)
      }
      await phone.waitForFunction(() => document.querySelector('.dshm-scrim')?.getAttribute('data-open') === 'false')
    }
    const layoutState = () => phone.evaluate(() => ({
      width: innerWidth,
      layers: ['.dshm-drawer', '.dshm-details', '.dshm-main'].map(selector => {
        const node = document.querySelector(selector)
        return node === null ? null : {
          selector, open: node.getAttribute('data-open'), display: getComputedStyle(node).display,
          width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height,
        }
      }),
      main: document.querySelector('.dshm-main')?.textContent?.slice(0, 120),
    }))
    const beforeRootBack = await layoutState()
    if (await back()) throw new Error(`Mobile Back consumed the conversation after settings closed: ${JSON.stringify({ before: beforeRootBack, after: await layoutState() })}`)
    const extensionBack = await phone.evaluate(() => {
      const layer = document.createElement('section')
      layer.dataset.dshMobileSurfacePlacement = 'overlay'
      layer.style.cssText = 'position:fixed;inset:0;z-index:1300'
      document.body.append(layer)
      const event = new Event('dsh-mobile:native-back', { cancelable: true })
      window.dispatchEvent(event)
      const result = event.defaultPrevented && layer.hidden
      layer.remove()
      return result
    })
    if (!extensionBack) throw new Error('Mobile Back did not close a visible extension overlay')
    if (errors.some(message => compatibilityError.test(message))) {
      throw new Error(`Mobile compatibility API failed during interaction: ${sanitized(JSON.stringify(errors))}`)
    }
    console.log(`Mobile client mounted through DSH Loader and read ${String(workspace.workspaces)} Workspaces over /api/remote.mux (${String(plan.entries.length)} plugin entries, ${Date.now() - startedAt} ms)`)
  } catch (error) { recordSmokeFailure(failures, error) }
  finally {
    try { await compression?.close() } catch (error) { recordSmokeFailure(failures, error) }
    try { await browser.close() } catch (error) { recordSmokeFailure(failures, error) }
  }
  completeSmoke(failures)
}

/**
 * Prove one real workspace file can be stat'd, read as text and read as bytes
 * through the paired mobile origin. A preview that cannot reach the Host fails
 * somewhere on this chain, so the read is the smallest honest end-to-end check.
 */
async function verifyMobileFilePreview(phone, directoryRoot, logs) {
  const workspace = await mobileRpc(phone, 'workspace/create', { request: { path: directoryRoot } })
  const workspaceValue = workspace.body?.result?.ok === true ? workspace.body.result.value : undefined
  const workspaceId = workspaceValue?.workspace?.workspaceId ?? workspaceValue?.workspaceId ?? workspaceValue?.id
  if (workspace.status !== 200 || typeof workspaceId !== 'string') {
    throw new Error(`Mobile gateway could not create the preview Workspace: ${sanitized(JSON.stringify(workspace))}\n${logs()}`)
  }
  const created = await mobileRpc(phone, 'session/create', { request: { workspaceId } })
  if (created.status !== 200 || created.body?.result?.ok !== true
    || typeof created.body.result.value?.sessionId !== 'string') {
    throw new Error(`Mobile gateway could not create a Session for the preview read: ${sanitized(JSON.stringify(created))}\n${logs()}`)
  }
  const sessionId = created.body.result.value.sessionId

  const stat = await mobileRpc(phone, 'workspaceFiles/stat', { workspaceFileScopeId: sessionId, path: PREVIEW_TEXT_FILE })
  const statValue = stat.body?.result?.value
  if (stat.status !== 200 || stat.body?.result?.ok !== true || typeof statValue?.absolutePath !== 'string'
    || typeof statValue.version !== 'string' || statValue.bytes !== PREVIEW_TEXT_BYTES.length) {
    throw new Error(`Mobile gateway workspaceFiles/stat failed: ${sanitized(JSON.stringify(stat))}\n${logs()}`)
  }
  if (!statValue.absolutePath.replace(/\\/gu, '/').endsWith(`/${PREVIEW_TEXT_FILE}`)) {
    throw new Error(`workspaceFiles/stat resolved an unexpected path: ${sanitized(JSON.stringify(statValue))}`)
  }

  const read = await mobileRpc(phone, 'workspaceFiles/read', {
    workspaceFileScopeId: sessionId, path: PREVIEW_TEXT_FILE, range: {},
  })
  const readValue = read.body?.result?.value
  if (read.status !== 200 || read.body?.result?.ok !== true
    || readValue?.text?.trimEnd() !== PREVIEW_TEXT_BYTES.trimEnd() || readValue.offset !== 1 || readValue.eof !== true || readValue.lines !== 1) {
    throw new Error(`Mobile gateway workspaceFiles/read did not return the real file text: ${sanitized(JSON.stringify(read))}\n${logs()}`)
  }

  const bytes = await mobileRpc(phone, 'workspaceFiles/readBytes', {
    workspaceFileScopeId: sessionId, path: PREVIEW_BINARY_FILE, options: {},
  }, { expectMultipart: true })
  if (bytes.status !== 200 || bytes.envelopeType !== 'server-response'
    || !bytes.contentType.startsWith('multipart/form-data')
    || bytes.attachmentCount !== 1 || bytes.codec !== 'bytes' || bytes.partIsBlob !== true
    || JSON.stringify(bytes.bytes) !== JSON.stringify(PREVIEW_BINARY_BYTES)
    || bytes.offsets?.eof !== true || bytes.offsets.offset !== 0) {
    throw new Error(`Mobile gateway workspaceFiles/readBytes did not return the real file bytes: ${sanitized(JSON.stringify(bytes))}\n${logs()}`)
  }

  // The Host failure has to travel back as an RPC error, not as a gateway 5xx:
  // that separation is what tells a missing file apart from a broken preview.
  const missing = await mobileRpc(phone, 'workspaceFiles/read', {
    workspaceFileScopeId: sessionId, path: 'preview-smoke-missing.md', range: {},
  })
  if (missing.status !== 200 || missing.body?.result?.ok !== false
    || missing.body.result.error?.code !== 'workspace-file/not-found') {
    throw new Error(`Mobile gateway did not report a Host not-found for a missing preview file: ${sanitized(JSON.stringify(missing))}\n${logs()}`)
  }

  const plan = await phone.evaluate(() => window.__DSH_BOOT__)
  if (!Array.isArray(plan?.entries) || !plan.entries.some(row => row.id === DOCUMENT_PREVIEW_MODULE)) {
    throw new Error(`Mobile boot graph dropped the document preview module: ${sanitized(JSON.stringify(plan?.entries?.map(row => row.id) ?? []))}`)
  }

  console.log(`Mobile gateway preview read real text and ${String(PREVIEW_BINARY_BYTES.length)} binary bytes over POST /api/workspaceFiles/{stat,read,readBytes} (csrf=${String(read.csrfCookie)}, transportOwnsHost=${String(read.transportOwnsHost)})`)
}

async function main() {
  if (process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL === undefined) await readFile(join(mobileRoot, 'lib', 'index.mjs'))
  await readFile(dshBin)
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-boot-smoke-'))
  let dsh
  const failures = []
  try {
    const directoryRoot = join(root, 'workspace-directory')
    await mkdir(directoryRoot)
    if (filePreview) {
      await writeFile(join(directoryRoot, PREVIEW_TEXT_FILE), PREVIEW_TEXT_BYTES)
      await writeFile(join(directoryRoot, PREVIEW_BINARY_FILE), Buffer.from(PREVIEW_BINARY_BYTES))
    }
    const tarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL === undefined
      ? await packBundle(mobileRoot, root) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL)
    let home
    try {
      home = await createMobileProfile(root, {
        tarball, dshBin, excludedClientModules, compressedWebSocket, missingCompanion,
      })
    } catch (error) {
      companionFailureObserved = missingCompanion && error instanceof Error && error.message === companionFailureMessage
      if (companionFailureObserved) throw new Error('Deliberately removed companion was rejected before launch')
      throw error
    }
    dsh = launchDsh(root, home, dshBin, forceBrowse ? ['--trusted-host', '198.18.0.1'] : [])
    await inspectBrowser(await dsh.ready(), dsh.logs, directoryRoot)
  } catch (error) {
    const collected = []
    recordSmokeFailure(collected, error)
    failures.push(...collected.map(failure => new Error(sanitized(failure.stack ?? failure.message))))
  } finally {
    if (dsh !== undefined) {
      try {
        const result = await dsh.close()
        if (result.forced || (result.code !== 0 && result.signal !== 'SIGTERM')) {
          failures.push(new Error(`DSH did not stop quiescently: ${JSON.stringify(result)}\n${dsh.logs()}`))
        }
      } catch (error) { recordSmokeFailure(failures, error) }
    }
    try { await removeTemporaryRoot(root) } catch (error) { recordSmokeFailure(failures, error) }
  }
  const marker = blockedCompatibility ? 'Legacy compatibility negative control detected'
    : missingCompanion ? companionFailureMessage : undefined
  completeSmoke(failures, marker, blockedCompatibility ? compatibilityFailureObserved : companionFailureObserved)
}

await main()
