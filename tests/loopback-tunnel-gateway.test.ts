import { X509Certificate } from 'node:crypto'
import { createServer, request as requestHttp } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGatewayConfig, type PluginConfig } from '../src/config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import {
  ensureManagedCa,
  LOOPBACK_TUNNEL_ADDRESSES,
  materializeManagedSetup,
  parseLoopbackTunnel,
  parseManagedSetup,
  saveManagedLoopbackTunnel,
  type ManagedSetup,
} from '../src/managed-setup.js'
import { RequestTrustPolicy } from '../src/network.js'
import { MemoryDeviceStore } from '../src/storage.js'

const cleanups: Array<() => Promise<void>> = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

function interfaceTable(address: string) {
  return {
    WLAN: [{
      address,
      netmask: '255.255.255.0',
      family: 'IPv4' as const,
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: `${address}/24`,
    }],
  }
}

async function managedFixture(): Promise<ManagedSetup> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-loopback-'))
  temporaryDirectories.push(directory)
  return {
    version: 2,
    networkInterface: 'WLAN',
    listenPort: 3443,
    upstreamOrigin: 'http://127.0.0.1:3080',
    tls: {
      mode: 'managed',
      caCertFile: join(directory, 'ca.pem'),
      caKeyFile: join(directory, 'ca-key.pem'),
      certFile: join(directory, 'server.pem'),
      keyFile: join(directory, 'server-key.pem'),
    },
  }
}

function gatewayConfig(overrides: Record<string, unknown> = {}): PluginConfig {
  return {
    listenHost: '127.0.0.1',
    listenPort: 3443,
    upstreamOrigin: 'http://127.0.0.1:3080',
    publicAuthorities: ['192.168.50.23:3443'],
    allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(tmpdir(), `dsh-mobile-loopback-${String(Math.random()).slice(2)}.json`),
    tls: {
      mode: 'provided',
      certFile: join(tmpdir(), 'loopback-leaf.pem'),
      keyFile: join(tmpdir(), 'loopback-leaf-key.pem'),
    },
    ...overrides,
  } as PluginConfig
}

/**
 * Start the real Gateway with the real managed leaf, so provided-TLS validation runs
 * against the same certificate material `materializeManagedSetup` produces.
 */
async function startGateway(overrides: { loopbackTunnel?: boolean; additionalAuthorities?: string[] } = {}): Promise<MobileAccessGateway> {
  const setup = { ...await managedFixture(), ...(overrides.loopbackTunnel === undefined ? {} : { loopbackTunnel: overrides.loopbackTunnel }) }
  await ensureManagedCa(setup.tls)
  await materializeManagedSetup(setup, interfaceTable('192.168.50.23'))
  const config = parseGatewayConfig({
    listenHost: '127.0.0.1',
    listenPort: 0,
    upstreamOrigin: 'http://127.0.0.1:3080',
    publicAuthorities: ['192.168.50.23'],
    allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(dirname(setup.tls.certFile), 'state.json'),
    tls: { mode: 'provided', certFile: setup.tls.certFile, keyFile: setup.tls.keyFile },
    ...(overrides.additionalAuthorities === undefined ? {} : { additionalAuthorities: overrides.additionalAuthorities }),
  })
  const gateway = new MobileAccessGateway(config, new MemoryDeviceStore())
  await gateway.start()
  cleanups.push(() => gateway.close())
  return gateway
}

interface OpenedPairing {
  readonly token: string
  readonly pairUrl: string
  readonly loopbackPairUrl?: string
}

/** Drive the real local-admin pairing route over loopback, as the desktop control does. */
async function openPairingThroughAdminRoute(gateway: MobileAccessGateway): Promise<OpenedPairing> {
  const route = gateway.localAdminRoute()
  const server = createServer((request, response) => { void route.handler(request, response) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const host = `127.0.0.1:${String(port)}`
  try {
    const body = '{}'
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = requestHttp({
        host: '127.0.0.1',
        port,
        path: '/api/mobile-access/pairing/open',
        method: 'POST',
        agent: false,
        headers: {
          host,
          origin: `http://${host}`,
          'sec-fetch-site': 'same-origin',
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
      }, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      })
      outgoing.once('error', reject)
      outgoing.end(body)
    })
    expect(result.status).toBe(201)
    return JSON.parse(result.body) as OpenedPairing
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }
}

