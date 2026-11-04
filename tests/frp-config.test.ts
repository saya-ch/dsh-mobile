import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FrpConfigStore,
  createFrpServerTemplate,
  createFrpcToml,
  frpProxyName,
  mergeSavedFrpSettings,
  mergeSavedFrpTarget,
  parseFrpSettings,
  validateFrpProxyName,
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

describe('attach mode and entry TLS settings', () => {
  it('keeps every new field optional and rejects unknown keys as before', () => {
    // Optional means a legacy configuration parses into the identical object.
    expect(parseFrpSettings(input)).toEqual({ version: 1, ...input })
    expect(parseFrpSettings(input)).not.toHaveProperty('mode')
    expect(parseFrpSettings({ ...input, mode: 'attach', vhostHttpPort: 8080 })).toMatchObject({
      mode: 'attach', vhostHttpPort: 8080,
    })
    expect(parseFrpSettings({ ...input, mode: 'deploy', entryTls: 'public-ip-cert' })).toMatchObject({
      mode: 'deploy', entryTls: 'public-ip-cert',
    })
    expect(parseFrpSettings({ ...input, publicPort: 33_080 }).publicPort).toBe(33_080)
    expect(() => parseFrpSettings({ ...input, mode: 'tunnel' })).toThrow('frp_settings_invalid')
    expect(() => parseFrpSettings({ ...input, entryTls: 'letsencrypt' })).toThrow('frp_entry_tls_invalid')
    expect(() => parseFrpSettings({ ...input, vhostHttpPort: 0 })).toThrow('frp_settings_invalid')
    expect(() => parseFrpSettings({ ...input, vhostHttpPort: 65_536 })).toThrow('frp_settings_invalid')
    expect(() => parseFrpSettings({ ...input, vhostHttpPort: 8080.5 })).toThrow('frp_settings_invalid')
    // The public entry may never collide with the DSH web, gateway, or origin ports.
    for (const reserved of [3080, 3443, 3444]) {
      expect(() => parseFrpSettings({ ...input, publicPort: reserved })).toThrow('frp_settings_invalid')
    }
    expect(() => parseFrpSettings({ ...input, unknownKey: 1 })).toThrow('frp_settings_invalid')
  })

  it('requires the real vhost port in attach mode unless the vhost is removed', () => {
    // Guessing 7080 for someone else's frps would disarm the exposure gate.
    expect(() => parseFrpSettings({ ...input, mode: 'attach' })).toThrow('frp_attach_mode_requires_vhost_port')
    expect(parseFrpSettings({ ...input, mode: 'attach', vhostHttpPort: 8080 }).vhostHttpPort).toBe(8080)
    // The self-signed entry publishes raw TCP, so there is no vhost to declare.
    expect(() => parseFrpSettings({ ...input, mode: 'attach', entryTls: 'self-signed' }))
      .toThrow('frp_self_signed_requires_public_ipv4')
    expect(parseFrpSettings({ ...input, publicOrigin: 'https://1.2.3.4', mode: 'attach', entryTls: 'self-signed' }).entryTls)
      .toBe('self-signed')
    // Deploy mode never installs a TCP passthrough to someone else's gateway.
    expect(() => parseFrpSettings({ ...input, entryTls: 'self-signed' })).toThrow('frp_entry_tls_invalid')
    expect(() => parseFrpSettings({ ...input, mode: 'deploy', entryTls: 'self-signed' })).toThrow('frp_entry_tls_invalid')
  })

  it('carries the new fields through the saved-configuration merge', () => {
    const saved = parseFrpSettings({ ...input, mode: 'attach', vhostHttpPort: 8080, publicPort: 34_443 })
    expect(mergeSavedFrpSettings({ ...input }, saved)).toMatchObject({
      mode: 'attach', vhostHttpPort: 8080, publicPort: 34_443,
    })
    expect(mergeSavedFrpSettings({ serverAddress: '', serverPort: Number.NaN, token: '', publicOrigin: '' }, saved))
      .toMatchObject({ mode: 'attach', vhostHttpPort: 8080 })
    // A switch back to the managed deployment must be explicit, not implied by a blank.
    expect(mergeSavedFrpSettings({ ...input, mode: 'deploy', entryTls: 'public-ip-cert', vhostHttpPort: 7080 }, saved))
      .toMatchObject({ mode: 'deploy', entryTls: 'public-ip-cert' })
    expect(mergeSavedFrpSettings({ ...input, mode: 'attach', vhostHttpPort: 9090 }, saved).vhostHttpPort).toBe(9090)
    expect(mergeSavedFrpSettings({ ...input, mode: 'attach', vhostHttpPort: 9090 }, saved).mode).toBe('attach')
  })

  it('emits a raw TCP proxy for the self-signed entry only', () => {
    const tcp = createFrpcToml(parseFrpSettings({ ...input, publicOrigin: 'https://1.2.3.4', mode: 'attach', entryTls: 'self-signed', publicPort: 33_080 }), 41234)
    expect(tcp).toContain('type = "tcp"')
    expect(tcp).toContain('remotePort = 33080')
    expect(tcp).toContain('localIP = "127.0.0.1"')
    expect(tcp).toContain('transport.tls.enable = true')
    expect(tcp).not.toContain('customDomains')
    const http = createFrpcToml(parseFrpSettings(input), 41234)
    expect(http).toContain('type = "http"')
    expect(http).not.toContain('remotePort')
  })

  it('reports the effective configuration to the panel and hides the defaults', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-status-'))
    temporaryDirectories.push(directory)
    const store = new FrpConfigStore(join(directory, 'frp'))
    await store.initialize()
    await store.configure(input)
    expect(store.status()).toMatchObject({ vhostHttpPort: 7080 })
    expect(store.status()).not.toHaveProperty('mode')
    expect(store.status()).not.toHaveProperty('entryTls')
    expect(store.status()).not.toHaveProperty('publicPort')
    await store.configure({ ...input, mode: 'attach', vhostHttpPort: 8080 })
    expect(store.status()).toMatchObject({ mode: 'attach', vhostHttpPort: 8080 })
    await store.configure({ ...input, publicOrigin: 'https://1.2.3.4', mode: 'attach', entryTls: 'self-signed', publicPort: 34_443 })
    expect(store.status()).toMatchObject({ mode: 'attach', entryTls: 'self-signed', publicPort: 34_443 })
    expect(JSON.stringify(store.status())).not.toContain(input.token)
    await store.purge()
  })
})

