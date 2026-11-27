import https, { type RequestOptions as HttpsRequestOptions } from 'node:https'
import { lookup as dnsLookup } from 'node:dns/promises'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { LookupFunction } from 'node:net'
import webPush from 'web-push'
import type { RequestOptions as WebPushOptions } from 'web-push'
import { ATTEMPT_TIMEOUT_MS, MAX_PAYLOAD_BYTES, type PushRegistration, type VapidKeys, isPushLocale } from './contracts.js'
import { isLoopbackAddress } from '../network.js'
import { resolveAppleEndpoint, validatePushSubscription, type AppleEndpointResolver } from './endpoint.js'

const MAX_RESPONSE_BYTES = 8192
const MAX_TTL_SECONDS = 1800
const CONTENT_ENCODING = 'aes128gcm'

export type PushSendResult =
  | { readonly kind: 'accepted' | 'gone' | 'suspended' | 'permanent' | 'cancelled' }
  | { readonly kind: 'retry'; readonly retryAfterMs?: number }

interface PushResponse { readonly statusCode: number; readonly headers: IncomingMessage['headers'] }
type RequestFactory = (url: URL, options: HttpsRequestOptions) => ClientRequest

/** Test seam for DNS and the final HTTPS request boundary; production defaults remain fixed and SSRF-checked. */
export interface PushSenderDependencies {
  readonly resolve?: AppleEndpointResolver
  readonly request?: RequestFactory
  /** May only shorten the fixed budget; it cannot extend the production deadline. */
  readonly attemptTimeoutMs?: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validatePayload(payload: unknown): payload is string {
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) return false
  try {
    const parsed: unknown = JSON.parse(payload)
    if (!isObject(parsed) || parsed.web_push !== 8030 || !isObject(parsed.notification)
      || Object.keys(parsed).length !== 2 || Object.keys(parsed.notification).length !== 5) return false
    const notification = parsed.notification
    return typeof notification.title === 'string' && notification.title.length > 0
      && typeof notification.body === 'string' && notification.body.length > 0
      && isPushLocale(notification.lang)
      && typeof notification.navigate === 'string'
      && (notification.navigate === '/' || /^\/\?mobile-push=[A-Za-z0-9_-]{1,256}$/u.test(notification.navigate))
      && typeof notification.tag === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(notification.tag)
  } catch {
    return false
  }
}

function validSubject(subject: unknown, origin: string): string | undefined {
  if (typeof subject !== 'string') return undefined
  const candidate = subject.trim() === '' ? `${origin}/` : subject
  let url: URL
  try { url = new URL(candidate) } catch { return undefined }
  if (url.protocol === 'mailto:') {
    return /^mailto:[^\s/?#@]+@[^\s/?#@]+$/iu.test(candidate) ? candidate : undefined
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') return undefined
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || isLoopbackAddress(hostname)) return undefined
  return candidate
}

function canonicalOrigin(origin: string): string | undefined {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'https:' || url.origin !== origin || url.username !== '' || url.password !== ''
      || url.pathname !== '/' || url.search !== '' || url.hash !== '') return undefined
    return url.origin
  } catch {
    return undefined
  }
}

/**
 * WebKit's declarative push parser resolves `navigate` without any base URL, so the encrypted wire
 * payload must carry an absolute URL. The already-validated relative template is resolved against
 * the canonical registration origin and the serialized copy is budget-checked again because the
 * origin adds bytes the payload template never counted.
 */
function bindNavigationOrigin(payload: string, origin: string): string | undefined {
  let parsed: { web_push?: unknown; notification?: { navigate?: unknown } }
  try { parsed = JSON.parse(payload) } catch { return undefined }
  if (typeof parsed?.notification?.navigate !== 'string') return undefined
  let resolved: URL
  try { resolved = new URL(parsed.notification.navigate, origin) } catch { return undefined }
  if (resolved.origin !== origin) return undefined
  const bound = JSON.stringify({ ...parsed, notification: { ...parsed.notification, navigate: resolved.href } })
  if (Buffer.byteLength(bound, 'utf8') > MAX_PAYLOAD_BYTES) return undefined
  return bound
}

