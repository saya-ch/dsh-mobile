import { createElement, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import type { ComposerReadingModeHandle } from './composer-collapse.js'
import { WIDE_LAYOUT_ATTRIBUTE } from './mobile-layout-attributes.js'
import { MOBILE_LAYOUT_MESSAGES, type MobileLayoutLanguage } from './mobile-layout-messages.js'
import {
  installComposerReadingMode,
  readComposerCollapseEnabled,
  selectActiveSessionRunning,
  subscribeComposerCollapseEnabled,
} from './composer-collapse.js'
import {
  SESSION_PREFETCH_DEFAULTS,
  SessionPrefetchTracker,
  prefetchSession,
  readSessionPrefetchEnabled,
  sessionPrefetchConfigFrom,
  subscribeSessionPrefetchEnabled,
} from './session-prefetch.js'

export { MOBILE_LAYOUT_MESSAGES } from './mobile-layout-messages.js'
export type { MobileLayoutLanguage } from './mobile-layout-messages.js'
export type { ComposerReadingModeHandle } from './composer-collapse.js'
// Re-exported so the browser fixture can drive the shipped layout bundle directly;
// this file already publishes the other DOM policies it installs.
export { installComposerReadingMode, readComposerCollapseEnabled, selectActiveSessionRunning } from './composer-collapse.js'

interface SessionState {
  readonly current?: string
  readonly byId: Readonly<Record<string, { readonly blank?: boolean; readonly title?: string; readonly running?: boolean } | undefined>>
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
  readonly get: (name: string) => unknown
  readonly on: (event: string, listener: (value: ThemeSnapshot) => void) => () => void
  readonly reflect: { provide: (name: string, value: unknown) => () => void | Promise<void> }
  readonly slots: {
    register: <Props>(options: Record<string, unknown>, component: (props: Props) => ReactNode) => () => void
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
  readonly rightbarTrack: boolean
  readonly rightbarFullscreen: boolean
  readonly panelInfo: PanelInfoSnapshot
}

/**
 * Panel selection as the standard `usePanelInfo` hook reports it: a null
 * `activePanelId` means the conversation owns the center column.
 */
interface PanelInfoSnapshot {
  readonly activePanelId: string | null
}

/** Optional DSH 0.1.5 right-Sidebar controls used by a Mobile close gesture. */
export interface SidebarRightControl {
  isExpanded(): boolean
  toggleExpanded(): void
}

/** Whether an optional service value supports the public right-Sidebar controls. */
export function isSidebarRightControl(value: unknown): value is SidebarRightControl {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SidebarRightControl>
  return typeof candidate.isExpanded === 'function' && typeof candidate.toggleExpanded === 'function'
}

/**
 * Viewport width at which the dedicated layout treats the sidebar as a
 * persistent desktop panel instead of an overlay drawer. Narrow screens
 * keep the overlay behavior byte-for-byte.
 */
export const WIDE_LAYOUT_MIN_WIDTH_PX = 900
/**
 * Shorter-side floor for the persistent sidebar, measured on the *device*: a
 * landscape phone is wider than the width threshold while its screen's short
 * side is still a phone's. Docking a 932x430 phone hid the conversation behind a
 * permanent rail and removed the panel return bar, so width alone is not enough
 * evidence of a tablet-sized viewport.
 *
 * The measurement must come from `screen`, not the viewport: a Pad 9 Pro Max in
 * landscape (1363x860 viewport, 1364x909 screen) reports `innerHeight: 441`
 * while the soft keyboard is open, and a viewport-height floor would flip a
 * docked tablet into the drawer layout mid-sentence.
 */
export const WIDE_LAYOUT_MIN_SHORTER_SIDE_PX = 600
/** Re-exported so the layout's own tests and callers keep one import site. */
export { WIDE_LAYOUT_ATTRIBUTE }
/**
 * Narrow band that still has room for a folded 56px rail beside the
 * conversation: the pre-existing 721-899px phone rule plus any narrow viewport
 * that is wide enough for the rail, such as a landscape phone.
 */
const FOLDED_RAIL_OFFSET_QUERY = '(min-width:721px)'
const RIGHTBAR_MIN_WIDTH_PX = 300
const RIGHTBAR_MAX_WIDTH_PX = 460
const RIGHTBAR_CENTER_MIN_WIDTH_PX = 400
const RIGHTBAR_DEFAULT_RATIO = 0.45
const SIDEBAR_EXPANDED_WIDTH_PX = 340
const SIDEBAR_COLLAPSED_WIDTH_PX = 56

/**
 * The device's shorter side in CSS pixels, independent of rotation and of the
 * soft keyboard. Falls back to the viewport only where `screen` reports nothing
 * usable (SSR, minimal DOM stubs).
 * @param screenWidth - `screen.width`, or `undefined` without a screen.
 * @param screenHeight - `screen.height`, or `undefined` without a screen.
 * @param viewportWidth - the viewport width, used for the fallback.
 * @param viewportHeight - the viewport height, used for the fallback.
 * @returns the shorter side in CSS pixels.
 */
export function resolveDeviceShortSide(
  screenWidth: number | undefined,
  screenHeight: number | undefined,
  viewportWidth: number,
  viewportHeight: number,
): number {
  return typeof screenWidth === 'number' && typeof screenHeight === 'number'
    && screenWidth > 0 && screenHeight > 0
    ? Math.min(screenWidth, screenHeight)
    : Math.min(viewportWidth, viewportHeight)
}

/**
 * Whether the dedicated layout should dock the sidebar as a persistent column.
 * @param viewportWidth - the viewport width in CSS pixels; a narrow window is
 * never wide, whatever the screen behind it measures.
 * @param deviceShortSide - the device's shorter side, from {@link resolveDeviceShortSide}.
 * @returns whether the viewport and the device are both large enough.
 */
export function isWideViewportLayout(viewportWidth: number, deviceShortSide: number): boolean {
  return viewportWidth >= WIDE_LAYOUT_MIN_WIDTH_PX
    && deviceShortSide >= WIDE_LAYOUT_MIN_SHORTER_SIDE_PX
}

/** Resolved right-panel presentation for the dedicated responsive layout. */
export interface MobileRightbarLayout {
  readonly docked: boolean
  readonly width: number
}

/** Preserve a readable conversation width before turning a requested right track into a docked column. */
export function resolveMobileRightbarLayout(
  viewportWidth: number,
  wideViewport: boolean,
  sidebarOpen: boolean,
  track: boolean,
  fullscreen: boolean,
): MobileRightbarLayout {
  const overlayWidth = wideViewport
    ? Math.min(viewportWidth * 0.94, RIGHTBAR_MAX_WIDTH_PX)
    : viewportWidth
  if (!track || fullscreen || (!wideViewport && sidebarOpen)) {
    return Object.freeze({ docked: false, width: overlayWidth })
  }
  const sidebarWidth = wideViewport && sidebarOpen
    ? SIDEBAR_EXPANDED_WIDTH_PX
    : SIDEBAR_COLLAPSED_WIDTH_PX
  const available = Math.floor(viewportWidth - sidebarWidth - RIGHTBAR_CENTER_MIN_WIDTH_PX)
  if (available < RIGHTBAR_MIN_WIDTH_PX) return Object.freeze({ docked: false, width: overlayWidth })
  const preferred = Math.min(
    RIGHTBAR_MAX_WIDTH_PX,
    Math.max(RIGHTBAR_MIN_WIDTH_PX, Math.round(viewportWidth * RIGHTBAR_DEFAULT_RATIO)),
  )
  return Object.freeze({ docked: true, width: Math.min(preferred, available) })
}

/** Whether an overlay drawer needs the modal scrim without dimming a docked desktop panel. */
export function isMobileScrimOpen(
  sidebarOpen: boolean,
  detailsModalOpen: boolean,
  wideViewport: boolean,
): boolean {
  return (!wideViewport && sidebarOpen) || detailsModalOpen
}

/**
 * Query matching devices whose primary pointer cannot hover: the phones and
 * tablets where focusing an editor raises a soft keyboard the user did not ask
 * for. A desktop keeps stock behaviour because it has a real keyboard already.
 */
export const TOUCH_PRIMARY_QUERY = '(hover: none), (pointer: coarse)'

/** The stock composer wrapper, which owns everything the phone adapter edits. */
const COMPOSER_CARD_SELECTOR = '[data-composer-card]'

/** The composer's editing host, whichever contenteditable flavour it boots with. */
const COMPOSER_EDITOR_SELECTOR = `${COMPOSER_CARD_SELECTOR} :is([contenteditable="true"],[contenteditable="plaintext-only"],[contenteditable=""])`

/** The composer's Add trigger, whose menu must open without summoning the IME. */
const COMPOSER_COMMAND_TRIGGER_SELECTOR = `${COMPOSER_CARD_SELECTOR} button[aria-haspopup="listbox"]`

/**
 * Whether a focus target belongs to the composer, which owns its own keyboard
 * decision and must never be blurred by a suppression window.
 * @param target - the focus target, already narrowed to an element.
 * @returns whether the target sits inside the composer card.
 */
export function isComposerOwnedFocus(target: Element | null): boolean {
  return target !== null && target.closest(COMPOSER_CARD_SELECTOR) !== null
}

/**
 * Whether a click opens a different Session, rather than its menu or current row.
 * @param target - the click target in the workspace sidebar.
 * @returns whether the Session selection can change.
 */
export function isSessionRowNavigation(target: Element | null): boolean {
  if (target === null) return false
  const row = target.closest('[role="treeitem"][aria-selected]')
  if (row === null || row.getAttribute('aria-selected') === 'true') return false
  const action = target.closest('button,[role="button"]')
  return action === null || action === row
}

/**
 * Decide how one pointer event changes the composer's soft keyboard.
 *
 * The Add button's own mousedown calls `keepDraftFocus`, which focuses the draft
 * on purpose so the caret survives the menu; on a phone that focus is what
 * raises the keyboard. `inputmode="none"` withholds the IME without moving focus
 * or the caret, so the menu, the caret, and the draft all keep stock behaviour.
 * @param target - the pointer target, already narrowed to an element.
 * @param touchPrimary - whether the device's primary pointer cannot hover.
 * @returns `withhold` for the Add trigger, `restore` for any other tap, and
 * `ignore` where no soft keyboard exists to withhold.
 */
export function resolveComposerImePolicy(
  target: Element | null,
  touchPrimary: boolean,
): 'ignore' | 'restore' | 'withhold' {
  if (!touchPrimary || target === null) return 'ignore'
  return target.closest(COMPOSER_COMMAND_TRIGGER_SELECTOR) === null ? 'restore' : 'withhold'
}

/**
 * Whether a tap landed on the stock Send, Queue, or Steer primary button.
 * Stop uses a square SVG; Add, attachment, and plugin buttons are separate actions.
 * @param target - the click target in the composer card.
 * @returns whether the enabled primary action carries the send arrow.
 */
export function isComposerActionTap(target: Element | null): boolean {
  if (target === null) return false
  const action = target.closest('button[class*="_primary"]')
  return action !== null && action.closest(COMPOSER_CARD_SELECTOR) !== null
    && !action.hasAttribute('disabled') && action.getAttribute('aria-disabled') !== 'true'
    && action.querySelector('svg path') !== null
}

/** Text, reference chips, and the stock attachment rail all contribute to a draft. */
function composerHasDraft(editor: HTMLElement, card: Element): boolean {
  return (editor.textContent ?? '').replaceAll('\u200b', '').trim() !== ''
    || editor.querySelector('[contenteditable="false"],[data-lexical-decorator],img') !== null
    || card.querySelector('[data-slot="conversation.input.attachments"] [role="group"] > *') !== null
}

/**
 * Collapse an on-screen keyboard after a trusted touch Send consumes the focused
 * draft. Consumption may be asynchronous; input, navigation, composition, or
 * another gesture cancels the observation. DSH owns optimistic sends and any
 * later failure restoration; this listener never submits or modifies the draft.
 * @param onConsumed - called immediately before blurring to suppress DSH autofocus.
 * @returns disposer for pointer, composition, focus, and draft observations.
 */
export function installComposerSendKeyboardPolicy(onConsumed: () => void): () => void {
  let touchButton: Element | null = null
  let cancelPending = (): void => {}
  const composing = new WeakSet<Element>()
  let compositionEndedAt = -Infinity
  const elementTarget = (target: EventTarget | null): Element | null => target instanceof Element ? target : null
  const onPointerDown = (event: PointerEvent): void => {
    cancelPending()
    const target = elementTarget(event.target)
    touchButton = event.isTrusted && (event.pointerType === 'touch' || event.pointerType === 'pen')
      && isComposerActionTap(target) ? target?.closest('button') ?? null : null
  }
  const onClick = (event: MouseEvent): void => {
    const action = touchButton
    touchButton = null
    const target = elementTarget(event.target)
    const active = document.activeElement
    const nativeState = window.__DSH_MOBILE_KEYBOARD_STATE__
    if (!event.isTrusted || event.detail === 0 || action === null || target?.closest('button') !== action
      || !isComposerActionTap(target) || !window.matchMedia(TOUCH_PRIMARY_QUERY).matches
      || (window.__DSH_MOBILE_NATIVE__ !== undefined
        && (nativeState?.noHardwareKeyboard !== true || nativeState.imeVisible !== true))
      || !(active instanceof HTMLElement) || !active.matches(COMPOSER_EDITOR_SELECTOR)
      || composing.has(active) || performance.now() - compositionEndedAt < 10) return
    const editor = active
    const composerCard = editor.closest(COMPOSER_CARD_SELECTOR)
    if (composerCard === null || action.closest(COMPOSER_CARD_SELECTOR) !== composerCard || !composerHasDraft(editor, composerCard)) return
    const card = composerCard
    const sessionOwner = card.closest('[data-conversation-session]')
    const sessionId = sessionOwner?.getAttribute('data-conversation-session')
    const currentEditor = (): boolean => editor.isConnected && editor.closest(COMPOSER_CARD_SELECTOR) === card
      && card.closest('[data-conversation-session]') === sessionOwner
      && sessionOwner?.getAttribute('data-conversation-session') === sessionId
      && document.activeElement === editor
    cancelPending()
    let frame = 0
    const observer = new MutationObserver(check)
    const expiry = window.setTimeout(() => { cancelPending() }, 30_000)
    cancelPending = (): void => {
      observer.disconnect()
      window.clearTimeout(expiry)
      window.cancelAnimationFrame(frame)
      cancelPending = () => {}
    }
    function check(): void {
      if (!currentEditor()) {
        cancelPending()
        return
      }
      if (composerHasDraft(editor, card) || ['adjudicating', 'submitting'].includes(editor.dataset.phase ?? '')) return
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = window.requestAnimationFrame(() => {
          frame = 0
          if (!currentEditor() || composerHasDraft(editor, card)
            || ['adjudicating', 'submitting'].includes(editor.dataset.phase ?? '')) return
          cancelPending()
          onConsumed()
          editor.blur()
        })
      })
    }
    observer.observe(card, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-phase', 'contenteditable'] })
    // The capture listener runs before React's onClick; the first frame reads its result.
    frame = window.requestAnimationFrame(() => { frame = 0; check() })
  }
  const onCompositionStart = (event: CompositionEvent): void => {
    const target = elementTarget(event.target)
    if (target !== null) composing.add(target)
    cancelPending()
  }
  const onCompositionEnd = (event: CompositionEvent): void => {
    const target = elementTarget(event.target)
    if (target !== null) composing.delete(target)
    compositionEndedAt = performance.now()
  }
  const onTyping = (): void => { touchButton = null; cancelPending() }
  const onFocus = (): void => { cancelPending() }
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('compositionstart', onCompositionStart, true)
  document.addEventListener('compositionend', onCompositionEnd, true)
  document.addEventListener('keydown', onTyping, true)
  document.addEventListener('input', onTyping, true)
  document.addEventListener('focusin', onFocus, true)
  return () => {
    cancelPending()
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('compositionstart', onCompositionStart, true)
    document.removeEventListener('compositionend', onCompositionEnd, true)
    document.removeEventListener('keydown', onTyping, true)
    document.removeEventListener('input', onTyping, true)
    document.removeEventListener('focusin', onFocus, true)
  }
}

/**
 * Close the details drawer from its scrim, collapsing the DSH 0.1.5 right
 * Sidebar first when that optional service owns the visible content.
 */
export function closeDetailsFromScrim(sidebarRight: unknown, closeDetails: () => void): void {
  if (isSidebarRightControl(sidebarRight) && sidebarRight.isExpanded()) {
    sidebarRight.toggleExpanded()
  }
  closeDetails()
}

/** The device and viewport facts the layout decision needs, read live. */
function readViewport(): { width: number, height: number, shortSide: number } {
  const width = window.innerWidth
  const height = window.innerHeight
  const screen = window.screen as { width?: number, height?: number } | undefined
  return {
    width,
    height,
    shortSide: resolveDeviceShortSide(screen?.width, screen?.height, width, height),
  }
}

/**
 * Reads the live device and viewport; unknown environments (SSR, tests) stay
 * narrow. `screen` is what distinguishes a tablet from a landscape phone and
 * what keeps a docked tablet docked while its soft keyboard is open.
 */
function viewportIsWide(): boolean {
  if (typeof window === 'undefined') return false
  const viewport = readViewport()
  return isWideViewportLayout(viewport.width, viewport.shortSide)
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
    rightbarTrack: false,
    rightbarFullscreen: false,
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

  /**
   * The panel store on the layout service itself (`ctx.layout.panelInfo`),
   * mirroring the official LayoutController of DSH 0.1.7-rc.2+. The root hook
   * wired in `apply` feeds `usePanelInfo` rendering; rc.2 client plugins read
   * this service member directly. Without it `dsh-client-ui-plugin-manager`
   * fails activation on the dedicated mobile frontend ("web boot: 1 entry did
   * not activate") and `dsh-client-ui-open-in-app` throws the first time its
   * shortcut target runs.
   */
  readonly panelInfo = {
    getSnapshot: (): PanelInfoSnapshot => this.getSnapshot().panelInfo,
    subscribe: (listener: () => void): (() => void) => this.subscribe(listener),
  }

  toggleSidebar(): void {
    this.update({ sidebarOpen: !this.snapshot.sidebarOpen })
  }

  openDetails(): void {
    this.update({ detailsOpen: true })
  }

  closeDetails(): void {
    this.update({ detailsOpen: false, rightbarTrack: false, rightbarFullscreen: false })
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

  /** Preserve the native seat's distinction between a docked track and fullscreen. */
  openRightbar(track = true, fullscreen = false): void {
    this.update({ detailsOpen: true, rightbarTrack: track, rightbarFullscreen: fullscreen })
  }

  /** Hide the right panel. */
  closeRightbar(): void {
    this.closeDetails()
  }

  /**
   * Select the main panel rendered in the center column; null means the
   * conversation. Mirrors the official LayoutController so the `panelInfo`
   * root hook stays truthful. Selecting a panel while the narrow overlay
   * drawer covers the center column dismisses that drawer — the user asked to
   * see the panel, not the navigation over it — while a docked wide sidebar
   * stays open.
   */
  selectPanel(panelId: string | null): void {
    if (panelId !== null && this.hasMainPanel?.(panelId) !== true) {
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    }
    this.navigation.abort()
    const dismissDrawer = this.snapshot.sidebarOpen && !viewportIsWide()
    const samePanel = this.snapshot.panelInfo.activePanelId === panelId
    if (!dismissDrawer && samePanel) return
    this.update({
      ...(dismissDrawer ? { sidebarOpen: false } : {}),
      ...(samePanel ? {} : { panelInfo: Object.freeze({ activePanelId: panelId }) }),
    })
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
      && snapshot.rightbarTrack === this.snapshot.rightbarTrack
      && snapshot.rightbarFullscreen === this.snapshot.rightbarFullscreen
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
/* Definite height bounds the transcript on engines without dvh. Isolation keeps
   shell descendants below positive-z-index portals attached to document.body. */
.dshm-shell{-webkit-text-size-adjust:100%;text-size-adjust:100%;position:relative;isolation:isolate;display:grid;grid-template-rows:minmax(0,1fr);width:100%;height:100%;height:100dvh;min-width:0;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)}
/* The mobile root owns its Grid geometry. Layered important rules keep broad
   unlayered skin rules from collapsing virtualized views to the header height.
   The wide/narrow band is the root attribute, not a media query: the decision
   needs the device screen size, which a media query cannot read. */
@layer dsh-mobile-layout{
.dshm-shell{display:grid!important;grid-template-rows:minmax(0,1fr)!important;grid-template-columns:minmax(0,1fr)!important}
.dshm-shell[${WIDE_LAYOUT_ATTRIBUTE}="1"]{grid-template-columns:auto minmax(0,1fr)!important}
}
.dshm-main{grid-area:1/1;position:relative;display:flex;flex-direction:column;min-width:0;min-height:0;margin-right:0;overflow:hidden;transition:margin-right var(--ds-transition-duration-slow,190ms) var(--ds-ease-in-out,ease)}
.dshm-mainContent{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden}
.dshm-shell[data-rightbar-docked=true] .dshm-main{margin-right:var(--dshm-rightbar-width)}
.dshm-shell[data-rightbar-docked=true] .dshm-details{position:absolute;width:var(--dshm-rightbar-width);box-shadow:none;padding-top:0}
/* Draw above the native absolute panel without consuming its width or
   intercepting controls; only docked mode needs this column separator. */
.dshm-shell[data-rightbar-docked=true] .dshm-details::after{content:"";position:absolute;inset:0 auto 0 0;width:.5px;background:var(--dsw-alias-border-l4);z-index:11;pointer-events:none}
/* The native panel paints itself at 100vw in fullscreen mode. Inside the
   docked overlay (94vw/460px, overflow:hidden) that layout was clipped to the
   right edge of the track, so the header slid out of view and the body showed
   only clipped line tails. A fullscreen panel owns the whole viewport. */
.dshm-shell[data-rightbar-fullscreen=true] .dshm-details{inset:0;width:100vw;max-width:100vw;box-shadow:none}
.dshm-main>*,.dshm-main>*>*{min-width:0}
.dshm-drawer{position:fixed;z-index:70;inset:0 auto 0 0;box-sizing:border-box;width:56px;max-width:100%;padding-top:env(safe-area-inset-top);overflow:hidden;background-color:Canvas;background-image:linear-gradient(var(--dsw-alias-bg-layer-1,#f8fafc),var(--dsw-alias-bg-layer-1,#f8fafc));box-shadow:none;will-change:width;transition:width 240ms cubic-bezier(.22,1,.36,1),box-shadow 240ms ease}
.dshm-drawer[data-open=true]{width:min(88vw,340px);box-shadow:18px 0 46px rgb(15 23 42 / 18%)}
.dshm-drawer[data-open=false]{pointer-events:auto;visibility:visible}
/* Slide the sidebar content only while opening or closing. A resting transform
   would make this child the containing block for stock fixed-position surfaces
   inside the sidebar and let the drawer's overflow clip them (issue #413: the
   Cordis plugin panel anchors itself to the viewport to escape that clip). */
.dshm-drawer>*{width:100%!important;height:100%!important;opacity:.94;transition:opacity 160ms ease-out}
.dshm-drawer[data-open=true]>*{opacity:1;animation:dshm-drawer-slide-open 220ms cubic-bezier(.22,1,.36,1)}
.dshm-drawer[data-open=false]>*{width:56px!important;animation:dshm-drawer-slide-closed 220ms cubic-bezier(.22,1,.36,1)}
@keyframes dshm-drawer-slide-open{from{transform:translateX(-6px)}to{transform:translateX(0)}}
@keyframes dshm-drawer-slide-closed{from{transform:translateX(0)}to{transform:translateX(-6px)}}
/* The Cordis plugin panel opens from the sidebar footer as a stock fixed surface
   (position:fixed, width:420px, anchored from its trigger) so the sidebar's
   overflow cannot clip it. On phones the drawer must give it real containment:
   span the viewport instead of the desktop width, sit above our drawer but below
   the stock floating slot layer (300), and cap the height so its body scrolls
   (issue #413). */
.dshm-shell:not([${WIDE_LAYOUT_ATTRIBUTE}="1"]) [data-cordis-panel]{position:fixed!important;inset:auto 8px max(8px,env(safe-area-inset-bottom)) 8px!important;width:auto!important;max-width:min(420px,calc(100vw - 16px))!important;max-height:min(60vh,calc(100dvh - 96px))!important;overflow-y:auto!important;z-index:210!important}
/* Folded icon rail: on narrow viewports the drawer is fixed, so give the main
   content the same 56px offset the wide grid already provides. The width floor
   keeps phone-width headers on their own inset; the band itself is the root
   attribute, so a landscape phone gets the offset too. The drawer's folded state
   owns this offset independently of nested-pane markers. */
@media${FOLDED_RAIL_OFFSET_QUERY}{.dshm-shell:not([${WIDE_LAYOUT_ATTRIBUTE}="1"]):has(.dshm-drawer[data-open=false]:not([data-right-modal=true])) .dshm-main{margin-left:56px}}
/* display:none also suppresses fixed descendants installed by the phone adapter. */
.dshm-drawer[data-right-modal=true]{display:none!important}
.dshm-details{position:fixed;z-index:80;inset:0 0 0 auto;box-sizing:border-box;width:min(94vw,460px);max-width:100%;padding-top:env(safe-area-inset-top);overflow:hidden;background-color:Canvas;background-image:linear-gradient(var(--dsw-alias-bg-layer-1,#fff),var(--dsw-alias-bg-layer-1,#fff));box-shadow:-18px 0 46px rgb(15 23 42 / 18%);transform:translateX(104%);transition:transform 190ms cubic-bezier(.22,1,.36,1)}
.dshm-details[data-open=true]{transform:translateX(0)}
.dshm-details[data-open=false]{pointer-events:none;visibility:hidden;transition:transform 190ms cubic-bezier(.22,1,.36,1),visibility 0s linear 190ms}
/* An absent marker is the narrow default: static fixtures and the first paint
   before React mounts keep the overlay geometry rather than a half-docked shell. */
.dshm-shell:not([${WIDE_LAYOUT_ATTRIBUTE}="1"]) .dshm-details{width:100%;max-width:100%;box-shadow:none}
.dshm-shell:not([${WIDE_LAYOUT_ATTRIBUTE}="1"]) .dshm-details [data-sidebar-right-toggle],.dshm-shell:not([${WIDE_LAYOUT_ATTRIBUTE}="1"]) .dshm-details [data-sidebar-right-mode]{min-width:48px;min-height:48px}
.dshm-scrim{position:fixed;z-index:65;inset:0;border:0;background:rgb(15 23 42 / 40%);opacity:0;pointer-events:none;transition:opacity 180ms ease-out}
.dshm-scrim[data-open=true]{opacity:1;pointer-events:auto}
.dshm-overlay{position:fixed;z-index:90;inset:0;pointer-events:none}.dshm-overlay>*{pointer-events:auto}
/* Reserve navigation space instead of covering a panel's own save controls. */
.dshm-panelNav{display:flex;align-items:center;flex-shrink:0;min-height:56px;box-sizing:border-box;padding:max(4px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) 4px max(68px,env(safe-area-inset-left));border-bottom:.5px solid var(--dsw-alias-border-l4);background-color:Canvas;background-image:linear-gradient(var(--dsw-alias-bg-base,#fff),var(--dsw-alias-bg-base,#fff))}
.dshm-panelBack{display:inline-flex;align-items:center;gap:8px;min-width:48px;min-height:48px;padding:8px 12px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#171a21);font:inherit;font-size:14px;line-height:1.4;text-align:left;cursor:pointer}
.dshm-panelBack:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}
.dshm-panelBack:active{background:var(--dsw-alias-interactive-bg-active,#e9ecef)}
.dshm-panelBack:disabled{opacity:.5;cursor:default}
.dshm-panelBack:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#171a21);outline-offset:2px}
.dshm-panelBack svg{width:20px;height:20px;flex-shrink:0}
.dshm-shell header{min-width:0}
/* A panel owns its header padding; only conversation content clears the rail. */
.dshm-shell :where(.dshm-main:not([data-dsh-panel="1"])) header{padding-left:52px}
/* Keep focused editables above Safari's 16px zoom threshold while retaining
   the DSH content-font preference and larger inherited text. Stock menus
   portal into document.body, so the floor scopes from the body itself. */
body:has(.dshm-shell) :is(input,textarea,[contenteditable=true],[contenteditable=plaintext-only],[contenteditable=""]){font-size:max(16px,1em,var(--dsh-content-font-size,1em))!important}
.dshm-shell table{display:block;max-width:100%;overflow-x:auto}
.dshm-shell pre{max-width:100%;overflow-x:auto}
.dshm-shell img,.dshm-shell video,.dshm-shell canvas,.dshm-shell svg{max-width:100%}
.dshm-shell [data-disclosure-row]{min-width:0;max-width:100%}
.dshm-shell [data-disclosure-row]>*{min-width:0;overflow-wrap:anywhere}
.dshm-shell [data-context-fields]>*{min-width:0}
.dshm-shell [class*="_body"]{max-width:100%;overflow-wrap:anywhere}
@media(max-width:420px){.dshm-shell [data-context-fields]>*{display:grid;grid-template-columns:1fr!important;gap:4px}.dshm-shell [class*="_ioSection"]{grid-template-columns:1fr!important}}
@media(max-width:600px){
.dshm-shell [data-question-key],.dshm-shell [data-plan-review-key]{box-sizing:border-box;width:100%;height:auto!important;min-width:0;flex:none!important;align-self:flex-end;padding:6px max(10px,env(safe-area-inset-left)) max(10px,env(safe-area-inset-bottom)) max(10px,env(safe-area-inset-right))!important}
.dshm-shell [data-question-key]>section,.dshm-shell [data-plan-review-key]>section{width:100%;height:auto!important;min-height:0!important;max-width:none!important;max-height:min(68dvh,520px)!important;border-radius:16px!important}
.dshm-shell [data-question-scroll],.dshm-shell [data-plan-review-scroll]{flex:0 1 auto!important;min-height:0!important;max-height:min(42dvh,360px)!important;overscroll-behavior:contain;scroll-padding-bottom:12px}
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
/* Wide band: the shell carries the decision, so these rules follow the same
   device+viewport test as the JS. An absent attribute is the narrow default. */
.dshm-shell[${WIDE_LAYOUT_ATTRIBUTE}="1"]{grid-template-columns:auto minmax(0,1fr)}
/* The wide drawer is a static grid column, not an overlay: it occupies its own
   track and never overlaps the conversation. Keeping a z-index here made it
   outrank the conversation column, so a dialog a plugin mounts inside the
   composer's own stacking context lost its left edge behind the opaque rail.
   A static column needs no layer, so it stays in normal flow order. */
.dshm-shell[${WIDE_LAYOUT_ATTRIBUTE}="1"] .dshm-drawer{position:static;grid-area:1/1;box-shadow:none;z-index:auto}
.dshm-shell[${WIDE_LAYOUT_ATTRIBUTE}="1"] .dshm-drawer[data-open=true]{width:340px;box-shadow:none}
.dshm-shell[${WIDE_LAYOUT_ATTRIBUTE}="1"] .dshm-drawer[data-open=false]{width:56px}
/* The conversation column outranks that column so an in-shell modal opened from
   it is not clipped by the navigation rail. It stays below the scrim (65), the
   detail panel (80) and the shell overlay (90), so a modal shell surface still
   dims and covers it. Only the wide grid needs this: on a phone the drawer is a
   floating overlay and must keep covering the conversation. */
.dshm-shell[${WIDE_LAYOUT_ATTRIBUTE}="1"] .dshm-main{grid-area:1/2;z-index:1}
@media(prefers-reduced-motion:reduce){.dshm-drawer,.dshm-details,.dshm-scrim,.dshm-drawer>*,.dshm-main{transition:none!important}.dshm-drawer>*{animation:none!important}}
/* Touch adaptation changes control boxes, not invisible hit regions. Root opt-out
   retains pane geometry too; nested opt-out preserves a widget's own controls.
   DSH's plugin cards open through a cardTitle/cardOpen button whose ::after
   overlay already owns the whole card hit area; the floor only inflated that
   title box and pushed each description away from its card title. */
@media(pointer:coarse){
.dshm-main[data-dsh-panel="1"] .dshm-mainContent:has(>[data-slot="main"]>:not([data-dsh-adapt="off"])):not(:has(>[data-slot="main"]>[data-dsh-adapt="off"])){overflow-y:auto;overscroll-behavior:contain}
.dshm-main[data-dsh-panel="1"] .dshm-mainContent>[data-slot="main"]>:not([data-dsh-adapt="off"]){max-width:100%;box-sizing:border-box}
.dshm-main[data-dsh-panel="1"] [data-slot="main"]>:not([data-dsh-adapt="off"]) :is(button,[role="button"],select,input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]):not([type=color]):not([type=file]):not([type=image])):not([role="switch"],[role="checkbox"],[role="radio"],[role="slider"],button[class*="_cardTitle"][class*="_cardOpen"],[data-dsh-adapt="off"],[data-dsh-adapt="off"] *){min-width:44px!important;min-height:44px!important}
.dshm-main[data-dsh-panel="1"] [data-slot="main"]>:not([data-dsh-adapt="off"]) :is(button,[role="button"],a):not([data-dsh-adapt="off"],[data-dsh-adapt="off"] *){touch-action:manipulation}
}
/* Reading mode (issue #194): after scrolling down a long conversation the
   composer editor collapses so the reading area is unobstructed. The card stays
   and keeps the upstream Send/Stop row; its generated label is the way back, and
   the text comes from --dshm-composer-restore-label so nothing is injected into
   the React-managed card. Opt-in, off by default. */
[data-dsh-mobile-composer-collapsed="true"] [data-composer-card] :is([contenteditable="true"],[contenteditable="plaintext-only"],[contenteditable=""],textarea){display:none!important}
[data-dsh-mobile-composer-collapsed="true"] [data-composer-card]{
  padding-top:6px!important;padding-bottom:6px!important;min-height:0!important;cursor:pointer}
[data-dsh-mobile-composer-collapsed="true"] [data-composer-card]::before{
  content:var(--dshm-composer-restore-label, "");display:flex;align-items:center;
  justify-content:center;min-height:44px;font-size:13px;opacity:.75;pointer-events:none}
`

function MobileAppFrame(props: MobileRootProps & {
  readonly controller: MobileLayoutController
  readonly requestDetailsClose: () => void
}): ReactNode {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot)
  const suppressKeyboardUntil = useRef(0)
  const suppressComposerUntil = useRef(0)
  const previousPanelId = useRef(state.panelInfo.activePanelId)
  const navigationIme = useRef(new Map<HTMLElement, string | null>())
  const restoreNavigationIme = (): void => {
    for (const [editor, previous] of navigationIme.current) {
      if (editor.getAttribute('inputmode') !== 'none') continue
      if (previous === null) editor.removeAttribute('inputmode')
      else editor.setAttribute('inputmode', previous)
    }
    navigationIme.current.clear()
  }
  useLayoutEffect(() => {
    const previous = previousPanelId.current
    previousPanelId.current = state.panelInfo.activePanelId
    if (previous === null || state.panelInfo.activePanelId !== null
      || !window.matchMedia(TOUCH_PRIMARY_QUERY).matches) return
    // All panel exits precede the remounted composer's passive autofocus.
    restoreNavigationIme()
    suppressComposerUntil.current = performance.now() + 500
    const active = document.activeElement
    if (active instanceof HTMLElement && active.matches(COMPOSER_EDITOR_SELECTOR)) active.blur()
  }, [state.panelInfo.activePanelId])
  // The width decides whether the window is big enough and the device's shorter
  // side decides whether it is a tablet: width alone would dock a landscape
  // phone, and the viewport height alone would undock a tablet whose soft
  // keyboard is open (Pad 9 Pro Max reports innerHeight 441 in landscape).
  // `resize` fires on rotation, window resizing and keyboard-driven viewport
  // changes, so both facts are re-read with the same frame-coalesced measurement.
  const [viewport, setViewport] = useState(readViewport)
  useEffect(() => {
    let frame: number | undefined
    const resize = (): void => {
      if (frame !== undefined) return
      frame = window.requestAnimationFrame(() => {
        frame = undefined
        setViewport(readViewport())
      })
    }
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      if (frame !== undefined) window.cancelAnimationFrame(frame)
    }
  }, [])
  const viewportWidth = viewport.width
  const wideViewport = isWideViewportLayout(viewport.width, viewport.shortSide)
  const rightbar = resolveMobileRightbarLayout(
    viewport.width,
    wideViewport,
    state.sidebarOpen,
    state.rightbarTrack,
    state.rightbarFullscreen,
  )
  const rightbarDocked = state.detailsOpen && rightbar.docked
  // DSH reports a fullscreen panel through the layout service; the overlay has
  // to hand over the whole viewport instead of its docked track (see the
  // `data-rightbar-fullscreen` rule). Phones derive fullscreen from their
  // width, so the flag is already set there.
  const rightbarFullscreen = state.detailsOpen && state.rightbarFullscreen
  // The panel owns the viewport on phones (no column fits) and in fullscreen on
  // a wider screen, so the conversation behind it is inert and needs no scrim.
  const rightbarFullWidth = state.detailsOpen && !rightbarDocked && (!wideViewport || rightbarFullscreen)
  const [documentLanguage, setDocumentLanguage] = useState(document.documentElement.lang)
  const browserLanguages = navigator.languages.length > 0 ? navigator.languages : [navigator.language]
  const language = resolveMobileLayoutLanguage(documentLanguage, browserLanguages)
  const messages = MOBILE_LAYOUT_MESSAGES[language]
  const scrimOpen = !rightbarFullWidth && isMobileScrimOpen(state.sidebarOpen, state.detailsOpen && !rightbarDocked, wideViewport)
  const activeSessionId = props.useSessions(session => {
    const current = session.current
    return current !== undefined && session.byId[current]?.blank === false ? current : undefined
  })
  const hasSession = activeSessionId !== undefined

  // Warm DSH session-query's prepared-session cache for the session the user just
  // left after a switch settles (issue #291). Opt-in via the session-prefetch
  // configuration; silent, read-only and bounded so it never disturbs normal
  // requests or live streams.
  const prefetchEnabled = useSyncExternalStore(
    subscribeSessionPrefetchEnabled,
    readSessionPrefetchEnabled,
    () => false,
  )
  const prefetchTracker = useRef<SessionPrefetchTracker | undefined>(undefined)
  const prefetchTimer = useRef<number | undefined>(undefined)
  const prefetchDispose = useRef<(() => void) | undefined>(undefined)
  // Rebuild the tracker when the opt-in flips: the switch is part of the config,
  // and a stale tracker would keep answering `skip('disabled')` (or keep warming
  // after the user turned it off).
  if (prefetchTracker.current === undefined || prefetchTracker.current.enabled !== prefetchEnabled) {
    prefetchTracker.current = new SessionPrefetchTracker(sessionPrefetchConfigFrom(prefetchEnabled))
  }
  useEffect(() => {
    if (activeSessionId === undefined) return
    const decision = prefetchTracker.current!.switchTo(activeSessionId)
    if (decision.action !== 'warm') return
    const target = decision.target
    if (prefetchTimer.current !== undefined) clearTimeout(prefetchTimer.current)
    prefetchTimer.current = window.setTimeout(() => {
      prefetchTimer.current = undefined
      // Keep the disposer: leaving the session (or unmounting) should abort a
      // request that would otherwise run to its timeout in the background.
      prefetchDispose.current?.()
      prefetchDispose.current = prefetchSession(fetch, target, SESSION_PREFETCH_DEFAULTS.timeoutMs)
    }, SESSION_PREFETCH_DEFAULTS.settleMs)
    return () => {
      if (prefetchTimer.current !== undefined) { clearTimeout(prefetchTimer.current); prefetchTimer.current = undefined }
      prefetchDispose.current?.()
      prefetchDispose.current = undefined
    }
  }, [activeSessionId, prefetchEnabled])
  // Reading mode (issue #194): while the user scrolls down a long conversation,
  // collapse the composer editor so the reading area is unobstructed; tapping the
  // collapsed card, focusing the composer, opening the keyboard, scrolling back up,
  // having a draft, or a running reply expands it again. Opt-in, off by default
  // (see COMPOSER_COLLAPSE_DEFAULTS). The composer and its draft stay owned by DSH;
  // this only toggles presentation.
  //
  // The switch is read from the persisted flag rather than a module singleton: the
  // settings row ships in the client bundle while this file is inlined into the
  // layout bundle, so two copies would each hold their own value and the toggle
  // would only apply after a reload.
  const collapseEnabled = useSyncExternalStore(
    subscribeComposerCollapseEnabled,
    readComposerCollapseEnabled,
    () => false,
  )
  // A running reply is not a composer phase: DSH reports it on the Session summary,
  // and data-phase returns to plain as soon as the submission is accepted, so the
  // phase alone would let the composer vanish mid-stream. Read the real flag.
  const activeRunning = props.useSessions(selectActiveSessionRunning)
  const runningRef = useRef(activeRunning)
  runningRef.current = activeRunning
  const active = collapseEnabled && hasSession
  const readingMode = useRef<ComposerReadingModeHandle | undefined>(undefined)
  // The DOM wiring lives in installComposerReadingMode so the scroll container,
  // the dead zone and the guards can be driven in a browser fixture, not only
  // asserted from source text.
  useEffect(() => {
    if (!active) return
    const installed = installComposerReadingMode({
      restoreLabel: messages.composerRestore,
      isRunning: () => runningRef.current,
    })
    readingMode.current = installed
    if (runningRef.current) installed.expand()
    return () => {
      readingMode.current = undefined
      installed.dispose()
    }
    // activeSessionId tears the mode down and reinstalls it, so a collapse never
    // leaks into the next conversation and the new scroller starts bound.
  }, [active, activeSessionId, messages.composerRestore])
  useEffect(() => {
    if (!activeRunning) return
    // Reset the dead zone too: without this the next downward scroll immediately
    // re-collapses the composer the user just came back for.
    readingMode.current?.expand()
    document.documentElement.setAttribute('data-dsh-mobile-composer-collapsed', 'false')
  }, [activeRunning])

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
    const elementTarget = (target: EventTarget | null): Element | null =>
      target instanceof Element ? target : null
    const suppressAutofocus = (event: FocusEvent): void => {
      const target = elementTarget(event.target)
      if (target === null) return
      const editable = target instanceof HTMLElement && (target.matches('input,textarea') || target.isContentEditable)
      if (!editable) return
      if (isComposerOwnedFocus(target)) {
        if (performance.now() < suppressComposerUntil.current) target.blur()
        return
      }
      if (performance.now() >= suppressKeyboardUntil.current) return
      target.blur()
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
    // The native composer deliberately preserves editor focus when its Add menu
    // opens, and on a phone that focus summons the soft keyboard. Withholding the
    // IME leaves the focus, the caret, and the draft exactly as stock left them;
    // any other tap restores the keyboard.
    const applyComposerImePolicy = (event: PointerEvent): void => {
      const target = elementTarget(event.target)
      // A deliberate tap in the composer ends the navigation-only suppression
      // before focus can reach the editor. The Add trigger then reclaims its
      // existing inputmode="none" policy below.
      if (isComposerOwnedFocus(target)) {
        suppressComposerUntil.current = 0
        restoreNavigationIme()
      }
      const policy = resolveComposerImePolicy(
        target,
        window.matchMedia(TOUCH_PRIMARY_QUERY).matches,
      )
      if (policy === 'ignore') return
      for (const editor of document.querySelectorAll<HTMLElement>(COMPOSER_EDITOR_SELECTOR)) {
        if (policy === 'withhold') editor.setAttribute('inputmode', 'none')
        else if (editor.getAttribute('inputmode') === 'none') editor.removeAttribute('inputmode')
      }
    }
    document.addEventListener('focusin', suppressAutofocus, true)
    document.addEventListener('click', suppressBranchAutofocus, true)
    // A finger tap never fires mousedown on Android, and this has to land before
    // the trigger's own focus, so it runs on capture for pointerdown.
    document.addEventListener('pointerdown', applyComposerImePolicy, true)
    const disposeSendKeyboard = installComposerSendKeyboardPolicy(() => {
      suppressComposerUntil.current = performance.now() + 700
    })
    return () => {
      document.removeEventListener('focusin', suppressAutofocus, true)
      document.removeEventListener('click', suppressBranchAutofocus, true)
      document.removeEventListener('pointerdown', applyComposerImePolicy, true)
      disposeSendKeyboard()
      restoreNavigationIme()
      // A withheld editor outliving the surface would strand the composer without
      // a keyboard for the rest of the session.
      for (const editor of document.querySelectorAll<HTMLElement>(`${COMPOSER_CARD_SELECTOR} [inputmode="none"]`)) {
        editor.removeAttribute('inputmode')
      }
    }
  }, [])

  // Session navigation on touch withholds upstream composer autofocus; only a
  // narrow overlay drawer closes after the row's own click handler completes.
  const closeDrawerAfterSessionAction = (event: { readonly target: EventTarget | null }): void => {
    if (!(event.target instanceof Element)) return
    if (isSessionRowNavigation(event.target) && window.matchMedia(TOUCH_PRIMARY_QUERY).matches) {
      const deadline = performance.now() + 500
      suppressComposerUntil.current = deadline
      for (const editor of document.querySelectorAll<HTMLElement>(COMPOSER_EDITOR_SELECTOR)) {
        if (!navigationIme.current.has(editor)) navigationIme.current.set(editor, editor.getAttribute('inputmode'))
        editor.setAttribute('inputmode', 'none')
        if (document.activeElement === editor) editor.blur()
      }
      window.setTimeout(() => {
        if (suppressComposerUntil.current !== deadline) return
        suppressComposerUntil.current = 0
        restoreNavigationIme()
      }, 500)
    }
    if (viewportIsWide()) return
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

  return createElement('div', {
    className: 'dshm-shell', lang: language,
    // The stylesheet follows this marker instead of a media query: the band
    // depends on `screen`, which CSS cannot read. It is part of the first render,
    // so a tablet never paints the drawer band and then reflows.
    [WIDE_LAYOUT_ATTRIBUTE]: wideViewport ? '1' : '0',
    'data-rightbar-docked': rightbarDocked,
    'data-rightbar-fullscreen': rightbarFullscreen,
    style: { '--dshm-rightbar-width': `${rightbar.width}px` },
  },
    createElement('main', {
      className: 'dshm-main',
      'data-dsh-mobile-session': activeSessionId,
      ...(rightbarFullWidth ? { inert: '', 'aria-hidden': true } : {}),
      // Legacy dsh-web community plugins use semantic pane attributes as their
      // compatibility path when the stock CSS-module column names are absent.
      'data-pane': 'conversation',
      // A third-party panel is open: the host owes its controls a touch-sized hit area
      // (see the plugin-panel block in MOBILE_LAYOUT_STYLES).
      'data-dsh-panel': state.panelInfo.activePanelId === null ? '0' : '1',
    },
      state.panelInfo.activePanelId !== null && !wideViewport ? createElement('div', {
        className: 'dshm-panelNav',
      }, createElement('button', {
        type: 'button',
        className: 'dshm-panelBack',
        'aria-label': messages.backToConversation,
        disabled: state.sidebarOpen,
        onClick: () => { props.controller.selectPanel(null) },
      }, createElement('svg', {
        'aria-hidden': true, viewBox: '0 0 24 24', fill: 'none',
      }, createElement('path', {
        d: 'M15 5l-7 7 7 7',
        stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
      })), createElement('span', null, messages.backToConversation))) : null,
      createElement('div', { className: 'dshm-mainContent' }, props.renderSlot('main', {}, {
        entryKey: state.panelInfo.activePanelId ?? 'conversation',
        fallback: props.renderSlot('conversation', {}),
      }))),
    createElement('button', {
      'aria-label': messages.closePanels,
      className: 'dshm-scrim',
      // A persistent wide sidebar needs no dimming; the scrim only covers
      // the narrow overlay drawer and the details panel.
      'data-open': scrimOpen,
      'aria-hidden': !scrimOpen,
      onClick: () => {
        if (!scrimOpen) return
        state.detailsOpen ? props.requestDetailsClose() : props.controller.closeSidebar()
      },
      tabIndex: scrimOpen ? 0 : -1,
      type: 'button',
    }),
    createElement('aside', {
      'aria-label': messages.workspaceNavigation,
      className: 'dshm-drawer',
      'data-pane': 'sidebar',
      'data-open': state.sidebarOpen,
      // The phone adapter promotes the whale toggle to a fixed high layer.
      // Remove that entire navigation surface while the right modal owns focus.
      'data-right-modal': state.detailsOpen && !rightbarDocked,
      ...(state.detailsOpen && !rightbarDocked ? { inert: '', 'aria-hidden': true } : {}),
      // Community rows collapse their label when an ancestor carries this marker.
      ...(state.sidebarOpen ? {} : { 'data-sidebar-collapsed': '' }),
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
        width: rightbar.width,
        viewportWidth,
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
      ? ctx.slots.provideRoot({ hooks: { panelInfo: controller.panelInfo } })
      : () => {}
    const requestDetailsClose = (): void => {
      closeDetailsFromScrim(ctx.get('sidebarRight'), () => { controller.closeDetails() })
    }
    const disposeRoot = ctx.slots.register<MobileRootProps>({
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
    }, props => createElement(MobileAppFrame, {
      ...props,
      controller,
      // sidebarRight is registered after the layout it depends on, so resolve
      // the optional service at gesture time rather than caching it at boot.
      requestDetailsClose,
    }))
    const onNativeBack = (event: Event): void => {
      if (!event.cancelable || event.defaultPrevented) return
      const state = controller.getSnapshot()
      if (state.detailsOpen) {
        event.preventDefault()
        requestDetailsClose()
      } else if (!viewportIsWide() && state.sidebarOpen) {
        event.preventDefault()
        controller.closeSidebar()
      } else if (state.panelInfo.activePanelId !== null) {
        event.preventDefault()
        controller.selectPanel(null)
      }
    }
    window.addEventListener('dsh-mobile:native-back', onNativeBack)
    const retainMainPanels = (): void => {
      controller.retainMainPanels(ctx.slots.entries('main').flatMap(entry =>
        entry.options.key === undefined ? [] : [entry.options.key]))
    }
    const disposePanels = ctx.slots.subscribe('main', retainMainPanels)
    retainMainPanels()
    return () => {
      window.removeEventListener('dsh-mobile:native-back', onNativeBack)
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
