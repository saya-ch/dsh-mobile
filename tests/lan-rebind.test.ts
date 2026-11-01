import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareManagedLanSetup } from '../src/lan-setup.js'
import { rebindManagedLan } from '../src/lan-rebind.js'
import { JsonMobileAccessControlStore, MobileAccessGatewayController } from '../src/control.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

describe('managed LAN rebind', () => {
  it('does not interrupt a live runtime or repair an unreadable identity during preflight', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-rebind-preflight-'))
    directories.push(directory)
    const setupFile = join(directory, 'setup.json')
    const controlFile = join(directory, 'control.json')
    const first = await prepareManagedLanSetup({ setupFile, controlFile,
      network: { name: 'old', address: '10.0.0.5', cidr: '10.0.0.0/24' }, listenPort: 3443, dshPort: 3080, configureFirewall: false })
    let stops = 0
    const controller = new MobileAccessGatewayController(new JsonMobileAccessControlStore(controlFile, true), async () => ({ close: async () => { stops++ } }))
    await controller.initialize()
    const previous = await readFile(setupFile, 'utf8')
    await writeFile(first.setup.tls.caKeyFile, 'unreadable-key')
    try {
      await expect(rebindManagedLan({ setupFile, controller,
        network: { name: 'new', address: '10.1.0.5', cidr: '10.1.0.0/24' }, publish: () => { throw new Error('Unexpected publication') } }))
        .rejects.toMatchObject({ name: 'ManagedLanConfigurationError' })
      expect(stops).toBe(0)
      expect(controller.isRunning()).toBe(true)
      expect(await readFile(setupFile, 'utf8')).toBe(previous)
      expect(await readFile(first.setup.tls.caKeyFile, 'utf8')).toBe('unreadable-key')
    } finally { await controller.close() }
  })

  it('keeps the CA, updates the saved interface and re-signs the leaf for the new address', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-rebind-'))
    directories.push(directory)
    const setupFile = join(directory, 'mobile-access-setup.json')
    const controlFile = join(directory, 'mobile-access-control.json')
    const tlsDirectory = join(directory, 'tls')

    const first = await prepareManagedLanSetup({
      setupFile,
      controlFile,
      network: { name: 'Wi-Fi', address: '10.0.0.5', cidr: '10.0.0.0/24' },
      listenPort: 3443,
      dshPort: 3080,
      configureFirewall: false,
    })
    const caBefore = await readFile(join(tlsDirectory, 'ca.pem'), 'utf8')
    expect(first.origin).toBe('https://10.0.0.5:3443')
    await writeFile(setupFile, JSON.stringify({ ...first.setup, extraAllowedCidrs: ['10.22.0.0/16'] }))
    await writeFile(controlFile, '{"version":1,"enabled":false}\n')

    const controller = new MobileAccessGatewayController(new JsonMobileAccessControlStore(controlFile, false), async () => {
      throw new Error('A disabled listener must not be started by rebind')
    })
    await controller.initialize()
    const second = await rebindManagedLan({
      setupFile,
      controller,
      network: { name: 'Ethernet', address: '10.0.0.9', cidr: '10.0.0.0/24' },
      publish: () => {},
    })
    await controller.close()

    // The CA identity is reused, so already-paired phones keep trusting the gateway.
    expect(await readFile(join(tlsDirectory, 'ca.pem'), 'utf8')).toBe(caBefore)

    // The saved setup follows the new interface.
    const saved = JSON.parse(await readFile(setupFile, 'utf8')) as { networkInterface?: string }
    expect(saved.networkInterface).toBe('Ethernet')
    expect(JSON.parse(await readFile(setupFile, 'utf8')).extraAllowedCidrs).toEqual(['10.22.0.0/16'])
    expect(JSON.parse(await readFile(controlFile, 'utf8')).enabled).toBe(false)
    expect(second.setup.networkInterface).toBe('Ethernet')
    expect(second.running).toBe(false)

    // The server leaf is re-signed for the new address.
    const leaf = new X509Certificate(await readFile(join(tlsDirectory, 'server-cert.pem'), 'utf8'))
    expect(leaf.subjectAltName ?? '').toContain('10.0.0.9')
  })
})
