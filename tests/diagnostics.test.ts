import { describe, expect, it, vi } from 'vitest'
import {
  collectConnectionDiagnostics,
  configuredProxyFor,
  hasCompetingRemoteChannelBoot,
  probeRemoteHealth,
  remoteDiagnosticTimeoutMs,
  type DiagnosticSnapshot,
} from '../src/diagnostics.js'

const healthy: DiagnosticSnapshot = {
  dshVersion: '0.1.1-rc.2',
  lan: {
    running: true,
    origin: 'https://192.168.0.101:3443',
    configuredInterface: 'Wi-Fi',
    interfaceName: 'Wi-Fi',
    port: 3443,
  },
  remote: {
    provider: 'cpolar',
    running: true,
    state: 'ready',
    origin: 'https://private-name.r8.cpolar.cn',
  },
}

describe('connection diagnostics', () => {
  it('recognizes only an active third-party remote boot script row', () => {
    expect(hasCompetingRemoteChannelBoot([{ kind: 'script', text: '(function(){w["__DSH_REMOTE_CHANNEL_BOOT__"]=seat})();' }])).toBe(true)
    const externalScript = [{ kind: 'script-src', src: '/plugins/remote.js' }]
    expect(hasCompetingRemoteChannelBoot(externalScript)).toBe(false)
    expect(hasCompetingRemoteChannelBoot([{ kind: 'script', text: 'window.__DSH_TRANSPORT__={ownsHost:true}' }])).toBe(false)
    expect(hasCompetingRemoteChannelBoot([])).toBe(false)
  })

  it('explains a competing remote pairing flow without treating its code as a DSH Mobile token', async () => {
    const result = await collectConnectionDiagnostics({ ...healthy, competingRemoteChannelBoot: true }, {
      firewall: async () => ({ state: 'ready' }),
      remote: async () => ({ state: 'ready', latencyMs: 86 }),
    })
    expect(result.overall).toBe('attention')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'remote-plugin-conflict', status: 'warning', reason: 'competing-remote-channel', action: expect.stringContaining('不要混用两种配对码') }),
    ]))
  })

  it('reports missing LAN setup as an actionable blocking problem', async () => {
    const result = await collectConnectionDiagnostics({
      ...healthy,
      lan: { configured: false, running: false },
      remote: { provider: 'cpolar', running: false, state: 'off' },
    }, {
      firewall: async () => ({ state: 'not-applicable' }),
      remote: async () => ({ state: 'not-applicable' }),
    })

    expect(result.overall).toBe('error')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'network', status: 'error', reason: 'lan-setup-required', action: expect.stringContaining('选择网卡') }),
    ]))
  })

  it('fits direct and relay attempts inside the desktop diagnostic request budget', () => {
    expect(remoteDiagnosticTimeoutMs('https://private-name.r8.cpolar.cn')).toBe(6_000)
    expect(remoteDiagnosticTimeoutMs('https://example.tail1234.ts.net')).toBe(6_000)
    expect(remoteDiagnosticTimeoutMs('https://example.com')).toBe(6_000)
  })

  it('summarizes healthy LAN and remote paths without copying exact addresses', async () => {
    const result = await collectConnectionDiagnostics(healthy, {
      firewall: async () => ({ state: 'ready' }),
      remote: async () => ({ state: 'ready', latencyMs: 86 }),
    })

    expect(result.overall).toBe('ok')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'lan', status: 'ok', reason: 'lan-ready', facts: { endpointSuffix: 'https://192.168.0.x:3443' } }),
      expect.objectContaining({ id: 'network', reason: 'network-interface', facts: { interfaceName: 'Wi-Fi' } }),
      expect.objectContaining({ id: 'remote', status: 'ok', reason: 'remote-ready', facts: { provider: 'cpolar', endpointSuffix: '*.cpolar.cn', latencyMs: 86 }, detail: expect.stringContaining('86 ms') }),
    ]))
    expect(result.report).toContain('https://192.168.0.x:3443')
    expect(result.report).toContain('endpoint=*.cpolar.cn')
    expect(result.report).not.toContain('192.168.0.101')
    expect(result.report).not.toContain('private-name')
  })

  it('reports only origin backend readiness and never probes user-managed public ingress', async () => {
    const remote = vi.fn(async () => ({ state: 'ready' as const, latencyMs: 1 }))
    const result = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'origin', running: true, state: 'ready', origin: 'https://phone.example.com:8815' },
    }, { firewall: async () => ({ state: 'ready' }), remote })
    expect(remote).not.toHaveBeenCalled()
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'remote', status: 'info', reason: 'remote-origin-ready', facts: { provider: 'origin' } }),
    ]))
    const check = result.checks.find(entry => entry.id === 'remote')!
    expect(check.detail + check.action).toContain('HTTPS')
    expect(check.detail + check.action).toContain('WebSocket')
    expect(result.checks.some(entry => entry.reason === 'remote-ready')).toBe(false)
  })

  it('turns missing firewall rules and provider errors into shortest recovery actions', async () => {
    const result = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'tailscale', running: true, state: 'error', errorCode: 'funnel_permission_required' },
    }, {
      firewall: async () => ({ state: 'missing' }),
      remote: async () => ({ state: 'not-applicable' }),
    })

    expect(result.overall).toBe('error')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'firewall', status: 'warning', action: expect.stringContaining('setup') }),
      expect.objectContaining({ id: 'remote', status: 'error', reason: 'remote-controller-error', facts: { provider: 'tailscale', controllerCode: 'funnel_permission_required' }, action: '继续完成 Tailscale Funnel 授权。' }),
    ]))
  })

  it('reports observed provider throttling without claiming an account quota', async () => {
    const result = await collectConnectionDiagnostics(healthy, {
      firewall: async () => ({ state: 'ready' }),
      remote: async () => ({ state: 'rate-limited', latencyMs: 210 }),
    })

    expect(result.overall).toBe('attention')
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'remote', status: 'warning', reason: 'remote-rate-limited', facts: { provider: 'cpolar', endpointSuffix: '*.cpolar.cn', latencyMs: 210 }, detail: expect.stringContaining('观察到服务限流') }),
    ]))
  })

  it('emits stable reasons for off, login, connecting, and unreachable remote variants', async () => {
    const probe = { firewall: async () => ({ state: 'ready' as const }), remote: async () => ({ state: 'unreachable' as const }) }
    const off = await collectConnectionDiagnostics({ ...healthy, remote: { provider: 'cpolar', running: false, state: 'off' } }, probe)
    const login = await collectConnectionDiagnostics({ ...healthy, remote: { provider: 'tailscale', running: true, state: 'needs-login' } }, probe)
    const connecting = await collectConnectionDiagnostics({ ...healthy, remote: { provider: 'cpolar', running: true, state: 'connecting' } }, probe)
    const unreachable = await collectConnectionDiagnostics(healthy, probe)
    expect(off.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'remote', reason: 'remote-off', facts: { provider: 'cpolar' } })]))
    expect(login.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'remote', reason: 'remote-needs-login', facts: { provider: 'tailscale' } })]))
    expect(connecting.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'remote', reason: 'remote-connecting', facts: { provider: 'cpolar' } })]))
    expect(unreachable.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'remote', reason: 'remote-unreachable', facts: { provider: 'cpolar', endpointSuffix: '*.cpolar.cn' } })]))
  })

  it('explains a failed Tailscale Fake-IP path without blaming the computer certificate', async () => {
    const result = await collectConnectionDiagnostics({
      ...healthy,
      remote: { provider: 'tailscale', running: true, state: 'ready', origin: 'https://example.tail1234.ts.net' },
    }, {
      firewall: async () => ({ state: 'ready' }),
      remote: async () => ({ state: 'unreachable', fakeIp: true }),
    })

    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'remote',
        status: 'error',
        reason: 'remote-fake-ip',
        facts: { provider: 'tailscale', endpointSuffix: '*.ts.net' },
        detail: expect.stringContaining('VPN 或 DNS 代理'),
        action: expect.stringContaining('cpolar'),
      }),
    ]))
  })
})

