import type { IncomingMessage, ServerResponse } from 'node:http'
import { addressAllowed, isLoopbackAddress, RequestTrustPolicy, type ParsedCidr } from './network.js'
import { DESKTOP_ADMIN_HEADER, DESKTOP_ADMIN_MARKER, WEB_ADMIN_HEADER, WEB_ADMIN_MARKER, isLocalAdminHostname } from './local-admin-host.js'

export const DEVICE_COOKIE = 'dsh_ma_device'
export const SESSION_COOKIE = 'dsh_ma_session'
export const CSRF_COOKIE = 'dsh_ma_csrf'
export const CSRF_HEADER = 'x-dsh-mobile-csrf'
export const LOCAL_ADMIN_PREFIX = '/api/mobile-access'
export const AUTH_PREFIX = '/mobile-access'
export const WS_PATHS = new Set([
  '/api/events.mux',
  '/api/events.host',
  '/api/remote.mux',
  // DSH desktop UI's sidebar terminal (renderer-v2) upgrades through this
  // exact path with a session query string; it is a first-party DSH surface.
  '/sidebar/ws/terminal',
])

/** Terse request failure safe to expose without internal diagnostics. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code)
    this.name = 'HttpError'
  }
}

/** Parsed origin-form request target with a decoded path for protected-prefix checks. */
export interface RequestTarget {
  readonly raw: string
  readonly pathname: string
  readonly decodedPathname: string
  readonly search: string
}

/** Parse only origin-form request targets and reject ambiguous slash encodings. */
export function parseRequestTarget(raw: string | undefined): RequestTarget {
  if (raw === undefined || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f\u007f]/u.test(raw)) {
    throw new HttpError(400, 'bad_request')
  }
  let parsed: URL
  let decodedPathname: string
  try {
    parsed = new URL(raw, 'http://gateway.invalid')
    decodedPathname = decodeURIComponent(parsed.pathname)
  } catch {
    throw new HttpError(400, 'bad_request')
  }
  if (decodedPathname.includes('\\') || decodedPathname.startsWith('//') || /[\u0000-\u001f\u007f]/u.test(decodedPathname)) {
    throw new HttpError(400, 'bad_request')
  }
  return Object.freeze({ raw, pathname: parsed.pathname, decodedPathname, search: parsed.search })
}

/**
 * Which framing policy a response carries.
 *
 * - `gateway`: the gateway's OWN documents (login, pairing, the CA helper) and
 *   its JSON/SSE responses. Nothing may frame them at all.
 * - `proxied`: the upstream DSH GUI and its routes, forwarded through the
 *   gateway. The GUI must be able to frame its OWN same-origin surfaces (the
 *   sidebar's HTML/diff preview routes, the browser tab pointed at the GUI
 *   itself) and the sidebar browser tab must be able to frame external http(s)
 *   sites plus `blob:` PDF previews — a plain `default-src 'self'` with no
 *   `frame-src` refuses all of them, which is what broke the sidebar browser
 *   over remote access.
 */
export type FramingPolicy = 'gateway' | 'proxied'

/**
 * The frame sources a proxied GUI document may embed: its own routes, blob:
 * (the PDF viewer's object URL) and external http(s) pages (the sidebar
 * browser tab). The framed document runs in the tab's existing sandbox
 * (opaque origin, no same-origin privileges), so this does not hand the
 * embedded page anything it did not already have.
 */
const PROXIED_FRAME_SRC = "frame-src 'self' blob: https: http:"

/**
 * Set the gateway browser protections and non-cacheability.
 * @param response - the response to decorate.
 * @param tls - whether the connection is TLS (adds HSTS).
 * @param framing - the framing policy; defaults to the strict gateway one, so
 *   every existing call site keeps refusing to be framed. Only the two PROXIED
 *   forwarders pass `'proxied'`.
 */
