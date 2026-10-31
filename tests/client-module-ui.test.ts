import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_MODULE_COPY, CLIENT_MODULE_REQUEST_TIMEOUT_MS, CLIENT_MODULE_STYLES, ClientModuleRequestTimeout, clientModuleTotalLabel, parseClientModuleView, requestClientModuleView } from '../src/client-module-ui.js'
import { ClientModuleDraft } from '../src/client-module-presentation.js'

describe('client module settings response', () => {
  const catalog = { source: 'device', excludedClientModules: ['optional'], entries: [
    { id: 'core', required: true, dependencies: [] },
    { id: 'optional', required: false, dependencies: ['core'] },
  ] }
  it('retains the required marker, exact module ids and dependencies', () => {
    expect(parseClientModuleView(catalog)).toEqual(catalog)
  })
  it('retains a catalog revision when the server reports one and tolerates an older server', () => {
    expect(parseClientModuleView({ ...catalog, revision: '0123456789abcdef' }).revision).toBe('0123456789abcdef')
    expect(parseClientModuleView(catalog).revision).toBeUndefined()
    expect(() => parseClientModuleView({ ...catalog, revision: '' })).toThrow('invalid_module_catalog')
  })
  it('carries an optional plugin description and rejects unusable ones', () => {
    const described = { ...catalog, entries: [{ id: 'core', required: true, dependencies: [], description: 'Manage DeepSeek login and open billing pages' }] }
    expect(parseClientModuleView(described).entries[0]).toMatchObject({ description: 'Manage DeepSeek login and open billing pages' })
    for (const bad of [{ description: '' }, { description: '   ' }, { description: 42 }, { description: 'x'.repeat(241) }]) {
      expect(() => parseClientModuleView({ ...catalog, entries: [{ ...catalog.entries[0], ...bad }] })).toThrow('invalid_module_catalog')
    }
  })
  it('carries optional measured sizes and rejects malformed ones', () => {
    const sized = { ...catalog, entries: [{ id: 'core', required: true, dependencies: [], bytes: 2048, gzipBytes: 900 }] }
    expect(parseClientModuleView(sized).entries[0]).toMatchObject({ bytes: 2048, gzipBytes: 900 })
    for (const bad of [{ bytes: -1 }, { gzipBytes: 1.5 }, { bytes: '2' }]) {
      expect(() => parseClientModuleView({ ...catalog, entries: [{ ...catalog.entries[0], ...bad }] })).toThrow('invalid_module_catalog')
    }
  })
  it('rejects malformed wire values before making choices interactive', () => {
    for (const value of [null, {}, { ...catalog, source: 'admin' }, { ...catalog, entries: [null] }, { ...catalog, entries: [{ id: 'x', required: 'yes', dependencies: [] }] }, { ...catalog, excludedClientModules: [null] }, { ...catalog, entries: [{ id: 'x', required: false, dependencies: [{}] }] }, { ...catalog, entries: [{ id: '', required: false, dependencies: [] }] }, { ...catalog, entries: [catalog.entries[0], catalog.entries[0]] }]) {
      expect(() => parseClientModuleView(value)).toThrow('invalid_module_catalog')
    }
  })
  it('has the same controls and copy in each supported locale', () => {
    const keys = Object.keys(CLIENT_MODULE_COPY.en).sort()
    for (const locale of ['zh', 'it'] as const) {
      expect(Object.keys(CLIENT_MODULE_COPY[locale]).sort()).toEqual(keys)
      expect(Object.values(CLIENT_MODULE_COPY[locale]).every(value => value.length > 0)).toBe(true)
    }
  })
  it('reports an incomplete total even when some selected bytes are known', () => {
    const draft = new ClientModuleDraft([
      { id: 'known', required: true, dependencies: [], gzipBytes: 1024 },
      { id: 'unknown', required: false, dependencies: [] },
    ], [])
    expect(clientModuleTotalLabel(draft, 'zh')).toBe('已测合计约 1 KB；另有 1 项未知')
    expect(clientModuleTotalLabel(draft, 'en')).toContain('1 sizes unknown')
    draft.setLoaded('unknown', false)
    expect(clientModuleTotalLabel(draft, 'zh')).toBe('勾选合计约 1 KB')
  })
  it('keeps long module names shrinkable and actions touch-sized', () => {
    expect(CLIENT_MODULE_STYLES).toContain('min-height:48px')
    expect(CLIENT_MODULE_STYLES).toContain('min-width:0;overflow-wrap:anywhere')
    expect(CLIENT_MODULE_STYLES).toContain('max-height:calc(100dvh - 32px)')
    expect(CLIENT_MODULE_STYLES).toContain('.dsh-module-body{min-height:0;overflow:auto')
    expect(CLIENT_MODULE_STYLES).toContain('padding:12px 16px max(12px,env(safe-area-inset-bottom))')
  })
})

