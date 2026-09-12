import { describe, expect, it, vi } from 'vitest'
import type {
  TaskCompletionEvent,
  TaskEventSession,
  TaskTurnEvent,
} from '../src/task-events.js'
import {
  TaskEventHub,
  watchTaskCompletions,
} from '../src/task-events.js'

type Handler = (session: TaskEventSession, event: TaskTurnEvent) => void

function context() {
  const handlers: Handler[] = []
  const announced: TaskCompletionEvent[] = []
  const events: Array<[string, Readonly<Record<string, string | number | boolean>>]> = []
  const dispose = watchTaskCompletions(
    { on: (_event: 'session/event', handler: Handler) => { handlers.push(handler); return () => undefined } },
    {
      debounceMs: 5,
      onTaskCompleted: event => { announced.push(event) },
      log: (event, fields) => { events.push([event, fields]) },
    },
  )
  return { handlers, announced, events, dispose }
}

function turnEnd(reason: unknown, turn = 3): TaskTurnEvent {
  return { type: 'turn/end', data: { turn, reason: reason as { kind: string } } }
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
