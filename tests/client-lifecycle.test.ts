import { readFileSync, readdirSync } from 'node:fs'
import postcss from 'postcss'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectConnectionDiagnostics, type DiagnosticSnapshot } from '../src/diagnostics.js'
import {
  apply,
  bindClientResponseLifetime,
  combineClientSignalLifetime,
  combineClientSignals,
  CONTROL_STYLES,
  createFrpServerTemplateForClipboard,
  createFrpAttachFrpcTomlForClipboard,
  createFrpAttachTemplateForClipboard,
  frpAttachFormErrorCode,
  clientReleaseInfo,
  diagnosticEntriesForRender,
  diagnosticControllerAction,
  diagnosticOverallForChecks,
  diagnosticServerCopy,
  DIAGNOSTIC_REASON_MESSAGES,
  extensionActionRequestInit,
  LOCALIZED_DIAGNOSTIC_COPY,
  extensionAssetUrl,
  extensionGenerationHeaders,
  extensionRouteUrl,
  failClosedExtensionGenerationReplacement,
  handleMissingExtensionManifest,
  installDshLanguageBoundSurface,
  installMobileNativeBack,
  installMobilePushBrowserClient,
  MOBILE_CONTROL_MESSAGES,
  mobileBackBlockedMessage,
  normalizeDiagnosticOverall,
  normalizeDiagnosticStatus,
  parseMobileExtensionManifest,
  PerIdActivationLifecycle,
  publishAuthoritativeExtensionIds,
  reconcileRemovedExtensions,
  registerUniqueDisposable,
  renderDiagnosticPayloadSafely,
  selectMobileControlLocale,
  setMobileSurfaceOpen,
  parseMobileRemoteProvider,
  startExtensionChangeStream,
  startLifecycleRefreshScheduler,
  validateDiagnosticChecks,
} from '../src/client.js'

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
}

class FakeWindow extends EventTarget {
  setTimeout = ((handler: TimerHandler, timeout?: number) => globalThis.setTimeout(handler, timeout)) as Window['setTimeout']
  clearTimeout = ((id: number) => globalThis.clearTimeout(id)) as Window['clearTimeout']
}

class BackNode extends EventTarget {
  hidden = false
  inert = false
  display = 'block'
  visibility = 'visible'
  rects = 1
  textContent = ''
  parentElement: BackNode | null = null
  readonly children: BackNode[] = []
  readonly attributes = new Map<string, string>()
  readonly dataset: Record<string, string> = {}
  clicks = 0
  onClick?: () => void

  constructor(readonly tagName = 'DIV', private readonly root = false) { super() }

  get isConnected(): boolean { return this.root || this.parentElement?.isConnected === true }
  get firstElementChild(): BackNode | null { return this.children[0] ?? null }
  get lastElementChild(): BackNode | null { return this.children.at(-1) ?? null }
  getClientRects(): readonly object[] { return this.rects > 0 ? [{}] : [] }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  contains(candidate: BackNode | null): boolean {
    for (let node = candidate; node !== null; node = node.parentElement) { if (node === this) return true }
    return false
  }
  append(child: BackNode): void {
    if (child.parentElement !== null) child.parentElement.children.splice(child.parentElement.children.indexOf(child), 1)
    child.parentElement = this
    this.children.push(child)
  }
  remove(): void {
    if (this.parentElement === null) return
    this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1)
    this.parentElement = null
  }
  closest(_selector: string): BackNode | null {
    for (let node: BackNode | null = this; node !== null; node = node.parentElement) {
      if (node.hidden || node.inert || node.getAttribute('aria-hidden') === 'true') return node
    }
    return null
  }
  click(): void { this.clicks += 1; this.onClick?.() }
}

class BackDocument extends EventTarget {
  readonly body = new BackNode('BODY', true)
  activeElement: BackNode | null = null

  private nodes(): BackNode[] {
    const all: BackNode[] = []
    const visit = (node: BackNode): void => { for (const child of node.children) { all.push(child); visit(child) } }
    visit(this.body)
    return all
  }

  getElementById(id: string): BackNode | null { return this.nodes().find(node => node.getAttribute('id') === id) ?? null }

  querySelectorAll(selector: string): BackNode[] {
    const all = this.nodes()
    if (selector.includes('dsh-mobile-surface-placement')) {
      return all.filter(node => node.dataset.dshMobileSurfacePlacement === 'page' || node.dataset.dshMobileSurfacePlacement === 'overlay')
    }
    if (selector.includes('dsh-mobile-composer-model-trigger')) {
      return all.filter(node => node.getAttribute('data-dsh-mobile-composer-model-trigger') !== null
        && node.getAttribute('aria-expanded') === 'true')
    }
    return all.filter(node => (node.getAttribute('role') === 'dialog' && node.getAttribute('aria-modal') === 'true')
      || node.getAttribute('role') === 'menu'
      || (selector.includes('[role="group"][id]') && node.getAttribute('role') === 'group' && node.getAttribute('id') !== null))
  }
}

class BackWindow extends EventTarget {
  getComputedStyle(node: BackNode): { display: string; visibility: string } {
    return { display: node.display, visibility: node.visibility }
  }
}

function backEvent(cancelable = true): Event { return new Event('dsh-mobile:native-back', { cancelable, bubbles: true }) }

class BackKeyboardEvent extends Event {
  readonly key: string
  readonly code: string
  constructor(type: string, options: KeyboardEventInit) {
    super(type, options)
    this.key = options.key ?? ''
    this.code = options.code ?? ''
  }
}

function composerModelBackFixture(role: 'menu' | 'group' = 'menu'): {
  readonly page: BackDocument; readonly trigger: BackNode; readonly popup: BackNode; readonly action: BackNode
} {
  vi.stubGlobal('KeyboardEvent', BackKeyboardEvent)
  const page = new BackDocument()
  const trigger = new BackNode('BUTTON')
  trigger.setAttribute('data-dsh-mobile-composer-model-trigger', 'true')
  trigger.setAttribute('aria-expanded', 'true')
  trigger.setAttribute('aria-controls', 'composer-model-menu')
  const popup = new BackNode(); popup.setAttribute('id', 'composer-model-menu'); popup.setAttribute('role', role)
  popup.setAttribute('data-menu-material', 'translucent')
  const action = new BackNode('BUTTON'); action.setAttribute('role', 'menuitemradio')
  popup.append(action); page.body.append(trigger); page.body.append(popup)
  return { page, trigger, popup, action }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function fixture(search = '') {
  const config = { available: true, installationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', publicKey: 'AQID', keyFingerprint: 'fp', ownerGeneration: 1, registrationGeneration: 0, status: 'disabled' as const, preferences: { question: true, plan: true, approval: true, response: true, goal: true, failure: true } }
  const api = {
    getConfig: vi.fn(async () => config), enroll: vi.fn(async () => ({ registration: {} })),
    disable: vi.fn(async () => undefined), updatePreferences: vi.fn(async () => undefined),
    sendTest: vi.fn(async () => undefined), resolve: vi.fn(async () => ({ sessionId: 's1', interaction: 'resolved' as const })),
  }
    const manager = { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => { throw new Error('unexpected permission prompt') }) }
    const environment = { secureContext: true, isTopLevel: true, standalone: true, permission: 'default' as const, pushManager: manager, origin: 'https://example.test', randomUUID: () => config.installationId }
    const page = new EventTarget() as Document & { visibilityState: DocumentVisibilityState; querySelector: (selector: string) => Element | null }
    Object.defineProperty(page, 'visibilityState', { value: 'visible', writable: true })
    page.querySelector = (selector: string) => selector.includes('dsh-mobile-gateway') ? ({}) as Element : null
    const history = { replaceState: vi.fn() }
    const view = new EventTarget() as Window & { location: Location; history: History }
    Object.defineProperty(view, 'location', { value: { search, pathname: '/', hash: '' }, writable: true, configurable: true })
    Object.defineProperty(view, 'history', { value: history })
    view.__DSH_MOBILE_FRONTEND__ = 'dedicated'
    const slotRegistrations: Array<{ options: unknown; component: (props: unknown) => unknown }> = []
    const serviceQueries: string[] = []
    const navigationInjections: Array<{ services: string[]; childDisposers: Array<() => void>; dispose: ReturnType<typeof vi.fn> }> = []
    const sessions = { list: { getSnapshot: () => ({ phase: 'ready', byId: { s1: {} }, ids: ['s1'] }), subscribe: () => () => undefined } }
    const workspaces = { list: { getSnapshot: () => ({ phase: 'ready', items: [] }), subscribe: () => () => undefined } }
    const uiWorkspace = { openSession: vi.fn() }
    // `inject` mirrors the public Cordis child lifecycle with already-active
    // providers: the callback runs immediately on the declared services.
    const context: {
      sessions: typeof sessions
      workspaces: typeof workspaces
      uiWorkspace: { openSession(id: string): void }
      get(name: string): unknown
      inject(services: readonly string[], callback: (child: unknown) => (() => void) | undefined): { dispose(): unknown }
      slots: { inject(key: string, callback: () => () => void): ReturnType<typeof vi.fn>; register(options: unknown, component: (props: unknown) => unknown): ReturnType<typeof vi.fn> }
    } = {
      sessions, workspaces, uiWorkspace,
      get(name: string): unknown {
        serviceQueries.push(name)
        if (name === 'sessions') return sessions
        if (name === 'workspaces') return workspaces
        if (name === 'uiWorkspace') return uiWorkspace
        return undefined
      },
      inject(services: readonly string[], callback: (child: unknown) => (() => void) | undefined) {
        const record = { services: [...services], childDisposers: [] as Array<() => void>, dispose: vi.fn() }
        navigationInjections.push(record)
        const childDisposer = callback({ sessions, workspaces, uiWorkspace })
        if (childDisposer !== undefined) record.childDisposers.push(childDisposer)
        return { dispose: () => { record.dispose(); for (const dispose of record.childDisposers.splice(0)) dispose() } }
      },
      slots: {
        inject(key: string, callback: () => () => void) { expect(key).toBe('settings.general.item'); callback(); return vi.fn() },
        register(options: unknown, component: (props: unknown) => unknown) { slotRegistrations.push({ options, component }); return vi.fn() },
      },
    }
    return { api, manager, environment, page, view, history, context, slotRegistrations, serviceQueries, navigationInjections }
  }

describe('dedicated browser push client entry', () => {
  it.each(['stock', 'native', 'unauthenticated'] as const)('leaves %s contexts inert', contextKind => {
    const test = fixture()
    if (contextKind === 'native') test.view.__DSH_MOBILE_NATIVE__ = { capabilities: () => [], invoke: async () => undefined }
    if (contextKind === 'stock') delete test.view.__DSH_MOBILE_FRONTEND__
    if (contextKind === 'unauthenticated') test.page.querySelector = () => null
    const dispose = installMobilePushBrowserClient(test.context as never, { view: test.view, page: test.page, api: test.api as never, environment: test.environment })
    expect(test.api.getConfig).not.toHaveBeenCalled()
    expect(test.slotRegistrations).toHaveLength(0)
    expect(test.manager.subscribe).not.toHaveBeenCalled()
    dispose()
  })

  it('starts without prompting, mounts the separate order-120 row, refreshes on focus and disposes without opting out', async () => {
    const test = fixture()
    const dispose = installMobilePushBrowserClient(test.context as never, { view: test.view, page: test.page, api: test.api as never, environment: test.environment })
    await Promise.resolve()
    expect(test.api.getConfig).toHaveBeenCalledExactlyOnceWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(test.manager.subscribe).not.toHaveBeenCalled()
    expect(test.slotRegistrations).toHaveLength(1)
    expect(test.slotRegistrations[0]?.options).toMatchObject({ id: 'dsh-mobile-push-browser', order: 120 })
    test.view.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(test.api.getConfig).toHaveBeenCalledTimes(2)
    dispose()
    test.view.dispatchEvent(new Event('focus'))
    await Promise.resolve()
    expect(test.api.getConfig).toHaveBeenCalledTimes(2)
    expect(test.api.disable).not.toHaveBeenCalled()
  })

  it('routes default browser mutations through the existing one-shot CSRF mobileRequest transport', async () => {
    const test = fixture()
    const page = test.page as Document & { cookie: string }
    page.cookie = 'dsh_ma_csrf=csrf-token'
    Object.defineProperty(page, 'documentElement', { value: { lang: 'en' } })
    vi.stubGlobal('document', page)
    vi.stubGlobal('navigator', { language: 'en', languages: ['en'] })
    vi.stubGlobal('location', { href: 'https://example.test/', origin: 'https://example.test' })
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    const dispose = installMobilePushBrowserClient(test.context as never, { view: test.view, page: test.page, environment: test.environment })
    for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 0))
    const row = test.slotRegistrations[0]?.component({}) as { props?: { controller?: { disable(): Promise<void> } } } | undefined
    expect(row?.props?.controller).toBeDefined()
    await row?.props?.controller?.disable()
    expect(fetch).toHaveBeenCalledTimes(3)
    const [, post] = fetch.mock.calls[1]!
    const headers = new Headers(post?.headers)
    expect(headers.get('x-dsh-mobile-csrf')).toBe('csrf-token')
    expect(headers.get('content-type')).toBe('application/json')
    expect(post).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
    dispose()
  })

  it('owns browser push once through apply effects and disposes its single lifecycle', async () => {
    const test = fixture()
    const effects: Array<{ label?: string; run: () => void | (() => void) }> = []
    const application = Object.assign(test.context, { effect: (run: () => void | (() => void), label?: string) => { effects.push(label === undefined ? { run } : { run, label }) } })
    const page = test.page as Document & { cookie: string }
    page.cookie = 'dsh_ma_csrf=csrf-token'
    Object.defineProperty(page, 'documentElement', { value: { lang: 'en' } })
    vi.stubGlobal('document', page)
    vi.stubGlobal('window', test.view)
    vi.stubGlobal('location', { href: 'https://example.test/', origin: 'https://example.test' })
    Object.defineProperty(test.view, 'navigator', { value: { standalone: true } })
    Object.defineProperty(test.view, 'isSecureContext', { value: true })
    Object.defineProperty(test.view, 'self', { value: test.view })
    Object.defineProperty(test.view, 'top', { value: test.view })
    Object.defineProperty(test.view, 'crypto', { value: { randomUUID: () => 'f12a9c10-7b4e-4d8a-9c21-5e6f0a1b2c3d' } })
    Object.defineProperty(test.view, 'pushManager', { value: test.manager })
    Object.defineProperty(test.view, 'Notification', { value: { permission: 'default' } })
    Object.defineProperty(test.view, 'matchMedia', { value: () => ({ matches: true }) })
    Object.defineProperty(test.view, 'document', { value: page })
    const configFetch = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/mobile-access/push/config')) configFetch()
      return new Response(JSON.stringify({ available: true, publicKey: 'AQID', installationId: 'f12a9c10-7b4e-4d8a-9c21-5e6f0a1b2c3d', ownerGeneration: 1, registrationGeneration: 0, status: 'disabled' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }))
    apply(application as Parameters<typeof apply>[0])
    const pushEffect = effects.filter(effect => effect.label === 'dsh-mobile: authenticated browser push lifecycle')
    expect(pushEffect).toHaveLength(1)
    const disposePush = pushEffect[0]!.run()
    expect(configFetch).toHaveBeenCalledTimes(1)
    expect(test.slotRegistrations.filter(entry => (entry.options as { id?: string }).id === 'dsh-mobile-push-browser')).toHaveLength(1)
    ;(disposePush as () => void)()
    test.view.dispatchEvent(new Event('focus'))
    expect(configFetch).toHaveBeenCalledTimes(1)
  })

  it('installs tap resolution only for a non-empty query through the scoped navigation-services lifecycle', async () => {
    const test = fixture('?mobile-push=opaque-ref')
    const opened: string[] = []
    test.context.uiWorkspace.openSession = (id: string) => { opened.push(id) }
    const notices: string[] = []
    const dispose = installMobilePushBrowserClient(test.context as never, { view: test.view, page: test.page, api: test.api as never, environment: test.environment, notify: key => notices.push(key) })
    expect(test.navigationInjections).toHaveLength(1)
    expect(test.navigationInjections[0]?.services).toEqual(['sessions', 'workspaces', 'uiWorkspace'])
    await Promise.resolve(); await Promise.resolve()
    expect(test.api.resolve).toHaveBeenCalledExactlyOnceWith('opaque-ref')
    expect(opened).toEqual(['s1'])
    expect(notices).toEqual(['session-resolved'])
    expect(test.history.replaceState).toHaveBeenCalledOnce()
    expect(test.navigationInjections[0]?.childDisposers).toHaveLength(1)
    dispose()
    expect(test.navigationInjections[0]?.dispose).toHaveBeenCalledOnce()
  })

  it('does not start the navigation-services lifecycle or install neutral navigation without a tap reference', () => {
    const test = fixture()
    const dispose = installMobilePushBrowserClient(test.context as never, { view: test.view, page: test.page, api: test.api as never, environment: test.environment })
    expect(test.navigationInjections).toHaveLength(0)
    expect(test.api.resolve).not.toHaveBeenCalled()
    dispose()
  })
})

