import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import { HttpError, assertExternalTrust, assertLocalAdminTrust, setSecurityHeaders } from '../src/http-security.js'
import { DESKTOP_ADMIN_HEADER, DESKTOP_ADMIN_MARKER, WEB_ADMIN_HEADER, WEB_ADMIN_MARKER } from '../src/local-admin-host.js'
import { RequestTrustPolicy, parseAuthority, parseCidr } from '../src/network.js'

const GATEWAY_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
const PROXIED_POLICY = 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()'

function fakeResponse(): { readonly headers: Record<string, string>; readonly response: ServerResponse } {
  const headers: Record<string, string> = {}
  const response = {
    setHeader: (name: string, value: string) => {
      headers[name] = value
    },
  } as unknown as ServerResponse
  return { headers, response }
}

describe('setSecurityHeaders', () => {
  it('admits same-origin and Blob media on the proxied GUI without widening other sources', () => {
    const gateway = fakeResponse()
    const proxied = fakeResponse()
    setSecurityHeaders(gateway.response, false)
    setSecurityHeaders(proxied.response, false, 'proxied')
    const directives = (headers: Record<string, string>) => new Map(
      headers['Content-Security-Policy']!.split('; ').map(value => {
        const [name, ...sources] = value.split(' ')
        return [name, sources.join(' ')]
      }),
    )
    const strict = directives(gateway.headers)
    const gui = directives(proxied.headers)
    expect(gui.get('media-src')).toBe("'self' blob:")
    expect(strict.has('media-src')).toBe(false)
    expect(strict.get('default-src')).toBe("'self'")
    expect(gui.get('default-src')).toBe(strict.get('default-src'))
    for (const name of ['script-src', 'connect-src', 'worker-src', 'img-src', 'font-src', 'object-src', 'base-uri', 'form-action']) {
      expect(gui.get(name), name).toBe(strict.get(name))
    }
    expect(gui.get('script-src')).toBe("'self' 'unsafe-inline' 'unsafe-eval'")
    expect(gui.get('connect-src')).toBe("'self'")
    expect(gui.get('media-src')).not.toMatch(/https?:|\*/u)
  })

  it('keeps the microphone on the proxied GUI document alone', () => {
    const gateway = fakeResponse()
    setSecurityHeaders(gateway.response, false)
    expect(gateway.headers['Permissions-Policy']).toBe(GATEWAY_POLICY)

    const proxied = fakeResponse()
    setSecurityHeaders(proxied.response, false, 'proxied')
    // Voice input records through getUserMedia; `microphone=()` refuses it before any prompt.
    expect(proxied.headers['Permissions-Policy']).toBe(PROXIED_POLICY)
    expect(proxied.headers['Permissions-Policy']).toContain('camera=()')
  })
})

function fakeRequest(init: {
  readonly remoteAddress?: string | undefined
  readonly host?: string
  readonly origin?: string | undefined
  readonly site?: string
  readonly desktopMarker?: string | readonly string[]
  readonly webMarker?: string | readonly string[]
  readonly method?: string
  readonly contentType?: string | readonly string[]
  readonly mode?: string
  readonly dest?: string
  readonly forwardedFor?: string
}): IncomingMessage {
  const headers: Record<string, string | readonly string[]> = {}
  if (init.host !== undefined) headers.host = init.host
  if (init.origin !== undefined) headers.origin = init.origin
  if (init.site !== undefined) headers['sec-fetch-site'] = init.site
  if (init.desktopMarker !== undefined) headers[DESKTOP_ADMIN_HEADER] = init.desktopMarker
  if (init.webMarker !== undefined) headers[WEB_ADMIN_HEADER] = init.webMarker
  if (init.contentType !== undefined) headers['content-type'] = init.contentType
  if (init.mode !== undefined) headers['sec-fetch-mode'] = init.mode
  if (init.dest !== undefined) headers['sec-fetch-dest'] = init.dest
  if (init.forwardedFor !== undefined) headers['x-forwarded-for'] = init.forwardedFor
  return {
    ...(init.method === undefined ? {} : { method: init.method }),
    socket: {
      remoteAddress: Object.hasOwn(init, 'remoteAddress') ? init.remoteAddress : '127.0.0.1',
    },
    headers,
  } as IncomingMessage
}

