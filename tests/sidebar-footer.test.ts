import { Children, type ReactElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, CONTROL_STYLES } from '../src/client.js'

class FakeElement extends EventTarget {
  readonly children: FakeElement[] = []
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  parent: FakeElement | undefined
  className = ''
  hidden = false
  id = ''
  lang = ''
  textContent = ''

  constructor(readonly tagName: string) { super() }
  focus(): void {}

  get classList() {
    return {
      toggle: (name: string, enabled: boolean) => {
        const names = new Set(this.className.split(' ').filter(Boolean))
        if (enabled) names.add(name)
        else names.delete(name)
        this.className = [...names].join(' ')
      },
    }
  }

  append(...children: FakeElement[]): void {
    for (const child of children) {
      child.remove()
      child.parent = this
      this.children.push(child)
    }
  }

  remove(): void {
    if (this.parent === undefined) return
    this.parent.children.splice(this.parent.children.indexOf(this), 1)
    this.parent = undefined
  }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  contains(target: unknown): boolean { return target === this || this.children.some(child => child.contains(target)) }

  querySelectorAll(selector: string): FakeElement[] {
    return this.children.flatMap(child => [
      ...(child.className.split(' ').includes(selector.slice(1)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ])
  }
}

class FakeDocument extends EventTarget {
  readonly documentElement = { lang: 'en-US' }
  readonly head = new FakeElement('head')
  readonly body = new FakeElement('body')
  readonly activeElement = null
  createElement(tag: string): FakeElement { return new FakeElement(tag) }
  querySelectorAll(selector: string): FakeElement[] { return this.body.querySelectorAll(selector) }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null }
}

interface TriggerProps {
  'aria-expanded': boolean
  'aria-controls': string
  'aria-label': string
  className: string
  lang: string
  title: string
  type: string
  children: ReactNode
  onClick(): void
}

const cleanup: (() => void)[] = []

afterEach(() => {
  for (const remove of cleanup.splice(0).reverse()) remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function installFooter(locale = 'en-US', hostname = 'localhost') {
  vi.useFakeTimers()
  const document = new FakeDocument()
  document.documentElement.lang = locale
  const window = Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval })
  const disconnect = vi.fn()
  const disposeSlot = vi.fn()
  const disposeSettings = vi.fn()
  const injectSlot = vi.fn((_name: string, install: () => () => void) => install())
  let renderer: ((wide: boolean) => ReactElement<TriggerProps>) | undefined

  vi.stubGlobal('document', document)
  vi.stubGlobal('window', window)
  vi.stubGlobal('location', { hostname, search: '' })
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' })
  vi.stubGlobal('Node', FakeElement)
  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('MutationObserver', class {
    observe(): void {}
    disconnect = disconnect
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))

  apply({
    effect(install) {
      const remove = install()
      if (remove !== undefined) cleanup.push(remove)
    },
    get: () => ({ isLoopback: true }),
    slots: {
      inject: injectSlot,
      register(options, component) {
        if (options.name === 'settings.general.item') {
          expect(options).toMatchObject({ id: 'dsh-mobile-client-modules', order: 120 })
          const row = component({} as never) as ReactElement<{ scope: string; locale: string }>
          expect(row.props.scope).toBe('computer')
          expect(row.props.locale).toBe(locale.split('-')[0] === 'zh' ? 'zh' : locale.split('-')[0] === 'it' ? 'it' : 'en')
          return disposeSettings
        }
        expect(options).toMatchObject({ name: 'sidebar.footer.action', id: 'dsh-mobile', order: 40 })
        renderer = wide => component({ wide } as never) as ReactElement<TriggerProps>
        return disposeSlot
      },
    },
  })

  return {
    document,
    disconnect,
    disposeSlot,
    disposeSettings,
    injectSlot,
    render(wide: boolean): ReactElement<TriggerProps> {
      if (renderer === undefined) throw new Error('Mobile Access footer was not registered')
      return renderer(wide)
    },
    mount(wide: boolean) {
      const tree = this.render(wide)
      const button = new FakeElement('button')
      button.className = tree.props.className
      button.setAttribute('aria-expanded', String(tree.props['aria-expanded']))
      button.addEventListener('click', tree.props.onClick)
      document.body.append(button)
      return { tree, button }
    },
  }
}

function declarations(selector: string): Record<string, string> {
  const start = CONTROL_STYLES.indexOf(`${selector}{`)
  expect(start, `missing CSS rule ${selector}`).toBeGreaterThanOrEqual(0)
  const body = CONTROL_STYLES.slice(start + selector.length + 1, CONTROL_STYLES.indexOf('}', start))
  return Object.fromEntries(body.split(';').filter(Boolean).map(declaration => {
    const colon = declaration.indexOf(':')
    return [declaration.slice(0, colon), declaration.slice(colon + 1)]
  }))
}

describe('desktop Mobile Access footer', () => {
  it('shares the footer row geometry and the compact icon target', () => {
    expect(declarations('.dsh-mobile-control__trigger')).toMatchObject({
      'box-sizing': 'border-box',
      flex: '1 1 auto',
      gap: 'var(--dsh-sidebar-label-gap,6px)',
      width: '100%',
      height: '42px',
      margin: '4px 2px',
      padding: '0 calc(var(--dsh-sidebar-row-padding,12px) - var(--dsh-sidebar-paint-inset,3px))',
      border: '0',
      'border-inline': 'var(--dsh-sidebar-paint-inset,3px) solid transparent',
      'background-clip': 'padding-box',
      'border-radius': 'var(--dsw-radius-md,12px)',
      'font-family': 'inherit',
      'font-size': '14px',
      'line-height': '22px',
      color: 'var(--dsw-alias-label-primary,#16181d)',
    })
    expect(declarations('.dsh-mobile-control__trigger.is-icon')).toMatchObject({
      flex: '0 0 auto',
      width: '36px',
      'min-width': '36px',
      height: '36px',
      margin: '4px 2px',
      padding: '0',
      gap: '0',
      'justify-content': 'center',
      'border-inline': '0',
      'border-radius': 'var(--dsw-radius-md,12px)',
    })
    expect(declarations('.dsh-mobile-control__trigger-icon')).toMatchObject({ width: '16px', height: '16px' })
    expect(declarations('.dsh-mobile-control__trigger.is-icon>.dsh-mobile-control__trigger-icon')).toEqual({ width: '18px', height: '18px' })
  })

  it('uses theme tokens for hover, pressed, expanded, and visible keyboard focus', () => {
    expect(declarations('.dsh-mobile-control__trigger:hover')['background-color']).toBe('var(--dsw-alias-interactive-bg-hover,#f1f3f6)')
    expect(declarations('.dsh-mobile-control__trigger:active,.dsh-mobile-control__trigger[aria-expanded="true"]')['background-color']).toBe('var(--dsw-alias-interactive-bg-active,#e8ebf0)')
    // Scoped above `.dsh-mobile-control button:focus-visible`, which is more specific.
    expect(declarations('.dsh-mobile-control .dsh-mobile-control__trigger:focus-visible')).toEqual({
      outline: '2px solid var(--dsw-alias-state-business-primary,currentColor)',
      'outline-offset': '-2px',
    })
    expect(CONTROL_STYLES).not.toContain('.dsh-mobile-control__trigger-icon::after')
  })

  it('lets a shared row size the label form by its own text instead of a fixed 44px', () => {
    expect(declarations('.dsh-mobile-control__trigger.is-shared')).toEqual({
      flex: '0 0 auto',
      width: 'auto',
      'max-width': '100%',
    })
    // The seat counts its peers through the capacity contract; the old
    // :only-child heuristic made one labelled button and two bare icons.
    expect(CONTROL_STYLES).not.toContain('.dsh-mobile-control__trigger:not(.is-rail):not(:only-child)')
    expect(CONTROL_STYLES).not.toContain('.dsh-mobile-control__trigger.is-rail')
  })

  it.each([
    ['en-US', 'Mobile access'],
    ['zh-CN', '移动访问'],
    ['it-IT', 'Accesso mobile'],
  ])('keeps a localized accessible name and the same vector icon in both widths for %s', (locale, label) => {
    const footer = installFooter(locale)
    expect(footer.injectSlot.mock.calls.map(([name]) => name)).toEqual(['settings.general.item', 'sidebar.footer.action'])
    expect(footer.injectSlot).toHaveBeenNthCalledWith(2, 'sidebar.footer.action', expect.any(Function))
    for (const wide of [true, false]) {
      const tree = footer.render(wide)
      const children = Children.toArray(tree.props.children) as ReactElement<{ children?: ReactNode }>[]
      expect(tree.type).toBe('button')
      expect(tree.props).toMatchObject({ 'aria-label': label, title: label, type: 'button', 'aria-expanded': false })
      expect(tree.props.className.includes('is-icon')).toBe(!wide)
      expect(children[0]?.type).toBe('svg')
      expect(children[0]?.props).toMatchObject({
        'aria-hidden': true,
        focusable: false,
        width: 18,
        height: 18,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
      })
      // The label stays in the tree in both forms; CSS hides it for the icon target.
      expect(children).toHaveLength(2)
      expect(children[1]?.props.children).toBe(label)
    }
  })

  it('keeps expanded state in sync when the open panel trigger is remounted as a rail', () => {
    const footer = installFooter()
    const wide = footer.mount(true)
    const panel = footer.document.querySelector('.dsh-mobile-control__panel')
    expect(panel?.id).toBe(wide.tree.props['aria-controls'])
    expect(panel?.hidden).toBe(true)

    wide.button.dispatchEvent(new Event('click'))
    expect(panel?.hidden).toBe(false)
    expect(wide.button.getAttribute('aria-expanded')).toBe('true')
    expect(footer.render(true).props['aria-expanded']).toBe(true)

    wide.button.remove()
    const rail = footer.mount(false)
    expect(rail.tree.props['aria-expanded']).toBe(true)
    expect(rail.button.getAttribute('aria-expanded')).toBe('true')

    footer.document.querySelector('.dsh-mobile-control__close')?.dispatchEvent(new Event('click'))
    expect(panel?.hidden).toBe(true)
    expect(rail.button.getAttribute('aria-expanded')).toBe('false')
    expect(footer.render(false).props['aria-expanded']).toBe(false)

    rail.button.dispatchEvent(new Event('click'))
    expect(panel?.hidden).toBe(false)
    rail.button.dispatchEvent(new Event('click'))
    expect(panel?.hidden).toBe(true)
    expect(rail.button.getAttribute('aria-expanded')).toBe('false')
  })

  it('registers the desktop footer on a private LAN address', () => {
    const footer = installFooter('zh-CN', '192.168.50.23')
    expect(footer.injectSlot.mock.calls.map(([name]) => name)).toEqual(['settings.general.item', 'sidebar.footer.action'])
    expect(footer.injectSlot).toHaveBeenNthCalledWith(2, 'sidebar.footer.action', expect.any(Function))
    expect(footer.render(true).props).toMatchObject({ 'aria-label': '移动访问', title: '移动访问' })
  })

  it('reflects outside dismissal and removes its panel, styles, and registration on disposal', () => {
    const footer = installFooter()
    const { button } = footer.mount(true)
    button.dispatchEvent(new Event('click'))
    const outside = new Event('pointerdown')
    Object.defineProperty(outside, 'target', { value: footer.document.body })
    footer.document.dispatchEvent(outside)
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(footer.render(true).props['aria-expanded']).toBe(false)

    const remove = cleanup.pop()
    expect(remove).toBeDefined()
    remove?.()
    expect(footer.document.querySelector('.dsh-mobile-control__panel')).toBeNull()
    expect(footer.document.head.children).toHaveLength(0)
    expect(footer.disposeSlot).toHaveBeenCalledOnce()
    expect(footer.disposeSettings).toHaveBeenCalledOnce()
    expect(footer.disconnect).toHaveBeenCalledOnce()
  })
})
