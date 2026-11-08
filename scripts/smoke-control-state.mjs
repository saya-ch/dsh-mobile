import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const client = await readFile(resolve(mobileRoot, 'lib/client.js'), 'utf8')
const prefix = '/api/mobile-access'
const remotePath = `${prefix}/remote/control`
const trustedPath = `${prefix}/lan/trusted-networks`
const modePath = `${prefix}/remote/origin/mode`
const caddyPath = `${prefix}/remote/caddy/settings`
const hostsPath = `${prefix}/extensions/hosts`
const recoverPath = `${prefix}/extensions/recover`
const fixtureHtml = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><section id="fixture-settings"></section><footer id="fixture-sidebar"></footer></body></html>'

function remoteState() {
  return {
    provider: 'origin', running: false, state: 'off', originMode: 'managed',
    providers: {
      origin: {
        component: { installed: true, supported: true },
        configuration: {
          configured: true, publicOrigin: 'https://saved-proxy.example.com:8815',
          listenHost: '127.0.0.1', listenPort: 3444, allowedCidrs: ['127.0.0.0/8'],
        },
      },
    },
    caddyConfiguration: { configured: true, publicOrigin: 'https://saved-caddy.example.com:8443', listenPort: 8443 },
    caddyState: { enabled: false, state: 'off' },
  }
}

async function waitUntil(read, accepts, description) {
  const deadline = performance.now() + 10_000
  let value
  do {
    value = await read()
    if (accepts(value)) return value
    await delay(10)
  } while (performance.now() < deadline)
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(value)}`)
}

// Each case owns its listener and pending HTTP responses. Only the controller
// responses are simulated; the built client creates and updates the real DOM.
async function withControl(browser, name, options, run) {
  const requests = []
  const errors = []
  const pending = new Set()
  const handlers = new Set()
  const state = {
    remote: remoteState(),
    trusted: { supported: options.supported !== false, extraAllowedCidrs: ['10.80.0.0/16'], windowsFirewall: false },
    holdTrusted: options.holdTrusted === true,
    holdMode: options.holdMode === true,
    holdNextRemote: false,
    hosts: options.hosts ?? [], holdHosts: false, holdRecovery: options.holdRecovery === true,
    recoveryError: options.recoveryError,
    diagnostics: options.diagnostics,
    pairingSequence: 0, holdCloudflared: false,
    lanRunning: options.lanRunning !== false, lanOrigin: 'https://192.168.50.20:3443', lanInterface: 'fixture0',
    holdRebind: false, rebindError: undefined, lanRecoveryRequired: false,
  }
  if (options.managedReady) {
    Object.assign(state.remote, {
      running: true, state: 'ready', origin: 'https://saved-caddy.example.com:8443',
      backendOrigin: 'http://127.0.0.1:49954',
      caddyState: { enabled: true, state: 'ready', origin: 'https://saved-caddy.example.com:8443', backendOrigin: 'http://127.0.0.1:49954' },
    })
    Object.assign(state.remote.providers.origin, { running: true, state: 'ready' })
  }
  if (options.layoutFixture) {
    Object.assign(state.remote.providers.origin, { running: true, state: 'ready' })
    state.remote.providers.origin.configuration.backendOrigin = 'http://127.0.0.1:3444'
    state.remote.providers.origin.component.installed = options.caddyInstalled !== false
    state.remote.providers.origin.component.supported = options.caddySupported !== false
  }
  if (options.frpFixture) {
    state.remote.providers.frp = {
      component: { installed: options.frpInstalled !== false, supported: true },
      configuration: { configured: false, proxyName: 'dsh-mobile-frp-feedback-fixture' },
    }
  }
  let closing = false
  let context
  const json = (response, status, body) => {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(body))
  }
  const hold = (entry, response) => {
    pending.add(response)
    response.once('close', () => { pending.delete(response) })
    entry.release = (status = 200, body = state.remote) => {
      assert.equal(pending.has(response), true, `${name}: held response was already closed`)
      pending.delete(response)
      json(response, status, body)
    }
  }
  const handle = async (request, response) => {
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString())
    const entry = { method: request.method, pathname, body }
    requests.push(entry)
    if (pathname === `${prefix}/release`) { json(response, 200, {}); return }
    if (pathname === `${prefix}/diagnostics`) {
      if (state.diagnostics === undefined) json(response, 503, { error: 'diagnostic_fixture_unavailable' })
      else json(response, 200, state.diagnostics)
      return
    }
    if (pathname === hostsPath) {
      if (state.holdHosts) { hold(entry, response); return }
      json(response, 200, { hosts: state.hosts, limits: { maxWorkers: 4, workers: state.hosts.filter(host => host.mode === 'worker' && host.state === 'ready').length } })
      return
    }
    if (pathname === recoverPath) {
      assert.equal(request.method, 'POST'); assert.equal(body.confirm, true)
      if (state.holdRecovery) { hold(entry, response); return }
      if (state.recoveryError !== undefined) { json(response, 409, { error: state.recoveryError }); return }
      state.hosts = state.hosts.map(host => host.id === body.id ? { ...host, state: 'ready' } : host)
      json(response, 200, { hosts: state.hosts, limits: { maxWorkers: 4, workers: 1 } })
      return
    }
    if (pathname === `${prefix}/lan/control`) {
      json(response, 200, { configured: true, rebindSupported: true, running: state.lanRunning,
        origin: state.lanRunning ? state.lanOrigin : undefined, ...(state.lanRecoveryRequired ? { recoveryRequired: true } : {}) })
      return
    }
    if (pathname === `${prefix}/lan/networks`) {
      json(response, 200, {
        supported: true,
        currentInterface: state.lanInterface,
        listenPort: 3443,
        platform: process.platform,
        networks: [0, 1].map(index => ({ name: `fixture${index}`, address: `192.168.50.${20 + index}`,
          cidr: '192.168.50.0/24', current: state.lanInterface === `fixture${index}`, recommended: index === 0 })),
      })
      return
    }
    if (pathname === `${prefix}/lan/rebind` && request.method === 'POST') {
      if (state.rebindError !== undefined) { json(response, 500, { error: state.rebindError }); return }
      if (state.holdRebind) { hold(entry, response); return }
      state.lanInterface = body.networkInterface
      state.lanOrigin = state.lanInterface === 'fixture1' ? 'https://192.168.50.21:3443' : 'https://192.168.50.20:3443'
      json(response, 200, { origin: state.lanOrigin, restartRequired: false, disconnected: state.lanRunning, ready: state.lanRunning })
      return
    }
    if (/^\/api\/mobile-access\/(lan|remote)\/pairing\/open$/u.test(pathname) && request.method === 'POST') {
      const token = `owned-pairing-fixture-${++state.pairingSequence}`
      json(response, 201, { pairUrl: `https://fixture.example/mobile-access/pair#token=${token}`,
        expiresAt: Date.parse('2026-01-01T12:00:01Z') + 120_000,
        qrSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>' })
      return
    }
    if (pathname === trustedPath) {
      if (request.method === 'GET' && state.holdTrusted) { hold(entry, response); return }
      if (request.method === 'POST') state.trusted.extraAllowedCidrs = body.extraAllowedCidrs
      json(response, 200, state.trusted)
      return
    }
    if (pathname === remotePath && request.method === 'GET') {
      if (state.holdNextRemote) { state.holdNextRemote = false; hold(entry, response); return }
      json(response, 200, state.remote)
      return
    }
    if (pathname === modePath && request.method === 'POST') {
      if (state.holdMode) { hold(entry, response); return }
      state.remote.originMode = body.mode
      json(response, 200, state.remote)
      return
    }
    if (pathname === caddyPath && request.method === 'POST') {
      state.remote.caddyConfiguration = { configured: true, ...body.settings }
      if (body.connect === true) {
        state.remote.originMode = 'managed'
        state.remote.running = true
        state.remote.state = 'ready'
        state.remote.origin = body.settings.publicOrigin
        state.remote.caddyState = { enabled: true, state: 'ready' }
      }
      json(response, 200, state.remote)
      return
    }
    if (pathname === `${prefix}/remote/cloudflared/tunnel` && request.method === 'POST') {
      if (state.holdCloudflared) { state.pendingCloudflared = response; hold(entry, response); return }
      const { token: _token, ...configuration } = body
      state.remote.providers.cloudflared.configuration = { ...configuration, configured: true }
      if (body.connect === true) Object.assign(state.remote, { running: true, state: 'connecting' })
      json(response, 200, state.remote)
      return
    }
    if (pathname === `${prefix}/remote/iroh/pairing/begin` && request.method === 'POST') {
      json(response, 200, { version: 1, type: 'iroh', endpointId: 'owned-endpoint', instanceId: 'owned-instance',
        origin: 'https://owned.iroh.localhost:3444', localPort: 3444, gatewayToken: 'owned-fixture-token', caCertificate: 'owned-fixture-ca',
        irohCode: state.irohQrUnavailable ? '654321' : '123456', expiresAt: Date.parse('2026-01-01T12:00:01Z') + 300_000,
        qrSvg: state.irohQrUnavailable ? '' : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>' })
      return
    }
    if (pathname === `${prefix}/remote/frp/configure` && request.method === 'POST') {
      if (state.frpConfigureError !== undefined) { json(response, 400, { error: state.frpConfigureError }); return }
      if (state.holdFrpConfigure) { hold(entry, response); return }
      const { token: _token, ...safe } = body
      state.remote.providers.frp.configuration = { configured: true, ...safe, proxyName: 'dsh-mobile-frp-feedback-fixture' }
      json(response, 200, state.remote)
      return
    }
    if (pathname === `${prefix}/remote/provider` && request.method === 'POST') state.remote.provider = body.provider
    if (pathname.startsWith(`${prefix}/remote/`)) { json(response, 200, state.remote); return }
    errors.push(`Unexpected fixture request: ${request.method} ${pathname}`)
    json(response, 404, { error: 'fixture_route_missing' })
  }
  const server = createServer((request, response) => {
    const task = handle(request, response).catch(error => {
      if (!closing) { errors.push(String(error)); json(response, 500, { error: 'fixture_failed' }) }
    })
    handlers.add(task)
    void task.finally(() => { handlers.delete(task) })
  })
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    assert(address !== null && typeof address !== 'string', `${name}: fixture has no TCP address`)
    const origin = `http://127.0.0.1:${address.port}`
    context = await browser.newContext({ viewport: { width: options.width ?? 1100, height: 900 }, locale: options.locale ?? 'en-US', reducedMotion: 'reduce', hasTouch: options.touch === true, isMobile: options.touch === true })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => { errors.push(error.message) })
    page.on('dialog', dialog => { void (options.cancelDialogs ? dialog.dismiss() : dialog.accept()) })
    await page.route('**/*', route => {
      const url = new URL(route.request().url())
      // Own the document as well as the controller fixture: local HTTP filters
      // must not inject unrelated scripts into this browser regression.
      if (url.origin === origin && url.pathname === '/' && route.request().isNavigationRequest()) {
        return route.fulfill({ contentType: 'text/html', body: fixtureHtml.replace('lang="en"', `lang="${options.language ?? 'en'}"`) })
      }
      if (url.origin === origin) return route.continue()
      errors.push(`Unexpected external request: ${route.request().url()}`)
      return route.abort()
    })
    await page.goto(origin)
    await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') })
    await page.clock.pauseAt(new Date('2026-01-01T12:00:01Z'))
    await page.evaluate(() => {
      const createElement = (type, props, ...children) => {
        if (typeof type === 'function') return type({ ...props, children })
        if (typeof type !== 'string') throw new Error('Unexpected React element in control fixture')
        const svg = ['svg', 'rect', 'path'].includes(type)
        const node = svg ? document.createElementNS('http://www.w3.org/2000/svg', type) : document.createElement(type)
        for (const [key, value] of Object.entries(props ?? {})) {
          if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
          else if (value !== undefined && value !== null) node.setAttribute(key === 'className' ? 'class' : key, String(value))
        }
        for (const child of children.flat(Infinity)) if (child !== undefined && child !== null) node.append(child)
        return node
      }
      const react = { createElement, useEffect: () => { throw new Error('Unexpected React hook in sidebar fixture') }, useState: () => { throw new Error('Unexpected React hook in sidebar fixture') } }
      const cleanup = []
      window.fixtureConsumed = []
      const originalFetch = window.fetch.bind(window)
      window.fetch = async (...args) => {
        const response = await originalFetch(...args)
        for (const method of ['text', 'json']) {
          const originalRead = response[method].bind(response)
          response[method] = async () => {
            const value = await originalRead()
            window.fixtureConsumed.push(new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).pathname)
            return value
          }
        }
        return response
      }
      window.__ModuleLoader__ = { load: ({ factory }) => { window.mobileClient = factory(name => {
        if (name === 'react') return react
        throw new Error(`Unexpected client dependency: ${name}`)
      }) } }
      window.mountClient = () => { window.mobileClient.apply({
        effect: effect => { const dispose = effect(); if (typeof dispose === 'function') cleanup.push(dispose) },
        get: () => undefined,
        slots: {
          inject: (_name, install) => install(),
          register: (metadata, render) => {
            let node
            if (metadata.name === 'settings.general.item' && metadata.id === 'dsh-mobile-client-modules') {
              node = render({}); document.querySelector('#fixture-settings').append(node)
            } else if (metadata.name === 'sidebar.footer.action' && metadata.id === 'dsh-mobile') {
              node = render({ wide: true }); document.querySelector('#fixture-sidebar').append(node)
            } else throw new Error(`Unexpected control fixture slot: ${metadata.name} ${metadata.id}`)
            return () => { node.remove() }
          },
        },
      }) }
      window.disposeClient = () => { while (cleanup.length > 0) cleanup.pop()(); window.fetch = originalFetch }
    })
    await page.addScriptTag({ content: client })
    await page.evaluate(() => { window.mountClient() })
    const consumed = pathname => page.evaluate(path => window.fixtureConsumed.filter(value => value === path).length, pathname)
    const settle = async (pathname, previous) => {
      await waitUntil(() => consumed(pathname), count => count > previous, `${name}: consumed ${pathname}`)
      await page.evaluate(() => new Promise(resolveTurn => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolveTurn() }
        channel.port2.postMessage(null)
      }))
    }
    const count = (method, pathname) => requests.filter(entry => entry.method === method && entry.pathname === pathname).length
    const waitRequest = (method, pathname, previous = 0) => waitUntil(
      () => requests.filter(entry => entry.method === method && entry.pathname === pathname),
      entries => entries.length > previous, `${name}: ${method} ${pathname}`,
    ).then(entries => entries[previous])
    await waitUntil(() => page.locator('.dsh-mobile-control__provider.is-origin').getAttribute('aria-pressed'), value => value === 'true', `${name}: initial remote render`)
    if (!options.layoutFixture) {
      assert.equal(await page.locator('#fixture-settings .dsh-module-title').textContent(), 'Mobile page modules', `${name}: missing General settings registration`)
      assert.equal(await page.locator('#fixture-settings .dsh-module-description').textContent(), 'Mobile defaults for this computer. Desktop plugins are unchanged.', `${name}: General settings did not use computer scope`)
    }
    await page.locator('.dsh-mobile-control__trigger').click()
    const ui = {
      trustedSummary: page.locator('summary').filter({ hasText: /^Additional trusted networks/ }),
      trustedInput: page.getByLabel('Additional source networks', { exact: true }),
      trustedSave: page.getByRole('button', { name: 'Save networks', exact: true, includeHidden: true }),
      managed: page.locator('input[name="caddy-mode"][value="managed"]'),
      external: page.locator('input[name="caddy-mode"][value="external"]'),
      caddySave: page.getByRole('button', { name: 'Save and start Caddy', exact: true, includeHidden: true }),
      caddyDomain: page.getByLabel('Public domain', { exact: true }),
      caddyPort: page.getByLabel('Local HTTPS port', { exact: true }),
      caddySecretId: page.getByLabel('Tencent Cloud SecretId', { exact: true }),
      caddySecretKey: page.getByLabel('Tencent Cloud SecretKey', { exact: true }),
      originPublic: page.getByLabel('Public HTTPS address', { exact: true }),
      originHost: page.getByLabel('Private listen IP (IPv4 / IPv6)', { exact: true }),
      originPort: page.getByLabel('HTTP backend port', { exact: true }),
      originCidrs: page.getByLabel('Allowed proxy source CIDRs', { exact: true }),
    }
    const openRemote = async () => {
      const previous = await consumed(remotePath)
      await page.locator('.dsh-mobile-control__provider.is-origin').click()
      await settle(remotePath, previous)
    }
    const pollRemote = async () => {
      const previous = await consumed(remotePath)
      await page.clock.runFor(1_500)
      await settle(remotePath, previous)
    }
    await run({ page, state, ui, count, waitRequest, consumed, settle, openRemote, pollRemote })
    assert.deepEqual(errors, [], `${name}: browser or fixture errors`)
    console.log(`Control-state browser smoke passed: ${name}`)
  } finally {
    closing = true
    try {
      if (context !== undefined) {
        for (const page of context.pages()) {
          if (!page.isClosed()) await page.evaluate(() => { window.disposeClient?.() })
        }
      }
    } finally {
      try { if (context !== undefined) await context.close() } finally {
        for (const response of pending) response.destroy()
        server.closeAllConnections()
        if (server.listening) await new Promise(resolveClose => { server.close(resolveClose) })
        await Promise.allSettled(handlers)
      }
    }
  }
}

