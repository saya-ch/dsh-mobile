import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOOPBACK_TUNNEL_ADDRESSES,
  ensureManagedCa,
  parseAdditionalTrustedNetworks,
  parseLoopbackTunnel,
  parseLoopbackTunnelPort,
  parseManagedSetup,
  readManagedSetupForStart,
  refreshManagedServerCertificate,
  saveManagedLoopbackTunnel,
} from '../src/managed-setup.js'
import { parseGatewayConfig } from '../src/config.js'

/**
 * Loopback tunnel (#444): an administrator who runs a local tunnel themselves — an frp
 * stcp visitor on the phone, for example — can reach the gateway on 127.0.0.1 without
 * exposing a public port. Off by default, and it only adds two exact names: the Origin,
 * CSRF, CIDR and credential checks are unchanged.
 */

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loopback-tunnel-'))
  dirs.push(dir)
  return dir
}

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

/** Expand both spellings ("::1" and "0:0:0:0:0:0:0:1") to the same eight groups. */
function expandIpv6(value: string): string[] {
  if (!value.includes(':')) return []
  const [head = '', tail] = value.split('::')
  const left = head === '' ? [] : head.split(':')
  const right = tail === undefined || tail === '' ? [] : tail.split(':')
  const zeros = Math.max(0, 8 - left.length - right.length)
  return [...left, ...Array<string>(zeros).fill('0'), ...right].map(part => part.replace(/^0+/u, '') || '0')
}

/** Sign one leaf for the given opt-in state and return its subjectAltName entries. */
async function leafAltNames(loopbackTunnel: boolean): Promise<string[]> {
  const dir = await tempDir()
  const tls = {
    mode: 'managed' as const,
    caCertFile: join(dir, 'ca.pem'),
    caKeyFile: join(dir, 'ca-key.pem'),
    certFile: join(dir, 'cert.pem'),
    keyFile: join(dir, 'key.pem'),
  }
  const setup = parseManagedSetup({
    version: 2,
    networkInterface: 'WLAN',
    listenPort: 3443,
    upstreamOrigin: 'http://127.0.0.1:3080',
    ...(loopbackTunnel ? { loopbackTunnel: true } : {}),
    tls,
  })
  await ensureManagedCa(tls)
  await refreshManagedServerCertificate(setup, '192.168.50.23')
  const leaf = new X509Certificate(await readFile(tls.certFile, 'utf8'))
  return (leaf.subjectAltName ?? '').split(',').map(entry => entry.trim())
}

const base = {
  version: 2 as const,
  networkInterface: 'WLAN',
  listenPort: 3443,
  upstreamOrigin: 'http://127.0.0.1:3080',
  tls: {
    mode: 'managed' as const,
    caCertFile: '/tmp/ca.pem',
    caKeyFile: '/tmp/ca-key.pem',
    certFile: '/tmp/cert.pem',
    keyFile: '/tmp/key.pem',
  },
}

