import { describe, expect, it } from 'vitest'
import {
  MOBILE_CLIENT_GRAPH_PATH, createMobileGraphRefresher, mobileGraphFrameRefresh, readMobileClientGraph,
} from '../src/mobile-graph-follower.js'

const OWNED_ROWS = new Set(['@deepseek-ai/dsh-client-ui-layout', '@deepseek-ai/dsh-client-hmr'])

describe('Mobile graph refresh ownership', () => {
  it('coalesces changes while fetching and never applies a response after disposal', async () => {
    const pending: { signal: AbortSignal; response: ReturnType<typeof Promise.withResolvers<unknown>> }[] = []
    const applied: unknown[] = []
    const refresher = createMobileGraphRefresher(signal => {
      const response = Promise.withResolvers<unknown>()
      pending.push({ signal, response })
      return response.promise
    }, async value => { applied.push(value) }, () => undefined)
    refresher.refresh()
    refresher.refresh()
    refresher.refresh()
    expect(pending).toHaveLength(1)
    pending[0]!.response.resolve('first projected graph')
    await Promise.resolve()
    await Promise.resolve()
    expect(pending).toHaveLength(2)
    const disposed = refresher.dispose()
    expect(pending[1]!.signal.aborted).toBe(true)
    pending[1]!.response.resolve('stale graph')
    await disposed
    expect(applied).toEqual(['first projected graph'])
  })
})

describe('Mobile graph frame mapping', () => {
  it('refreshes the projection for a graph change and a rebuild of a row Mobile does not own', () => {
    expect(mobileGraphFrameRefresh({ type: 'graph', graph: { rev: 'g' } }, OWNED_ROWS)).toBe(true)
    expect(mobileGraphFrameRefresh({ type: 'rebuilt', id: 'feature', rev: 'r2' }, OWNED_ROWS)).toBe(true)
  })

  it('leaves snapshots to the stream, which already refreshes on every baseline', () => {
    // Snapshots reach `replace`, never this predicate; a baseline passed here is not an incremental change.
    expect(mobileGraphFrameRefresh({ type: 'baseline', graph: { rev: 'b' } }, OWNED_ROWS)).toBe(false)
  })

  it('ignores rebuilds of Mobile-owned rows and frames it cannot classify', () => {
    for (const id of OWNED_ROWS) {
      expect(mobileGraphFrameRefresh({ type: 'rebuilt', id, rev: 'x' }, OWNED_ROWS)).toBe(false)
    }
    for (const frame of [null, undefined, 'graph', [], { type: 'unknown' }, { type: 'rebuilt' }, { type: 'rebuilt', id: 7 }]) {
      expect(mobileGraphFrameRefresh(frame, OWNED_ROWS)).toBe(false)
    }
  })
})

describe('Mobile graph refresh request', () => {
  it('asks the gateway for this document’s view without caching', async () => {
    const calls: unknown[] = []
    const controller = new AbortController()
    const request = (async (...args: Parameters<typeof fetch>) => {
      calls.push(args)
      return new Response(JSON.stringify({ rev: 'projected', entries: [] }), { status: 200 })
    }) as typeof fetch
    const graph = await readMobileClientGraph('a'.repeat(32), controller.signal, request)
    expect(calls).toEqual([[
      MOBILE_CLIENT_GRAPH_PATH,
      { headers: { 'x-dsh-mobile-view': 'a'.repeat(32) }, credentials: 'same-origin', cache: 'no-store', signal: controller.signal },
    ]])
    expect(graph).toEqual({ rev: 'projected', entries: [] })
  })

  it('rejects a refused view instead of handing back an error document', async () => {
    const request = (async () => new Response(JSON.stringify({ error: 'mobile_document_view_invalid' }), { status: 409 })) as typeof fetch
    await expect(readMobileClientGraph('0'.repeat(32), new AbortController().signal, request)).rejects.toThrow('HTTP 409')
  })
})
