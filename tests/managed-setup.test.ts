import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  availableLanNetworks,
  ensureManagedCa,
  isNetworkSelectionError,
  materializeManagedSetup,
  parseManagedSetup,
  parseAdditionalTrustedNetworks,
  refreshManagedUpstreamOrigin,
  resolveSavedLanNetwork,
  saveManagedTrustedNetworks,
  preferredLanInterfaceNames,
  selectLanNetwork,
  type ManagedSetup,
} from '../src/managed-setup.js'
import { addressAllowed, parseCidr } from '../src/network.js'

const temporaryDirectories: string[] = []
afterEach(async () => {
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

function interfaceEntry(address: string, prefix = 24) {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4' as const,
    mac: '00:00:00:00:00:00',
    internal: false,
    cidr: `${address}/${String(prefix)}`,
  }
}

async function fixture(): Promise<ManagedSetup> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-managed-'))
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

describe('managed DHCP setup', () => {
  it('adds only explicitly trusted tunnel networks and preserves them while following DHCP', async () => {
    const setup = { ...await fixture(), extraAllowedCidrs: ['11.24.0.0/24', '192.168.50.0/24', '2001:db8::/32'] }
    await ensureManagedCa(setup.tls)
    const first = await materializeManagedSetup(setup, interfaceTable('192.168.50.23'))
    expect(first.allowedCidrs).toEqual(['192.168.50.0/24', '11.24.0.0/24', '2001:db8::/32'])
    const cidrs = parseAdditionalTrustedNetworks(first.allowedCidrs).map(parseCidr)
    expect(addressAllowed('11.24.0.2', cidrs)).toBe(true)
    expect(addressAllowed('11.25.0.2', cidrs)).toBe(false)
    expect(addressAllowed('2001:db8::2', cidrs)).toBe(true)
    const second = await materializeManagedSetup(setup, interfaceTable('192.168.60.23'))
    expect(second.allowedCidrs).toEqual(['192.168.60.0/24', ...setup.extraAllowedCidrs])
  })

  it('keeps legacy managed setup unchanged and rejects invalid extra networks', async () => {
    const setup = await fixture()
    expect(parseManagedSetup(setup)).toEqual(setup)
    expect(parseManagedSetup({ ...setup, extraAllowedCidrs: ['11.24.0.0/24', '11.24.0.0/24'] }).extraAllowedCidrs).toEqual(['11.24.0.0/24'])
    for (const value of ['11.24.0.0/24', [true], ['bad'], ['11.24.0.2/24'], ['11.24.0.0/33']]) {
      expect(() => parseManagedSetup({ ...setup, extraAllowedCidrs: value })).toThrow()
    }
  })

  it('atomically saves extra networks without changing TLS identity and keeps prior data after invalid input', async () => {
    const setup = await fixture()
    const setupFile = join(dirname(setup.tls.caCertFile), 'setup.json')
    await ensureManagedCa(setup.tls)
    const before = await readFile(setup.tls.caCertFile, 'utf8')
    await writeFile(setupFile, `${JSON.stringify(setup)}\n`)
    await saveManagedTrustedNetworks(setupFile, ['11.24.0.0/24'])
    expect(parseManagedSetup(JSON.parse(await readFile(setupFile, 'utf8')))).toEqual({ ...setup, extraAllowedCidrs: ['11.24.0.0/24'] })
    expect(await readFile(setup.tls.caCertFile, 'utf8')).toBe(before)
    const saved = await readFile(setupFile, 'utf8')
    await expect(saveManagedTrustedNetworks(setupFile, ['invalid'])).rejects.toThrow()
    expect(await readFile(setupFile, 'utf8')).toBe(saved)
    await saveManagedTrustedNetworks(setupFile, [])
    expect(parseManagedSetup(JSON.parse(await readFile(setupFile, 'utf8'))).extraAllowedCidrs).toEqual([])
  })
  it('follows the saved interface when its address changes', () => {
    expect(selectLanNetwork(undefined, 'WLAN', interfaceTable('192.168.50.23'))).toEqual({
      name: 'WLAN',
      address: '192.168.50.23',
      cidr: '192.168.50.0/24',
      family: 4,
    })
  })

  it('flags LAN-selection failures as degradable, config failures as fatal', () => {
    const table = interfaceTable('192.168.50.23')
    const selectionErrors = [
      () => selectLanNetwork(undefined, 'Ethernet', table),
      () => selectLanNetwork(undefined, undefined, {}),
      () => selectLanNetwork('10.9.9.9', undefined, table),
      () => selectLanNetwork(undefined, 'WLAN', {
        WLAN: [interfaceEntry('192.168.50.23'), interfaceEntry('192.168.50.24')],
      }),
    ]
    for (const run of selectionErrors) {
      let error: unknown
      try { run() } catch (e) { error = e }
      expect(error).toBeInstanceOf(Error)
      expect(isNetworkSelectionError(error)).toBe(true)
    }
    expect(isNetworkSelectionError(new Error('managed TLS CA certificate and key do not match'))).toBe(false)
    expect(isNetworkSelectionError(new Error('mobile setup networkInterface'))).toBe(false)
    expect(isNetworkSelectionError(undefined)).toBe(false)
    expect(isNetworkSelectionError('plain string')).toBe(false)
  })

  it('uses the physical default route instead of active virtual networks', async () => {
    const table = {
      Mihomo: [interfaceEntry('10.0.0.2')],
      WLAN: [interfaceEntry('192.168.50.23')],
      'vEthernet (WSL)': [interfaceEntry('172.18.176.1', 20)],
    }
    const preferred = await preferredLanInterfaceNames('win32', async () => 'WLAN\r\n')

    expect(selectLanNetwork(undefined, undefined, table, preferred)).toEqual({
      name: 'WLAN',
      address: '192.168.50.23',
      cidr: '192.168.50.0/24',
      family: 4,
    })
  })

  it('selects the only physical-looking LAN when route inspection is unavailable', () => {
    expect(selectLanNetwork(undefined, undefined, {
      Ethernet: [interfaceEntry('192.168.10.8')],
      'vEthernet (Default Switch)': [interfaceEntry('172.20.0.1')],
      'Radmin VPN': [interfaceEntry('10.20.30.40')],
    })).toMatchObject({ name: 'Ethernet', address: '192.168.10.8' })
  })

  it('keeps an explicit address and reports genuinely ambiguous physical LANs', () => {
    const table = {
      Ethernet: [interfaceEntry('192.168.10.8')],
      WLAN: [interfaceEntry('192.168.50.23')],
    }
    expect(selectLanNetwork('192.168.50.23', undefined, table, ['Ethernet']))
      .toMatchObject({ name: 'WLAN', address: '192.168.50.23' })
    expect(() => selectLanNetwork(undefined, undefined, table)).toThrow(
      'Ethernet=192.168.10.8, WLAN=192.168.50.23',
    )
  })

  it('builds LAN candidates from CGNAT addresses without accepting adjacent ranges', () => {
    expect(availableLanNetworks({ Ethernet: [interfaceEntry('100.64.0.77', 10)] })).toEqual([{
      name: 'Ethernet',
      address: '100.64.0.77',
      cidr: '100.64.0.0/10',
      family: 4,
    }])
    for (const address of ['100.64.0.0', '100.127.255.255']) {
      expect(availableLanNetworks({ Ethernet: [interfaceEntry(address)] })).toHaveLength(1)
    }
    for (const address of ['100.63.255.255', '100.128.0.0']) {
      expect(availableLanNetworks({ Ethernet: [interfaceEntry(address)] })).toEqual([])
    }
  })

  it('materializes a managed HTTPS origin on a CGNAT LAN interface', async () => {
    const setup = { ...await fixture(), networkInterface: 'Ethernet' }
    await ensureManagedCa(setup.tls)
    const config = await materializeManagedSetup(setup, {
      Ethernet: [interfaceEntry('100.64.0.180')],
    })
    expect(config).toMatchObject({
      publicOrigin: 'https://100.64.0.180:3443',
      listenHost: '100.64.0.180',
      allowedCidrs: ['100.64.0.0/24'],
    })
  })

  it('parses Linux default routes by metric and ignores tunnel interfaces', async () => {
    const routes = [
      'default dev tun0 metric 1',
      'default via 192.168.50.1 dev wlan0 metric 600',
      'default via 192.168.10.1 dev eth0 metric 100',
    ].join('\n')
    await expect(preferredLanInterfaceNames('linux', async () => routes)).resolves.toEqual(['eth0', 'wlan0'])
  })

  it('keeps one CA while signing a leaf for the current address', async () => {
    const setup = await fixture()
    const ca = await ensureManagedCa(setup.tls)
    const config = await materializeManagedSetup(setup, interfaceTable('192.168.50.23'))
    const leaf = new X509Certificate(await readFile(setup.tls.certFile, 'utf8'))

    expect(config).toMatchObject({
      publicOrigin: 'https://192.168.50.23:3443',
      listenHost: '192.168.50.23',
      allowedCidrs: ['192.168.50.0/24'],
      pairingCaFile: setup.tls.caCertFile,
    })
    expect(leaf.checkIP('192.168.50.23')).toBe('192.168.50.23')
    expect(leaf.verify(ca.publicKey)).toBe(true)
    expect(leaf.subject).not.toBe(leaf.issuer)

    await materializeManagedSetup(setup, interfaceTable('192.168.50.99'))
    const rotated = new X509Certificate(await readFile(setup.tls.certFile, 'utf8'))
    const persistedCa = new X509Certificate(await readFile(setup.tls.caCertFile, 'utf8'))
    expect(rotated.checkIP('192.168.50.99')).toBe('192.168.50.99')
    expect(rotated.verify(persistedCa.publicKey)).toBe(true)
    expect(persistedCa.fingerprint256).toBe(ca.fingerprint256)
  })

  it('keeps a custom Mobile HTTPS port independent from the active DSH Web port', async () => {
    const setup = { ...await fixture(), listenPort: 4567 }
    await ensureManagedCa(setup.tls)
    const config = await materializeManagedSetup(setup, interfaceTable('192.168.50.23'))
    expect(config).toMatchObject({
      publicOrigin: 'https://192.168.50.23:4567',
      listenHost: '192.168.50.23',
    })
    expect(config).not.toHaveProperty('upstreamOrigin')
  })

  it('rejects unknown durable fields before using paths', () => {
    expect(() => parseManagedSetup({
      version: 2,
      networkInterface: 'WLAN',
      listenPort: 3443,
      upstreamOrigin: 'http://127.0.0.1:3080',
      tls: {
        mode: 'managed',
        caCertFile: 'ca.pem',
        caKeyFile: 'ca-key.pem',
        certFile: 'server.pem',
        keyFile: 'server-key.pem',
      },
      unexpected: true,
    })).toThrow('unsupported format')
  })
})

function ipv6Entry(address: string, prefix = 64, internal = false) {
  return {
    address,
    netmask: 'ffff:ffff:ffff:ffff::',
    family: 'IPv6' as const,
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/${String(prefix)}`,
    scopeid: 0,
  }
}

describe('managed IPv6 LAN setup', () => {
  const STABLE_V6 = '240c:ca04:2401:283f:c15:dfff:fe88:549'
  const TEMPORARY_V6 = '240c:ca04:2401:283f:1234:5678:9abc:def0'
  const ULA_V6 = 'fd12:3456:789a::5'

  it('offers IPv6 after IPv4 and skips link-local, loopback and missing prefixes', () => {
    const networks = availableLanNetworks({
      WLAN: [
        interfaceEntry('172.24.224.105', 16),
        ipv6Entry(STABLE_V6),
        ipv6Entry(TEMPORARY_V6),
        ipv6Entry('fe80::c15:dfff:fe88:549'),
        ipv6Entry('::1', 128, true),
        ipv6Entry(ULA_V6),
      ],
    })
    expect(networks.map(entry => entry.address)).toEqual([
      '172.24.224.105',
      STABLE_V6,
      TEMPORARY_V6,
      ULA_V6,
    ])
    expect(networks[1]).toMatchObject({
      family: 6,
      cidr: '240c:ca04:2401:283f::/64',
      publicAddress: true,
    })
    expect(networks[3]).toMatchObject({ family: 6, cidr: 'fd12:3456:789a::/64', publicAddress: false })
  })

  it('excludes transition tunnels, virtual adapters and /128 privacy suffixes', () => {
    const networks = availableLanNetworks({
      WLAN: [ipv6Entry(STABLE_V6), ipv6Entry('240c:ca04:2401:283f:edcd:4422:b56:973a', 128)],
      'Teredo Tunneling Pseudo-Interface': [ipv6Entry('2001:0:14c9:d502:3c66:167e:39ed:fffe')],
      'Radmin VPN': [ipv6Entry('fdfd::1ad0:dcc')],
      '6to4 Adapter': [ipv6Entry('2002:c0a8:0101::1', 48)],
    })
    expect(networks.map(entry => entry.address)).toEqual([STABLE_V6])
  })

  it('keeps IPv4 as the dual-stack default and selects IPv6 only by exact address', () => {
    const table = {
      WLAN: [interfaceEntry('172.24.224.105', 16), ipv6Entry(STABLE_V6)],
    }
    expect(selectLanNetwork(undefined, 'WLAN', table)).toMatchObject({ address: '172.24.224.105', family: 4 })
    expect(selectLanNetwork(STABLE_V6, undefined, table)).toMatchObject({ address: STABLE_V6, family: 6 })
  })

  it('follows the saved IPv6 address and falls back to the interface when it rotates', async () => {
    const setup = { ...await fixture(), networkInterface: 'WLAN', networkAddress: STABLE_V6 }
    expect(resolveSavedLanNetwork(setup, {
      WLAN: [interfaceEntry('172.24.224.105', 16), ipv6Entry(STABLE_V6), ipv6Entry(TEMPORARY_V6)],
    }).address).toBe(STABLE_V6)
    // The privacy suffix rotated away: follow the interface instead of failing closed.
    expect(resolveSavedLanNetwork(setup, {
      WLAN: [interfaceEntry('172.24.224.105', 16), ipv6Entry(TEMPORARY_V6)],
    }).address).toBe('172.24.224.105')
  })

  it('materializes a bracketed IPv6 origin and signs a leaf for it', async () => {
    const setup = { ...await fixture(), networkInterface: 'WLAN', networkAddress: STABLE_V6 }
    await ensureManagedCa(setup.tls)
    const config = await materializeManagedSetup(setup, {
      WLAN: [interfaceEntry('172.24.224.105', 16), ipv6Entry(STABLE_V6)],
    })
    expect(config).toMatchObject({
      publicOrigin: `https://[${STABLE_V6}]:3443`,
      listenHost: STABLE_V6,
      allowedCidrs: ['240c:ca04:2401:283f::/64'],
    })
    const leaf = new X509Certificate(await readFile(setup.tls.certFile, 'utf8'))
    expect(leaf.checkIP(STABLE_V6)).toBe(STABLE_V6)
  })

  it('persists a valid networkAddress and rejects a non-literal one', async () => {
    const setup = await fixture()
    expect(parseManagedSetup({ ...setup, networkAddress: STABLE_V6 }).networkAddress).toBe(STABLE_V6)
    expect(() => parseManagedSetup({ ...setup, networkAddress: 'wlan0' })).toThrow('IP literal')
    expect(() => parseManagedSetup({ ...setup, networkAddress: '' })).toThrow('IP literal')
  })
})

describe('managed setup upstream snapshot', () => {
  it('refreshes only the legacy upstreamOrigin and keeps every other field', async () => {
    const setup = { ...await fixture(), extraAllowedCidrs: ['11.24.0.0/24'] }
    const setupFile = join(dirname(setup.tls.caCertFile), 'setup.json')
    await writeFile(setupFile, `${JSON.stringify(setup, null, 2)}\n`)

    expect(await refreshManagedUpstreamOrigin(setupFile, setup, 57_725)).toBe(true)
    const rewritten = parseManagedSetup(JSON.parse(await readFile(setupFile, 'utf8')))
    expect(rewritten).toEqual({ ...setup, upstreamOrigin: 'http://127.0.0.1:57725' })

    // Already current: no rewrite, and an unusable port is not written at all.
    const current = { ...setup, upstreamOrigin: 'http://127.0.0.1:57725' }
    expect(await refreshManagedUpstreamOrigin(setupFile, current, 57_725)).toBe(false)
    expect(await refreshManagedUpstreamOrigin(setupFile, current, 0)).toBe(false)
    expect(parseManagedSetup(JSON.parse(await readFile(setupFile, 'utf8')))).toEqual(current)
  })
})
