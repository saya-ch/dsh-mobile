import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Config, parseControlFile, parseGatewayConfig } from '../src/config.js'
import {
  addressAllowed,
  parseAuthority,
  parseCidr,
  RequestTrustPolicy,
  resolveAuthority,
} from '../src/network.js'

const stateFile = join(tmpdir(), 'dsh-mobile-access-config-test.json')
const controlFile = join(tmpdir(), 'dsh-mobile-access-control-test.json')

describe('gateway configuration', () => {
  it.each(['typo', 'http', '', null, 0, 1, true, false, [], {}])('rejects unknown TLS mode %j instead of selecting a plaintext public listener', mode => {
    expect(() => parseGatewayConfig({
      stateFile, listenHost: '0.0.0.0', publicAuthorities: ['gateway.example.com'], allowedCidrs: ['127.0.0.0/8'],
      tls: { mode, certFile: join(tmpdir(), 'cert.pem'), keyFile: join(tmpdir(), 'key.pem') },
    })).toThrow('tls.mode must be provided or disabled')
  })

  it.each([null, 'provided', false, []])('rejects a non-object TLS configuration %j', tls => {
    expect(() => parseGatewayConfig({ stateFile, tls })).toThrow('tls must be an object')
  })

  it('keeps provided TLS as the sole omitted-mode default and still requires its certificate files', () => {
    const files = { certFile: join(tmpdir(), 'cert.pem'), keyFile: join(tmpdir(), 'key.pem') }
    expect(parseGatewayConfig({ stateFile, tls: files }).tls).toMatchObject({ mode: 'provided', ...files })
    expect(() => parseGatewayConfig({ stateFile, tls: { mode: 'provided' } })).toThrow('tls.certFile must be an absolute file path')
    expect(() => parseGatewayConfig({ stateFile, listenHost: '0.0.0.0', tls: { mode: 'disabled' } })).toThrow('TLS may be disabled only on an IP loopback listener')
  })

  it('separates transport timeouts from optional authenticated API response timeouts', () => {
    const base = { stateFile, controlFile, initiallyEnabled: false, tls: { mode: 'disabled' as const } }
    expect(parseGatewayConfig(base)).toMatchObject({ upstreamTimeoutMs: 30_000, upstreamApiTimeoutMs: 0 })
    for (const upstreamApiTimeoutMs of [0, 1, 600_000, 2_147_483_647]) {
      expect(parseGatewayConfig(Config({ ...base, upstreamApiTimeoutMs })).upstreamApiTimeoutMs).toBe(upstreamApiTimeoutMs)
    }
    for (const upstreamApiTimeoutMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1000', 2_147_483_648]) {
      expect(() => parseGatewayConfig({ ...base, upstreamApiTimeoutMs })).toThrow(/upstreamApiTimeoutMs must be an integer/u)
    }
    expect(() => parseGatewayConfig({ ...base, upstreamTimeoutMs: 0 })).toThrow(/upstreamTimeoutMs/u)
  })

  it('keeps WebSocket compression opt-in and freezes validated paths and budgets', () => {
    const base = { stateFile, controlFile, initiallyEnabled: false, tls: { mode: 'disabled' as const } }
    expect(parseGatewayConfig(base).websocketCompression.paths).toEqual([])
    const paths = ['/api/remote.mux', '/api/remote.mux']
    const value = Config({ ...base, websocketCompression: { paths, maxMessageBytes: 2048, maxQueuedBytes: 4096 } })
    const resolved = parseGatewayConfig(value).websocketCompression
    paths.push('/another')
    expect(resolved.paths).toEqual(['/api/remote.mux'])
    expect(resolved.maxMessageBytes).toBe(2048)
    expect(resolved.maxQueuedBytes).toBe(4096)
    expect(Object.isFrozen(resolved)).toBe(true)
    expect(Object.isFrozen(resolved.paths)).toBe(true)
  })

  it('rejects malformed compression paths and unbounded compression resource settings', () => {
    const base = { stateFile, tls: { mode: 'disabled' } }
    for (const websocketCompression of [
      true, [], { paths: ['/api/remote.mux?token=secret'] }, { paths: ['/../other'] },
      { maxMessageBytes: 0 }, { maxMessageBytes: 4096, maxQueuedBytes: 2048 },
      { maxMessageBytes: 1024, maxQueuedBytes: 1024 },
      { maxMessageBytes: 1024, thresholdBytes: 2048 }, { concurrencyLimit: 0 }, { level: 10 },
    ]) {
      expect(() => parseGatewayConfig({ ...base, websocketCompression })).toThrow()
    }
  })

  it('keeps an additional TLS chain optional in the Loader schema', () => {
    const value = Config({
      stateFile,
      controlFile,
      initiallyEnabled: false,
      tls: {
        mode: 'provided',
        certFile: join(tmpdir(), 'server-cert.pem'),
        keyFile: join(tmpdir(), 'server-key.pem'),
      },
    })

    expect(value.tls?.caFile).toBeUndefined()
    const resolved = parseGatewayConfig(value)
    expect(resolved).toMatchObject({
      listenHost: '127.0.0.1',
      listenPort: 3443,
      tls: { mode: 'provided' },
    })
    expect(resolved.upstreamOrigin.origin).toBe('http://127.0.0.1:3080')
    expect(resolved.allowedCidrs).toHaveLength(2)
    expect(resolved.customCssFile).toBe(join(tmpdir(), 'mobile.css'))
    expect(resolved.customScriptFile).toBe(join(tmpdir(), 'mobile.js'))
    expect(resolved.mobileCompatibilityFile).toBe(fileURLToPath(new URL('../src/mobile-compat.js', import.meta.url)))
    expect(resolved.excludedClientModules).toEqual([])
  })

  it('accepts exact, unique optional client module ids and rejects malformed selections', () => {
    const selected = ['@example/optional-client']
    const loader = Config({ stateFile, controlFile, initiallyEnabled: false, tls: { mode: 'disabled' }, excludedClientModules: selected })
    const resolved = parseGatewayConfig(loader)
    selected.push('@example/another-client')
    expect(resolved.excludedClientModules).toEqual(['@example/optional-client'])
    expect(Object.isFrozen(resolved.excludedClientModules)).toBe(true)
    expect(() => parseGatewayConfig({ stateFile, tls: { mode: 'disabled' }, excludedClientModules: ['a', 'a'] }))
      .toThrow('excludedClientModules must not contain duplicate ids')
    for (const value of [[' a '], [''], ['a', 1], 'a']) {
      expect(() => parseGatewayConfig({ stateFile, tls: { mode: 'disabled' }, excludedClientModules: value }))
        .toThrow('excludedClientModules must be an array of exact, non-empty client module ids')
    }
  })

  it('requires an absolute path for a compatibility bundle override', () => {
    const mobileCompatibilityFile = join(tmpdir(), 'custom-compat.js')
    expect(parseGatewayConfig({ stateFile, tls: { mode: 'disabled' }, mobileCompatibilityFile }).mobileCompatibilityFile)
      .toBe(mobileCompatibilityFile)
    expect(() => parseGatewayConfig({ stateFile, tls: { mode: 'disabled' }, mobileCompatibilityFile: 'compat.js' }))
      .toThrow(/mobileCompatibilityFile must be an absolute file path/u)
  })

  it('keeps durable device state required at the Loader boundary', () => {
    expect(() => Config()).toThrow(/stateFile missing required value/)
  })

  it('requires an absolute hidden control-state file', () => {
    expect(parseControlFile(controlFile)).toBe(controlFile)
    expect(() => parseControlFile('control.json')).toThrow(/controlFile must be an absolute file path/)
    expect(() => Config({
      stateFile,
      controlFile: undefined as never,
      initiallyEnabled: false,
    })).toThrow(/controlFile missing required value/)
    expect(() => Config({
      stateFile,
      controlFile,
      initiallyEnabled: undefined as never,
    })).toThrow(/initiallyEnabled missing required value/)
  })

  it('derives the listener port and sole authority from a public HTTPS origin', () => {
    const quick = Config({
      publicOrigin: 'https://192.168.50.23:3443',
      allowedCidrs: ['192.168.50.0/24'],
      stateFile,
      controlFile,
      initiallyEnabled: true,
      tls: {
        mode: 'provided',
        certFile: join(tmpdir(), 'quick-cert.pem'),
        keyFile: join(tmpdir(), 'quick-key.pem'),
      },
    })
    expect(quick.publicAuthorities).toBeUndefined()
    const resolved = parseGatewayConfig(quick)

    expect(resolved.listenHost).toBe('0.0.0.0')
    expect(resolved.listenPort).toBe(3443)
    expect(resolved.authorities).toEqual([{ hostname: '192.168.50.23', port: 3443 }])

    const defaultPort = parseGatewayConfig({
      publicOrigin: 'https://dsh.home.arpa/',
      allowedCidrs: ['192.168.50.0/24'],
      stateFile,
      tls: {
        mode: 'provided',
        certFile: join(tmpdir(), 'default-port-cert.pem'),
        keyFile: join(tmpdir(), 'default-port-key.pem'),
      },
    })
    expect(defaultPort.listenPort).toBe(443)
    expect(defaultPort.authorities).toEqual([{ hostname: 'dsh.home.arpa' }])
  })

  it.each([
    'http://192.168.50.23:3443',
    'https://user:password@192.168.50.23:3443',
    'https://192.168.50.23:3443/path',
    'https://192.168.50.23:3443/?query=value',
    'https://192.168.50.23:3443/#fragment',
    'https://0.0.0.0:3443',
  ])('rejects unsafe public origin %s', (publicOrigin) => {
    expect(() => parseGatewayConfig({
      publicOrigin,
      allowedCidrs: ['192.168.50.0/24'],
      stateFile,
      tls: {
        mode: 'provided',
        certFile: join(tmpdir(), 'invalid-origin-cert.pem'),
        keyFile: join(tmpdir(), 'invalid-origin-key.pem'),
      },
    })).toThrow(/publicOrigin/)
  })

  it('rejects ambiguous quick and advanced public network configuration', () => {
    const tls = {
      mode: 'provided' as const,
      certFile: join(tmpdir(), 'conflict-cert.pem'),
      keyFile: join(tmpdir(), 'conflict-key.pem'),
    }
    expect(() => parseGatewayConfig({
      publicOrigin: 'https://192.168.50.23:3443',
      listenPort: 3443,
      allowedCidrs: ['192.168.50.0/24'],
      stateFile,
      tls,
    })).toThrow(/publicOrigin cannot be combined with listenPort/)
    expect(() => parseGatewayConfig({
      publicOrigin: 'https://192.168.50.23:3443',
      publicAuthorities: ['192.168.50.23:3443'],
      allowedCidrs: ['192.168.50.0/24'],
      stateFile,
      tls,
    })).toThrow(/publicOrigin cannot be combined with publicAuthorities/)
    expect(() => parseGatewayConfig({
      publicOrigin: 'https://127.0.0.1:3443',
      listenHost: '127.0.0.1',
      stateFile,
      tls: { mode: 'disabled' },
    })).toThrow(/publicOrigin requires TLS/)
  })

  it('rejects sessions that could outlive their device credential', () => {
    expect(() => parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      deviceTtlMs: 60_000,
      sessionTtlMs: 60_001,
    })).toThrow(/sessionTtlMs must not exceed deviceTtlMs/)
  })

  it('accepts a loopback-only HTTP development listener', () => {
    const config = parseGatewayConfig({
      listenHost: '127.0.0.1',
      listenPort: 3443,
      upstreamOrigin: 'http://127.0.0.1:3080',
      publicAuthorities: ['127.0.0.1:3443'],
      allowedCidrs: ['127.0.0.0/8'],
      stateFile,
      tls: { mode: 'disabled' },
    })
    expect(config.tls).toEqual({ mode: 'disabled' })
    expect(config.upstreamOrigin.origin).toBe('http://127.0.0.1:3080')
    expect(config.maxConnections).toBe(64)
    expect(config.sessionTtlMs).toBe(8 * 60 * 60_000)
  })

  it('requires TLS, authorities, CIDRs, and absolute state for network exposure', () => {
    expect(() => parseGatewayConfig({
      listenHost: '0.0.0.0',
      listenPort: 3443,
      upstreamOrigin: 'http://127.0.0.1:3080',
      publicAuthorities: ['192.168.1.2:3443'],
      allowedCidrs: ['192.168.0.0/16'],
      stateFile,
      tls: { mode: 'disabled' },
    })).toThrow(/TLS may be disabled only/)

    expect(() => parseGatewayConfig({
      listenHost: '0.0.0.0',
      listenPort: 3443,
      upstreamOrigin: 'http://127.0.0.1:3080',
      allowedCidrs: ['192.168.0.0/16'],
      stateFile,
      tls: { mode: 'provided', certFile: join(tmpdir(), 'cert.pem'), keyFile: join(tmpdir(), 'key.pem') },
    })).toThrow(/publicAuthorities/)

    expect(() => parseGatewayConfig({
      listenHost: '0.0.0.0',
      listenPort: 3443,
      upstreamOrigin: 'http://127.0.0.1:3080',
      publicAuthorities: ['192.168.1.2:3443'],
      stateFile,
      tls: { mode: 'provided', certFile: join(tmpdir(), 'cert.pem'), keyFile: join(tmpdir(), 'key.pem') },
    })).toThrow(/allowedCidrs/)

    expect(() => parseGatewayConfig({
      stateFile: 'devices.json',
      tls: { mode: 'disabled' },
    })).toThrow(/absolute file path/)
  })

  it.each([
    'https://127.0.0.1:3080',
    'http://192.168.1.5:3080',
    'http://user:pass@127.0.0.1:3080',
    'http://127.0.0.1:3080/path',
    'http://127.0.0.1',
  ])('rejects unsafe upstream %s', (upstreamOrigin) => {
    expect(() => parseGatewayConfig({ stateFile, upstreamOrigin, tls: { mode: 'disabled' } })).toThrow(/upstreamOrigin/)
  })

  it('rejects ambiguous authority and CIDR entries', () => {
    expect(() => parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      publicAuthorities: ['127.0.0.1:3555'],
      listenPort: 3443,
    })).toThrow(/authority port/)
    expect(() => parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      allowedCidrs: ['192.168.1.7/24'],
    })).toThrow(/host bits/)
    expect(() => parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      publicAuthorities: ['https://127.0.0.1:3443'],
    })).toThrow(/authority/)
    expect(() => parseGatewayConfig({
      stateFile,
      listenPort: 0,
      tls: { mode: 'disabled' },
      publicAuthorities: ['127.0.0.1:3443'],
    })).toThrow(/non-zero listenPort/)
    expect(() => parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      allowedCidrs: ['127.0.0.0/8', '127.0.0.0/008'],
    })).toThrow(/duplicates/)
    expect(() => parseGatewayConfig({
      stateFile,
      tls: { mode: 'disabled' },
      maxConnections: 0,
    })).toThrow(/maxConnections/)
  })
})

