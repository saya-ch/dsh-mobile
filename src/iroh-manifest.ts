/** Checksum-gated resolution of the iroh transport host binary.
 *
 * The sidecar is built and published by the independent `dsh-mobile-iroh`
 * companion (npm alpha channel); this stable plugin never bundles, downloads
 * or rebuilds it. Resolution points at an installed companion directory,
 * validates its manifest against that package's own version, then verifies
 * the platform binary byte-for-byte. Anything unexpected fails closed.
 */
import { createHash } from 'node:crypto'
import { lstat, open, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const IROH_NATIVE_TARGETS = Object.freeze({
  'win32-x64': 'dsh-mobile-iroh-host-win32-x64.exe',
  'linux-x64': 'dsh-mobile-iroh-host-linux-x64',
  'darwin-x64': 'dsh-mobile-iroh-host-darwin-x64',
  'darwin-arm64': 'dsh-mobile-iroh-host-darwin-arm64',
} as const)

export type IrohNativeTarget = keyof typeof IROH_NATIVE_TARGETS

const MAX_BINARY_BYTES = 128 * 1024 * 1024
const MAX_MANIFEST_BYTES = 4096

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
}

export interface IrohNativeArtifact {
  readonly file: string
  readonly bytes: number
  readonly sha256: string
}

export interface IrohNativeManifest {
  readonly schemaVersion: 1
  readonly packageVersion: string
  readonly artifacts: Readonly<Record<IrohNativeTarget, IrohNativeArtifact>>
}

/** Validate the complete package-bound inventory; artifact paths are never supplied by metadata. */
export function validateIrohNativeManifest(value: unknown, packageVersion: string): IrohNativeManifest {
  if (!exactKeys(value, ['schemaVersion', 'packageVersion', 'artifacts']) || value.schemaVersion !== 1
    || value.packageVersion !== packageVersion || !exactKeys(value.artifacts, Object.keys(IROH_NATIVE_TARGETS))) {
    throw new Error('iroh_native_manifest_invalid')
  }
  const artifacts = {} as Record<IrohNativeTarget, IrohNativeArtifact>
  for (const target of Object.keys(IROH_NATIVE_TARGETS) as readonly IrohNativeTarget[]) {
    const entry = (value.artifacts as Record<string, unknown>)[target]
    if (!exactKeys(entry, ['file', 'bytes', 'sha256']) || entry.file !== IROH_NATIVE_TARGETS[target]
      || !Number.isSafeInteger(entry.bytes) || (entry.bytes as number) < 64 || (entry.bytes as number) > MAX_BINARY_BYTES
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256 as string)) {
      throw new Error('iroh_native_manifest_invalid')
    }
    artifacts[target] = Object.freeze({ file: entry.file, bytes: entry.bytes, sha256: entry.sha256 }) as IrohNativeArtifact
  }
  return Object.freeze({ schemaVersion: 1, packageVersion: value.packageVersion, artifacts: Object.freeze(artifacts) }) as IrohNativeManifest
}

/**
 * Return the checksum-verified sidecar inside an installed companion package.
 * @param companionRoot - Companion package directory (contains `package.json` + `native/`).
 */
export async function resolveIrohSidecarAt(companionRoot: string, platform: string, arch: string): Promise<string> {
  const target = `${platform}-${arch}`
  if (!Object.hasOwn(IROH_NATIVE_TARGETS, target)) throw new Error('iroh_native_platform_unsupported')
  const root = await realpath(resolve(companionRoot)).catch(() => { throw new Error('iroh_native_missing') })
  const nativeDirectory = join(root, 'native')
  const directory = await lstat(nativeDirectory).catch(() => { throw new Error('iroh_native_missing') })
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('iroh_native_file_invalid')
  const manifestPath = join(nativeDirectory, 'manifest.json')
  const manifestStat = await lstat(manifestPath).catch(() => { throw new Error('iroh_native_missing') })
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_MANIFEST_BYTES) {
    throw new Error('iroh_native_manifest_invalid')
  }
  let manifest: IrohNativeManifest
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown }
    if (typeof pkg.version !== 'string') throw new Error('iroh_native_manifest_invalid')
    manifest = validateIrohNativeManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown, pkg.version)
  } catch (error) {
    if (error instanceof Error && error.message === 'iroh_native_manifest_invalid') throw error
    throw new Error('iroh_native_manifest_invalid')
  }
  const expected = manifest.artifacts[target as IrohNativeTarget]
  const path = join(nativeDirectory, IROH_NATIVE_TARGETS[target as IrohNativeTarget])
  const before = await lstat(path).catch(() => { throw new Error('iroh_native_missing') })
  if (!before.isFile() || before.isSymbolicLink() || before.size !== expected.bytes) throw new Error('iroh_native_file_invalid')
  const file = await open(path, 'r').catch(() => { throw new Error('iroh_native_missing') })
  try {
    const opened = await file.stat()
    if (!opened.isFile() || opened.size !== expected.bytes || opened.ino !== before.ino || opened.dev !== before.dev) {
      throw new Error('iroh_native_file_invalid')
    }
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      const buffer = chunk as Buffer
      bytes += buffer.length
      if (bytes > expected.bytes) throw new Error('iroh_native_file_changed')
      hash.update(buffer)
    }
    if (hash.digest('hex') !== expected.sha256) throw new Error('iroh_native_hash_mismatch')
    const after = await lstat(path)
    if (after.isSymbolicLink() || after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs) throw new Error('iroh_native_file_changed')
  } finally { await file.close() }
  if (process.platform !== 'win32' && platform !== 'win32' && (before.mode & 0o111) === 0) {
    throw new Error('iroh_native_not_executable')
  }
  return path
}
