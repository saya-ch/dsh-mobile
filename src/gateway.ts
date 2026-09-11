import { createHash, X509Certificate } from 'node:crypto'
import { createSocket, type Socket as DatagramSocket } from 'node:dgram'
import { readFile, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { extname } from 'node:path'
import {
  createServer as createHttpServer,
  request as requestHttp,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer, type ServerOptions } from 'node:https'
import { connect, isIP, type AddressInfo, type Socket } from 'node:net'
import { Transform, type TransformCallback } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGzip, gzip } from 'node:zlib'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import Bonjour from 'bonjour-service'
import * as QRCode from 'qrcode'
import {
  AccessController,
  AccessError,
  BoundedRateLimiter,
  type DeviceSummary,
  type SessionAuthorization,
} from './access.js'
import type { ResolvedGatewayConfig } from './config.js'
import {
  AUTH_PREFIX,
  assertExternalTrust,
  assertLocalAdminTrust,
  cookie,
  CSRF_COOKIE,
  CSRF_HEADER,
  DEVICE_COOKIE,
  HttpError,
  LOCAL_ADMIN_PREFIX,
  parseCookies,
  parseRequestTarget,
  readJsonObject,
  sendFailure,
  sendJson,
  SESSION_COOKIE,
  setSecurityHeaders,
  WS_PATHS,
} from './http-security.js'
import type { BlockedUpgradePathEntry, BlockedUpgradePathLog } from './websocket-paths.js'
import {
  DSH_MOBILE_VERSION,
  MINIMUM_ANDROID_APP_VERSION,
  MOBILE_METADATA_VERSION,
} from './version.js'
import { addressAllowed, isLoopbackAddress, type ParsedCidr, RequestTrustPolicy } from './network.js'
import type { DeviceStore } from './storage.js'
import { listComputerImages, readComputerImage } from './computer-images.js'
import {
  EXTENSION_LIMITS,
  MobileExtensionError,
  type MobileAccessService,
  type MobileRouteRequest,
  type MobileRouteResponse,
} from './extensions.js'

type GatewayServer = HttpServer | HttpsServer

interface ActiveRequest {
  readonly sessionKey: string
  readonly deviceId: string
  readonly expiresAt: number
  readonly abort: () => void
  readonly timer: NodeJS.Timeout
}

interface ActiveWebSocket {
  readonly sessionKey: string
  readonly deviceId: string
  readonly client: Socket
  readonly upstream: Socket
  readonly timer: NodeJS.Timeout
}

const MAX_CONTROL_BODY_BYTES = 16 * 1024
const MAX_HEADER_BYTES = 16 * 1024
const MOBILE_HISTORY_PAGE_MESSAGES = 10
const SESSION_HISTORY_PATH = '/api/session.history'
const DISCOVERY_QUERY = Buffer.from('DSH_MOBILE_DISCOVER_V1', 'ascii')
const DISCOVERY_PROTOCOL = 1
const DISCOVERY_INTERVAL_MS = 3_000
const MDNS_SERVICE_TYPE = 'dsh-mobile'
const MOBILE_LAYOUT_MODULE = '@deepseek-ai/dsh-client-ui-layout'
const MOBILE_LAYOUT_PATH = `${AUTH_PREFIX}/mobile-layout.js`
const MOBILE_BOOT_BATCH_PREFIX = `${AUTH_PREFIX}/mobile-boot/`
const MAX_MOBILE_BOOT_BATCH_BYTES = 32 * 1024 * 1024
const MAX_MOBILE_BOOT_ENTRY_BYTES = 8 * 1024 * 1024
const MAX_MOBILE_BOOT_BATCHES = 8
const MOBILE_BOOT_UPSTREAM_ATTEMPTS = 4
const MOBILE_BOOT_RETRY_DELAY_MS = 150
const TRANSIENT_UPSTREAM_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ETIMEDOUT',
  'ERR_STREAM_PREMATURE_CLOSE',
])
const UPSTREAM_AUTH_REFRESH_MARGIN_MS = 60_000
const UPSTREAM_COOKIE_PAIR = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21-\x3A\x3C-\x7E]*$/u
const CUSTOM_STYLE_FALLBACK = '/* Add mobile overrides in the DSH home mobile-access/mobile.css file. */\n'
const CUSTOM_SCRIPT_FALLBACK = 'window.dshMobile?.register(() => undefined)\n'
const EXTENSION_CHANGE_POLL_MS = 2_000
const EXTENSION_EVENT_HEARTBEAT_MS = 15_000
const MOBILE_CLIENT_MODULE = 'dsh-mobile'
const CONNECTION_MODULE = '@deepseek-ai/dsh-client-connection'
const RUNTIME_MODULE = '@deepseek-ai/dsh-client-runtime'
const RENDERER_MODULE = '@deepseek-ai/dsh-client-ui-renderer'
const SIDEBAR_MODULE = '@deepseek-ai/dsh-client-ui-sidebar'
const SETTINGS_MODULE = '@deepseek-ai/dsh-client-ui-settings'
const API_GATEWAY_MODULE = '@deepseek-ai/dsh-api-gateway'
const API_REMOTES_MODULE = '@deepseek-ai/dsh-api-remotes'
const MOBILE_LAYOUT_DEPENDENCY_PROFILES = Object.freeze([
  Object.freeze({
    slots: RUNTIME_MODULE,
    dependencies: Object.freeze([RUNTIME_MODULE, '@deepseek-ai/dsh-client-ui-theme']),
  }),
  Object.freeze({
    slots: RENDERER_MODULE,
    dependencies: Object.freeze([
      '@deepseek-ai/dsh-client-locale',
      RENDERER_MODULE,
      '@deepseek-ai/dsh-client-ui-session',
      '@deepseek-ai/dsh-client-ui-theme',
    ]),
  }),
])
const MOBILE_CSRF_FETCH_BOOTSTRAP = `(()=>{const nativeFetch=window.fetch.bind(window);window.fetch=(input,init)=>{const source=input instanceof Request?input:undefined;const method=String(init?.method??source?.method??'GET').toUpperCase();if(method==='GET'||method==='HEAD')return nativeFetch(input,init);const raw=typeof input==='string'?input:input instanceof URL?input.href:source?.url;if(raw===undefined||new URL(raw,location.href).origin!==location.origin)return nativeFetch(input,init);const headers=new Headers(init?.headers??source?.headers);if(!headers.has(${JSON.stringify(CSRF_HEADER)})){const prefix=${JSON.stringify(`${CSRF_COOKIE}=`)};const token=document.cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith(prefix))?.slice(prefix.length);if(token!==undefined)headers.set(${JSON.stringify(CSRF_HEADER)},token)}return nativeFetch(input,{...init,headers})};})();`
// Paired pages use the gateway's authenticated HTTP carrier; streams retain DSH's WebSocket transport.
const MOBILE_AUTHENTICATED_TRANSPORT_BOOTSTRAP = `(()=>{if(window.__DSH_TRANSPORT__!==undefined)throw new Error('DSH Mobile cannot replace an existing transport override');window.__DSH_TRANSPORT__={fetch:(input,init)=>window.fetch(input,init),ownsHost:true}})();`
const PAIR_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Pair DSH mobile access</title>
<main>
  <h1>Pair this device</h1>
  <form id="pair-form">
    <label>Pairing code <input id="pair-token" autocomplete="one-time-code" required></label>
    <label>Device name <input id="device-label" maxlength="64" autocomplete="off"></label>
    <button type="submit">Pair</button>
    <output id="pair-status"></output>
  </form>