export function setSecurityHeaders(response: ServerResponse, tls: boolean, framing: FramingPolicy = 'gateway'): void {
  const proxied = framing === 'proxied'
  response.setHeader('Cache-Control', 'no-store')
  // DSH emits inline boot code, revives Schemastery callbacks, and applies dynamic styles.
  // These allowances provide compatibility, not XSS isolation.
  response.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    // A proxied GUI is frameable by ITS OWN origin only (its preview routes and
    // the sidebar's page routes); every third-party origin stays refused, so
    // clickjacking protection is unchanged for the gateway's own documents.
    proxied ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    // GUI plugins may fetch same-origin media into object URLs before playback.
    ...(proxied ? ["media-src 'self' blob:"] : []),
    // `frame-src` has no allow-by-default: the sidebar browser tab embeds
    // cross-origin pages, which only an explicit frame-src admits.
    ...(proxied ? [PROXIED_FRAME_SRC] : []),
  ].join('; '))
  // The proxied GUI document owns local voice input: DSH's voice-input plugin
  // records through `getUserMedia`, which a bare `microphone=()` refuses before
  // any prompt. Only that document widens the microphone to itself; the
  // gateway's own pages and every other feature stay refused.
  const microphone = proxied ? 'microphone=(self)' : 'microphone=()'
  response.setHeader('Permissions-Policy', `camera=(), ${microphone}, geolocation=(), payment=(), usb=()`)
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  // The legacy twin of frame-ancestors: SAMEORIGIN keeps older engines aligned
  // with the proxied policy instead of refusing the GUI's own frames.
  response.setHeader('X-Frame-Options', proxied ? 'SAMEORIGIN' : 'DENY')
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  if (tls) response.setHeader('Strict-Transport-Security', 'max-age=31536000')
}

