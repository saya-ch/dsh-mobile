import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { restrictPrivateFile } from '../private-file.js'
import { canonicalPushEndpoint } from './endpoint.js'
import type { PushSnapshot } from './contracts.js'

const MAX_STATE_BYTES = 4 * 1024 * 1024
const emptySnapshot = (): PushSnapshot => ({ version: 1, ownerGenerations: [], registrations: [], pending: [], receipts: [], references: [] })
async function ensurePrivateDirectory(directory: string): Promise<void> {
  const absolute = resolve(directory)
  await mkdir(absolute, { recursive: true, mode: 0o700 })
  const stat = await lstat(absolute)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('push state parent must be a managed non-symlink directory')
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('push state parent permissions must be owner-only')
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function list(value: unknown): value is unknown[] { return Array.isArray(value) }
function validKey(value: unknown): boolean { return object(value) && only(value, ['publicKey', 'privateKey', 'fingerprint']) && typeof value.publicKey === 'string' && value.publicKey.length > 0 && typeof value.privateKey === 'string' && value.privateKey.length > 0 && typeof value.fingerprint === 'string' && value.fingerprint.length > 0 }
type OwnerFields = Record<string, unknown> & { scopeId: string; deviceId: string; origin: string }
function owner(value: unknown): value is OwnerFields { return object(value) && typeof value.scopeId === 'string' && value.scopeId.length > 0 && typeof value.deviceId === 'string' && value.deviceId.length > 0 && typeof value.origin === 'string' && value.origin.length > 0 }
function recipient(value: unknown): boolean { return owner(value) && typeof value.installationId === 'string' && value.installationId.length > 0 }
function only(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)) }
function validSource(value: unknown): boolean {
  if (!object(value) || !only(value, ['sourceId', 'sessionId', 'targetSessionId', 'category', 'createdAt', 'expiresAt', 'lifetime', 'turn', 'callId', 'goal'])) return false
  const categories = ['question', 'plan', 'approval', 'response', 'goal', 'failure']
  return [value.sourceId, value.sessionId, value.targetSessionId].every(v => typeof v === 'string' && v.length > 0 && v.length <= 4096)
    && categories.includes(String(value.category)) && Number.isFinite(value.createdAt) && Number.isFinite(value.expiresAt)
    && ['live', 'projected', 'committed'].includes(String(value.lifetime))
    && (value.turn === undefined || Number.isSafeInteger(value.turn)) && (value.callId === undefined || typeof value.callId === 'string')
    && (value.goal === undefined || (object(value.goal) && only(value.goal, ['id', 'revision']) && typeof value.goal.id === 'string' && Number.isSafeInteger(value.goal.revision)))
}
function scopedCounts(rows: readonly unknown[], scope: (row: unknown) => unknown, maximum = 1024): boolean {
  const counts = new Map<unknown, number>()
  for (const row of rows) { const key = scope(row); const next = (counts.get(key) ?? 0) + 1; counts.set(key, next); if (next > maximum) return false }
  return true
}
function registration(value: unknown): boolean {
  return recipient(value) && object(value) && only(value, ['scopeId', 'deviceId', 'origin', 'installationId', 'subscription', 'locale', 'preferences', 'generation', 'keyFingerprint', 'enabled', 'health'])
    && object(value.subscription) && only(value.subscription, ['endpoint', 'keys']) && typeof value.subscription.endpoint === 'string' && value.subscription.endpoint.length > 0
    && object(value.subscription.keys) && only(value.subscription.keys, ['p256dh', 'auth']) && typeof value.subscription.keys.p256dh === 'string' && typeof value.subscription.keys.auth === 'string'
    && (value.locale === 'en' || value.locale === 'zh-CN' || value.locale === 'it') && object(value.preferences)
    && only(value.preferences, ['question', 'plan', 'approval', 'response', 'goal', 'failure']) && ['question', 'plan', 'approval', 'response', 'goal', 'failure'].every(k => typeof (value.preferences as Record<string, unknown>)[k] === 'boolean')
    && Number.isSafeInteger(value.generation) && Number(value.generation) > 0 && typeof value.keyFingerprint === 'string' && typeof value.enabled === 'boolean'
    && ['ready', 'suspended', 'repair-required'].includes(String(value.health))
}
export function parsePushSnapshot(value: unknown): PushSnapshot {
  if (!object(value) || !only(value, ['version', 'keys', 'ownerGenerations', 'ownerGenerationFloor', 'registrations', 'pending', 'receipts', 'references']) || value.version !== 1) throw new Error('push state has an unsupported version')
  for (const field of ['ownerGenerations', 'registrations', 'pending', 'receipts', 'references']) if (!list(value[field])) throw new Error(`push state ${field} must be an array`)
  if (value.ownerGenerationFloor !== undefined && (!Number.isSafeInteger(value.ownerGenerationFloor) || Number(value.ownerGenerationFloor) < 0)) throw new Error('push state has an invalid owner generation floor')
  if (value.keys !== undefined && !validKey(value.keys)) throw new Error('push state contains invalid key material')
  const owners = value.ownerGenerations as unknown[]
  const registrations = value.registrations as unknown[]
  const pending = value.pending as unknown[]
  const receipts = value.receipts as unknown[]
  const references = value.references as unknown[]
  if (!scopedCounts(owners, row => object(row) ? row.scopeId : undefined) || !scopedCounts(registrations, row => object(row) ? row.scopeId : undefined, 256) || !scopedCounts(pending, row => object(row) && object(row.key) ? row.key.scopeId : undefined, 256) || !scopedCounts(receipts, row => object(row) && object(row.key) ? row.key.scopeId : undefined) || !scopedCounts(references, row => object(row) && object(row.key) ? row.key.scopeId : undefined)) throw new Error('push state exceeds a storage limit')
  if (!owners.every(o => owner(o) && only(o, ['scopeId', 'deviceId', 'origin', 'generation']) && Number.isSafeInteger(o.generation) && Number(o.generation) >= 0)
    || !registrations.every(registration)
    || !pending.every(i => object(i) && only(i, ['id', 'key', 'source', 'ownerGeneration', 'recipientGeneration', 'attempts', 'nextAttemptAt']) && typeof i.id === 'string' && recipient(i.key) && object(i.key) && only(i.key, ['scopeId', 'deviceId', 'origin', 'installationId']) && validSource(i.source) && Number.isSafeInteger(i.ownerGeneration) && Number.isSafeInteger(i.recipientGeneration) && Number.isSafeInteger(i.attempts) && Number.isFinite(i.nextAttemptAt))
    || !receipts.every(r => object(r) && only(r, ['sourceId', 'key', 'recipientGeneration', 'expiresAt']) && typeof r.sourceId === 'string' && recipient(r.key) && object(r.key) && only(r.key, ['scopeId', 'deviceId', 'origin', 'installationId']) && Number.isSafeInteger(r.recipientGeneration) && Number.isFinite(r.expiresAt))
    || !references.every(r => object(r) && only(r, ['reference', 'key', 'source', 'expiresAt']) && typeof r.reference === 'string' && recipient(r.key) && object(r.key) && only(r.key, ['scopeId', 'deviceId', 'origin', 'installationId']) && validSource(r.source) && r.expiresAt === (r.source as Record<string, unknown>).expiresAt)) throw new Error('push state contains invalid records')
  const validOwners = owners as OwnerFields[]
  const ownerKeys = validOwners.map(o => JSON.stringify([o.scopeId, o.deviceId, o.origin]))
  const validRegistrations = registrations as Array<Record<string, unknown>>
  const regKeys = validRegistrations.map(reg => JSON.stringify([reg.scopeId, reg.deviceId, reg.origin, reg.installationId]))
  const endpoints = validRegistrations.map(reg => canonicalPushEndpoint((reg.subscription as Record<string, unknown>).endpoint as string))
  if (new Set(ownerKeys).size !== owners.length || new Set(regKeys).size !== registrations.length || new Set(endpoints).size !== endpoints.length) throw new Error('push state contains duplicate ownership')
  for (const reg of validRegistrations) if (validRegistrations.filter(other => other.scopeId === reg.scopeId && other.deviceId === reg.deviceId).length > 4) throw new Error('push state exceeds the per-device registration limit')
  return structuredClone(value) as unknown as PushSnapshot
}