/*
 * Optional frpc `user` field.
 *
 * Shared frps services (for example free public frp panels) namespace proxies
 * per user: frps registers `<user>.<proxyName>`. The field stays optional so a
 * legacy configuration keeps producing byte-identical artefacts, and a blank
 * form input is "absent" rather than an empty string in settings.json.
 */
describe('optional frpc user field', () => {
  it('keeps user optional, normalizes blank to absent, and validates the token form', () => {
    expect(parseFrpSettings({ ...input, user: 'shared-frp.user_1' })).toMatchObject({ user: 'shared-frp.user_1' })
    expect(parseFrpSettings({ ...input, user: '' })).not.toHaveProperty('user')
    expect(parseFrpSettings(input)).not.toHaveProperty('user')
    for (const invalid of ['has space', 'quote"d', 'a/b', '括号', 'x'.repeat(129), 7, null]) {
      expect(() => parseFrpSettings({ ...input, user: invalid as unknown as string })).toThrow('frp_user_invalid')
    }
  })

  it('emits user into frpc.toml for both proxy types and keeps defaults unchanged', () => {
    const withUser = parseFrpSettings({ ...input, user: 'shared-frp.user_1' })
    const http = createFrpcToml(withUser, 42123)
    expect(http).toContain('user = "shared-frp.user_1"')
    expect(http.indexOf('user = "shared-frp.user_1"')).toBeLessThan(http.indexOf('[[proxies]]'))
    const tcp = createFrpcToml(parseFrpSettings({
      ...input, publicOrigin: 'https://1.2.3.4', mode: 'attach', entryTls: 'self-signed', publicPort: 33_080, user: 'shared-frp.user_1',
    }), 41234)
    expect(tcp).toContain('user = "shared-frp.user_1"')
    expect(tcp).toContain('type = "tcp"')
    expect(createFrpcToml(parseFrpSettings(input), 42123)).not.toContain('user')
  })

  it('keeps an omitted user but clears an explicitly blank user without replacing the saved token', async () => {
    const saved = parseFrpSettings({ ...input, user: 'shared-frp.user_1' })
    expect(mergeSavedFrpSettings({ ...input }, saved).user).toBe('shared-frp.user_1')
    const cleared = mergeSavedFrpSettings({ token: '', user: '' }, saved)
    expect(cleared.token).toBe(saved.token)
    expect(cleared).not.toHaveProperty('user')
    expect(createFrpcToml(cleared, 42123)).not.toContain('user =')
    expect(mergeSavedFrpSettings({ ...input, user: 'other.user-1' }, saved).user).toBe('other.user-1')
    expect(mergeSavedFrpSettings({ ...input }, parseFrpSettings(input)).user).toBeUndefined()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-user-'))
    temporaryDirectories.push(directory)
    const store = new FrpConfigStore(join(directory, 'frp'))
    await store.initialize()
    await store.configure({ ...input, user: 'shared-frp.user_1' })
    expect(store.status().user).toBe('shared-frp.user_1')
    await store.writeRuntimeConfig(42123)
    expect(await readFile(store.runtimeConfigFile, 'utf8')).toContain('user = "shared-frp.user_1"')
    await store.configure(input)
    expect(store.status()).not.toHaveProperty('user')
  })
})

