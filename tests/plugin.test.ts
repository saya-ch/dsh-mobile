import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { createServer, request as requestHttp } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config, parseGatewayConfig } from '../src/config.js'
import { parseCidr, RequestTrustPolicy } from '../src/network.js'
import { apply, inject, remoteGatewayConfig, settleCleanupSteps } from '../src/plugin.js'
import { DSH_MOBILE_VERSION, MINIMUM_ANDROID_APP_VERSION } from '../src/version.js'

const contexts: Context[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function invoke(route: WebRoute, method: 'GET' | 'POST', path: string, body = ''): Promise<{ status: number; body: string }> {
  const server = createServer((request, response) => { void route.handler(request, response) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  try {
    return await new Promise((resolve, reject) => {
      const request = requestHttp({
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          host: `127.0.0.1:${String(port)}`,
          ...(method === 'POST' ? {
            origin: `http://127.0.0.1:${String(port)}`,
            'sec-fetch-site': 'same-origin',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          } : {}),
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

async function mount(initiallyEnabled = false, webServerPort = 3080): Promise<{ context: Context; route: WebRoute; command: CommandDefinition; upstreamBase: string | undefined }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-plugin-'))
  temporaryDirectories.push(directory)
  let route: WebRoute | undefined
  let command: CommandDefinition | undefined
  let upstreamBase: string | undefined
  const context = new Context()
  contexts.push(context)
  context.provide('webServer', {
    port: webServerPort,
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
  } as never)
  await context.plugin({ Config, inject, apply }, {
    listenPort: 38083,
    stateFile: join(directory, 'devices.json'),
    controlFile: join(directory, 'control.json'),
    customCssFile: join(directory, 'mobile.css'),
    customScriptFile: join(directory, 'mobile.js'),
    initiallyEnabled,
    tls: { mode: 'disabled' },
  })
  if (route === undefined) throw new Error('plugin did not register its control route')
  if (command === undefined) throw new Error('plugin did not register its /mobile command')
  return { context, route, command, upstreamBase }
}

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

  it('follows the active WebServer port when no setup upstream is configured', async () => {
    const mounted = await mount(false, 43120)
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
      kind: 'plugin',
      plugin: 'dsh-mobile',
      form: 'notice',
      summary: '/mobile 把手机端改成深色主题',
    })
  })
})
