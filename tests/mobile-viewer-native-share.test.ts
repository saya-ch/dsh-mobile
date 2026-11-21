import { describe, expect, it, vi } from 'vitest'
import { bindViewerNativeHandoff, createViewerNativeShare, VIEWER_NATIVE_SHARE_CAPABILITY, VIEWER_NATIVE_CHUNK_BYTES } from '../src/mobile-viewer-native-share.js'

const NAME = '報告.xlsx'
const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** Reference native side: records the protocol and stores staged bytes per transfer id. */
function fakeNative() {
  const state = { calls: [] as Array<{ action: string; input: any }>, staged: new Map<string, Uint8Array>(), ids: 0, failAppend: -1, quotaFull: false }
  const bridge = {
    capabilities: async () => state.quotaFull ? ['share'] : ['share', VIEWER_NATIVE_SHARE_CAPABILITY],
    invoke: vi.fn(async (action: string, input: any = {}): Promise<unknown> => {
      state.calls.push({ action, input })
      if (action === 'files.share.begin') {
        if (state.quotaFull) throw Object.assign(Error('aggregate full'), { code: 'aggregate_full' })
        const id = `n${++state.ids}`; state.staged.set(id, new Uint8Array(input.bytes))
        return { ok: true, id }
      }
      if (action === 'files.share.append') {
        const index = state.calls.filter(c => c.action === 'files.share.append').length
        if (index === state.failAppend) throw Object.assign(Error('offset'), { code: 'offset_mismatch' })
        const held = state.staged.get(input.id)!
        const bytes = Uint8Array.from(atob(input.data), c => c.charCodeAt(0))
        held.set(bytes, input.offset)
        return { ok: true, nextOffset: input.offset + bytes.length }
      }
      if (action === 'files.share.finish') { if (!state.staged.has(input.id)) throw Error('unknown'); return { ok: true } }
      if (action === 'files.share.cancel') { state.staged.delete(input.id); return { ok: true } }
      throw Error('unexpected action ' + action)
    }),
  }
  return { state, bridge }
}

const fileOf = (size: number, fill = 7): File => new File([new Uint8Array(size).fill(fill)], NAME, { type: MIME })