</main>
<script src="/mobile-access/pair.js" defer></script>
</html>
`

interface BootGraphEntry {
  id: string
  url: string
  rev: string
  inject?: string[]
  immediately?: boolean
}

interface BootGraphBatch {
  phase: 'bootstrap' | 'application'
  url: string
  rev: string
  entries: string[]
}

interface MobileBootBatchEntry {
  readonly id: string
  readonly url: string
  readonly rev: string
}

interface MobileBootBatchPlan {
  readonly key: string
  readonly path: string
  readonly entries: readonly MobileBootBatchEntry[]
}

interface RewrittenMobileIndex {
  readonly html: string
  readonly batch?: MobileBootBatchPlan
}

interface StoredMobileBootBatch {
  readonly plan: MobileBootBatchPlan
  body?: Buffer
  gzipBody?: Buffer
  etag?: string
  layoutMtimeMs?: number
  /** In-flight assembly shared by every concurrent requester of this batch. */
  assembly?: MobileBootBatchAssembly
}

interface MobileBootBatchAssembly {
  readonly controller: AbortController
  readonly task: Promise<Buffer>
}

const gzipBuffer = promisify(gzip)

function ensureMobileViewport(html: string): string {
  const viewport = /<meta\b(?=[^>]*\bname\s*=\s*["']viewport["'])[^>]*>/iu
  const match = viewport.exec(html)
  if (match === null) {
    const head = /<head\b[^>]*>/iu.exec(html)
    if (head?.index === undefined) return html
    const position = head.index + head[0].length
    return `${html.slice(0, position)}<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">${html.slice(position)}`
  }
  if (/\bviewport-fit\s*=\s*cover\b/iu.test(match[0])) return html
  const content = /\bcontent\s*=\s*(["'])(.*?)\1/iu
  const next = content.test(match[0])
    ? match[0].replace(content, (_whole, quote: string, value: string) => `content=${quote}${value},viewport-fit=cover${quote}`)
    : match[0].replace(/\s*\/?>$/u, ' content="width=device-width,initial-scale=1,viewport-fit=cover">')
  return `${html.slice(0, match.index)}${next}${html.slice(match.index + match[0].length)}`
}

function orderAuthenticatedSettings(entries: BootGraphEntry[], slotsProvider: string): boolean {
  const mobile = entries.filter(entry => entry !== null && typeof entry === 'object' && entry.id === MOBILE_CLIENT_MODULE)
  const settings = entries.filter(entry => entry !== null && typeof entry === 'object' && entry.id === SETTINGS_MODULE)
  if (mobile.length === 0 || settings.length === 0) return false
  if (mobile.length !== 1 || settings.length !== 1) throw new Error('upstream DSH mobile settings graph is ambiguous')
  if (!Array.isArray(mobile[0]?.inject)
    || !mobile[0].inject.includes(CONNECTION_MODULE)
    || !mobile[0].inject.includes(SIDEBAR_MODULE)) {
    throw new Error('dsh-mobile client has unsupported dependencies')
  }
  if (!Array.isArray(settings[0]?.inject)) {
    throw new Error('upstream DSH settings module has unsupported dependencies')
  }
  const remoteSettings = !settings[0].inject.includes(CONNECTION_MODULE)
  if (remoteSettings) {
    if (!settings[0].inject.includes(API_REMOTES_MODULE) || slotsProvider !== RENDERER_MODULE) {
      throw new Error('upstream DSH settings module has unsupported dependencies')
    }
    const remotes = entries.filter(entry => entry !== null && typeof entry === 'object' && entry.id === API_REMOTES_MODULE)
    const gateway = entries.filter(entry => entry !== null && typeof entry === 'object' && entry.id === API_GATEWAY_MODULE)
    if (remotes.length !== 1 || !Array.isArray(remotes[0]?.inject) || !remotes[0].inject.includes(API_GATEWAY_MODULE)
      || gateway.length !== 1 || !Array.isArray(gateway[0]?.inject) || !gateway[0].inject.includes(CONNECTION_MODULE)) {
      throw new Error('upstream DSH settings Remote graph has unsupported dependencies')
    }
    // These package edges order factory arrival; authenticated transport trust is installed before boot.
    if (!gateway[0].inject.includes(MOBILE_CLIENT_MODULE)) gateway[0].inject = [...gateway[0].inject, MOBILE_CLIENT_MODULE]
  }
  mobile[0].inject = [CONNECTION_MODULE, slotsProvider]
  if (!settings[0].inject.includes(MOBILE_CLIENT_MODULE)) settings[0].inject = [...settings[0].inject, MOBILE_CLIENT_MODULE]
  return remoteSettings
}

function revisionedMobileBatchPath(entries: readonly MobileBootBatchEntry[]): { readonly key: string; readonly path: string } {
  const key = createHash('sha256')
    .update(DSH_MOBILE_VERSION)
    .update(JSON.stringify(entries))
    .digest('hex')
  return { key, path: `${MOBILE_BOOT_BATCH_PREFIX}${key}.js` }
}

function rewriteMobileIndexWithBatch(html: string): RewrittenMobileIndex {
  const assignment = /(?:window\.__DSH_BOOT__|globalThis\["__DSH_BOOT__"\])\s*=\s*/u.exec(html)
  if (assignment?.index === undefined) throw new Error('upstream DSH index has no boot manifest')
  const start = assignment.index
  const valueStart = start + assignment[0].length
  const scriptEnd = html.indexOf('</script>', valueStart)
  if (scriptEnd < 0) throw new Error('upstream DSH boot manifest script is incomplete')
  const source = html.slice(valueStart, scriptEnd).trim().replace(/;$/u, '')
  const parsed = JSON.parse(source) as { rev?: unknown; entries?: unknown; batches?: unknown }
  if (typeof parsed.rev !== 'string' || !Array.isArray(parsed.entries)) {
    throw new Error('upstream DSH boot manifest is malformed')
  }
  const entries = parsed.entries as BootGraphEntry[]
  const layout = entries.filter(entry => entry !== null && typeof entry === 'object' && entry.id === MOBILE_LAYOUT_MODULE)
  if (layout.length !== 1 || typeof layout[0]?.url !== 'string' || typeof layout[0].rev !== 'string') {
    throw new Error('upstream DSH boot manifest has no unique layout module')
  }
  if (!Array.isArray(layout[0].inject)) {
    throw new Error('upstream DSH layout module has unsupported dependencies')
  }
  const dependencyProfile = MOBILE_LAYOUT_DEPENDENCY_PROFILES.find(profile => (
    profile.dependencies.every(dependency => layout[0]?.inject?.includes(dependency))
  ))
  if (dependencyProfile === undefined) throw new Error('upstream DSH layout module has unsupported dependencies')
  layout[0].url = MOBILE_LAYOUT_PATH
  layout[0].rev = `dsh-mobile-layout-${DSH_MOBILE_VERSION}`
  const remoteSettings = orderAuthenticatedSettings(entries, dependencyProfile.slots)

  let mobileBatch: MobileBootBatchPlan | undefined
  if (parsed.batches !== undefined) {
    if (!Array.isArray(parsed.batches)) throw new Error('upstream DSH boot manifest batches are malformed')
    const batches = parsed.batches as BootGraphBatch[]
    const entryById = new Map(entries.map(entry => [entry.id, entry]))
    if (entryById.size !== entries.length) throw new Error('upstream DSH boot manifest has duplicate entries')
    const layoutBatches: BootGraphBatch[] = []
    for (const batch of batches) {
      if (batch === null || typeof batch !== 'object'
        || (batch.phase !== 'bootstrap' && batch.phase !== 'application')
        || typeof batch.url !== 'string' || typeof batch.rev !== 'string'
        || !Array.isArray(batch.entries) || batch.entries.length === 0
        || batch.entries.some(id => typeof id !== 'string' || !entryById.has(id))) {
        throw new Error('upstream DSH boot manifest batches are malformed')
      }
      if (batch.entries.includes(MOBILE_LAYOUT_MODULE)) layoutBatches.push(batch)
    }
    if (layoutBatches.length !== 1 || layoutBatches[0]?.phase !== 'application') {
      throw new Error('upstream DSH boot manifest has no unique application layout batch')
    }
    const layoutBatch = layoutBatches[0]
    const planEntries = layoutBatch.entries.map((id): MobileBootBatchEntry => {
      const entry = entryById.get(id)
      if (entry === undefined || typeof entry.url !== 'string' || typeof entry.rev !== 'string') {
        throw new Error('upstream DSH boot manifest batches are malformed')
      }
      return Object.freeze({ id, url: entry.url, rev: entry.rev })
    })
    const revision = revisionedMobileBatchPath(planEntries)
    layoutBatch.url = revision.path
    layoutBatch.rev = revision.key
    mobileBatch = Object.freeze({ ...revision, entries: Object.freeze(planEntries) })
    parsed.rev = createHash('sha256').update(JSON.stringify({ entries, batches })).digest('hex').slice(0, 16)
  }
  const transportBootstrap = remoteSettings ? MOBILE_AUTHENTICATED_TRANSPORT_BOOTSTRAP : ''
  const replacement = `${transportBootstrap}${MOBILE_CSRF_FETCH_BOOTSTRAP}window.__DSH_MOBILE_FRONTEND__="dedicated";${assignment[0]}${JSON.stringify(parsed)};`
  return Object.freeze({
    html: ensureMobileViewport(`${html.slice(0, start)}${replacement}${html.slice(scriptEnd)}`),
    ...(mobileBatch === undefined ? {} : { batch: mobileBatch }),
  })
}

/** Replace only DSH's layout client module while retaining its complete plugin graph. */
export function rewriteMobileIndex(html: string): string {
  return rewriteMobileIndexWithBatch(html).html
}

const PAIR_SCRIPT = `(() => {
  const form = document.getElementById('pair-form')
  const token = document.getElementById('pair-token')
  const label = document.getElementById('device-label')
  const status = document.getElementById('pair-status')
  const fragment = new URLSearchParams(location.hash.slice(1))
  const supplied = fragment.get('token')
  history.replaceState(null, '', location.pathname)
  if (supplied) token.value = supplied
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    status.value = 'Pairing…'
    const response = await fetch('/mobile-access/auth/pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: token.value, label: label.value || undefined }),
    })
    if (!response.ok) {
      status.value = 'Pairing failed'
      return
    }
    location.replace('/')
  })
})()
`

const LOGIN_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Reconnect DSH mobile access</title>
<main>
  <h1>Reconnect this device</h1>
  <p id="login-progress">Restoring the secure Session…</p>
  <section id="login-failed" hidden>
    <p>This device is no longer paired. Open pairing on the computer, then pair it again.</p>
    <a href="/mobile-access/pair">Open pairing</a>
  </section>
</main>
<script src="/mobile-access/login.js" defer></script>
</html>
`

const LOGIN_SCRIPT = `(() => {
  const candidate = new URL(location.href).searchParams.get('return')
  let returnPath = '/'
  if (candidate && candidate.startsWith('/')) {
    try {
      const resolved = new URL(candidate, location.origin)
      const pathname = decodeURIComponent(resolved.pathname)
      if (resolved.origin === location.origin && pathname !== '/mobile-access'
        && !pathname.startsWith('/mobile-access/') && !pathname.includes('\\\\')) {
        returnPath = resolved.pathname + resolved.search + resolved.hash
      }
    } catch {
      // Malformed untrusted return targets keep the safe root default.
    }
  }
  fetch('/mobile-access/auth/renew', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).then((response) => {
    if (response.ok) {
      location.replace(returnPath)
      return
    }
    document.getElementById('login-progress').hidden = true
    document.getElementById('login-failed').hidden = false
  }).catch(() => {
    document.getElementById('login-progress').textContent = 'The computer is unavailable.'
  })
})()
`

class ByteLimitTransform extends Transform {
  private total = 0

  constructor(private readonly maximum: number) {
    super()
  }

  override _transform(chunk: Buffer, encoding: BufferEncoding, callback: TransformCallback): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    this.total += buffer.length
    if (this.total > this.maximum) {
      callback(new HttpError(413, 'payload_too_large'))
      return
    }
    callback(null, buffer)
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

interface PemCertificate {
  readonly pem: string
  readonly certificate: X509Certificate
}

function parsePemCertificates(contents: Buffer, source: string): PemCertificate[] {
  const text = contents.toString('utf8')
  const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu
  const blocks = text.match(pattern) ?? []
  if (blocks.length === 0 || text.replace(pattern, '').trim() !== '') {
    throw new Error(`${source} must contain only PEM certificates`)
  }
  return blocks.map((pem) => {
    let certificate: X509Certificate
    try {
      certificate = new X509Certificate(pem)
    } catch (error) {
      throw new Error(`${source} contains an invalid certificate`, { cause: error })
    }
    return Object.freeze({ pem: `${pem}\n`, certificate })
  })
}

function validateServerChain(chain: readonly PemCertificate[]): void {
  const now = Date.now()
  for (const [index, entry] of chain.entries()) {
    if (Date.parse(entry.certificate.validFrom) > now || Date.parse(entry.certificate.validTo) <= now) {
      throw new Error('TLS certificate chain contains a certificate that is not currently valid')
    }
    if (index === 0) continue
    if (entry.certificate.subject === entry.certificate.issuer
      && entry.certificate.verify(entry.certificate.publicKey)) {
      throw new Error('TLS server certificate chain must not include a self-signed root')
    }
    const child = chain[index - 1]!.certificate
    if (!entry.certificate.ca || !child.checkIssued(entry.certificate)
      || !child.verify(entry.certificate.publicKey)) {
      throw new Error('TLS server certificate chain is not an ordered leaf-to-intermediate chain')
    }
  }
}

async function tlsOptions(config: ResolvedGatewayConfig): Promise<ServerOptions> {
  if (config.tls.mode === 'disabled') throw new Error('TLS options requested for a disabled listener')
  const [certFile, key, additionalChainFile] = await Promise.all([
    readFile(config.tls.certFile),
    readFile(config.tls.keyFile),
    config.tls.caFile === undefined ? Promise.resolve(undefined) : readFile(config.tls.caFile),
  ])
  const chain = [
    ...parsePemCertificates(certFile, 'tls.certFile'),
    ...(additionalChainFile === undefined ? [] : parsePemCertificates(additionalChainFile, 'tls.caFile')),
  ]
  validateServerChain(chain)
  const leaf = chain[0]!.certificate
  for (const authority of config.authorities) {
    const hostname = stripIpv6Brackets(authority.hostname)
    const match = isIP(hostname) === 0 ? leaf.checkHost(hostname) : leaf.checkIP(hostname)
    if (match === undefined) throw new Error(`TLS certificate does not cover configured authority ${hostname}`)
  }
  return {
    cert: chain.map(entry => entry.pem).join(''),
    key,
    requestCert: false,
    minVersion: 'TLSv1.2',
    maxHeaderSize: MAX_HEADER_BYTES,
  }
}

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`, 'ascii').digest('base64')
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? undefined : value
}

function hasToken(header: string | undefined, token: string): boolean {
  return header?.split(',').some(value => value.trim().toLowerCase() === token) ?? false
}

function rejectUpgrade(socket: Socket, status: number, code: string): void {
  if (socket.destroyed) return
  const body = `${JSON.stringify({ error: code })}\n`
  socket.end([
    `HTTP/1.1 ${String(status)} ${status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : 'Bad Request'}`,
    'Connection: close',
    'Cache-Control: no-store',
    'Content-Type: application/json; charset=utf-8',
    'Referrer-Policy: no-referrer',
    'X-Content-Type-Options: nosniff',
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    '',
    body,
  ].join('\r\n'))
}

function sanitizeRequestHeaders(
  request: IncomingMessage,
  upstream: URL,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {
    host: upstream.host,
  }
  if (request.headers.origin !== undefined) headers.origin = upstream.origin
  if (request.headers['sec-fetch-site'] !== undefined) headers['sec-fetch-site'] = 'same-origin'
  const allowed = [
    'accept', 'accept-encoding', 'accept-language', 'content-encoding', 'content-length', 'content-type',
    'if-match', 'if-modified-since', 'if-none-match', 'if-unmodified-since', 'range', 'user-agent',
  ] as const
  for (const name of allowed) {
    const value = request.headers[name]
    if (value !== undefined) headers[name] = value
  }
  return headers
}

const BLOCKED_RESPONSE_HEADERS = new Set([
  'alt-svc', 'cache-control', 'connection', 'content-security-policy', 'content-security-policy-report-only',
  'cross-origin-embedder-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'expires',
  'keep-alive', 'nel', 'permissions-policy', 'pragma', 'proxy-authenticate', 'referrer-policy',
  'report-to', 'reporting-endpoints', 'server', 'set-cookie', 'strict-transport-security', 'trailer',
  'transfer-encoding', 'upgrade', 'via', 'x-content-type-options', 'x-frame-options', 'x-powered-by',
])

function sanitizeResponseHeaders(headers: IncomingHttpHeaders, upstream: URL): OutgoingHttpHeaders {
  const clean: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (value === undefined || BLOCKED_RESPONSE_HEADERS.has(lower) || lower.startsWith('access-control-')) continue
    if (lower === 'location' && typeof value === 'string') {
      try {
        const location = new URL(value, upstream)
        clean.location = location.origin === upstream.origin
          ? `${location.pathname}${location.search}${location.hash}`
          : value
      } catch {
        continue
      }
      continue
    }
    clean[lower] = value
  }
  return clean
}