describe('module settings request lifetime', () => {
  const catalog = { source: 'device', excludedClientModules: [], entries: [{ id: 'optional', required: false, dependencies: [] }] }
  const success = (): Response => Response.json(catalog)
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('sends a device write once with the exact CSRF cookie and no desktop marker', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(success())
    vi.stubGlobal('fetch', fetch)
    vi.stubGlobal('document', { cookie: 'dsh_ma_csrf=legacy; __Host-dsh_ma_csrf=pinned; unrelated=foo' })
    await requestClientModuleView('device', new AbortController().signal, { excludedClientModules: ['optional'] })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('/mobile-access/client-modules')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{"excludedClientModules":["optional"]}')
    expect(new Headers(init?.headers).get('x-dsh-mobile-csrf')).toBe('pinned')
    expect(new Headers(init?.headers).has('x-dsh-mobile-desktop-admin')).toBe(false)
  })

  it('saves an explicitly repaired old exclusion with the optional draft choices kept', async () => {
    const entries = [{ id: 'core', required: true, dependencies: [] }, { id: 'optional', required: false, dependencies: [] }]
    const draft = new ClientModuleDraft(entries, ['missing-module', 'core', 'optional'])
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ source: 'device', entries, excludedClientModules: ['optional'] }))
    vi.stubGlobal('fetch', fetch); vi.stubGlobal('document', { cookie: 'dsh_ma_csrf=token' })
    expect(fetch).not.toHaveBeenCalled()
    expect(draft.clearInvalidExclusion('missing-module')).toBe(true)
    expect(draft.clearInvalidExclusion('core')).toBe(true)
    expect(draft.clearInvalidExclusion('optional')).toBe(false)
    expect(draft.changeCount).toBe(2)
    expect(fetch).not.toHaveBeenCalled()
    const saved = await requestClientModuleView('device', new AbortController().signal, { excludedClientModules: draft.excludedIds })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]![1]?.body).toBe('{"excludedClientModules":["optional"]}')
    expect(new ClientModuleDraft(saved.entries, saved.excludedClientModules).changeCount).toBe(0)
  })

  it('uses the fixed desktop Origin marker only for computer writes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => success())
    vi.stubGlobal('fetch', fetch); vi.stubGlobal('location', { protocol: 'dsh-app:', hostname: 'app' })
    await requestClientModuleView('computer', new AbortController().signal)
    await requestClientModuleView('computer', new AbortController().signal, { reset: true })
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/api/mobile-access/client-modules', '/api/mobile-access/client-modules'])
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).has('x-dsh-mobile-desktop-admin')).toBe(false)
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get('x-dsh-mobile-desktop-admin')).toBe('dsh-app://app')
  })

  it('keeps dependency errors as bounded literal text without replaying a write', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ error: 'excluded_client_modules_invalid', detail: 'dependent -> optional' }, { status: 409 }))
    vi.stubGlobal('fetch', fetch); vi.stubGlobal('document', { cookie: '' })
    await expect(requestClientModuleView('device', new AbortController().signal, { excludedClientModules: ['optional'] })).rejects.toMatchObject({ detail: 'dependent -> optional' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('settles reads at the deadline even if Fetch ignores abort', async () => {
    vi.useFakeTimers()
    let complete: (response: Response) => void = () => {}
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(resolve => { complete = resolve }))
    vi.stubGlobal('fetch', fetch)
    const pending = requestClientModuleView('device', new AbortController().signal)
    const rejection = expect(pending).rejects.toMatchObject({ mutation: false })
    await vi.advanceTimersByTimeAsync(CLIENT_MODULE_REQUEST_TIMEOUT_MS.read)
    await rejection
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true)
    complete(success()); await Promise.resolve()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats explicit measurement as cancellable read-only work despite its CSRF-protected POST', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise<never>(() => {}))
    vi.stubGlobal('fetch', fetch); vi.stubGlobal('document', { cookie: 'dsh_ma_csrf=token' })
    const pending = requestClientModuleView('device', new AbortController().signal, { measure: true })
    const rejected = expect(pending).rejects.toMatchObject({ mutation: false })
    await vi.advanceTimersByTimeAsync(CLIENT_MODULE_REQUEST_TIMEOUT_MS.read)
    await rejected
    expect(fetch.mock.calls[0]![1]?.body).toBe('{"measure":true}')
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('x-dsh-mobile-csrf')).toBe('token')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('includes stalled response-body reads in the deadline and does not repeat ambiguous writes', async () => {
    vi.useFakeTimers()
    const response = success(); vi.spyOn(response, 'json').mockImplementation(() => new Promise<never>(() => {}))
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetch); vi.stubGlobal('document', { cookie: '' })
    const pending = requestClientModuleView('device', new AbortController().signal, { excludedClientModules: ['optional'] })
    const rejection = expect(pending).rejects.toBeInstanceOf(ClientModuleRequestTimeout)
    await vi.advanceTimersByTimeAsync(CLIENT_MODULE_REQUEST_TIMEOUT_MS.write)
    await rejection
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts on dialog disposal without waiting for an uncooperative operation', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise<never>(() => {}))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const pending = requestClientModuleView('device', controller.signal)
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort(); await rejection
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    await expect(requestClientModuleView('device', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('clears timers and cancellation handlers after successful reads', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(success())
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    expect(await requestClientModuleView('device', controller.signal)).toEqual(catalog)
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    controller.abort(); expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(false)
  })

  it('clears the operation budget when header setup or JSON parsing fails', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('not JSON'))
    vi.stubGlobal('fetch', fetch)
    await expect(requestClientModuleView('device', new AbortController().signal)).rejects.toBeInstanceOf(SyntaxError)
    expect(vi.getTimerCount()).toBe(0)
    vi.stubGlobal('location', { get protocol(): string { throw new Error('invalid location') }, hostname: 'app' })
    await expect(requestClientModuleView('computer', new AbortController().signal, { reset: true })).rejects.toThrow('invalid location')
    expect(vi.getTimerCount()).toBe(0)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
