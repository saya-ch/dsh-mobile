import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CATALOG_CACHE_METHODS,
  CATALOG_MUTATION_METHODS,
  DEFAULT_CATALOG_CACHE_LIMITS,
  CatalogCache,
  checkCatalogRequest,
  restampEnvelope,
  validateCatalogEnvelope,
  type CatalogFillOutcome,
  type CatalogReplayResult,
  type CatalogServeResult,
} from '../src/catalog-cache.js'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const identity = (digest: string): { identityDigest: string } => ({ identityDigest: digest })

const snapshot = { cookie: 'upstream-cookie-a' }

const envelope = (rpcId: string, model = 'composer-model-0'): string =>
  JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value: { default: { provider: 'p', model } } } })

const request = (method: string, rpcId: string, args: unknown = {}): string =>
  JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })

const bodyRpcId = (body: string): unknown => (JSON.parse(body) as { rpcId: unknown }).rpcId

class FakeClock {
  now = 1_000

  readonly tick = (): number => this.now

  advance(ms: number): void {
    this.now += ms
  }
}

const fillOutcome = (rpcId: string, model?: string): CatalogFillOutcome =>
  ({ shareable: true, envelopeJson: envelope(rpcId, model), upstreamRpcId: rpcId })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('catalog request eligibility', () => {
  it('accepts both allowlisted methods with the verified envelope shape', () => {
    for (const method of CATALOG_CACHE_METHODS) {
      expect(checkCatalogRequest(method, request(method, 'rpc-1'))).toEqual({ method, rpcId: 'rpc-1' })
    }
  })

  it('rejects unknown methods before any fill', () => {
    expect(checkCatalogRequest('session/prompt', request('session/prompt', 'rpc-1'))).toBeUndefined()
    expect(checkCatalogRequest('llm/discoverModels', request('llm/discoverModels', 'rpc-1'))).toBeUndefined()
  })

  it('rejects envelope violations', () => {
    const method = 'session/modelCatalog'
    const cases: Array<[string, string]> = [
      ['wrong type', JSON.stringify({ type: 'client-response', rpcId: 'r', method, payload: { args: {} } })],
      ['method mismatch', request('llm/listProviders', 'r')],
      ['missing rpcId', JSON.stringify({ type: 'client-request', method, payload: { args: {} } })],
      ['empty rpcId', request(method, '')],
      ['non-string rpcId', JSON.stringify({ type: 'client-request', rpcId: 7, method, payload: { args: {} } })],
      ['overlong rpcId', request(method, 'r'.repeat(513))],
      ['nonempty args', request(method, 'r', { sessionId: 'x' })],
      ['null args', JSON.stringify({ type: 'client-request', rpcId: 'r', method, payload: { args: null } })],
      ['array args', JSON.stringify({ type: 'client-request', rpcId: 'r', method, payload: { args: [] } })],
      ['missing payload', JSON.stringify({ type: 'client-request', rpcId: 'r', method })],
      ['unknown envelope field', JSON.stringify({ type: 'client-request', rpcId: 'r', method, payload: { args: {} }, extra: 1 })],
      ['unknown payload field', JSON.stringify({ type: 'client-request', rpcId: 'r', method, payload: { args: {}, mode: 'x' } })],
      ['unparseable', 'not json'],
    ]
    for (const [name, body] of cases) expect(checkCatalogRequest(method, body), name).toBeUndefined()
  })
})

