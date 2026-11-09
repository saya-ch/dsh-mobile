import { describe, expect, it, vi } from 'vitest'
import type { PushTarget } from '../src/mobile-push/contracts.js'
import { installPushNavigation } from '../src/mobile-push/navigation.js'

function fixture(search: string) {
  let sessionListener = () => {}
  let workspaceListener = () => {}
  const sessionState = { phase: 'pending' as 'pending' | 'ready', byId: {} as Record<string, unknown>, ids: [] as string[] }
  const workspaceState = { phase: 'pending' as 'pending' | 'ready', items: [] as unknown[] }
  const opened: string[] = []
  const notices: string[] = []
  const history = { replaceState: vi.fn((_state: unknown, _title: string, url?: string | URL | null) => { location.search = new URL(String(url), location.href).search }) }
  const location = { href: `https://mobile.example.test/${search}`, search }
  const ctx = {
    sessions: { list: { getSnapshot: () => sessionState, subscribe: (fn: () => void) => { sessionListener = fn; return () => { sessionListener = () => {} } } } },
    workspaces: { list: { getSnapshot: () => workspaceState, subscribe: (fn: () => void) => { workspaceListener = fn; return () => { workspaceListener = () => {} } } } },
    uiWorkspace: { openSession: (id: string) => opened.push(id) },
  }
  return { ctx, location, history, opened, notices, ready: () => { sessionState.phase = 'ready'; workspaceState.phase = 'ready'; sessionListener(); workspaceListener() },
    addSession: (id: string) => { sessionState.byId[id] = { id }; sessionState.ids.push(id) } }
}

describe('authenticated mobile push navigation', () => {
  it('waits for actual public Workspace and Session readiness, strips the ref, and opens an existing target once', async () => {
    const f = fixture('?mobile-push=opaque-ref')
    const resolve = vi.fn(async (): Promise<PushTarget | undefined> => ({ sessionId: 'session-1', interaction: 'current' }))
    const stop = installPushNavigation(f.ctx as never, { resolve, notify: key => f.notices.push(key), browser: { location: f.location as never, history: f.history as never } })
    expect(resolve).not.toHaveBeenCalled()
    f.addSession('session-1'); f.ready(); await vi.waitFor(() => expect(f.opened).toEqual(['session-1']))
    expect(f.history.replaceState).toHaveBeenCalledOnce()
    expect(f.location.search).toBe('')
    expect(resolve).toHaveBeenCalledWith('opaque-ref')
    f.ready(); expect(f.opened).toEqual(['session-1'])
    stop()
  })

  it.each([
    ['expired ref', async () => undefined],
    ['foreign ref', async () => undefined],
    ['missing session', async () => ({ sessionId: 'gone', interaction: 'current' } as const)],
    ['unknown interaction state', async () => ({ sessionId: 's1', interaction: 'future' } as unknown as PushTarget)],
  ])('%s shows neutral fallback without opening', async (_label, resolve) => {
    const f = fixture('?mobile-push=opaque-ref'); f.addSession('s1')
    const stop = installPushNavigation(f.ctx as never, { resolve, notify: key => f.notices.push(key), browser: { location: f.location as never, history: f.history as never } })
    f.ready(); await vi.waitFor(() => expect(f.history.replaceState).toHaveBeenCalledOnce())
    expect(f.opened).toEqual([]); expect(f.notices).toEqual(['session-unavailable']); expect(f.location.search).toBe('')
    stop()
  })

  it('opens a resolved target only as a session and does not answer or reopen an interaction', async () => {
    const f = fixture('?mobile-push=resolved-ref'); f.addSession('s1')
    const stop = installPushNavigation(f.ctx as never, { resolve: async () => ({ sessionId: 's1', interaction: 'resolved' }), notify: key => f.notices.push(key), browser: { location: f.location as never, history: f.history as never } })
    f.ready(); await vi.waitFor(() => expect(f.opened).toEqual(['s1']))
    expect(f.notices).toEqual(['session-resolved']); expect(f.opened).toHaveLength(1)
    stop()
  })

  it('uses the session-list fallback for a URL without a ref', () => {
    const f = fixture('')
    const stop = installPushNavigation(f.ctx as never, { resolve: vi.fn(), notify: key => f.notices.push(key), browser: { location: f.location as never, history: f.history as never } })
    expect(f.notices).toEqual(['session-unavailable']); expect(f.opened).toEqual([]); stop()
  })
})
