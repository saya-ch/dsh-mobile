import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { createServer, request as requestHttp, type IncomingMessage } from 'node:http'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generate } from 'selfsigned'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Config, parseGatewayConfig, type PluginConfig } from '../src/config.js'
import { parseCidr, RequestTrustPolicy } from '../src/network.js'
import { apply, inject, originGatewayConfig, remoteGatewayConfig, settleCleanupSteps, upstreamAuthenticatedUrl } from '../src/plugin.js'
import { parseOriginSettings } from '../src/origin-proxy-config.js'
import { parseFrpSettings } from '../src/frp-config.js'
import { ensureFrpIngressCertificate } from '../src/frp-ingress.js'
import { DSH_MOBILE_VERSION, MINIMUM_ANDROID_APP_VERSION } from '../src/version.js'
import { DESKTOP_ADMIN_HEADER, DESKTOP_ADMIN_MARKER } from '../src/local-admin-host.js'

const contexts: Context[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function invoke(
  route: WebRoute,
  method: 'GET' | 'POST',
  path: string,
  body = '',
  hostHostname = '127.0.0.1',
  requestHeaders?: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const server = createServer((request, response) => { void route.handler(request, response) })
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

async function mount(
  initiallyEnabled = false,
  webServerPort = 3080,
  config: Partial<PluginConfig> = {},
  requestRejection: (request: IncomingMessage) => 401 | 403 | undefined = () => 401,
  indexInjections: readonly { kind: string; text?: string }[] = [],
): Promise<{ context: Context; route: WebRoute; command: CommandDefinition; upstreamBase: string | undefined; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-plugin-'))
  temporaryDirectories.push(directory)
  let route: WebRoute | undefined
  let command: CommandDefinition | undefined
  let upstreamBase: string | undefined
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
      return `${baseUrl}/?token=test-launch-token`
    },
    requestRejection,
  } as never)
  await context.plugin({ Config, inject, apply }, {
    listenPort: 0,
    stateFile: join(directory, 'devices.json'),
    controlFile: join(directory, 'control.json'),
    customCssFile: join(directory, 'mobile.css'),
    customScriptFile: join(directory, 'mobile.js'),
    initiallyEnabled,
    tls: { mode: 'disabled' },
    ...config,
  })
  if (route === undefined) throw new Error('plugin did not register its control route')
  if (command === undefined) throw new Error('plugin did not register its /mobile command')
  return { context, route, command, upstreamBase, directory }
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
  it('requires the WebServer, commands, and Connection services', () => {
    expect(inject).toEqual(['webServer', 'commands', 'connection'])
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

  it('keeps a loopback control route available while the LAN listener is stopped', async () => {
    const mounted = await mount()
    expect(mounted.route).toMatchObject({ kind: 'prefix', path: '/api/mobile-access' })
    const status = await invoke(mounted.route, 'GET', '/api/mobile-access/control')
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toEqual({ running: false })
    const remote = await invoke(mounted.route, 'GET', '/api/mobile-access/remote/control')
    expect(remote.status).toBe(200)
    expect(JSON.parse(remote.body)).toMatchObject({
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

  it('allows a private LAN Host on the loopback desktop admin route', async () => {
    const mounted = await mount()
    const allowed = await invoke(mounted.route, 'GET', '/api/mobile-access/lan/control', '', '192.168.50.23')
    expect(allowed.status).toBe(200)
    expect(JSON.parse(allowed.body)).toMatchObject({ running: false })
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
    expect(JSON.parse(stopped.body)).toEqual({ running: false })
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
    expect(JSON.parse(lan.body)).toEqual({ running: false })
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

  it('registers a /mobile command that steers the agent with the customization guide', async () => {
    const mounted = await mount()
    expect(mounted.command).toMatchObject({
      name: 'mobile',
      description: expect.any(String),
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
    // Never leak the token, key material, or private paths through the self-check.
    expect(check.body).not.toContain('0123456789abcdef0123456789abcdef')
    expect(check.body).not.toContain('ca-key.pem')
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
    }
    const masked = await invoke(mounted.route, 'POST', '/api/mobile-access/remote/frp/attach-plan', JSON.stringify(request))
    expect(masked.status).toBe(200)
    const maskedParsed = JSON.parse(masked.body) as {
      frpAttachPlan: { local: { frpcToml: string; tokenMasked: boolean } }
      frpAttachTemplate: string
    }
    // The default preview is masked in both artefacts the panel can copy.
    expect(maskedParsed.frpAttachPlan.local.frpcToml).toContain('auth.token = "***"')
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
  })
})
