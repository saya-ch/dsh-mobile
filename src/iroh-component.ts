/** Managed view of the iroh transport host sidecar.
 *
 * Explicit installation verifies and promotes a pinned sidecar release into
 * private storage. A verified independent companion copy can be reused without
 * downloading. Enabling the channel alone never downloads a component.
 */
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { downloadPinnedArtifact } from './component-download.js'
import { ensureIrohDirectory, removeIrohTree, renameIrohPath } from './iroh-files.js'
import { resolveIrohSidecarAt } from './iroh-manifest.js'

export const IROH_VERSION = '0.1.0-alpha.2'
export const IROH_DOWNLOAD_PAGE = 'https://www.npmjs.com/package/dsh-mobile-iroh'
export const IROH_RELEASE_PAGE = 'https://github.com/saya-ch/dsh-mobile-iroh/releases'

/** A size- and content-pinned sidecar release asset with independent wire and installed-byte checks. */
export interface IrohArtifact {
  readonly version: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly downloadUrl: string
  readonly downloadBytes: number
  readonly downloadSha256: string
  readonly executableName: string
  readonly executableBytes: number
  readonly executableSha256: string
}

// Only independently verified official assets enter this source-owned catalog.
// The bytes are the companion 0.1.0-alpha.2 release payloads, served verbatim
// by the npm CDN; the SHA-256 pins make the mirror irrelevant to trust.
export const IROH_COMPONENT_RELEASES: Readonly<Record<string, IrohArtifact>> = Object.freeze({
  'linux-x64': Object.freeze({
    version: IROH_VERSION, platform: 'linux', arch: 'x64', executableName: 'dsh-mobile-iroh-host-linux-x64',
    downloadUrl: 'https://unpkg.com/dsh-mobile-iroh@0.1.0-alpha.2/native/dsh-mobile-iroh-host-linux-x64',
    downloadBytes: 24451352, executableBytes: 24451352,
    downloadSha256: 'be391dfba3f0f1323d4fe9989e56a0554ceaf74e00a44acdf4a3bfd163bdcab5',
    executableSha256: 'be391dfba3f0f1323d4fe9989e56a0554ceaf74e00a44acdf4a3bfd163bdcab5',
  }),
  'win32-x64': Object.freeze({
    version: IROH_VERSION, platform: 'win32', arch: 'x64', executableName: 'dsh-mobile-iroh-host-win32-x64.exe',
    downloadUrl: 'https://unpkg.com/dsh-mobile-iroh@0.1.0-alpha.2/native/dsh-mobile-iroh-host-win32-x64.exe',
    downloadBytes: 14861312, executableBytes: 14861312,
    downloadSha256: '38d32e37e535ae5c7174008057326fe1afdb1859650871043f02622099fc6cfa',
    executableSha256: '38d32e37e535ae5c7174008057326fe1afdb1859650871043f02622099fc6cfa',
  }),
  'darwin-x64': Object.freeze({
    version: IROH_VERSION, platform: 'darwin', arch: 'x64', executableName: 'dsh-mobile-iroh-host-darwin-x64',
    downloadUrl: 'https://unpkg.com/dsh-mobile-iroh@0.1.0-alpha.2/native/dsh-mobile-iroh-host-darwin-x64',
    downloadBytes: 18084584, executableBytes: 18084584,
    downloadSha256: '2420851d31239e8a4f875370debc774ac82a89567445d96a64e6725ee15bd596',
    executableSha256: '2420851d31239e8a4f875370debc774ac82a89567445d96a64e6725ee15bd596',
  }),
  'darwin-arm64': Object.freeze({
    version: IROH_VERSION, platform: 'darwin', arch: 'arm64', executableName: 'dsh-mobile-iroh-host-darwin-arm64',
    downloadUrl: 'https://unpkg.com/dsh-mobile-iroh@0.1.0-alpha.2/native/dsh-mobile-iroh-host-darwin-arm64',
    downloadBytes: 17632400, executableBytes: 17632400,
    downloadSha256: 'e6106f481f8a1c1e2cb9d83e6e0bc91aaca1ce6d468556d387fcdc394f36ad29',
    executableSha256: 'e6106f481f8a1c1e2cb9d83e6e0bc91aaca1ce6d468556d387fcdc394f36ad29',
  }),
})