/** Send a bounded JSON response without reflecting request or upstream data. */
export function sendJson(response: ServerResponse, status: number, value: unknown, tls: boolean): void {
  if (response.headersSent || response.destroyed) return
  setSecurityHeaders(response, tls)
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Send a generic failure containing only a stable category. */
export function sendFailure(response: ServerResponse, status: number, code: string, tls: boolean): void {
  sendJson(response, status, { error: code }, tls)
}

/** Read and parse one bounded JSON object. */
export async function readJsonObject(request: IncomingMessage, maximumBytes: number): Promise<Record<string, unknown>> {
  const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new HttpError(415, 'unsupported_media_type')
  const declared = request.headers['content-length']
  if (declared !== undefined) {
    if (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes) throw new HttpError(413, 'payload_too_large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maximumBytes) throw new HttpError(413, 'payload_too_large')
    chunks.push(buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new HttpError(400, 'bad_request')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new HttpError(400, 'bad_request')
  return parsed as Record<string, unknown>
}

/** Strict cookie parser: malformed or duplicate names invalidate the whole header. */
export function parseCookies(header: string | undefined): ReadonlyMap<string, string> | undefined {
  if (header === undefined) return new Map()
  if (header.length > 8192) return undefined
  const cookies = new Map<string, string>()
  for (const part of header.split(';')) {
    const equals = part.indexOf('=')
    if (equals <= 0) return undefined
    const name = part.slice(0, equals).trim()
    const value = part.slice(equals + 1).trim()
    if (!/^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/u.test(name) || !/^[\w\-.~+/=]*$/u.test(value) || cookies.has(name)) {
      return undefined
    }
    cookies.set(name, value)
  }
  return cookies
}

/** Serialize a host-only Cookie with no Domain attribute. */
export function cookie(
  name: string,
  value: string,
  options: { tls: boolean; httpOnly: boolean; path: string; maxAgeSeconds: number },
): string {
  const parts = [
    `${name}=${value}`,
    `Path=${options.path}`,
    `Max-Age=${String(Math.max(0, Math.floor(options.maxAgeSeconds)))}`,
    'SameSite=Strict',
    'Priority=High',
  ]
  if (options.tls) parts.push('Secure')
  if (options.httpOnly) parts.push('HttpOnly')
  return parts.join('; ')
}

/** Enforce direct CIDR, exact Host, and browser same-origin facts. */
export function assertExternalTrust(request: IncomingMessage, policy: RequestTrustPolicy, requireOrigin: boolean): void {
  // A peer outside the trusted CIDRs is a network mismatch, not a bad credential.
  // Naming it separately lets a pairing client say which network to trust instead
  // of reporting that a one-time pairing code expired.
  if (!addressAllowed(request.socket.remoteAddress, policy.cidrs)) throw new HttpError(403, 'source_network_untrusted')
  if (!policy.acceptsHost(request.headers.host)) throw new HttpError(403, 'forbidden')
  const origin = request.headers.origin
  if (origin !== undefined && !policy.acceptsOrigin(origin)) throw new HttpError(403, 'forbidden')
  const site = request.headers['sec-fetch-site']
  // 微信小程序（wx.request / wx.connectSocket）的 Sec-Fetch-Site 由微信自动附加
  // （same-origin / same-site / cross-site），客户端无法控制，也不代表真实跨站攻击；
  // CSRF 防护的核心是下方对 Origin 的强制校验，因此这里接受全部合法取值。
  if (site !== undefined && site !== 'same-origin' && site !== 'same-site' && site !== 'cross-site' && site !== 'none') throw new HttpError(403, 'forbidden')
  // POST 只强制 Origin 正确。
  if (requireOrigin && !policy.acceptsOrigin(origin)) throw new HttpError(403, 'forbidden')
}

function localAuthority(header: string | undefined): { hostname: string; authority: string } | undefined {
  if (header === undefined || /[/?#@\\]/u.test(header)) return undefined
  try {
    const url = new URL(`http://${header}`)
    if (url.pathname !== '/' || url.username !== '' || url.password !== '') return undefined
    return { hostname: url.hostname, authority: url.host.toLowerCase() }
  } catch {
    return undefined
  }
}

/** Protect management with direct-peer, Host, browser-source and optional authenticated-network admission. */
export function assertLocalAdminTrust(
  request: IncomingMessage,
  requireBrowserOrigin: boolean,
  authenticateDesktop: () => boolean = () => false,
  adminAllowedCidrs: readonly ParsedCidr[] = [],
): void {
  const peer = request.socket.remoteAddress
  const loopback = peer !== undefined && isLoopbackAddress(peer)
  if (!loopback && !addressAllowed(peer, adminAllowedCidrs)) {
    throw new HttpError(403, 'forbidden')
  }
  const host = localAuthority(request.headers.host)
  if (host === undefined || !isLocalAdminHostname(host.hostname)) {
    throw new HttpError(403, 'forbidden')
  }
  // This prefix never grants a cross-origin preflight permission for management actions.
  if (request.method === 'OPTIONS') throw new HttpError(403, 'forbidden')
  const site = request.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'forbidden')
  const origin = request.headers.origin
  if (origin !== undefined) {
    try {
      const parsed = new URL(origin)
      if (parsed.host.toLowerCase() !== host.authority || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
        throw new HttpError(403, 'forbidden')
      }
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(403, 'forbidden')
    }
  }
  // Desktop strips Origin and Sec-Fetch-Site before forwarding, but preserves
  // this plugin's non-simple request header. An unrelated browser origin cannot
  // send that header through CORS; a local process could already forge Origin.
  const desktopForward = site === undefined && request.headers[DESKTOP_ADMIN_HEADER] === DESKTOP_ADMIN_MARKER
  const contentType = request.headers['content-type']
  // A browser cannot attach this non-simple JSON marker across origins without
  // a successful preflight. This management prefix must remain CORS-disabled.
  const webRequest = request.method === 'POST'
    && (site === undefined || site === 'same-origin')
    && request.headers[WEB_ADMIN_HEADER] === WEB_ADMIN_MARKER
    && request.headers[DESKTOP_ADMIN_HEADER] === undefined
    && typeof contentType === 'string' && contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
  if (requireBrowserOrigin && origin === undefined && !webRequest && !(desktopForward && authenticateDesktop())) {
    throw new HttpError(403, 'forbidden')
  }
  if (requireBrowserOrigin && site !== undefined && site !== 'same-origin') {
    throw new HttpError(403, 'forbidden')
  }
  // An explicit network is an additional source restriction, not an identity.
  // The caller must validate the current request through DSH's authentication.
  if (!loopback && !authenticateDesktop()) throw new HttpError(401, 'admin_authentication_required')
}
