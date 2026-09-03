import type { Context } from '@deepseek-ai/cordis'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm/message'
// Side-effect type import: activates dsh-commands' Context augmentation so
// `ctx.commands` and its handler types resolve without a runtime dependency.
import type {} from '@deepseek-ai/dsh-commands'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { createRequire } from 'node:module'
import { X509Certificate } from 'node:crypto'
import { copyFile, lstat, readFile, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parseControlFile, parseGatewayConfig, type PluginConfig, type ResolvedGatewayConfig } from './config.js'
import { collectConnectionDiagnostics } from './diagnostics.js'
import { MOBILE_CUSTOMIZATION_GUIDE } from './mobile-guide.js'
import { createVpsUninstallScript, deployVps, fetchVpsHostKeys, parseVpsDeploymentInput, uninstallVps } from './vps-deploy.js'
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
import { FunnelController, funnelExecutable } from './funnel.js'
import { CpolarController } from './cpolar.js'
import { CpolarComponentManager, type CpolarComponentStatus } from './cpolar-component.js'
import { FrpComponentManager, type FrpComponentStatus } from './frp-component.js'
import { FrpConfigStore, mergeSavedFrpSettings, mergeSavedFrpTarget, type FrpConfigurationStatus } from './frp-config.js'
import { FrpController } from './frp.js'
import { PluginReleaseManager, releaseProfileDirectory } from './release-update.js'
import { installMobileFileLogger } from './file-logger.js'
import {
  configuredRemoteProvider,
  JsonRemoteProviderStore,
  RemoteProviderCoordinator,
  type RemoteProvider,
  type RemoteProviderController,
  type RemoteProviderStatus,
} from './remote.js'
import { parseAuthority, parseCidr } from './network.js'
import {
  materializeManagedSetup,
  parseManagedSetup,
  selectLanNetwork,
  type ManagedSetup,
} from './managed-setup.js'

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
}

function upstreamAuthenticatedUrl(ctx: Context, upstreamOrigin: URL): string | undefined {
  const connection = (ctx as Context & { readonly connection?: BrowserAuthenticatedConnection }).connection
  return typeof connection?.authenticatedUrl === 'function'
    ? connection.authenticatedUrl(upstreamOrigin.origin)
    : undefined
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
  if (error instanceof Error && [
    'frp_server_address_invalid',
    'frp_server_port_invalid',
    'frp_token_invalid',
    'frp_public_origin_invalid',
    'frp_settings_invalid',
  ].includes(error.message)) return new HttpError(400, error.message)
  if (error instanceof Error && error.message.startsWith('frp_')) {
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
  return new HttpError(500, 'internal_error')
}

const SETUP_KEYS = new Set([
  'version', 'publicOrigin', 'listenHost', 'listenPort', 'upstreamOrigin',
  'publicAuthorities', 'allowedCidrs', 'instanceId', 'pairingCaFile', 'tls',
])

type LoadedSetup = {
  readonly kind: 'fixed'
  readonly config: PluginConfig
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
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'fixed', config }
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
  return {
    kind: 'fixed',
    config: { ...withoutSetupKeys(config), ...setup } as unknown as PluginConfig,
  }
}

