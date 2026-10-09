import { isIP } from './ip.js'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { isGloballyRoutableIpv4 } from './network.js'
import { restrictPrivateFile } from './private-file.js'
import { assertManagedParents, removeManagedPaths, removeManagedTree, writeManagedPrivateFile } from './managed-files.js'
import { createRestrictedFrpServerTemplate, FRP_VHOST_HTTP_PORT, type FrpEntryTls } from './frp-template.js'

const MAX_SETTINGS_BYTES = 8 * 1024

/** How the restricted FRP channel is provisioned on the VPS. */
export type FrpMode = 'deploy' | 'attach'

/** Public entry port used by the self-signed TCP passthrough (never 443 by requirement). */
export const FRP_DEFAULT_PUBLIC_PORT = 33_080

/** Ports owned by other DSH Mobile listeners; the public entry may never reuse them. */
export const FRP_RESERVED_PORTS: readonly number[] = Object.freeze([3080, 3443, 3444])

/** Every key `settings.json` may contain. Unknown keys stay rejected. */
const FRP_SETTINGS_KEYS: ReadonlySet<string> = new Set([
  'version', 'serverAddress', 'serverPort', 'token', 'publicOrigin',
  'mode', 'entryTls', 'vhostHttpPort', 'publicPort',
])

/** Credentials and endpoints required by the restricted FRP provider. */
export interface FrpSettings {
  readonly version: 1
  readonly serverAddress: string
  readonly serverPort: number
  readonly token: string
  readonly publicOrigin: string
  /**
   * `deploy` (default) installs the plugin's own frps on the VPS.
   * `attach` reuses an frps that already runs there and never touches it.
   */
  readonly mode?: FrpMode
  /** `public-ip-cert` (default) or the gateway-terminated `self-signed` passthrough. */
  readonly entryTls?: FrpEntryTls
  /** The real `vhostHTTPPort` of the user's frps; defaults to the upstream 7080. */
  readonly vhostHttpPort?: number
  /** Public entry port of the self-signed TCP proxy; defaults to 33080. */
  readonly publicPort?: number
}

/** Safe FRP configuration fields returned to the desktop UI. */
export interface FrpConfigurationStatus {
  readonly configured: boolean
  readonly serverAddress?: string
  readonly serverPort?: number
  readonly publicOrigin?: string
  readonly vhostHttpPort: number
  readonly storagePath: string
  /** Proxy name frpc registers on the shared frps; unique per DSH installation. */
  readonly proxyName: string
  readonly errorCode?: string
  /** Present only when the saved configuration leaves the upstream `deploy` default. */
  readonly mode?: FrpMode
  /** Present only when the saved configuration uses the self-signed entry. */
  readonly entryTls?: FrpEntryTls
  /** Present only when a non-default public entry port is saved. */
  readonly publicPort?: number
}

function hostname(value: string): boolean {
  if (value.length > 253 || !value.includes('.')) return false
  return value.split('.').every(label => label.length >= 1 && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
}

/** Validate the FRP server hostname or IP address. */
export function validateFrpServerAddress(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length === 0 || value.length > 253
    || /[\s\u0000-\u001f\u007f/\\@?#]/u.test(value)) throw new Error('frp_server_address_invalid')
  const normalized = value.toLowerCase().replace(/\.$/u, '')
  if (isIP(normalized) === 0 && !hostname(normalized)) throw new Error('frp_server_address_invalid')
  return normalized
}

/** Validate the FRP control port. */
export function validateFrpServerPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error('frp_server_port_invalid')
  }
  return Number(value)
}

/** Validate a high-entropy FRP token before durable storage. */
export function validateFrpToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512
    || /[\s\u0000-\u001f\u007f]/u.test(value)) throw new Error('frp_token_invalid')
  return value
}

/** Validate the public HTTPS origin used by Caddy and Android pairing. */
export function validateFrpPublicOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512) throw new Error('frp_public_origin_invalid')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('frp_public_origin_invalid') }
  const publicHost = url.hostname
  if (url.protocol !== 'https:' || url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== ''
    || url.username !== '' || url.password !== '' || (isIP(publicHost) !== 4 && !hostname(publicHost))) {
    throw new Error('frp_public_origin_invalid')
  }
  // Documentation and other non-routable IPv4 literals (e.g. 203.0.113.10)
  // can never be a real VPS endpoint; reject them instead of deploying certs.
  if (isIP(publicHost) === 4 && !isGloballyRoutableIpv4(publicHost)) throw new Error('frp_public_origin_invalid')
  return url.origin
}

