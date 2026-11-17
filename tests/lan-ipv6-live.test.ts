import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type AddressInfo } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { X509Certificate } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { availableLanNetworks } from '../src/managed-setup.js'
import { prepareManagedLanSetup } from '../src/lan-setup.js'
import { MemoryDeviceStore } from '../src/storage.js'

const PORT = 3444
const network = availableLanNetworks().find(entry => entry.family === 6)
const directories: string[] = []
const closers: Array<() => Promise<void>> = []

afterAll(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function listen(server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> {
  return new Promise(resolve => server.listen(port, host, () => resolve()))
}

/** Skip on hosts without a real IPv6 LAN address; CI has none. */
describe.skipIf(network === undefined)('live IPv6 LAN gateway', () => {
  it('serves metadata, CA, pairing and the mobile page over a bracketed IPv6 origin', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><title>dsh</title><p>upstream</p>')
    })
    await listen(upstream, 0, '127.0.0.1')
    closers.push(() => new Promise(resolve => upstream.close(() => resolve())))
    const upstreamPort = (upstream.address() as AddressInfo).port

    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-ipv6-live-'))
    directories.push(directory)
    const prepared = await prepareManagedLanSetup({
      setupFile: join(directory, 'setup.json'),
      controlFile: join(directory, 'control.json'),
      network: network!,
      listenPort: PORT,
      dshPort: upstreamPort,
      configureFirewall: false,
    })
    const origin = `https://[${network!.address}]:${String(PORT)}`
    expect(prepared.origin).toBe(origin)

    const caPem = await readFile(prepared.setup.tls.caCertFile)
    const instanceId = new X509Certificate(caPem).fingerprint256.replaceAll(':', '').toLowerCase()
    const instance = new MobileAccessGateway(
      parseGatewayConfig({
        publicOrigin: origin,
        listenHost: network!.address,
        upstreamOrigin: `http://127.0.0.1:${String(upstreamPort)}`,
        allowedCidrs: [network!.cidr],
        stateFile: join(directory, 'devices.json'),
        pairingCaFile: prepared.setup.tls.caCertFile,
        tls: { mode: 'provided', certFile: prepared.setup.tls.certFile, keyFile: prepared.setup.tls.keyFile },
        instanceId,
      }),
      new MemoryDeviceStore(),
    )
    await instance.start()
    closers.push(() => instance.close())

    const ca = caPem
    const host = new URL(origin).host
    const call = (path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
      new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
        const outgoing = httpsRequest(`${origin}${path}`, {
          method: options.method ?? 'GET',
          ca,
          headers: {
            host,
            origin,
            'sec-fetch-site': 'same-origin',
            ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...options.headers,
          },
        }, response => {
          let body = ''
          response.on('data', chunk => { body += String(chunk) })
          response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }))
        })
        outgoing.on('error', reject)
        if (options.body !== undefined) outgoing.write(options.body)
        outgoing.end()
      })

    const metadata = await call('/mobile-access/metadata')
    expect(metadata.status).toBe(200)
    expect(metadata.body).toContain('minimumAndroidAppVersion')

    const androidCa = await call('/mobile-access/ca.cer')
    expect(androidCa.status).toBe(200)

    const opened = await instance.access.openPairing()
    const paired = await call('/mobile-access/auth/pair', {
      method: 'POST',
      body: JSON.stringify({ token: opened.token, label: 'IPv6 phone' }),
    })
    expect(paired.status).toBe(201)
    const setCookie = paired.headers['set-cookie']
    const cookies = (Array.isArray(setCookie) ? setCookie : setCookie === undefined ? [] : [setCookie])
      .map(entry => entry.split(';', 1)[0] ?? '')
      .filter(Boolean)
      .join('; ')
    expect(cookies).not.toBe('')

    const page = await call('/', { headers: { cookie: cookies, accept: 'text/html' } })
    expect(page.status).toBe(200)
    expect(page.body).toContain('upstream')
    // The Host header the gateway accepted must be the bracketed literal, proving the
    // exact-authority policy and the signed leaf agree on the IPv6 origin.
    expect(page.headers['content-type']).toContain('text/html')

    // A foreign Host is refused even though TLS succeeded.
    const foreign = await call('/mobile-access/metadata', { headers: { host: `127.0.0.1:${String(PORT)}` } })
    expect(foreign.status).toBe(403)
  })
})