describe('catalog envelope validation and restamping', () => {
  it('accepts only the verified success schema with the expected rpcId', () => {
    expect(validateCatalogEnvelope(envelope('fill-1'), 'fill-1')).toBe(true)
    expect(validateCatalogEnvelope(envelope('fill-1'), 'fill-2'), 'wrong rpcId').toBe(false)
    expect(validateCatalogEnvelope(JSON.stringify({ type: 'server-response', rpcId: 'f', result: { ok: false, error: { code: 'x', message: 'm' } } }), 'f'), 'error variant').toBe(false)
    expect(validateCatalogEnvelope(JSON.stringify({ type: 'client-request', rpcId: 'f', result: { ok: true, value: {} } }), 'f'), 'wrong type value').toBe(false)
    expect(validateCatalogEnvelope(JSON.stringify({ rpcId: 'f', result: { ok: true, value: {} } }), 'f'), 'missing type').toBe(false)
    expect(validateCatalogEnvelope(JSON.stringify({ type: 'server-response', rpcId: 'f' }), 'f'), 'missing result').toBe(false)
    expect(validateCatalogEnvelope(JSON.stringify({ type: 'server-response', rpcId: 'f', result: { value: {} } }), 'f'), 'missing ok').toBe(false)
    expect(validateCatalogEnvelope(JSON.stringify({ type: 'server-response', rpcId: 'f', result: { ok: true } }), 'f'), 'missing value').toBe(false)
    expect(validateCatalogEnvelope('nope', 'f'), 'unparseable').toBe(false)
  })

  it('restamps only the rpcId and preserves the result', () => {
    const restamped = restampEnvelope(envelope('fill-1'), 'fill-1', 'caller-9')
    expect(restamped).toBeDefined()
    const parsed = JSON.parse(restamped as string) as { type: string; rpcId: string; result: unknown }
    expect(parsed.rpcId).toBe('caller-9')
    expect(parsed.type).toBe('server-response')
    expect(parsed.result).toEqual({ ok: true, value: { default: { provider: 'p', model: 'composer-model-0' } } })
    expect(restampEnvelope(envelope('fill-1'), 'fill-2', 'caller-9'), 'wrong expected id').toBeUndefined()
    expect(restampEnvelope('nope', 'fill-1', 'caller-9')).toBeUndefined()
  })
})

