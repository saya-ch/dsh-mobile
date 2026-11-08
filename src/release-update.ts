import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { DSH_MOBILE_VERSION } from './version.js'

const PACKAGE_NAME = 'dsh-mobile'
const NPM_LATEST_URL = 'https://registry.npmjs.org/dsh-mobile/latest'
const ANDROID_RELEASE_DESCRIPTOR_URL = 'https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/apps/mobile/release.json'
const GITHUB_RELEASE_API = 'https://api.github.com/repos/saya-ch/dsh-mobile/releases/tags/'
const GITHUB_RELEASES_URL = 'https://github.com/saya-ch/dsh-mobile/releases'
const RELEASE_NOTES_MAX_CHARS = 4000
const STATUS_CACHE_MS = 10 * 60_000
const REQUEST_TIMEOUT_MS = 8_000
const UPDATE_TIMEOUT_MS = 120_000
const UPDATE_TERMINATION_GRACE_MS = 1_500
const bundledAndroidRelease: unknown = createRequire(import.meta.url)('../apps/mobile/release.json')

const NUMERIC_VERSION_IDENTIFIER = '(?:0|[1-9]\\d*)'
const WILDCARD_VERSION_IDENTIFIER = '(?:[xX*])'
const PARTIAL_VERSION = `(?:${WILDCARD_VERSION_IDENTIFIER}|${NUMERIC_VERSION_IDENTIFIER}(?:\\.(?:${WILDCARD_VERSION_IDENTIFIER}|${NUMERIC_VERSION_IDENTIFIER}(?:\\.(?:${WILDCARD_VERSION_IDENTIFIER}|${NUMERIC_VERSION_IDENTIFIER}))?))?)`
const FULL_VERSION = `${NUMERIC_VERSION_IDENTIFIER}\\.${NUMERIC_VERSION_IDENTIFIER}\\.${NUMERIC_VERSION_IDENTIFIER}(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?`
const RANGE_VERSION = `(?:${FULL_VERSION}|${PARTIAL_VERSION})`
const COMPARATOR = new RegExp(`^(?:<=|>=|<|>|=|~|\\^)?${RANGE_VERSION}$`, 'u')
const HYPHEN_RANGE = new RegExp(`^${RANGE_VERSION} +[-] +${RANGE_VERSION}$`, 'u')
const DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u

interface Semver {
  readonly core: readonly [number, number, number]
  readonly prerelease: readonly (number | string)[]
}

/** Release information safe to return through the loopback administration API. */
export interface PluginReleaseStatus {
  readonly installedVersion: string
  readonly latestVersion?: string
  readonly updateAvailable: boolean
  readonly updateSupported: boolean
  readonly androidVersion?: string
  readonly androidDownloadUrl: string
  /** Actual byte sizes of the published APKs, resolved from the GitHub release assets. */
  readonly androidCompatBytes?: number
  readonly androidIrohBytes?: number
  /** Trimmed GitHub release notes for the selected npm version. */
  readonly releaseNotes?: string
}

/** Result returned after the profile package has been replaced successfully. */
export interface PluginUpdateResult {
  readonly installedVersion: string
  readonly restartRequired: true
}

interface PluginReleaseManagerOptions {
  readonly profileDirectory: string | undefined
  readonly installedVersion?: string
  readonly fetch?: typeof globalThis.fetch
  readonly runUpdate?: (profileDirectory: string, version: string) => Promise<void>
  readonly readInstalledVersion?: (profileDirectory: string) => Promise<string | undefined>
  readonly now?: () => number
  readonly updateProcess?: PnpmUpdateRuntime
}

interface UpdateProcessExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

interface UpdateProcessRequest {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly detached: boolean
  readonly platform: NodeJS.Platform
  readonly shell: false
}

interface ManagedUpdateProcess {
  readonly completion: Promise<UpdateProcessExit>
  readonly stderr?: NodeJS.ReadableStream
  terminateTree(): Promise<void>
}

interface UpdateDeadline {
  readonly promise: Promise<void>
  cancel(): void
}

