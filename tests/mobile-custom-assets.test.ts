import { afterEach, describe, expect, it, vi } from 'vitest'
import { installCustomAssets, startExtensionChangeStream } from '../src/client.js'
import { installMobileConnectionRecovery, type MobileConnectionState } from '../src/client-recovery.js'
import { createMobileAssetLoadReporter, ownsMobileCustomization, readMobileAssetText } from '../src/mobile-custom-assets.js'
import { ensureMobileGatewayMarker } from '../src/mobile-compat-bootstrap.js'
import { EXTENSION_LIMITS, LEGACY_CUSTOM_ASSET_LIMIT } from '../src/extension-limits.js'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

class AssetNode extends EventTarget {
  readonly dataset: Record<string, string> = {}
  readonly style = { cssText: '' }
  readonly children: AssetNode[] = []
  readonly attributes = new Map<string, string>()
  textContent = ''
  hidden = false
  parent?: AssetNode
  constructor(readonly tagName: string, private readonly evaluate?: (source: string) => void) { super() }
  append(...nodes: AssetNode[]): void {
    for (const node of nodes) {
      this.children.push(node); node.parent = this
      if (node.tagName === 'script') this.evaluate?.(node.textContent)
    }
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  remove(): void {
    const at = this.parent?.children.indexOf(this) ?? -1
    if (at >= 0) this.parent?.children.splice(at, 1)
    delete this.parent
  }
  get isConnected(): boolean { return this.parent !== undefined }
  getClientRects(): readonly object[] { return [{}] }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  closest(): null { return null }
}

class AssetPage extends EventTarget {
  readonly documentElement = { lang: 'en' }
  readonly head: AssetNode
  readonly body = new AssetNode('body')
  visibilityState = 'visible'
  constructor(readonly marked: boolean, view: object) {
    super()
    this.head = new AssetNode('head', source => { Function('window', source)(view) })
  }
  createElement(tag: string): AssetNode { return new AssetNode(tag) }
  querySelector(selector: string): AssetNode | null { return selector.startsWith('meta[') && this.marked ? this.head : null }
  querySelectorAll(selector: string): readonly AssetNode[] {
    return selector.includes('data-dsh-mobile-surface-placement') ? this.body.children.filter(node => node.dataset.dshMobileSurfacePlacement !== undefined) : []
  }
}

class AssetView extends EventTarget {
  __DSH_MOBILE_FRONTEND__?: 'dedicated'
  dshMobile?: { register(mount: () => void): void }
  readonly setTimeout = globalThis.setTimeout
  readonly clearTimeout = globalThis.clearTimeout
  getComputedStyle(): { display: string; visibility: string } { return { display: 'block', visibility: 'visible' } }
}

class AssetEvents {
  static readonly instances: AssetEvents[] = []
  readonly close = vi.fn()
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() { AssetEvents.instances.push(this) }
  addEventListener(): void {}
}

function environment(marked = true, dedicated = false) {
  AssetEvents.instances.length = 0
  const view = new AssetView()
  if (dedicated) view.__DSH_MOBILE_FRONTEND__ = 'dedicated'
  const page = new AssetPage(marked, view)
  vi.stubGlobal('window', view)
  vi.stubGlobal('document', page)
  vi.stubGlobal('navigator', { languages: ['en'], language: 'en' })
  vi.stubGlobal('EventSource', AssetEvents)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  return { view, page, warn, info }
}

function manifest(revision = 'one'): Response {
  return Response.json({ protocol: 1, extensions: [], legacy: { scriptRevision: revision, styleRevision: revision } }, { headers: { etag: `"${revision}"` } })
}

function installAssetsWithConnection(view: AssetView, page: AssetPage, initial: MobileConnectionState) {
  let snapshot = initial
  const changes = new EventTarget()
  const connection = {
    reconnect: vi.fn(),
    state: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        changes.addEventListener('change', listener)
        return () => { changes.removeEventListener('change', listener) }
      },
    },
  }
  const recoveryPage = Object.assign(view, { document: page, location: { origin: 'https://fixture.invalid' } })
  let refresh: (() => void) | undefined
  const recovery = installMobileConnectionRecovery(
    () => connection, recoveryPage as unknown as Parameters<typeof installMobileConnectionRecovery>[1], page as unknown as Document,
    undefined, undefined, () => { refresh?.() },
  )
  cleanups.push(() => { void recovery?.() })
  cleanups.push(installCustomAssets({ rejected: vi.fn(), retry: () => false, registerRefresh: fn => {
    refresh = fn
    return () => { refresh = undefined }
  } }))
  return (next: MobileConnectionState): void => { snapshot = next; changes.dispatchEvent(new Event('change')) }
}

