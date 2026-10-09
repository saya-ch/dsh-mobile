import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { assertManagedParents, ensureManagedDirectory, removeManagedPaths, removeManagedTree, replaceManagedDirectory } from './managed-files.js'

const FRP_VERSION = '0.70.1'
const MAX_ARCHIVE_ENTRIES = 128
const MAX_ARCHIVE_LIST_BYTES = 256 * 1024

interface FrpArtifact {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly downloadUrl: string
  readonly downloadBytes: number
  readonly downloadSha256: string
  readonly archiveName: string
  readonly executableName: string
}

const releases = [
  {
    platform: 'win32', arch: 'x64', archiveName: 'frp.zip', executableName: 'frpc.exe',
    downloadBytes: 13_924_309,
    downloadSha256: '531f3cd3cc41c0b4f077b54fe6b7dd83c0ff727e7f0bf412a4c78fa279165de5',
    downloadUrl: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_windows_amd64.zip`,
  },
  {
    platform: 'win32', arch: 'arm64', archiveName: 'frp.zip', executableName: 'frpc.exe',
    downloadBytes: 12_204_751,
    downloadSha256: '74d3acaf0f03ee190dd0462f9b49861dca50b0559c5488af4b36572fc951fcca',
    downloadUrl: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_windows_arm64.zip`,
  },
  {
    platform: 'linux', arch: 'x64', archiveName: 'frp.tar.gz', executableName: 'frpc',
    downloadBytes: 13_924_042,
    downloadSha256: '333da23d1b9009d7c01638e9ba38cf4600f7d37d393f854e96ee1396adefa9a6',
    downloadUrl: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz`,
  },
  {
    platform: 'linux', arch: 'arm64', archiveName: 'frp.tar.gz', executableName: 'frpc',
    downloadBytes: 12_371_290,
    downloadSha256: '3990f396a9a490ee7f0e5f355287750ed41520064ed999eab443b5e9a78d773d',
    downloadUrl: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_arm64.tar.gz`,
  },
  {
    platform: 'darwin', arch: 'x64', archiveName: 'frp.tar.gz', executableName: 'frpc',
    downloadBytes: 13_951_979,
    downloadSha256: 'cbf69cf26e5553e914e97d37f5d4367fa30f5f531d073a889465af4719281e25',
    downloadUrl: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_darwin_amd64.tar.gz`,
  },
  {
    platform: 'darwin', arch: 'arm64', archiveName: 'frp.tar.gz', executableName: 'frpc',
    downloadBytes: 12_670_664,
    downloadSha256: 'cfa733b5a261c1647edee3c1fc4133d2542989b28f5602e81d47fc821d25c55f',
    downloadUrl: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_darwin_arm64.tar.gz`,
  },
] as const satisfies readonly FrpArtifact[]

/** Pinned official FRP release metadata for supported desktop targets. */
export const FRP_COMPONENT_RELEASES: Readonly<Record<string, FrpArtifact>> = Object.freeze(Object.fromEntries(
  releases.map(release => [`${release.platform}-${release.arch}`, Object.freeze(release)]),
))

/** Public, credential-free description of the managed FRP client. */
export interface FrpComponentStatus {
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

interface FrpComponentManagerOptions {
  readonly stateDirectory: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly fetchArtifact?: (artifact: FrpArtifact, signal: AbortSignal) => Promise<Uint8Array>
  readonly extractArtifact?: (archive: string, destination: string, executableName: string) => Promise<void>
  readonly inspectExecutable?: (executable: string) => Promise<string>
}

function inside(parent: string, child: string): boolean {
  const candidate = relative(parent, child)
  return candidate !== '' && !candidate.startsWith('..') && !isAbsolute(candidate)
}

async function regularFile(file: string): Promise<boolean> {
  try {
    const entry = await lstat(file)
    return entry.isFile() && !entry.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function runCapture(file: string, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolveRun, reject) => {
    execFile(file, [...args], {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: MAX_ARCHIVE_LIST_BYTES,
      encoding: 'utf8',
    }, (error, stdout) => {
      if (error === null) resolveRun(stdout)
      else reject(error)
    })
  })
}

function validatedArchiveEntry(rawEntry: string): readonly string[] {
  if (rawEntry.length === 0 || rawEntry.includes('\\') || rawEntry.includes('\u0000')
    || rawEntry.startsWith('/') || /^[a-zA-Z]:/u.test(rawEntry)) {
    throw new Error('frp_archive_path_invalid')
  }
  const segments = rawEntry.replace(/\/$/u, '').split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('frp_archive_path_invalid')
  }
  return segments
}