function retryAfterMs(value: string | string[] | undefined, now: number): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  if (!raw) return undefined
  if (/^\d{1,10}$/u.test(raw)) return Number(raw) * 1000
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

function safeStatus(statusCode: number, retryAfter: number | undefined, ttlSeconds: number): PushSendResult {
  if (statusCode >= 200 && statusCode < 300) return { kind: 'accepted' }
  if (statusCode === 404 || statusCode === 410) return { kind: 'gone' }
  if (statusCode === 401 || statusCode === 403) return { kind: 'suspended' }
  if (statusCode === 429) {
    if (retryAfter !== undefined && retryAfter > ttlSeconds * 1000) return { kind: 'permanent' }
    return retryAfter === undefined ? { kind: 'retry' } : { kind: 'retry', retryAfterMs: retryAfter }
  }
  if (statusCode >= 500 && statusCode < 600) return { kind: 'retry' }
  return { kind: 'permanent' }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('push_aborted'))
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('push_aborted'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      value => { signal.removeEventListener('abort', abort); resolve(value) },
      error => { signal.removeEventListener('abort', abort); reject(error) },
    )
  })
}

function responseFromRequest(
  requestFactory: RequestFactory,
  url: URL,
  options: HttpsRequestOptions,
  body: Buffer,
  signal: AbortSignal,
): Promise<PushResponse> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest
    let settled = false
    const finish = (result?: PushResponse, error?: Error): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abortRequest)
      if (error) reject(error)
      else if (result) resolve(result)
    }
    const abortRequest = (): void => {
      request?.destroy(new Error('push_aborted'))
      finish(undefined, new Error('push_aborted'))
    }
    try {
      request = requestFactory(url, options)
      signal.addEventListener('abort', abortRequest, { once: true })
      request.once('error', () => finish(undefined, new Error('push_transport_failed')))
      request.once('response', (response: IncomingMessage) => {
        const statusCode = response.statusCode
        if (typeof statusCode !== 'number') {
          response.destroy()
          request.destroy()
          finish(undefined, new Error('push_transport_failed'))
          return
        }
        if (statusCode >= 300 && statusCode < 400) {
          finish({ statusCode, headers: response.headers })
          response.destroy()
          request.destroy()
          return
        }
        let bytes = 0
        let oversized = false
        response.on('data', (chunk: Buffer | string) => {
          bytes += Buffer.byteLength(chunk)
          if (bytes > MAX_RESPONSE_BYTES && !oversized) {
            oversized = true
            finish({ statusCode, headers: response.headers })
            response.destroy()
            request.destroy()
          }
        })
        response.once('error', () => {
          if (!oversized) finish(undefined, new Error('push_transport_failed'))
        })
        response.once('end', () => finish({ statusCode, headers: response.headers }))
      })
      request.end(body)
    } catch {
      finish(undefined, new Error('push_transport_failed'))
    }
  })
}

function makePinnedLookup(hostname: string, address: { readonly address: string; readonly family: 4 | 6 }): LookupFunction {
  return ((queryHostname: string, options: unknown, callback: (...args: any[]) => void) => {
    if (queryHostname.toLowerCase() !== hostname.toLowerCase()) {
      callback(new Error('push_dns_pin_mismatch'))
      return
    }
    const all = isObject(options) && options.all === true
    if (all) callback(null, [{ address: address.address, family: address.family }])
    else callback(null, address.address, address.family)
  }) as LookupFunction
}

function requestOptions(
  url: URL,
  details: ReturnType<typeof webPush.generateRequestDetails>,
  address: { readonly address: string; readonly family: 4 | 6 },
): HttpsRequestOptions {
  return {
    method: details.method,
    headers: details.headers,
    agent: false,
    servername: url.hostname,
    rejectUnauthorized: true,
    lookup: makePinnedLookup(url.hostname, address),
    timeout: ATTEMPT_TIMEOUT_MS,
  }
}

/** Generate one persistent installation VAPID key pair via the maintained library. */
export function createVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = webPush.generateVAPIDKeys()
  return Object.freeze({ publicKey, privateKey })
}

/** Encrypted, no-redirect HTTPS sender with DNS pinning and one absolute wall-clock budget. */
export class PushSender {
  private readonly resolver: AppleEndpointResolver
  private readonly requestFactory: RequestFactory
  private readonly budgetMs: number

