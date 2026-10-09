import { lstat, readFile } from 'node:fs/promises'
import { isIP } from './ip.js'
import { isAbsolute, join, resolve } from 'node:path'
import { addressAllowed, isGloballyRoutableIpv4, isLoopbackAddress, parseCidr } from './network.js'
import { restrictPrivateFile } from './private-file.js'
import { assertManagedParents, removeManagedTree, writeManagedPrivateFile } from './managed-files.js'

export const DEFAULT_ORIGIN_LISTEN_PORT = 3444
const MAX_SETTINGS_BYTES = 8 * 1024
/**
 * Ports a user-space listener can actually hold on every supported platform. Below
 * this the bind needs privileges on Linux and macOS and fails with EACCES, which
 * surfaces as a generic start failure rather than a rejected choice.
 */
const MIN_ORIGIN_LISTEN_PORT = 1024
/** The LAN gateway's HTTPS port, held for as long as DSH runs. */
const RESERVED_LAN_GATEWAY_PORT = 3443
/** DSH's own WebServer port; the plugin cannot function while it is taken. */
const RESERVED_DSH_WEB_PORT = 3080
const PRIVATE_NETWORKS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'].map(parseCidr)
const TRUSTED_NETWORKS = [...PRIVATE_NETWORKS, parseCidr('127.0.0.0/8')]

/** A private HTTP listener behind a user-managed HTTPS reverse proxy. */
export interface OriginSettings {
  readonly version: 1
  readonly publicOrigin: string
  readonly listenHost: string
  readonly listenPort: number
  readonly allowedCidrs: readonly string[]
}

/** Configuration metadata returned only to the local desktop control UI. */
export interface OriginConfigurationStatus {
  readonly configured: boolean
  readonly publicOrigin?: string
  readonly listenHost?: string
  readonly listenPort?: number
  readonly allowedCidrs?: readonly string[]
  readonly backendOrigin?: string
  readonly storagePath: string
  readonly errorCode?: string
}

/** Require a public HTTPS origin; custom external ports are supported. */
export function validateOriginPublicOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || /[\s\u0000-\u001f\u007f\\@?#]/u.test(value)) {
    throw new Error('origin_public_origin_invalid')
  }
  let url: URL
  try { url = new URL(value) } catch { throw new Error('origin_public_origin_invalid') }
  const host = url.hostname
  const validHostname = host.length <= 253 && host.includes('.')
    && host.split('.').every(label => label.length >= 1 && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
    && !['localhost', 'local', 'lan', 'home', 'internal', 'home.arpa']
      .some(suffix => host === suffix || host.endsWith('.' + suffix))
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '' || (url.port !== '' && Number(url.port) < 1)
    || (isIP(host) === 4 ? !isGloballyRoutableIpv4(host) : isIP(host) !== 0 || !validHostname)) {
    throw new Error('origin_public_origin_invalid')
  }
  return url.origin
}

/** Bind only one explicit loopback or RFC1918 IPv4 interface, never all interfaces. */
export function validateOriginListenHost(value: unknown): string {
  if (typeof value !== 'string' || isIP(value) !== 4
    || (!isLoopbackAddress(value) && !addressAllowed(value, PRIVATE_NETWORKS))) {
    throw new Error('origin_listen_host_invalid')
  }
  return value
}

export function validateOriginListenPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < MIN_ORIGIN_LISTEN_PORT || Number(value) > 65_535) {
    throw new Error('origin_listen_port_invalid')
  }
  // 3443 is the LAN gateway and 3080 is DSH's own WebServer. Neither is a transient
  // conflict, so both are refused as choices rather than left to fail on bind.
  if (value === RESERVED_LAN_GATEWAY_PORT || value === RESERVED_DSH_WEB_PORT) {
    throw new Error('origin_listen_port_reserved')
  }
  return Number(value)
}

