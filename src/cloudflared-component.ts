import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { downloadPinnedArtifact } from './component-download.js'
import { assertManagedParents, ensureManagedDirectory, removeManagedPaths, removeManagedTree, replaceManagedDirectory } from './managed-files.js'

/**
 * Pinned cloudflared components fetched only after an explicit user action.
 *
 * Cloudflare ships bare executables for Windows and Linux but a `.tgz` for
 * macOS, so an artifact carries two digests: the bytes on the wire
 * (`downloadBytes`/`downloadSha256`) and the executable that ends up installed
 * (`executableBytes`/`executableSha256`). For bare artifacts the two pairs are
 * identical. `--no-autoupdate` is passed at runtime as well, so the pinned
 * bytes stay the bytes that were verified.
 */
interface CloudflaredArtifact {
  readonly version: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly downloadUrl: string
  readonly downloadBytes: number
  readonly downloadSha256: string
  readonly executableName: string
  /** Bytes of the installed executable; equals `downloadBytes` for bare artifacts. */
  readonly executableBytes: number
  readonly executableSha256: string
  /** Set when the download is an archive rather than the executable itself. */
  readonly archive?: CloudflaredArchive
}

interface CloudflaredArchive {
  readonly format: 'tgz'
  /** Member basename to install, e.g. `cloudflared`. */
  readonly member: string
}

/** Upper bound for `tar -t` output; a pinned release listing is a few lines. */
const MAX_ARCHIVE_LIST_BYTES = 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 256
const DOWNLOAD_TIMEOUT_MS = 300_000

const CLOUDFLARED_VERSION = '2026.9.1'

