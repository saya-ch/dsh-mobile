import type { Context } from '@deepseek-ai/cordis'
import type { PushTarget } from './contracts.js'

/** Public frontend services used by this adapter (no private Workspace/UI hooks). */
export type PushNavigationContext = Omit<Context, 'sessions' | 'workspaces' | 'uiWorkspace'> & {
  readonly sessions: { readonly list: { getSnapshot(): { readonly phase: string; readonly byId: Readonly<Record<string, unknown>>; readonly ids: readonly string[] }; subscribe(listener: () => void): () => void } }
  readonly workspaces: { readonly list: { getSnapshot(): { readonly phase: string; readonly items: readonly unknown[] }; subscribe(listener: () => void): () => void } }
  readonly uiWorkspace: { openSession(sessionId: string): void }
}

export interface PushNavigationOptions {
  /** Authenticated Task 5 resolver; opaque reference is never treated as a credential. */
  readonly resolve: (reference: string) => Promise<PushTarget | undefined>
  /** Stable neutral UI notice keys: session-unavailable or session-resolved. */
  readonly notify: (key: string) => void
  /** Browser adapters are injectable for tests/embedded hosts; defaults to public Window APIs. */
  readonly browser?: {
    readonly location: Pick<Location, 'search' | 'pathname' | 'hash'>
    readonly history: Pick<History, 'replaceState'>
  }
}

const REF_PARAMETER = 'mobile-push'

/**
 * Consume one authenticated tap reference after the public Workspace and Session
 * list baselines are ready. Return the disposal function for list subscriptions.
 */
export function installPushNavigation(ctx: Context, options: PushNavigationOptions): () => void {
  const context = ctx as unknown as PushNavigationContext
  const browser = options.browser ?? { location: window.location, history: window.history }
  const params = new URLSearchParams(browser.location.search)
  const reference = params.get(REF_PARAMETER)
  let disposed = false
  let consumed = false
  let resolving = false
  let opened = false

  const clearReference = (): void => {
    if (!params.has(REF_PARAMETER)) return
    params.delete(REF_PARAMETER)
    const query = params.toString()
    const url = `${browser.location.pathname}${query ? `?${query}` : ''}${browser.location.hash}`
    browser.history.replaceState(null, '', url)
  }
  const neutral = (key = 'session-unavailable'): void => {
    if (disposed || consumed) return
    consumed = true
    clearReference()
    options.notify(key)
  }

  const check = (): void => {
    if (disposed || consumed || resolving) return
    if (!reference) { neutral(); return }
    const sessions = context.sessions.list.getSnapshot()
    const workspaces = context.workspaces.list.getSnapshot()
    if (sessions.phase !== 'pending' && sessions.phase !== 'ready' || workspaces.phase !== 'pending' && workspaces.phase !== 'ready') {
      neutral()
      return
    }
    if (sessions.phase !== 'ready' || workspaces.phase !== 'ready') return
    if (!reference) { neutral(); return }
    resolving = true
    consumed = true
    clearReference()
    void options.resolve(reference).then(target => {
      if (disposed) return
      if (!target || (target.interaction !== 'current' && target.interaction !== 'resolved') ||
          !sessionsAvailable(context, target.sessionId)) {
        options.notify('session-unavailable')
        return
      }
      if (opened) return
      opened = true
      context.uiWorkspace.openSession(target.sessionId)
      if (target.interaction === 'resolved') options.notify('session-resolved')
    }).catch(() => {
      if (!disposed) options.notify('session-unavailable')
    })
  }

  const unsubscribeSessions = context.sessions.list.subscribe(check)
  const unsubscribeWorkspaces = context.workspaces.list.subscribe(check)
  check()
  return () => {
    if (disposed) return
    disposed = true
    unsubscribeSessions()
    unsubscribeWorkspaces()
  }
}

function sessionsAvailable(ctx: PushNavigationContext, sessionId: string): boolean {
  const snapshot = ctx.sessions.list.getSnapshot()
  return snapshot.phase === 'ready' && snapshot.ids.includes(sessionId) && snapshot.byId[sessionId] !== undefined
}
