/**
 * Reading-mode composer collapse for the dedicated Mobile layout (issue #194).
 *
 * While the user scrolls down through a long conversation, the composer keeps
 * its full multi-row height and crowds the reading area. This module tracks the
 * conversation scroller and collapses the composer once the user has scrolled
 * down past roughly one viewport while reading, then expands it again when the
 * user scrolls back up toward the top (reading is done, input is likely).
 *
 * The feature is opt-in and disabled by default, so existing layouts are never
 * silently changed. Collapse is a CSS-only presentation toggle driven by a
 * data- attribute on the document element; the composer and its draft stay owned
 * by DSH. A collapse is always recoverable: tapping the collapsed card, focusing
 * the composer, opening the keyboard, having a draft, a running reply, or
 * scrolling toward the top expands it again.
 */

export type ComposerCollapseState = 'expanded' | 'collapsed'

export interface ComposerCollapseConfig {
  /** Master switch; disabled by default so the behavior is opt-in. */
  readonly enabled: boolean
  /** Scroll distance (px) that counts as "reading down" past one viewport. */
  readonly collapseThresholdPx: number
  /** A downward run resets when the user scrolls up at least this far (px). */
  readonly reverseResetPx: number
}

export const COMPOSER_COLLAPSE_DEFAULTS: Readonly<ComposerCollapseConfig> = {
  enabled: false,
  collapseThresholdPx: 480,
  reverseResetPx: 80,
}

/**
 * Track cumulative reading progress across scroll events. This is the only
 * collapse policy: a decision table plus accumulated progress, kept out of the
 * component so it stays testable without a DOM.
 */
export class ComposerCollapseTracker {
  private readingProgress = 0
  private reverseProgress = 0
  private state: ComposerCollapseState = 'expanded'
  private config: Readonly<ComposerCollapseConfig>

  constructor(config: Readonly<ComposerCollapseConfig>) {
    this.config = config
  }

  /** Whether the opt-in switch is currently on. */
  get enabled(): boolean {
    return this.config.enabled
  }

  /** Update whether collapse is enabled (the user's settings toggle). */
  setEnabled(enabled: boolean): void {
    this.config = { ...this.config, enabled }
    if (!enabled) this.reset()
  }

  /**
   * Feed one scroll sample; returns the resulting presentation state.
   *
   * reverseResetPx is a deliberate dead zone: a collapsed composer stays
   * collapsed until the user scrolls back up at least that far, so a 1px jitter
   * does not flip the layout on every frame.
   */
  sample(deltaY: number): ComposerCollapseState {
    if (!this.config.enabled) {
      this.reset()
      return this.state
    }
    if (this.state === 'collapsed') {
      if (deltaY > 0) {
        // Still reading down; restart any pending reverse run.
        this.reverseProgress = 0
        return this.state
      }
      this.reverseProgress += -deltaY
      if (this.reverseProgress >= Math.max(this.config.reverseResetPx, 1)) this.reset()
      return this.state
    }
    if (deltaY < 0) {
      // Scrolling up reduces reading intent.
      this.readingProgress = Math.max(0, this.readingProgress + deltaY)
      this.reverseProgress = 0
      return this.state
    }
    this.readingProgress += deltaY
    this.reverseProgress = 0
    if (this.readingProgress >= this.config.collapseThresholdPx) this.state = 'collapsed'
    return this.state
  }

  /** User interacted with the composer (focus, tap, keyboard, draft): expand. */
  expand(): void {
    this.reset()
  }

  get stateValue(): ComposerCollapseState {
    return this.state
  }

  /** @internal exposed for tests */
  progress(): number {
    return this.readingProgress
  }

  private reset(): void {
    this.state = 'expanded'
    this.readingProgress = 0
    this.reverseProgress = 0
  }
}