const releases = [
  {
    version: CLOUDFLARED_VERSION,
    platform: 'win32',
    arch: 'x64',
    downloadUrl: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`,
    downloadBytes: 54_976_432,
    downloadSha256: '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712',
    executableName: 'cloudflared.exe',
    executableBytes: 54_976_432,
    executableSha256: '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712',
  },
  {
    version: CLOUDFLARED_VERSION,
    platform: 'linux',
    arch: 'x64',
    downloadUrl: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`,
    downloadBytes: 39_838_488,
    downloadSha256: '03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc',
    executableName: 'cloudflared',
    executableBytes: 39_838_488,
    executableSha256: '03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc',
  },
  {
    version: CLOUDFLARED_VERSION,
    platform: 'linux',
    arch: 'arm64',
    downloadUrl: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-arm64`,
    downloadBytes: 37_466_252,
    downloadSha256: '3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3',
    executableName: 'cloudflared',
    executableBytes: 37_466_252,
    executableSha256: '3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3',
  },
  // Cloudflare publishes macOS only as a `.tgz`, so these two carry distinct
  // archive and executable digests: 21 MB of gzip in, a 39-42 MB Mach-O out.
  {
    version: CLOUDFLARED_VERSION,
    platform: 'darwin',
    arch: 'x64',
    downloadUrl: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-amd64.tgz`,
    downloadBytes: 21_118_723,
    downloadSha256: 'ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4',
    executableName: 'cloudflared',
    executableBytes: 41_731_488,
    executableSha256: '1ea07ae775b03236bd6be18ca1848d6bdc4af2f4f3bce398823b5a36e5761b75',
    archive: { format: 'tgz', member: 'cloudflared' },
  },
  {
    version: CLOUDFLARED_VERSION,
    platform: 'darwin',
    arch: 'arm64',
    downloadUrl: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-darwin-arm64.tgz`,
    downloadBytes: 19_217_478,
    downloadSha256: 'c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe',
    executableName: 'cloudflared',
    executableBytes: 38_893_072,
    executableSha256: '9a0b19f67dc7a3011bc6b972c7ce06a5fcea8784ac6bd599ffa382ea4aeb5a6e',
    archive: { format: 'tgz', member: 'cloudflared' },
  },
] as const satisfies readonly CloudflaredArtifact[]

/** Pinned official cloudflared release metadata for supported desktop targets. */
export const CLOUDFLARED_COMPONENT_RELEASES: Readonly<Record<string, CloudflaredArtifact>> = Object.freeze(Object.fromEntries(
  releases.map(release => [`${release.platform}-${release.arch}`, Object.freeze(release)]),
))

/**
 * Canonical release metadata. New code should select from
 * {@link CLOUDFLARED_COMPONENT_RELEASES} by platform and architecture; this
 * alias preserves the original Windows x64 entry for existing callers.
 */
export const CLOUDFLARED_COMPONENT_RELEASE = CLOUDFLARED_COMPONENT_RELEASES['win32-x64'] as CloudflaredArtifact

const DOWNLOAD_PAGE = 'https://github.com/cloudflare/cloudflared/releases'
const TERMS_URL = 'https://www.cloudflare.com/website-terms/'

/**
 * Public, credential-free description of the managed cloudflared component.
 *
 * There is deliberately no `configured` flag: a quick tunnel needs no account,
 * token, or DNS record, so installation is the only precondition.
 */
export interface CloudflaredComponentStatus {
  readonly supported: boolean
  readonly installed: boolean
  readonly version: string
  readonly downloadBytes: number
  readonly installedBytes: number
  readonly sourceUrl: string
  readonly downloadPage: string
  readonly termsUrl: string
  readonly storagePath: string
  readonly errorCode?: string
}

interface CloudflaredComponentManagerOptions {
  readonly stateDirectory: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly fetchArtifact?: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  readonly extractArtifact?: (archive: string, destination: string, member: string) => Promise<void>
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

/** Reject absolute, traversing, or Windows-shaped archive members. */
function validatedArchiveEntry(rawEntry: string): readonly string[] {
  if (rawEntry.length === 0 || rawEntry.includes('\\') || rawEntry.includes('\u0000')
    || rawEntry.startsWith('/') || /^[a-zA-Z]:/u.test(rawEntry)) {
    throw new Error('cloudflared_archive_path_invalid')
  }
  const segments = rawEntry.replace(/\/$/u, '').split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('cloudflared_archive_path_invalid')
  }
  return segments
}

/** Select exactly one archive member named `member`, wherever it sits in the tree. */
export function selectCloudflaredArchiveEntry(entries: readonly string[], member: string): string {
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('cloudflared_archive_entries_invalid')
  }
  let selected: string | undefined
  for (const entry of entries) {
    const segments = validatedArchiveEntry(entry)
    if (segments.at(-1) === member) {
      if (selected !== undefined) throw new Error('cloudflared_archive_executable_ambiguous')
      selected = entry.replace(/\/$/u, '')
    }
  }
  if (selected === undefined) throw new Error('cloudflared_archive_executable_missing')
  return selected
}

/**
 * Unpack the pinned member out of a `.tgz` using the system `tar`, which ships
 * with Windows 10+, macOS, and every supported Linux base.
 */
async function defaultExtractArtifact(archive: string, destination: string, member: string): Promise<void> {
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar'
  const listing = await runCapture(tar, ['-tzf', archive])
  const entries = listing.split(/\r?\n/u).filter(entry => entry.length > 0)
  const selected = selectCloudflaredArchiveEntry(entries, member)
  const unpacked = join(destination, 'archive')
  await mkdir(unpacked, { recursive: true, mode: 0o700 })
  await runCapture(tar, ['-xzf', archive, '-C', unpacked, selected])
  const extracted = join(unpacked, ...validatedArchiveEntry(selected))
  if (!await regularFile(extracted)) throw new Error('cloudflared_archive_executable_invalid')
  await copyFile(extracted, join(destination, member))
}

async function defaultFetchArtifact(
  url: string,
  signal: AbortSignal,
  expectedBytes: number,
): Promise<Uint8Array> {
  return downloadPinnedArtifact({
    url,
    expectedBytes,
    errorPrefix: 'cloudflared',
    signal,
  })
}

/** Select the pinned artifact for one host, or undefined where unsupported. */
function lookupRelease(platform: NodeJS.Platform, arch: string): CloudflaredArtifact | undefined {
  return CLOUDFLARED_COMPONENT_RELEASES[`${platform}-${arch}`]
}

/** Owns the optional cloudflared binary inside DSH Mobile state. */
export class CloudflaredComponentManager {
  readonly executable: string
  readonly componentRoot: string
  readonly componentStorage: string
  readonly stateRoot: string
  readonly logRoot: string
  private readonly stagingRoot: string
  private readonly stateDirectory: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly release: CloudflaredArtifact | undefined
  private readonly fetchArtifact: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  private readonly extractArtifact: (archive: string, destination: string, member: string) => Promise<void>
  private installed = false
  private errorCode: string | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(options: CloudflaredComponentManagerOptions) {
    if (!isAbsolute(options.stateDirectory)) throw new Error('cloudflared state directory must be absolute')
    const stateDirectory = resolve(options.stateDirectory)
    this.stateDirectory = stateDirectory
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.release = lookupRelease(this.platform, this.arch)
    this.componentRoot = join(stateDirectory, 'components', 'cloudflared')
    this.componentStorage = join(this.componentRoot, this.release?.version ?? CLOUDFLARED_VERSION)
    this.executable = join(this.componentStorage, this.release?.executableName ?? 'cloudflared')
    this.stateRoot = join(stateDirectory, 'state', 'cloudflared')
    this.logRoot = join(stateDirectory, 'logs', 'cloudflared')
    this.stagingRoot = join(stateDirectory, 'staging', 'cloudflared')
    for (const child of [this.componentRoot, this.componentStorage, this.stateRoot, this.logRoot, this.stagingRoot]) {
      if (!inside(stateDirectory, child)) throw new Error('cloudflared component path escaped its state directory')
    }
    const release = this.release
    this.fetchArtifact = options.fetchArtifact
      ?? ((url, signal) => defaultFetchArtifact(url, signal, release?.downloadBytes ?? 0))
    this.extractArtifact = options.extractArtifact ?? defaultExtractArtifact
  }

  /** Inspect the managed binary without using any global cloudflared state. */
  async initialize(): Promise<void> {
    const release = this.release
    this.installed = false
    this.errorCode = undefined
    try {
      await assertManagedParents(this.stateDirectory, this.executable, 'cloudflared')
      this.installed = release !== undefined && await regularFile(this.executable, release.executableBytes)
      if (this.installed && release !== undefined && await sha256(this.executable) !== release.executableSha256) {
        this.installed = false
        this.errorCode = 'cloudflared_component_invalid'
      }
    } catch (_error) {
      this.installed = false
      this.errorCode = 'cloudflared_component_invalid'
    }
  }

  /** Return a safe status that never includes machine-specific account data. */
  status(): CloudflaredComponentStatus {
    // Unsupported hosts still report the canonical entry so the panel can show
    // what would be installed elsewhere; `supported` carries the actual gate.
    const release = this.release ?? CLOUDFLARED_COMPONENT_RELEASE
    return Object.freeze({
      supported: this.release !== undefined,
      installed: this.installed,
      version: release.version,
      downloadBytes: release.downloadBytes,
      installedBytes: release.executableBytes,
      sourceUrl: release.downloadUrl,
      downloadPage: DOWNLOAD_PAGE,
      termsUrl: TERMS_URL,
      storagePath: this.componentRoot,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    })
  }

  /** Download, verify, and install the pinned cloudflared executable after explicit confirmation. */
  install(): Promise<CloudflaredComponentStatus> {
    return this.enqueue(async () => {
      const release = this.release
      if (release === undefined) throw new Error('cloudflared_component_unsupported')
      await assertManagedParents(this.stateDirectory, this.executable, 'cloudflared')
      await ensureManagedDirectory(this.stateDirectory, this.stagingRoot, 'cloudflared')
      const staging = await mkdtemp(join(this.stagingRoot, 'install-'))
      try {
        const controller = new AbortController()
        // The pinned artifact is tens of megabytes, so the transfer budget is
        // larger than a control handshake: a slow but working link must not
        // fail the install.
        const timeout = setTimeout(() => { controller.abort() }, DOWNLOAD_TIMEOUT_MS)
        timeout.unref()
        let bytes: Uint8Array
        try { bytes = await this.fetchArtifact(release.downloadUrl, controller.signal) } finally { clearTimeout(timeout) }
        if (bytes.byteLength !== release.downloadBytes) {
          throw new Error('cloudflared_download_size_mismatch')
        }
        const digest = createHash('sha256').update(bytes).digest('hex')
        if (digest !== release.downloadSha256) throw new Error('cloudflared_download_hash_mismatch')
        const staged = join(staging, release.executableName)
        if (release.archive === undefined) {
          // Bare artifacts *are* the executable, so the download pair is
          // already the install pair.
          await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 })
        } else {
          const downloaded = join(staging, `${release.executableName}.download`)
          await writeFile(downloaded, bytes, { flag: 'wx', mode: 0o600 })
          try {
            await this.extractArtifact(downloaded, staging, release.archive.member)
          } finally {
            await rm(downloaded, { force: true })
          }
        }
        await chmod(staged, 0o700)
        if (!await regularFile(staged, release.executableBytes)
          || await sha256(staged) !== release.executableSha256) {
          throw new Error('cloudflared_executable_hash_mismatch')
        }
        const candidate = join(this.componentRoot, `.install-${randomBytes(12).toString('hex')}`)
        await ensureManagedDirectory(this.stateDirectory, candidate, 'cloudflared')
        try {
          await copyFile(staged, join(candidate, release.executableName))
          await chmod(join(candidate, release.executableName), 0o700)
          await replaceManagedDirectory(this.stateDirectory, this.componentStorage, candidate, 'cloudflared')
        } catch (error) {
          try { await removeManagedTree(this.stateDirectory, candidate, 'cloudflared') } catch (_cleanupError) {
            process.emitWarning('cloudflared candidate cleanup failed', { code: 'DSH_MOBILE_COMPONENT_CLEANUP_FAILED' })
          }
          throw error
        }
        this.installed = true
        this.errorCode = undefined
      } catch (error) {
        try {
          await assertManagedParents(this.stateDirectory, this.executable, 'cloudflared')
          this.installed = await regularFile(this.executable, release.executableBytes)
            && await sha256(this.executable) === release.executableSha256
        } catch (_inspectionError) { this.installed = false }
        throw error
      } finally {
        await removeManagedTree(this.stateDirectory, staging, 'cloudflared')
      }
    })
  }

  /** Remove every cloudflared file owned by DSH Mobile without touching global state. */
  purge(): Promise<CloudflaredComponentStatus> {
    return this.enqueue(async () => {
      await removeManagedPaths(this.stateDirectory, [this.componentRoot, this.stateRoot, this.logRoot, this.stagingRoot], 'cloudflared')
      this.installed = false
      this.errorCode = undefined
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<CloudflaredComponentStatus> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task.then(() => this.status())
  }
}
