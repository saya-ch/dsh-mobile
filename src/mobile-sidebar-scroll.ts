import { WIDE_LAYOUT_ATTRIBUTE } from './mobile-layout-attributes.js'

/** Page-local scroll memory for the Workspace consumer, which unmounts on collapse. */
export interface SidebarScrollSnapshot {
  readonly top: number
  readonly anchor?: string
  readonly offset?: number
}

export function sidebarRestoreTop(snapshot: SidebarScrollSnapshot, anchorTop?: number): number {
  return Math.max(0, anchorTop === undefined || snapshot.offset === undefined
    ? snapshot.top : anchorTop - snapshot.offset)
}

const keyedRows = '[data-row-key]'
const hasSuffix = (element: Element, suffix: string): boolean => [...element.classList].some(token => token.endsWith(suffix))

function visible(element: HTMLElement): boolean {
  return element.isConnected && element.clientHeight > 0 && element.getClientRects().length > 0
}

export function captureSidebarScroll(element: HTMLElement): SidebarScrollSnapshot {
  const top = element.scrollTop
  const bounds = element.getBoundingClientRect()
  const row = [...element.querySelectorAll<HTMLElement>(keyedRows)].find(candidate => {
    const rect = candidate.getBoundingClientRect()
    return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom
  })
  return row === undefined ? { top } : {
    top, anchor: row.getAttribute('data-row-key') ?? '',
    offset: row.getBoundingClientRect().top - bounds.top,
  }
}

/**
 * Uses browser scrollports/keyed rows only; no React internals, DOM reordering,
 * forced group expansion or persistent storage of session identities. Absolute
 * position seeds a virtual window before a mounted keyed anchor refines it.
 */
