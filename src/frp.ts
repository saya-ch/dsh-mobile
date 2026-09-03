import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { isAbsolute } from 'node:path'
import type { MobileAccessControlStore } from './control.js'
import type { FrpConfigStore } from './frp-config.js'
import { DEFAULT_VHOST_HTTP_PORT } from './frp-config.js'
import type { MobileAccessGateway } from './gateway.js'
import { settleRemoteResources, terminateRemoteProcess, type RemoteProviderController } from './remote.js'

const START_TIMEOUT_MS = 45_000
const DISCOVERY_REQUEST_TIMEOUT_MS = 5_000
const DISCOVERY_RETRY_MS = 1_000
const MAX_DISCOVERY_BYTES = 16 * 1024
const VHOST_PROBE_TIMEOUT_MS = 1_500

/** Product-facing states for the restricted self-hosted FRP transport. */
export type FrpState = 'off' | 'unavailable' | 'starting' | 'connecting' | 'ready' | 'error'

/** Safe FRP state returned only through the loopback DSH control route. */
export interface FrpStatus {
  readonly enabled: boolean
  readonly state: FrpState
  readonly origin?: string
  readonly errorCode?: string
}

/** Inputs for one FRP client process and authenticated DSH gateway. */
export interface FrpControllerOptions {
  readonly store: MobileAccessControlStore
  readonly executable: string
  readonly config: FrpConfigStore
  readonly instanceId: string
  readonly createGateway: (origin: string) => Promise<MobileAccessGateway>
  readonly onStatus?: (status: FrpStatus) => void
  readonly verifyConfig?: (executable: string, configFile: string) => Promise<void>
  readonly launchClient?: (executable: string, configFile: string) => ChildProcessWithoutNullStreams
  readonly probeVhostExposure?: (serverAddress: string, port: number) => Promise<boolean>
  readonly probeDiscovery?: (origin: string, expectedInstanceId: string, signal: AbortSignal) => Promise<boolean>
  readonly startTimeoutMs?: number
  readonly retryIntervalMs?: number
}

function publicStatus(status: FrpStatus): FrpStatus {
  return Object.freeze({
    enabled: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  })
}

async function defaultVerifyConfig(executable: string, configFile: string): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    execFile(executable, ['verify', '-c', configFile], {
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    }, error => {
      if (error === null) resolveRun()
      else reject(error)
    })
  })
}

