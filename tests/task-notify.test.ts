import { describe, expect, it } from 'vitest'
import {
  fireTaskNotifyEvent,
  hasPendingInputQuestion,
  observeTaskActivity,
  parseTaskNotifyPayload,
  pendingInputQuestionKey,
  readComposerBusyState,
  readSessionLabel,
  TASK_NOTIFY_LIMITS,
  TASK_NOTIFY_QUIET_MS,
  taskCompletionTag,
  TaskNotifyTracker,
} from '../src/task-notify.js'

function format(kind: 'done' | 'question', sessionLabel: string): { title: string; body: string } {
  return kind === 'done'
    ? { title: 'Task finished', body: sessionLabel === '' ? 'DSH task finished' : `DSH task finished: ${sessionLabel}` }
    : { title: 'Input needed', body: 'DSH waits for your choice' }
}

function trackerAt(startMs = 1_000_000) {
  let now = startMs
  const tracker = new TaskNotifyTracker({ quietMs: 90_000, now: () => now, format })
  return { tracker, advance: (ms: number) => { now += ms } }
}

function hiddenSnapshot(overrides: Partial<Parameters<TaskNotifyTracker['evaluate']>[0]> = {}) {
  return {
    pageHidden: true, pendingQuestion: false, questionKey: undefined, sessionLabel: 'demo', composerBusy: false,
    ...overrides,
  }
}

