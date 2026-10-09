import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, mkdir, opendir, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { finished, type Readable } from 'node:stream'
import { defaultExtensionWorkerModule, ExtensionWorkerBudget, ExtensionWorkerHost, type WorkerParentLogger } from './extension-worker.js'
import { resolveHostExecution, type HostExecutionConfig, type ResolvedHostExecutionConfig } from './extension-worker-config.js'

/** Maximum sizes enforced at the local-extension filesystem boundary. */
export const EXTENSION_LIMITS = Object.freeze({
  manifest: 64 * 1024,
  script: 1024 * 1024,
  css: 512 * 1024,
  asset: 8 * 1024 * 1024,
  assetFiles: 256,
  assetBytes: 32 * 1024 * 1024,
  assetDepth: 8,
})

/** A misbehaving host activation must not wedge the local watcher forever. */
const HOST_ACTIVATION_TIMEOUT_MS = 5_000

/** The previous Host outlives the hidden-page refresh interval and one timed refresh. */
const RETIRED_GENERATION_TTL_MS = 10 * 60_000

/** Extension teardown is advisory and must never stop watcher progress. */
const HOST_TEARDOWN_TIMEOUT_MS = 2_000

/** Default budget for one extension action or route-handler execution. */
export const HOST_OPERATION_TIMEOUT_MS = 30_000

/** Upper bound for a per-operation `timeoutMs` override. */
export const HOST_OPERATION_TIMEOUT_MAX_MS = 300_000

async function withActivationTimeout<T>(promise: Promise<T>, id: string, signal: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new MobileExtensionError('host_load_timeout', `extension ${id} activation timed out`, 500)), HOST_ACTIVATION_TIMEOUT_MS)
        }),
      new Promise<never>((_, reject) => {
        const abort = (): void => { reject(new MobileExtensionError('host_activation_closed', `extension ${id} activation is closed`, 409)) }
        if (signal.aborted) abort()
        else { onAbort = abort; signal.addEventListener('abort', abort, { once: true }) }
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** A controlled business failure returned by an extension action or route. */
export class MobileExtensionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message)
    this.name = 'MobileExtensionError'
  }
}

/** One host-side action exposed by an extension. */
type CallableActionInput = (value?: never, options?: never) => unknown

export interface MobileHostAction {
  /** A callable Schemastery schema or an adapter exposing parse(). */
  readonly input?: CallableActionInput | { parse(value: unknown): unknown }
  /** Optional per-action budget override; validated and snapshotted at registration. */
  readonly timeoutMs?: number
  readonly run: (context: MobileActionContext, input: unknown) => unknown | Promise<unknown>
}

/** Context supplied to a host action. */
export interface MobileActionContext {
  readonly signal: AbortSignal
  readonly deviceId: string
}

/** Safe request values supplied to a host route. */
export interface MobileRouteRequest {
  readonly method: string
  readonly pathname: string
  readonly query: Readonly<URLSearchParams>
  readonly headers: Readonly<Record<string, string>>
  readonly body: Uint8Array
  readonly signal: AbortSignal
  readonly deviceId: string
}

/** Values an extension route may return; status is a final HTTP code from 200 through 599. */
export interface MobileRouteResponse {
  readonly status?: number
  readonly contentType?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body: string | Uint8Array | Readable
}

/** One host-side route exposed by an extension. */
export interface MobileHostRoute {
  readonly method: string
  readonly path: string
  readonly kind?: 'exact' | 'prefix'
  /** Optional per-route handler budget override; validated and snapshotted at registration. */
  readonly timeoutMs?: number
  readonly handle: (request: MobileRouteRequest) => MobileRouteResponse | Promise<MobileRouteResponse>
}

/** Metadata shared by local and npm-provided extensions. */
export interface MobileExtensionManifest {
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description?: string
}

/** Definition registered by a normal Cordis plugin. */
export interface MobileExtensionDefinition extends MobileExtensionManifest {
  readonly actions?: Readonly<Record<string, MobileHostAction>>
  readonly routes?: readonly MobileHostRoute[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mobileAccess: MobileAccessService
  }
}

/** A local extension manifest read from extension.json. */
export interface LocalExtensionManifest extends MobileExtensionManifest {}

/** Public snapshot sent to the mobile browser. */
export interface MobileExtensionClientEntry extends MobileExtensionManifest {
  readonly generation?: string
  readonly scriptUrl?: string
  readonly styleUrl?: string
  readonly assetsUrl?: string
}

interface LocalAssetSnapshot {
  readonly body: Buffer
  readonly digest: string
  readonly name: string
}

/** Small status summary used by the desktop mobile-access card. */
export interface MobileExtensionStatus {
  readonly loaded: number
  readonly failed: number
}

interface ActiveLocalExtension {
  readonly manifest: LocalExtensionManifest
  readonly directory: string
  readonly scriptBody?: Buffer
  readonly styleBody?: Buffer
  readonly assets: ReadonlyMap<string, LocalAssetSnapshot>
  readonly host: MobileExtensionDefinition
  readonly controller: AbortController
  readonly cleanups: readonly (() => void | Promise<void>)[]
  readonly digest: string
  readonly worker?: ExtensionWorkerHost
}

interface RegisteredExtension {
  readonly definition: MobileExtensionDefinition
  readonly dispose: () => void
}

interface RetiredLocalExtension {
  readonly active: ActiveLocalExtension
  readonly timer: NodeJS.Timeout
}

/** Local execution options; the packaged worker entry is used unless a test supplies an override. */
export interface LocalExecutionOptions {
  readonly hostExecution?: HostExecutionConfig & { readonly workerModule?: string }
  readonly workerBudget?: ExtensionWorkerBudget
}

type HostApi = {
  readonly manifest: LocalExtensionManifest
  readonly context: Context
  readonly schema: typeof z
  readonly signal: AbortSignal
  action(name: string, spec: MobileHostAction): void
  route(spec: MobileHostRoute): void
  effect(setup: () => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>): void
}

/** Worker-host API: logger-only context, with no Cordis services or registrations crossing threads. */
export interface MobileWorkerHostApi {
  readonly manifest: LocalExtensionManifest
  readonly context: { readonly logger: WorkerParentLogger }
  readonly schema: typeof z
  readonly signal: AbortSignal
  action(name: string, spec: MobileHostAction): void
  route(spec: MobileHostRoute): void
  effect(setup: () => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>): void
}

type LocalHostModule = { readonly default?: (api: HostApi) => void | Promise<void> }

/** Validate user-facing extension text without allowing control characters. */
function text(value: unknown, field: string, maximum: number, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || (required && value.length === 0) || value.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new MobileExtensionError('invalid_manifest', `${field} is invalid`)
  return value
}

/** Validate a stable extension id. */
export function assertExtensionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(value)) {
    throw new MobileExtensionError('invalid_manifest', 'extension id is invalid')
  }
  return value
}

