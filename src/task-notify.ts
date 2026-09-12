/** Task-completion notifications for the Android shell.
 *
 * The page cannot know a run "finished" from any single event, so completion
 * is defined conservatively: assistant activity was observed, then the
 * conversation stayed quiet for a bounded period with no pending input
 * question, while the page was hidden. Question cards, which unambiguously
 * wait for the user, notify immediately instead of waiting out the quiet
 * period. Everything here is pure except the clearly-marked DOM adapters so
 * the decision logic stays unit-testable under node.
 */

/** How long the conversation must stay quiet before a run counts as done. */
export const TASK_NOTIFY_QUIET_MS = 90_000

/**
 * Grace after a busy-to-idle transition before announcing completion.
 * Absorbs composer flicker between steps while still feeling immediate.
 */
export const TASK_NOTIFY_GRACE_MS = 10_000

/**
 * Minimum continuous busy time for an instant announcement. A run that held
 * the composer this long is no flicker: announce at once instead of waiting
 * out the grace period.
 */
export const TASK_NOTIFY_MIN_BUSY_MS = 20_000

/** Maximum quiet period worth waiting through before giving up on a run. */
export const TASK_NOTIFY_STALE_MS = 30 * 60_000

/** Wire bounds mirrored by the Android notification policy. */
export const TASK_NOTIFY_LIMITS = Object.freeze({
  title: 80,
  body: 200,
  tag: 64,
} as const)

export type TaskNotifyKind = 'done' | 'question'

export interface TaskNotifyTexts {
  readonly doneTitle: string
  readonly doneBody: string
  readonly questionTitle: string
  readonly questionBody: string
}

export interface TaskNotifySnapshot {
  /** Result of document.hidden at evaluation time. */
  readonly pageHidden: boolean
  /** Whether a question or plan-review card currently waits for input. */
  readonly pendingQuestion: boolean
  /** Stable key of the waiting card, when the DOM exposes one. */
  readonly questionKey: string | undefined
  /** Best-effort session label for the notification body. */
  readonly sessionLabel: string
  /** Current composer busy flag; drives the completion transition. */
  readonly composerBusy: boolean
}

export interface TaskNotifyEvent {
  readonly kind: TaskNotifyKind
  readonly title: string
  readonly body: string
  readonly tag: string
}

export interface TaskNotifyOptions {
  readonly quietMs?: number
  readonly graceMs?: number
  readonly minBusyMs?: number
  readonly now?: () => number
  readonly format: (kind: TaskNotifyKind, sessionLabel: string) => { title: string; body: string }
}

const MAX_SEEN_QUESTION_KEYS = 20

function sanitizeTagFragment(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9-]+/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, TASK_NOTIFY_LIMITS.tag)
}

/** Decide whether the current snapshot deserves a system notification. */
export class TaskNotifyTracker {
  private lastActivityAt: number | undefined
  private notifiedDoneAt: number | undefined
  private wasBusy = false
  private busySince: number | undefined
  private idleAnchoredAt: number | undefined
  private readonly seenQuestionKeys = new Set<string>()
  private readonly quietMs: number
  private readonly graceMs: number
  private readonly minBusyMs: number
  private readonly now: () => number
  private readonly format: (kind: TaskNotifyKind, sessionLabel: string) => { title: string; body: string }

  constructor(options: TaskNotifyOptions) {
    this.quietMs = options.quietMs ?? TASK_NOTIFY_QUIET_MS
    this.graceMs = options.graceMs ?? TASK_NOTIFY_GRACE_MS
    this.minBusyMs = options.minBusyMs ?? TASK_NOTIFY_MIN_BUSY_MS
    this.now = options.now ?? Date.now
    this.format = options.format
  }

  /** Record assistant-side activity; re-arms completion after a notification. */
  markActivity(): void {
    const now = this.now()
    this.lastActivityAt = now
    if (this.notifiedDoneAt !== undefined && this.notifiedDoneAt <= now) this.notifiedDoneAt = undefined
  }

  /**
   * Milliseconds until a pending completion anchor fires, or undefined when
   * no anchor exists. Lets the watcher schedule one exact timer instead of
   * waiting for the next coarse poll tick.
   */
  pendingAnchorDelayMs(): number | undefined {
    if (this.idleAnchoredAt === undefined) return undefined
    return Math.max(0, this.graceMs - (this.now() - this.idleAnchoredAt))
  }

