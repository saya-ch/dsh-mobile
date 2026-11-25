import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MobileAccessControlState, MobileAccessControlStore } from './control.js'
import type { MobileAccessGateway } from './gateway.js'
import { settleRemoteResources, terminateRemoteProcess, type RemoteProviderController } from './remote.js'
import { assertManagedParents, ensureManagedDirectory, removeManagedTree } from './managed-files.js'

const MAX_PROTOCOL_LINE_BYTES = 16 * 1024
const FUNNEL_START_TIMEOUT_MS = 45_000

/** Product-facing states for the independent Tailscale Funnel transport. */
export type FunnelState = 'off' | 'unavailable' | 'starting' | 'needs-login' | 'connecting' | 'ready' | 'error'

/** Safe state returned only through the loopback DSH control route. */
export interface FunnelStatus {
  readonly enabled: boolean
  readonly state: FunnelState
  readonly origin?: string
  readonly loginUrl?: string
  readonly setupUrl?: string
  readonly errorCode?: string
}

interface FunnelEvent {
  readonly version: 1
  readonly type: 'login' | 'ready' | 'serving' | 'error'
  readonly url?: string
  readonly origin?: string
  readonly code?: string
}

/** Construction inputs for one Funnel lifecycle independent from the LAN gateway. */
export interface FunnelControllerOptions {
  readonly store: MobileAccessControlStore
  readonly executable: string
  readonly stateDirectory: string
  /** The plugin's owned Mobile state root; direct callers own the explicit state-directory parent. */
  readonly ownedRoot?: string
  readonly hostname: string
  readonly createGateway: (origin: string) => Promise<MobileAccessGateway>
  readonly onStatus?: (status: FunnelStatus) => void
}

function publicStatus(status: FunnelStatus): FunnelStatus {
  return Object.freeze({
    enabled: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.loginUrl === undefined ? {} : { loginUrl: status.loginUrl }),
    ...(status.setupUrl === undefined ? {} : { setupUrl: status.setupUrl }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  })
}

const FUNNEL_SETUP_URLS = new Set([
  'https://tailscale.com/s/no-funnel',
  'https://tailscale.com/s/https',
])

function parseSetupUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid_sidecar_protocol')
  const url = new URL(value)
  const normalized = url.toString().replace(/\/$/u, '')
  const officialInteractive = url.protocol === 'https:' && url.hostname === 'login.tailscale.com'
    && url.port === '' && url.username === '' && url.password === ''
  if (!FUNNEL_SETUP_URLS.has(normalized) && !officialInteractive) throw new Error('invalid_sidecar_protocol')
  return officialInteractive ? url.toString() : normalized
}

function parseOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) throw new Error('invalid_funnel_origin')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('invalid_funnel_origin') }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.port !== ''
    || url.pathname !== '/' || url.search !== '' || url.hash !== ''
    || url.username !== '' || url.password !== '') throw new Error('invalid_funnel_origin')
  return url.origin
}

/** Parse one sidecar protocol line while restricting every browser-opened URL. */
export function parseFunnelEvent(line: string): FunnelEvent {
  if (Buffer.byteLength(line, 'utf8') === 0 || Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
    throw new Error('invalid_sidecar_protocol')
  }
  let value: unknown
  try { value = JSON.parse(line) as unknown } catch { throw new Error('invalid_sidecar_protocol') }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid_sidecar_protocol')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.type !== 'string') throw new Error('invalid_sidecar_protocol')
  if (record.type === 'login') {
    if (typeof record.url !== 'string' || record.url.length > 2048) throw new Error('invalid_sidecar_protocol')
    const url = new URL(record.url)
    if (url.protocol !== 'https:' || url.hostname !== 'login.tailscale.com') throw new Error('invalid_sidecar_protocol')
    return Object.freeze({ version: 1, type: 'login', url: url.toString() })
  }
  if (record.type === 'ready' || record.type === 'serving') {
    return Object.freeze({ version: 1, type: record.type, origin: parseOrigin(record.origin) })
  }
  if (record.type === 'error') {
    if (typeof record.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(record.code)) {
      throw new Error('invalid_sidecar_protocol')
    }
    const setupUrl = parseSetupUrl(record.url)
    return Object.freeze({ version: 1, type: 'error', code: record.code, ...(setupUrl === undefined ? {} : { url: setupUrl }) })
  }
  throw new Error('invalid_sidecar_protocol')
}

function withoutProvisioningSecrets(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = new Set(['TS_AUTHKEY', 'TAILSCALE_AUTHKEY', 'TS_OAUTH_CLIENT_SECRET'])
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !blocked.has(name.toUpperCase())))
}

