import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { assertCaddyParents, ensureCaddyDirectory, removeCaddyTree, renameCaddyPath } from './caddy-files.js'
import { downloadPinnedArtifact } from './component-download.js'
import { execFileText } from './exec-file.js'

export const CADDY_VERSION = '2.11.6'
export const CADDY_DNS_PLUGIN_VERSION = 'v0.4.3'
export const CADDY_DOWNLOAD_PAGE = 'https://caddyserver.com/download'

/** An immutable release asset with independent wire and installed-byte checks. */
export interface CaddyArtifact {
  readonly version: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly downloadUrl: string
  readonly downloadBytes: number
  readonly downloadSha256: string
  readonly executableName: string
  readonly executableBytes: number
  readonly executableSha256: string
  readonly dnsPluginVersion: string
}

// The custom-download service returned v2.11.7 when v2.11.6 was requested.
// Production installation stays disabled until immutable assets have been published and verified.
export const CADDY_COMPONENT_RELEASES: Readonly<Record<string, CaddyArtifact>> = Object.freeze({})
export const CADDY_COMPONENT_RELEASE = Object.freeze({ version: CADDY_VERSION, dnsPluginVersion: CADDY_DNS_PLUGIN_VERSION })
export type CaddyDnsProvider = 'tencentcloud'

export function isCaddyDnsProvider(value: unknown): value is CaddyDnsProvider { return value === 'tencentcloud' }

export interface CaddyComponentStatus {
  readonly supported: boolean
  readonly installed: boolean
  readonly version: string
  readonly downloadBytes: number
  readonly installedBytes: number
  readonly sourceUrl: string
  readonly downloadPage: string
  readonly storagePath: string
  readonly errorCode?: string
}

interface CaddyComponentManagerOptions {
  readonly stateDirectory: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  /** Instance-local artifact metadata for tests or a verified immutable release. */
  readonly artifact?: CaddyArtifact
  readonly fetchArtifact?: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  readonly inspectExecutable?: (executable: string) => Promise<{ version: string; modules: string }>
  readonly promoteDirectory?: (source: string, destination: string) => Promise<void>
}

async function digest(file: string): Promise<string> { return createHash('sha256').update(await readFile(file)).digest('hex') }

/** Minimal process environment for version/module checks, without ambient API credentials or proxy overrides. */
export function caddyInspectionEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    if (environment[name] !== undefined) result[name] = environment[name]
  }
  return result
}

async function inspect(executable: string): Promise<{ version: string; modules: string }> {
  const options = { env: caddyInspectionEnvironment(), timeout: 15_000, maxBuffer: 256 * 1024 }
  const version = (await execFileText(executable, ['version'], options)).stdout.trim()
  const modules = (await execFileText(executable, ['list-modules', '--versions'], options)).stdout
  return { version, modules }
}

/** Owns only the optional pinned executable; runtime configuration belongs to CaddyConfigStore. */
export class CaddyComponentManager {
  readonly executable: string
  readonly componentRoot: string
  readonly componentStorage: string
  readonly logRoot: string
  private readonly stateDirectory: string
  private readonly stagingRoot: string
  private readonly artifact: CaddyArtifact | undefined
  private readonly fetchArtifact: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  private readonly inspectExecutable: (executable: string) => Promise<{ version: string; modules: string }>
  private readonly promote: (source: string, destination: string) => Promise<void>
  private installed = false
  private errorCode: string | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(options: CaddyComponentManagerOptions) {
    if (!isAbsolute(options.stateDirectory)) throw new Error('caddy state directory must be absolute')
    this.stateDirectory = resolve(options.stateDirectory)
    const platform = options.platform ?? process.platform
    const arch = options.arch ?? process.arch
    const artifact = options.artifact ?? CADDY_COMPONENT_RELEASES[`${platform}-${arch}`]
    if (artifact !== undefined && (artifact.platform !== platform || artifact.arch !== arch
      || !/^https:\/\//u.test(artifact.downloadUrl) || !/^[a-f0-9]{64}$/u.test(artifact.downloadSha256)
      || !/^[a-f0-9]{64}$/u.test(artifact.executableSha256) || artifact.downloadBytes < 1 || artifact.executableBytes < 1
      || !/^[a-z0-9.-]+$/u.test(artifact.executableName))) throw new Error('caddy_artifact_invalid')
    this.artifact = artifact
    this.componentRoot = join(this.stateDirectory, 'components', 'caddy')
    this.componentStorage = join(this.componentRoot, artifact?.version ?? CADDY_VERSION)
    this.executable = join(this.componentStorage, artifact?.executableName ?? (platform === 'win32' ? 'caddy.exe' : 'caddy'))
    this.logRoot = join(this.stateDirectory, 'caddy', 'logs')
    this.stagingRoot = join(this.stateDirectory, 'staging', 'caddy')
    this.fetchArtifact = options.fetchArtifact ?? ((url, signal) => downloadPinnedArtifact({ url, signal, expectedBytes: artifact?.downloadBytes ?? 0, errorPrefix: 'caddy' }))
    this.inspectExecutable = options.inspectExecutable ?? inspect
    this.promote = options.promoteDirectory ?? ((source, destination) => renameCaddyPath(this.stateDirectory, source, destination))
  }