describe('task completion tracker', () => {
  it('notifies once after the quiet period, then stays silent until new activity', () => {
    const { tracker, advance } = trackerAt()
    tracker.markActivity()
    expect(tracker.evaluate(hiddenSnapshot())).toBeUndefined()
    advance(TASK_NOTIFY_QUIET_MS - 1)
    expect(tracker.evaluate(hiddenSnapshot())).toBeUndefined()
    advance(1)
    const event = tracker.evaluate(hiddenSnapshot())
    expect(event?.kind).toBe('done')
    expect(event?.tag).toBe('dsh-task-done')
    expect(tracker.evaluate(hiddenSnapshot())).toBeUndefined()
    tracker.markActivity()
    advance(TASK_NOTIFY_QUIET_MS)
    expect(tracker.evaluate(hiddenSnapshot())?.kind).toBe('done')
  })

  it('stays silent while the page is visible and without any activity', () => {
    const { tracker, advance } = trackerAt()
    expect(tracker.evaluate({ ...hiddenSnapshot(), pageHidden: false })).toBeUndefined()
    tracker.markActivity()
    advance(TASK_NOTIFY_QUIET_MS * 2)
    expect(tracker.evaluate({ ...hiddenSnapshot(), pageHidden: false })).toBeUndefined()
  })

  it('never announces a stale run', () => {
    const { tracker, advance } = trackerAt()
    tracker.markActivity()
    advance(31 * 60_000)
    expect(tracker.evaluate(hiddenSnapshot())).toBeUndefined()
    // The stale activity is dropped, so later silence alone cannot notify.
    advance(TASK_NOTIFY_QUIET_MS)
    expect(tracker.evaluate(hiddenSnapshot())).toBeUndefined()
  })

  it('notifies a waiting question immediately and deduplicates its key', () => {
    const { tracker } = trackerAt()
    const first = tracker.evaluate(hiddenSnapshot({ pendingQuestion: true, questionKey: 'q-1' }))
    expect(first?.kind).toBe('question')
    expect(first?.tag).toBe('dsh-task-question-q-1')
    expect(tracker.evaluate(hiddenSnapshot({ pendingQuestion: true, questionKey: 'q-1' }))).toBeUndefined()
    expect(tracker.evaluate(hiddenSnapshot({ pendingQuestion: true, questionKey: 'q-2' }))?.kind).toBe('question')
  })

  it('suppresses completion while input is pending and remembers seen questions', () => {
    const { tracker, advance } = trackerAt()
    tracker.markActivity()
    advance(TASK_NOTIFY_QUIET_MS * 2)
    // Visible question: no notify, but the key is remembered.
    expect(tracker.evaluate({ ...hiddenSnapshot({ pendingQuestion: true, questionKey: 'q-9' }), pageHidden: false })).toBeUndefined()
    expect(tracker.evaluate(hiddenSnapshot({ pendingQuestion: true, questionKey: 'q-9' }))).toBeUndefined()
    // Resolved elsewhere with the run long quiet: completion fires.
    expect(tracker.evaluate(hiddenSnapshot())?.kind).toBe('done')
  })

  it('anchors the quiet clock on the busy-to-idle transition', () => {
    const { tracker, advance } = trackerAt()
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: true }))).toBeUndefined()
    advance(TASK_NOTIFY_QUIET_MS * 2)
    // Still busy: no completion while the run holds the composer.
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: true }))).toBeUndefined()
    tracker.markActivity()
    // Busy since the first observation: long enough to announce at once.
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: false }))?.kind).toBe('done')
  })

  it('exposes the pending anchor delay for exact timer scheduling', () => {
    const { tracker, advance } = trackerAt()
    expect(tracker.pendingAnchorDelayMs()).toBeUndefined()
    tracker.evaluate(hiddenSnapshot({ composerBusy: true }))
    expect(tracker.pendingAnchorDelayMs()).toBeUndefined()
    tracker.evaluate(hiddenSnapshot({ composerBusy: false }))
    expect(tracker.pendingAnchorDelayMs()).toBe(10_000)
    advance(4_000)
    expect(tracker.pendingAnchorDelayMs()).toBe(6_000)
    advance(6_000)
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: false }))?.kind).toBe('done')
    expect(tracker.pendingAnchorDelayMs()).toBeUndefined()
  })

  it('announces a long run the moment it ends', () => {
    const { tracker, advance } = trackerAt()
    tracker.evaluate(hiddenSnapshot({ composerBusy: true }))
    advance(25_000)
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: false }))?.kind).toBe('done')
    // Already announced: stays silent without new activity.
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: false }))).toBeUndefined()
  })

  it('holds a short run for the grace period instead of announcing at once', () => {
    const { tracker, advance } = trackerAt()
    tracker.evaluate(hiddenSnapshot({ composerBusy: true }))
    advance(5_000)
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: false }))).toBeUndefined()
    advance(9_999)
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: false }))).toBeUndefined()
    advance(1)
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: false }))?.kind).toBe('done')
  })

  it('prefers the waiting question over an ending run', () => {
    const { tracker, advance } = trackerAt()
    tracker.evaluate(hiddenSnapshot({ composerBusy: true }))
    advance(25_000)
    const event = tracker.evaluate(hiddenSnapshot({ composerBusy: false, pendingQuestion: true, questionKey: 'q-x' }))
    expect(event?.kind).toBe('question')
  })

  it('announces completion right after the grace period without waiting out quiet', () => {    const { tracker, advance } = trackerAt()
    tracker.evaluate(hiddenSnapshot({ composerBusy: true }))
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: false }))).toBeUndefined()
    advance(9_999)
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: false }))).toBeUndefined()
    advance(1)
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: false }))?.kind).toBe('done')
    // Already announced: stays silent without new activity.
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: false }))).toBeUndefined()
  })

  it('absorbs composer flicker inside the grace period', () => {
    const { tracker, advance } = trackerAt()
    tracker.evaluate(hiddenSnapshot({ composerBusy: true }))
    tracker.evaluate(hiddenSnapshot({ composerBusy: false }))
    advance(5_000)
    // Busy again before grace elapsed: the pending announcement is dropped.
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: true }))).toBeUndefined()
    advance(60_000)
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: true }))).toBeUndefined()
  })

  it('treats an ending watched on screen as seen', () => {
    const { tracker, advance } = trackerAt()
    tracker.evaluate(hiddenSnapshot({ composerBusy: true, pageHidden: false }))
    tracker.evaluate(hiddenSnapshot({ composerBusy: false, pageHidden: false }))
    // Backgrounding later with no new activity stays silent.
    advance(TASK_NOTIFY_QUIET_MS * 2)
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: false }))).toBeUndefined()
    // A new run re-arms normally.
    tracker.markActivity()
    advance(TASK_NOTIFY_QUIET_MS)
    expect(tracker.evaluate(hiddenSnapshot({ composerBusy: false }))?.kind).toBe('done')
  })

  it('reads the composer busy signal like the media actions do', () => {
    const idle = {
      querySelector: (selectors: string) => selectors.includes('[data-composer-card]')
        ? {
            getAttribute: () => null,
            querySelector: () => ({ disabled: false, readOnly: false, getAttribute: () => null }),
          }
        : null,
    } as unknown as ParentNode
    expect(readComposerBusyState(idle)).toBe(false)
    const busyAria = {
      querySelector: () => ({ getAttribute: (name: string) => name === 'aria-busy' ? 'true' : null, querySelector: () => null }),
    } as unknown as ParentNode
    expect(readComposerBusyState(busyAria)).toBe(true)
    const busyDisabled = {
      querySelector: () => ({
        getAttribute: () => null,
        querySelector: () => ({ disabled: true, readOnly: false, getAttribute: () => null }),
      }),
    } as unknown as ParentNode
    expect(readComposerBusyState(busyDisabled)).toBe(true)
    expect(readComposerBusyState({ querySelector: () => null } as unknown as ParentNode)).toBe(false)
    expect(readComposerBusyState({} as ParentNode)).toBe(false)
  })

  it('bounds session labels for the wire', () => {
    expect(readSessionLabel(undefined)).toBe('')
    expect(readSessionLabel('  demo session  ')).toBe('demo session')
    expect(readSessionLabel('x'.repeat(200)).length).toBe(80)
    expect(readSessionLabel('a\u0000b')).toBe('a b')
  })

  it('parses host-pushed payloads and rejects malformed frames', () => {
    expect(parseTaskNotifyPayload('{"sessionId":"s-1","turn":2}')).toEqual({ sessionId: 's-1', turn: 2 })
    expect(parseTaskNotifyPayload('{"sessionId":"s-1"}')).toEqual({ sessionId: 's-1', turn: 0 })
    expect(parseTaskNotifyPayload('not-json')).toBeUndefined()
    expect(parseTaskNotifyPayload('{"sessionId":""}')).toBeUndefined()
    expect(parseTaskNotifyPayload('{"sessionId":42}')).toBeUndefined()
    expect(parseTaskNotifyPayload(null)).toBeUndefined()
    expect(parseTaskNotifyPayload(['s-1'])).toBeUndefined()
  })

  it('stays silent without a native bridge', () => {
    expect(fireTaskNotifyEvent({ kind: 'done', title: 't', body: 'b', tag: 'dsh-task-done' })).toBe(false)
  })

  it('uses safe bounded tags for arbitrary question keys', () => {
    const { tracker } = trackerAt()
    const event = tracker.evaluate(hiddenSnapshot({ pendingQuestion: true, questionKey: 'Q 1/2: pick!' }))
    expect(event?.tag).toBe('dsh-task-question-q-1-2-pick')
    expect(event?.tag.length).toBeLessThanOrEqual(TASK_NOTIFY_LIMITS.tag)
  })

  it('keeps completed turns separate with bounded native tags', () => {
    expect(taskCompletionTag('session-a', 1)).toBe('dsh-task-done-session-a-1')
    expect(taskCompletionTag('session-a', 2)).not.toBe(taskCompletionTag('session-a', 1))
    expect(taskCompletionTag('x'.repeat(200), 3).length).toBeLessThanOrEqual(TASK_NOTIFY_LIMITS.tag)
  })
})

