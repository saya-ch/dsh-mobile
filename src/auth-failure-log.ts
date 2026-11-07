import type { IncomingMessage } from 'node:http'
import type { SessionAuthorization } from './access.js'
import { HOST_CSRF_COOKIE, HOST_SESSION_COOKIE } from './browser-auth-cookies.js'
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE } from './http-security.js'

/** One rejected HTTP request, with presence/count fields instead of credential values. */
export interface AuthFailureEntry {
  readonly kind: 'authorize' | 'csrf'
  readonly status: number
  readonly method: string
  /** A fixed public endpoint or route category; never an arbitrary request pathname. */
  readonly path: string
  readonly sessionCookie: boolean
  readonly csrfHeader: boolean
  /** Number of occurrences of the two actual CSRF cookie names, including empty values. */
  readonly csrfCookies: number
  readonly origin?: string
  readonly site?: 'same-origin' | 'same-site' | 'cross-site' | 'none'
  readonly device?: string
  /** Earlier failures of this kind suppressed since its preceding recorded request. */
  readonly suppressed?: number
}

// Fixed safety limits: request paths, identities and configuration cannot increase log throughput.
const LOG_INTERVAL_MS = 30_000
const MAX_LOGGED_ORIGIN_LENGTH = 512

function requestPathCategory(path: string): string {
  switch (path) {
    case '/':
    case '/index.html':
    case '/api/session/prompt':
    case '/api/events.mux':
    case '/api/events.host':
    case '/api/remote.mux':
    case '/mobile-access/compat.js':
    case '/mobile-access/mobile-layout.js':
    case '/mobile-access/custom.js':
    case '/mobile-access/custom.css':
    case '/mobile-access/client-modules':
    case '/mobile-access/events':
      return path
    default:
      if (path.startsWith('/api/')) return '/api/*'
      // Plugin bundles and owned assets are the two paths a mobile page re-requests constantly;
      // collapsing them into `/*` hid which half of the traffic was being rejected.
      if (path.startsWith('/plugins/')) return '/plugins/*'
      if (path.startsWith('/assets/')) return '/assets/*'
      if (path.startsWith('/mobile-access/extensions/')) return '/mobile-access/extensions/*'
      // The compatibility bundle is requested by content revision; the digest is not
      // a stable log category, so every revision collapses to the bundle's name.
      if (/^\/mobile-access\/compat-[a-f\d]{64}\.js$/u.test(path)) return '/mobile-access/compat.js'
      if (path.startsWith('/mobile-access/')) return '/mobile-access/*'
      return '/*'
  }
}

function requestMethod(method: string | undefined): string {
  switch (method) {
    case 'GET': case 'HEAD': case 'POST': case 'PUT': case 'PATCH': case 'DELETE': case 'OPTIONS':
      return method
    default:
      return 'OTHER'
  }
}

function requestEntry(
  kind: AuthFailureEntry['kind'],
  status: number,
  request: IncomingMessage,
  path: string,
  canonicalOrigin: string | undefined,
  authorization: SessionAuthorization | undefined,
): AuthFailureEntry {
  let sessionCookie = false
  let csrfCookies = 0
  for (const cookie of (request.headers.cookie ?? '').split(';')) {
    const equals = cookie.indexOf('=')
    if (equals < 0) continue
    const name = cookie.slice(0, equals).trim()
    if (name === SESSION_COOKIE || name === HOST_SESSION_COOKIE) sessionCookie = true
    if (name === CSRF_COOKIE || name === HOST_CSRF_COOKIE) csrfCookies += 1
  }
  const site = request.headers['sec-fetch-site']
  return {
    kind, status,
    method: requestMethod(request.method),
    path: requestPathCategory(path),
    sessionCookie,
    csrfHeader: request.headers[CSRF_HEADER] !== undefined,
    csrfCookies,
    ...(canonicalOrigin === undefined || canonicalOrigin.length > MAX_LOGGED_ORIGIN_LENGTH ? {} : { origin: canonicalOrigin }),
    ...(site === 'same-origin' || site === 'same-site' || site === 'cross-site' || site === 'none' ? { site } : {}),
    ...(authorization === undefined ? {} : { device: authorization.deviceId.slice(0, 8) }),
  }
}

interface FailureWindow { nextLogAt: number; suppressed: number }

/**
 * Gateway-owned diagnostic sampling with two fixed slots and no timer or attacker-selected key.
 * Each kind records immediately, then at most once per 30 seconds. Suppressed counts accompany
 * its next recorded request; no credential, request body, arbitrary path or query is retained.
 * The caller supplies the Origin already normalized by its successful request-trust check.
 */
export class AuthFailureRecorder {
  private readonly windows: Record<AuthFailureEntry['kind'], FailureWindow> = {
    authorize: { nextLogAt: 0, suppressed: 0 },
    csrf: { nextLogAt: 0, suppressed: 0 },
  }
  private observerFailureReported = false

  constructor(
    private readonly observe: ((entry: AuthFailureEntry) => void) | undefined,
    private readonly now: () => number = () => performance.now(),
    private readonly reportObserverFailure: () => void = () => {
      process.emitWarning('Mobile access authentication diagnostics could not be recorded', { code: 'DSH_MOBILE_AUTH_LOG_FAILED' })
    },
  ) {}

  /** Record a trusted-request rejection without changing its authentication result or retrying it. */
  record(
    kind: AuthFailureEntry['kind'],
    status: number,
    request: IncomingMessage,
    path: string,
    canonicalOrigin?: string,
    authorization?: SessionAuthorization,
  ): void {
    if (this.observe === undefined) return
    const now = this.now()
    const window = this.windows[kind]
    if (now < window.nextLogAt) {
      window.suppressed = Math.min(Number.MAX_SAFE_INTEGER, window.suppressed + 1)
      return
    }
    const suppressed = window.suppressed
    window.nextLogAt = now + LOG_INTERVAL_MS
    window.suppressed = 0
    try {
      this.observe({
        ...requestEntry(kind, status, request, path, canonicalOrigin, authorization),
        ...(suppressed === 0 ? {} : { suppressed }),
      })
    } catch (observerError) {
      void observerError // A diagnostic sink must not replace an authentication failure or redirect.
      if (this.observerFailureReported) return
      this.observerFailureReported = true
      try { this.reportObserverFailure() }
      catch (reporterError) { void reporterError /* The original HTTP failure still owns the response. */ }
    }
  }
}
