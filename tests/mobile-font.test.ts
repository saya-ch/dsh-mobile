import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MOBILE_FONT_SIZE, MOBILE_FONT_STORAGE_KEY, MOBILE_TYPOGRAPHY_STORAGE_KEY,
  MobileFontPreference, installMobileFontPreference, normalizeMobileFontFamily, parseMobileFontSize } from '../src/mobile-font.js'

afterEach(() => { vi.unstubAllGlobals() })

describe('mobile font preference', () => {
  it('defaults locally instead of inheriting a Host preference', () => {
    expect(new MobileFontPreference(null).getSnapshot()).toBe(16)
    for (const value of [null, '', '20px', '-1', '33', '11', '16.5', 'Infinity']) expect(parseMobileFontSize(value)).toBe(DEFAULT_MOBILE_FONT_SIZE)
    expect(parseMobileFontSize('20')).toBe(20)
  })

  it('persists local changes and restores them without Host RPCs', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const preference = new MobileFontPreference(storage)
    const listener = vi.fn()
    const unsubscribe = preference.subscribe(listener)
    preference.set(20)
    expect(values.get(MOBILE_FONT_STORAGE_KEY)).toBe('20')
    expect(new MobileFontPreference(storage).getSnapshot()).toBe(20)
    expect(listener).toHaveBeenCalledTimes(1)
    preference.set(20)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    preference.set(18)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps controls usable when storage is denied', () => {
    const storage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } }
    const preference = new MobileFontPreference(storage)
    expect(preference.getSnapshot()).toBe(16)
    preference.set(22)
    expect(preference.getSnapshot()).toBe(22)
  })

  it('rejects malformed sizes without changing the saved preference', () => {
    const preference = new MobileFontPreference(null)
    for (const size of [11, 33, 16.5, NaN, Infinity]) expect(() => preference.set(size)).toThrow(RangeError)
    expect(preference.getSnapshot()).toBe(16)
  })

  it('migrates the legacy mobile text size while adding an independent code default', () => {
    const values = new Map([[MOBILE_FONT_STORAGE_KEY, '22']])
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const preference = new MobileFontPreference(storage)
    expect(preference.getTypographySnapshot()).toEqual({ sizes: { text: 22, code: 11 }, families: { text: '', code: '' } })
    preference.setRoleSize('code', 17)
    preference.setRoleFamily('code', 'JetBrains Mono, monospace')
    expect(new MobileFontPreference(storage).getTypographySnapshot()).toEqual({
      sizes: { text: 22, code: 17 }, families: { text: '', code: '"JetBrains Mono", monospace' },
    })
    expect(values.get(MOBILE_FONT_STORAGE_KEY)).toBe('22')
  })

  it('keeps the last readable legacy size when the new JSON is corrupted or inaccessible', () => {
    for (const value of ['not-json', 'null', '[]', '{}', '{"sizes":null,"families":null}']) {
      const preference = new MobileFontPreference({ getItem: key => key === MOBILE_FONT_STORAGE_KEY ? '20' : value, setItem() {} })
      expect(preference.getTypographySnapshot()).toEqual({ sizes: { text: 20, code: 11 }, families: { text: '', code: '' } })
    }
    const preference = new MobileFontPreference({ getItem: key => {
      if (key === MOBILE_TYPOGRAPHY_STORAGE_KEY) throw new Error('denied')
      return '24'
    }, setItem() {} })
    expect(preference.getSnapshot()).toBe(24)
  })

  it('validates persisted roles independently without trusting arbitrary JSON fields', () => {
    const value = JSON.stringify({ sizes: { text: 100, code: 19, terminal: '20' }, families: { text: 42, code: '  Mono Font, monospace ', terminal: 'serif' }, injected: true })
    const preference = new MobileFontPreference({ getItem: key => key === MOBILE_FONT_STORAGE_KEY ? '18' : value, setItem() {} })
    expect(preference.getTypographySnapshot()).toEqual({ sizes: { text: 18, code: 19 }, families: { text: '', code: '"Mono Font", monospace' } })
    expect(Object.isFrozen(preference.getTypographySnapshot())).toBe(true)
    expect(Object.isFrozen(preference.getTypographySnapshot().sizes)).toBe(true)
    expect(Object.isFrozen(preference.getTypographySnapshot().families)).toBe(true)
  })

  it('normalizes existing font names and generic stacks idempotently with bounded input', () => {
    expect(normalizeMobileFontFamily(' "Noto Sans",\n monospace, , system-ui ')).toBe('"Noto Sans", monospace, system-ui')
    expect(normalizeMobileFontFamily('<>\\\u0000')).toBe('')
    expect(normalizeMobileFontFamily('x'.repeat(2048))).toHaveLength(1024)
    const long = normalizeMobileFontFamily('x'.repeat(2048))
    expect(normalizeMobileFontFamily(long)).toBe(long)
    const value = normalizeMobileFontFamily('Noto Sans SC, -apple-system, sans-serif')
    expect(normalizeMobileFontFamily(value)).toBe(value)
  })

  it('restores every local font role and keeps the legacy preference consistent', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const preference = new MobileFontPreference(storage)
    preference.set(24)
    preference.setRoleSize('code', 15)
    for (const role of ['text', 'code'] as const) preference.setRoleFamily(role, 'Custom Font')
    const listener = vi.fn()
    preference.subscribe(listener)
    preference.reset()
    expect(new MobileFontPreference(storage).getTypographySnapshot()).toEqual({ sizes: { text: 16, code: 11 }, families: { text: '', code: '' } })
    expect(values.get(MOBILE_FONT_STORAGE_KEY)).toBe('16')
    preference.reset()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid code values while keeping available local controls responsive', () => {
    const preference = new MobileFontPreference({ getItem: () => null, setItem: () => { throw new Error('quota') } })
    for (const role of ['code'] as const) {
      for (const size of [9, 33, 12.5, NaN, Infinity]) expect(() => preference.setRoleSize(role, size)).toThrow(RangeError)
      preference.setRoleSize(role, 20)
      preference.setRoleFamily(role, 'monospace')
    }
    expect(preference.getTypographySnapshot()).toEqual({ sizes: { text: 16, code: 20 }, families: { text: '', code: 'monospace' } })
  })
})