/** Validate a manifest from JSON or a plugin definition. */
export function parseExtensionManifest(value: unknown): LocalExtensionManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MobileExtensionError('invalid_manifest', 'extension.json must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1) throw new MobileExtensionError('invalid_manifest', 'unsupported extension schema')
  const id = assertExtensionId(record.id)
  const name = text(record.name, 'name', 120, true) as string
  const version = text(record.version, 'version', 64, true) as string
  const description = text(record.description, 'description', 500, false)
  for (const key of Reflect.ownKeys(record)) {
    if (!['schemaVersion', 'id', 'name', 'version', 'description'].includes(String(key))) {
      throw new MobileExtensionError('invalid_manifest', 'extension.json has unknown fields')
    }
  }
  return Object.freeze({ schemaVersion: 1, id, name, version, ...(description === undefined ? {} : { description }) })
}

function normalizeRelativePath(value: string, field: string): string {
  if (value.length === 0 || value.includes('\0') || isAbsolute(value)) throw new MobileExtensionError('invalid_extension_path', `${field} is invalid`)
  const normalized = value.replaceAll('\\', '/')
  if (normalized.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new MobileExtensionError('invalid_extension_path', `${field} escapes extension directory`)
  }
  return normalized
}

async function regularFile(path: string, maximum: number, field: string): Promise<{ readonly path: string; readonly size: number }> {
  let info
  try { info = await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new MobileExtensionError('invalid_extension', `${field} is missing`)
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
    throw new MobileExtensionError('invalid_extension', `${field} must be a regular file within its size limit`)
  }
  return { path, size: info.size }
}

async function containedPath(root: string, relativePath: string, maximum: number, field: string): Promise<{ readonly path: string; readonly size: number }> {
  const normalized = normalizeRelativePath(relativePath, field)
  const target = resolve(root, normalized)
  const rootReal = await realpath(root)
  const targetReal = await realpath(target)
  const relation = relative(rootReal, targetReal)
  if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) throw new MobileExtensionError('invalid_extension_path', `${field} escapes extension directory`)
  return regularFile(targetReal, maximum, field)
}

async function optionalFile(root: string, name: string, maximum: number, field: string): Promise<string | undefined> {
  try {
    return (await containedPath(root, name, maximum, field)).path
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    if (error instanceof MobileExtensionError && error.message.includes('is missing')) return undefined
    throw error
  }
}

async function optionalBytes(root: string, name: string, maximum: number, field: string): Promise<Buffer | undefined> {
  const path = await optionalFile(root, name, maximum, field)
  return path === undefined ? undefined : readFile(path)
}

function assertRealPathWithin(rootReal: string, targetReal: string, field: string): void {
  const relation = relative(rootReal, targetReal)
  if (relation === '' || relation.startsWith('..') || isAbsolute(relation)) {
    throw new MobileExtensionError('invalid_extension_path', `${field} escapes extension directory`)
  }
}

async function realExtensionRoot(directory: string): Promise<string> {
  const root = resolve(directory)
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new MobileExtensionError('invalid_extension', 'extension directory must be real')
  return realpath(root)
}

async function assetSnapshot(extensionRootReal: string): Promise<ReadonlyMap<string, LocalAssetSnapshot>> {
  const assetsPath = join(extensionRootReal, 'assets')
  let assetsInfo
  try { assetsInfo = await lstat(assetsPath) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  if (!assetsInfo.isDirectory() || assetsInfo.isSymbolicLink()) {
    throw new MobileExtensionError('invalid_extension', 'assets must be a real directory')
  }
  const assetsReal = await realpath(assetsPath)
  assertRealPathWithin(extensionRootReal, assetsReal, 'assets')
  const snapshots = new Map<string, LocalAssetSnapshot>()
  let totalBytes = 0
  const visit = async (directoryReal: string, prefix: string, depth: number): Promise<void> => {
    if (depth > EXTENSION_LIMITS.assetDepth) {
      throw new MobileExtensionError('invalid_extension', 'asset tree exceeds its depth limit')
    }
    assertRealPathWithin(extensionRootReal, directoryReal, 'asset directory')
    const handle = await opendir(directoryReal)
    const entries: Dirent[] = []
    try { for await (const entry of handle) entries.push(entry) }
    finally { await handle.close().catch(() => undefined) }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    for (const entry of entries) {
      const path = join(directoryReal, entry.name)
      const info = await lstat(path)
      if (info.isSymbolicLink()) throw new MobileExtensionError('invalid_extension_path', 'asset escapes extension directory')
      const targetReal = await realpath(path)
      assertRealPathWithin(extensionRootReal, targetReal, 'asset')
      const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (info.isDirectory()) {
        await visit(targetReal, key, depth + 1)
        continue
      }
      if (!info.isFile() || info.size > EXTENSION_LIMITS.asset) {
        throw new MobileExtensionError('invalid_extension', 'asset must be a regular file within its size limit')
      }
      const body = await readFile(targetReal)
      totalBytes += body.byteLength
      if (snapshots.size >= EXTENSION_LIMITS.assetFiles || totalBytes > EXTENSION_LIMITS.assetBytes) {
        throw new MobileExtensionError('invalid_extension', 'asset tree exceeds its aggregate limit')
      }
      snapshots.set(key, Object.freeze({ body, digest: createHash('sha256').update(body).digest('hex'), name: entry.name }))
    }
  }
  await visit(assetsReal, '', 0)
  return snapshots
}

interface LocalExtensionFingerprint {
  readonly manifest: LocalExtensionManifest
  readonly digest: string
  readonly scriptBody?: Buffer
  readonly styleBody?: Buffer
  readonly assets: ReadonlyMap<string, LocalAssetSnapshot>
}

async function extensionFingerprint(directory: string): Promise<LocalExtensionFingerprint> {
  const root = await realExtensionRoot(directory)
  const manifestFile = await regularFile(join(root, 'extension.json'), EXTENSION_LIMITS.manifest, 'extension.json')
  const manifestBody = await readFile(manifestFile.path)
  const manifest = parseExtensionManifest(JSON.parse(manifestBody.toString('utf8')) as unknown)
  if (manifest.id !== basename(root)) throw new MobileExtensionError('invalid_manifest', 'extension id must match its directory name')
  const [host, script, style, assets] = await Promise.all([
    optionalBytes(root, 'host.mjs', EXTENSION_LIMITS.script, 'host.mjs'),
    optionalBytes(root, 'mobile.js', EXTENSION_LIMITS.script, 'mobile.js'),
    optionalBytes(root, 'mobile.css', EXTENSION_LIMITS.css, 'mobile.css'),
    assetSnapshot(root),
  ])
  const digest = createHash('sha256').update(`manifest:${manifestBody.byteLength}:`).update(createHash('sha256').update(manifestBody).digest())
  for (const [name, body] of [['host', host], ['script', script], ['style', style]] as const) {
    digest.update(`\0${name}:${body?.byteLength ?? -1}:`)
    if (body !== undefined) digest.update(createHash('sha256').update(body).digest())
  }
  for (const [name, asset] of assets) {
    digest.update(`\0asset:${Buffer.byteLength(name)}:${name}:${asset.body.byteLength}:${asset.digest}`)
  }
  return {
    manifest,
    digest: digest.digest('hex'),
    assets,
    ...(script === undefined ? {} : { scriptBody: script }),
    ...(style === undefined ? {} : { styleBody: style }),
  }
}

function routeKey(route: MobileHostRoute): string {
  const method = route.method.toUpperCase()
  const path = normalizeRoutePath(route.path)
  return `${method} ${route.kind ?? 'exact'} ${path}`
}

function normalizeRoutePath(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256
    || value.includes('?') || value.includes('#') || value.includes('\\') || value.includes('\0')
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new MobileExtensionError('invalid_route', 'extension route path is invalid')
  const normalizedInput = value.startsWith('/') ? value : `/${value}`
  const parts = normalizedInput.split('/')
  if (parts.some(part => part === '..' || part === '.')) throw new MobileExtensionError('invalid_route', 'extension route path is invalid')
  return normalizedInput === '/' ? '/' : normalizedInput.replace(/\/+$/u, '')
}

/** Validate and snapshot an optional per-operation timeout override. */
function operationTimeout(value: unknown, code: 'invalid_action' | 'invalid_route'): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > HOST_OPERATION_TIMEOUT_MAX_MS) {
    throw new MobileExtensionError(code, 'operation timeoutMs is invalid')
  }
  return value
}