/** Select exactly one nested frpc executable from a safe archive listing. */
export function selectFrpExecutableEntry(entries: readonly string[], executableName: string): string {
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('frp_archive_entries_invalid')
  let executableEntry: string | undefined
  for (const entry of entries) {
    const segments = validatedArchiveEntry(entry)
    if (segments.length >= 2 && segments.at(-1) === executableName) {
      if (executableEntry !== undefined) throw new Error('frp_archive_executable_ambiguous')
      executableEntry = entry.replace(/\/$/u, '')
    }
  }
  if (executableEntry === undefined) throw new Error('frp_archive_executable_missing')
  return executableEntry
}

async function defaultExtractArtifact(archive: string, destination: string, executableName: string): Promise<void> {
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar'
  const listing = await runCapture(tar, ['-tf', archive])
  const entries = listing.split(/\r?\n/u).filter(entry => entry.length > 0)
  const executableEntry = selectFrpExecutableEntry(entries, executableName)
  const unpacked = join(destination, 'archive')
  await mkdir(unpacked, { recursive: true, mode: 0o700 })
  await runCapture(tar, ['-xf', archive, '-C', unpacked, executableEntry])
  const extracted = join(unpacked, ...validatedArchiveEntry(executableEntry))
  if (!await regularFile(extracted)) throw new Error('frp_archive_executable_invalid')
  await copyFile(extracted, join(destination, executableName))
}