describe('task activity DOM adapters', () => {
  it('detects pending input cards through stable markers', () => {
    const none = { querySelector: () => null } as unknown as ParentNode
    expect(hasPendingInputQuestion(none)).toBe(false)
    expect(pendingInputQuestionKey(none)).toBeUndefined()
    const card = {
      querySelector: (selectors: string) => selectors.includes('[data-question-key]')
        ? { getAttribute: (name: string) => name === 'data-question-key' ? 'abc' : null }
        : null,
    } as unknown as ParentNode
    expect(hasPendingInputQuestion(card)).toBe(true)
    expect(pendingInputQuestionKey(card)).toBe('abc')
  })

  it('observes mutations and disposes cleanly', () => {
    let observed: MutationCallback | undefined
    let disconnected = false
    let calls = 0
    class FakeObserver {
      constructor(callback: MutationCallback) { observed = callback }
      observe(): void { calls += 1 }
      disconnect(): void { disconnected = true }
    }
    const dispose = observeTaskActivity({} as Node, () => undefined, FakeObserver as unknown as typeof MutationObserver)
    expect(calls).toBe(1)
    dispose()
    expect(disconnected).toBe(true)
    expect(typeof observed).toBe('function')
  })

  it('is inert without a MutationObserver implementation', () => {
    expect(observeTaskActivity({} as Node, () => undefined, undefined)()).toBeUndefined()
  })
})