/** Owns the source-built tsnet sidecar, remote gateway, and persisted remote switch. */
export class FunnelController implements RemoteProviderController {
  private enabled = false
  private initialized = false
  private disposed = false
  private child: ChildProcessWithoutNullStreams | undefined
  private gatewayValue: MobileAccessGateway | undefined
  private generation = 0
  private buffer = ''
  private latest: FunnelStatus = publicStatus({ enabled: false, state: 'off' })
  private queue: Promise<void> = Promise.resolve()
  private closeTask: Promise<void> | undefined
  private startTimer: NodeJS.Timeout | undefined
  private readonly ownedRoot: string

  constructor(private readonly options: FunnelControllerOptions) {
    if (!isAbsolute(options.executable) || !isAbsolute(options.stateDirectory)) {
      throw new Error('Funnel paths must be absolute')
    }
    this.ownedRoot = options.ownedRoot ?? dirname(resolve(options.stateDirectory))
    if (!isAbsolute(this.ownedRoot) || resolve(this.ownedRoot) === resolve(options.stateDirectory)) throw new Error('Funnel state must be a child of its owned root')
  }

  /** Restore the remote switch without coupling it to LAN availability. */
  async initialize(initialState?: MobileAccessControlState): Promise<void> {
    try { await this.assertStateParents() } catch (_error) {
      this.enabled = false
      this.initialized = true
      this.publish({ enabled: false, state: 'unavailable', errorCode: 'funnel_state_invalid' })
      return
    }
    const state = initialState ?? await this.options.store.load()
    this.enabled = state.enabled
    this.initialized = true
    if (this.enabled) await this.start()
    else this.publish({ enabled: false, state: 'off' })
  }

  /** Return the currently attached authenticated remote gateway. */
  gateway(): MobileAccessGateway | undefined {
    return this.gatewayValue
  }

  /** Return state safe for the local desktop control UI. */
  status(): FunnelStatus {
    return publicStatus(this.latest)
  }

  /** Enable or disable Funnel without changing the LAN listener. */
  async setEnabled(enabled: boolean): Promise<FunnelStatus> {
    if (!this.initialized || this.disposed) throw new Error('Funnel controller is unavailable')
    await this.enqueue(async () => {
      const ownsResources = this.child !== undefined || this.gatewayValue !== undefined
      if (this.enabled === enabled && (enabled ? this.child !== undefined : !ownsResources && this.latest.state === 'off')) return
      if (!enabled) {
        // A damaged state directory must never prevent an already-owned process
        // or gateway from being stopped. Keep the durable switch untouched when
        // validation fails, so a repaired directory can be retried safely.
        try { await this.assertStateParents() } catch (error) {
          try { await this.stop() } catch (cleanupError) {
            this.publish({ enabled: this.enabled, state: 'error', errorCode: 'funnel_cleanup_failed' })
            throw new AggregateError([error, cleanupError], 'Funnel state validation and cleanup failed')
          }
          this.publish({ enabled: this.enabled, state: 'unavailable', errorCode: 'funnel_state_invalid' })
          throw error
        }
        // Persist before changing in-memory ownership. A failed write leaves the
        // working tunnel intact and the same operation remains retryable.
        await this.options.store.save({ version: 1, enabled: false })
        this.enabled = false
        try { await this.stop() } catch (error) {
          this.publish({ enabled: false, state: 'error', errorCode: 'funnel_cleanup_failed' })
          throw error
        }
        this.publish({ enabled: false, state: 'off' })
        return
      }
      try { await this.assertStateParents() } catch (error) {
        this.publish({ enabled: this.enabled, state: 'unavailable', errorCode: 'funnel_state_invalid' })
        throw error
      }
      await this.options.store.save({ version: 1, enabled: true })
      this.enabled = true
      // A previous failed disable may have stopped publishing state while still
      // retaining a resource whose cleanup failed. Reconcile it before restart.
      if (ownsResources) await this.stop()
      await this.start()
    })
    return this.status()
  }

  /** Restart a failed or interrupted Funnel session while retaining sign-in state. */
  async reconnect(): Promise<FunnelStatus> {
    if (!this.initialized || this.disposed) throw new Error('Funnel controller is unavailable')
    await this.enqueue(async () => {
      try { await this.assertStateParents() } catch (error) {
        this.publish({ enabled: this.enabled, state: 'unavailable', errorCode: 'funnel_state_invalid' })
        throw error
      }
      if (!this.enabled) {
        await this.options.store.save({ version: 1, enabled: true })
        this.enabled = true
      }
      await this.stop()
      await this.start()
    })
    return this.status()
  }