describe('loopback tunnel sanity', () => {
  it('parses the flag and defaults to absent', () => {
    expect(parseManagedSetup(base)).not.toHaveProperty('loopbackTunnel')
    expect(parseManagedSetup({ ...base, loopbackTunnel: true }).loopbackTunnel).toBe(true)
    expect(parseManagedSetup({ ...base, loopbackTunnel: false }).loopbackTunnel).toBe(false)
    expect(() => parseManagedSetup({ ...base, loopbackTunnel: 'true' })).toThrow()
    expect(() => parseLoopbackTunnel(1)).toThrow()
    expect(LOOPBACK_TUNNEL_ADDRESSES).toEqual(['127.0.0.1', '::1'])
  })

  it('round-trips through the setter without disturbing other fields', async () => {
    const dir = await tempDir()
    const file = join(dir, 'setup.json')
    await writeFile(file, JSON.stringify({ ...base, extraAllowedCidrs: ['10.9.0.0/24'] }))
    const saved = await saveManagedLoopbackTunnel(file, true)
    expect(saved.loopbackTunnel).toBe(true)
    const reread = parseManagedSetup(JSON.parse(await import('node:fs/promises').then(m => m.readFile(file, 'utf8'))))
    expect(reread.loopbackTunnel).toBe(true)
    expect(parseAdditionalTrustedNetworks(reread.extraAllowedCidrs)).toEqual(['10.9.0.0/24'])
    expect(reread.listenPort).toBe(3443)
  })

  it('makes the gateway accept the loopback origin and keeps the LAN one first', async () => {
    const off = parseGatewayConfig({
      publicOrigin: 'https://192.168.1.10:3443',
      listenHost: '192.168.1.10',
      upstreamOrigin: 'http://127.0.0.1:3080',
      allowedCidrs: ['192.168.1.0/24'],
      additionalAuthorities: [],
      stateFile: join(tmpdir(), `loopback-${String(Date.now())}-a.json`),
      tls: { mode: 'provided', certFile: '/tmp/c.pem', keyFile: '/tmp/k.pem' },
    })
    expect(off.authorities.map(entry => `${entry.hostname}:${String(entry.port)}`)).toEqual(['192.168.1.10:3443'])
    const on = parseGatewayConfig({
      publicOrigin: 'https://192.168.1.10:3443',
      listenHost: '192.168.1.10',
      upstreamOrigin: 'http://127.0.0.1:3080',
      allowedCidrs: ['192.168.1.0/24'],
      additionalAuthorities: ['127.0.0.1:3443', '[::1]:3443'],
      stateFile: join(tmpdir(), `loopback-${String(Date.now())}-b.json`),
      tls: { mode: 'provided', certFile: '/tmp/c.pem', keyFile: '/tmp/k.pem' },
    })
    expect(on.authorities.map(entry => `${entry.hostname}:${String(entry.port)}`)).toEqual([
      '192.168.1.10:3443', '127.0.0.1:3443', '[::1]:3443',
    ])
  })

  it('accepts the empty list the materializer always emits but not a non-array', () => {
    // Regression: the materializer emits additionalAuthorities: [] whenever the opt-in is
    // off, so treating an empty list as invalid would break every managed start. A
    // non-array, on the other hand, must fail loudly instead of passing as "none".
    const withAdditional = (additionalAuthorities: unknown) => () => parseGatewayConfig({
      publicOrigin: 'https://192.168.1.10:3443',
      listenHost: '192.168.1.10',
      upstreamOrigin: 'http://127.0.0.1:3080',
      allowedCidrs: ['192.168.1.0/24'],
      additionalAuthorities,
      stateFile: join(tmpdir(), `loopback-${String(Date.now())}-shape.json`),
      tls: { mode: 'provided', certFile: '/tmp/c.pem', keyFile: '/tmp/k.pem' },
    } as never)
    expect(withAdditional([])()).toBeDefined()
    expect(withAdditional({})).toThrow()
    expect(withAdditional(3)).toThrow()
    expect(withAdditional('127.0.0.1:3443')).toThrow()
  })

  it('keeps the saved tunnel port on the authority, and listenPort when it is absent', () => {
    // The visitor can be bound anywhere; the accepted Host follows the saved port.
    const base = {
      publicOrigin: 'https://192.168.1.10:3443',
      listenHost: '192.168.1.10',
      upstreamOrigin: 'http://127.0.0.1:3080',
      allowedCidrs: ['192.168.1.0/24'],
      stateFile: join(tmpdir(), `loopback-${String(Date.now())}-p.json`),
      tls: { mode: 'provided', certFile: '/tmp/c.pem', keyFile: '/tmp/k.pem' },
    } as const
    const custom = parseGatewayConfig({ ...base, additionalAuthorities: ['127.0.0.1:6000', '[::1]:6000'] } as never)
    expect(custom.additionalAuthorities.map(entry => entry.port)).toEqual([6000, 6000])
    // Absent port means the listener port, which is what the guide documents.
    const implied = parseGatewayConfig({ ...base, additionalAuthorities: ['127.0.0.1', '[::1]'] } as never)
    expect(implied.additionalAuthorities.map(entry => entry.port)).toEqual([undefined, undefined])
  })

  it('validates the tunnel port as an explicit integer in range', () => {
    for (const bad of [0, -1, 65536, 1.5, '3443', null, Number.NaN]) {
      expect(() => parseLoopbackTunnelPort(bad)).toThrow()
    }
    expect(parseLoopbackTunnelPort(1)).toBe(1)
    expect(parseLoopbackTunnelPort(65535)).toBe(65535)
  })

  it('lets a loopback addition carry the tunnel port but still rejects a bad authority', () => {
    const make = (additionalAuthorities: string[]) => () => parseGatewayConfig({
      publicOrigin: 'https://192.168.1.10:3443',
      listenHost: '192.168.1.10',
      upstreamOrigin: 'http://127.0.0.1:3080',
      allowedCidrs: ['192.168.1.0/24'],
      additionalAuthorities,
      stateFile: join(tmpdir(), `loopback-${String(Date.now())}-c.json`),
      tls: { mode: 'provided', certFile: '/tmp/c.pem', keyFile: '/tmp/k.pem' },
    })
    // The visitor may listen on its own port, so the loopback authority keeps it.
    const tunnelPort = make(['127.0.0.1:9999'])()
    expect(tunnelPort.additionalAuthorities[0]!.port).toBe(9999)
    // Everything else about an authority is still refused.
    expect(make(['127.0.0.1:3443', '127.0.0.1:3443'])).toThrow()
    expect(make(['127.0.0.1:3443/path'])).toThrow()
    expect(make(['user@127.0.0.1:3443'])).toThrow()
    // An omitted port still means the listener port, which is the documented setup.
  expect(make(['127.0.0.1'])()).toBeDefined()
    expect(make(['192.168.1.11:9999'])).toThrow()
  })
})

