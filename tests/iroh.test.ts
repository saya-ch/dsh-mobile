import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { X509Certificate } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IrohController, IrohIdentityProbeError } from '../src/iroh.js'
import type { IrohComponentManager } from '../src/iroh-component.js'
import { irohOrigin } from '../src/iroh-origin.js'
import { ensureIrohTls } from '../src/iroh-tls.js'
import { decodePairingDescriptor } from '../src/iroh-pairing.js'

const ENDPOINT = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
const roots: string[] = []
const prefix = 'dsh-mobile-iroh-controller-test-'

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(root) === root && basename(root).startsWith(prefix) && resolve(root, '..') === resolve(tmpdir())) {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } else throw new Error('Refusing to remove an unowned fixture')
  }
})

class FakeStdio extends EventEmitter {
  destroyed = false
  writableLength = 0
  readonly written: string[] = []
  private readonly buffered: Array<string | Buffer> = []
  /** Simulate bytes already sitting in the OS pipe buffer. */
  stageInput(chunk: string | Buffer): void {
    this.buffered.push(chunk)
  }
  read(): string | Buffer | null {
    const next = this.buffered.shift()
    return next === undefined ? null : next
  }
  write(chunk: string): boolean {
    this.written.push(chunk)
    return true
  }
  resume(): void { /* no-op */ }
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly stdin = new FakeStdio()
  readonly stdout = new FakeStdio()
  readonly stderr = new FakeStdio()
  kill(): boolean {
    if (this.exitCode !== null) return false
    this.exitCode = 0
    queueMicrotask(() => this.emit('close', 0, null))
    return true
  }
}

function fakeStore(enabled = false): { load: () => Promise<{ version: 1; enabled: boolean }>; save: (state: { version: 1; enabled: boolean }) => Promise<void>; saved: { version: 1; enabled: boolean }[] } {
  const saved: { version: 1; enabled: boolean }[] = []
  return {
    saved,
    load: async () => ({ version: 1 as const, enabled }),
    save: async (state) => { saved.push(state) },
  }
}

function fakeComponent(executable: string | null = '/sidecar/host'): IrohComponentManager {
  const status = () => {
    if (executable === null) throw new Error('iroh_companion_missing')
    return { supported: true, installed: true, version: '0.1.0-alpha.1', downloadBytes: 128, installedBytes: 128, sourceUrl: '', releasePage: '', storagePath: executable }
  }
  return {
    executable: executable ?? undefined,
    install: async () => status(),
    ensureAvailable: async () => status(),
  } as unknown as IrohComponentManager
}

function fakeGateway() {
  return {
    address: () => ({ host: '127.0.0.1', port: 23443, origin: 'https://127.0.0.1:23443' }),
    close: vi.fn(async () => undefined),
  }
}