describe('cold push tap navigation across real scoped public providers', () => {
  const contexts: Context[] = []

  interface MutableLocation { search: string; pathname: string; hash: string }

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  })

  /** Mount the push client exactly as the packed web client does: a plugin activated by `slots` alone, before any navigation service exists. */
  function mountColdTapClient(search: string): {
    test: ReturnType<typeof fixture>
    location: MutableLocation
    notices: string[]
    opened: string[]
    subscribeCalls: { sessions: number; workspaces: number }
    unsubscribeCalls: { sessions: number; workspaces: number }
    clientReady: Promise<unknown>
    mountProvider(options: { sessionsPhase: 'pending' | 'ready' }): Promise<{ dispose(): Promise<unknown> }>
    disposePushClient(): void
  } {
    const test = fixture(search)
    const location: MutableLocation = { search, pathname: '/', hash: '' }
    Object.defineProperty(test.view, 'location', { value: location, writable: true })
    test.history.replaceState = vi.fn((_data: unknown, _title: string, url: string) => {
      const at = String(url).indexOf('?')
      location.search = at >= 0 ? String(url).slice(at) : ''
    })
    const notices: string[] = []
    const opened: string[] = []
    const subscribeCalls = { sessions: 0, workspaces: 0 }
    const unsubscribeCalls = { sessions: 0, workspaces: 0 }
    const context = new Context()
    contexts.push(context)
    context.provide('slots', test.context.slots)
    let disposePushClient: () => void = () => undefined
    const clientFiber = context.plugin({
      name: 'dsh-mobile-push-client',
      inject: ['slots'],
      apply: pluginContext => {
        disposePushClient = installMobilePushBrowserClient(pluginContext as never, {
          view: test.view, page: test.page, api: test.api as never, environment: test.environment,
          notify: key => { notices.push(key) },
        })
      },
    })
    let providerSequence = 0
    const mountProvider = async ({ sessionsPhase }: { sessionsPhase: 'pending' | 'ready' }) => {
      const ready = sessionsPhase === 'ready'
      const providerFiber = context.plugin({
        name: `test-public-navigation-services-${++providerSequence}`,
        apply: providerContext => {
          providerContext.provide('sessions', {
            list: {
              getSnapshot: () => ({ phase: sessionsPhase, byId: ready ? { s1: {} } : {}, ids: ready ? ['s1'] : [] }),
              subscribe: () => { subscribeCalls.sessions += 1; return () => { unsubscribeCalls.sessions += 1 } },
            },
          } as never)
          providerContext.provide('workspaces', {
            list: {
              getSnapshot: () => ({ phase: 'ready', items: [] }),
              subscribe: () => { subscribeCalls.workspaces += 1; return () => { unsubscribeCalls.workspaces += 1 } },
            },
          } as never)
          providerContext.provide('uiWorkspace', { openSession: (id: string) => { opened.push(id) } } as never)
        },
      })
      await providerFiber
      return { dispose: () => providerFiber.dispose() }
    }
    return {
      test, location, notices, opened, subscribeCalls, unsubscribeCalls, clientReady: Promise.resolve(clientFiber), mountProvider,
      disposePushClient: () => { disposePushClient() },
    }
  }

  it('consumes a cold tap reference once public navigation services activate after the push client', async () => {
    const mounted = mountColdTapClient('?mobile-push=opaque-ref')
    await mounted.clientReady
    // Cold boundary: the push client is live while the public navigation
    // services have not activated yet — nothing may be consumed here.
    expect(mounted.test.api.resolve).not.toHaveBeenCalled()
    expect(mounted.location.search).toBe('?mobile-push=opaque-ref')
    await mounted.mountProvider({ sessionsPhase: 'ready' })
    await vi.waitFor(() => { expect(mounted.test.api.resolve).toHaveBeenCalledExactlyOnceWith('opaque-ref') })
    expect(mounted.test.history.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/')
    expect(mounted.location.search).toBe('')
    await Promise.resolve(); await Promise.resolve()
    expect(mounted.opened).toEqual(['s1'])
    expect(mounted.notices).toEqual(['session-resolved'])
    mounted.disposePushClient()
  })

  it('retains an unconsumed reference without requests while public navigation services never activate', async () => {
    const mounted = mountColdTapClient('?mobile-push=opaque-ref')
    await mounted.clientReady
    await new Promise(resolve => { setTimeout(resolve, 0) })
    expect(mounted.test.api.resolve).not.toHaveBeenCalled()
    expect(mounted.test.history.replaceState).not.toHaveBeenCalled()
    expect(mounted.location.search).toBe('?mobile-push=opaque-ref')
    expect(mounted.notices).toEqual([])
    expect(mounted.subscribeCalls).toEqual({ sessions: 0, workspaces: 0 })
    mounted.disposePushClient()
  })

  it('removes listeners synchronously on the outer disposer and never opens or notifies when a held resolve settles afterwards', async () => {
    const mounted = mountColdTapClient('?mobile-push=opaque-ref')
    let releaseResolve!: (target: unknown) => void
    mounted.test.api.resolve.mockImplementation(() => new Promise(resolve => { releaseResolve = resolve as (target: unknown) => void }))
    await mounted.clientReady
    await mounted.mountProvider({ sessionsPhase: 'ready' })
    await vi.waitFor(() => {
      expect(mounted.test.api.resolve).toHaveBeenCalledExactlyOnceWith('opaque-ref')
      expect(mounted.subscribeCalls).toEqual({ sessions: 1, workspaces: 1 })
    })
    expect(mounted.location.search).toBe('')
    // The exported outer disposer is synchronous: list listeners must be gone
    // immediately even though the underlying child Fiber disposal is async.
    mounted.disposePushClient()
    expect(mounted.unsubscribeCalls).toEqual({ sessions: 1, workspaces: 1 })
    releaseResolve({ sessionId: 's1', interaction: 'resolved' })
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(mounted.opened).toEqual([])
    expect(mounted.notices).toEqual([])
  })

  it('follows provider loss and re-provision before consumption: held readiness, disposed listeners, then one clean consumption', async () => {
    const mounted = mountColdTapClient('?mobile-push=opaque-ref')
    await mounted.clientReady
    const firstProvider = await mounted.mountProvider({ sessionsPhase: 'pending' })
    // Readiness barrier: the session list is held at `pending`, so the
    // installed consumer must subscribe but must not consume yet.
    await vi.waitFor(() => { expect(mounted.subscribeCalls).toEqual({ sessions: 1, workspaces: 1 }) })
    expect(mounted.test.api.resolve).not.toHaveBeenCalled()
    expect(mounted.location.search).toBe('?mobile-push=opaque-ref')
    await firstProvider.dispose()
    await vi.waitFor(() => { expect(mounted.unsubscribeCalls).toEqual({ sessions: 1, workspaces: 1 }) })
    expect(mounted.test.api.resolve).not.toHaveBeenCalled()
    await mounted.mountProvider({ sessionsPhase: 'ready' })
    await vi.waitFor(() => { expect(mounted.test.api.resolve).toHaveBeenCalledExactlyOnceWith('opaque-ref') })
    expect(mounted.test.history.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/')
    expect(mounted.location.search).toBe('')
    await Promise.resolve(); await Promise.resolve()
    expect(mounted.opened).toEqual(['s1'])
    expect(mounted.notices).toEqual(['session-resolved'])
    mounted.disposePushClient()
  })

  it('does not re-consume or re-notify when providers are replaced after consumption', async () => {
    const mounted = mountColdTapClient('?mobile-push=opaque-ref')
    await mounted.clientReady
    const firstProvider = await mounted.mountProvider({ sessionsPhase: 'ready' })
    await vi.waitFor(() => { expect(mounted.opened).toEqual(['s1']) })
    expect(mounted.notices).toEqual(['session-resolved'])
    await firstProvider.dispose()
    await vi.waitFor(() => { expect(mounted.unsubscribeCalls).toEqual({ sessions: 1, workspaces: 1 }) })
    await mounted.mountProvider({ sessionsPhase: 'ready' })
    // The consumed URL cannot arm a second consumer: settle the replacement
    // lifecycle, then require that no navigation was installed again.
    await new Promise(resolve => { setTimeout(resolve, 0) })
    for (let index = 0; index < 10; index += 1) await Promise.resolve()
    expect(mounted.subscribeCalls).toEqual({ sessions: 1, workspaces: 1 })
    expect(mounted.test.api.resolve).toHaveBeenCalledExactlyOnceWith('opaque-ref')
    expect(mounted.test.history.replaceState).toHaveBeenCalledExactlyOnceWith(null, '', '/')
    expect(mounted.opened).toEqual(['s1'])
    expect(mounted.notices).toEqual(['session-resolved'])
    mounted.disposePushClient()
  })
})

