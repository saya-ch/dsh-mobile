import { Context } from '@deepseek-ai/cordis'
import { createServer, request as requestHttp } from 'node:http'
import type { AddressInfo, Server } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessService } from '../src/extensions.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { CSRF_HEADER, SESSION_COOKIE } from '../src/http-security.js'
import { MemoryDeviceStore } from '../src/storage.js'
import { buildExtensionWorkerEntry } from './helpers/extension-worker-build.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

function request(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const body = options.body
    const headers = { ...options.headers, ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }) }
    const outgoing = requestHttp({ host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, agent: false }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    outgoing.once('error', reject); outgoing.end(body)
  })
}

function cookie(headers: Record<string, string | string[] | undefined>, name: string): string {
  const values = headers['set-cookie']; const list = Array.isArray(values) ? values : values === undefined ? [] : [values]
  return list.find(value => value.startsWith(`${name}=`))?.split(';', 1)[0] ?? ''
}

describe('worker-mode extension through the real gateway path', () => {
  it('serves worker-serialized action bytes verbatim without gateway-side serialization', async () => {
    const workerModule = await buildExtensionWorkerEntry()
    const upstream = createServer((_, response) => { response.writeHead(200); response.end('ok') })
    const upstreamPort = await listen(upstream)
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })

    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-gateway-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const directory = join(root, 'bigcounter')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'bigcounter', name: 'BigCounter', version: '1.0.0' }))
    await writeFile(join(directory, 'host.mjs'), `
import {Readable} from 'node:stream'
export default (api) => {
  api.action('big', { run: () => ({ value: 'ok', note: '你好 worker 🚀' }) })
  api.action('quick', { run: async () => ({ ok: true }) })
  api.route({method:'GET',path:'/stream',handle:()=>({body:Readable.from([Buffer.alloc(700000,120)])})})
}
`)

    const context = new Context(); cleanups.push(() => context.fiber.dispose())
    const service = new MobileAccessService(context)
    cleanups.push(() => service.stopLocal())
    await service.startLocal(root, context, { hostExecution: { mode: 'worker', workerModule } })
    // Capture the canonical prepared bytes straight from the RPC boundary.
    const active = service.extension('bigcounter') as { readonly worker: { invoke: (action: string, input: unknown, caller: { signal: AbortSignal; deviceId: string }) => Promise<{ readonly bytes: Buffer }> } } | undefined
    if (active === undefined) throw new Error('bigcounter extension did not load')
    const prepared = await active.worker.invoke('big', {}, { signal: new AbortController().signal, deviceId: 'device' })

    const config = parseGatewayConfig({
      listenHost: '127.0.0.1', listenPort: 0,
      upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
      publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(root, 'devices.json'), tls: { mode: 'disabled' },
    })
    const gateway = new MobileAccessGateway(config, new MemoryDeviceStore(), service)
    await gateway.start(); cleanups.push(() => gateway.close())
    const opened = await gateway.access.openPairing()
    const origin = gateway.address().origin
    const paired = await request(gateway.address().port, '/mobile-access/auth/pair', {
      method: 'POST',
      headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      body: JSON.stringify({ token: opened.token }),
    })
    expect(paired.status).toBe(201)
    const session = cookie(paired.headers, SESSION_COOKIE); const csrf = JSON.parse(paired.body) as { csrfToken: string }
    const headers = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', cookie: session, [CSRF_HEADER]: csrf.csrfToken, 'content-type': 'application/json' }

    // Pass-through plumbing proof: the response is byte-identical to the
    // bytes captured at the RPC boundary (plus sendJson's trailing newline).
    // Note: this cannot distinguish reserialization by bytes alone — the
    // worker's serializer is JSON.stringify, whose output is round-trip
    // stable by construction; the architectural guarantee (the value never
    // crosses the boundary) is enforced by the PreparedJsonResult type.
    const big = await request(gateway.address().port, '/mobile-access/extensions/bigcounter/actions/big', { method: 'POST', headers, body: '{}' })
    expect(big.status).toBe(200)
    // Byte-identity with the RPC-captured prepared bytes, plus sendJson's
    // trailing-newline framing: the gateway wrote worker bytes verbatim.
    expect(big.body).toBe(`${prepared.bytes.toString('utf8')}\n`)
    expect(big.body).toContain('你好 worker 🚀')

    const quick = await request(gateway.address().port, '/mobile-access/extensions/bigcounter/actions/quick', { method: 'POST', headers, body: '{}' })
    expect(quick.status).toBe(200)
    expect(quick.body).toBe('{"ok":true}\n')
    const streamed = await request(gateway.address().port, '/mobile-access/extensions/bigcounter/routes/stream', {headers})
    expect(streamed.status).toBe(200)
    expect(streamed.body).toBe('x'.repeat(700000))
  })
})
