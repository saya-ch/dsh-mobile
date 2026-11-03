import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { restrictPrivateFile } from './private-file.js'

/** Installed client module metadata, without upstream URLs or host paths. */
export interface ClientModuleEntry {
  readonly id: string
  readonly required: boolean
  readonly dependencies: readonly string[]
  /** Source bytes of the upstream bundle, when the Gateway could measure them. */
  readonly bytes?: number
  /** Gzipped bytes the phone would receive, when the Gateway could measure them. */
  readonly gzipBytes?: number
  /** The plugin package's own one-line description, when it could be read. */
  readonly description?: string
}

/** Selection returned to the computer administrator or the authenticated device. */
export interface ClientModulePreferenceView {
  readonly entries: readonly ClientModuleEntry[]
  /** Canonical fingerprint of this catalog. A write that carries a different one is stale. */
  readonly revision: string
  readonly excludedClientModules: readonly string[]
  readonly defaultExcludedClientModules: readonly string[]
  readonly source: 'device' | 'computer' | 'plugin'
  readonly reloadRequired: true
}

/** Effective exclusion selection and the current computer default. */
export interface ClientModulePreferenceSelection {
  readonly excludedClientModules: readonly string[]
  readonly defaultExcludedClientModules: readonly string[]
  readonly source: ClientModulePreferenceView['source']
}

interface PreferenceRecord {
  readonly version: 1
  readonly computer?: readonly string[]
  readonly devices: Readonly<Record<string, readonly string[]>>
}

const MAX_RECORD_BYTES = 1024 * 1024

/** Validate untrusted JSON selections; graph membership is checked by the Gateway. */
export function parseExcludedClientModules(value: unknown): readonly string[] {
  if (!Array.isArray(value)
    || value.some(id => typeof id !== 'string' || id.length === 0
      || id.trim() !== id || /[\u0000-\u001f\u007f]/u.test(id))) {
    throw new Error('excluded_client_modules_invalid')
  }
  const ids = value as string[]
  if (new Set(ids).size !== ids.length) throw new Error('excluded_client_modules_invalid')
  return Object.freeze([...ids])
}

function deviceKey(deviceId: string): void {
  if (!/^[a-f\d]{32}$/u.test(deviceId)) throw new Error('client_module_device_invalid')
}

function parseRecord(value: unknown): PreferenceRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('client_module_preferences_invalid')
  const record = value as Record<string, unknown>
  if (record.version !== 1 || record.devices === null || typeof record.devices !== 'object' || Array.isArray(record.devices)
    || Object.keys(record).some(key => !['version', 'computer', 'devices'].includes(key))) throw new Error('client_module_preferences_invalid')
  const devices: Record<string, readonly string[]> = {}
  for (const [id, excluded] of Object.entries(record.devices)) { deviceKey(id); devices[id] = parseExcludedClientModules(excluded) }
  return Object.freeze({
    version: 1, devices: Object.freeze(devices),
    ...(record.computer === undefined ? {} : { computer: parseExcludedClientModules(record.computer) }),
  })
}

/** Atomic, serialized preferences shared by the LAN and remote Gateway instances. */
export class ClientModulePreferenceStore {
  private readonly defaults: readonly string[]
  private value: PreferenceRecord = Object.freeze({ version: 1, devices: Object.freeze({}) })
  private initialization: Promise<void> | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(readonly file: string, defaults: readonly string[]) {
    if (!isAbsolute(file)) throw new Error('client module preference path must be absolute')
    this.defaults = parseExcludedClientModules(defaults)
  }

  /** Read existing state once. Missing state is not written during initialization. */
  initialize(): Promise<void> {
    this.initialization ??= this.load()
    return this.initialization
  }

