import { describe, expect, it } from 'vitest'
import { collectConnectionDiagnostics, remoteDiagnosticTimeoutMs, type DiagnosticSnapshot } from '../src/diagnostics.js'

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

  it('allows known remote relays longer than direct endpoints', () => {
    expect(remoteDiagnosticTimeoutMs('https://private-name.r8.cpolar.cn')).toBe(10_000)
    expect(remoteDiagnosticTimeoutMs('https://example.tail1234.ts.net')).toBe(10_000)
    expect(remoteDiagnosticTimeoutMs('https://example.com')).toBe(10_000)
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