describe('ManagedSetup loopback tunnel: default off changes nothing', () => {
  it('omits loopbackTunnel entirely when the durable file does not declare it', async () => {
    const setup = await managedFixture()
    const parsed = parseManagedSetup(setup)
    expect(parsed).toEqual(setup)
    expect(Object.keys(parsed)).toEqual(Object.keys(setup))
    expect(Object.prototype.hasOwnProperty.call(parsed, 'loopbackTunnel')).toBe(false)
    // An explicit false is the same disabled behaviour, but remains observable.
    expect(parseManagedSetup({ ...setup, loopbackTunnel: false }).loopbackTunnel).toBe(false)
  })

  it('always emits an empty additionalAuthorities list and signs a LAN-only leaf', async () => {
    const setup = await managedFixture()
    await ensureManagedCa(setup.tls)
    const config = await materializeManagedSetup(setup, interfaceTable('192.168.50.23'))
    expect(Object.prototype.hasOwnProperty.call(config, 'additionalAuthorities')).toBe(true)
    expect(config.additionalAuthorities).toEqual([])

    const leaf = new X509Certificate(await readFile(setup.tls.certFile, 'utf8'))
    expect(leaf.checkIP('192.168.50.23')).toBe('192.168.50.23')
    expect(leaf.checkIP('127.0.0.1')).toBeUndefined()
    expect(leaf.checkIP('::1')).toBeUndefined()
    expect(leaf.subjectAltName ?? '').not.toContain('127.0.0.1')
  })

  it('treats additionalAuthorities: [] exactly like an absent property', () => {
    const absent = parseGatewayConfig(gatewayConfig())
    const empty = parseGatewayConfig(gatewayConfig({ additionalAuthorities: [] }))
    expect(empty.authorities).toEqual(absent.authorities)
    expect(empty.listenPort).toBe(absent.listenPort)
  })
})

describe('ManagedSetup loopback tunnel: enabled', () => {
  it('adds both loopback IPs to the real leaf without dropping the LAN address', async () => {
    const setup = { ...await managedFixture(), loopbackTunnel: true }
    await ensureManagedCa(setup.tls)
    const config = await materializeManagedSetup(setup, interfaceTable('192.168.50.23'))

    const leaf = new X509Certificate(await readFile(setup.tls.certFile, 'utf8'))
    expect(leaf.checkIP('192.168.50.23')).toBe('192.168.50.23')
    expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1')
    expect(leaf.checkIP('::1')).toBe('::1')
    const names = leaf.subjectAltName ?? ''
    expect(names).toContain('IP Address:192.168.50.23')
    expect(names).toContain('IP Address:127.0.0.1')
    expect(names).toMatch(/IP Address:(?:0:0:0:0:0:0:0:1|::1)/u)

    expect(config.additionalAuthorities).toEqual(['127.0.0.1:3443', '[::1]:3443'])
  })

  it('accepts the materialized authorities as HTTPS origins and exact hosts', async () => {
    const setup = { ...await managedFixture(), loopbackTunnel: true }
    await ensureManagedCa(setup.tls)
    const materialized = await materializeManagedSetup(setup, interfaceTable('192.168.50.23'))
    const resolved = parseGatewayConfig({
      ...gatewayConfig({ publicAuthorities: undefined, listenPort: undefined }),
      ...materialized,
    })

    expect(resolved.authorities).toEqual([
      { hostname: '192.168.50.23', port: 3443 },
      { hostname: '127.0.0.1', port: 3443 },
      { hostname: '[::1]', port: 3443 },
    ])
    const policy = new RequestTrustPolicy(resolved.authorities, resolved.listenPort, resolved.allowedCidrs, resolved.publicTls)
    expect(resolved.publicTls).toBe(true)
    expect(policy.origins.has('https://127.0.0.1:3443')).toBe(true)
    expect(policy.origins.has('https://[::1]:3443')).toBe(true)
    expect(policy.acceptsOrigin('https://127.0.0.1:3443')).toBe(true)
    expect(policy.acceptsHost('127.0.0.1:3443')).toBe(true)
    expect(policy.acceptsHost('[::1]:3443')).toBe(true)
  })

  it('reports the loopback origin and advertises a pairing URL with the same fragment', async () => {
    const gateway = await startGateway({ loopbackTunnel: true, additionalAuthorities: ['127.0.0.1', '[::1]'] })
    const port = gateway.address().port
    expect(gateway.loopbackOrigin()).toBe(`https://127.0.0.1:${String(port)}`)

    const pairing = await openPairingThroughAdminRoute(gateway)
    expect(pairing.loopbackPairUrl).toBe(`https://127.0.0.1:${String(port)}/mobile-access/pair${new URL(pairing.pairUrl).hash}`)
    expect(new URL(pairing.loopbackPairUrl!).origin).toBe(`https://127.0.0.1:${String(port)}`)
    expect(new URL(pairing.loopbackPairUrl!).hash).toBe(new URL(pairing.pairUrl).hash)
    expect(new URL(pairing.pairUrl).origin).toBe(`https://192.168.50.23:${String(port)}`)
  })

  it('accepts the tunnel on a port of its own and reports it in the pairing URL', async () => {
    // A visitor bound to 6000 forwards raw bytes to the listener; the client's Host then
    // carries 127.0.0.1:6000, which the gateway must accept as an exact authority.
    const gateway = await startGateway({ loopbackTunnel: true, additionalAuthorities: ['127.0.0.1:6000', '[::1]:6000'] })
    const listenerPort = gateway.address().port
    expect(gateway.loopbackOrigin()).toBe('https://127.0.0.1:6000')

    const pairing = await openPairingThroughAdminRoute(gateway)
    expect(new URL(pairing.loopbackPairUrl!).origin).toBe('https://127.0.0.1:6000')
    expect(new URL(pairing.loopbackPairUrl!).hash).toBe(new URL(pairing.pairUrl).hash)
    // The LAN authority is unaffected and still uses the listener port.
    expect(new URL(pairing.pairUrl).origin).toBe(`https://192.168.50.23:${String(listenerPort)}`)
  })

  it('keeps the loopback origin and pairing key absent when the tunnel is off', async () => {
    const gateway = await startGateway({ loopbackTunnel: false })
    expect(gateway.loopbackOrigin()).toBeUndefined()
    const pairing = await openPairingThroughAdminRoute(gateway)
    expect(Object.prototype.hasOwnProperty.call(pairing, 'loopbackPairUrl')).toBe(false)
    expect(new URL(pairing.pairUrl).origin).toBe(`https://192.168.50.23:${String(gateway.address().port)}`)
  })

  it('declares exactly the two IP literals as tunnel loopback names', () => {
    expect([...LOOPBACK_TUNNEL_ADDRESSES]).toEqual(['127.0.0.1', '::1'])
    expect(Object.isFrozen(LOOPBACK_TUNNEL_ADDRESSES)).toBe(true)
  })
})

