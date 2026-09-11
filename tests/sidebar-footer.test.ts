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

function installFooter(locale = 'en-US') {
  vi.useFakeTimers()
  const document = new FakeDocument()
  document.documentElement.lang = locale
  const window = Object.assign(new EventTarget(), { setTimeout, clearTimeout, setInterval, clearInterval })
  const disconnect = vi.fn()
  const disposeSlot = vi.fn()
  const injectSlot = vi.fn((_name: string, install: () => () => void) => install())
  let renderer: ((wide: boolean) => ReactElement<TriggerProps>) | undefined

  vi.stubGlobal('document', document)
  vi.stubGlobal('window', window)
  vi.stubGlobal('location', { hostname: 'localhost', search: '' })
  vi.stubGlobal('navigator', { languages: ['en-US'], language: 'en-US' })
  vi.stubGlobal('Node', FakeElement)
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
        expect(options).toMatchObject({ name: 'sidebar.footer.action', id: 'dsh-mobile' })
        renderer = wide => component({ wide } as never) as ReactElement<TriggerProps>
        return disposeSlot
      },
    },
  })

  return {
    document,
    disconnect,
    disposeSlot,
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
  it('shares the footer row and preserves the compact rail target', () => {
    expect(declarations('.dsh-mobile-control__trigger')).toMatchObject({
      'box-sizing': 'border-box',
      flex: '1 1 auto',
      gap: '8px',
      width: '100%',
      height: '42px',
      margin: '4px 0',
      padding: '0 10px 0 8px',
      border: '0',
      'border-radius': '12px',
      'font-family': 'inherit',
      'font-size': '14px',
      'line-height': '22px',
      color: 'var(--dsw-alias-label-primary,#16181d)',
    })
    expect(declarations('.dsh-mobile-control__trigger.is-rail')).toMatchObject({
      flex: '0 0 auto',
      width: '36px',
      height: '36px',
      margin: '8px 0 10px',
      padding: '0',
      gap: '0',
      'justify-content': 'center',
      'border-radius': '50%',
    })
  })

  it('uses theme tokens for hover, pressed, expanded, and visible keyboard focus', () => {
    expect(declarations('.dsh-mobile-control__trigger:hover').background).toBe('var(--dsw-alias-interactive-bg-hover,#f1f3f6)')
    expect(declarations('.dsh-mobile-control__trigger:active,.dsh-mobile-control__trigger[aria-expanded="true"]').background).toBe('var(--dsw-alias-interactive-bg-active,#e8ebf0)')
    expect(declarations('.dsh-mobile-control__trigger:focus-visible')).toEqual({
      outline: '2px solid var(--dsw-alias-state-business-primary,currentColor)',
      'outline-offset': '2px',
    })
    expect(CONTROL_STYLES).not.toContain('.dsh-mobile-control__trigger-icon::after')
  })

  it.each([
    ['en-US', 'Mobile access'],
    ['zh-CN', '移动访问'],
    ['it-IT', 'Accesso mobile'],
  ])('keeps a localized accessible name and the same vector icon in both widths for %s', (locale, label) => {
    const footer = installFooter(locale)
    expect(footer.injectSlot).toHaveBeenCalledExactlyOnceWith('sidebar.footer.action', expect.any(Function))
    for (const wide of [true, false]) {
      const tree = footer.render(wide)
      const children = Children.toArray(tree.props.children) as ReactElement[]
      expect(tree.type).toBe('button')
      expect(tree.props).toMatchObject({ 'aria-label': label, title: label, type: 'button', 'aria-expanded': false })
      expect(tree.props.className.includes('is-rail')).toBe(!wide)
      expect(children[0]?.type).toBe('svg')
      expect(children[0]?.props).toMatchObject({
        'aria-hidden': true,
        focusable: false,
        width: wide ? 16 : 18,
        height: wide ? 16 : 18,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
      })
      expect(children).toHaveLength(wide ? 2 : 1)
      if (wide) expect(children[1]?.props.children).toBe(label)
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
    expect(footer.disconnect).toHaveBeenCalledOnce()
  })
})
