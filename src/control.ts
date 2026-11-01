import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { restrictPrivateFile } from './private-file.js'

/** Versioned durable preference for the resident mobile-access runtime. */
export interface MobileAccessControlState {
  readonly version: 1
  readonly enabled: boolean
}

/** Persistence seam for the runtime preference. */
export interface MobileAccessControlStore {
  load(): Promise<MobileAccessControlState>
  save(state: MobileAccessControlState): Promise<void>
}

/** One started gateway runtime owned by the controller. */
export interface MobileAccessRuntime {
  close(): Promise<void>
}

/** One address-specific runtime selected from the current LAN state. */
export interface MobileAccessRuntimeSelection {
  readonly key: string
  start(): Promise<MobileAccessRuntime>
}

/** A configuration change failed; recovered distinguishes a restored runtime from an unknown configuration. */
export class MobileAccessReconfigurationError extends Error {
  constructor(readonly recovered: boolean, cause: unknown) {
    super(recovered ? 'mobile access configuration restored' : 'mobile access configuration requires recovery', { cause })
    this.name = 'MobileAccessReconfigurationError'
  }
}

/** Keeps one runtime aligned with a changing network selection. */
export class FollowingMobileAccessRuntime implements MobileAccessRuntime {
  private runtime: MobileAccessRuntime | undefined
  private key: string | undefined
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly select: () => Promise<MobileAccessRuntimeSelection>,
    private readonly onRefreshError: (error: unknown) => void,
  ) {}

  /** Start the current selection and optionally poll for later changes. */
  async initialize(refreshIntervalMs?: number): Promise<void> {
    await this.refresh()
    if (refreshIntervalMs === undefined) return
    this.beginPolling(refreshIntervalMs)
  }

  /**
   * Arm the refresh poller without requiring an initial selection.
   * Boot-degraded path: the first selection already failed (e.g. the saved
   * LAN is down), but later refreshes must still get their chance so a
   * returning network recovers without a restart. Failures keep flowing to
   * onRefreshError; close() stays the single teardown.
   */
  beginPolling(refreshIntervalMs: number): void {
    if (this.timer !== undefined) return
    this.timer = setInterval(() => {
      void this.refresh().catch(this.onRefreshError)
    }, refreshIntervalMs)
    this.timer.unref()
  }

  /** Reconcile the active runtime with the latest selection. */
  refresh(): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return
      const selection = await this.select()
      if (this.closed || (this.runtime !== undefined && this.key === selection.key)) return
      const previous = this.runtime
      this.runtime = undefined
      this.key = undefined
      if (previous !== undefined) await previous.close()
      this.runtime = await selection.start()
      this.key = selection.key
    })
  }

  /** Stop polling and close the most recently selected runtime. */
  close(): Promise<void> {
    if (this.closed) return this.queue
    this.closed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    return this.enqueue(async () => {
      const runtime = this.runtime
      this.runtime = undefined
      this.key = undefined
      if (runtime !== undefined) await runtime.close()
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(() => {}, () => {})
    return run
  }
}

/** Validate control state loaded across the filesystem boundary. */
export function parseMobileAccessControlState(value: unknown): MobileAccessControlState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('mobile-access control state must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 1 || typeof record.enabled !== 'boolean'
    || Reflect.ownKeys(record).some(key => key !== 'version' && key !== 'enabled')) {
    throw new Error('mobile-access control state has an unsupported format')
  }
  return Object.freeze({ version: 1, enabled: record.enabled })
}

/** Atomic JSON store whose absent-file state comes from the installation-time default. */
export class JsonMobileAccessControlStore implements MobileAccessControlStore {
  constructor(private readonly file: string, private readonly initiallyEnabled: boolean) {}

  /** Disable an existing preference, returning the state only after private-file preparation completes. */
  async disableIfPresent(): Promise<MobileAccessControlState> {
    const disabled: MobileAccessControlState = Object.freeze({ version: 1, enabled: false })
    try {
      await lstat(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (this.initiallyEnabled) await this.save(disabled)
        return disabled
      }
      throw error
    }
    await this.save(disabled)
    return disabled
  }

