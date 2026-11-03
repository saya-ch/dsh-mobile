import { createServer, request as requestHttp, Server, type IncomingHttpHeaders } from 'node:http'
import { connect, type Socket } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway, type HttpFailureEntry } from '../src/gateway.js'
import { CSRF_HEADER, SESSION_COOKIE } from '../src/http-security.js'
import { MemoryDeviceStore } from '../src/storage.js'

interface HttpResult { readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: string }
interface UpstreamRequest { readonly method: string | undefined; readonly url: string | undefined; readonly body: Buffer }
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  } finally {
    vi.restoreAllMocks()
  }
})

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test HTTP server has no TCP address')
  return address.port
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections()
  if (!server.listening) return
  await new Promise<void>(resolve => { server.close(() => resolve()) })
}

async function fixture(status = 400, observe?: (entry: HttpFailureEntry) => void) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-http-failures-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const received: UpstreamRequest[] = []
  const upstreamBody = '{"error":"bad_request"}\n'
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('error', () => undefined)
    request.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
    request.once('end', () => {
      received.push({ method: request.method, url: request.url, body: Buffer.concat(chunks) })
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(upstreamBody),
        'x-upstream-result': 'retained',
      })
      response.end(upstreamBody)
    })
  })
  cleanups.push(() => close(upstream))
  const upstreamPort = await listen(upstream)
  const config = parseGatewayConfig({
    listenHost: '127.0.0.1', listenPort: 0,
    upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
    publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(root, 'devices.json'), tls: { mode: 'disabled' },
  })
  const entries: HttpFailureEntry[] = []
  const gateway = new MobileAccessGateway(
    { ...config, discovery: false }, new MemoryDeviceStore(),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    observe ?? (entry => { entries.push(entry) }),
  )
  cleanups.push(() => gateway.close())
  await gateway.start()
  const opened = await gateway.access.openPairing()
  const paired = await gateway.access.pair('fixture', opened.token, 'HTTP diagnostics fixture')
  const port = gateway.address().port
  const headers = {
    host: new URL(gateway.address().origin).host,
    origin: gateway.address().origin,
    'sec-fetch-site': 'same-origin',
    cookie: `${SESSION_COOKIE}=${paired.sessionToken}`,
    [CSRF_HEADER]: paired.csrfToken,
    'content-type': 'application/json',
  }
  return { gateway, port, headers, received, entries, upstreamBody }
}

function rawRequest(port: number, request: string, halfClose = false): Promise<{ readonly head: string; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    cleanups.push(async () => {
      if (socket.destroyed) return
      const closed = new Promise<void>(done => { socket.once('close', () => done()) })
      socket.destroy()
      await closed
    })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('raw HTTP response did not settle')) }, 2_000)
    const chunks: Buffer[] = []
    socket.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
    socket.once('error', reject)
    socket.once('close', () => {
      clearTimeout(timer)
      const result = Buffer.concat(chunks).toString('utf8')
      const end = result.indexOf('\r\n\r\n')
      resolve({ head: result.slice(0, end), body: result.slice(end + 4) })
    })
    socket.once('connect', () => {
      if (halfClose) socket.end(request)
      else socket.write(request)
    })
  })
}

