import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-mobile': {
      kind: 'plugin:dsh-mobile'
      form: 'notice'
      summary: string
    }
  }
}
// Side-effect type import: activates dsh-commands' Context augmentation so
// `ctx.commands` and its handler types resolve without a runtime dependency.
import type {} from '@deepseek-ai/dsh-commands'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage } from 'node:http'
import { createRequire } from 'node:module'
import { X509Certificate } from 'node:crypto'
import { copyFile, lstat, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseControlFile, parseGatewayConfig, type PluginConfig, type ResolvedGatewayConfig } from './config.js'
import { collectConnectionDiagnostics, hasCompetingRemoteChannelBoot } from './diagnostics.js'
import { buildMobileGuide, type MobileGuideState } from './mobile-guide.js'
import { createVpsUninstallScript, deployVps, fetchVpsHostKeys, parseVpsDeploymentInput, uninstallVps } from './vps-deploy.js'
import { TaskEventHub, watchTaskCompletions } from './task-events.js'
import {
  FollowingMobileAccessRuntime,
  JsonMobileAccessControlStore,
  MobileAccessGatewayController,
  type MobileAccessRuntime,
} from './control.js'
import { MobileAccessGateway } from './gateway.js'
import { createMobileAccessService, type MobileAccessService } from './extensions.js'
import { listComputerImages, readComputerImage } from './computer-images.js'
import {
  HttpError,
  LOCAL_ADMIN_PREFIX,
  assertLocalAdminTrust,
  parseRequestTarget,
  readJsonObject,
  sendFailure,
  sendJson,
} from './http-security.js'
import { JsonDeviceStore } from './storage.js'
import { BlockedUpgradePathLog, WebSocketPathStore } from './websocket-paths.js'
import { FunnelController, funnelExecutable } from './funnel.js'
import { CpolarController } from './cpolar.js'
import { CpolarComponentManager, type CpolarComponentStatus } from './cpolar-component.js'
import { CloudflaredComponentManager, type CloudflaredComponentStatus } from './cloudflared-component.js'
import { CloudflaredController } from './cloudflared.js'
import {
  CloudflaredTunnelStore,
  mergeSavedCloudflaredTunnelSettings,
  type CloudflaredTunnelStatus,
} from './cloudflared-tunnel.js'
import { FrpComponentManager, type FrpComponentStatus } from './frp-component.js'
import {
  FrpConfigStore,
  isFrpSelfSignedIngress,
  mergeSavedFrpSettings,
  mergeSavedFrpTarget,
  resolveFrpPublicPort,
  resolveFrpVhostHttpPort,
  type FrpConfigurationStatus,
  type FrpSettings,
} from './frp-config.js'
import { createFrpAttachTemplate } from './frp-attach.js'
import { createFrpAttachPlan } from './frp-attach-plan.js'
import { defaultProbeDiscovery, FrpController } from './frp.js'
import { ensureFrpIngressCertificate, frpIngressPaths, frpIngressSelfCheck, purgeFrpIngressCertificates, type FrpIngressCertificate } from './frp-ingress.js'
import { OriginConfigStore, parseOriginSettings, validateOriginListenPort, type OriginConfigurationStatus, type OriginSettings } from './origin-proxy-config.js'
import { OriginController } from './origin-proxy.js'
import { PluginReleaseManager, releaseProfileDirectory } from './release-update.js'
import { installMobileFileLogger } from './file-logger.js'
import {
  configuredRemoteProvider,
  JsonRemoteProviderStore,
  RemoteProviderCoordinator,
  REMOTE_PROVIDERS,
  type RemoteProvider,
  type RemoteProviderController,
  type RemoteProviderStatus,
} from './remote.js'
import { parseAuthority, parseCidr, probeTcpReachable } from './network.js'
import {
  availableLanNetworks,
  isNetworkSelectionError,
  materializeManagedSetup,
  parseManagedSetup,
  preferredLanInterfaceNames,
  selectLanNetwork,
  type ManagedSetup,
} from './managed-setup.js'
import { prepareManagedLanSetup, type ManagedLanSetupResult } from './lan-setup.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-mobile'

/** The stock WebServer serves the control card; Connection authenticates the loopback DSH origin. */
export const inject = ['webServer', 'commands', 'connection']

/** Run cleanup steps in ownership order and report every failure after all steps settle. */
export async function settleCleanupSteps(steps: readonly (() => void | Promise<void>)[]): Promise<void> {
  const errors: unknown[] = []
  for (const step of steps) {
    try { await step() } catch (error) { errors.push(error) }
  }
  if (errors.length === 1 && errors[0] instanceof Error) throw errors[0]
  if (errors.length > 0) throw new AggregateError(errors, 'DSH Mobile cleanup failed')
}

interface BrowserAuthenticatedConnection {
  authenticatedUrl?: (baseUrl: string) => string
  requestRejection?: (request: IncomingMessage) => 401 | 403 | undefined
}

/**
 * Resolve the DSH launch-token URL the gateway exchanges for its upstream cookie.
 *
 * A layer that disables DSH browser authentication — dsh-lan-access with
 * `noAuth: true` replaces `authenticatedUrl` with one returning the bare origin
 * — produces a URL with no query string, so it cannot carry a launch token. That
 * is a legitimate "this upstream needs no browser auth" signal: report no URL and
 * the gateway proxies without a cookie instead of failing every route with
 * `upstream_unavailable`. A token-bearing URL keeps the existing exchange, and a
 * connection service that is absent or returns a malformed URL keeps failing
 * closed. Only parsing is guarded: a connection service that throws still fails
 * plugin activation loudly rather than silently proxying without authentication.
 */
export function upstreamAuthenticatedUrl(ctx: Context, upstreamOrigin: URL): string | undefined {
  const connection = (ctx as Context & { readonly connection?: BrowserAuthenticatedConnection }).connection
  if (typeof connection?.authenticatedUrl !== 'function') return undefined
  const authenticatedUrl = connection.authenticatedUrl(upstreamOrigin.origin)
  try {
    return new URL(authenticatedUrl).search === '' ? undefined : authenticatedUrl
  } catch {
    return undefined
  }
}

