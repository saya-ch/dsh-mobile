import { Context, type Message } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { createHash, X509Certificate } from 'node:crypto'
import { createTestTlsChain } from './tls-fixtures.js'
import { createServer, request as requestHttp, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as requestHttps } from 'node:https'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { connect, type AddressInfo } from 'node:net'
import { checkServerIdentity, connect as connectTls } from 'node:tls'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { generate } from 'selfsigned'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, parseGatewayConfig, type PluginConfig } from '../src/config.js'
import { JsonMobileAccessControlStore } from '../src/control.js'
import { parseCidr, RequestTrustPolicy } from '../src/network.js'
import * as network from '../src/network.js'
import * as managedSetup from '../src/managed-setup.js'
import * as lanRebind from '../src/lan-rebind.js'
import { MobileAccessReconfigurationError } from '../src/control.js'
import { apply, frpIngressGatewayConfig, inject, originGatewayConfig, remoteGatewayConfig, settleCleanupSteps, upstreamAuthenticatedUrl } from '../src/plugin.js'
import { parseOriginSettings } from '../src/origin-proxy-config.js'
import { parseFrpSettings } from '../src/frp-config.js'
import { ensureFrpIngressCertificate } from '../src/frp-ingress.js'
import { DSH_MOBILE_VERSION, MINIMUM_ANDROID_APP_VERSION } from '../src/version.js'
import { DESKTOP_ADMIN_HEADER, DESKTOP_ADMIN_MARKER, WEB_ADMIN_HEADER, WEB_ADMIN_MARKER } from '../src/local-admin-host.js'
import { AccessController } from '../src/access.js'
import { SESSION_COOKIE } from '../src/http-security.js'
import { buildExtensionWorkerEntry } from './helpers/extension-worker-build.js'
import { parseUnavailableExtensionHosts } from '../src/extension-recovery-ui.js'
import { CaddyComponentManager, CADDY_VERSION, type CaddyArtifact } from '../src/caddy-component.js'
import { FunnelController, type FunnelControllerOptions } from '../src/funnel.js'
import { FrpController, type FrpControllerOptions } from '../src/frp.js'
import type { MobileAccessGateway } from '../src/gateway.js'
import { PushGatewayCoordinator, type PushGatewayOriginBinding } from '../src/mobile-push/gateway.js'
import { PushDelivery } from '../src/mobile-push/delivery.js'
import { PushRegistry, vapidFingerprint } from '../src/mobile-push/registry.js'
import { JsonPushStore } from '../src/mobile-push/store.js'
import { createVapidKeys } from '../src/mobile-push/sender.js'

const contexts: Context[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function invoke(
  route: WebRoute,
  method: 'GET' | 'POST' | 'OPTIONS',
  path: string,
  body = '',
  hostHostname = '127.0.0.1',
  requestHeaders?: Record<string, string>,
  directPeer?: string,
): Promise<{ status: number; body: string }> {
  const server = createServer((request, response) => {
    // Controlled admission fixture; the transport itself remains on loopback.
    if (directPeer !== undefined) Object.defineProperty(request.socket, 'remoteAddress', { value: directPeer })
    void route.handler(request, response)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const authority = `${hostHostname}:${String(port)}`
  try {
    return await new Promise((resolve, reject) => {
      const request = requestHttp({
        host: '127.0.0.1',
        port,
        method,
        path,
        // Keep-alive sockets parked in the global agent hold loopback ports from
        // the same ephemeral range this fixture probes for the origin listener.
        agent: false,
        headers: {
          host: authority,
          ...(method === 'POST' ? {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          } : {}),
          ...(requestHeaders ?? (method === 'POST' ? {
            origin: `http://${authority}`,
            'sec-fetch-site': 'same-origin',
          } : {})),
        },
      }, (response) => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      request.once('error', reject)
      if (body !== '') request.write(body)
      request.end()
    })
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }
}

async function frpProxyNameFromRoute(route: WebRoute): Promise<string> {
  const result = await invoke(route, 'GET', '/api/mobile-access/remote/control')
  expect(result.status).toBe(200)
  const payload = JSON.parse(result.body) as { providers: { frp: { configuration: { proxyName: string } } } }
  return payload.providers.frp.configuration.proxyName
}

async function mount(
  initiallyEnabled = false,
  webServerPort = 3080,
  config: Partial<PluginConfig> = {},
  requestRejection: (request: IncomingMessage) => 401 | 403 | undefined = () => 401,
  indexInjections: readonly { kind: string; text?: string }[] = [],
  pushHostAvailable = false,
  blockPushStoreDirectory = false,
  scopedPushHostServices = false,
  loaderMobileInjection = false,
  waitForPushRuntime = true,
  authenticationUrl?: (base: string) => string,
): Promise<{
  context: Context; route: WebRoute; command: CommandDefinition; upstreamBase: string | undefined; directory: string;
  pushProjectionDisposer: (() => void) | undefined; pushProjectionRegistered: Promise<void>;
  installPushHostServices: () => Promise<{ dispose: () => Promise<void>; projectionDisposer: () => void; registered: Promise<void> }>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-plugin-'))
  temporaryDirectories.push(directory)
  if (blockPushStoreDirectory) await writeFile(join(directory, 'mobile-push'), 'not-a-directory')
  let route: WebRoute | undefined
  let command: CommandDefinition | undefined
  let upstreamBase: string | undefined
  let pushProjectionDisposer: (() => void) | undefined
  const context = new Context()
  contexts.push(context)
  context.provide('webServer', {
    port: webServerPort,
    collectIndexInjections: () => indexInjections,
    register(candidate: WebRoute) {
      route = candidate
      return () => { if (route === candidate) route = undefined }
    },
  } as WebServer)
  context.provide('commands', {
    register(definition: CommandDefinition) {
      command = definition
      return () => { if (command === definition) command = undefined }
    },
  } as never)
  context.provide('connection', {
    authenticatedUrl(baseUrl: string) {
      upstreamBase = baseUrl
      return authenticationUrl === undefined ? `${baseUrl}/?token=test-launch-token` : authenticationUrl(baseUrl)
    },
    requestRejection,
  } as never)
  let resolvePushProjectionRegistered!: () => void
  const pushProjectionRegistered = new Promise<void>(resolve => { resolvePushProjectionRegistered = resolve })
  let pushHostProviderSequence = 0
  const providePushHostServices = (hostContext: Context, projectionDisposer: () => void, onRegistered: () => void): void => {
    hostContext.provide('userQuestions', { pending: () => [] } as never)
    hostContext.provide('approval', {} as never)
    hostContext.provide('sessionProjections', {
      stateOf: () => undefined,
      snapshot: () => ({ asOfSeq: 0, values: {} }),
      register: () => {
        resolvePushProjectionRegistered()
        onRegistered()
        return projectionDisposer
      },
    } as never)
    hostContext.provide('sessionQuery', {
      observeSession: async () => ({ source: 'prepared', [Symbol.dispose]: () => undefined }),
    } as never)
    hostContext.provide('agents', { get: () => undefined, list: () => [], roots: () => [], isOwnedBy: () => false } as never)
  }
  const installPushHostServices = async (): Promise<{ dispose: () => Promise<void>; projectionDisposer: () => void; registered: Promise<void> }> => {
    let resolveRegistered!: () => void
    const registered = new Promise<void>(resolve => { resolveRegistered = resolve })
    const projectionDisposer = vi.fn()
    const providerFiber = context.plugin({
      name: `test-push-host-services-${++pushHostProviderSequence}`,
      apply: hostContext => providePushHostServices(hostContext, projectionDisposer, resolveRegistered),
    })
    await providerFiber
    pushProjectionDisposer = projectionDisposer
    return { dispose: () => providerFiber.dispose(), projectionDisposer, registered }
  }
  if (pushHostAvailable) {
    if (scopedPushHostServices) await installPushHostServices()
    else {
      const projectionDisposer = vi.fn()
      pushProjectionDisposer = projectionDisposer
      providePushHostServices(context, projectionDisposer, () => undefined)
    }
  }
  await context.plugin({ Config, inject: loaderMobileInjection ? ['webServer', 'connection'] : inject, apply }, {
    listenPort: 0,
    stateFile: join(directory, 'devices.json'),
    controlFile: join(directory, 'control.json'),
    customCssFile: join(directory, 'mobile.css'),
    customScriptFile: join(directory, 'mobile.js'),
    initiallyEnabled,
    tls: { mode: 'disabled' },
    ...config,
  })
  if (pushHostAvailable && !blockPushStoreDirectory && waitForPushRuntime) {
    const pushStatePath = join(directory, 'mobile-push', 'push-state.json')
    await vi.waitFor(async () => {
      const pushState = JSON.parse(await readFile(pushStatePath, 'utf8')) as { keys?: { fingerprint: string } }
      expect(pushState.keys?.fingerprint).toMatch(/^[0-9a-f]{64}$/u)
    })
  }
  if (route === undefined) throw new Error('plugin did not register its control route')
  if (command === undefined) throw new Error('plugin did not register its /mobile command')
  return {
    context, route, command, upstreamBase, directory, pushProjectionRegistered, installPushHostServices,
    get pushProjectionDisposer() { return pushProjectionDisposer },
  }
}

async function unusedOriginPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>(resolve => { server.close(() => resolve()) })
  return port
}

async function pairOriginBackend(port: number, token: string): Promise<number> {
  const body = JSON.stringify({ token, label: 'Origin plugin test' })
  return new Promise((resolve, reject) => {
    const request = requestHttp({ host: '127.0.0.1',
      port,
      path: '/mobile-access/auth/pair',
      method: 'POST',
      // Pairing reuses the origin port, so it must not borrow a pooled socket either.
      agent: false,
      headers: {
        host: 'phone.example.com:8815', origin: 'https://phone.example.com:8815',
        'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
      } }, response => { response.resume(); response.once('end', () => { resolve(response.statusCode ?? 0) }) })
    request.once('error', reject)
    request.end(body)
  })
}

interface GatewayTestTrust { readonly ca: string; readonly hostname: string }

async function rejectGatewayPrompt(port: number, origin: string, trust?: GatewayTestTrust): Promise<number> {
  return new Promise((resolve, reject) => {
    const options = {
      host: '127.0.0.1', port, path: '/api/session/prompt', method: 'POST', agent: false as const,
      headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'content-length': '2' },
      ...(trust === undefined ? {} : {
        ca: trust.ca,
        checkServerIdentity: (_hostname: string, certificate: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(trust.hostname, certificate),
      }),
    }
    const request = (trust === undefined ? requestHttp : requestHttps)(options, response => {
      response.resume()
      response.once('error', reject)
      response.once('end', () => resolve(response.statusCode ?? 0))
    })
    request.once('error', reject)
    request.setTimeout(5_000, () => request.destroy(new Error('Owned rejection request timed out')))
    request.end('{}')
  })
}

async function overflowGatewayHeaders(port: number, origin: string, trust?: GatewayTestTrust): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = trust === undefined
      ? connect(port, '127.0.0.1')
      : connectTls({
          host: '127.0.0.1', port, ca: trust.ca,
          checkServerIdentity: (_hostname, certificate) => checkServerIdentity(trust.hostname, certificate),
        })
    const chunks: Buffer[] = []
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Owned parser rejection timed out')) }, 5_000)
    socket.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
    socket.once('error', reject)
    socket.once('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')) })
    socket.once(trust === undefined ? 'connect' : 'secureConnect', () => {
      socket.write([
        'POST /api/session/prompt HTTP/1.1', `Host: ${new URL(origin).host}`,
        `X-Private: ${'prompt-private-header-secret-234'.repeat(1_000)}`,
        'Content-Length: 2', 'Connection: close', '', '{}',
      ].join('\r\n'))
    })
  })
}

function observePluginWarnings(context: Context): Message[] {
  const messages: Message[] = []
  context.logger.exporter({
    levels: { default: -1, 'dsh-mobile': 3 },
    export(message) { if (message.name === 'dsh-mobile' && message.type === 'warn') messages.push(message) },
  })
  return messages
}

async function assertGatewayDiagnosticComposition(
  messages: Message[], port: number, origin: string, trust?: GatewayTestTrust,
): Promise<void> {
  const before = messages.length
  expect(await rejectGatewayPrompt(port, origin, trust)).toBe(401)
  const overflow = await overflowGatewayHeaders(port, origin, trust)
  expect(overflow).toContain('HTTP/1.1 431 Request Header Fields Too Large')
  expect(overflow).toContain('{"error":"headers_too_large"}\n')
  const actual = messages.slice(before)
  expect(actual.filter(message => message.args[0] === 'auth failure %s')).toEqual([
    expect.objectContaining({ args: ['auth failure %s', JSON.stringify({
      kind: 'authorize', status: 401, method: 'POST', path: '/api/session/prompt',
      sessionCookie: false, csrfHeader: false, csrfCookies: 0, origin, site: 'same-origin',
    })] }),
  ])
  expect(actual.filter(message => message.args[0] === 'http failure %s')).toEqual([
    expect.objectContaining({ args: ['http failure %s', JSON.stringify({ kind: 'parser', status: 431, code: 'HPE_HEADER_OVERFLOW' })] }),
  ])
  expect(JSON.stringify(actual)).not.toContain('prompt-private-header-secret-234')
}