/** Validate the provisioning mode. */
export function validateFrpMode(value: unknown): FrpMode {
  if (value !== 'deploy' && value !== 'attach') throw new Error('frp_settings_invalid')
  return value
}

/** Validate the entry TLS mode. */
export function validateFrpEntryTls(value: unknown): FrpEntryTls {
  if (value !== 'public-ip-cert' && value !== 'self-signed') throw new Error('frp_entry_tls_invalid')
  return value
}

function validatePort(value: unknown, rejectReserved: boolean): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error('frp_settings_invalid')
  }
  const port = Number(value)
  if (rejectReserved && FRP_RESERVED_PORTS.includes(port)) throw new Error('frp_settings_invalid')
  return port
}

/** Validate the loopback vhost port of the target frps. */
export function validateFrpVhostHttpPort(value: unknown): number {
  return validatePort(value, false)
}

/** Validate the public entry port of the self-signed TCP proxy. */
export function validateFrpPublicPort(value: unknown): number {
  return validatePort(value, true)
}

/** Effective provisioning mode; an absent field keeps the upstream behaviour. */
export function resolveFrpMode(settings: FrpSettings): FrpMode {
  return settings.mode ?? 'deploy'
}

/** Effective entry TLS mode; an absent field keeps the upstream behaviour. */
export function resolveFrpEntryTls(settings: FrpSettings): FrpEntryTls {
  return settings.entryTls ?? 'public-ip-cert'
}

/** Effective loopback vhost port; an absent field keeps the upstream behaviour. */
export function resolveFrpVhostHttpPort(settings: FrpSettings): number {
  return settings.vhostHttpPort ?? FRP_VHOST_HTTP_PORT
}

/** Effective public entry port of the self-signed passthrough. */
export function resolveFrpPublicPort(settings: FrpSettings): number {
  return settings.publicPort ?? FRP_DEFAULT_PUBLIC_PORT
}

/** Public HTTPS endpoint the user opens, independent of the frps control address. */
export function resolveFrpEntryProbe(settings: FrpSettings): { host: string; port: number } {
  const origin = new URL(frpEntryOrigin(settings))
  return { host: origin.hostname, port: origin.port === '' ? 443 : Number(origin.port) }
}

/** HTTPS origin users actually open; the self-signed TCP entry is not on 443. */
export function frpEntryOrigin(settings: FrpSettings): string {
  if (!isFrpSelfSignedIngress(settings)) return settings.publicOrigin
  return `https://${new URL(settings.publicOrigin).hostname}:${String(resolveFrpPublicPort(settings))}`
}

/** True when the gateway terminates TLS itself behind a raw frps TCP proxy. */
export function isFrpSelfSignedIngress(settings: FrpSettings): boolean {
  return resolveFrpEntryTls(settings) === 'self-signed'
}

/**
 * Parse FRP settings at the loopback request and filesystem boundaries.
 *
 * Optional keys are kept only when supplied, so a legacy `settings.json` still
 * round-trips byte for byte and every default stays the upstream behaviour.
 * Two cross-field rules are enforced here because neither can be recovered later:
 * the self-signed entry is a TCP passthrough and therefore attach-only, and
 * attach mode with a public-CA entry must state the user's real vhost port —
 * silently assuming 7080 would disable the plaintext-exposure gate.
 */