describe('createViewerNativeShare sender', () => {
  it('an old app without the negotiated capability gets no file action', async () => {
    const { state, bridge } = fakeNative(); state.quotaFull = true // capabilities list drops files.share
    const sender = createViewerNativeShare(bridge)
    expect(await sender.supported()).toBe(false)
    expect(await sender.send(fileOf(3), () => true, new AbortController().signal)).toBe('unsupported')
    expect(state.calls).toEqual([])
  })

  it('streams bounded monotonic chunks, awaiting each ack before the next, and finishes once', async () => {
    const { state, bridge } = fakeNative()
    const sender = createViewerNativeShare(bridge)
    const size = VIEWER_NATIVE_CHUNK_BYTES + 1000
    expect(await sender.send(fileOf(size, 9), () => true, new AbortController().signal)).toBe('shared')
    const begin = state.calls[0]; expect(begin).toEqual({ action: 'files.share.begin', input: { name: NAME, mime: MIME, bytes: size } })
    const appends = state.calls.filter(c => c.action === 'files.share.append')
    expect(appends.map(a => a.input.offset)).toEqual([0, VIEWER_NATIVE_CHUNK_BYTES])
    expect(appends.map(a => atob(a.input.data).length)).toEqual([VIEWER_NATIVE_CHUNK_BYTES, 1000])
    expect(state.calls.at(-1)!.action).toBe('files.share.finish')
    expect(state.calls.filter(c => c.action === 'files.share.finish')).toHaveLength(1)
    const staged = state.staged.get('n1')!
    expect(staged.length).toBe(size); expect(staged.every(b => b === 9)).toBe(true)
  })

  it('refuses an oversized file before any bridge call', async () => {
    const { state, bridge } = fakeNative()
    const sender = createViewerNativeShare(bridge)
    expect(await sender.send(fileOf(8 * 1024 * 1024 + 1), () => true, new AbortController().signal)).toBe('too-large')
    expect(state.calls).toEqual([])
  })

  it('a rejected append cancels the partial transfer and never launches a chooser', async () => {
    const { state, bridge } = fakeNative(); state.failAppend = 2
    const sender = createViewerNativeShare(bridge)
    const size = VIEWER_NATIVE_CHUNK_BYTES * 3
    expect(await sender.send(fileOf(size), () => true, new AbortController().signal)).toBe('failed')
    expect(state.calls.some(c => c.action === 'files.share.finish')).toBe(false)
    expect(state.calls.at(-1)).toEqual({ action: 'files.share.cancel', input: { id: 'n1' } })
    expect(state.staged.size).toBe(0)
  })

  it('aborts mid-transfer into a cancel, dropping the partial file', async () => {
    const { state, bridge } = fakeNative()
    const controller = new AbortController()
    const wrapped = { ...bridge, invoke: async (action: string, input?: any) => {
      if (action === 'files.share.append' && state.calls.filter(c => c.action === 'files.share.append').length === 1) controller.abort()
      return bridge.invoke(action, input)
    } }
    const sender = createViewerNativeShare(wrapped)
    expect(await sender.send(fileOf(VIEWER_NATIVE_CHUNK_BYTES * 2), () => true, controller.signal)).toBe('cancelled')
    expect(state.calls.some(c => c.action === 'files.share.finish')).toBe(false)
    expect(state.calls.at(-1)!.action).toBe('files.share.cancel')
    expect(state.staged.size).toBe(0)
  })

  it('allows only one pending upload per document', async () => {
    const { bridge } = fakeNative()
    const sender = createViewerNativeShare(bridge)
    const first = sender.send(fileOf(VIEWER_NATIVE_CHUNK_BYTES * 4), () => true, new AbortController().signal)
    expect(await sender.send(fileOf(10), () => true, new AbortController().signal)).toBe('busy')
    expect(await first).toBe('shared')
    expect(await sender.send(fileOf(10, 3), () => true, new AbortController().signal)).toBe('shared')
  })

  it('two attachments with one display name keep distinct bytes', async () => {
    const { state, bridge } = fakeNative()
    const sender = createViewerNativeShare(bridge)
    await sender.send(fileOf(5, 1), () => true, new AbortController().signal)
    await sender.send(fileOf(5, 2), () => true, new AbortController().signal)
    const bytes = [...state.staged.values()]
    expect(bytes).toHaveLength(2)
    expect([...bytes[0]!]).toEqual([1, 1, 1, 1, 1])
    expect([...bytes[1]!]).toEqual([2, 2, 2, 2, 2])
  })

  it('a stale viewer cannot start a transfer', async () => {
    const { state, bridge } = fakeNative()
    const sender = createViewerNativeShare(bridge)
    expect(await sender.send(fileOf(3), () => false, new AbortController().signal)).toBe('stale')
    expect(state.calls).toEqual([])
  })

  it('activates native handoff when __DSH_MOBILE_NATIVE__ arrives later on dsh-mobile-native-ready', async () => {
    const { state, bridge } = fakeNative()
    let injected: typeof bridge | undefined
    const target = new EventTarget()
    const handoff = bindViewerNativeHandoff(() => injected, target as never)
    expect(handoff.enabled()).toBe(false)
    injected = bridge
    target.dispatchEvent(new Event('dsh-mobile-native-ready'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(handoff.enabled()).toBe(true)
    expect(await handoff.send(fileOf(4, 5), () => true, new AbortController().signal)).toBe('shared')
    expect(state.staged.size).toBe(1)
    handoff.dispose()
    expect(handoff.enabled()).toBe(false)
  })

  it('accepts unwrapped NativeBridge response.value payloads ({ id }, { nextOffset }) without inner ok', async () => {
    const staged = new Map<string, Uint8Array>()
    const bridge = {
      capabilities: async () => [VIEWER_NATIVE_SHARE_CAPABILITY],
      invoke: async (action: string, input: any) => {
        if (action === 'files.share.begin') { staged.set('n1', new Uint8Array(input.bytes)); return { id: 'n1' } }
        if (action === 'files.share.append') {
          const bytes = Uint8Array.from(atob(input.data), c => c.charCodeAt(0))
          staged.get(input.id)!.set(bytes, input.offset)
          return { nextOffset: input.offset + bytes.length }
        }
        if (action === 'files.share.finish') return { ok: true }
        return { ok: true }
      },
    }
    const sender = createViewerNativeShare(bridge)
    expect(await sender.send(fileOf(12, 4), () => true, new AbortController().signal)).toBe('shared')
    expect([...staged.get('n1')!]).toEqual(new Array(12).fill(4))
  })
})
