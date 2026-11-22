import { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import { createServer, request as requestHttp } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Config } from '../src/config.js'
import { FRP_ATTACH_TOKEN_PLACEHOLDER } from '../src/frp-attach.js'
import { FrpConfigStore, createFrpcToml } from '../src/frp-config.js'
import { apply, inject } from '../src/plugin.js'

const TOKEN = '0123456789abcdef0123456789abcdef'

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
  const authority = `127.0.0.1:${String(port)}`
  try {
    return await new Promise((resolve, reject) => {
      const request = requestHttp({
        host: '127.0.0.1',
        port,
        method,
        path,
        agent: false,
        headers: {
          host: authority,
          ...(method === 'POST' ? {
            origin: `http://${authority}`,
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

async function mount(): Promise<WebRoute> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-mask-'))
  temporaryDirectories.push(directory)
  let route: WebRoute | undefined
  const context = new Context()
  contexts.push(context)
  context.provide('webServer', {
    port: 3080,
    register(candidate: WebRoute) { route = candidate; return () => { if (route === candidate) route = undefined } },
  } as WebServer)
  context.provide('commands', {
    register(_definition: CommandDefinition) { return () => undefined },
  } as never)
  context.provide('connection', {
    authenticatedUrl(baseUrl: string) { return `${baseUrl}/?token=test-launch-token` },
    requestRejection() { return undefined },
  } as never)
  await context.plugin({ Config, inject, apply }, {
    listenPort: 0,
    stateFile: join(directory, 'devices.json'),
    controlFile: join(directory, 'control.json'),
    customCssFile: join(directory, 'mobile.css'),
    customScriptFile: join(directory, 'mobile.js'),
    initiallyEnabled: false,
    tls: { mode: 'disabled' },
  })
  if (route === undefined) throw new Error('plugin did not register its control route')
  return route
}

const ATTACH_FORM = {
  serverAddress: '1.2.3.4',
  serverPort: 7000,
  token: TOKEN,
  publicOrigin: 'https://1.2.3.4',
  mode: 'attach',
  entryTls: 'self-signed',
  publicPort: 33_080,
}

/**
 * The token-masking triad of the attach preview.
 *
 * The panel copies text into the system clipboard, where it survives, so every
 * artefact the plugin produces on its own must mask the token. The file frpc
 * reads still needs the plaintext upstream configuration.
 */
describe('attach preview token masking', () => {
  it('masks the token even when a same-origin caller requests a reveal of saved settings', async () => {
    const route = await mount()
    const configured = await invoke(route, 'POST', '/api/mobile-access/remote/frp/configure', JSON.stringify(ATTACH_FORM))
    expect(configured.status).toBe(200)
    expect(configured.body).not.toContain(TOKEN)

    const preview = await invoke(route, 'POST', '/api/mobile-access/remote/frp/attach-plan', JSON.stringify(ATTACH_FORM))
    expect(preview.status).toBe(200)
    expect(preview.body).not.toContain(TOKEN)
    const parsed = JSON.parse(preview.body) as {
      frpAttachPlan: { local: { frpcToml: string; tokenMasked: boolean } }
      frpAttachTemplate: string
    }
    const maskedAssignment = `auth.token = "${FRP_ATTACH_TOKEN_PLACEHOLDER}"`
    expect(parsed.frpAttachPlan.local.frpcToml).toContain(maskedAssignment)
    expect(parsed.frpAttachPlan.local.frpcToml).not.toContain(TOKEN)
    expect(parsed.frpAttachPlan.local.tokenMasked).toBe(true)
    expect(parsed.frpAttachTemplate).toContain(maskedAssignment)
    expect(parsed.frpAttachTemplate).not.toContain(TOKEN)

    const requestedReveal = await invoke(route, 'POST', '/api/mobile-access/remote/frp/attach-plan',
      JSON.stringify({ ...ATTACH_FORM, token: '', revealToken: true }))
    expect(requestedReveal.status).toBe(200)
    expect(requestedReveal.body).not.toContain(TOKEN)
    const revealedParsed = JSON.parse(requestedReveal.body) as {
      frpAttachPlan: { local: { frpcToml: string; tokenMasked: boolean } }
      frpAttachTemplate: string
    }
    expect(revealedParsed.frpAttachPlan.local.frpcToml).toContain(maskedAssignment)
    expect(revealedParsed.frpAttachPlan.local.tokenMasked).toBe(true)
    expect(revealedParsed.frpAttachTemplate).not.toContain(TOKEN)

    // Nothing is persisted by a preview, and the control payload never carries it.
    const status = await invoke(route, 'GET', '/api/mobile-access/remote/control')
    expect(status.status).toBe(200)
    expect(status.body).not.toContain(TOKEN)
  })

  it('keeps the file frpc reads byte-identical to the upstream plaintext configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-mask-store-'))
    temporaryDirectories.push(directory)
    const store = new FrpConfigStore(join(directory, 'config'))
    await store.initialize()
    await store.configure(ATTACH_FORM)
    await store.writeRuntimeConfig(41_234)
    const written = await readFile(store.runtimeConfigFile, 'utf8')
    // frpc must be able to authenticate, so the on-disk file keeps the real token
    // and stays exactly what createFrpcToml() produces.
    expect(written).toContain(`auth.token = "${TOKEN}"`)
    expect(written).not.toContain(FRP_ATTACH_TOKEN_PLACEHOLDER)
    expect(written).toBe(createFrpcToml(store.settings() ?? (() => { throw new Error('settings missing') })(), 41_234))
  })

  it('never stores the token in the browser draft the panel keeps', async () => {
    const source = await readFile(new URL('../src/client.ts', import.meta.url), 'utf8')
    const stored = [...source.matchAll(/localStorage\.setItem\([^,]+,\s*JSON\.stringify\(\{([\s\S]*?)\}\)/gu)]
      .map(match => match[1] as string)
    expect(stored.length).toBeGreaterThan(0)
    for (const block of stored) expect(block).not.toMatch(/token/iu)
  })
})
