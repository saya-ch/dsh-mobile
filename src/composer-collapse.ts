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

/** Read the persisted opt-in. Defaults to off; unreadable storage keeps it off. */
export function readComposerCollapseEnabled(storage?: Pick<Storage, 'getItem'> | null): boolean {
  try {
    // Resolved inside the try: a restricted WebView can throw from the getter.
    const resolved = storage === undefined ? globalThis.localStorage : storage
    return resolved?.getItem(COMPOSER_COLLAPSE_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

/** Persist the opt-in and notify the layout bundle in the same page. */
export function writeComposerCollapseEnabled(enabled: boolean, storage?: Pick<Storage, 'setItem'> | null): void {
  try {
    const resolved = storage === undefined ? globalThis.localStorage : storage
    resolved?.setItem(COMPOSER_COLLAPSE_STORAGE_KEY, String(enabled))
  } catch {
    /* Blocked storage still lets this page react through the event below. */
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
