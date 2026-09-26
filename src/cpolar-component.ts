import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { downloadPinnedArtifact } from './component-download.js'
import { restrictPrivateFile } from './private-file.js'

/** Pinned cpolar components fetched only after an explicit user action. */
interface CpolarArtifact {
  readonly version: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly downloadUrl: string
  readonly downloadBytes: number
  readonly downloadSha256: string
  readonly executableName: string
  readonly executableBytes: number
  readonly executableSha256: string
  /** Windows ships an MSI inside a zip; Linux ships the binary in a tarball. */
  readonly archiveKind: 'msi-zip' | 'tar.gz'
}

const CPOLAR_VERSION = '3.3.18'

const releases = [
  {
    version: CPOLAR_VERSION,
    platform: 'win32',
    arch: 'x64',
    downloadUrl: `https://www.cpolar.com/static/downloads/releases/${CPOLAR_VERSION}/cpolar-stable-windows-amd64-setup.zip`,
    downloadBytes: 7_603_505,
    downloadSha256: 'fb8cf60289058ee26079f995d2eeea0b21768a742d90c93015afe96e83428830',
    executableName: 'cpolar.exe',
    executableBytes: 19_637_680,
    executableSha256: 'b2d865ee505e842d22ceca5493a872efa893a79b079a7a8ee2bd3aa5343a5c41',
    archiveKind: 'msi-zip',
  },
  {
    version: CPOLAR_VERSION,
    platform: 'linux',
    arch: 'x64',
    downloadUrl: `https://www.cpolar.com/static/downloads/releases/${CPOLAR_VERSION}/cpolar-stable-linux-amd64.tar.gz`,
    downloadBytes: 7_404_781,
    downloadSha256: '5cd3320c4369928ccb509c4f5fa2ec3b86151ead77e1b77c1694aa64c43e32e7',
    executableName: 'cpolar',
    executableBytes: 19_328_632,
    executableSha256: 'c076e1109372a3f88031841c5989030e49b6871b54aee3260c796da9122dec05',
    archiveKind: 'tar.gz',
  },
  {
    version: CPOLAR_VERSION,
    platform: 'linux',
    arch: 'arm64',
    downloadUrl: `https://www.cpolar.com/static/downloads/releases/${CPOLAR_VERSION}/cpolar-stable-linux-arm64.tar.gz`,
    downloadBytes: 6_855_666,
    downloadSha256: '8a61a97983f18ae5ffb4b8bac4c9b3d8e2399a6ee101844e7b0b30d7f326157c',
    executableName: 'cpolar',
    executableBytes: 19_017_169,
    executableSha256: '8d76a1b7e518df45f387f107c7a428079c67ecd9b971a2915c53b947ea9b443a',
    archiveKind: 'tar.gz',
  },
] as const satisfies readonly CpolarArtifact[]

/** Pinned official cpolar release metadata for supported desktop targets. */
export const CPOLAR_COMPONENT_RELEASES: Readonly<Record<string, CpolarArtifact>> = Object.freeze(Object.fromEntries(
  releases.map(release => [`${release.platform}-${release.arch}`, Object.freeze(release)]),
))

/**
 * Canonical release metadata. New code should select from
 * {@link CPOLAR_COMPONENT_RELEASES} by platform and architecture; this alias
 * preserves the original Windows x64 entry for existing callers.
 */
export const CPOLAR_COMPONENT_RELEASE = CPOLAR_COMPONENT_RELEASES['win32-x64'] as CpolarArtifact

const DOWNLOAD_PAGE = 'https://www.cpolar.com/download'
const SIGNUP_URL = 'https://dashboard.cpolar.com/signup'
const DASHBOARD_URL = 'https://dashboard.cpolar.com/auth'
const TERMS_URL = 'https://www.cpolar.com/tos'

/** Public, credential-free description of the managed cpolar component. */
export interface CpolarComponentStatus {
  readonly supported: boolean
  readonly installed: boolean
  readonly configured: boolean
  readonly version: string
  readonly downloadBytes: number
  readonly installedBytes: number
  readonly sourceUrl: string
  readonly downloadPage: string
  readonly signupUrl: string
  readonly dashboardUrl: string
  readonly termsUrl: string
  readonly storagePath: string
  readonly errorCode?: string
}

interface CpolarComponentManagerOptions {
  readonly stateDirectory: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly fetchArtifact?: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  readonly extractArtifact?: (archive: string, destination: string) => Promise<void>
}

function inside(parent: string, child: string): boolean {
  const candidate = relative(parent, child)
  return candidate !== '' && !candidate.startsWith('..') && !isAbsolute(candidate)
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function regularFile(file: string, expectedBytes?: number): Promise<boolean> {
  try {
    const stat = await lstat(file)
    return stat.isFile() && !stat.isSymbolicLink() && (expectedBytes === undefined || stat.size === expectedBytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

type InstallFailureCode = 'cpolar_download_failed' | 'cpolar_extract_failed' | 'cpolar_storage_failed'

async function installStep<T>(code: InstallFailureCode, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('cpolar_')) throw error
    throw new Error(code, { cause: error })
  }
}

async function run(file: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    execFile(file, [...args], { windowsHide: true, timeout: 120_000 }, (error) => {
      if (error === null) resolveRun()
      else reject(error)
    })
  })
}