describe('runtime start reads the saved setup', () => {
  it('uses the file, not the caller fallback, so a just-saved switch takes effect', async () => {
    const dir = await tempDir()
    const file = join(dir, 'setup.json')
    await writeFile(file, JSON.stringify({ ...base, loopbackTunnel: true }))
    // The caller passes an older snapshot (a rebind override, the activation-time setup); the
    // file is written before any override is published, so it is never the stale copy.
    const stale = parseManagedSetup(base)
    const { setup, fresh } = await readManagedSetupForStart(file, stale)
    expect(fresh).toBe(true)
    expect(setup.loopbackTunnel).toBe(true)
  })

  it('reports a fallback instead of claiming the switch was applied', async () => {
    const dir = await tempDir()
    const missing = join(dir, 'absent.json')
    const stale = parseManagedSetup({ ...base, extraAllowedCidrs: ['10.9.0.0/24'] })
    const absent = await readManagedSetupForStart(missing, stale)
    // fresh=false is what keeps the panel's "restart to apply" prompt alive.
    expect(absent.fresh).toBe(false)
    expect(absent.setup).toBe(stale)

    const corrupt = join(dir, 'corrupt.json')
    await writeFile(corrupt, '{ not json')
    const broken = await readManagedSetupForStart(corrupt, stale)
    expect(broken.fresh).toBe(false)
    expect(broken.setup).toBe(stale)
  })
})

describe('loopback tunnel leaf', () => {
  it('leaves the certificate untouched when the opt-in is off', async () => {
    const names = await leafAltNames(false)
    expect(names.some(name => name === 'IP Address:192.168.50.23')).toBe(true)
    expect(names.some(name => name.includes('127.0.0.1'))).toBe(false)
    expect(names.some(name => name.includes('::1'))).toBe(false)
  })

  it('adds both loopback names and keeps the LAN address when the opt-in is on', async () => {
    const names = await leafAltNames(true)
    expect(names.some(name => name === 'IP Address:192.168.50.23')).toBe(true)
    expect(names.some(name => name.includes('127.0.0.1'))).toBe(true)
    // The signer renders IPv6 in its expanded form (0:0:0:0:0:0:0:1), so compare the
    // meaning rather than the spelling; Android matches SAN IP entries by address bytes.
    const ipEntries = names.filter(name => name.startsWith('IP Address:')).map(name => name.slice('IP Address:'.length))
    expect(ipEntries).toContain('127.0.0.1')
    expect(ipEntries.some(entry => expandIpv6(entry).join(':') === expandIpv6('::1').join(':'))).toBe(true)
  })
})
