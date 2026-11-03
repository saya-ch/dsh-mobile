import { describe, expect, it, vi } from 'vitest'
import { collectConnectionDiagnostics, probeRemoteHealth, type DiagnosticSnapshot } from '../src/diagnostics.js'
import { DIAGNOSTIC_NETWORK_MESSAGES, DIAGNOSTIC_SCOPE_MESSAGES } from '../src/client-messages.js'
import { localizedDiagnosticEntryCopy } from '../src/client.js'

const snapshot: DiagnosticSnapshot = {
  dshVersion: '0.2.1-rc.5',
  lan: { configured: false, running: false },
  remote: { provider: 'tailscale', running: true, state: 'ready', origin: 'https://private-name.tail1234.ts.net' },
}
const firewall = async () => ({ state: 'not-applicable' as const })

describe('diagnostic path ownership and uncertainty', () => {
  it('separates a Funnel-only tailnet-path failure from public readiness without an external DNS query', async () => {
    const tunnel = vi.fn()
    const lookup = vi.fn(async () => [{ address: '100.100.1.9', family: 4 }])
    const remote = await probeRemoteHealth(snapshot.remote.origin, {
      env: {}, direct: async () => ({ state: 'unreachable', failureStage: 'connect' }), lookup, tunnel,
    })
    const result = await collectConnectionDiagnostics(snapshot, { firewall, remote: async () => remote })
    expect(lookup).toHaveBeenCalledExactlyOnceWith('private-name.tail1234.ts.net')
    expect(tunnel).not.toHaveBeenCalled()
    expect(result.overall).toBe('attention')
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'remote', status: 'warning', scope: 'computer', reason: 'remote-tailnet-shadowed' }))
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'remote-service', status: 'ok', reason: 'remote-service-ready' }))
    expect(result.checks).toContainEqual(expect.objectContaining({ id: 'remote-dns', reason: 'dns-tailnet', facts: { dnsKind: 'tailnet', dnsFamily: 'ipv4' } }))
    expect(result.checks.some(check => check.reason === 'remote-ready' || check.reason === 'remote-fake-ip')).toBe(false)
    expect(result.report).not.toMatch(/private-name|tail1234|100\.100\.1\.9/u)
    expect(result.coverage).toEqual({ measuredFrom: 'computer', unverified: ['phone', 'authenticated-page', 'resources', 'websocket'] })
  })

  it.each(['tls', 'http'] as const)('does not downgrade a real %s failure because DNS used a tailnet address', async failureStage => {
    for (const kind of ['tailnet', 'fake-ip'] as const) {
      const result = await collectConnectionDiagnostics(snapshot, { firewall, remote: async () => ({ state: 'unreachable', failureStage, dns: { kind, family: 'ipv4' } }) })
      expect(result.overall).toBe('error')
      expect(result.checks.find(check => check.id === 'remote')?.reason).toBe(failureStage === 'tls' ? 'remote-tls-failed' : 'remote-http-failed')
    }
  })

  it('does not infer tailnet shadowing from mixed DNS answers or an unrelated provider', async () => {
    for (const [provider, kind] of [['tailscale', 'mixed'], ['cpolar', 'tailnet']] as const) {
      const result = await collectConnectionDiagnostics({ ...snapshot, remote: { ...snapshot.remote, provider } }, { firewall, remote: async () => ({ state: 'unreachable', failureStage: 'connect', dns: { kind, family: 'dual' } }) })
      expect(result.checks.find(check => check.id === 'remote')?.reason).toBe('remote-connect-failed')
    }
  })

  it('keeps a successful proxy path distinct from private system DNS and phone acceptance', async () => {
    const remote = await probeRemoteHealth(snapshot.remote.origin, {
      env: { HTTPS_PROXY: 'http://127.0.0.1:7897' }, direct: async () => ({ state: 'unreachable', failureStage: 'connect' }),
      lookup: async () => [{ address: '100.64.1.1', family: 4 }], tunnel: async () => ({ status: 200, latencyMs: 7 }),
    })
    expect(remote).toMatchObject({ state: 'ready', viaProxy: true, dns: { kind: 'tailnet' } })
    const result = await collectConnectionDiagnostics(snapshot, { firewall, remote: async () => remote })
    expect(result.checks.find(check => check.id === 'remote')).toMatchObject({ reason: 'remote-ready', status: 'warning', facts: expect.objectContaining({ viaProxy: true }) })
    expect(result.checks.find(check => check.id === 'phone-network')?.scope).toBe('phone')
  })

  it('does not turn unused LAN/firewall configuration into a remote failure', async () => {
    const inactiveFirewall = vi.fn(async () => ({ state: 'missing' as const }))
    const result = await collectConnectionDiagnostics({ ...snapshot, lan: { running: false, networkError: 'network_interface_unavailable' } }, { firewall: inactiveFirewall, remote: async () => ({ state: 'ready' }) })
    expect(result.overall).toBe('ok')
    expect(inactiveFirewall).not.toHaveBeenCalled()
    expect(result.checks.filter(check => check.id === 'network' || check.id === 'firewall').every(check => check.status === 'info')).toBe(true)
  })

  it('retains an unclassified failure instead of attributing it to DNS alone', async () => {
    const result = await collectConnectionDiagnostics(snapshot, { firewall, remote: async () => ({ state: 'unreachable', failureStage: 'unknown', dns: { kind: 'tailnet', family: 'ipv4' } }) })
    expect(result.checks.find(check => check.id === 'remote')).toMatchObject({ reason: 'remote-unreachable', status: 'error' })
  })

  it('keeps DNS failure and HTTP failure stages explicit rather than guessing a VPN cause', async () => {
    for (const [failureStage, reason] of [['dns', 'remote-dns-failed'], ['connect', 'remote-connect-failed'], ['tls', 'remote-tls-failed'], ['timeout', 'remote-probe-timeout'], ['http', 'remote-http-failed']] as const) {
      const result = await collectConnectionDiagnostics(snapshot, { firewall, remote: async () => ({ state: 'unreachable', failureStage }) })
      expect(result.checks.find(check => check.id === 'remote')?.reason).toBe(reason)
    }
  })

  it('keeps all new reasons localized without exposing addresses or untranslated placeholders', () => {
    for (const locale of ['en', 'it', 'zh'] as const) {
      expect(Object.keys(DIAGNOSTIC_NETWORK_MESSAGES[locale])).toEqual(Object.keys(DIAGNOSTIC_NETWORK_MESSAGES.en))
      expect(DIAGNOSTIC_SCOPE_MESSAGES[locale].coverage).not.toBe('')
      for (const reason of Object.keys(DIAGNOSTIC_NETWORK_MESSAGES[locale])) {
        const copy = localizedDiagnosticEntryCopy({ reason, facts: { provider: 'tailscale' } }, locale)
        expect(copy.detail).not.toBe('')
        expect(copy.detail + copy.action).not.toMatch(/\{\w+\}/u)
      }
    }
  })
})
