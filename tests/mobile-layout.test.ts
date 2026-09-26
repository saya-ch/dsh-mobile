import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { parseMobileBootPlan, rewriteMobileIndex, splitMobileBootBatch } from '../src/gateway.js'
import { CSRF_COOKIE, CSRF_HEADER } from '../src/http-security.js'
import {
  MOBILE_LAYOUT_MESSAGES,
  MOBILE_LAYOUT_STYLES,
  TOUCH_PRIMARY_QUERY,
  WIDE_LAYOUT_MIN_WIDTH_PX,
  apply as applyMobileLayout,
  closeDetailsFromScrim,
  isComposerOwnedFocus,
  isMobileScrimOpen,
  isSessionRowNavigation,
  isSidebarRightControl,
  isWideViewportLayout,
  resolveComposerImePolicy,
  resolveMobileLayoutLanguage,
  resolveMobileRightbarLayout,
} from '../src/mobile-layout.js'

function index(entries: unknown[]): string {
  return `<!doctype html><html><head><script>window.__DSH_BOOT__ = ${JSON.stringify({ rev: 'stock', entries })};</script></head><body></body></html>`
}

function currentIndex(entries: unknown[]): string {
  return `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({ rev: 'stock', entries })};</script></head><body></body></html>`
}

/**
 * Minimal DOM the dedicated layout touches while booting: the style element it
 * appends, the theme presenter's meta tag, and a narrow-viewport matchMedia.
 * @returns a disposer restoring every global it replaced.
 */
function stubClientGlobals(): () => void {
  const globals = globalThis as Record<string, unknown>
  const previous = new Map<string, unknown>()
  const define = (name: string, value: unknown): void => {
    if (!previous.has(name)) previous.set(name, globals[name])
    globals[name] = value
  }
  const style = { dataset: {}, style: {}, setAttribute() {}, remove() {} }
  const meta = { name: '', content: '', isConnected: false, append() {}, remove() {} }
  define('document', {
    documentElement: { style: { setProperty() {}, removeProperty() {} }, lang: 'en' },
    body: { style: { setProperty() {}, removeProperty() {} }, toggleAttribute() {}, removeAttribute() {}, backgroundColor: '' },
    head: { append() {} },
    createElement: (tag: string) => tag === 'meta' ? meta : style,
    querySelector: () => null,
    title: '',
  })
  define('window', {
    innerWidth: 390,
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    setInterval: () => 0,
    clearInterval() {},
  })
  define('getComputedStyle', () => ({ backgroundColor: '' }))
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete globals[name]
      else globals[name] = value
    }
  }
}

interface BootEntry {
  id: string
  url: string
  rev: string
  inject?: string[]
  external?: string[]
  immediately?: boolean
}

const connectionModule = '@deepseek-ai/dsh-client-connection'
const rendererModule = '@deepseek-ai/dsh-client-ui-renderer'
const gatewayModule = '@deepseek-ai/dsh-api-gateway'
const remotesModule = '@deepseek-ai/dsh-api-remotes'
const settingsModule = '@deepseek-ai/dsh-client-ui-settings'

function remoteSettingsEntries(): BootEntry[] {
  const entry = (id: string, inject: string[] = []): BootEntry => ({ id, url: `/plugins/${id}.js`, rev: 'stock', inject })
  return [
    entry(connectionModule),
    entry(rendererModule),
    entry('@deepseek-ai/dsh-typert-registry'),
    entry(gatewayModule, ['@deepseek-ai/dsh-typert-registry', connectionModule]),
    entry(remotesModule, [gatewayModule]),
    entry(settingsModule, [remotesModule]),
    entry('@deepseek-ai/dsh-client-locale', [settingsModule]),
    entry('@deepseek-ai/dsh-client-ui-session', [remotesModule]),
    entry('@deepseek-ai/dsh-client-ui-theme', [settingsModule]),
    entry('@deepseek-ai/dsh-client-ui-layout', [
      '@deepseek-ai/dsh-client-locale', rendererModule,
      '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-theme',
    ]),
    entry('@deepseek-ai/dsh-client-ui-sidebar', [settingsModule]),
    { ...entry('dsh-mobile', [connectionModule, '@deepseek-ai/dsh-client-ui-sidebar']), immediately: true },
  ]
}

function bootEntries(html: string): BootEntry[] {
  const match = /(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*(\{.*\});<\/script>/u.exec(html)
  if (match?.[1] === undefined) throw new Error('missing test boot manifest')
  return (JSON.parse(match[1]) as { entries: BootEntry[] }).entries
}

interface TransportHooks {
  fetch: typeof fetch
  ownsHost?: boolean
  openStream?: () => void
  loadBundle?: () => void
}

/** Minimal DOM event target with capture ordering and immediate-propagation stops. */
function createEventTarget() {
  interface Entry { readonly type: string; readonly fn: (event: PageEvent) => void; readonly capture: boolean }
  interface PageEvent {
    readonly type: string
    defaultPrevented: boolean
    immediateStopped: boolean
    stopImmediatePropagation(): void
    preventDefault(): void
  }
  const entries: Entry[] = []
  const captureOf = (options?: boolean | { capture?: boolean }): boolean =>
    typeof options === 'boolean' ? options : options?.capture === true
  return {
    entries,
    addEventListener(type: string, fn: (event: PageEvent) => void, options?: boolean | { capture?: boolean }): void {
      entries.push({ type, fn, capture: captureOf(options) })
    },
    removeEventListener(type: string, fn: (event: PageEvent) => void, options?: boolean | { capture?: boolean }): void {
      const capture = captureOf(options)
      const at = entries.findIndex(entry => entry.type === type && entry.fn === fn && entry.capture === capture)
      if (at >= 0) entries.splice(at, 1)
    },
    /** Capture listeners run before bubble listeners, as the DOM specifies. */
    dispatch(type: string): PageEvent {
      const ordered = [...entries.filter(entry => entry.type === type && entry.capture),
        ...entries.filter(entry => entry.type === type && !entry.capture)]
      let immediateStopped = false
      const event: PageEvent = {
        type,
        defaultPrevented: false,
        get immediateStopped() { return immediateStopped },
        stopImmediatePropagation() { immediateStopped = true },
        preventDefault() { event.defaultPrevented = true },
      }
      for (const entry of ordered) {
        if (immediateStopped) break
        entry.fn(event)
      }
      return event
    },
  }
}

function bootstrapPage(html: string, existingTransport?: TransportHooks) {
  const nativeFetch = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
  const nativeBridge = Object.freeze({ request: vi.fn() })
  const events = createEventTarget()
  const navigator = { onLine: true }
  const page: {
    fetch: typeof fetch
    __DSH_TRANSPORT__?: TransportHooks
    __DSH_BOOT__?: unknown
    __DSH_MOBILE_FRONTEND__?: string
    dshMobileNative: typeof nativeBridge
    navigator: typeof navigator
    addEventListener: typeof events.addEventListener
    removeEventListener: typeof events.removeEventListener
    dispatchEvent: (event: Event) => boolean
    setTimeout: typeof setTimeout
    clearTimeout: typeof clearTimeout
  } = {
    fetch: nativeFetch,
    dshMobileNative: nativeBridge,
    navigator,
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
    dispatchEvent: (event: Event) => { events.dispatch(event.type); return true },
    setTimeout,
    clearTimeout,
  }
  if (existingTransport !== undefined) page.__DSH_TRANSPORT__ = existingTransport
  const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1]
  if (script === undefined) throw new Error('missing bootstrap script')
  return {
    page,
    navigator,
    events,
    nativeFetch,
    nativeBridge,
    run() {
      runInNewContext(script, {
        window: page,
        globalThis: page,
        document: { cookie: `${CSRF_COOKIE}=paired-csrf-token` },
        location: new URL('https://phone.example/'),
        AbortController, Event, Headers, Request, URL,
      })
    },
  }
}