describe('mobile native Back before layout navigation', () => {
  it.each([false, true])('routes Back to the owned directory dialog before later capture listeners, busy: %s', busy => {
    const view = new BackWindow()
    const page = new BackDocument()
    const dialog = new BackNode('DIALOG')
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true')
    dialog.setAttribute('open', ''); dialog.setAttribute('data-dshm-picker-dialog', 'true')
    page.body.append(dialog)
    const dismissed = vi.fn((event: Event) => { event.preventDefault(); if (!busy) dialog.remove() })
    dialog.addEventListener('dsh-mobile:directory-picker-dismiss', dismissed)
    const blocked = vi.fn()
    const stop = installMobileNativeBack(view as never, page as never, blocked)
    const later = vi.fn()
    view.addEventListener('dsh-mobile:native-back', later, true)
    const event = backEvent()
    try {
      view.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
      expect(dismissed).toHaveBeenCalledOnce()
      expect(dialog.isConnected).toBe(busy)
      expect(blocked).not.toHaveBeenCalled()
      expect(later).not.toHaveBeenCalled()
    } finally { stop(); view.removeEventListener('dsh-mobile:native-back', later, true) }
  })

  it('closes only visible page and overlay surfaces in visual order', () => {
    const view = new BackWindow()
    const page = new BackDocument()
    const host = new BackNode()
    page.body.append(host)
    const action = new BackNode(); action.dataset.dshMobileSurfacePlacement = 'sidebar-action'
    const first = new BackNode(); first.dataset.dshMobileSurfacePlacement = 'page'; first.hidden = true
    const second = new BackNode(); second.dataset.dshMobileSurfacePlacement = 'overlay'; second.hidden = true
    host.append(action); host.append(first); host.append(second)
    setMobileSurfaceOpen(action as never, true)
    expect(host.firstElementChild).toBe(action)
    setMobileSurfaceOpen(first as never, true)
    setMobileSurfaceOpen(second as never, true)
    setMobileSurfaceOpen(first as never, true)
    expect(host.lastElementChild).toBe(first)

    const blocked = vi.fn()
    const stop = installMobileNativeBack(view as never, page as never, blocked)
    const layoutBack = vi.fn()
    view.addEventListener('dsh-mobile:native-back', layoutBack)
    const firstBack = backEvent()
    view.dispatchEvent(firstBack)
    expect(firstBack.defaultPrevented).toBe(true)
    expect(first.hidden).toBe(true)
    expect(second.hidden).toBe(false)
    expect(action.hidden).toBe(false)
    expect(layoutBack).not.toHaveBeenCalled()

    const secondBack = backEvent()
    view.dispatchEvent(secondBack)
    expect(secondBack.defaultPrevented).toBe(true)
    expect(second.hidden).toBe(true)
    const unhandled = backEvent()
    view.dispatchEvent(unhandled)
    expect(unhandled.defaultPrevented).toBe(false)
    expect(layoutBack).toHaveBeenCalledOnce()
    expect(blocked).not.toHaveBeenCalled()
    stop()
  })

  it('ignores hidden surfaces, requires a cancelable request, and removes the capture listener', () => {
    const view = new BackWindow()
    const page = new BackDocument()
    const surface = new BackNode(); surface.dataset.dshMobileSurfacePlacement = 'page'
    page.body.append(surface)
    const blocked = vi.fn()
    const stop = installMobileNativeBack(view as never, page as never, blocked)

    const notCancelable = backEvent(false)
    view.dispatchEvent(notCancelable)
    expect(surface.hidden).toBe(false)
    surface.visibility = 'hidden'
    const hiddenBack = backEvent()
    view.dispatchEvent(hiddenBack)
    expect(hiddenBack.defaultPrevented).toBe(false)
    surface.visibility = 'visible'
    stop()
    view.dispatchEvent(backEvent())
    expect(surface.hidden).toBe(false)
  })

  it.each([true, false])('uses the empty direct presentation mask, with legacy aria-hidden %s, not a dialog action', legacyHidden => {
    const view = new BackWindow()
    const page = new BackDocument()
    const wrapper = new BackNode(); wrapper.setAttribute('role', 'presentation')
    const mask = new BackNode(); if (legacyHidden) mask.setAttribute('aria-hidden', 'true')
    const dialog = new BackNode(); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true')
    const action = new BackNode('BUTTON')
    mask.onClick = () => { wrapper.remove() }
    page.body.append(wrapper); wrapper.append(mask); wrapper.append(dialog); dialog.append(action)
    const blocked = vi.fn()
    const stop = installMobileNativeBack(view as never, page as never, blocked)
    const event = backEvent()
    view.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(mask.clicks).toBe(1)
    expect(wrapper.isConnected).toBe(false)
    expect(action.clicks).toBe(0)
    expect(blocked).not.toHaveBeenCalled()
    stop()
  })

  it.each(['role', 'tabindex', 'contenteditable', 'text', 'child', 'aria-visible'])('does not treat a %s sibling as a dialog backdrop', variant => {
    const view = new BackWindow()
    const page = new BackDocument()
    const wrapper = new BackNode(); wrapper.setAttribute('role', 'presentation')
    const sibling = new BackNode()
    if (variant === 'role') sibling.setAttribute('role', 'button')
    if (variant === 'tabindex') sibling.setAttribute('tabindex', '0')
    if (variant === 'contenteditable') sibling.setAttribute('contenteditable', 'true')
    if (variant === 'text') sibling.textContent = 'Perform an action'
    if (variant === 'child') sibling.append(new BackNode('BUTTON'))
    if (variant === 'aria-visible') sibling.setAttribute('aria-hidden', 'false')
    const dialog = new BackNode(); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true')
    page.body.append(wrapper); wrapper.append(sibling); wrapper.append(dialog)
    const blocked = vi.fn()
    const stop = installMobileNativeBack(view as never, page as never, blocked)
    const event = backEvent()
    view.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(sibling.clicks).toBe(0)
    expect(blocked).toHaveBeenCalledOnce()
    stop()
  })

  it('uses only the single visible DSH menu outside-pointerdown path', () => {
    const view = new BackWindow()
    const page = new BackDocument()
    const menu = new BackNode(); menu.setAttribute('role', 'menu'); menu.setAttribute('data-menu-material', 'translucent')
    page.body.append(menu)
    const outside = vi.fn()
    page.addEventListener('pointerdown', outside)
    const blocked = vi.fn()
    const stop = installMobileNativeBack(view as never, page as never, blocked)
    const event = backEvent()
    view.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(outside).toHaveBeenCalledOnce()
    expect(blocked).not.toHaveBeenCalled()

    const otherMenu = new BackNode(); otherMenu.setAttribute('role', 'menu')
    page.body.append(otherMenu)
    view.dispatchEvent(backEvent())
    expect(outside).toHaveBeenCalledOnce()
    expect(blocked).toHaveBeenCalledOnce()
    stop()
  })

  it('closes the owned model root through Escape without activating an option or outside pointer handler', () => {
    const view = new BackWindow()
    const { page, trigger, popup, action } = composerModelBackFixture()
    const editor = new BackNode('INPUT'); page.body.append(editor); page.activeElement = editor
    const editorBack = vi.fn(); editor.addEventListener('keydown', editorBack)
    const outside = vi.fn()
    page.addEventListener('pointerdown', outside); page.addEventListener('mousedown', outside)
    const escape = vi.fn((event: Event) => {
      expect((event as KeyboardEvent).key).toBe('Escape')
      expect((event as KeyboardEvent).code).toBe('Escape')
      expect(event.bubbles).toBe(true)
      event.preventDefault()
      popup.remove()
      trigger.setAttribute('aria-expanded', 'false')
    })
    trigger.addEventListener('keydown', escape)
    const blocked = vi.fn()
    const stop = installMobileNativeBack(view as never, page as never, blocked)
    const event = backEvent(); view.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(popup.isConnected).toBe(false)
    expect(escape).toHaveBeenCalledOnce()
    expect(action.clicks).toBe(0)
    expect(trigger.clicks).toBe(0)
    expect(editorBack).not.toHaveBeenCalled()
    expect(outside).not.toHaveBeenCalled()
    expect(blocked).not.toHaveBeenCalled()
    page.body.append(popup); trigger.setAttribute('aria-expanded', 'true')
    stop()
    const disposedBack = backEvent(); view.dispatchEvent(disposedBack)
    expect(disposedBack.defaultPrevented).toBe(false)
    expect(escape).toHaveBeenCalledOnce()
  })

  it('backs the model search pane out through its focused searchbox before closing the root', () => {
    const view = new BackWindow()
    const { page, trigger, popup, action } = composerModelBackFixture('group')
    const search = new BackNode('INPUT'); search.setAttribute('role', 'searchbox')
    const options = new BackNode(); options.setAttribute('role', 'menu')
    popup.append(search); popup.append(options); options.append(action)
    page.activeElement = search
    const searchBack = vi.fn((event: Event) => {
      expect((event as KeyboardEvent).key).toBe('Escape')
      event.preventDefault()
      popup.setAttribute('role', 'menu'); options.remove(); search.remove(); page.activeElement = trigger
    })
    search.addEventListener('keydown', searchBack)
    const rootBack = vi.fn((event: Event) => { event.preventDefault(); popup.remove() })
    trigger.addEventListener('keydown', rootBack)
    const blocked = vi.fn()
    const stop = installMobileNativeBack(view as never, page as never, blocked)
    const submenuBack = backEvent(); view.dispatchEvent(submenuBack)
    expect(submenuBack.defaultPrevented).toBe(true)
    expect(popup.isConnected).toBe(true)
    expect(popup.getAttribute('role')).toBe('menu')
    expect(searchBack).toHaveBeenCalledOnce()
    expect(rootBack).not.toHaveBeenCalled()
    const rootEvent = backEvent(); view.dispatchEvent(rootEvent)
    expect(rootEvent.defaultPrevented).toBe(true)
    expect(popup.isConnected).toBe(false)
    expect(rootBack).toHaveBeenCalledOnce()
    expect(action.clicks).toBe(0)
    expect(blocked).not.toHaveBeenCalled()
    stop()
  })

  it.each(['menu', 'dialog', 'surface'] as const)('does not send Escape to a model popup underneath a foreground %s', kind => {
    const view = new BackWindow()
    const { page, trigger, popup } = composerModelBackFixture()
    const foreground = new BackNode()
    if (kind === 'surface') foreground.dataset.dshMobileSurfacePlacement = 'overlay'
    else { foreground.setAttribute('role', kind); if (kind === 'dialog') foreground.setAttribute('aria-modal', 'true') }
    page.body.append(foreground)
    const escape = vi.fn(); trigger.addEventListener('keydown', escape)
    const blocked = vi.fn()
    const stop = installMobileNativeBack(view as never, page as never, blocked)
    const event = backEvent(); view.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(escape).not.toHaveBeenCalled()
    expect(popup.isConnected).toBe(true)
    expect(blocked).toHaveBeenCalledTimes(kind === 'surface' ? 0 : 1)
    expect(foreground.hidden).toBe(kind === 'surface')
    stop()
  })

  it.each(['menu', 'dialog'] as const)('keeps overlapping %s blocked even when a model portal appears last in DOM order', kind => {
    const view = new BackWindow()
    const { page, trigger, popup } = composerModelBackFixture()
    const foreign = new BackNode(); foreign.setAttribute('role', kind)
    if (kind === 'dialog') foreign.setAttribute('aria-modal', 'true')
    page.body.append(foreign); page.body.append(popup)
    const escape = vi.fn(); trigger.addEventListener('keydown', escape)
    const outside = vi.fn(); page.addEventListener('pointerdown', outside)
    const blocked = vi.fn()
    const stop = installMobileNativeBack(view as never, page as never, blocked)
    view.dispatchEvent(backEvent())
    expect(escape).not.toHaveBeenCalled()
    expect(outside).not.toHaveBeenCalled()
    expect(blocked).toHaveBeenCalledOnce()
    stop()
  })

  it.each(['unmarked', 'closed', 'missing-controls', 'mismatched', 'unexpected-role', 'hidden-popup', 'hidden-trigger'] as const)('requires visible popup ownership instead of guessing for %s controls', state => {
    const view = new BackWindow()
    const { page, trigger, popup } = composerModelBackFixture('group')
    const options = new BackNode(); options.setAttribute('role', 'menu'); popup.append(options)
    if (state === 'unmarked') trigger.attributes.delete('data-dsh-mobile-composer-model-trigger')
    else if (state === 'closed') trigger.setAttribute('aria-expanded', 'false')
    else if (state === 'missing-controls') trigger.attributes.delete('aria-controls')
    else if (state === 'mismatched') trigger.setAttribute('aria-controls', 'another-model-menu')
    else if (state === 'unexpected-role') popup.setAttribute('role', 'presentation')
    else if (state === 'hidden-popup') popup.hidden = true
    else trigger.hidden = true
    const escape = vi.fn(); trigger.addEventListener('keydown', escape)
    const blocked = vi.fn()
    const stop = installMobileNativeBack(view as never, page as never, blocked)
    const event = backEvent(); view.dispatchEvent(event)
    expect(escape).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(state !== 'hidden-popup')
    expect(blocked).toHaveBeenCalledTimes(state === 'hidden-popup' ? 0 : 1)
    stop()
  })

  it('reports blocked rather than silently claiming an owned model popup whose Escape handler is unavailable', () => {
    const view = new BackWindow()
    const { page, trigger, popup } = composerModelBackFixture()
    const escape = vi.fn(); trigger.addEventListener('keydown', escape)
    const blocked = vi.fn()
    const stop = installMobileNativeBack(view as never, page as never, blocked)
    const event = backEvent(); view.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(escape).toHaveBeenCalledOnce()
    expect(popup.isConnected).toBe(true)
    expect(blocked).toHaveBeenCalledOnce()
    stop()
  })

  it('holds unknown dialogs and menus above the layout with localized feedback', () => {
    const view = new BackWindow()
    const page = new BackDocument()
    const unknown = new BackNode(); unknown.setAttribute('role', 'dialog'); unknown.setAttribute('aria-modal', 'true')
    const button = new BackNode('BUTTON'); unknown.append(button); page.body.append(unknown)
    const blocked = vi.fn()
    const stop = installMobileNativeBack(view as never, page as never, blocked)
    const layoutBack = vi.fn()
    view.addEventListener('dsh-mobile:native-back', layoutBack)
    const event = backEvent()
    view.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(button.clicks).toBe(0)
    expect(blocked).toHaveBeenCalledOnce()
    expect(layoutBack).not.toHaveBeenCalled()
    unknown.remove()
    const menu = new BackNode(); menu.setAttribute('role', 'menu'); page.body.append(menu)
    const menuBack = backEvent()
    view.dispatchEvent(menuBack)
    expect(menuBack.defaultPrevented).toBe(true)
    expect(blocked).toHaveBeenCalledTimes(2)
    expect(layoutBack).not.toHaveBeenCalled()
    expect(mobileBackBlockedMessage('en')).toBe('Close the open panel first.')
    expect(mobileBackBlockedMessage('it')).toBe('Chiudi prima il pannello aperto.')
    expect(mobileBackBlockedMessage('zh')).toBe('请先关闭当前弹层。')
    stop()
  })
})

