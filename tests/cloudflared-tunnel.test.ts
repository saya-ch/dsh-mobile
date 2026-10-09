import { lstat, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CloudflaredTunnelStore,
  mergeSavedCloudflaredTunnelSettings,
  parseCloudflaredTunnelSettings,
  validateCloudflaredTunnelHostname,
  validateCloudflaredTunnelPort,
  validateCloudflaredTunnelToken,
} from '../src/cloudflared-tunnel.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

// Shaped like a real connector token: base64url of a JSON blob.
const token = 'eyJhIjoiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJ0IjoiMDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAwIiwicyI6Ik1EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREF3TURBd01EQXdNREEifQ'
const named = { version: 1 as const, mode: 'named' as const, token, hostname: 'dsh.example.com', port: 3444 }

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

describe('cloudflared tunnel configuration', () => {
  it('preserves the existing controlled error for a non-file saved configuration', async () => {
    const root = await temporaryDirectory('dsh-mobile-tunnel-target-')
    const store = new CloudflaredTunnelStore(root)
    await mkdir(store.settingsFile)
    await expect(store.configure(named)).rejects.toThrow('cloudflared_tunnel_target_invalid')
    expect((await lstat(store.settingsFile)).isDirectory()).toBe(true)
  })

  it('defaults to a quick tunnel and rejects fields a quick tunnel cannot use', () => {
    expect(parseCloudflaredTunnelSettings({ version: 1 })).toEqual({ version: 1, mode: 'quick' })
    expect(parseCloudflaredTunnelSettings({ mode: 'quick' })).toEqual({ version: 1, mode: 'quick' })
    // A quick tunnel allocates its own hostname and port, so carrying either is a
    // configuration error rather than something to silently ignore.
    expect(() => parseCloudflaredTunnelSettings({ mode: 'quick', port: 3444 })).toThrow('cloudflared_tunnel_settings_invalid')
    expect(() => parseCloudflaredTunnelSettings({ mode: 'quick', token })).toThrow('cloudflared_tunnel_settings_invalid')
    expect(() => parseCloudflaredTunnelSettings({ version: 2, mode: 'quick' })).toThrow('cloudflared_tunnel_settings_invalid')
    expect(() => parseCloudflaredTunnelSettings({ mode: 'portable' })).toThrow('cloudflared_tunnel_settings_invalid')
    expect(() => parseCloudflaredTunnelSettings({ ...named, extra: true })).toThrow('cloudflared_tunnel_settings_invalid')
    expect(() => parseCloudflaredTunnelSettings(null)).toThrow('cloudflared_tunnel_settings_invalid')
    expect(parseCloudflaredTunnelSettings(named)).toEqual(named)
  })

  it('requires a routable public hostname that Cloudflare can serve', () => {
    expect(validateCloudflaredTunnelHostname('dsh.example.com')).toBe('dsh.example.com')
    expect(validateCloudflaredTunnelHostname('DSH.Example.COM')).toBe('dsh.example.com')
    expect(validateCloudflaredTunnelHostname('dsh.example.com.')).toBe('dsh.example.com')
    expect(validateCloudflaredTunnelHostname('a-b.c-d.example.com')).toBe('a-b.c-d.example.com')
    // Cloudflare's own control-plane suffixes are never routable player hostnames:
    // one belongs to quick tunnels, the other is the routing target itself.
    for (const host of [
      'localhost', 'dsh', '', ' dsh.example.com', 'dsh.example.com ',
      '1.2.3.4', '*.example.com', 'random.trycloudflare.com',
      'abc123.cfargotunnel.com', '-dsh.example.com', 'dsh-.example.com',
      'dsh..example.com', `dsh.${'a'.repeat(64)}.me`, `dsh.${'a'.repeat(250)}.me`,
      'dsh.example.com/path', 'user@dsh.example.com',
      // The bare apexes are Cloudflare's own and can never be routed to a customer
      // tunnel, so a suffix-only test would let them through.
      'trycloudflare.com', 'cfargotunnel.com',
    ]) {
      expect(() => validateCloudflaredTunnelHostname(host), host).toThrow('cloudflared_tunnel_hostname_invalid')
    }
  })

  it('keeps the forward port out of the privileged range and off the LAN gateway', () => {
    expect(validateCloudflaredTunnelPort(3444)).toBe(3444)
    expect(validateCloudflaredTunnelPort(1024)).toBe(1024)
    expect(validateCloudflaredTunnelPort(65_535)).toBe(65_535)
    for (const port of [1023, 443, 80, 0, -1, 65_536, 3444.5, Number.NaN, '3444']) {
      expect(() => validateCloudflaredTunnelPort(port), String(port)).toThrow('cloudflared_tunnel_port_invalid')
    }
    // 3443 belongs to the LAN gateway for as long as DSH runs, so it is not a
    // transient conflict: it must be named as reserved, not reported busy.
    expect(() => validateCloudflaredTunnelPort(3443)).toThrow('cloudflared_tunnel_port_reserved')
    expect(() => parseCloudflaredTunnelSettings({ ...named, port: 3443 })).toThrow('cloudflared_tunnel_port_reserved')
  })

  it('accepts only a credential-shaped connector token', () => {
    expect(validateCloudflaredTunnelToken(token)).toBe(token)
    expect(validateCloudflaredTunnelToken('a'.repeat(32))).toBe('a'.repeat(32))
    for (const value of ['', 'short', 'a'.repeat(31), ` ${token}`, `${token}\n`, 'has space in it aaaaaaaaaaaaaaaaaaaaaa', undefined, 42]) {
      expect(() => validateCloudflaredTunnelToken(value), String(value).slice(0, 20)).toThrow('cloudflared_tunnel_token_invalid')
    }
  })

  it('merges a blank submit with the saved token so the panel never has to resend it', () => {
    const saved = parseCloudflaredTunnelSettings(named)
    expect(mergeSavedCloudflaredTunnelSettings({ mode: 'named', token: '', hostname: 'other.example.com', port: 4000 }, saved))
      .toEqual({ ...named, hostname: 'other.example.com', port: 4000 })
    expect(mergeSavedCloudflaredTunnelSettings({ mode: 'named' }, saved)).toEqual(named)
    expect(mergeSavedCloudflaredTunnelSettings({ token: 'x'.repeat(32), hostname: 'dsh.example.com', port: 3444 }, saved))
      .toMatchObject({ token: 'x'.repeat(32) })
    expect(mergeSavedCloudflaredTunnelSettings({ mode: 'quick' }, saved)).toEqual({ version: 1, mode: 'quick' })
    // The named branch hardcodes its mode, so an unrecognized value must be refused
    // here rather than silently rewritten into a named tunnel. `null` is not in the
    // list: like the other fields, it means "not supplied" and keeps the saved mode.
    for (const bogus of ['bogus', 'named ', 'NAMED', '', 1, true]) {
      expect(() => mergeSavedCloudflaredTunnelSettings({ mode: bogus, hostname: 'x.example.com' }, saved), String(bogus))
        .toThrow('cloudflared_tunnel_settings_invalid')
    }
    expect(mergeSavedCloudflaredTunnelSettings({ mode: null }, saved)).toEqual(named)
    // Nothing saved and nothing supplied must report a missing configuration
    // rather than a half-built named tunnel.
    expect(() => mergeSavedCloudflaredTunnelSettings({ mode: 'named' }, undefined)).toThrow('cloudflared_tunnel_config_missing')
    expect(() => mergeSavedCloudflaredTunnelSettings({ mode: 'named', hostname: 'dsh.example.com', port: 3444 }, undefined))
      .toThrow('cloudflared_tunnel_config_missing')
    expect(mergeSavedCloudflaredTunnelSettings({ mode: 'named', token: '', hostname: '', port: '' }, saved)).toEqual(named)
  })

  it('stores the token privately and never reports it', async () => {
    const directory = await temporaryDirectory('dsh-mobile-cloudflared-tunnel-')
    const store = new CloudflaredTunnelStore(join(directory, 'cloudflared'))
    await store.initialize()
    expect(store.status()).toMatchObject({ mode: 'quick', configured: false })
    expect(store.settings()).toEqual({ version: 1, mode: 'quick' })

    await store.configure(named)
    expect(store.status()).toMatchObject({ mode: 'named', configured: true, hostname: named.hostname, port: 3444 })
    expect(JSON.stringify(store.status())).not.toContain(token)
    const written = JSON.parse(await readFile(store.settingsFile, 'utf8')) as Record<string, unknown>
    expect(written).toEqual(named)

    // A reload from disk must reproduce the same configuration.
    const reloaded = new CloudflaredTunnelStore(join(directory, 'cloudflared'))
    await reloaded.initialize()
    expect(reloaded.settings()).toEqual(named)
    expect(reloaded.status()).not.toHaveProperty('token')

    // Switching back to a quick tunnel removes the stored credential.
    await store.configure({ mode: 'quick' })
    await expect(lstat(store.settingsFile)).rejects.toMatchObject({ code: 'ENOENT' })

    await store.configure(named)
    await store.purge()
    expect(store.settings()).toEqual({ version: 1, mode: 'quick' })
    await expect(lstat(store.settingsFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('falls back to a quick tunnel when the stored file is unusable', async () => {
    const directory = await temporaryDirectory('dsh-mobile-cloudflared-bad-')
    const root = join(directory, 'cloudflared')
    await mkdir(root, { recursive: true })
    const store = new CloudflaredTunnelStore(root)
    await writeFile(store.settingsFile, '{ not json')

    await store.initialize()
    expect(store.status()).toMatchObject({ mode: 'quick', configured: false, errorCode: 'cloudflared_tunnel_config_invalid' })
    // The provider must still be startable, so the invalid file degrades to quick.
    expect(store.settings()).toEqual({ version: 1, mode: 'quick' })

    // A well-formed file with a bad hostname is equally rejected.
    await writeFile(store.settingsFile, JSON.stringify({ ...named, hostname: 'x.trycloudflare.com' }))
    const second = new CloudflaredTunnelStore(root)
    await second.initialize()
    expect(second.status()).toMatchObject({ mode: 'quick', errorCode: 'cloudflared_tunnel_config_invalid' })
  })

  it('refuses a non-absolute state directory', async () => {
    expect(() => new CloudflaredTunnelStore('relative/dir')).toThrow('cloudflared tunnel state directory must be absolute')
    // The file lives beside the provider's own control state.
    const directory = await temporaryDirectory('dsh-mobile-cloudflared-path-')
    const store = new CloudflaredTunnelStore(join(directory, 'cloudflared'))
    expect(dirname(store.settingsFile)).toBe(join(directory, 'cloudflared'))
  })
})