/** Sends protocol requests only to the owned loopback listener behind the selected Origin. */
async function nativeGatewayRequest(
  port: number,
  origin: string,
  path: string,
  data?: Record<string, string>,
  ca?: string,
  capability = 'installation-id',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = data === undefined ? undefined : JSON.stringify(data)
  return new Promise((resolve, reject) => {
    const request = (ca === undefined ? requestHttp : requestHttps)({ host: '127.0.0.1', port, path,
      ...(ca === undefined ? {} : { ca }),
      method: body === undefined ? 'GET' : 'POST', agent: false,
      headers: { host: new URL(origin).host,
        ...(capability === '' ? {} : { 'X-DSH-Mobile-Capabilities': capability }),
        ...(body === undefined ? {} : { origin, 'sec-fetch-site': 'same-origin',
          'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('error', reject)
      response.once('end', () => {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Native response must be an object')
          resolve({ status: response.statusCode ?? 0, body: parsed as Record<string, unknown> })
        } catch (error) { reject(error) }
      })
    })
    request.setTimeout(5000, () => { request.destroy(new Error('Owned native request timed out')) })
    request.once('error', reject)
    request.end(body)
  })
}

async function mobileGatewayRequest(
  port: number,
  origin: string,
  path: string,
  options: { method?: 'GET' | 'POST'; body?: Record<string, unknown>; cookie?: string; csrf?: string } = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: Record<string, unknown> }> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body)
  return new Promise((resolve, reject) => {
    const request = requestHttp({
      host: '127.0.0.1', port, path, method: options.method ?? 'GET', agent: false,
      headers: {
        host: new URL(origin).host,
        origin,
        'sec-fetch-site': 'same-origin',
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.csrf === undefined ? {} : { 'x-dsh-mobile-csrf': options.csrf }),
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
      },
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.once('error', reject)
      response.once('end', () => {
        try {
          const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Mobile Gateway response must be an object')
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: parsed as Record<string, unknown> })
        } catch (error) { reject(error) }
      })
    })
    request.setTimeout(5000, () => { request.destroy(new Error('Owned Mobile Gateway request timed out')) })
    request.once('error', reject)
    request.end(body)
  })
}

function responseString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string') throw new Error(`Expected response field ${field}`)
  return value
}

async function nativePairFromRoute(
  route: WebRoute,
  mode: 'lan' | 'remote',
  port: number,
  origin: string,
  instanceId: string,
  ca?: string,
): Promise<Record<string, unknown>> {
  const discovery = await nativeGatewayRequest(port, origin, '/mobile-access/discovery', undefined, ca)
  expect(discovery.status).toBe(200)
  expect(discovery.body.instanceId).toBe(instanceId)
  expect(discovery.body).not.toHaveProperty('installationId')
  const pairing = await invoke(route, 'POST', `/api/mobile-access/${mode}/pairing/open`, '{}')
  expect(pairing.status).toBe(201)
  const opened = JSON.parse(pairing.body) as Record<string, unknown>
  const token = responseString(opened, 'token')
  expect(opened.appKey).toBe(`dsh1.${instanceId}.${token}`)
  const paired = await nativeGatewayRequest(port, origin, '/mobile-access/auth/native-pair', { token, label: 'Owned composition phone' }, ca)
  expect(paired.status).toBe(201)
  expect(Object.keys(paired.body).sort()).toEqual(['csrfToken', 'deviceExpiresAt', 'deviceId', 'deviceToken', 'installationId', 'instanceId', 'sessionExpiresAt', 'sessionToken'])
  expect(paired.body.instanceId).toBe(instanceId)
  return paired.body
}

async function checkNativeCredential(port: number, origin: string, token: string, instanceId: string, deviceId: string, installationId: string, ca?: string): Promise<void> {
  const probe = await nativeGatewayRequest(port, origin, '/mobile-access/auth/native-probe', { deviceToken: token }, ca)
  expect(probe.status).toBe(200)
  expect(Object.keys(probe.body).sort()).toEqual(['deviceExpiresAt', 'deviceId', 'installationId', 'instanceId'])
  expect(probe.body).toMatchObject({ instanceId, deviceId, installationId })
  const renewed = await nativeGatewayRequest(port, origin, '/mobile-access/auth/native-renew', { deviceToken: token }, ca)
  expect(renewed.status).toBe(200)
  expect(Object.keys(renewed.body).sort()).toEqual(['csrfToken', 'deviceId', 'installationId', 'instanceId', 'sessionExpiresAt', 'sessionToken'])
  expect(renewed.body).toMatchObject({ instanceId, deviceId, installationId })
}

/**
 * One initial port probe plus up to two re-probes when the operating system
 * handed the released port to an unrelated loopback socket in the meantime.
 */
const ORIGIN_PORT_ATTEMPTS = 3

/**
 * Configure and start the private origin listener on a freshly probed port.
 *
 * `unusedOriginPort` has to release its probe socket before the plugin binds the
 * same number, so the port can be taken in between. The plugin then reports the
 * genuine `origin_listen_port_in_use` collision; this fixture re-probes and
 * retries within a bound instead of failing the run on host port churn. Every
 * other outcome is returned untouched so the assertions stay authoritative.
 */
async function startOriginOnFreePort(route: WebRoute): Promise<{
  port: number
  form: { publicOrigin: string; listenPort: number }
  configured: { status: number; body: string }
  started: { status: number; body: string }
}> {
  for (let attempt = 0; ; attempt += 1) {
    const port = await unusedOriginPort()
    const form = { publicOrigin: 'https://phone.example.com:8815', listenPort: port }
    const configured = await invoke(route, 'POST', '/api/mobile-access/remote/origin/configure', JSON.stringify(form))
    const started = await invoke(route, 'POST', '/api/mobile-access/remote/control', JSON.stringify({ running: true }))
    const collided = (JSON.parse(started.body) as { errorCode?: string }).errorCode === 'origin_listen_port_in_use'
    if (collided && attempt < ORIGIN_PORT_ATTEMPTS - 1) continue
    return { port, form, configured, started }
  }
}

async function managedSetupFile(upstreamOrigin: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-managed-plugin-'))
  temporaryDirectories.push(directory)
  const generated = await generate([{ name: 'commonName', value: 'DSH Mobile test CA' }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    extensions: [{ name: 'basicConstraints', cA: true, critical: true }],
  })
  const caCertFile = join(directory, 'ca.pem')
  await writeFile(caCertFile, generated.cert)
  await writeFile(join(directory, 'ca-key.pem'), generated.private)
  const setupFile = join(directory, 'setup.json')
  await writeFile(setupFile, JSON.stringify({
    version: 2,
    networkInterface: 'unused-while-disabled',
    listenPort: 3443,
    upstreamOrigin,
    tls: {
      mode: 'managed',
      caCertFile,
      caKeyFile: join(directory, 'ca-key.pem'),
      certFile: join(directory, 'server.pem'),
      keyFile: join(directory, 'server-key.pem'),
    },
  }))
  return setupFile
}

describe('managed LAN rebind HTTP route', () => {
  it('blocks enabling an uncertain configuration until an explicit successful rebind', async () => {
    const networks = [
      { name: 'unused-while-disabled', address: '10.0.0.5', cidr: '10.0.0.0/24' },
      { name: 'Ethernet', address: '10.1.0.5', cidr: '10.1.0.0/24' },
    ]
    vi.spyOn(managedSetup, 'availableLanNetworks').mockReturnValue(networks)
    vi.spyOn(managedSetup, 'selectLanNetwork').mockImplementation((_address, name) => {
      const selected = networks.find(item => name === undefined || item.name === name)
      if (selected === undefined) throw new Error('Unavailable interface')
      return selected
    })
    const setupFile = await managedSetupFile('http://127.0.0.1:3080')
    const mounted = await mount(false, 3080, { setupFile })
    const original = lanRebind.rebindManagedLan
    const change = vi.spyOn(lanRebind, 'rebindManagedLan').mockRejectedValue(new MobileAccessReconfigurationError(false, new Error('Owned recovery failure')))
    expect((await invoke(mounted.route, 'POST', '/api/mobile-access/lan/rebind', '{"networkInterface":"Ethernet"}')).status).toBe(500)
    const uncertain = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    expect(JSON.parse(uncertain.body)).toMatchObject({ running: false, recoveryRequired: true })
    const enable = await invoke(mounted.route, 'POST', '/api/mobile-access/lan/control', '{"running":true}')
    expect(enable.status).toBe(409)
    expect(enable.body).toContain('lan_rebind_recovery_required')
    change.mockImplementation(original)
    // Reapplying the original selection is allowed as an explicit recovery action.
    expect((await invoke(mounted.route, 'POST', '/api/mobile-access/lan/rebind', '{"networkInterface":"unused-while-disabled"}')).status).toBe(200)
    const restored = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    expect(JSON.parse(restored.body)).toMatchObject({ running: false })
    expect(JSON.parse(restored.body)).not.toHaveProperty('recoveryRequired')
  })

  it('preserves stopped state and trusted networks through repeated changes and returns the current interface', async () => {
    const networks = [
      { name: 'unused-while-disabled', address: '10.0.0.5', cidr: '10.0.0.0/24' },
      { name: 'Ethernet', address: '10.1.0.5', cidr: '10.1.0.0/24' },
    ]
    vi.spyOn(managedSetup, 'availableLanNetworks').mockReturnValue(networks)
    vi.spyOn(managedSetup, 'preferredLanInterfaceNames').mockResolvedValue([])
    vi.spyOn(managedSetup, 'selectLanNetwork').mockImplementation((_address, name) => {
      const selected = networks.find(item => name === undefined || item.name === name)
      if (selected === undefined) throw new Error('Unavailable interface')
      return selected
    })
    const setupFile = await managedSetupFile('http://127.0.0.1:3080')
    const current = managedSetup.parseManagedSetup(JSON.parse(await readFile(setupFile, 'utf8')))
    await writeFile(setupFile, JSON.stringify({ ...current, extraAllowedCidrs: ['10.80.0.0/16'] }))
    const mounted = await mount(false, 3080, { setupFile })
    const caBefore = await readFile(current.tls.caCertFile, 'utf8')
    const path = '/api/mobile-access/lan/rebind'
    for (const name of ['Ethernet', 'unused-while-disabled', 'Ethernet']) {
      expect((await invoke(mounted.route, 'POST', path, JSON.stringify({ networkInterface: name }))).status).toBe(200)
      const saved = managedSetup.parseManagedSetup(JSON.parse(await readFile(setupFile, 'utf8')))
      expect(saved.networkInterface).toBe(name)
      expect(saved.extraAllowedCidrs).toEqual(['10.80.0.0/16'])
      expect(saved.tls).toEqual(current.tls)
      expect(await readFile(current.tls.caCertFile, 'utf8')).toBe(caBefore)
      const status = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
      expect(JSON.parse(status.body)).toMatchObject({ running: false, rebindSupported: true })
      const listed = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/networks')
      expect(JSON.parse(listed.body).currentInterface).toBe(name)
      expect((await invoke(mounted.route, 'POST', path, JSON.stringify({ networkInterface: name }))).status).toBe(409)
    }
    const invalid = await invoke(mounted.route, 'POST', path, JSON.stringify({ networkInterface: 'Ethernet', ignored: true }))
    expect(invalid.status).toBe(400)
    const foreign = await invoke(mounted.route, 'POST', path, '{"networkInterface":"Ethernet"}', '127.0.0.1',
      { origin: 'https://foreign.invalid', 'sec-fetch-site': 'cross-site' })
    expect(foreign.status).toBe(403)
    await writeFile(setupFile, '{broken configuration')
    const corrupt = await invoke(mounted.route, 'POST', path, '{"networkInterface":"unused-while-disabled"}')
    expect(corrupt.status).toBe(409)
    expect(corrupt.body).toContain('lan_rebind_configuration_invalid')
    expect(await readFile(setupFile, 'utf8')).toBe('{broken configuration')
  })
})

describe('upstream browser authentication', () => {
  const upstreamOrigin = new URL('http://127.0.0.1:3080')
  const withConnection = (connection: unknown): Context => ({ connection } as unknown as Context)

  it('keeps the launch-token URL a stock DSH connection returns', () => {
    const authenticatedUrl = upstreamAuthenticatedUrl(withConnection({
      authenticatedUrl: (baseUrl: string) => `${baseUrl}/?token=launch-token`,
    }), upstreamOrigin)
    expect(authenticatedUrl).toBe('http://127.0.0.1:3080/?token=launch-token')
  })

  it('reports no upstream URL when browser authentication is disabled, so the gateway proxies without a cookie', () => {
    // dsh-lan-access `noAuth: true` replaces `authenticatedUrl` with one that
    // returns the bare origin. Handing that URL to the gateway made its cookie
    // exchange reject every proxied route with `upstream_unavailable`.
    const authenticatedUrl = upstreamAuthenticatedUrl(withConnection({
      authenticatedUrl: (baseUrl: string) => baseUrl,
    }), upstreamOrigin)
    expect(authenticatedUrl).toBeUndefined()
  })

  it('reports no upstream URL when the connection service exposes no browser authentication', () => {
    expect(upstreamAuthenticatedUrl(withConnection(undefined), upstreamOrigin)).toBeUndefined()
    expect(upstreamAuthenticatedUrl(withConnection({}), upstreamOrigin)).toBeUndefined()
    expect(upstreamAuthenticatedUrl(withConnection({ authenticatedUrl: 'not-a-function' }), upstreamOrigin)).toBeUndefined()
  })

  it('reports no upstream URL when the connection service returns a malformed URL', () => {
    expect(upstreamAuthenticatedUrl(withConnection({
      authenticatedUrl: () => 'not a url',
    }), upstreamOrigin)).toBeUndefined()
  })

  it('does not swallow a failing connection service', () => {
    // Only parsing the returned URL is guarded. A broken connection service must
    // keep failing plugin activation instead of silently proxying unauthenticated.
    expect(() => upstreamAuthenticatedUrl(withConnection({
      authenticatedUrl: () => { throw new Error('connection unavailable') },
    }), upstreamOrigin)).toThrow('connection unavailable')
  })
})

