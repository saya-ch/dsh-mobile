import { lstat, readFile } from 'node:fs/promises'
import { isIP } from './ip.js'
import { isAbsolute, join, resolve } from 'node:path'
import { restrictPrivateFile } from './private-file.js'
import { assertManagedParents, removeManagedTree, writeManagedPrivateFile } from './managed-files.js'

const MAX_CONFIG_BYTES = 8 * 1024
const QUICK_TUNNEL_SUFFIX = '.trycloudflare.com'
/** Cloudflare's own tunnel-routing domain; it can never be a public hostname. */
const TUNNEL_ROUTING_SUFFIX = '.cfargotunnel.com'
/**
 * The bare registrable names behind those suffixes. A suffix test alone accepts
 * them, yet Cloudflare owns both apexes outright, so neither can ever be routed to
 * a customer tunnel.
 */
const RESERVED_APEX_NAMES: readonly string[] = Object.freeze([
  QUICK_TUNNEL_SUFFIX.slice(1),
  TUNNEL_ROUTING_SUFFIX.slice(1),
])
/** Ports below this need privileges on every supported platform. */
const MIN_PORT = 1024
const MAX_PORT = 65_535
/**
 * The LAN gateway's HTTPS port, held by the plugin for as long as DSH runs. It is
 * never available to a tunnel, so a configuration naming it must be refused up
 * front rather than failing later as a generic "port in use".
 */
const RESERVED_LAN_GATEWAY_PORT = 3443
const MAX_TOKEN_LENGTH = 4096

/** Which tunnel flavour the cloudflared provider runs. */
export type CloudflaredTunnelMode = 'quick' | 'named'

/**
 * Cloudflared provider configuration.
 *
 * A quick tunnel owns nothing durable: cloudflared allocates a random hostname
 * and a random forward port every start. A named tunnel instead runs with an
 * account token, and its public hostname is routed by Cloudflare to the local
 * port recorded here, so that port must stay stable across restarts.
 */
export type CloudflaredTunnelSettings =
  | { readonly version: 1; readonly mode: 'quick' }
  | {
    readonly version: 1
    readonly mode: 'named'
    readonly token: string
    readonly hostname: string
    readonly port: number
  }

/** Configuration metadata safe to hand to the desktop panel; never the token. */
export interface CloudflaredTunnelStatus {
  readonly mode: CloudflaredTunnelMode
  readonly configured: boolean
  readonly hostname?: string
  readonly port?: number
  readonly storagePath: string
  readonly errorCode?: string
}

function hostname(value: string): boolean {
  if (value.length > 253 || !value.includes('.')) return false
  return value.split('.').every(label => label.length >= 1 && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
}

/**
 * Validate the public hostname Cloudflare routes to this tunnel.
 *
 * The name must be a real DNS name, not an IP literal or a wildcard, and it
 * cannot sit under Cloudflare's own control-plane suffixes: `trycloudflare.com`
 * belongs to quick tunnels, and a `cfargotunnel.com` name is the routing target
 * rather than a routable public address.
 */
export function validateCloudflaredTunnelHostname(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length === 0 || value.length > 253) {
    throw new Error('cloudflared_tunnel_hostname_invalid')
  }
  const normalized = value.toLowerCase().replace(/\.$/u, '')
  // An IPv4 literal is dot-separated digits and would otherwise satisfy the label
  // grammar, but Cloudflare never routes a tunnel hostname to an address.
  if (isIP(normalized) !== 0 || !hostname(normalized) || normalized.includes('*')
    || RESERVED_APEX_NAMES.includes(normalized)
    || normalized.endsWith(QUICK_TUNNEL_SUFFIX) || normalized.endsWith(TUNNEL_ROUTING_SUFFIX)) {
    throw new Error('cloudflared_tunnel_hostname_invalid')
  }
  return normalized
}

/** Validate the stable loopback port Cloudflare's ingress forwards to. */
export function validateCloudflaredTunnelPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < MIN_PORT || Number(value) > MAX_PORT) {
    throw new Error('cloudflared_tunnel_port_invalid')
  }
  // The LAN gateway always owns 3443, so this is not a transient conflict and the
  // user must be told which port to avoid instead of "the port is busy".
  if (value === RESERVED_LAN_GATEWAY_PORT) throw new Error('cloudflared_tunnel_port_reserved')
  return Number(value)
}

/**
 * Validate a connector token before durable storage.
 *
 * A token is a base64url-encoded JSON blob that carries the account, tunnel id
 * and tunnel secret; the provider passes it through the environment rather than
 * the command line, and it is never returned to any client.
 */
export function validateCloudflaredTunnelToken(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim()
    || value.length < 32 || value.length > MAX_TOKEN_LENGTH
    || !/^[A-Za-z0-9_=+/-]+$/u.test(value)) {
    throw new Error('cloudflared_tunnel_token_invalid')
  }
  return value
}