const browser = await chromium.launch({ headless: true })
let cases = 0
try {
  for (const lanRunning of [false, true]) {
    await withControl(browser, `LAN rebind state and confirmed refresh (${lanRunning})`, { lanRunning }, async ({ page, state, count, waitRequest }) => {
      await page.locator('.dsh-mobile-control__provider.is-lan').click()
      const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Change network', exact: true }) }).last()
      const select = section.getByLabel('New network', { exact: true })
      const confirm = section.locator('button.dsh-mobile-control__primary')
      await waitUntil(() => confirm.isEnabled(), Boolean, 'initial network scan')
      await select.selectOption('fixture1')
      state.holdRebind = true
      await confirm.click()
      const request = await waitRequest('POST', `${prefix}/lan/rebind`)
      assert.equal(await select.isDisabled(), true)
      assert.equal(await section.getByRole('button', { name: 'Scan again' }).isDisabled(), true)
      await select.dispatchEvent('change')
      assert.equal(await confirm.isDisabled(), true, 'A queued change event re-enabled the pending submit')
      assert.equal(count('POST', `${prefix}/lan/rebind`), 1)
      state.lanInterface = 'fixture1'
      state.lanOrigin = 'https://192.168.50.21:3443'
      request.release(200, { origin: state.lanOrigin, disconnected: lanRunning, ready: lanRunning, restartRequired: false })
      await waitUntil(() => confirm.isEnabled(), Boolean, 'rebind follow-up reads and idle controls')
      assert.equal(await select.inputValue(), 'fixture1', 'Current network was not refreshed')
      assert.equal(count('POST', `${prefix}/lan/control`), 0, 'Rebind changed the enabled preference')
      if (lanRunning) {
        await waitRequest('POST', `${prefix}/lan/pairing/open`)
        assert.equal(await page.locator('a[href="https://192.168.50.21:3443"]').count(), 1, 'The previous connection address survived')
      } else assert.equal(count('POST', `${prefix}/lan/pairing/open`), 0, 'Stopped access opened a pairing window')
      state.holdRebind = false
      state.rebindError = 'lan_rebind_recovery_required'
      state.lanRecoveryRequired = true
      await select.selectOption('fixture0')
      await confirm.click()
      await waitUntil(() => section.textContent(), text => text.includes('could not be restored'), 'explicit failed recovery')
      assert.equal((await section.textContent()).includes('Nothing was modified'), false)
      await section.getByRole('button', { name: 'Scan again' }).click()
      await waitUntil(() => confirm.isEnabled(), Boolean, 'read-only recovery status refresh')
      assert.equal(count('POST', `${prefix}/lan/rebind`), 2, 'Refreshing uncertain state replayed a write')
      assert((await page.locator('.dsh-mobile-control__channel-pane').textContent()).includes('could not be restored'))
    })
    cases++
  }
  await withControl(browser, 'Mac folder guidance is optional, host-scoped and keyboard-accessible', { managedReady: true, touch: true, width: 320 },
    async ({ page, state, openRemote, pollRemote }) => {
      await openRemote()
      const summary = page.locator('summary').filter({ hasText: /^Before leaving this Mac$/u })
      const help = summary.locator('..')
      assert.equal(await summary.isVisible(), false, 'Unknown/non-Mac Host showed the Mac help')
      state.remote.macosHost = true
      await pollRemote()
      await summary.waitFor({ state: 'visible' })
      assert.equal(await help.evaluate(node => node.open), false, 'Help interrupted the ready view')
      const mainActions = page.locator('.dsh-mobile-control__remote-workspace > .dsh-mobile-control__actions')
      assert.equal(await mainActions.isVisible(), true, 'Help blocked the remote actions')
      const writes = []
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith(prefix) && request.method() !== 'GET') writes.push(request.method())
      })
      await summary.focus()
      await summary.press('Enter')
      const note = help.locator('p')
      await note.waitFor({ state: 'visible' })
      assert.match(await note.textContent(), /Files and Folders/u)
      assert(await help.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Help overflowed at 320px')
      await summary.press('Space')
      await note.waitFor({ state: 'hidden' })
      Object.assign(state.remote, { state: 'connecting' })
      await pollRemote()
      await summary.waitFor({ state: 'hidden' })
      assert.deepEqual(writes, [], 'Folder guidance must not call an admin write route')
    })
  cases++
  for (const provider of ['cloudflared', 'cpolar', 'iroh']) {
    await withControl(browser, `${provider} actions require installation; stable three-button row`, {}, async ({ page, state, consumed, settle, openRemote, pollRemote, count }) => {
      await openRemote()
      state.remote.providers[provider] = { component: { installed: false, supported: true, configured: true }, configuration: { configured: true, mode: 'quick' } }
      let before = await consumed(`${prefix}/remote/provider`)
      await page.locator('.dsh-mobile-control__provider').filter({ has: page.locator('strong').filter({ hasText: new RegExp(`^${provider}\\b`, 'u') }) }).click()
      await settle(`${prefix}/remote/provider`, before)
      const row = page.locator('.dsh-mobile-control__remote-workspace > .dsh-mobile-control__actions')
      assert.equal(await row.isVisible(), false, 'Uninstalled component exposed its remote action row')
      assert.equal(await row.evaluate(node => getComputedStyle(node).display), 'none', 'Action layout overrode hidden')
      state.remote.providers[provider].component.installed = true
      await pollRemote()
      assert.equal(await row.isVisible(), true)
      assert.equal(await row.locator('button:visible').count(), 3)
      const boxes = await row.locator('button:visible').evaluateAll(buttons => buttons.map(button => {
        const rect = button.getBoundingClientRect(); return { y: rect.y, width: rect.width }
      }))
      assert(boxes.every(box => Math.abs(box.y - boxes[0].y) < 1 && Math.abs(box.width - boxes[0].width) < 1), 'Three actions no longer share one row')
      if (provider !== 'iroh') return
      const copy = row.getByRole('button', { name: 'Copy pairing link', exact: true })
      assert.equal(await copy.isVisible(), true)
      assert.equal(await copy.isDisabled(), true, 'An empty descriptor was copyable')
      Object.assign(state.remote, { running: true, state: 'ready', origin: 'https://owned.iroh.localhost:3444' })
      await pollRemote()
      assert.equal(await copy.isDisabled(), true)
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async text => { window.fixtureCopiedIroh = text } } }) })
      const path = `${prefix}/remote/iroh/pairing/begin`
      before = await consumed(path)
      await row.getByRole('button', { name: 'Generate iroh pairing QR code', exact: true }).click()
      await settle(path, before)
      await pollRemote()
      assert.equal(await copy.isEnabled(), true)
      await copy.click()
      await waitUntil(() => page.evaluate(() => window.fixtureCopiedIroh), value => typeof value === 'string', 'iroh descriptor copy')
      assert.equal(JSON.parse(await page.evaluate(() => window.fixtureCopiedIroh)).irohCode, '123456')
      assert.equal(count('POST', path), 1, 'Copy reminted a pairing window')
      const qr = page.locator('.dsh-mobile-control__qr.is-expandable')
      assert.equal(await qr.isVisible(), true)
      state.irohQrUnavailable = true
      before = await consumed(path)
      await row.getByRole('button', { name: 'Generate iroh pairing QR code', exact: true }).click()
      await settle(path, before)
      await pollRemote()
      assert.equal(await qr.isVisible(), false, 'A failed QR render left the previous code visible')
      assert.equal(await copy.isEnabled(), true, 'A valid descriptor lost its copy fallback')
      assert.equal(await page.getByText('The QR image could not be generated.', { exact: false }).isVisible(), true)
      await copy.click()
      await waitUntil(() => page.evaluate(() => JSON.parse(window.fixtureCopiedIroh).irohCode),
        value => value === '654321', 'the current descriptor despite missing QR artwork')
      assert.equal(count('POST', path), 2, 'The fallback copy reminted a pairing window')
      state.irohQrUnavailable = false
      before = await consumed(path)
      await row.getByRole('button', { name: 'Generate iroh pairing QR code', exact: true }).click()
      await settle(path, before)
      await qr.locator('img').waitFor({ state: 'visible' })
      await qr.focus()
      await qr.press('Enter')
      const zoom = page.locator('.dsh-mobile-control__qr-zoom')
      await zoom.waitFor({ state: 'visible' })
      await page.clock.fastForward(300_001)
      await pollRemote()
      assert.equal(await copy.isVisible(), true)
      assert.equal(await copy.isDisabled(), true, 'Expired descriptor was copyable')
      assert.equal(await qr.locator('img').count(), 0, 'Expired QR artwork remained inline')
      assert.equal(await zoom.isVisible(), false, 'Expired QR artwork remained zoomed')
    })
    cases++
  }
  for (const remote of [false, true]) {
    await withControl(browser, `${remote ? 'remote' : 'LAN'} QR expiry and explicit copy`, {}, async ({ page, state, count, consumed, settle, openRemote, pollRemote }) => {
      if (remote) {
        Object.assign(state.remote, { running: true, state: 'ready', origin: 'https://fixture.example' })
        await openRemote()
      }
      const catalog = await page.evaluate(() => window.mobileClient.MOBILE_CONTROL_MESSAGES.en)
      const path = `${prefix}/${remote ? 'remote' : 'lan'}/pairing/open`
      const pane = page.locator(remote ? '.dsh-mobile-control__remote-workspace' : '.dsh-mobile-control__channel-pane > .dsh-mobile-control__view')
      await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true,
        value: { writeText: async text => { window.fixtureCopiedPairing = text } } }) })
      const previous = await consumed(path)
      await pane.getByRole('button', { name: catalog[remote ? 'generateRemoteQr' : 'generateCopyKey'], exact: true }).click()
      await settle(path, previous)
      assert.equal(await pane.locator('.dsh-mobile-control__qr img').count(), 1)
      const actions = await pane.locator(':scope > .dsh-mobile-control__actions > button:visible').evaluateAll(buttons => buttons.map(button => {
        const { x, y, width, height } = button.getBoundingClientRect()
        return { x, y, width, height }
      }))
      assert.equal(actions.length, 3, 'The ready channel must keep its three primary actions')
      assert(actions.every(action => Math.abs(action.y - actions[0].y) < 1 && Math.abs(action.width - actions[0].width) < 1), `Primary actions did not remain a single equal-width row: ${JSON.stringify(actions)}`)
      assert.equal(await pane.locator('.dsh-mobile-control__stage-header').count(), 0, 'Removed current-connection row returned')
      await pollRemote()
      assert.equal(await pane.getByText(/^Pairing QR valid until/u).isVisible(), true, 'Poll hid a valid pairing deadline')
      await pane.getByRole('button', { name: catalog[remote ? 'copyRemoteLink' : 'copyPairLink'], exact: true }).click()
      await waitUntil(() => page.evaluate(() => window.fixtureCopiedPairing), value => typeof value === 'string', 'explicit copy')
      assert.equal(count('POST', path), 1, 'Copy unexpectedly invalidated the displayed QR')
      await page.clock.fastForward(120_000)
      await pollRemote()
      assert.equal(await pane.locator('.dsh-mobile-control__qr img').count(), 0, 'Expired QR remained visible')
      assert.equal(await pane.getByText(catalog.pairingExpired, { exact: true }).first().isVisible(), true)
      await pollRemote()
      assert.equal(await pane.getByText(catalog.pairingExpired, { exact: true }).first().isVisible(), true, 'Next poll erased expiry')
      assert.equal(count('POST', path), 1, 'Polling silently generated a new pairing token')
    })
    cases++
  }
  await withControl(browser, 'named cloudflared save-and-connect keeps one busy owner', {}, async ({ page, state, count, consumed, settle, waitRequest, openRemote, pollRemote }) => {
    await openRemote()
    state.remote.providers.cloudflared = { component: { installed: true, supported: true }, configuration: { mode: 'named', configured: false } }
    let previous = await consumed(`${prefix}/remote/provider`)
    await page.getByRole('radio', { name: /^cloudflared\b/u }).click()
    await settle(`${prefix}/remote/provider`, previous)
    const catalog = await page.evaluate(() => window.mobileClient.MOBILE_CONTROL_MESSAGES.en)
    await page.getByRole('button', { name: new RegExp(`^${catalog.cloudflaredShowConfig}`, 'u') }).click()
    const host = page.getByLabel(catalog.cloudflaredTunnelHostname, { exact: true })
    const port = page.getByLabel(catalog.cloudflaredTunnelPort, { exact: true })
    const token = page.getByLabel(catalog.cloudflaredTunnelToken, { exact: true })
    assert.equal(await host.isEnabled(), true, 'Incomplete saved named settings were locked')
    await host.fill('https://owned-fixture.example')
    await port.fill('3444')
    await token.fill('a'.repeat(40))
    state.holdCloudflared = true
    const path = `${prefix}/remote/cloudflared/tunnel`
    previous = await consumed(path)
    await page.getByRole('button', { name: catalog.cloudflaredTunnelSave, exact: true }).click()
    const saved = await waitRequest('POST', path)
    assert.equal(saved.body.connect, true)
    assert.equal(await host.isDisabled(), true)
    assert.equal(await page.locator('.dsh-mobile-control__provider.is-iroh').isDisabled(), true)
    await pollRemote()
    assert.equal(await host.isDisabled(), true, 'Poll unlocked an in-flight save')
    Object.assign(state.remote, { running: true, state: 'connecting' })
    state.remote.providers.cloudflared.configuration = { mode: 'named', configured: true, hostname: saved.body.hostname, port: 3444 }
    const held = state.pendingCloudflared
    assert(held !== undefined, 'Save fixture did not retain its response')
    held.writeHead(200, { 'content-type': 'application/json' }); held.end(JSON.stringify(state.remote))
    await settle(path, previous)
    assert.equal(count('POST', remotePath), 0, 'Save-and-connect used a second raceable control request')
    assert.equal(await token.inputValue(), '')
    assert.equal(await page.getByText(catalog.cloudflaredTunnelSaved, { exact: true }).isVisible(), true)
    assert.equal(await page.getByRole('button', { name: catalog.cloudflaredEditConfig, exact: true }).isVisible(), true)
    assert.equal(await page.getByText('Saved and connected.', { exact: true }).count(), 0)
  })
  cases++
  for (const touch of [false, true]) {
    await withControl(browser, `cloudflared notes and modal keyboard ${touch ? 'touch' : 'pointer'}`, { touch, width: touch ? 390 : 1100 }, async ({ page, state, consumed, settle, openRemote }) => {
      await openRemote()
      state.remote.providers.cloudflared = { component: { installed: true, supported: true }, configuration: { mode: 'quick', configured: false } }
      const before = await consumed(`${prefix}/remote/provider`)
      await page.getByRole('radio', { name: /^cloudflared\b/u }).click()
      await settle(`${prefix}/remote/provider`, before)
      const notes = page.locator('.dsh-mobile-control__notes-panel')
      const toggle = page.locator('.dsh-mobile-control__notes-toggle')
      await page.mouse.move(1090, 890)
      await toggle.focus()
      await page.keyboard.press('Enter')
      assert.equal(await notes.isVisible(), true, 'Keyboard could not open tunnel notes')
      await page.keyboard.press('Escape')
      assert.equal(await notes.isVisible(), false)
      assert.equal(await page.locator('.dsh-mobile-control__panel').isVisible(), true, 'Notes Escape also closed the whole panel')
      if (touch) {
        await toggle.tap()
        assert.equal(await notes.isVisible(), true, 'Touch could not open tunnel notes')
        await toggle.tap()
        assert.equal(await notes.isVisible(), false, 'Touch could not dismiss tunnel notes')
      }
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('.dsh-mobile-control__panel').isVisible(), false)
      assert.equal(await page.locator('.dsh-mobile-control__trigger').evaluate(node => document.activeElement === node), true, 'Closing did not restore trigger focus')
    })
    cases++
  }
  for (const language of ['en', 'it', 'zh']) {
    await withControl(browser, `FRP field validation ${language}`, {
      layoutFixture: true, frpFixture: true, language, width: 360,
      locale: language === 'zh' ? 'zh-CN' : language === 'it' ? 'it-IT' : 'en-US',
    }, async ({ page, state, count, waitRequest, consumed, settle, openRemote }) => {
      if (language === 'zh') await page.evaluate(() => {
        document.documentElement.style.colorScheme = 'dark'
        for (const [name, value] of Object.entries({
          '--dsw-alias-bg-layer-1': '#202225', '--dsw-alias-bg-layer-2': '#292b30',
          '--dsw-alias-label-primary': '#f2f3f5', '--dsw-alias-label-secondary': '#b9bdc6',
          '--dsw-alias-border-l2': '#454850', '--dsw-alias-border-l3': '#60646d',
          '--dsw-alias-state-error-primary': '#ff9494',
        })) document.documentElement.style.setProperty(name, value)
      })
      await openRemote()
      const previous = await consumed(`${prefix}/remote/provider`)
      await page.locator('.dsh-mobile-control__provider.is-frp').click()
      await settle(`${prefix}/remote/provider`, previous)
      const field = name => page.locator(`#dsh-mobile-frp-${name}`)
      const configure = page.locator('button[aria-describedby="dsh-mobile-frp-action-hint"]')
      assert.equal(await configure.count(), 1, 'FRP configure action must be uniquely identifiable')
      const postPath = `${prefix}/remote/frp/configure`
      await field('serverAddress').fill('https://frp.example.com:7000')
      await field('serverPort').fill('0')
      await field('token').fill('short')
      await field('publicOrigin').fill('1.2.3.4:33080')
      await configure.click()
      assert.equal(count('POST', postPath), 0, 'Invalid fields issued a configure request')
      assert.equal(await field('serverAddress').evaluate(node => document.activeElement === node), true, 'First invalid field was not focused')
      for (const name of ['serverAddress', 'serverPort', 'token', 'publicOrigin']) {
        assert.equal(await field(name).getAttribute('aria-invalid'), 'true')
        const error = page.locator(`#dsh-mobile-frp-${name}-error`)
        assert.equal(await error.isVisible(), true, `${name}: inline error is not visible`)
        assert((await error.textContent()).length > 15, `${name}: error has no specific guidance`)
        assert((await field(name).getAttribute('aria-describedby')).includes(`dsh-mobile-frp-${name}-error`))
      }
      const screenshots = process.env.DSH_CONTROL_LAYOUT_SCREENSHOT_DIR
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await page.screenshot({ path: resolve(screenshots, `frp-validation-${language}.png`) })
      }
      await field('serverAddress').fill('frp.example.com')
      await field('serverPort').fill('7000')
      await field('token').fill('fixture-token-not-a-secret-012345')
      await field('publicOrigin').fill('https://1.2.3.4')
      assert.equal(await page.locator('.dsh-mobile-control__frp-fields [aria-invalid=true]').count(), 0, 'Corrected fields kept errors')
      const vpsGroup = page.locator('.dsh-mobile-control__frp-group').nth(1)
      const sshFields = vpsGroup.locator('.dsh-mobile-control__frp-fields')
      const copy = await page.evaluate(locale => window.mobileClient.MOBILE_CONTROL_MESSAGES[locale], language)
      const openVps = async () => { if (!await vpsGroup.evaluate(node => node.open)) await vpsGroup.locator('summary').click() }
      await openVps()
      await sshFields.locator('input').nth(0).fill('owned-fixture-user')
      await sshFields.locator('input').nth(1).fill('2222')
      await sshFields.locator('input').nth(2).fill('/owned-fixture/key')
      const checkMode = async attach => {
        await openVps()
        assert.deepEqual({ title: await vpsGroup.locator('summary').textContent(), display: await sshFields.evaluate(node => getComputedStyle(node).display), visible: await sshFields.isVisible() },
          { title: attach ? copy.frpStep2TitleAttach : copy.frpStep2Title, display: attach ? 'none' : 'grid', visible: !attach }, 'FRP step-2 heading and SSH fields disagree with attach/deploy mode')
        assert.equal(await vpsGroup.getByRole('button', { name: copy.vpsDeploy, exact: true }).isVisible(), !attach)
        if (attach) {
          for (const name of [copy.frpAttachPlan, copy.frpAttachToken]) {
            assert.equal(await vpsGroup.getByRole('button', { name, exact: true }).isVisible(), true, 'An attach action disappeared with the SSH fields')
          }
        }
        assert.equal(await vpsGroup.getByRole('button', { name: copy.frpAttachSelfCheck, exact: true }).isVisible(), false, 'Self-check appeared before FRP configuration was saved')
      }
      await checkMode(false)
      await field('mode').selectOption('attach')
      await checkMode(true)
      await field('mode').selectOption('deploy')
      await checkMode(false)
      assert.deepEqual(await sshFields.locator('input').evaluateAll(nodes => nodes.map(node => node.value)), ['owned-fixture-user', '2222', '/owned-fixture/key'], 'Changing mode discarded SSH draft fields')
      await field('mode').selectOption('attach')
      await checkMode(true)
      assert.equal(count('POST', postPath), 0, 'Changing mode silently saved configuration')
      assert.equal(count('POST', `${prefix}/remote/frp/vps/deploy`), 0, 'Changing mode started VPS deployment')
      await configure.click()
      assert.equal(await field('vhostHttpPort').getAttribute('aria-invalid'), 'true')
      await field('entryTls').selectOption('self-signed')
      assert.equal(await field('vhostHttpPort').getAttribute('aria-invalid'), null, 'Hidden vhost field kept a stale error')
      await field('publicPort').fill('3443')
      await field('publicOrigin').fill('https://1.2.3.4:33080')
      await configure.click()
      assert.equal(count('POST', postPath), 0)
      assert.equal(await field('publicOrigin').evaluate(node => document.activeElement === node), true)
      assert.equal(await field('publicPort').getAttribute('aria-invalid'), 'true')
      assert((await page.locator('#dsh-mobile-frp-publicOrigin-error').textContent()).includes('https://'))
      await field('publicOrigin').fill('http://1.2.3.4')
      await configure.click()
      assert.equal(count('POST', postPath), 0, 'HTTP origin was accepted')
      await field('entryTls').selectOption('public-ip-cert')
      await field('vhostHttpPort').fill('0')
      await configure.click()
      assert.equal(await field('vhostHttpPort').getAttribute('aria-invalid'), 'true', 'Invalid vhost port became a default')
      assert.equal(await field('publicPort').getAttribute('aria-invalid'), null, 'Hidden public port retained an error')
      await field('vhostHttpPort').fill('7080')
      await field('entryTls').selectOption('self-signed')
      await field('publicOrigin').fill('https://1.2.3.4')
      await field('publicPort').fill('33080')
      state.frpConfigureError = 'frp_public_origin_invalid'
      const rejected = await consumed(postPath)
      await configure.click()
      await settle(postPath, rejected)
      assert.equal(count('POST', postPath), 1)
      assert.equal(await field('publicOrigin').getAttribute('aria-invalid'), 'true', 'Host validation error did not identify its field')
      state.frpConfigureError = undefined
      await field('publicOrigin').fill('https://1.2.3.4/')
      const accepted = await consumed(postPath)
      await configure.click()
      await settle(postPath, accepted)
      assert.equal(count('POST', postPath), 2)
      assert.equal(await page.locator('.dsh-mobile-control__frp-fields [aria-invalid=true]').count(), 0)
      assert.equal(await field('publicOrigin').locator('..').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'Field feedback overflowed the narrow panel')
      await field('publicPort').fill('3443')
      await field('entryTls').selectOption('public-ip-cert')
      await field('token').fill('fixture-token-not-a-secret-012345')
      state.holdFrpConfigure = true
      const publicCa = await consumed(postPath)
      await configure.click()
      const held = await waitRequest('POST', postPath, 2)
      assert.equal(await configure.isDisabled(), true)
      assert.equal(await page.locator('#dsh-mobile-frp-action-hint').isVisible(), true, 'Busy save had no explanation')
      assert((await page.locator('#dsh-mobile-frp-action-hint').textContent()).length > 15)
      held.release(200, state.remote)
      await settle(postPath, publicCa)
      assert.equal(count('POST', postPath), 3, 'A hidden self-signed port prevented saving public-CA settings')
    })
    cases++
  }
  await withControl(browser, 'FRP missing component explains disabled save', {
    layoutFixture: true, frpFixture: true, frpInstalled: false,
  }, async ({ page, state, count, waitRequest, consumed, settle, openRemote }) => {
    await openRemote()
    const refreshBefore = count('GET', remotePath)
    const refreshConsumed = await consumed(remotePath)
    state.holdNextRemote = true
    const previous = await consumed(`${prefix}/remote/provider`)
    await page.locator('.dsh-mobile-control__provider.is-frp').click()
    await settle(`${prefix}/remote/provider`, previous)
    const refresh = await waitRequest('GET', remotePath, refreshBefore)
    assert.equal(typeof refresh.release, 'function', 'Provider refresh was not held')
    const hint = page.locator('#dsh-mobile-frp-action-hint')
    const provider = page.locator('.dsh-mobile-control__provider.is-frp')
    const install = page.getByRole('button', { name: 'Install official frpc', exact: true })
    assert.match(await hint.textContent(), /remote operation is in progress/u)
    assert.equal(await provider.isDisabled(), true)
    assert.equal(await install.isDisabled(), true)
    assert.equal(await page.locator('button[aria-describedby="dsh-mobile-frp-action-hint"]').isDisabled(), true)
    refresh.release()
    await settle(remotePath, refreshConsumed)
    await waitUntil(async () => ({ provider: await provider.isEnabled(), install: await install.isEnabled() }),
      enabled => enabled.provider && enabled.install, 'FRP provider refresh idle controls')
    assert.equal(await hint.isVisible(), true)
    assert.match(await hint.textContent(), /Install.*frpc/u)
    assert.equal(await page.locator('button[aria-describedby="dsh-mobile-frp-action-hint"]').isDisabled(), true)
  })
  cases++
  for (const language of ['en', 'it', 'zh']) {
    const codes = ['sidecar_exited', 'some_unknown_future_code', 'funnel_https_required', 'cloudflared_invalid_output', 'future_<img src=x onerror=alert(1)>']
    const diagnostics = {
      overall: 'error', generatedAt: Date.UTC(2026, 0, 1, 12),
      checks: codes.map(controllerCode => ({
        id: 'remote', status: 'error', reason: 'remote-controller-error',
        label: 'Remote', detail: 'Host fallback detail', action: 'Host fallback action',
        facts: { provider: 'tailscale', controllerCode },
      })),
    }
    await withControl(browser, `Funnel authorization and diagnostic copy ${language}`, {
      layoutFixture: true, language, locale: language === 'zh' ? 'zh-CN' : language === 'it' ? 'it-IT' : 'en-US',
      width: 360, diagnostics,
    }, async ({ page, state, consumed, settle, openRemote, pollRemote }) => {
      await openRemote()
      Object.assign(state.remote, {
        provider: 'tailscale', running: true, state: 'error', errorCode: 'funnel_https_required',
        setupUrl: 'https://tailscale.com/s/https',
      })
      await pollRemote()
      const guide = page.locator('[data-dsh-mobile-guide="funnel"]')
      const authorize = guide.locator('.dsh-mobile-control__primary')
      assert.equal(await guide.isVisible(), true, 'The authorization error did not expose its setup guide')
      assert.equal(await authorize.isEnabled(), true, 'The authorization button was disabled')
      await page.evaluate(() => {
        window.fixtureOpenedUrls = []
        window.open = url => { window.fixtureOpenedUrls.push(String(url)); return null }
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async text => { window.fixtureCopiedReport = text },
        } })
      })
      await authorize.click()
      assert.deepEqual(await page.evaluate(() => window.fixtureOpenedUrls), ['https://tailscale.com/s/https'])
      const previous = await consumed(`${prefix}/diagnostics`)
      const diagnosticName = await page.evaluate(locale => window.mobileClient.MOBILE_CONTROL_MESSAGES[locale].openDiagnostics, language)
      await page.getByRole('button', { name: diagnosticName, exact: true }).click()
      await settle(`${prefix}/diagnostics`, previous)
      const rows = page.locator('.dsh-mobile-control__diagnostic-check')
      assert.equal(await rows.count(), codes.length)
      const catalog = await page.evaluate(locale => ({
        messages: window.mobileClient.MOBILE_CONTROL_MESSAGES[locale],
        templates: window.mobileClient.DIAGNOSTIC_REASON_MESSAGES[locale]['remote-controller-error'],
      }), language)
      const report = await page.locator('.dsh-mobile-control__diagnostic-report').textContent()
      const actions = [catalog.messages.controlChannelFailed, catalog.templates[1], catalog.messages.funnelHttps, catalog.messages.cloudflaredOutputInvalid, catalog.templates[1]]
      for (const [index, code] of codes.entries()) {
        const expectedDetail = catalog.templates[0].replace('{provider}', 'Tailscale Funnel').replace('{controllerCode}', code)
        assert.equal(await rows.nth(index).locator('.dsh-mobile-control__diagnostic-check-body > p').first().textContent(), expectedDetail)
        assert.equal(await rows.nth(index).locator('.dsh-mobile-control__diagnostic-action').textContent(), catalog.messages.diagnosticAction + actions[index])
        assert(report.includes(expectedDetail + ' ' + actions[index]), 'Copied report diverged from the visible diagnostic')
      }
      assert.equal(await rows.locator('img').count(), 0, 'An error code was interpreted as HTML')
      await page.locator('.dsh-mobile-control__diagnostic-copy').click()
      assert.equal(await page.evaluate(() => window.fixtureCopiedReport), report)
    })
    cases++
  }
  for (const language of ['en', 'it', 'zh']) {
    const checks = [
      { id: 'remote-service', status: 'ok', reason: 'remote-service-ready', scope: 'computer', facts: { provider: 'tailscale' } },
      { id: 'remote-dns', status: 'info', reason: 'dns-tailnet', scope: 'computer' },
      { id: 'remote', status: 'warning', reason: 'remote-tailnet-shadowed', scope: 'computer' },
      { id: 'phone-network', status: 'info', reason: 'phone-network-unknown', scope: 'phone' },
    ].map(entry => ({ ...entry, label: 'Host label', detail: 'Host fallback', action: '' }))
    await withControl(browser, `Diagnostic measurement scope ${language}`, {
      layoutFixture: true, language, locale: language === 'zh' ? 'zh-CN' : language === 'it' ? 'it-IT' : 'en-US', width: 360,
      diagnostics: { version: 1, overall: 'attention', generatedAt: Date.UTC(2026, 10, 2), checks },
    }, async ({ page, consumed, settle }) => {
      const previous = await consumed(`${prefix}/diagnostics`)
      const name = await page.evaluate(locale => window.mobileClient.MOBILE_CONTROL_MESSAGES[locale].openDiagnostics, language)
      await page.getByRole('button', { name, exact: true }).click()
      await settle(`${prefix}/diagnostics`, previous)
      const scopeCopy = await page.evaluate(locale => window.mobileClient.DIAGNOSTIC_SCOPE_MESSAGES[locale], language)
      const rows = page.locator('.dsh-mobile-control__diagnostic-check')
      assert.equal(await rows.count(), checks.length)
      assert.equal(await rows.locator('.dsh-mobile-control__diagnostic-scope').count(), checks.length)
      assert.equal(await rows.filter({ has: page.getByText(scopeCopy.phone, { exact: true }) }).count(), 1)
      const report = await page.locator('.dsh-mobile-control__diagnostic-report').textContent()
      assert(report.includes(scopeCopy.coverage) && report.includes(`[${scopeCopy.computer}]`) && report.includes(`[${scopeCopy.phone}]`), 'Copied report dropped measurement limits')
      const expected = await page.evaluate(locale => window.mobileClient.DIAGNOSTIC_NETWORK_MESSAGES[locale]['remote-tailnet-shadowed'][0], language)
      assert(report.includes(expected), 'Copied report lost the localized tailnet caveat')
      assert.equal(await rows.filter({ hasText: expected }).count(), 1)
      assert.equal(await page.locator('body').evaluate(node => node.scrollWidth <= window.innerWidth + 1), true, 'Diagnostic copy overflowed the narrow viewport')
    })
    cases++
  }

  await withControl(browser, 'managed readiness uses server truth, not the HTTPS form preview', { managedReady: true }, async ({ page, state, ui, count, openRemote, pollRemote }) => {
    const badge = page.locator('.dsh-mobile-control__provider.is-origin .dsh-mobile-control__provider-badge')
    const notice = page.locator('.dsh-mobile-control__remote-workspace .dsh-mobile-control__status[aria-live="polite"]')
    const assertManaged = async () => {
      assert.equal(await badge.textContent(), 'Ready')
      assert.equal(await notice.textContent(), 'Managed HTTPS entry verified for this computer.')
    }
    await assertManaged() // initial mount, before opening the remote tab
    await openRemote()
    assert.equal(await ui.managed.isChecked(), true)
    await assertManaged()
    await pollRemote()
    assert.equal(await ui.managed.isChecked(), true)
    await page.locator('.dsh-mobile-control__close').click()
    await page.locator('.dsh-mobile-control__trigger').click()
    await assertManaged()
    // A different controller changes the server mode; a clean form follows it.
    state.remote.originMode = 'external'
    state.remote.caddyState = { enabled: false, state: 'off' }
    state.remote.origin = state.remote.providers.origin.configuration.publicOrigin
    await pollRemote()
    assert.equal(await ui.external.isChecked(), true)
    assert.equal(await badge.textContent(), 'Backend listening')
    assert.match(await notice.textContent(), /have NOT been verified/u)
    state.remote.originMode = 'managed'
    state.remote.caddyState = { enabled: true, state: 'ready' }
    await pollRemote()
    assert.equal(await ui.managed.isChecked(), true, 'Clean external form did not follow the server back to managed')
    await assertManaged()
    state.remote.originMode = 'external'
    state.remote.caddyState = { enabled: false, state: 'off' }
    await pollRemote()
    // Selecting managed only previews the form, not the current connection.
    await ui.managed.check()
    await ui.caddyDomain.fill('https://unsaved-caddy.example.com:9443')
    await pollRemote()
    assert.equal(await ui.managed.isChecked(), true)
    assert.equal(await badge.textContent(), 'Backend listening')
    assert.equal(await page.getByText('HTTPS form preview differs from the current connection.', { exact: true }).isVisible(), true)
    // Another server mode change updates the summary without discarding edits.
    state.remote.originMode = 'managed'
    state.remote.caddyState = { enabled: true, state: 'ready' }
    state.remote.origin = 'https://saved-caddy.example.com:8443'
    await pollRemote()
    await assertManaged()
    assert.equal(await ui.caddyDomain.inputValue(), 'https://unsaved-caddy.example.com:9443')
    assert.equal(count('POST', modePath), 0)
    assert.equal(count('POST', caddyPath), 0)
  })
  cases++

  await withControl(browser, 'retained external preview cannot mislabel a server-managed connection', { managedReady: true }, async ({ page, state, ui, count, openRemote, pollRemote }) => {
    await openRemote()
    // First follow an external server mode, then explicitly stage and return to
    // its external form. This exercises the existing retained-preview policy.
    state.remote.originMode = 'external'
    state.remote.caddyState = { enabled: false, state: 'off' }
    await pollRemote()
    await ui.originPublic.fill('https://unsaved-proxy.example.com:8816')
    await ui.managed.check()
    await ui.external.check()
    state.remote.originMode = 'managed'
    state.remote.caddyState = { enabled: true, state: 'ready' }
    await pollRemote()
    assert.equal(await ui.external.isChecked(), true, 'Server change discarded the intentional external preview')
    assert.equal(await ui.originPublic.inputValue(), 'https://unsaved-proxy.example.com:8816')
    assert.equal(await page.locator('.dsh-mobile-control__provider.is-origin .dsh-mobile-control__provider-badge').textContent(), 'Ready')
    assert.equal(await page.locator('.dsh-mobile-control__remote-workspace .dsh-mobile-control__status[aria-live="polite"]').textContent(), 'Managed HTTPS entry verified for this computer.')
    assert.equal(await page.getByText('HTTPS form preview differs from the current connection.', { exact: true }).isVisible(), true)
    await page.locator('.dsh-mobile-control__close').click()
    await page.locator('.dsh-mobile-control__trigger').click()
    await pollRemote()
    assert.equal(await ui.external.isChecked(), true, 'Reopening discarded the intentional preview')
    assert.equal(count('POST', modePath), 0, 'Server snapshot/preview replay mutated the origin mode')
    assert.equal(count('POST', caddyPath), 0)
    assert.equal(count('POST', `${prefix}/remote/origin/configure`), 0)
  })
  cases++

  // Render the real client/CSS: a hidden attribute alone does not prove a
  // display:grid form is hidden, and jsdom cannot measure radio geometry.
  for (const language of ['en', 'zh', 'it']) for (const width of [320, 360, 1100]) {
    const dark = language === 'zh' || width === 360
    const installed = width !== 320
    const supported = !(language === 'it' && width === 360)
    await withControl(browser, `HTTPS layout ${language} ${width}px ${dark ? 'dark' : 'light'}`, {
      layoutFixture: true, width, language, caddyInstalled: installed, caddySupported: supported,
    }, async ({ page, ui, count, consumed, settle, openRemote }) => {
      if (dark) await page.evaluate(() => {
        document.documentElement.style.colorScheme = 'dark'
        for (const [key, value] of Object.entries({
          'bg-layer-1': '#222', 'bg-layer-2': '#292929', 'bg-layer-3': '#303030',
          'label-primary': '#eee', 'label-secondary': '#bbb', 'border-l2': '#444', 'border-l3': '#555',
        })) document.documentElement.style.setProperty(`--dsw-alias-${key}`, value)
      })
      await openRemote()
      const setup = page.locator('.dsh-mobile-control__origin-setup')
      const externalFields = setup.locator('.dsh-mobile-control__origin-fields').first()
      const managedFields = setup.locator('.dsh-mobile-control__origin-fields').last()
      const backend = setup.locator('.dsh-mobile-control__origin-backend')
      const assertGeometry = async () => {
        const geometry = await setup.evaluate(node => {
          const rect = element => {
            const { x, y, width, height } = element.getBoundingClientRect()
            return { x, y, width, height }
          }
          const visible = element => element.getClientRects().length !== 0
          return {
            bounds: rect(node), overflow: node.scrollWidth > node.clientWidth + 1,
            radios: [...node.querySelectorAll('input[type=radio]')].map(input => ({
              input: rect(input), label: rect(input.parentElement), text: rect(input.nextElementSibling),
            })),
            fields: [...node.querySelectorAll('.dsh-mobile-control__field')].filter(visible).map(rect),
            controls: [...node.querySelectorAll('.dsh-mobile-control__field input,.dsh-mobile-control__field select')].filter(visible).map(rect),
            actions: [...node.querySelectorAll('.dsh-mobile-control__caddy-actions button')].filter(visible).map(rect),
            columns: getComputedStyle([...node.querySelectorAll('.dsh-mobile-control__origin-fields')].find(visible)).gridTemplateColumns.split(' ').length,
          }
        })
        assert.equal(geometry.overflow, false, 'HTTPS card has horizontal overflow')
        for (const { input, label, text } of geometry.radios) {
          assert(input.width >= 16 && input.width <= 22 && input.height >= 16 && input.height <= 22, 'Radio inherited text-input sizing')
          assert(label.height >= 44, 'Mode label lost its touch target')
          assert(text.x >= input.x + input.width, 'Mode text is not beside its radio')
        }
        for (const field of geometry.fields) {
          assert(field.x >= geometry.bounds.x && field.x + field.width <= geometry.bounds.x + geometry.bounds.width + 1, 'Field escaped the card')
        }
        for (const control of geometry.controls) assert(control.height >= 44 && control.height <= 48, 'Input/select heights differ')
        for (const action of geometry.actions) {
          assert(action.height >= 44 && action.height <= 72, `Action stretched to a note height: ${JSON.stringify(geometry)}`)
          assert(action.width >= geometry.bounds.width - 28, 'Caddy action did not span the form width')
        }
        const columns = geometry.bounds.width - 26 >= 292 ? 2 : 1
        assert.equal(geometry.columns, columns, 'Fields did not adapt to the available card width')
        const index = await ui.managed.isChecked() ? 2 : 1
        const [left, right] = geometry.fields.slice(index, index + 2)
        if (columns === 2) {
          assert(Math.abs(left.y - right.y) <= 1 && right.x >= left.x + left.width, 'Wide-card field pair is not actually side by side')
        } else {
          assert(right.y >= left.y + left.height && Math.abs(left.x - right.x) <= 1, 'Narrow-card fields are not stacked')
        }
      }
      assert.equal(await ui.managed.isChecked(), true)
      await assertGeometry()
      assert.equal(await externalFields.isVisible(), false, 'External fields remain visible in managed mode')
      assert.equal(await managedFields.isVisible(), true)
      assert.equal(await backend.isVisible(), false, 'Managed mode leaked the external backend block')
      assert.equal(await setup.locator('fieldset').getAttribute('aria-label'), null, 'Use the visible legend as the native group name')
      assert.equal(await setup.locator('fieldset legend').isVisible(), true)
      const caddyActions = setup.locator('.dsh-mobile-control__caddy-actions')
      assert.equal(await caddyActions.locator('button').first().isVisible(), !installed)
      assert.equal(await caddyActions.locator('button').nth(1).isVisible(), installed)
      if (!supported) assert.equal(await managedFields.locator('input,select').first().isDisabled(), true)
      const screenshots = process.env.DSH_CONTROL_LAYOUT_SCREENSHOT_DIR
      // Expand only for capture so the popup's scrolling viewport does not
      // clip the first/last rows of a tall narrow-screen card.
      const screenshotStyle = '.dsh-mobile-control__panel{max-height:none!important;overflow:visible!important}.dsh-mobile-control{position:absolute!important;top:0!important;bottom:auto!important}'
      if (screenshots !== undefined) {
        await mkdir(screenshots, { recursive: true })
        await setup.screenshot({ path: resolve(screenshots, `managed-${language}-${width}.png`), style: screenshotStyle })
      }
      const before = await consumed(modePath)
      const recoveryBefore = await consumed(remotePath)
      // Click the label rather than the small circle; keep the existing mode
      // confirmation/controller request and draft-preservation behavior.
      await ui.external.locator('..').click()
      await settle(modePath, before)
      await settle(remotePath, recoveryBefore)
      await waitUntil(() => ui.external.isDisabled(), disabled => !disabled, 'external mode enabled')
      assert.equal(await externalFields.isVisible(), true)
      assert.equal(await managedFields.isVisible(), false, 'Caddy fields remain visible in external mode')
      assert.equal(await backend.isVisible(), true)
      await assertGeometry()
      if (screenshots !== undefined) await setup.screenshot({ path: resolve(screenshots, `external-${language}-${width}.png`), style: screenshotStyle })
      await ui.external.focus()
      await ui.external.press('ArrowDown')
      assert.equal(await ui.managed.isChecked(), true, 'Native keyboard mode selection broke')
      assert.equal(await externalFields.isVisible(), false)
      assert.equal(await managedFields.isVisible(), true)
      assert.equal(count('POST', modePath), 1, 'Managed preview must not write the mode before saving')
      assert.equal(count('POST', caddyPath), 0, 'Changing layout/preview must not save credentials')
    })
    cases++
  }

  await withControl(browser, 'canceling HTTPS mode change keeps the active form and sends no write', { cancelDialogs: true }, async ({ page, ui, count, openRemote }) => {
    await openRemote()
    await ui.external.locator('..').click()
    assert.equal(await ui.managed.isChecked(), true)
    assert.equal(await ui.external.isChecked(), false)
    assert.equal(await page.locator('.dsh-mobile-control__caddy-form').isVisible(), true)
    assert.equal(await ui.originPublic.isVisible(), false)
    assert.equal(count('POST', modePath), 0)
    assert.equal(count('POST', caddyPath), 0)
  })
  cases++

  await withControl(browser, 'trusted networks stay disabled while pending and after failure', { holdTrusted: true }, async ({ page, state, ui, count, waitRequest, consumed, settle }) => {
    assert.equal(await ui.trustedSave.isDisabled(), true, 'Unread trusted networks allowed a save')
    assert.equal(await ui.trustedInput.isDisabled(), true, 'Unread trusted networks allowed editing')
    const before = await consumed(trustedPath)
    await ui.trustedSummary.click()
    const read = await waitRequest('GET', trustedPath)
    assert.equal(await ui.trustedSave.isDisabled(), true, 'Pending trusted GET allowed a save')
    await ui.trustedSave.evaluate(node => { node.click() })
    assert.equal(count('POST', trustedPath), 0, 'Pending trusted GET sent a write')
    read.release(503, { error: 'fixture_read_failed' })
    await settle(trustedPath, before)
    assert.equal(await ui.trustedSave.isDisabled(), true, 'Failed trusted GET allowed a save')
    assert.equal(await ui.trustedInput.isDisabled(), true, 'Failed trusted GET allowed editing')
    assert.equal(await page.getByText('Could not read this setting. Retry after reopening this section.', { exact: true }).isVisible(), true)
    await ui.trustedSave.evaluate(node => { node.click() })
    assert.equal(count('POST', trustedPath), 0, 'Failed trusted GET sent a write')
    state.holdTrusted = false
    await ui.trustedSummary.click()
    const retryBefore = await consumed(trustedPath)
    await ui.trustedSummary.click()
    await settle(trustedPath, retryBefore)
    assert.equal(await ui.trustedSave.isDisabled(), false, 'Successful supported retry did not enable saving')
    assert.equal(await ui.trustedInput.inputValue(), '10.80.0.0/16')
  })
  cases++

  await withControl(browser, 'unsupported trusted networks never allow writes', { supported: false }, async ({ page, ui, count, consumed, settle }) => {
    const before = await consumed(trustedPath)
    await ui.trustedSummary.click()
    await settle(trustedPath, before)
    assert.equal(await ui.trustedSave.isDisabled(), true)
    assert.equal(await ui.trustedInput.isDisabled(), true)
    assert.equal(await page.getByText('Available only with managed LAN setup.', { exact: true }).isVisible(), true)
    await ui.trustedSave.evaluate(node => { node.click() })
    assert.equal(count('POST', trustedPath), 0, 'Unsupported trusted networks sent a write')
  })
  cases++

  await withControl(browser, 'Caddy busy survives late snapshots and polling; failed mode change restores managed', { holdMode: true }, async ({ page, state, ui, count, waitRequest, consumed, settle, openRemote, pollRemote }) => {
    await openRemote()
    assert.equal(await ui.managed.isChecked(), true)
    assert.equal(await ui.caddySave.isDisabled(), false)
    state.holdNextRemote = true
    const priorReads = count('GET', remotePath)
    const priorConsumed = await consumed(remotePath)
    await page.clock.runFor(1_500)
    const staleRead = await waitRequest('GET', remotePath, priorReads)
    await ui.external.check()
    const mode = await waitRequest('POST', modePath)
    assert.deepEqual(mode.body, { mode: 'external' })
    const assertBusy = async () => {
      for (const [label, control] of [['managed radio', ui.managed], ['external radio', ui.external], ['Caddy save', ui.caddySave], ['Caddy domain', ui.caddyDomain]]) {
        assert.equal(await control.isDisabled(), true, `${label} unlocked during a pending Caddy action`)
      }
      assert.equal(await page.locator('.dsh-mobile-control__provider:not(.is-lan)').evaluateAll(nodes => nodes.every(node => node.disabled)), true, 'Remote provider cards unlocked during a pending Caddy action')
    }
    await assertBusy()
    staleRead.release(200, { ...remoteState(), provider: 'tailscale' })
    await settle(remotePath, priorConsumed)
    assert.equal(await page.locator('.dsh-mobile-control__provider.is-origin').getAttribute('aria-pressed'), 'true', 'Late pre-action snapshot changed the provider')
    await assertBusy()
    const readsDuringBusy = count('GET', remotePath)
    await page.clock.runFor(1_500)
    await assertBusy()
    assert.equal(count('GET', remotePath), readsDuringBusy, 'Caddy action did not suppress periodic controller reads')
    const modeBefore = await consumed(modePath)
    const recoveryBefore = await consumed(remotePath)
    mode.release(409, { error: 'origin_mode_switch_failed' })
    await settle(modePath, modeBefore)
    await settle(remotePath, recoveryBefore)
    assert.equal(await ui.managed.isChecked(), true, 'Failed mode change retained the external preview')
    assert.equal(await ui.external.isChecked(), false)
    assert.equal(await ui.caddySave.isDisabled(), false, 'Failed action left Caddy controls locked')
    const feedback = page.locator('#dsh-mobile-origin-feedback')
    assert.equal(await feedback.isVisible(), true, 'Failed mode change hid its feedback inside the managed form')
    assert.equal(await feedback.evaluate(node => node.classList.contains('is-error')), true)
    assert.match(await feedback.textContent(), /Managed HTTPS connection was not established/u)
    await pollRemote()
    assert.equal(await ui.managed.isChecked(), true, 'Next poll restored a failed external preview')
    assert.equal(await feedback.isVisible(), true, 'Next poll erased the failed mode change message')
  })
  cases++

  await withControl(browser, 'periodic snapshots preserve dirty trusted, origin and Caddy fields', {}, async ({ page, state, ui, count, consumed, settle, openRemote, pollRemote }) => {
    const trustedBefore = await consumed(trustedPath)
    await ui.trustedSummary.click()
    await settle(trustedPath, trustedBefore)
    const trustedDraft = '11.24.0.0/24\n2001:db8:1::/64'
    await ui.trustedInput.fill(trustedDraft)
    await openRemote()
    const modeBefore = await consumed(modePath)
    const recoveryBefore = await consumed(remotePath)
    await ui.external.check()
    await settle(modePath, modeBefore)
    await settle(remotePath, recoveryBefore)
    await waitUntil(() => ui.external.isDisabled(), value => value === false, 'completed external mode change')
    const originDraft = ['https://draft-proxy.example.com:8816', '192.168.50.20', '3445', '192.168.50.10/32, 127.0.0.0/8']
    for (const [index, control] of [ui.originPublic, ui.originHost, ui.originPort, ui.originCidrs].entries()) await control.fill(originDraft[index])
    await ui.managed.check()
    const caddyDraft = ['https://draft-caddy.example.com:9443', '9443', 'fixture-secret-id', 'fixture-secret-key']
    for (const [index, control] of [ui.caddyDomain, ui.caddyPort, ui.caddySecretId, ui.caddySecretKey].entries()) await control.fill(caddyDraft[index])
    state.trusted.extraAllowedCidrs = ['10.90.0.0/16']
    Object.assign(state.remote.providers.origin.configuration, { publicOrigin: 'https://new-saved-proxy.example.com', listenHost: '10.0.0.2', listenPort: 3555, allowedCidrs: ['10.0.0.1/32'] })
    Object.assign(state.remote.caddyConfiguration, { publicOrigin: 'https://new-saved-caddy.example.com', listenPort: 8555 })
    for (let index = 0; index < 2; index++) {
      await pollRemote()
      assert.equal(await ui.trustedInput.inputValue(), trustedDraft, 'Poll overwrote dirty trusted networks')
      assert.deepEqual(await Promise.all([ui.originPublic, ui.originHost, ui.originPort, ui.originCidrs].map(control => control.inputValue())), originDraft, 'Poll overwrote dirty origin fields')
      assert.deepEqual(await Promise.all([ui.caddyDomain, ui.caddyPort, ui.caddySecretId, ui.caddySecretKey].map(control => control.inputValue())), caddyDraft, 'Poll overwrote dirty Caddy fields')
      assert.equal(await ui.managed.isChecked(), true, 'Poll overwrote the unsaved managed preview')
    }
    assert.equal(count('POST', trustedPath), 0, 'Editing trusted networks saved without an explicit action')
    assert.equal(count('POST', `${prefix}/remote/origin/configure`), 0, 'Editing origin fields saved without an explicit action')
    assert.equal(count('POST', caddyPath), 0, 'Editing Caddy fields saved without an explicit action')
  })
  cases++

  await withControl(browser, 'IPv6 proxy host input retains and submits an expanded ULA address', {}, async ({ page, ui, count, waitRequest, consumed, settle, openRemote }) => {
    await openRemote()
    const modeBefore = await consumed(modePath)
    const remoteBefore = await consumed(remotePath)
    await ui.external.check()
    await settle(modePath, modeBefore)
    await settle(remotePath, remoteBefore)
    await waitUntil(() => ui.external.isDisabled(), value => value === false, 'completed external mode change')
    const host = 'fd12:3456:789a:0000:0000:0000:0000:0010'
    const source = 'fd12:3456:789a::1/128'
    await ui.originPublic.fill('https://ipv6-proxy.example.com:8815')
    await ui.originHost.fill('')
    await ui.originHost.pressSequentially(host)
    await ui.originCidrs.fill(source)
    assert.equal(await ui.originHost.inputValue(), host, 'IPv6 host was truncated by the IPv4 input limit')
    const path = `${prefix}/remote/origin/configure`
    assert.equal(count('POST', path), 0)
    await page.getByRole('button', { name: 'Save and start backend', exact: true }).click()
    const saved = await waitRequest('POST', path)
    assert.deepEqual(saved.body, {
      publicOrigin: 'https://ipv6-proxy.example.com:8815', listenHost: host,
      listenPort: 3444, allowedCidrs: [source],
    })
  })
  cases++

  await withControl(browser, 'Caddy save and connect uses one atomic controller request', {}, async ({ ui, count, waitRequest, consumed, settle, openRemote }) => {
    await openRemote()
    await ui.caddyDomain.fill('https://atomic-caddy.example.com:9443')
    await ui.caddyPort.fill('9443')
    await ui.caddySecretId.fill('fixture-atomic-id')
    await ui.caddySecretKey.fill('fixture-atomic-key')
    const before = await consumed(caddyPath)
    await ui.caddySave.click()
    const saved = await waitRequest('POST', caddyPath)
    await settle(caddyPath, before)
    await waitUntil(() => ui.caddySave.isDisabled(), value => value === false, 'completed atomic Caddy connection')
    assert.deepEqual(saved.body, {
      settings: { version: 1, publicOrigin: 'https://atomic-caddy.example.com:9443', dnsProvider: 'tencentcloud', listenPort: 9443 },
      secretId: 'fixture-atomic-id', secretKey: 'fixture-atomic-key', connect: true,
    })
    assert.equal(count('POST', caddyPath), 1, 'Caddy connection did not use exactly one settings write')
    assert.equal(count('POST', modePath), 0, 'Caddy connection separately changed origin mode')
    assert.equal(count('POST', remotePath), 0, 'Caddy connection separately started the remote controller')
    assert.equal(await ui.managed.isChecked(), true)
    assert.equal(await ui.caddySecretId.inputValue(), '', 'Successful Caddy connection retained the submitted SecretId')
    assert.equal(await ui.caddySecretKey.inputValue(), '', 'Successful Caddy connection retained the submitted SecretKey')
  })
  cases++

  const stoppedHost = { id: 'stopped-worker', name: '<b>Stopped worker</b>', mode: 'worker', state: 'unavailable', generation: 'a'.repeat(64) }
  for (const language of ['en', 'zh', 'it']) {
    await withControl(browser, `explicit worker recovery ${language}`, { layoutFixture: true, language, width: 360,
      hosts: [stoppedHost, { ...stoppedHost, id: 'ready-worker', state: 'ready' }, { ...stoppedHost, id: 'inline', mode: 'in-process' }],
    }, async ({ page, count, consumed, settle, openRemote }) => {
      const section = page.locator('.dsh-mobile-control__extension-recovery')
      await section.waitFor({ state: 'visible' })
      const dark = language !== 'en'
      await page.evaluate(dark => {
        document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
        for (const [key, value] of Object.entries(dark
          ? { 'bg-module-platform': '#292929', 'bg-layer-1': '#222', 'label-primary': '#eee', 'label-secondary': '#bbb', 'border-l2': '#444', 'border-l3': '#555' }
          : { 'bg-module-platform': '#f3f4f6', 'bg-layer-1': '#fff', 'label-primary': '#171a21', 'label-secondary': '#596273', 'border-l2': '#ddd', 'border-l3': '#ccc' })) {
          document.documentElement.style.setProperty(`--dsw-alias-${key}`, value)
        }
      }, dark)
      const theme = await section.evaluate(node => ({ foreground: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }))
      assert.deepEqual(theme, dark ? { foreground: 'rgb(238, 238, 238)', background: 'rgb(41, 41, 41)' } : { foreground: 'rgb(23, 26, 33)', background: 'rgb(243, 244, 246)' }, 'Recovery did not consume its DSH theme tokens')
      assert.equal(await section.locator('li').count(), 1, 'Recovery included a ready or in-process host')
      assert.equal(await section.locator('strong').textContent(), stoppedHost.name, 'Host name was not rendered as plain text')
      assert.equal(await section.locator('strong b').count(), 0, 'Host name was interpreted as HTML')
      const button = section.locator('button[data-extension-recovery-id]')
      const bounds = await button.boundingBox()
      assert(bounds !== null && bounds.width >= 48 && bounds.height >= 48, 'Recovery lost its touch target')
      assert(await button.evaluate(node => { const box = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)) }), 'Recovery button was covered')
      assert.equal(await section.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'Recovery card overflowed')
      assert.equal(count('POST', recoverPath), 0, 'Opening the control automatically restarted a worker')
      await openRemote()
      assert.equal(await section.isVisible(), true, 'Remote tab hid extension recovery')
      const diagnosticName = await page.evaluate(locale => window.mobileClient.MOBILE_CONTROL_MESSAGES[locale].openDiagnostics, language)
      await page.getByRole('button', { name: diagnosticName, exact: true }).click()
      assert.equal(await section.isVisible(), true, 'Diagnostics hid extension recovery')
      const confirmations = []
      page.on('dialog', dialog => { confirmations.push(dialog.message()) })
      const before = await consumed(recoverPath)
      await button.click()
      await settle(recoverPath, before)
      assert.equal(confirmations.length, 1, 'Recovery did not require an explicit confirmation')
      assert.match(confirmations[0], language === 'zh' ? /不会重新执行|不会重新/u : language === 'it' ? /non verranno ripetute/u : /will not be retried/u)
      assert.equal(count('POST', recoverPath), 1)
      assert.equal(await section.isVisible(), false, 'Successful recovery did not remove the stopped-worker section')
    })
    cases++
  }

  await withControl(browser, 'cancelled worker recovery never sends a write', { hosts: [stoppedHost], cancelDialogs: true }, async ({ page, count }) => {
    await page.locator('.dsh-mobile-control__extension-recovery').waitFor({ state: 'visible' })
    await page.locator('button[data-extension-recovery-id]').click()
    assert.equal(count('POST', recoverPath), 0)
    assert.equal(await page.locator('button[data-extension-recovery-id]').isDisabled(), false)
  })
  cases++

  await withControl(browser, 'worker recovery serializes writes and ignores an older read', { hosts: [stoppedHost, { ...stoppedHost, id: 'second-worker' }], holdRecovery: true }, async ({ page, state, count, waitRequest, consumed, settle, openRemote }) => {
    const section = page.locator('.dsh-mobile-control__extension-recovery')
    await section.waitFor({ state: 'visible' })
    state.holdHosts = true
    const readCount = count('GET', hostsPath)
    await openRemote()
    const stale = await waitRequest('GET', hostsPath, readCount)
    await section.locator('button[data-extension-recovery-id]').first().click()
    const post = await waitRequest('POST', recoverPath)
    assert.deepEqual(post.body, { id: stoppedHost.id, confirm: true })
    assert.equal(await section.locator('button[data-extension-recovery-id]:disabled').count(), 2)
    await section.locator('button[data-extension-recovery-id]').last().evaluate(node => node.click())
    assert.equal(count('POST', recoverPath), 1, 'Busy recovery allowed a second write')
    state.hosts = []; state.holdHosts = false; state.holdRecovery = false
    const before = await consumed(recoverPath)
    post.release(200, { hosts: [], limits: { maxWorkers: 4, workers: 2 } })
    await settle(recoverPath, before)
    assert.equal(await section.isVisible(), false)
    const previous = await consumed(hostsPath)
    stale.release(200, { hosts: [stoppedHost], limits: { maxWorkers: 4, workers: 0 } })
    await settle(hostsPath, previous)
    assert.equal(await section.isVisible(), false, 'An older GET resurrected the recovered worker')
  })
  cases++

  await withControl(browser, 'worker restart failure stays actionable through background refresh', { hosts: [stoppedHost], recoveryError: 'extension_changed_during_activation' }, async ({ page, state, consumed, settle }) => {
    const section = page.locator('.dsh-mobile-control__extension-recovery')
    await section.waitFor({ state: 'visible' })
    const previous = await consumed(recoverPath)
    await section.locator('button[data-extension-recovery-id]').click()
    await settle(recoverPath, previous)
    const error = section.locator('[role="status"]')
    assert.match(await error.textContent(), /files changed/u)
    assert.equal(await section.locator('button[data-extension-recovery-id]').isDisabled(), false)
    const priorRead = await consumed(hostsPath)
    await page.clock.runFor(20_000)
    await settle(hostsPath, priorRead)
    assert.match(await error.textContent(), /files changed/u, 'Background refresh erased the recovery failure')
    state.recoveryError = undefined
    const next = await consumed(recoverPath)
    await section.locator('button[data-extension-recovery-id]').click()
    await settle(recoverPath, next)
    assert.equal(await section.isVisible(), false)
  })
  cases++

  await withControl(browser, 'late recovery read cannot update a disposed control', { hosts: [stoppedHost] }, async ({ page }) => {
    const section = page.locator('.dsh-mobile-control__extension-recovery')
    await section.waitFor({ state: 'visible' })
    await page.evaluate(payload => {
      const original = window.fetch
      window.fetch = (path, init) => String(path).endsWith('/extensions/hosts') ? new Promise(resolve => {
        window.releaseLateRecovery = () => resolve({ ok: true, json: async () => payload })
      }) : original(path, init)
      window.detachedRecovery = document.querySelector('.dsh-mobile-control__extension-recovery')
      window.detachedRecoveryText = window.detachedRecovery.textContent
    }, { hosts: [] })
    await page.locator('.dsh-mobile-control__close').click()
    await page.locator('.dsh-mobile-control__trigger').click()
    await page.waitForFunction(() => typeof window.releaseLateRecovery === 'function')
    await page.evaluate(async () => {
      window.disposeClient()
      window.releaseLateRecovery()
      for (let turn = 0; turn < 12; turn++) await Promise.resolve()
    })
    assert.equal(await page.locator('.dsh-mobile-control').count(), 0)
    assert.equal(await page.evaluate(() => window.detachedRecovery.textContent), await page.evaluate(() => window.detachedRecoveryText), 'Late data rewrote a disposed section')
    assert.equal(await page.evaluate(() => window.detachedRecovery.hidden), false, 'Late data hid the detached section')
  })
  cases++
  console.log(`Control-state browser smoke passed (${cases} cases; owned HTTP controller fixtures).`)
} finally { await browser.close() }