describe('mobile customization ownership and safe diagnostics', () => {
  it.each(['request', 'body'] as const)('identifies manifest %s failure without reflecting transport details', async phase => {
    vi.useFakeTimers()
    const { warn } = environment()
    const fetch = vi.fn(async () => {
      if (phase === 'request') throw new Error('private transport address and token')
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('private response bytes')) } }))
    })
    vi.stubGlobal('fetch', fetch)
    cleanups.push(installCustomAssets())
    if (phase === 'request') {
      await vi.advanceTimersByTimeAsync(2_999)
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(warn).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
    } else await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(phase === 'request' ? 3 : 1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('extension manifest is unavailable')
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|token|refreshed/u)
  })

  it('silently retries a resumed manifest with the same validator, then accepts 304', async () => {
    vi.useFakeTimers()
    const { page, warn } = environment()
    const cancel = vi.fn()
    const manifestFetch = vi.fn(async (_init: RequestInit) => manifest())
    manifestFetch.mockResolvedValueOnce(manifest())
      .mockRejectedValueOnce(new TypeError('temporary disconnect'))
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
    const fetch = vi.fn((path: string, init: RequestInit) => path.endsWith('/manifest')
      ? manifestFetch(init) : Promise.resolve(new Response('')))
    vi.stubGlobal('fetch', fetch)
    cleanups.push(installCustomAssets())
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(3)

    page.visibilityState = 'hidden'
    page.dispatchEvent(new Event('visibilitychange'))
    page.visibilityState = 'visible'
    page.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(999)
    expect(manifestFetch).toHaveBeenCalledTimes(2)
    expect(warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(manifestFetch).toHaveBeenCalledTimes(3)
    expect(cancel).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(manifestFetch).toHaveBeenCalledTimes(3)
    expect(warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(manifestFetch).toHaveBeenCalledTimes(4)
    const attempt = manifestFetch.mock.calls[1]?.[0]
    expect(attempt).toMatchObject({ credentials: 'same-origin', cache: 'no-store', headers: { 'if-none-match': '"one"' } })
    expect(manifestFetch.mock.calls[2]?.[0].signal).toBe(attempt?.signal)
    expect(manifestFetch.mock.calls[3]?.[0].headers).toEqual(attempt?.headers)
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each(['connecting', undefined] as const)('revalidates customization after a minute away and recovery from %s', async unavailableState => {
    vi.useFakeTimers()
    const { view, page, warn, info } = environment()
    let snapshot: MobileConnectionState = 'connected'
    const requests = vi.fn(async (path: string, init: RequestInit): Promise<Response> => {
      if (!path.endsWith('/manifest')) return new Response('')
      if (snapshot !== 'connected') return new Response(null, { status: 400 })
      return new Headers(init.headers).has('if-none-match') ? new Response(null, { status: 304 }) : manifest()
    })
    const manifestRequests = (): number => requests.mock.calls.filter(([path]) => path.endsWith('/manifest')).length
    vi.stubGlobal('fetch', requests)
    const publish = installAssetsWithConnection(view, page, snapshot)
    const setState = (next: MobileConnectionState): void => { snapshot = next; publish(next) }
    const notice = page.body.children.find(node => node.attributes.has('data-dsh-mobile-customization-notice'))
    expect(notice?.hidden).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(manifestRequests()).toBe(1)
    page.visibilityState = 'hidden'
    page.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60_000)
    setState('disconnected')
    setState('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(manifestRequests()).toBe(1)
    setState(unavailableState)

    page.visibilityState = 'visible'
    page.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(manifestRequests()).toBe(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('extension manifest is unavailable'))
    expect(notice?.hidden).toBe(false)
    expect(info).not.toHaveBeenCalled()

    setState('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(manifestRequests()).toBe(3)
    expect(notice?.hidden).toBe(true)
    expect(info).toHaveBeenCalledWith(expect.stringContaining('customization is available again'))
    setState('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(manifestRequests()).toBe(3)
  })

  it('revalidates once when the extension stream reopens after an earlier DSH reconnect', async () => {
    vi.useFakeTimers()
    const { view, page, warn, info } = environment()
    let httpReady = true
    let manifestRequests = 0
    vi.stubGlobal('fetch', async (path: string, init: RequestInit): Promise<Response> => {
      if (!path.endsWith('/manifest')) return new Response(path.endsWith('.css') ? ':root { --extension-retained: 1; }' : '')
      manifestRequests++
      if (!httpReady) return new Response(null, { status: 503 })
      return new Headers(init.headers).has('if-none-match') ? new Response(null, { status: 304 }) : manifest()
    })
    const setState = installAssetsWithConnection(view, page, undefined)
    const notice = page.body.children.find(node => node.attributes.has('data-dsh-mobile-customization-notice'))
    await vi.advanceTimersByTimeAsync(0)
    const oldStream = AssetEvents.instances[0]
    expect(oldStream).toBeDefined()
    oldStream?.onopen?.()
    setState('connected')
    await vi.advanceTimersByTimeAsync(0)
    expect(manifestRequests).toBe(1)

    page.visibilityState = 'hidden'
    page.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(60_000)
    setState('connecting')
    httpReady = false
    page.visibilityState = 'visible'
    page.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(manifestRequests).toBe(4)
    expect(notice?.hidden).toBe(false)

    // DSH's live connection becomes ready before the customization HTTP lane.
    setState('connected')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(manifestRequests).toBe(7)
    expect(notice?.hidden).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(info).not.toHaveBeenCalled()
    const style = page.head.children.find(node => node.dataset.plugin === 'dsh-mobile-custom')
    expect(style?.textContent).toContain('--extension-retained: 1')

    oldStream?.onerror?.()
    await vi.advanceTimersByTimeAsync(1_000)
    const newStream = AssetEvents.instances[1]
    expect(newStream).toBeDefined()
    oldStream?.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(manifestRequests).toBe(7)
    expect(notice?.hidden).toBe(false)

    httpReady = true
    newStream?.onopen?.()
    newStream?.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(manifestRequests).toBe(8)
    expect(notice?.hidden).toBe(true)
    expect(info).toHaveBeenCalledTimes(1)
    expect(style?.textContent).toContain('--extension-retained: 1')

    page.visibilityState = 'hidden'
    page.dispatchEvent(new Event('visibilitychange'))
    newStream?.onerror?.()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(AssetEvents.instances).toHaveLength(3)
    AssetEvents.instances[2]?.onopen?.()
    await vi.advanceTimersByTimeAsync(0)
    expect(manifestRequests).toBe(8)
  })

  it.each([400, 401, 403])('reports terminal manifest status %i without retrying', async status => {
    vi.useFakeTimers()
    const { warn } = environment()
    const fetch = vi.fn(async () => new Response(null, { status }))
    vi.stubGlobal('fetch', fetch)
    cleanups.push(installCustomAssets())
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(status === 400 ? 'extension manifest is unavailable' : 'authentication is unavailable'))
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('cancels manifest retry backoff when customization is disposed', async () => {
    vi.useFakeTimers()
    const { warn } = environment()
    const fetch = vi.fn(async () => new Response(null, { status: 504 }))
    vi.stubGlobal('fetch', fetch)
    const stop = installCustomAssets()
    cleanups.push(stop)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('distinguishes extension resource failure from a successfully read manifest', async () => {
    const { warn } = environment()
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/mobile-access/extensions/manifest') return Response.json({ protocol: 1, legacy: { scriptRevision: '', styleRevision: '' }, extensions: [{ id: 'fixture', styleUrl: '/mobile-access/extensions/fixture/mobile.css' }] })
      throw new Error('private resource failure')
    }))
    cleanups.push(installCustomAssets())
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
    expect(warn.mock.calls.some(call => String(call[0]).includes('resource could not be loaded'))).toBe(true)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('private')
  })

  it.each([
    [true, undefined, true], [false, 'dedicated', true], [undefined, 'dedicated', true],
    [false, undefined, false], [undefined, undefined, false],
  ] as const)('resolves gateway %s and frontend %s to %s', (gateway, frontend, expected) => {
    expect(ownsMobileCustomization(gateway, frontend)).toBe(expected)
  })

  it('marks the actual boot script without executable code, CSP changes or an inert comment anchor', () => {
    const html = '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'nonce-test\'"><!-- <script>inert</script> --><script nonce="test">window.__DSH_BOOT__={};</script></head></html>'
    const marked = ensureMobileGatewayMarker(html)
    expect(marked.replace('<meta name="dsh-mobile-gateway" content="authenticated">', '')).toBe(html)
    expect(marked.indexOf('name="dsh-mobile-gateway"')).toBeGreaterThan(marked.indexOf('-->'))
    expect(marked).not.toContain('__DSH_MOBILE_FRONTEND__')
    expect(marked).not.toContain('__DSH_TRANSPORT__')
    expect(ensureMobileGatewayMarker('<p>No DSH boot script</p>')).toBe('<p>No DSH boot script</p>')
  })

  it.each(['en', 'it', 'zh'] as const)('deduplicates %s diagnostics until recovery and ignores cancelled or disposed work', locale => {
    const output = { warn: vi.fn(), info: vi.fn() }
    const reporter = createMobileAssetLoadReporter(() => locale, output)
    const cycle = new AbortController()
    reporter.fail('authentication_required', cycle.signal)
    reporter.fail('authentication_required', cycle.signal)
    reporter.fail('resource_unavailable', cycle.signal)
    expect(output.warn).toHaveBeenCalledTimes(1)
    reporter.recover(cycle.signal); reporter.recover(cycle.signal)
    expect(output.info).toHaveBeenCalledTimes(1)
    reporter.fail('authentication_required', cycle.signal)
    expect(output.warn).toHaveBeenCalledTimes(2)
    cycle.abort()
    reporter.fail('manifest_invalid', cycle.signal); reporter.recover(cycle.signal)
    reporter.dispose()
    reporter.fail('gateway_required'); reporter.recover(new AbortController().signal)
    expect(output.warn).toHaveBeenCalledTimes(2)
    expect(output.info).toHaveBeenCalledTimes(1)
  })

  it('does not request APIs on ordinary public DSH or unpaired preview documents', () => {
    const { warn } = environment(false)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const stop = installCustomAssets(); cleanups.push(stop)
    expect(fetch).not.toHaveBeenCalled()
    expect(AssetEvents.instances).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('paired DSH Mobile access entry')
  })

  it('retains preview native Back layer dismissal without custom API requests, then removes the listener on disposal', () => {
    const { view, page, warn } = environment(false)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const overlay = new AssetNode('section')
    overlay.dataset.dshMobileSurfacePlacement = 'overlay'
    page.body.append(overlay)
    const stop = installCustomAssets(); cleanups.push(stop)
    const back = new Event('dsh-mobile:native-back', { cancelable: true })
    view.dispatchEvent(back)
    expect(back.defaultPrevented).toBe(true)
    expect(overlay.hidden).toBe(true)
    expect(fetch).not.toHaveBeenCalled()
    expect(AssetEvents.instances).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    stop()
    overlay.hidden = false
    const afterStop = new Event('dsh-mobile:native-back', { cancelable: true })
    view.dispatchEvent(afterStop)
    expect(afterStop.defaultPrevented).toBe(false)
    expect(overlay.hidden).toBe(false)
    expect(page.head.children.some(node => node.dataset.plugin === 'dsh-mobile-custom')).toBe(false)
  })

  it.each([
    ['dedicated', false, true], ['stock', true, false], ['preview through gateway', true, false],
  ] as const)('loads actual custom CSS and JS on the %s gateway document', async (_mode, marked, dedicated) => {
    const { page, warn } = environment(marked, dedicated)
    const mount = vi.fn()
    vi.stubGlobal('__mobileAssetMount', mount)
    const fetch = vi.fn((path: string, init: RequestInit) => {
      expect(init.credentials).toBe('same-origin')
      expect(init.cache).toBe('no-store')
      expect(init.signal).toBeInstanceOf(AbortSignal)
      if (path.endsWith('/manifest')) return Promise.resolve(manifest())
      if (path.endsWith('/custom.js')) return Promise.resolve(new Response('window.dshMobile.register(() => { globalThis.__mobileAssetMount(); });'))
      if (path.endsWith('/custom.css')) return Promise.resolve(new Response(':root { --owned-mobile: first; }'))
      throw new Error('unexpected mobile resource')
    })
    vi.stubGlobal('fetch', fetch)
    cleanups.push(installCustomAssets())
    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(page.head.children.find(node => node.dataset.plugin === 'dsh-mobile-custom')?.textContent).toContain('--owned-mobile: first'))
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/mobile-access/extensions/manifest', '/mobile-access/custom.js', '/mobile-access/custom.css'])
    expect(AssetEvents.instances).toHaveLength(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('makes no custom asset or SSE request after manifest 401, then recovers on focus without reloading', async () => {
    const { view, page, warn, info } = environment()
    let authenticated = false
    const fetch = vi.fn((path: string) => {
      if (path.endsWith('/manifest')) return Promise.resolve(authenticated ? manifest() : new Response('secret-do-not-log', { status: 401 }))
      return Promise.resolve(new Response(path.endsWith('.css') ? ':root { --recovered: true; }' : ''))
    })
    vi.stubGlobal('fetch', fetch)
    cleanups.push(installCustomAssets())
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(AssetEvents.instances).toHaveLength(0)
    view.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(warn).toHaveBeenCalledTimes(1)
    authenticated = true
    view.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1))
    expect(page.head.children.find(node => node.dataset.plugin === 'dsh-mobile-custom')?.textContent).toContain('--recovered: true')
    expect(AssetEvents.instances).toHaveLength(1)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-do-not-log')
  })

  it('retains already loaded CSS when the manifest becomes malformed or a later CSS request fails', async () => {
    const { view, page, warn, info } = environment()
    let mode: 'good' | 'invalid' | 'css-failed' = 'good'
    const fetch = vi.fn((path: string) => {
      if (path.endsWith('/manifest')) return Promise.resolve(mode === 'invalid' ? Response.json({ privatePath: '/secret' }) : manifest(mode))
      if (path.endsWith('/custom.css')) return Promise.resolve(mode === 'css-failed' ? new Response('', { status: 503 }) : new Response(':root { --retained: true; }'))
      return Promise.resolve(new Response(''))
    })
    vi.stubGlobal('fetch', fetch)
    cleanups.push(installCustomAssets())
    await vi.waitFor(() => expect(page.head.children.find(node => node.dataset.plugin === 'dsh-mobile-custom')?.textContent).toContain('--retained: true'))
    mode = 'invalid'; view.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    mode = 'css-failed'; view.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2))
    expect(page.head.children.find(node => node.dataset.plugin === 'dsh-mobile-custom')?.textContent).toContain('--retained: true')
    mode = 'good'; view.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1))
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/secret')
  })

  it('pauses an established event stream on manifest authentication loss while retaining valid CSS', async () => {
    const { view, page, warn, info } = environment()
    let authorized = true
    vi.stubGlobal('fetch', (path: string) => Promise.resolve(path.endsWith('/manifest')
      ? authorized ? manifest() : new Response('do-not-log-session', { status: 401 })
      : new Response(path.endsWith('.css') ? ':root { --saved-customization: true; }' : '')))
    cleanups.push(installCustomAssets())
    await vi.waitFor(() => expect(AssetEvents.instances).toHaveLength(1))
    authorized = false; view.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(AssetEvents.instances[0]?.close).toHaveBeenCalledTimes(1)
    expect(page.head.children.find(node => node.dataset.plugin === 'dsh-mobile-custom')?.textContent).toContain('--saved-customization: true')
    authorized = true; view.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1))
    expect(AssetEvents.instances).toHaveLength(2)
  })

  it('accepts existing extension CSS and script size limits above the legacy resource budget', async () => {
    const { page, warn } = environment()
    const activate = vi.fn()
    vi.stubGlobal('__mobileLargeActivate', activate)
    const scriptBase = 'window.dshMobile.define({apiVersion:1,id:"large",activate(){globalThis.__mobileLargeActivate();}});'
    const script = scriptBase + '/*' + 'x'.repeat(EXTENSION_LIMITS.script - scriptBase.length - 4) + '*/'
    const css = '/*' + 'x'.repeat(EXTENSION_LIMITS.css - 4) + '*/'
    expect(new TextEncoder().encode(script).byteLength).toBe(EXTENSION_LIMITS.script)
    expect(new TextEncoder().encode(css).byteLength).toBe(EXTENSION_LIMITS.css)
    expect(css.length).toBeGreaterThan(LEGACY_CUSTOM_ASSET_LIMIT)
    vi.stubGlobal('fetch', (path: string) => {
      if (path.endsWith('/manifest')) return Promise.resolve(Response.json({ protocol: 1, legacy: { scriptRevision: '', styleRevision: '' },
        extensions: [{ id: 'large', styleUrl: '/mobile-access/extensions/large/mobile.css', scriptUrl: '/mobile-access/extensions/large/mobile.js' }] }))
      if (path.includes('/extensions/large/')) return Promise.resolve(new Response(path.endsWith('.css') ? css : script))
      return Promise.resolve(new Response(''))
    })
    cleanups.push(installCustomAssets())
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1))
    expect(page.head.children.find(node => node.dataset.dshMobileExtensionStyle === 'large')?.textContent).toBe(css)
    expect(warn).not.toHaveBeenCalled()
  })

  it('retains aggregate extension manifests larger than the legacy resource budget', async () => {
    const { warn } = environment()
    const entries = Array.from({ length: 1_000 }, (_, index) => ({ id: `demo-${index}`, description: 'x'.repeat(500) }))
    const payload = { protocol: 1, legacy: { scriptRevision: '', styleRevision: '' }, extensions: entries }
    expect(JSON.stringify(payload).length).toBeGreaterThan(LEGACY_CUSTOM_ASSET_LIMIT)
    const fetch = vi.fn((path: string) => Promise.resolve(path.endsWith('/manifest') ? Response.json(payload) : new Response('')))
    vi.stubGlobal('fetch', fetch)
    cleanups.push(installCustomAssets())
    await vi.waitFor(() => expect(AssetEvents.instances).toHaveLength(1))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))
    expect(warn).not.toHaveBeenCalled()
  })

  it.each(['css', 'script'] as const)('rejects extension %s just above its existing file limit without applying it', async kind => {
    const { page, warn } = environment()
    const cancelled = vi.fn()
    const resource = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(EXTENSION_LIMITS[kind] + 1)) },
      cancel: cancelled,
    }))
    vi.stubGlobal('fetch', (path: string) => {
      if (path.endsWith('/manifest')) return Promise.resolve(Response.json({ protocol: 1, legacy: { scriptRevision: '', styleRevision: '' },
        extensions: [{ id: 'oversized', [kind === 'css' ? 'styleUrl' : 'scriptUrl']: '/mobile-access/extensions/oversized/resource' }] }))
      if (path.includes('/extensions/oversized/')) return Promise.resolve(resource)
      return Promise.resolve(new Response(''))
    })
    cleanups.push(installCustomAssets())
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(resource.body?.locked).toBe(false)
    expect(page.head.children.some(node => node.dataset.dshMobileExtensionStyle === 'oversized')).toBe(false)
  })

  it('keeps the authorized legacy fallback on manifest 404 without warning on every refresh', async () => {
    const { view, page, warn, info } = environment()
    vi.stubGlobal('fetch', (path: string) => Promise.resolve(path.endsWith('/manifest')
      ? new Response('', { status: 404 }) : new Response(path.endsWith('.css') ? ':root { --legacy: true; }' : '')))
    cleanups.push(installCustomAssets())
    await vi.waitFor(() => expect(page.head.children.find(node => node.dataset.plugin === 'dsh-mobile-custom')?.textContent).toContain('--legacy: true'))
    view.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(info).not.toHaveBeenCalled()
    expect(AssetEvents.instances).toHaveLength(0)
  })

  it('does not apply a CSS response or report errors after its installer is disposed', async () => {
    const { page, warn, info } = environment()
    let release: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', (path: string) => path.endsWith('/manifest') ? Promise.resolve(manifest())
      : path.endsWith('.js') ? Promise.resolve(new Response('')) : new Promise<Response>(resolve => { release = resolve }))
    const stop = installCustomAssets(); cleanups.push(stop)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    stop()
    const cancelled = vi.fn()
    release?.(new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('late-css')) }, cancel: cancelled })))
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1))
    expect(page.head.children.some(node => node.textContent.includes('late-css'))).toBe(false)
    expect(warn).not.toHaveBeenCalled(); expect(info).not.toHaveBeenCalled()
  })

  it('ignores a timed-out refresh returning 404 after a newer manifest committed extension styles', async () => {
    vi.useFakeTimers()
    const { view, page, warn } = environment()
    let releaseOld: ((response: Response) => void) | undefined
    let manifestCalls = 0
    const fetch = vi.fn((path: string) => {
      if (path.endsWith('/manifest')) {
        manifestCalls++
        if (manifestCalls === 1) return new Promise<Response>(resolve => { releaseOld = resolve })
        return Promise.resolve(Response.json({ protocol: 1, legacy: { scriptRevision: '', styleRevision: '' },
          extensions: [{ id: 'fresh', styleUrl: '/mobile-access/extensions/fresh/mobile.css' }] }))
      }
      return Promise.resolve(new Response(path.includes('/extensions/fresh/') ? ':root { --fresh-extension: retained; }' : ''))
    })
    vi.stubGlobal('fetch', fetch)
    cleanups.push(installCustomAssets())
    await vi.advanceTimersByTimeAsync(0)
    expect(releaseOld).toBeTypeOf('function')
    await vi.advanceTimersByTimeAsync(30_001)
    view.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(page.head.children.find(node => node.dataset.dshMobileExtensionStyle === 'fresh')?.textContent).toContain('--fresh-extension: retained'))
    const cancelled = vi.fn()
    releaseOld?.(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])) }, cancel: cancelled }), { status: 404 }))
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1))
    expect(page.head.children.find(node => node.dataset.dshMobileExtensionStyle === 'fresh')?.textContent).toContain('--fresh-extension: retained')
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('customization response and stream lifetimes', () => {
  it('cancels oversized text and releases its reader lock', async () => {
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(20)) }, cancel: cancelled }))
    await expect(readMobileAssetText(response, new AbortController().signal, 10)).rejects.toThrow('too large')
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
  })

  it('cancels an in-flight reader after abort instead of waiting indefinitely', async () => {
    const cancelled = vi.fn()
    const response = new Response(new ReadableStream({ cancel: cancelled }))
    const cycle = new AbortController()
    const pending = readMobileAssetText(response, cycle.signal, LEGACY_CUSTOM_ASSET_LIMIT)
    cycle.abort()
    await expect(pending).rejects.toBeInstanceOf(DOMException)
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(response.body?.locked).toBe(false)
  })

  it('pauses SSE retries on authentication failure and resumes exactly once after authorization', async () => {
    vi.useFakeTimers()
    const view = new AssetView()
    const close = vi.fn()
    const changed = vi.fn()
    const reopened = vi.fn()
    const listeners: Array<Map<string, EventListener>> = []
    const sources: AssetEvents[] = []
    const create = vi.fn(() => {
      const own = new Map<string, EventListener>(); listeners.push(own)
      const addEventListener: EventSource['addEventListener'] = (name: string, listener: EventListenerOrEventListenerObject | ((event: MessageEvent) => void) | null) => { own.set(name, listener as EventListener) }
      const source = Object.assign(new AssetEvents(), { close, addEventListener })
      sources.push(source)
      return source
    })
    const events = startExtensionChangeStream(changed, { window: view, create }, undefined, undefined, false, reopened)
    cleanups.push(events)
    expect(create).not.toHaveBeenCalled()
    events.setEnabled(true); events.setEnabled(true)
    expect(create).toHaveBeenCalledTimes(1)
    sources[0]?.onopen?.()
    sources[0]?.onerror?.()
    events.setEnabled(false)
    sources[0]?.onopen?.()
    listeners[0]?.get('extensions-changed')?.(new Event('extensions-changed'))
    expect(changed).not.toHaveBeenCalled()
    view.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(create).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    events.setEnabled(true)
    expect(create).toHaveBeenCalledTimes(2)
    sources[1]?.onopen?.()
    expect(reopened).not.toHaveBeenCalled()
    listeners[0]?.get('extensions-changed')?.(new Event('extensions-changed'))
    expect(changed).not.toHaveBeenCalled()
    listeners[1]?.get('extensions-changed')?.(new Event('extensions-changed'))
    expect(changed).toHaveBeenCalledTimes(1)
    events(); events.setEnabled(true)
    expect(create).toHaveBeenCalledTimes(2)
  })
})
