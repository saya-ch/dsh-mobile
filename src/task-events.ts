/**
 * Host-side task-completion fan-out for phone notifications.
 *
 * The exact moment a run ends is known only on the Host (the phone page can
 * merely infer it from UI state), so this module watches the public
 * `session/event` bus for completed root turns and hands them to a hub that
 * fans out to every live mobile gateway.
 *
 * Phones still render the final notification locally, but the event carries an
 * optional, already-bounded title/body derived from the Session title and the
 * turn's first non-empty assistant line. The Android background service uses
 * that text when present and falls back to its localized strings when the
 * fields are absent, so older Apps that ignore the new fields keep working.
 */

/** A completed root turn worth announcing on paired phones. */
export interface TaskCompletionEvent {
  readonly sessionId: string
  readonly turn: number
  /** Bounded Session title; present only with a bounded body. */
  readonly title?: string
  /** Bounded first non-empty assistant line of the turn; present only with a title. */
  readonly body?: string
}

/** Minimal session shape read off the `session/event` bus. */
export interface TaskEventSession {
  readonly id: unknown
  readonly header?: { readonly parentSession?: unknown } | null | undefined
}

/**
 * Minimal turn event shape read off the `session/event` bus. Fields stay
 * unknown here and are validated at runtime below so this module never
 * depends on the harness session packages.
 */
export interface TaskTurnEvent {
  readonly type: string
  readonly data?: unknown
}

/** Structural slice of the Host context this module needs (keeps tests cordis-free). */
export interface TaskEventContext {
  on(event: 'session/event', handler: (session: TaskEventSession, event: TaskTurnEvent) => void): () => void
}

export interface TaskEventWatcherOptions {
  /** Trailing debounce per session that merges turn-boundary bursts. */
  readonly debounceMs?: number
  readonly onTaskCompleted: (event: TaskCompletionEvent) => void
  /** Read the Session's display title (normally `sessionProjections.stateOf(session, 'title')`). */
  readonly readSessionTitle?: ((session: TaskEventSession) => unknown) | undefined
  readonly log?: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void
}

export const TASK_EVENT_DEBOUNCE_MS = 1_000

/**
 * Wire bounds for the optional title/body. They mirror the Android notification
 * policy (`TASK_NOTIFY_LIMITS`) so the page's own notifications and the
 * background service never publish a value one side would truncate again.
 */
export const TASK_ANNOUNCEMENT_LIMITS = Object.freeze({
  title: 80,
  body: 200,
} as const)

/** Bounded number of Sessions whose pending assistant line is retained. */
const MAX_PENDING_TEXT = 128

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function turnNumber(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function turnData(value: unknown): { turn: number; completed: boolean } {
  const data = record(value)
  if (data === undefined) return { turn: 0, completed: false }
  const reason = data.reason as { readonly kind?: unknown } | string | null | undefined
  const completed = typeof reason === 'string'
    ? reason === 'completed'
    : reason !== null && typeof reason === 'object' && (reason as { readonly kind?: unknown }).kind === 'completed'
  return { turn: turnNumber(data.turn), completed }
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu
const PLACEHOLDER = /\[(?:redacted|path|url)\]/gu

/**
 * Remove text that must never reach a lock screen: URLs, filesystem paths and
 * common credential shapes. The body comes from a user-visible assistant
 * message, not from logs, but a model can still quote a path or a token.
 */
function redactSensitive(text: string): string {
  return text
    .replace(/\b(?:https?|file):\/\/\S+/giu, '[url]')
    .replace(/(?:^|\s)[A-Za-z]:\\[^\s]+/gu, ' [path]')
    .replace(/(?:^|\s)\/(?:[^\s/]+\/)+[^\s]*/gu, ' [path]')
    .replace(/(?:^|\s)~\/[^\s]+/gu, ' [path]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/gu, '[redacted]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/gu, '[redacted]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/giu, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|token|secret|password|passwd)\s*[:=]\s*['"]?[^\s'"]{4,}/giu, '$1=[redacted]')
}

function boundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = redactSensitive(
    value.normalize('NFC').replace(CONTROL_CHARACTERS, ' ').replace(/\s+/gu, ' ').trim(),
  ).trim()
  // A body that consisted only of a redacted path/token carries no useful text.
  if (normalized === '' || normalized.replace(PLACEHOLDER, '').trim() === '') return undefined
  const characters = Array.from(normalized)
  return characters.length > limit ? characters.slice(0, limit).join('').trim() : normalized
}

/**
 * Build the optional wire text. Both fields are present or both are absent:
 * a title without a body (or vice versa) would make the App mix plugin text
 * with its fixed fallback strings.
 */