function acceptsGzip(header: string | undefined): boolean {
  if (header === undefined) return false
  let wildcard: boolean | undefined
  for (const entry of header.split(',')) {
    const [rawName, ...parameters] = entry.split(';')
    const name = rawName?.trim().toLowerCase()
    if (name === undefined || name === '') continue
    let quality = 1
    for (const parameter of parameters) {
      const match = /^\s*q\s*=\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*$/iu.exec(parameter)
      if (match !== null) quality = Number(match[1])
    }
    if (name === 'gzip') return quality > 0
    if (name === '*') wildcard = quality > 0
  }
  return wildcard ?? false
}

function isCompressibleContentType(value: string | string[] | undefined): boolean {
  const contentType = Array.isArray(value) ? value[0] : value
  if (contentType === undefined) return false
  const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  return mediaType.startsWith('text/')
    || /^(?:application\/(?:javascript|json|xml|x-javascript)|image\/svg\+xml)$/u.test(mediaType)
}

function shouldCompressResponse(request: IncomingMessage, response: IncomingMessage): boolean {
  const pathname = request.url?.split('?', 1)[0] ?? ''
  const compressibleRequest = (request.method === 'GET'
      && (pathname.startsWith('/plugins/') || pathname.startsWith('/assets/')))
    || (request.method === 'POST' && pathname === SESSION_HISTORY_PATH)
  return compressibleRequest
    && response.statusCode === 200
    && request.headers.range === undefined
    && response.headers['content-range'] === undefined
    && response.headers['content-encoding'] === undefined
    && acceptsGzip(request.headers['accept-encoding'])
    && isCompressibleContentType(response.headers['content-type'])
}

function revisionedStaticCacheControl(request: IncomingMessage): string | undefined {
  if (request.method !== 'GET' && request.method !== 'HEAD') return undefined
  let target: URL
  try { target = new URL(request.url ?? '/', 'https://dsh-mobile.invalid') } catch { return undefined }
  const revision = target.searchParams.get('rev')
  const hasRevision = revision !== null && /^[a-z0-9_-]{4,128}$/iu.test(revision)
  const hashedAsset = /^\/assets\/.*-[a-z0-9_-]{8,}\.[a-z0-9]+$/iu.test(target.pathname)
  if (!(target.pathname.startsWith('/plugins/') && hasRevision)
    && !(target.pathname.startsWith('/assets/') && (hasRevision || hashedAsset))) return undefined
  return 'private, max-age=31536000, immutable'
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mobileHistoryRequestBody(request: IncomingMessage, body: Buffer): Buffer {
  if (request.method !== 'POST' || request.url?.split('?', 1)[0] !== SESSION_HISTORY_PATH) return body
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return body
  }
  if (!isJsonRecord(parsed) || parsed.method !== 'session.history' || !isJsonRecord(parsed.payload)) return body
  const requested = parsed.payload.maxMessages
  if (typeof requested === 'number' && Number.isInteger(requested) && requested > 0 && requested <= MOBILE_HISTORY_PAGE_MESSAGES) {
    return body
  }
  return Buffer.from(JSON.stringify({
    ...parsed,
    payload: { ...parsed.payload, maxMessages: MOBILE_HISTORY_PAGE_MESSAGES },
  }))
}

function addVaryAcceptEncoding(headers: OutgoingHttpHeaders): void {
  const existing = headers.vary
  const rawValues: string[] = Array.isArray(existing)
    ? existing.map(value => String(value))
    : existing === undefined ? [] : [String(existing)]
  const values = rawValues.flatMap(value => value.split(',').map(part => part.trim()).filter(Boolean))
  if (!values.some(value => value.toLowerCase() === 'accept-encoding')) values.push('Accept-Encoding')
  headers.vary = values.join(', ')
}

function requestCookies(request: IncomingMessage): ReadonlyMap<string, string> {
  const cookies = parseCookies(request.headers.cookie)
  if (cookies === undefined) throw new HttpError(401, 'authentication_failed')
  return cookies
}

function mapError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof AccessError) return new HttpError(error.status, error.code)
  if (error instanceof MobileExtensionError) return new HttpError(error.status, error.code)
  return new HttpError(500, 'internal_error')
}

function requestAbortedError(): Error {
  const error = new Error('request aborted')
  error.name = 'AbortError'
  return error
}

function isTransientUpstreamError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  return typeof code === 'string' && TRANSIENT_UPSTREAM_ERROR_CODES.has(code)
}

function upstreamTimeoutError(): NodeJS.ErrnoException {
  const error = new Error('upstream timeout') as NodeJS.ErrnoException
  error.code = 'ETIMEDOUT'
  return error
}

function waitForAbortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(requestAbortedError())
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      clearTimeout(timer)
      reject(requestAbortedError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', aborted, { once: true })
  })
}

function waitForRequestTask<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(requestAbortedError())
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      reject(requestAbortedError())
    }
    signal.addEventListener('abort', aborted, { once: true })
    void task.then(
      value => {
        signal.removeEventListener('abort', aborted)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', aborted)
        reject(error)
      },
    )
  })
}

function discoveryDeviceName(): string {
  const value = hostname().trim().replaceAll(/[\u0000-\u001f\u007f]/gu, '')
  return (value === '' ? 'DeepSeek Harness' : value).slice(0, 63)
}

function discoveryMdnsHost(instanceId: string): string {
  const label = hostname().toLowerCase().replaceAll(/[^a-z0-9-]/gu, '-').replaceAll(/^-+|-+$/gu, '').slice(0, 40)
  return `${label === '' ? 'dsh' : label}-${instanceId.slice(0, 8)}.local`
}

function discoveryBroadcastTargets(cidrs: readonly ParsedCidr[]): readonly string[] {
  const targets = new Set<string>(['255.255.255.255'])
  for (const cidr of cidrs) {
    if (cidr.bits !== 32 || cidr.prefix >= 32) continue
    const hostBits = BigInt(32 - cidr.prefix)
    const broadcast = cidr.network | ((1n << hostBits) - 1n)
    targets.add([24n, 16n, 8n, 0n].map(shift => Number((broadcast >> shift) & 0xffn)).join('.'))
  }
  return [...targets]
}

function extensionTarget(pathname: string):
  | { readonly kind: 'manifest' }
  | { readonly kind: 'events' }
  | { readonly kind: 'script' | 'style' | 'asset'; readonly id: string; readonly path?: string }
  | { readonly kind: 'action'; readonly id: string; readonly action: string }
  | { readonly kind: 'route'; readonly id: string; readonly path: string }
  | undefined {
  const prefix = `${AUTH_PREFIX}/extensions`
  if (pathname === prefix || pathname === `${prefix}/` || pathname === `${prefix}/manifest`) return { kind: 'manifest' }
  if (pathname === `${prefix}/events`) return { kind: 'events' }
  if (!pathname.startsWith(`${prefix}/`)) return undefined
  const parts = pathname.slice(prefix.length + 1).split('/')
  const id = parts.shift()
  if (id === undefined || !/^[a-z][a-z0-9-]{0,63}$/u.test(id)) return undefined
  const leaf = parts.shift()
  if (leaf === 'mobile.js' && parts.length === 0) return { kind: 'script', id }
  if (leaf === 'mobile.css' && parts.length === 0) return { kind: 'style', id }
  if (leaf === 'assets' && parts.length > 0) return { kind: 'asset', id, path: parts.join('/') }
  if (leaf === 'actions' && parts.length === 1 && /^[a-z][a-z0-9-]{0,63}$/u.test(parts[0]!)) return { kind: 'action', id, action: parts[0]! }
  if (leaf === 'routes') return { kind: 'route', id, path: `/${parts.join('/')}`.replace(/\/{2,}/gu, '/') }
  return undefined
}

const EXTENSION_GENERATION_HEADER = 'x-dsh-mobile-extension-generation'

function extensionGeneration(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^[a-f\d]{64}$/u.test(value)) throw new HttpError(400, 'invalid_extension_generation')
  return value
}

function mobileBootBatchKey(pathname: string): string | undefined {
  const match = new RegExp(`^${MOBILE_BOOT_BATCH_PREFIX.replaceAll('/', '\\/')}([a-f\\d]{64})\\.js$`, 'u').exec(pathname)
  return match?.[1]
}

function assertBoundedContentLength(request: IncomingMessage, maximum: number): void {
  const declared = request.headers['content-length']
  if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
    throw new HttpError(413, 'payload_too_large')
  }
}