  /** Recheck a pinned executable before launching; no unverified local binary can run. */
  async ensureExecutable(): Promise<void> {
    const artifact = this.artifact
    if (artifact === undefined) throw new Error('caddy_component_unavailable')
    await assertCaddyParents(this.stateDirectory, this.executable)
    const entry = await lstat(this.executable)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== artifact.executableBytes
      || await digest(this.executable) !== artifact.executableSha256) throw new Error('caddy_component_invalid')
    await this.verifyMetadata(this.executable, artifact)
  }

  async initialize(): Promise<void> {
    this.installed = false; this.errorCode = undefined
    if (this.artifact === undefined) { this.errorCode = 'caddy_component_unavailable'; return }
    try { await this.ensureExecutable(); this.installed = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.errorCode = 'caddy_component_invalid'
    }
  }

  status(): CaddyComponentStatus {
    const artifact = this.artifact
    return Object.freeze({ supported: artifact !== undefined, installed: this.installed,
      version: artifact?.version ?? CADDY_VERSION, downloadBytes: artifact?.downloadBytes ?? 0,
      installedBytes: this.installed ? artifact?.executableBytes ?? 0 : 0,
      sourceUrl: artifact?.downloadUrl ?? CADDY_DOWNLOAD_PAGE, downloadPage: CADDY_DOWNLOAD_PAGE, storagePath: this.componentRoot,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    })
  }

  /** Explicit installation verifies bytes and reported modules before preserving-old promotion. */
  install(): Promise<CaddyComponentStatus> {
    return this.enqueue(async () => {
      const artifact = this.artifact
      if (artifact === undefined) throw new Error('caddy_component_unavailable')
      await ensureCaddyDirectory(this.stateDirectory, this.stagingRoot)
      await ensureCaddyDirectory(this.stateDirectory, this.componentRoot)
      const staging = await mkdtemp(join(this.stagingRoot, 'install-'))
      const candidate = join(this.componentRoot, '.install-' + randomBytes(12).toString('hex'))
      const backup = join(this.componentRoot, '.previous-' + randomBytes(12).toString('hex'))
      let previous = false
      let promoted = false
      let failed = false
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => { controller.abort() }, 600_000)
        timeout.unref()
        let bytes: Uint8Array
        try { bytes = await this.fetchArtifact(artifact.downloadUrl, controller.signal) } finally { clearTimeout(timeout) }
        if (bytes.byteLength !== artifact.downloadBytes) throw new Error('caddy_download_size_mismatch')
        if (createHash('sha256').update(bytes).digest('hex') !== artifact.downloadSha256) throw new Error('caddy_download_hash_mismatch')
        await ensureCaddyDirectory(this.stateDirectory, candidate)
        const executable = join(candidate, artifact.executableName)
        await writeFile(executable, bytes, { flag: 'wx', mode: 0o700 })
        await chmod(executable, 0o700)
        if (bytes.byteLength !== artifact.executableBytes || await digest(executable) !== artifact.executableSha256) throw new Error('caddy_executable_hash_mismatch')
        await this.verifyMetadata(executable, artifact)
        try {
          const entry = await lstat(this.componentStorage)
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('caddy_path_invalid')
          await renameCaddyPath(this.stateDirectory, this.componentStorage, backup); previous = true
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        try { await this.promote(candidate, this.componentStorage); promoted = true } catch (error) {
          if (previous) {
            try { await renameCaddyPath(this.stateDirectory, backup, this.componentStorage); previous = false } catch (rollbackError) {
              this.installed = false; this.errorCode = 'caddy_component_invalid'
              // Keep the only old bytes in backup and expose both failures without claiming a usable installation.
              throw new AggregateError([error, rollbackError], 'caddy_component_rollback_failed', { cause: error })
            }
          }
          throw error
        }
        this.installed = true; this.errorCode = undefined
      } catch (error) { failed = true; throw error } finally {
        // A busy cleanup must not replace the original verification/promotion error.
        let cleanupError: unknown
        for (const path of [staging, candidate, ...(previous && promoted ? [backup] : [])]) {
          try { await removeCaddyTree(this.stateDirectory, path) } catch (error) { cleanupError ??= error }
        }
        if (!failed && cleanupError !== undefined) throw cleanupError
      }
    })
  }

  /** Remove optional component files; callers stop the controller and purge runtime configuration separately. */
  purge(): Promise<CaddyComponentStatus> {
    return this.enqueue(async () => {
      await removeCaddyTree(this.stateDirectory, this.componentRoot)
      await removeCaddyTree(this.stateDirectory, this.stagingRoot)
      this.installed = false; this.errorCode = this.artifact === undefined ? 'caddy_component_unavailable' : undefined
    })
  }

  private async verifyMetadata(executable: string, artifact: CaddyArtifact): Promise<void> {
    const info = await this.inspectExecutable(executable)
    if (!info.version.startsWith('v' + artifact.version + ' ')) throw new Error('caddy_executable_version_mismatch')
    const nonstandard = info.modules.split(/\r?\n/u).filter(line => line.startsWith('dns.providers.'))
    if (nonstandard.length !== 1 || nonstandard[0] !== 'dns.providers.tencentcloud ' + artifact.dnsPluginVersion
      || !info.modules.includes('Non-standard modules: 1')) throw new Error('caddy_executable_modules_mismatch')
  }

  private enqueue(operation: () => Promise<void>): Promise<CaddyComponentStatus> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task.then(() => this.status())
  }
}
