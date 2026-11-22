import type { Context } from '@deepseek-ai/cordis'
import { RemoteSnapshotStream, RemoteStreamCarrierError, type ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import pluginEventsRemote from '@deepseek-ai/dsh-client-hmr/remote'
import type { PluginsEventBaseline, PluginsEventFrame, PluginsEventIncrement } from '@deepseek-ai/dsh-client-hmr/types'
import { createMobileGraphRefresher, mobileGraphFrameRefresh, readMobileClientGraph } from '../../../src/mobile-graph-follower.js'

interface Access {
  whenAccess(endpoint: string, start: () => () => Promise<void>): unknown
}
interface ModuleEntries { sync(graph: unknown): Promise<void> }
/** The generated `pluginEvents` Client method, mounted by the Remote contribution below. */
interface PluginEvents { follow(signal: AbortSignal): AsyncIterable<PluginsEventFrame> }
/** Failures a Host reload produces while it withdraws `pluginEvents` with the socket still open. */
const RELOADING: ReadonlySet<string> = new Set(['gateway/invocation-unavailable', 'gateway/service-unavailable'])

export const name = 'dsh-mobile-graph-follower'
export const inject = ['modules', 'remote', 'remoteAccess']

/**
 * Follow the same DSH Remote plugin stream with DSH's reconnect behavior, but
 * reconcile only graphs projected by the Mobile gateway for this document.
 * The stock frames carry the unadapted Host graph, which would unload the
 * dedicated layout and any module selection saved for this device.
 */
export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const view = (globalThis as { __DSH_MOBILE_GRAPH_VIEW__?: string }).__DSH_MOBILE_GRAPH_VIEW__
  if (typeof view !== 'string' || !/^[a-f0-9]{32}$/u.test(view)) throw new Error('DSH Mobile graph follower has no dedicated document view')
  const remote = ctx.get('remote') as ClientRemote
  const access = ctx.get('remoteAccess') as Access
  const { entries } = ctx.get('modules') as { entries: ModuleEntries }
  const unmount = await remote.$mount(pluginEventsRemote)
  try {
    const events = ctx.get('remote.pluginEvents') as PluginEvents | undefined
    if (events === undefined) throw new Error('DSH Mobile graph follower: the mounted pluginEvents namespace is not registered')
    access.whenAccess('pluginEvents/follow', () => {
      const projector = createMobileGraphRefresher(
        signal => readMobileClientGraph(view, signal),
        graph => entries.sync(graph),
        () => { ctx.logger.warn('DSH Mobile: plugin graph refresh failed; the dedicated layout is kept until the next change') },
      )
      const stream = remote.$stream<PluginsEventFrame>({
        name: 'DSH Mobile plugin events',
        // A Host-side end (the service restarting) reconnects rather than ending the logical stream.
        open: async function* (signal) {
          try {
            yield* events.follow(signal)
          } catch (error) {
            if (error instanceof Error && 'code' in error && RELOADING.has(String(error.code))) {
              throw new RemoteStreamCarrierError('Plugin events are unavailable while the Host reloads', { cause: error })
            }
            throw error
          }
        },
        ended: () => Object.assign(new Error('DSH Mobile plugin events ended'), { code: 'gateway/carrier-lost' as const }),
      })
      const control = new RemoteSnapshotStream<PluginsEventBaseline, PluginsEventIncrement>(stream, {
        name: 'DSH Mobile plugin events',
        isSnapshot: (frame): frame is PluginsEventBaseline => frame.type === 'baseline',
        replace: () => projector.refresh(),
        update: frame => { if (mobileGraphFrameRefresh(frame)) projector.refresh() },
        failed: () => { ctx.logger.warn('DSH Mobile: live plugin graph updates stopped; reload the page to refresh the layout') },
      })
      control.start()
      return async () => { await Promise.all([projector.dispose(), control.dispose()]) }
    })
    return unmount
  } catch (error) {
    await unmount()
    throw error
  }
}