describe('network trust policy', () => {
  it('matches IPv4, mapped IPv4, and IPv6 without broadening prefixes', () => {
    const cidrs = [parseCidr('192.168.0.0/16'), parseCidr('::1/128')]
    expect(addressAllowed('192.168.4.7', cidrs)).toBe(true)
    expect(addressAllowed('::ffff:192.168.4.7', cidrs)).toBe(true)
    expect(addressAllowed('192.169.4.7', cidrs)).toBe(false)
    expect(addressAllowed('::1', cidrs)).toBe(true)
    expect(addressAllowed(undefined, cidrs)).toBe(false)
  })

  it('requires exact authority and origin including the listener port', () => {
    const spec = parseAuthority('Harness.Example')
    expect(resolveAuthority(spec, 3443)).toBe('harness.example:3443')
    const policy = new RequestTrustPolicy([spec], 3443, [parseCidr('10.0.0.0/8')], true)
    expect(policy.acceptsHost('harness.example:3443')).toBe(true)
    expect(policy.acceptsHost('harness.example')).toBe(false)
    expect(policy.acceptsHost('harness.example:3444')).toBe(false)
    expect(policy.acceptsOrigin('https://harness.example:3443')).toBe(true)
    expect(policy.acceptsOrigin('http://harness.example:3443')).toBe(false)
    expect(policy.acceptsOrigin('https://harness.example:3443/path')).toBe(false)
    expect(policy.acceptsOrigin('https://harness.example:3443,undefined')).toBe(true)
    expect(policy.acceptsOrigin('https://harness.example:3443,https://evil.example')).toBe(false)
    expect(policy.acceptsOrigin('https://evil.example,https://harness.example:3443')).toBe(false)
  })

  it.each([
    { port: 443, tls: true, origin: 'https://harness.example' },
    { port: 80, tls: false, origin: 'http://harness.example' },
  ])('canonicalizes the default port for $origin', ({ port, tls, origin }) => {
    const policy = new RequestTrustPolicy(
      [parseAuthority('harness.example')],
      port,
      [parseCidr('10.0.0.0/8')],
      tls,
    )
    expect(policy.acceptsHost('harness.example')).toBe(true)
    expect(policy.acceptsOrigin(origin)).toBe(true)
    expect(policy.acceptsOrigin(`${origin}:${String(port)}`)).toBe(true)
  })
})