describe('dedicated mobile layout boot', () => {
  it('replaces only the stock layout bundle and marks the page as dedicated', () => {
    const output = rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime' },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
      { id: '@deepseek-ai/dsh-client-ui-conversation', url: '/conversation.js', rev: 'conversation' },
    ]))

    expect(output).toContain('window.__DSH_MOBILE_FRONTEND__="dedicated"')
    expect(output).toContain('window.fetch=(input,init)=>')
    expect(output).toContain('x-dsh-mobile-csrf')
    expect(output.indexOf('window.fetch=(input,init)=>')).toBeLessThan(output.indexOf('window.__DSH_BOOT__'))
    expect(output).toContain('"url":"/mobile-access/mobile-layout.js"')
    expect(output).toContain('"inject":["@deepseek-ai/dsh-client-runtime","@deepseek-ai/dsh-client-ui-theme"]')
    expect(output).toContain('"url":"/conversation.js"')
    expect(output).not.toContain('"url":"/layout.js"')
    expect(output).toContain('viewport-fit=cover')
    expect(output).not.toContain('__DSH_TRANSPORT__')
  })

  it('orders the authenticated mobile client before settings without retaining the sidebar cycle', () => {
    const output = rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-connection', url: '/connection.js', rev: 'connection', inject: [] },
      { id: '@deepseek-ai/dsh-client-runtime', url: '/runtime.js', rev: 'runtime', inject: ['@deepseek-ai/dsh-client-connection'] },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings',
        url: '/settings.js',
        rev: 'settings',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-runtime'],
      },
      {
        id: 'dsh-mobile',
        url: '/dsh-mobile.js',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]))

    expect(output).toContain('"id":"dsh-mobile","url":"/dsh-mobile.js","rev":"mobile","inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-runtime"]')
    expect(output).toContain('"id":"@deepseek-ai/dsh-client-ui-settings","url":"/settings.js","rev":"settings","inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-runtime","dsh-mobile"]')
    expect(output).not.toContain('"id":"dsh-mobile","url":"/dsh-mobile.js","rev":"mobile","inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-sidebar"]')
  })

  it('rebuilds the DSH 0.1.2 application batch around the dedicated layout', () => {
    const entries = [
      { id: '@deepseek-ai/dsh-client-connection', url: '/plugins/connection.js?rev=connection', rev: 'connection', inject: [] },
      { id: '@deepseek-ai/dsh-client-ui-renderer', url: '/plugins/renderer.js?rev=renderer', rev: 'renderer', inject: [] },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/plugins/layout.js?rev=layout',
        rev: 'layout',
        inject: [
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-ui-renderer',
          '@deepseek-ai/dsh-client-ui-session',
          '@deepseek-ai/dsh-client-ui-theme',
        ],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings',
        url: '/plugins/settings.js?rev=settings',
        rev: 'settings',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-api-remotes'],
      },
      {
        id: 'dsh-mobile',
        url: '/plugins/dsh-mobile.js?rev=mobile',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]
    const source = `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
      rev: 'stock',
      entries,
      batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock-batch', entries: entries.map(entry => entry.id) }],
    })};</script></head><body></body></html>`
    const output = rewriteMobileIndex(source)

    expect(output).toContain('"url":"/mobile-access/mobile-layout.js"')
    expect(output).toContain('"inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-ui-renderer"]')
    expect(output).toContain('"inject":["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-api-remotes","dsh-mobile"]')
    expect(output).toMatch(/"url":"\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js"/u)
    expect(output).not.toContain('/plugins/application.js?rev=stock')
    // Rows are emitted in the canonical (id-sorted) order, not manifest order,
    // so the derived batch is stable across restarts of an unchanged manifest.
    expect(output).toContain(`"entries":${JSON.stringify([...entries.map(entry => entry.id)].sort())}`)
  })

  it('derives the same merged batch, key, and body order from a reordered manifest', () => {
    const entries = [
      { id: '@deepseek-ai/dsh-client-connection', url: '/plugins/connection.js?rev=connection', rev: 'connection', inject: [] },
      { id: '@deepseek-ai/dsh-client-ui-renderer', url: '/plugins/renderer.js?rev=renderer', rev: 'renderer', inject: [] },
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/plugins/layout.js?rev=layout',
        rev: 'layout',
        inject: [
          '@deepseek-ai/dsh-client-locale',
          '@deepseek-ai/dsh-client-ui-renderer',
          '@deepseek-ai/dsh-client-ui-session',
          '@deepseek-ai/dsh-client-ui-theme',
        ],
      },
      {
        id: '@deepseek-ai/dsh-client-ui-settings',
        url: '/plugins/settings.js?rev=settings',
        rev: 'settings',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-api-remotes'],
      },
      {
        id: 'dsh-mobile',
        url: '/plugins/dsh-mobile.js?rev=mobile',
        rev: 'mobile',
        inject: ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-ui-sidebar'],
        immediately: true,
      },
    ]
    const manifest = (ordered: typeof entries): string =>
      `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify({
        rev: 'stock',
        entries: ordered,
        batches: [{ phase: 'application', url: '/plugins/application.js?rev=stock', rev: 'stock-batch', entries: ordered.map(entry => entry.id) }],
      })};</script></head><body></body></html>`
    const splitFor = (ordered: typeof entries) => {
      const plan = parseMobileBootPlan(manifest(ordered))
      return splitMobileBootBatch(plan.planEntries ?? [], new Map(), new Set())
    }
    const summarize = (split: ReturnType<typeof splitFor>) => split.plans.map(plan => ({
      key: plan.key,
      path: plan.path,
      ids: plan.entries.map(entry => entry.id),
      urls: plan.entries.map(entry => entry.url),
    }))

    const forward = splitFor(entries)
    const reverse = splitFor([...entries].reverse())

    // The same module set must derive the same merged batch: one key (the URL)
    // and one body order (the ETag). Upstream lists these entries in
    // module-registration order, which is not stable across restarts of an
    // unchanged configuration, so an order-sensitive derivation re-hashes every
    // batch after each restart and every paired device re-downloads the whole
    // boot payload.
    expect(summarize(reverse)).toEqual(summarize(forward))
    expect(reverse.rows).toEqual(forward.rows)
  })

  it.each([false, true])('installs authenticated HTTP transport before the alpha.2 boot manifest (reverse roster: %s)', reverse => {
    const entries = remoteSettingsEntries()
    if (reverse) entries.reverse()
    const output = rewriteMobileIndex(currentIndex(entries))
    const rewritten = bootEntries(output)
    expect(rewritten.find(entry => entry.id === 'dsh-mobile')?.inject).toEqual([connectionModule, rendererModule])
    expect(rewritten.find(entry => entry.id === gatewayModule)?.inject).toEqual([
      '@deepseek-ai/dsh-typert-registry', connectionModule, 'dsh-mobile',
    ])
    expect(rewritten.find(entry => entry.id === settingsModule)?.inject).toEqual([remotesModule, 'dsh-mobile'])
    expect(output.indexOf('window.__DSH_TRANSPORT__=')).toBeLessThan(output.indexOf('globalThis["__DSH_BOOT__"]'))
    const bootstrap = bootstrapPage(output)
    bootstrap.run()
    expect(bootstrap.page.__DSH_TRANSPORT__?.ownsHost).toBe(true)
    expect(bootstrap.page.__DSH_TRANSPORT__?.fetch).toBeTypeOf('function')
    expect(bootstrap.page.__DSH_TRANSPORT__).not.toHaveProperty('openStream')
    expect(bootstrap.page.__DSH_TRANSPORT__).not.toHaveProperty('loadBundle')
    expect(bootstrap.page.__DSH_MOBILE_FRONTEND__).toBe('dedicated')
    expect(bootstrap.page.__DSH_BOOT__).toBeDefined()
    expect(bootstrap.page.dshMobileNative).toBe(bootstrap.nativeBridge)
    expect(bootstrap.nativeFetch).not.toHaveBeenCalled()
  })

  it('preserves fetch credentials, cancellation, body, and CSRF without a recursive transport', async () => {
    const bootstrap = bootstrapPage(rewriteMobileIndex(currentIndex(remoteSettingsEntries())))
    bootstrap.run()
    const transport = bootstrap.page.__DSH_TRANSPORT__!
    const signal = new AbortController().signal
    const target = new URL('https://phone.example/api/settings/mutate')
    await transport.fetch(target, {
      method: 'POST', credentials: 'include', signal, body: 'payload', headers: { 'x-existing': 'kept' },
    })
    expect(bootstrap.nativeFetch).toHaveBeenCalledOnce()
    const [input, init] = bootstrap.nativeFetch.mock.calls[0]!
    expect(input).toBe(target)
    expect(init).toMatchObject({ method: 'POST', credentials: 'include', body: 'payload' })
    expect(init?.signal).toBe(signal)
    expect(new Headers(init?.headers).get(CSRF_HEADER)).toBe('paired-csrf-token')
    expect(new Headers(init?.headers).get('x-existing')).toBe('kept')

    await transport.fetch(target, { method: 'POST', headers: { [CSRF_HEADER]: 'explicit-token' } })
    expect(new Headers(bootstrap.nativeFetch.mock.calls[1]![1]?.headers).get(CSRF_HEADER)).toBe('explicit-token')
    const externalInit = { method: 'POST', credentials: 'omit' as const }
    await transport.fetch(new URL('https://other.example/api/test'), externalInit)
    expect(bootstrap.nativeFetch.mock.calls[2]![1]).toBe(externalInit)
    expect(bootstrap.nativeFetch).toHaveBeenCalledTimes(3)
  })

  it('refuses an existing transport without replacing or promoting its capabilities', () => {
    const existing = Object.freeze({ fetch: vi.fn<typeof fetch>(), ownsHost: false, openStream: vi.fn(), loadBundle: vi.fn() })
    const bootstrap = bootstrapPage(rewriteMobileIndex(currentIndex(remoteSettingsEntries())), existing)
    expect(() => bootstrap.run()).toThrow('DSH Mobile cannot replace an existing transport override')
    expect(bootstrap.page.__DSH_TRANSPORT__).toBe(existing)
    expect(existing.ownsHost).toBe(false)
    expect(bootstrap.page.fetch).toBe(bootstrap.nativeFetch)
    expect(bootstrap.page.__DSH_BOOT__).toBeUndefined()
    expect(bootstrap.page.__DSH_MOBILE_FRONTEND__).toBeUndefined()
  })

  it('keeps the gateway reachable when the OS only loses public internet', async () => {
    const bootstrap = bootstrapPage(rewriteMobileIndex(currentIndex(remoteSettingsEntries())))
    try {
      bootstrap.navigator.onLine = false
      bootstrap.run()
      const suspended = vi.fn()
      bootstrap.page.addEventListener('offline', suspended)
      bootstrap.events.dispatch('offline')
      await vi.waitFor(() => { expect(bootstrap.nativeFetch).toHaveBeenCalledOnce() })
      expect(bootstrap.nativeFetch.mock.calls[0]?.[0]).toBe('/mobile-access/health')
      expect(bootstrap.page.navigator.onLine).toBe(true)
      expect(suspended).not.toHaveBeenCalled()
    } finally {
      bootstrap.events.dispatch('pagehide')
    }
  })

  it('stops the offline event before DSH connection recovery can suspend retries', () => {
    const bootstrap = bootstrapPage(rewriteMobileIndex(currentIndex(remoteSettingsEntries())))
    bootstrap.run()
    // Mirrors dsh-client-connection's watchBrowserNetwork listener, which is the
    // only consumer of `offline` in DSH and publishes `disconnected` on it.
    const suspended = vi.fn()
    bootstrap.page.addEventListener('offline', suspended)
    const event = bootstrap.events.dispatch('offline')
    expect(suspended).not.toHaveBeenCalled()
    expect(event.immediateStopped).toBe(true)
    // `online` stays untouched: recovery still resumes the sequence on a real transition.
    const resumed = vi.fn()
    bootstrap.page.addEventListener('online', resumed)
    bootstrap.events.dispatch('online')
    expect(resumed).toHaveBeenCalledOnce()
    bootstrap.events.dispatch('pagehide')
  })

  it('replays true gateway loss and recovery to the Connection and other listeners', async () => {
    const bootstrap = bootstrapPage(rewriteMobileIndex(currentIndex(remoteSettingsEntries())))
    bootstrap.nativeFetch.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    bootstrap.nativeFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    try {
      bootstrap.run()
      const suspended = vi.fn()
      const resumed = vi.fn()
      bootstrap.page.addEventListener('offline', suspended)
      bootstrap.page.addEventListener('online', resumed)
      bootstrap.events.dispatch('offline')
      await vi.waitFor(() => { expect(suspended).toHaveBeenCalledOnce() })
      expect(bootstrap.page.navigator.onLine).toBe(false)
      await Promise.resolve()
      bootstrap.events.dispatch('offline')
      await vi.waitFor(() => { expect(resumed).toHaveBeenCalledOnce() })
      expect(bootstrap.page.navigator.onLine).toBe(true)
    } finally {
      bootstrap.events.dispatch('pagehide')
    }
  })

  it('rechecks a lost gateway and resumes even without an OS online event', async () => {
    vi.useFakeTimers()
    const bootstrap = bootstrapPage(rewriteMobileIndex(currentIndex(remoteSettingsEntries())))
    bootstrap.nativeFetch.mockResolvedValueOnce(new Response('{}', { status: 503 }))
    bootstrap.nativeFetch.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    try {
      bootstrap.run()
      const suspended = vi.fn()
      const resumed = vi.fn()
      bootstrap.page.addEventListener('offline', suspended)
      bootstrap.page.addEventListener('online', resumed)
      bootstrap.events.dispatch('offline')
      await vi.advanceTimersByTimeAsync(0)
      expect(suspended).toHaveBeenCalledOnce()
      expect(bootstrap.page.navigator.onLine).toBe(false)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(resumed).toHaveBeenCalledOnce()
      expect(bootstrap.page.navigator.onLine).toBe(true)
      expect(bootstrap.nativeFetch).toHaveBeenCalledTimes(2)
    } finally {
      bootstrap.events.dispatch('pagehide')
      vi.useRealTimers()
    }
  })

  it('keeps ordinary page listeners and event-target bookkeeping working', () => {
    const bootstrap = bootstrapPage(rewriteMobileIndex(currentIndex(remoteSettingsEntries())))
    bootstrap.run()
    const received: string[] = []
    const listener = (event: { type: string }): void => { received.push(event.type) }
    bootstrap.page.addEventListener('resize', listener)
    bootstrap.events.dispatch('resize')
    bootstrap.page.removeEventListener('resize', listener)
    bootstrap.events.dispatch('resize')
    expect(received).toEqual(['resize'])
  })

  it.each([
    { name: 'missing Remote assembly', module: remotesModule, change: 'remove' },
    { name: 'duplicate Remote assembly', module: remotesModule, change: 'duplicate' },
    { name: 'Remote assembly without Gateway', module: remotesModule, change: 'dependencies' },
    { name: 'missing Gateway', module: gatewayModule, change: 'remove' },
    { name: 'duplicate Gateway', module: gatewayModule, change: 'duplicate' },
    { name: 'Gateway without Connection', module: gatewayModule, change: 'dependencies' },
  ])('rejects the alpha.2 settings graph with $name', ({ module, change }) => {
    const entries = remoteSettingsEntries()
    const position = entries.findIndex(entry => entry.id === module)
    const entry = entries[position]!
    if (change === 'remove') entries.splice(position, 1)
    else if (change === 'duplicate') entries.push({ ...entry })
    else entry.inject = []
    expect(() => rewriteMobileIndex(currentIndex(entries))).toThrow('settings Remote graph has unsupported dependencies')
  })

  it('rejects settings that has neither the Connection nor the Remote assembly dependency', () => {
    const entries = remoteSettingsEntries()
    entries.find(entry => entry.id === settingsModule)!.inject = [rendererModule]
    expect(() => rewriteMobileIndex(currentIndex(entries))).toThrow('settings module has unsupported dependencies')
  })

  it('accepts the DSH 0.1.1 global injection syntax', () => {
    const output = rewriteMobileIndex(currentIndex([
      {
        id: '@deepseek-ai/dsh-client-ui-layout',
        url: '/layout.js',
        rev: 'layout',
        inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'],
      },
    ]))

    expect(output).toContain('window.__DSH_MOBILE_FRONTEND__="dedicated"')
    expect(output).toContain('globalThis["__DSH_BOOT__"] = {')
    expect(output).toContain('"url":"/mobile-access/mobile-layout.js"')
  })

  it('selects and localizes the dedicated layout language', () => {
    expect(resolveMobileLayoutLanguage('it-IT', ['en-US'])).toBe('it')
    expect(resolveMobileLayoutLanguage('zh-CN', ['it-IT', 'en-US'])).toBe('zh')
    expect(resolveMobileLayoutLanguage('', ['en-GB'])).toBe('en')
    expect(resolveMobileLayoutLanguage('', ['fr-FR'])).toBe('en')
    expect(MOBILE_LAYOUT_MESSAGES.it).toEqual({
      closePanels: 'Chiudi pannelli',
      workspaceNavigation: 'Navigazione area di lavoro e sessioni',
    })
    expect(MOBILE_LAYOUT_MESSAGES.en.closePanels).toBe('Close panels')
    expect(MOBILE_LAYOUT_MESSAGES.zh.workspaceNavigation).toBe('工作区与会话导航')
  })

  it('adapts stable DSH question surfaces for touch screens', () => {
    const narrowStart = MOBILE_LAYOUT_STYLES.indexOf('@media(max-width:600px){')
    const wideStart = MOBILE_LAYOUT_STYLES.indexOf('@media(min-width:900px){')
    expect(narrowStart).toBeGreaterThan(0)
    expect(wideStart).toBeGreaterThan(narrowStart)
    const shared = MOBILE_LAYOUT_STYLES.slice(0, narrowStart)
    const narrow = MOBILE_LAYOUT_STYLES.slice(narrowStart, wideStart)
    expect(shared).not.toContain('[data-question-key]')
    expect(shared).not.toContain('[data-plan-review-key]')
    expect(narrow).toContain('[data-question-key]')
    expect(narrow).toContain('[data-question-scroll]')
    expect(narrow).toContain('[data-plan-review-key]')
    expect(narrow).toContain('[data-plan-review-scroll]')
    expect(narrow).toContain('[data-plan-review-key]>section>div:last-child')
    expect(narrow).toContain('max-height:min(42dvh,360px)')
    expect(narrow).toContain('height:auto!important')
    expect(narrow).toContain('min-height:44px')
  })

  it('treats viewports at least 900px wide as a persistent desktop sidebar', () => {
    expect(WIDE_LAYOUT_MIN_WIDTH_PX).toBe(900)
    expect(isWideViewportLayout(899)).toBe(false)
    expect(isWideViewportLayout(900)).toBe(true)
    expect(isWideViewportLayout(1920)).toBe(true)
  })

  it.each([
    [false, false, false, false],
    [true, false, false, true],
    [false, true, false, true],
    [true, true, false, true],
    [true, false, true, false],
    [false, true, true, true],
    [true, true, true, true],
  ])(
    'shows the modal scrim for sidebar=%s detailsModal=%s wide=%s as %s',
    (sidebarOpen, detailsModalOpen, wideViewport, expected) => {
      expect(isMobileScrimOpen(sidebarOpen, detailsModalOpen, wideViewport)).toBe(expected)
    },
  )

  it('collapses the optional DSH right Sidebar before closing the Mobile drawer', () => {
    const events: string[] = []
    const sidebarRight = {
      expanded: true,
      isExpanded() { return this.expanded },
      toggleExpanded() { this.expanded = !this.expanded; events.push('official') },
    }

    expect(isSidebarRightControl(sidebarRight)).toBe(true)
    closeDetailsFromScrim(sidebarRight, () => { events.push('mobile') })

    expect(sidebarRight.expanded).toBe(false)
    expect(events).toEqual(['official', 'mobile'])
  })

  it('closes locally when the old host has no right-Sidebar service', () => {
    const closeDetails = vi.fn()
    closeDetailsFromScrim(undefined, closeDetails)
    expect(closeDetails).toHaveBeenCalledOnce()
  })

  it('does not reopen an official right Sidebar that is already collapsed', () => {
    const toggleExpanded = vi.fn()
    const closeDetails = vi.fn()
    closeDetailsFromScrim({ isExpanded: () => false, toggleExpanded }, closeDetails)
    expect(toggleExpanded).not.toHaveBeenCalled()
    expect(closeDetails).toHaveBeenCalledOnce()
  })

  it('rejects partial optional service values', () => {
    expect(isSidebarRightControl(null)).toBe(false)
    expect(isSidebarRightControl({ isExpanded: () => true })).toBe(false)
    expect(isSidebarRightControl({ toggleExpanded: () => {} })).toBe(false)
  })

  it.each([
    [375, false, false, false, false, 375],
    [375, false, true, false, false, 375],
    [755, false, true, false, false, 755],
    [756, false, true, false, true, 300],
    [899, false, true, false, true, 405],
    [899, true, true, false, false, 899],
    [900, true, true, false, false, 460],
    [900, false, true, false, true, 405],
    [1039, true, true, false, false, 460],
    [1040, true, true, false, true, 300],
    [1200, true, true, false, true, 460],
    [1200, true, false, false, false, 460],
    [1200, true, true, true, false, 460],
  ] as const)(
    'resolves rightbar viewport=%i sidebar=%s track=%s fullscreen=%s as docked=%s width=%i',
    (viewport, sidebarOpen, track, fullscreen, docked, width) => {
      expect(resolveMobileRightbarLayout(viewport, sidebarOpen, track, fullscreen)).toEqual({ docked, width })
    },
  )

  it('reserves only the resolved native rightbar track', () => {
    expect(MOBILE_LAYOUT_STYLES).toContain('margin-right:0;')
    expect(MOBILE_LAYOUT_STYLES).toContain('.dshm-shell[data-rightbar-docked=true] .dshm-main{margin-right:var(--dshm-rightbar-width)}')
    expect(MOBILE_LAYOUT_STYLES).not.toContain('--dsh-sidebar-width')
    expect(MOBILE_LAYOUT_STYLES).not.toContain('data-dsh-sidebar-dragging')
  })

  it('uses the full phone viewport for the right panel without changing wide docking', () => {
    expect(MOBILE_LAYOUT_STYLES).toContain('@media(max-width:899px){.dshm-details{width:100%;max-width:100%;box-shadow:none}')
    expect(MOBILE_LAYOUT_STYLES).toContain('.dshm-details [data-sidebar-right-toggle],.dshm-details [data-sidebar-right-mode]{min-width:48px;min-height:48px}')
    expect(MOBILE_LAYOUT_STYLES).toContain('.dshm-shell[data-rightbar-docked=true] .dshm-details{position:absolute;width:var(--dshm-rightbar-width)')
    const source = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
    expect(source).toContain('const rightbarFullWidth = state.detailsOpen && !rightbarDocked && !wideViewport')
    expect(source).toContain('const scrimOpen = !rightbarFullWidth && isMobileScrimOpen(')
    expect(source).toContain("rightbarFullWidth ? { inert: '', 'aria-hidden': true } : {}")
  })

  it('draws a theme-aware docked separator without changing geometry or hit targets', () => {
    expect(MOBILE_LAYOUT_STYLES).toContain('.dshm-shell[data-rightbar-docked=true] .dshm-details::after{content:"";position:absolute;inset:0 auto 0 0;width:.5px;background:var(--dsw-alias-border-l4);z-index:11;pointer-events:none}')
  })

  it('suppresses the fixed whale toggle only while the right modal is open', () => {
    const source = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
    expect(source).toContain("'data-right-modal': state.detailsOpen && !rightbarDocked")
    expect(source).toContain("state.detailsOpen && !rightbarDocked ? { inert: '', 'aria-hidden': true } : {}")
    expect(MOBILE_LAYOUT_STYLES).toContain('.dshm-drawer[data-right-modal=true]{display:none!important}')
  })

  it('keeps the narrow overlay drawer CSS untouched while docking the wide sidebar', () => {
    expect(MOBILE_LAYOUT_STYLES).toContain('.dshm-drawer{position:fixed')
    expect(MOBILE_LAYOUT_STYLES).toContain('@media(min-width:900px)')
    expect(MOBILE_LAYOUT_STYLES).toContain('.dshm-shell{grid-template-columns:auto minmax(0,1fr)}')
    expect(MOBILE_LAYOUT_STYLES).toContain('.dshm-main{grid-area:1/2}')
    expect(MOBILE_LAYOUT_STYLES).toContain('.dshm-drawer{position:static')
    expect(MOBILE_LAYOUT_STYLES).toContain('.dshm-drawer[data-open=true]{width:340px')
  })

  it('opens the wide sidebar by default without resetting explicit toggles', () => {
    const source = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
    expect(source).toContain('sidebarOpen: viewportIsWide()')
    expect(source).toContain('sharedController ??= new MobileLayoutController()')
    expect(source).toContain('if (viewportIsWide()) return')
    expect(source).toContain('isMobileScrimOpen(state.sidebarOpen, state.detailsOpen && !rightbarDocked, wideViewport)')
    expect(source).toContain("'aria-hidden': !scrimOpen")
    expect(source).toContain('tabIndex: scrimOpen ? 0 : -1')
  })

  it('projects the current session title into the browser tab like the stock layout', () => {
    const source = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
    expect(source).toContain('session.byId[session.current]?.title')
    expect(source).toContain('document.title = `${sessionTitle} — ${productTitle}`')
    expect(source).toContain('return () => { document.title = productTitle }')
  })

  it('exposes legacy dsh-web pane anchors so community center-column plugins can mount', () => {
    const source = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
    expect(source).toContain("'data-pane': 'conversation'")
    expect(source).toContain("'data-pane': 'sidebar'")
    expect(source).toContain("'data-sidebar-collapsed': ''")
    expect(MOBILE_LAYOUT_STYLES).toContain('.dshm-main{grid-area:1/1;position:relative;')
  })

  it('opens the command menu without summoning the mobile soft keyboard', () => {
    // The composer focuses its editor on purpose when the Add menu opens, so the
    // phone withholds the IME instead of moving that focus: blurring it made the
    // tap feel dead, and a mousedown-only listener never ran on a finger tap.
    const source = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
    expect(source).toContain("document.addEventListener('pointerdown', applyComposerImePolicy, true)")
    expect(source).toContain("document.removeEventListener('pointerdown', applyComposerImePolicy, true)")
    expect(source).toContain("editor.setAttribute('inputmode', 'none')")
    expect(source).toContain("target.matches('input,textarea') || target.isContentEditable")
    expect(source).toContain("active.matches('input,textarea') || active.isContentEditable")
    expect(source).not.toContain('suppressCommandAutofocus')
  })

  it('shares panelInfo between the root hook and layout service', () => {
    const restore = stubClientGlobals()
    try {
      const cleanups: Array<() => void> = []
      const mainEntries: Array<{ options: { key?: string } }> = [{ options: { key: 'alpha' } }]
      let notifyMainEntries = (): void => {}
      let root: { children: Record<string, { kind: string; scope: string }> } | undefined
      let rootComponent: ((props: Record<string, never>) => unknown) | undefined
      let contribution: { hooks: { panelInfo: { getSnapshot: () => { activePanelId: string | null }, subscribe: (listener: () => void) => () => void } } } | undefined
      let layout: {
        panelInfo: { getSnapshot: () => { activePanelId: string | null }, subscribe: (listener: () => void) => () => void }
        selectPanel: (id: string | null) => void
        retainMainPanels: (ids: readonly string[]) => void
        openRightbar: (track?: boolean, fullscreen?: boolean) => void
        closeRightbar: () => void
        beginNavigation: () => AbortSignal
      } | undefined
      let mobileController: { getSnapshot: () => { detailsOpen: boolean } } | undefined
      let sidebarRightService: unknown
      const get = vi.fn((name: string): unknown => name === 'sidebarRight' ? sidebarRightService : undefined)
      const ctx = {
        effect: (effect: () => void | (() => void)) => {
          const cleanup = effect()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        },
        get,
        on: () => () => {},
        reflect: { provide: (name: string, value: unknown) => {
          if (name !== 'layout') return () => {}
          layout = value as typeof layout
          mobileController = value as typeof mobileController
          return () => {}
        } },
        slots: {
          register: (options: Record<string, unknown>, component: unknown) => {
            root = options as typeof root
            rootComponent = component as typeof rootComponent
            return () => {}
          },
          provideRoot: (value: unknown) => { contribution = value as typeof contribution; return () => {} },
          entries: (name: string) => name === 'main' ? mainEntries : [],
          subscribe: (name: string, listener: () => void) => {
            if (name === 'main') notifyMainEntries = listener
            return () => { notifyMainEntries = () => {} }
          },
        },
        theme: { getTheme: () => ({ active: { colorScheme: 'light' as const, tokens: {} } }) },
      }
      applyMobileLayout(ctx as never)

      // The conversation panel moved into this keyed slot in DSH 0.1.5.
      expect(root?.children.main?.kind).toBe('keyed')
      expect(root?.children.main?.scope).toBe('root')
      expect(Object.keys(root?.children ?? {})).toContain('conversation')
      expect(root?.children.rightbar).toEqual({ kind: 'single', scope: 'root' })

      // Missing this hook fails assembly for every usePanelInfo registration.
      const panelInfo = contribution?.hooks.panelInfo
      expect(panelInfo).toBeDefined()
      expect(panelInfo?.getSnapshot()).toEqual({ activePanelId: null })
      expect(layout?.panelInfo).toBe(panelInfo)

      const seen: Array<{ activePanelId: string | null }> = []
      panelInfo?.subscribe(() => { seen.push(panelInfo.getSnapshot()) })
      layout?.selectPanel('alpha')
      mainEntries.splice(0, mainEntries.length, { options: { key: 'beta' } })
      // Validation reads the live registry instead of waiting for its batched
      // subscription notification.
      layout?.selectPanel('beta')
      expect(() => { layout?.selectPanel('missing') }).toThrow('main panel "missing" is not registered')
      mainEntries.splice(0)
      notifyMainEntries()
      expect(seen).toEqual([{ activePanelId: 'alpha' }, { activePanelId: 'beta' }, { activePanelId: null }])

      // DSH 0.1.7-rc.2 client plugins read the same store off the layout
      // service member (ctx.layout.panelInfo), the way the official
      // LayoutController exposes it. Without the member plugin-manager fails
      // activation on the dedicated frontend and open-in-app's shortcut
      // target throws at invocation time.
      const servicePanelInfo = layout?.panelInfo
      expect(servicePanelInfo).toBeDefined()
      expect(servicePanelInfo?.getSnapshot()).toEqual({ activePanelId: null })
      const serviceSeen: Array<{ activePanelId: string | null }> = []
      const disposeServicePanelListener = servicePanelInfo?.subscribe(() => {
        serviceSeen.push(servicePanelInfo.getSnapshot())
      })
      mainEntries.splice(0, mainEntries.length, { options: { key: 'gamma' } })
      layout?.selectPanel('gamma')
      expect(serviceSeen).toEqual([{ activePanelId: 'gamma' }])
      expect(typeof disposeServicePanelListener).toBe('function')
      disposeServicePanelListener?.()

      // The right panel (dsh-better-sidebar and friends) drives the drawer
      // through these two; without them syncPresentation throws.
      expect(typeof layout?.openRightbar).toBe('function')
      expect(typeof layout?.closeRightbar).toBe('function')
      layout?.openRightbar(true, false)
      expect(mobileController?.getSnapshot()).toMatchObject({ detailsOpen: true })
      layout?.closeRightbar()
      expect(mobileController?.getSnapshot()).toMatchObject({ detailsOpen: false })
      expect(get).not.toHaveBeenCalled()

      // The optional service is registered after the layout, so the scrim's
      // callback must discover it when the user acts rather than at boot.
      layout?.openRightbar(true, false)
      const frameElement = rootComponent?.({}) as { props: { requestDetailsClose: () => void } }
      const toggleExpanded = vi.fn()
      sidebarRightService = { isExpanded: () => true, toggleExpanded }
      frameElement.props.requestDetailsClose()
      expect(get).toHaveBeenCalledWith('sidebarRight')
      expect(toggleExpanded).toHaveBeenCalledOnce()
      expect(mobileController?.getSnapshot()).toMatchObject({ detailsOpen: false })

      // The new-session button goes startSession -> openWorkspace ->
      // ctx.layout.beginNavigation(); a missing method made it silently no-op.
      const first = layout?.beginNavigation()
      const second = layout?.beginNavigation()
      expect(first).toBeInstanceOf(AbortSignal)
      expect(first?.aborted).toBe(true)
      expect(second?.aborted).toBe(false)
      expect(AbortSignal.any([second as AbortSignal]).aborted).toBe(false)

      for (const cleanup of cleanups.reverse()) cleanup()
      expect(second?.aborted).toBe(true)

      const source = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
      expect(source).toContain("entryKey: state.panelInfo.activePanelId ?? 'conversation'")
      expect(source).toContain("fallback: props.renderSlot('conversation', {})")
      expect(source).toContain("hasSession ? props.renderSlot('details', {}) : undefined")
      expect(source).toContain('disposePanelInfo()')
      // A phone-width viewport must still report room: reporting false makes
      // RightbarSeat collapse the surface right after it opens.
      expect(source).toContain('canShow: true')
      expect(source).not.toContain('canShow: window.innerWidth >=')
      expect(source).toContain("ctx.get('sidebarRight')")
      expect(source).toContain("export const inject: readonly string[] = ['slots', 'theme']")
      expect(source).not.toMatch(/export const inject[^\n]*sidebarRight/u)
    } finally {
      restore()
    }
  })

  it('keeps the legacy layout usable when the renderer cannot publish root hooks', () => {
    const restore = stubClientGlobals()
    const cleanups: Array<() => void> = []
    try {
      expect(() => { applyMobileLayout({
        effect: (effect: () => void | (() => void)) => {
          const cleanup = effect()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        },
        get: () => undefined,
        on: () => () => {},
        reflect: { provide: () => () => {} },
        slots: {
          register: () => () => {},
          entries: () => [],
          subscribe: () => () => {},
        },
        theme: { getTheme: () => ({ active: { colorScheme: 'light' as const, tokens: {} } }) },
      } as never) }).not.toThrow()
    } finally {
      for (const cleanup of cleanups.reverse()) cleanup()
      restore()
    }
  })

  it('fails closed when the upstream page cannot identify one layout module', () => {
    expect(() => rewriteMobileIndex(index([]))).toThrow('no unique layout module')
    expect(() => rewriteMobileIndex('<html></html>')).toThrow('no boot manifest')
  })

  it('fails closed when the stock layout dependency contract changes', () => {
    expect(() => rewriteMobileIndex(index([
      { id: '@deepseek-ai/dsh-client-ui-layout', url: '/layout.js', rev: 'layout', inject: ['new-runtime'] },
    ]))).toThrow('unsupported dependencies')
  })
})

