import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { rewriteMobileIndex } from '../src/gateway.js'
import { CSRF_COOKIE, CSRF_HEADER } from '../src/http-security.js'
import {
  MOBILE_LAYOUT_MESSAGES,
  MOBILE_LAYOUT_STYLES,
  WIDE_LAYOUT_MIN_WIDTH_PX,
  apply as applyMobileLayout,
  closeDetailsFromScrim,
  isMobileScrimOpen,
  isSidebarRightControl,
  isWideViewportLayout,
  resolveMobileLayoutLanguage,
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

function bootstrapPage(html: string, existingTransport?: TransportHooks) {
  const nativeFetch = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
  const nativeBridge = Object.freeze({ request: vi.fn() })
  const page: {
    fetch: typeof fetch
    __DSH_TRANSPORT__?: TransportHooks
    __DSH_BOOT__?: unknown
    __DSH_MOBILE_FRONTEND__?: string
    dshMobileNative: typeof nativeBridge
  } = { fetch: nativeFetch, dshMobileNative: nativeBridge }
  if (existingTransport !== undefined) page.__DSH_TRANSPORT__ = existingTransport
  const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1]
  if (script === undefined) throw new Error('missing bootstrap script')
  return {
    page,
    nativeFetch,
    nativeBridge,
    run() {
      runInNewContext(script, {
        window: page,
        globalThis: page,
        document: { cookie: `${CSRF_COOKIE}=paired-csrf-token` },
        location: new URL('https://phone.example/'),
        Headers, Request, URL,
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
    expect(output).toContain(`"entries":${JSON.stringify(entries.map(entry => entry.id))}`)
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
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-question-key]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-question-scroll]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-plan-review-key]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-plan-review-scroll]')
    expect(MOBILE_LAYOUT_STYLES).toContain('[data-plan-review-key]>section>div:last-child')
    expect(MOBILE_LAYOUT_STYLES).toContain('max-height:min(42dvh,360px)')
    expect(MOBILE_LAYOUT_STYLES).toContain('height:auto!important')
    expect(MOBILE_LAYOUT_STYLES).toContain('min-height:44px')
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
    [false, true, true, false],
    [true, true, true, false],
  ])(
    'shows the modal scrim for sidebar=%s details=%s wide=%s as %s',
    (sidebarOpen, detailsOpen, wideViewport, expected) => {
      expect(isMobileScrimOpen(sidebarOpen, detailsOpen, wideViewport)).toBe(expected)
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
    expect(source).toContain('isMobileScrimOpen(state.sidebarOpen, state.detailsOpen, wideViewport)')
    expect(source).toContain("'aria-hidden': !scrimOpen")
    expect(source).toContain('tabIndex: scrimOpen ? 0 : -1')
  })

  it('projects the current session title into the browser tab like the stock layout', () => {
    const source = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
    expect(source).toContain('session.byId[session.current]?.title')
    expect(source).toContain('document.title = `${sessionTitle} — ${productTitle}`')
    expect(source).toContain('return () => { document.title = productTitle }')
  })

  it('opens the command menu without restoring focus to the mobile editor', () => {
    const source = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
    expect(source).toContain("event.target.closest('button[aria-haspopup=\"listbox\"]')")
    expect(source).toContain("target.matches('input,textarea') || target.isContentEditable")
    expect(source).toContain("active.matches('input,textarea') || active.isContentEditable")
  })

  it('publishes the root panelInfo hook the official layout owns', () => {
    const restore = stubClientGlobals()
    try {
      const cleanups: Array<() => void> = []
      const mainEntries: Array<{ options: { key?: string } }> = [{ options: { key: 'alpha' } }]
      let notifyMainEntries = (): void => {}
      let root: { children: Record<string, { kind: string; scope: string }> } | undefined
      let rootComponent: ((props: Record<string, never>) => unknown) | undefined
      let contribution: { hooks: { panelInfo: { getSnapshot: () => { activePanelId: string | null }, subscribe: (listener: () => void) => () => void } } } | undefined
      let layout: {
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
