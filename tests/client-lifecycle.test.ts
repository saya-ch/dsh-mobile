import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  bindClientResponseLifetime,
  combineClientSignalLifetime,
  combineClientSignals,
  CONTROL_STYLES,
  createFrpServerTemplateForClipboard,
  clientReleaseInfo,
  diagnosticEntriesForRender,
  diagnosticOverallForChecks,
  diagnosticServerCopy,
  DIAGNOSTIC_REASON_MESSAGES,
  extensionAssetUrl,
  extensionGenerationHeaders,
  extensionRouteUrl,
  failClosedExtensionGenerationReplacement,
  handleMissingExtensionManifest,
  installDshLanguageBoundSurface,
  MOBILE_CONTROL_MESSAGES,
  normalizeDiagnosticOverall,
  normalizeDiagnosticStatus,
  parseMobileExtensionManifest,
  PerIdActivationLifecycle,
  publishAuthoritativeExtensionIds,
  reconcileRemovedExtensions,
  registerUniqueDisposable,
  renderDiagnosticPayloadSafely,
  selectMobileControlLocale,
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

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('mobile-control localization', () => {
  it('uses DSH theme layers for remote cards while preserving a scannable QR background', () => {
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__provider{')
    expect(CONTROL_STYLES).toContain('background:var(--dsw-alias-bg-layer-2,#fff)')
    expect(CONTROL_STYLES).toContain('background:var(--dsw-alias-interactive-bg-active')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__cpolar-setup')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__token')
    expect(CONTROL_STYLES).toContain('grid-template-columns:repeat(2,minmax(0,1fr))')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__remote-workspace')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__stage-value')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__state-badge')
    expect(CONTROL_STYLES).toContain('dsh-mobile-control__qr img{border-radius:12px;background:#fff')
  })

  it('renders only validated release versions and the official Android download', () => {
    expect(clientReleaseInfo({
      updateAvailable: true,
      latestVersion: '0.4.1',
      androidVersion: '0.4.1',
      androidDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/v0.4.1/dsh-mobile-android-v0.4.1.apk',
      releaseNotes: '## notes',
    })).toEqual({
      updateAvailable: true,
      latestVersion: '0.4.1',
      androidVersion: '0.4.1',
      androidDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/v0.4.1/dsh-mobile-android-v0.4.1.apk',
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
    })).toEqual({
      updateAvailable: true,
      latestVersion: '0.4.1',
      androidVersion: '0.4.1',
      androidDownloadUrl: 'https://github.com/saya-ch/dsh-mobile/releases/download/v0.4.1/dsh-mobile-android-v0.4.1.apk',
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
    const englishReasons = Object.keys(DIAGNOSTIC_REASON_MESSAGES.en).sort()
    expect(Object.keys(DIAGNOSTIC_REASON_MESSAGES.it).sort()).toEqual(englishReasons)
    expect(Object.keys(DIAGNOSTIC_REASON_MESSAGES.zh).sort()).toEqual(englishReasons)
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
    expect(source).toContain("frpVpsSummary.textContent = t('frpStep2Title')")
    expect(source).toContain('wsGroupOf')
    expect(source).toContain('wsPathsAllowAll')
    expect(source).toContain('dsh-mobile-control__ws-dot')
    expect(source).toContain('setInterval(pollWsBlocked, 20_000)')
    expect(MOBILE_CONTROL_MESSAGES.en.wsPathsAllowAll).toBe('Allow all')
    expect(source).toContain('diagnosticsChecks, wsPathsSection, diagnosticsDetails')
    expect(source).toContain("if (view === 'diagnostics') {")
    expect(source).toContain('wsPathsSeenAttempts = wsBlockedTotal(wsPathsBlocked)')
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