const layoutId = '@deepseek-ai/dsh-client-ui-layout'
const chartLayoutInject = ['@deepseek-ai/dsh-client-locale', rendererModule, '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-theme']

function batchedIndex(ids: string[]): string {
  const others = ids
    .filter(id => id !== layoutId)
    .map(id => ({ id, url: `/plugins/${id}.js`, rev: 'r' }))
  const layout = { id: layoutId, url: '/plugins/layout.js', rev: 'rl', inject: chartLayoutInject }
  const entries = [...others, layout]
  const graph = {
    rev: 'stock',
    entries,
    batches: [{ phase: 'application', url: '/plugins/application.js', rev: 'stock-batch', entries: entries.map(entry => entry.id) }],
  }
  return `<!doctype html><html><head><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)};</script></head><body></body></html>`
}

function exclusionIndex(extra: BootEntry[] = [], separate: string[] = []): string {
  const base: BootEntry[] = [
    { id: 'bootstrap', url: '/plugins/bootstrap.js', rev: 'bootstrap' },
    { id: '@deepseek-ai/dsh-client-runtime', url: '/plugins/runtime.js', rev: 'runtime' },
    { id: '@deepseek-ai/dsh-client-ui-theme', url: '/plugins/theme.js', rev: 'theme' },
    { id: connectionModule, url: '/plugins/connection.js', rev: 'connection' },
    { id: layoutId, url: '/plugins/layout.js', rev: 'layout', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'] },
    { id: 'dsh-mobile', url: '/plugins/dsh-mobile.js', rev: 'mobile', inject: [connectionModule, '@deepseek-ai/dsh-client-ui-sidebar'] },
  ]
  const entries = [...base, ...extra]
  const graph = {
    rev: 'stock',
    entries,
    batches: [
      { phase: 'bootstrap', url: '/plugins/bootstrap-batch.js', rev: 'bootstrap-batch', entries: ['bootstrap'] },
      { phase: 'application', url: '/plugins/application.js', rev: 'app-batch', entries: entries.map(entry => entry.id).filter(id => id !== 'bootstrap' && !separate.includes(id)) },
      ...(separate.length > 0 ? [{ phase: 'application', url: '/plugins/separate.js', rev: 'separate-batch', entries: separate }] : []),
    ],
  }
  const preloads = graph.batches.filter(batch => batch.phase === 'application')
    .map(batch => `<link rel="preload" as="script" href="${batch.url}">`).join('')
  return `<!doctype html><html><head><link rel="preload" as="image" href="/unrelated.png">${preloads}<script src="/plugins/bootstrap-batch.js"></script><script>globalThis["__DSH_BOOT__"] = ${JSON.stringify(graph)};</script></head><body></body></html>`
}

function parsedBoot(html: string): { rev: string; entries: BootEntry[]; batches: { phase: string; url: string; entries: string[] }[] } {
  const text = /globalThis\["__DSH_BOOT__"\] = (\{.*\});<\/script>/u.exec(html)?.[1]
  if (text === undefined) throw new Error('missing boot graph')
  return JSON.parse(text) as { rev: string; entries: BootEntry[]; batches: { phase: string; url: string; entries: string[] }[] }
}

describe('optional mobile client module exclusion', () => {
  const leaf: BootEntry = { id: '@example/leaf', url: '/plugins/leaf.js', rev: 'leaf' }

  it('keeps the default graph and removes selected entries before forming batches and revision', () => {
    const html = exclusionIndex([leaf, { id: '@example/solo', url: '/plugins/solo.js', rev: 'solo' }], ['@example/solo'])
    const original = parsedBoot(rewriteMobileIndex(html))
    const selected = parsedBoot(rewriteMobileIndex(html, ['@example/leaf', '@example/solo']))
    expect(original.entries.map(entry => entry.id)).toContain('@example/leaf')
    expect(selected.entries.map(entry => entry.id)).not.toContain('@example/leaf')
    expect(selected.entries.map(entry => entry.id)).not.toContain('@example/solo')
    expect(selected.batches.flatMap(batch => batch.entries)).not.toContain('@example/leaf')
    expect(selected.batches.flatMap(batch => batch.entries)).not.toContain('@example/solo')
    expect(selected.batches.some(batch => batch.url === '/plugins/separate.js')).toBe(false)
    expect(rewriteMobileIndex(html, ['@example/leaf', '@example/solo'])).not.toContain('href="/plugins/application.js"')
    expect(rewriteMobileIndex(html, ['@example/leaf', '@example/solo'])).not.toContain('href="/plugins/separate.js"')
    expect(rewriteMobileIndex(html, ['@example/leaf', '@example/solo'])).toContain('<link rel="preload" as="image" href="/unrelated.png">')
    expect(rewriteMobileIndex(html, ['@example/leaf', '@example/solo'])).toContain('<script src="/plugins/bootstrap-batch.js"></script>')
    expect(selected.rev).not.toBe(original.rev)
    const plan = parseMobileBootPlan(html, ['@example/leaf', '@example/solo'])
    expect(plan.planEntries?.map(entry => entry.id)).not.toContain('@example/leaf')
  })

  it('rejects missing, core, immediate, and bootstrap modules', () => {
    const html = exclusionIndex([leaf, { id: '@example/urgent', url: '/plugins/urgent.js', rev: 'urgent', immediately: true }])
    for (const id of [layoutId, connectionModule, 'dsh-mobile', '@example/urgent', 'bootstrap']) {
      expect(() => rewriteMobileIndex(html, [id])).toThrow(`module ${id} is required for mobile boot or belongs to a bootstrap batch`)
    }
    expect(() => rewriteMobileIndex(html, ['@example/missing'])).toThrow('module @example/missing is not installed')
    expect(() => rewriteMobileIndex(html, ['@example/leaf', '@example/leaf'])).toThrow('duplicate module ids')
  })

  it('rejects exclusions still required by a retained inject or external edge', () => {
    const injected: BootEntry = { id: '@example/inject-consumer', url: '/plugins/inject.js', rev: 'inject', inject: [leaf.id] }
    const external: BootEntry = { id: '@example/external-consumer', url: '/plugins/external.js', rev: 'external', external: [`${leaf.id}/client`] }
    expect(() => rewriteMobileIndex(exclusionIndex([leaf, injected]), [leaf.id])).toThrow(`module ${injected.id} still depends on excluded module ${leaf.id}`)
    expect(() => rewriteMobileIndex(exclusionIndex([leaf, external]), [leaf.id])).toThrow(`module ${external.id} still depends on excluded module ${leaf.id}`)
    const selected = parsedBoot(rewriteMobileIndex(exclusionIndex([leaf, injected, external]), [leaf.id, injected.id, external.id]))
    expect(selected.entries.map(entry => entry.id)).not.toContain(leaf.id)
  })

  it('reassembles a second application batch when an excluded module shares it with retained modules', () => {
    const html = exclusionIndex([leaf, { id: '@example/other', url: '/plugins/other.js', rev: 'other' }], [leaf.id, '@example/other'])
    const output = rewriteMobileIndex(html, [leaf.id])
    const graph = parsedBoot(output)
    expect(graph.entries.map(entry => entry.id)).not.toContain(leaf.id)
    expect(graph.batches.flatMap(batch => batch.entries)).toContain('@example/other')
    expect(graph.batches.flatMap(batch => batch.entries)).not.toContain(leaf.id)
    expect(graph.batches.filter(batch => batch.url.startsWith('/mobile-access/mobile-boot/'))).toHaveLength(2)
    expect(output).not.toContain('href="/plugins/separate.js"')
    expect((output.match(/<link rel="preload" as="script" href="\/mobile-access\/mobile-boot\//gu) ?? [])).toHaveLength(2)
  })

  it('can omit document preview with its dependent Open In entry across application batches', () => {
    const documentPreview = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
    const openInApp = '@deepseek-ai/dsh-client-ui-open-in-app'
    const html = exclusionIndex([
      { id: documentPreview, url: '/plugins/document-preview.js', rev: 'preview' },
      { id: openInApp, url: '/plugins/open-in-app.js', rev: 'open', inject: [documentPreview] },
      { id: '@example/retained', url: '/plugins/retained.js', rev: 'retained' },
    ], [openInApp, '@example/retained'])
    expect(() => rewriteMobileIndex(html, [documentPreview])).toThrow(`module ${openInApp} still depends on excluded module ${documentPreview}`)
    const output = rewriteMobileIndex(html, [documentPreview, openInApp])
    const graph = parsedBoot(output)
    expect(graph.entries.map(entry => entry.id)).not.toContain(documentPreview)
    expect(graph.entries.map(entry => entry.id)).not.toContain(openInApp)
    expect(graph.entries.map(entry => entry.id)).toContain('@example/retained')
    expect(graph.batches.flatMap(batch => batch.entries)).toContain('@example/retained')
    expect(output).not.toContain('href="/plugins/application.js"')
    expect(output).not.toContain('href="/plugins/separate.js"')
  })

  it('rewrites an entity-escaped application preload to the actual mobile batch', () => {
    const html = exclusionIndex([leaf]).replaceAll('/plugins/application.js', '/plugins/application.js?a=1&amp;b=2')
      .replace('"url":"/plugins/application.js?a=1&amp;b=2"', '"url":"/plugins/application.js?a=1&b=2"')
    const output = rewriteMobileIndex(html, [leaf.id])
    expect(output).not.toContain('href="/plugins/application.js?a=1&amp;b=2"')
    expect(output).toMatch(/<link rel="preload" as="script" href="\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js">/u)
  })

  it('requires a complete batched graph when exclusion is selected', () => {
    expect(() => rewriteMobileIndex(index([{ id: layoutId, url: '/layout.js', rev: 'layout', inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme'] }]), [leaf.id]))
      .toThrow('this DSH version has no batched boot manifest')
  })
})

describe('mobile boot batch chunking', () => {
  it('merges every entry into one batch when no sizes are provided', () => {
    const plan = parseMobileBootPlan(batchedIndex(['a', 'b']))
    expect(plan.planEntries).toBeDefined()
    const split = splitMobileBootBatch(plan.planEntries!, new Map(), new Set())
    expect(split.plans).toHaveLength(1)
    expect(split.rows).toHaveLength(1)
    expect(split.rows[0]!.url).toMatch(/^\/mobile-access\/mobile-boot\/[a-f\d]{64}\.js$/u)
    expect(split.rows[0]!.entries).toEqual(expect.arrayContaining(['a', 'b', layoutId]))
  })

  it('passes an entry at the per-entry cap through its own batch', () => {
    const plan = parseMobileBootPlan(batchedIndex(['a', 'b']))
    const split = splitMobileBootBatch(plan.planEntries!, new Map([
      ['/plugins/a.js', 9 * 1024 * 1024],
      ['/plugins/b.js', 4096],
    ]), new Set())
    expect(split.plans).toHaveLength(1)
    expect(split.rows).toHaveLength(2)
    const solo = split.rows.find(row => row.entries.length === 1 && row.entries[0] === 'a')
    expect(solo).toBeDefined()
    expect(solo!.url).toBe('/plugins/a.js')
    expect(solo!.rev).toBe('r')
    const merged = split.rows.find(row => row.url.startsWith('/mobile-access/mobile-boot/'))
    expect(merged!.entries).toEqual(expect.arrayContaining([layoutId, 'b']))
    expect(split.rows.flatMap(row => row.entries).sort()).toEqual(['a', 'b', layoutId].sort())
  })

  it('only rejects what the caller measured or explicitly flagged', () => {
    const plan = parseMobileBootPlan(batchedIndex(['a', 'b']))
    const split = splitMobileBootBatch(plan.planEntries!, new Map(), new Set(['/plugins/a.js']))
    expect(split.rows.find(row => row.entries.length === 1 && row.entries[0] === 'a')?.url).toBe('/plugins/a.js')
    expect(split.rows.find(row => row.url.startsWith('/mobile-access/'))?.entries).toEqual(expect.arrayContaining([layoutId, 'b']))
  })

  it('chunks a large application batch into multiple merged batches', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const plan = parseMobileBootPlan(batchedIndex(ids))
    const sizes = new Map(ids.map(id => [`/plugins/${id}.js`, 5 * 1024 * 1024]))
    const split = splitMobileBootBatch(plan.planEntries!, sizes, new Set())
    expect(split.plans.length).toBeGreaterThan(1)
    expect(split.rows.filter(row => row.url.startsWith('/mobile-access/'))).toHaveLength(split.plans.length)
    expect(split.rows.filter(row => row.url.startsWith('/plugins/'))).toHaveLength(0)
    expect(split.rows.flatMap(row => row.entries).sort()).toEqual([...ids, layoutId].sort())
  })

  it('keeps the layout module inside a merged batch even when the batch is otherwise oversized', () => {
    const plan = parseMobileBootPlan(batchedIndex(['a']))
    const split = splitMobileBootBatch(plan.planEntries!, new Map([
      ['/plugins/a.js', 9 * 1024 * 1024],
    ]), new Set())
    const merged = split.rows.find(row => row.url.startsWith('/mobile-access/mobile-boot/'))
    expect(merged?.entries).toEqual([layoutId])
    expect(split.rows.filter(row => row.url.startsWith('/plugins/')).map(row => row.entries[0])).toEqual(['a'])
  })
})

/**
 * Element stub whose `closest` answers the whole ancestor chain with one answer.
 * @param found - whether the queried selector matches anywhere up the chain.
 * @returns the stub, cast to the element the policy reads.
 */
function closestStub(found: boolean): Element {
  return { closest: () => (found ? {} : null) } as unknown as Element
}

describe('composer soft-keyboard policy', () => {
  it('withholds the IME for the Add trigger on a touch-primary device', () => {
    expect(resolveComposerImePolicy(closestStub(true), true)).toBe('withhold')
  })

  it('matches only a listbox trigger inside the composer card', () => {
    let queried = ''
    const target = { closest: (selector: string) => { queried = selector; return null } } as unknown as Element
    expect(resolveComposerImePolicy(target, true)).toBe('restore')
    expect(queried).toBe('[data-composer-card] button[aria-haspopup="listbox"]')
  })

  it('restores the IME for every other tap on a touch-primary device', () => {
    // The composer itself is the important case: reaching for the draft has to
    // bring the keyboard back, or the withheld attribute would strand it.
    expect(resolveComposerImePolicy(closestStub(false), true)).toBe('restore')
  })

  it('leaves a device with a real keyboard untouched', () => {
    expect(resolveComposerImePolicy(closestStub(true), false)).toBe('ignore')
    expect(resolveComposerImePolicy(closestStub(false), false)).toBe('ignore')
  })

  it('ignores a pointer event with no element target', () => {
    expect(resolveComposerImePolicy(null, true)).toBe('ignore')
    expect(resolveComposerImePolicy(null, false)).toBe('ignore')
  })

  it('treats only the composer as its own keyboard owner', () => {
    expect(isComposerOwnedFocus(closestStub(true))).toBe(true)
    expect(isComposerOwnedFocus(closestStub(false))).toBe(false)
    expect(isComposerOwnedFocus(null)).toBe(false)
  })

  it('gates on the no-hover query rather than a viewport width', () => {
    expect(TOUCH_PRIMARY_QUERY).toBe('(hover: none), (pointer: coarse)')
  })

  it('stops withholding the IME once the surface goes away', () => {
    // A withheld editor outliving the surface would strand the composer without
    // a keyboard for the rest of the session.
    const source = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
    expect(source).toContain('`${COMPOSER_CARD_SELECTOR} [inputmode="none"]`')
    expect(source).toContain("editor.removeAttribute('inputmode')")
  })

  it('only suppresses composer autofocus while changing Sessions on a touch device', () => {
    const source = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
    expect(source).toContain('if (performance.now() < suppressComposerUntil.current) target.blur()')
    expect(source).toContain('isSessionRowNavigation(event.target) && window.matchMedia(TOUCH_PRIMARY_QUERY).matches')
    expect(source).toContain("editor.setAttribute('inputmode', 'none')")
    expect(source).toContain('if (document.activeElement === editor) editor.blur()')
    expect(source).toContain('suppressComposerUntil.current = 0')
    expect(source).toContain('restoreNavigationIme()')
    expect(source).toContain('if (viewportIsWide()) return')
    expect(source.indexOf('isSessionRowNavigation(event.target)')).toBeLessThan(source.indexOf('if (viewportIsWide()) return', source.indexOf('const closeDrawerAfterSessionAction')))
  })

  it('recognizes another Session row without treating the current row or its menu as navigation', () => {
    const target = (selected: boolean, menu: boolean): Element => {
      const row = { getAttribute: () => String(selected) }
      const action = menu ? {} : null
      return { closest: (selector: string) => selector.startsWith('[role="treeitem"]') ? row : action } as unknown as Element
    }
    expect(isSessionRowNavigation(target(false, false))).toBe(true)
    expect(isSessionRowNavigation(target(true, false))).toBe(false)
    expect(isSessionRowNavigation(target(false, true))).toBe(false)
    expect(isSessionRowNavigation(null)).toBe(false)
  })
})
