import { describe, expect, it, vi } from 'vitest'
import type {
  TaskCompletionEvent,
  TaskEventSession,
  TaskTurnEvent,
} from '../src/task-events.js'
import {
  TASK_ANNOUNCEMENT_LIMITS,
  TaskEventHub,
  watchTaskCompletions,
} from '../src/task-events.js'

type Handler = (session: TaskEventSession, event: TaskTurnEvent) => void

function context(readSessionTitle?: (session: TaskEventSession) => unknown) {
  const handlers: Handler[] = []
  const announced: TaskCompletionEvent[] = []
  const events: Array<[string, Readonly<Record<string, string | number | boolean>>]> = []
  const dispose = watchTaskCompletions(
    { on: (_event: 'session/event', handler: Handler) => { handlers.push(handler); return () => undefined } },
    {
      debounceMs: 5,
      readSessionTitle,
      onTaskCompleted: event => { announced.push(event) },
      log: (event, fields) => { events.push([event, fields]) },
    },
  )
  return { handlers, announced, events, dispose }
}

function turnEnd(reason: unknown, turn = 3): TaskTurnEvent {
  return { type: 'turn/end', data: { turn, reason: reason as { kind: string } } }
}

function assistantMessage(text: string, turn = 3): TaskTurnEvent {
  return {
    type: 'assistant/message',
    data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }
}

const root = { id: 'session-1', header: {} }
const child = { id: 'session-2', header: { parentSession: 'session-1' } }