/**
 * Storage key for the opt-in switch.
 *
 * The setting row lives in the client bundle while the tracker lives in the
 * layout bundle, and tsdown.config.ts emits those as two independent CJS modules
 * that each inline this file. A module-level singleton therefore cannot carry the
 * value across: the row would flip its own copy while the layout kept the
 * boot-time value, and the toggle would only apply after a reload. The persisted
 * flag plus the two events below are the shared state instead, mirroring the
 * session-prefetch opt-in.
 */
export const COMPOSER_COLLAPSE_STORAGE_KEY = 'dsh-mobile.composer-collapse.enabled'
export const COMPOSER_COLLAPSE_EVENT = 'dsh-mobile:composer-collapse-change'

/**
 * Last value written in this page when storage refused the write.
 *
 * This is a per-bundle fallback for the blocked-storage case only: it is not the
 * cross-bundle transport (that is the persisted flag plus the events above). It
 * exists so a switch that cannot be persisted still reads back as flipped in the
 * same page, instead of the row snapping back while the layout obeys the event.
 */
let unpersistedEnabled: boolean | undefined

/** Read the persisted opt-in. Defaults to off; unreadable storage keeps it off. */
export function readComposerCollapseEnabled(storage?: Pick<Storage, 'getItem'> | null): boolean {
  try {
    // Resolved inside the try: a restricted WebView can throw from the getter.
    const resolved = storage === undefined ? globalThis.localStorage : storage
    const stored = resolved?.getItem(COMPOSER_COLLAPSE_STORAGE_KEY) ?? null
    if (stored !== null) return stored === 'true'
    return storage === undefined ? unpersistedEnabled ?? false : false
  } catch {
    return storage === undefined ? unpersistedEnabled ?? false : false
  }
}

/** Persist the opt-in and notify the layout bundle in the same page. */
export function writeComposerCollapseEnabled(enabled: boolean, storage?: Pick<Storage, 'setItem'> | null): void {
  try {
    const resolved = storage === undefined ? globalThis.localStorage : storage
    if (resolved === null) throw new Error('storage unavailable')
    resolved.setItem(COMPOSER_COLLAPSE_STORAGE_KEY, String(enabled))
    if (storage === undefined) unpersistedEnabled = undefined
  } catch {
    // Blocked storage still lets this page react through the event below, and the
    // in-page read has to agree with it or the row and the layout diverge.
    if (storage === undefined) unpersistedEnabled = enabled
  }
  try {
    globalThis.dispatchEvent?.(new CustomEvent(COMPOSER_COLLAPSE_EVENT, { detail: { enabled } }))
  } catch {
    /* CustomEvent is missing in some test environments; the storage event still applies. */
  }
}

/**
 * Subscribe to opt-in changes coming from either bundle. The listener is not
 * called with the initial value; read it once with readComposerCollapseEnabled().
 */
export function subscribeComposerCollapseEnabled(listener: (enabled: boolean) => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== COMPOSER_COLLAPSE_STORAGE_KEY) return
    listener(readComposerCollapseEnabled())
  }
  const onCustom = (event: Event): void => {
    const detail = (event as CustomEvent<{ enabled?: boolean }>).detail
    listener(detail?.enabled ?? readComposerCollapseEnabled())
  }
  globalThis.addEventListener?.('storage', onStorage)
  globalThis.addEventListener?.(COMPOSER_COLLAPSE_EVENT, onCustom)
  return () => {
    globalThis.removeEventListener?.('storage', onStorage)
    globalThis.removeEventListener?.(COMPOSER_COLLAPSE_EVENT, onCustom)
  }
}

/** Apply the persisted opt-in onto a base config. */
export function composerCollapseConfigFrom(
  enabled: boolean,
  base: Readonly<ComposerCollapseConfig> = COMPOSER_COLLAPSE_DEFAULTS,
): ComposerCollapseConfig {
  return { ...base, enabled }
}

