import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ensureManagedCa,
  materializeManagedSetup,
  parseManagedSetup,
  preferredLanInterfaceNames,
  selectLanNetwork,
  type ManagedSetup,
} from '../src/managed-setup.js'

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
  it('follows the saved interface when its address changes', () => {
    expect(selectLanNetwork(undefined, 'WLAN', interfaceTable('192.168.50.23'))).toEqual({
      name: 'WLAN',
      address: '192.168.50.23',
      cidr: '192.168.50.0/24',
    })
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
