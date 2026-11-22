/** Gateway route that returns this dedicated document's projected plugin graph. */
export const MOBILE_CLIENT_GRAPH_PATH = '/mobile-access/client-graph'
/** Gateway header naming the dedicated document view a request speaks for. */
export const MOBILE_DOCUMENT_VIEW_HEADER = 'x-dsh-mobile-view'
/** Graph rows whose code Mobile supplies; the page never loads their stock rebuilds. */
export const MOBILE_OWNED_GRAPH_ROWS: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-hmr',
])

/**
 * Whether one incremental `pluginEvents/follow` frame requires a fresh projected graph.
 *
 * Snapshots — the opening baseline and every re-baseline — reach the stream's `replace`
 * and always refresh. A frame's own graph is never applied: it is the stock Host graph,
 * which would replace the dedicated layout. Only the notification is used.
 */
export function mobileGraphFrameRefresh(frame: unknown, ownRows: ReadonlySet<string> = MOBILE_OWNED_GRAPH_ROWS): boolean {
  if (frame === null || typeof frame !== 'object') return false
  const { type, id } = frame as { readonly type?: unknown; readonly id?: unknown }
  if (type === 'graph') return true
  return type === 'rebuilt' && typeof id === 'string' && !ownRows.has(id)
}

/**
 * Read the projected graph for one dedicated document view.
 * The gateway owns projection and refuses a view that is not this Session's.
 */
export async function readMobileClientGraph(
  view: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<unknown> {
  const response = await request(MOBILE_CLIENT_GRAPH_PATH, {
    headers: { [MOBILE_DOCUMENT_VIEW_HEADER]: view }, credentials: 'same-origin', cache: 'no-store', signal,
  })
  if (!response.ok) throw new Error(`Mobile graph refresh was refused with HTTP ${response.status}`)
  return response.json()
}

/** Coalesce Remote notifications while one authenticated graph refresh is in flight. */
export function createMobileGraphRefresher(
  read: (signal: AbortSignal) => Promise<unknown>,
  apply: (graph: unknown) => Promise<void>,
  failed: () => void,
): { refresh: () => void; dispose: () => Promise<void> } {
  const lifetime = new AbortController()
  let pending = false
  let task: Promise<void> | undefined
  const drain = async (): Promise<void> => {
    while (pending && !lifetime.signal.aborted) {
      pending = false
      try {
        const projected = await read(lifetime.signal)
        if (!lifetime.signal.aborted) await apply(projected)
      } catch {
        if (!lifetime.signal.aborted) failed()
      }
    }
  }
  const refresh = (): void => {
    if (lifetime.signal.aborted) return
    pending = true
    task ??= drain().finally(() => {
      task = undefined
      if (pending) refresh()
    })
  }
  return {
    refresh,
    async dispose() {
      pending = false
      lifetime.abort()
      await task
    },
  }
}