  /** Disable Funnel and remove only its private Tailscale node state. */
  async reset(): Promise<FunnelStatus> {
    if (!this.initialized || this.disposed) throw new Error('Funnel controller is unavailable')
    await this.enqueue(async () => {
      try {
        await assertManagedParents(this.ownedRoot, this.options.stateDirectory, 'funnel')
        const selected = await lstat(this.options.stateDirectory).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          return undefined
        })
        if (selected !== undefined && (selected.isSymbolicLink() || !selected.isDirectory())) {
          await removeManagedTree(this.ownedRoot, this.options.stateDirectory, 'funnel')
        }
      } catch (error) {
        this.publish({ enabled: this.enabled, state: 'off', errorCode: 'funnel_state_invalid' })
        throw error
      }
      await this.options.store.save({ version: 1, enabled: false })
      this.enabled = false
      await this.stop()
      try {
        await removeManagedTree(this.ownedRoot, this.options.stateDirectory, 'funnel')
        await this.assertStateParents()
        // A configured control file can belong to the node directory just removed.
        await this.options.store.save({ version: 1, enabled: false })
      } catch (error) {
        this.publish({ enabled: false, state: 'off', errorCode: 'funnel_state_invalid' })
        throw error
      }
      this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** Stop all remote resources without modifying the remembered switch. */
  close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.disposed = true
    const task = this.enqueue(() => this.stop())
    this.closeTask = task.catch((error: unknown) => {
      this.closeTask = undefined
      throw error
    })
    return this.closeTask
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private publish(status: FunnelStatus): void {
    this.latest = publicStatus(status)
    try { this.options.onStatus?.(this.status()) } catch { /* UI observation cannot own runtime state. */ }
  }

  private async assertStateParents(): Promise<void> {
    await assertManagedParents(this.ownedRoot, this.options.stateDirectory, 'funnel')
    try {
      const entry = await lstat(this.options.stateDirectory)
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('funnel_path_invalid')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  private async start(): Promise<void> {
    const generation = ++this.generation
    let entry
    try { entry = await lstat(this.options.executable) } catch {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'component_missing' })
      return
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'component_invalid' })
      return
    }
    try {
      await this.assertStateParents()
      await ensureManagedDirectory(this.ownedRoot, this.options.stateDirectory, 'funnel')
    } catch (_error) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'funnel_state_invalid' })
      return
    }
    this.buffer = ''
    this.publish({ enabled: true, state: 'starting' })
    await ensureExecutable(this.options.executable)
    const child = spawn(this.options.executable, [
      '--state-dir', resolve(this.options.stateDirectory),
      '--hostname', this.options.hostname,
    ], {
      env: withoutProvisioningSecrets(process.env),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.clearStartTimer()
    this.startTimer = setTimeout(() => {
      void this.enqueue(() => this.failGeneration(generation, 'funnel_start_timeout'))
    }, FUNNEL_START_TIMEOUT_MS)
    this.startTimer.unref()
    child.stderr.resume()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { this.consume(generation, String(chunk)) })
    child.once('error', () => {
      void this.enqueue(() => this.failGeneration(generation, 'sidecar_launch_failed'))
    })
    child.once('close', code => {
      if (generation !== this.generation || this.child !== child) return
      this.child = undefined
      if (this.enabled) {
        void this.enqueue(() => this.failGeneration(generation, code === 0 ? 'sidecar_stopped' : 'sidecar_exited'))
      }
    })
  }

  private consume(generation: number, chunk: string): void {
    if (generation !== this.generation) return
    this.buffer += chunk
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_PROTOCOL_LINE_BYTES && !this.buffer.includes('\n')) {
      void this.enqueue(() => this.failGeneration(generation, 'invalid_sidecar_protocol'))
      return
    }
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).replace(/\r$/u, '')
      this.buffer = this.buffer.slice(newline + 1)
      let event: FunnelEvent
      try { event = parseFunnelEvent(line) } catch {
        void this.enqueue(() => this.failGeneration(generation, 'invalid_sidecar_protocol'))
        return
      }
      void this.enqueue(() => this.handleEvent(generation, event))
    }
  }

  private async handleEvent(generation: number, event: FunnelEvent): Promise<void> {
    if (generation !== this.generation || !this.enabled) return
    this.clearStartTimer()
    if (event.type === 'login') {
      this.publish({ enabled: true, state: 'needs-login', loginUrl: event.url! })
      return
    }
    if (event.type === 'error') {
      await this.failGeneration(generation, event.code ?? 'funnel_failed', event.url)
      return
    }
    const origin = parseOrigin(event.origin)
    if (event.type === 'ready') {
      let gateway: MobileAccessGateway
      try {
        await this.gatewayValue?.close()
        this.gatewayValue = undefined
        gateway = await this.options.createGateway(origin)
      } catch {
        await this.failGeneration(generation, 'gateway_start_failed')
        return
      }
      if (generation !== this.generation || !this.enabled) {
        await gateway.close()
        return
      }
      this.gatewayValue = gateway
      const address = gateway.address()
      const child = this.child
      if (child === undefined) {
        await this.failGeneration(generation, 'sidecar_stopped')
        return
      }
      child.stdin.write(
        `${JSON.stringify({ version: 1, type: 'serve', target: `http://${address.host}:${String(address.port)}` })}\n`,
        error => {
          if (error !== null && error !== undefined) {
            void this.enqueue(() => this.failGeneration(generation, 'control_channel_failed'))
          }
        },
      )
      this.publish({ enabled: true, state: 'connecting', origin })
      return
    }
    this.publish({ enabled: true, state: 'ready', origin })
  }

  private async failGeneration(generation: number, code: string, setupUrl?: string): Promise<void> {
    if (generation !== this.generation) return
    // Failure ends the generation before cleanup can enqueue a process-close event.
    ++this.generation
    try { await this.stopProcessAndGateway() } catch (_error) {
      // Background protocol callbacks cannot reject into the process event loop.
      // Failed resources remain owned so reconnect or close can retry their cleanup.
      this.publish({ enabled: this.enabled, state: 'error', errorCode: 'funnel_cleanup_failed' })
      return
    }
    if (this.enabled) this.publish({ enabled: true, state: 'error', errorCode: code, ...(setupUrl === undefined ? {} : { setupUrl }) })
  }

  private async stop(): Promise<void> {
    ++this.generation
    await this.stopProcessAndGateway()
  }

  private async stopProcessAndGateway(): Promise<void> {
    this.clearStartTimer()
    const child = this.child
    const gateway = this.gatewayValue
    await settleRemoteResources([
      async () => {
        child?.stdin.end()
        if (child !== undefined && child.exitCode === null) await terminateRemoteProcess(child)
        if (this.child === child) this.child = undefined
      },
      async () => {
        if (gateway !== undefined) {
          await gateway.close()
          if (this.gatewayValue === gateway) this.gatewayValue = undefined
        }
      },
    ], 'Funnel resource cleanup failed')
  }

  private clearStartTimer(): void {
    if (this.startTimer === undefined) return
    clearTimeout(this.startTimer)
    this.startTimer = undefined
  }
}