export function taskAnnouncementText(
  title: unknown,
  body: unknown,
): { readonly title: string; readonly body: string } | undefined {
  const boundedTitle = boundedText(title, TASK_ANNOUNCEMENT_LIMITS.title)
  const boundedBody = boundedText(body, TASK_ANNOUNCEMENT_LIMITS.body)
  if (boundedTitle === undefined || boundedBody === undefined) return undefined
  return Object.freeze({ title: boundedTitle, body: boundedBody })
}

/** Extract the concatenated text parts of an assistant message event. */
export function assistantMessageText(event: TaskTurnEvent): string | undefined {
  const data = record(event.data)
  const message = record(data?.message)
  const content = message?.content
  if (typeof content === 'string') return content === '' ? undefined : content
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const part of content) {
    const block = record(part)
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text === '' ? undefined : text
}

function firstNonEmptyLine(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  for (const line of value.split(/\r\n|\r|\n/gu)) {
    const trimmed = line.trim()
    if (trimmed !== '') return trimmed
  }
  return undefined
}

function sessionTitle(
  reader: ((session: TaskEventSession) => unknown) | undefined,
  session: TaskEventSession,
): string | undefined {
  if (reader === undefined) return undefined
  try {
    const value = reader(session)
    return typeof value === 'string' && value.trim() !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Subscribe to completed root turns. Subagent turns are skipped so one task
 * announces once, and rapid turn boundaries collapse into a single event.
 * Returns a disposer that also drops pending debounces.
 */
export function watchTaskCompletions(ctx: TaskEventContext, options: TaskEventWatcherOptions): () => void {
  const debounceMs = options.debounceMs ?? TASK_EVENT_DEBOUNCE_MS
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  /** First non-empty assistant line of the latest turn per root Session. */
  const assistantLines = new Map<string, { turn: number; line: string }>()
  const rememberLine = (sessionId: string, turn: number, line: string): void => {
    if (assistantLines.size >= MAX_PENDING_TEXT && !assistantLines.has(sessionId)) {
      const oldest = assistantLines.keys().next()
      if (!oldest.done) assistantLines.delete(oldest.value)
    }
    const existing = assistantLines.get(sessionId)
    if (existing === undefined || existing.turn !== turn) assistantLines.set(sessionId, { turn, line })
  }
  const disposeListener = ctx.on('session/event', (session, event) => {
    if (session.header?.parentSession !== undefined && session.header?.parentSession !== null) return
    const sessionId = String(session.id)
    if (event.type === 'turn/start') {
      assistantLines.delete(sessionId)
      return
    }
    if (event.type === 'assistant/message') {
      const turn = turnNumber(record(event.data)?.turn)
      const line = firstNonEmptyLine(assistantMessageText(event))
      if (line !== undefined) rememberLine(sessionId, turn, line)
      return
    }
    if (event.type !== 'turn/end') return
    const { turn, completed } = turnData(event.data)
    if (!completed) {
      assistantLines.delete(sessionId)
      return
    }
    const pendingLine = assistantLines.get(sessionId)
    const announcement = taskAnnouncementText(
      sessionTitle(options.readSessionTitle, session),
      pendingLine?.turn === turn ? pendingLine.line : undefined,
    )
    assistantLines.delete(sessionId)
    const previous = pending.get(sessionId)
    if (previous !== undefined) clearTimeout(previous)
    pending.set(sessionId, setTimeout(() => {
      pending.delete(sessionId)
      options.log?.('task-completed-announced', { sessionId, turn })
      options.onTaskCompleted(Object.freeze({
        sessionId,
        turn,
        ...(announcement === undefined ? {} : announcement),
      }))
    }, debounceMs))
  })
  return () => {
    disposeListener()
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
    assistantLines.clear()
  }
}

/** Receives fanned-out completion events (normally a mobile gateway). */
export interface TaskEventSink {
  broadcastTaskEvent(event: TaskCompletionEvent): void
}

/** One subscription feeding every live gateway; gateways register on start. */
export class TaskEventHub {
  private readonly sinks = new Set<TaskEventSink>()

  /** Register a sink; returns its disposer. */
  add(sink: TaskEventSink): () => void {
    this.sinks.add(sink)
    return () => { this.sinks.delete(sink) }
  }

  /** Fan out to a snapshot so a failing sink cannot break its siblings. */
  broadcast(event: TaskCompletionEvent): void {
    for (const sink of [...this.sinks]) {
      try { sink.broadcastTaskEvent(event) } catch { /* A failing gateway must not break its siblings. */ }
    }
  }

  /** Visible for tests. */
  get size(): number {
    return this.sinks.size
  }
}
