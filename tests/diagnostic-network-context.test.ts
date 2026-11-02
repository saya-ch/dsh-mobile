import { describe, expect, it, vi } from 'vitest'
import { classifyDiagnosticDns, diagnosticFailureStage, probeDiagnosticDns } from '../src/diagnostic-network-context.js'

describe('non-identifying diagnostic network context', () => {
  it.each(['100.64.0.1', '100.127.255.254', 'fd7a:115c:a1e0::1'])('recognizes tailnet address %s without calling it Fake-IP', address => {
    expect(classifyDiagnosticDns([{ address, family: address.includes(':') ? 6 : 4 }]).kind).toBe('tailnet')
  })
  it.each(['100.63.255.254', '100.128.0.1'])('does not extend the shared-address range to %s', address => {
    expect(classifyDiagnosticDns([{ address, family: 4 }]).kind).toBe('public')
  })
  it('distinguishes fake-IP, private, mixed and dual-family observations', () => {
    expect(classifyDiagnosticDns([{ address: '198.19.0.1', family: 4 }]).kind).toBe('fake-ip')
    expect(classifyDiagnosticDns([{ address: '127.0.0.1', family: 4 }]).kind).toBe('private')
    expect(classifyDiagnosticDns([{ address: '100.64.0.1', family: 4 }, { address: '1.1.1.1', family: 4 }]).kind).toBe('mixed')
    expect(classifyDiagnosticDns([{ address: '100.64.0.1', family: 4 }, { address: 'fd7a:115c:a1e0::2', family: 6 }])).toEqual({ kind: 'tailnet', family: 'dual' })
    expect(classifyDiagnosticDns([])).toEqual({ kind: 'unknown', family: 'unknown' })
  })
  it('returns unknown for failure or deadline and ignores a late result', async () => {
    vi.useFakeTimers()
    try {
      let release: (value: { address: string; family: number }[]) => void = () => {}
      const pending = probeDiagnosticDns('private-name.ts.net', 20, () => new Promise(resolve => { release = resolve }))
      await vi.advanceTimersByTimeAsync(20)
      expect(await pending).toEqual({ kind: 'unknown', family: 'unknown' })
      release([{ address: '100.64.0.1', family: 4 }])
      expect(vi.getTimerCount()).toBe(0)
      expect(await probeDiagnosticDns('private-name.ts.net', 20, async () => { throw new Error('private hostname') })).toEqual({ kind: 'unknown', family: 'unknown' })
    } finally { vi.useRealTimers() }
  })
  it.each([
    ['ENOTFOUND', 'dns'], ['ECONNREFUSED', 'connect'], ['CERT_HAS_EXPIRED', 'tls'], ['ETIMEDOUT', 'timeout'], ['private-string', 'unknown'],
  ])('classifies %s through a Fetch cause without returning private details', (code, stage) => {
    expect(diagnosticFailureStage(new Error('private URL and credentials', { cause: { code } }))).toBe(stage)
  })
  it('bounds cyclic causes and distinguishes a request deadline', () => {
    const cyclic = { cause: {} }; cyclic.cause = cyclic
    expect(diagnosticFailureStage(cyclic)).toBe('unknown')
    expect(diagnosticFailureStage(new DOMException('private URL', 'TimeoutError'))).toBe('timeout')
  })
})