/** Parse tunnel settings at the request and filesystem boundaries. */
export function parseCloudflaredTunnelSettings(value: unknown): CloudflaredTunnelSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('cloudflared_tunnel_settings_invalid')
  }
  const record = value as Record<string, unknown>
  const allowed = ['version', 'mode', 'token', 'hostname', 'port']
  if (Reflect.ownKeys(record).some(key => !allowed.includes(String(key)))) {
    throw new Error('cloudflared_tunnel_settings_invalid')
  }
  if (record.version !== undefined && record.version !== 1) {
    throw new Error('cloudflared_tunnel_settings_invalid')
  }
  const mode = record.mode ?? 'quick'
  if (mode === 'quick') {
    if (record.token !== undefined || record.hostname !== undefined || record.port !== undefined) {
      throw new Error('cloudflared_tunnel_settings_invalid')
    }
    return Object.freeze({ version: 1, mode: 'quick' })
  }
  if (mode !== 'named') throw new Error('cloudflared_tunnel_settings_invalid')
  return Object.freeze({
    version: 1,
    mode: 'named',
    token: validateCloudflaredTunnelToken(record.token),
    hostname: validateCloudflaredTunnelHostname(record.hostname),
    port: validateCloudflaredTunnelPort(record.port),
  })
}

/**
 * Merge a partial panel request with the saved named-tunnel settings so a blank
 * field keeps its stored value. The token in particular is write-only, so the
 * panel submits an empty string to mean "keep the existing connector token".
 */
export function mergeSavedCloudflaredTunnelSettings(
  partial: Readonly<Record<string, unknown>>,
  saved: CloudflaredTunnelSettings | undefined,
): CloudflaredTunnelSettings {
  const requested = partial.mode ?? saved?.mode ?? 'quick'
  // The named branch below hardcodes its mode, so an unrecognized value would be
  // silently rewritten into a named tunnel. Validate here as strictly as the
  // parser does, rather than letting this layer launder it.
  if (requested !== 'quick' && requested !== 'named') {
    throw new Error('cloudflared_tunnel_settings_invalid')
  }
  if (requested === 'quick') return parseCloudflaredTunnelSettings({ version: 1, mode: 'quick' })
  const previous = saved?.mode === 'named' ? saved : undefined
  const token = partial.token === '' || partial.token === undefined ? previous?.token : partial.token
  const hostname = partial.hostname === '' || partial.hostname === undefined ? previous?.hostname : partial.hostname
  const port = partial.port === undefined || partial.port === '' ? previous?.port : partial.port
  if (token === undefined || hostname === undefined || port === undefined) {
    throw new Error('cloudflared_tunnel_config_missing')
  }
  return parseCloudflaredTunnelSettings({ version: 1, mode: 'named', token, hostname, port })
}

/** Owns the private cloudflared tunnel configuration for one DSH installation. */
export class CloudflaredTunnelStore {
  readonly stateRoot: string
  readonly settingsFile: string
  private settingsValue: CloudflaredTunnelSettings = Object.freeze({ version: 1, mode: 'quick' })
  private errorCode: string | undefined

  constructor(stateDirectory: string, private readonly ownedRoot = stateDirectory) {
    if (!isAbsolute(stateDirectory)) throw new Error('cloudflared tunnel state directory must be absolute')
    this.stateRoot = resolve(stateDirectory)
    this.settingsFile = join(this.stateRoot, 'tunnel.json')
  }

  /** Load private settings while rejecting links, oversized files and unknown fields. */
  async initialize(): Promise<void> {
    this.settingsValue = Object.freeze({ version: 1, mode: 'quick' })
    this.errorCode = undefined
    try { await assertManagedParents(this.ownedRoot, this.settingsFile, 'cloudflared') } catch (_error) {
      this.errorCode = 'cloudflared_tunnel_config_invalid'
      return
    }
    let entry
    try { entry = await lstat(this.settingsFile) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_CONFIG_BYTES) {
      this.errorCode = 'cloudflared_tunnel_config_invalid'
      return
    }
    await restrictPrivateFile(this.settingsFile)
    try {
      this.settingsValue = parseCloudflaredTunnelSettings(JSON.parse(await readFile(this.settingsFile, 'utf8')) as unknown)
      this.errorCode = undefined
    } catch {
      this.settingsValue = Object.freeze({ version: 1, mode: 'quick' })
      this.errorCode = 'cloudflared_tunnel_config_invalid'
    }
  }

  /** Return configuration metadata without exposing the connector token. */
  status(): CloudflaredTunnelStatus {
    const settings = this.settingsValue
    return Object.freeze({
      mode: settings.mode,
      configured: settings.mode === 'named',
      ...(settings.mode === 'named' ? { hostname: settings.hostname, port: settings.port } : {}),
      storagePath: this.stateRoot,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    })
  }

  /** Return private settings only to the provider lifecycle. */
  settings(): CloudflaredTunnelSettings {
    return this.settingsValue
  }

  /** Atomically replace the tunnel configuration. */
  async configure(value: unknown): Promise<CloudflaredTunnelStatus> {
    const settings = parseCloudflaredTunnelSettings(value)
    if (settings.mode === 'quick') await removeManagedTree(this.ownedRoot, this.settingsFile, 'cloudflared')
    else {
      try { await writeManagedPrivateFile(this.ownedRoot, this.settingsFile, `${JSON.stringify(settings)}\n`, 'cloudflared') }
      catch (error) {
        if (error instanceof Error && error.message === 'cloudflared_config_target_invalid') {
          throw new Error('cloudflared_tunnel_target_invalid', { cause: error })
        }
        throw error
      }
    }
    this.settingsValue = settings
    this.errorCode = undefined
    return this.status()
  }

  /** Forget a named tunnel and its connector token. */
  async purge(): Promise<CloudflaredTunnelStatus> {
    await removeManagedTree(this.ownedRoot, this.settingsFile, 'cloudflared')
    this.settingsValue = Object.freeze({ version: 1, mode: 'quick' })
    this.errorCode = undefined
    return this.status()
  }
}