function installedDshVersion(): string {
  try {
    const manifest = createRequire(import.meta.url)('@deepseek-ai/dsh-host-webserver/package.json') as unknown
    if (manifest === null || typeof manifest !== 'object') return 'unknown'
    const version = (manifest as { readonly version?: unknown }).version
    return typeof version === 'string' && version !== '' ? version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function mapAdminError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  const code = (error as NodeJS.ErrnoException).code
  if (error instanceof Error && error.message.includes('spawn UNKNOWN')) {
    return new HttpError(409, 'frp_component_launch_failed')
  }
  if (code === 'EADDRNOTAVAIL') return new HttpError(409, 'network_address_changed')
  if (code === 'EADDRINUSE') return new HttpError(409, 'listen_port_in_use')
  if (error instanceof Error && error.message.startsWith('saved LAN interface ')) {
    return new HttpError(409, 'network_interface_unavailable')
  }
  if (error instanceof Error && error.message === 'cpolar_authtoken_invalid') {
    return new HttpError(400, 'cpolar_authtoken_invalid')
  }
  if (error instanceof Error && error.message.startsWith('cpolar_')) {
    return new HttpError(409, error.message)
  }
  // Component download and hash failures carry their own stable code, so the panel can show why an
  // install failed instead of a generic server error.
  if (error instanceof Error && error.message.startsWith('cloudflared_')) {
    return new HttpError(409, error.message)
  }
  if (error instanceof Error && [
    'frp_server_address_invalid',
    'frp_server_port_invalid',
    'frp_token_invalid',
    'frp_public_origin_invalid',
    'frp_settings_invalid',
  ].includes(error.message)) return new HttpError(400, error.message)
  // Attach-mode codes are environment/precondition conflicts by design:
  // `frp_attach_mode_requires_vhost_port` (the user's frps port is unknown),
  // `frp_attach_cert_unknown` (the ingress certificate is missing or unusable),
  // and `frp_entry_tls_invalid` (the requested entry mode cannot be provisioned)
  // all map to 409 here, while a reachable plaintext vhost keeps the upstream
  // `frp_vhost_publicly_reachable` / `frp_vhost_probe_failed` codes.
  if (error instanceof Error && error.message.startsWith('frp_')) {
    return new HttpError(409, error.message)
  }
  if (error instanceof Error && [
    'origin_settings_invalid', 'origin_public_origin_invalid', 'origin_listen_host_invalid',
    'origin_listen_port_invalid', 'origin_listen_port_reserved', 'origin_allowed_cidrs_invalid',
  ].includes(error.message)) return new HttpError(400, error.message)
  if (error instanceof Error && error.message.startsWith('origin_')) {
    return new HttpError(409, error.message)
  }
  if (error instanceof Error && error.message.startsWith('vps_')) {
    return new HttpError(409, error.message)
  }
  if (error instanceof Error && error.message === 'plugin_update_failed') {
    return new HttpError(500, error.message)
  }
  if (error instanceof Error && error.message.startsWith('plugin_update_')) {
    return new HttpError(409, error.message)
  }
  if (error instanceof Error && error.message.startsWith('lan_setup_')) {
    return new HttpError(409, error.message)
  }
  return new HttpError(500, 'internal_error')
}

const SETUP_KEYS = new Set([
  'version', 'publicOrigin', 'listenHost', 'listenPort', 'upstreamOrigin',
  'publicAuthorities', 'allowedCidrs', 'instanceId', 'pairingCaFile', 'tls',
])

/** True when path names a regular file (not a directory or symlink). */
async function existsRegularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

type LoadedSetup = {
  readonly kind: 'fixed'
  readonly config: PluginConfig
} | {
  readonly kind: 'unconfigured'
  readonly config: PluginConfig
  readonly setupFile: string
} | {
  readonly kind: 'managed'
  readonly config: PluginConfig
  readonly setup: ManagedSetup
}

function withoutSetupKeys(config: PluginConfig): PluginConfig {
  const merged = { ...config } as Record<string, unknown>
  for (const key of SETUP_KEYS) if (key !== 'version') delete merged[key]
  return merged as unknown as PluginConfig
}

async function loadSetup(config: PluginConfig): Promise<LoadedSetup> {
  if (config.setupFile === undefined) return { kind: 'fixed', config }
  if (!isAbsolute(config.setupFile)) throw new Error('setupFile must be an absolute file path')
  let source: string
  try {
    source = await readFile(resolve(config.setupFile), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'unconfigured', config, setupFile: resolve(config.setupFile) }
    }
    throw error
  }
  let parsed: unknown
  try { parsed = JSON.parse(source) as unknown }
  catch (error) { throw new Error('mobile setup file is not valid JSON', { cause: error }) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('mobile setup file must be an object')
  }
  const record = parsed as Record<string, unknown>
  if (record.version === 2) {
    return { kind: 'managed', config: withoutSetupKeys(config), setup: parseManagedSetup(record) }
  }
  if (record.version !== 1 || Reflect.ownKeys(record).some(key => typeof key !== 'string' || !SETUP_KEYS.has(key))) {
    throw new Error('mobile setup file has an unsupported format')
  }
  const { version: _version, ...setup } = record
  delete setup.upstreamOrigin
  return {
    kind: 'fixed',
    config: { ...withoutSetupKeys(config), ...setup } as unknown as PluginConfig,
  }
}

function loopbackTemplate(loaded: LoadedSetup, webServerPort: number): ResolvedGatewayConfig {
  const base = withoutSetupKeys(loaded.config)
  const activeUpstreamOrigin = `http://127.0.0.1:${String(webServerPort)}`
  return parseGatewayConfig({
    ...base,
    ...(loaded.kind === 'managed'
      ? { upstreamOrigin: activeUpstreamOrigin }
      : { upstreamOrigin: loaded.config.upstreamOrigin ?? activeUpstreamOrigin }),
    listenHost: '127.0.0.1',
    listenPort: 0,
    publicAuthorities: ['127.0.0.1'],
    allowedCidrs: ['127.0.0.0/8'],
    tls: { mode: 'disabled' },
  })
}

async function stableInstanceId(loaded: LoadedSetup, template: ResolvedGatewayConfig): Promise<string> {
  if (loaded.kind !== 'managed') return loaded.config.instanceId ?? template.instanceId
  const certificate = new X509Certificate(await readFile(loaded.setup.tls.caCertFile))
  return certificate.fingerprint256.replaceAll(':', '').toLowerCase()
}

export function remoteGatewayConfig(
  template: ResolvedGatewayConfig,
  publicOrigin: string,
  stateFile: string,
  instanceId: string,
  listenPort = 0,
): ResolvedGatewayConfig {
  const origin = new URL(publicOrigin)
  if (origin.protocol !== 'https:' || origin.username !== '' || origin.password !== ''
    || origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
    throw new Error('remote public origin must be an HTTPS origin')
  }
  // The gateway listens on an ephemeral loopback port behind Funnel, while the
  // public authority is HTTPS on 443. Keep that external port explicit so the
  // trust policy never substitutes the private listener port into QR URLs.
  const publicAuthority = origin.port === '' ? `${origin.hostname}:443` : origin.host
  const { pairingCaFile: _pairingCaFile, ...shared } = template
  return Object.freeze({
    ...shared,
    listenHost: '127.0.0.1',
    listenPort,
    authorities: Object.freeze([parseAuthority(publicAuthority)]),
    allowedCidrs: Object.freeze([parseCidr('127.0.0.0/8')]),
    stateFile,
    instanceId,
    tls: Object.freeze({ mode: 'disabled' }),
    publicTls: true,
    discovery: false,
  })
}