function loopbackTemplate(loaded: LoadedSetup, webServerPort: number): ResolvedGatewayConfig {
  const base = withoutSetupKeys(loaded.config)
  return parseGatewayConfig({
    ...base,
    ...(loaded.kind === 'managed'
      ? { upstreamOrigin: loaded.setup.upstreamOrigin }
      : { upstreamOrigin: loaded.config.upstreamOrigin ?? `http://127.0.0.1:${String(webServerPort)}` }),
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

function remoteControlPayload(
  provider: RemoteProvider,
  status: RemoteProviderStatus,
  gateway: MobileAccessGateway | undefined,
  providerStatuses: Readonly<Record<RemoteProvider, RemoteProviderStatus>>,
  cpolarComponent: CpolarComponentStatus,
  frpComponent: FrpComponentStatus,
  frpConfiguration: FrpConfigurationStatus,
): Record<string, unknown> {
  return {
    provider,
    running: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
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
      frp: {
        bundled: false,
        running: providerStatuses.frp.enabled,
        state: providerStatuses.frp.state,
        component: frpComponent,
        configuration: frpConfiguration,
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
  const frpComponent = new FrpComponentManager({ stateDirectory })
  await frpComponent.initialize()
  const frpConfig = new FrpConfigStore(join(remoteDirectory, 'frp', 'config'))
  await frpConfig.initialize()
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
  let lanGateway: MobileAccessGateway | undefined
  const startGateway = async (candidateConfig: PluginConfig): Promise<MobileAccessRuntime> => {
    const resolved = parseGatewayConfig(candidateConfig)
    const candidate = new MobileAccessGateway(
      resolved,
      new JsonDeviceStore(resolved.stateFile, resolved.maxDevices),
      mobileAccess,
      upstreamLoginUrl,
    )
    await candidate.start()
    lanGateway = candidate
    return {
      close: async () => {
        if (lanGateway === candidate) lanGateway = undefined
        await candidate.close()
      },
    }
  }
  const startRuntime = async (): Promise<MobileAccessRuntime> => {
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
    await following.initialize(2_000)
    return following
  }
  const lanController = new MobileAccessGatewayController(
    new JsonMobileAccessControlStore(parseControlFile(config.controlFile), config.initiallyEnabled),
    startRuntime,
  )
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
      )
      await candidate.start()
      return candidate
  }
  const tailscaleStore = new JsonMobileAccessControlStore(join(remoteDirectory, 'control.json'), false)
  const cpolarStore = new JsonMobileAccessControlStore(join(remoteDirectory, 'cpolar', 'control.json'), false)
  const frpStore = new JsonMobileAccessControlStore(join(remoteDirectory, 'frp', 'control.json'), false)
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
      region: 'cn',
      createGateway: createRemoteGateway,
    }),
    frp: new FrpController({
      store: frpStore,
      executable: frpComponent.executable,
      config: frpConfig,
      instanceId,
      createGateway: createRemoteGateway,
    }),
  }
  const remoteProviders = new RemoteProviderCoordinator(initialRemoteProvider, remoteControllers, remoteProviderStore)
  const remoteController = () => remoteProviders.controller()
  const remotePayload = (): Record<string, unknown> => remoteControlPayload(
    remoteProviders.selected,
    remoteController().status(),
    remoteController().gateway(),
    {
      tailscale: remoteControllers.tailscale.status(),
      cpolar: remoteControllers.cpolar.status(),
      frp: remoteControllers.frp.status(),
    },
    cpolarComponent.status(),
    frpComponent.status(),
    frpConfig.status(),
  )
  const lanPayload = (): Record<string, unknown> => ({
    running: lanController.isRunning(),
    origin: lanGateway?.address().origin,
    ...(lanGateway === undefined ? {} : { extensions: lanGateway.extensionStatus() }),
  })
  const diagnosticsPayload = async (): Promise<Record<string, unknown>> => {
    let interfaceName: string | undefined
    let networkError: string | undefined
    if (loaded.kind === 'managed') {
      try { interfaceName = selectLanNetwork(undefined, loaded.setup.networkInterface).name }
      catch { networkError = 'network_interface_unavailable' }
    }
    const remote = remoteController().status()
    return collectConnectionDiagnostics({
      dshVersion,
      lan: {
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
    }) as unknown as Record<string, unknown>
  }

  const adminRoute: WebRoute = {
    kind: 'prefix',
    path: LOCAL_ADMIN_PREFIX,
    handler: async (request, response) => {
      try {
        const target = parseRequestTarget(request.url)
        assertLocalAdminTrust(request, request.method === 'POST')
        if (target.search !== '') throw new HttpError(400, 'bad_request')
        const lanControl = target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/control`
          || target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/lan/control`
        if (request.method === 'GET' && lanControl) {
          sendJson(response, 200, lanPayload(), false)
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
          await lanController.setRunning(body.running)
          sendJson(response, 200, lanPayload(), false)
          return
        }
        if (request.method === 'GET' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/control`) {
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/provider`) {
          const body = await readJsonObject(request, 4096)
          if (body.provider !== 'tailscale' && body.provider !== 'cpolar' && body.provider !== 'frp') {
            throw new HttpError(400, 'bad_request')
          }
          await remoteProviders.select(body.provider)
          sendJson(response, 200, remotePayload(), false)
          return
        }
        if (request.method === 'POST' && target.decodedPathname === `${LOCAL_ADMIN_PREFIX}/remote/cpolar/component/install`) {
          const body = await readJsonObject(request, 4096)
          if (body.confirm !== true) throw new HttpError(400, 'bad_request')
          await remoteProviders.mutate(async () => cpolarComponent.install())
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
            await Promise.all([frpComponent.purge(), frpConfig.purge()])
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
      handler: ({ agent, rawInput }) => {
        const task = rawInput.trim()
        if (task === '') return { kind: 'error', text: '请带上需求，例如：/mobile 把手机端改成深色主题' }
        // A plugin-source message renders as a collapsed context-injection row
        // (label "dsh-mobile", one-line notice summary) instead of a user bubble,
        // while steering still wakes the agent with the full guide as input.
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: `${MOBILE_CUSTOMIZATION_GUIDE}\n\n用户需求：${task}` }],
          source: {
            kind: 'plugin',
            plugin: 'dsh-mobile',
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
        frp: frpStore,
      }
      await Promise.all((Object.keys(stores) as RemoteProvider[])
        .filter(provider => provider !== remoteProviders.selected)
        .map(provider => stores[provider].save({ version: 1, enabled: false })))
      for (const provider of ['tailscale', 'cpolar', 'frp'] as const) await remoteControllers[provider].initialize()
    } catch (error) {
      try {
        await settleCleanupSteps([
          unregister,
          disposeMobileCommand,
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
