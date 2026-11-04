import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureSidebarScroll, installMobileSidebarScrollMemory, sidebarRestoreTop } from '../src/mobile-sidebar-scroll.js'

class FakePort {
  isConnected = true
  clientHeight = 100
  scrollHeight = 1100
  classList = ['test_list']
  dataset: Record<string, string> = {}
  rows: FakePort[] = []
  children: FakePort[] = []
  parent: FakePort | undefined
  closed = false
  inDrawer = false
  wideBand: string | null = null
  y = 0
  height = 20
  selected = false
  value = ''
  search: FakePort | undefined
  private top = 0
  get scrollTop(): number { return this.top }
  set scrollTop(value: number) { this.top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value)) }
  getClientRects(): object[] { return this.clientHeight > 0 ? [{}] : [] }
  getBoundingClientRect(): { top: number; bottom: number; height: number } {
    const top = this.parent === undefined ? 0 : this.y - this.parent.scrollTop
    return { top, bottom: top + this.height, height: this.height }
  }
  getAttribute(name: string): string | null {
    if (name === 'data-row-key') return this.dataset.rowKey ?? null
    if (name === 'data-dshm-wide') return this.wideBand
    return null
  }
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)) || this.rows.includes(node as FakePort) }
  closest(selector: string): FakePort | null {
    if (selector === '[data-open="false"]') return this.closed ? this : null
    if (selector === '[data-pane="sidebar"]') return this.inDrawer ? this : null
    return null
  }
  querySelectorAll(selector: string): FakePort[] {
    return selector === '[data-row-key]' ? this.rows : this.children
  }
  querySelector(selector: string): FakePort | null {
    return selector.endsWith(' input') ? this.search ?? null
      : selector.includes('aria-selected') ? this.rows.find(row => row.selected) ?? null
      : selector === '[data-row-key]' ? this.rows[0] ?? null : null
  }
}