export function parseFrpSettings(value: unknown): FrpSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('frp_settings_invalid')
  const record = value as Record<string, unknown>
  if (Reflect.ownKeys(record).some(key => !FRP_SETTINGS_KEYS.has(String(key)))) {
    throw new Error('frp_settings_invalid')
  }
  if (record.version !== undefined && record.version !== 1) throw new Error('frp_settings_invalid')
  const mode = record.mode === undefined ? undefined : validateFrpMode(record.mode)
  const entryTls = record.entryTls === undefined ? undefined : validateFrpEntryTls(record.entryTls)
  const vhostHttpPort = record.vhostHttpPort === undefined ? undefined : validateFrpVhostHttpPort(record.vhostHttpPort)
  const publicPort = record.publicPort === undefined ? undefined : validateFrpPublicPort(record.publicPort)
  const resolvedMode = mode ?? 'deploy'
  const resolvedEntryTls: FrpEntryTls = entryTls ?? 'public-ip-cert'
  if (resolvedEntryTls === 'self-signed' && resolvedMode !== 'attach') throw new Error('frp_entry_tls_invalid')
  if (resolvedMode === 'attach' && resolvedEntryTls === 'public-ip-cert' && vhostHttpPort === undefined) {
    throw new Error('frp_attach_mode_requires_vhost_port')
  }
  const publicOrigin = validateFrpPublicOrigin(record.publicOrigin)
  if (resolvedEntryTls === 'self-signed' && isIP(new URL(publicOrigin).hostname) !== 4) {
    throw new Error('frp_self_signed_requires_public_ipv4')
  }
  return Object.freeze({
    version: 1,
    serverAddress: validateFrpServerAddress(record.serverAddress),
    serverPort: validateFrpServerPort(record.serverPort),
    token: validateFrpToken(record.token),
    publicOrigin,
    ...(mode === undefined ? {} : { mode }),
    ...(entryTls === undefined ? {} : { entryTls }),
    ...(vhostHttpPort === undefined ? {} : { vhostHttpPort }),
    ...(publicPort === undefined ? {} : { publicPort }),
  })
}

/**
 * Merge a partial VPS request body with the saved configuration so a blank
 * field keeps its saved value ("已保存时可留空"). Every merged field is still
 * validated; with nothing saved and nothing supplied the result reports a
 * missing configuration instead of silently deploying blanks.
 */
export function mergeSavedFrpSettings(
  partial: Readonly<Record<string, unknown>>,
  saved: FrpSettings | undefined,
): FrpSettings {
  const pick = <K extends 'mode' | 'entryTls' | 'vhostHttpPort' | 'publicPort'>(key: K): unknown => {
    const supplied = partial[key]
    if (supplied === '' || supplied === undefined) return saved?.[key]
    return supplied
  }
  const mode = pick('mode')
  const entryTls = pick('entryTls')
  const vhostHttpPort = pick('vhostHttpPort')
  const publicPort = pick('publicPort')
  const merged = {
    serverAddress: partial.serverAddress === '' || partial.serverAddress === undefined
      ? saved?.serverAddress : partial.serverAddress,
    serverPort: typeof partial.serverPort === 'number' && Number.isSafeInteger(partial.serverPort) && partial.serverPort >= 1
      ? partial.serverPort : saved?.serverPort,
    token: partial.token === '' || partial.token === undefined ? saved?.token : partial.token,
    publicOrigin: partial.publicOrigin === '' || partial.publicOrigin === undefined
      ? saved?.publicOrigin : partial.publicOrigin,
    ...(mode === '' || mode === undefined ? {} : { mode }),
    ...(entryTls === '' || entryTls === undefined ? {} : { entryTls }),
    ...(vhostHttpPort === '' || vhostHttpPort === undefined ? {} : { vhostHttpPort }),
    ...(publicPort === '' || publicPort === undefined ? {} : { publicPort }),
  }
  if (merged.serverAddress === undefined && merged.serverPort === undefined
    && merged.token === undefined && merged.publicOrigin === undefined) {
    throw new Error('frp_config_missing')
  }
  return parseFrpSettings(merged)
}

/** Merge a VPS target (address and control port) with the saved configuration. */
export function mergeSavedFrpTarget(
  partial: Readonly<Record<string, unknown>>,
  saved: FrpSettings | undefined,
): { readonly serverAddress: string; readonly serverPort: number } {
  const serverAddress = partial.serverAddress === '' || partial.serverAddress === undefined
    ? saved?.serverAddress : partial.serverAddress
  const serverPort = typeof partial.serverPort === 'number' && Number.isSafeInteger(partial.serverPort) && partial.serverPort >= 1
    ? partial.serverPort : saved?.serverPort
  if (serverAddress === undefined || serverPort === undefined) throw new Error('frp_config_missing')
  return Object.freeze({
    serverAddress: validateFrpServerAddress(serverAddress),
    serverPort: validateFrpServerPort(serverPort),
  })
}

function tomlString(value: string): string {
  return JSON.stringify(value)
}