describe('CatalogCache TTL and replay', () => {
  it('blocks on a missing entry, serves per-caller replays, then fresh hits without new fills', async () => {
    const clock = new FakeClock()
    let fills = 0
    const cache = new CatalogCache({
      fetchFill: async ({ method }) => {
        fills += 1
        return fillOutcome(`fill-${fills}`, method === 'llm/listProviders' ? 'provider-model' : undefined)
      },
      clock: clock.tick,
    })
    const first = await cache.serve({ method: 'session/modelCatalog', rpcId: 'caller-1', identityDigest: 'id-a', upstream: snapshot })
    expect(first.kind).toBe('replay')
    expect(bodyRpcId((first as { body: string }).body)).toBe('caller-1')
    const second = await cache.serve({ method: 'session/modelCatalog', rpcId: 'caller-2', identityDigest: 'id-a', upstream: snapshot })
    expect(second.kind).toBe('hit')
    expect(bodyRpcId((second as { body: string }).body)).toBe('caller-2')
    expect(fills).toBe(1)
    expect(cache.entryCount).toBe(1)
    expect(cache.residentBytes).toBeGreaterThan(0)
  })

  it('applies the fresh/stale/expired intervals measured from fill completion', async () => {
    const clock = new FakeClock()
    let fills = 0
    const pending = deferred<CatalogFillOutcome>()
    const cache = new CatalogCache({
      fetchFill: () => {
        fills += 1
        return fills === 1 ? pending.promise : Promise.resolve(fillOutcome(`fill-${fills}`))
      },
      clock: clock.tick,
    })
    const started = cache.serve({ method: 'session/modelCatalog', rpcId: 'c1', identityDigest: 'id-a', upstream: snapshot })
    clock.advance(10_000)
    pending.resolve(fillOutcome('fill-1'))
    expect((await started).kind).toBe('replay')
    const completionAge = 10_000
    void completionAge
    clock.advance(DEFAULT_CATALOG_CACHE_LIMITS.freshMs - 1)
    expect((await cache.serve({ method: 'session/modelCatalog', rpcId: 'c2', identityDigest: 'id-a', upstream: snapshot })).kind).toBe('hit')
    clock.advance(1)
    expect((await cache.serve({ method: 'session/modelCatalog', rpcId: 'c3', identityDigest: 'id-a', upstream: snapshot })).kind).toBe('stale')
    clock.advance(DEFAULT_CATALOG_CACHE_LIMITS.staleMs - DEFAULT_CATALOG_CACHE_LIMITS.freshMs - 1)
    expect((await cache.serve({ method: 'session/modelCatalog', rpcId: 'c4', identityDigest: 'id-a', upstream: snapshot })).kind).toBe('stale')
    clock.advance(1)
    const expired = await cache.serve({ method: 'session/modelCatalog', rpcId: 'c5', identityDigest: 'id-a', upstream: snapshot })
    expect(expired.kind).toBe('replay')
    expect(fills).toBe(2)
  })

  it('serves stale immediately while the background refresh is pending', async () => {
    const clock = new FakeClock()
    let fills = 0
    const background = deferred<CatalogFillOutcome>()
    const cache = new CatalogCache({
      fetchFill: () => {
        fills += 1
        return fills === 1 ? Promise.resolve(fillOutcome('fill-1', 'old')) : background.promise
      },
      clock: clock.tick,
    })
    await cache.serve({ method: 'session/modelCatalog', rpcId: 'c1', identityDigest: 'id-a', upstream: snapshot })
    clock.advance(DEFAULT_CATALOG_CACHE_LIMITS.freshMs + 1)
    const stale = await cache.serve({ method: 'session/modelCatalog', rpcId: 'c2', identityDigest: 'id-a', upstream: snapshot })
    expect(stale.kind).toBe('stale')
    expect((JSON.parse((stale as { body: string }).body) as { result: { value: { default: { model: string } } } }).result.value.default.model).toBe('old')
    background.resolve(fillOutcome('fill-2', 'new'))
    await vi.waitFor(async () => {
      const settled = await cache.serve({ method: 'session/modelCatalog', rpcId: 'poll', identityDigest: 'id-a', upstream: snapshot })
      expect(settled.kind).toBe('hit')
      expect((JSON.parse((settled as { body: string }).body) as { result: { value: { default: { model: string } } } }).result.value.default.model).toBe('new')
    })
    const fresh = await cache.serve({ method: 'session/modelCatalog', rpcId: 'c3', identityDigest: 'id-a', upstream: snapshot })
    expect(fresh.kind).toBe('hit')
    expect((JSON.parse((fresh as { body: string }).body) as { result: { value: { default: { model: string } } } }).result.value.default.model).toBe('new')
  })

  it('does not renew freshness when a refresh fails', async () => {
    const clock = new FakeClock()
    let fills = 0
    const failing = deferred<CatalogFillOutcome>()
    const cache = new CatalogCache({
      fetchFill: () => {
        fills += 1
        if (fills === 1) return Promise.resolve(fillOutcome('fill-1'))
        if (fills === 2) return failing.promise
        return Promise.resolve(fillOutcome(`fill-${fills}`))
      },
      clock: clock.tick,
    })
    await cache.serve({ method: 'session/modelCatalog', rpcId: 'c1', identityDigest: 'id-a', upstream: snapshot })
    clock.advance(DEFAULT_CATALOG_CACHE_LIMITS.freshMs + 1)
    await cache.serve({ method: 'session/modelCatalog', rpcId: 'c2', identityDigest: 'id-a', upstream: snapshot })
    failing.resolve({ shareable: false })
    await vi.waitFor(() => expect(cache.inFlightFills).toBe(0))
    clock.advance(DEFAULT_CATALOG_CACHE_LIMITS.staleMs - DEFAULT_CATALOG_CACHE_LIMITS.freshMs)
    const after = await cache.serve({ method: 'session/modelCatalog', rpcId: 'c3', identityDigest: 'id-a', upstream: snapshot })
    expect(after.kind).toBe('replay')
    expect(fills).toBe(3)
  })

  it('collapses concurrent misses into one fill with per-caller rpcIds, including after expiry', async () => {
    const clock = new FakeClock()
    let fills = 0
    const gate = deferred<void>()
    const cache = new CatalogCache({
      fetchFill: async () => {
        fills += 1
        await gate.promise
        return fillOutcome(`fill-${fills}`)
      },
      clock: clock.tick,
    })
    const waiters = Array.from({ length: 5 }, (_, index) =>
      cache.serve({ method: 'session/modelCatalog', rpcId: `caller-${index}`, identityDigest: 'id-a', upstream: snapshot }))
    gate.resolve()
    const settled = await Promise.all(waiters)
    expect(fills).toBe(1)
    for (const [index, result] of settled.entries()) {
      expect(result.kind, `waiter ${index}`).toBe('replay')
      expect(bodyRpcId((result as { body: string }).body)).toBe(`caller-${index}`)
    }
    clock.advance(DEFAULT_CATALOG_CACHE_LIMITS.staleMs + 1)
    const expired = await Promise.all([
      cache.serve({ method: 'session/modelCatalog', rpcId: 'again-1', identityDigest: 'id-a', upstream: snapshot }),
      cache.serve({ method: 'session/modelCatalog', rpcId: 'again-2', identityDigest: 'id-a', upstream: snapshot }),
    ])
    expect(fills).toBe(2)
    expect(expired.map(result => bodyRpcId((result as { body: string }).body))).toEqual(['again-1', 'again-2'])
  })

  it('allows repeated caller rpcIds', async () => {
    const cache = new CatalogCache({ fetchFill: async () => fillOutcome('fill-1'), clock: new FakeClock().tick })
    const one = await cache.serve({ method: 'llm/listProviders', rpcId: 'same', identityDigest: 'id-a', upstream: snapshot })
    const two = await cache.serve({ method: 'llm/listProviders', rpcId: 'same', identityDigest: 'id-a', upstream: snapshot })
    expect([one.kind, two.kind]).toEqual(['replay', 'hit'])
    expect(bodyRpcId((one as { body: string }).body)).toBe('same')
    expect(bodyRpcId((two as { body: string }).body)).toBe('same')
  })
})