describe('mobile-control localization', () => {
  it('uses raw Host controller codes to render specific actions in every locale', async () => {
    const failures = [
      { provider: 'tailscale', code: 'funnel_permission_required', key: 'funnelPermission' },
      { provider: 'frp', code: 'frp_component_missing', key: 'frpMissing' },
      { provider: 'tailscale', code: 'sidecar_exited', key: 'controlChannelFailed' },
    ] as const
    for (const { provider, code, key } of failures) {
      const snapshot: DiagnosticSnapshot = {
        dshVersion: '0.1.7-alpha.2',
        lan: { configured: false, running: false },
        remote: { provider, running: true, state: 'error', errorCode: code },
      }
      const result = await collectConnectionDiagnostics(snapshot, {
        firewall: async () => ({ state: 'not-applicable' }),
        remote: async () => ({ state: 'not-applicable' }),
      })
      const check = result.checks.find(entry => entry.id === 'remote')
      expect(check?.reason).toBe('remote-controller-error')
      expect(check?.facts?.controllerCode).toBe(code)
      for (const locale of ['en', 'it', 'zh'] as const) {
        const fallback = DIAGNOSTIC_REASON_MESSAGES[locale]['remote-controller-error'][1]
        expect(diagnosticControllerAction(check?.facts?.controllerCode, locale, fallback))
          .toBe((MOBILE_CONTROL_MESSAGES[locale] as Record<string, string>)[key])
      }
    }
  })

  it('keeps generic diagnostic guidance for unknown and status-only controller codes', () => {
    for (const locale of ['en', 'it', 'zh'] as const) {
      const fallback = DIAGNOSTIC_REASON_MESSAGES[locale]['remote-controller-error'][1]
      expect(diagnosticControllerAction('future_provider_error', locale, fallback)).toBe(fallback)
      expect(diagnosticControllerAction('cpolar_port_unavailable', locale, fallback)).toBe(fallback)
    }
  })

  it('distinguishes cpolar extraction stages in all supported locales', () => {
    const stages = [
      ['tools', 'cpolarExtractToolsFailed'],
      ['archive', 'cpolarExtractArchiveFailed'],
      ['database', 'cpolarExtractDatabaseFailed'],
      ['cabinet', 'cpolarExtractCabinetFailed'],
      ['file', 'cpolarExtractFileFailed'],
    ] as const
    for (const locale of ['en', 'it', 'zh'] as const) {
      const catalog = MOBILE_CONTROL_MESSAGES[locale] as Record<string, string>
      for (const [stage, key] of stages) {
        expect(catalog[key]).toBeTruthy()
        expect(diagnosticControllerAction(`cpolar_extract_${stage}_failed`, locale, 'fallback')).toBe(catalog[key])
      }
    }
    expect((MOBILE_CONTROL_MESSAGES.zh as Record<string, string>).cpolarExtractDatabaseFailed).toContain('不要')
    expect((MOBILE_CONTROL_MESSAGES.en as Record<string, string>).cpolarExtractToolsFailed).toContain('no administrator')
  })

  it('uses DSH theme layers for remote cards while preserving a scannable QR background', () => {
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__provider{')
    expect(CONTROL_STYLES).toContain('background:var(--dsw-alias-bg-layer-2,#fff)')
    expect(CONTROL_STYLES).toContain('background:var(--dsw-alias-interactive-bg-active')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__cpolar-setup')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__token')
    expect(CONTROL_STYLES).toContain('.dsh-mobile-control__provider-choices{display:grid;grid-template-columns:1fr;gap:8px}')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__remote-workspace')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__http-frame-warning')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__stage-value')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__state-badge')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__lan-setup{')
    expect(CONTROL_STYLES).toContain('min-height:44px')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__actions[hidden],.dsh-mobile-control__manage-row[hidden]{display:none}')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__qr img{border-radius:12px;background:#fff')
  })

  it('keeps the named-tunnel form behind an explicit mode choice and never persists the token in the DOM', () => {
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    // The mode selector stages a choice; only Save reaches the provider, so clicking
    // between the two can never silently discard a saved token.
    expect(source).toContain("cloudflaredModeQuick.addEventListener('click'")
    expect(source).toContain("cloudflaredModeNamed.addEventListener('click'")
    expect(source).toContain('const cloudflaredShownMode = cloudflaredModeDraft ?? cloudflaredTunnelMode')
    // The connector token is a credential: a masked input, posted once, cleared after.
    expect(source).toContain("cloudflaredToken.type = 'password'")
    expect(source).toContain('/remote/cloudflared/tunnel')
    expect(source).toContain('/remote/cloudflared/tunnel/purge')
    expect(source).toContain('cloudflaredToken.value = \'\'')
    // Quick tunnels allocate their own address, so the named fields stay hidden.
    // The form is collapsed by default and, once a named tunnel is configured, it
    // stays locked until the operator explicitly chooses Edit.
    expect(source).toContain('cloudflaredTunnel.hidden = true')
    expect(source).toContain("const locked = named && cloudflaredTunnelConfigured && cloudflaredTunnelMode === 'named' && !cloudflaredConfigEditing")
    expect(CONTROL_STYLES).toContain('.dsh-mobile-control__tunnel[hidden]{display:none}')
  })

  it('keeps the provider list single-column with legible copy and non-trivial targets', () => {
    // Verified against the panel rendered at its real 380 px width. Three providers in a
    // two-column grid left the last card orphaned in half a row, the description that decides
    // the choice was the smallest text in the panel, and the two destructive inline actions
    // were the smallest targets in it.
    const declaration = (selector: string, property: string): number => {
      const start = CONTROL_STYLES.indexOf(`${selector}{`)
      expect(start, `${selector} is missing from CONTROL_STYLES`).toBeGreaterThanOrEqual(0)
      const block = CONTROL_STYLES.slice(start, CONTROL_STYLES.indexOf('}', start))
      const match = new RegExp(`${property}:(\\d+)px`).exec(block)
      expect(match, `${property} is missing from ${selector}`).not.toBeNull()
      return match === null ? 0 : Number(match[1])
    }

    // One column, so every provider card spans the panel and a fourth provider cannot orphan a row.
    expect(CONTROL_STYLES).toContain('.dsh-mobile-control__provider-choices{display:grid;grid-template-columns:1fr;gap:8px}')
    expect(declaration('.dsh-mobile-control__provider-description', 'font-size')).toBeGreaterThanOrEqual(12)
    expect(declaration('.dsh-mobile-control__device-revoke', 'min-height')).toBeGreaterThanOrEqual(36)
    expect(declaration('.dsh-mobile-control__ws-paths-remove', 'min-height')).toBeGreaterThanOrEqual(36)
    // Two interactive tiers only: 36px inline, 44px primary. Nothing below the type floor either.
    expect(declaration('.dsh-mobile-control__details>summary', 'min-height')).toBeGreaterThanOrEqual(36)
    expect(declaration('.dsh-mobile-control__actions button', 'min-height')).toBeGreaterThanOrEqual(44)
    expect(declaration('.dsh-mobile-control__danger', 'min-height')).toBeGreaterThanOrEqual(44)
    expect(declaration('.dsh-mobile-control__app-download', 'min-height')).toBeGreaterThanOrEqual(44)
    expect(CONTROL_STYLES).not.toContain('font-size:10px')
    // The floor also covers sizes declared through the font shorthand, which is how every chip,
    // counter and monospace value used to sit at 9-10px.
    expect(CONTROL_STYLES).not.toContain('font:650 9px')
    expect(CONTROL_STYLES).not.toContain('font:650 10px')
    expect(CONTROL_STYLES).not.toContain('font:10px')
    // Status colours ride the DSH tokens so the panel follows the dark theme, keeping today's
    // light value only as the fallback.
    expect(CONTROL_STYLES).toContain('var(--dsw-alias-state-success-tertiary,#e6f7f0)')
    expect(CONTROL_STYLES).toContain('var(--dsw-alias-state-warn-tertiary,#fff4dc)')
    expect(CONTROL_STYLES).toContain('var(--dsw-alias-state-error-primary,#dc2626)')
    expect(CONTROL_STYLES).toContain('var(--dsw-alias-state-business-tertiary,#e8f0ff)')
    expect(CONTROL_STYLES).toContain('--dsh-diagnostic-ok:var(--dsw-alias-state-success-primary,#087454)')
    // Text keeps a label token: a state-* colour is a fill (green-500 measured 2.09:1 as copy on
    // its own tint, and fixed blue measured 2.7:1 on the dark panel).
    expect(CONTROL_STYLES).toContain('color:var(--dsw-alias-label-primary,#087454)')
    expect(CONTROL_STYLES).not.toContain('color:#2563eb')
    expect(CONTROL_STYLES).toContain('color:var(--dsw-alias-label-primary-bluish,#2563eb)')
  })

  it('renders only validated release versions and the official Android download', () => {
    expect(clientReleaseInfo({
      updateAvailable: true,
      latestVersion: '0.4.1',
      androidVersion: '0.4.1',
      androidDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/v0.4.1/dsh-mobile-android-v0.4.1.apk',

      androidIrohDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/android-v0.4.1/dsh-mobile-android-v0.4.1-iroh.apk',
      releaseNotes: '## notes',
    })).toEqual({
      updateAvailable: true,
      latestVersion: '0.4.1',
      androidVersion: '0.4.1',
      androidDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/v0.4.1/dsh-mobile-android-v0.4.1.apk',

      androidIrohDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/android-v0.4.1/dsh-mobile-android-v0.4.1-iroh.apk',
      releaseNotes: '## notes',
    })
    expect(clientReleaseInfo({
      updateAvailable: true,
      latestVersion: '0.4.1',
      releaseNotes: '',
    })).toEqual({
      updateAvailable: true,
      latestVersion: '0.4.1',
      androidDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases',
    })
    expect(clientReleaseInfo({
      updateAvailable: true,
      latestVersion: '0.4.1',
      androidVersion: '0.4.1',
      androidDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/v0.4.1/dsh-mobile-android-v0.4.1.apk',

      androidIrohDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/android-v0.4.1/dsh-mobile-android-v0.4.1-iroh.apk',
    })).toEqual({
      updateAvailable: true,
      latestVersion: '0.4.1',
      androidVersion: '0.4.1',
      androidDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/v0.4.1/dsh-mobile-android-v0.4.1.apk',

      androidIrohDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/android-v0.4.1/dsh-mobile-android-v0.4.1-iroh.apk',
    })
    expect(clientReleaseInfo({
      updateAvailable: true,
      latestVersion: '<script>',
      androidVersion: 'latest',
      androidDownloadUrl: 'https://example.com/app.apk',
    })).toEqual({
      updateAvailable: false,
      androidDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases',
    })
    expect(clientReleaseInfo({
      updateAvailable: false,
      androidVersion: '0.4.1',
      androidDownloadUrl: 'https://example.com/dsh-mobile.apk',
    })).toEqual({
      updateAvailable: false,
      androidVersion: '0.4.1',
      androidDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases',
    })
  })

  it.each(['v0.6.1', 'android-v0.6.1'])('renders independent plugin and App versions with the exact official App tag %s', releaseTag => {
    const androidDownloadUrl = `https://github.com/saya-ch/dsh-mobile/releases/download/${releaseTag}/dsh-mobile-android-v0.6.1.apk`
    expect(clientReleaseInfo({ updateAvailable: true, latestVersion: '0.6.2', androidVersion: '0.6.1', androidDownloadUrl })).toEqual({
      updateAvailable: true, latestVersion: '0.6.2', androidVersion: '0.6.1', androidDownloadUrl,
      androidIrohDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/android-v0.6.1/dsh-mobile-android-v0.6.1-iroh.apk',
    })
  })

  it.each([
    'https://github.com/other-owner/dsh-mobile/releases/download/android-v0.6.1/dsh-mobile-android-v0.6.1.apk',
    'https://github.com/saya-ch/dsh-mobile/releases/download/android-v0.6.2/dsh-mobile-android-v0.6.1.apk',
    'https://github.com/saya-ch/dsh-mobile/releases/download/android-v0.6.1/dsh-mobile-android-android-v0.6.1.apk',
    'https://github.com/saya-ch/dsh-mobile/releases/download/android-v0.6.1/dsh-mobile-android-v0.6.1.apk?token=bad',
  ])('does not accept a mismatched or non-canonical App asset URL: %s', androidDownloadUrl => {
    expect(clientReleaseInfo({ androidVersion: '0.6.1', androidDownloadUrl }).androidDownloadUrl).toBe('https://github.com/saya-ch/dsh-mobile/releases')
  })

  it('follows the DSH document language before the browser fallback', () => {
    expect(selectMobileControlLocale('it-IT', ['en-US'])).toBe('it')
    expect(selectMobileControlLocale('', ['zh-Hant', 'en-US'])).toBe('zh')
    expect(selectMobileControlLocale('de-DE', ['fr-FR'])).toBe('en')
    expect(selectMobileControlLocale('en-US', ['it-IT'])).toBe('en')
    expect(selectMobileControlLocale('zh-CN', ['it-IT'])).toBe('zh')
  })

  it('keeps Italian, English, and Chinese catalogs in parity including v0.3 diagnostics', () => {
    const englishKeys = Object.keys(MOBILE_CONTROL_MESSAGES.en).sort()
    expect(Object.keys(MOBILE_CONTROL_MESSAGES.it).sort()).toEqual(englishKeys)
    expect(Object.keys(MOBILE_CONTROL_MESSAGES.zh).sort()).toEqual(englishKeys)
    expect(MOBILE_CONTROL_MESSAGES.it).toMatchObject({
      mobileAccess: 'Accesso mobile',
      diagnostics: 'Diagnostica',
      diagnosticsStart: 'Avvia controllo',
      requestTimeout: 'Operazione scaduta. Verifica che DSH sia ancora in esecuzione e riprova.',
    })
    expect((MOBILE_CONTROL_MESSAGES.en as Record<string, string>).diagnosticsCopied?.toLowerCase()).toContain('redacted report')
    expect(MOBILE_CONTROL_MESSAGES.en.cpolarReady).toContain('temporary addresses')
    expect(MOBILE_CONTROL_MESSAGES.it.cpolarReady).toContain('indirizzi temporanei')
    expect(MOBILE_CONTROL_MESSAGES.zh.mobileAccess).toBe('移动访问')
    expect(MOBILE_CONTROL_MESSAGES.zh.cpolarReady).toContain('临时地址')
    expect(MOBILE_CONTROL_MESSAGES.zh.lanSetupRequired).toContain('选择上方网络')
    expect(MOBILE_CONTROL_MESSAGES.zh.frpAttachTokenReenter).toContain('重新输入共享 Token')
    expect((MOBILE_CONTROL_MESSAGES.en as Record<string, string>).frpEntryTlsPublic).not.toContain('IP certificate')
    const englishReasons = Object.keys(DIAGNOSTIC_REASON_MESSAGES.en).sort()
    expect(Object.keys(DIAGNOSTIC_REASON_MESSAGES.it).sort()).toEqual(englishReasons)
    expect(Object.keys(DIAGNOSTIC_REASON_MESSAGES.zh).sort()).toEqual(englishReasons)
    expect(DIAGNOSTIC_REASON_MESSAGES.en['remote-ready-via-proxy'][0]).toContain('phone reachability is not verified')
    expect(DIAGNOSTIC_REASON_MESSAGES.it['remote-ready-via-proxy'][0]).toContain('telefono')
    expect(DIAGNOSTIC_REASON_MESSAGES.zh['remote-ready-via-proxy'][0]).toContain('尚未验证手机网络')
    const englishReportKeys = Object.keys(LOCALIZED_DIAGNOSTIC_COPY.en).sort()
    expect(Object.keys(LOCALIZED_DIAGNOSTIC_COPY.it).sort()).toEqual(englishReportKeys)
    expect(Object.keys(LOCALIZED_DIAGNOSTIC_COPY.zh).sort()).toEqual(englishReportKeys)
    expect(LOCALIZED_DIAGNOSTIC_COPY.zh.networkAction).toContain('dsh-mobile setup')
  })

  it('maps every remote provider the host can report, including cloudflared', () => {
    // The control UI maps the host's provider string onto its own union and
    // falls back to the built-in provider when the name is unknown. A provider
    // missing from that mapping would silently render another provider's
    // wording and state instead of failing, so every supported name is pinned.
    for (const provider of ['tailscale', 'cpolar', 'cloudflared', 'frp', 'origin'] as const) {
      expect(parseMobileRemoteProvider(provider)).toBe(provider)
    }
    expect(parseMobileRemoteProvider('cloudfare')).toBe('tailscale')
    expect(parseMobileRemoteProvider('')).toBe('tailscale')
    expect(parseMobileRemoteProvider(undefined)).toBe('tailscale')
    expect(parseMobileRemoteProvider(42)).toBe('tailscale')
  })

  it('localizes both cloudflared tunnel modes without implying either is the only one', () => {
    // Keys appended with Object.assign are not part of the inferred catalog type,
    // so read them through the same cast the existing origin assertions use.
    const en = MOBILE_CONTROL_MESSAGES.en as Record<string, string>
    const it = MOBILE_CONTROL_MESSAGES.it as Record<string, string>
    const zh = MOBILE_CONTROL_MESSAGES.zh as Record<string, string>
    // The provider now runs a quick tunnel *or* a named tunnel, so the badge and
    // description must not claim an account is never needed.
    expect(en.cloudflaredBadge).toBe('Account optional')
    expect(zh.cloudflaredBadge).toBe('账号可选')
    expect(it.cloudflaredBadge).toBe('Account facoltativo')
    expect(en.prepareCloudflared).toBe('Prepare cloudflared')
    for (const [catalog, label] of [[en, 'en'], [it, 'it'], [zh, 'zh']] as const) {
      expect(catalog.cloudflaredDescription, label).toMatch(/temporary|临时|temporaneo/iu)
      expect(catalog.cloudflaredDescription, label).toMatch(/fixed|fixed domain|固定|fisso/iu)
    }
    // A quick tunnel is temporary, rate-limited, and carries no uptime promise;
    // the UI must say so rather than implying a production-grade channel.
    expect(en.cloudflaredQuickNote).toContain('rate-limited')
    expect(en.cloudflaredQuickNote).toContain('no uptime guarantee')
    expect(zh.cloudflaredQuickNote).toContain('无可用性保证')
    expect(it.cloudflaredQuickNote).toContain('senza garanzia')
    // The named-tunnel note must state the token's real handling, because that is
    // the part a user cannot verify from the UI.
    expect(en.cloudflaredNamedNote).toContain('environment')
    expect(zh.cloudflaredNamedNote).toContain('环境变量')
    expect(it.cloudflaredNamedNote).toContain('ambiente')
    // The component-readiness line no longer describes only a quick tunnel: the
    // mode-specific note carries that, and a stale claim here would contradict it.
    for (const [catalog, label] of [[en, 'en'], [it, 'it'], [zh, 'zh']] as const) {
      expect(catalog.cloudflaredReady, label).not.toMatch(/temporary|临时|temporaneo/iu)
      expect(catalog.remoteStartingCloudflared, label).not.toMatch(/temporary|临时|temporaneo/iu)
    }
    for (const catalog of [en, it, zh]) {
      // The badge states the real difference (account optional), not a regional claim.
      expect(catalog.cloudflaredBadge).not.toMatch(/mainland|国内/u)
      for (const key of [
        'cloudflaredDescription', 'cloudflaredQuickNote', 'cloudflaredNamedNote', 'cloudflaredComponentNote',
        'installConfirmCloudflared', 'purgeCloudflared', 'purgeCloudflaredConfirm',
        'resetCloudflaredConfirm', 'reconnectingCloudflared',
        'cloudflaredMissing', 'cloudflaredInvalid', 'cloudflaredPortUnavailable',
        'cloudflaredLaunchFailed', 'cloudflaredTimeout', 'cloudflaredStopped',
        'cloudflaredExited', 'cloudflaredOutputInvalid', 'cloudflaredOriginInvalid',
      ]) {
        expect(catalog[key]?.length).toBeGreaterThan(0)
      }
    }
  })

  it('parses as CSS and maps every provider failure code to copy that exists', () => {
    // A stray brace once sat between a rule and its own declarations: the browser
    // dropped `font` and `cursor` from every destructive button and the string-based
    // guards above could not see it. Only a parser catches that class of defect.
    expect(() => postcss.parse(CONTROL_STYLES)).not.toThrow()
    // Every code the panel can translate must exist in every locale, otherwise a failed
    // request falls back to printing the raw server code in all three languages.
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    const table = /const REMOTE_ERROR_MESSAGE_KEYS[^{]*\{([\s\S]*?)\n\}/u.exec(source)?.[1] ?? ''
    const keys = [...table.matchAll(/:\s*'([A-Za-z0-9]+)'/gu)].map((match) => match[1] ?? '')
    expect(keys.length).toBeGreaterThan(40)
    for (const [locale, catalog] of Object.entries(MOBILE_CONTROL_MESSAGES)) {
      for (const key of keys) {
        expect((catalog as Record<string, string>)[key], `${locale}.${key}`).toBeTruthy()
      }
    }
    // The panel must route provider failures through that table rather than stringifying
    // the error, which is what leaked `Error: cloudflared_...` to users.
    expect(source).toContain('remoteFailureTextFor(error, \'installFailed\')')
    expect(source).toContain('remoteFailureTextFor(error, \'requestFailed\')')
  })

  it('references only DSH tokens that exist, so no var() falls back to a light literal', () => {
    // Four names used here once did not exist in DSH (`border-subtle`, `border-normal`,
    // `danger-normal`, `warning-normal`) plus three in the native layout (`bg`,
    // `interactive-border-focus`, another `border-subtle`). Every `var()` therefore took
    // its light fallback and the dark theme never adapted. The DSH checkout is not
    // available in CI, so the set the plugin may use is recorded here: adding a token is
    // then a deliberate edit rather than a silent typo.
    const allowed = new Set([
      '--dsw-radius-panel', '--dsw-font-family',
      '--dsw-font-markdown-base', '--dsw-font-markdown-code-block',
      '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-layer-3',
      '--dsw-alias-bg-module-platform',
      '--dsw-alias-border-l2', '--dsw-alias-border-l3', '--dsw-alias-border-l4',
      '--dsw-alias-interactive-bg-active', '--dsw-alias-interactive-bg-hover',
      '--dsw-alias-interactive-bg-hover-danger', '--dsw-alias-interactive-bg-hover-solid',
      '--dsw-alias-label-primary', '--dsw-alias-label-primary-bluish',
      '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary',
      '--dsw-alias-button-primary-fill', '--dsw-alias-button-primary-hover', '--dsw-alias-label-primary-foreground',
      '--dsw-alias-state-business-primary', '--dsw-alias-state-business-tertiary',
      '--dsw-alias-state-error-primary', '--dsw-alias-state-error-secondary',
      '--dsw-alias-state-success-primary', '--dsw-alias-state-success-tertiary',
      '--dsw-alias-state-warn-label', '--dsw-alias-state-warn-primary', '--dsw-alias-state-warn-tertiary',
    ])
    const unknown = new Map()
    for (const file of readdirSync(new URL('../src', import.meta.url))) {
      if (!file.endsWith('.ts')) continue
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      for (const match of source.matchAll(/var\((--dsw-[a-z0-9-]+)/gu)) {
        const token = match[1] ?? ''
        if (!allowed.has(token)) unknown.set(`${file} ${token}`, true)
      }
    }
    expect([...unknown.keys()]).toEqual([])
  })

  it('localizes own-proxy setup without equating a listening backend with public readiness', () => {
    expect(MOBILE_CONTROL_MESSAGES.en).toMatchObject({
      originName: 'Own reverse proxy', originSaveStart: 'Save and start backend',
      originBackendReady: 'Backend listening', originCopyBackend: 'Copy backend address',
    })
    expect((MOBILE_CONTROL_MESSAGES.en as Record<string, string>).originReady).toContain('have NOT been verified')
    expect((MOBILE_CONTROL_MESSAGES.it as Record<string, string>).originReady).toContain('NON sono stati verificati')
    expect((MOBILE_CONTROL_MESSAGES.zh as Record<string, string>).originReady).toContain('不代表公网连接已成功')
    expect((MOBILE_CONTROL_MESSAGES.en as Record<string, string>).originWarning).toContain('including its port')
    expect((MOBILE_CONTROL_MESSAGES.zh as Record<string, string>).originWarning).toContain('绝不能直接暴露公网')
    expect((MOBILE_CONTROL_MESSAGES.en as Record<string, string>).originPurgeConfirm).toContain('Paired remote devices')
    expect((MOBILE_CONTROL_MESSAGES.zh as Record<string, string>).originPurgeConfirm).toContain('均保留')
    for (const messages of Object.values(MOBILE_CONTROL_MESSAGES)) {
      for (const key of ['originPublicOrigin', 'originListenHost', 'originListenPort', 'originAllowedCidrs', 'originBackendSaved']) {
        expect((messages as Record<string, string>)[key]?.length).toBeGreaterThan(0)
      }
    }
  })

  it('keeps managed connection copy distinct from external backend and form preview', () => {
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    expect(source).toContain("const managedOrigin = origin && data.originMode === 'managed'")
    expect(source).toContain("ready: origin ? t(managedOrigin ? 'caddyVerified' : 'originReady')")
    expect(source).toContain("originChoiceBadge.textContent = managedOrigin ? t(remoteReady ? 'ready' : 'advanced') : originListening ? t('originBackendReady') : t('advanced')")
    expect(source).not.toContain("element('div', 'dsh-mobile-control__stage-header')")
    expect(source).toContain('caddyModeManagedSelected === managedOrigin')
    // The preview remains a form draft: only clean modes follow controller reads.
    expect(source).toContain("if (!caddyModePreviewDirty) caddyModeManagedSelected = data.originMode === 'managed'")
    for (const catalog of Object.values(MOBILE_CONTROL_MESSAGES)) {
      const copy = catalog as Record<string, string>
      expect(copy.caddyName?.length).toBeGreaterThan(0)
      expect(copy.caddyModePreviewNote?.length).toBeGreaterThan(0)
    }
    expect((MOBILE_CONTROL_MESSAGES.en as Record<string, string>).originDescription).toContain('Caddy')
  })

  it('keeps every origin validation and runtime error translated in all locales', () => {
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    const mapping = source.match(/const ORIGIN_ERROR_MESSAGE_KEYS[^=]*= \{([\s\S]*?)\n\}/u)?.[1] ?? ''
    const keys = [...mapping.matchAll(/origin_[a-z_]+: '([^']+)'/gu)].map(match => match[1]!)
    expect(keys.length).toBeGreaterThanOrEqual(11)
    for (const messages of Object.values(MOBILE_CONTROL_MESSAGES)) {
      for (const key of keys) expect((messages as Record<string, string>)[key]?.length).toBeGreaterThan(0)
    }
  })

  it('wires private-origin controls and protects edited forms from stale poll snapshots', () => {
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    expect(source).toContain('providerChoices.append(irohChoice, frpChoice, originChoice)')
    expect(source).toContain('/api/mobile-access/remote/origin/configure')
    expect(source).toContain('/api/mobile-access/remote/origin/purge')
    expect(source).toContain('if (!originFormDirty && !originFormBusy)')
    expect(source).toContain('if (remoteLoadInFlight || originFormBusy || caddyFormBusy) return')
    expect(source).toContain('if (epoch === remoteSnapshotEpoch) renderRemote(data)')
    expect(source).toContain("originSetup.setAttribute('aria-busy', String(originFormBusy))")
    expect(source).toContain("input?.setAttribute('aria-invalid', 'true')")
    expect(source).toContain("originProvider.running === true")
    expect(source).toContain("window.confirm(t('originPurgeConfirm'))")
    expect(CONTROL_STYLES).toContain('.dsh-mobile-control__origin-fields')
    expect(CONTROL_STYLES).toContain('.dsh-mobile-control__origin-fields input[aria-invalid=true]')
  })

  it('keeps every iroh setup and runtime message translated in all locales', () => {
    for (const messages of Object.values(MOBILE_CONTROL_MESSAGES)) {
      const copy = messages as Record<string, string>
      for (const key of ['irohName', 'irohExperimental', 'irohDescription', 'prepareIroh', 'irohInstallNote',
        'irohComponentNote', 'irohPhaseNote', 'irohUnavailable', 'irohStarting', 'irohConnecting',
        'irohCompanionMissing', 'irohDataDirectoryInvalid', 'irohSidecarInvalid', 'irohDownloadFailed', 'irohPlatformUnsupported', 'irohIdentityFailed',
        'irohLaunchFailed', 'irohTimeout', 'irohInstallConfirm', 'installingIroh', 'switchingIroh',
        'reconnectingIroh', 'resetIrohConfirm', 'irohNotReady', 'irohPairingFailed', 'irohExited',
        'irohPairingTitle', 'generateIrohQr', 'enlargeQr', 'closeEnlargedQr', 'irohPairingReady']) {
        expect(copy[key]?.length).toBeGreaterThan(0)
      }
    }
  })

  it('shows iroh verification progress and names the exact companion failure', () => {
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    // Indeterminate progress next to the install button; the checksum check is
    // one quick round trip, so a determinate percentage would be invented.
    expect(source).toContain("element('progress', 'dsh-mobile-control__progress')")
    expect(source).toContain('irohInstallProgress.hidden = false')
    expect(source).toContain("irohInstall.setAttribute('aria-busy', 'true')")
    // A poll landing mid-verification must not wipe the in-flight progress.
    expect(source).toContain('let irohVerifying = false')
    expect(source).toContain("irohComponentStatus.setAttribute('role', 'status')")
    // A sidecar that exists but failed verification must not be reported as
    // merely absent: that sends the user to install over something broken
    // without naming it.
    expect(source).toContain("irohComponentError === 'irohSidecarInvalid' ? t('irohSidecarInvalid')")
    // The install button names the pinned download size, like the other
    // on-demand components.
    expect(source).toContain("t('installWithSize', { size: formatMegabytes(irohDownloadBytes) })")
    expect(CONTROL_STYLES).toContain('.dsh-mobile-control__progress')
    expect(source).toContain('irohQrZoomImage.src = `data:image/svg+xml;base64,${btoa(activeIrohQrSvg)}`')
    expect(source).toContain("element('div', 'dsh-mobile-control__qr is-expandable')")
    expect(CONTROL_STYLES).toContain('.dsh-mobile-control__qr-zoom')
    expect(CONTROL_STYLES).toContain('.dsh-mobile-control__qr-zoom-close')
  })

  it('hides the generic pair actions while iroh owns the remote slot', () => {
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    // The generic pair link points at the provider origin, which under iroh
    // only resolves inside the iroh transport; the app pairs from the iroh
    // descriptor instead.
    expect(source).toContain('remotePair.hidden = iroh')
    expect(source).toContain('remoteCopyLink.hidden = iroh')
  })

  it('declares the QR viewer as a modal dialog only while it is open', () => {
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    // The viewer is mounted with the control root, so a permanent
    // role=dialog/aria-modal="true" would make every current-modal query
    // (this plugin's native Back router, third-party scripts and the packed
    // Mobile fixtures) observe a modal the user cannot see. A hidden element
    // must not claim modal semantics.
    const mount = source.slice(source.indexOf("const irohQrZoom = element('div', 'dsh-mobile-control__qr-zoom')"),
      source.indexOf('const setIrohQrZoomOpen = '))
    expect(mount).not.toContain("irohQrZoom.setAttribute('role', 'dialog')")
    expect(mount).not.toContain("irohQrZoom.setAttribute('aria-modal', 'true')")
    expect(mount).toContain('irohQrZoom.hidden = true')
    expect(source).toContain('const setIrohQrZoomOpen = (open: boolean): void => {')
    const toggler = source.slice(source.indexOf('const setIrohQrZoomOpen = '), source.indexOf('irohQrZoom.append(irohQrZoomImage'))
    expect(toggler).toContain("irohQrZoom.setAttribute('role', 'dialog')")
    expect(toggler).toContain("irohQrZoom.setAttribute('aria-modal', 'true')")
    expect(toggler).toContain("irohQrZoom.removeAttribute('role')")
    expect(toggler).toContain("irohQrZoom.removeAttribute('aria-modal')")
    expect(toggler).toContain('irohQrZoom.hidden = !open')
    // Opening and closing, plus the provider-reset path, share that switch.
    expect(source).toContain('setIrohQrZoomOpen(true)')
    expect(source.match(/setIrohQrZoomOpen\(false\)/gu)?.length).toBe(2)
    // No leftover direct visibility write can bypass the attribute owner: the
    // element starts hidden at mount, and every later change goes through the
    // toggler so role/aria-modal can never drift from the visible state.
    expect(source).not.toContain('irohQrZoom.hidden = false')
    expect(source.match(/irohQrZoom\.hidden = true/gu)?.length).toBe(1)
  })

  it('creates the restricted FRP VPS template entirely in the loopback client', () => {
    const template = createFrpServerTemplateForClipboard(
      7000,
      '0123456789abcdef0123456789abcdef',
      'https://dsh.example.com',
    )
    expect(template).toContain('proxyBindAddr = "127.0.0.1"')
    expect(template).toContain('reverse_proxy 127.0.0.1:7080')
    expect(() => createFrpServerTemplateForClipboard(7000, 'short', 'https://dsh.example.com')).toThrow()
    expect(() => createFrpServerTemplateForClipboard(7000, '0'.repeat(32), 'http://dsh.example.com')).toThrow()
  })

  it('builds attach runbooks in the loopback client and wires the new panel controls', () => {
    const selfSignedForm = {
      serverAddress: '1.2.3.4',
      serverPort: 7000,
      token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://1.2.3.4',
      entryTls: 'self-signed' as const,
      publicPort: 33_080,
    }
    const selfSigned = createFrpAttachTemplateForClipboard(selfSignedForm)
    // The token is part of the local half by design; the VPS half never installs frps.
    expect(selfSigned).toContain('type = "tcp"')
    expect(selfSigned).toContain('remotePort = 33080')
    expect(selfSigned).toContain('ufw allow 33080/tcp')
    expect(selfSigned.split('---- (a)')[1]!.split('---- (b)')[0]).not.toContain('auth.token')
    const proxyName = 'dsh-mobile-0123456789ab'
    const namedRunbook = createFrpAttachTemplateForClipboard(selfSignedForm, { proxyName })
    expect(namedRunbook).toContain(`name = "${proxyName}"`)
    expect(namedRunbook).not.toContain('name = "dsh-mobile"\n')
    expect(createFrpAttachFrpcTomlForClipboard(selfSignedForm, { proxyName, revealToken: true }))
      .toContain(`name = "${proxyName}"`)
    const http = createFrpAttachTemplateForClipboard({
      serverAddress: '1.2.3.4',
      serverPort: 7000,
      token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://1.2.3.4',
      entryTls: 'public-ip-cert',
      vhostHttpPort: 8080,
    })
    expect(http).toContain('reverse_proxy 127.0.0.1:8080')
    // Attach without the user's real vhost port must report the host's own code.
    expect(frpAttachFormErrorCode({
      serverAddress: '1.2.3.4',
      serverPort: 7000,
      token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://1.2.3.4',
      entryTls: 'public-ip-cert',
    })).toBe('frp_attach_mode_requires_vhost_port')
    expect(frpAttachFormErrorCode({
      serverAddress: '1.2.3.4',
      serverPort: 7000,
      token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://1.2.3.4',
      entryTls: 'self-signed',
    })).toBeUndefined()

    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    expect(source).toContain("t('frpModeAttach')")
    expect(source).toContain('frpModeDraft = true')
    expect(source).toContain("frpVhostPort.value = ''")
    expect(source).not.toContain("frpVhostPort.value = '7080'")
    expect(source).toContain("facts.viaProxy === true")
    expect(source).toContain("t('frpEntryTlsSelfSigned')")
    expect(source).toContain("t('frpPublicPortHint')")
    expect(source).toContain("t('frpAttachPlanCopied')")
    expect(source).toContain("t('frpAttachSelfCheck')")
    expect(source).toContain("t('frpAttachTokenReenter')")
    expect(source).toContain('frpCopyAttachPlan.hidden = true; frpCopyAttachPlan.disabled = true')
    expect(source).toContain('frpCopyAttachToken.hidden = true; frpCopyAttachToken.disabled = true')
    expect(source).toContain('frpStep2Text.textContent = attachSelected && configuredFrpProxyName === undefined')
    expect(source).toContain('frpCopyAttachPlan.disabled = remoteProviderBusy || configuredFrpProxyName === undefined')
    expect(source).toContain('frpCopyAttachToken.disabled = remoteProviderBusy || configuredFrpProxyName === undefined')
    expect(source).toContain('createFrpAttachTemplateForClipboard(attachForm, { proxyName })')
    expect(source).toContain('createFrpAttachFrpcTomlForClipboard(attachForm, {')
    expect(source.match(/const proxyName = frpClipboardProxyName\(\)/gu)).toHaveLength(2)
    expect(source.match(/if \(proxyName === undefined\) return/gu)).toHaveLength(2)
    expect(source).toMatch(/remoteStatus\.textContent = t\('loadingRemoteStatus'\)\r?\n\s+loadRemote\(\)/u)
    expect(source).not.toContain('body: JSON.stringify({ ...form, revealToken: true })')
    expect(source).toContain("t(selfSignedSelected ? 'frpAppRequirementSelfSigned' : 'frpAppRequirement')")
    expect(source).toContain('/api/mobile-access/remote/frp/attach-plan')
    expect(source).toContain('/api/mobile-access/remote/frp/self-check')
    // Status, attach validation, and diagnostics use the same code-to-copy table.
    expect(source.match(/frp_attach_mode_requires_vhost_port: 'frpAttachModeRequiresVhostPort'/gu)).toHaveLength(1)
    expect(source.match(/frp_attach_cert_unknown: 'frpAttachCertUnknownError'/gu)).toHaveLength(1)
    expect(source.match(/frp_entry_tls_invalid: 'frpEntryTlsInvalid'/gu)).toHaveLength(1)
    expect(source.match(/frp_self_signed_requires_public_ipv4: 'frpSelfSignedRequiresPublicIpv4'/gu)).toHaveLength(1)
    expect(source.match(/frp_ingress_ca_expired: 'frpIngressCaExpired'/gu)).toHaveLength(1)
    expect(source.match(/frp_ingress_ca_invalid: 'frpIngressCaInvalid'/gu)).toHaveLength(1)
    expect(source.match(/frp_ingress_ca_changed: 'frpIngressCaChanged'/gu)).toHaveLength(1)
    expect(source.match(/frp_ingress_renewal_failed: 'frpIngressRenewalFailed'/gu)).toHaveLength(1)
    expect(source).toContain("t('frpAttachCaExpiring'")
    expect(CONTROL_STYLES).toContain('.dsh-mobile-control__frp-hint')
    expect(CONTROL_STYLES).toContain('.dsh-mobile-control__frp-fields select')
    // The step-2 group <summary> is the visible heading while the group is
    // collapsed, so it must follow the same attach/deploy switch as the inner
    // title instead of keeping the construction-time deploy copy.
    expect(source).toContain("frpVpsSummary.textContent = t(attachSelected ? 'frpStep2TitleAttach' : 'frpStep2Title')")
    // `hidden` has to win over the container's `display:grid`, or the SSH deploy
    // fields stay visible in attach mode even though the client sets `hidden`.
    expect(CONTROL_STYLES).toContain('.dsh-mobile-control__frp-fields[hidden]{display:none}')
    const routes = readFileSync(new URL('../src/plugin.ts', import.meta.url), 'utf8')
    expect(routes).toContain('/remote/frp/attach-plan')
    expect(routes).toContain('/remote/frp/self-check')
  })

  it('manages admin-approved third-party WebSocket paths from the loopback panel', () => {
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    expect(source).toContain('/api/mobile-access/remote/websocket-paths')
    expect(source).toContain('/api/mobile-access/remote/websocket-paths/blocked')
    expect(source).toContain("t('wsPathsTitle')")
    expect(source).toContain("t('wsPathsInvalid')")
    expect(source).toContain("t('wsPathsDetected')")
    expect(source).toContain("t('wsPathsAllow')")
    const routes = readFileSync(new URL('../src/plugin.ts', import.meta.url), 'utf8')
    expect(routes).toContain('/remote/websocket-paths')
    expect(MOBILE_CONTROL_MESSAGES.en.wsPathsAdd).toBe('Allow path')
    expect(source).toContain('wsGroupOf')
    expect(source).toContain('wsPathsAllowAll')
    expect(source).toContain('dsh-mobile-control__ws-dot')
    expect(source).toContain('setInterval(() => { pollWsBlocked(); if (!panel.hidden) void extensionRecovery.refresh() }, 20_000)')
    expect(MOBILE_CONTROL_MESSAGES.en.wsPathsAllowAll).toBe('Allow all')
    expect(source).toContain('diagnosticsChecks, wsPathsSection, diagnosticsDetails')
    expect(source).toContain("if (view === 'diagnostics') {")
    expect(source).toContain('wsPathsSeenAttempts = wsBlockedTotal(wsPathsBlocked)')
  })

  it('registers the native-only computer switch in DSH General settings', () => {
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    expect(source).toContain("settings.general.item")
    expect(source).toContain("dsh-mobile-switch-computer")
    expect(source).toContain("mobile.switch-computer")
    expect(source).toContain("useMobileNativeSettingsAction('mobile.switch-computer')")
    expect(source).toContain("dsh-mobile-native-ready")
    expect(source).toContain("if (!desktopAdmin) {")
    expect(source).toContain("t('httpFrameWarning')")
  })

  it('shows Android notification settings in DSH General and routes it through the scoped bridge', () => {
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    const bridge = readFileSync(new URL('../apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/NativeBridge.kt', import.meta.url), 'utf8')
    const activity = readFileSync(new URL('../apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/MainActivity.kt', import.meta.url), 'utf8')
    expect(source).toContain("id: 'dsh-mobile-task-notifications'")
    expect(source).toContain("useMobileNativeSettingsAction('notification.settings')")
    expect(source).toContain('onClick: invoke')
    expect(source).toContain('请在系统提示或设置中确认任务通知权限。')
    expect(source).toContain('Confirm notification access in the system prompt or settings.')
    expect(source).toContain('Conferma il permesso nella richiesta o nelle impostazioni di sistema.')
    expect(bridge).toContain('if (!NativeBridgePolicy.isTrustedMessage(origin, sourceOrigin.toString(), isMainFrame)) return')
    expect(bridge).toContain('"notification.settings" -> activity.runOnUiThread')
    expect(bridge).toContain('onOpenTaskNotificationSettings')
    expect(activity).toContain('bridge.onOpenTaskNotificationSettings = ::openTaskNotificationSettings')
  })

  it('owns locale persistence as an independent disposable client effect', () => {
    let deliver = () => {}
    let disconnected = false
    const writes: string[] = []
    const root = { lang: 'en' }
    class Observer {
      constructor(callback: () => void) { deliver = callback }
      observe() {}
      disconnect() { disconnected = true }
    }
    vi.stubGlobal('document', {
      documentElement: root,
      querySelector: () => ({}),
      set cookie(value: string) { writes.push(value) },
    })
    vi.stubGlobal('window', { location: { protocol: 'https:' }, MutationObserver: Observer })
    const effects: Array<() => void | (() => void)> = []
    apply({ effect: (effect, label) => { if (label?.includes('locale persistence')) effects.push(effect) },
      get: () => { throw new Error('No additional service is needed') },
      slots: { inject: () => () => {}, register: () => () => {} } })
    expect(effects).toHaveLength(1)
    const stop = effects[0]!()
    expect(writes[0]).toMatch(/^dsh_ma_ui_locale=en;/u)
    root.lang = 'it'
    deliver()
    expect(writes[1]).toMatch(/^dsh_ma_ui_locale=it;/u)
    expect(typeof stop).toBe('function')
    if (typeof stop === 'function') stop()
    expect(disconnected).toBe(true)
    root.lang = 'zh'
    deliver()
    expect(writes).toHaveLength(2)
  })

  it('remounts plugin-owned UI only when the DSH document language changes', () => {
    const documentElement = { lang: 'en-US' }
    let observer: { callback: MutationCallback, disconnect: ReturnType<typeof vi.fn> } | undefined
    class FakeMutationObserver {
      readonly disconnect = vi.fn()
      constructor(readonly callback: MutationCallback) { observer = this }
      observe = vi.fn()
    }
    vi.stubGlobal('document', { documentElement })
    vi.stubGlobal('navigator', { language: 'zh-CN', languages: ['zh-CN'] })
    vi.stubGlobal('MutationObserver', FakeMutationObserver)
    const disposers = [vi.fn(), vi.fn()]
    const install = vi.fn(() => disposers[install.mock.calls.length - 1] ?? vi.fn())

    const stop = installDshLanguageBoundSurface(install)
    expect(install).toHaveBeenCalledTimes(1)
    documentElement.lang = 'it-IT'
    observer?.callback([], observer as unknown as MutationObserver)
    expect(disposers[0]).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledTimes(2)
    observer?.callback([], observer as unknown as MutationObserver)
    expect(install).toHaveBeenCalledTimes(2)

    stop()
    expect(observer?.disconnect).toHaveBeenCalledOnce()
    expect(disposers[1]).toHaveBeenCalledOnce()
  })

  it('fails closed for malformed diagnostic states and preserves unknown server copy', () => {
    expect(normalizeDiagnosticOverall('ok')).toBe('ok')
    expect(normalizeDiagnosticOverall('unexpected')).toBe('error')
    expect(normalizeDiagnosticOverall(undefined)).toBe('error')
    expect(normalizeDiagnosticStatus('info')).toBe('info')
    expect(normalizeDiagnosticStatus('unexpected')).toBe('error')
    expect(diagnosticOverallForChecks('ok', ['ok', 'unexpected'])).toBe('error')
    expect(diagnosticOverallForChecks('ok', ['ok', 'error'])).toBe('error')
    expect(diagnosticOverallForChecks('ok', ['ok', 'warning'])).toBe('attention')
    expect(diagnosticOverallForChecks('attention', ['ok'])).toBe('attention')
    expect(diagnosticOverallForChecks('error', ['ok'])).toBe('error')
    expect(diagnosticOverallForChecks('ok', ['ok', 'info'])).toBe('ok')
    expect(diagnosticServerCopy({ label: 'Server label', detail: 'Server detail', action: 'Server action' })).toEqual({ label: 'Server label', detail: 'Server detail', action: 'Server action' })
    expect(validateDiagnosticChecks([null, 1, 'bad', ['array'], { status: 'ok' }])).toEqual({ entries: [{ status: 'ok' }], malformed: true })
    expect(validateDiagnosticChecks(undefined)).toEqual({ entries: [], malformed: true })
    const noBlockers = vi.fn()
    const renderEnvelope = (data: Record<string, unknown>): void => {
      const entries = diagnosticEntriesForRender(data)
      if (entries.length === 0) noBlockers()
    }
    const missingFailure = vi.fn()
    renderDiagnosticPayloadSafely({ overall: 'ok' }, renderEnvelope, missingFailure)
    expect(missingFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'diagnostics envelope is unavailable' }))
    const nullFailure = vi.fn()
    renderDiagnosticPayloadSafely({ overall: 'ok', checks: [null] }, renderEnvelope, nullFailure)
    expect(nullFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'diagnostics envelope is unavailable' }))
    expect(() => diagnosticEntriesForRender({ overall: 'ok', checks: [] })).toThrowError('diagnostics envelope is unavailable')
    expect(noBlockers).not.toHaveBeenCalled()
  })
})