function validateDefinition(definition: MobileExtensionDefinition): MobileExtensionDefinition {
  const manifest = parseExtensionManifest({
    schemaVersion: definition.schemaVersion,
    id: definition.id,
    name: definition.name,
    version: definition.version,
    ...(definition.description === undefined ? {} : { description: definition.description }),
  })
  const actionNames = new Set<string>()
  const actions: Record<string, MobileHostAction> = {}
  for (const [name, action] of Object.entries(definition.actions ?? {})) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(name) || action === null || typeof action !== 'object' || typeof action.run !== 'function' || actionNames.has(name)) {
      throw new MobileExtensionError('invalid_action', `invalid action ${name}`)
    }
    actionNames.add(name)
    const actionTimeout = operationTimeout(action.timeoutMs, 'invalid_action')
    const actionInput = action.input
    actions[name] = Object.freeze({
      ...(actionInput === undefined ? {} : { input: actionInput }),
      run: action.run.bind(action),
      ...(actionTimeout === undefined ? {} : { timeoutMs: actionTimeout }),
    })
  }
  const routeNames = new Set<string>()
  const routes = (definition.routes ?? []).map(route => {
    if (route === null || typeof route !== 'object' || typeof route.handle !== 'function') throw new MobileExtensionError('invalid_route', 'invalid extension route')
    const method = route.method.toUpperCase()
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new MobileExtensionError('invalid_route', 'unsupported extension route method')
    const routeTimeout = operationTimeout(route.timeoutMs, 'invalid_route')
    const normalized: MobileHostRoute = Object.freeze({
      method, path: normalizeRoutePath(route.path), ...(route.kind === undefined ? {} : { kind: route.kind }),
      handle: route.handle.bind(route),
      ...(routeTimeout === undefined ? {} : { timeoutMs: routeTimeout }),
    })
    const key = routeKey(normalized)
    if (routeNames.has(key)) throw new MobileExtensionError('duplicate_route', `duplicate route ${key}`)
    routeNames.add(key)
    return normalized
  })
  return Object.freeze({ ...manifest, ...(definition.actions === undefined ? {} : { actions: Object.freeze(actions) }), ...(routes.length === 0 ? {} : { routes: Object.freeze(routes) }) })
}

interface CombinedSignalLifetime {
  readonly signal: AbortSignal
  readonly cleanup: () => void
}

function combineSignalLifetime(first: AbortSignal, second: AbortSignal): CombinedSignalLifetime {
  if (first.aborted || second.aborted) {
    const aborted = new AbortController()
    aborted.abort(first.aborted ? first.reason : second.reason)
    return { signal: aborted.signal, cleanup: () => undefined }
  }
  const controller = new AbortController()
  const cleanup = (): void => {
    first.removeEventListener('abort', abortFirst)
    second.removeEventListener('abort', abortSecond)
  }
  const abortFirst = (): void => { cleanup(); controller.abort(first.reason) }
  const abortSecond = (): void => { cleanup(); controller.abort(second.reason) }
  first.addEventListener('abort', abortFirst, { once: true })
  second.addEventListener('abort', abortSecond, { once: true })
  return { signal: controller.signal, cleanup }
}

/** Validate and normalize an action input through either supported schema form. */
function parseActionInput(schema: MobileHostAction['input'], input: unknown): unknown {
  if (schema === undefined) return input
  if (typeof schema === 'function') return (schema as (value: unknown) => unknown)(input)
  return schema.parse(input) ?? input
}

/** Combine two abort lifetimes without relying on AbortSignal.any in older WebViews. */
export function combineSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  return combineSignalLifetime(first, second).signal
}

/** Host registry and service consumed by both npm plugins and local extensions. */
export class MobileAccessService extends Service {
  private readonly registered = new Map<string, RegisteredExtension>()
  private readonly local = new Map<string, ActiveLocalExtension>()
  private readonly retired = new Map<string, RetiredLocalExtension>()
  private readonly failures = new Map<string, string>()
  /** Extensions with caller-detached, still-unresolved operations. */
  private readonly abandoned = new Map<string, number>()
  private readonly contentListeners = new Set<() => void>()
  private contentHash = createHash('sha256').update('').digest('hex')
  private localRoot: string | undefined
  private localContext: Context | undefined
  private localTimer: NodeJS.Timeout | undefined
  private localRefreshing: Promise<void> | undefined
  private localRefreshAbort: AbortController | undefined
  private localLifecycle = 0
  private localClosed = true
  private localExecution: LocalExecutionOptions | undefined
  private localExecutionKey: string | undefined
  private workerBudget: ExtensionWorkerBudget | undefined
  private readonly disposal = new Set<Promise<void>>()
  private readonly recoveries = new Map<string, Promise<void>>()

  constructor(ctx: Context) { super(ctx, 'mobileAccess') }

  /** Register a normal Cordis extension and return an idempotent disposer. */
  registerExtension(definition: MobileExtensionDefinition): () => void {
    const validated = validateDefinition(definition)
    if (this.registered.has(validated.id) || this.local.has(validated.id)) throw new Error(`mobile extension id already registered: ${validated.id}`)
    const dispose = (): void => {
      const current = this.registered.get(validated.id)
      if (current?.dispose === dispose) {
        this.registered.delete(validated.id)
        this.updateContentHash()
      }
    }
    this.registered.set(validated.id, { definition: validated, dispose })
    this.updateContentHash()
    return dispose
  }