export function installMobileSidebarScrollMemory(): { sync: () => void; dispose: () => void } {
  const memories = new Map<string, SidebarScrollSnapshot>()
  const stockViewport = window.matchMedia('(max-width:720px)')
  /**
   * Whether the dedicated layout currently renders the sidebar as an overlay
   * drawer. That is the layout's own decision on the shell — a landscape phone
   * is an overlay there although its viewport is wide — so a width query would
   * disable this memory exactly where the drawer is hardest to reach.
   */
  const drawerBand = (): boolean => {
    const shell = document.querySelector('.dshm-shell')
    return shell === null || shell.getAttribute(WIDE_LAYOUT_ATTRIBUTE) !== '1'
  }
  let root: HTMLElement | undefined
  let open = false
  let ports = new Map<HTMLElement, string>()
  let pending = new Map<HTMLElement, { snapshot: SidebarScrollSnapshot | undefined; stable: number }>()
  let frame = 0
  let deadline = 0
  let disposed = false

  const isOpen = (): boolean => root !== undefined && visible(root)
    && !hasSuffix(root, '_collapsed')
    && root.closest('[data-open="false"]') === null
    && root.querySelector('[data-dsh-mobile-settings]') === null
  const cancel = (): void => {
    if (frame !== 0) cancelAnimationFrame(frame)
    frame = 0
    pending.clear()
  }
  const remember = (): void => {
    if (!open || !isOpen()) return
    for (const [port, key] of ports) {
      if (!pending.has(port) && visible(port)) memories.set(key, port === root ? { top: port.scrollTop } : captureSidebarScroll(port))
    }
  }
  const restore = (): void => {
    frame = 0
    if (disposed || !open || !isOpen()) return
    for (const [port, state] of pending) {
      if (!visible(port)) continue
      const snapshot = state.snapshot
      if (snapshot === undefined) {
        if (port === root) { pending.delete(port); continue }
        // A mounted current row is a safe fallback. Hidden/collapsed groups and
        // off-window virtual rows are not expanded/searched by this adapter.
        const selected = port.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]')
        if (selected !== null && visible(selected)) {
          const bounds = port.getBoundingClientRect(), rect = selected.getBoundingClientRect()
          if (rect.top < bounds.top || rect.bottom > bounds.bottom) port.scrollTop += rect.top - bounds.top - (port.clientHeight - rect.height) / 2
          pending.delete(port)
        } else if (port.querySelector(keyedRows) !== null) pending.delete(port)
        continue
      }
      const anchor = [...port.querySelectorAll<HTMLElement>(keyedRows)].find(row => row.dataset.rowKey === snapshot.anchor)
      const anchorTop = anchor === undefined ? undefined
        : port.scrollTop + anchor.getBoundingClientRect().top - port.getBoundingClientRect().top
      const target = sidebarRestoreTop(snapshot, anchorTop)
      const before = port.scrollTop
      port.scrollTop = target
      // Wait for virtual-window rendering / asynchronous list geometry. Do not
      // replace a remembered lower position with a temporarily clamped zero.
      if (Math.abs(port.scrollTop - target) <= 1 && Math.abs(before - port.scrollTop) <= 1) state.stable++
      else state.stable = 0
      if (state.stable >= 2) pending.delete(port)
    }
    if (pending.size > 0 && performance.now() < deadline) frame = requestAnimationFrame(restore)
    else pending.clear()
  }
  const sync = (): void => {
    if (disposed) return
    const next = document.querySelector<HTMLElement>('[data-dsh-mobile-sidebar-root]') ?? undefined
    const mobile = next?.closest('[data-pane="sidebar"]') != null
      ? drawerBand() : stockViewport.matches
    if (next !== root) { cancel(); ports.clear(); root = next; open = false }
    const nextOpen = mobile && isOpen()
    if (!nextOpen) { cancel(); open = false; ports.clear(); return }
    const reopening = !open
    open = true
    if (root === undefined) return
    // Match the actual Workspace list, not panels/footer lists. The outer
    // root can scroll independently in short drawers and owns separate memory.
    const candidates = [root, ...root.querySelectorAll<HTMLElement>('[class*="_regionArea"] [class*="_list"]')]
      .filter(port => port === root || hasSuffix(port, '_list'))
    const nextPorts = new Map<HTMLElement, string>()
    for (const port of candidates) {
      const key = port === root ? 'outer' : `workspace:${[...port.classList].sort().join(' ')}:${root.querySelector<HTMLInputElement>('[class*="_regionArea"] input')?.value ?? ''}`
      nextPorts.set(port, key)
      if (reopening || ports.get(port) !== key) {
        pending.set(port, { snapshot: memories.get(key), stable: 0 })
        deadline = performance.now() + 1200
      }
    }
    for (const port of pending.keys()) if (!nextPorts.has(port)) pending.delete(port)
    ports = nextPorts
    if (pending.size > 0 && frame === 0) frame = requestAnimationFrame(restore)
  }
  const onScroll = (event: Event): void => {
    const port = event.target
    if (!(port instanceof HTMLElement) || !open || !isOpen() || pending.has(port) || !visible(port)) return
    const key = ports.get(port)
    if (key !== undefined) memories.set(key, port === root ? { top: port.scrollTop } : captureSidebarScroll(port))
  }
  const onIntent = (event: Event): void => {
    if (!(event.target instanceof Node) || !root?.contains(event.target)) return
    // Capture before the upstream handler unmounts the list; genuine user input
    // also wins over an unfinished restoration.
    cancel()
    remember()
  }
  stockViewport.addEventListener('change', sync)
  document.addEventListener('scroll', onScroll, true)
  for (const type of ['pointerdown', 'touchstart', 'wheel', 'keydown', 'click']) document.addEventListener(type, onIntent, true)
  return {
    sync,
    dispose: () => {
      disposed = true
      cancel()
      stockViewport.removeEventListener('change', sync)
      document.removeEventListener('scroll', onScroll, true)
      for (const type of ['pointerdown', 'touchstart', 'wheel', 'keydown', 'click']) document.removeEventListener(type, onIntent, true)
      ports.clear(); memories.clear(); root = undefined
    },
  }
}
