/**
 * Host-side task-completion fan-out for phone notifications.
 *
 * The exact moment a run ends is known only on the Host (the phone page can
 * merely infer it from UI state), so this module watches the public
 * `session/event` bus for completed root turns and hands them to a hub that
 * fans out to every live mobile gateway. Phones render the text locally, so
 * no user content crosses this boundary — only opaque session and turn ids.
 */

/** A completed root turn worth announcing on paired phones. */
export interface TaskCompletionEvent {
  readonly sessionId: string
  readonly turn: number
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
  readonly log?: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void
}

export const TASK_EVENT_DEBOUNCE_MS = 1_000

function turnNumber(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function turnData(value: unknown): { turn: number; completed: boolean } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { turn: 0, completed: false }
  const record = value as Record<string, unknown>
  const reason = record.reason as { readonly kind?: unknown } | string | null | undefined
  const completed = typeof reason === 'string'
    ? reason === 'completed'
    : reason !== null && typeof reason === 'object' && (reason as { readonly kind?: unknown }).kind === 'completed'
  return { turn: turnNumber(record.turn), completed }
}

/**
 * Subscribe to completed root turns. Subagent turns are skipped so one task
 * announces once, and rapid turn boundaries collapse into a single event.
 * Returns a disposer that also drops pending debounces.
 */
export function watchTaskCompletions(ctx: TaskEventContext, options: TaskEventWatcherOptions): () => void {
  const debounceMs = options.debounceMs ?? TASK_EVENT_DEBOUNCE_MS
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const disposeListener = ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const { turn, completed } = turnData(event.data)
    if (!completed) return
    if (session.header?.parentSession !== undefined && session.header?.parentSession !== null) return
    const sessionId = String(session.id)
    options.log?.('task-completed-observed', { sessionId, turn })
    const previous = pending.get(sessionId)
    if (previous !== undefined) clearTimeout(previous)
    pending.set(sessionId, setTimeout(() => {
      pending.delete(sessionId)
      options.log?.('task-completed-announced', { sessionId, turn })
      options.onTaskCompleted(Object.freeze({ sessionId, turn }))
    }, debounceMs))
  })
  return () => {
    disposeListener()
    for (const timer of pending.values()) clearTimeout(timer)
    pending.clear()
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