describe('remote reachability relay fallback', () => {
  const funnelOrigin = 'https://example.tail1234.ts.net'
  /** The relay addresses this machine actually configures in the environment. */
  const relayEnv = { HTTP_PROXY: 'http://127.0.0.1:7897' } satisfies NodeJS.ProcessEnv
  const directGone = async (): Promise<{ state: 'unreachable' }> => ({ state: 'unreachable' })

  it('picks the configured relay unless NO_PROXY covers the target', () => {
    expect(configuredProxyFor(funnelOrigin, { HTTPS_PROXY: 'http://relay:7897', ALL_PROXY: 'http://all:1', HTTP_PROXY: 'http://generic:2' })?.host).toBe('relay:7897')
    expect(configuredProxyFor(funnelOrigin, { https_proxy: 'http://relay:7897' })?.host).toBe('relay:7897')
    expect(configuredProxyFor(funnelOrigin, { HTTP_PROXY: 'http://relay:7897' })?.host).toBe('relay:7897')
    expect(configuredProxyFor(funnelOrigin, {})).toBeUndefined()
    expect(configuredProxyFor(funnelOrigin, { HTTPS_PROXY: 'socks5://relay:1080' })).toBeUndefined()
  })

  it('honors NO_PROXY without losing the localhost exclusions this machine sets', () => {
    const env = { HTTP_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'localhost,127.0.0.1,::1' }
    expect(configuredProxyFor(funnelOrigin, env)?.host).toBe('127.0.0.1:7897')
    expect(configuredProxyFor(funnelOrigin, { ...env, NO_PROXY: 'ts.net' })).toBeUndefined()
    expect(configuredProxyFor(funnelOrigin, { ...env, NO_PROXY: '.tail1234.ts.net' })).toBeUndefined()
    expect(configuredProxyFor(funnelOrigin, { HTTP_PROXY: 'http://127.0.0.1:7897', NO_PROXY: '*' })).toBeUndefined()
    expect(configuredProxyFor('https://private-name.r8.cpolar.cn', { HTTP_PROXY: 'http://127.0.0.1:7897', NO_PROXY: 'ts.net' })?.host).toBe('127.0.0.1:7897')
    expect(configuredProxyFor(funnelOrigin, { ...env, NO_PROXY: 'ts.net:80' })?.host).toBe('127.0.0.1:7897')
    expect(configuredProxyFor(funnelOrigin, { ...env, NO_PROXY: 'ts.net:443' })).toBeUndefined()
    expect(configuredProxyFor('https://[::1]', { ...env, NO_PROXY: '[::1]:443' })).toBeUndefined()
  })

  it('answers ready through the relay when the direct hairpin cannot', async () => {
    const tunnel = vi.fn(async () => ({ status: 200, latencyMs: 96 }))
    const observation = await probeRemoteHealth(funnelOrigin, { env: relayEnv, direct: directGone, tunnel })
    expect(observation).toEqual({ state: 'ready', latencyMs: 96, viaProxy: true })
    expect(tunnel).toHaveBeenCalledOnce()
  })

  it('threads the relay egress into the localized remote-ready facts', async () => {
    const result = await collectConnectionDiagnostics(healthy, {
      firewall: async () => ({ state: 'ready' }),
      remote: async () => ({ state: 'ready', latencyMs: 8, viaProxy: true }),
    })
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'remote',
        status: 'warning',
        reason: 'remote-ready',
        facts: { provider: 'cpolar', endpointSuffix: '*.cpolar.cn', latencyMs: 8, viaProxy: true },
      }),
    ]))
    expect(result.checks.find(entry => entry.id === 'remote')?.detail).toContain('尚未验证手机能否连接')
    expect(result.overall).toBe('attention')
  })

  it('keeps the direct failure when the relay refuses, times out, or is not configured', async () => {
    const refused = vi.fn(async () => ({ status: 502, latencyMs: 4 }))
    expect(await probeRemoteHealth(funnelOrigin, { env: relayEnv, direct: directGone, tunnel: refused })).toEqual({ state: 'unreachable' })
    const threw = vi.fn(async () => { throw new Error('proxy_tunnel_closed') })
    expect(await probeRemoteHealth(funnelOrigin, { env: relayEnv, direct: directGone, tunnel: threw })).toEqual({ state: 'unreachable' })
    const unused = vi.fn(async () => ({ status: 200, latencyMs: 1 }))
    expect(await probeRemoteHealth(funnelOrigin, { env: { NO_PROXY: '*' }, direct: directGone, tunnel: unused })).toEqual({ state: 'unreachable' })
    expect(unused).not.toHaveBeenCalled()
  })

  it('maps a relay-side throttling answer without inventing a readiness claim', async () => {
    const observation = await probeRemoteHealth(funnelOrigin, {
      env: relayEnv,
      direct: directGone,
      tunnel: async () => ({ status: 429, latencyMs: 17 }),
    })
    expect(observation).toEqual({ state: 'rate-limited', latencyMs: 17, viaProxy: true })
  })

  it('preserves the Fake-IP verdict when both the direct and relay attempts fail', async () => {
    const observation = await probeRemoteHealth(funnelOrigin, {
      env: relayEnv,
      direct: async () => ({ state: 'unreachable' as const, fakeIp: true }),
      tunnel: async () => { throw new Error('proxy_tunnel_timeout') },
    })
    expect(observation).toEqual({ state: 'unreachable', fakeIp: true })
  })

  it('leaves absent origins and probe answers untouched', async () => {
    expect(await probeRemoteHealth(undefined)).toEqual({ state: 'not-applicable' })
    const direct = async (): Promise<{ state: 'ready'; latencyMs: number }> => ({ state: 'ready', latencyMs: 3 })
    expect(await probeRemoteHealth(funnelOrigin, { env: relayEnv, direct, tunnel: async () => ({ status: 200, latencyMs: 9 }) })).toEqual({ state: 'ready', latencyMs: 3 })
  })
})
