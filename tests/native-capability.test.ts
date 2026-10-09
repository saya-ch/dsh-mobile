import { describe, expect, it, vi } from 'vitest'
import { invokeBoundNativeCapability } from '../src/native-capability.js'

describe('extension-owned queued native capability', () => {
  it('does not start a native effect after synchronous disposal', async () => {
    const controller = new AbortController()
    const bridge = { invoke: vi.fn(async () => ({ ok: true })) }
    const call = invokeBoundNativeCapability(bridge, () => bridge, 'camera.capture', {}, controller.signal)
    controller.abort(new DOMException('extension disposed', 'AbortError'))
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(bridge.invoke).not.toHaveBeenCalled()
  })

  it('does not start an effect on a replaced native bridge', async () => {
    const bridge = { invoke: vi.fn(async () => ({ ok: true })) }
    let current = bridge
    const call = invokeBoundNativeCapability(bridge, () => current, 'clipboard.write', { text: 'old owner' }, new AbortController().signal)
    current = { invoke: vi.fn(async () => ({ ok: true })) }
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    expect(bridge.invoke).not.toHaveBeenCalled()
    expect(current.invoke).not.toHaveBeenCalled()
  })

  it('rejects cancellation after a started effect without retrying or claiming rollback', async () => {
    let complete!: (value: unknown) => void
    const controller = new AbortController()
    const bridge = { invoke: vi.fn(() => new Promise(resolve => { complete = resolve })) }
    const call = invokeBoundNativeCapability(bridge, () => bridge, 'share', {}, controller.signal)
    await Promise.resolve()
    expect(bridge.invoke).toHaveBeenCalledTimes(1)
    controller.abort()
    await expect(call).rejects.toMatchObject({ name: 'AbortError' })
    complete({ ok: true })
    await Promise.resolve()
    expect(bridge.invoke).toHaveBeenCalledTimes(1)
  })

  it('passes through the live native result and rejects native errors', async () => {
    const bridge = { invoke: vi.fn(async () => ({ ok: true })) }
    await expect(invokeBoundNativeCapability(bridge, () => bridge, 'share', { text: 'live' }, new AbortController().signal)).resolves.toEqual({ ok: true })
    expect(bridge.invoke).toHaveBeenCalledWith('share', { text: 'live' })
    bridge.invoke.mockRejectedValueOnce(new Error('native failure'))
    await expect(invokeBoundNativeCapability(bridge, () => bridge, 'share', {}, new AbortController().signal)).rejects.toThrow('native failure')
  })
})
