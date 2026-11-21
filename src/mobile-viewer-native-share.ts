/** Sender for the negotiated Android viewer-file bridge; the text `share` action is never reused. */

export const VIEWER_NATIVE_SHARE_CAPABILITY = 'files.share'
export const VIEWER_NATIVE_CHUNK_BYTES = 192 * 1024
export const VIEWER_NATIVE_MAX_BYTES = 8 * 1024 * 1024

export interface ViewerNativeBridge {
  capabilities(): Promise<readonly string[]> | readonly string[]
  invoke(action: string, input?: unknown, options?: { readonly signal?: AbortSignal }): Promise<unknown>
}

export type ViewerNativeSendResult = 'shared' | 'unsupported' | 'too-large' | 'stale' | 'busy' | 'cancelled' | 'failed'

interface BridgeReply { readonly ok?: boolean; readonly id?: string; readonly nextOffset?: number }

/** Encode one chunk without spreading a 192 KiB array into the call stack. */
function base64(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  return btoa(binary)
}

/** Bind the negotiated viewer handoff to late native-bridge injection (`dsh-mobile-native-ready`). */
export function bindViewerNativeHandoff(
  getBridge: () => ViewerNativeBridge | undefined,
  events: {
    addEventListener(type: 'dsh-mobile-native-ready', listener: () => void): void
    removeEventListener(type: 'dsh-mobile-native-ready', listener: () => void): void
  },
) {
  let activeBridge: ViewerNativeBridge | undefined
  let activeSender: ReturnType<typeof createViewerNativeShare> | undefined
  let shareEnabled = false
  let generation = 0
  let disposed = false
  const refresh = (): void => {
    if (disposed) return
    const bridge = getBridge()
    if (bridge === activeBridge) return
    activeBridge = bridge
    activeSender = bridge === undefined ? undefined : createViewerNativeShare(bridge)
    shareEnabled = false
    const attempt = ++generation
    if (activeSender === undefined) return
    void activeSender.supported().then(supported => {
      if (!disposed && attempt === generation && activeBridge === bridge) shareEnabled = supported
    })
  }
  refresh()
  events.addEventListener('dsh-mobile-native-ready', refresh)
  return {
    enabled: (): boolean => shareEnabled && activeSender !== undefined,
    send: (file: File, current: () => boolean, signal: AbortSignal): Promise<ViewerNativeSendResult> =>
      activeSender === undefined ? Promise.resolve('unsupported') : activeSender.send(file, current, signal),
    dispose: (): void => {
      disposed = true
      generation += 1
      shareEnabled = false
      events.removeEventListener('dsh-mobile-native-ready', refresh)
    },
  }
}

/** One pending upload per document; every failure path cancels its partial transfer. */
export function createViewerNativeShare(bridge: ViewerNativeBridge) {
  let supportedPromise: Promise<boolean> | undefined
  let pending = false
  const supported = (): Promise<boolean> => supportedPromise ??= Promise.resolve(bridge.capabilities())
    .then(list => Array.isArray(list) && list.includes(VIEWER_NATIVE_SHARE_CAPABILITY))
    .catch(() => false)
  const invoke = (action: string, input: unknown, signal?: AbortSignal): Promise<BridgeReply> =>
    Promise.resolve(bridge.invoke(action, input, signal === undefined ? {} : { signal })) as Promise<BridgeReply>
  const cancel = (id: string): Promise<void> => invoke('files.share.cancel', { id }, undefined).then(() => undefined, () => undefined)
  return {
    supported,
    async send(file: File, current: () => boolean, signal: AbortSignal): Promise<ViewerNativeSendResult> {
      if (pending) return 'busy'
      pending = true // claimed synchronously so a concurrent gesture cannot begin a second upload
      try {
        if (!await supported()) return 'unsupported'
        if (file.size > VIEWER_NATIVE_MAX_BYTES) return 'too-large'
        if (!current() || signal.aborted) return 'stale'
        let id: string | undefined
        try {
          const begin = await invoke('files.share.begin', { name: file.name, mime: file.type || 'application/octet-stream', bytes: file.size }, signal)
          if (begin?.ok === false || typeof begin?.id !== 'string' || begin.id === '') return 'failed'
          id = begin.id
        } catch { return 'failed' }
        try {
          const bytes = new Uint8Array(await file.arrayBuffer())
          for (let offset = 0; offset < bytes.length; offset += VIEWER_NATIVE_CHUNK_BYTES) {
            if (!current() || signal.aborted) { await cancel(id); return 'cancelled' }
            const chunk = bytes.subarray(offset, offset + VIEWER_NATIVE_CHUNK_BYTES)
            const ack = await invoke('files.share.append', { id, offset, data: base64(chunk) }, signal)
            if (ack?.ok === false || ack?.nextOffset !== offset + chunk.length) throw Error('append rejected')
          }
          if (!current() || signal.aborted) { await cancel(id); return 'cancelled' }
          // Cooperative cancellation at chunk boundaries: Android's page adapter discards `signal` for
          // non-`auth.renew` actions (NativeBridge.kt ~line 1305), so dismissing the menu during the brief
          // `files.share.finish` bridge hop (milliseconds, bytes already staged, chooser still requires
          // explicit recipient selection) can launch the chooser over a closed menu. Known, accepted, ledgered.
          const done = await invoke('files.share.finish', { id }, signal)
          return done?.ok === true ? 'shared' : 'failed'
        } catch {
          await cancel(id)
          return signal.aborted ? 'cancelled' : 'failed'
        }
      } finally { pending = false }
    },
  }
}
