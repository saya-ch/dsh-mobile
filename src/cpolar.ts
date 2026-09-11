import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { createServer, type Server } from 'node:net'
import { isAbsolute, resolve } from 'node:path'
import type { MobileAccessControlStore } from './control.js'
import type { MobileAccessGateway } from './gateway.js'
import { settleRemoteResources, terminateRemoteProcess, type RemoteProviderController } from './remote.js'

const MAX_LOG_BUFFER_BYTES = 64 * 1024
const START_TIMEOUT_MS = 45_000
const CPOLAR_HOST_SUFFIXES = Object.freeze(['.cpolar.cn', '.cpolar.io', '.cpolar.top', '.cpolar.com'])

/** Product-facing states for the optional cpolar remote transport. */
export type CpolarState = 'off' | 'unavailable' | 'starting' | 'connecting' | 'ready' | 'error'

/** Safe cpolar state returned only through the loopback DSH control route. */
export interface CpolarStatus {
  readonly enabled: boolean
  readonly state: CpolarState
  readonly origin?: string
  readonly errorCode?: string
}

/** Inputs for one cpolar process and its authenticated DSH gateway. */
export interface CpolarControllerOptions {
  readonly store: MobileAccessControlStore
  readonly executable: string
  readonly configFile: string
  readonly region?: string
  readonly createGateway: (origin: string, listenPort: number) => Promise<MobileAccessGateway>
  readonly onStatus?: (status: CpolarStatus) => void
  readonly spawnProcess?: (
    executable: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams
}

interface PortReservation {
  readonly port: number
  readonly release: () => Promise<void>
}

function publicStatus(status: CpolarStatus): CpolarStatus {
  return Object.freeze({
    enabled: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  })
}

function isCpolarHost(hostname: string): boolean {
  return CPOLAR_HOST_SUFFIXES.some(suffix => hostname.endsWith(suffix))
}

/** Extract a validated public HTTPS origin from one cpolar log line. */
export function parseCpolarOrigin(line: string): string | undefined {
  if (!line.includes('Tunnel established at ')) return undefined
  const match = /Tunnel established at (https:\/\/[^"\s]+)/u.exec(line)
  if (match === null) return undefined
  let url: URL
  try { url = new URL(match[1]!) } catch { throw new Error('invalid_cpolar_origin') }
  if (url.protocol !== 'https:' || url.port !== '' || !isCpolarHost(url.hostname)
    || url.pathname !== '/' || url.search !== '' || url.hash !== ''
    || url.username !== '' || url.password !== '') throw new Error('invalid_cpolar_origin')
  return url.origin
}

async function reserveLoopbackPort(): Promise<PortReservation> {
  const server: Server = createServer(socket => { socket.destroy() })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('cpolar_port_reservation_failed')
  }
  let released = false
  return {
    port: address.port,
    release: async () => {
      if (released) return
      released = true
      await new Promise<void>(resolveClose => { server.close(() => resolveClose()) })
    },
  }
}

function spawnCpolarProcess(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return spawn(executable, [...args], {
    env: environment,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function withoutProxyEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'])
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !blocked.has(name.toUpperCase())))
}

/** Owns an installed cpolar client and a provider-specific DSH remote gateway. */
export class CpolarController implements RemoteProviderController {
  private enabled = false
  private initialized = false
  private disposed = false
  private child: ChildProcessWithoutNullStreams | undefined
  private gatewayValue: MobileAccessGateway | undefined
  private reservation: PortReservation | undefined
  private generation = 0
  private buffer = ''
  private latest: CpolarStatus = publicStatus({ enabled: false, state: 'off' })
  private queue: Promise<void> = Promise.resolve()
  private startupTimer: NodeJS.Timeout | undefined

  constructor(private readonly options: CpolarControllerOptions) {
    if (!isAbsolute(options.executable) || !isAbsolute(options.configFile)) {
      throw new Error('cpolar paths must be absolute')
    }
    if (options.region !== undefined && !/^[a-z][a-z0-9_]{0,31}$/u.test(options.region)) {
      throw new Error('cpolar region is invalid')
    }
  }

  /** Restore the remembered cpolar switch independently from LAN and Funnel state. */
  async initialize(): Promise<void> {
    const state = await this.options.store.load()
    this.enabled = state.enabled
    this.initialized = true
    if (this.enabled) await this.start()
    else this.publish({ enabled: false, state: 'off' })
  }

  /** Return the active cpolar-backed DSH gateway. */
  gateway(): MobileAccessGateway | undefined {
    return this.gatewayValue
  }

  /** Return state safe for the desktop control UI. */
  status(): CpolarStatus {
    return publicStatus(this.latest)
  }

  /** Enable or disable cpolar without changing LAN or Tailscale state. */
  async setEnabled(enabled: boolean): Promise<CpolarStatus> {
    if (!this.initialized || this.disposed) throw new Error('cpolar controller is unavailable')
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

  /** Restart cpolar while retaining its account configuration and DSH device store. */
  async reconnect(): Promise<CpolarStatus> {
    if (!this.initialized || this.disposed) throw new Error('cpolar controller is unavailable')
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

  /** Disable cpolar without modifying the user's cpolar account or global tunnels. */
  async reset(): Promise<CpolarStatus> {
    if (!this.initialized || this.disposed) throw new Error('cpolar controller is unavailable')
    await this.enqueue(async () => {
      await this.stop()
      this.enabled = false
      await this.options.store.save({ version: 1, enabled: false })
      this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** Stop owned resources without changing the remembered switch. */
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

  private publish(status: CpolarStatus): void {
    this.latest = publicStatus(status)
    try { this.options.onStatus?.(this.status()) } catch { /* UI observation cannot own runtime state. */ }
  }

  private async start(): Promise<void> {
    const generation = ++this.generation
    let executableEntry
    try { executableEntry = await lstat(this.options.executable) } catch {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'cpolar_component_missing' })
      return
    }
    if (!executableEntry.isFile() || executableEntry.isSymbolicLink()) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'cpolar_component_invalid' })
      return
    }
    let configEntry
    try { configEntry = await lstat(this.options.configFile) } catch {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'cpolar_config_missing' })
      return
    }
    if (!configEntry.isFile() || configEntry.isSymbolicLink()) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'cpolar_config_invalid' })
      return
    }

    let reservation: PortReservation
    try { reservation = await reserveLoopbackPort() } catch {
      this.publish({ enabled: true, state: 'error', errorCode: 'cpolar_port_unavailable' })
      return
    }
    this.reservation = reservation
    this.buffer = ''
    this.publish({ enabled: true, state: 'starting' })
    const args = [
      'http',
      `-config=${resolve(this.options.configFile)}`,
      `-region=${this.options.region ?? 'cn'}`,
      '-inspect-addr=false',
      '-redirect-https=true',
      '-log=stdout',
      '-log-level=INFO',
      String(reservation.port),
    ]
    const child = (this.options.spawnProcess ?? spawnCpolarProcess)(
      this.options.executable,
      args,
      withoutProxyEnvironment(process.env),
    )
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { this.consume(generation, String(chunk)) })
    child.stderr.on('data', chunk => { this.consume(generation, String(chunk)) })
    child.once('error', () => { void this.enqueue(() => this.failGeneration(generation, 'cpolar_launch_failed')) })
    child.once('close', code => {
      if (generation !== this.generation || this.child !== child) return
      this.child = undefined
      if (this.enabled) void this.enqueue(() => this.failGeneration(generation, code === 0 ? 'cpolar_stopped' : 'cpolar_exited'))
    })
    this.startupTimer = setTimeout(() => {
      void this.enqueue(() => this.failGeneration(generation, 'cpolar_start_timeout'))
    }, START_TIMEOUT_MS)
    this.startupTimer.unref()
  }

  private consume(generation: number, chunk: string): void {
    if (generation !== this.generation) return
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LOG_BUFFER_BYTES && !this.buffer.includes('\n')) {
      void this.enqueue(() => this.failGeneration(generation, 'cpolar_invalid_output'))
      return
    }
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      let origin: string | undefined
      try { origin = parseCpolarOrigin(line) } catch {
        void this.enqueue(() => this.failGeneration(generation, 'cpolar_invalid_origin'))
        return
      }
      if (origin !== undefined) void this.enqueue(() => this.attachGateway(generation, origin))
    }
  }

  private async attachGateway(generation: number, origin: string): Promise<void> {
    if (generation !== this.generation || !this.enabled || this.disposed) return
    const current = this.gatewayValue
    if (current !== undefined) {
      if (current.address().origin === origin) return
      await this.rotateGateway(generation, origin, current)
      return
    }
    const reservation = this.reservation
    if (reservation === undefined) return
    this.publish({ enabled: true, state: 'connecting', origin })
    await reservation.release()
    if (this.reservation === reservation) this.reservation = undefined
    let gateway: MobileAccessGateway
    try { gateway = await this.options.createGateway(origin, reservation.port) } catch {
      await this.failGeneration(generation, 'gateway_start_failed')
      return
    }
    if (generation !== this.generation || !this.enabled || this.disposed || this.child === undefined) {
      await gateway.close()
      return
    }
    this.gatewayValue = gateway
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    this.publish({ enabled: true, state: 'ready', origin })
  }

  /** Replace the gateway authority when cpolar rotates a temporary public origin. */
  private async rotateGateway(
    generation: number,
    origin: string,
    current: MobileAccessGateway,
  ): Promise<void> {
    const listenPort = current.address().port
    // A replacement must bind the same port cpolar already forwards to. Stop
    // exposing the closing instance before releasing that port.
    if (this.gatewayValue === current) this.gatewayValue = undefined
    this.publish({ enabled: true, state: 'connecting', origin })
    try {
      await current.close()
    } catch {
      await this.failGeneration(generation, 'gateway_start_failed')
      return
    }
    if (generation !== this.generation || !this.enabled || this.disposed || this.child === undefined) return

    let replacement: MobileAccessGateway
    try { replacement = await this.options.createGateway(origin, listenPort) } catch {
      await this.failGeneration(generation, 'gateway_start_failed')
      return
    }
    if (generation !== this.generation || !this.enabled || this.disposed || this.child === undefined) {
      await replacement.close()
      return
    }
    this.gatewayValue = replacement
    this.publish({ enabled: true, state: 'ready', origin })
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
    if (this.startupTimer !== undefined) clearTimeout(this.startupTimer)
    this.startupTimer = undefined
    const reservation = this.reservation
    this.reservation = undefined
    const child = this.child
    this.child = undefined
    const gateway = this.gatewayValue
    this.gatewayValue = undefined
    await settleRemoteResources([
      () => reservation?.release(),
      () => child !== undefined && child.exitCode === null ? terminateRemoteProcess(child) : undefined,
      () => gateway?.close(),
    ], 'cpolar resource cleanup failed')
  }
}