describe('custom asset refresh lifecycle', () => {
  it('refreshes immediately, coalesces overlaps, and uses visible/hidden default intervals', async () => {
    vi.useFakeTimers()
    const fakeDocument = new FakeDocument()
    const fakeWindow = new FakeWindow()
    let releaseFirst: (() => void) | undefined
    let calls = 0
    const refresh = vi.fn(() => {
      calls += 1
      if (calls === 1) return new Promise<void>(resolve => { releaseFirst = resolve })
      return Promise.resolve()
    })
    const stop = startLifecycleRefreshScheduler(refresh, {}, { document: fakeDocument, window: fakeWindow })
    await Promise.resolve()

    expect(refresh).toHaveBeenCalledTimes(1)
    fakeWindow.dispatchEvent(new Event('focus'))
    fakeWindow.dispatchEvent(new Event('online'))
    expect(refresh).toHaveBeenCalledTimes(1)
    releaseFirst?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(refresh).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(44_999)
    expect(refresh).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(3)

    fakeDocument.visibilityState = 'hidden'
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(299_999)
    expect(refresh).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(refresh).toHaveBeenCalledTimes(4)

    fakeDocument.visibilityState = 'visible'
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(5)
    stop()
  })

  it('aborts an in-flight refresh and removes lifecycle triggers during cleanup', async () => {
    let signal: AbortSignal | undefined
    let settle: (() => void) | undefined
    const fakeDocument = new FakeDocument()
    const fakeWindow = new FakeWindow()
    const refresh = vi.fn((current: AbortSignal) => {
      signal = current
      return new Promise<void>(resolve => { settle = resolve })
    })
    const stop = startLifecycleRefreshScheduler(refresh, {}, { document: fakeDocument, window: fakeWindow })
    await Promise.resolve()

    expect(signal?.aborted).toBe(false)
    stop()
    expect(signal?.aborted).toBe(true)
    settle?.()
    fakeWindow.dispatchEvent(new Event('focus'))
    fakeWindow.dispatchEvent(new Event('online'))
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('times out a hung cycle, aborts its work, and keeps the scheduler moving', async () => {
    vi.useFakeTimers()
    const fakeDocument = new FakeDocument()
    const fakeWindow = new FakeWindow()
    const signals: AbortSignal[] = []
    const refresh = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return signals.length === 1 ? new Promise<void>(() => {}) : Promise.resolve()
    })
    const stop = startLifecycleRefreshScheduler(refresh, { cycleTimeoutMs: 50, visibleIntervalMs: 100 }, { document: fakeDocument, window: fakeWindow })
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(50)
    expect(signals[0]?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(refresh).toHaveBeenCalledTimes(2)
    stop()
  })

  it('accepts a push refresh without starting a parallel cycle', async () => {
    const fakeDocument = new FakeDocument()
    const fakeWindow = new FakeWindow()
    let release: (() => void) | undefined
    const refresh = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const stop = startLifecycleRefreshScheduler(refresh, {}, { document: fakeDocument, window: fakeWindow })
    await Promise.resolve()
    stop.refresh()
    stop.refresh()
    expect(refresh).toHaveBeenCalledTimes(1)
    release?.()
    await vi.waitFor(() => { expect(refresh).toHaveBeenCalledTimes(2) })
    stop()
  })

  it('keeps one event stream and reconnects with bounded exponential backoff', async () => {
    vi.useFakeTimers()
    class FakeEventSource {
      onopen: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      readonly listeners = new Map<string, EventListener>()
      readonly close = vi.fn()
      addEventListener(name: string, listener: EventListener): void { this.listeners.set(name, listener) }
    }
    const fakeWindow = new FakeWindow()
    const sources: FakeEventSource[] = []
    const changed = vi.fn()
    const stop = startExtensionChangeStream(changed, {
      window: fakeWindow,
      create: () => { const source = new FakeEventSource(); sources.push(source); return source as unknown as EventSource },
    })
    expect(sources).toHaveLength(1)
    sources[0]?.listeners.get('extensions-changed')?.(new Event('extensions-changed'))
    expect(changed).toHaveBeenCalledTimes(1)
    sources[0]?.onerror?.(new Event('error'))
    expect(sources[0]?.close).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(sources).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sources).toHaveLength(2)
    sources[1]?.onerror?.(new Event('error'))
    await vi.advanceTimersByTimeAsync(1_999)
    expect(sources).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(sources).toHaveLength(3)
    fakeWindow.dispatchEvent(new Event('online'))
    expect(sources[2]?.close).toHaveBeenCalledTimes(1)
    expect(sources).toHaveLength(4)
    stop()
    expect(sources[3]?.close).toHaveBeenCalledTimes(1)
  })

  it('delivers task notifications to the optional handler and ignores malformed frames', () => {
    vi.useFakeTimers()
    class FakeEventSource {
      onopen: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null
      readonly listeners = new Map<string, EventListener>()
      readonly close = vi.fn()
      addEventListener(name: string, listener: EventListener): void { this.listeners.set(name, listener) }
    }
    const fakeWindow = new FakeWindow()
    const sources: FakeEventSource[] = []
    const changed = vi.fn()
    const notified: unknown[] = []
    const stop = startExtensionChangeStream(changed, {
      window: fakeWindow,
      create: () => { const source = new FakeEventSource(); sources.push(source); return source as unknown as EventSource },
    }, payload => { notified.push(payload) })
    const task = sources[0]?.listeners.get('task-notify')
    expect(typeof task).toBe('function')
    // The stream delivers frames verbatim; parsing and filtering belong to
    // the caller (covered by parseTaskNotifyPayload tests).
    task?.(({ data: '{"sessionId":"s-1","turn":2}' }) as unknown as Event)
    task?.(({ data: 'not-json' }) as unknown as Event)
    task?.(({ data: '{"sessionId":""}' }) as unknown as Event)
    expect(notified).toEqual(['{"sessionId":"s-1","turn":2}', 'not-json', '{"sessionId":""}'])
    expect(changed).not.toHaveBeenCalled()
    stop()
    vi.useRealTimers()
  })
})