/**
 * Gateway config for the self-signed FRP ingress.
 *
 * Unlike {@link remoteGatewayConfig}, the gateway itself is the TLS endpoint:
 * frps only forwards raw TCP, so the listener speaks HTTPS with the leaf that
 * `pairingCaFile` signed, and the pairing CA is deliberately retained so the
 * gateway can serve `GET /mobile-access/ca.cer` for the app to pin. The listener
 * stays on loopback because the public entry is the frps TCP proxy, never a
 * direct bind.
 */
export function frpIngressGatewayConfig(
  template: ResolvedGatewayConfig,
  settings: FrpSettings,
  stateFile: string,
  ingress: Pick<FrpIngressCertificate, 'paths' | 'caFingerprint'>,
  listenPort = 0,
): ResolvedGatewayConfig {
  if (!isFrpSelfSignedIngress(settings)) throw new Error('frp_entry_tls_invalid')
  const publicHost = new URL(settings.publicOrigin).hostname
  const publicAuthority = `${publicHost}:${String(resolveFrpPublicPort(settings))}`
  const { pairingCaFile: _templateCaFile, ...shared } = template
  return Object.freeze({
    ...shared,
    listenHost: '127.0.0.1',
    listenPort,
    authorities: Object.freeze([parseAuthority(publicAuthority)]),
    // Only frpc originates the connection, from the same computer.
    allowedCidrs: Object.freeze([parseCidr('127.0.0.0/8')]),
    stateFile,
    // The app validates `instance` against the CA it pins (gateway.ts checks the
    // same fingerprint), so this channel must use the CA fingerprint, not the
    // plugin-wide installation id.
    instanceId: ingress.caFingerprint,
    pairingCaFile: ingress.paths.caCertFile,
    tls: Object.freeze({ mode: 'provided', certFile: ingress.paths.certFile, keyFile: ingress.paths.keyFile }),
    publicTls: true,
    discovery: false,
  })
}

/**
 * CA the FRP start-up self-check must pin, read from the ingress directory.
 *
 * The self-signed entry presents a leaf signed by this CA, which is absent from
 * the system trust store, so the probe must anchor it exactly as the app does
 * when it pins `pairingCaFile`. The public-CA entry answers with a publicly
 * trusted certificate and therefore returns `undefined` (system trust store).
 * An unreadable self-signed CA fails explicitly: falling back to the system
 * trust store would hide a broken pairing identity behind a start timeout.
 */
export async function readFrpIngressTrustAnchor(settings: FrpSettings, stateFile: string): Promise<string | undefined> {
  if (!isFrpSelfSignedIngress(settings)) return undefined
  try { return await readFile(frpIngressPaths(stateFile).caCertFile, 'utf8') } catch (error) {
    throw new Error('frp_ingress_ca_invalid', { cause: error })
  }
}

/** Reuse remote HTTPS policy while binding a separately validated private HTTP origin. */
export function originGatewayConfig(
  template: ResolvedGatewayConfig,
  settings: OriginSettings,
  stateFile: string,
  instanceId: string,
  listenPort = settings.listenPort,
): ResolvedGatewayConfig {
  const validated = parseOriginSettings(settings)
  // Port zero is available only to in-process tests, never to saved settings.
  if (listenPort !== 0) validateOriginListenPort(listenPort)
  return Object.freeze({
    ...remoteGatewayConfig(template, validated.publicOrigin, stateFile, instanceId, listenPort),
    listenHost: validated.listenHost,
    allowedCidrs: Object.freeze(validated.allowedCidrs.map(parseCidr)),
  })
}

function remoteControlPayload(
  provider: RemoteProvider,
  status: RemoteProviderStatus,
  gateway: MobileAccessGateway | undefined,
  providerStatuses: Readonly<Record<RemoteProvider, RemoteProviderStatus>>,
  cpolarComponent: CpolarComponentStatus,
  cloudflaredComponent: CloudflaredComponentStatus,
  cloudflaredConfiguration: CloudflaredTunnelStatus,
  frpComponent: FrpComponentStatus,
  frpConfiguration: FrpConfigurationStatus,
  originConfiguration: OriginConfigurationStatus,
): Record<string, unknown> {
  return {
    provider,
    running: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.backendOrigin === undefined ? {} : { backendOrigin: status.backendOrigin }),
    ...(status.loginUrl === undefined ? {} : { loginUrl: status.loginUrl }),
    ...(status.setupUrl === undefined ? {} : { setupUrl: status.setupUrl }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
    ...(gateway === undefined ? {} : { extensions: gateway.extensionStatus() }),
    providers: {
      tailscale: { bundled: true, running: providerStatuses.tailscale.enabled, state: providerStatuses.tailscale.state },
      cpolar: {
        bundled: false,
        running: providerStatuses.cpolar.enabled,
        state: providerStatuses.cpolar.state,
        component: cpolarComponent,
      },
      cloudflared: {
        bundled: false,
        running: providerStatuses.cloudflared.enabled,
        state: providerStatuses.cloudflared.state,
        component: cloudflaredComponent,
        configuration: cloudflaredConfiguration,
      },
      frp: {
        bundled: false,
        running: providerStatuses.frp.enabled,
        state: providerStatuses.frp.state,
        component: frpComponent,
        configuration: frpConfiguration,
      },
      origin: {
        bundled: true,
        running: providerStatuses.origin.enabled,
        state: providerStatuses.origin.state,
        configuration: originConfiguration,
      },
    },
  }
}

