import { afterEach, describe, expect, it, vi } from 'vitest'
import { installCustomAssets, startExtensionChangeStream } from '../src/client.js'
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

class AssetNode {
  readonly dataset: Record<string, string> = {}
  readonly style = { cssText: '' }
  readonly children: AssetNode[] = []
  readonly attributes = new Map<string, string>()
  textContent = ''
  hidden = false
  parent?: AssetNode
  constructor(readonly tagName: string, private readonly evaluate?: (source: string) => void) {}
  append(node: AssetNode): void {
    this.children.push(node); node.parent = this
    if (node.tagName === 'script') this.evaluate?.(node.textContent)
  }
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

describe('mobile customization ownership and safe diagnostics', () => {
  it.each(['request', 'body'] as const)('identifies manifest %s failure without reflecting transport details', async phase => {
    const { warn } = environment()
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (phase === 'request') throw new Error('private transport address and token')
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('private response bytes')) } }))
    }))
    cleanups.push(installCustomAssets())
    await vi.waitFor(() => { expect(warn).toHaveBeenCalled() })
    expect(warn.mock.calls[0]?.[0]).toContain('extension manifest is unavailable')
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|token|refreshed/u)
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
    const listeners: Array<Map<string, EventListener>> = []
    const create = vi.fn(() => {
      const own = new Map<string, EventListener>(); listeners.push(own)
      const addEventListener: EventSource['addEventListener'] = (name: string, listener: EventListenerOrEventListenerObject | ((event: MessageEvent) => void) | null) => { own.set(name, listener as EventListener) }
      return { close, onopen: null, onerror: null, addEventListener }
    })
    const events = startExtensionChangeStream(changed, { window: view, create }, undefined, undefined, false)
    cleanups.push(events)
    expect(create).not.toHaveBeenCalled()
    events.setEnabled(true); events.setEnabled(true)
    expect(create).toHaveBeenCalledTimes(1)
    events.setEnabled(false)
    listeners[0]?.get('extensions-changed')?.(new Event('extensions-changed'))
    expect(changed).not.toHaveBeenCalled()
    view.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(120_000)
    expect(create).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    events.setEnabled(true)
    expect(create).toHaveBeenCalledTimes(2)
    listeners[0]?.get('extensions-changed')?.(new Event('extensions-changed'))
    expect(changed).not.toHaveBeenCalled()
    listeners[1]?.get('extensions-changed')?.(new Event('extensions-changed'))
    expect(changed).toHaveBeenCalledTimes(1)
    events(); events.setEnabled(true)
    expect(create).toHaveBeenCalledTimes(2)
  })
})