  /** Aggregate digest covering every registered and active local extension. */
  contentDigest(): string {
    return this.contentHash
  }

  /** Subscribe to committed extension generation changes. */
  onContentChanged(listener: () => void): () => void {
    this.contentListeners.add(listener)
    return () => { this.contentListeners.delete(listener) }
  }

  private updateContentHash(): void {
    const parts = [
      ...[...this.registered.values()].map(entry => entry.definition.id),
      ...[...this.local.values()].map(active => `${active.manifest.id}:${active.digest}`),
    ]
    const next = createHash('sha256').update(parts.sort().join('|')).digest('hex')
    if (next === this.contentHash) return
    this.contentHash = next
    for (const listener of this.contentListeners) {
      try { listener() } catch { /* One observer cannot block a committed generation. */ }
    }
  }

  /** Return the current client-facing manifest, deterministically sorted by id. */
  manifest(): readonly MobileExtensionClientEntry[] {
    const entries = new Map<string, MobileExtensionClientEntry>()
    for (const { definition } of this.registered.values()) entries.set(definition.id, {
      schemaVersion: 1, id: definition.id, name: definition.name, version: definition.version,
      ...(definition.description === undefined ? {} : { description: definition.description }),
    })
    for (const active of this.local.values()) entries.set(active.manifest.id, {
      ...active.manifest,
      generation: active.digest,
      ...(active.scriptBody === undefined ? {} : { scriptUrl: `/mobile-access/extensions/${active.manifest.id}/mobile.js?generation=${active.digest}` }),
      ...(active.styleBody === undefined ? {} : { styleUrl: `/mobile-access/extensions/${active.manifest.id}/mobile.css?generation=${active.digest}` }),
      assetsUrl: `/mobile-access/extensions/${active.manifest.id}/assets/`,
    })
    return [...entries.values()].sort((left, right) => left.id.localeCompare(right.id))
  }

  /** Return loaded and failed local extension counts without exposing host errors. */
  status(): MobileExtensionStatus {
    const unavailable = [...this.local.values()].filter(entry => entry.worker !== undefined && !entry.worker.available()).length
    return Object.freeze({ loaded: this.registered.size + this.local.size - unavailable, failed: this.failures.size + unavailable })
  }

  /** Local Host status does not reveal filesystem paths, credentials or extension errors. */
  hostStatus(): { readonly hosts: readonly { readonly id: string; readonly name: string; readonly mode: 'worker' | 'in-process'; readonly state: 'ready' | 'unavailable'; readonly generation: string }[]; readonly limits: { readonly maxWorkers: number; readonly workers: number } } {
    const limits = resolveHostExecution(this.localExecution?.hostExecution)
    return {
      hosts: [...this.local.values()].map(entry => ({ id: entry.manifest.id, name: entry.manifest.name, mode: entry.worker === undefined ? 'in-process' : 'worker', state: entry.worker === undefined || entry.worker.available() ? 'ready' : 'unavailable', generation: entry.digest })),
      limits: { maxWorkers: limits.maxWorkers, workers: this.workerBudget?.current ?? 0 },
    }
  }

  /** Explicitly replace one unavailable worker without replaying requests or changing its files. */
  recoverExtension(id: string): Promise<void> {
    assertExtensionId(id)
    const existing = this.recoveries.get(id)
    if (existing !== undefined) return existing
    const recovering = (async (): Promise<void> => {
      if (this.localRefreshing !== undefined) await this.localRefreshing
      const previous = this.local.get(id)
      if (this.localClosed || previous?.worker === undefined || this.localContext === undefined) throw new MobileExtensionError('extension_recovery_unavailable', 'local worker recovery is unavailable', 409)
      if (previous.worker.available()) throw new MobileExtensionError('extension_host_running', 'extension worker is already running', 409)
      await previous.worker.terminate('explicit-recovery')
      const lifecycle = this.localLifecycle
      const fingerprint = await extensionFingerprint(previous.directory)
      const fresh = await loadLocalExtension(previous.directory, this.localContext, fingerprint, undefined, this.localExecution)
      try {
        const confirmed = await extensionFingerprint(previous.directory)
        if (this.localClosed || this.localLifecycle !== lifecycle || this.local.get(id) !== previous || confirmed.digest !== fingerprint.digest) throw new MobileExtensionError('extension_changed_during_activation', 'extension changed during recovery', 409)
      } catch (error) { await abortAndDisposeLocal([fresh]); throw error }
      this.local.set(id, fresh)
      this.failures.delete(id)
      this.queueDisposal([previous])
      this.updateContentHash()
    })().finally(() => { if (this.recoveries.get(id) === recovering) this.recoveries.delete(id) })
    this.recoveries.set(id, recovering)
    return recovering
  }

  private queueDisposal(entries: readonly ActiveLocalExtension[]): void {
    const pending = abortAndDisposeLocal(entries).finally(() => { this.disposal.delete(pending) })
    this.disposal.add(pending)
  }

  /** Locate one active extension. */
  extension(id: string, generation?: string): MobileExtensionDefinition | ActiveLocalExtension | undefined {
    if (generation !== undefined) {
      const current = this.local.get(id)
      if (current?.digest === generation) return current
      const previous = this.retired.get(id)?.active
      return previous?.digest === generation ? previous : undefined
    }
    return this.local.get(id) ?? this.registered.get(id)?.definition
  }

  /** Return the active local generation signal for gateway cancellation wiring. */
  signal(id: string, generation?: string): AbortSignal | undefined {
    const extension = this.extension(id, generation)
    return extension !== undefined && 'host' in extension ? extension.controller.signal : undefined
  }

  /** Read a local client entry after validating that it remains inside its directory. */
  async readClientFile(id: string, kind: 'script' | 'style', signal?: AbortSignal, generation?: string): Promise<{ readonly body: Buffer; readonly digest: string }> {
    signal?.throwIfAborted()
    const selected = this.extension(id, generation)
    const active = selected !== undefined && 'host' in selected ? selected : undefined
    if (active === undefined) throw new MobileExtensionError('extension_generation_not_found', 'extension generation not found', 404)
    const snapshot = kind === 'script' ? active.scriptBody : active.styleBody
    if (snapshot === undefined) throw new MobileExtensionError('extension_asset_not_found', 'extension asset not found', 404)
    const body = Buffer.from(snapshot)
    return { body, digest: createHash('sha256').update(body).digest('hex') }
  }

  /** Read a generation-pinned static asset from its validated snapshot. */
  async readAsset(id: string, assetPath: string, signal?: AbortSignal, generation?: string): Promise<{ readonly body: Buffer; readonly digest: string; readonly name: string }> {
    signal?.throwIfAborted()
    const selected = this.extension(id, generation)
    const active = selected !== undefined && 'host' in selected ? selected : undefined
    if (active === undefined) throw new MobileExtensionError('extension_generation_not_found', 'extension generation not found', 404)
    const normalized = normalizeRelativePath(assetPath, 'asset')
    const asset = active.assets.get(normalized)
    if (asset === undefined) throw new MobileExtensionError('extension_asset_not_found', 'extension asset not found', 404)
    return { body: Buffer.from(asset.body), digest: asset.digest, name: asset.name }
  }