function reject(init: Parameters<typeof fakeRequest>[0], requireOrigin = false, authenticateDesktop = () => false): void {
  expect(() => assertLocalAdminTrust(fakeRequest(init), requireOrigin, authenticateDesktop)).toThrow(HttpError)
  try {
    assertLocalAdminTrust(fakeRequest(init), requireOrigin, authenticateDesktop)
  } catch (error) {
    expect(error).toMatchObject({ status: 403, code: 'forbidden' })
  }
}

describe('assertLocalAdminTrust', () => {
  it('admits only explicitly trusted direct peers with authenticated DSH requests', () => {
    const cidrs = [parseCidr('192.168.50.23/32')]
    const request = fakeRequest({ remoteAddress: '192.168.50.23', host: '192.168.50.8:3080',
      method: 'POST', origin: 'http://192.168.50.8:3080', site: 'same-origin' })
    expect(() => assertLocalAdminTrust(request, true, () => true)).toThrowError(expect.objectContaining({ status: 403 }))
    expect(() => assertLocalAdminTrust(request, true, () => false, cidrs)).toThrowError(expect.objectContaining({ status: 401, code: 'admin_authentication_required' }))
    expect(() => assertLocalAdminTrust(request, true, () => true, cidrs)).not.toThrow()
    expect(() => assertLocalAdminTrust(request, true, undefined, cidrs)).toThrowError(expect.objectContaining({ status: 401 }))
  })

  it('requires authenticated admission for remote management reads too', () => {
    const cidrs = [parseCidr('192.168.50.0/24')]
    const request = fakeRequest({ remoteAddress: '::ffff:192.168.50.23', host: '192.168.50.8:3080' })
    expect(() => assertLocalAdminTrust(request, false, () => false, cidrs)).toThrowError(expect.objectContaining({ status: 401 }))
    expect(() => assertLocalAdminTrust(request, false, () => true, cidrs)).not.toThrow()
  })

  it.each([
    { remoteAddress: '192.168.60.23', forwardedFor: '192.168.50.23' },
    { remoteAddress: undefined, forwardedFor: '192.168.50.23' },
    { host: 'evil.example' },
    { origin: 'http://evil.example' },
    { origin: 'http://192.168.50.8:9999' },
    { site: 'cross-site' },
    { site: 'same-site' },
    { method: 'OPTIONS' },
    { origin: undefined },
  ])('keeps remote management source restrictions with valid authentication: %j', override => {
    const request = fakeRequest({ remoteAddress: '192.168.50.23', host: '192.168.50.8:3080',
      method: 'POST', origin: 'http://192.168.50.8:3080', site: 'same-origin', ...override })
    expect(() => assertLocalAdminTrust(request, true, () => true, [parseCidr('192.168.50.23/32')]))
      .toThrowError(expect.objectContaining({ status: 403 }))
  })

  it('requires DSH authentication even for a correctly marked remote JSON request', () => {
    const request = fakeRequest({ remoteAddress: '192.168.50.23', host: '192.168.50.8:3080',
      method: 'POST', contentType: 'application/json', webMarker: WEB_ADMIN_MARKER })
    const cidrs = [parseCidr('192.168.50.23/32')]
    expect(() => assertLocalAdminTrust(request, true, () => false, cidrs)).toThrowError(expect.objectContaining({ status: 401 }))
    expect(() => assertLocalAdminTrust(request, true, () => true, cidrs)).not.toThrow()
  })

  it('keeps loopback Host and TCP peer working', () => {
    expect(() => assertLocalAdminTrust(fakeRequest({ host: '127.0.0.1:8787' }), false)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({ host: 'localhost:8787' }), false)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({ host: '[::1]:8787' }), false)).not.toThrow()
  })

  it('accepts RFC1918 and IPv4 link-local Host values when the TCP peer is loopback', () => {
    expect(() => assertLocalAdminTrust(fakeRequest({
      remoteAddress: '127.0.0.1',
      host: '192.168.50.23:8080',
    }), false)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({
      remoteAddress: '::1',
      host: '10.0.0.8:8080',
      origin: 'http://10.0.0.8:8080',
      site: 'same-origin',
    }), true)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({
      remoteAddress: '::ffff:127.0.0.1',
      host: '172.16.1.9:8080',
    }), false)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({
      remoteAddress: '127.0.0.1',
      host: '169.254.12.4:8080',
    }), false)).not.toThrow()
  })

  it('still rejects DNS rebinding, public, and CGNAT Host values', () => {
    reject({ host: 'evil.example' })
    reject({ host: 'dsh.example.com:8080' })
    reject({ host: '8.8.8.8:8080' })
    reject({ host: '100.64.1.8:8080' })
    reject({ host: '203.0.113.10:8080' })
  })

  it('still requires a loopback TCP peer', () => {
    reject({ remoteAddress: '192.168.50.23', host: '192.168.50.23:8080' })
    reject({ remoteAddress: '192.168.50.23', host: 'localhost:8080' })
    reject({ remoteAddress: '10.0.0.8', host: '127.0.0.1:8080' })
    reject({ remoteAddress: '::ffff:192.168.50.23', host: '192.168.50.23:8080' })
    reject({ remoteAddress: undefined, host: '127.0.0.1:8080' })
  })

  it('rejects a mismatched or non-http Origin even on a private Host', () => {
    reject({
      host: '192.168.50.23:8080',
      origin: 'http://127.0.0.1:8080',
    })
    reject({
      host: '192.168.50.23:8080',
      origin: 'ftp://192.168.50.23:8080',
    })
    reject({
      host: '192.168.50.23:8080',
      origin: 'http://evil.example',
    })
  })

  it('allows https Origin when the Host authority matches, for TLS-terminating reverse proxies', () => {
    expect(() => assertLocalAdminTrust(fakeRequest({
      host: '192.168.50.23:8080',
      origin: 'https://192.168.50.23:8080',
    }), false)).not.toThrow()
  })

  it('requires a same-origin browser Origin on mutating requests when Sec-Fetch-Site is present', () => {
    reject({
      host: '192.168.50.23:8080',
      site: 'same-origin',
    }, true)
    reject({
      host: '192.168.50.23:8080',
      origin: 'http://192.168.50.23:8080',
      site: 'cross-site',
    }, true)
    expect(() => assertLocalAdminTrust(fakeRequest({
      host: '192.168.50.23:8080',
      origin: 'http://192.168.50.23:8080',
      site: 'same-origin',
    }), true)).not.toThrow()
  })

  it('rejects a desktop-shell Origin without the forwarded request marker', () => {
    reject({ host: '127.0.0.1:8080', origin: 'dsh-app://app' }, true)
  })

  it('accepts only marked Origin-less Desktop forwards on mutating requests', () => {
    expect(() => assertLocalAdminTrust(fakeRequest({
      host: '127.0.0.1:8080',
      desktopMarker: DESKTOP_ADMIN_MARKER,
    }), true, () => true)).not.toThrow()
    reject({ host: '127.0.0.1:8080' }, true)
    reject({ host: '127.0.0.1:8080', desktopMarker: DESKTOP_ADMIN_MARKER }, true)
    reject({ host: '127.0.0.1:8080', desktopMarker: 'dsh-app://other' }, true)
    reject({ host: '127.0.0.1:8080', desktopMarker: [DESKTOP_ADMIN_MARKER, DESKTOP_ADMIN_MARKER] }, true)
  })

  it('keeps the marker from overriding browser Origin, Fetch Metadata, TCP peer, or Host', () => {
    reject({ host: '127.0.0.1:8080', desktopMarker: DESKTOP_ADMIN_MARKER, site: 'same-origin' }, true, () => true)
    reject({ host: '127.0.0.1:8080', desktopMarker: DESKTOP_ADMIN_MARKER, site: 'cross-site' }, true, () => true)
    reject({ host: '127.0.0.1:8080', desktopMarker: DESKTOP_ADMIN_MARKER, origin: 'http://evil.example' }, true, () => true)
    reject({ host: '127.0.0.1:8080', desktopMarker: DESKTOP_ADMIN_MARKER, origin: 'dsh-app://app' }, true, () => true)
    reject({ host: 'evil.example:8080', desktopMarker: DESKTOP_ADMIN_MARKER }, true, () => true)
    reject({ remoteAddress: '192.168.50.23', host: '127.0.0.1:8080', desktopMarker: DESKTOP_ADMIN_MARKER }, true, () => true)
  })

  it('keeps an unmarked Origin-less and Fetch-Metadata-less POST forbidden', () => {
    reject({ host: '192.168.50.23:8080' }, true)
  })

  it('still rejects Origin-less mutating requests that carry Fetch Metadata', () => {
    reject({
      host: '192.168.50.23:8080',
      site: 'same-origin',
    }, true)
  })

  it.each([undefined, 'same-origin'])('accepts only marked JSON Web POSTs without Origin and site %s', site => {
    expect(() => assertLocalAdminTrust(fakeRequest({ host: '192.168.50.23:3080', method: 'POST',
      ...(site === undefined ? {} : { site }), webMarker: WEB_ADMIN_MARKER, contentType: 'application/json; charset=utf-8' }), true)).not.toThrow()
  })

  it.each([
    { method: 'GET', contentType: 'application/json' },
    { method: 'POST' },
    { method: 'POST', contentType: 'text/plain' },
    { method: 'POST', contentType: 'application/x-www-form-urlencoded' },
    { method: 'POST', contentType: 'application/jsonx' },
    { method: 'POST', contentType: ['application/json', 'text/plain'] },
    { method: 'POST', contentType: 'application/json', site: 'cross-site' },
    { method: 'POST', contentType: 'application/json', site: 'same-site' },
    { method: 'POST', contentType: 'application/json', site: 'none' },
    { method: 'POST', contentType: 'application/json', origin: 'null' },
    { method: 'POST', contentType: 'application/json', origin: '' },
    { method: 'POST', contentType: 'application/json', origin: 'http://evil.example' },
    { method: 'POST', contentType: 'application/json', origin: 'http://192.168.50.23:9999' },
    { method: 'POST', contentType: 'application/json', desktopMarker: DESKTOP_ADMIN_MARKER },
  ])('rejects a Web marker outside its source/media/method scope: %j', init => {
    reject({ host: '192.168.50.23:3080', webMarker: WEB_ADMIN_MARKER, ...init }, true)
  })

  it.each(['wrong', `${WEB_ADMIN_MARKER}, ${WEB_ADMIN_MARKER}`, [WEB_ADMIN_MARKER, WEB_ADMIN_MARKER]])('rejects a malformed or repeated Web marker %j', webMarker => {
    reject({ host: '192.168.50.23:3080', method: 'POST', contentType: 'application/json', webMarker }, true)
  })

  it('does not accept Fetch mode/destination as an Origin substitute', () => {
    reject({ host: '192.168.50.23:3080', method: 'POST', contentType: 'application/json', mode: 'cors', dest: 'empty' }, true)
    reject({ host: '192.168.50.23:3080', method: 'POST', contentType: 'application/json', mode: 'cors', dest: 'empty', site: 'same-origin' }, true)
  })

  it('keeps the local peer and trusted Host checks ahead of the Web marker', () => {
    reject({ host: '192.168.50.23:3080', remoteAddress: '192.168.50.8', method: 'POST', contentType: 'application/json', webMarker: WEB_ADMIN_MARKER }, true)
    reject({ host: 'evil.example:3080', method: 'POST', contentType: 'application/json', webMarker: WEB_ADMIN_MARKER }, true)
  })

  it('refuses preflights even when source headers are absent or same-origin', () => {
    for (const source of [{}, { origin: 'http://192.168.50.23:3080', site: 'same-origin' }]) {
      reject({ host: '192.168.50.23:3080', method: 'OPTIONS', webMarker: WEB_ADMIN_MARKER, ...source })
    }
  })
})

