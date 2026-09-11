import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { MOBILE_LAYOUT_MESSAGES, type MobileLayoutLanguage } from './mobile-layout-messages.js'

export { MOBILE_LAYOUT_MESSAGES } from './mobile-layout-messages.js'
export type { MobileLayoutLanguage } from './mobile-layout-messages.js'

interface SessionState {
  readonly current?: string
  readonly byId: Readonly<Record<string, { readonly blank?: boolean; readonly title?: string } | undefined>>
}

interface MobileRootProps {
  readonly renderSlot: (
    name: string,
    owner: Record<string, unknown>,
    options?: { readonly entryKey?: string | null; readonly fallback?: ReactNode },
  ) => ReactNode
  readonly useSessions: <T>(selector: (state: SessionState) => T) => T
}

/** Root contribution carrying one observable hook into the standard kit. */
interface RootHookContribution {
  readonly hooks: Readonly<Record<string, {
    readonly getSnapshot: () => unknown
    readonly subscribe: (listener: () => void) => () => void
  }>>
}

interface MobileClientContext {
  readonly effect: (effect: () => void | (() => void), label?: string) => void
  readonly on: (event: string, listener: (value: ThemeSnapshot) => void) => () => void
  readonly reflect: { provide: (name: string, value: unknown) => () => void | Promise<void> }
  readonly slots: {
    register: (options: Record<string, unknown>, component: (props: MobileRootProps) => ReactNode) => () => void
    entries: (name: string) => readonly { readonly options: { readonly key?: string } }[]
    subscribe: (name: string, listener: () => void) => () => void
    /**
     * Publish a root standard hook. The official layout owns `panelInfo`, so
     * replacing that module means replacing the owner too.
     */
    provideRoot?: (contribution: RootHookContribution) => () => void
  }
  readonly theme: { getTheme: () => ThemeSnapshot }
}

interface ThemeSnapshot {
  readonly active: {
    readonly colorScheme: 'dark' | 'light'
    readonly tokens: Readonly<Record<string, string>>
  }
}

interface LayoutSnapshot {
  readonly sidebarOpen: boolean
  readonly detailsOpen: boolean
  readonly panelInfo: PanelInfoSnapshot
}

/**
 * Panel selection as the standard `usePanelInfo` hook reports it: a null
 * `activePanelId` means the conversation owns the center column.
 */
interface PanelInfoSnapshot {
  readonly activePanelId: string | null
}

/**
 * Viewport width at which the dedicated layout treats the sidebar as a
 * persistent desktop panel instead of an overlay drawer. Narrow screens
 * keep the overlay behavior byte-for-byte.
 */
export const WIDE_LAYOUT_MIN_WIDTH_PX = 900

export function isWideViewportLayout(viewportWidth: number): boolean {
  return viewportWidth >= WIDE_LAYOUT_MIN_WIDTH_PX
}

/** Reads the live viewport; unknown environments (SSR, tests) stay narrow. */
function viewportIsWide(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(`(min-width: ${WIDE_LAYOUT_MIN_WIDTH_PX}px)`).matches
}

/** Resolve the supported language used by the dedicated mobile layout. */
export function resolveMobileLayoutLanguage(
  documentLanguage: string,
  browserLanguages: readonly string[],
): MobileLayoutLanguage {
  return [documentLanguage, ...browserLanguages]
    .map(value => value.trim().toLowerCase().split(/[-_]/u)[0])
    .find((value): value is MobileLayoutLanguage => value === 'it' || value === 'en' || value === 'zh') ?? 'en'
}