  /** Reject new dispatches to an extension whose abandoned work is unresolved. */
  private requireAdmission(id: string): void {
    if ((this.abandoned.get(id) ?? 0) > 0) {
      throw new MobileExtensionError('extension_busy', `extension ${id} has unresolved abandoned work`, 503)
    }
  }

  /** Account for one operation until its underlying work actually settles. */
  private trackOperation<T>(id: string, operation: BoundedOperation<T>): void {
    operation.settled.then(() => {
      if (operation.detached()) {
        const remaining = (this.abandoned.get(id) ?? 1) - 1
        if (remaining <= 0) this.abandoned.delete(id)
        else this.abandoned.set(id, remaining)
      }
    }).catch(() => undefined)
  }

  /** Invoke one action after parsing its input and binding the request lifetime. */
  async invoke(id: string, actionName: string, input: unknown, context: MobileActionContext, generation?: string): Promise<unknown> {
    const extension = this.extension(id, generation)
    if (extension === undefined) throw new MobileExtensionError('extension_not_found', 'extension not found', 404)
    const definition = 'host' in extension ? extension.host : extension
    const action = definition.actions?.[actionName]
    if (action === undefined) throw new MobileExtensionError('action_not_found', 'action not found', 404)
    // A cancelled invocation must not execute host code or occupy admission accounting.
    if ('host' in extension) extension.controller.signal.throwIfAborted()
    context.signal.throwIfAborted()
    this.requireAdmission(id)
    const external = 'host' in extension ? combineSignalLifetime(extension.controller.signal, context.signal) : undefined
    let operation: BoundedOperation<unknown> | undefined
    try {
      operation = startBoundedOperation(
        signal => {
          let parsed: unknown
          try { parsed = parseActionInput(action.input, input) } catch { throw new MobileExtensionError('invalid_action_input', 'action input is invalid', 400) }
          // Schema callables and parse adapters may validate asynchronously; both stay inside the budget,
          // and a caller that detached mid-parse must not start a further execution stage.
          return Promise.resolve(parsed).then(
            value => {
              signal.throwIfAborted()
              return action.run({ ...context, signal }, value)
            },
            () => { throw new MobileExtensionError('invalid_action_input', 'action input is invalid', 400) },
          )
        },
        {
          external: external?.signal ?? context.signal,
          timeoutMs: action.timeoutMs ?? ('host' in extension && extension.worker !== undefined ? resolveHostExecution(this.localExecution?.hostExecution).operationTimeoutMs : HOST_OPERATION_TIMEOUT_MS),
          timeoutError: () => new MobileExtensionError('extension_action_timeout', `extension ${id} action ${actionName} timed out`, 500),
          onDetach: () => { this.abandoned.set(id, (this.abandoned.get(id) ?? 0) + 1) },
        },
      )
      this.trackOperation(id, operation)
      // Action values are JSON-serialized downstream; late values are simply discarded.
      return await operation.caller
    } catch (error) {
      if (error instanceof OperationCancelled) throw error.reason
      if (error instanceof MobileExtensionError) throw error
      throw new MobileExtensionError('extension_failed', 'extension action failed', 500)
    } finally {
      operation?.release()
      external?.cleanup()
    }
  }

  /** Match one route and invoke it with a generation-bound abort signal. */
  async route(id: string, method: string, pathname: string, request: MobileRouteRequest, generation?: string): Promise<MobileRouteResponse> {
    const extension = this.extension(id, generation)
    if (extension === undefined) throw new MobileExtensionError('extension_not_found', 'extension not found', 404)
    const definition = 'host' in extension ? extension.host : extension
    const route = definition.routes?.find((candidate: MobileHostRoute) => {
      if (candidate.method !== method) return false
      return (candidate.kind ?? 'exact') === 'exact'
        ? candidate.path === pathname
        : pathname === candidate.path || pathname.startsWith(`${candidate.path}/`)
    })
    if (route === undefined) throw new MobileExtensionError('route_not_found', 'route not found', 404)
    // A cancelled request must not execute host code or occupy admission accounting.
    if ('host' in extension) extension.controller.signal.throwIfAborted()
    request.signal.throwIfAborted()
    this.requireAdmission(id)
    const external = 'host' in extension ? combineSignalLifetime(extension.controller.signal, request.signal) : undefined
    let operation: BoundedOperation<MobileRouteResponse> | undefined
    let holdForStream = false
    try {
      operation = startBoundedOperation(
        signal => route.handle({ ...request, signal }),
        {
          external: external?.signal ?? request.signal,
          timeoutMs: route.timeoutMs ?? ('host' in extension && extension.worker !== undefined ? resolveHostExecution(this.localExecution?.hostExecution).operationTimeoutMs : HOST_OPERATION_TIMEOUT_MS),
          timeoutError: () => new MobileExtensionError('extension_route_timeout', `extension ${id} route ${method} ${pathname} timed out`, 500),
          onDetach: () => { this.abandoned.set(id, (this.abandoned.get(id) ?? 0) + 1) },
        },
      )
      this.trackOperation(id, operation)
      // A handler that resolves after its deadline may still open a stream nobody owns.
      operation.settled.then(() => {
        disposeLateExtensionResponse(operation?.lateValue())
      }).catch(() => undefined)
      const result = await operation.caller
      if (result === null || typeof result !== 'object' || typeof result.body !== 'string' && !(result.body instanceof Uint8Array) && !isReadable(result.body)) {
        throw new MobileExtensionError('invalid_route_response', 'extension returned an invalid response', 500)
      }
      if (isReadable(result.body)) {
        // The deadline ended at resolution; request and generation cancellation
        // keep flowing until the returned stream itself settles.
        holdForStream = true
        releaseSignalLifetimeWhenStreamSettles(result.body, () => { operation?.release(); external?.cleanup() })
      }
      return result
    } catch (error) {
      if (error instanceof OperationCancelled) throw error.reason
      if (error instanceof MobileExtensionError) throw error
      throw new MobileExtensionError('extension_failed', 'extension route failed', 500)
    } finally {
      if (!holdForStream) {
        operation?.release()
        external?.cleanup()
      }
    }
  }