/** Public, credential-free description of the iroh sidecar. */
export interface IrohComponentStatus {
  readonly supported: boolean
  readonly installed: boolean
  readonly version: string
  readonly downloadBytes: number
  readonly installedBytes: number
  readonly sourceUrl: string
  readonly releasePage: string
  readonly storagePath: string
  readonly errorCode?: string
}

export interface IrohComponentManagerOptions {
  readonly stateDirectory: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  /** Candidate companion package directories, in preference order. */
  readonly locateCompanionRoots?: () => readonly string[]
  /** Instance-local release metadata for tests or a verified immutable release. */
  readonly artifact?: IrohArtifact
  readonly fetchArtifact?: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  readonly resolveSidecar?: (companionRoot: string, platform: string, arch: string) => Promise<string>
}

type IrohInstallOrigin = 'state' | 'companion'

async function digest(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export class IrohComponentManager {
  private readonly stateDirectory: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly locateCompanionRoots: () => readonly string[]
  private readonly resolveSidecar: (companionRoot: string, platform: string, arch: string) => Promise<string>
  private readonly artifact: IrohArtifact | undefined
  private readonly fetchArtifact: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  private readonly componentRoot: string
  private readonly componentStorage: string
  private readonly executablePath: string
  private readonly stagingRoot: string
  private cached: IrohComponentStatus
  private cachedExecutable: string | undefined
  private origin: IrohInstallOrigin | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(options: IrohComponentManagerOptions) {
    if (typeof options.stateDirectory !== 'string' || options.stateDirectory === '' || !isAbsolute(options.stateDirectory)) {
      throw new Error('iroh component state directory invalid')
    }
    this.stateDirectory = resolve(options.stateDirectory)
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    const artifact = options.artifact ?? IROH_COMPONENT_RELEASES[`${this.platform}-${this.arch}`]
    if (artifact !== undefined && (artifact.platform !== this.platform || artifact.arch !== this.arch
      || !/^https:\/\//u.test(artifact.downloadUrl) || !/^[a-f0-9]{64}$/u.test(artifact.downloadSha256)
      || !/^[a-f0-9]{64}$/u.test(artifact.executableSha256) || artifact.downloadBytes < 1 || artifact.executableBytes < 1
      || !/^[a-z0-9.-]+$/u.test(artifact.executableName))) throw new Error('iroh_artifact_invalid')
    this.artifact = artifact
    this.locateCompanionRoots = options.locateCompanionRoots ?? (() => [])
    this.resolveSidecar = options.resolveSidecar ?? resolveIrohSidecarAt
    this.fetchArtifact = options.fetchArtifact
      ?? ((url, signal) => downloadPinnedArtifact({ url, signal, expectedBytes: artifact?.downloadBytes ?? 0, errorPrefix: 'iroh', redirectHosts: ['unpkg.com'] }))
    this.componentRoot = join(this.stateDirectory, 'components', 'iroh')
    this.componentStorage = join(this.componentRoot, artifact?.version ?? IROH_VERSION)
    this.executablePath = join(this.componentStorage, artifact?.executableName ?? (this.platform === 'win32' ? 'dsh-mobile-iroh-host-win32-x64.exe' : 'dsh-mobile-iroh-host-linux-x64'))
    this.stagingRoot = join(this.stateDirectory, 'staging', 'iroh')
    this.cached = this.baseStatus()
  }

  /** Resolved, verified sidecar executable, or undefined when unavailable. */
  get executable(): string | undefined {
    return this.cachedExecutable
  }

  /** Cached component state; refresh with {@link initialize} or {@link install}. */
  status(): IrohComponentStatus {
    return this.cached
  }

  /** Verify the sidecar once at startup; safe to call before any status read. */
  async initialize(): Promise<void> {
    await this.enqueue(() => this.refresh())
  }

  /**
   * Confirm a usable sidecar without downloading anything.
   *
   * Enabling the channel calls this: starting must never trigger a download
   * on its own. Only the explicit install button below may fetch bytes.
   */
  async ensureAvailable(): Promise<IrohComponentStatus> {
    return this.enqueue(async () => {
      const current = await this.refresh()
      const supported = this.artifact !== undefined
      if (!supported) throw new Error('iroh_platform_unsupported')
      if (!current.installed) throw new Error('iroh_companion_missing')
      return current
    })
  }

  /**
   * Ensure a verified sidecar in the plugin private directory.
   *
   * Prefers an already installed companion copy (no network), otherwise
   * downloads the pinned release and verifies size and SHA-256 before
   * promoting it. A companion that exists but fails verification is reported
   * instead of being silently replaced by a download.
   */
  async install(): Promise<IrohComponentStatus> {
    return this.enqueue(async () => {
      const artifact = this.artifact
      if (artifact === undefined) throw new Error('iroh_platform_unsupported')
      const stateValid = await this.checkStateExecutable(artifact).catch(() => undefined)
      if (stateValid !== undefined) {
        this.publishInstalled(artifact, this.executablePath, stateValid, 'state')
        return this.cached
      }
      const companion = await this.findCompanionExecutable().catch(() => undefined)
      if (companion !== undefined) {
        if (companion.valid) {
          await this.publishBytes(artifact, await readFile(companion.executable))
          return this.cached
        }
        this.origin = undefined
        this.cachedExecutable = undefined
        this.cached = Object.freeze({ ...this.baseStatus(), installed: false, errorCode: 'irohSidecarInvalid' })
        throw new Error('iroh_sidecar_invalid')
      }
      let bytes: Uint8Array
      try {
        bytes = await this.downloadArtifact(artifact)
      } catch (error) {
        // Transport faults (DNS, reset, proxy) carry no stable code of their
        // own; report them as a download failure instead of a generic 500 so
        // the panel can suggest a retry.
        if (error instanceof Error && error.message.startsWith('iroh_')) throw error
        throw new Error('iroh_download_failed', { cause: error })
      }
      await this.publishBytes(artifact, bytes)
      return this.cached
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private baseStatus(): IrohComponentStatus {
    const supported = this.artifact !== undefined
    return Object.freeze({
      supported,
      installed: false,
      version: '',
      downloadBytes: this.artifact?.downloadBytes ?? 0,
      installedBytes: 0,
      sourceUrl: this.artifact?.downloadUrl ?? IROH_DOWNLOAD_PAGE,
      releasePage: IROH_RELEASE_PAGE,
      storagePath: this.stateDirectory,
      ...(supported ? {} : { errorCode: 'irohPlatformUnsupported' }),
    })
  }

  private publishInstalled(artifact: IrohArtifact, executable: string, version: string, origin: IrohInstallOrigin): void {
    this.origin = origin
    this.cachedExecutable = executable
    this.cached = Object.freeze({
      supported: true,
      installed: true,
      version,
      downloadBytes: artifact.downloadBytes,
      installedBytes: artifact.executableBytes,
      sourceUrl: artifact.downloadUrl,
      releasePage: IROH_RELEASE_PAGE,
      storagePath: executable,
    })
  }

  private async checkStateExecutable(artifact: IrohArtifact): Promise<string> {
    const entry = await lstat(this.executablePath)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== artifact.executableBytes) {
      throw new Error('iroh_sidecar_invalid')
    }
    // The companion lookup enforces this too: a byte-identical binary that
    // the OS refuses to execute must not read as installed.
    if (this.platform !== 'win32' && (entry.mode & 0o111) === 0) throw new Error('iroh_sidecar_invalid')
    if (await digest(this.executablePath) !== artifact.executableSha256) throw new Error('iroh_sidecar_invalid')
    return artifact.version
  }

  private async findCompanionExecutable(): Promise<{ executable: string; version: string; valid: boolean } | undefined> {
    for (const root of this.locateCompanionRoots()) {
      try {
        const executable = await this.resolveSidecar(root, this.platform, this.arch)
        const stat = await lstat(executable)
        let version = ''
        try {
          const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
          if (pkg.name === 'dsh-mobile-iroh' && typeof pkg.version === 'string') version = pkg.version
        } catch { /* version stays empty */ }
        return { executable, version, valid: true }
      } catch (error) {
        if (error instanceof Error && error.message === 'iroh_native_platform_unsupported') continue
        if (error instanceof Error && (error.message === 'iroh_native_hash_mismatch' || error.message === 'iroh_native_file_changed'
          || error.message === 'iroh_native_file_invalid' || error.message === 'iroh_native_manifest_invalid'
          || error.message === 'iroh_native_not_executable')) {
          return { executable: '', version: '', valid: false }
        }
      }
    }
    return undefined
  }

  private async downloadArtifact(artifact: IrohArtifact): Promise<Uint8Array> {
    const controller = new AbortController()
    const timeout = setTimeout(() => { controller.abort(new Error('iroh_download_timeout')) }, 600_000)
    timeout.unref()
    try {
      const bytes = await this.fetchArtifact(artifact.downloadUrl, controller.signal)
      if (bytes.byteLength !== artifact.downloadBytes) throw new Error('iroh_download_size_mismatch')
      if (digestBytes(bytes) !== artifact.downloadSha256) throw new Error('iroh_download_hash_mismatch')
      return bytes
    } finally {
      clearTimeout(timeout)
    }
  }

  private async publishBytes(artifact: IrohArtifact, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength !== artifact.executableBytes || digestBytes(bytes) !== artifact.executableSha256) {
      throw new Error('iroh_download_hash_mismatch')
    }
    await ensureIrohDirectory(this.stateDirectory, this.stagingRoot)
    await ensureIrohDirectory(this.stateDirectory, this.componentRoot)
    const staging = await mkdtemp(join(this.stagingRoot, 'install-'))
    const staged = join(staging, artifact.executableName)
    const backup = join(this.componentRoot, `.previous-${Date.now().toString(36)}`)
    let movedPrevious = false
    try {
      await writeFile(staged, bytes, { flag: 'wx', mode: 0o700 })
      await chmod(staged, 0o700)
      if (digestBytes(await readFile(staged)) !== artifact.executableSha256) throw new Error('iroh_download_hash_mismatch')
      await ensureIrohDirectory(this.stateDirectory, this.componentStorage)
      try {
        // Move the previous install aside only when one exists, then
        // recreate the storage directory: rename needs its parent present.
        await lstat(this.executablePath)
        await renameIrohPath(this.stateDirectory, this.componentStorage, backup)
        movedPrevious = true
        await ensureIrohDirectory(this.stateDirectory, this.componentStorage)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      try {
        await rename(staged, this.executablePath)
      } catch (error) {
        if (movedPrevious) {
          try {
            await renameIrohPath(this.stateDirectory, backup, this.componentStorage)
            movedPrevious = false
          } catch { /* keep both failures */ }
        }
        throw error
      }
      this.publishInstalled(artifact, this.executablePath, artifact.version, 'state')
    } finally {
      const leftovers = movedPrevious ? [staging, backup] : [staging]
      const failures: unknown[] = []
      for (const path of leftovers) {
        try { await removeIrohTree(this.stateDirectory, path) } catch (error) { failures.push(error) }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'iroh_component_cleanup_failed')
    }
  }

  /** Remove the installed sidecar component from the plugin private directory. */
  async purge(): Promise<IrohComponentStatus> {
    return this.enqueue(async () => {
      const failures: unknown[] = []
      try {
        await removeIrohTree(this.stateDirectory, this.componentStorage)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failures.push(error)
      }
      this.cachedExecutable = undefined
      this.origin = undefined
      this.cached = this.baseStatus()
      if (failures.length > 0) throw new AggregateError(failures, 'iroh_component_cleanup_failed')
      return this.cached
    })
  }

  private async refresh(): Promise<IrohComponentStatus> {
    if (this.artifact === undefined) {
      this.origin = undefined
      this.cachedExecutable = undefined
      this.cached = this.baseStatus()
      return this.cached
    }
    const stateVersion = await this.checkStateExecutable(this.artifact).catch(() => undefined)
    if (stateVersion !== undefined) {
      this.publishInstalled(this.artifact, this.executablePath, stateVersion, 'state')
      return this.cached
    }
    const companion = await this.findCompanionExecutable().catch(() => undefined)
    if (companion !== undefined && companion.valid) {
      this.publishInstalled(this.artifact, companion.executable, companion.version, 'companion')
      return this.cached
    }
    // A stale or tampered state copy (or companion) must not read as merely
    // absent: that sends the user to install over something already broken
    // without naming it.
    const stateExists = await lstat(this.executablePath)
      .then(entry => entry.isFile() && !entry.isSymbolicLink())
      .catch(() => false)
    this.origin = undefined
    this.cachedExecutable = undefined
    this.cached = Object.freeze({
      ...this.baseStatus(),
      installed: false,
      ...(stateExists || (companion !== undefined && !companion.valid) ? { errorCode: 'irohSidecarInvalid' } : {}),
    })
    return this.cached
  }
}
