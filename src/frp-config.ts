import { randomBytes } from 'node:crypto'
import { isIP } from 'node:net'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { isGloballyRoutableIpv4 } from './network.js'
import { restrictPrivateFile } from './private-file.js'
import { createRestrictedFrpServerTemplate, FRP_VHOST_HTTP_PORT } from './frp-template.js'

const MAX_SETTINGS_BYTES = 8 * 1024

/** Credentials and endpoints required by the restricted FRP provider. */
export interface FrpSettings {
  readonly version: 1
  readonly serverAddress: string
  readonly serverPort: number
  readonly token: string
  readonly publicOrigin: string
}

/** Safe FRP configuration fields returned to the desktop UI. */
export interface FrpConfigurationStatus {
  readonly configured: boolean
  readonly serverAddress?: string
  readonly serverPort?: number
  readonly publicOrigin?: string
  readonly vhostHttpPort: number
  readonly storagePath: string
  readonly errorCode?: string
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

/** Parse FRP settings at the loopback request and filesystem boundaries. */
export function parseFrpSettings(value: unknown): FrpSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('frp_settings_invalid')
  const record = value as Record<string, unknown>
  if (Reflect.ownKeys(record).some(key => !['version', 'serverAddress', 'serverPort', 'token', 'publicOrigin'].includes(String(key)))) {
    throw new Error('frp_settings_invalid')
  }
  if (record.version !== undefined && record.version !== 1) throw new Error('frp_settings_invalid')
  return Object.freeze({
    version: 1,
    serverAddress: validateFrpServerAddress(record.serverAddress),
    serverPort: validateFrpServerPort(record.serverPort),
    token: validateFrpToken(record.token),
    publicOrigin: validateFrpPublicOrigin(record.publicOrigin),
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
  const merged = {
    serverAddress: partial.serverAddress === '' || partial.serverAddress === undefined
      ? saved?.serverAddress : partial.serverAddress,
    serverPort: typeof partial.serverPort === 'number' && Number.isSafeInteger(partial.serverPort) && partial.serverPort >= 1
      ? partial.serverPort : saved?.serverPort,
    token: partial.token === '' || partial.token === undefined ? saved?.token : partial.token,
    publicOrigin: partial.publicOrigin === '' || partial.publicOrigin === undefined
      ? saved?.publicOrigin : partial.publicOrigin,
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

/** Build the single-purpose frpc configuration for the current loopback gateway. */
export function createFrpcToml(settings: FrpSettings, localPort: number): string {
  if (!Number.isSafeInteger(localPort) || localPort < 1 || localPort > 65_535) throw new Error('frp_local_port_invalid')
  const hostnameValue = new URL(settings.publicOrigin).hostname
  return [
    `serverAddr = ${tomlString(settings.serverAddress)}`,
    `serverPort = ${String(settings.serverPort)}`,
    'auth.method = "token"',
    `auth.token = ${tomlString(settings.token)}`,
    'transport.tls.enable = true',
    '',
    '[[proxies]]',
    'name = "dsh-mobile"',
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
  return createRestrictedFrpServerTemplate(settings.serverPort, settings.token, settings.publicOrigin)
}

async function atomicPrivateWrite(file: string, body: string): Promise<void> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    const current = await lstat(file)
    if (!current.isFile() || current.isSymbolicLink()) throw new Error('frp_config_target_invalid')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(directory, `.${basename(file)}.${randomBytes(12).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
    await restrictPrivateFile(file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Owns private FRP settings and generation-specific frpc configuration. */
export class FrpConfigStore {
  readonly stateRoot: string
  readonly settingsFile: string
  readonly runtimeConfigFile: string
  private settingsValue: FrpSettings | undefined
  private errorCode: string | undefined

  constructor(stateDirectory: string) {
    if (!isAbsolute(stateDirectory)) throw new Error('frp config state directory must be absolute')
    this.stateRoot = resolve(stateDirectory)
    this.settingsFile = join(this.stateRoot, 'settings.json')
    this.runtimeConfigFile = join(this.stateRoot, 'frpc.toml')
  }

  /** Load private settings while rejecting links, oversized files, and unknown fields. */
  async initialize(): Promise<void> {
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

  /** Return configuration metadata without exposing the FRP token. */
  status(): FrpConfigurationStatus {
    const settings = this.settingsValue
    return Object.freeze({
      configured: settings !== undefined,
      ...(settings === undefined ? {} : {
        serverAddress: settings.serverAddress,
        serverPort: settings.serverPort,
        publicOrigin: settings.publicOrigin,
      }),
      vhostHttpPort: FRP_VHOST_HTTP_PORT,
      storagePath: this.stateRoot,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    })
  }

  /** Return private settings only to the provider lifecycle. */
  settings(): FrpSettings | undefined {
    return this.settingsValue
  }

  /** Atomically replace private FRP settings. */
  async configure(value: unknown): Promise<FrpConfigurationStatus> {
    const settings = parseFrpSettings(value)
    await atomicPrivateWrite(this.settingsFile, `${JSON.stringify(settings)}\n`)
    await rm(this.runtimeConfigFile, { force: true })
    this.settingsValue = settings
    this.errorCode = undefined
    return this.status()
  }

  /** Materialize the private generation-specific frpc configuration. */
  async writeRuntimeConfig(localPort: number): Promise<string> {
    const settings = this.settingsValue
    if (settings === undefined) throw new Error('frp_config_missing')
    await atomicPrivateWrite(this.runtimeConfigFile, createFrpcToml(settings, localPort))
    return this.runtimeConfigFile
  }

  /** Remove only configuration files owned by the FRP provider. */
  async purge(): Promise<FrpConfigurationStatus> {
    await rm(this.stateRoot, { recursive: true, force: true })
    this.settingsValue = undefined
    this.errorCode = undefined
    return this.status()
  }
}

export { FRP_VHOST_HTTP_PORT as DEFAULT_VHOST_HTTP_PORT }