  /** Start the local directory watcher; an absent directory is intentionally inert. */
  async startLocal(root: string, context: Context, options?: LocalExecutionOptions): Promise<void> {
    const targetRoot = resolve(root)
    const limits = resolveHostExecution(options?.hostExecution)
    const executionKey = JSON.stringify({ limits, module: options?.hostExecution?.workerModule })
    if (this.localRoot !== undefined && (resolve(this.localRoot) !== targetRoot || this.localExecutionKey !== executionKey)) await this.stopLocal()
    if (this.localTimer !== undefined) clearInterval(this.localTimer)
    const lifecycle = ++this.localLifecycle
    this.workerBudget ??= new ExtensionWorkerBudget(limits.maxWorkers)
    this.localRoot = targetRoot; this.localContext = context; this.localExecution = { ...options, workerBudget: this.workerBudget }; this.localExecutionKey = executionKey; this.localClosed = false
    await mkdir(this.localRoot, { recursive: true })
    if (this.localClosed || this.localLifecycle !== lifecycle || this.localRoot !== targetRoot || this.localContext !== context) return
    await this.refreshLocal()
    if (this.localClosed || this.localLifecycle !== lifecycle || this.localRoot !== targetRoot || this.localContext !== context) return
    this.localTimer = setInterval(() => { void this.refreshLocal() }, 2_000)
    this.localTimer.unref()
  }

  /** Stop the watcher and abort every local host generation. */
  async stopLocal(): Promise<void> {
    this.localClosed = true
    const lifecycle = ++this.localLifecycle
    if (this.localTimer !== undefined) clearInterval(this.localTimer)
    this.localTimer = undefined
    const refreshing = this.localRefreshing
    this.localRefreshAbort?.abort()
    const previous = [...this.local.values(), ...[...this.retired.values()].map(entry => entry.active)]
    this.local.clear()
    for (const entry of this.retired.values()) clearTimeout(entry.timer)
    this.retired.clear()
    this.failures.clear()
    this.updateContentHash()
    await Promise.allSettled([
      abortAndDisposeLocal(previous),
      ...(refreshing === undefined ? [] : [refreshing]),
    ])
    if (this.localLifecycle !== lifecycle) return
    const late = [...this.local.values(), ...[...this.retired.values()].map(entry => entry.active)]
    this.local.clear()
    for (const entry of this.retired.values()) clearTimeout(entry.timer)
    this.retired.clear()
    this.failures.clear()
    this.updateContentHash()
    await abortAndDisposeLocal(late)
    await Promise.allSettled([...this.disposal, ...this.recoveries.values()])
    this.workerBudget = undefined
    if (this.localTimer !== undefined) clearInterval(this.localTimer)
    this.localTimer = undefined
  }

  /** Refresh all local extensions atomically; failures keep the previous snapshot. */
  refreshLocal(): Promise<void> {
    if (this.localRefreshing !== undefined) return this.localRefreshing
    const controller = new AbortController()
    this.localRefreshAbort = controller
    const refreshing = this.stageAndCommit(controller.signal).finally(() => {
      if (this.localRefreshing === refreshing) this.localRefreshing = undefined
      if (this.localRefreshAbort === controller) this.localRefreshAbort = undefined
    })
    this.localRefreshing = refreshing
    return refreshing
  }

  private async stageAndCommit(signal: AbortSignal): Promise<void> {
    if (this.localClosed || signal.aborted || this.localRoot === undefined || this.localContext === undefined) return
    let names: string[] = []
    try {
      const directory = await opendir(this.localRoot)
      try { for await (const entry of directory) if (entry.isDirectory() && !entry.isSymbolicLink()) names.push(entry.name) }
      finally { await directory.close().catch(() => undefined) }
    } catch { return }
    names.sort()
    const staged: ActiveLocalExtension[] = []
    const stagedFresh: ActiveLocalExtension[] = []
    let failingName = 'local'
    try {
      for (const name of names) {
        signal.throwIfAborted()
        failingName = name
        const directory = join(this.localRoot, name)
        const fingerprint = await extensionFingerprint(directory)
        const current = this.local.get(fingerprint.manifest.id)
        const retired = this.retired.get(fingerprint.manifest.id)?.active
        const previous = current?.digest === fingerprint.digest ? current : retired?.digest === fingerprint.digest ? retired : undefined
        if (previous?.digest === fingerprint.digest) staged.push(previous)
        else {
          const fresh = await loadLocalExtension(directory, this.localContext, fingerprint, signal, this.localExecution)
          try {
            signal.throwIfAborted()
            const confirmed = await extensionFingerprint(directory)
            if (confirmed.digest !== fingerprint.digest) {
              throw new MobileExtensionError('extension_changed_during_activation', `extension ${fingerprint.manifest.id} changed during activation`, 409)
            }
          } catch (error) {
            await abortAndDisposeLocal([fresh])
            throw error
          }
          staged.push(fresh); stagedFresh.push(fresh)
        }
      }
      if (this.localClosed || signal.aborted || this.localRoot === undefined || this.localContext === undefined) {
        await abortAndDisposeLocal(stagedFresh)
        return
      }
      const duplicate = new Set<string>()
      for (const entry of staged) {
        if (duplicate.has(entry.manifest.id) || this.registered.has(entry.manifest.id)) throw new MobileExtensionError('duplicate_extension', `duplicate extension id ${entry.manifest.id}`)
        duplicate.add(entry.manifest.id)
      }
      const previous = [...this.local.values()]
      for (const entry of staged) {
        const retired = this.retired.get(entry.manifest.id)
        if (retired?.active === entry) {
          clearTimeout(retired.timer)
          this.retired.delete(entry.manifest.id)
        }
      }
      const stagedIds = new Set(staged.map(entry => entry.manifest.id))
      const removed: ActiveLocalExtension[] = []
      for (const entry of previous) {
        if (staged.includes(entry)) continue
        if (stagedIds.has(entry.manifest.id)) {
          this.retire(entry)
          continue
        }
        removed.push(entry)
        const retired = this.retired.get(entry.manifest.id)
        if (retired !== undefined) {
          clearTimeout(retired.timer)
          this.retired.delete(entry.manifest.id)
          removed.push(retired.active)
        }
      }
      this.local.clear()
      for (const entry of staged) this.local.set(entry.manifest.id, entry)
      for (const entry of staged) this.failures.delete(entry.manifest.id)
      for (const name of names) this.failures.delete(name)
      for (const failure of this.failures.keys()) {
        if (failure !== 'local' && !names.includes(failure)) this.failures.delete(failure)
      }
      this.failures.delete('local')
      if (removed.length > 0) this.queueDisposal(removed)
      this.updateContentHash()
    } catch (error) {
      await abortAndDisposeLocal(stagedFresh)
      if (this.localClosed || signal.aborted) return
      const message = error instanceof Error ? error.message : String(error)
      const changedFailure=this.failures.get(failingName)!==message
      this.failures.set(failingName, message)
      if(changedFailure&&error instanceof MobileExtensionError&&error.code==='extension_worker_heap_override')this.ctx.logger.warn('local extension worker refused: %s',error.message)
      if (!(error instanceof MobileExtensionError)) this.ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private retire(active: ActiveLocalExtension): void {
    const previous = this.retired.get(active.manifest.id)
    if (previous?.active === active) return
    if (previous !== undefined) {
      clearTimeout(previous.timer)
      this.retired.delete(active.manifest.id)
      this.queueDisposal([previous.active])
    }
    const timer = setTimeout(() => {
      const current = this.retired.get(active.manifest.id)
      if (current?.active !== active) return
      this.retired.delete(active.manifest.id)
      this.queueDisposal([active])
    }, RETIRED_GENERATION_TTL_MS)
    timer.unref()
    this.retired.set(active.manifest.id, { active, timer })
  }
}

function isReadable(value: unknown): value is Readable {
  return value !== null && typeof value === 'object' && typeof (value as { pipe?: unknown }).pipe === 'function'
}

/** Destroy a route response that arrived after its caller detached; must never throw or emit unhandled stream errors. */
export function disposeLateExtensionResponse(value: unknown): void {
  try {
    if (value === null || typeof value !== 'object') return
    const body = (value as { readonly body?: unknown }).body
    if (!isReadable(body) || typeof body.once !== 'function' || typeof body.destroy !== 'function') return
    body.once('error', () => undefined)
    body.destroy()
  } catch { /* Invalid late results and disposal failures must not escape. */ }
}

function releaseSignalLifetimeWhenStreamSettles(stream: Readable, cleanup: () => void): void {
  let stopObserving: (() => void) | undefined
  stopObserving = finished(stream, () => {
    stopObserving?.()
    cleanup()
  })
}

function invokeCleanups(cleanups: readonly (() => void | Promise<void>)[]): Promise<unknown>[] {
  const pending: Promise<unknown>[] = []
  for (const cleanup of [...cleanups].reverse()) {
    try { pending.push(Promise.resolve(cleanup())) } catch { /* extension teardown cannot block the owner */ }
  }
  return pending
}

async function settleBounded(pending: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (pending.length === 0) return
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>(resolveTimeout => { timer = setTimeout(resolveTimeout, timeoutMs) }),
  ])
  if (timer !== undefined) clearTimeout(timer)
}