async function defaultFetchArtifact(
  url: string,
  signal: AbortSignal,
  expectedBytes: number,
): Promise<Uint8Array> {
  return downloadPinnedArtifact({
    url,
    expectedBytes,
    errorPrefix: 'cpolar',
    signal,
  })
}

async function extractWindowsMsi(archive: string, destination: string, executableName: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('cpolar_component_unsupported')
  const unpacked = join(destination, 'archive')
  const administrative = join(destination, 'administrative')
  await mkdir(unpacked, { recursive: true, mode: 0o700 })
  await mkdir(administrative, { recursive: true, mode: 0o700 })
  await run('tar.exe', ['-xf', archive, '-C', unpacked])
  const archiveEntries = await readdir(unpacked, { recursive: true })
  const msiRelative = archiveEntries.find(entry => entry.toLowerCase().endsWith('.msi'))
  if (msiRelative === undefined) throw new Error('cpolar_installer_missing')
  await run('msiexec.exe', ['/a', join(unpacked, msiRelative), '/qn', `TARGETDIR=${administrative}`])
  const installedEntries = await readdir(administrative, { recursive: true })
  const executableRelative = installedEntries.find(entry => basename(entry).toLowerCase() === executableName.toLowerCase())
  if (executableRelative === undefined) throw new Error('cpolar_executable_missing')
  await copyFile(join(administrative, executableRelative), join(destination, executableName))
}

async function extractLinuxTarball(archive: string, destination: string, executableName: string): Promise<void> {
  const unpacked = join(destination, 'archive')
  await mkdir(unpacked, { recursive: true, mode: 0o700 })
  // The Linux tarball carries the binary at its root; no installer involved.
  await run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-xzf', archive, '-C', unpacked])
  const archiveEntries = await readdir(unpacked, { recursive: true })
  const executableRelative = archiveEntries.find(entry => basename(entry).toLowerCase() === executableName.toLowerCase())
  if (executableRelative === undefined) throw new Error('cpolar_executable_missing')
  await copyFile(join(unpacked, executableRelative), join(destination, executableName))
}

async function defaultExtractArtifact(archive: string, destination: string, release: CpolarArtifact): Promise<void> {
  if (release.archiveKind === 'tar.gz') return extractLinuxTarball(archive, destination, release.executableName)
  return extractWindowsMsi(archive, destination, release.executableName)
}

/** Validate a cpolar Authtoken before it crosses the durable-file boundary. */
export function validateCpolarAuthtoken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 512
    || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('cpolar_authtoken_invalid')
  }
  return value
}

/** Owns the optional cpolar binary and account configuration inside DSH Mobile state. */
export class CpolarComponentManager {
  readonly executable: string
  readonly configFile: string
  readonly componentRoot: string
  readonly componentStorage: string
  readonly stateRoot: string
  readonly logRoot: string
  private readonly stagingRoot: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly release: CpolarArtifact | undefined
  private readonly fetchArtifact: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  private readonly extractArtifact: (archive: string, destination: string) => Promise<void>
  private installed = false
  private configured = false
  private errorCode: string | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(options: CpolarComponentManagerOptions) {
    const stateDirectory = resolve(options.stateDirectory)
    if (!isAbsolute(stateDirectory)) throw new Error('cpolar state directory must be absolute')
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.release = CPOLAR_COMPONENT_RELEASES[`${this.platform}-${this.arch}`]
    this.componentRoot = join(stateDirectory, 'components', 'cpolar')
    this.componentStorage = join(this.componentRoot, this.release?.version ?? CPOLAR_VERSION)
    this.executable = join(this.componentStorage, this.release?.executableName ?? 'cpolar')
    this.stateRoot = join(stateDirectory, 'state', 'cpolar')
    this.configFile = join(this.stateRoot, 'cpolar.yml')
    this.logRoot = join(stateDirectory, 'logs', 'cpolar')
    this.stagingRoot = join(stateDirectory, 'staging', 'cpolar')
    for (const child of [this.componentRoot, this.componentStorage, this.stateRoot, this.logRoot, this.stagingRoot]) {
      if (!inside(stateDirectory, child)) throw new Error('cpolar component path escaped its state directory')
    }
    const release = this.release
    this.fetchArtifact = options.fetchArtifact
      ?? ((url, signal) => defaultFetchArtifact(url, signal, release?.downloadBytes ?? 0))
    this.extractArtifact = options.extractArtifact
      ?? ((archive, destination) => {
        if (release === undefined) throw new Error('cpolar_component_unsupported')
        return defaultExtractArtifact(archive, destination, release)
      })
  }