async function fixtureDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('iroh controller', () => {
  it('keeps concurrent close calls pending during an admitted startup', async () => {
    let releaseIdentity!: (id: string) => void
    let enteredIdentity!: () => void
    const entered = new Promise<void>(resolve => { enteredIdentity = resolve })
    const identity = new Promise<string>(resolve => { releaseIdentity = resolve })
    const createGateway = vi.fn(async () => fakeGateway() as never)
    const controller = new IrohController({
      store: fakeStore(true), component: fakeComponent(), dataDirectory: await fixtureDir(),
      createGateway, resolveIdentity: () => { enteredIdentity(); return identity },
    })
    const initializing = controller.initialize()
    await entered
    let closed = 0
    const first = controller.close().then(() => { closed++ })
    const second = controller.close().then(() => { closed++ })
    await Promise.resolve()
    expect(closed).toBe(0)
    releaseIdentity(ENDPOINT)
    await Promise.all([initializing, first, second])
    expect(closed).toBe(2)
    expect(createGateway).not.toHaveBeenCalled()
  })

  it('retains a child after failed termination so close can retry', async () => {
    const child = new FakeChild()
    let refuseStop = true
    const ordinaryKill = child.kill.bind(child)
    child.kill = () => {
      if (refuseStop) throw new Error('controlled stop failure')
      return ordinaryKill()
    }
    const gateway = fakeGateway()
    const controller = new IrohController({
      store: fakeStore(false), component: fakeComponent(), dataDirectory: await fixtureDir(),
      createGateway: async () => gateway as never, resolveIdentity: async () => ENDPOINT,
      launchSidecar: (() => {
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ version: 1, type: 'ready', endpoint_id: ENDPOINT, direct_addresses: [], local_only: false })}\n`)))
        return child
      }) as never,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    await expect(controller.close()).rejects.toThrow('controlled stop failure')
    expect(child.exitCode).toBeNull()
    expect(gateway.close).toHaveBeenCalledTimes(1)
    refuseStop = false
    await controller.close()
    expect(child.exitCode).toBe(0)
    expect(gateway.close).toHaveBeenCalledTimes(1)
  })

  it('stays off without spawning anything', async () => {
    const store = fakeStore(false)
    const launched: unknown[] = []
    const controller = new IrohController({
      store, component: fakeComponent(), dataDirectory: await fixtureDir(),
      createGateway: async () => { throw new Error('must not create') },
      launchSidecar: (() => { launched.push(1); throw new Error('must not launch') }) as never,
      resolveIdentity: async () => { throw new Error('must not resolve') },
    })
    await controller.initialize()
    expect(controller.status()).toEqual({ enabled: false, state: 'off' })
    expect(launched).toEqual([])
    await controller.close()
  })

  it('fails closed with guidance when the companion is missing', async () => {
    const controller = new IrohController({
      store: fakeStore(false), component: fakeComponent(null), dataDirectory: await fixtureDir(),
      createGateway: async () => { throw new Error('must not create') },
    })
    await controller.initialize()
    const status = await controller.setEnabled(true)
    expect(status.enabled).toBe(true)
    expect(status.state).toBe('unavailable')
    expect(status.errorCode).toBe('iroh_companion_missing')
    await controller.close()
  })

  it('surfaces an insecure private directory with the native diagnostic', async () => {
    const failures: Array<{ errorCode: string; diagnostic?: string }> = []
    const controller = new IrohController({
      store: fakeStore(false),
      component: fakeComponent('/sidecar/host'),
      dataDirectory: await fixtureDir(),
      createGateway: async () => { throw new Error('must not create') },
      resolveIdentity: async () => {
        throw new IrohIdentityProbeError(
          'iroh_data_directory_insecure',
          'private path ACL grants access or replacement rights to another principal',
        )
      },
      onFailure: failure => { failures.push(failure) },
    })
    await controller.initialize()
    const status = await controller.setEnabled(true)
    expect(status).toMatchObject({ enabled: true, state: 'error', errorCode: 'iroh_data_directory_insecure' })
    expect(failures).toEqual([{
      errorCode: 'iroh_data_directory_insecure',
      diagnostic: 'private path ACL grants access or replacement rights to another principal',
    }])
    await controller.close()
  })

  it('reaches ready through identity, gateway and sidecar handshake', async () => {
    const gateway = fakeGateway()
    const children: FakeChild[] = []
    const controller = new IrohController({
      store: fakeStore(false), component: fakeComponent('/sidecar/host'), dataDirectory: await fixtureDir(),
      createGateway: async () => gateway as never,
      launchSidecar: ((() => {
        const child = new FakeChild()
        children.push(child)
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ version: 1, type: 'ready', endpoint_id: ENDPOINT, direct_addresses: [], local_only: false })}\n`)))
        return child
      }) as never),
      resolveIdentity: async () => ENDPOINT,
      readyTimeoutMs: 5_000,
    })
    await controller.initialize()
    const pending = controller.setEnabled(true)
    const status = await pending
    expect(status).toEqual({ enabled: true, state: 'ready', origin: irohOrigin(ENDPOINT) })
    expect(children).toHaveLength(1)
    expect(controller.gateway()).toBe(gateway)
    await controller.close()
    expect(gateway.close).toHaveBeenCalled()
  })

  it('rejects a sidecar ready for another endpoint', async () => {
    const gateway = fakeGateway()
    const controller = new IrohController({
      store: fakeStore(false), component: fakeComponent('/sidecar/host'), dataDirectory: await fixtureDir(),
      createGateway: async () => gateway as never,
      launchSidecar: ((() => {
        const child = new FakeChild()
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ version: 1, type: 'ready', endpoint_id: `${ENDPOINT.slice(0, 63)}0`, direct_addresses: [], local_only: false })}\n`)))
        return child
      }) as never),
      resolveIdentity: async () => ENDPOINT,
      readyTimeoutMs: 5_000,
    })
    await controller.initialize()
    const status = await controller.setEnabled(true)
    expect(status.state).toBe('error')
    expect(status.errorCode).toBe('iroh_start_timeout')
    await controller.close()
  })

  it('disables, reconnects and resets without leaking resources', async () => {
    const gateways = [fakeGateway(), fakeGateway()]
    let created = 0
    const children: FakeChild[] = []
    const controller = new IrohController({
      store: fakeStore(false), component: fakeComponent('/sidecar/host'), dataDirectory: await fixtureDir(),
      createGateway: async () => gateways[created++] as never,
      launchSidecar: ((() => {
        const child = new FakeChild()
        children.push(child)
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ version: 1, type: 'ready', endpoint_id: ENDPOINT, direct_addresses: [], local_only: false })}\n`)))
        return child
      }) as never),
      resolveIdentity: async () => ENDPOINT,
      readyTimeoutMs: 5_000,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    expect(controller.status().state).toBe('ready')
    await controller.reconnect()
    expect(controller.status().state).toBe('ready')
    expect(created).toBe(2)
    const firstGateway = gateways[0]
    const secondGateway = gateways[1]
    expect(firstGateway).toBeDefined()
    expect(secondGateway).toBeDefined()
    expect(firstGateway?.close).toHaveBeenCalled()
    const firstChild = children[0]
    expect(firstChild).toBeDefined()
    expect(firstChild?.stdin.written.join('')).toContain('shutdown')
    await controller.reset()
    expect(controller.status()).toEqual({ enabled: false, state: 'off' })
    expect(secondGateway?.close).toHaveBeenCalled()
    await controller.close()
    await expect(controller.setEnabled(true)).rejects.toThrow('unavailable')
  })

  it('refuses pairing windows while the channel is not ready', async () => {
    const controller = new IrohController({
      store: fakeStore(false), component: fakeComponent('/sidecar/host'), dataDirectory: await fixtureDir(),
      createGateway: async () => { throw new Error('must not create') },
    })
    await controller.initialize()
    await expect(controller.beginPairing()).rejects.toThrow('iroh_not_ready')
    await controller.close()
  })

  it('mints a bounded descriptor binding the sidecar code and gateway token', async () => {
    const tlsRoot = await fixtureDir()
    const tlsStateFile = join(tlsRoot, 'remote', 'devices.json')
    const tls = await ensureIrohTls(ENDPOINT, tlsStateFile, tlsRoot)
    const caDer = new X509Certificate(await readFile(tls.paths.caCertFile)).raw
    const gatewayToken = randomBytes(32).toString('base64url')
    const gateway = {
      ...fakeGateway(),
      config: { instanceId: tls.caFingerprint },
      access: { openPairing: vi.fn(async (ttlMs: number) => ({ token: gatewayToken, expiresAt: Date.now() + ttlMs })) },
    }
    const children: FakeChild[] = []
    const controller = new IrohController({
      store: fakeStore(false), component: fakeComponent('/sidecar/host'), dataDirectory: await fixtureDir(),
      createGateway: async () => gateway as never,
      launchSidecar: ((() => {
        const child = new FakeChild()
        children.push(child)
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ version: 1, type: 'ready', endpoint_id: ENDPOINT, direct_addresses: [], local_only: false })}\n`)))
        return child
      }) as never),
      resolveIdentity: async () => ENDPOINT,
      resolvePairingCa: async () => ({ der: caDer, fingerprint: tls.caFingerprint }),
      readyTimeoutMs: 5_000,
      pairingTimeoutMs: 5_000,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    expect(controller.status().state).toBe('ready')
    const child = children[0]
    expect(child).toBeDefined()
    const pairing = controller.beginPairing()
    queueMicrotask(() => child?.stdout.emit('data', Buffer.from(`${JSON.stringify({ version: 1, type: 'pairing', code: '482916', expires_in_sec: 300 })}\n`)))
    const result = await pairing
    expect(result.code).toBe('482916')
    expect(result.descriptor.endpointId).toBe(ENDPOINT)
    expect(result.descriptor.gatewayToken).toBe(gatewayToken)
    expect(result.descriptor.instanceId).toBe(tls.caFingerprint)
    expect(result.descriptor.irohCode).toBe('482916')
    // The minted payload already satisfies the wire validator phones enforce.
    expect(decodePairingDescriptor(result.encoded)).toEqual(result.descriptor)
    expect(child?.stdin.written.join('')).toContain('pairing-begin')
    await controller.close()
  })

  it('caps the gateway pairing window at five minutes', async () => {
    const tlsRoot = await fixtureDir()
    const tlsStateFile = join(tlsRoot, 'remote', 'devices.json')
    const tls = await ensureIrohTls(ENDPOINT, tlsStateFile, tlsRoot)
    const caDer = new X509Certificate(await readFile(tls.paths.caCertFile)).raw
    const gatewayToken = randomBytes(32).toString('base64url')
    const openPairing = vi.fn(async (ttlMs: number) => ({ token: gatewayToken, expiresAt: Date.now() + ttlMs }))
    const gateway = {
      ...fakeGateway(),
      config: { instanceId: tls.caFingerprint },
      access: { openPairing },
    }
    const children: FakeChild[] = []
    const controller = new IrohController({
      store: fakeStore(false), component: fakeComponent('/sidecar/host'), dataDirectory: await fixtureDir(),
      createGateway: async () => gateway as never,
      launchSidecar: ((() => {
        const child = new FakeChild()
        children.push(child)
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ version: 1, type: 'ready', endpoint_id: ENDPOINT, direct_addresses: [], local_only: false })}\n`)))
        return child
      }) as never),
      resolveIdentity: async () => ENDPOINT,
      resolvePairingCa: async () => ({ der: caDer, fingerprint: tls.caFingerprint }),
      readyTimeoutMs: 5_000,
      pairingTimeoutMs: 5_000,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    const child = children[0]
    expect(child).toBeDefined()
    const pairing = controller.beginPairing()
    // The sidecar offers a ten-minute window; the controller must not ask the
    // gateway for more than its five-minute pairing budget.
    queueMicrotask(() => child?.stdout.emit('data', Buffer.from(`${JSON.stringify({ version: 1, type: 'pairing', code: '482916', expires_in_sec: 600 })}\n`)))
    await pairing
    expect(openPairing).toHaveBeenCalledWith(300_000)
    await controller.close()
  })

  it('ignores a stale startup pairing event buffered before pairing begins', async () => {
    const tlsRoot = await fixtureDir()
    const tlsStateFile = join(tlsRoot, 'remote', 'devices.json')
    const tls = await ensureIrohTls(ENDPOINT, tlsStateFile, tlsRoot)
    const caDer = new X509Certificate(await readFile(tls.paths.caCertFile)).raw
    const gatewayToken = randomBytes(32).toString('base64url')
    const gateway = {
      ...fakeGateway(),
      config: { instanceId: tls.caFingerprint },
      access: { openPairing: vi.fn(async (ttlMs: number) => ({ token: gatewayToken, expiresAt: Date.now() + ttlMs })) },
    }
    const children: FakeChild[] = []
    const controller = new IrohController({
      store: fakeStore(false), component: fakeComponent('/sidecar/host'), dataDirectory: await fixtureDir(),
      createGateway: async () => gateway as never,
      launchSidecar: ((() => {
        const child = new FakeChild()
        children.push(child)
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ version: 1, type: 'ready', endpoint_id: ENDPOINT, direct_addresses: [], local_only: false })}\n`)))
        return child
      }) as never),
      resolveIdentity: async () => ENDPOINT,
      resolvePairingCa: async () => ({ der: caDer, fingerprint: tls.caFingerprint }),
      readyTimeoutMs: 5_000,
      pairingTimeoutMs: 5_000,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    const child = children[0]
    expect(child).toBeDefined()
    // The sidecar emits one pairing window on its own at startup when no
    // devices are paired yet. It sits buffered until the first real pairing
    // request and must not be mistaken for the fresh code.
    child?.stdout.stageInput(`${JSON.stringify({ version: 1, type: 'pairing', code: '000000', expires_in_sec: 600 })}\n`)
    const pairing = controller.beginPairing()
    queueMicrotask(() => child?.stdout.emit('data', Buffer.from(`${JSON.stringify({ version: 1, type: 'pairing', code: '482916', expires_in_sec: 600 })}\n`)))
    const result = await pairing
    expect(result.code).toBe('482916')
    expect(result.descriptor.irohCode).toBe('482916')
    await controller.close()
  })

  it('fails pairing when the sidecar reports an error', async () => {    const gateway = { ...fakeGateway(), config: { instanceId: 'x'.repeat(64) }, access: { openPairing: vi.fn() } }
    const children: FakeChild[] = []
    const controller = new IrohController({
      store: fakeStore(false), component: fakeComponent('/sidecar/host'), dataDirectory: await fixtureDir(),
      createGateway: async () => gateway as never,
      launchSidecar: ((() => {
        const child = new FakeChild()
        children.push(child)
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ version: 1, type: 'ready', endpoint_id: ENDPOINT, direct_addresses: [], local_only: false })}\n`)))
        return child
      }) as never),
      resolveIdentity: async () => ENDPOINT,
      readyTimeoutMs: 5_000,
      pairingTimeoutMs: 5_000,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    const child = children[0]
    const pairing = controller.beginPairing()
    queueMicrotask(() => child?.stdout.emit('data', Buffer.from(`${JSON.stringify({ version: 1, type: 'error', code: 'pairing_busy', message: 'busy' })}\n`)))
    await expect(pairing).rejects.toThrow('iroh_pairing_failed')
    expect(gateway.access.openPairing).not.toHaveBeenCalled()
    await controller.close()
  })

  it('surfaces an unexpected sidecar exit instead of a stale ready state', async () => {
    const gateway = fakeGateway()
    const children: FakeChild[] = []
    const statuses: string[] = []
    const controller = new IrohController({
      store: fakeStore(false), component: fakeComponent('/sidecar/host'), dataDirectory: await fixtureDir(),
      createGateway: async () => gateway as never,
      launchSidecar: ((() => {
        const child = new FakeChild()
        children.push(child)
        queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ version: 1, type: 'ready', endpoint_id: ENDPOINT, direct_addresses: [], local_only: false })}\n`)))
        return child
      }) as never),
      resolveIdentity: async () => ENDPOINT,
      onStatus: status => { statuses.push(status.state) },
      readyTimeoutMs: 5_000,
    })
    await controller.initialize()
    await controller.setEnabled(true)
    expect(controller.status().state).toBe('ready')
    const child = children[0]
    expect(child).toBeDefined()
    child?.emit('close', 1, null)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(controller.status()).toMatchObject({ enabled: true, state: 'error', errorCode: 'iroh_exited' })
    expect(statuses).toContain('error')
    expect(gateway.close).toHaveBeenCalled()
    await controller.close()
  })
})