async function readBoundedBody(request: IncomingMessage, maximum: number): Promise<Buffer> {
  assertBoundedContentLength(request, maximum)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buffer.length
    if (total > maximum) throw new HttpError(413, 'payload_too_large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

function extensionRequestHeaders(headers: IncomingHttpHeaders): Readonly<Record<string, string>> {
  const allowed = new Set(['accept', 'content-type', 'content-length', 'content-range', 'range', 'if-none-match', 'if-modified-since'])
  const output: Record<string, string> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (!allowed.has(name) || typeof value !== 'string') continue
    output[name] = value
  }
  return Object.freeze(output)
}

function extensionContentType(path: string): string {
  const type = {
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  }[extname(path).toLowerCase()]
  return type ?? 'application/octet-stream'
}

/** Authenticated TLS edge in front of the ordinary loopback-only DSH Web server. */
export class MobileAccessGateway {
  readonly access: AccessController
  private readonly listenerTlsEnabled: boolean
  private readonly tlsEnabled: boolean
  private policy: RequestTrustPolicy | undefined
  private server: GatewayServer | undefined
  private discoverySocket: DatagramSocket | undefined
  private discoveryTimer: NodeJS.Timeout | undefined
  private bonjour: Bonjour | undefined
  private pairingCaCertificate: string | undefined
  private listenerPort: number | undefined
  private readonly connectedSockets = new Set<Socket>()
  private readonly activeRequests = new Map<number, ActiveRequest>()
  private readonly activeWebSockets = new Map<number, ActiveWebSocket>()
  private readonly mobileBootBatches = new Map<string, StoredMobileBootBatch>()
  private readonly extensionEventListeners = new Set<(revision: number) => void>()
  private extensionEventRevision = 0
  private extensionChangeTimer: NodeJS.Timeout | undefined
  private extensionChangeTask: Promise<void> | undefined
  private legacyCustomDigest = ''
  private upstreamCookie: string | undefined
  private upstreamCookieExpiresAt = 0
  private upstreamCookieTask: Promise<string> | undefined
  private upstreamAuthRequest: ClientRequest | undefined
  private nextOperationId = 1
  private closing = false
  private started = false
  private closeTask: Promise<void> | undefined
  private readonly removeSessionListener: () => void
  private readonly removeExtensionContentListener: () => void
  private readonly renewLimiter: BoundedRateLimiter

  constructor(
    readonly config: ResolvedGatewayConfig,
    store: DeviceStore,
    private readonly extensions?: MobileAccessService,
    private readonly upstreamAuthenticatedUrl?: string,
    private readonly extraWebSocketPaths?: { has(pathname: string): boolean },
    private readonly blockedUpgradeLog?: BlockedUpgradePathLog,
  ) {
    this.listenerTlsEnabled = config.tls.mode === 'provided'
    this.tlsEnabled = config.publicTls
    this.access = new AccessController(store, {
      pairingTtlMs: config.pairingTtlMs,
      deviceTtlMs: config.deviceTtlMs,
      sessionTtlMs: config.sessionTtlMs,
      maxDevices: config.maxDevices,
      maxSessions: config.maxSessions,
      rateLimitWindowMs: config.rateLimitWindowMs,
      maxPairingAttempts: config.maxPairingAttempts,
      maxRateLimitKeys: config.maxRateLimitKeys,
    })
    this.renewLimiter = new BoundedRateLimiter(
      Math.min(100, config.maxPairingAttempts * 4),
      config.rateLimitWindowMs,
      config.maxRateLimitKeys,
    )
    this.removeSessionListener = this.access.onSessionEnded(authorization => {
      this.abortSessionResources(authorization.sessionKey)
    })
    this.removeExtensionContentListener = this.extensions?.onContentChanged(() => {
      this.broadcastExtensionChange()
    }) ?? (() => undefined)
  }

  /** Initialize durable state, validate TLS, and bind the externally reachable listener. */
  async start(): Promise<void> {
    if (this.started || this.server !== undefined) throw new Error('mobile-access gateway cannot be started twice')
    this.started = true
    await this.access.initialize()
    try {
      if (this.config.pairingCaFile !== undefined) {
        const certificate = new X509Certificate(await readFile(this.config.pairingCaFile))
        const fingerprint = certificate.fingerprint256.replaceAll(':', '').toLowerCase()
        if (!certificate.ca || certificate.subject !== certificate.issuer
          || !certificate.verify(certificate.publicKey) || fingerprint !== this.config.instanceId) {
          throw new Error('pairingCaFile must be the self-signed CA identified by instanceId')
        }
        this.pairingCaCertificate = certificate.raw.toString('base64')
      }
      const handler = (request: IncomingMessage, response: ServerResponse): void => {
        void this.handleExternalRequest(request, response).catch((error: unknown) => {
          const mapped = mapError(error)
          if (response.headersSent) response.destroy()
          else sendFailure(response, mapped.status, mapped.code, this.tlsEnabled)
        })
      }
      const server = this.listenerTlsEnabled
        ? createHttpsServer(await tlsOptions(this.config), handler)
        : createHttpServer({ maxHeaderSize: MAX_HEADER_BYTES }, handler)
      this.server = server
      server.maxHeadersCount = 64
      server.maxConnections = this.config.maxConnections
      server.headersTimeout = 10_000
      server.requestTimeout = this.config.upstreamTimeoutMs
      server.keepAliveTimeout = 5_000
      server.on('connection', (socket: Socket) => {
        if (this.connectedSockets.size >= this.config.maxConnections) {
          socket.destroy()
          return
        }
        this.connectedSockets.add(socket)
        socket.on('error', () => { socket.destroy() })
        socket.once('close', () => { this.connectedSockets.delete(socket) })
      })
      server.on('connect', (_request, socket) => { socket.destroy() })
      server.on('upgrade', (request, socket, head) => {
        void this.handleUpgrade(request, socket as Socket, head).catch((error: unknown) => {
          const mapped = mapError(error)
          rejectUpgrade(socket as Socket, mapped.status, mapped.code)
        })
      })
      server.on('clientError', (_error, socket) => { rejectUpgrade(socket as Socket, 400, 'bad_request') })
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { reject(error) }
        server.once('error', failed)
        server.listen(this.config.listenPort, this.config.listenHost, () => {
          server.off('error', failed)
          resolve()
        })
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('gateway listener has no TCP address')
      this.listenerPort = address.port
      this.policy = new RequestTrustPolicy(
        this.config.authorities,
        address.port,
        this.config.allowedCidrs,
        this.tlsEnabled,
      )
      if (this.config.discovery) await this.startDiscovery(address.port)
      await this.pollLegacyCustomChanges()
      this.extensionChangeTimer = setInterval(() => { void this.pollLegacyCustomChanges() }, EXTENSION_CHANGE_POLL_MS)
      this.extensionChangeTimer.unref()
    } catch (error) {
      await this.closeFailedStart()
      throw error
    }
  }

  private async startDiscovery(port: number): Promise<void> {
    const socket = createSocket('udp4')
    this.discoverySocket = socket
    const announcement = this.discoveryAnnouncement(port)
    socket.on('message', (message, remote) => {
      if (this.closing || !message.equals(DISCOVERY_QUERY)
        || !addressAllowed(remote.address, this.config.allowedCidrs)) return
      socket.send(announcement, remote.port, remote.address, () => undefined)
    })
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { reject(error) }
      socket.once('error', failed)
      // The UDP socket is IPv4-only; only a literal IPv4 loopback address is bindable, never ::1.
      const bindHost = isIP(this.config.listenHost) === 4 && isLoopbackAddress(this.config.listenHost) ? this.config.listenHost : '0.0.0.0'
      socket.bind(port, bindHost, () => {
        socket.off('error', failed)
        socket.setBroadcast(true)
        resolve()
      })
    })
    const announce = (): void => {
      for (const target of discoveryBroadcastTargets(this.config.allowedCidrs)) {
        socket.send(announcement, port, target, () => undefined)
      }
    }
    announce()
    this.discoveryTimer = setInterval(announce, DISCOVERY_INTERVAL_MS)
    this.discoveryTimer.unref()

    const deviceName = discoveryDeviceName()
    const bonjour = new Bonjour({ disableIPv6: true })
    this.bonjour = bonjour
    bonjour.publish({
      name: `${deviceName} (${this.config.instanceId.slice(0, 8)})`,
      type: MDNS_SERVICE_TYPE,
      protocol: 'tcp',
      port,
      host: discoveryMdnsHost(this.config.instanceId),
      disableIPv6: true,
      txt: {
        deviceName,
        origin: this.address().origin,
        instanceId: this.config.instanceId,
        protocol: String(DISCOVERY_PROTOCOL),
      },
    })
  }

  private discoveryAnnouncement(port: number): Buffer {
    return Buffer.from(JSON.stringify({
      deviceName: discoveryDeviceName(),
      origin: this.address().origin,
      port,
      protocol: DISCOVERY_PROTOCOL,
      instanceId: this.config.instanceId,
    }), 'utf8')
  }

  private async closeFailedStart(): Promise<void> {
    if (this.extensionChangeTimer !== undefined) clearInterval(this.extensionChangeTimer)
    this.extensionChangeTimer = undefined
    this.removeExtensionContentListener()
    if (this.discoveryTimer !== undefined) clearInterval(this.discoveryTimer)
    this.discoveryTimer = undefined
    await this.closeBonjour()
    this.discoverySocket?.close()
    this.discoverySocket = undefined
    for (const socket of this.connectedSockets) socket.destroy()
    const server = this.server
    this.server = undefined
    if (server?.listening === true) {
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
    await this.access.close()
  }

  private async closeBonjour(): Promise<void> {
    const bonjour = this.bonjour
    this.bonjour = undefined
    if (bonjour === undefined) return
    await new Promise<void>(resolve => {
      bonjour.unpublishAll(() => { bonjour.destroy(() => resolve()) })
    })
  }

  /** Actual bound address, available after start and safe for loopback status output. */
  address(): { host: string; port: number; origin: string } {
    if (this.listenerPort === undefined || this.policy === undefined) throw new Error('gateway is not listening')
    const origin = this.policy.origins.values().next().value as string | undefined
    if (origin === undefined) throw new Error('gateway has no public authority')
    return Object.freeze({ host: this.config.listenHost, port: this.listenerPort, origin })
  }

  private requirePolicy(): RequestTrustPolicy {
    if (this.policy === undefined || this.closing) throw new HttpError(503, 'unavailable')
    return this.policy
  }

  private authorize(request: IncomingMessage): SessionAuthorization {
    const sessionToken = requestCookies(request).get(SESSION_COOKIE)
    if (sessionToken === undefined) throw new HttpError(401, 'authentication_failed')
    return this.access.authorizeSession(sessionToken)
  }

  private requireCsrf(request: IncomingMessage, authorization: SessionAuthorization): void {
    const value = headerValue(request.headers, CSRF_HEADER)
    this.access.assertCsrf(authorization, value)
  }

  private setSessionCookies(response: ServerResponse, result: {
    sessionToken: string
    csrfToken: string
    sessionExpiresAt: number
  }, now: number): void {
    const maxAge = (result.sessionExpiresAt - now) / 1000
    response.setHeader('Set-Cookie', [
      cookie(SESSION_COOKIE, result.sessionToken, { tls: this.tlsEnabled, httpOnly: true, path: '/', maxAgeSeconds: maxAge }),
      cookie(CSRF_COOKIE, result.csrfToken, { tls: this.tlsEnabled, httpOnly: false, path: '/', maxAgeSeconds: maxAge }),
    ])
  }

  private async handlePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
    if (typeof body.token !== 'string' || (body.label !== undefined && typeof body.label !== 'string')) {
      throw new HttpError(400, 'bad_request')
    }
    const result = await this.access.pair(request.socket.remoteAddress ?? 'unknown', body.token, body.label as string | undefined)
    const now = Date.now()
    this.setSessionCookies(response, result, now)
    const sessionCookies = response.getHeader('Set-Cookie') as string[]
    response.setHeader('Set-Cookie', [
      ...sessionCookies,
      cookie(DEVICE_COOKIE, result.deviceToken, {
        tls: this.tlsEnabled,
        httpOnly: true,
        path: '/mobile-access/auth/renew',
        maxAgeSeconds: (result.deviceExpiresAt - now) / 1000,
      }),
    ])
    sendJson(response, 201, {
      paired: true,
      deviceId: result.deviceId,
      csrfToken: result.csrfToken,
      sessionExpiresAt: result.sessionExpiresAt,
    }, this.tlsEnabled)
  }

  private async handleRenew(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.renewLimiter.take(request.socket.remoteAddress ?? 'unknown', Date.now())) {
      throw new HttpError(429, 'rate_limited')
    }
    await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
    const deviceToken = requestCookies(request).get(DEVICE_COOKIE)
    if (deviceToken === undefined) throw new HttpError(401, 'authentication_failed')
    let result
    try {
      result = await this.access.renew(deviceToken)
    } catch (error) {
      if (error instanceof AccessError && error.status === 401) {
        response.setHeader('Set-Cookie', cookie(DEVICE_COOKIE, '', {
          tls: this.tlsEnabled,
          httpOnly: true,
          path: '/mobile-access/auth/renew',
          maxAgeSeconds: 0,
        }))
      }
      throw error
    }
    this.setSessionCookies(response, result, Date.now())
    sendJson(response, 200, {
      renewed: true,
      deviceId: result.deviceId,
      csrfToken: result.csrfToken,
      sessionExpiresAt: result.sessionExpiresAt,
    }, this.tlsEnabled)
  }

  private async handleNativePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
    if (typeof body.token !== 'string' || (body.label !== undefined && typeof body.label !== 'string')) {
      throw new HttpError(400, 'bad_request')
    }
    const result = await this.access.pair(
      request.socket.remoteAddress ?? 'unknown',
      body.token,
      body.label as string | undefined,
    )
    sendJson(response, 201, {
      instanceId: this.config.instanceId,
      deviceId: result.deviceId,
      deviceToken: result.deviceToken,
      deviceExpiresAt: result.deviceExpiresAt,
      sessionToken: result.sessionToken,
      csrfToken: result.csrfToken,
      sessionExpiresAt: result.sessionExpiresAt,
    }, this.tlsEnabled)
  }

  private async handleNativeRenew(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.renewLimiter.take(request.socket.remoteAddress ?? 'unknown', Date.now())) {
      throw new HttpError(429, 'rate_limited')
    }
    const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
    if (typeof body.deviceToken !== 'string') throw new HttpError(400, 'bad_request')
    const result = await this.access.renew(body.deviceToken)
    sendJson(response, 200, {
      instanceId: this.config.instanceId,
      deviceId: result.deviceId,
      sessionToken: result.sessionToken,
      csrfToken: result.csrfToken,
      sessionExpiresAt: result.sessionExpiresAt,
    }, this.tlsEnabled)
  }

  private async handleLogout(request: IncomingMessage, response: ServerResponse): Promise<void> {
    await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
    const authorization = this.authorize(request)
    this.requireCsrf(request, authorization)
    this.access.logout(authorization)
    response.setHeader('Set-Cookie', [
      cookie(SESSION_COOKIE, '', { tls: this.tlsEnabled, httpOnly: true, path: '/', maxAgeSeconds: 0 }),
      cookie(CSRF_COOKIE, '', { tls: this.tlsEnabled, httpOnly: false, path: '/', maxAgeSeconds: 0 }),
    ])
    sendJson(response, 200, { loggedOut: true }, this.tlsEnabled)
  }

  private async handleExternalRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const target = parseRequestTarget(request.url)
    const policy = this.requirePolicy()
    const isMutation = request.method !== 'GET' && request.method !== 'HEAD'
    assertExternalTrust(request, policy, isMutation)
    if (target.decodedPathname === LOCAL_ADMIN_PREFIX || target.decodedPathname.startsWith(`${LOCAL_ADMIN_PREFIX}/`)) {
      throw new HttpError(404, 'not_found')
    }
    if (request.method === 'TRACE' || request.method === 'CONNECT') throw new HttpError(405, 'method_not_allowed')

    if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/health`) {
      sendJson(response, 200, { ok: true }, this.tlsEnabled)
      return
    }
    if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/metadata`) {
      sendJson(response, 200, {
        version: MOBILE_METADATA_VERSION,
        pluginVersion: DSH_MOBILE_VERSION,
        minimumAndroidAppVersion: MINIMUM_ANDROID_APP_VERSION,
        discoveryProtocol: DISCOVERY_PROTOCOL,
      }, this.tlsEnabled)
      return
    }
    if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/discovery`) {
      sendJson(response, 200, {
        deviceName: discoveryDeviceName(),
        origin: this.address().origin,
        port: this.address().port,
        protocol: DISCOVERY_PROTOCOL,
        instanceId: this.config.instanceId,
      }, this.tlsEnabled)
      return
    }
    if (target.search === '' && request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/ca.cer`) {
      if (this.pairingCaCertificate === undefined) throw new HttpError(404, 'not_found')
      const body = Buffer.from(this.pairingCaCertificate, 'base64')
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(200, {
        'Content-Type': 'application/pkix-cert',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      })
      response.end(body)
      return
    }
    if (target.search === '' && request.method === 'GET'
      && (target.decodedPathname === `${AUTH_PREFIX}/pair` || target.decodedPathname === `${AUTH_PREFIX}/pair.js`)) {
      if (!this.access.pairingStatus().open) throw new HttpError(404, 'not_found')
      setSecurityHeaders(response, this.tlsEnabled)
      const body = target.decodedPathname.endsWith('.js') ? PAIR_SCRIPT : PAIR_PAGE
      response.writeHead(200, {
        'Content-Type': target.decodedPathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      })
      response.end(body)
      return
    }
    if (request.method === 'GET'
      && (target.decodedPathname === `${AUTH_PREFIX}/login` || target.decodedPathname === `${AUTH_PREFIX}/login.js`)) {
      if (target.decodedPathname.endsWith('.js') && target.search !== '') throw new HttpError(400, 'bad_request')
      setSecurityHeaders(response, this.tlsEnabled)
      const body = target.decodedPathname.endsWith('.js') ? LOGIN_SCRIPT : LOGIN_PAGE
      response.writeHead(200, {
        'Content-Type': target.decodedPathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      })
      response.end(body)
      return
    }
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/auth/pair`) {
      await this.handlePair(request, response)
      return
    }
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/auth/renew`) {
      await this.handleRenew(request, response)
      return
    }
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/auth/native-pair`) {
      await this.handleNativePair(request, response)
      return
    }
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/auth/native-renew`) {
      await this.handleNativeRenew(request, response)
      return
    }
    if (target.search === '' && request.method === 'POST' && target.decodedPathname === `${AUTH_PREFIX}/auth/logout`) {
      await this.handleLogout(request, response)
      return
    }
    const computerImages = request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/computer-images`
    const computerImage = request.method === 'GET' && target.decodedPathname === `${AUTH_PREFIX}/computer-image`
    const requestedExtension = extensionTarget(target.decodedPathname)
    const requestedMobileBootBatch = mobileBootBatchKey(target.decodedPathname)
    const customAsset = request.method === 'GET'
      ? target.decodedPathname === `${AUTH_PREFIX}/custom.css`
        ? {
            file: this.config.customCssFile,
            contentType: 'text/css; charset=utf-8',
            fallback: CUSTOM_STYLE_FALLBACK,
          }
        : target.decodedPathname === `${AUTH_PREFIX}/custom.js`
          ? {
              file: this.config.customScriptFile,
              contentType: 'text/javascript; charset=utf-8',
              fallback: CUSTOM_SCRIPT_FALLBACK,
            }
          : target.decodedPathname === MOBILE_LAYOUT_PATH
            ? {
                file: this.config.mobileLayoutFile,
                contentType: 'text/javascript; charset=utf-8',
                fallback: undefined,
              }
          : undefined
      : undefined
    if (customAsset === undefined && requestedMobileBootBatch === undefined && !computerImages && !computerImage
      && extensionTarget(target.decodedPathname) === undefined
      && (target.decodedPathname === AUTH_PREFIX || target.decodedPathname.startsWith(`${AUTH_PREFIX}/`))) {
      throw new HttpError(404, 'not_found')
    }

    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST'
      && requestedExtension?.kind !== 'route') {
      throw new HttpError(405, 'method_not_allowed')
    }
    let authorization: SessionAuthorization
    try {
      authorization = this.authorize(request)
    } catch (error) {
      const mapped = mapError(error)
      const acceptsHtml = request.headers.accept?.split(',').some(value => value.trim().split(';', 1)[0] === 'text/html') ?? false
      const topLevel = request.method === 'GET'
        && acceptsHtml
        && (request.headers['sec-fetch-dest'] === undefined || request.headers['sec-fetch-dest'] === 'document')
        && target.decodedPathname !== '/api'
        && !target.decodedPathname.startsWith('/api/')
      if (mapped.status === 401 && topLevel) {
        const returnPath = target.raw.length <= 2048 ? target.raw : '/'
        setSecurityHeaders(response, this.tlsEnabled)
        response.writeHead(302, {
          Location: `${AUTH_PREFIX}/login?return=${encodeURIComponent(returnPath)}`,
          'Content-Length': 0,
        })
        response.end()
        return
      }
      throw error
    }
    if (isMutation) this.requireCsrf(request, authorization)
    const extension = requestedExtension
    if (extension !== undefined) {
      await this.handleExtensionRequest(extension, target, request, response, authorization)
      return
    }
    if (requestedMobileBootBatch !== undefined) {
      await this.serveMobileBootBatch(requestedMobileBootBatch, request, response, authorization)
      return
    }
    if (customAsset !== undefined) {
      const operation = this.allocateRequest(authorization, response, {})
      try {
        let body: Buffer
        let mtime: Date | undefined
        try {
          body = await readFile(customAsset.file, { signal: operation.signal })
          try {
            const fileStat = await stat(customAsset.file)
            mtime = fileStat.mtime
          } catch { /* keep undefined */ }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          if (customAsset.fallback === undefined) throw new HttpError(503, 'mobile_frontend_unavailable')
          body = Buffer.from(customAsset.fallback)
        }
        if (body.byteLength > 256 * 1024) throw new HttpError(413, 'payload_too_large')
        const etag = createHash('sha256').update(body).digest('hex')
        const ifNoneMatch = headerValue(request.headers, 'if-none-match')
        if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
          setSecurityHeaders(response, this.tlsEnabled)
          response.writeHead(304)
          response.end()
          return
        }
        setSecurityHeaders(response, this.tlsEnabled)
        const responseHeaders: Record<string, string | number> = {
          'Content-Type': customAsset.contentType,
          'Content-Length': body.byteLength,
          'ETag': etag,
        }
        if (mtime !== undefined) responseHeaders['Last-Modified'] = mtime.toUTCString()
        response.writeHead(200, responseHeaders)
        response.end(body)
        return
      } finally {
        operation.release()
      }
    }
    if (computerImages) {
      const operation = this.allocateRequest(authorization, response, {})
      try {
        const query = new URL(target.raw, this.address().origin).searchParams
        sendJson(response, 200, await listComputerImages(query.get('path'), operation.signal), this.tlsEnabled)
        return
      } finally {
        operation.release()
      }
    }
    if (computerImage) {
      const operation = this.allocateRequest(authorization, response, {})
      try {
        const query = new URL(target.raw, this.address().origin).searchParams
        const image = await readComputerImage(query.get('path'), operation.signal)
        setSecurityHeaders(response, this.tlsEnabled)
        response.writeHead(200, {
          'Content-Type': image.contentType,
          'Content-Length': image.body.byteLength,
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(image.name)}`,
        })
        response.end(image.body)
        return
      } finally {
        operation.release()
      }
    }
    const stockFrontend = new URL(target.raw, this.address().origin).searchParams.get('frontend') === 'stock'
    const acceptsHtml = request.headers.accept?.split(',').some(value => value.trim().split(';', 1)[0] === 'text/html') ?? false
    if (request.method === 'GET' && acceptsHtml && !stockFrontend) {
      await this.proxyMobileIndex(request, response, authorization)
      return
    }
    if (stockFrontend && target.decodedPathname === '/') request.url = '/'
    await this.proxyHttp(request, response, authorization)
  }

  private async handleExtensionRequest(
    targetInfo: NonNullable<ReturnType<typeof extensionTarget>>,
    target: ReturnType<typeof parseRequestTarget>,
    request: IncomingMessage,
    response: ServerResponse,
    authorization: SessionAuthorization,
  ): Promise<void> {
    const extensions = this.extensions
    if (extensions === undefined) throw new HttpError(404, 'not_found')
    if (targetInfo.kind === 'events') {
      if (request.method !== 'GET' || target.search !== '') throw new HttpError(request.method === 'GET' ? 400 : 405, request.method === 'GET' ? 'bad_request' : 'method_not_allowed')
      this.openExtensionEventStream(request, response, authorization)
      return
    }
    if (targetInfo.kind === 'manifest') {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed')
      const operation = this.allocateRequest(authorization, response, {})
      try {
        operation.signal.throwIfAborted()
        const customRevision = async (file: string, fallback: string): Promise<string> => {
          let source: Buffer
          try {
            source = await readFile(file, { signal: operation.signal })
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            source = Buffer.from(fallback)
          }
          if (source.byteLength > 256 * 1024) throw new HttpError(413, 'payload_too_large')
          return createHash('sha256').update(source).digest('hex')
        }
        const [scriptRevision, styleRevision] = await Promise.all([
          customRevision(this.config.customScriptFile, CUSTOM_SCRIPT_FALLBACK),
          customRevision(this.config.customCssFile, CUSTOM_STYLE_FALLBACK),
        ])
        const body = Buffer.from(JSON.stringify({
          protocol: 1,
          extensions: extensions.manifest(),
          legacy: { scriptRevision, styleRevision },
        }))
        // The ETag must cover extension content, not just the manifest body, so
        // editing mobile.js/css alone invalidates the client's cached manifest.
        const etag = createHash('sha256').update(body).update(extensions.contentDigest()).digest('hex')
        if (headerValue(request.headers, 'if-none-match') === etag) {
          setSecurityHeaders(response, this.tlsEnabled); response.writeHead(304); response.end(); return
        }
        setSecurityHeaders(response, this.tlsEnabled)
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.byteLength, ETag: etag })
        if (request.method === 'HEAD') response.end(); else response.end(body)
        return
      } finally {
        operation.release()
      }
    }
    if (targetInfo.kind === 'script' || targetInfo.kind === 'style' || targetInfo.kind === 'asset') {
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed')
      const generation = extensionGeneration(new URLSearchParams(target.search).get('generation') ?? undefined)
      const operation = this.allocateRequest(authorization, response, {})
      try {
        const file = targetInfo.kind === 'script'
          ? await extensions.readClientFile(targetInfo.id, 'script', operation.signal, generation)
          : targetInfo.kind === 'style'
            ? await extensions.readClientFile(targetInfo.id, 'style', operation.signal, generation)
            : await extensions.readAsset(targetInfo.id, targetInfo.path ?? '', operation.signal, generation)
        if (headerValue(request.headers, 'if-none-match') === file.digest) {
          setSecurityHeaders(response, this.tlsEnabled); response.writeHead(304); response.end(); return
        }
        const contentType = targetInfo.kind === 'script'
          ? 'text/javascript; charset=utf-8'
          : targetInfo.kind === 'style' ? 'text/css; charset=utf-8' : extensionContentType(targetInfo.path ?? '')
        setSecurityHeaders(response, this.tlsEnabled)
        response.writeHead(200, { 'Content-Type': contentType, 'Content-Length': file.body.byteLength, ETag: file.digest })
        if (request.method === 'HEAD') response.end(); else response.end(file.body)
        return
      } finally {
        operation.release()
      }
    }
    if (targetInfo.kind === 'action') {
      if (request.method !== 'POST') throw new HttpError(405, 'method_not_allowed')
      const maximum = 1024 * 1024
      assertBoundedContentLength(request, maximum)
      const generation = extensionGeneration(headerValue(request.headers, EXTENSION_GENERATION_HEADER))
      const operation = this.allocateRequest(authorization, response, {})
      const abort = new AbortController()
      response.once('close', () => { abort.abort() })
      const generationSignal = extensions.signal(targetInfo.id, generation)
      const onGenerationAbort = (): void => { abort.abort(); if (!response.destroyed) response.destroy() }
      generationSignal?.addEventListener('abort', onGenerationAbort, { once: true })
      try {
        const body = await readJsonObject(request, maximum)
        const result = await extensions.invoke(targetInfo.id, targetInfo.action, body, { signal: abort.signal, deviceId: authorization.deviceId }, generation)
        let serialized: Buffer
        try { serialized = Buffer.from(JSON.stringify(result)) } catch { throw new MobileExtensionError('extension_failed', 'extension action failed', 500) }
        if (serialized.byteLength > 4 * 1024 * 1024) throw new MobileExtensionError('extension_result_too_large', 'extension result is too large', 500)
        sendJson(response, 200, result, this.tlsEnabled)
      } finally {
        generationSignal?.removeEventListener('abort', onGenerationAbort)
        abort.abort(); operation.release()
      }
      return
    }
    if (targetInfo.kind === 'route') {
      const method = request.method ?? 'GET'
      if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new HttpError(405, 'method_not_allowed')
      const hasBody = method !== 'GET' && method !== 'HEAD'
      if (hasBody) assertBoundedContentLength(request, this.config.maxBodyBytes)
      const generation = extensionGeneration(headerValue(request.headers, EXTENSION_GENERATION_HEADER))
      const operation = this.allocateRequest(authorization, response, {})
      const abort = new AbortController()
      response.once('close', () => { abort.abort() })
      const generationSignal = extensions.signal(targetInfo.id, generation)
      const onGenerationAbort = (): void => { abort.abort(); if (!response.destroyed) response.destroy() }
      generationSignal?.addEventListener('abort', onGenerationAbort, { once: true })
      try {
        const body = hasBody ? await readBoundedBody(request, this.config.maxBodyBytes) : Buffer.alloc(0)
        const parsed = new URL(target.raw, this.address().origin)
        const routeRequest: MobileRouteRequest = {
          method, pathname: targetInfo.path, query: parsed.searchParams,
          headers: extensionRequestHeaders(request.headers), body, signal: abort.signal, deviceId: authorization.deviceId,
        }
        const result = await extensions.route(targetInfo.id, method, targetInfo.path, routeRequest, generation)
        await this.sendExtensionResponse(response, result, request.method === 'HEAD')
      } finally {
        generationSignal?.removeEventListener('abort', onGenerationAbort)
        abort.abort(); operation.release()
      }
    }
  }

  private async sendExtensionResponse(response: ServerResponse, result: MobileRouteResponse, head: boolean): Promise<void> {
    const status = result.status ?? 200
    if (!Number.isSafeInteger(status) || status < 200 || status > 599) {
      throw new MobileExtensionError('invalid_route_response', 'extension returned an invalid HTTP status', 500)
    }
    const contentType = result.contentType ?? 'application/octet-stream'
    if (contentType.length > 1024
      || !/^[\x20-\x7e]+$/u.test(contentType)
      || !/^[\w!#$&+.^-]+\/[\w!#$&+.^-]+(?:;[\x20-\x7e]*)?$/u.test(contentType)) {
      throw new MobileExtensionError('invalid_route_response', 'extension returned an invalid content type', 500)
    }
    const safeHeaders: Record<string, string> = {}
    for (const [name, value] of Object.entries(result.headers ?? {})) {
      if (!/^(?:content-disposition|cache-control|etag)$/iu.test(name) || /[\r\n]/u.test(value)) continue
      safeHeaders[name] = value
    }
    setSecurityHeaders(response, this.tlsEnabled)
    if (typeof result.body === 'string' || result.body instanceof Uint8Array) {
      const body = typeof result.body === 'string' ? Buffer.from(result.body) : Buffer.from(result.body)
      if (body.byteLength > 4 * 1024 * 1024) throw new MobileExtensionError('extension_result_too_large', 'extension response is too large', 500)
      response.writeHead(status, { ...safeHeaders, 'Content-Type': contentType, 'Content-Length': body.byteLength })
      if (head) response.end(); else response.end(body)
      return
    }
    response.writeHead(status, { ...safeHeaders, 'Content-Type': contentType })
    if (head) { result.body.destroy(); response.end(); return }
    await pipeline(result.body, new ByteLimitTransform(4 * 1024 * 1024), response)
  }

  /** Exchange DSH's process-local launch token for an authority-bound cookie kept inside this gateway. */
  private async upstreamCookieHeader(): Promise<string | undefined> {
    if (this.upstreamAuthenticatedUrl === undefined) return undefined
    if (this.upstreamCookie !== undefined
      && this.upstreamCookieExpiresAt > Date.now() + UPSTREAM_AUTH_REFRESH_MARGIN_MS) {
      return this.upstreamCookie
    }
    if (this.upstreamCookieTask !== undefined) return this.upstreamCookieTask
    const task = this.exchangeUpstreamCookie()
    this.upstreamCookieTask = task
    try {
      return await task
    } finally {
      if (this.upstreamCookieTask === task) this.upstreamCookieTask = undefined
    }
  }

  private async exchangeUpstreamCookie(): Promise<string> {
    const authenticatedUrl = this.upstreamAuthenticatedUrl
    if (authenticatedUrl === undefined) throw new HttpError(502, 'upstream_unavailable')
    let target: URL
    try {
      target = new URL(authenticatedUrl)
    } catch {
      throw new HttpError(502, 'upstream_unavailable')
    }
    if (target.origin !== this.config.upstreamOrigin.origin || target.pathname !== '/'
      || target.hash !== '' || target.search === '') {
      throw new HttpError(502, 'upstream_unavailable')
    }
    try {
      const proxied = await new Promise<IncomingMessage>((resolve, reject) => {
        const upstreamRequest = requestHttp({
          protocol: 'http:',
          hostname: stripIpv6Brackets(this.config.upstreamOrigin.hostname),
          port: Number(this.config.upstreamOrigin.port),
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          headers: {
            host: this.config.upstreamOrigin.host,
            accept: 'text/html',
            'accept-encoding': 'identity',
          },
          agent: false,
        })
        this.upstreamAuthRequest = upstreamRequest
        upstreamRequest.setTimeout(this.config.upstreamTimeoutMs, () => {
          upstreamRequest.destroy(new Error('upstream timeout'))
        })
        upstreamRequest.once('response', resolve)
        upstreamRequest.once('error', reject)
        upstreamRequest.end()
      })
      await new Promise<void>((resolve, reject) => {
        proxied.once('end', resolve)
        proxied.once('error', reject)
        proxied.resume()
      })
      const setCookie = proxied.headers['set-cookie']?.[0]
      const pair = setCookie?.split(';', 1)[0]
      const maxAgeText = setCookie === undefined
        ? undefined
        : /(?:^|;\s*)Max-Age=(\d+)(?:;|$)/iu.exec(setCookie)?.[1]
      const maxAgeSeconds = maxAgeText === undefined ? Number.NaN : Number(maxAgeText)
      const expiresAt = Date.now() + maxAgeSeconds * 1000
      if (proxied.statusCode !== 303 || pair === undefined || pair.length > 4096
        || !UPSTREAM_COOKIE_PAIR.test(pair) || !Number.isSafeInteger(expiresAt)
        || maxAgeSeconds <= 0) {
        throw new HttpError(502, 'upstream_unavailable')
      }
      this.upstreamCookie = pair
      this.upstreamCookieExpiresAt = expiresAt
      return pair
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(502, 'upstream_unavailable')
    } finally {
      this.upstreamAuthRequest?.destroy()
      this.upstreamAuthRequest = undefined
    }
  }

  private async proxyMobileIndex(
    request: IncomingMessage,
    response: ServerResponse,
    authorization: SessionAuthorization,
  ): Promise<void> {
    const holder: { request?: ClientRequest } = {}
    const operation = this.allocateRequest(authorization, response, holder)
    try {
      const upstreamHeaders = sanitizeRequestHeaders(request, this.config.upstreamOrigin)
      const upstreamCookie = await this.upstreamCookieHeader()
      if (upstreamCookie !== undefined) upstreamHeaders.cookie = upstreamCookie
      upstreamHeaders['accept-encoding'] = 'identity'
      const proxied = await new Promise<IncomingMessage>((resolve, reject) => {
        const upstreamRequest = requestHttp({
          protocol: 'http:',
          hostname: stripIpv6Brackets(this.config.upstreamOrigin.hostname),
          port: Number(this.config.upstreamOrigin.port),
          method: 'GET',
          path: '/',
          headers: upstreamHeaders,
          agent: false,
        })
        holder.request = upstreamRequest
        upstreamRequest.setTimeout(this.config.upstreamTimeoutMs, () => {
          upstreamRequest.destroy(new Error('upstream timeout'))
        })
        upstreamRequest.once('response', resolve)
        upstreamRequest.once('error', reject)
        upstreamRequest.end()
      })
      if ((proxied.statusCode ?? 502) !== 200) throw new HttpError(502, 'upstream_unavailable')
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of proxied) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.byteLength
        if (bytes > 4 * 1024 * 1024) throw new HttpError(502, 'upstream_unavailable')
        chunks.push(buffer)
      }
      let body: Buffer
      try {
        const rewritten = rewriteMobileIndexWithBatch(Buffer.concat(chunks).toString('utf8'))
        if (rewritten.batch !== undefined) this.rememberMobileBootBatch(rewritten.batch)
        body = Buffer.from(rewritten.html)
      } catch {
        throw new HttpError(502, 'upstream_unavailable')
      }
      const headers = sanitizeResponseHeaders(proxied.headers, this.config.upstreamOrigin)
      delete headers['content-length']
      delete headers['content-encoding']
      delete headers.etag
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(200, {
        ...headers,
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.byteLength,
      })
      response.end(body)
    } catch (error) {
      holder.request?.destroy()
      if (error instanceof HttpError) throw error
      if (response.headersSent) response.destroy()
      else throw new HttpError(502, 'upstream_unavailable')
    } finally {
      operation.release()
    }
  }

  private rememberMobileBootBatch(plan: MobileBootBatchPlan): void {
    const existing = this.mobileBootBatches.get(plan.key)
    this.mobileBootBatches.delete(plan.key)
    this.mobileBootBatches.set(plan.key, existing ?? { plan })
    while (this.mobileBootBatches.size > MAX_MOBILE_BOOT_BATCHES) {
      const oldest = this.mobileBootBatches.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.mobileBootBatches.get(oldest)?.assembly?.controller.abort()
      this.mobileBootBatches.delete(oldest)
    }
  }

  private async serveMobileBootBatch(
    key: string,
    request: IncomingMessage,
    response: ServerResponse,
    authorization: SessionAuthorization,
  ): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed')
    const stored = this.mobileBootBatches.get(key)
    if (stored === undefined) throw new HttpError(404, 'not_found')
    const operation = this.allocateRequest(authorization, response, {})
    response.once('close', operation.abort)
    try {
      const layoutStat = await stat(this.config.mobileLayoutFile)
      if (stored.body === undefined || stored.etag === undefined || stored.layoutMtimeMs !== layoutStat.mtimeMs) {
        operation.signal.throwIfAborted()
        const assembly = stored.assembly ?? this.startMobileBootBatchAssembly(stored, layoutStat.mtimeMs)
        await waitForRequestTask(assembly.task, operation.signal)
      }
      const compressed = acceptsGzip(request.headers['accept-encoding'])
      // The assembly above assigns stored.body; TypeScript cannot narrow a
      // property written inside an awaited closure, so read it once here.
      const assembled = stored.body
      if (assembled === undefined) throw new HttpError(502, 'upstream_unavailable')
      const body = compressed
        ? stored.gzipBody ??= await gzipBuffer(assembled)
        : assembled
      const etag = compressed ? `${stored.etag}-gzip` : stored.etag
      const headers: OutgoingHttpHeaders = {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': body.byteLength,
        'Cache-Control': 'private, no-cache',
        ETag: etag,
      }
      if (compressed) headers['Content-Encoding'] = 'gzip'
      addVaryAcceptEncoding(headers)
      if (headerValue(request.headers, 'if-none-match') === etag) {
        setSecurityHeaders(response, this.tlsEnabled)
        response.writeHead(304, { ETag: etag, 'Cache-Control': 'private, no-cache', Vary: String(headers.vary) })
        response.end()
        return
      }
      setSecurityHeaders(response, this.tlsEnabled)
      response.writeHead(200, headers)
      if (request.method === 'HEAD') response.end()
      else response.end(body)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(503, 'mobile_frontend_unavailable')
      throw error
    } finally {
      response.removeListener('close', operation.abort)
      operation.release()
    }
  }

  private startMobileBootBatchAssembly(stored: StoredMobileBootBatch, layoutMtimeMs: number): MobileBootBatchAssembly {
    const controller = new AbortController()
    const task = (async (): Promise<Buffer> => {
      const body = await this.assembleMobileBootBatch(stored.plan, controller.signal)
      stored.body = body
      delete stored.gzipBody
      stored.etag = createHash('sha256').update(body).digest('hex')
      stored.layoutMtimeMs = layoutMtimeMs
      return body
    })()
    const assembly = Object.freeze({ controller, task })
    stored.assembly = assembly
    void task.then(
      () => { if (stored.assembly === assembly) delete stored.assembly },
      () => { if (stored.assembly === assembly) delete stored.assembly },
    )
    return assembly
  }

  private async assembleMobileBootBatch(plan: MobileBootBatchPlan, signal: AbortSignal): Promise<Buffer> {
    const bodies = new Array<Buffer>(plan.entries.length)
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < plan.entries.length) {
        const index = cursor++
        const entry = plan.entries[index]!
        bodies[index] = entry.id === MOBILE_LAYOUT_MODULE
          ? await readFile(this.config.mobileLayoutFile, { signal })
          : await this.readUpstreamClientBundleWithRetry(entry.url, signal)
        if (bodies[index]!.byteLength > MAX_MOBILE_BOOT_ENTRY_BYTES) throw new HttpError(502, 'upstream_unavailable')
      }
    }
    // Three workers keep the fan-out gentle: the upstream resets a fraction of
    // connections when this many entries are pulled at once, and every reset
    // used to fail the whole batch.
    await Promise.all(Array.from({ length: Math.min(3, plan.entries.length) }, worker))
    const total = bodies.reduce((bytes, body) => bytes + body.byteLength + 2, 0)
    if (total > MAX_MOBILE_BOOT_BATCH_BYTES) throw new HttpError(502, 'upstream_unavailable')
    return Buffer.concat(bodies.flatMap(body => [body, Buffer.from('\n;\n')]))
  }

  /**
   * Read one upstream bundle, retrying transient connection failures.
   *
   * Assembling a batch fans out over every client entry, and the upstream
   * resets a fraction of those connections before sending a byte
   * (`read ECONNRESET`, recv=0) — randomly, on any entry, at any concurrency.
   * A single such reset used to fail the whole batch with 502
   * `upstream_unavailable`, surfacing in the browser as "bundle script
   * /mobile-access/mobile-boot/<hash>.js failed to load". Retrying recovers
   * every observed reset; a genuine upstream error still fails.
   */
  private async readUpstreamClientBundleWithRetry(source: string, signal: AbortSignal): Promise<Buffer> {
    for (let attempt = 1; attempt <= MOBILE_BOOT_UPSTREAM_ATTEMPTS; attempt++) {
      signal.throwIfAborted()
      try {
        return await this.readUpstreamClientBundle(source, signal)
      } catch (error) {
        if (signal.aborted) throw error
        if (!isTransientUpstreamError(error)) throw error
        if (attempt === MOBILE_BOOT_UPSTREAM_ATTEMPTS) throw new HttpError(502, 'upstream_unavailable')
        await waitForAbortableDelay(MOBILE_BOOT_RETRY_DELAY_MS * attempt, signal)
      }
    }
    throw new HttpError(502, 'upstream_unavailable')
  }

  private async readUpstreamClientBundle(source: string, signal: AbortSignal): Promise<Buffer> {
    signal.throwIfAborted()
    if (!source.startsWith('/plugins/') || source.includes('#')) throw new HttpError(502, 'upstream_unavailable')
    const target = new URL(source, this.config.upstreamOrigin)
    if (target.origin !== this.config.upstreamOrigin.origin) throw new HttpError(502, 'upstream_unavailable')
    let upstreamRequest: ClientRequest | undefined
    const aborted = (): void => { upstreamRequest?.destroy(new Error('request aborted')) }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      const upstreamCookie = await this.upstreamCookieHeader()
      signal.throwIfAborted()
      const proxied = await new Promise<IncomingMessage>((resolve, reject) => {
        upstreamRequest = requestHttp({
          protocol: 'http:',
          hostname: stripIpv6Brackets(this.config.upstreamOrigin.hostname),
          port: Number(this.config.upstreamOrigin.port),
          method: 'GET',
          path: `${target.pathname}${target.search}`,
          headers: {
            host: this.config.upstreamOrigin.host,
            accept: 'text/javascript',
            'accept-encoding': 'identity',
            ...(upstreamCookie === undefined ? {} : { cookie: upstreamCookie }),
          },
          agent: false,
        })
        upstreamRequest.setTimeout(this.config.upstreamTimeoutMs, () => {
          upstreamRequest?.destroy(upstreamTimeoutError())
        })
        upstreamRequest.once('response', resolve)
        upstreamRequest.once('error', reject)
        upstreamRequest.end()
      })
      if ((proxied.statusCode ?? 502) !== 200) throw new HttpError(502, 'upstream_unavailable')
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of proxied) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.byteLength
        if (bytes > MAX_MOBILE_BOOT_ENTRY_BYTES) throw new HttpError(502, 'upstream_unavailable')
        chunks.push(buffer)
      }
      return Buffer.concat(chunks)
    } catch (error) {
      if (error instanceof HttpError) throw error
      if (signal.aborted || isTransientUpstreamError(error)) throw error
      throw new HttpError(502, 'upstream_unavailable')
    } finally {
      signal.removeEventListener('abort', aborted)
      upstreamRequest?.destroy()
    }
  }

  private allocateRequest(
    authorization: SessionAuthorization,
    response: ServerResponse,
    upstream: { request?: ClientRequest },
  ): { id: number; signal: AbortSignal; abort: () => void; release: () => void } {
    if (this.activeRequests.size >= this.config.maxActiveRequests) throw new HttpError(429, 'busy')
    const id = this.nextOperationId++
    const controller = new AbortController()
    const abort = (): void => {
      controller.abort()
      upstream.request?.destroy()
      if (!response.destroyed) response.destroy()
    }
    const timer = setTimeout(abort, Math.max(1, authorization.expiresAt - Date.now()))
    timer.unref()
    this.activeRequests.set(id, Object.freeze({ ...authorization, abort, timer }))
    return {
      id,
      signal: controller.signal,
      abort,
      release: () => {
        const entry = this.activeRequests.get(id)
        if (entry !== undefined) clearTimeout(entry.timer)
        this.activeRequests.delete(id)
      },
    }
  }

  private async proxyHttp(
    request: IncomingMessage,
    response: ServerResponse,
    authorization: SessionAuthorization,
  ): Promise<void> {
    const declared = request.headers['content-length']
    if (declared !== undefined && (!/^\d+$/u.test(declared) || Number(declared) > this.config.maxBodyBytes)) {
      throw new HttpError(413, 'payload_too_large')
    }
    const holder: { request?: ClientRequest } = {}
    const operation = this.allocateRequest(authorization, response, holder)
    let bodyDone: Promise<void> | undefined
    try {
      const bufferedBody = request.method === 'POST' && request.url?.split('?', 1)[0] === SESSION_HISTORY_PATH
        ? mobileHistoryRequestBody(request, await readBoundedBody(request, this.config.maxBodyBytes))
        : undefined
      const upstreamHeaders = sanitizeRequestHeaders(request, this.config.upstreamOrigin)
      const upstreamCookie = await this.upstreamCookieHeader()
      if (upstreamCookie !== undefined) upstreamHeaders.cookie = upstreamCookie
      if (bufferedBody !== undefined) upstreamHeaders['content-length'] = String(bufferedBody.byteLength)
      const upstreamResponse = new Promise<IncomingMessage>((resolve, reject) => {
        const upstreamRequest = requestHttp({
          protocol: 'http:',
          hostname: stripIpv6Brackets(this.config.upstreamOrigin.hostname),
          port: Number(this.config.upstreamOrigin.port),
          method: request.method,
          path: request.url,
          headers: upstreamHeaders,
          agent: false,
        })
        holder.request = upstreamRequest
        upstreamRequest.setTimeout(this.config.upstreamTimeoutMs, () => {
          upstreamRequest.destroy(new Error('upstream timeout'))
        })
        upstreamRequest.once('response', resolve)
        upstreamRequest.once('error', reject)
        if (bufferedBody === undefined) {
          bodyDone = pipeline(request, new ByteLimitTransform(this.config.maxBodyBytes), upstreamRequest)
        } else {
          upstreamRequest.end(bufferedBody)
          bodyDone = Promise.resolve()
        }
        void bodyDone.catch(reject)
      })
      const proxied = await upstreamResponse
      setSecurityHeaders(response, this.tlsEnabled)
      const headers = sanitizeResponseHeaders(proxied.headers, this.config.upstreamOrigin)
      const cacheControl = revisionedStaticCacheControl(request)
      if (cacheControl !== undefined) headers['cache-control'] = cacheControl
      const compressed = shouldCompressResponse(request, proxied)
      if (compressed) {
        delete headers['accept-ranges']
        delete headers['content-length']
        delete headers.etag
        headers['content-encoding'] = 'gzip'
        addVaryAcceptEncoding(headers)
      }
      response.writeHead(proxied.statusCode ?? 502, headers)
      await Promise.all([
        bodyDone,
        compressed ? pipeline(proxied, createGzip(), response) : pipeline(proxied, response),
      ])
    } catch (error) {
      holder.request?.destroy()
      await bodyDone?.catch(() => undefined)
      if (error instanceof HttpError) throw error
      if (response.headersSent) response.destroy()
      else throw new HttpError(502, 'upstream_unavailable')
    } finally {
      operation.release()
    }
  }

  private abortSessionResources(sessionKey: string): void {
    for (const request of this.activeRequests.values()) {
      if (request.sessionKey === sessionKey) request.abort()
    }
    for (const socket of this.activeWebSockets.values()) {
      if (socket.sessionKey === sessionKey) {
        socket.client.destroy()
        socket.upstream.destroy()
      }
    }
  }

  private broadcastExtensionChange(): void {
    if (this.closing) return
    this.extensionEventRevision += 1
    for (const listener of this.extensionEventListeners) listener(this.extensionEventRevision)
  }

  private pollLegacyCustomChanges(): Promise<void> {
    if (this.extensionChangeTask !== undefined) return this.extensionChangeTask
    const digestFile = async (path: string, fallback: string): Promise<string> => {
      try {
        const info = await stat(path)
        if (!info.isFile() || info.size > 256 * 1024) return `invalid:${String(info.size)}:${String(info.mtimeMs)}`
        return createHash('sha256').update(await readFile(path)).digest('hex')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createHash('sha256').update(fallback).digest('hex')
        return `error:${String((error as NodeJS.ErrnoException).code ?? 'unknown')}`
      }
    }
    const task = Promise.all([
      digestFile(this.config.customScriptFile, CUSTOM_SCRIPT_FALLBACK),
      digestFile(this.config.customCssFile, CUSTOM_STYLE_FALLBACK),
    ]).then(parts => {
      const next = createHash('sha256').update(parts.join('|')).digest('hex')
      if (this.legacyCustomDigest !== '' && next !== this.legacyCustomDigest) this.broadcastExtensionChange()
      this.legacyCustomDigest = next
    }).finally(() => {
      if (this.extensionChangeTask === task) this.extensionChangeTask = undefined
    })
    this.extensionChangeTask = task
    return task
  }

  private openExtensionEventStream(
    request: IncomingMessage,
    response: ServerResponse,
    authorization: SessionAuthorization,
  ): void {
    const operation = this.allocateRequest(authorization, response, {})
    let closed = false
    let heartbeat: NodeJS.Timeout | undefined
    const close = (): void => {
      if (closed) return
      closed = true
      if (heartbeat !== undefined) clearInterval(heartbeat)
      this.extensionEventListeners.delete(send)
      request.removeListener('aborted', close)
      response.removeListener('close', close)
      operation.release()
    }
    const send = (revision: number): void => {
      if (closed || response.destroyed || response.writableEnded) return
      response.write(`id: ${String(revision)}\nevent: extensions-changed\ndata: {\"revision\":${String(revision)}}\n\n`)
    }
    setSecurityHeaders(response, this.tlsEnabled)
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    response.write('retry: 2000\n: ready\n\n')
    this.extensionEventListeners.add(send)
    heartbeat = setInterval(() => {
      if (!closed && !response.destroyed && !response.writableEnded) response.write(': heartbeat\n\n')
    }, EXTENSION_EVENT_HEARTBEAT_MS)
    heartbeat.unref()
    request.once('aborted', close)
    response.once('close', close)
  }

  private async readUpgradeResponse(upstream: Socket, expectedAccept: string): Promise<{ header: string; remainder: Buffer }> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0)
      const failed = (error: Error): void => { cleanup(); reject(error) }
      const closed = (): void => { cleanup(); reject(new Error('upstream closed during WebSocket handshake')) }
      const data = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk])
        const end = buffer.indexOf('\r\n\r\n')
        if (end < 0) {
          if (buffer.length >= MAX_HEADER_BYTES) failed(new Error('upstream WebSocket headers are too large'))
          return
        }
        if (end + 4 > MAX_HEADER_BYTES) {
          failed(new Error('upstream WebSocket headers are too large'))
          return
        }
        cleanup()
        const lines = buffer.subarray(0, end).toString('latin1').split('\r\n')
        if (lines.shift() !== 'HTTP/1.1 101 Switching Protocols') {
          reject(new Error('upstream refused WebSocket upgrade'))
          return
        }
        const selected = new Map<string, string>()
        for (const line of lines) {
          const colon = line.indexOf(':')
          if (colon <= 0) {
            reject(new Error('upstream returned malformed WebSocket headers'))
            return
          }
          const name = line.slice(0, colon).trim().toLowerCase()
          const value = line.slice(colon + 1).trim()
          if (selected.has(name)) {
            reject(new Error('upstream returned duplicate WebSocket headers'))
            return
          }
          selected.set(name, value)
        }
        if (selected.get('upgrade')?.toLowerCase() !== 'websocket'
          || !hasToken(selected.get('connection'), 'upgrade')
          || selected.get('sec-websocket-accept') !== expectedAccept) {
          reject(new Error('upstream returned an invalid WebSocket handshake'))
          return
        }
        const output = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${expectedAccept}`,
        ]
        const protocol = selected.get('sec-websocket-protocol')
        const extensions = selected.get('sec-websocket-extensions')
        if (protocol !== undefined) output.push(`Sec-WebSocket-Protocol: ${protocol}`)
        if (extensions !== undefined) output.push(`Sec-WebSocket-Extensions: ${extensions}`)
        output.push('Referrer-Policy: no-referrer', 'X-Content-Type-Options: nosniff', '', '')
        resolve({ header: output.join('\r\n'), remainder: buffer.subarray(end + 4) })
      }
      const cleanup = (): void => {
        upstream.off('data', data)
        upstream.off('error', failed)
        upstream.off('close', closed)
      }
      upstream.on('data', data)
      upstream.once('error', failed)
      upstream.once('close', closed)
    })
  }

  /** Snapshot of rejected upgrade paths for the approval UI (newest first). */
  blockedUpgradePathReport(): BlockedUpgradePathEntry[] {
    return this.blockedUpgradeLog?.report() ?? []
  }

  private async handleUpgrade(request: IncomingMessage, client: Socket, head: Buffer): Promise<void> {
    const target = parseRequestTarget(request.url)
    const policy = this.requirePolicy()
    // Android WebView WebSockets do not consistently carry Fetch Metadata.
    // Exact Origin, direct CIDR, exact Host, and the short Session Cookie
    // remain mandatory; when Sec-Fetch-Site is present, assertExternalTrust
    // still requires it to be same-origin.
    assertExternalTrust(request, policy, false)
    if (!policy.acceptsOrigin(request.headers.origin)) throw new HttpError(403, 'forbidden')
    // Core DSH paths plus admin-approved third-party plugin paths (exact
    // pathname match; the query string rides along to the upstream plugin,
    // which owns its parsing). Everything else stays 404: paired-device
    // auth, Origin, and handshake checks below still apply to allowed paths.
    const upgradeAllowed = WS_PATHS.has(target.decodedPathname)
      || (this.extraWebSocketPaths?.has(target.decodedPathname) ?? false)
    if (!upgradeAllowed) {
      this.blockedUpgradeLog?.record(target.decodedPathname)
      throw new HttpError(404, 'not_found')
    }
    if (request.method !== 'GET' || headerValue(request.headers, 'upgrade')?.toLowerCase() !== 'websocket'
      || !hasToken(headerValue(request.headers, 'connection'), 'upgrade')) {
      throw new HttpError(400, 'bad_request')
    }
    const key = headerValue(request.headers, 'sec-websocket-key')
    if (key === undefined || headerValue(request.headers, 'sec-websocket-version') !== '13') {
      throw new HttpError(400, 'bad_request')
    }
    let decodedKey: Buffer
    try {
      decodedKey = Buffer.from(key, 'base64')
    } catch {
      throw new HttpError(400, 'bad_request')
    }
    if (decodedKey.length !== 16 || decodedKey.toString('base64') !== key) throw new HttpError(400, 'bad_request')
    const authorization = this.authorize(request)
    if (this.activeWebSockets.size >= this.config.maxWebSockets) throw new HttpError(429, 'busy')
    const upstreamCookie = await this.upstreamCookieHeader()

    const upstream = connect({
      host: stripIpv6Brackets(this.config.upstreamOrigin.hostname),
      port: Number(this.config.upstreamOrigin.port),
    })
    client.pause()
    const id = this.nextOperationId++
    const closeBoth = (): void => {
      client.destroy()
      upstream.destroy()
    }
    client.on('error', closeBoth)
    upstream.on('error', closeBoth)
    const timer = setTimeout(closeBoth, Math.max(1, authorization.expiresAt - Date.now()))
    timer.unref()
    const record: ActiveWebSocket = Object.freeze({ ...authorization, client, upstream, timer })
    this.activeWebSockets.set(id, record)
    const cleanup = (): void => {
      const active = this.activeWebSockets.get(id)
      if (active !== undefined) clearTimeout(active.timer)
      this.activeWebSockets.delete(id)
    }
    client.once('close', () => { upstream.destroy(); cleanup() })
    upstream.once('close', () => { client.destroy(); cleanup() })
    upstream.setTimeout(this.config.upstreamTimeoutMs, closeBoth)
    try {
      await new Promise<void>((resolve, reject) => {
        const connected = (): void => {
          upstream.off('error', failed)
          resolve()
        }
        const failed = (error: Error): void => {
          upstream.off('connect', connected)
          reject(error)
        }
        upstream.once('connect', connected)
        upstream.once('error', failed)
      })
      const requestLines = [
        `GET ${target.raw} HTTP/1.1`,
        `Host: ${this.config.upstreamOrigin.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Origin: ${this.config.upstreamOrigin.origin}`,
        'Sec-Fetch-Site: same-origin',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ]
      if (upstreamCookie !== undefined) requestLines.push(`Cookie: ${upstreamCookie}`)
      const protocol = headerValue(request.headers, 'sec-websocket-protocol')
      const extensions = headerValue(request.headers, 'sec-websocket-extensions')
      if (protocol !== undefined) requestLines.push(`Sec-WebSocket-Protocol: ${protocol}`)
      if (extensions !== undefined) requestLines.push(`Sec-WebSocket-Extensions: ${extensions}`)
      requestLines.push('', '')
      upstream.write(requestLines.join('\r\n'))
      if (head.length > 0) upstream.write(head)
      const handshake = await this.readUpgradeResponse(upstream, websocketAccept(key))
      upstream.setTimeout(0)
      client.write(handshake.header)
      if (handshake.remainder.length > 0) client.write(handshake.remainder)
      upstream.pipe(client)
      client.pipe(upstream)
      client.resume()
    } catch (error) {
      closeBoth()
      if (error instanceof HttpError) throw error
      throw new HttpError(502, 'upstream_unavailable')
    }
  }

  /** Loopback-only DSH WebServer route for opening pairing and managing devices. */
  localAdminRoute(prefix: string = LOCAL_ADMIN_PREFIX): WebRoute {
    return {
      kind: 'prefix',
      path: prefix,
      handler: async (request, response) => {
        try {
          const target = parseRequestTarget(request.url)
          const mutation = request.method === 'POST'
          assertLocalAdminTrust(request, mutation)
          if (target.search !== '') throw new HttpError(400, 'bad_request')
          if (request.method === 'GET' && target.decodedPathname === `${prefix}/status`) {
            sendJson(response, 200, {
              gateway: this.address(),
              pairing: this.access.pairingStatus(),
              deviceCount: this.access.listDevices().length,
              resources: {
                connections: this.connectedSockets.size,
                activeRequests: this.activeRequests.size,
                webSockets: this.activeWebSockets.size,
              },
            }, false)
            return
          }
          if (request.method === 'GET' && target.decodedPathname === `${prefix}/devices`) {
            sendJson(response, 200, { devices: this.access.listDevices() }, false)
            return
          }
          if (request.method === 'POST' && target.decodedPathname === `${prefix}/pairing/open`) {
            const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
            if (body.ttlMs !== undefined && typeof body.ttlMs !== 'number') throw new HttpError(400, 'bad_request')
            const opened = await this.access.openPairing(body.ttlMs as number | undefined)
            const pairUrl = `${this.address().origin}/mobile-access/pair#instance=${this.config.instanceId}&token=${opened.token}`
            const appPairUrl = pairUrl
            // The QR code is an enhancement; a failed render must not waste an opened window.
            let qrSvg = ''
            try {
              qrSvg = await QRCode.toString(appPairUrl, { type: 'svg', margin: 1 })
            } catch {
              // keep qrSvg empty
            }
            sendJson(response, 201, {
              ...opened,
              appKey: `dsh1.${this.config.instanceId}.${opened.token}`,
              pairUrl,
              appPairUrl,
              qrSvg,
            }, false)
            return
          }
          if (request.method === 'POST' && target.decodedPathname === `${prefix}/devices/revoke`) {
            const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
            if (typeof body.deviceId !== 'string' || !/^[a-f\d]{32}$/u.test(body.deviceId)) {
              throw new HttpError(400, 'bad_request')
            }
            const revoked = await this.access.revokeDevice(body.deviceId)
            if (!revoked) throw new HttpError(404, 'not_found')
            sendJson(response, 200, { revoked: true }, false)
            return
          }
          if (request.method === 'POST' && target.decodedPathname === `${prefix}/devices/reset`) {
            const body = await readJsonObject(request, MAX_CONTROL_BODY_BYTES)
            if (body.confirm !== true) throw new HttpError(400, 'bad_request')
            await this.access.resetDevices()
            sendJson(response, 200, { reset: true }, false)
            return
          }
          throw new HttpError(404, 'not_found')
        } catch (error) {
          const mapped = mapError(error)
          if (response.headersSent) response.destroy()
          else sendFailure(response, mapped.status, mapped.code, false)
        }
      },
    }
  }

  /** Close listeners and abort all accepted work before resolving teardown. */
  async close(): Promise<void> {
    if (this.closeTask !== undefined) return this.closeTask
    this.closeTask = this.performClose()
    return this.closeTask
  }

  private async performClose(): Promise<void> {
    this.closing = true
    if (this.extensionChangeTimer !== undefined) clearInterval(this.extensionChangeTimer)
    this.extensionChangeTimer = undefined
    this.removeExtensionContentListener()
    this.upstreamAuthRequest?.destroy()
    this.upstreamAuthRequest = undefined
    this.removeSessionListener()
    const accessClose = this.access.close()
    for (const stored of this.mobileBootBatches.values()) stored.assembly?.controller.abort()
    for (const request of this.activeRequests.values()) request.abort()
    for (const websocket of this.activeWebSockets.values()) {
      websocket.client.destroy()
      websocket.upstream.destroy()
    }
    for (const socket of this.connectedSockets) socket.destroy()
    if (this.discoveryTimer !== undefined) clearInterval(this.discoveryTimer)
    this.discoveryTimer = undefined
    await this.closeBonjour()
    const discoverySocket = this.discoverySocket
    this.discoverySocket = undefined
    if (discoverySocket !== undefined) {
      await new Promise<void>(resolve => { discoverySocket.close(() => resolve()) })
    }
    const server = this.server
    this.server = undefined
    if (server !== undefined && server.listening) {
      server.closeAllConnections()
      await new Promise<void>(resolve => { server.close(() => resolve()) })
    }
    await accessClose
    this.activeRequests.clear()
    this.activeWebSockets.clear()
    this.connectedSockets.clear()
    this.policy = undefined
    this.listenerPort = undefined
  }

  /** Safe metadata helper for direct loopback integrations. */
  devices(): readonly DeviceSummary[] {
    return this.access.listDevices()
  }

  /** Status shown by the loopback mobile-access control card. */
  extensionStatus(): { readonly loaded: number; readonly failed: number } {
    return this.extensions?.status() ?? { loaded: 0, failed: 0 }
  }
}