describe('CatalogCache generations', () => {
  it('discards a blocking fill that completes after a mutation', async () => {
    const clock = new FakeClock()
    const pending = deferred<CatalogFillOutcome>()
    let fills = 0
    const cache = new CatalogCache({
      fetchFill: () => {
        fills += 1
        return pending.promise
      },
      clock: clock.tick,
    })
    const waiter = cache.serve({ method: 'session/modelCatalog', rpcId: 'c1', identityDigest: 'id-a', upstream: snapshot })
    cache.noteCatalogMutation()
    pending.resolve(fillOutcome('fill-1'))
    expect(await waiter).toEqual({ kind: 'passthrough' })
    expect(cache.entryCount).toBe(0)
  })

  it('discards a blocking fill that completes after an identity change', async () => {
    const clock = new FakeClock()
    const pending = deferred<CatalogFillOutcome>()
    const cache = new CatalogCache({
      fetchFill: () => pending.promise,
      clock: clock.tick,
    })
    const waiter = cache.serve({ method: 'session/modelCatalog', rpcId: 'c1', identityDigest: 'id-a', upstream: snapshot })
    cache.noteIdentity('id-b')
    pending.resolve(fillOutcome('fill-1'))
    expect(await waiter).toEqual({ kind: 'passthrough' })
    expect(cache.entryCount).toBe(0)
  })

  it('prevents a post-mutation request from joining the old flight', async () => {
    const clock = new FakeClock()
    const first = deferred<CatalogFillOutcome>()
    let fills = 0
    const gates: Array<Deferred<CatalogFillOutcome>> = []
    const cache = new CatalogCache({
      fetchFill: () => {
        fills += 1
        if (fills === 1) return first.promise
        const gate = deferred<CatalogFillOutcome>()
        gates.push(gate)
        return gate.promise
      },
      clock: clock.tick,
    })
    const old = cache.serve({ method: 'session/modelCatalog', rpcId: 'c1', identityDigest: 'id-a', upstream: snapshot })
    cache.noteCatalogMutation()
    const fresh = cache.serve({ method: 'session/modelCatalog', rpcId: 'c2', identityDigest: 'id-a', upstream: snapshot })
    expect(fills).toBe(2)
    first.resolve({ shareable: false })
    expect(await old).toEqual({ kind: 'passthrough' })
    gates[0]?.resolve(fillOutcome('fill-2'))
    expect((await fresh).kind).toBe('replay')
  })

  it('keeps the newer flight when an older flight settles late', async () => {
    const clock = new FakeClock()
    const old = deferred<CatalogFillOutcome>()
    const fresh = deferred<CatalogFillOutcome>()
    let fills = 0
    const cache = new CatalogCache({
      fetchFill: () => {
        fills += 1
        return fills === 1 ? old.promise : fresh.promise
      },
      clock: clock.tick,
    })
    const oldWaiter = cache.serve({ method: 'session/modelCatalog', rpcId: 'c1', identityDigest: 'id-a', upstream: snapshot })
    cache.noteCatalogMutation()
    const freshWaiter = cache.serve({ method: 'session/modelCatalog', rpcId: 'c2', identityDigest: 'id-a', upstream: snapshot })
    fresh.resolve(fillOutcome('fill-2'))
    expect((await freshWaiter).kind).toBe('replay')
    old.resolve(fillOutcome('fill-1'))
    expect(await oldWaiter).toEqual({ kind: 'passthrough' })
    const after = await cache.serve({ method: 'session/modelCatalog', rpcId: 'c3', identityDigest: 'id-a', upstream: snapshot })
    expect((JSON.parse((after as { body: string }).body) as { result: { value: { default: { model: string } } } }).result.value.default.model).toBe('composer-model-0')
    expect(after.kind).toBe('hit')
  })

  it('does not resurrect an old identity after an A→B→A transition', async () => {
    const clock = new FakeClock()
    const pending = deferred<CatalogFillOutcome>()
    const cache = new CatalogCache({
      fetchFill: () => pending.promise,
      clock: clock.tick,
    })
    const waiter = cache.serve({ method: 'session/modelCatalog', rpcId: 'c1', identityDigest: 'id-a', upstream: snapshot })
    cache.noteIdentity('id-b')
    cache.noteIdentity('id-a')
    pending.resolve(fillOutcome('fill-1'))
    expect(await waiter).toEqual({ kind: 'passthrough' })
    expect(cache.entryCount).toBe(0)
  })

  it('counts obsolete flights as active until they settle', async () => {
    const clock = new FakeClock()
    const pending = deferred<CatalogFillOutcome>()
    const cache = new CatalogCache({
      fetchFill: () => pending.promise,
      clock: clock.tick,
      limits: { maxInFlightFills: 2 },
    })
    void cache.serve({ method: 'session/modelCatalog', rpcId: 'c1', identityDigest: 'id-a', upstream: snapshot })
    cache.noteCatalogMutation()
    expect(cache.inFlightFills).toBe(1)
    pending.resolve({ shareable: false })
    await vi.waitFor(() => expect(cache.inFlightFills).toBe(0))
  })

  it('marks results uncommittable after mutation, identity change, disposal, or expiry', async () => {
    const clock = new FakeClock()
    const cache = new CatalogCache({ fetchFill: async () => fillOutcome('fill-1'), clock: clock.tick })
    const result = await cache.serve({ method: 'session/modelCatalog', rpcId: 'c1', identityDigest: 'id-a', upstream: snapshot })
    const replay = (result: CatalogServeResult): CatalogReplayResult => result as CatalogReplayResult
    expect(cache.canCommit(replay(result))).toBe(true)
    cache.noteCatalogMutation()
    expect(cache.canCommit(replay(result))).toBe(false)
    const second = await cache.serve({ method: 'session/modelCatalog', rpcId: 'c2', identityDigest: 'id-a', upstream: snapshot })
    cache.noteIdentity('id-b')
    expect(cache.canCommit(replay(second))).toBe(false)
    const third = await cache.serve({ method: 'session/modelCatalog', rpcId: 'c3', identityDigest: 'id-b', upstream: snapshot })
    expect(cache.canCommit(replay(third))).toBe(true)
    clock.advance(DEFAULT_CATALOG_CACHE_LIMITS.staleMs + 1)
    expect(cache.canCommit(replay(third)), 'expired results are uncommittable').toBe(false)
    cache.dispose()
    expect(cache.canCommit(replay(third))).toBe(false)
    expect(cache.isCurrent(replay(third).generation)).toBe(false)
  })
})