describe('remote Funnel gateway configuration', () => {
  it('propagates an independent installation identity to public, own-Origin and pinned FRP entries', () => {
    const installationId = 'd'.repeat(64)
    const template = { ...parseGatewayConfig({ stateFile: join(tmpdir(), 'installation-config-template.json'), listenPort: 0, tls: { mode: 'disabled' } }), installationId }
    const stateFile = join(tmpdir(), 'installation-config-devices.json')
    const publicConfig = remoteGatewayConfig(template, 'https://phone.example.com', stateFile, 'a'.repeat(64))
    const originConfig = originGatewayConfig(template, parseOriginSettings({ publicOrigin: 'https://phone.example.com', listenHost: '127.0.0.1', allowedCidrs: ['127.0.0.0/8'] }), stateFile, 'b'.repeat(64), 0)
    const frpConfig = frpIngressGatewayConfig(template, parseFrpSettings({ serverAddress: '1.2.3.4', serverPort: 7000, token: '0123456789abcdef0123456789abcdef', publicOrigin: 'https://1.2.3.4', mode: 'attach', entryTls: 'self-signed' }), stateFile, {
      caFingerprint: 'c'.repeat(64),
      paths: { directory: tmpdir(), caCertFile: 'ca.pem', caKeyFile: 'ca-key.pem', certFile: 'cert.pem', keyFile: 'key.pem', statusFile: 'status.json' },
    })
    expect([publicConfig, originConfig, frpConfig].map(config => config.installationId)).toEqual([installationId, installationId, installationId])
    expect([publicConfig, originConfig, frpConfig].map(config => config.instanceId)).toEqual(['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)])
    expect(frpConfig.pairingCaFile).toBe('ca.pem')
    expect(remoteGatewayConfig(parseGatewayConfig({ stateFile: join(tmpdir(), 'installation-config-template.json'), listenPort: 0, tls: { mode: 'disabled' } }), 'https://phone.example.com', stateFile, 'a'.repeat(64))).not.toHaveProperty('installationId')
  })

  it('keeps public HTTPS on 443 when the private listener uses an ephemeral port', () => {
    const template = parseGatewayConfig({
      listenHost: '127.0.0.1',
      listenPort: 0,
      publicAuthorities: ['127.0.0.1'],
      allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(tmpdir(), 'dsh-mobile-remote-template.json'),
      tls: { mode: 'disabled' },
    })
    const publicHost = 'dsh-14a71b788377-1.tail775400.ts.net'
    const config = remoteGatewayConfig(
      template,
      `https://${publicHost}`,
      join(tmpdir(), 'dsh-mobile-remote-devices.json'),
      'a'.repeat(64),
    )
    const policy = new RequestTrustPolicy(
      config.authorities,
      58_916,
      [parseCidr('127.0.0.0/8')],
      config.publicTls,
    )

    expect(config.authorities).toEqual([{ hostname: publicHost, port: 443 }])
    expect([...policy.origins]).toEqual([`https://${publicHost}`])
    expect(policy.acceptsHost(publicHost)).toBe(true)
    expect(policy.acceptsOrigin(`https://${publicHost}`)).toBe(true)
    expect(policy.acceptsHost(`${publicHost}:58916`)).toBe(false)
    expect(policy.acceptsOrigin(`https://${publicHost}:58916`)).toBe(false)
  })

  it('allows a transport-owned fixed loopback port without changing the public authority', () => {
    const template = parseGatewayConfig({
      listenHost: '127.0.0.1',
      listenPort: 0,
      publicAuthorities: ['127.0.0.1'],
      allowedCidrs: ['127.0.0.0/8'],
      stateFile: join(tmpdir(), 'dsh-mobile-remote-template.json'),
      excludedClientModules: ['@example/optional-client'],
      tls: { mode: 'disabled' },
    })
    const config = remoteGatewayConfig(
      template,
      'https://example.r8.cpolar.cn',
      join(tmpdir(), 'dsh-mobile-cpolar-devices.json'),
      'b'.repeat(64),
      45_321,
    )

    expect(config.listenPort).toBe(45_321)
    expect(config.authorities).toEqual([{ hostname: 'example.r8.cpolar.cn', port: 443 }])
    expect(config.excludedClientModules).toEqual(['@example/optional-client'])
  })
})

describe('private HTTP origin gateway configuration', () => {
  it('preserves a non-default public TLS port without inheriting LAN trust or certificates', () => {
    const template = parseGatewayConfig({
      listenHost: '127.0.0.1', listenPort: 3443, publicAuthorities: ['127.0.0.1:3443'],
      allowedCidrs: ['127.0.0.0/8'], stateFile: join(tmpdir(), 'origin-lan-template.json'), tls: { mode: 'disabled' },
    })
    const settings = parseOriginSettings({
      publicOrigin: 'https://phone.example.com:8815', listenHost: '192.168.10.20',
      allowedCidrs: ['192.168.10.1/32'],
    })
    const config = originGatewayConfig({ ...template, pairingCaFile: join(tmpdir(), 'unused-lan-ca.pem') }, settings,
      join(tmpdir(), 'origin-remote-devices.json'), 'c'.repeat(64))
    expect(config).toMatchObject({ listenHost: '192.168.10.20', listenPort: 3444, tls: { mode: 'disabled' }, publicTls: true, discovery: false })
    expect(config.pairingCaFile).toBeUndefined()
    expect(config.allowedCidrs.map(cidr => cidr.source)).toEqual(['192.168.10.1/32'])
    const policy = new RequestTrustPolicy(config.authorities, 3444, config.allowedCidrs, config.publicTls)
    expect([...policy.origins]).toEqual(['https://phone.example.com:8815'])
    expect(policy.acceptsHost('phone.example.com:8815')).toBe(true)
    expect(policy.acceptsHost('phone.example.com')).toBe(false)
    expect(policy.acceptsHost('192.168.10.20:3444')).toBe(false)
    expect(policy.acceptsOrigin('http://phone.example.com:8815')).toBe(false)
    expect(template.listenPort).toBe(3443)
  })
})

describe('stock DSH lifecycle', () => {
  it.each(['lan', 'own-Origin'] as const)('records real auth and HTTP parser failures through the %s Gateway factory', async mode => {
    const mounted = await mount(mode === 'lan')
    const messages = observePluginWarnings(mounted.context)
    let port: number
    let origin: string
    if (mode === 'lan') {
      const status = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
      origin = responseString(JSON.parse(status.body) as Record<string, unknown>, 'origin')
      port = Number(new URL(origin).port)
    } else {
      const selected = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/provider', '{"provider":"origin"}')
      expect(selected.status).toBe(200)
      const started = await startOriginOnFreePort(mounted.route)
      expect(JSON.parse(started.started.body)).toMatchObject({ provider: 'origin', running: true, state: 'ready' })
      port = started.port
      origin = started.form.publicOrigin
    }
    await assertGatewayDiagnosticComposition(messages, port, origin)
    await mounted.context.fiber.dispose()
    const log = await readFile(join(mounted.directory, 'logs', 'dsh-mobile.log'), 'utf8')
    expect(log).toContain('auth failure')
    expect(log).toContain('http failure')
    expect(log).toContain('HPE_HEADER_OVERFLOW')
    expect(log).not.toContain('prompt-private-header-secret-234')
  })

  it('records both diagnostics through the actual ordinary remote and self-signed FRP factories without launching a tunnel', async () => {
    const factories: {
      remote?: FunnelControllerOptions['createGateway']
      frp?: FrpControllerOptions['createGateway']
    } = {}
    const initializeFunnel = FunnelController.prototype.initialize
    const initializeFrp = FrpController.prototype.initialize
    vi.spyOn(FunnelController.prototype, 'initialize').mockImplementation(function (this: FunnelController, initialState) {
      const options = Reflect.get(this, 'options') as FunnelControllerOptions
      factories.remote = options.createGateway
      return initializeFunnel.call(this, initialState)
    })
    vi.spyOn(FrpController.prototype, 'initialize').mockImplementation(function (this: FrpController, initialState) {
      const options = Reflect.get(this, 'options') as FrpControllerOptions
      factories.frp = options.createGateway
      return initializeFrp.call(this, initialState)
    })
    const mounted = await mount()
    const messages = observePluginWarnings(mounted.context)
    if (factories.remote === undefined || factories.frp === undefined) throw new Error('Plugin did not compose both remote Gateway factories')
    const gateways: MobileAccessGateway[] = []
    try {
      const remote = await factories.remote('https://gateway-fixture.example.com')
      gateways.push(remote)
      await assertGatewayDiagnosticComposition(messages, remote.address().port, remote.address().origin)
      const settings = parseFrpSettings({
        mode: 'attach', entryTls: 'self-signed', publicPort: 33_080,
        publicOrigin: 'https://1.2.3.4', serverAddress: '1.2.3.4', serverPort: 7000,
        token: '0123456789abcdef0123456789abcdef',
      })
      // Invoke only the injected Gateway factory. No frpc launch, public DNS,
      // remote listener, vhost exposure check or public discovery probe runs.
      const ingress = await factories.frp('https://1.2.3.4:33080', settings)
      gateways.push(ingress)
      const caFile = ingress.config.pairingCaFile
      if (caFile === undefined) throw new Error('FRP ingress did not retain its pairing CA')
      await assertGatewayDiagnosticComposition(messages, ingress.address().port, ingress.address().origin, {
        ca: await readFile(caFile, 'utf8'), hostname: '1.2.3.4',
      })
    } finally {
      await Promise.all(gateways.map(gateway => gateway.close()))
    }
    await mounted.context.fiber.dispose()
    const log = await readFile(join(mounted.directory, 'logs', 'dsh-mobile.log'), 'utf8')
    expect(log.match(/http failure/gu)).toHaveLength(2)
    expect(log.match(/auth failure/gu)).toHaveLength(2)
    expect(log).not.toContain('prompt-private-header-secret-234')
  })

  it('loads LAN and the selected remote preference while handing prepared states to inactive providers', async () => {
    const load = vi.spyOn(JsonMobileAccessControlStore.prototype, 'load')
    const disable = vi.spyOn(JsonMobileAccessControlStore.prototype, 'disableIfPresent')
    await mount(false)
    expect(disable).toHaveBeenCalledTimes(5)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('requires the WebServer, commands, and Connection services', () => {
    expect(inject).toEqual(['webServer', 'commands', 'connection'])
  })

  it('rejects late admin reads and writes after the plugin generation closes', async () => {
    const mounted = await mount()
    await mounted.context.fiber.dispose()
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    expect(status.status).toBe(503)
    const saved = await invoke(mounted.route, 'POST', '/api/mobile-access/lan/trusted-networks', JSON.stringify({ extraAllowedCidrs: ['10.80.0.0/24'] }))
    expect(saved.status).toBe(503)
  })

  it('continues ordered teardown after failures and aggregates them', async () => {
    const completed: string[] = []
    let failure: unknown
    try {
      await settleCleanupSteps([
        () => { completed.push('route') },
        async () => { completed.push('remote'); throw new Error('remote close failed') },
        async () => { completed.push('lan') },
        async () => { completed.push('extensions'); throw new Error('extension close failed') },
        () => { completed.push('builtin') },
      ])
    } catch (error) { failure = error }
    expect(completed).toEqual(['route', 'remote', 'lan', 'extensions', 'builtin'])
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
  })

  it('owns an admitted Caddy installation until unload aborts and drains its actual download', async () => {
    const bytes = Buffer.from('owned plugin component fixture')
    const hash = createHash('sha256').update(bytes).digest('hex')
    const artifact: CaddyArtifact = {
      version: CADDY_VERSION, platform: process.platform, arch: process.arch,
      downloadUrl: 'https://example.com/fixture/caddy', downloadBytes: bytes.length, downloadSha256: hash,
      executableName: process.platform === 'win32' ? 'caddy.exe' : 'caddy', executableBytes: bytes.length,
      executableSha256: hash, dnsPluginVersion: 'v0.4.3',
    }
    let enter!: (signal: AbortSignal) => void
    let release!: (value: Uint8Array) => void
    const entered = new Promise<AbortSignal>(resolve => { enter = resolve })
    const download = new Promise<Uint8Array>(resolve => { release = resolve })
    const inspect = vi.fn(async () => ({ version: 'v' + CADDY_VERSION + ' h1:fixture',
      modules: 'dns.providers.tencentcloud v0.4.3\nNon-standard modules: 1\n' }))
    const install = CaddyComponentManager.prototype.install
    vi.spyOn(CaddyComponentManager.prototype, 'install').mockImplementation(function (this: CaddyComponentManager) {
      // Only the download/inspection inputs are fixtures; the actual manager queue and close remain in use.
      Object.defineProperties(this, {
        artifact: { value: artifact },
        fetchArtifact: { value: async (_url: string, signal: AbortSignal) => { enter(signal); return download } },
        inspectExecutable: { value: inspect },
      })
      return install.call(this)
    })
    const mounted = await mount(false, 3080, {}, () => undefined)
    const installing = invoke(mounted.route, 'POST', '/api/mobile-access/remote/caddy/component/install', '{"confirm":true}')
    const signal = await entered
    const aborted = new Promise<'aborted'>(resolve => { signal.addEventListener('abort', () => resolve('aborted'), { once: true }) })
    let completed = false
    const disposing = mounted.context.fiber.dispose().then(() => { completed = true; return 'disposed' as const })
    try {
      expect(await Promise.race([aborted, disposing])).toBe('aborted')
      expect(completed).toBe(false)
      expect((await invoke(mounted.route, 'POST', '/api/mobile-access/remote/caddy/component/install', '{"confirm":true}')).status).toBe(503)
    } finally {
      release(bytes)
      await Promise.all([installing, disposing])
    }
    expect(completed).toBe(true)
    expect((await installing).status).not.toBe(200)
    expect(inspect).not.toHaveBeenCalled()
    await expect(lstat(join(mounted.directory, 'components', 'caddy', CADDY_VERSION))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps a loopback control route available while the LAN listener is stopped', async () => {
    const mounted = await mount()
    expect(mounted.route).toMatchObject({ kind: 'prefix', path: '/api/mobile-access' })
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/control')
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toEqual({ running: false, rebindSupported: false })
    const remote = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')
    expect(remote.status).toBe(200)
    const remoteBody = JSON.parse(remote.body) as Record<string, unknown>
    expect(remoteBody.macosHost).toBe(process.platform === 'darwin' ? true : undefined)
    expect(remoteBody).toMatchObject({
      provider: 'tailscale',
      running: false,
      state: 'off',
      providers: {
        tailscale: { bundled: true, running: false, state: 'off' },
        cpolar: {
          bundled: false,
          running: false,
          state: 'off',
          component: { installed: false, configured: false },
        },
        frp: {
          bundled: false,
          running: false,
          state: 'off',
          component: { supported: true, installed: false, version: '0.70.1' },
          configuration: { configured: false, vhostHttpPort: 7080 },
        },
      },
    })
    const diagnostics = await invoke(mounted.route, 'GET', '/api/mobile-access/diagnostics')
    expect(diagnostics.status).toBe(200)
    expect(JSON.parse(diagnostics.body)).toMatchObject({
      version: 1,
      overall: expect.stringMatching(/^(?:ok|attention|error)$/),
      versions: { plugin: DSH_MOBILE_VERSION, minimumAndroidApp: MINIMUM_ANDROID_APP_VERSION },
      checks: expect.any(Array),
      report: expect.stringContaining('DSH Mobile 诊断报告'),
    })
  })

  it('returns a cpolar download-stage error instead of a generic 500', async () => {
    const mounted = await mount()
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('fetch failed')))
    const failed = await invoke(
      mounted.route, 'POST', '/api/mobile-access/remote/cpolar/component/install',
      JSON.stringify({ confirm: true }),
    )
    expect(failed.status).toBe(409)
    expect(JSON.parse(failed.body)).toEqual({ error: 'cpolar_download_failed' })
  })

  it('follows the active WebServer port when no setup upstream is configured', async () => {
    const mounted = await mount(false, 43120)
    expect(mounted.upstreamBase).toBe('http://127.0.0.1:43120')
  })

  it('reports a live third-party remote boot conflict through the desktop diagnostic route', async () => {
    const mounted = await mount(false, 3080, {}, undefined, [
      { kind: 'script', text: '(function(){w["__DSH_REMOTE_CHANNEL_BOOT__"]=seat})();' },
    ])
    const response = await invoke(mounted.route, 'GET', '/api/mobile-access/diagnostics')
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toMatchObject({
      checks: expect.arrayContaining([expect.objectContaining({ reason: 'competing-remote-channel', status: 'warning' })]),
    })
  })

  it('passes the admitted request Peer to newer index collectors without creating another Peer', async () => {
    const mounted = await mount()
    const peer = Object.freeze({ fixture: 'opaque request peer' })
    const admit = vi.fn(() => ({ peer }))
    Object.assign(mounted.context.get('connection')!, { admit })
    const collect = vi.fn((received?: object) => {
      if (received !== peer) throw new Error('Missing admitted Peer')
      return [{ kind: 'script', text: 'window.__DSH_REMOTE_CHANNEL_BOOT__=true' }]
    })
    Object.assign(mounted.context.webServer, { collectIndexInjections: collect })
    const response = await invoke(mounted.route, 'GET', '/api/mobile-access/diagnostics')
    expect(response.status).toBe(200)
    expect(admit).toHaveBeenCalledTimes(1)
    expect(collect).toHaveBeenCalledExactlyOnceWith(peer)
    expect(JSON.parse(response.body).checks).toContainEqual(expect.objectContaining({ reason: 'competing-remote-channel' }))
  })

  it('preserves a newer admission rejection instead of inspecting injections under a fabricated Peer', async () => {
    const mounted = await mount()
    Object.assign(mounted.context.get('connection')!, { admit: () => ({ rejection: 403 }) })
    const collect = vi.fn(() => [])
    Object.assign(mounted.context.webServer, { collectIndexInjections: collect })
    const response = await invoke(mounted.route, 'GET', '/api/mobile-access/diagnostics')
    expect(response.status).toBe(403)
    expect(collect).not.toHaveBeenCalled()
  })

  it('contains a failed optional script inspection without reporting no conflict or leaking its error', async () => {
    const mounted = await mount()
    Object.assign(mounted.context.webServer, { collectIndexInjections: () => { throw new Error('private hook data and token') } })
    const response = await invoke(mounted.route, 'GET', '/api/mobile-access/diagnostics')
    expect(response.status).toBe(200)
    const report = JSON.parse(response.body)
    expect(report.checks).toContainEqual(expect.objectContaining({ reason: 'plugin-inspection-unavailable', status: 'warning' }))
    expect(report.checks).toContainEqual(expect.objectContaining({ reason: 'versions-current' }))
    expect(response.body).not.toContain('private hook data')
  })

  it('allows a private LAN Host on the loopback desktop admin route', async () => {
    const mounted = await mount()
    const allowed = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control', '', '192.168.50.23')
    expect(allowed.status).toBe(200)
    expect(JSON.parse(allowed.body)).toMatchObject({ running: false })
  })

  it('binds optional push Host services across the scoped Loader boundary', async () => {
    const mounted = await mount(false, 3080, {}, () => 401, [], true, false, true, true)
    const pushState = JSON.parse(await readFile(join(mounted.directory, 'mobile-push', 'push-state.json'), 'utf8')) as {
      keys?: { fingerprint: string }
    }
    expect(pushState.keys?.fingerprint).toMatch(/^[0-9a-f]{64}$/u)
    expect(mounted.pushProjectionDisposer).toBeDefined()
    await mounted.context.fiber.dispose()
    expect(mounted.pushProjectionDisposer).toHaveBeenCalledTimes(1)
  })

  it('keeps an already-running Gateway attached across late Host and Registry readiness', async () => {
    const requestRejection = vi.fn(() => undefined)
    const mounted = await mount(true, 3080, {}, requestRejection, [], false, false, false, true)
    let releaseRegistryInit!: () => void
    const registryInitGate = new Promise<void>(resolve => { releaseRegistryInit = resolve })
    let registryInitStarted!: () => void
    const registryInitStartedPromise = new Promise<void>(resolve => { registryInitStarted = resolve })
    const originalInitialize = PushRegistry.prototype.initialize
    const initialize = vi.spyOn(PushRegistry.prototype, 'initialize').mockImplementation(async function (this: PushRegistry) {
      registryInitStarted()
      await registryInitGate
      return originalInitialize.call(this)
    })
    try {
      const status = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
      const origin = responseString(JSON.parse(status.body) as Record<string, unknown>, 'origin')
      const port = Number(new URL(origin).port)
      const installationId = '11111111-1111-4111-8111-111111111111'
      const opened = await invoke(mounted.route, 'POST', '/api/mobile-access/lan/pairing/open', '{}')
      expect(opened.status).toBe(201)
      const token = responseString(JSON.parse(opened.body) as Record<string, unknown>, 'token')
      const paired = await mobileGatewayRequest(port, origin, '/mobile-access/auth/pair', {
        method: 'POST', body: { token, label: 'Late push composition test' },
      })
      expect(paired.status).toBe(201)
      const sessionCookie = paired.headers['set-cookie']?.map(value => value.split(';', 1)[0] ?? '')
        .find(value => value.startsWith(`${SESSION_COOKIE}=`))
      if (sessionCookie === undefined) throw new Error('Owned Gateway pairing did not issue a session cookie')

      const before = await mobileGatewayRequest(port, origin, `/mobile-access/push/config?installationId=${encodeURIComponent(installationId)}`, { cookie: sessionCookie })
      expect(before.status).toBe(200)
      expect(before.body).toMatchObject({ available: false, installationId, status: 'disabled' })

      await mounted.installPushHostServices()
      await mounted.pushProjectionRegistered
      await registryInitStartedPromise
      const configPendingOnReadiness = mobileGatewayRequest(port, origin, `/mobile-access/push/config?installationId=${encodeURIComponent(installationId)}`, { cookie: sessionCookie })
      releaseRegistryInit()
      const after = await configPendingOnReadiness
      expect(initialize).toHaveBeenCalledTimes(1)
      expect(after.status).toBe(200)
      expect(after.body).toMatchObject({ available: true, installationId, status: 'disabled' })
      expect(after.body.publicKey).toMatch(/^[A-Za-z0-9_-]+$/u)
      expect(after.body.keyFingerprint).toMatch(/^[0-9a-f]{64}$/u)
    } finally {
      releaseRegistryInit()
      await mounted.context.fiber.dispose()
    }
  })

  it('drains push initialization before parent disposal and cannot resurrect the runtime', async () => {
    const mounted = await mount()
    let releaseRegistryInit!: () => void
    const registryInitGate = new Promise<void>(resolve => { releaseRegistryInit = resolve })
    let registryInitStarted!: () => void
    const registryInitStartedPromise = new Promise<void>(resolve => { registryInitStarted = resolve })
    const originalInitialize = PushRegistry.prototype.initialize
    const initialize = vi.spyOn(PushRegistry.prototype, 'initialize').mockImplementation(async function (this: PushRegistry) {
      registryInitStarted()
      await registryInitGate
      return originalInitialize.call(this)
    })
    const closeCoordinator = vi.spyOn(PushGatewayCoordinator.prototype, 'close')
    const closeDelivery = vi.spyOn(PushDelivery.prototype, 'close')
    const closeRegistry = vi.spyOn(PushRegistry.prototype, 'close')
    let disposed = false
    try {
      await mounted.installPushHostServices()
      await mounted.pushProjectionRegistered
      await registryInitStartedPromise
      const disposal = mounted.context.fiber.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      releaseRegistryInit()
      await disposal

      expect(initialize).toHaveBeenCalledTimes(1)
      expect(closeCoordinator).not.toHaveBeenCalled()
      expect(closeDelivery).not.toHaveBeenCalled()
      expect(closeRegistry).toHaveBeenCalledTimes(1)
      expect(mounted.pushProjectionDisposer).toHaveBeenCalledTimes(1)
    } finally {
      releaseRegistryInit()
      if (!disposed) await mounted.context.fiber.dispose()
    }
  })

  it('drains replaced Host generation A before publishing generation B', async () => {
    const mounted = await mount(true)
    let releaseGenerationA!: () => void
    const generationAGate = new Promise<void>(resolve => { releaseGenerationA = resolve })
    let generationAStarted!: () => void
    const generationAStartedPromise = new Promise<void>(resolve => { generationAStarted = resolve })
    let generationBStarted!: () => void
    const generationBStartedPromise = new Promise<void>(resolve => { generationBStarted = resolve })
    const originalInitialize = PushRegistry.prototype.initialize
    const originalClose = PushRegistry.prototype.close
    const activeRegistries = new Set<PushRegistry>()
    let maxConcurrentRegistries = 0
    let initializeCount = 0
    const initialize = vi.spyOn(PushRegistry.prototype, 'initialize').mockImplementation(async function (this: PushRegistry) {
      const attempt = ++initializeCount
      activeRegistries.add(this)
      maxConcurrentRegistries = Math.max(maxConcurrentRegistries, activeRegistries.size)
      if (attempt === 1) {
        generationAStarted()
        await generationAGate
      } else if (attempt === 2) {
        generationBStarted()
      }
      return originalInitialize.call(this)
    })
    vi.spyOn(PushRegistry.prototype, 'close').mockImplementation(async function (this: PushRegistry) {
      try { await originalClose.call(this) } finally { activeRegistries.delete(this) }
    })
    const closeCoordinator = vi.spyOn(PushGatewayCoordinator.prototype, 'close')
    let resolveOriginAttached!: () => void
    const originAttached = new Promise<void>(resolve => { resolveOriginAttached = resolve })
    const originalAttachOrigin = PushGatewayCoordinator.prototype.attachOrigin
    const attachOrigin = vi.spyOn(PushGatewayCoordinator.prototype, 'attachOrigin').mockImplementation(function (
      this: PushGatewayCoordinator,
      binding: PushGatewayOriginBinding,
    ) {
      const detach = originalAttachOrigin.call(this, binding)
      resolveOriginAttached()
      return detach
    })
    let providerA: Awaited<ReturnType<typeof mounted.installPushHostServices>> | undefined
    let providerB: Awaited<ReturnType<typeof mounted.installPushHostServices>> | undefined
    try {
      providerA = await mounted.installPushHostServices()
      await providerA.registered
      await generationAStartedPromise
      const losingA = providerA.dispose()
      providerB = await mounted.installPushHostServices()
      releaseGenerationA()
      await losingA
      await providerB.registered
      await generationBStartedPromise
      await originAttached

      expect(initialize).toHaveBeenCalledTimes(2)
      expect(maxConcurrentRegistries).toBe(1)
      expect(activeRegistries.size).toBe(1)
      expect(providerA.projectionDisposer).toHaveBeenCalledTimes(1)
      expect(providerB.projectionDisposer).not.toHaveBeenCalled()
      expect(attachOrigin).toHaveBeenCalledTimes(1)
      expect(closeCoordinator).not.toHaveBeenCalled()

      await mounted.context.fiber.dispose()
      expect(closeCoordinator).toHaveBeenCalledTimes(1)
      expect(providerB.projectionDisposer).toHaveBeenCalledTimes(1)
      expect(activeRegistries.size).toBe(0)
    } finally {
      releaseGenerationA()
      if (providerB !== undefined) await providerB.dispose()
      if (providerA !== undefined) await providerA.dispose()
      await mounted.context.fiber.dispose()
    }
  })

  it('keeps ordinary Mobile active when optional push Host services are absent', async () => {
    const mounted = await mount()
    expect(mounted.command.name).toBe('mobile')
    const localControl = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    expect(localControl.status).toBe(200)
    expect(JSON.parse(localControl.body)).toMatchObject({ running: false })
    await expect(readFile(join(mounted.directory, 'mobile-push', 'push-state.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([false, true])('checks saved push consent before logout without optional Host services (enabled=%s)', async enabled => {
    const mounted = await mount(true)
    const control = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    const origin = responseString(JSON.parse(control.body) as Record<string, unknown>, 'origin')
    const port = Number(new URL(origin).port)
    const opened = await invoke(mounted.route, 'POST', '/api/mobile-access/lan/pairing/open', '{}')
    const token = responseString(JSON.parse(opened.body) as Record<string, unknown>, 'token')
    const paired = await mobileGatewayRequest(port, origin, '/mobile-access/auth/pair', { method: 'POST', body: { token } })
    expect(paired.status).toBe(201)
    const cookie = paired.headers['set-cookie']?.map(value => value.split(';', 1)[0] ?? '').join('; ')
    if (cookie === undefined) throw new Error('Owned logout fixture did not receive pairing cookies')
    const csrf = responseString(paired.body, 'csrfToken')
    const keys = createVapidKeys()
    const fingerprint = vapidFingerprint(keys)
    const store = new JsonPushStore(join(mounted.directory, 'mobile-push', 'push-state.json'))
    await store.save({
      version: 1, keys: { ...keys, fingerprint }, ownerGenerations: [], pending: [], receipts: [], references: [],
      registrations: [{
        scopeId: join(mounted.directory, 'devices.json'), deviceId: responseString(paired.body, 'deviceId'), origin,
        installationId: '11111111-1111-4111-8111-111111111111',
        subscription: { endpoint: 'https://web.push.apple.com/owned-logout-test', keys: { p256dh: keys.publicKey, auth: Buffer.alloc(16).toString('base64url') } },
        locale: 'en', preferences: { question: true, plan: true, approval: true, response: true, goal: true, failure: true },
        generation: 1, keyFingerprint: fingerprint, enabled, health: 'ready',
      }],
    })
    const result = await mobileGatewayRequest(port, origin, '/mobile-access/auth/logout', { method: 'POST', body: {}, cookie, csrf })
    expect(result.status).toBe(enabled ? 503 : 200)
    if (enabled) {
      expect(result.body).toEqual({ error: 'push_unavailable' })
      expect(result.headers['set-cookie']).toBeUndefined()
      const stillAuthenticated = await mobileGatewayRequest(port, origin, '/mobile-access/push/config?installationId=11111111-1111-4111-8111-111111111111', { cookie })
      expect(stillAuthenticated.status).toBe(200)
    } else expect(result.body).toEqual({ loggedOut: true })
    expect((await store.load()).registrations[0]?.enabled).toBe(enabled)
  })

  it('closes the single push runtime on normal plugin unload', async () => {
    vi.useFakeTimers()
    const closeCoordinator = vi.spyOn(PushGatewayCoordinator.prototype, 'close')
    const closeDelivery = vi.spyOn(PushDelivery.prototype, 'close')
    const closeRegistry = vi.spyOn(PushRegistry.prototype, 'close')
    try {
      const mounted = await mount(false, 3080, {}, () => 401, [], true)
      const pushState = JSON.parse(await readFile(join(mounted.directory, 'mobile-push', 'push-state.json'), 'utf8')) as {
        keys?: { fingerprint: string }
      }
      expect(pushState.keys?.fingerprint).toMatch(/^[0-9a-f]{64}$/u)
      expect(mounted.pushProjectionDisposer).toBeDefined()

      await mounted.context.fiber.dispose()
      expect(closeCoordinator).toHaveBeenCalledTimes(1)
      expect(closeDelivery).toHaveBeenCalledTimes(1)
      expect(closeRegistry).toHaveBeenCalledTimes(1)
      expect(mounted.pushProjectionDisposer).toHaveBeenCalledTimes(1)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('resets the shared push key registry through the trusted Desktop route', async () => {
    const requestRejection = vi.fn((request: IncomingMessage) => request.headers.cookie === 'dsh-session=valid' ? undefined : 401)
    const mounted = await mount(false, 3080, {}, requestRejection, [], true)
    const before = JSON.parse(await readFile(join(mounted.directory, 'mobile-push', 'push-state.json'), 'utf8')) as {
      keys?: { fingerprint: string }; registrations: unknown[]; pending: unknown[]; references: unknown[]
    }
    const response = await invoke(mounted.route, 'POST', '/api/mobile-access/push/reset', JSON.stringify({ confirm: 'reset-web-push' }), '127.0.0.1', {
      [DESKTOP_ADMIN_HEADER]: DESKTOP_ADMIN_MARKER, cookie: 'dsh-session=valid',
    })
    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ reset: true })
    const after = JSON.parse(await readFile(join(mounted.directory, 'mobile-push', 'push-state.json'), 'utf8')) as {
      keys?: { fingerprint: string }; registrations: unknown[]; pending: unknown[]; references: unknown[]
    }
    expect(after.keys?.fingerprint).not.toBe(before.keys?.fingerprint)
    expect(after.registrations).toEqual([])
    expect(after.pending).toEqual([])
    expect(after.references).toEqual([])
  })

  it('keeps Mobile controls alive when only push state initialization fails', async () => {
    const requestRejection = vi.fn((request: IncomingMessage) => request.headers.cookie === 'dsh-session=valid' ? undefined : 401)
    const mounted = await mount(false, 3080, {}, requestRejection, [], true, true)

    expect(mounted.command).toBeDefined()
    const control = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    expect(control.status).toBe(200)
    const reset = await invoke(mounted.route, 'POST', '/api/mobile-access/push/reset', JSON.stringify({ confirm: 'reset-web-push' }), '127.0.0.1', {
      [DESKTOP_ADMIN_HEADER]: DESKTOP_ADMIN_MARKER, cookie: 'dsh-session=valid',
    })
    expect(reset.status).toBe(503)
    expect(JSON.parse(reset.body)).toEqual({ error: 'push_unavailable' })
  })

  it('protects the explicit local push key reset with Desktop trust, exact confirmation, and bounded JSON', async () => {
    const requestRejection = vi.fn((request: IncomingMessage) => request.headers.cookie === 'dsh-session=valid' ? undefined : 401)
    const mounted = await mount(false, 3080, {}, requestRejection)
    const path = '/api/mobile-access/push/reset'
    const marker = { [DESKTOP_ADMIN_HEADER]: DESKTOP_ADMIN_MARKER }
    const valid = JSON.stringify({ confirm: 'reset-web-push' })

    const unmarked = await invoke(mounted.route, 'POST', path, valid, '127.0.0.1', { 'content-type': 'application/json' })
    expect(unmarked.status).toBe(403)
    const unauthenticated = await invoke(mounted.route, 'POST', path, valid, '127.0.0.1', marker)
    expect(unauthenticated.status).toBe(403)
    const wrongConfirmation = await invoke(mounted.route, 'POST', path, JSON.stringify({ confirm: true }), '127.0.0.1', {
      ...marker, cookie: 'dsh-session=valid',
    })
    expect(wrongConfirmation.status).toBe(400)
    const extraFields = await invoke(mounted.route, 'POST', path, JSON.stringify({ confirm: 'reset-web-push', installationId: 'attacker' }), '127.0.0.1', {
      ...marker, cookie: 'dsh-session=valid',
    })
    expect(extraFields.status).toBe(400)
    const validButUnavailable = await invoke(mounted.route, 'POST', path, valid, '127.0.0.1', {
      ...marker, cookie: 'dsh-session=valid',
    })
    expect(validButUnavailable.status).toBe(503)
    expect(JSON.parse(validButUnavailable.body)).toEqual({ error: 'push_unavailable' })
    expect(requestRejection).toHaveBeenCalled()
  })

  it('wires explicit management networks to authenticated DSH requests without changing defaults', async () => {
    const authenticate = vi.fn((request: IncomingMessage) => request.headers.cookie === 'dsh-session=valid' ? undefined : 401)
    const mounted = await mount(false, 3080, { adminAllowedCidrs: ['192.168.50.23/32'] }, authenticate)
    const path = '/api/mobile-access/lan/control'
    expect((await invoke(mounted.route, 'GET', path, '', '192.168.50.8', {}, '192.168.50.23')).status).toBe(401)
    expect((await invoke(mounted.route, 'GET', path, '', '192.168.50.8', { cookie: 'dsh-session=valid' }, '192.168.50.23')).status).toBe(200)
    expect((await invoke(mounted.route, 'GET', path, '', '192.168.50.8', { cookie: 'dsh-session=valid', 'x-forwarded-for': '192.168.50.23' }, '192.168.50.24')).status).toBe(403)
    const defaultMount = await mount(false, 3080, {}, authenticate)
    expect((await invoke(defaultMount.route, 'GET', path, '', '192.168.50.8', { cookie: 'dsh-session=valid' }, '192.168.50.23')).status).toBe(403)
  })

  it.each([
    (base: string) => base,
    (_base: string) => 'https://foreign.example/?token=not-ours',
    (base: string) => `${base}/?other=not-a-token`,
  ])('does not open network management when upstream authentication is disabled or unsupported', async authenticationUrl => {
    const mounted = await mount(false, 3080, { adminAllowedCidrs: ['192.168.50.23/32'] }, () => undefined, [], false, false, false, false, true, authenticationUrl)
    const path = '/api/mobile-access/lan/control'
    expect((await invoke(mounted.route, 'GET', path, '', '192.168.50.8', {}, '192.168.50.23')).status).toBe(401)
    expect((await invoke(mounted.route, 'GET', path)).status).toBe(200)
  })

  it('keeps the destructive push key reset loopback-only while admitted NAS management stays available', async () => {
    const authenticate = vi.fn((request: IncomingMessage) => request.headers.cookie === 'dsh-session=valid' ? undefined : 401)
    const mounted = await mount(false, 3080, { adminAllowedCidrs: ['192.168.50.23/32'] }, authenticate, [], false, false, false, false, true,
      base => `${base}/?token=test-launch-token`)
    // The same explicitly admitted, Core-authenticated NAS peer keeps ordinary management…
    expect((await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control', '', '192.168.50.8', { cookie: 'dsh-session=valid' }, '192.168.50.23')).status).toBe(200)
    // …but must not reach the state-destroying notification-key reset.
    const reset = await invoke(mounted.route, 'POST', '/api/mobile-access/push/reset', JSON.stringify({ confirm: 'reset-web-push' }), '192.168.50.8', {
      cookie: 'dsh-session=valid', 'content-type': 'application/json', [DESKTOP_ADMIN_HEADER]: DESKTOP_ADMIN_MARKER,
    }, '192.168.50.23')
    expect(reset.status).toBe(403)
    // Loopback admission is unchanged; the unavailable-service response proves the guard admitted this caller.
    const loopback = await invoke(mounted.route, 'POST', '/api/mobile-access/push/reset', JSON.stringify({ confirm: 'reset-web-push' }), '127.0.0.1', {
      cookie: 'dsh-session=valid', 'content-type': 'application/json', [DESKTOP_ADMIN_HEADER]: DESKTOP_ADMIN_MARKER,
    })
    expect(loopback.status).toBe(503)
    expect(JSON.parse(loopback.body)).toEqual({ error: 'push_unavailable' })
  })

  it('requires an authenticated Host session for official Desktop Origin-less writes', async () => {
    const requestRejection = vi.fn((request: IncomingMessage) => request.headers.cookie === 'dsh-session=valid' ? undefined : 401)
    const mounted = await mount(false, 3080, {}, requestRejection)
    const path = '/api/mobile-access/remote/provider'
    const body = JSON.stringify({ provider: 'cpolar' })
    const desktopHeaders = { [DESKTOP_ADMIN_HEADER]: DESKTOP_ADMIN_MARKER, cookie: 'dsh-session=valid' }

    const unmarked = await invoke(mounted.route, 'POST', path, body, '127.0.0.1', { cookie: 'dsh-session=valid' })
    expect(unmarked.status).toBe(403)
    const unauthenticated = await invoke(mounted.route, 'POST', path, body, '127.0.0.1', { [DESKTOP_ADMIN_HEADER]: DESKTOP_ADMIN_MARKER })
    expect(unauthenticated.status).toBe(403)
    const browserMetadata = await invoke(mounted.route, 'POST', path, body, '127.0.0.1', { ...desktopHeaders, 'sec-fetch-site': 'same-origin' })
    expect(browserMetadata.status).toBe(403)
    const allowed = await invoke(mounted.route, 'POST', path, body, '127.0.0.1', desktopHeaders)
    expect(allowed.status).toBe(200)
    expect(JSON.parse(allowed.body)).toMatchObject({ provider: 'cpolar' })
    expect(requestRejection).toHaveBeenCalledTimes(2)
  })

  it.each([
    '/api/mobile-access/lan/pairing/open',
    '/api/mobile-access/pairing/open',
  ])('keeps authenticated official Desktop writes trusted through %s', async path => {
    const requestRejection = vi.fn((request: IncomingMessage) => request.headers.cookie === 'dsh-session=valid' ? undefined : 401)
    const mounted = await mount(true, 3080, {}, requestRejection)
    const invalidBody = JSON.stringify({ ttlMs: 'not a duration' })
    const marker = { [DESKTOP_ADMIN_HEADER]: DESKTOP_ADMIN_MARKER }

    const unmarked = await invoke(mounted.route, 'POST', path, invalidBody, '127.0.0.1', { cookie: 'dsh-session=valid' })
    expect(unmarked.status).toBe(403)
    const unauthenticated = await invoke(mounted.route, 'POST', path, invalidBody, '127.0.0.1', { ...marker, cookie: 'dsh-session=invalid' })
    expect(unauthenticated.status).toBe(403)
    const allowed = await invoke(mounted.route, 'POST', path, invalidBody, '127.0.0.1', { ...marker, cookie: 'dsh-session=valid' })
    expect(allowed.status).toBe(400)
    expect(JSON.parse(allowed.body)).toEqual({ error: 'bad_request' })
  })

  it('accepts marked Origin-less Web JSON pairing without using Desktop authentication', async () => {
    const openPairing = vi.spyOn(AccessController.prototype, 'openPairing')
    const requestRejection = vi.fn(() => 401 as const)
    const mounted = await mount(true, 3080, {}, requestRejection)
    const path = '/api/mobile-access/lan/pairing/open'
    const marker = { [WEB_ADMIN_HEADER]: WEB_ADMIN_MARKER }
    for (const headers of [
      {},
      { ...marker, 'content-type': 'text/plain' },
      { ...marker, origin: 'http://evil.example' },
      { ...marker, 'sec-fetch-site': 'same-site' },
      { ...marker, [WEB_ADMIN_HEADER]: `${WEB_ADMIN_MARKER}, ${WEB_ADMIN_MARKER}` },
    ]) {
      const rejected = await invoke(mounted.route, 'POST', path, '{}', '192.168.50.23', headers)
      expect(rejected.status).toBe(403)
      expect(JSON.parse(rejected.body)).toEqual({ error: 'forbidden' })
    }
    const preflight = await invoke(mounted.route, 'OPTIONS', path, '', '192.168.50.23', {
      'access-control-request-method': 'POST', 'access-control-request-headers': WEB_ADMIN_HEADER,
    })
    expect(preflight.status).toBe(403)
    expect(openPairing).not.toHaveBeenCalled()
    for (const source of [{}, { 'sec-fetch-site': 'same-origin' }]) {
      const allowed = await invoke(mounted.route, 'POST', path, '{}', '192.168.50.23', { ...marker, ...source })
      expect(allowed.status).toBe(201)
      expect(JSON.parse(allowed.body)).toMatchObject({ token: expect.any(String) })
    }
    expect(openPairing).toHaveBeenCalledTimes(2)
    expect(requestRejection).not.toHaveBeenCalled()
  })

  it('rejects DNS-rebinding and public Host values on the desktop admin route', async () => {
    const mounted = await mount()
    const rebound = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control', '', 'evil.example')
    expect(rebound.status).toBe(403)
    expect(JSON.parse(rebound.body)).toEqual({ error: 'forbidden' })
    const publicHost = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control', '', '8.8.8.8')
    expect(publicHost.status).toBe(403)
    const cgnat = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control', '', '100.64.1.8')
    expect(cgnat.status).toBe(403)
  })

  it('does not present the loopback fallback as LAN access when managed setup is missing', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-unconfigured-plugin-'))
    temporaryDirectories.push(directory)
    const mounted = await mount(false, 3080, { setupFile: join(directory, 'missing-setup.json') })
    expect(await readFile(join(mounted.directory, 'installation-id'), 'utf8')).toMatch(/^[a-f0-9]{64}\n$/u)

    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toMatchObject({ configured: false, restartRequired: false, running: false })
    expect(status.body).not.toContain('127.0.0.1:3443')

    const setup = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/setup')
    expect(setup.status).toBe(200)
    expect(JSON.parse(setup.body)).toMatchObject({ configured: false, listenPort: 3443, networks: expect.any(Array) })

    const started = await invoke(mounted.route, 'POST', '/api/mobile-access/lan/control', JSON.stringify({ running: true }))
    expect(started.status).toBe(409)
    expect(JSON.parse(started.body)).toEqual({ error: 'lan_setup_required' })
  })

  it('follows the active WebServer port instead of a managed setup snapshot', async () => {
    const setupFile = await managedSetupFile('http://127.0.0.1:3080')
    const mounted = await mount(false, 43120, { setupFile })
    expect(mounted.upstreamBase).toBe('http://127.0.0.1:43120')
    expect(await readFile(join(mounted.directory, 'installation-id'), 'utf8')).toMatch(/^[a-f0-9]{64}\n$/u)
  })

  it('ignores a legacy setup upstream snapshot when DSH selects another port', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-legacy-plugin-'))
    temporaryDirectories.push(directory)
    const setupFile = join(directory, 'setup.json')
    await writeFile(setupFile, JSON.stringify({ version: 1, upstreamOrigin: 'http://127.0.0.1:3080' }))
    const mounted = await mount(false, 43120, { setupFile })
    expect(mounted.upstreamBase).toBe('http://127.0.0.1:43120')
  })

  it('starts and stops the gateway through the local control route', async () => {
    const mounted = await mount()
    const started = await invoke(mounted.route, 'POST', '/api/mobile-access/control', JSON.stringify({ running: true }))
    expect(started.status).toBe(200)
    expect(JSON.parse(started.body)).toMatchObject({ running: true })
    const stopped = await invoke(mounted.route, 'POST', '/api/mobile-access/control', JSON.stringify({ running: false }))
    expect(stopped.status).toBe(200)
    expect(JSON.parse(stopped.body)).toEqual({ running: false, rebindSupported: false })
  })

  it('advertises and binds the persisted installation identity through the default fixed gateway', async () => {
    const mounted = await mount(true)
    const instanceId = (await readFile(join(mounted.directory, 'installation-id'), 'utf8')).trim()
    expect(instanceId).toMatch(/^[a-f0-9]{64}$/u)
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    expect(status.status).toBe(200)
    const origin = responseString(JSON.parse(status.body) as Record<string, unknown>, 'origin')
    const port = Number(new URL(origin).port)
    const paired = await nativePairFromRoute(mounted.route, 'lan', port, origin, instanceId)
    expect(paired.installationId).toBe(instanceId)
    await checkNativeCredential(port, origin, responseString(paired, 'deviceToken'), instanceId, responseString(paired, 'deviceId'), responseString(paired, 'installationId'))
    const state = JSON.parse(await readFile(join(mounted.directory, 'devices.json'), 'utf8')) as { version: number; devices: { nativeInstanceId?: string }[] }
    expect(state.version).toBe(2)
    expect(state.devices.map(device => device.nativeInstanceId)).toEqual([instanceId])
  })

  it('keeps exact legacy native wire keys on plugin gateways unless installation identity is explicitly negotiated', async () => {
    const mounted = await mount(true)
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    const origin = responseString(JSON.parse(status.body) as Record<string, unknown>, 'origin')
    const port = Number(new URL(origin).port)
    const installationId = (await readFile(join(mounted.directory, 'installation-id'), 'utf8')).trim()
    for (const capability of ['', 'unknown-feature', 'installation-id']) {
      const opened = await invoke(mounted.route, 'POST', '/api/mobile-access/lan/pairing/open', '{}')
      expect(opened.status).toBe(201)
      const token = responseString(JSON.parse(opened.body) as Record<string, unknown>, 'token')
      const paired = await nativeGatewayRequest(port, origin, '/mobile-access/auth/native-pair', { token }, undefined, capability)
      expect(paired.status).toBe(201)
      const optionalKeys = capability === 'installation-id' ? ['installationId'] : []
      expect(Object.keys(paired.body).sort()).toEqual(['csrfToken', 'deviceExpiresAt', 'deviceId', 'deviceToken', 'instanceId', 'sessionExpiresAt', 'sessionToken', ...optionalKeys].sort())
      const deviceToken = responseString(paired.body, 'deviceToken')
      const probe = await nativeGatewayRequest(port, origin, '/mobile-access/auth/native-probe', { deviceToken }, undefined, capability)
      expect(probe.status).toBe(200)
      expect(Object.keys(probe.body).sort()).toEqual(['deviceExpiresAt', 'deviceId', 'instanceId', ...optionalKeys].sort())
      const renewed = await nativeGatewayRequest(port, origin, '/mobile-access/auth/native-renew', { deviceToken }, undefined, capability)
      expect(renewed.status).toBe(200)
      expect(Object.keys(renewed.body).sort()).toEqual(['csrfToken', 'deviceId', 'instanceId', 'sessionExpiresAt', 'sessionToken', ...optionalKeys].sort())
      if (capability === 'installation-id') {
        for (const body of [paired.body, probe.body, renewed.body]) expect(body.installationId).toBe(installationId)
      }
    }
    for (const action of ['native-pair', 'native-probe', 'native-renew']) {
      const denied = await nativeGatewayRequest(port, origin, `/mobile-access/auth/${action}`, { token: 'X'.repeat(43), deviceToken: 'X'.repeat(43) })
      expect(denied.status).toBe(401)
      expect(denied.body).toEqual({ error: 'authentication_failed' })
    }
  })

  it('shares the persisted installation identity across independently paired CA-backed LAN and own-Origin entries after restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-plugin-ca-grouping-'))
    temporaryDirectories.push(directory)
    const chain = createTestTlsChain()
    const caCertFile = join(directory, 'ca.pem')
    const certFile = join(directory, 'server.pem')
    const keyFile = join(directory, 'server-key.pem')
    await writeFile(caCertFile, chain.rootCert)
    await writeFile(certFile, chain.leafCert + chain.intermediateCert)
    await writeFile(keyFile, chain.leafKey)
    const caId = new X509Certificate(chain.rootCert).fingerprint256.replaceAll(':', '').toLowerCase()
    // Fixed CA-backed config exercises the real plugin LAN factory without
    // requiring a machine-specific interface or managed-certificate renewal.
    const config: Partial<PluginConfig> = {
      stateFile: join(directory, 'devices.json'), controlFile: join(directory, 'control.json'),
      instanceId: caId, pairingCaFile: caCertFile, tls: { mode: 'provided', certFile, keyFile },
    }
    const mounted = await mount(true, 3080, config)
    const installationId = (await readFile(join(directory, 'installation-id'), 'utf8')).trim()
    expect(installationId).not.toBe(caId)
    const lanStatus = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    const lanOrigin = responseString(JSON.parse(lanStatus.body) as Record<string, unknown>, 'origin')
    const lanPort = Number(new URL(lanOrigin).port)
    const lanPair = await nativePairFromRoute(mounted.route, 'lan', lanPort, lanOrigin, caId, chain.rootCert)
    expect(lanPair.installationId).toBe(installationId)
    const selected = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/provider', '{"provider":"origin"}')
    expect(selected.status).toBe(200)
    const remote = await startOriginOnFreePort(mounted.route)
    expect(remote.started.status).toBe(200)
    const remotePair = await nativePairFromRoute(mounted.route, 'remote', remote.port, remote.form.publicOrigin, caId)
    expect(remotePair.installationId).toBe(installationId)
    const lanToken = responseString(lanPair, 'deviceToken')
    const remoteToken = responseString(remotePair, 'deviceToken')
    expect(lanToken).not.toBe(remoteToken)
    const lanDevice = responseString(lanPair, 'deviceId')
    const remoteDevice = responseString(remotePair, 'deviceId')
    await checkNativeCredential(lanPort, lanOrigin, lanToken, caId, lanDevice, installationId, chain.rootCert)
    await checkNativeCredential(remote.port, remote.form.publicOrigin, remoteToken, caId, remoteDevice, installationId)
    // Shared identity is a hint, not interchangeable LAN/remote authorization.
    const wrongChannel = await nativeGatewayRequest(remote.port, remote.form.publicOrigin, '/mobile-access/auth/native-probe', { deviceToken: lanToken })
    expect(wrongChannel.status).toBe(401)
    expect(wrongChannel.body).toEqual({ error: 'authentication_failed' })
    await mounted.context.fiber.dispose()
    contexts.splice(contexts.indexOf(mounted.context), 1)
    const restarted = await mount(true, 3080, config)
    expect((await readFile(join(directory, 'installation-id'), 'utf8')).trim()).toBe(installationId)
    const nextLanStatus = await invoke(restarted.route, 'GET', '/api/mobile-access/lan/control')
    const nextLanOrigin = responseString(JSON.parse(nextLanStatus.body) as Record<string, unknown>, 'origin')
    const nextRemote = await startOriginOnFreePort(restarted.route)
    expect(nextRemote.started.status).toBe(200)
    await checkNativeCredential(Number(new URL(nextLanOrigin).port), nextLanOrigin, lanToken, caId, lanDevice, installationId, chain.rootCert)
    await checkNativeCredential(nextRemote.port, nextRemote.form.publicOrigin, remoteToken, caId, remoteDevice, installationId)
  })

  it('preserves legacy native credentials beside installation-bound own-Origin pairings after plugin restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-plugin-legacy-identity-'))
    temporaryDirectories.push(directory)
    const stateFile = join(directory, 'devices.json')
    const legacyId = parseGatewayConfig({ stateFile, listenPort: 0, tls: { mode: 'disabled' } }).instanceId
    const token = 'L'.repeat(43)
    const deviceId = 'd'.repeat(32)
    const now = Date.now()
    await mkdir(join(directory, 'remote'), { recursive: true })
    await writeFile(join(directory, 'remote', 'devices.json'), JSON.stringify({ version: 1, devices: [{
      id: deviceId, label: 'Legacy composition phone', tokenDigest: createHash('sha256').update(token).digest('hex'),
      createdAt: now - 1000, lastSeenAt: now - 1000, expiresAt: now + 3_600_000,
    }] }), { mode: 0o600 })
    const mounted = await mount(false, 3080, { stateFile })
    const instanceId = (await readFile(join(directory, 'installation-id'), 'utf8')).trim()
    expect(instanceId).not.toBe(legacyId)
    const selected = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/provider', '{"provider":"origin"}')
    expect(selected.status).toBe(200)
    const first = await startOriginOnFreePort(mounted.route)
    expect(first.configured.status).toBe(200)
    expect(JSON.parse(first.started.body)).toMatchObject({ provider: 'origin', running: true, state: 'ready' })
    await checkNativeCredential(first.port, first.form.publicOrigin, token, legacyId, deviceId, instanceId)
    const paired = await nativePairFromRoute(mounted.route, 'remote', first.port, first.form.publicOrigin, instanceId)
    const freshToken = responseString(paired, 'deviceToken')
    const freshDevice = responseString(paired, 'deviceId')
    await checkNativeCredential(first.port, first.form.publicOrigin, freshToken, instanceId, freshDevice, instanceId)
    const stopped = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/control', '{"running":false}')
    expect(JSON.parse(stopped.body)).toMatchObject({ running: false, state: 'off' })
    await mounted.context.fiber.dispose()
    contexts.splice(contexts.indexOf(mounted.context), 1)
    const restarted = await mount(false, 3080, { stateFile })
    expect((await readFile(join(directory, 'installation-id'), 'utf8')).trim()).toBe(instanceId)
    const second = await startOriginOnFreePort(restarted.route)
    expect(JSON.parse(second.started.body)).toMatchObject({ provider: 'origin', running: true, state: 'ready' })
    await checkNativeCredential(second.port, second.form.publicOrigin, token, legacyId, deviceId, instanceId)
    await checkNativeCredential(second.port, second.form.publicOrigin, freshToken, instanceId, freshDevice, instanceId)
  })

  it('retains the explicit operator identity for fixed and own-Origin native entries', async () => {
    const instanceId = 'a'.repeat(64)
    const mounted = await mount(true, 3080, { instanceId })
    expect((await readFile(join(mounted.directory, 'installation-id'), 'utf8')).trim()).not.toBe(instanceId)
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    const origin = responseString(JSON.parse(status.body) as Record<string, unknown>, 'origin')
    const paired = await nativePairFromRoute(mounted.route, 'lan', Number(new URL(origin).port), origin, instanceId)
    await checkNativeCredential(Number(new URL(origin).port), origin, responseString(paired, 'deviceToken'), instanceId, responseString(paired, 'deviceId'), responseString(paired, 'installationId'))
    const stopped = await invoke(mounted.route, 'POST', '/api/mobile-access/lan/control', '{"running":false}')
    expect(JSON.parse(stopped.body)).toMatchObject({ running: false })
    const selected = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/provider', '{"provider":"origin"}')
    expect(selected.status).toBe(200)
    const remote = await startOriginOnFreePort(mounted.route)
    expect(JSON.parse(remote.started.body)).toMatchObject({ provider: 'origin', running: true, state: 'ready' })
    const remotePair = await nativePairFromRoute(mounted.route, 'remote', remote.port, remote.form.publicOrigin, instanceId)
    const installationId = (await readFile(join(mounted.directory, 'installation-id'), 'utf8')).trim()
    expect(paired.installationId).toBe(installationId)
    expect(remotePair.installationId).toBe(installationId)
    expect(installationId).not.toBe(instanceId)
    await checkNativeCredential(remote.port, remote.form.publicOrigin, responseString(remotePair, 'deviceToken'), instanceId, responseString(remotePair, 'deviceId'), installationId)
  })

  it('switches remote providers without changing the LAN runtime', async () => {
    const mounted = await mount()
    const selected = await invoke(
      mounted.route,
      'POST',
      '/api/mobile-access/remote/provider',
      JSON.stringify({ provider: 'cpolar' }),
    )
    expect(selected.status).toBe(200)
    expect(JSON.parse(selected.body)).toMatchObject({ provider: 'cpolar', running: false, state: 'off' })
    const lan = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')
    expect(JSON.parse(lan.body)).toEqual({ running: false, rebindSupported: false })
  })

  it('does not create control files for remote providers that were never enabled', async () => {
    const mounted = await mount()
    for (const provider of ['cpolar', 'cloudflared', 'frp', 'origin', 'iroh']) {
      await expect(lstat(join(mounted.directory, 'remote', provider, 'control.json')))
        .rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('saves and enables only the selected cloudflared provider in one queued operation', async () => {
    const mounted = await mount()
    expect((await invoke(mounted.route, 'POST', '/api/mobile-access/remote/provider', JSON.stringify({ provider: 'cloudflared' }))).status).toBe(200)
    expect((await invoke(mounted.route, 'POST', '/api/mobile-access/remote/cloudflared/tunnel', JSON.stringify({ mode: 'quick', connect: 'yes' }))).status).toBe(400)
    const configured = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/cloudflared/tunnel', JSON.stringify({ mode: 'quick', connect: true }))
    expect(configured.status).toBe(200)
    expect(JSON.parse(configured.body)).toMatchObject({ provider: 'cloudflared', running: true, state: 'unavailable', errorCode: 'cloudflared_component_missing' })
    expect((await invoke(mounted.route, 'POST', '/api/mobile-access/remote/control', JSON.stringify({ provider: 'cloudflared', running: false }))).status).toBe(200)
    expect(JSON.parse((await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')).body)).toMatchObject({ running: false })
  })

  it('selects experimental iroh and fails closed without a sidecar', async () => {
    // Pin the companion lookup away from the checkout siblings so the
    // absence below holds on machines with a neighbouring companion clone.
    // The download is stubbed at the network edge so the install failure is
    // hermetic: no test may fetch the real pinned release.
    const previousCompanion = process.env.DSH_MOBILE_IROH_COMPANION
    process.env.DSH_MOBILE_IROH_COMPANION = join(tmpdir(), 'dsh-mobile-no-companion-fixture')
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('too short', { status: 200 }))
    let mounted: Awaited<ReturnType<typeof mount>>
    try {
      mounted = await mount()
    const selected = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/provider', JSON.stringify({ provider: 'iroh' }))
    expect(selected.status).toBe(200)
    expect(JSON.parse(selected.body)).toMatchObject({ provider: 'iroh', running: false, state: 'off' })
    const control = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')
    expect(JSON.parse(control.body)).toMatchObject({
      providers: { iroh: { bundled: false, running: false, state: 'off', component: { supported: expect.any(Boolean), installed: false } } },
    })
    const refused = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/iroh/component/install', '{}')
    expect(refused.status).toBe(400)
    const confirmed = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/iroh/component/install', JSON.stringify({ confirm: true }))
    expect(confirmed.status).toBe(409)
    expect(JSON.parse(confirmed.body)).toEqual({ error: 'iroh_download_size_mismatch' })
    expect(fetch).toHaveBeenCalled()
    fetch.mockRejectedValue(new TypeError('fetch failed'))
    const offline = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/iroh/component/install', JSON.stringify({ confirm: true }))
    expect(offline.status).toBe(409)
    expect(JSON.parse(offline.body)).toEqual({ error: 'iroh_download_failed' })
    const started = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/control', JSON.stringify({ running: true }))
    expect(started.status).toBe(200)
    expect(JSON.parse(started.body)).toMatchObject({ provider: 'iroh', running: true, state: 'unavailable', errorCode: 'iroh_companion_missing' })
    const refusedPurge = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/iroh/component/purge', JSON.stringify({ confirm: true }))
    expect(refusedPurge.status).toBe(409)
    expect(JSON.parse(refusedPurge.body)).toEqual({ error: 'iroh_component_running' })
    const pairing = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/iroh/pairing/begin', '{}')
    expect(pairing.status).toBe(409)
    expect(JSON.parse(pairing.body)).toEqual({ error: 'iroh_not_ready' })
    expect((await invoke(mounted.route, 'POST', '/api/mobile-access/remote/control', JSON.stringify({ running: false, provider: 'iroh' }))).status).toBe(200)
    expect((await invoke(mounted.route, 'POST', '/api/mobile-access/remote/iroh/component/purge', '{}')).status).toBe(400)
    const purged = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/iroh/component/purge', JSON.stringify({ confirm: true }))
    expect(purged.status).toBe(200)
    expect(JSON.parse(purged.body)).toMatchObject({ running: false, providers: { iroh: { component: { installed: false } } } })
    expect((await invoke(mounted.route, 'POST', '/api/mobile-access/remote/control', JSON.stringify({ running: true, provider: 'cloudflared' }))).status).toBe(409)
    expect((await invoke(mounted.route, 'POST', '/api/mobile-access/remote/cloudflared/tunnel', JSON.stringify({ mode: 'quick', connect: true }))).status).toBe(409)
    expect(JSON.parse((await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')).body)).toMatchObject({ provider: 'iroh', running: false })
    } finally {
      if (previousCompanion === undefined) delete process.env.DSH_MOBILE_IROH_COMPANION
      else process.env.DSH_MOBILE_IROH_COMPANION = previousCompanion
    }
  })

  it.each([
    { kind: 'enabled', contents: '{"version":1,"enabled":true}' },
    { kind: 'malformed', contents: 'invalid JSON' },
    { kind: 'oversized', contents: 'x'.repeat(4097) },
  ])('disables an existing $kind nonselected provider before initialization', async ({ contents }) => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-stale-remote-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'remote', 'cpolar', 'control.json')
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, contents)
    const mounted = await mount(false, 3080, { stateFile: join(directory, 'devices.json') })
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1, enabled: false })
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')
    expect(JSON.parse(status.body)).toMatchObject({ provider: 'tailscale', providers: { cpolar: { running: false, state: 'off' } } })
  })

  it('runs and purges the origin independently of LAN while keeping shared remote pairings', async () => {
    const mounted = await mount(true)
    const lanBefore = JSON.parse((await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')).body)
    const selected = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/provider', JSON.stringify({ provider: 'origin' }))
    expect(JSON.parse(selected.body)).toMatchObject({ provider: 'origin', running: false, state: 'off' })
    const { port, form, configured, started } = await startOriginOnFreePort(mounted.route)
    expect(configured.status).toBe(200)
    const metadata = JSON.parse(configured.body).providers.origin.configuration as { storagePath: string }
    expect(JSON.parse(configured.body)).toMatchObject({ providers: { origin: { configuration: {
      configured: true, publicOrigin: form.publicOrigin, listenHost: '127.0.0.1', listenPort: port,
      allowedCidrs: ['127.0.0.0/8'], backendOrigin: 'http://127.0.0.1:' + String(port),
    } } } })
    expect(JSON.parse(started.body)).toMatchObject({ provider: 'origin', running: true, state: 'ready', origin: form.publicOrigin,
      backendOrigin: 'http://127.0.0.1:' + String(port) })
    const pairing = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/pairing/open', '{}')
    expect(pairing.status).toBe(201)
    const opened = JSON.parse(pairing.body) as { token: string; appKey: string; pairUrl: string; appPairUrl: string }
    expect(opened.pairUrl).toMatch(/^https:\/\/phone\.example\.com:8815\/mobile-access\/pair#/u)
    expect(opened.appKey).toMatch(/^dsh1\.[a-f0-9]{64}\.[A-Za-z0-9_-]{43}$/u)
    expect(opened.pairUrl).toContain('#instance=')
    expect(opened.appPairUrl).toBe(opened.pairUrl)
    expect(await pairOriginBackend(port, opened.token)).toBe(201)
    const devices = JSON.parse((await invoke(mounted.route, 'GET', '/api/mobile-access/remote/devices')).body).devices
    expect(devices).toHaveLength(1)
    const deviceFile = join(metadata.storagePath, '..', '..', 'devices.json')
    const persistedDevices = JSON.parse(await readFile(deviceFile, 'utf8'))
    const refused = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/origin/purge', '{}')
    expect(refused.status).toBe(400)
    const purged = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/origin/purge', JSON.stringify({ confirm: true }))
    expect(JSON.parse(purged.body)).toMatchObject({ running: false, state: 'off', providers: { origin: { configuration: { configured: false } } } })
    expect(JSON.parse(await readFile(deviceFile, 'utf8'))).toEqual(persistedDevices)
    await expect(readFile(join(metadata.storagePath, 'settings.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(pairOriginBackend(port, opened.token)).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    const lanAfter = JSON.parse((await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')).body)
    expect(lanAfter).toEqual(lanBefore)
    await invoke(mounted.route, 'POST', '/api/mobile-access/remote/origin/configure', JSON.stringify(form))
    await invoke(mounted.route, 'POST', '/api/mobile-access/remote/control', JSON.stringify({ running: true }))
    const restored = JSON.parse((await invoke(mounted.route, 'GET', '/api/mobile-access/remote/devices')).body).devices
    expect(restored).toHaveLength(1)
  })

  it('reports a real port collision without disturbing the existing LAN listener', async () => {
    const mounted = await mount(true)
    const lanBefore = JSON.parse((await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')).body)
    await invoke(mounted.route, 'POST', '/api/mobile-access/remote/provider', JSON.stringify({ provider: 'origin' }))
    const occupiedPort = Number(new URL(lanBefore.origin as string).port)
    expect(occupiedPort).toBeGreaterThan(0)
    const configured = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/origin/configure', JSON.stringify({
      publicOrigin: 'https://phone.example.com:8815', listenPort: occupiedPort,
    }))
    expect(configured.status).toBe(200)
    const started = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/control', JSON.stringify({ running: true }))
    expect(JSON.parse(started.body)).toMatchObject({ running: true, state: 'error', errorCode: 'origin_listen_port_in_use' })
    const stopped = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/control', JSON.stringify({ running: false }))
    expect(JSON.parse(stopped.body)).toMatchObject({ running: false, state: 'off' })
    expect(JSON.parse((await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control')).body)).toEqual(lanBefore)
  })

  it.each([
    [{ publicOrigin: 'http://phone.example.com' }, 'origin_public_origin_invalid'],
    [{ listenHost: '0.0.0.0' }, 'origin_listen_host_invalid'],
    [{ listenHost: '8.8.8.8' }, 'origin_listen_host_invalid'],
    [{ listenPort: 0 }, 'origin_listen_port_invalid'],
    [{ listenPort: 3443 }, 'origin_listen_port_reserved'],
    [{ allowedCidrs: ['0.0.0.0/0'] }, 'origin_allowed_cidrs_invalid'],
    [{ listenHost: '192.168.10.20' }, 'origin_allowed_cidrs_invalid'],
  ])('rejects unsafe origin settings at the local API: %j', async (override, error) => {
    const mounted = await mount()
    const result = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/origin/configure', JSON.stringify({
      publicOrigin: 'https://phone.example.com:8815', ...override,
    }))
    expect(result.status).toBe(400)
    expect(JSON.parse(result.body)).toEqual({ error })
  })

  it('stores restricted FRP settings without returning the token', async () => {
    const mounted = await mount()
    const selected = await invoke(
      mounted.route,
      'POST',
      '/api/mobile-access/remote/provider',
      JSON.stringify({ provider: 'frp' }),
    )
    expect(selected.status).toBe(200)
    const token = '0123456789abcdef0123456789abcdef'
    const configured = await invoke(
      mounted.route,
      'POST',
      '/api/mobile-access/remote/frp/configure',
      JSON.stringify({
        serverAddress: 'frp.example.com',
        serverPort: 7000,
        token,
        publicOrigin: 'https://dsh.example.com',
      }),
    )
    expect(configured.status).toBe(200)
    expect(configured.body).not.toContain(token)
    expect(JSON.parse(configured.body)).toMatchObject({
      provider: 'frp',
      providers: {
        frp: {
          configuration: {
            configured: true,
            serverAddress: 'frp.example.com',
            serverPort: 7000,
            publicOrigin: 'https://dsh.example.com',
          },
        },
      },
    })
  })

  it('keeps distinct FRP proxy names when fixed setups provide the same gateway identity', async () => {
    const instanceId = 'a'.repeat(64)
    const first = await mount(false, 3080, { instanceId })
    const second = await mount(false, 3080, { instanceId })
    const firstName = await frpProxyNameFromRoute(first.route)
    const secondName = await frpProxyNameFromRoute(second.route)
    expect(firstName).toMatch(/^dsh-mobile-[a-f0-9]{12}$/u)
    expect(secondName).not.toBe(firstName)
    expect(await readFile(join(first.directory, 'installation-id'), 'utf8')).toMatch(/^[a-f0-9]{64}\n$/u)
    expect(await readFile(join(second.directory, 'installation-id'), 'utf8')).toMatch(/^[a-f0-9]{64}\n$/u)

    const purged = await invoke(first.route, 'POST', '/api/mobile-access/remote/frp/component/purge', '{"confirm":true}')
    expect(purged.status).toBe(200)
    expect(await frpProxyNameFromRoute(first.route)).toBe(firstName)
    expect(await readFile(join(first.directory, 'installation-id'), 'utf8')).toMatch(/^[a-f0-9]{64}\n$/u)
  })

  it('rewrites a stale managed upstream snapshot to the active DSH port', async () => {
    const setupFile = await managedSetupFile('http://127.0.0.1:11111')
    await mount(false, 57_725, { setupFile })
    const rewritten = JSON.parse(await readFile(setupFile, 'utf8')) as { upstreamOrigin: string; listenPort: number }
    expect(rewritten.upstreamOrigin).toBe('http://127.0.0.1:57725')
    expect(rewritten.listenPort).toBe(3443)
  })

  it('keeps the FRP proxy name when an unconfigured setup becomes managed after restart', async () => {
    const setupDirectory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-setup-'))
    temporaryDirectories.push(setupDirectory)
    const setupFile = join(setupDirectory, 'setup.json')
    const before = await mount(false, 3080, { setupFile })
    const proxyName = await frpProxyNameFromRoute(before.route)
    const marker = await readFile(join(before.directory, 'installation-id'), 'utf8')

    await before.context.fiber.dispose()
    contexts.splice(contexts.indexOf(before.context), 1)
    const managed = await managedSetupFile('http://127.0.0.1:3080')
    await writeFile(setupFile, await readFile(managed, 'utf8'))
    const after = await mount(false, 3080, { setupFile, stateFile: join(before.directory, 'devices.json') })
    expect(await frpProxyNameFromRoute(after.route)).toBe(proxyName)
    expect(await readFile(join(before.directory, 'installation-id'), 'utf8')).toBe(marker)
  })

  it('registers a /mobile command that steers the agent with the customization guide', async () => {
    const mounted = await mount()
    expect(mounted.command).toMatchObject({
      name: 'mobile',
      description: '定制手机界面或添加电脑能力',
      input: { hint: expect.any(String) },
    })
    const steered: { text: string; source: unknown }[] = []
    const agent = {
      steer: (message: { content: readonly { readonly text?: string }[]; source: unknown }) => {
        steered.push({ text: message.content[0]?.text ?? '', source: message.source })
      },
      whenIdle: async (): Promise<void> => undefined,
    }
    const invoke = (rawInput: string) => mounted.command.handler({
      agent,
      commandId: 'id' as never,
      signal: new AbortController().signal,
      rawInput,
    } as never)
    const empty = await invoke('  ')
    expect(empty).toMatchObject({ kind: 'error' })
    expect(steered).toEqual([])
    const result = await invoke(' 把手机端改成深色主题')
    expect(result).toMatchObject({ kind: 'success' })
    expect(steered.length).toBe(1)
    const [steeredMessage] = steered
    expect(steeredMessage).toBeDefined()
    expect(steeredMessage!.text).toContain('mobile-access')
    expect(steeredMessage!.text).toContain('把手机端改成深色主题')
    // The guide rides as a plugin-source context injection, not a user bubble.
    expect(steeredMessage!.source).toMatchObject({
      kind: 'plugin:dsh-mobile',
      form: 'notice',
      summary: '/mobile 把手机端改成深色主题',
    })
  })
})

describe('local worker recovery control routes', () => {
  it('uses authenticated exact-origin admin routes and recovers an unchanged stopped worker', async () => {
    const mounted = await mount(false, 3080, { hostExecution: { mode: 'worker', extensions: ['recoverable'], maxWorkers: 2 } })
    const extensionRoot = join(mounted.directory, 'extensions')
    const directory = join(extensionRoot, 'recoverable'); await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'recoverable', name: 'Recoverable', version: '1' }))
    await writeFile(join(directory, 'host.mjs'), 'export default api => { api.action("probe", {run: () => ({ok:true})}) }')
    await mounted.context.mobileAccess.startLocal(extensionRoot, mounted.context, { hostExecution: { mode: 'worker', extensions: ['recoverable'], maxWorkers: 2, workerModule: await buildExtensionWorkerEntry() } })
    const active = mounted.context.mobileAccess.extension('recoverable') as { readonly worker: {terminate(reason: string): Promise<void>} }
    const running = await invoke(mounted.route, 'GET', '/api/mobile-access/extensions/hosts')
    expect(running.status).toBe(200)
    expect(JSON.parse(running.body)).toMatchObject({hosts:[{id:'recoverable', mode:'worker', state:'ready'}], limits:{workers:1,maxWorkers:2}})
    expect(parseUnavailableExtensionHosts(JSON.parse(running.body))).toEqual([])
    expect(running.body).not.toContain(directory)
    const ready = await invoke(mounted.route, 'POST', '/api/mobile-access/extensions/recover', JSON.stringify({id:'recoverable',confirm:true}))
    expect(ready.status).toBe(409)
    expect(JSON.parse(ready.body)).toEqual({error:'extension_host_running'})
    await active.worker.terminate('test-offline')
    const stopped = await invoke(mounted.route, 'GET', '/api/mobile-access/extensions/hosts')
    expect(parseUnavailableExtensionHosts(JSON.parse(stopped.body))).toEqual([{ id: 'recoverable', name: 'Recoverable', generation: expect.stringMatching(/^[a-f\d]{64}$/u) }])
    const blocked = await invoke(mounted.route, 'POST', '/api/mobile-access/extensions/recover', JSON.stringify({id:'recoverable',confirm:true}), '127.0.0.1', {origin:'https://evil.example','sec-fetch-site':'cross-site'})
    expect(blocked.status).toBe(403)
    expect(mounted.context.mobileAccess.hostStatus().hosts[0]?.state).toBe('unavailable')
    const noConfirmation = await invoke(mounted.route, 'POST', '/api/mobile-access/extensions/recover', JSON.stringify({id:'recoverable'}))
    expect(noConfirmation.status).toBe(400)
    const recovered = await invoke(mounted.route, 'POST', '/api/mobile-access/extensions/recover', JSON.stringify({id:'recoverable',confirm:true}))
    expect(recovered.status).toBe(200)
    expect(JSON.parse(recovered.body)).toMatchObject({hosts:[{id:'recoverable',state:'ready'}]})
    expect(parseUnavailableExtensionHosts(JSON.parse(recovered.body))).toEqual([])
  })
})

describe('attach-mode control routes', () => {
  it('previews the attach runbook over loopback without installing anything', async () => {
    const mounted = await mount()
    const planRequest = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/attach-plan', JSON.stringify({
      serverAddress: '1.2.3.4',
      serverPort: 7000,
      token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://1.2.3.4',
      mode: 'attach',
      entryTls: 'self-signed',
      publicPort: 33_080,
    }))
    expect(planRequest.status).toBe(200)
    const parsed = JSON.parse(planRequest.body) as { frpAttachPlan: Record<string, unknown>; frpAttachTemplate: string }
    expect(parsed.frpAttachPlan).toMatchObject({ mode: 'attach', entryTls: 'self-signed', publicPort: 33_080 })
    expect(parsed.frpAttachPlan.vps as unknown[]).toHaveLength(3)
    expect(parsed.frpAttachTemplate).toContain('type = "tcp"')
    expect(parsed.frpAttachTemplate).toContain('remotePort = 33080')
    expect(parsed.frpAttachTemplate).toContain('ufw allow 33080/tcp')
    // A preview must not persist anything.
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')
    expect(status.body).not.toContain('0123456789abcdef0123456789abcdef')
  })

  it('reports the documented error codes for attach-mode misconfiguration', async () => {
    const mounted = await mount()
    const missingVhost = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/configure', JSON.stringify({
      serverAddress: '1.2.3.4',
      serverPort: 7000,
      token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://1.2.3.4',
      mode: 'attach',
    }))
    expect(missingVhost.status).toBe(409)
    expect(missingVhost.body).toContain('frp_attach_mode_requires_vhost_port')
    const badEntryTls = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/configure', JSON.stringify({
      serverAddress: '1.2.3.4',
      serverPort: 7000,
      token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://1.2.3.4',
      mode: 'deploy',
      entryTls: 'self-signed',
    }))
    expect(badEntryTls.status).toBe(409)
    expect(badEntryTls.body).toContain('frp_entry_tls_invalid')
  })

  it('exposes the self-signed certificate state and reachability on demand', async () => {
    const probe = vi.spyOn(network, 'probeTcpReachable').mockResolvedValue(false)
    const mounted = await mount()
    const configured = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/configure', JSON.stringify({
      serverAddress: '127.0.0.1',
      serverPort: 1,
      token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://8.8.8.8',
      mode: 'attach',
      entryTls: 'self-signed',
      publicPort: 33_080,
    }))
    expect(configured.status).toBe(200)
    expect(configured.body).not.toContain('0123456789abcdef0123456789abcdef')
    const check = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/frp/self-check')
    expect(check.status).toBe(200)
    const parsed = JSON.parse(check.body) as { frpSelfCheck: Record<string, unknown> }
    expect(parsed.frpSelfCheck).toMatchObject({
      mode: 'attach',
      entryTls: 'self-signed',
      publicPort: 33_080,
      // Nothing is listening and the certificate does not exist until the channel
      // starts: both facts are reported instead of throwing.
      frpsReachable: false,
      entryReachable: false,
      inbound: { listenHost: '127.0.0.1', allowedCidrs: ['127.0.0.0/8'] },
    })
    expect((parsed.frpSelfCheck.certificate as Record<string, unknown>).state).toBe('unknown')
    expect(probe).toHaveBeenCalledWith('127.0.0.1', 1)
    expect(probe).toHaveBeenCalledWith('8.8.8.8', 33_080)
    // Never leak the token, key material, or private paths through the self-check.
    expect(check.body).not.toContain('0123456789abcdef0123456789abcdef')
    expect(check.body).not.toContain('ca-key.pem')
  })

  it('checks the public-certificate HTTPS entry instead of the self-signed port', async () => {
    const probe = vi.spyOn(network, 'probeTcpReachable').mockImplementation(async (host, port) => host === '8.8.8.8' && port === 443)
    const mounted = await mount()
    const configured = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/configure', JSON.stringify({
      serverAddress: '127.0.0.1', serverPort: 1, token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://8.8.8.8', mode: 'attach', entryTls: 'public-ip-cert', vhostHttpPort: 7080,
    }))
    expect(configured.status).toBe(200)
    const check = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/frp/self-check')
    expect(check.status).toBe(200)
    expect(JSON.parse(check.body).frpSelfCheck).toMatchObject({ frpsReachable: false, entryReachable: true })
    expect(probe).toHaveBeenCalledWith('8.8.8.8', 443)
    expect(probe).not.toHaveBeenCalledWith('127.0.0.1', 33_080)
  })

  it('purges the FRP-owned CA key, leaf key, and identity marker through the control route', async () => {
    const mounted = await mount()
    const settings = parseFrpSettings({
      serverAddress: '1.2.3.4', serverPort: 7000,
      token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://1.2.3.4', mode: 'attach', entryTls: 'self-signed',
    })
    const stateFile = join(mounted.directory, 'remote', 'devices.json')
    const ingress = await ensureFrpIngressCertificate(settings, stateFile)
    const configured = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/configure', JSON.stringify(settings))
    expect(configured.status).toBe(200)
    const purged = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/component/purge', '{"confirm":true}')
    expect(purged.status).toBe(200)
    for (const file of [ingress.paths.caCertFile, ingress.paths.caKeyFile, ingress.paths.certFile, ingress.paths.keyFile, ingress.paths.statusFile]) {
      await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  })

  it('keeps the managed deploy routes untouched for the default mode', async () => {
    const mounted = await mount()
    const configured = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/configure', JSON.stringify({
      serverAddress: 'frp.example.com',
      serverPort: 7000,
      token: '0123456789abcdef0123456789abcdef',
      publicOrigin: 'https://dsh.example.com',
    }))
    expect(configured.status).toBe(200)
    const parsed = JSON.parse(configured.body) as { providers: { frp: { configuration: Record<string, unknown> } } }
    // A legacy configuration must not gain the new keys in the status payload.
    expect(parsed.providers.frp.configuration).toMatchObject({
      configured: true,
      vhostHttpPort: 7080,
    })
    expect(parsed.providers.frp.configuration).not.toHaveProperty('mode')
    expect(parsed.providers.frp.configuration).not.toHaveProperty('entryTls')
    expect(parsed.providers.frp.configuration).not.toHaveProperty('publicPort')
  })

  it('never returns a saved FRP token from the attach preview, even on a reveal request', async () => {
    const mounted = await mount()
    const token = '0123456789abcdef0123456789abcdef'
    const request = {
      serverAddress: '1.2.3.4',
      serverPort: 7000,
      token,
      publicOrigin: 'https://1.2.3.4',
      mode: 'attach',
      entryTls: 'self-signed',
      publicPort: 33_080,
      user: 'shared-user',
    }
    const masked = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/attach-plan', JSON.stringify(request))
    expect(masked.status).toBe(200)
    const maskedParsed = JSON.parse(masked.body) as {
      frpAttachPlan: { local: { frpcToml: string; tokenMasked: boolean } }
      frpAttachTemplate: string
    }
    // The default preview is masked in both artefacts the panel can copy.
    expect(maskedParsed.frpAttachPlan.local.frpcToml).toContain('auth.token = "***"')
    expect(maskedParsed.frpAttachPlan.local.frpcToml).toContain('user = "shared-user"')
    expect(maskedParsed.frpAttachPlan.local.tokenMasked).toBe(true)
    expect(maskedParsed.frpAttachTemplate).not.toContain(token)
    expect(masked.body).not.toContain(token)
    const configured = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/configure', JSON.stringify(request))
    expect(configured.status).toBe(200)
    // A same-origin script can send this body without a user gesture. The
    // saved token must remain unreadable even when the request asks to reveal it.
    const requestedReveal = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/attach-plan',
      JSON.stringify({ ...request, token: '', revealToken: true }))
    expect(requestedReveal.status).toBe(200)
    const revealedParsed = JSON.parse(requestedReveal.body) as {
      frpAttachPlan: { local: { frpcToml: string; tokenMasked: boolean } }
      frpAttachTemplate: string
    }
    expect(revealedParsed.frpAttachPlan.local.frpcToml).toContain('auth.token = "***"')
    expect(revealedParsed.frpAttachPlan.local.tokenMasked).toBe(true)
    expect(revealedParsed.frpAttachTemplate).not.toContain(token)
    expect(requestedReveal.body).not.toContain(token)
    // The control snapshot also keeps the saved token private.
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')
    expect(status.body).not.toContain(token)
    for (const endpoint of [{ serverAddress: '2.3.4.5' }, { serverPort: 7001 }]) {
      const changedServer = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/configure',
        JSON.stringify({ ...request, ...endpoint, token: '', user: '' }))
      expect(changedServer.status).toBe(400)
      expect(JSON.parse(changedServer.body)).toEqual({ error: 'frp_token_invalid' })
    }
    const cleared = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/configure',
      JSON.stringify({ ...request, token: '', user: '' }))
    expect(cleared.status).toBe(200)
    expect(JSON.parse(cleared.body).providers.frp.configuration).not.toHaveProperty('user')
    expect(cleared.body).not.toContain(token)
    const previewAfterClear = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/attach-plan', '{}')
    expect(previewAfterClear.status).toBe(200)
    expect(JSON.parse(previewAfterClear.body).frpAttachPlan.local.frpcToml).toContain('auth.token = "***"')
    expect(JSON.parse(previewAfterClear.body).frpAttachPlan.local.frpcToml).not.toContain('user =')
  })
})