/**
 * 软键盘开合监听。
 * 键盘弹起（visualViewport 缩小）意味着用户要输入，应展开收起态。
 * 封装在这里而不是 layout，是为了让 layout 源码不含 visualViewport——
 * 那里只用 window.innerWidth 判宽屏，否则软键盘缩小可视视口会把手机误判成宽屏。
 */
export function onViewportResize(handler: () => void): () => void {
  const viewport = globalThis.visualViewport
  if (viewport === null || viewport === undefined) return () => {}
  viewport.addEventListener('resize', handler)
  return () => { viewport.removeEventListener('resize', handler) }
}

/**
 * DOM wiring for reading mode. Kept here rather than in mobile-layout.ts so the
 * behavior can be exercised against a real scroll container in the browser
 * fixture, and so the layout source keeps its width-only viewport guard.
 */
export interface ComposerReadingModeOptions {
  /** Localized label rendered on the collapsed card. */
  readonly restoreLabel: string
  /** Whether the active session is streaming a reply right now. */
  readonly isRunning: () => boolean
  /** Injected in tests; defaults to the live document. */
  readonly doc?: Document
}

export interface ComposerReadingModeHandle {
  /** Force the composer back open (session switch, running reply, teardown). */
  expand(): void
  dispose(): void
}

const COLLAPSED_ATTRIBUTE = 'data-dsh-mobile-composer-collapsed'
const RESTORE_LABEL_PROPERTY = '--dshm-composer-restore-label'
const CONVERSATION_SCROLL_SELECTOR = '[data-conversation-scroll]'
const COMPOSER_CARD_SELECTOR = '[data-composer-card]'
const COMPOSER_EDITOR_SELECTOR = `${COMPOSER_CARD_SELECTOR} :is([contenteditable="true"],[contenteditable="plaintext-only"],[contenteditable=""],textarea)`

/**
 * Install the reading-mode collapse. Opt-in through the persisted switch, off by
 * default; the composer and its draft stay owned by DSH, this only toggles a
 * presentation attribute on the document element.
 */