describe('CatalogCache admission, bounds, and failure', () => {
  it('lets followers join a full flight', async () => {
    const clock = new FakeClock()
    const gate = deferred<CatalogFillOutcome>()
    let fills = 0
    const cache = new CatalogCache({
      fetchFill: () => {
        fills += 1
        return gate.promise
      },
      clock: clock.tick,
      limits: { maxInFlightFills: 1 },
    })
    const waiters = [
      cache.serve({ method: 'session/modelCatalog', rpcId: 'a', identityDigest: 'id-a', upstream: snapshot }),
      cache.serve({ method: 'session/modelCatalog', rpcId: 'b', identityDigest: 'id-a', upstream: snapshot }),
    ]
    gate.resolve(fillOutcome('fill-1'))
    const settled = await Promise.all(waiters)
    expect(fills).toBe(1)
    expect(settled.map(result => result.kind)).toEqual(['replay', 'replay'])
  })

  it('rejects admission for a new key at capacity without starting a fill', async () => {
    const clock = new FakeClock()
    const gate = deferred<CatalogFillOutcome>()
    let fills = 0
    const cache = new CatalogCache({
      fetchFill: () => {
        fills += 1
        return gate.promise
      },
      clock: clock.tick,
      limits: { maxInFlightFills: 1 },
    })
    const first = cache.serve({ method: 'session/modelCatalog', rpcId: 'a', identityDigest: 'id-a', upstream: snapshot })
    const second = await cache.serve({ method: 'llm/listProviders', rpcId: 'b', identityDigest: 'id-a', upstream: snapshot })
    expect(second).toEqual({ kind: 'passthrough' })
    expect(fills).toBe(1)
    gate.resolve(fillOutcome('fill-1'))
    expect((await first).kind).toBe('replay')
  })

  it('evicts least-recently served entries under smaller numeric limits', async () => {
    const clock = new FakeClock()
    const cache = new CatalogCache({
      fetchFill: async ({ method }) => fillOutcome(`fill-${method}`, method === 'llm/listProviders' ? 'p' : undefined),
      clock: clock.tick,
      limits: { maxEntries: 1 },
    })
    await cache.serve({ method: 'session/modelCatalog', rpcId: 'a', identityDigest: 'id-a', upstream: snapshot })
    await cache.serve({ method: 'llm/listProviders', rpcId: 'b', identityDigest: 'id-a', upstream: snapshot })
    expect(cache.entryCount).toBe(1)
    await cache.serve({ method: 'session/modelCatalog', rpcId: 'c', identityDigest: 'id-a', upstream: snapshot })
    expect(cache.entryCount).toBe(1)
  })

  it('retains nothing for unshareable, invalid, mismatched, or oversize outcomes', async () => {
    const clock = new FakeClock()
    let fills = 0
    const cache = new CatalogCache({
      fetchFill: async () => {
        fills += 1
        if (fills === 1) return { shareable: false }
        if (fills === 2) return { shareable: true, envelopeJson: JSON.stringify({ type: 'wrong', rpcId: 'f', result: { ok: true, value: 1 } }), upstreamRpcId: 'f' }
        if (fills === 3) return { shareable: true, envelopeJson: envelope('someone-else'), upstreamRpcId: 'f' }
        return {
          shareable: true,
          envelopeJson: JSON.stringify({
            type: 'server-response', rpcId: 'f',
            result: { ok: true, value: { default: { provider: 'p', model: 'm' }, filler: 'y'.repeat(2_048) } },
          }),
          upstreamRpcId: 'f',
        }
      },
      clock: clock.tick,
      limits: { maxEntryBytes: 1_024 },
    })
    expect((await cache.serve({ method: 'session/modelCatalog', rpcId: 'a', identityDigest: 'id-a', upstream: snapshot })).kind).toBe('passthrough')
    expect((await cache.serve({ method: 'session/modelCatalog', rpcId: 'b', identityDigest: 'id-a', upstream: snapshot })).kind, 'invalid envelope schema is not retained').toBe('passthrough')
    expect((await cache.serve({ method: 'session/modelCatalog', rpcId: 'c', identityDigest: 'id-a', upstream: snapshot })).kind, 'rpcId mismatch is not retained').toBe('passthrough')
    expect((await cache.serve({ method: 'session/modelCatalog', rpcId: 'd', identityDigest: 'id-a', upstream: snapshot })).kind, 'oversize envelope serves once').toBe('replay')
    expect(cache.entryCount).toBe(0)
    expect((await cache.serve({ method: 'session/modelCatalog', rpcId: 'e', identityDigest: 'id-a', upstream: snapshot })).kind, 'oversize envelope was not retained').toBe('replay')
    expect(cache.entryCount).toBe(0)
    expect(cache.residentBytes).toBe(0)
  })

  it('settles rejected and throwing fill callbacks safely', async () => {
    const clock = new FakeClock()
    let fills = 0
    const cache = new CatalogCache({
      fetchFill: () => {
        fills += 1
        if (fills === 1) return Promise.reject(new Error('upstream gone'))
        throw new Error('synchronous failure')
      },
      clock: clock.tick,
    })
    expect((await cache.serve({ method: 'session/modelCatalog', rpcId: 'a', identityDigest: 'id-a', upstream: snapshot })).kind).toBe('passthrough')
    expect((await cache.serve({ method: 'session/modelCatalog', rpcId: 'b', identityDigest: 'id-a', upstream: snapshot })).kind).toBe('passthrough')
    expect(cache.entryCount).toBe(0)
  })

  it('refuses new fills and publication after disposal', async () => {
    const clock = new FakeClock()
    let fills = 0
    const cache = new CatalogCache({
      fetchFill: async () => {
        fills += 1
        return fillOutcome('fill-1')
      },
      clock: clock.tick,
    })
    cache.dispose()
    expect(await cache.serve({ method: 'session/modelCatalog', rpcId: 'a', identityDigest: 'id-a', upstream: snapshot })).toEqual({ kind: 'passthrough' })
    expect(fills).toBe(0)
  })
})

describe('catalog mutation registry', () => {
  it('exposes the inspected catalog-affecting mutation methods', () => {
    expect([...CATALOG_MUTATION_METHODS].sort()).toEqual([
      'account/signOut',
      'account/startSignIn',
      'credentials/set',
      'credentials/unset',
      'pluginManager/installBundle',
      'pluginManager/removeBundle',
      'pluginManager/setBundleEnabled',
      'pluginManager/setPluginEnabled',
      'pluginManager/setVersionExemption',
      'pluginManager/updateBundle',
      'session/initializeDefaultModel',
      'session/selectModel',
      'settings/mutate',
      'settings/replace',
      'settings/update',
    ])
    expect(CATALOG_MUTATION_METHODS.has('llm/discoverModels')).toBe(false)
    expect(CATALOG_MUTATION_METHODS.has('session/prompt')).toBe(false)
  })
})