  evaluate(snapshot: TaskNotifySnapshot): TaskNotifyEvent | undefined {
    const now = this.now()
    if (!this.wasBusy && snapshot.composerBusy) this.busySince = now
    if (this.wasBusy && !snapshot.composerBusy) {
      // The run just ended. A run that held the composer long enough is no
      // flicker: announce at once when hidden, unless a question card (which
      // has its own immediate path below) is already waiting.
      const busyFor = this.busySince === undefined ? 0 : now - this.busySince
      this.busySince = undefined
      if (snapshot.pageHidden && !snapshot.pendingQuestion && busyFor >= this.minBusyMs) {
        this.idleAnchoredAt = undefined
        this.notifiedDoneAt = now
        return this.event('done', snapshot.sessionLabel, undefined)
      }
      this.idleAnchoredAt = snapshot.pageHidden ? now : undefined
      if (!snapshot.pageHidden) this.notifiedDoneAt = now
    }
    this.wasBusy = snapshot.composerBusy
    if (snapshot.composerBusy) {
      this.idleAnchoredAt = undefined
    } else if (this.idleAnchoredAt !== undefined && !snapshot.pageHidden) {
      // Came back before the grace elapsed: treat the ending as seen.
      this.idleAnchoredAt = undefined
      this.notifiedDoneAt = now
    }
    if (!snapshot.pageHidden) {
      if (snapshot.pendingQuestion && snapshot.questionKey !== undefined) this.rememberQuestionKey(snapshot.questionKey)
      return undefined
    }
    if (snapshot.pendingQuestion) {
      if (snapshot.questionKey === undefined || this.seenQuestionKeys.has(snapshot.questionKey)) return undefined
      this.rememberQuestionKey(snapshot.questionKey)
      return this.event('question', snapshot.sessionLabel, snapshot.questionKey)
    }
    // Completion: the anchored transition announces fast; the quiet period
    // remains as the fallback for activity without a busy signal.
    if (this.idleAnchoredAt !== undefined) {
      if (now - this.idleAnchoredAt < this.graceMs) return undefined
      this.idleAnchoredAt = undefined
      this.notifiedDoneAt = now
      return this.event('done', snapshot.sessionLabel, undefined)
    }
    if (this.lastActivityAt === undefined) return undefined
    if (now - this.lastActivityAt < this.quietMs) return undefined
    if (now - this.lastActivityAt > TASK_NOTIFY_STALE_MS) {
      // Activity too old to attribute: drop it instead of announcing a stale run.
      this.lastActivityAt = undefined
      return undefined
    }
    if (this.notifiedDoneAt !== undefined && this.notifiedDoneAt >= this.lastActivityAt) return undefined
    this.notifiedDoneAt = now
    return this.event('done', snapshot.sessionLabel, undefined)
  }

  private rememberQuestionKey(key: string): void {
    this.seenQuestionKeys.add(key)
    if (this.seenQuestionKeys.size > MAX_SEEN_QUESTION_KEYS) {
      const oldest = this.seenQuestionKeys.values().next()
      if (!oldest.done) this.seenQuestionKeys.delete(oldest.value)
    }
  }

  private event(kind: TaskNotifyKind, sessionLabel: string, questionKey: string | undefined): TaskNotifyEvent {
    const text = this.format(kind, sessionLabel)
    const tag = kind === 'question' && questionKey !== undefined
      ? `dsh-task-question-${sanitizeTagFragment(questionKey) || 'pending'}`
      : 'dsh-task-done'
    return Object.freeze({ kind, title: text.title, body: text.body, tag })
  }
}

interface ComposerProbe {
  getAttribute?: (name: string) => string | null
  querySelector?: (selectors: string) => {
    disabled?: boolean
    readOnly?: boolean
    getAttribute?: (name: string) => string | null
  } | null
}

/**
 * Mirror of the composer busy signal used for media actions: the run is busy
 * while the composer is aria-busy, disabled, read-only, or non-interactive.
 */
export function readComposerBusyState(root: ParentNode): boolean {
  if (typeof root.querySelector !== 'function') return false
  const card = root.querySelector('[data-composer-card]') as ComposerProbe | null
  if (card === null || typeof card.getAttribute !== 'function' || typeof card.querySelector !== 'function') return false
  if (card.getAttribute('aria-busy') === 'true') return true
  const field = card.querySelector('textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"]')
  if (field === null) return false
  return field.disabled === true || field.readOnly === true || field.getAttribute?.('aria-disabled') === 'true'
}

/**
 * Best-effort session label for the notification body, bounded for the wire.
 * Callers accept that titles may name the active session on the lock screen.
 */
export function readSessionLabel(title: unknown): string {
  if (typeof title !== 'string') return ''
  return title.normalize('NFC').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim().slice(0, 80)
}

/** Whether the document currently shows a card that waits for user input. */
export function hasPendingInputQuestion(root: ParentNode): boolean {  if (typeof root.querySelector !== 'function') return false
  return root.querySelector('[data-question-key],[data-plan-review-key]') !== null
}

/** Stable key of the waiting input card, when the DOM exposes one. */
export function pendingInputQuestionKey(root: ParentNode): string | undefined {
  if (typeof root.querySelector !== 'function') return undefined
  const card = root.querySelector('[data-question-key],[data-plan-review-key]') as {
    getAttribute?: (name: string) => string | null
  } | null
  const getAttribute = card?.getAttribute
  if (typeof getAttribute !== 'function') return undefined
  const key = getAttribute.call(card, 'data-question-key') ?? getAttribute.call(card, 'data-plan-review-key')
  if (key === null || key === '') return undefined
  return key
}