  constructor(dependencies: PushSenderDependencies = {}) {
    this.resolver = dependencies.resolve ?? (async hostname => {
      const resolved = await dnsLookup(hostname, { all: true, verbatim: true })
      return resolved.filter(item => item.family === 4 || item.family === 6) as Array<{ address: string; family: 4 | 6 }>
    })
    this.requestFactory = dependencies.request ?? https.request.bind(https)
    this.budgetMs = Math.max(1, Math.min(ATTEMPT_TIMEOUT_MS, dependencies.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS))
  }

  async send(input: {
    registration: PushRegistration
    payload: string
    ttlSeconds: number
    subject: string
    keys: VapidKeys
    signal: AbortSignal
    beforeRequest?: (signal: AbortSignal) => Promise<boolean>
  }): Promise<PushSendResult> {
    const started = performance.now()
    const controller = new AbortController()
    const callerAbort = () => controller.abort()
    if (input.signal.aborted) controller.abort()
    else input.signal.addEventListener('abort', callerAbort, { once: true })
    const deadline = setTimeout(() => controller.abort(), this.budgetMs)
    try {
      if (controller.signal.aborted) return { kind: 'retry' }
      if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > MAX_TTL_SECONDS
        || !validatePayload(input.payload)) return { kind: 'permanent' }
      const origin = canonicalOrigin(input.registration.origin)
      if (!origin) return { kind: 'permanent' }
      const wirePayload = bindNavigationOrigin(input.payload, origin)
      if (!wirePayload) return { kind: 'permanent' }
      const subject = validSubject(input.subject, origin)
      if (!subject) return { kind: 'permanent' }
      let subscription
      try { subscription = validatePushSubscription(input.registration.subscription) } catch { return { kind: 'permanent' } }
      const resolved = await abortable(
        resolveAppleEndpoint(subscription.endpoint, this.resolver),
        controller.signal,
      )
      if (controller.signal.aborted || performance.now() - started >= this.budgetMs) return { kind: 'retry' }
      const options: WebPushOptions = {
        contentEncoding: CONTENT_ENCODING,
        vapidDetails: { subject, publicKey: input.keys.publicKey, privateKey: input.keys.privateKey },
        TTL: input.ttlSeconds,
        timeout: ATTEMPT_TIMEOUT_MS,
      }
      let details: ReturnType<typeof webPush.generateRequestDetails>
      try { details = webPush.generateRequestDetails(subscription, wirePayload, options) } catch { return { kind: 'permanent' } }
      if (controller.signal.aborted || performance.now() - started >= this.budgetMs) return { kind: 'retry' }
      const requestConfig = requestOptions(resolved.url, details, resolved.addresses[0]!)
      const beforeRequest = input.beforeRequest
      if (beforeRequest !== undefined) {
        if (typeof beforeRequest !== 'function') return { kind: 'cancelled' }
        let permitted: boolean
        try {
          permitted = await abortable(Promise.resolve().then(() => beforeRequest(controller.signal)), controller.signal)
        } catch {
          return { kind: 'cancelled' }
        }
        if (permitted !== true || controller.signal.aborted || performance.now() - started >= this.budgetMs) {
          return { kind: 'cancelled' }
        }
      }
      const response = await abortable(
        responseFromRequest(this.requestFactory, resolved.url, requestConfig, details.body ?? Buffer.alloc(0), controller.signal),
        controller.signal,
      )
      if (controller.signal.aborted || performance.now() - started > this.budgetMs) return { kind: 'retry' }
      const waitMs = retryAfterMs(response.headers['retry-after'], Date.now())
      return safeStatus(response.statusCode, waitMs, input.ttlSeconds)
    } catch (error) {
      if (error instanceof TypeError && error.message === 'push_endpoint_address_rejected') return { kind: 'permanent' }
      if (controller.signal.aborted || performance.now() - started >= this.budgetMs) return { kind: 'retry' }
      return { kind: 'retry' }
    } finally {
      clearTimeout(deadline)
      input.signal.removeEventListener('abort', callerAbort)
    }
  }
}