function fontSurface(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial).map(([property, value]) => [property, { value, priority: '' }]))
  const style = {
    getPropertyValue: (property: string) => values.get(property)?.value ?? '',
    getPropertyPriority: (property: string) => values.get(property)?.priority ?? '',
    setProperty: (property: string, value: string, priority = '') => { values.set(property, { value, priority }) },
    removeProperty: (property: string) => { const value = values.get(property)?.value ?? ''; values.delete(property); return value },
  }
  const disconnect = vi.fn()
  let notify = (): void => {}
  vi.stubGlobal('window', { localStorage: null })
  vi.stubGlobal('document', { body: { style } })
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: () => void) { notify = callback }
    observe() {}
    disconnect = disconnect
  })
  return { style, disconnect, notify: () => { notify() } }
}

describe('mobile font presentation ownership', () => {
  it('projects text and code onto body while leaving native terminal settings intact', () => {
    const surface = fontSurface({ '--dsh-content-font-size': '14px', '--dsh-font-family-text': 'Host Font', '--dsh-terminal-font-size': '18px', '--dsh-font-family-terminal': 'Host Terminal', '--other-token': 'keep' })
    const local = installMobileFontPreference()
    try {
      expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('16px')
      expect(surface.style.getPropertyValue('--dsh-code-font-size')).toBe('11px')
      expect(surface.style.getPropertyValue('--dsh-terminal-font-size')).toBe('18px')
      expect(surface.style.getPropertyValue('--dsh-font-family-terminal')).toBe('Host Terminal')
      expect(surface.style.getPropertyValue('--dsh-font-family-text')).toBe('')
      local.preference.setRoleSize('code', 18)
      local.preference.setRoleFamily('code', 'Local Mono')
      expect(surface.style.getPropertyValue('--dsh-code-font-size')).toBe('18px')
      expect(surface.style.getPropertyValue('--dsh-font-family-code')).toBe('"Local Mono"')
      expect(surface.style.getPropertyValue('--other-token')).toBe('keep')
    } finally { local.dispose() }
    expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('14px')
    expect(surface.style.getPropertyValue('--dsh-font-family-text')).toBe('Host Font')
    expect(surface.style.getPropertyValue('--dsh-code-font-size')).toBe('')
    expect(surface.disconnect).toHaveBeenCalledTimes(1)
  })

  it('retains mobile values through Host presentation updates and restores the latest foreign values on dispose', () => {
    const surface = fontSurface({ '--dsh-content-font-size': '14px' })
    const local = installMobileFontPreference()
    local.preference.set(22)
    surface.style.setProperty('--dsh-content-font-size', '18px', 'important')
    surface.style.setProperty('--dsh-font-family-code', 'Host Mono')
    surface.notify()
    expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('22px')
    expect(surface.style.getPropertyValue('--dsh-font-family-code')).toBe('')
    local.dispose()
    expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('18px')
    expect(surface.style.getPropertyPriority('--dsh-content-font-size')).toBe('important')
    expect(surface.style.getPropertyValue('--dsh-font-family-code')).toBe('Host Mono')
    local.preference.set(24)
    expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('18px')
  })

  it('leaves a newer foreign write intact when disposal precedes observer delivery', () => {
    const surface = fontSurface({ '--dsh-content-font-size': '14px' })
    const local = installMobileFontPreference()
    surface.style.setProperty('--dsh-content-font-size', '19px')
    surface.style.setProperty('--dsh-font-family-terminal', 'Foreign Mono')
    local.dispose()
    expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('19px')
    expect(surface.style.getPropertyValue('--dsh-font-family-terminal')).toBe('Foreign Mono')
  })

  it('tracks a foreign priority change even when the font value matches the local value', () => {
    const surface = fontSurface({ '--dsh-content-font-size': '14px' })
    const local = installMobileFontPreference()
    surface.style.setProperty('--dsh-content-font-size', '16px', 'important')
    surface.notify()
    expect(surface.style.getPropertyPriority('--dsh-content-font-size')).toBe('')
    local.dispose()
    expect(surface.style.getPropertyValue('--dsh-content-font-size')).toBe('16px')
    expect(surface.style.getPropertyPriority('--dsh-content-font-size')).toBe('important')
  })
})