function httpRequest(
  context: Awaited<ReturnType<typeof fixture>>,
  path: string,
  options: { readonly method?: string; readonly body?: string; readonly chunked?: boolean; readonly headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const body = options.body ?? '{}'
  return new Promise((resolve, reject) => {
    const outgoing = requestHttp({
      host: '127.0.0.1', port: context.port, path, method: options.method ?? 'POST', agent: false,
      headers: {
        ...context.headers,
        ...(options.chunked === true ? { 'transfer-encoding': 'chunked' } : { 'content-length': String(Buffer.byteLength(body)) }),
        ...options.headers,
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      response.once('error', reject)
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error', reject)
    outgoing.end(body)
  })
}

function gatewayServer(gateway: MobileAccessGateway): Server {
  const server: unknown = Reflect.get(gateway, 'server')
  if (!(server instanceof Server)) throw new Error('test Gateway has no active HTTP server')
  return server
}

describe('Gateway HTTP rejection diagnostics', () => {
  it.each(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'])('closes a controlled %s without sending a false HTTP 400', async nodeCode => {
    const f = await fixture()
    const server = gatewayServer(f.gateway)
    server.once('connection', (socket: Socket) => {
      server.emit('clientError', Object.assign(new Error('private message'), { code: nodeCode, rawPacket: Buffer.from('private-cookie-and-body') }), socket)
    })
    const result = await rawRequest(f.port, '')
    expect(result).toEqual({ head: '', body: '' })
    expect(f.entries).toEqual([{ kind: 'transport', code: nodeCode }])
    expect(f.received).toHaveLength(0)
    expect(JSON.stringify(f.entries)).not.toContain('private')
  })

  it('identifies a real invalid HTTP method without retaining the request or credentials', async () => {
    const f = await fixture()
    const result = await rawRequest(f.port, 'G@T /private?token=secret HTTP/1.1\r\nHost: localhost\r\n\r\n')
    expect(result.head).toContain('HTTP/1.1 400 Bad Request')
    expect(f.entries).toEqual([{ kind: 'parser', status: 400, code: 'HPE_INVALID_METHOD' }])
    expect(f.received).toHaveLength(0)
    expect(JSON.stringify(f.entries)).not.toMatch(/private|secret/u)
  })
  it('returns a real header parser overflow as 431 instead of an ambiguous 400', async () => {
    const f = await fixture()
    const result = await rawRequest(f.port, [
      'POST /api/session/prompt HTTP/1.1',
      `Host: ${f.headers.host}`,
      `X-Private: ${'private-cookie-like-data'.repeat(1_000)}`,
      'Content-Length: 2', 'Connection: close', '', '{}',
    ].join('\r\n'))
    expect(result.head).toContain('HTTP/1.1 431 Request Header Fields Too Large')
    expect(result.body).toBe('{"error":"headers_too_large"}\n')
    expect(f.entries).toEqual([{ kind: 'parser', status: 431, code: 'HPE_HEADER_OVERFLOW' }])
    expect(f.received).toHaveLength(0)
    expect(JSON.stringify(f.entries)).not.toMatch(/private|cookie/iu)
  })

  it('keeps an incomplete body rejection distinguishable from a completed upstream rejection', async () => {
    const f = await fixture()
    const result = await rawRequest(f.port, [
      'POST /api/session/prompt HTTP/1.1',
      ...Object.entries(f.headers).map(([key, value]) => `${key}: ${value}`),
      'Content-Length: 100000', 'Connection: close', '', '{}',
    ].join('\r\n'), true)
    expect(result.head).toContain('HTTP/1.1 400 Bad Request')
    expect(result.body).toBe('{"error":"bad_request"}\n')
    expect(f.entries).toEqual([{ kind: 'parser', status: 400, code: 'HPE_INVALID_EOF_STATE' }])
    expect(f.received).toHaveLength(0)
  })

  it.each([
    { nodeCode: 'ERR_HTTP_REQUEST_TIMEOUT', status: 408, reason: 'Request Timeout', code: 'request_timeout', recorded: 'ERR_HTTP_REQUEST_TIMEOUT' },
    { nodeCode: 'private-unknown-code', status: 400, reason: 'Bad Request', code: 'bad_request', recorded: 'other' },
  ])('contains a controlled $nodeCode event without exposing its packet or error', async ({ nodeCode, status, reason, code, recorded }) => {
    const f = await fixture()
    const server = gatewayServer(f.gateway)
    // A controlled parser event checks response wiring without waiting for Node's
    // connection-check interval; it does not measure the request receive deadline.
    server.once('connection', (socket: Socket) => {
      server.emit('clientError', Object.assign(new Error('private message'), { code: nodeCode, rawPacket: Buffer.from('private-cookie-and-body') }), socket)
    })
    const result = await rawRequest(f.port, `GET /mobile-access/health HTTP/1.1\r\nHost: ${f.headers.host}\r\n\r\n`)
    expect(result.head).toContain(`HTTP/1.1 ${String(status)} ${reason}`)
    expect(result.body).toBe(`${JSON.stringify({ error: code })}\n`)
    expect(f.entries).toEqual([{ kind: 'parser', status, code: recorded }])
    expect(JSON.stringify(f.entries)).not.toContain('private')
    expect(f.received).toHaveLength(0)
  })

  it('records an invalid target without retaining its query or token', async () => {
    const f = await fixture()
    const result = await httpRequest(f, '/api/%ZZ/private?token=private-token')
    expect(result.status).toBe(400)
    expect(result.body).toBe('{"error":"bad_request"}\n')
    expect(f.entries).toEqual([{ kind: 'target', status: 400, code: 'bad_request' }])
    expect(JSON.stringify(f.entries)).not.toContain('private')
    expect(f.received).toHaveLength(0)
  })

  it.each([false, true])('retains an authenticated upstream 400 and forwards a chunked=%s prompt body exactly once', async chunked => {
    const f = await fixture()
    const body = JSON.stringify({ sessionId: 'private-session', text: '中文 🐳', image: 'a'.repeat(158_988) })
    const result = await httpRequest(f, '/api/session/prompt?private=secret-query', { body, chunked })
    expect(result).toMatchObject({ status: 400, body: f.upstreamBody })
    expect(result.headers['x-upstream-result']).toBe('retained')
    expect(f.received).toEqual([{ method: 'POST', url: '/api/session/prompt?private=secret-query', body: Buffer.from(body) }])
    expect(f.entries).toEqual([{ kind: 'upstream', status: 400, method: 'POST', path: '/api/session/prompt' }])
    expect(JSON.stringify(f.entries)).not.toMatch(/private|secret|中文|image/u)
  })

  it('does not retry a rejected prompt or record unauthenticated and unrelated requests as prompt failures', async () => {
    const f = await fixture(503)
    const unauthorized = await httpRequest(f, '/api/session/prompt', { headers: { cookie: '' } })
    expect(unauthorized.status).toBe(401)
    expect(f.received).toHaveLength(0)
    expect(f.entries).toHaveLength(0)
    for (const path of ['/api/session/other-private-action', '/api/%73ession/prompt']) {
      expect((await httpRequest(f, path)).status).toBe(503)
    }
    expect((await httpRequest(f, '/api/session/prompt', { method: 'GET' })).status).toBe(503)
    expect(f.entries).toHaveLength(0)
    const result = await httpRequest(f, '/api/session/prompt')
    expect(result.status).toBe(503)
    expect(f.received.filter(request => request.method === 'POST' && request.url === '/api/session/prompt')).toHaveLength(1)
    expect(f.entries).toEqual([{ kind: 'upstream', status: 503, method: 'POST', path: '/api/session/prompt' }])
  })

  it('keeps upstream and target HTTP failures unchanged when the observer throws', async () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined)
    const observer = vi.fn(() => { throw new Error('private sink failure') })
    const f = await fixture(400, observer)
    const upstream = await httpRequest(f, '/api/session/prompt')
    expect(upstream).toMatchObject({ status: 400, body: f.upstreamBody })
    const target = await httpRequest(f, '/api/%ZZ/private')
    expect(target).toMatchObject({ status: 400, body: '{"error":"bad_request"}\n' })
    expect(observer).toHaveBeenCalledTimes(2)
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      'Mobile access HTTP diagnostics could not be recorded', { code: 'DSH_MOBILE_HTTP_LOG_FAILED' },
    )
    expect(f.received).toHaveLength(1)
  })
})