describe('ManagedSetup loopback tunnel: rejection paths', () => {
  it('rejects non-boolean loopbackTunnel values in a durable setup', async () => {
    const setup = await managedFixture()
    for (const value of ['true', 'false', 1, 0, null, {}, []]) {
      expect(() => parseManagedSetup({ ...setup, loopbackTunnel: value })).toThrow()
    }
    expect(() => parseLoopbackTunnel('true')).toThrow()
    expect(() => parseLoopbackTunnel(1)).toThrow()
    expect(() => parseLoopbackTunnel(null)).toThrow()
    expect(() => parseLoopbackTunnel(undefined)).toThrow()
    expect(() => parseLoopbackTunnel({})).toThrow()
    expect(parseLoopbackTunnel(true)).toBe(true)
    expect(parseLoopbackTunnel(false)).toBe(false)
  })

  it('accepts a loopback addition at the tunnel port but not at an unrelated public one', () => {
    // The visitor may be bound to a port of its own, so a loopback name may differ from
    // listenPort. A public name may not: that would move the listener's declared authority.
    const accepted = parseGatewayConfig(gatewayConfig({
      additionalAuthorities: ['127.0.0.1:3444', '[::1]:3444'],
    }))
    expect(accepted.additionalAuthorities.map(entry => entry.port)).toEqual([3444, 3444])
    expect(() => parseGatewayConfig(gatewayConfig({
      additionalAuthorities: ['192.168.1.10:3444'],
    }))).toThrow()
  })

  it('rejects duplicate additional authorities and duplicates of the public authority', () => {
    expect(() => parseGatewayConfig(gatewayConfig({
      additionalAuthorities: ['127.0.0.1:3443', '127.0.0.1:3443'],
    }))).toThrow()
    expect(() => parseGatewayConfig(gatewayConfig({
      additionalAuthorities: ['192.168.50.23:3443'],
    }))).toThrow()
  })

  it('rejects URL components and separators inside an additional authority', () => {
    for (const value of ['127.0.0.1/24', '127.0.0.1?x', '127.0.0.1#x', 'user@127.0.0.1', '127.0.0.1\\x', ' 127.0.0.1']) {
      expect(() => parseGatewayConfig(gatewayConfig({ additionalAuthorities: [value] }))).toThrow()
    }
  })

  it('refuses loopback-only listeners that declare additional authorities without a public one', () => {
    // The same loopback listener without the declaration stays valid: only the new list is gated.
    expect(() => parseGatewayConfig(gatewayConfig({ publicAuthorities: undefined, listenPort: 3443 }))).not.toThrow()
    expect(() => parseGatewayConfig(gatewayConfig({
      publicAuthorities: undefined,
      additionalAuthorities: ['127.0.0.1:3443'],
    }))).toThrow()
    expect(() => parseGatewayConfig(gatewayConfig({
      publicAuthorities: [],
      additionalAuthorities: ['127.0.0.1:3443'],
    }))).toThrow()
  })
})

