import { createServer, request as requestHttp, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { MobileAccessGateway } from '../src/gateway.js'
import { parseGatewayConfig } from '../src/config.js'
import { MemoryDeviceStore } from '../src/storage.js'
import { CSRF_HEADER, SESSION_COOKIE } from '../src/http-security.js'

interface Observation {
  path: string
  method: string
  headers: IncomingHttpHeaders
  socket: Socket
}
interface Result { status: number; body: Buffer; headers: IncomingHttpHeaders }
interface Fixture {
  gateway: MobileAccessGateway
  observations: Observation[]
  upstreamHost: string
  signal: AbortSignal
  root: string
  upstreamListening: () => boolean
  invoke: (path: string, options?: { method?: string; body?: Buffer }) => Promise<Result>
}
const upstreamCookie = 'dsh-auth-test=v1.signed-cookie'
const payload = Buffer.from([0, 255, 128, 13, 10, 65, 0])
const bundle = Buffer.from('globalThis.singleUseBoot = true;\n')

// Reflection invokes existing buffered paths; it never replaces a production method.
function buffered<T>(gateway: MobileAccessGateway, name: string, ...args: unknown[]): Promise<T> {
  const method: unknown = Reflect.get(gateway, name)
  if (typeof method !== 'function') throw new Error(`Missing gateway method: ${name}`)
  return Reflect.apply(method, gateway, args) as Promise<T>
}

async function withFixture(
  responder: (request: IncomingMessage, response: ServerResponse) => void,
  run: (fixture: Fixture) => Promise<void>,
  authenticatedUpstream = false,
  deadlineMs = 8_000,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-single-use-'))
  const controller = new AbortController()
  const { signal } = controller
  const watchdog = setTimeout(() => controller.abort(new Error('Fixture deadline exceeded')), deadlineMs)
  const observations: Observation[] = []
  const sockets = new Set<Socket>()
  const socketClosed: Promise<void>[] = []
  const callers: Array<{ destroy: () => void; settled: Promise<unknown> }> = []
  let gateway: MobileAccessGateway | undefined
  const upstream = createServer((incoming, response) => {
    observations.push({
      path: incoming.url ?? '', method: incoming.method ?? '',
      headers: incoming.headers, socket: incoming.socket,
    })
    // Bodyless responses end immediately: no artificial drain/delay masks early replies.
    if (authenticatedUpstream && incoming.url === '/?token=single-use-launch') {
      response.writeHead(303, {
        location: '/', 'set-cookie': `${upstreamCookie}; Max-Age=1800; Path=/; HttpOnly; SameSite=Strict`,
      })
      response.end()
    } else responder(incoming, response)
  })
  let upstreamStarted = false
  const upstreamClosed = new Promise<void>(resolve => upstream.once('close', resolve))
  upstream.on('connection', socket => {
    sockets.add(socket)
    socketClosed.push(new Promise<void>(resolve => {
      socket.once('close', () => { sockets.delete(socket); resolve() })
    }))
  })
  try {
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject)
      const aborted = (): void => reject(signal.reason)
      signal.addEventListener('abort', aborted, { once: true })
      upstream.listen({ port: 0, host: '127.0.0.1', signal }, () => {
        upstreamStarted = true
        signal.removeEventListener('abort', aborted)
        resolve()
      })
    })
    const address = upstream.address()
    if (address === null || typeof address === 'string') throw new Error('Missing upstream TCP address')
    const upstreamHost = `127.0.0.1:${String(address.port)}`
    const config = parseGatewayConfig({
      listenHost: '127.0.0.1', listenPort: 0, upstreamOrigin: `http://${upstreamHost}`,
      publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(root, 'devices.json'), tls: { mode: 'disabled' },
    })
    gateway = new MobileAccessGateway(
      Object.freeze({ ...config, discovery: false }), new MemoryDeviceStore(), undefined,
      authenticatedUpstream ? `http://${upstreamHost}/?token=single-use-launch` : undefined,
    )
    await gateway.start()
    signal.throwIfAborted()
    const pairing = await gateway.access.openPairing()
    signal.throwIfAborted()
    const paired = await gateway.access.pair('single-use-fixture', pairing.token, 'Single-use phone')
    signal.throwIfAborted()
    const instance = gateway
    const origin = instance.address().origin
    const invoke: Fixture['invoke'] = (path, options = {}) => {
      let outgoing: ReturnType<typeof requestHttp> | undefined
      const result = new Promise<Result>((resolve, reject) => {
        outgoing = requestHttp({
          hostname: '127.0.0.1', port: instance.address().port, path,
          method: options.method ?? 'GET', agent: false, signal,
          headers: {
            host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin',
            // Deliberately nominates a phone hop header; upstream must not copy it.
            connection: 'keep-alive, x-mobile-hop', 'x-mobile-hop': 'must-not-forward',
            cookie: `${SESSION_COOKIE}=${paired.sessionToken}; mobile-secret=private`,
            authorization: 'Bearer mobile-secret', [CSRF_HEADER]: paired.csrfToken,
            ...(options.body === undefined ? {} : {
              'content-length': options.body.length, 'content-type': 'application/octet-stream',
            }),
          },
        }, response => {
          const chunks: Buffer[] = []
          response.on('data', chunk => chunks.push(Buffer.from(chunk)))
          response.once('error', reject)
          response.once('end', () => resolve({
            status: response.statusCode ?? 0, body: Buffer.concat(chunks), headers: response.headers,
          }))
        })
        outgoing.once('error', reject)
        outgoing.end(options.body)
      })
      callers.push({ destroy: () => outgoing?.destroy(), settled: result.catch(() => undefined) })
      return result
    }
    await run({ gateway: instance, observations, upstreamHost, invoke, signal, root,
      upstreamListening: () => upstream.listening })
    signal.throwIfAborted()
    // Prove transport-owned closure before teardown can forcibly close any socket.
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all(socketClosed),
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Upstream sockets remained open after response completion')), 2_000)
        }),
      ])
      expect(sockets.size).toBe(0)
    } finally {
      if (deadline !== undefined) clearTimeout(deadline)
    }
  } catch (error) {
    throw signal.aborted ? signal.reason : error
  } finally {
    clearTimeout(watchdog)
    controller.abort()
    // Completion-based teardown also runs after setup/assertion errors; no sleeps or leaked listeners.
    try {
      for (const caller of callers) caller.destroy()
      await Promise.allSettled(callers.map(caller => caller.settled))
      await gateway?.close()
    } finally {
      try {
        const closed = upstream.listening
          ? new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
          : Promise.resolve()
        for (const socket of sockets) socket.destroy()
        await closed
        await Promise.all(socketClosed)
        if (upstreamStarted) await upstreamClosed
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
}

function expectOwnedFreshRequests(fixture: Fixture, count: number, cookie?: string): void {
  expect(fixture.observations).toHaveLength(count)
  // Socket object identity, not ephemeral port numbers, proves no connection reuse/pool.
  expect(new Set(fixture.observations.map(observation => observation.socket)).size).toBe(count)
  for (const observation of fixture.observations) {
    // Node's existing agent:false framing closes each upstream, never copying the phone's Connection.
    expect(observation.headers.connection).toBe('close')
    expect(observation.headers.host).toBe(fixture.upstreamHost)
    expect(observation.headers.authorization).toBeUndefined()
    expect(observation.headers['x-mobile-hop']).toBeUndefined()
    expect(observation.headers[CSRF_HEADER]).toBeUndefined()
    expect(observation.headers.cookie).toBe(observation.path.includes('token=') ? undefined : cookie)
  }
}

describe('gateway existing agent:false upstream HTTP isolation', { timeout: 10_000 }, () => {
  it('uses one fresh socket per sequential and concurrent authorized API GET with intact binary bodies', async () => {
    await withFixture((_incoming, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': payload.length })
      response.end(payload)
    }, async fixture => {
      for (const path of ['/api/single-use?sequence=1', '/api/single-use?sequence=2']) {
        const result = await fixture.invoke(path)
        expect(result.status).toBe(200)
        expect(result.body).toEqual(payload)
      }
      const results = await Promise.all([
        fixture.invoke('/api/single-use?concurrent=1'), fixture.invoke('/api/single-use?concurrent=2'),
      ])
      for (const result of results) {
        expect(result.status).toBe(200)
        expect(result.body).toEqual(payload)
      }
      expect(fixture.observations.map(observation => observation.path).sort()).toEqual([
        '/api/single-use?concurrent=1', '/api/single-use?concurrent=2',
        '/api/single-use?sequence=1', '/api/single-use?sequence=2',
      ])
      expectOwnedFreshRequests(fixture, 4)
    })
  })

  it('consumes a binary POST once and preserves a chunked streamed response', async () => {
    const bodies: Buffer[] = []
    await withFixture((incoming, response) => {
      const chunks: Buffer[] = []
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
      incoming.once('end', () => {
        bodies.push(Buffer.concat(chunks))
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.write(payload.subarray(0, 3))
        response.end(payload.subarray(3))
      })
    }, async fixture => {
      const result = await fixture.invoke('/api/single-use-post', { method: 'POST', body: payload })
      expect(result.status).toBe(200)
      expect(result.body).toEqual(payload)
      expect(bodies).toEqual([payload])
      expect(fixture.observations[0]?.method).toBe('POST')
      expectOwnedFreshRequests(fixture, 1)
    })
  })

  it('does not replay a POST after the upstream consumes its side-effect payload and resets', async () => {
    const consumed: Buffer[] = []
    await withFixture((incoming, _response) => {
      const chunks: Buffer[] = []
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)))
      incoming.once('end', () => { consumed.push(Buffer.concat(chunks)); incoming.socket.destroy() })
    }, async fixture => {
      const result = await fixture.invoke('/api/single-use-side-effect', { method: 'POST', body: payload })
      expect(result.status).toBe(502)
      expect(result.body.toString()).toBe('{"error":"upstream_unavailable"}\n')
      expect(consumed).toEqual([payload])
      expectOwnedFreshRequests(fixture, 1)
    })
  })

  it.each([['HEAD', 200], ['GET', 204], ['GET', 304]] as const)(
    'preserves bodyless %s/%s without reuse or replay', async (method, status) => {
      await withFixture((_incoming, response) => { response.writeHead(status); response.end() }, async fixture => {
        const result = await fixture.invoke('/api/single-use-empty', { method })
        expect(result.status).toBe(status)
        expect(result.body.length).toBe(0)
        expectOwnedFreshRequests(fixture, 1)
      })
    },
  )

  it('cancels a held zero-budget API response and finishes resource cleanup before rejecting', async () => {
    let setup: Fixture | undefined
    let held = false
    await expect(withFixture((_incoming, _response) => { held = true }, async fixture => {
      setup = fixture
      expect(fixture.gateway.config.upstreamApiTimeoutMs).toBe(0)
      await fixture.invoke('/api/single-use-watchdog')
    }, false, 200)).rejects.toThrow('Fixture deadline exceeded')
    expect(held).toBe(true)
    expect(setup).toBeDefined()
    expect(setup!.signal.aborted).toBe(true)
    expect(setup!.upstreamListening()).toBe(false)
    expect(setup!.observations).toHaveLength(1)
    expect(setup!.observations[0]!.socket.destroyed).toBe(true)
    expect(Reflect.get(setup!.gateway, 'server')).toBeUndefined()
    await expect(stat(setup!.root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains agent:false close framing on all five outgoing paths and forwards only the configured upstream auth cookie', async () => {
    await withFixture((incoming, response) => {
      if (incoming.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<!doctype html><title>single-use index</title>')
      } else if (incoming.url?.startsWith('/plugins/')) {
        response.writeHead(200, { 'content-type': 'text/javascript', 'content-length': bundle.length })
        response.end(bundle)
      } else { response.writeHead(200); response.end(payload) }
    }, async fixture => {
      const main = await fixture.invoke('/api/single-use-auth') // Also triggers the real auth-cookie exchange GET.
      expect(main.status).toBe(200)
      expect(main.body).toEqual(payload)
      const { signal } = fixture
      const index = await buffered<{ html: string }>(fixture.gateway, 'fetchAuthenticatedUpstreamIndex', signal)
      expect(index.html).toBe('<!doctype html><title>single-use index</title>')
      expect(await buffered<number>(fixture.gateway, 'upstreamBundleSize', '/plugins/single-use.js?rev=probe', signal))
        .toBe(bundle.length)
      expect(await buffered<Buffer>(fixture.gateway, 'readUpstreamClientBundle', '/plugins/single-use.js?rev=batch', signal))
        .toEqual(bundle)
      expect(fixture.observations.map(observation => [observation.method, observation.path])).toEqual([
        ['GET', '/?token=single-use-launch'], ['GET', '/api/single-use-auth'], ['GET', '/'],
        ['GET', '/plugins/single-use.js?rev=probe'], ['GET', '/plugins/single-use.js?rev=batch'],
      ])
      expectOwnedFreshRequests(fixture, 5, upstreamCookie)
      expect(main.headers['set-cookie']).toBeUndefined()
    }, true)
  })
})