  async load(): Promise<MobileAccessControlState> {
    let stat
    try {
      stat = await lstat(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return Object.freeze({ version: 1, enabled: this.initiallyEnabled })
      }
      throw error
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
      throw new Error('mobile-access control state must be a regular file no larger than 4 KiB')
    }
    await restrictPrivateFile(this.file)
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown
    } catch (error) {
      throw new Error('mobile-access control state is not valid JSON', { cause: error })
    }
    return parseMobileAccessControlState(parsed)
  }

  async save(state: MobileAccessControlState): Promise<void> {
    const validated = parseMobileAccessControlState(state)
    const directory = dirname(this.file)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      const current = await lstat(this.file)
      if (!current.isFile() || current.isSymbolicLink()) {
        throw new Error('mobile-access control state target must remain a regular file')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = join(directory, `.${basename(this.file)}.${randomBytes(12).toString('hex')}.tmp`)
    try {
      await writeFile(temporary, `${JSON.stringify(validated)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      await restrictPrivateFile(temporary)
      await rename(temporary, this.file)
    } catch (error) {
      try {
        await rm(temporary, { force: true })
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'control state write and temporary cleanup both failed')
      }
      throw error
    }
  }
}

/** Serialized persistent lifecycle for the gateway behind the always-loaded Cordis entry. */
export class MobileAccessGatewayController {
  private runtime: MobileAccessRuntime | undefined
  private initialized = false
  private closing = false
  private queue: Promise<void> = Promise.resolve()
  private closeTask: Promise<void> | undefined

  constructor(
    private readonly store: MobileAccessControlStore,
    private readonly startRuntime: () => Promise<MobileAccessRuntime>,
  ) {}

  /** Load the durable preference and start the first runtime when enabled. */
  initialize(): Promise<void> {
    return this.enqueue(async () => {
      if (this.initialized) throw new Error('mobile-access control is already initialized')
      if (this.closing) throw new Error('mobile-access control is closing')
      const state = await this.store.load()
      if (state.enabled) this.runtime = await this.startRuntime()
      this.initialized = true
    })
  }

  /** Return the committed in-process runtime state. */
  isRunning(): boolean {
    return this.runtime !== undefined
  }

  /** Start or stop the runtime and persist only a successfully committed transition. */
  setRunning(running: boolean): Promise<void> {
    if (this.closing) return Promise.reject(new Error('mobile-access control is closing'))
    return this.enqueue(async () => {
      if (!this.initialized) throw new Error('mobile-access control is not initialized')
      if (this.isRunning() === running) return
      if (running) {
        await this.enable()
      } else {
        await this.disable()
      }
    })
  }

  /** Change configuration with the runtime stopped, without changing its durable enabled preference. */
  reconfigure<T>(change: () => Promise<T>, restore: () => Promise<void>): Promise<{ value: T; running: boolean }> {
    if (this.closing) return Promise.reject(new Error('mobile-access control is closing'))
    return this.enqueue(async () => {
      if (!this.initialized) throw new Error('mobile-access control is not initialized')
      const previous = this.runtime
      if (previous !== undefined) {
        try { await previous.close() }
        catch (error) { throw new MobileAccessReconfigurationError(false, error) }
      }
      this.runtime = undefined
      try {
        const value = await change()
        if (previous !== undefined) this.runtime = await this.startRuntime()
        return { value, running: previous !== undefined }
      } catch (error) {
        try {
          await restore()
          if (previous !== undefined) this.runtime = await this.startRuntime()
        } catch (restoreError) {
          throw new MobileAccessReconfigurationError(false, new AggregateError([error, restoreError]))
        }
        throw new MobileAccessReconfigurationError(true, error)
      }
    })
  }

  /** Stop the runtime after earlier transitions without changing the restart preference. */
  close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.closing = true
    this.closeTask = this.enqueue(async () => {
      const runtime = this.runtime
      if (runtime === undefined) return
      await runtime.close()
      this.runtime = undefined
    })
    return this.closeTask
  }

  private async enable(): Promise<void> {
    const candidate = await this.startRuntime()
    try {
      await this.store.save({ version: 1, enabled: true })
    } catch (error) {
      try {
        await candidate.close()
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'enabling mobile access failed and runtime rollback also failed')
      }
      throw error
    }
    this.runtime = candidate
  }

  private async disable(): Promise<void> {
    const previous = this.runtime
    if (previous === undefined) return
    await previous.close()
    try {
      await this.store.save({ version: 1, enabled: false })
    } catch (error) {
      try {
        this.runtime = await this.startRuntime()
      } catch (rollbackError) {
        this.runtime = undefined
        throw new AggregateError([error, rollbackError], 'disabling mobile access failed and runtime rollback also failed')
      }
      throw error
    }
    this.runtime = undefined
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation)
    this.queue = run.then(() => {}, () => {})
    return run
  }
}