  private async load(): Promise<void> {
    let information
    try { information = await lstat(this.file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!information.isFile() || information.isSymbolicLink() || information.size > MAX_RECORD_BYTES) {
      throw new Error('client module preferences must be a regular file no larger than 1 MiB')
    }
    this.value = parseRecord(JSON.parse(await readFile(this.file, 'utf8')))
  }

  private selection(deviceId?: string): ClientModulePreferenceSelection {
    if (deviceId !== undefined) deviceKey(deviceId)
    const computer = this.value.computer ?? this.defaults
    const device = deviceId === undefined ? undefined : this.value.devices[deviceId]
    return Object.freeze({
      excludedClientModules: device ?? computer,
      defaultExcludedClientModules: computer,
      source: device !== undefined ? 'device' : this.value.computer !== undefined ? 'computer' : 'plugin',
    })
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(action)
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  /** Resolve one device override, otherwise the computer or plugin default. */
  async read(deviceId?: string): Promise<ClientModulePreferenceSelection> {
    await this.initialize()
    return this.exclusive(async () => this.selection(deviceId))
  }

  /** Revalidate against the current boot manifest inside the serialized mutation. */
  async configure(
    excluded: unknown,
    deviceId: string | undefined,
    validate: (selection: readonly string[]) => Promise<void>,
  ): Promise<ClientModulePreferenceSelection> {
    const ids = parseExcludedClientModules(excluded)
    if (deviceId !== undefined) deviceKey(deviceId)
    await this.initialize()
    return this.exclusive(async () => {
      await validate(ids)
      const next: PreferenceRecord = deviceId === undefined
        ? { ...this.value, computer: ids }
        : { ...this.value, devices: { ...this.value.devices, [deviceId]: ids } }
      await this.save(next)
      return this.selection(deviceId)
    })
  }

  /** Remove only the selected override; retain all other device selections. */
  async reset(deviceId: string | undefined, validate: (selection: readonly string[]) => Promise<void>): Promise<ClientModulePreferenceSelection> {
    if (deviceId !== undefined) deviceKey(deviceId)
    await this.initialize()
    return this.exclusive(async () => {
      const devices = { ...this.value.devices }
      if (deviceId !== undefined) delete devices[deviceId]
      const next: PreferenceRecord = {
        version: 1, devices,
        ...(deviceId === undefined || this.value.computer === undefined ? {} : { computer: this.value.computer }),
      }
      const effective = deviceId === undefined ? this.defaults : this.value.computer ?? this.defaults
      await validate(effective)
      await this.save(next)
      return this.selection(deviceId)
    })
  }

  /** Remove exactly the revoked device's record without evaluating its obsolete graph. */
  removeDevice(deviceId: string): Promise<void> {
    return this.removeDevices([deviceId])
  }

  /** Remove an explicit set of revoked identities, not every record in the shared store. */
  async removeDevices(deviceIds: readonly string[]): Promise<void> {
    for (const deviceId of deviceIds) deviceKey(deviceId)
    await this.initialize()
    await this.exclusive(async () => {
      if (!deviceIds.some(id => this.value.devices[id] !== undefined)) return
      const devices = { ...this.value.devices }
      for (const deviceId of deviceIds) delete devices[deviceId]
      await this.save({ ...this.value, devices })
    })
  }

  private async save(record: PreferenceRecord): Promise<void> {
    const valid = parseRecord(record)
    const body = `${JSON.stringify(valid)}\n`
    if (Buffer.byteLength(body) > MAX_RECORD_BYTES) throw new Error('client_module_preferences_limit')
    const directory = dirname(this.file)
    const created = await mkdir(directory, { recursive: true, mode: 0o700 })
    if (created !== undefined) await restrictPrivateFile(directory, 0o700)
    try {
      const existing = await lstat(this.file)
      if (!existing.isFile() || existing.isSymbolicLink()) throw new Error('client module preference target must be a regular file')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const temporary = join(directory, `.${basename(this.file)}.${randomBytes(12).toString('hex')}.tmp`)
    try {
      await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await restrictPrivateFile(temporary)
      await rename(temporary, this.file)
      this.value = valid
    } catch (error) {
      try { await rm(temporary, { force: true }) } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'client module preference write and temporary cleanup failed')
      }
      throw error
    }
  }
}