function defaultLaunchClient(executable: string, configFile: string): ChildProcessWithoutNullStreams {
  return spawn(executable, ['-c', configFile], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

async function defaultProbeVhostExposure(serverAddress: string, port: number): Promise<boolean> {
  return new Promise<boolean>(resolveProbe => {
    const socket = connect({ host: serverAddress, port })
    let finished = false
    let received = ''
    const finish = (exposed: boolean): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      socket.destroy()
      resolveProbe(exposed)
    }
    const timer = setTimeout(() => { finish(false) }, VHOST_PROBE_TIMEOUT_MS)
    timer.unref()
    socket.once('connect', () => {
      // A transparent proxy/TUN can acknowledge every TCP connect even when
      // the remote port is closed. Require an actual HTTP response from the
      // FRP vhost listener before treating the plaintext port as exposed.
      socket.write('GET /dsh-mobile-exposure-probe HTTP/1.1\r\nHost: invalid.example\r\nConnection: close\r\n\r\n')
    })
    socket.on('data', chunk => {
      received = `${received}${chunk.toString('latin1')}`.slice(0, 32)
      if (/^HTTP\/1\.[01] [1-5][0-9]{2}/u.test(received)) finish(true)
    })
    socket.once('close', () => { finish(false) })
    socket.once('error', () => { finish(false) })
  })
}

async function boundedResponseBytes(response: Response): Promise<Uint8Array> {
  if (response.body === null) throw new Error('frp_discovery_invalid')
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DISCOVERY_BYTES) throw new Error('frp_discovery_invalid')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    received += result.value.byteLength
    if (received > MAX_DISCOVERY_BYTES) {
      await reader.cancel()
      throw new Error('frp_discovery_invalid')
    }
    chunks.push(result.value)
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function defaultProbeDiscovery(origin: string, expectedInstanceId: string, signal: AbortSignal): Promise<boolean> {
  const requestController = new AbortController()
  const abort = (): void => { requestController.abort() }
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, DISCOVERY_REQUEST_TIMEOUT_MS)
  timeout.unref()
  try {
    const response = await fetch(`${origin}/mobile-access/discovery`, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      signal: requestController.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return false
    let value: unknown
    try { value = JSON.parse(new TextDecoder().decode(await boundedResponseBytes(response))) as unknown } catch {
      throw new Error('frp_discovery_invalid')
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('frp_discovery_invalid')
    const actual = (value as Record<string, unknown>).instanceId
    if (typeof actual !== 'string') throw new Error('frp_discovery_invalid')
    if (actual !== expectedInstanceId) throw new Error('frp_discovery_mismatch')
    return true
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
  }
}

/** Owns frpc, its generation-specific configuration, and the remote gateway. */
export class FrpController implements RemoteProviderController {
  private enabled = false
  private initialized = false
  private disposed = false
  private child: ChildProcessWithoutNullStreams | undefined
  private gatewayValue: MobileAccessGateway | undefined
  private generation = 0
  private latest: FrpStatus = publicStatus({ enabled: false, state: 'off' })
  private queue: Promise<void> = Promise.resolve()
  private startupAbort: AbortController | undefined

  constructor(private readonly options: FrpControllerOptions) {
    if (!isAbsolute(options.executable)) throw new Error('frpc executable path must be absolute')
    if (!/^[a-f0-9]{64}$/u.test(options.instanceId)) throw new Error('FRP instance ID is invalid')
  }

  /** Restore the remembered FRP switch without changing LAN or other providers. */
  async initialize(): Promise<void> {
    const state = await this.options.store.load()
    this.enabled = state.enabled
    this.initialized = true
    if (this.enabled) await this.start()
    else this.publish({ enabled: false, state: 'off' })
  }

  /** Return the active FRP-backed DSH gateway. */
  gateway(): MobileAccessGateway | undefined {
    return this.gatewayValue
  }

  /** Return state safe for the desktop control UI. */
  status(): FrpStatus {
    return publicStatus(this.latest)
  }

  /** Enable or disable FRP without changing LAN or another provider. */
  async setEnabled(enabled: boolean): Promise<FrpStatus> {
    if (!this.initialized || this.disposed) throw new Error('FRP controller is unavailable')
    await this.enqueue(async () => {
      if (this.enabled === enabled && (enabled === false || this.child !== undefined)) return
      if (!enabled) await this.stop()
      this.enabled = enabled
      await this.options.store.save({ version: 1, enabled })
      if (enabled) await this.start()
      else this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** Restart FRP while retaining its private server settings and devices. */
  async reconnect(): Promise<FrpStatus> {
    if (!this.initialized || this.disposed) throw new Error('FRP controller is unavailable')
    await this.enqueue(async () => {
      if (!this.enabled) {
        this.enabled = true
        await this.options.store.save({ version: 1, enabled: true })
      }
      await this.stop()
      await this.start()
    })
    return this.status()
  }

  /** Disable FRP without deleting its explicitly managed component or settings. */
  async reset(): Promise<FrpStatus> {
    if (!this.initialized || this.disposed) throw new Error('FRP controller is unavailable')
    await this.enqueue(async () => {
      await this.stop()
      this.enabled = false
      await this.options.store.save({ version: 1, enabled: false })
      this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** Stop all FRP resources without changing the remembered switch. */
  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.enqueue(() => this.stop())
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private publish(status: FrpStatus): void {
    this.latest = publicStatus(status)
    try { this.options.onStatus?.(this.status()) } catch { /* UI observation cannot own runtime state. */ }
  }

  private async start(): Promise<void> {
    const generation = ++this.generation
    let executableEntry
    try { executableEntry = await lstat(this.options.executable) } catch {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'frp_component_missing' })
      return
    }
    if (!executableEntry.isFile() || executableEntry.isSymbolicLink()) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'frp_component_invalid' })
      return
    }
    const settings = this.options.config.settings()
    if (settings === undefined) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'frp_config_missing' })
      return
    }
    this.publish({ enabled: true, state: 'starting', origin: settings.publicOrigin })
    let exposed: boolean
    try {
      exposed = await (this.options.probeVhostExposure ?? defaultProbeVhostExposure)(
        settings.serverAddress,
        DEFAULT_VHOST_HTTP_PORT,
      )
    } catch {
      this.publish({ enabled: true, state: 'error', origin: settings.publicOrigin, errorCode: 'frp_vhost_probe_failed' })
      return
    }
    if (exposed) {
      this.publish({ enabled: true, state: 'error', origin: settings.publicOrigin, errorCode: 'frp_vhost_publicly_reachable' })
      return
    }
    let gateway: MobileAccessGateway
    try { gateway = await this.options.createGateway(settings.publicOrigin) } catch {
      this.publish({ enabled: true, state: 'error', origin: settings.publicOrigin, errorCode: 'gateway_start_failed' })
      return
    }
    if (generation !== this.generation || !this.enabled) {
      await gateway.close()
      return
    }
    this.gatewayValue = gateway
    let configFile: string
    try {
      configFile = await this.options.config.writeRuntimeConfig(gateway.address().port)
      await (this.options.verifyConfig ?? defaultVerifyConfig)(this.options.executable, configFile)
    } catch {
      await this.failGeneration(generation, 'frp_config_verify_failed')
      return
    }
    if (generation !== this.generation || !this.enabled) return
    let child: ChildProcessWithoutNullStreams
    try { child = (this.options.launchClient ?? defaultLaunchClient)(this.options.executable, configFile) } catch {
      await this.failGeneration(generation, 'frp_launch_failed')
      return
    }
    this.child = child
    child.stdout.resume()
    child.stderr.resume()
    child.once('error', () => { void this.enqueue(() => this.failGeneration(generation, 'frp_launch_failed')) })
    child.once('close', code => {
      if (generation !== this.generation || this.child !== child) return
      this.child = undefined
      if (this.enabled) void this.enqueue(() => this.failGeneration(generation, code === 0 ? 'frp_stopped' : 'frp_exited'))
    })
    this.publish({ enabled: true, state: 'connecting', origin: settings.publicOrigin })
    const controller = new AbortController()
    this.startupAbort = controller
    void this.waitForDiscovery(generation, settings.publicOrigin, controller.signal)
  }

  private async waitForDiscovery(generation: number, origin: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? START_TIMEOUT_MS)
    const probe = this.options.probeDiscovery ?? defaultProbeDiscovery
    while (!signal.aborted && Date.now() < deadline) {
      try {
        if (await probe(origin, this.options.instanceId, signal)) {
          await this.enqueue(async () => {
            if (generation !== this.generation || signal.aborted || !this.enabled) return
            this.startupAbort = undefined
            this.publish({ enabled: true, state: 'ready', origin })
          })
          return
        }
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof Error && (error.message === 'frp_discovery_mismatch' || error.message === 'frp_discovery_invalid')) {
          await this.enqueue(() => this.failGeneration(generation, error.message))
          return
        }
      }
      await new Promise<void>(resolveWait => {
        let finished = false
        const finish = (): void => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          signal.removeEventListener('abort', finish)
          resolveWait()
        }
        const timer = setTimeout(finish, this.options.retryIntervalMs ?? DISCOVERY_RETRY_MS)
        timer.unref()
        signal.addEventListener('abort', finish, { once: true })
      })
    }
    if (!signal.aborted) await this.enqueue(() => this.failGeneration(generation, 'frp_start_timeout'))
  }

  private async failGeneration(generation: number, code: string): Promise<void> {
    if (generation !== this.generation) return
    await this.stopProcessAndGateway()
    if (this.enabled) this.publish({ enabled: true, state: 'error', errorCode: code })
  }

  private async stop(): Promise<void> {
    ++this.generation
    await this.stopProcessAndGateway()
  }

  private async stopProcessAndGateway(): Promise<void> {
    this.startupAbort?.abort()
    this.startupAbort = undefined
    const child = this.child
    this.child = undefined
    const gateway = this.gatewayValue
    this.gatewayValue = undefined
    await settleRemoteResources([
      () => child !== undefined && child.exitCode === null ? terminateRemoteProcess(child) : undefined,
      () => gateway?.close(),
      () => rm(this.options.config.runtimeConfigFile, { force: true }),
    ], 'FRP resource cleanup failed')
  }
}