/**
 * Legacy proxy name, kept only as the default of {@link createFrpcToml}.
 *
 * A shared frps accepts one proxy per name across *all* its clients, so a fixed
 * name let any other DSH installation — or a not yet reaped session of this one —
 * own `dsh-mobile` first. frpc then logged `start error: proxy name [dsh-mobile]
 * is already in use`, kept running without publishing the entry port, and the
 * start-up self-check ended in `frp_start_timeout` ("the public endpoint did not
 * become ready"). Product callers therefore pass an installation-derived name
 * from {@link frpProxyName}; this constant only keeps the exported API and the
 * byte-for-byte compatibility test working for legacy callers.
 */
export const FRP_DEFAULT_PROXY_NAME = 'dsh-mobile'

/**
 * Validate a proxy name for the generated frpc configuration.
 *
 * frps accepts one proxy per name on the whole server, so the name must be a
 * single safe token: no whitespace, no quotes, no path or bracket characters.
 */
export function validateFrpProxyName(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || !/^[A-Za-z0-9._-]+$/u.test(value)) throw new Error('frp_proxy_name_invalid')
  return value
}

/**
 * Proxy name for one DSH installation.
 *
 * Derived from the stable installation identity so two computers sharing one
 * frps never register the same proxy, while a single installation keeps the
 * same name across restarts (so its own stale registration is the only possible
 * conflict, and that one expires with the frps heartbeat).
 */
export function frpProxyName(instanceId: string): string {
  if (typeof instanceId !== 'string' || !/^[a-f0-9]{64}$/u.test(instanceId)) throw new Error('frp_instance_id_invalid')
  return `${FRP_DEFAULT_PROXY_NAME}-${instanceId.slice(0, 12)}`
}

/**
 * Build the single-purpose frpc configuration for the current loopback gateway.
 *
 * The default (public-CA) entry is an HTTP vhost behind Caddy and is emitted byte
 * for byte as before. The self-signed entry cannot use a vhost at all: frps only
 * forwards raw TCP, and the gateway terminates TLS on that connection.
 *
 * `proxyName` defaults to the legacy fixed name only for legacy callers; the
 * provider and the attach preview always pass {@link frpProxyName}.
 */
export function createFrpcToml(
  settings: FrpSettings,
  localPort: number,
  proxyName: string = FRP_DEFAULT_PROXY_NAME,
): string {
  if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535) throw new Error('frp_local_port_invalid')
  const header = [
    `serverAddr = ${tomlString(settings.serverAddress)}`,
    `serverPort = ${String(settings.serverPort)}`,
    'auth.method = "token"',
    `auth.token = ${tomlString(settings.token)}`,
    'transport.tls.enable = true',
    '',
    '[[proxies]]',
    `name = ${tomlString(validateFrpProxyName(proxyName))}`,
  ]
  if (isFrpSelfSignedIngress(settings)) {
    return [
      ...header,
      // Raw TCP passthrough: frps never terminates or inspects TLS. The DSH
      // gateway terminates it and the app pins the gateway CA instead of any
      // public certificate authority.
      'type = "tcp"',
      'localIP = "127.0.0.1"',
      `localPort = ${String(localPort)}`,
      `remotePort = ${String(resolveFrpPublicPort(settings))}`,
      'transport.useEncryption = true',
      'transport.useCompression = true',
      '',
    ].join('\n')
  }
  const hostnameValue = new URL(settings.publicOrigin).hostname
  return [
    ...header,
    'type = "http"',
    'localIP = "127.0.0.1"',
    `localPort = ${String(localPort)}`,
    `customDomains = [${tomlString(hostnameValue)}]`,
    'transport.useEncryption = true',
    'transport.useCompression = true',
    '',
  ].join('\n')
}

/** Build the matching restricted frps and Caddy templates for one VPS. */
export function createFrpServerTemplate(settings: FrpSettings): string {
  return createRestrictedFrpServerTemplate(settings.serverPort, settings.token, settings.publicOrigin, {
    vhostHttpPort: resolveFrpVhostHttpPort(settings),
    entryTls: resolveFrpEntryTls(settings),
  })
}

/** Owns private FRP settings and generation-specific frpc configuration. */
export class FrpConfigStore {
  readonly stateRoot: string
  readonly settingsFile: string
  readonly runtimeConfigFile: string
  /**
   * Proxy name every generated frpc.toml registers.
   *
   * Injected by the composing plugin ({@link frpProxyName}) so one frps can
   * serve several DSH installations; the legacy fixed name stays the default
   * for direct constructions in tests and for the exported API.
   */
  readonly proxyName: string
  private settingsValue: FrpSettings | undefined
  private errorCode: string | undefined