/*
 * Shared-frps proxy naming.
 *
 * frps accepts one proxy per name across every client, so the fixed upstream
 * name let any other DSH installation own `dsh-mobile` first: frpc then kept
 * running without publishing the entry port and the start-up self-check ended in
 * `frp_start_timeout`. The product therefore derives the name from the
 * installation identity while the legacy default stays available to callers that
 * cannot supply one.
 */
describe('FRP proxy naming', () => {
  it('derives a stable installation name and validates its inputs', () => {
    expect(frpProxyName('0123456789abcdef'.repeat(4))).toBe('dsh-mobile-0123456789ab')
    // The same installation keeps its name across restarts, so its own stale
    // registration is the only conflict it can ever meet.
    expect(frpProxyName('a'.repeat(64))).toBe(frpProxyName('a'.repeat(64)))
    expect(frpProxyName('a'.repeat(64))).not.toBe(frpProxyName('b'.repeat(64)))
    for (const invalid of ['', 'not-a-fingerprint', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 42, undefined]) {
      expect(() => frpProxyName(invalid as unknown as string)).toThrow('frp_instance_id_invalid')
    }
  })

  it('rejects names frps could not register as one token', () => {
    expect(validateFrpProxyName('dsh-mobile-0123456789ab')).toBe('dsh-mobile-0123456789ab')
    for (const invalid of ['', 'has space', 'quote"d', 'a/b', 'line\nbreak', 'x'.repeat(129), 7, undefined]) {
      expect(() => validateFrpProxyName(invalid as unknown as string)).toThrow('frp_proxy_name_invalid')
    }
  })

  it('writes the derived name into frpc.toml and reports it to the panel', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-name-'))
    temporaryDirectories.push(directory)
    const settings = parseFrpSettings(input)
    expect(createFrpcToml(settings, 42123, 'dsh-mobile-abc123abc123'))
      .toContain('name = "dsh-mobile-abc123abc123"')
    // The legacy default is what the exported API and the compatibility gate pin.
    expect(createFrpcToml(settings, 42123)).toContain('name = "dsh-mobile"')
    expect(() => createFrpcToml(settings, 42123, 'bad name')).toThrow('frp_proxy_name_invalid')

    const store = new FrpConfigStore(join(directory, 'frp'), 'dsh-mobile-abc123abc123')
    await store.initialize()
    await store.configure(input)
    expect(store.status().proxyName).toBe('dsh-mobile-abc123abc123')
    await store.writeRuntimeConfig(42123)
    const written = await readFile(store.runtimeConfigFile, 'utf8')
    expect(written).toContain('name = "dsh-mobile-abc123abc123"')
    expect(() => new FrpConfigStore(join(directory, 'other'), 'bad name')).toThrow('frp_proxy_name_invalid')
  })
})