describe('assertExternalTrust', () => {
  const policy = new RequestTrustPolicy([parseAuthority('10.0.0.5:3443')], 3443, [parseCidr('10.0.0.0/24')], true)

  it('names a peer outside the trusted networks instead of a bad credential', () => {
    // A phone on another subnet reaches the port, so the pairing client must say
    // which network to trust rather than report an expired one-time code.
    const request = fakeRequest({ remoteAddress: '10.9.8.7', host: '10.0.0.5:3443' })
    expect(() => assertExternalTrust(request, policy, false))
      .toThrowError(expect.objectContaining({ status: 403, code: 'source_network_untrusted' }))
  })

  it('keeps a foreign Host a plain forbidden rejection', () => {
    const request = fakeRequest({ remoteAddress: '10.0.0.7', host: 'evil.example:3443' })
    expect(() => assertExternalTrust(request, policy, false))
      .toThrowError(expect.objectContaining({ status: 403, code: 'forbidden' }))
  })

  it('admits the trusted peer with the exact Host and same-scheme Origin', () => {
    const request = fakeRequest({ remoteAddress: '10.0.0.7', host: '10.0.0.5:3443',
      origin: 'https://10.0.0.5:3443', site: 'same-origin', method: 'POST' })
    expect(() => assertExternalTrust(request, policy, true)).not.toThrow()
  })

  it('still requires the exact Origin on a mutation', () => {
    const request = fakeRequest({ remoteAddress: '10.0.0.7', host: '10.0.0.5:3443', method: 'POST' })
    expect(() => assertExternalTrust(request, policy, true))
      .toThrowError(expect.objectContaining({ status: 403, code: 'forbidden' }))
  })
})