  constructor(stateDirectory: string, proxyName: string = FRP_DEFAULT_PROXY_NAME, private readonly ownedRoot = stateDirectory) {
    if (!isAbsolute(stateDirectory)) throw new Error('frp config state directory must be absolute')
    this.stateRoot = resolve(stateDirectory)
    this.settingsFile = join(this.stateRoot, 'settings.json')
    this.runtimeConfigFile = join(this.stateRoot, 'frpc.toml')
    this.proxyName = validateFrpProxyName(proxyName)
  }

  /** Load private settings while rejecting links, oversized files, and unknown fields. */
  async initialize(): Promise<void> {
    this.settingsValue = undefined
    this.errorCode = undefined
    try { await assertManagedParents(this.ownedRoot, this.settingsFile, 'frp') } catch (_error) {
      this.errorCode = 'frp_config_invalid'
      return
    }
    let entry
    try { entry = await lstat(this.settingsFile) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_SETTINGS_BYTES) {
      this.errorCode = 'frp_config_invalid'
      return
    }
    await restrictPrivateFile(this.settingsFile)
    try {
      this.settingsValue = parseFrpSettings(JSON.parse(await readFile(this.settingsFile, 'utf8')) as unknown)
      this.errorCode = undefined
    } catch {
      this.settingsValue = undefined
      this.errorCode = 'frp_config_invalid'
    }
  }

  /**
   * Return configuration metadata without exposing the FRP token.
   *
   * The optional keys appear only when the saved configuration departs from the
   * upstream defaults, so the pre-existing field set is unchanged for every
   * legacy configuration.
   */
  status(): FrpConfigurationStatus {
    const settings = this.settingsValue
    const mode = settings === undefined ? undefined : resolveFrpMode(settings)
    const entryTls = settings === undefined ? undefined : resolveFrpEntryTls(settings)
    return Object.freeze({
      configured: settings !== undefined,
      ...(settings === undefined ? {} : {
        serverAddress: settings.serverAddress,
        serverPort: settings.serverPort,
        publicOrigin: settings.publicOrigin,
      }),
      vhostHttpPort: settings === undefined ? FRP_VHOST_HTTP_PORT : resolveFrpVhostHttpPort(settings),
      storagePath: this.stateRoot,
      proxyName: this.proxyName,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
      ...(mode === undefined || mode === 'deploy' ? {} : { mode }),
      ...(entryTls === undefined || entryTls === 'public-ip-cert' ? {} : { entryTls }),
      ...(settings?.publicPort === undefined ? {} : { publicPort: settings.publicPort }),
    })
  }

  /** Return private settings only to the provider lifecycle. */
  settings(): FrpSettings | undefined {
    return this.settingsValue
  }

  /** Atomically replace private FRP settings. */
  async configure(value: unknown): Promise<FrpConfigurationStatus> {
    const settings = parseFrpSettings(value)
    await writeManagedPrivateFile(this.ownedRoot, this.settingsFile, `${JSON.stringify(settings)}\n`, 'frp')
    await removeManagedTree(this.ownedRoot, this.runtimeConfigFile, 'frp')
    this.settingsValue = settings
    this.errorCode = undefined
    return this.status()
  }

  /** Materialize the private generation-specific frpc configuration. */
  async writeRuntimeConfig(localPort: number): Promise<string> {
    const settings = this.settingsValue
    if (settings === undefined) throw new Error('frp_config_missing')
    await writeManagedPrivateFile(this.ownedRoot, this.runtimeConfigFile, createFrpcToml(settings, localPort, this.proxyName), 'frp')
    return this.runtimeConfigFile
  }

  /** Remove only configuration files owned by the FRP provider. */
  async purge(): Promise<FrpConfigurationStatus> {
    await removeManagedPaths(this.ownedRoot, [this.settingsFile, this.runtimeConfigFile], 'frp')
    this.settingsValue = undefined
    this.errorCode = undefined
    return this.status()
  }
}

export { FRP_VHOST_HTTP_PORT as DEFAULT_VHOST_HTTP_PORT }
export type { FrpEntryTls } from './frp-template.js'