/** Mount the resident control route and its optional authenticated LAN gateway. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  const dshVersion = installedDshVersion()
  const loaded = await loadSetup(config)
  const mobileAccess: MobileAccessService = createMobileAccessService(ctx)
  const template = loopbackTemplate(loaded, ctx.webServer.port)
  const upstreamLoginUrl = upstreamAuthenticatedUrl(ctx, template.upstreamOrigin)
  const instanceId = await stableInstanceId(loaded, template)
  const stateDirectory = dirname(template.stateFile)
  const logFile = await installMobileFileLogger(ctx, stateDirectory)
  const logger = ctx.logger('dsh-mobile')
  logger.info('logging initialized file=%s', logFile)
  // Completed root turns fan out to every live mobile gateway, whose phones
  // render the notification text locally. One subscription serves all paths.
  const taskEventHub = new TaskEventHub()
  const disposeTaskEvents = watchTaskCompletions(ctx, {
    onTaskCompleted: event => taskEventHub.broadcast(event),
    log(event, fields) { logger.info('task event=%s fields=%o', event, fields) },
  })
  const remoteDirectory = join(stateDirectory, 'remote')
  const configuredDshHome = process.env.DSH_HOME?.trim()
  const dshHome = configuredDshHome === undefined || configuredDshHome === ''
    ? dirname(stateDirectory)
    : resolve(configuredDshHome)
  const releaseManager = new PluginReleaseManager({
    profileDirectory: releaseProfileDirectory(ctx, dshHome, process.argv.slice(2)),
  })
  const remoteProviderStore = new JsonRemoteProviderStore(
    join(remoteDirectory, 'provider.json'),
    configuredRemoteProvider(process.env),
  )
  const initialRemoteProvider = (await remoteProviderStore.load()).provider
  const cpolarComponent = new CpolarComponentManager({ stateDirectory })
  await cpolarComponent.initialize()
  const cloudflaredComponent = new CloudflaredComponentManager({ stateDirectory })
  await cloudflaredComponent.initialize()
  const frpComponent = new FrpComponentManager({ stateDirectory })
  await frpComponent.initialize()
  const frpConfig = new FrpConfigStore(join(remoteDirectory, 'frp', 'config'))
  await frpConfig.initialize()
  const originConfig = new OriginConfigStore(join(remoteDirectory, 'origin', 'config'))
  await originConfig.initialize()
  const cloudflaredTunnel = new CloudflaredTunnelStore(join(remoteDirectory, 'cloudflared'))
  await cloudflaredTunnel.initialize()
  const unregisterBuiltin = mobileAccess.registerExtension({
    schemaVersion: 1,
    id: 'computer-images',
    name: 'Computer images',
    version: '1.0.0',
    description: 'Authenticated computer-side image browser',
    routes: [
      {
        method: 'GET', path: 'list',
        async handle(request) {
          return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(await listComputerImages(request.query.get('path'))) }
        },
      },
      {
        method: 'GET', path: 'image',
        async handle(request) {
          const image = await readComputerImage(request.query.get('path'))
          return { status: 200, contentType: image.contentType, headers: { 'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.name)}` }, body: image.body }
        },
      },
    ],
  })
  // One upgrade-path policy shared by the LAN gateway and every remote
  // gateway: admin approvals apply immediately, no restart required.
  const webSocketPaths = new WebSocketPathStore(join(stateDirectory, 'websocket-paths.json'))
  await webSocketPaths.load()
  const blockedUpgradePaths = new BlockedUpgradePathLog()
  let lanGateway: MobileAccessGateway | undefined
  let preparedLanSetup: ManagedLanSetupResult | undefined
  const startGateway = async (candidateConfig: PluginConfig): Promise<MobileAccessRuntime> => {
    const resolved = parseGatewayConfig({
      ...candidateConfig,
      upstreamOrigin: template.upstreamOrigin.origin,
    })
    const candidate = new MobileAccessGateway(
      resolved,
      new JsonDeviceStore(resolved.stateFile, resolved.maxDevices),
      mobileAccess,
      upstreamLoginUrl,
      webSocketPaths,
      blockedUpgradePaths,
      (source, code) => { logger.warn('%s discovery degraded while DSH remains available: %s', source, code) },
    )
    await candidate.start()
    lanGateway = candidate
    const removeTaskSink = taskEventHub.add(candidate)
    return {
      close: async () => {
        if (lanGateway === candidate) lanGateway = undefined
        removeTaskSink()
        await candidate.close()
      },
    }
  }
  const startRuntime = async (): Promise<MobileAccessRuntime> => {
    if (loaded.kind === 'unconfigured') throw new Error(preparedLanSetup === undefined ? 'lan_setup_required' : 'lan_setup_restart_required')
    if (loaded.kind === 'fixed') return startGateway(loaded.config)
    const following = new FollowingMobileAccessRuntime(async () => {
      const network = selectLanNetwork(undefined, loaded.setup.networkInterface)
      return {
        key: `${network.name}\0${network.address}\0${network.cidr}`,
        start: async () => startGateway({
          ...loaded.config,
          ...await materializeManagedSetup(loaded.setup),
        }),
      }
    }, (error) => {
      process.emitWarning(`DSH Mobile could not follow the current LAN address: ${error instanceof Error ? error.message : String(error)}`, {
        code: 'DSH_MOBILE_NETWORK_REFRESH',
      })
    })
    try {
      await following.initialize(2_000)
    } catch (error) {
      // A missing saved interface (Wi-Fi/Ethernet switch, docked laptop…)
      // must not take down all of DSH: stay dormant with the poller armed so
      // a returning network recovers on its own. Anything else is a real
      // failure and still fails boot loudly.
      if (!isNetworkSelectionError(error)) throw error
      const detail = error instanceof Error ? error.message : String(error)
      process.emitWarning(
        `DSH Mobile: ${detail}; mobile access stays dormant until the network returns or setup is re-run — DSH itself keeps running.`,
        { code: 'DSH_MOBILE_NETWORK_UNAVAILABLE' },
      )
      following.beginPolling(2_000)
    }
    return following
  }
  const lanControlFile = parseControlFile(config.controlFile)
  const lanControlStore = new JsonMobileAccessControlStore(lanControlFile, config.initiallyEnabled)
  if (loaded.kind === 'unconfigured' && (await lanControlStore.load()).enabled) {
    await lanControlStore.save({ version: 1, enabled: false })
  }
  const lanController = new MobileAccessGatewayController(lanControlStore, startRuntime)
  const remoteDeviceFile = join(remoteDirectory, 'devices.json')
  const legacyCpolarDeviceFile = join(remoteDirectory, 'cpolar', 'devices.json')
  if (initialRemoteProvider === 'cpolar') {
    try {
      await lstat(remoteDeviceFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try { await copyFile(legacyCpolarDeviceFile, remoteDeviceFile) } catch (copyError) {
        if ((copyError as NodeJS.ErrnoException).code !== 'ENOENT') throw copyError
      }
    }
  }
  const createRemoteGateway = async (publicOrigin: string, listenPort = 0): Promise<MobileAccessGateway> => {
      const resolved = remoteGatewayConfig(
        template,
        publicOrigin,
        remoteDeviceFile,
        instanceId,
        listenPort,
      )
      const candidate = new MobileAccessGateway(
        resolved,
        new JsonDeviceStore(resolved.stateFile, resolved.maxDevices),
        mobileAccess,
        upstreamLoginUrl,
        webSocketPaths,
        blockedUpgradePaths,
      )
      await candidate.start()
      return candidate
  }
  /**
   * Gateway factory for the FRP provider.
   *
   * The public-CA entry keeps the ordinary Caddy-fronted remote gateway. The
   * self-signed entry terminates TLS inside the gateway, so it first materializes
   * a leaf the pairing CA signed for the public IPv4 and then binds the ingress
   * configuration that keeps that CA pinned.
   */
  const createFrpGateway = async (publicOrigin: string, settings: FrpSettings): Promise<MobileAccessGateway> => {
    if (!isFrpSelfSignedIngress(settings)) return createRemoteGateway(publicOrigin)
    const ingress = await ensureFrpIngressCertificate(settings, remoteDeviceFile)
    const resolved = frpIngressGatewayConfig(template, settings, remoteDeviceFile, ingress)
    const candidate = new MobileAccessGateway(
      resolved,
      new JsonDeviceStore(resolved.stateFile, resolved.maxDevices),
      mobileAccess,
      upstreamLoginUrl,
      webSocketPaths,
      blockedUpgradePaths,
    )
    try { await candidate.start() } catch (error) {
      await candidate.close()
      throw error
    }
    return candidate
  }
  const createOriginGateway = async (settings: OriginSettings): Promise<MobileAccessGateway> => {
    const resolved = originGatewayConfig(template, settings, remoteDeviceFile, instanceId)
    const candidate = new MobileAccessGateway(
      resolved, new JsonDeviceStore(resolved.stateFile, resolved.maxDevices), mobileAccess,
      upstreamLoginUrl, webSocketPaths, blockedUpgradePaths,
    )
    try { await candidate.start() } catch (error) {
      await candidate.close()
      throw error
    }
    return candidate
  }
  const tailscaleStore = new JsonMobileAccessControlStore(join(remoteDirectory, 'control.json'), false)
  const cpolarStore = new JsonMobileAccessControlStore(join(remoteDirectory, 'cpolar', 'control.json'), false)
  const cloudflaredStore = new JsonMobileAccessControlStore(join(remoteDirectory, 'cloudflared', 'control.json'), false)
  const frpStore = new JsonMobileAccessControlStore(join(remoteDirectory, 'frp', 'control.json'), false)
  const originStore = new JsonMobileAccessControlStore(join(remoteDirectory, 'origin', 'control.json'), false)
  const remoteControllers: Record<RemoteProvider, RemoteProviderController> = {
    tailscale: new FunnelController({
      store: tailscaleStore,
      executable: funnelExecutable(import.meta.url),
      stateDirectory: join(remoteDirectory, 'tailscale'),
      hostname: `dsh-${instanceId.slice(0, 12)}`,
      createGateway: createRemoteGateway,
    }),
    cpolar: new CpolarController({
      store: cpolarStore,
      executable: cpolarComponent.executable,
      configFile: cpolarComponent.configFile,
      createGateway: createRemoteGateway,
    }),
    cloudflared: new CloudflaredController({
      store: cloudflaredStore,
      executable: cloudflaredComponent.executable,
      tunnel: cloudflaredTunnel,
      createGateway: createRemoteGateway,
    }),
    frp: new FrpController({
      store: frpStore,
      executable: frpComponent.executable,
      config: frpConfig,
      instanceId,
      createGateway: createFrpGateway,
      /**
       * Hand the start-up self-check the CA the app itself pins.
       *
       * Only this module knows where the ingress material lives, so the anchor is
       * read here from the ingress directory instead of being guessed downstream.
       */
      resolveDiscoveryTrustAnchor: settings => readFrpIngressTrustAnchor(settings, remoteDeviceFile),
      maintainIngressCertificate: async (settings, gateway) => {
        await ensureFrpIngressCertificate(settings, remoteDeviceFile, Date.now(), gateway.config.instanceId)
        await gateway.refreshProvidedTls()
      },
    }),
    origin: new OriginController({ store: originStore, config: originConfig, createGateway: createOriginGateway }),
  }
  const remoteProviders = new RemoteProviderCoordinator(initialRemoteProvider, remoteControllers, remoteProviderStore)
  const remoteController = () => remoteProviders.controller()
  // Remote gateways rotate inside their controllers; forward through the
  // current instance so stale gateways never receive events.
  for (const provider of REMOTE_PROVIDERS) {
    const controller = remoteControllers[provider]
    taskEventHub.add({ broadcastTaskEvent: event => { controller.gateway()?.broadcastTaskEvent(event) } })
  }
  const remotePayload = (): Record<string, unknown> => remoteControlPayload(
    remoteProviders.selected,
    remoteController().status(),
    remoteController().gateway(),
    {
      tailscale: remoteControllers.tailscale.status(),
      cpolar: remoteControllers.cpolar.status(),
      cloudflared: remoteControllers.cloudflared.status(),
      frp: remoteControllers.frp.status(),
      origin: remoteControllers.origin.status(),
    },
    cpolarComponent.status(),
    cloudflaredComponent.status(),
    cloudflaredTunnel.status(),
    frpComponent.status(),
    frpConfig.status(),
    originConfig.status(),
  )
  const lanPayload = (): Record<string, unknown> => ({
    ...(loaded.kind === 'unconfigured' ? {
      configured: preparedLanSetup !== undefined,
      restartRequired: preparedLanSetup !== undefined,
    } : {}),
    running: lanController.isRunning(),
    origin: lanGateway?.address().origin,
    ...(preparedLanSetup === undefined ? {} : { pendingOrigin: preparedLanSetup.origin }),
    ...(lanGateway === undefined ? {} : { extensions: lanGateway.extensionStatus() }),
  })
  const lanSetupPayload = async (): Promise<Record<string, unknown>> => {
    if (loaded.kind !== 'unconfigured' || preparedLanSetup !== undefined) return lanPayload()
    const networks = availableLanNetworks()
    const preferred = await preferredLanInterfaceNames()
    let recommendedAddress: string | undefined
    try { recommendedAddress = selectLanNetwork(undefined, undefined, undefined, preferred).address } catch { /* user chooses when selection is ambiguous */ }
    return {
      ...lanPayload(),
      networks: networks.map(network => ({
        name: network.name,
        address: network.address,
        cidr: network.cidr,
        recommended: network.address === recommendedAddress,
      })),
      listenPort: 3443,
      windowsFirewall: process.platform === 'win32',
    }
  }
  const diagnosticsPayload = async (): Promise<Record<string, unknown>> => {
    let interfaceName: string | undefined
    let networkError: string | undefined
    if (loaded.kind === 'managed') {
      try { interfaceName = selectLanNetwork(undefined, loaded.setup.networkInterface).name }
      catch { networkError = 'network_interface_unavailable' }
    }
    const remote = remoteController().status()
    const frpOrigin = remote.origin
    const frpSettings = remoteProviders.selected === 'frp' ? frpConfig.settings() : undefined
    const frpGateway = remoteControllers.frp.gateway()
    const pinnedFrpProbe = frpSettings !== undefined && isFrpSelfSignedIngress(frpSettings)
      && frpGateway !== undefined && frpOrigin !== undefined
      ? async (): Promise<{ state: 'ready' | 'unreachable'; latencyMs?: number }> => {
          try {
            const trustAnchorPem = await readFrpIngressTrustAnchor(frpSettings, remoteDeviceFile)
            if (trustAnchorPem === undefined) return { state: 'unreachable' }
            const started = performance.now()
            const reachable = await defaultProbeDiscovery(
              { origin: frpOrigin, trustAnchorPem },
              frpGateway.config.instanceId,
              AbortSignal.timeout(5_500),
            )
            return reachable
              ? { state: 'ready', latencyMs: Math.max(0, Math.round(performance.now() - started)) }
              : { state: 'unreachable' }
          } catch {
            return { state: 'unreachable' }
          }
        }
      : undefined
    return collectConnectionDiagnostics({
      dshVersion,
      competingRemoteChannelBoot: hasCompetingRemoteChannelBoot(ctx.webServer.collectIndexInjections?.() ?? []),
      lan: {
        configured: loaded.kind !== 'unconfigured' || preparedLanSetup !== undefined,
        running: lanController.isRunning(),
        ...(lanGateway === undefined ? {} : { origin: lanGateway.address().origin, port: lanGateway.address().port }),
        ...(loaded.kind === 'managed' ? { configuredInterface: loaded.setup.networkInterface, port: loaded.setup.listenPort } : {}),
        ...(interfaceName === undefined ? {} : { interfaceName }),
        ...(networkError === undefined ? {} : { networkError }),
      },
      remote: {
        provider: remoteProviders.selected,
        running: remote.enabled,
        state: remote.state,
        ...(remote.origin === undefined ? {} : { origin: remote.origin }),
        ...(remote.errorCode === undefined ? {} : { errorCode: remote.errorCode }),
      },
    }, pinnedFrpProbe === undefined ? {} : { remote: pinnedFrpProbe }) as unknown as Record<string, unknown>
  }

  const adminRoute: WebRoute = {
    kind: 'prefix',
    path: LOCAL_ADMIN_PREFIX,
    handler: async (request, response) => {
      try {
        const target = parseRequestTarget(request.url)
        assertLocalAdminTrust(request, request.method === 'POST', () => {
          const connection = (ctx as Context & { readonly connection?: BrowserAuthenticatedConnection }).connection
          return typeof connection?.requestRejection === 'function' && connection.requestRejection(request) === undefined
        })
        if (target.search !== '') throw new HttpError(400, 'bad_request')
        const lanControl = target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/control`
          || target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/lan/control`
        if (request.method === 'GET' && lanControl) {
          sendJson(response, 200, lanPayload(), false)
          return
        }
        if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/lan/setup`) {
          sendJson(response, 200, await lanSetupPayload(), false)
          return
        }
        if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/diagnostics`) {
          sendJson(response, 200, await diagnosticsPayload(), false)
          return
        }
        if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/release`) {
          sendJson(response, 200, await releaseManager.status(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/release/update`) {
          await readJsonObject(request, 4096)
          sendJson(response, 200, await releaseManager.update(), false)
          return
        }
        if (request.method === 'POST' && lanControl) {
          const body = await readJsonObject(request, 4096)
          if (typeof body.running !== 'boolean') throw new HttpError(400, 'bad_request')
          if (body.running && loaded.kind === 'unconfigured') {
            throw new HttpError(409, preparedLanSetup === undefined ? 'lan_setup_required' : 'lan_setup_restart_required')
          }
          await lanController.setRunning(body.running)
          sendJson(response, 200, lanPayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/lan/setup`) {
          const body = await readJsonObject(request, 4096)
          if (loaded.kind !== 'unconfigured') throw new HttpError(409, 'lan_setup_already_configured')
          if (preparedLanSetup !== undefined) {
            sendJson(response, 200, await lanSetupPayload(), false)
            return
          }
          if (body.confirm !== true || typeof body.address !== 'string') throw new HttpError(400, 'bad_request')
          const network = availableLanNetworks().find(candidate => candidate.address === body.address)
          if (network === undefined) throw new HttpError(409, 'lan_setup_network_unavailable')
          try {
            preparedLanSetup = await prepareManagedLanSetup({
              setupFile: loaded.setupFile,
              controlFile: lanControlFile,
              network,
              listenPort: 3443,
              dshPort: ctx.webServer.port,
              configureFirewall: body.configureFirewall !== false,
            })
          } catch (error) {
            logger.error('managed LAN setup failed: %s', error instanceof Error ? error.stack ?? error.message : String(error))
            throw new HttpError(409, 'lan_setup_failed')
          }
          sendJson(response, 200, await lanSetupPayload(), false)
          return
        }
        if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/control`) {
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/provider`) {
          const body = await readJsonObject(request, 4096)
          if (body.provider !== 'tailscale' && body.provider !== 'cpolar' && body.provider !== 'cloudflared'
            && body.provider !== 'frp' && body.provider !== 'origin') {
            throw new HttpError(400, 'bad_request')
          }
          await remoteProviders.select(body.provider)
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/origin/configure`) {
          const body = await readJsonObject(request, 8192)
          await remoteProviders.mutate(async () => {
            await originConfig.configure(body)
            if (remoteControllers.origin.status().enabled) await remoteControllers.origin.reconnect()
          })
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/origin/purge`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          await remoteProviders.mutate(async () => {
            await remoteControllers.origin.setEnabled(false)
            await originConfig.purge()
          })
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/cpolar/component/install`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          logger.info('cpolar component install started')
          try {
            await remoteProviders.mutate(async () => cpolarComponent.install())
            logger.info('cpolar component install completed')
          } catch (error) {
            const cause = error instanceof Error && error.cause instanceof Error ? error.cause : undefined
            logger.error('cpolar component install failed: %s%s',
              error instanceof Error ? error.stack ?? error.message : String(error),
              cause === undefined ? '' : `; cause: ${cause.message}`)
            throw error
          }
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/cpolar/configure`) {
          const body = await readJsonObject(request, 4096)
          await remoteProviders.mutate(async () => cpolarComponent.configure(body.authtoken))
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/cpolar/component/purge`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          await remoteProviders.mutate(async () => {
            await remoteControllers.cpolar.setEnabled(false)
            await cpolarComponent.purge()
          })
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/cloudflared/component/install`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          logger.info('cloudflared component install started')
          try {
            await remoteProviders.mutate(async () => cloudflaredComponent.install())
            logger.info('cloudflared component install completed')
          } catch (error) {
            logger.error('cloudflared component install failed: %s', error instanceof Error ? error.stack ?? error.message : String(error))
            throw error
          }
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/cloudflared/component/purge`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          await remoteProviders.mutate(async () => {
            await remoteControllers.cloudflared.setEnabled(false)
            await cloudflaredComponent.purge()
          })
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/cloudflared/tunnel`) {
          const body = await readJsonObject(request, 8192)
          await remoteProviders.mutate(async () => {
            await cloudflaredTunnel.configure(mergeSavedCloudflaredTunnelSettings(body, cloudflaredTunnel.settings()))
            // A live connector is bound to the previous hostname, port and token, so
            // the new configuration only takes effect through a restart.
            if (remoteControllers.cloudflared.status().enabled) await remoteControllers.cloudflared.reconnect()
          })
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/cloudflared/tunnel/purge`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          await remoteProviders.mutate(async () => {
            await remoteControllers.cloudflared.setEnabled(false)
            await cloudflaredTunnel.purge()
          })
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/frp/component/install`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          logger.info('frpc component install started')
          try {
            await remoteProviders.mutate(async () => frpComponent.install())
            logger.info('frpc component install completed')
          } catch (error) {
            logger.error('frpc component install failed: %s', error instanceof Error ? error.stack ?? error.message : String(error))
            throw error
          }
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/frp/configure`) {
          const body = await readJsonObject(request, 4096)
          await remoteProviders.mutate(async () => {
            await frpConfig.configure(body)
            if (remoteControllers.frp.status().enabled) await remoteControllers.frp.reconnect()
          })
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/frp/attach-plan`) {
          const body = await readJsonObject(request, 8192)
          // Read-only preview: blank fields keep their saved values, and nothing
          // on the VPS or the local filesystem is touched.
          const settings = mergeSavedFrpSettings(body, frpConfig.settings())
          // This route is callable by any same-origin client script. Never return
          // the saved token, even if a caller asks for an unmasked preview.
          const options = { configFile: frpConfig.runtimeConfigFile }
          logger.info('frp attach plan requested mode=%s entryTls=%s vhostHttpPort=%d',
            settings.mode ?? 'deploy', settings.entryTls ?? 'public-ip-cert', resolveFrpVhostHttpPort(settings))
          sendJson(response, 200, {
            ...remotePayload(),
            frpAttachPlan: createFrpAttachPlan(settings, options),
            frpAttachTemplate: createFrpAttachTemplate(settings, options),
          }, false)
          return
        }
        if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/frp/self-check`) {
          const settings = frpConfig.settings()
          if (settings === undefined) throw new HttpError(409, 'frp_config_missing')
          const check = await frpIngressSelfCheck(settings, remoteDeviceFile)
          // Two independent facts: the control port proves the user's frps is up,
          // and the entry port proves the tunnel actually forwards to this
          // computer. Both are advisory and never gate a security decision.
          const [frpsReachable, entryReachable] = await Promise.all([
            probeTcpReachable(settings.serverAddress, settings.serverPort),
            probeTcpReachable(settings.serverAddress, resolveFrpPublicPort(settings)),
          ])
          sendJson(response, 200, {
            ...remotePayload(),
            frpSelfCheck: {
              ...check,
              // Only stable booleans and the CA fingerprint leave this route: no
              // token, no key material, and no private file paths.
              frpsReachable,
              entryReachable,
              frpc: remoteController().status(),
              component: frpComponent.status(),
            },
          }, false)
          return
        }
        if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/websocket-paths`) {
          sendJson(response, 200, { paths: webSocketPaths.list() }, false)
          return
        }
        if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/websocket-paths/blocked`) {
          sendJson(response, 200, { blocked: blockedUpgradePaths.report() }, false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/websocket-paths`) {
          const body = await readJsonObject(request, 4096)
          if (!Array.isArray(body.paths)) throw new HttpError(400, 'bad_request')
          const paths = await webSocketPaths.replace(body.paths)
          logger.info('websocket upgrade paths updated count=%d paths=%o', paths.length, paths)
          sendJson(response, 200, { paths }, false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/frp/vps/host-keys`) {
          const body = await readJsonObject(request, 8192)
          const serverAddress = typeof body.serverAddress === 'string' ? body.serverAddress : ''
          logger.info('vps host keys requested host=%s sshUser=%s sshPort=%d',
            serverAddress, String(body.sshUser), Number(body.sshPort))
          const hostKeys = await fetchVpsHostKeys(serverAddress, {
            sshUser: body.sshUser,
            sshPort: body.sshPort,
            ...(body.sshKeyPath === undefined || body.sshKeyPath === '' ? {} : { sshKeyPath: body.sshKeyPath }),
          }, {
            log(event, fields) { logger.info('vps host keys event=%s fields=%o', event, fields) },
          })
          for (const key of hostKeys) logger.info('vps host key host=%s type=%s fingerprint=%s', serverAddress, key.keyType, key.fingerprint)
          sendJson(response, 200, { ...remotePayload(), vpsHostKeys: hostKeys }, false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/frp/vps/deploy`) {
          const body = await readJsonObject(request, 8192)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          logger.info('vps deploy requested host=%s port=%d sshUser=%s sshPort=%d keyProvided=%s fingerprints=%s',
            String(body.serverAddress), Number(body.serverPort), String(body.sshUser), Number(body.sshPort), body.sshKeyPath === undefined ? 'false' : 'true',
            Array.isArray(body.hostFingerprints) ? String(body.hostFingerprints.length) : 'none')
          const deployment = await remoteProviders.mutate(async () => {
            // Blank fields keep their saved values so a saved token can stay empty.
            const settings = mergeSavedFrpSettings(body, frpConfig.settings())
            const result = await deployVps(settings, parseVpsDeploymentInput({
              sshUser: body.sshUser,
              sshPort: body.sshPort,
              ...(body.sshKeyPath === undefined ? {} : { sshKeyPath: body.sshKeyPath }),
              hostFingerprints: body.hostFingerprints,
            }), {
              log(event, fields) { logger.info('vps deploy event=%s fields=%o', event, fields) },
            })
            await frpConfig.configure(settings)
            logger.info('vps deploy completed host=%s origin=%s checks=%d', settings.serverAddress, settings.publicOrigin, result.checks.length)
            return result
          })
          sendJson(response, 200, { ...remotePayload(), vpsDeployment: deployment }, false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/frp/vps/uninstall-script`) {
          const body = await readJsonObject(request, 4096)
          const savedTarget = mergeSavedFrpTarget(body, frpConfig.settings())
          const script = createVpsUninstallScript({
            serverPort: savedTarget.serverPort,
            ...(body.certName === undefined || body.certName === '' ? {} : { certName: body.certName }),
          })
          sendJson(response, 200, { ...remotePayload(), vpsUninstallScript: script }, false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/frp/vps/uninstall`) {
          const body = await readJsonObject(request, 8192)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          logger.info('vps uninstall requested host=%s sshUser=%s sshPort=%d',
            String(body.serverAddress), String(body.sshUser), Number(body.sshPort))
          const removal = await remoteProviders.mutate(async () => {
            const savedTarget = mergeSavedFrpTarget(body, frpConfig.settings())
            const result = await uninstallVps(savedTarget.serverAddress, {
              serverPort: savedTarget.serverPort,
              ...(body.certName === undefined || body.certName === '' ? {} : { certName: body.certName }),
            }, parseVpsDeploymentInput({
              sshUser: body.sshUser,
              sshPort: body.sshPort,
              ...(body.sshKeyPath === undefined ? {} : { sshKeyPath: body.sshKeyPath }),
              hostFingerprints: body.hostFingerprints,
            }), {
              log(event, fields) { logger.info('vps uninstall event=%s fields=%o', event, fields) },
            })
            logger.info('vps uninstall completed host=%s checks=%d', result.serverAddress, result.checks.length)
            return result
          })
          sendJson(response, 200, { ...remotePayload(), vpsUninstall: removal }, false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/frp/component/purge`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          await remoteProviders.mutate(async () => {
            await remoteControllers.frp.setEnabled(false)
            await Promise.all([frpComponent.purge(), frpConfig.purge(), purgeFrpIngressCertificates(remoteDeviceFile)])
          })
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/control`) {
          const body = await readJsonObject(request, 4096)
          const running = body.running
          if (typeof running !== 'boolean') throw new HttpError(400, 'bad_request')
          await remoteProviders.mutate(async controller => controller.setEnabled(running))
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/reconnect`) {
          await readJsonObject(request, 4096)
          await remoteProviders.mutate(async controller => controller.reconnect())
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/reset`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          await remoteProviders.mutate(async controller => {
            await controller.reset()
            await rm(remoteDeviceFile, { force: true })
          })
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (target.decodedPathname.startsWith(`${LOCAL_ADMIN_PREFIX}/remote/`)) {
          const active = remoteController().gateway()
          if (active === undefined) throw new HttpError(409, 'gateway_stopped')
          await active.localAdminRoute(`${LOCAL_ADMIN_PREFIX}/remote`).handler(request, response)
          return
        }
        if (target.decodedPathname.startsWith(`${LOCAL_ADMIN_PREFIX}/lan/`)) {
          const active = lanGateway
          if (active === undefined) throw new HttpError(409, 'gateway_stopped')
          await active.localAdminRoute(`${LOCAL_ADMIN_PREFIX}/lan`).handler(request, response)
          return
        }
        const active = lanGateway
        if (active === undefined) throw new HttpError(409, 'gateway_stopped')
        await active.localAdminRoute().handler(request, response)
      } catch (error) {
        const mapped = mapAdminError(error)
        if (response.headersSent) response.destroy()
        else sendFailure(response, mapped.status, mapped.code, false)
      }
    },
  }

  await ctx.effect(async () => {
    const unregister = ctx.webServer.register(adminRoute)
    const disposeMobileCommand = ctx.commands.register({
      name: 'mobile',
      description: '按需求修改 DSH Mobile 的手机端界面或添加电脑端能力',
      input: { hint: '<要做什么>' },
      handler: async ({ agent, rawInput }) => {
        const task = rawInput.trim()
        if (task === '') return { kind: 'error', text: '请带上需求，例如：/mobile 把手机端改成深色主题' }
        // Collect the current customization state so the guide does not
        // overwrite earlier /mobile work blindly.
        const state: MobileGuideState = {
          directory: stateDirectory,
          hasCustomCss: await existsRegularFile(template.customCssFile),
          hasCustomJs: await existsRegularFile(template.customScriptFile),
          extensions: mobileAccess.manifest().map(entry => ({
            id: entry.id,
            name: entry.name,
            version: entry.version,
          })),
          failedExtensionCount: mobileAccess.status().failed,
        }
        const guide = buildMobileGuide(state)
        // A plugin-source message renders as a collapsed context-injection row
        // (label "dsh-mobile", one-line notice summary) instead of a user bubble,
        // while steering still wakes the agent with the full guide as input.
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: `${guide}\n\n用户需求：${task}` }],
          source: {
            kind: 'plugin:dsh-mobile',
            form: 'notice',
            summary: boundContextSummary(`/mobile ${task}`),
          },
        }))
        return { kind: 'success', text: '已把需求交给 DSH 处理，改动会在手机端几秒内生效。' }
      },
    })
    try {
      await mobileAccess.startLocal(template.extensionsDir, ctx)
      await lanController.initialize()
      const stores: Record<RemoteProvider, JsonMobileAccessControlStore> = {
        tailscale: tailscaleStore,
        cpolar: cpolarStore,
        cloudflared: cloudflaredStore,
        frp: frpStore,
        origin: originStore,
      }
      await Promise.all((Object.keys(stores) as RemoteProvider[])
        .filter(provider => provider !== remoteProviders.selected)
        .map(provider => stores[provider].save({ version: 1, enabled: false })))
      for (const provider of REMOTE_PROVIDERS) await remoteControllers[provider].initialize()
      // Broadcast discovery degrades silently when its UDP port cannot be bound, which
      // otherwise leaves "the phone cannot find this computer" with no visible cause.
      const lanDiscovery = lanGateway?.discoveryStatus()
      if (lanDiscovery !== undefined && !lanDiscovery.broadcast) {
        logger.warn(
          'broadcast discovery is unavailable (%s); mDNS is still published, so pair manually or free the UDP port',
          lanDiscovery.errorCode ?? 'unknown_cause',
        )
      }
      if (lanDiscovery?.mobileAssetsErrorCode !== undefined) {
        logger.warn(
          'a bundled mobile asset is missing (%s); the phone frontend will serve without it',
          lanDiscovery.mobileAssetsErrorCode,
        )
      }
    } catch (error) {
      try {
        await settleCleanupSteps([
          unregister,
          disposeMobileCommand,
          disposeTaskEvents,
          async () => {
            const results = await Promise.allSettled(Object.values(remoteControllers).map(controller => controller.close()))
            const failures = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
            if (failures.length > 0) throw new AggregateError(failures, 'remote provider cleanup failed')
          },
          () => lanController.close(),
          () => mobileAccess.stopLocal(),
          unregisterBuiltin,
        ])
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'DSH Mobile initialization and cleanup failed')
      }
      throw error
    }
    return async () => {
      await settleCleanupSteps([
        unregister,
        disposeMobileCommand,
        disposeTaskEvents,
        async () => {
          const results = await Promise.allSettled(Object.values(remoteControllers).map(controller => controller.close()))
          const failures = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
          if (failures.length > 0) throw new AggregateError(failures, 'remote provider cleanup failed')
        },
        () => lanController.close(),
        () => mobileAccess.stopLocal(),
        unregisterBuiltin,
      ])
    }
  }, 'dsh-mobile: independent LAN and selectable remote providers with /mobile command')
}