describe('task completion watcher', () => {
  it('announces a completed root turn after debouncing', async () => {
    const { handlers, announced } = context()
    handlers.forEach(handler => { handler(root, turnEnd({ kind: 'completed' })) })
    expect(announced).toEqual([])
    await vi.waitFor(() => { expect(announced).toEqual([{ sessionId: 'session-1', turn: 3 }]) })
  })

  it('ignores non-completed reasons and unrelated events', async () => {
    const { handlers, announced } = context()
    handlers.forEach(handler => {
      handler(root, turnEnd({ kind: 'aborted' }))
      handler(root, turnEnd({ kind: 'error' }))
      handler(root, { type: 'turn/start', data: { turn: 3 } })
      handler(root, { type: 'assistant/message', data: { turn: 3 } })
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(announced).toEqual([])
  })

  it('skips subagent turns so one task announces once', async () => {
    const { handlers, announced } = context()
    handlers.forEach(handler => { handler(child, turnEnd({ kind: 'completed' })) })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(announced).toEqual([])
  })

  it('collapses rapid turn boundaries into a single announcement', async () => {
    const { handlers, announced } = context()
    handlers.forEach(handler => {
      handler(root, turnEnd({ kind: 'completed' }, 3))
      handler(root, turnEnd({ kind: 'completed' }, 4))
    })
    await vi.waitFor(() => { expect(announced).toHaveLength(1) })
    expect(announced).toEqual([{ sessionId: 'session-1', turn: 4 }])
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(announced).toHaveLength(1)
  })

  it('drops pending debounces on dispose', async () => {
    const { handlers, announced, dispose } = context()
    handlers.forEach(handler => { handler(root, turnEnd({ kind: 'completed' })) })
    dispose()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(announced).toEqual([])
  })

  it('derives the Session title and the first assistant line for the wire', async () => {
    const { handlers, announced, events } = context(() => 'Fix login')
    handlers.forEach(handler => {
      handler(root, assistantMessage('\n\n  Login fixed.\nSecond line', 3))
      handler(root, turnEnd({ kind: 'completed' }, 3))
    })
    await vi.waitFor(() => {
      expect(announced).toEqual([{ sessionId: 'session-1', turn: 3, title: 'Fix login', body: 'Login fixed.' }])
    })
    // Content never goes to the log line, only opaque ids do.
    expect(events.at(-1)).toEqual(['task-completed-announced', { sessionId: 'session-1', turn: 3 }])
  })

  it('omits both text fields when either side is unavailable', async () => {
    const noBody = context(() => 'Fix login')
    noBody.handlers.forEach(handler => { handler(root, turnEnd({ kind: 'completed' }, 3)) })
    await vi.waitFor(() => { expect(noBody.announced).toEqual([{ sessionId: 'session-1', turn: 3 }]) })

    const noTitle = context()
    noTitle.handlers.forEach(handler => {
      handler(root, assistantMessage('Login fixed.', 3))
      handler(root, turnEnd({ kind: 'completed' }, 3))
    })
    await vi.waitFor(() => { expect(noTitle.announced).toEqual([{ sessionId: 'session-1', turn: 3 }]) })
  })

  it('bounds, normalizes and redacts paths, URLs and credentials', async () => {
    const { handlers, announced } = context(() => `  ${'T'.repeat(200)}\u0000 title  `)
    handlers.forEach(handler => {
      handler(root, assistantMessage('Open https://secret.example.invalid/x and C:\\Users\\me\\key.txt with token=abcdefgh', 3))
      handler(root, turnEnd({ kind: 'completed' }, 3))
    })
    await vi.waitFor(() => expect(announced).toHaveLength(1))
    const event = announced[0]!
    expect(event.title).toHaveLength(TASK_ANNOUNCEMENT_LIMITS.title)
    expect(event.title).not.toContain('\u0000')
    expect(event.body!.length).toBeLessThanOrEqual(TASK_ANNOUNCEMENT_LIMITS.body)
    expect(event.body).not.toContain('secret.example.invalid')
    expect(event.body).not.toContain('C:\\Users')
    expect(event.body).not.toContain('abcdefgh')
    expect(event.body).toContain('[url]')
    expect(event.body).toContain('[path]')
    expect(event.body).toContain('token=[redacted]')
  })

  it('truncates an over-long first line to the wire bound', async () => {
    const { handlers, announced } = context(() => 'Long answer')
    handlers.forEach(handler => {
      handler(root, assistantMessage('B'.repeat(400), 3))
      handler(root, turnEnd({ kind: 'completed' }, 3))
    })
    await vi.waitFor(() => expect(announced).toHaveLength(1))
    expect(announced[0]?.body).toHaveLength(TASK_ANNOUNCEMENT_LIMITS.body)
  })

  it('omits the pair when the body was only a path or credential', async () => {
    const { handlers, announced } = context(() => 'Fix login')
    handlers.forEach(handler => {
      handler(root, assistantMessage('C:\\Users\\me\\secret.txt', 3))
      handler(root, turnEnd({ kind: 'completed' }, 3))
    })
    await vi.waitFor(() => { expect(announced).toEqual([{ sessionId: 'session-1', turn: 3 }]) })
  })

  it('ignores assistant text from a different turn or a subagent session', async () => {
    const { handlers, announced } = context(() => 'Fix login')
    handlers.forEach(handler => {
      handler(root, assistantMessage('Stale turn text', 2))
      handler(root, turnEnd({ kind: 'completed' }, 3))
    })
    await vi.waitFor(() => { expect(announced).toEqual([{ sessionId: 'session-1', turn: 3 }]) })

    const subagent = context(() => 'Fix login')
    subagent.handlers.forEach(handler => {
      handler(child, assistantMessage('Child text', 3))
      handler(child, turnEnd({ kind: 'completed' }, 3))
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(subagent.announced).toEqual([])
  })
})

describe('task event hub', () => {
  it('fans out to every sink and isolates failures', () => {
    const hub = new TaskEventHub()
    const first: TaskCompletionEvent[] = []
    const failures: Error[] = []
    const disposeFirst = hub.add({ broadcastTaskEvent: event => { first.push(event) } })
    hub.add({
      broadcastTaskEvent: () => { throw new Error('gateway gone'); },
    })
    expect(hub.size).toBe(2)
    expect(() => { hub.broadcast({ sessionId: 's', turn: 1 }) }).not.toThrow()
    expect(first).toEqual([{ sessionId: 's', turn: 1 }])
    disposeFirst()
    expect(hub.size).toBe(1)
    expect(failures).toEqual([])
  })
})