export function installComposerReadingMode(options: ComposerReadingModeOptions): ComposerReadingModeHandle {
  const doc = options.doc ?? globalThis.document
  const root = doc.documentElement
  const tracker = new ComposerCollapseTracker(composerCollapseConfigFrom(readComposerCollapseEnabled()))
  let collapsed = false
  const view = doc.defaultView
  const apply = (next: boolean): void => {
    if (collapsed === next) return
    collapsed = next
    root.setAttribute(COLLAPSED_ATTRIBUTE, next ? 'true' : 'false')
  }
  const expand = (): void => {
    tracker.expand()
    apply(false)
  }
  // The label travels as a custom property: the collapsed card is DSH-owned
  // React output, so a generated label is safer than an injected child.
  root.style.setProperty(RESTORE_LABEL_PROPERTY, JSON.stringify(options.restoreLabel))
  const scroller = (): HTMLElement | undefined => {
    const found = doc.querySelector(CONVERSATION_SCROLL_SELECTOR)
    return found instanceof (view?.HTMLElement ?? Object) ? found as HTMLElement : undefined
  }
  // The document itself never scrolls (html/body/#root are height:100% with
  // overflow:hidden); the conversation scrolls inside the container above, so its
  // scrollTop is the only truthful reading progress.
  let lastTop = scroller()?.scrollTop ?? 0
  let rafPending = false
  const sample = (): void => {
    rafPending = false
    const port = scroller()
    if (port === undefined) return
    const top = port.scrollTop
    const delta = top - lastTop
    lastTop = top
    // A streaming reply returns the composer phase to plain, so Stop has to stay
    // reachable: never collapse away an active generation. A draft is the same
    // promise from the other side: the composer is the only place it is visible,
    // so a scroll that lands after the draft was typed must not hide it either.
    if (busy()) {
      expand()
      return
    }
    apply(tracker.sample(delta) === 'collapsed')
  };
  const onScroll = (event: Event): void => {
    const target = event.target
    if (target === null || !(target as Element).hasAttribute?.(CONVERSATION_SCROLL_SELECTOR.slice(1, -1))) return
    if (rafPending) return
    rafPending = true
    if (view === null) { sample(); return }
    view.requestAnimationFrame(sample)
  };
  // A draft or an in-flight submission is only visible in the composer, so a
  // collapse there would look like data loss.
  const busy = (): boolean => {
    if (options.isRunning()) return true
    const card = doc.querySelector(COMPOSER_CARD_SELECTOR)
    const editor = card?.querySelector<HTMLElement>(COMPOSER_EDITOR_SELECTOR) ?? null
    if (editor === null) return false
    // Any phase other than plain means the composer is mid-submit. Deny-listing
    // the non-plain phases instead of allow-listing the in-flight ones keeps this
    // correct across DSH versions: the union is plain | adjudicating | claimed |
    // submitting where I could read it, and other releases report extra names
    // (e.g. sending) that must block too, not fall through to 'not busy'.
    const phase = editor.dataset.phase ?? ''
    if (phase !== '' && phase !== 'plain') return true
    // Focus is the keyboard window: the user opened the composer and the soft
    // keyboard is up, so collapsing would take the editor out from under it.
    const focused = (doc as Document).activeElement
    if (focused !== null && card !== null && card.contains(focused)) return true
    const text = (editor as HTMLTextAreaElement).value ?? editor.textContent ?? ''
    return text.trim() !== ''
  };
  const guard = (): void => { if (busy()) expand() }
  const onPointerDown = (event: Event): void => {
    if (!collapsed) return
    const target = event.target
    if (target === null || !(target instanceof (view?.Element ?? Object))) return
    if ((target as Element).closest(COMPOSER_CARD_SELECTOR) === null) return
    expand()
  };
  const onFocusIn = (): void => { expand() }
  // The composer card is DSH's React output: it is replaced when a conversation
  // goes from empty to active, so the observed set is refreshed, not captured once.
  let observed: HTMLElement[] = []
  const observeCards = (): void => {
    const cards = [...doc.querySelectorAll<HTMLElement>(COMPOSER_CARD_SELECTOR)]
    if (cards.length === observed.length && cards.every((card, index) => card === observed[index])) return
    observer.disconnect()
    for (const card of cards) {
      observer.observe(card, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-phase'] })
    }
    observed = cards
  }
  const observer = new (view?.MutationObserver ?? MutationObserver)(() => { observeCards(); guard() })
  observeCards()
  doc.addEventListener('scroll', onScroll, { passive: true, capture: true })
  doc.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('focusin', onFocusIn, true)
  const stopPreference = subscribeComposerCollapseEnabled(enabled => {
    tracker.setEnabled(enabled)
    if (!enabled) expand()
  })
  const stopViewport = onViewportResize(onFocusIn)
  return {
    expand,
    dispose(): void {
      doc.removeEventListener('scroll', onScroll, { capture: true })
      doc.removeEventListener('pointerdown', onPointerDown, true)
      doc.removeEventListener('focusin', onFocusIn, true)
      stopViewport()
      stopPreference()
      observer.disconnect()
      root.style.removeProperty(RESTORE_LABEL_PROPERTY)
      apply(false)
    },
  }
}

/**
 * The slice of the Session summary reading mode needs. Kept structural so the
 * selector can be unit-tested without a Session store.
 */
export interface ReadingModeSessionState {
  readonly current?: string
  readonly byId: Readonly<Record<string, { readonly running?: boolean } | undefined>>
}

/**
 * Whether the active session is streaming a reply. A running reply is not a
 * composer phase: `data-phase` returns to `plain` as soon as the submission is
 * accepted, so this flag is the only truthful signal for the streaming window.
 */
export function selectActiveSessionRunning(state: ReadingModeSessionState): boolean {
  const current = state.current
  return current !== undefined && state.byId[current]?.running === true
}