describe('ManagedSetup loopback tunnel persistence', () => {
  it('saves and reads back the opt-in without touching the rest of the setup', async () => {
    const setup = { ...await managedFixture(), listenPort: 4567, extraAllowedCidrs: ['11.24.0.0/24'] }
    await ensureManagedCa(setup.tls)
    const caBefore = await readFile(setup.tls.caCertFile, 'utf8')
    const setupFile = join(dirname(setup.tls.caCertFile), 'setup.json')
    await writeFile(setupFile, `${JSON.stringify(setup, null, 2)}\n`)

    const saved = await saveManagedLoopbackTunnel(setupFile, true)
    expect(saved).toMatchObject({ loopbackTunnel: true, extraAllowedCidrs: ['11.24.0.0/24'], listenPort: 4567 })
    const readBack = parseManagedSetup(JSON.parse(await readFile(setupFile, 'utf8')))
    expect(readBack).toEqual({ ...setup, loopbackTunnel: true })
    expect(readBack.extraAllowedCidrs).toEqual(['11.24.0.0/24'])
    expect(readBack.networkInterface).toBe('WLAN')
    expect(readBack.listenPort).toBe(4567)
    expect(readBack.tls).toEqual(setup.tls)
    expect(await readFile(setup.tls.caCertFile, 'utf8')).toBe(caBefore)

    await saveManagedLoopbackTunnel(setupFile, false)
    expect(parseManagedSetup(JSON.parse(await readFile(setupFile, 'utf8')))).toEqual({ ...setup, loopbackTunnel: false })
  })

  it('keeps the previous file intact when the new value cannot be validated', async () => {
    const setup = await managedFixture()
    const setupFile = join(dirname(setup.tls.caCertFile), 'setup.json')
    await writeFile(setupFile, `${JSON.stringify(setup, null, 2)}\n`)
    const before = await readFile(setupFile, 'utf8')

    await expect(saveManagedLoopbackTunnel(setupFile, 'true')).rejects.toThrow()
    expect(await readFile(setupFile, 'utf8')).toBe(before)
  })

  it('does not let an enabled setup leak into a later disabled one', async () => {
    const setup = await managedFixture()
    await ensureManagedCa(setup.tls)
    const setupFile = join(dirname(setup.tls.caCertFile), 'setup.json')
    await writeFile(setupFile, `${JSON.stringify(setup, null, 2)}\n`)

    await saveManagedLoopbackTunnel(setupFile, true)
    const enabled = await materializeManagedSetup(
      parseManagedSetup(JSON.parse(await readFile(setupFile, 'utf8'))),
      interfaceTable('192.168.50.23'),
    )
    expect(enabled.additionalAuthorities).toEqual(['127.0.0.1:3443', '[::1]:3443'])

    await saveManagedLoopbackTunnel(setupFile, false)
    const disabled = await materializeManagedSetup(
      parseManagedSetup(JSON.parse(await readFile(setupFile, 'utf8'))),
      interfaceTable('192.168.50.23'),
    )
    expect(disabled.additionalAuthorities).toEqual([])
    const leaf = new X509Certificate(await readFile(setup.tls.certFile, 'utf8'))
    expect(leaf.checkIP('127.0.0.1')).toBeUndefined()
    expect(leaf.checkIP('::1')).toBeUndefined()
  })
})