export class JsonPushStore {
  constructor(private readonly file: string) {}
  async load(): Promise<PushSnapshot> {
    try {
      const parent = await lstat(dirname(this.file))
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('push state parent must be a managed non-symlink directory')
      if (process.platform !== 'win32' && (parent.mode & 0o077) !== 0) throw new Error('push state parent permissions must be owner-only')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySnapshot()
      throw error
    }
    let info
    try { info = await lstat(this.file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptySnapshot()
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) throw new Error('push state must be a regular file no larger than 4 MiB')
    await restrictPrivateFile(this.file)
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(this.file, 'utf8')) as unknown } catch (error) { throw new Error('push state is not valid JSON', { cause: error }) }
    return parsePushSnapshot(parsed)
  }
  async save(snapshot: PushSnapshot): Promise<void> {
    const safe = parsePushSnapshot(snapshot)
    const serialized = `${JSON.stringify(safe)}\n`
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) throw new Error('push state exceeds 4 MiB')
    const directory = dirname(this.file)
    await ensurePrivateDirectory(directory)
    try {
      const current = await lstat(this.file)
      if (!current.isFile() || current.isSymbolicLink()) throw new Error('push state target must remain a regular file')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const temporary = join(directory, `.${basename(this.file)}.${randomBytes(12).toString('hex')}.tmp`)
    try {
      await writeFile(temporary, '', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await restrictPrivateFile(temporary)
      await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'r+' })
      await rename(temporary, this.file)
    } catch (error) {
      try { await rm(temporary, { force: true }) } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'push state write and cleanup both failed') }
      throw error
    }
  }
}

export class MemoryPushStore {
  private snapshot: PushSnapshot
  constructor(initial: PushSnapshot = emptySnapshot()) { this.snapshot = parsePushSnapshot(initial) }
  async load(): Promise<PushSnapshot> { return structuredClone(this.snapshot) }
  async save(snapshot: PushSnapshot): Promise<void> { this.snapshot = parsePushSnapshot(snapshot) }
  inspect(): PushSnapshot { return structuredClone(this.snapshot) }
}