class MobileLayoutController {
  // Wide viewports start with the persistent sidebar open; applying the
  // layout again (reconnect, refocus) reuses the module singleton below,
  // so an explicit user collapse is never reset.
  private snapshot: LayoutSnapshot = Object.freeze({
    sidebarOpen: viewportIsWide(),
    detailsOpen: false,
    panelInfo: Object.freeze({ activePanelId: null }),
  })
  private readonly listeners = new Set<() => void>()
  private hasMainPanel: ((id: string) => boolean) | undefined
  // Pending workspace/session navigation, cancelled whenever a newer one
  // starts. Mirrors the official LayoutController's navigation controller.
  private navigation = new AbortController()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): LayoutSnapshot => this.snapshot

  toggleSidebar(): void {
    this.update({ sidebarOpen: !this.snapshot.sidebarOpen })
  }

  openDetails(): void {
    this.update({ detailsOpen: true })
  }

  closeDetails(): void {
    this.update({ detailsOpen: false })
  }

  closeSidebar(): void {
    this.update({ sidebarOpen: false })
  }

  /**
   * Invalidate the previous navigation and hand back a fresh signal. The
   * workspace controller wraps this around "open a workspace" and "fork a
   * session" (dsh-client-ui-workspace) — the path behind the sidebar's
   * new-session button. Without it startSession throws inside a
   * `.catch(reason => console.warn('new session failed:', reason))`, so the
   * button silently did nothing.
   */
  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }

  /** Invalidate pending navigations when this layout unloads. */
  dispose(): void {
    this.navigation.abort()
  }

  /** Bind panel validation to the live slot registry owned by this application. */
  bindMainPanelRegistry(hasMainPanel: (id: string) => boolean): () => void {
    this.hasMainPanel = hasMainPanel
    return () => {
      if (this.hasMainPanel === hasMainPanel) this.hasMainPanel = undefined
    }
  }

  /**
   * Show the right panel. The official controller tracks a persistent column
   * here; this layout always renders the panel as the details overlay, so both
   * the track and fullscreen requests open the same drawer.
   */
  openRightbar(_track?: boolean, _fullscreen?: boolean): void {
    this.openDetails()
  }

  /** Hide the right panel. */
  closeRightbar(): void {
    this.closeDetails()
  }

  /**
   * Select the main panel rendered in the center column; null means the
   * conversation. Mirrors the official LayoutController so the `panelInfo`
   * root hook stays truthful.
   */
  selectPanel(panelId: string | null): void {
    if (panelId !== null && this.hasMainPanel?.(panelId) !== true) {
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    }
    this.navigation.abort()
    if (this.snapshot.panelInfo.activePanelId === panelId) return
    this.update({ panelInfo: Object.freeze({ activePanelId: panelId }) })
  }

  /** Drop a selected panel once no main-slot entry declares it. */
  retainMainPanels(panelIds: readonly string[]): void {
    const active = this.snapshot.panelInfo.activePanelId
    if (active !== null && !panelIds.includes(active)) {
      this.update({ panelInfo: Object.freeze({ activePanelId: null }) })
    }
  }

  private update(next: Partial<LayoutSnapshot>): void {
    const snapshot = Object.freeze({ ...this.snapshot, ...next })
    if (
      snapshot.sidebarOpen === this.snapshot.sidebarOpen
      && snapshot.detailsOpen === this.snapshot.detailsOpen
      && snapshot.panelInfo === this.snapshot.panelInfo
    ) return
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

class ThemePresenter {
  private appliedTokens: string[] = []
  private readonly meta = document.createElement('meta')

  constructor() {
    this.meta.name = 'theme-color'
  }

  apply(snapshot: ThemeSnapshot): void {
    const scheme = snapshot.active.colorScheme
    document.documentElement.style.colorScheme = scheme
    document.body.toggleAttribute('data-ds-dark-theme', scheme === 'dark')
    for (const name of this.appliedTokens) document.body.style.removeProperty(name)
    this.appliedTokens = []
    for (const [name, value] of Object.entries(snapshot.active.tokens)) {
      document.body.style.setProperty(name, value)
      this.appliedTokens.push(name)
    }
    this.meta.content = getComputedStyle(document.body).backgroundColor
    if (!this.meta.isConnected) document.head.append(this.meta)
  }

  dispose(): void {
    document.documentElement.style.removeProperty('color-scheme')
    document.body.removeAttribute('data-ds-dark-theme')
    for (const name of this.appliedTokens) document.body.style.removeProperty(name)
    this.meta.remove()
  }
}

export const MOBILE_LAYOUT_STYLES = `
html,body,#root{width:100%;height:100%;overflow:hidden}
.dshm-shell{position:relative;display:grid;width:100%;height:100dvh;min-width:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)}
.dshm-main{grid-area:1/1;min-width:0;min-height:0;overflow:hidden}
.dshm-main>*,.dshm-main>*>*{min-width:0}
.dshm-drawer{position:fixed;z-index:70;inset:0 auto 0 0;box-sizing:border-box;width:56px;max-width:100%;padding-top:env(safe-area-inset-top);overflow:hidden;background:var(--dsw-alias-bg-layer-1,#f8fafc);box-shadow:none;will-change:width;transition:width 240ms cubic-bezier(.22,1,.36,1),box-shadow 240ms ease}
.dshm-drawer[data-open=true]{width:min(88vw,340px);box-shadow:18px 0 46px rgb(15 23 42 / 18%)}
.dshm-drawer[data-open=false]{pointer-events:auto;visibility:visible}
.dshm-drawer>*{width:100%!important;height:100%!important;transform:translateX(-6px);opacity:.94;transition:transform 220ms cubic-bezier(.22,1,.36,1),opacity 160ms ease-out}
.dshm-drawer[data-open=true]>*{transform:translateX(0);opacity:1}
.dshm-drawer[data-open=false]>*{width:56px!important}
.dshm-details{position:fixed;z-index:80;inset:0 0 0 auto;box-sizing:border-box;width:min(94vw,460px);max-width:100%;padding-top:env(safe-area-inset-top);overflow:hidden;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:-18px 0 46px rgb(15 23 42 / 18%);transform:translateX(104%);transition:transform 190ms cubic-bezier(.22,1,.36,1)}
.dshm-details[data-open=true]{transform:translateX(0)}
.dshm-details[data-open=false]{pointer-events:none;visibility:hidden;transition:transform 190ms cubic-bezier(.22,1,.36,1),visibility 0s linear 190ms}
.dshm-scrim{position:fixed;z-index:65;inset:0;border:0;background:rgb(15 23 42 / 40%);opacity:0;pointer-events:none;transition:opacity 180ms ease-out}
.dshm-scrim[data-open=true]{opacity:1;pointer-events:auto}
.dshm-overlay{position:fixed;z-index:90;inset:0;pointer-events:none}.dshm-overlay>*{pointer-events:auto}
.dshm-shell header{min-width:0;padding-left:52px}
.dshm-shell textarea{font-size:16px}
.dshm-shell table{display:block;max-width:100%;overflow-x:auto}
.dshm-shell pre{max-width:100%;overflow-x:auto}
.dshm-shell img,.dshm-shell video,.dshm-shell canvas,.dshm-shell svg{max-width:100%}
.dshm-shell [data-disclosure-row]{min-width:0;max-width:100%}
.dshm-shell [data-disclosure-row]>*{min-width:0;overflow-wrap:anywhere}
.dshm-shell [data-context-fields]>*{min-width:0}
.dshm-shell [class*="_body"]{max-width:100%;overflow-wrap:anywhere}
.dshm-shell [data-question-key],.dshm-shell [data-plan-review-key]{box-sizing:border-box;width:100%;height:auto!important;min-width:0;flex:none!important;align-self:flex-end;padding:6px max(10px,env(safe-area-inset-left)) max(10px,env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-right))!important}
.dshm-shell [data-question-key]>section,.dshm-shell [data-plan-review-key]>section{width:100%;height:auto!important;min-height:0!important;max-width:none!important;max-height:min(68dvh,520px)!important;border-radius:16px!important}
.dshm-shell [data-question-scroll],.dshm-shell [data-plan-review-scroll]{flex:0 1 auto!important;min-height:0!important;max-height:min(42dvh,360px)!important;overscroll-behavior:contain;scroll-padding-bottom:12px}
@media(max-width:420px){.dshm-shell [data-context-fields]>*{display:grid;grid-template-columns:1fr!important;gap:4px}.dshm-shell [class*="_ioSection"]{grid-template-columns:1fr!important}}
@media(max-width:600px){
.dshm-shell [data-question-key]>section>header{display:flex!important;visibility:visible!important;flex:none!important;gap:8px!important;padding:12px 8px 4px 14px!important}
.dshm-shell [data-question-key]>section>header h2{min-width:0;overflow-wrap:anywhere;font-size:16px!important;line-height:22px!important}
.dshm-shell [data-question-key]>section>header button{min-width:40px;min-height:40px}
.dshm-shell [data-question-key] [role=radio],.dshm-shell [data-question-key] [role=checkbox]{min-height:48px!important;touch-action:manipulation}
.dshm-shell [data-question-key]>section>footer{display:grid!important;grid-template-columns:auto minmax(0,1fr);align-items:center!important;flex:none!important;gap:6px 8px!important;margin-top:4px!important;padding:6px 10px 10px!important}
.dshm-shell [data-question-key]>section>footer>:last-child{grid-column:1/-1;display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));width:100%;gap:8px!important}
.dshm-shell [data-question-key]>section>footer>:last-child button{width:100%;min-height:44px}
.dshm-shell [data-plan-review-key]>section>div:last-child{display:grid!important;grid-template-columns:1fr;gap:8px!important;padding:8px 12px 10px!important}
.dshm-shell [data-plan-review-key]>section>div:last-child>div:last-child{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr));width:100%;gap:8px!important}
.dshm-shell [data-plan-review-key]>section>div:last-child>div:last-child>button:first-child{grid-column:1/-1}
.dshm-shell [data-plan-review-key]>section>div:last-child button{width:100%;min-height:44px}
}
@media(min-width:900px){
.dshm-shell{grid-template-columns:auto minmax(0,1fr)}
.dshm-main{grid-area:1/2}
.dshm-drawer{position:static;grid-area:1/1;box-shadow:none}
.dshm-drawer[data-open=true]{width:340px;box-shadow:none}
.dshm-drawer[data-open=false]{width:56px}
}
@media(prefers-reduced-motion:reduce){.dshm-drawer,.dshm-details,.dshm-scrim,.dshm-drawer>*{transition:none!important}}
`

function MobileAppFrame(props: MobileRootProps & { readonly controller: MobileLayoutController }): ReactNode {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot)
  const suppressKeyboardUntil = useRef(0)
  const [wideViewport, setWideViewport] = useState(viewportIsWide)
  const [documentLanguage, setDocumentLanguage] = useState(document.documentElement.lang)
  const browserLanguages = navigator.languages.length > 0 ? navigator.languages : [navigator.language]
  const language = resolveMobileLayoutLanguage(documentLanguage, browserLanguages)
  const messages = MOBILE_LAYOUT_MESSAGES[language]
  const activeSessionId = props.useSessions(session => {
    const current = session.current
    return current !== undefined && session.byId[current]?.blank === false ? current : undefined
  })
  const hasSession = activeSessionId !== undefined

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(`(min-width: ${WIDE_LAYOUT_MIN_WIDTH_PX}px)`)
    const syncViewport = (): void => { setWideViewport(query.matches) }
    syncViewport()
    query.addEventListener('change', syncViewport)
    return () => { query.removeEventListener('change', syncViewport) }
  }, [])

  useEffect(() => {
    const observer = new MutationObserver(() => { setDocumentLanguage(document.documentElement.lang) })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
    return () => { observer.disconnect() }
  }, [])

  useEffect(() => {
    if (!hasSession) props.controller.closeDetails()
  }, [hasSession, props.controller])

  // Mirror the stock layout: project the current session title into the
  // browser tab, restoring the product title when no session is selected.
  const sessionTitle = props.useSessions(session =>
    session.current === undefined ? undefined : session.byId[session.current]?.title,
  )
  useEffect(() => {
    const productTitle = document.title
    if (sessionTitle !== undefined) document.title = `${sessionTitle} — ${productTitle}`
    return () => { document.title = productTitle }
  }, [sessionTitle])

  useEffect(() => {
    const suppressAutofocus = (event: FocusEvent): void => {
      if (performance.now() >= suppressKeyboardUntil.current) return
      const target = event.target
      if (target instanceof HTMLElement && (target.matches('input,textarea') || target.isContentEditable)) target.blur()
    }
    const suppressBranchAutofocus = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return
      const branch = event.target.closest('button[aria-label*="分支"],button[aria-label*="Branch"],button[aria-label*="branch"],button[aria-label*="Ramo"],button[aria-label*="ramo"]')
      if (branch === null || branch.hasAttribute('disabled') || branch.getAttribute('aria-disabled') === 'true') return
      suppressKeyboardUntil.current = performance.now() + 700
      window.setTimeout(() => {
        const active = document.activeElement
        if (active instanceof HTMLElement && (active.matches('input,textarea') || active.isContentEditable)) active.blur()
      }, 0)
    }
    const suppressCommandAutofocus = (event: MouseEvent): void => {
      if (!(event.target instanceof Element)) return
      const commandButton = event.target.closest('button[aria-haspopup="listbox"]')
      if (commandButton === null) return
      // The native composer deliberately preserves editor focus on mousedown;
      // mobile command menus should open without summoning the soft keyboard.
      suppressKeyboardUntil.current = performance.now() + 700
      event.preventDefault()
      event.stopPropagation()
      window.setTimeout(() => {
        const active = document.activeElement
        if (active instanceof HTMLElement && (active.matches('input,textarea') || active.isContentEditable)) active.blur()
      }, 0)
    }
    document.addEventListener('focusin', suppressAutofocus, true)
    document.addEventListener('click', suppressBranchAutofocus, true)
    document.addEventListener('mousedown', suppressCommandAutofocus, true)
    return () => {
      document.removeEventListener('focusin', suppressAutofocus, true)
      document.removeEventListener('click', suppressBranchAutofocus, true)
      document.removeEventListener('mousedown', suppressCommandAutofocus, true)
    }
  }, [])

  // A persistent wide sidebar stays put: selecting a session only dismisses
  // the narrow overlay drawer (and its soft-keyboard suppression).
  const closeDrawerAfterSessionAction = (event: { readonly target: EventTarget | null }): void => {
    if (viewportIsWide()) return
    if (!(event.target instanceof Element)) return
    const row = event.target.closest<HTMLElement>('[role="treeitem"][aria-selected]')
    const action = event.target.closest('button,[role="button"]')
    const startsSession = action?.matches('button[class*="_newSession"],button[class*="_brand"]')
      || /新建会话|新会话|new session|new conversation|nuova sessione|nuova conversazione/i.test(action?.getAttribute('aria-label') ?? '')
    if (row === null && !startsSession) return
    if (row !== null && action !== null && action !== row) return
    suppressKeyboardUntil.current = performance.now() + 500
    // Let the session row finish its own click handler before unmounting the drawer.
    window.setTimeout(() => {
      props.controller.closeSidebar()
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur()
    }, 0)
  }

  return createElement('div', { className: 'dshm-shell', lang: language },
    createElement('main', { className: 'dshm-main', 'data-dsh-mobile-session': activeSessionId },
      props.renderSlot('main', {}, {
        entryKey: state.panelInfo.activePanelId ?? 'conversation',
        fallback: props.renderSlot('conversation', {}),
      })),
    createElement('button', {
      'aria-label': messages.closePanels,
      className: 'dshm-scrim',
      // A persistent wide sidebar needs no dimming; the scrim only covers
      // the narrow overlay drawer and the details panel.
      'data-open': state.detailsOpen || (state.sidebarOpen && !wideViewport),
      onClick: () => { state.detailsOpen ? props.controller.closeDetails() : props.controller.closeSidebar() },
      tabIndex: state.sidebarOpen || state.detailsOpen ? 0 : -1,
      type: 'button',
    }),
    createElement('aside', {
      'aria-label': messages.workspaceNavigation,
      className: 'dshm-drawer',
      'data-open': state.sidebarOpen,
      onClickCapture: closeDrawerAfterSessionAction,
    }, props.renderSlot('sidebar', {
      collapsed: !state.sidebarOpen,
      width: state.sidebarOpen ? 340 : 56,
    })),
    createElement('aside', {
      'aria-hidden': !state.detailsOpen,
      className: 'dshm-details',
      'data-open': state.detailsOpen,
      ...(state.detailsOpen ? {} : { inert: '' }),
    }, [
      // DSH 0.1.3 and earlier bind details to a Session. Newer DSH owns the
      // Session decision inside its root-scoped rightbar occupant, so that
      // occupant must stay mounted even while no Session is selected.
      hasSession ? props.renderSlot('details', {}) : undefined,
      props.renderSlot('rightbar', {
        width: Math.min(window.innerWidth * 0.94, 460),
        viewportWidth: window.innerWidth,
        // The official frame reports whether a persistent column still fits
        // (normal.rightbar > 0); this layout renders the right panel in the
        // details overlay, which needs no column space. Reporting false would
        // make RightbarSeat force the surface closed immediately after opening
        // it (ui-sidebar-right: `shown && !fullscreen && !canShow` ->
        // actions.setExpanded(false)), so the panel could never stay open on a
        // phone-width viewport.
        canShow: true,
      }),
    ]),
    createElement('div', { className: 'dshm-overlay', 'data-shell-overlay': true }, props.renderSlot('shell.overlay', {})),
  )
}