async function defaultFetchArtifact(artifact: FrpArtifact, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(artifact.downloadUrl, { redirect: 'follow', signal })
  if (!response.ok) throw new Error(`frp_download_http_${String(response.status)}`)
  const finalUrl = new URL(response.url)
  const officialHost = finalUrl.hostname === 'github.com' || finalUrl.hostname.endsWith('.githubusercontent.com')
  if (finalUrl.protocol !== 'https:' || !officialHost) throw new Error('frp_download_origin_invalid')
  const lengthHeader = response.headers.get('content-length')
  const declaredLength = lengthHeader === null ? undefined : Number(lengthHeader)
  if (declaredLength !== undefined && (!Number.isFinite(declaredLength) || declaredLength !== artifact.downloadBytes)) {
    throw new Error('frp_download_size_mismatch')
  }
  if (response.body === null) throw new Error('frp_download_empty')
  const chunks: Uint8Array[] = []
  let received = 0
  const reader = response.body.getReader()
  while (true) {
    const result = await reader.read()
    if (result.done) break
    received += result.value.byteLength
    if (received > artifact.downloadBytes) {
      await reader.cancel()
      throw new Error('frp_download_size_mismatch')
    }
    chunks.push(result.value)
  }
  if (received !== artifact.downloadBytes) throw new Error('frp_download_size_mismatch')
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function defaultInspectExecutable(executable: string): Promise<string> {
  return (await runCapture(executable, ['--version'])).trim()
}

/** Owns the optional official frpc binary inside the DSH Mobile state directory. */
export class FrpComponentManager {
  readonly executable: string
  readonly componentRoot: string
  readonly componentStorage: string
  readonly logRoot: string
  private readonly stagingRoot: string
  private readonly stateDirectory: string
  private readonly artifact: FrpArtifact | undefined
  private readonly fetchArtifact: (artifact: FrpArtifact, signal: AbortSignal) => Promise<Uint8Array>
  private readonly extractArtifact: (archive: string, destination: string, executableName: string) => Promise<void>
  private readonly inspectExecutable: (executable: string) => Promise<string>
  private installed = false
  private installedBytes = 0
  private errorCode: string | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(options: FrpComponentManagerOptions) {
    if (!isAbsolute(options.stateDirectory)) throw new Error('frp state directory must be absolute')
    const stateDirectory = resolve(options.stateDirectory)
    this.stateDirectory = stateDirectory
    const platform = options.platform ?? process.platform
    const arch = options.arch ?? process.arch
    this.artifact = FRP_COMPONENT_RELEASES[`${platform}-${arch}`]
    this.componentRoot = join(stateDirectory, 'components', 'frp')
    this.componentStorage = join(this.componentRoot, FRP_VERSION)
    this.executable = join(this.componentStorage, platform === 'win32' ? 'frpc.exe' : 'frpc')
    this.logRoot = join(stateDirectory, 'logs', 'frp')
    this.stagingRoot = join(stateDirectory, 'staging', 'frp')
    for (const child of [this.componentRoot, this.componentStorage, this.logRoot, this.stagingRoot]) {
      if (!inside(stateDirectory, child)) throw new Error('frp component path escaped its state directory')
    }
    this.fetchArtifact = options.fetchArtifact ?? defaultFetchArtifact
    this.extractArtifact = options.extractArtifact ?? defaultExtractArtifact
    this.inspectExecutable = options.inspectExecutable ?? defaultInspectExecutable
  }

  /** Inspect the managed executable without relying on global FRP installations. */
  async initialize(): Promise<void> {
    this.installed = false
    this.installedBytes = 0
    this.errorCode = undefined
    try {
      await assertManagedParents(this.stateDirectory, this.executable, 'frp')
      this.installed = await regularFile(this.executable)
      this.installedBytes = this.installed ? (await stat(this.executable)).size : 0
      if (this.installed) {
        const version = await this.inspectExecutable(this.executable)
        if (version !== FRP_VERSION) throw new Error('frp_component_version_mismatch')
      }
    } catch (_error) {
      this.installed = false
      this.installedBytes = 0
      this.errorCode = 'frp_component_invalid'
    }
  }

  /** Return component metadata without exposing configuration or credentials. */
  status(): FrpComponentStatus {
    return Object.freeze({
      supported: this.artifact !== undefined,
      installed: this.installed,
      version: FRP_VERSION,
      downloadBytes: this.artifact?.downloadBytes ?? 0,
      installedBytes: this.installedBytes,
      sourceUrl: this.artifact?.downloadUrl ?? 'https://github.com/fatedier/frp/releases',
      releasePage: `https://github.com/fatedier/frp/releases/tag/v${FRP_VERSION}`,
      storagePath: this.componentRoot,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    })
  }

  /** Download, verify, and extract only frpc after explicit confirmation. */
  install(): Promise<FrpComponentStatus> {
    return this.enqueue(async () => {
      const artifact = this.artifact
      if (artifact === undefined) throw new Error('frp_component_unsupported')
      await assertManagedParents(this.stateDirectory, this.executable, 'frp')
      await ensureManagedDirectory(this.stateDirectory, this.stagingRoot, 'frp')
      const staging = await mkdtemp(join(this.stagingRoot, 'install-'))
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => { controller.abort() }, 120_000)
        timeout.unref()
        let bytes: Uint8Array
        try { bytes = await this.fetchArtifact(artifact, controller.signal) } finally { clearTimeout(timeout) }
        if (bytes.byteLength !== artifact.downloadBytes) throw new Error('frp_download_size_mismatch')
        if (sha256(bytes) !== artifact.downloadSha256) throw new Error('frp_download_hash_mismatch')
        const archive = join(staging, artifact.archiveName)
        await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 })
        await this.extractArtifact(archive, staging, artifact.executableName)
        const extracted = join(staging, artifact.executableName)
        if (!await regularFile(extracted)) throw new Error('frp_executable_missing')
        await chmod(extracted, 0o700)
        const version = await this.inspectExecutable(extracted)
        if (version !== FRP_VERSION) throw new Error('frp_component_version_mismatch')
        const candidate = join(this.componentRoot, `.install-${randomBytes(12).toString('hex')}`)
        await ensureManagedDirectory(this.stateDirectory, candidate, 'frp')
        try {
          const candidateExecutable = join(candidate, artifact.executableName)
          await copyFile(extracted, candidateExecutable)
          await chmod(candidateExecutable, 0o700)
          await replaceManagedDirectory(this.stateDirectory, this.componentStorage, candidate, 'frp')
        } catch (error) {
          try { await removeManagedTree(this.stateDirectory, candidate, 'frp') } catch (_cleanupError) {
            process.emitWarning('FRP candidate cleanup failed', { code: 'DSH_MOBILE_COMPONENT_CLEANUP_FAILED' })
          }
          throw error
        }
        this.installed = true
        this.installedBytes = (await stat(this.executable)).size
        this.errorCode = undefined
      } finally {
        await removeManagedTree(this.stateDirectory, staging, 'frp')
      }
    })
  }

  /** Remove all FRP executable, staging, and log files owned by DSH Mobile. */
  purge(): Promise<FrpComponentStatus> {
    return this.enqueue(async () => {
      await removeManagedPaths(this.stateDirectory, [this.componentRoot, this.logRoot, this.stagingRoot], 'frp')
      this.installed = false
      this.installedBytes = 0
      this.errorCode = undefined
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<FrpComponentStatus> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task.then(() => this.status())
  }
}