/** Sentinel distinguishing caller detachment (deadline or external cancel) from a host error. */
class OperationCancelled {
  constructor(readonly reason: unknown) {}
}

/**
 * Run one extension operation under a per-invocation deadline.
 *
 * Releasing the caller, stopping the wait, and stopping the work are separate
 * concerns: the caller settles at the deadline (or on external cancellation)
 * even when the host ignores its signal, while the underlying work is observed
 * to settlement so late results can be disposed and accounted for.
 */
interface BoundedOperation<T> {
  /** Settles exactly once with the caller-visible outcome. */
  readonly caller: Promise<T>
  /** Settles when the underlying work settles; never rejects. */
  readonly settled: Promise<void>
  /** Whether the caller detached before the work settled. */
  detached(): boolean
  /** The value when the work fulfilled after the caller detached. */
  lateValue(): T | undefined
  /** End the per-invocation cancellation lifetime exactly once. */
  release(): void
}

function startBoundedOperation<T>(
  start: (signal: AbortSignal) => T | Promise<T>,
  options: {
    readonly external: AbortSignal | undefined
    readonly timeoutMs: number
    readonly timeoutError: () => MobileExtensionError
    /** Invoked at most once when the caller detaches with work unresolved. */
    readonly onDetach?: () => void
  },
): BoundedOperation<T> {
  const deadline = new AbortController()
  const combined = options.external === undefined
    ? { signal: deadline.signal, cleanup: (): void => undefined }
    : combineSignalLifetime(options.external, deadline.signal)
  let detached = false
  let workState: 'fulfilled' | 'rejected' | undefined
  let lateFulfilled: T | undefined
  let notifySettled: (() => void) | undefined
  let callerTimer: NodeJS.Timeout | undefined
  let onExternal: (() => void) | undefined
  const settled = new Promise<void>(resolve => { notifySettled = resolve })
  const detach = (reject: (reason?: unknown) => void, reason: unknown): void => {
    // A queued timer must not detach work that already settled.
    if (detached || workState !== undefined) return
    detached = true
    // The caller is gone: stop its timer and observer, and record abandonment
    // before firing cancellation listeners so re-entrant dispatch is gated.
    if (callerTimer !== undefined) clearTimeout(callerTimer)
    if (onExternal !== undefined) options.external?.removeEventListener('abort', onExternal)
    options.onDetach?.()
    deadline.abort(reason)
    reject(new OperationCancelled(reason))
  }
  const caller = new Promise<T>((resolve, reject) => {
    callerTimer = setTimeout(() => detach(reject, options.timeoutError()), options.timeoutMs)
    onExternal = (): void => { detach(reject, combined.signal.reason) }
    options.external?.addEventListener('abort', onExternal, { once: true })
    void (async (): Promise<void> => {
      try {
        const value = await start(combined.signal)
        workState = 'fulfilled'
        if (callerTimer !== undefined) clearTimeout(callerTimer)
        if (onExternal !== undefined) options.external?.removeEventListener('abort', onExternal)
        // A detached caller owns nothing anymore; a live caller decides via release().
        if (detached) combined.cleanup()
        if (detached) lateFulfilled = value
        else resolve(value)
        notifySettled?.()
      } catch (error) {
        workState = 'rejected'
        if (callerTimer !== undefined) clearTimeout(callerTimer)
        if (onExternal !== undefined) options.external?.removeEventListener('abort', onExternal)
        if (detached) combined.cleanup()
        if (!detached) reject(error)
        notifySettled?.()
      }
    })()
  })
  let released = false
  return {
    caller,
    settled,
    detached: () => detached,
    lateValue: () => (detached && workState === 'fulfilled' ? lateFulfilled : undefined),
    release: () => { if (!released) { released = true; combined.cleanup() } },
  }
}

async function abortAndDisposeLocal(entries: readonly ActiveLocalExtension[]): Promise<void> {
  const pending: Promise<unknown>[] = []
  for (const entry of entries) {
    entry.controller.abort()
    pending.push(...invokeCleanups(entry.cleanups))
  }
  await settleBounded(pending, HOST_TEARDOWN_TIMEOUT_MS)
  // Worker disposal requires confirmed exit even when its effect cleanup exceeded the advisory budget.
  await Promise.all(entries.flatMap(entry => entry.worker === undefined ? [] : [entry.worker.dispose()]))
}

