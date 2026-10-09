import { describe, expect, it, vi } from 'vitest'
import { MobileDisplayScaleController, parseMobileDisplayScale, type MobileDisplayScaleBridge } from '../src/mobile-display-scale.js'

const reply = (percent = 100) => ({ percent, minPercent: 80, maxPercent: 125 })
const capabilities = ['mobile.display-scale.get', 'mobile.display-scale.set'] as const
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

async function ready(controller: MobileDisplayScaleController) {
  await vi.waitFor(() => { expect(controller.getSnapshot().state).toBe('ready') })
}

describe('native mobile page scale', () => {
  it('hides the control in browsers and older Apps without both capabilities', async () => {
    const browser = new MobileDisplayScaleController(() => undefined)
    browser.start()
    expect(browser.getSnapshot().state).toBe('hidden')
    for (const supported of [[], ['mobile.display-scale.get'], ['mobile.display-scale.set']]) {
      const native = { capabilities: vi.fn(() => supported), invoke: vi.fn() }
      const controller = new MobileDisplayScaleController(() => native)
      controller.start()
      await vi.waitFor(() => { expect(native.capabilities).toHaveBeenCalledTimes(1) })
      expect(controller.getSnapshot().state).toBe('hidden')
      expect(native.invoke).not.toHaveBeenCalled()
      controller.stop()
    }
    browser.stop()
  })

  it('reads and writes through native capabilities without Host RPCs or browser preference writes', async () => {
    const invoke = vi.fn(async (_action: string, input: unknown) => typeof input === 'object' && input !== null && 'percent' in input ? reply(Number(input.percent)) : reply())
    const native = { capabilities: () => capabilities, invoke }
    const stable = new MobileDisplayScaleController(() => native)
    stable.start()
    await ready(stable)
    stable.setPercent(80)
    await ready(stable)
    expect(stable.getSnapshot().value?.percent).toBe(80)
    expect(invoke.mock.calls).toEqual([['mobile.display-scale.get', {}], ['mobile.display-scale.set', { percent: 80 }]])
    stable.setPercent(100)
    await ready(stable)
    expect(stable.getSnapshot().value?.percent).toBe(100)
    stable.stop()
  })

  it('serializes repeated taps while a native mutation is pending', async () => {
    const pending = deferred<unknown>()
    const native = { capabilities: () => capabilities, invoke: vi.fn((action: string) => action.endsWith('.get') ? Promise.resolve(reply()) : pending.promise) }
    const controller = new MobileDisplayScaleController(() => native)
    controller.start()
    await ready(controller)
    controller.setPercent(80)
    controller.setPercent(125)
    await vi.waitFor(() => { expect(native.invoke).toHaveBeenCalledTimes(2) })
    expect(controller.getSnapshot().state).toBe('busy')
    pending.resolve(reply(80))
    await ready(controller)
    expect(controller.getSnapshot().value?.percent).toBe(80)
    controller.stop()
  })

  it('keeps the last confirmed scale after failure and allows a fresh read', async () => {
    const native = { capabilities: () => capabilities, invoke: vi.fn(async (action: string) => {
      if (action.endsWith('.set')) throw new Error('native unavailable')
      return reply(90)
    }) }
    const controller = new MobileDisplayScaleController(() => native)
    controller.start()
    await ready(controller)
    controller.setPercent(125)
    await vi.waitFor(() => { expect(controller.getSnapshot().state).toBe('error') })
    expect(controller.getSnapshot().value?.percent).toBe(90)
    controller.refresh()
    await ready(controller)
    expect(controller.getSnapshot().value?.percent).toBe(90)
    controller.stop()
  })

  it('shows a recoverable read error only after capability support was confirmed', async () => {
    const native = { capabilities: () => capabilities, invoke: vi.fn(async () => { throw new Error('read failed') }) }
    const controller = new MobileDisplayScaleController(() => native)
    controller.start()
    await vi.waitFor(() => { expect(controller.getSnapshot().state).toBe('error') })
    expect(controller.getSnapshot().value).toBeNull()
    controller.stop()
  })

  it('ignores the result from a replaced native adapter', async () => {
    const pending = deferred<unknown>()
    const old = { capabilities: () => capabilities, invoke: vi.fn(() => pending.promise) }
    const next = { capabilities: () => capabilities, invoke: vi.fn(async () => reply(125)) }
    let native: MobileDisplayScaleBridge = old
    const controller = new MobileDisplayScaleController(() => native)
    controller.start()
    await vi.waitFor(() => { expect(old.invoke).toHaveBeenCalledTimes(1) })
    native = next
    controller.refresh()
    await ready(controller)
    pending.resolve(reply(80))
    await pending.promise
    expect(controller.getSnapshot().value?.percent).toBe(125)
    controller.stop()
  })

  it('does not start queued writes after the settings row unmounts', async () => {
    const native = { capabilities: () => capabilities, invoke: vi.fn(async () => reply()) }
    const controller = new MobileDisplayScaleController(() => native)
    controller.start()
    await ready(controller)
    controller.setPercent(80)
    controller.stop()
    await Promise.resolve()
    expect(native.invoke).toHaveBeenCalledTimes(1)
  })

  it('does not publish an in-flight result after disposal and can be mounted again', async () => {
    const pending = deferred<unknown>()
    const native = { capabilities: () => capabilities, invoke: vi.fn(() => pending.promise) }
    const controller = new MobileDisplayScaleController(() => native)
    const changed = vi.fn()
    controller.subscribe(changed)
    controller.start()
    await vi.waitFor(() => { expect(native.invoke).toHaveBeenCalledTimes(1) })
    controller.stop()
    const count = changed.mock.calls.length
    pending.resolve(reply(80))
    await pending.promise
    expect(changed).toHaveBeenCalledTimes(count)
    controller.start()
    await ready(controller)
    expect(controller.getSnapshot().value?.percent).toBe(80)
    controller.stop()
  })

  it('rejects invalid user values before requesting a native change', async () => {
    const native = { capabilities: () => capabilities, invoke: vi.fn(async () => reply()) }
    const controller = new MobileDisplayScaleController(() => native)
    controller.start()
    await ready(controller)
    for (const percent of [79, 126, 100.5, NaN, Infinity]) controller.setPercent(percent)
    controller.setPercent(100)
    expect(native.invoke).toHaveBeenCalledTimes(1)
    controller.stop()
  })

  it('validates native replies and keeps the confirmed object immutable', () => {
    expect(Object.isFrozen(parseMobileDisplayScale(reply(125)))).toBe(true)
    for (const value of [null, [], {}, '100', reply(126), reply(100.5), { ...reply(), minPercent: 79 }, { ...reply(), maxPercent: 126 }, { ...reply(), percent: '100' }]) {
      expect(() => parseMobileDisplayScale(value)).toThrow(TypeError)
    }
  })
})