/**
 * Locate this machine's Funnel executable, with one local development override.
 *
 * The sidecar ships as an optional per-platform npm package
 * (`dsh-mobile-funnel-<platform>-<arch>`): npm reads its `os`/`cpu` fields and
 * installs only the one this machine can run, so an install no longer carries three
 * ~20 MB binaries it will never spawn. Resolve through the module loader rather than
 * assuming a directory layout, because the package manager decides where the package
 * lands and a workspace may link it instead of copying it.
 */
export function funnelExecutable(importMetaUrl: string, environment: NodeJS.ProcessEnv = process.env): string {
  const override = environment.DSH_MOBILE_FUNNEL_SIDECAR
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error('DSH_MOBILE_FUNNEL_SIDECAR must be an absolute path')
    return resolve(override)
  }
  const target = `${process.platform}-${process.arch}`
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const file = `dsh-mobile-funnel-${target}${suffix}`
  const installed = installedFunnelExecutable(importMetaUrl, target, file)
  if (installed !== undefined) return installed
  // A checkout that built straight into `bin/` keeps working.
  return resolve(fileURLToPath(new URL(`../bin/${file}`, importMetaUrl)))
}

/** The binary inside this platform's optional package, when that package is installed. */
function installedFunnelExecutable(importMetaUrl: string, target: string, file: string): string | undefined {
  try {
    const require = createRequire(importMetaUrl)
    const manifest = require.resolve(`dsh-mobile-funnel-${target}/package.json`)
    const candidate = resolve(dirname(manifest), file)
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

/**
 * A package unpacked from a Windows working tree keeps the archive's mode, which is
 * not executable on Linux or macOS, and the sidecar is spawned directly. Restoring the
 * bit here covers every install path; a read-only tree keeps whatever the caller can
 * report from the spawn itself.
 */
async function ensureExecutable(path: string): Promise<void> {
  if (process.platform === 'win32') return
  await chmod(path, 0o755).catch(() => undefined)
}