async function loadLocalExtension(directory: string, context: Context, known?: LocalExtensionFingerprint, parentSignal?: AbortSignal, execution?: LocalExecutionOptions): Promise<ActiveLocalExtension> {
  const root = await realExtensionRoot(directory)
  const manifestFile = await regularFile(join(root, 'extension.json'), EXTENSION_LIMITS.manifest, 'extension.json')
  const manifest = known?.manifest ?? parseExtensionManifest(JSON.parse(await readFile(manifestFile.path, 'utf8')) as unknown)
  if (manifest.id !== basename(root)) throw new MobileExtensionError('invalid_manifest', 'extension id must match its directory name')
  const scriptBody = known === undefined
    ? await optionalFile(root, 'mobile.js', EXTENSION_LIMITS.script, 'mobile.js').then(path => path === undefined ? undefined : readFile(path))
    : known.scriptBody
  const styleBody = known === undefined
    ? await optionalFile(root, 'mobile.css', EXTENSION_LIMITS.css, 'mobile.css').then(path => path === undefined ? undefined : readFile(path))
    : known.styleBody
  const assets = known?.assets ?? await assetSnapshot(root)
  const hostFile = await optionalFile(root, 'host.mjs', EXTENSION_LIMITS.script, 'host.mjs')
  const controller = new AbortController()
  const actions: Record<string, MobileHostAction> = {}
  const routes: MobileHostRoute[] = []
  const cleanups: (() => void | Promise<void>)[] = []
  const pendingEffects: Promise<void>[] = []
  let activationOpen = true
  const onParentAbort = (): void => { controller.abort(parentSignal?.reason) }
  if (parentSignal?.aborted === true) onParentAbort()
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  const ensureActivationOpen = (): void => {
    if (!activationOpen || controller.signal.aborted) throw new MobileExtensionError('host_activation_closed', `extension ${manifest.id} activation is closed`, 409)
  }
  const api: HostApi = {
    manifest,
    context,
    schema: z,
    signal: controller.signal,
    action(name, spec) { ensureActivationOpen(); if (actions[name] !== undefined) throw new MobileExtensionError('duplicate_action', `duplicate action ${name}`); actions[name] = spec },
    route(spec) { ensureActivationOpen(); routes.push(spec) },
    effect(setup) {
      ensureActivationOpen()
      const result = setup()
      if (result instanceof Promise) {
        pendingEffects.push(result.then(async cleanup => {
          if (typeof cleanup !== 'function') return
          if (activationOpen) cleanups.push(cleanup)
          else await cleanup()
        }))
      } else if (typeof result === 'function') {
        if (activationOpen) cleanups.push(result)
        else void Promise.resolve(result()).catch(() => undefined)
      }
    },
  }
  try {
    // Worker mode: all executable host behavior runs inside one worker
    // per generation; registration crosses as metadata only and action results
    // cross as worker-serialized bytes.
    const limits = resolveHostExecution(execution?.hostExecution)
    const selected = limits.mode === 'worker' && (limits.extensions === undefined || limits.extensions.includes(manifest.id))
    const worker = selected && hostFile !== undefined
      ? new ExtensionWorkerHost({
        workerModule: execution?.hostExecution?.workerModule ?? defaultExtensionWorkerModule(),
        hostFile,
        manifest,
        generation: known?.digest ?? createHash('sha256').update(manifest.id).digest('hex'),
        logger: workerLoggerAdapter(context),
        limits,
        ...(execution?.workerBudget === undefined ? {} : { budget: execution.workerBudget }),
        onUnavailable: error => { controller.abort(error) },
      })
      : undefined
    let host: MobileExtensionDefinition
    if (worker !== undefined) {
      try {
        await withActivationTimeout(worker.activate(), manifest.id, controller.signal)
      } catch (error) {
        // A failed activation must not leak a live worker thread (the watcher
        // retries every interval).
        await worker.terminate('activation-failed')
        throw error
      }
      const proxyActions: Record<string, MobileHostAction> = {}
      for (const metadata of worker.actionMetadata()) {
        proxyActions[metadata.name] = {
          ...(metadata.timeoutMs === undefined ? {} : { timeoutMs: metadata.timeoutMs }),
          run: (actionContext, input) => worker.invokeExecution(metadata.name, input, actionContext),
        }
      }
      const proxyRoutes: MobileHostRoute[] = worker.routeMetadata().map((metadata, index) => ({
        method: metadata.method,
        path: metadata.path,
        ...(metadata.kind === undefined ? {} : { kind: metadata.kind }),
        ...(metadata.timeoutMs === undefined ? {} : { timeoutMs: metadata.timeoutMs }),
        handle: request => worker.handleRouteExecution(index, request),
      }))
      try {
        host = validateDefinition({ ...manifest, ...(Object.keys(proxyActions).length === 0 ? {} : { actions: proxyActions }), ...(proxyRoutes.length === 0 ? {} : { routes: proxyRoutes }) })
      } catch (error) {
        await worker.terminate('definition-invalid')
        throw error
      }
      // Worker lifecycle cleanup is owned separately from advisory in-process effect cleanup.
    } else {
      const activate = async (): Promise<void> => {
        controller.signal.throwIfAborted()
        if (hostFile !== undefined) {
          const digest = createHash('sha256').update(await readFile(hostFile)).digest('hex')
          controller.signal.throwIfAborted()
          let imported: LocalHostModule
          try { imported = await import(`${pathToFileURL(hostFile).href}?dsh_generation=${digest}`) as LocalHostModule }
          catch { throw new MobileExtensionError('host_load_failed', `could not load ${manifest.id}/host.mjs`, 500) }
          controller.signal.throwIfAborted()
          if (imported.default !== undefined) await imported.default(api)
        }
        await Promise.all(pendingEffects)
      }
      await withActivationTimeout(activate(), manifest.id, controller.signal)
      host = validateDefinition({ ...manifest, actions, routes })
    }
    activationOpen = false
    const digest = known?.digest ?? createHash('sha256').update(manifest.id).digest('hex')
    return Object.freeze({ manifest, directory: root, ...(scriptBody === undefined ? {} : { scriptBody }), ...(styleBody === undefined ? {} : { styleBody }), assets, host, controller, cleanups: Object.freeze(cleanups), digest, ...(worker === undefined ? {} : { worker }) })
  } catch (error) {
    activationOpen = false
    controller.abort()
    const cleanupPromises = invokeCleanups(cleanups.splice(0))
    await settleBounded([...pendingEffects, ...cleanupPromises], HOST_TEARDOWN_TIMEOUT_MS)
    throw error
  } finally {
    parentSignal?.removeEventListener('abort', onParentAbort)
  }
}

/** Forward the worker's logger-only context adapter into the plugin logger. */
function workerLoggerAdapter(context: Context): WorkerParentLogger {
  return {
    debug: (...args: unknown[]) => { context.logger.debug(...args as Parameters<typeof context.logger.debug>) },
    info: (...args: unknown[]) => { context.logger.info(...args as Parameters<typeof context.logger.info>) },
    warn: (...args: unknown[]) => { context.logger.warn(...args as Parameters<typeof context.logger.warn>) },
    error: (...args: unknown[]) => { context.logger.error(...args as Parameters<typeof context.logger.error>) },
  }
}

/** Construct the service in a Cordis plugin without importing DSH internals. */
export function createMobileAccessService(ctx: Context): MobileAccessService {
  return new MobileAccessService(ctx)
}