  /** Inspect the managed binary and configuration without using global cpolar state. */
  async initialize(): Promise<void> {
    const release = this.release
    this.installed = release !== undefined && await regularFile(this.executable, release.executableBytes)
    if (this.installed && release !== undefined && await sha256(this.executable) !== release.executableSha256) {
      this.installed = false
      this.errorCode = 'cpolar_component_invalid'
    }
    this.configured = await regularFile(this.configFile)
    if (this.configured) await restrictPrivateFile(this.configFile)
  }

  /** Return a safe status that never includes the account token. */
  status(): CpolarComponentStatus {
    // Unsupported hosts still report the canonical entry so the panel can show
    // what would be installed elsewhere; `supported` carries the actual gate.
    const release = this.release ?? CPOLAR_COMPONENT_RELEASE
    return Object.freeze({
      supported: this.release !== undefined,
      installed: this.installed,
      configured: this.configured,
      version: release.version,
      downloadBytes: release.downloadBytes,
      installedBytes: release.executableBytes,
      sourceUrl: release.downloadUrl,
      downloadPage: DOWNLOAD_PAGE,
      signupUrl: SIGNUP_URL,
      dashboardUrl: DASHBOARD_URL,
      termsUrl: TERMS_URL,
      storagePath: this.componentRoot,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    })
  }

  /** Download, verify, and administratively extract cpolar after explicit confirmation. */
  install(): Promise<CpolarComponentStatus> {
    return this.enqueue(async () => {
      const release = this.release
      if (release === undefined) throw new Error('cpolar_component_unsupported')
      const staging = await installStep('cpolar_storage_failed', async () => {
        await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 })
        return mkdtemp(join(this.stagingRoot, 'install-'))
      })
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => { controller.abort() }, 120_000)
        timeout.unref()
        let bytes: Uint8Array
        try {
          bytes = await installStep('cpolar_download_failed', () => this.fetchArtifact(release.downloadUrl, controller.signal))
        } catch (error) {
          if (controller.signal.aborted) throw new Error('cpolar_download_timeout', { cause: error })
          throw error
        } finally { clearTimeout(timeout) }
        const digest = createHash('sha256').update(bytes).digest('hex')
        if (digest !== release.downloadSha256) throw new Error('cpolar_download_hash_mismatch')
        const archive = join(staging, release.archiveKind === 'tar.gz' ? 'cpolar.tar.gz' : 'cpolar.zip')
        await installStep('cpolar_storage_failed', () => writeFile(archive, bytes, { flag: 'wx', mode: 0o600 }))
        await installStep('cpolar_extract_failed', () => this.extractArtifact(archive, staging))
        const extracted = join(staging, release.executableName)
        const valid = await installStep('cpolar_extract_failed', async () => (
          await regularFile(extracted, release.executableBytes)
          && await sha256(extracted) === release.executableSha256
        ))
        if (!valid) {
          throw new Error('cpolar_executable_hash_mismatch')
        }
        const candidate = join(this.componentRoot, `.install-${randomBytes(12).toString('hex')}`)
        await installStep('cpolar_storage_failed', async () => {
          await mkdir(candidate, { recursive: true, mode: 0o700 })
          await copyFile(extracted, join(candidate, release.executableName))
          await chmod(join(candidate, release.executableName), 0o700)
          await rm(this.componentStorage, { recursive: true, force: true })
          await rename(candidate, this.componentStorage)
        })
        this.installed = true
        this.errorCode = undefined
      } finally {
        await installStep('cpolar_storage_failed', () => rm(staging, { recursive: true, force: true }))
      }
    })
  }

  /** Store only the cpolar token in a private, self-update-disabled configuration. */
  configure(authtoken: unknown): Promise<CpolarComponentStatus> {
    return this.enqueue(async () => {
      const token = validateCpolarAuthtoken(authtoken)
      await mkdir(this.stateRoot, { recursive: true, mode: 0o700 })
      const temporary = join(this.stateRoot, `.cpolar.${randomBytes(12).toString('hex')}.tmp`)
      const body = `authtoken: ${JSON.stringify(token)}\nconsole_ui: false\nupdate: false\ninspect_db_size: -1\n`
      try {
        await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await rename(temporary, this.configFile)
        await restrictPrivateFile(this.configFile)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
      this.configured = true
      this.errorCode = undefined
    })
  }

  /** Remove every cpolar file owned by DSH Mobile without touching global state. */
  purge(): Promise<CpolarComponentStatus> {
    return this.enqueue(async () => {
      await Promise.all([
        rm(this.componentRoot, { recursive: true, force: true }),
        rm(this.stateRoot, { recursive: true, force: true }),
        rm(this.logRoot, { recursive: true, force: true }),
        rm(this.stagingRoot, { recursive: true, force: true }),
      ])
      this.installed = false
      this.configured = false
      this.errorCode = undefined
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<CpolarComponentStatus> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task.then(() => this.status())
  }
}