function fixture() {
  const root = new FakePort(); root.classList = ['test_root']; root.height = 100
  const listeners = new Map<string, EventListener>()
  let id = 0
  const frames = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('HTMLElement', FakePort)
  vi.stubGlobal('Node', FakePort)
  vi.stubGlobal('document', {
    querySelector: () => root,
    addEventListener: (type: string, listener: EventListener) => { listeners.set(type, listener) },
    removeEventListener: (type: string) => { listeners.delete(type) },
  })
  // `mobile` is the stock <=720px band; the dedicated band is the shell marker.
  let mobile = true
  const windowListeners = new Map<string, EventListener>()
  vi.stubGlobal('window', {
    matchMedia: () => ({ get matches() { return mobile }, addEventListener: () => {}, removeEventListener: () => {} }),
    addEventListener: (type: string, listener: EventListener) => { windowListeners.set(type, listener) },
    removeEventListener: (type: string) => { windowListeners.delete(type) },
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (key: number) => { frames.delete(key) })
  const list = (selected = false): FakePort => {
    const port = new FakePort(); port.height = 100
    for (let i = 0; i < 50; i++) {
      const row = new FakePort(); row.parent = port; row.y = i * 20; row.dataset.rowKey = `session:${i}`; row.selected = selected && i === 35
      port.rows.push(row)
    }
    root.children = [port]
    return port
  }
  const tick = (count = 4): void => {
    for (let i = 0; i < count; i++) {
      const batch = [...frames.values()]; frames.clear(); batch.forEach(callback => callback(0))
    }
  }
  const event = (type: string, target: FakePort): void => { listeners.get(type)?.({ target } as unknown as Event) }
  const resize = (): void => { windowListeners.get('resize')?.({ target: window } as unknown as Event) }
  return {
    root, list, tick, event, frames, listeners, windowListeners, resize,
    desktop: () => { mobile = false },
    // The dedicated layout writes the band on the shell; the drawer element is
    // inside `[data-pane="sidebar"]` whenever the dedicated layout owns it.
    dedicated: (wide: boolean) => { root.inDrawer = true; root.wideBand = wide ? '1' : '0' },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('sidebar scroll memory', () => {
  it('seeds absolute position and refines it with a keyed anchor rather than row indexes', () => {
    expect(sidebarRestoreTop({ top: 640 })).toBe(640)
    expect(sidebarRestoreTop({ top: 640, offset: -4 }, 700)).toBe(704)
    expect(sidebarRestoreTop({ top: -5 })).toBe(0)
    expect(sidebarRestoreTop({ top: 640, offset: 10 }, 4)).toBe(0)
  })

  it('captures the first actually visible keyed row and its clipped offset', () => {
    const f = fixture(), port = f.list(); port.scrollTop = 647
    expect(captureSidebarScroll(port as unknown as HTMLElement)).toEqual({ top: 647, anchor: 'session:32', offset: -7 })
  })

  it('restores a remounted lower list while preserving outer scroll independently', () => {
    const f = fixture(), port = f.list(), memory = installMobileSidebarScrollMemory()
    memory.sync(); f.tick()
    port.scrollTop = 647; f.root.scrollTop = 45
    f.event('scroll', port); f.event('scroll', f.root)
    f.root.closed = true; memory.sync()
    port.isConnected = false; port.clientHeight = 0; port.scrollTop = 0
    f.event('scroll', port)
    const next = f.list(); f.root.scrollTop = 0; f.root.closed = false
    memory.sync(); f.tick()
    expect(next.scrollTop).toBe(647)
    expect(f.root.scrollTop).toBe(45)
    memory.dispose()
    expect(f.frames.size).toBe(0)
    expect(f.listeners.size).toBe(0)
  })

  it('keeps text-input search positions separate even when the list element is reused', () => {
    const f = fixture(), port = f.list(), memory = installMobileSidebarScrollMemory()
    const search = new FakePort(); f.root.search = search
    memory.sync(); f.tick()
    port.scrollTop = 640; f.event('scroll', port)
    search.value = 'needle'; port.scrollTop = 0
    memory.sync(); f.tick()
    port.scrollTop = 80; f.event('scroll', port)
    search.value = ''; port.scrollTop = 0
    memory.sync(); f.tick()
    expect(port.scrollTop).toBe(640)
    search.value = 'needle'; port.scrollTop = 0
    memory.sync(); f.tick()
    expect(port.scrollTop).toBe(80)
    memory.dispose()
  })

  it('uses the selected mounted row only when there is no saved list position', () => {
    const f = fixture(), port = f.list(true), memory = installMobileSidebarScrollMemory()
    memory.sync(); f.tick()
    expect(port.scrollTop).toBe(660)
    expect(f.root.scrollTop).toBe(0)
    memory.dispose()
  })

  it('does not override user scrolling with current-row fallback on every mutation', () => {
    const f = fixture(), port = f.list(true), memory = installMobileSidebarScrollMemory()
    memory.sync(); f.tick()
    port.scrollTop = 40; f.event('scroll', port)
    memory.sync(); f.tick()
    expect(port.scrollTop).toBe(40)
    memory.dispose()
  })

  it('waits for list geometry and virtual row mounting without forgetting the saved offset', () => {
    const f = fixture(), port = f.list(), memory = installMobileSidebarScrollMemory()
    memory.sync(); f.tick()
    port.scrollTop = 647; f.event('scroll', port)
    f.root.closed = true; memory.sync()
    const next = f.list(); next.scrollHeight = 100; next.rows = []
    f.root.closed = false; memory.sync(); f.tick()
    expect(next.scrollTop).toBe(0)
    next.scrollHeight = 1100; f.tick()
    expect(next.scrollTop).toBe(647)
    memory.dispose()
  })

  it('keeps scroll memory on a landscape phone drawer whose viewport is wider than 720px', () => {
    // 932x430 phone: the stock <=720px band is false, but the dedicated layout
    // renders an overlay drawer because the device short side is 430. A width
    // query would leave the drawer without scroll memory exactly there.
    const f = fixture(), port = f.list(), memory = installMobileSidebarScrollMemory()
    f.desktop(); f.dedicated(false)
    memory.sync(); f.tick()
    port.scrollTop = 647; f.event('scroll', port)
    f.root.closed = true; memory.sync()
    const next = f.list(); f.root.closed = false
    memory.sync(); f.tick()
    expect(next.scrollTop).toBe(647)
    memory.dispose()
  })

  it('keeps the stock list untouched once the layout docks the sidebar', () => {
    const f = fixture(), port = f.list(), memory = installMobileSidebarScrollMemory()
    f.desktop(); f.dedicated(true)
    memory.sync(); f.tick()
    port.scrollTop = 647; f.event('scroll', port)
    f.root.closed = true; memory.sync()
    const next = f.list(); f.root.closed = false
    memory.sync(); f.tick()
    expect(next.scrollTop).toBe(0)
    memory.dispose()
  })

  it('follows the band marker when it changes and ignores resizes that keep it', () => {
    const f = fixture(), port = f.list(), memory = installMobileSidebarScrollMemory()
    f.desktop(); f.dedicated(false)
    memory.sync(); f.tick()
    expect(f.windowListeners.has('resize')).toBe(true)
    port.scrollTop = 647; f.event('scroll', port)
    // A resize that keeps the band leaves the remembered position alone.
    f.resize(); f.tick()
    expect(port.scrollTop).toBe(647)
    // The layout docks the sidebar: the adapter hands the list back to stock.
    f.root.wideBand = '1'
    f.resize(); f.tick()
    f.root.closed = true; memory.sync()
    const next = f.list(); f.root.closed = false
    memory.sync(); f.tick()
    expect(next.scrollTop).toBe(0)
    memory.dispose()
    expect(f.windowListeners.has('resize')).toBe(false)
  })

  it('cancels a pending restore on genuine navigation and keeps desktop untouched', () => {
    const f = fixture(), port = f.list(), memory = installMobileSidebarScrollMemory()
    memory.sync(); f.tick()
    port.scrollTop = 640; f.event('scroll', port)
    f.root.closed = true; memory.sync()
    const next = f.list(); f.root.closed = false; memory.sync()
    f.event('pointerdown', next); next.scrollTop = 20; f.event('scroll', next); f.tick()
    expect(next.scrollTop).toBe(20)
    f.desktop(); memory.sync(); f.tick()
    expect(next.scrollTop).toBe(20)
    memory.dispose()
  })
})
