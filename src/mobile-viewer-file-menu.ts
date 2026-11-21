import { browserHandoff, parseViewerAddress, readViewerFile, type ShareStage, type ViewerStat } from './mobile-viewer-file-share.js'
import type { ViewerNativeSendResult } from './mobile-viewer-native-share.js'

interface Source<T> { getSnapshot(): T; subscribe(fn: () => void): () => void }
interface Target { navigationRevision?: number; occurrence?: { signal: AbortSignal; navigation: Source<{ address: string; revision: number }> } }
export interface ViewerServices {
  sidebarRight: { focusedTarget(node: Element): Target | undefined; isTargetCurrent(target: Target): boolean; mounted: Source<unknown> }
  remote: { workspaceFiles: { stat(session: string, path: string, signal: AbortSignal): Promise<{ ok: boolean; value?: ViewerStat }> } }
  connection: { state: Source<string | undefined> }
}
export interface ViewerMenuLabels { copy: string; share: string; ready: string; reading: string; sharing: string; failed: string; size: string }

/** Optional negotiated native bridge handoff; replaces Web Share inside the App WebView. */
export interface ViewerNativeHandoff {
  enabled(): boolean
  send(file: File, current: () => boolean, signal: AbortSignal): Promise<ViewerNativeSendResult>
}

type Viewport = Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>
type Edges = Pick<DOMRectReadOnly, 'left' | 'right' | 'top' | 'bottom'>
type Bar = Pick<DOMRectReadOnly, 'left' | 'bottom' | 'width'>

/** Coordinates are in the layout viewport; viewport bounds already exclude safe-area insets. */
export function placeMenu(bar: Bar, viewport: Viewport, panelHeight: number, controls: readonly Edges[] = []) {
  const width = Math.min(bar.width, viewport.width)
  const left = Math.max(viewport.left, Math.min(bar.left, viewport.left + viewport.width - width))
  const top = Math.max(viewport.top, bar.bottom + 8)
  const bottom = viewport.top + viewport.height
  const overlapsControl = controls.some(c => c.left < left + width && c.right > left && c.top < top + panelHeight && c.bottom > top)
  if (top + panelHeight <= bottom && !overlapsControl) return { mode: 'dropdown' as const, left, top, width }
  return { mode: 'sheet' as const, left: viewport.left, bottom, width: viewport.width }
}

function positionMenu(dialog: HTMLDialogElement, owner: Element) {
  const visual = window.visualViewport
  const style = getComputedStyle(dialog)
  const inset = (edge: string) => Number.parseFloat(style.getPropertyValue(`--dsh-mobile-menu-safe-${edge}`)) || 0
  const viewport = {
    left: (visual?.offsetLeft ?? 0) + inset('left'),
    top: (visual?.offsetTop ?? 0) + inset('top'),
    width: Math.max(0, (visual?.width ?? window.innerWidth) - inset('left') - inset('right')),
    height: Math.max(0, (visual?.height ?? window.innerHeight) - inset('top') - inset('bottom')),
  }
  const bar = owner.getBoundingClientRect()
  // Measure wrapping at the dropdown width, even when currently presented as a sheet.
  dialog.style.width = `${Math.min(bar.width, viewport.width)}px`
  dialog.style.maxHeight = `${viewport.height}px`
  const height = dialog.getBoundingClientRect().height
  // Only the nearby preview header controls can collide with the path dropdown.
  const controls = [...owner.parentElement?.querySelectorAll('button, a[href], [role="button"]') ?? []]
    .filter(el => el !== owner && !owner.contains(el) && el.getClientRects().length && getComputedStyle(el).visibility === 'visible')
    .map(el => el.getBoundingClientRect())
  const placement = placeMenu(bar, viewport, height, controls)
  dialog.style.left = `${placement.left}px`
  dialog.style.top = `${placement.mode === 'dropdown' ? placement.top : placement.bottom}px`
  dialog.style.width = `${placement.width}px`
  dialog.style.transform = placement.mode === 'sheet' ? 'translateY(-100%)' : ''
}