interface PnpmUpdateRuntime {
  readonly platform?: NodeJS.Platform
  readonly timeoutMs?: number
  readonly windowsCommandInterpreter?: string
  readonly start?: (request: UpdateProcessRequest) => ManagedUpdateProcess
  readonly deadline?: (timeoutMs: number) => UpdateDeadline
}

function parseSemver(value: string): Semver | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(value)
  if (match === null) return undefined
  const core = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  if (core.some(part => !Number.isSafeInteger(part))) return undefined
  const prerelease = match[4] === undefined
    ? []
    : match[4].split('.').map((part): number | string => /^\d+$/u.test(part) ? Number(part) : part)
  if (prerelease.some(part => typeof part === 'number' && !Number.isSafeInteger(part))) return undefined
  return Object.freeze({ core, prerelease: Object.freeze(prerelease) })
}

/** Compare two strict SemVer strings, including prerelease precedence. */
export function comparePluginVersions(left: string, right: string): number | undefined {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (a === undefined || b === undefined) return undefined
  for (let index = 0; index < a.core.length; index += 1) {
    const difference = a.core[index]! - b.core[index]!
    if (difference !== 0) return Math.sign(difference)
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    if (typeof leftPart === 'number' && typeof rightPart === 'number') return Math.sign(leftPart - rightPart)
    if (typeof leftPart === 'number') return -1
    if (typeof rightPart === 'number') return 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function isComparatorSet(value: string): boolean {
  if (HYPHEN_RANGE.test(value)) return true
  const normalized = value.replace(/(<=|>=|<|>|=|~|\^) +/gu, '$1')
  const comparators = normalized.split(/ +/u)
  return comparators.length > 0 && comparators.every(comparator => COMPARATOR.test(comparator))
}

function isNpmVersionRange(value: string): boolean {
  if (!/^[0-9xX*<>=~^|.+\- ]+$/u.test(value)) return false
  const alternatives = value.split(/ *\|\| */u)
  return alternatives.length > 0 && alternatives.every(alternative => alternative !== '' && isComparatorSet(alternative))
}

/** Return whether pnpm may safely replace this profile dependency from an npm version, range, or tag. */
export function isRegistryPluginSpec(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || value === '' || /[\u0000-\u001f\u007f]/u.test(value)) return false
  if (/\.(?:tgz|tar(?:\.gz)?)$/iu.test(value)) return false
  return parseSemver(value) !== undefined || isNpmVersionRange(value) || DIST_TAG.test(value)
}

/** Resolve the DSH profile named by the current launcher arguments. */
export function launchedProfileName(argv: readonly string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') {
      const candidate = argv[index + 1]
      if (candidate !== undefined && /^[\w.-]+$/u.test(candidate)) return candidate
    }
    const match = /^--profile=([\w.-]+)$/u.exec(argv[index] ?? '')
    if (match?.[1] !== undefined) return match[1]
  }
  return 'web'
}

interface DesktopProfiles {
  readonly current?: { readonly dir?: string }
}

function profileInstallingModule(dshHome: string, moduleUrl: string): string | undefined {
  let directory: string
  try {
    directory = dirname(fileURLToPath(moduleUrl))
  } catch {
    return undefined
  }
  const profilesRoot = resolve(dshHome, 'profiles')
  for (let depth = 0; depth < 16; depth += 1) {
    const candidate = resolve(directory)
    const fromProfiles = relative(profilesRoot, candidate)
    if (fromProfiles !== '' && !fromProfiles.startsWith('..') && !isAbsolute(fromProfiles)) {
      try {
        const manifest = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')) as {
          readonly dependencies?: Readonly<Record<string, unknown>>
          readonly dsh?: { readonly profile?: unknown }
        }
        if (typeof manifest.dependencies?.[PACKAGE_NAME] === 'string'
          && typeof manifest.dsh?.profile === 'object' && manifest.dsh.profile !== null) {
          return candidate
        }
      } catch { /* Keep walking toward the profile root. */ }
    }
    const parent = dirname(candidate)
    if (parent === candidate) break
    directory = parent
  }
  return undefined
}