describe('extension request isolation', () => {
  it('sends Host action input as JSON while pinning the active generation', async () => {
    const controller = new AbortController()
    const init = extensionActionRequestInit('a'.repeat(64), { name: 'Ada' }, controller.signal)
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    expect(new Headers(init.headers).get('x-dsh-mobile-extension-generation')).toBe('a'.repeat(64))
    expect(init.body).toBe(JSON.stringify({ name: 'Ada' }))
    expect(init.signal).toBe(controller.signal)
  })

  it('combines abort lifetimes without AbortSignal.any', () => {
    const extension = new AbortController()
    const caller = new AbortController()
    const combined = combineClientSignals(extension.signal, caller.signal)
    caller.abort('caller stopped')
    expect(combined.aborted).toBe(true)
    expect(combined.reason).toBe('caller stopped')
  })

  it('detaches combined signal listeners after a normal request completes', () => {
    const extension = new AbortController()
    const caller = new AbortController()
    const removeExtension = vi.spyOn(extension.signal, 'removeEventListener')
    const removeCaller = vi.spyOn(caller.signal, 'removeEventListener')
    const combined = combineClientSignalLifetime(extension.signal, caller.signal)
    combined.cleanup()
    expect(removeExtension).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(removeCaller).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(combined.signal.aborted).toBe(false)
  })

  it('retains request abort wiring until a streamed response finishes', async () => {
    const extension = new AbortController()
    const caller = new AbortController()
    const removeExtension = vi.spyOn(extension.signal, 'removeEventListener')
    const removeCaller = vi.spyOn(caller.signal, 'removeEventListener')
    const lifetime = combineClientSignalLifetime(extension.signal, caller.signal)
    let source: ReadableStreamDefaultController<Uint8Array> | undefined
    const response = bindClientResponseLifetime(new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller },
    }), { headers: { 'content-type': 'text/plain' }, status: 200 }), lifetime.cleanup)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(removeExtension).not.toHaveBeenCalled()
    expect(removeCaller).not.toHaveBeenCalled()

    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    source?.enqueue(new TextEncoder().encode('chunk'))
    await expect(reader?.read()).resolves.toMatchObject({ done: false })
    expect(removeExtension).not.toHaveBeenCalled()
    const finished = reader?.read()
    source?.close()
    await expect(finished).resolves.toEqual({ done: true, value: undefined })
    expect(removeExtension).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(removeCaller).toHaveBeenCalledWith('abort', expect.any(Function))
  })

  it('keeps a streamed response abortable after fetch has returned its headers', async () => {
    const extension = new AbortController()
    const caller = new AbortController()
    const lifetime = combineClientSignalLifetime(extension.signal, caller.signal)
    let source: ReadableStreamDefaultController<Uint8Array> | undefined
    const response = bindClientResponseLifetime(new Response(new ReadableStream<Uint8Array>({
      start(controller) { source = controller },
    })), lifetime.cleanup)
    const pending = response.body?.getReader().read()
    caller.abort(new DOMException('extension request cancelled', 'AbortError'))
    source?.error(caller.signal.reason)
    expect(lifetime.signal.aborted).toBe(true)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('fails closed when a replacement Host generation cannot activate', () => {
    const dispose = vi.fn()
    expect(failClosedExtensionGenerationReplacement(true, 'old', 'new', dispose)).toBe(true)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(failClosedExtensionGenerationReplacement(true, 'new', 'new', dispose)).toBe(false)
    expect(failClosedExtensionGenerationReplacement(false, 'old', 'new', dispose)).toBe(false)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('normalizes route URLs before enforcing the current extension namespace', () => {
    const origin = 'https://dsh.example/'
    expect(extensionRouteUrl('demo', '/status?full=1', origin).href).toBe('https://dsh.example/mobile-access/extensions/demo/routes/status?full=1')
    expect(extensionRouteUrl('demo', '/status?path=%2Ftmp%2Fimage.png', origin).searchParams.get('path')).toBe('/tmp/image.png')
    for (const path of ['/../other/routes/status', '/%2e%2e/other/routes/status', '/safe/%2f../other', '//evil.test/x', '/ok#fragment']) {
      expect(() => extensionRouteUrl('demo', path, origin)).toThrowError('extension routes must be relative')
    }
  })

  it('builds generation-pinned asset URLs without path escape', () => {
    const generation = 'a'.repeat(64)
    expect(extensionAssetUrl('demo', generation, 'icons/photo.png', 'https://dsh.example/').href)
      .toBe(`https://dsh.example/mobile-access/extensions/demo/assets/icons/photo.png?generation=${generation}`)
    for (const path of ['', '/absolute.png', '../secret', 'safe/../secret']) {
      expect(() => extensionAssetUrl('demo', generation, path, 'https://dsh.example/')).toThrowError('extension asset path is invalid')
    }
  })

  it('pins SDK requests to the activated Host generation', () => {
    const generation = 'c'.repeat(64)
    const headers = extensionGenerationHeaders(generation, { accept: 'application/json', 'x-dsh-mobile-extension-generation': 'stale' })
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('x-dsh-mobile-extension-generation')).toBe(generation)
  })
})

describe('per-extension activation lifecycle', () => {
  it('detaches cancelled pending work, starts a replacement, and only late-disposes the orphan', async () => {
    const lifecycle = new PerIdActivationLifecycle<string>()
    const disposed: string[] = []
    await expect(lifecycle.activate('demo', {}, undefined, () => ({
      result: Promise.resolve('previous'),
      cancel: vi.fn(),
      dispose: value => { disposed.push(value) },
    }))).resolves.toBe(true)

    let resolveLate: ((value: string) => void) | undefined
    let pendingSignal: AbortSignal | undefined
    const cancelPending = vi.fn()
    const cycle = new AbortController()
    const late = lifecycle.activate('demo', {}, cycle.signal, controller => {
      pendingSignal = controller.signal
      return {
        result: new Promise<string>(resolve => { resolveLate = resolve }),
        cancel: cancelPending,
        dispose: value => { disposed.push(value) },
      }
    })
    await Promise.resolve()
    expect(lifecycle.getActive('demo')).toBe('previous')
    expect(lifecycle.pendingCount()).toBe(1)

    cycle.abort()
    expect(lifecycle.pendingCount()).toBe(0)
    await expect(late).resolves.toBe(false)
    expect(pendingSignal?.aborted).toBe(true)
    expect(cancelPending).toHaveBeenCalledTimes(1)

    const replacementCreate = vi.fn(() => ({
      result: Promise.resolve('replacement'),
      cancel: vi.fn(),
      dispose: (value: string) => { disposed.push(value) },
    }))
    await expect(lifecycle.activate('demo', {}, undefined, replacementCreate)).resolves.toBe(true)
    expect(replacementCreate).toHaveBeenCalledTimes(1)
    expect(lifecycle.getActive('demo')).toBe('replacement')
    expect(disposed).toEqual(['previous'])

    resolveLate?.('late-orphan')
    await Promise.resolve()
    await Promise.resolve()
    expect(disposed).toEqual(['previous', 'late-orphan'])
    expect(lifecycle.getActive('demo')).toBe('replacement')
    lifecycle.dispose()
    lifecycle.dispose()
    expect(disposed).toEqual(['previous', 'late-orphan', 'replacement'])
  })

  it('rejects a duplicate surface id before mounting and tears the original down exactly once', () => {
    const entries = new Map<string, { readonly dispose: () => void }>()
    const claimedIds = new Set<string>()
    const firstMount = vi.fn()
    const firstCleanup = vi.fn()
    const releaseFirst = registerUniqueDisposable(entries, claimedIds, 'duplicate', () => {
      firstMount()
      return { dispose: firstCleanup }
    })
    const duplicateMount = vi.fn(() => ({ dispose: vi.fn() }))

    expect(() => registerUniqueDisposable(entries, claimedIds, 'duplicate', duplicateMount)).toThrowError('duplicate lifecycle id: duplicate')
    expect(firstMount).toHaveBeenCalledTimes(1)
    expect(duplicateMount).not.toHaveBeenCalled()
    expect(entries.size).toBe(1)

    for (const entry of entries.values()) entry.dispose()
    entries.clear()
    claimedIds.clear()
    expect(firstCleanup).toHaveBeenCalledTimes(1)
    expect(entries.size).toBe(0)
    expect(claimedIds.size).toBe(0)
    releaseFirst()
    releaseFirst()
    expect(firstCleanup).toHaveBeenCalledTimes(1)
  })

  it('cancels teardown during pending exactly once and disposes its late value exactly once', async () => {
    const lifecycle = new PerIdActivationLifecycle<string>()
    let resolveLate: ((value: string) => void) | undefined
    const cancel = vi.fn()
    const dispose = vi.fn()
    const pending = lifecycle.activate('demo', {}, undefined, () => ({
      result: new Promise<string>(resolve => { resolveLate = resolve }),
      cancel,
      dispose,
    }))
    lifecycle.dispose()
    lifecycle.dispose()
    expect(lifecycle.pendingCount()).toBe(0)
    expect(cancel).toHaveBeenCalledTimes(1)
    resolveLate?.('late-after-teardown')
    await expect(pending).resolves.toBe(false)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledWith('late-after-teardown')
  })
})

describe('client extension manifest reconciliation', () => {
  it('does not clear current extensions or invoke legacy reads for an already aborted missing-manifest refresh', async () => {
    const controller = new AbortController()
    controller.abort()
    const clear = vi.fn()
    const legacy = vi.fn(async () => [true, true])
    await expect(handleMissingExtensionManifest(clear, legacy, controller.signal)).resolves.toBe(false)
    expect(clear).not.toHaveBeenCalled()
    expect(legacy).not.toHaveBeenCalled()
  })
  it('does not register into the single official attachment slot or shadow its preview UI', () => {
    const source = apply.toString()
    expect(source).not.toContain('conversation.input.attachments')
    expect(source).not.toContain('dsh-mobile-native-attachment-bridge')
    expect(source).not.toContain('NativeMobileAttachmentBridge')
  })

  it('clears manifest resources immediately on 404 even when legacy fallback later fails', async () => {
    let resolveFallback: ((value: readonly boolean[]) => void) | undefined
    const clear = vi.fn()
    const pending = handleMissingExtensionManifest(clear, () => new Promise(resolve => { resolveFallback = resolve }), new AbortController().signal)
    expect(clear).toHaveBeenCalledTimes(1)
    resolveFallback?.([true, false])
    await expect(pending).resolves.toBe(false)
  })

  it('updates authoritative ids and clears managed resources on manifest removal', async () => {
    const lifecycle = new PerIdActivationLifecycle<string>()
    const authoritative = new Set<string>()
    const managedStyles = new Set<string>()
    const removed: string[] = []
    const disposeManaged = (id: string): void => { removed.push(id); lifecycle.remove(id); managedStyles.delete(id) }

    publishAuthoritativeExtensionIds(authoritative, new Set(['first', 'second']), [managedStyles], disposeManaged)
    await expect(lifecycle.activate('first', {}, undefined, () => ({
      result: Promise.resolve('first-active'), cancel: vi.fn(), dispose: vi.fn(),
    }))).resolves.toBe(true)

    const secondCycle = new AbortController()
    const second = lifecycle.activate('second', {}, secondCycle.signal, () => ({
      result: new Promise<string>(() => {}), cancel: vi.fn(), dispose: vi.fn(),
    }))
    secondCycle.abort(new DOMException('cycle timed out', 'TimeoutError'))
    await expect(second).resolves.toBe(false)
    expect(lifecycle.pendingCount()).toBe(0)

    publishAuthoritativeExtensionIds(authoritative, new Set(['second']), [managedStyles], disposeManaged)
    expect(removed).toEqual(['first'])
    expect(lifecycle.getActive('first')).toBeUndefined()

    managedStyles.add('style-only')
    await handleMissingExtensionManifest(
      () => { publishAuthoritativeExtensionIds(authoritative, new Set(), [managedStyles], disposeManaged) },
      async () => [false],
      new AbortController().signal,
    )
    expect(removed).toEqual(['first', 'second', 'style-only'])
    expect(authoritative.size).toBe(0)
  })

  it('disposes omitted extension ids once while retaining present ids', () => {
    const disposed: string[] = []
    reconcileRemovedExtensions(['removed', 'retained', 'removed'], new Set(['retained']), id => disposed.push(id))
    expect(disposed).toEqual(['removed'])
  })

  it('validates protocol, schema, ids, duplicates, and resource URLs before authority', () => {
    const generation = 'b'.repeat(64)
    expect(parseMobileExtensionManifest({
      protocol: 1,
      extensions: [{ id: 'demo', generation, scriptUrl: `/mobile-access/extensions/demo/mobile.js?generation=${generation}`, assetsUrl: '/mobile-access/extensions/demo/assets/' }, { id: 'theme', styleUrl: '/mobile-access/extensions/theme/mobile.css' }],
      legacy: { scriptRevision: 'js-1', styleRevision: 'css-1' },
    })).toEqual({
      extensions: [{ id: 'demo', generation, scriptUrl: `/mobile-access/extensions/demo/mobile.js?generation=${generation}`, assetsUrl: '/mobile-access/extensions/demo/assets/' }, { id: 'theme', styleUrl: '/mobile-access/extensions/theme/mobile.css' }],
      legacy: { scriptRevision: 'js-1', styleRevision: 'css-1' },
    })
    expect(parseMobileExtensionManifest({ protocol: 2, extensions: [], legacy: { scriptRevision: '', styleRevision: '' } })).toBeUndefined()
    expect(parseMobileExtensionManifest({ protocol: 1, extensions: {}, legacy: { scriptRevision: '', styleRevision: '' } })).toBeUndefined()
    expect(parseMobileExtensionManifest({ protocol: 1, extensions: [{ id: 'demo' }, { id: 'demo' }], legacy: { scriptRevision: '', styleRevision: '' } })).toBeUndefined()
    expect(parseMobileExtensionManifest({ protocol: 1, extensions: [{ id: 'demo', scriptUrl: 'https://evil.test/x.js' }], legacy: { scriptRevision: '', styleRevision: '' } })).toBeUndefined()
    expect(parseMobileExtensionManifest({ protocol: 1, extensions: [{ id: 'demo', generation: 'stale' }], legacy: { scriptRevision: '', styleRevision: '' } })).toBeUndefined()
  })

  it('can reconcile script and style presence independently', () => {
    const scripts: string[] = []
    const styles: string[] = []
    reconcileRemovedExtensions(['script-only', 'both'], new Set(['script-only']), id => scripts.push(id))
    reconcileRemovedExtensions(['style-only', 'both'], new Set(['style-only']), id => styles.push(id))
    expect(scripts).toEqual(['both'])
    expect(styles).toEqual(['both'])
  })
})
