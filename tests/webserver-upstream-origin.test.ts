import { describe, expect, it, vi } from 'vitest'
import { resolveWebServerUpstreamOrigin } from '../src/plugin.js'

describe('active WebServer upstream origin', () => {
  it('retains the legacy port-only loopback contract when getOrigin is absent', () => {
    expect(resolveWebServerUpstreamOrigin({ port: 28000 })).toBe('http://127.0.0.1:28000')
  })

  it.each([
    ['http://192.168.50.23:28000', 'http://192.168.50.23:28000'],
    ['http://127.0.0.1:28000', 'http://127.0.0.1:28000'],
    ['http://[2001:db8::23]:28000', 'http://[2001:db8::23]:28000'],
    ['http://[::1]:28000', 'http://[::1]:28000'],
    ['http://0.0.0.0:28000', 'http://127.0.0.1:28000'],
    ['http://[::]:28000', 'http://[::1]:28000'],
  ])('resolves the published HTTP listener %s to %s', (origin, expected) => {
    const getOrigin = vi.fn(() => origin)
    expect(resolveWebServerUpstreamOrigin({ port: 3080, getOrigin })).toBe(expected)
    expect(getOrigin).toHaveBeenCalledTimes(1)
  })

  it('calls getOrigin with its WebServer receiver instead of an unbound function', () => {
    const webServer = {
      port: 28000,
      getOrigin(this: { readonly port: number }) { return `http://192.168.50.23:${String(this.port)}` },
    }
    expect(resolveWebServerUpstreamOrigin(webServer)).toBe('http://192.168.50.23:28000')
  })

  it.each([
    '',
    'not a url',
    'https://192.168.50.23:28000',
    'ws://192.168.50.23:28000',
    'http://localhost:28000',
    'http://gateway.example.com:28000',
    'http://192.168.50.23',
    'http://192.168.50.23:80',
    'http://192.168.50.23:65536',
    'http://user@192.168.50.23:28000',
    'http://user:password@192.168.50.23:28000',
    'http://192.168.50.23:28000/path',
    'http://192.168.50.23:28000/?query=value',
    'http://192.168.50.23:28000/#fragment',
    'http://[fe80::23%25eth0]:28000',
  ])('rejects an unsafe published origin %j without falling back to the port', origin => {
    expect(() => resolveWebServerUpstreamOrigin({ port: 3080, getOrigin: () => origin }))
      .toThrow(/HTTP WebServer origin/u)
  })

  it.each([
    { origin: undefined }, { origin: null }, { origin: 28000 }, { origin: {} }, { origin: [] },
  ])('rejects a non-string getOrigin result $origin without falling back', ({ origin }) => {
    const getOrigin = (() => origin) as () => string
    expect(() => resolveWebServerUpstreamOrigin({ port: 3080, getOrigin })).toThrow(/HTTP WebServer origin/u)
  })

  it.each([null, false, 28000, 'http://192.168.50.23:28000', {}])('rejects a malformed present getOrigin member %j instead of selecting the legacy listener', getOrigin => {
    const webServer = { port: 3080, getOrigin } as unknown as { readonly port: number; getOrigin?: () => string }
    expect(() => resolveWebServerUpstreamOrigin(webServer)).toThrow(/getOrigin must be a function/u)
  })

  it('propagates getOrigin failure rather than trying an unrelated loopback address', () => {
    const failure = new Error('listener origin unavailable')
    const webServer = {
      get port(): number { throw new Error('fallback must not read port') },
      getOrigin() { throw failure },
    }
    expect(() => resolveWebServerUpstreamOrigin(webServer)).toThrow(failure)
  })
})