/** Install nothing in the header. The existing delegated handler asks this menu to take ownership. */
export function viewerMenu(getServices: () => ViewerServices | undefined, labels: ViewerMenuLabels, native?: ViewerNativeHandoff) {
  let retire: (() => void) | undefined
  function browserCanShareFiles(): boolean {
    try { return navigator.canShare({ files: [new File([], 'test.txt', { type: 'text/plain' })] }) } catch { return false }
  }
  function open(owner: Element, copy: () => void): boolean {
    let close = () => {}
    try {
      const ctx = getServices()
      const viaNative = native?.enabled() === true
      if (!ctx || !window.isSecureContext || (!viaNative && window.__DSH_MOBILE_NATIVE__)
        || (!viaNative && (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function' || !browserCanShareFiles()))
        || typeof HTMLDialogElement === 'undefined' || typeof HTMLDialogElement.prototype.showModal !== 'function') return false
      if (typeof ctx.sidebarRight?.focusedTarget !== 'function' || typeof ctx.sidebarRight.isTargetCurrent !== 'function') return false
      const target = ctx.sidebarRight.focusedTarget(owner)
      const held = target, occ = held?.occurrence, nav = occ?.navigation?.getSnapshot?.()
      const file = nav && parseViewerAddress(nav.address)
      if (!held || !occ || !nav || !file || held.navigationRevision !== nav.revision || !ctx.connection?.state) return false
      const current = () => {
        try {
          return getServices() === ctx && owner.isConnected && !occ.signal.aborted && ctx.connection.state.getSnapshot() === 'connected' && ctx.sidebarRight.isTargetCurrent(held) && owner.getClientRects().length > 0 && getComputedStyle(owner).visibility === 'visible' && ctx.sidebarRight.focusedTarget(owner)?.occurrence === occ
        } catch {
          return false
        }
      }
      if (!current()) return false
      retire?.()
      const dialog = document.createElement('dialog'), choices = document.createElement('div'), status = document.createElement('div')
      dialog.className = 'dsh-mobile-viewer-file-menu'; dialog.setAttribute('aria-label', owner.getAttribute('title') || file.path)
      const button = (text: string) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; choices.append(b); return b }
      const cp = button(labels.copy), share = button(labels.share)
      status.setAttribute('role', 'status'); choices.append(status); dialog.append(choices)
      const lifetime = new AbortController(), { signal } = lifetime
      const readFile = (s: AbortSignal) => readViewerFile(file, s, async (address, abort) => {
        const result = await ctx.remote.workspaceFiles.stat(address.sessionId, address.path, abort)
        if (!result.ok || !result.value || !current()) throw Error('read')
        return result.value
      }, window.fetch.bind(window))
      const show = (stage: ShareStage) => {
        share.disabled = stage === 'reading' || stage === 'sharing'; share.textContent = stage === 'ready' ? labels.ready : labels.share
        status.textContent = labels[stage]; if (stage === 'ready') share.focus()
      }
      let nativeBusy = false
      let off = () => {}, observer: MutationObserver | undefined
      const hand = browserHandoff({
        current, active: () => navigator.userActivation?.isActive === true,
        canShare: f => navigator.canShare({ files: [f] }), share: f => navigator.share({ files: [f] }),
        read: s => readFile(s),
        state: show, done: () => close(),
      })
      close = () => {
        if (signal.aborted) return
        lifetime.abort(); off(); observer?.disconnect(); hand.dispose(); retire = undefined
        try { dialog.close() } catch {}
        dialog.remove()
        if (current() && owner instanceof HTMLElement) owner.focus({ preventScroll: true })
      }
      async function nativeChoose() {
        if (nativeBusy) return
        nativeBusy = true
        try {
          show('reading')
          const prepared = await readFile(signal)
          if (!current()) { close(); return }
          show('sharing')
          const result = await native!.send(prepared, current, signal)
          if (!current()) { close(); return }
          if (result === 'shared') close()
          else if (result === 'cancelled' || result === 'stale' || result === 'unsupported') close()
          else show(result === 'too-large' ? 'size' : 'failed')
        } catch {
          if (current()) show('failed')
        } finally { nativeBusy = false }
      }
      // Reflow shares the staleness check; a current file only moves the open dialog.
      let frame = 0
      const run = () => {
        frame = 0
        if (!current()) close()
        else positionMenu(dialog, owner)
      }
      const schedule = () => { if (frame === 0 && !signal.aborted) frame = requestAnimationFrame(run) }
      const unsub = [ctx.connection.state.subscribe(schedule), ctx.sidebarRight.mounted.subscribe(schedule), occ.navigation.subscribe(schedule)]
      off = () => { unsub.forEach(fn => fn()); if (frame !== 0) cancelAnimationFrame(frame); frame = 0 }
      occ.signal.addEventListener('abort', close, { once: true, signal }); window.addEventListener('pagehide', close, {signal}); window.addEventListener('offline', close, {signal})
      window.addEventListener('scroll', schedule, { capture: true, passive: true, signal })
      window.addEventListener('resize', schedule, { signal })
      window.addEventListener('orientationchange', schedule, { signal })
      window.visualViewport?.addEventListener('scroll', schedule, { passive: true, signal })
      window.visualViewport?.addEventListener('resize', schedule, { signal })
      observer = new MutationObserver(records => {
        // Our own position writes must not schedule themselves for another frame.
        if (records.some(record => record.target !== dialog || record.attributeName !== 'style')) schedule()
      }); observer.observe(document.body, { subtree:true, childList:true, attributes:true, attributeFilter:['hidden','aria-hidden','class','style'] })
      cp.onclick = () => { if (current()) copy(); close() }; share.onclick = () => { if (!current()) { close(); return } if (viaNative) void nativeChoose(); else void hand.choose() }
      dialog.oncancel = e => { e.preventDefault(); close() }; dialog.onclick = e => { if (e.target === dialog) close() }
      const back = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); close() }; window.addEventListener('dsh-mobile:native-back', back, { capture:true, signal })
      retire = close; document.body.append(dialog)
      dialog.showModal()
      positionMenu(dialog, owner)
      cp.focus(); return true
    } catch {
      close()
      return false
    }
  }
  return { open, dispose: () => retire?.() }
}