// One controller per document: re-applying the layout (reconnect, tab
// refocus) must not reset the user's explicit sidebar toggle.
let sharedController: MobileLayoutController | undefined

/** Replace the desktop layout module on the authenticated mobile surface. */
export function apply(ctx: MobileClientContext): void {
  sharedController ??= new MobileLayoutController()
  const controller = sharedController
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-mobile-layout'
    style.textContent = MOBILE_LAYOUT_STYLES
    document.head.append(style)
    const disposeMainPanelRegistry = controller.bindMainPanelRegistry(id =>
      ctx.slots.entries('main').some(entry => entry.options.key === id))
    const disposeService = ctx.reflect.provide('layout', controller)
    // The official layout owns the root `panelInfo` hook; replacing the layout
    // module means replacing that owner. Without it every registration that
    // declares the standard `usePanelInfo` prop fails assembly
    // ("strict standard hook 'panelInfo' has no source") and renders as a dead
    // cell — the workspace sidebar's session list lives exactly there.
    const disposePanelInfo = typeof ctx.slots.provideRoot === 'function'
      ? ctx.slots.provideRoot({ hooks: { panelInfo: {
          getSnapshot: () => controller.getSnapshot().panelInfo,
          subscribe: (listener: () => void) => controller.subscribe(listener),
        } } })
      : () => {}
    const disposeRoot = ctx.slots.register({
      name: 'root',
      children: {
        sidebar: { kind: 'single', scope: 'root' },
        conversation: { kind: 'single', scope: 'session-maybe' },
        // The conversation panel moved into this keyed slot in DSH 0.1.5;
        // without the declaration the center column stays blank.
        main: { kind: 'keyed', scope: 'root' },
        rightbar: { kind: 'single', scope: 'root' },
        details: { kind: 'single', scope: 'session' },
        'shell.overlay': { kind: 'list', scope: 'root' },
      },
    }, props => createElement(MobileAppFrame, { ...props, controller }))
    const retainMainPanels = (): void => {
      controller.retainMainPanels(ctx.slots.entries('main').flatMap(entry =>
        entry.options.key === undefined ? [] : [entry.options.key]))
    }
    const disposePanels = ctx.slots.subscribe('main', retainMainPanels)
    retainMainPanels()
    return () => {
      controller.dispose()
      disposePanels()
      disposeRoot()
      disposePanelInfo()
      void disposeService()
      disposeMainPanelRegistry()
      style.remove()
    }
  }, 'dsh-mobile: dedicated root layout')

  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', snapshot => { presenter.apply(snapshot) })
    return () => { off(); presenter.dispose() }
  }, 'dsh-mobile: theme presenter')
}

/** Preserve the official layout module's dependency ordering. */
export const inject: readonly string[] = ['slots', 'theme']
