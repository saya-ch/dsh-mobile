import { describe, expect, it } from 'vitest'
import { installMobileUiLocalePersistence } from '../src/mobile-ui-locale.js'

/** Minimal DOM boundary: real installer, recorded browser cookie assignments and observer delivery. */
function fixture({ lang = 'en-US', owned = true, protocol = 'https:', blocked = false } = {}) {
  const writes: string[] = []
  let deliver = () => {}
  let disconnected = false
  let observed: unknown
  const root = { lang }
  const page = {
    documentElement: root,
    querySelector(selector: string) {
      return owned && selector === 'meta[name="dsh-mobile-gateway"][content="authenticated"]' ? {} : null
    },
    set cookie(value: string) { if (blocked) throw new Error('storage blocked'); writes.push(value) },
  } as unknown as Document
  class Observer {
    constructor(callback: () => void) { deliver = callback }
    observe(target: unknown, options: unknown) { observed = { target, options } }
    disconnect() { disconnected = true }
  }
  const view = { location: { protocol }, MutationObserver: Observer } as unknown as Window
  return { page, view, root, writes, change(value: string) { root.lang = value; deliver() },
    deliver: () => deliver(), observed: () => observed, disconnected: () => disconnected }
}

describe('mobile UI locale persistence', () => {
  it('records DSH document language immediately and follows normalized changes', () => {
    const f = fixture()
    const stop = installMobileUiLocalePersistence(f.page, f.view)
    expect(f.writes).toEqual(['dsh_ma_ui_locale=en; Path=/mobile-access; Max-Age=31536000; SameSite=Lax; Secure'])
    expect(f.observed()).toEqual({ target: f.root, options: { attributes: true, attributeFilter: ['lang'] } })
    f.change('IT_it')
    f.change('it-IT')
    f.change('zh-CN')
    expect(f.writes.map(value => value.split(';')[0])).toEqual(['dsh_ma_ui_locale=en', 'dsh_ma_ui_locale=it', 'dsh_ma_ui_locale=zh'])
    stop()
    expect(f.disconnected()).toBe(true)
    f.change('en')
    expect(f.writes).toHaveLength(3)
  })

  it('preserves preference through blank language and maps unsupported DSH language to English', () => {
    const f = fixture({ lang: '' })
    const stop = installMobileUiLocalePersistence(f.page, f.view)
    expect(f.writes).toEqual([])
    f.change('zh-HK')
    f.change('  ')
    expect(f.writes).toHaveLength(1)
    // `fr` is supported now; use a language that genuinely is not.
    f.change('nl-NL')
    expect(f.writes.at(-1)).toMatch(/^dsh_ma_ui_locale=en;/u)
    stop()
  })

  it('does not persist preferences on ordinary desktop or preview pages', () => {
    const f = fixture({ owned: false })
    const stop = installMobileUiLocalePersistence(f.page, f.view)
    f.change('it')
    expect(f.writes).toEqual([])
    expect(f.observed()).toBeUndefined()
    stop()
  })

  it('leaves HTTP usable without Secure', () => {
    const f = fixture({ protocol: 'http:' })
    const stop = installMobileUiLocalePersistence(f.page, f.view)
    expect(f.writes).toEqual(['dsh_ma_ui_locale=en; Path=/mobile-access; Max-Age=31536000; SameSite=Lax'])
    stop()
  })

  it('does not interrupt startup or later language changes when cookies are blocked', () => {
    const f = fixture({ blocked: true })
    const stop = installMobileUiLocalePersistence(f.page, f.view)
    expect(() => f.change('it')).not.toThrow()
    expect(f.writes).toEqual([])
    stop()
  })
})
