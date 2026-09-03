import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FrpConfigStore,
  createFrpServerTemplate,
  createFrpcToml,
  mergeSavedFrpSettings,
  mergeSavedFrpTarget,
  parseFrpSettings,
} from '../src/frp-config.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const input = {
  serverAddress: 'frp.example.com',
  serverPort: 7000,
  token: '0123456789abcdef0123456789abcdef',
  publicOrigin: 'https://dsh.example.com',
}

describe('restricted FRP configuration', () => {
  it('accepts only the fixed single-purpose inputs', () => {
    expect(parseFrpSettings(input)).toEqual({ version: 1, ...input })
    expect(() => parseFrpSettings({ ...input, publicOrigin: 'http://dsh.example.com' })).toThrow('frp_public_origin_invalid')
    expect(parseFrpSettings({ ...input, publicOrigin: 'https://1.2.3.4' }).publicOrigin).toBe('https://1.2.3.4')
    expect(parseFrpSettings({ ...input, serverAddress: '1.2.3.4' }).serverAddress).toBe('1.2.3.4')
    // Documentation, private, and reserved IPv4 literals can never be a public endpoint.
    for (const host of ['203.0.113.10', '192.0.2.1', '198.51.100.7', '192.168.1.20', '10.0.0.8', '100.64.0.8', '0.0.0.0', '255.255.255.255', '224.0.0.1', '198.18.0.1', '192.0.0.1', '192.88.99.1']) {
      expect(() => parseFrpSettings({ ...input, publicOrigin: `https://${host}` })).toThrow('frp_public_origin_invalid')
    }
    // The frpc server address stays permissive so local loopback rigs keep working;
    // VPS operations enforce a public SSH target separately.
    expect(parseFrpSettings({ ...input, serverAddress: '127.0.0.1' }).serverAddress).toBe('127.0.0.1')
    expect(() => parseFrpSettings({ ...input, publicOrigin: 'https://[::1]' })).toThrow('frp_public_origin_invalid')
    expect(() => parseFrpSettings({ ...input, token: 'too-short' })).toThrow('frp_token_invalid')
    expect(() => parseFrpSettings({ ...input, localPort: 3080 })).toThrow('frp_settings_invalid')
  })

  it('merges blank VPS fields with the saved configuration', () => {
    const saved = parseFrpSettings(input)
    expect(mergeSavedFrpSettings({ ...input }, saved)).toEqual({ version: 1, ...input })
    expect(mergeSavedFrpSettings({ serverAddress: '', serverPort: Number.NaN, token: '', publicOrigin: '' }, saved))
      .toEqual({ version: 1, ...input })
    expect(mergeSavedFrpSettings({ ...input, token: 'fedcba9876543210fedcba9876543210' }, saved).token)
      .toBe('fedcba9876543210fedcba9876543210')
    expect(() => mergeSavedFrpSettings({ serverAddress: '', token: '' }, undefined)).toThrow('frp_config_missing')
    expect(() => mergeSavedFrpSettings({ ...input, publicOrigin: 'https://203.0.113.10' }, saved))
      .toThrow('frp_public_origin_invalid')
    expect(mergeSavedFrpTarget({ serverAddress: '', serverPort: 0 }, saved)).toEqual({
      serverAddress: input.serverAddress, serverPort: input.serverPort,
    })
    expect(() => mergeSavedFrpTarget({}, undefined)).toThrow('frp_config_missing')
  })

  it('generates one encrypted HTTP vhost and a loopback-only server template', () => {
    const settings = parseFrpSettings(input)
    const client = createFrpcToml(settings, 42123)
    expect(client).toContain('type = "http"')
    expect(client).toContain('localIP = "127.0.0.1"')
    expect(client).toContain('localPort = 42123')
    expect(client).toContain('customDomains = ["dsh.example.com"]')
    expect(client).toContain('transport.useEncryption = true')
    expect(client).not.toMatch(/tcp|udp|plugin/u)

    const server = createFrpServerTemplate(settings)
    expect(server).toContain('proxyBindAddr = "127.0.0.1"')
    expect(server).toContain('vhostHTTPPort = 7080')
    expect(server).toContain('reverse_proxy 127.0.0.1:7080')
    // The manual site ships as an importable snippet so later cleanup can
    // remove exactly this block without touching user Caddy content.
    expect(server).toContain('/etc/caddy/dsh-mobile-dsh.caddy')
    expect(server).toContain('import /etc/caddy/dsh-mobile-dsh.caddy')
  })

  it('guides manual public-IPv4 deployments to a trusted certificate', () => {
    const settings = parseFrpSettings({ ...input, serverAddress: '1.2.3.4', publicOrigin: 'https://1.2.3.4' })
    const server = createFrpServerTemplate(settings)
    expect(server).toContain('tls /var/lib/caddy/dsh-mobile-certs/fullchain.pem')
    expect(server).toContain('certbot certonly --standalone')
    expect(server).toContain('--ip-address 1.2.3.4')
    const domain = createFrpServerTemplate(parseFrpSettings(input))
    expect(domain).not.toContain('certbot')
  })

  it('keeps the token private and removes all owned configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-config-'))
    temporaryDirectories.push(directory)
    const store = new FrpConfigStore(join(directory, 'frp'))
    await store.initialize()
    expect(store.status()).toMatchObject({ configured: false, vhostHttpPort: 7080 })
    await store.configure(input)
    expect(store.status()).toMatchObject({
      configured: true,
      serverAddress: input.serverAddress,
      serverPort: input.serverPort,
      publicOrigin: input.publicOrigin,
    })
    expect(JSON.stringify(store.status())).not.toContain(input.token)
    expect(await readFile(store.settingsFile, 'utf8')).toContain(input.token)
    await store.writeRuntimeConfig(41234)
    expect((await lstat(store.runtimeConfigFile)).isFile()).toBe(true)
    await store.purge()
    expect(store.status()).toMatchObject({ configured: false })
    await expect(lstat(store.settingsFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