/** Resolve the launcher-owned Desktop profile, or the CLI profile outside Desktop. */
export function releaseProfileDirectory(
  ctx: Pick<Context, 'get'>,
  dshHome: string,
  argv: readonly string[],
  moduleUrl: string = import.meta.url,
): string | undefined {
  const desktopProfiles = ctx.get('desktopProfiles') as DesktopProfiles | undefined
  const desktopDirectory = desktopProfiles?.current?.dir
  if (typeof desktopDirectory === 'string' && isAbsolute(desktopDirectory)) return desktopDirectory
  const installedProfile = profileInstallingModule(dshHome, moduleUrl)
  if (installedProfile !== undefined) return installedProfile
  // Desktop selects its profile outside argv; never update an unrelated Web profile.
  if (desktopProfiles !== undefined || ctx.get('desktopRuntime') !== undefined) return undefined
  return join(dshHome, 'profiles', launchedProfileName(argv))
}

async function profileDependencySpec(profileDirectory: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(profileDirectory, 'package.json'), 'utf8')) as {
      readonly dependencies?: Readonly<Record<string, unknown>>
    }
    const value = manifest.dependencies?.[PACKAGE_NAME]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

async function fetchNpmVersion(fetcher: typeof globalThis.fetch): Promise<string | undefined> {
  const response = await fetcher(NPM_LATEST_URL, {
    headers: { accept: 'application/json', 'user-agent': 'dsh-mobile-release-check' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) return undefined
  const payload = await response.json() as { readonly version?: unknown }
  return typeof payload.version === 'string' && parseSemver(payload.version) !== undefined
    ? payload.version
    : undefined
}

interface AndroidRelease {
  readonly version: string
  readonly tag: string
  readonly downloadUrl: string
}

function androidRelease(version: unknown, tag: unknown): AndroidRelease | undefined {
  if (typeof version !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)
    || parseSemver(version) === undefined || (tag !== `v${version}` && tag !== `android-v${version}`)) return undefined
  return Object.freeze({
    version,
    tag: tag as string,
    downloadUrl: `https://github.com/saya-ch/dsh-mobile/releases/download/${tag}/dsh-mobile-android-v${version}.apk`,
  })
}

/** Read the published APK byte sizes from the GitHub release assets (best effort). */
async function fetchAndroidAssetSizes(
  fetcher: typeof globalThis.fetch,
  version: string,
  tag: string,
  signal: AbortSignal,
): Promise<{ readonly compatBytes?: number; readonly irohBytes?: number }> {
  try {
    const response = await fetcher(`${GITHUB_RELEASE_API}${encodeURIComponent(tag)}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-mobile-release-check' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
    })
    if (!response.ok) return {}
    const payload: unknown = await response.json()
    if (payload === null || typeof payload !== 'object' || !('assets' in payload) || !Array.isArray(payload.assets)) return {}
    const assets: unknown[] = payload.assets
    const sizeOf = (name: string): number | undefined => {
      for (const asset of assets) {
        if (asset !== null && typeof asset === 'object' && 'name' in asset && asset.name === name
          && 'size' in asset && typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size > 0) return asset.size
      }
      return undefined
    }
    const compatBytes = sizeOf(`dsh-mobile-android-v${version}.apk`)
    const irohBytes = sizeOf(`dsh-mobile-android-v${version}-iroh.apk`)
    return {
      ...(compatBytes === undefined ? {} : { compatBytes }),
      ...(irohBytes === undefined ? {} : { irohBytes }),
    }
  } catch {
    return {}
  }
}

function androidReleaseDescriptor(payload: unknown): AndroidRelease | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const fields = payload as { readonly version?: unknown; readonly releaseTag?: unknown; readonly versionCode?: unknown }
  return Number.isSafeInteger(fields.versionCode) && Number(fields.versionCode) > 0
    ? androidRelease(fields.version, fields.releaseTag)
    : undefined
}

async function fetchAndroidRelease(fetcher: typeof globalThis.fetch): Promise<AndroidRelease | undefined> {
  const fallback = androidReleaseDescriptor(bundledAndroidRelease)
  try {
    const response = await fetcher(ANDROID_RELEASE_DESCRIPTOR_URL, {
      redirect: 'error',
      headers: { accept: 'application/json', 'user-agent': 'dsh-mobile-release-check' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.ok) {
      const release = androidReleaseDescriptor(await response.json())
      if (release !== undefined) {
        return fallback !== undefined && comparePluginVersions(release.version, fallback.version) === -1 ? fallback : release
      }
    }
  } catch {
    // The package's verified App pointer remains available when the network lookup fails.
  }
  return fallback
}

/** Best-effort body of the selected npm version's GitHub release, trimmed to a bounded size. */
async function fetchReleaseNotes(fetcher: typeof globalThis.fetch, version: string): Promise<string | undefined> {
  const response = await fetcher(`${GITHUB_RELEASE_API}${encodeURIComponent(`v${version}`)}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-mobile-release-check' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) return undefined
  const payload = await response.json() as { readonly body?: unknown }
  if (typeof payload.body !== 'string') return undefined
  const notes = payload.body.trim()
  return notes === '' ? undefined : notes.slice(0, RELEASE_NOTES_MAX_CHARS)
}

async function readProfileInstalledVersion(profileDirectory: string): Promise<string | undefined> {
  try {
    const manifestPath = createRequire(join(profileDirectory, 'package.json')).resolve(`${PACKAGE_NAME}/package.json`)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { readonly version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

function childCompletion(child: ChildProcess): Promise<UpdateProcessExit> {
  return new Promise<UpdateProcessExit>((resolveCompletion, rejectCompletion) => {
    child.once('error', rejectCompletion)
    child.once('close', (code, signal) => { resolveCompletion({ code, signal }) })
  })
}

function createDeadline(timeoutMs: number): UpdateDeadline {
  let timer: NodeJS.Timeout | undefined
  const promise = new Promise<void>(resolveTimeout => {
    timer = setTimeout(resolveTimeout, timeoutMs)
    timer.unref()
  })
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    },
  }
}

async function taskkillProcessTree(pid: number): Promise<void> {
  const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  })
  const result = await childCompletion(killer)
  if (result.code !== 0) throw new Error('plugin_update_tree_termination_failed')
}

async function completionWithin(completion: Promise<UpdateProcessExit>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      completion.then(() => true, () => true),
      new Promise<false>(resolveTimeout => {
        timer = setTimeout(() => { resolveTimeout(false) }, timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function processMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ESRCH'
}

async function terminateProcessTree(child: ChildProcess, completion: Promise<UpdateProcessExit>, platform: NodeJS.Platform): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const pid = child.pid
  if (pid === undefined) {
    child.kill('SIGKILL')
    if (!await completionWithin(completion, UPDATE_TERMINATION_GRACE_MS)) {
      throw new Error('plugin_update_tree_termination_timeout')
    }
    return
  }
  if (platform === 'win32') {
    try { await taskkillProcessTree(pid) } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (!await completionWithin(completion, UPDATE_TERMINATION_GRACE_MS)) {
        throw new AggregateError([error, new Error('plugin_update_tree_termination_timeout')], 'plugin update tree termination failed')
      }
      throw error
    }
    if (!await completionWithin(completion, UPDATE_TERMINATION_GRACE_MS)) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (!await completionWithin(completion, UPDATE_TERMINATION_GRACE_MS)) {
        throw new Error('plugin_update_tree_termination_timeout')
      }
    }
    return
  }
  try { process.kill(-pid, 'SIGTERM') } catch (error) {
    if (!processMissing(error)) throw error
    if (!await completionWithin(completion, UPDATE_TERMINATION_GRACE_MS)) {
      throw new Error('plugin_update_tree_termination_timeout')
    }
    return
  }
  if (await completionWithin(completion, UPDATE_TERMINATION_GRACE_MS)) return
  try { process.kill(-pid, 'SIGKILL') } catch (error) {
    if (!processMissing(error)) throw error
  }
  if (!await completionWithin(completion, UPDATE_TERMINATION_GRACE_MS)) {
    throw new Error('plugin_update_tree_termination_timeout')
  }
}

function startUpdateProcess(request: UpdateProcessRequest): ManagedUpdateProcess {
  const child = spawn(request.command, [...request.args], {
    cwd: request.cwd,
    detached: request.detached,
    shell: request.shell,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  const completion = childCompletion(child)
  return {
    completion,
    ...(child.stderr === null ? {} : { stderr: child.stderr }),
    terminateTree: async () => terminateProcessTree(child, completion, request.platform),
  }
}

function updateFailure(cause?: unknown): Error {
  return cause === undefined ? new Error('plugin_update_failed') : new Error('plugin_update_failed', { cause })
}

async function runPnpmUpdate(profileDirectory: string, version: string, runtime: PnpmUpdateRuntime = {}): Promise<void> {
  if (parseSemver(version) === undefined) throw new Error('plugin_update_unavailable')
  const platform = runtime.platform ?? process.platform
  const packageSpec = `${PACKAGE_NAME}@${version}`
  const managed = (runtime.start ?? startUpdateProcess)({
    command: platform === 'win32'
      ? (runtime.windowsCommandInterpreter ?? process.env.ComSpec ?? 'cmd.exe')
      : 'pnpm',
    args: platform === 'win32'
      ? ['/d', '/s', '/c', 'pnpm.cmd', 'add', packageSpec]
      : ['add', packageSpec],
    cwd: profileDirectory,
    detached: platform !== 'win32',
    platform,
    shell: false,
  })
  let diagnostics = ''
  managed.stderr?.on('data', chunk => {
    if (diagnostics.length < 4096) diagnostics += Buffer.from(chunk).toString('utf8').slice(0, 4096 - diagnostics.length)
  })
  const completion = managed.completion.then(
    result => ({ kind: 'exit' as const, result }),
    error => ({ kind: 'error' as const, error }),
  )
  const deadline = (runtime.deadline ?? createDeadline)(runtime.timeoutMs ?? UPDATE_TIMEOUT_MS)
  const first = await Promise.race([
    completion,
    deadline.promise.then(() => ({ kind: 'timeout' as const })),
  ])
  deadline.cancel()
  if (first.kind === 'error') throw updateFailure(first.error)
  if (first.kind === 'exit') {
    if (first.result.code === 0) return
    const detail = diagnostics.trim() || `pnpm exited with ${first.result.signal ?? String(first.result.code)}`
    throw updateFailure(new Error(detail))
  }
  let terminationError: unknown
  try { await managed.terminateTree() } catch (error) { terminationError = error }
  if (terminationError !== undefined) throw updateFailure(terminationError)
  const stopped = await completion
  if (stopped.kind === 'error') throw updateFailure(stopped.error)
  throw updateFailure(new Error('plugin update timed out'))
}

/** Cached npm/GitHub release lookup and guarded profile-local package update. */
export class PluginReleaseManager {
  private readonly profileDirectory: string | undefined
  private readonly installedVersion: string
  private readonly fetcher: typeof globalThis.fetch
  private readonly runner: (profileDirectory: string, version: string) => Promise<void>
  private readonly installedVersionReader: (profileDirectory: string) => Promise<string | undefined>
  private readonly now: () => number
  private cache: { readonly expiresAt: number; readonly status: PluginReleaseStatus } | undefined
  private activeUpdate: Promise<PluginUpdateResult> | undefined
  private readonly assetLookupOwner = new AbortController()
  private assetLookup: Promise<void> | undefined
  private assetSizes: { readonly downloadUrl: string; readonly compatBytes?: number; readonly irohBytes?: number } | undefined

  constructor(options: PluginReleaseManagerOptions) {
    this.profileDirectory = options.profileDirectory
    this.installedVersion = options.installedVersion ?? DSH_MOBILE_VERSION
    this.fetcher = options.fetch ?? globalThis.fetch
    this.runner = options.runUpdate ?? ((profileDirectory, version) => runPnpmUpdate(profileDirectory, version, options.updateProcess))
    this.installedVersionReader = options.readInstalledVersion ?? readProfileInstalledVersion
    this.now = options.now ?? Date.now
  }

  /** Read cached release metadata and suppress external lookup failures. */
  async status(force = false): Promise<PluginReleaseStatus> {
    if (!force && this.cache !== undefined && this.cache.expiresAt > this.now()) return this.cache.status
    const dependencySpec = this.profileDirectory === undefined ? undefined : await profileDependencySpec(this.profileDirectory)
    const updateSupported = isRegistryPluginSpec(dependencySpec)
    const npmVersion = fetchNpmVersion(this.fetcher)
    const [npmResult, androidResult, notesResult] = await Promise.allSettled([
      npmVersion,
      fetchAndroidRelease(this.fetcher).then(android => {
        if (android !== undefined) this.startAssetLookup(android)
        return android
      }),
      npmVersion.then(version => version === undefined ? undefined : fetchReleaseNotes(this.fetcher, version)),
    ])
    const latestVersion = npmResult.status === 'fulfilled' ? npmResult.value : undefined
    const android = androidResult.status === 'fulfilled' ? androidResult.value : undefined
    const releaseNotes = notesResult.status === 'fulfilled' ? notesResult.value : undefined
    const androidSizes = this.assetSizes?.downloadUrl === android?.downloadUrl ? this.assetSizes : undefined
    const comparison = latestVersion === undefined
      ? undefined
      : comparePluginVersions(latestVersion, this.installedVersion)
    const status: PluginReleaseStatus = Object.freeze({
      installedVersion: this.installedVersion,
      ...(latestVersion === undefined ? {} : { latestVersion }),
      updateAvailable: updateSupported && comparison === 1,
      updateSupported,
      ...(android === undefined ? {} : { androidVersion: android.version }),
      androidDownloadUrl: android?.downloadUrl ?? GITHUB_RELEASES_URL,
      ...(androidSizes?.compatBytes === undefined ? {} : { androidCompatBytes: androidSizes.compatBytes }),
      ...(androidSizes?.irohBytes === undefined ? {} : { androidIrohBytes: androidSizes.irohBytes }),
      ...(releaseNotes === undefined ? {} : { releaseNotes }),
    })
    this.cache = { expiresAt: this.now() + STATUS_CACHE_MS, status }
    return status
  }

  /** Cancel and drain the optional APK-size lookup without delaying provider cleanup. */
  async dispose(): Promise<void> {
    this.assetLookupOwner.abort()
    await this.assetLookup
  }

  private startAssetLookup(android: AndroidRelease): void {
    if (this.assetLookupOwner.signal.aborted || this.assetLookup !== undefined || this.assetSizes?.downloadUrl === android.downloadUrl) return
    this.assetLookup = fetchAndroidAssetSizes(this.fetcher, android.version, android.tag, this.assetLookupOwner.signal)
      .then(sizes => {
        if (this.assetLookupOwner.signal.aborted) return
        this.assetSizes = { downloadUrl: android.downloadUrl, ...sizes }
        if (this.cache?.status.androidDownloadUrl === android.downloadUrl) {
          this.cache = { ...this.cache, status: Object.freeze({ ...this.cache.status,
            ...(sizes.compatBytes === undefined ? {} : { androidCompatBytes: sizes.compatBytes }),
            ...(sizes.irohBytes === undefined ? {} : { androidIrohBytes: sizes.irohBytes }),
          }) }
        }
      }).finally(() => { this.assetLookup = undefined })
  }

  /** Install the latest npm release into the active profile, then require a DSH restart. */
  async update(): Promise<PluginUpdateResult> {
    if (this.activeUpdate !== undefined) return this.activeUpdate
    this.activeUpdate = this.updateOnce()
    try { return await this.activeUpdate }
    finally { this.activeUpdate = undefined }
  }

  private async updateOnce(): Promise<PluginUpdateResult> {
    const profileDirectory = this.profileDirectory
    if (profileDirectory === undefined) throw new Error('plugin_update_unsupported')
    const status = await this.status(true)
    if (!status.updateSupported) throw new Error('plugin_update_unsupported')
    if (!status.updateAvailable || status.latestVersion === undefined) throw new Error('plugin_update_unavailable')
    await this.runner(profileDirectory, status.latestVersion)
    const installed = await this.installedVersionReader(profileDirectory)
    if (installed !== status.latestVersion) throw new Error('plugin_update_failed')
    this.cache = undefined
    return Object.freeze({ installedVersion: installed, restartRequired: true })
  }
}