/** Authorize direct proxy socket peers, not untrusted forwarded client headers. */
export function validateOriginAllowedCidrs(value: unknown, listenHost: string): readonly string[] {
  const input = value === undefined && isLoopbackAddress(listenHost) ? ['127.0.0.0/8'] : value
  if (!Array.isArray(input) || input.length === 0 || input.length > 16) {
    throw new Error('origin_allowed_cidrs_invalid')
  }
  const cidrs: string[] = []
  for (const entry of input) {
    if (typeof entry !== 'string' || entry.length > 64 || isIP(entry.split('/')[0] ?? '') !== 4) {
      throw new Error('origin_allowed_cidrs_invalid')
    }
    try {
      const cidr = parseCidr(entry)
      if (cidr.bits !== 32 || !TRUSTED_NETWORKS.some(range => cidr.prefix >= range.prefix
        && addressAllowed(entry.split('/')[0], [range]))) throw new Error('untrusted CIDR')
      cidrs.push(cidr.source)
    } catch { throw new Error('origin_allowed_cidrs_invalid') }
  }
  if (!isLoopbackAddress(listenHost) && !cidrs.some(cidr => !isLoopbackAddress(cidr.split('/')[0]!))) {
    throw new Error('origin_allowed_cidrs_invalid')
  }
  return Object.freeze([...new Set(cidrs)])
}

/** Validate both saved settings and local administrative requests. */
export function parseOriginSettings(value: unknown): OriginSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('origin_settings_invalid')
  const record = value as Record<string, unknown>
  if (Reflect.ownKeys(record).some(key => !['version', 'publicOrigin', 'listenHost', 'listenPort', 'allowedCidrs'].includes(String(key)))
    || (record.version !== undefined && record.version !== 1)) throw new Error('origin_settings_invalid')
  const listenHost = validateOriginListenHost(record.listenHost === undefined ? '127.0.0.1' : record.listenHost)
  return Object.freeze({
    version: 1,
    publicOrigin: validateOriginPublicOrigin(record.publicOrigin),
    listenHost,
    listenPort: validateOriginListenPort(record.listenPort === undefined ? DEFAULT_ORIGIN_LISTEN_PORT : record.listenPort),
    allowedCidrs: validateOriginAllowedCidrs(record.allowedCidrs, listenHost),
  })
}

/** Owns only origin settings; shared paired-device storage is never removed. */
export class OriginConfigStore {
  readonly stateRoot: string
  readonly settingsFile: string
  private settingsValue: OriginSettings | undefined
  private errorCode: string | undefined

  constructor(stateDirectory: string, private readonly ownedRoot = stateDirectory) {
    if (!isAbsolute(stateDirectory)) throw new Error('origin config state directory must be absolute')
    this.stateRoot = resolve(stateDirectory)
    this.settingsFile = join(this.stateRoot, 'settings.json')
  }

  async initialize(): Promise<void> {
    this.settingsValue = undefined
    this.errorCode = undefined
    try { await assertManagedParents(this.ownedRoot, this.settingsFile, 'origin') } catch (_error) {
      this.errorCode = 'origin_config_invalid'
      return
    }
    let entry
    try { entry = await lstat(this.settingsFile) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_SETTINGS_BYTES) {
      this.errorCode = 'origin_config_invalid'
      return
    }
    await restrictPrivateFile(this.settingsFile)
    try {
      this.settingsValue = parseOriginSettings(JSON.parse(await readFile(this.settingsFile, 'utf8')) as unknown)
    } catch { this.errorCode = 'origin_config_invalid' }
  }

  status(): OriginConfigurationStatus {
    const settings = this.settingsValue
    return Object.freeze({
      configured: settings !== undefined,
      ...(settings === undefined ? {} : {
        publicOrigin: settings.publicOrigin,
        listenHost: settings.listenHost,
        listenPort: settings.listenPort,
        allowedCidrs: settings.allowedCidrs,
        backendOrigin: 'http://' + settings.listenHost + ':' + String(settings.listenPort),
      }),
      storagePath: this.stateRoot,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    })
  }

  settings(): OriginSettings | undefined { return this.settingsValue }

  async configure(value: unknown): Promise<OriginConfigurationStatus> {
    const settings = parseOriginSettings(value)
    await writeManagedPrivateFile(this.ownedRoot, this.settingsFile, JSON.stringify(settings) + '\n', 'origin')
    this.settingsValue = settings
    this.errorCode = undefined
    return this.status()
  }

  async purge(): Promise<OriginConfigurationStatus> {
    await removeManagedTree(this.ownedRoot, this.settingsFile, 'origin')
    this.settingsValue = undefined
    this.errorCode = undefined
    return this.status()
  }
}
