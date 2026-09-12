import { X509Certificate } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareManagedLanSetup } from '../src/lan-setup.js'
import { parseManagedSetup } from '../src/managed-setup.js'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('managed LAN setup', () => {
  it('creates private TLS material and an enabled restart state after explicit confirmation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-lan-setup-'))
    directories.push(directory)
    const setupFile = join(directory, 'setup.json')
    const controlFile = join(directory, 'control.json')
    const result = await prepareManagedLanSetup({
      setupFile,
      controlFile,
      network: { name: 'Wi-Fi', address: '192.168.50.8', cidr: '192.168.50.0/24' },
      listenPort: 3443,
      dshPort: 43120,
      configureFirewall: false,
    })

    expect(result.origin).toBe('https://192.168.50.8:3443')
    expect(parseManagedSetup(JSON.parse(await readFile(setupFile, 'utf8')))).toMatchObject({
      version: 2,
      networkInterface: 'Wi-Fi',
      listenPort: 3443,
      upstreamOrigin: 'http://127.0.0.1:43120',
    })
    expect(JSON.parse(await readFile(controlFile, 'utf8'))).toEqual({ version: 1, enabled: true })
    const ca = new X509Certificate(await readFile(result.setup.tls.caCertFile, 'utf8'))
    const server = new X509Certificate(await readFile(result.setup.tls.certFile, 'utf8'))
    expect(ca.ca).toBe(true)
    expect(server.ca).toBe(false)
    expect(server.verify(ca.publicKey)).toBe(true)
    expect(await readFile(result.androidCertificate)).toEqual(ca.raw)
  })

  it('rejects relative state paths and invalid listener ports before writing setup', async () => {
    await expect(prepareManagedLanSetup({
      setupFile: 'setup.json',
      controlFile: 'control.json',
      network: { name: 'Wi-Fi', address: '192.168.50.8', cidr: '192.168.50.0/24' },
      listenPort: 443,
      dshPort: 3080,
      configureFirewall: false,
    })).rejects.toThrow(/paths must be absolute/)

    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-lan-setup-invalid-'))
    directories.push(directory)
    await expect(prepareManagedLanSetup({
      setupFile: join(directory, 'setup.json'),
      controlFile: join(directory, 'control.json'),
      network: { name: 'Wi-Fi', address: '192.168.50.8', cidr: '192.168.50.0/24' },
      listenPort: 443,
      dshPort: 3080,
      configureFirewall: false,
    })).rejects.toThrow(/listenPort must be from 1024 through 65535/)
  })
})