/** Observe assistant-side conversation mutations; returns a disposer. */
export function observeTaskActivity(
  target: Node,
  onActivity: () => void,
  observe: typeof MutationObserver | undefined = typeof MutationObserver === 'function' ? MutationObserver : undefined,
): () => void {
  if (observe === undefined) return () => undefined
  const observer = new observe(() => { onActivity() })
  try {
    observer.observe(target, { childList: true, characterData: true, subtree: true })
  } catch {
    return () => undefined
  }
  return () => { observer.disconnect() }
}

export interface TaskWatcherLabels {
  readonly label: (kind: TaskNotifyKind, sessionLabel: string) => { title: string; body: string }
}

interface NativeBridgeHandle {
  capabilities(): Promise<readonly string[]>
  invoke(action: string, input?: unknown): Promise<unknown>
}

function readNativeBridge(): NativeBridgeHandle | undefined {
  if (typeof window === 'undefined') return undefined
  const bridge = (window as unknown as { __DSH_MOBILE_NATIVE__?: NativeBridgeHandle }).__DSH_MOBILE_NATIVE__
  if (bridge === undefined || typeof bridge.capabilities !== 'function' || typeof bridge.invoke !== 'function') return undefined
  return bridge
}

export interface TaskNotifyWireEvent {
  readonly kind: TaskNotifyKind
  readonly title: string
  readonly body: string
  readonly tag: string
}

/** Parse a `task-notify` SSE payload; rejects anything malformed or empty. */
export function parseTaskNotifyPayload(value: unknown): { readonly sessionId: string; readonly turn: number } | undefined {
  let record: Record<string, unknown> | undefined
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
      record = parsed as Record<string, unknown>
    } catch {
      return undefined
    }
  } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    record = value as Record<string, unknown>
  } else return undefined
  if (typeof record.sessionId !== 'string' || record.sessionId.trim() === '') return undefined
  const turn = typeof record.turn === 'number' && Number.isSafeInteger(record.turn) && record.turn >= 0 ? record.turn : 0
  return Object.freeze({ sessionId: record.sessionId.slice(0, 128), turn })
}

/**
 * Deliver one notification through the native bridge when available.
 * Returns false when there is no bridge (desktop browsers keep their own
 * UI) so callers can fall back; a denial flips the module sticky flag via
 * onDenied for the session-lifetime nag guard.
 */
export function fireTaskNotifyEvent(
  event: TaskNotifyWireEvent,
  onDenied?: () => void,
): boolean {
  const bridge = readNativeBridge()
  if (bridge === undefined) return false
  void Promise.resolve()
    .then(() => bridge.capabilities())
    .then(capabilities => {
      if (!capabilities.includes('notification.notify')) return
      return bridge.invoke('notification.notify', { title: event.title, body: event.body, tag: event.tag })
    })
    .then(
      () => undefined,
      (error: unknown) => {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
        // A denial is sticky for this page load: never nag for permission.
        if ((code === 'permission_denied' || code === 'denied') && onDenied !== undefined) onDenied()
      },
    )
  return true
}

/**
 * Watch the rendered conversation for finished runs and waiting questions,
 * notifying through the native bridge while the page is hidden. Returns a
 * disposer. Silent when no native bridge exists (desktop browsers keep their
 * own UI) or after the user denies the permission.
 */
export function installTaskCompletionWatcher(options: TaskWatcherLabels): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => undefined
  const tracker = new TaskNotifyTracker({ format: options.label })
  let notifyBlocked = false
  let timer = 0
  let anchorTimer = 0

  const fire = (event: TaskNotifyEvent): void => {
    if (notifyBlocked) return
    if (!fireTaskNotifyEvent(event, () => { notifyBlocked = true })) return
  }
  const evaluateNow = (): void => {
    const busy = readComposerBusyState(document)
    const event = tracker.evaluate({
      pageHidden: document.hidden,
      pendingQuestion: hasPendingInputQuestion(document),
      questionKey: pendingInputQuestionKey(document),
      sessionLabel: readSessionLabel(document.title),
      composerBusy: busy,
    })
    if (event !== undefined) fire(event)
    scheduleAnchorTimer()
  }
  // The interval is only a backstop: an anchor schedules its own exact shot
  // so completion announces ~grace after the run ends instead of waiting out
  // the next coarse tick with no further mutations to wake it.
  const scheduleAnchorTimer = (): void => {
    const delay = tracker.pendingAnchorDelayMs()
    if (delay === undefined) {
      if (anchorTimer !== 0) {
        window.clearTimeout(anchorTimer)
        anchorTimer = 0
      }
      return
    }
    if (anchorTimer !== 0) return
    anchorTimer = window.setTimeout(() => {
      anchorTimer = 0
      evaluateNow()
    }, delay)
  }
  const disposeObservation = observeTaskActivity(document.documentElement, () => {
    tracker.markActivity()
    evaluateNow()
  })
  const onVisibility = (): void => { evaluateNow() }
  document.addEventListener('visibilitychange', onVisibility)
  if (typeof window.setInterval === 'function') {
    timer = window.setInterval(evaluateNow, 15_000)
  }
  evaluateNow()
  return () => {
    disposeObservation()
    document.removeEventListener('visibilitychange', onVisibility)
    if (timer !== 0) window.clearInterval(timer)
    if (anchorTimer !== 0) window.clearTimeout(anchorTimer)
  }
}
