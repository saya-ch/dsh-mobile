/** Fixed parser details safe to record without Node's raw packet, message or request headers. */
export type HttpParserCode =
  | 'ERR_HTTP_REQUEST_TIMEOUT'
  | 'HPE_HEADER_OVERFLOW'
  | 'HPE_INVALID_METHOD'
  | 'HPE_INVALID_CONSTANT'
  | 'HPE_INVALID_URL'
  | 'HPE_INVALID_VERSION'
  | 'HPE_LF_EXPECTED'
  | 'HPE_PAUSED_H2_UPGRADE'
  | 'HPE_INVALID_CHUNK_SIZE'
  | 'HPE_INVALID_CONTENT_LENGTH'
  | 'HPE_INVALID_EOF_STATE'
  | 'HPE_INVALID_HEADER_TOKEN'
  | 'HPE_INVALID_TRANSFER_ENCODING'
  | 'HPE_UNEXPECTED_CONTENT_LENGTH'
  | 'other'

/** A rejected inbound HTTP message's public response and bounded diagnostic category. */
export interface HttpParserFailure {
  readonly status: 400 | 408 | 431
  readonly code: 'bad_request' | 'request_timeout' | 'headers_too_large'
  readonly parserCode: HttpParserCode
}

/** Socket failures do not establish that an HTTP request was rejected. */
export type HttpTransportCode = 'ECONNRESET' | 'EPIPE' | 'ETIMEDOUT' | 'ERR_STREAM_PREMATURE_CLOSE'

/** Node's clientError event includes transport errors as well as parser failures. */
export type HttpClientFailure =
  | ({ readonly kind: 'parser' } & HttpParserFailure)
  | { readonly kind: 'transport'; readonly code: HttpTransportCode }

/** One sampled rejection. Arbitrary paths, query strings, body data and credentials are excluded. */
export type HttpFailureEntry = (
  | { readonly kind: 'parser'; readonly status: HttpParserFailure['status']; readonly code: HttpParserCode }
  | { readonly kind: 'transport'; readonly code: HttpTransportCode }
  | { readonly kind: 'target'; readonly status: 400; readonly code: 'bad_request' }
  | { readonly kind: 'upstream'; readonly status: number; readonly method: 'POST'; readonly path: '/api/session/prompt' }
) & { readonly suppressed?: number }

function safeParserCode(code: string | undefined): HttpParserCode {
  switch (code) {
    case 'ERR_HTTP_REQUEST_TIMEOUT':
    case 'HPE_HEADER_OVERFLOW':
    case 'HPE_INVALID_METHOD':
    case 'HPE_INVALID_CONSTANT':
    case 'HPE_INVALID_URL':
    case 'HPE_INVALID_VERSION':
    case 'HPE_LF_EXPECTED':
    case 'HPE_PAUSED_H2_UPGRADE':
    case 'HPE_INVALID_CHUNK_SIZE':
    case 'HPE_INVALID_CONTENT_LENGTH':
    case 'HPE_INVALID_EOF_STATE':
    case 'HPE_INVALID_HEADER_TOKEN':
    case 'HPE_INVALID_TRANSFER_ENCODING':
    case 'HPE_UNEXPECTED_CONTENT_LENGTH':
      return code
    default:
      return 'other'
  }
}

/**
 * Classify Node's HTTP rejection without reflecting an unrecognized error code.
 * @param nodeCode - The parser error's machine code, not its message or raw packet.
 * @returns The fixed public HTTP status/category and allowlisted diagnostic code.
 */
export function classifyHttpParserFailure(nodeCode: string | undefined): HttpParserFailure {
  const parserCode = safeParserCode(nodeCode)
  if (parserCode === 'ERR_HTTP_REQUEST_TIMEOUT') return { status: 408, code: 'request_timeout', parserCode }
  if (parserCode === 'HPE_HEADER_OVERFLOW') return { status: 431, code: 'headers_too_large', parserCode }
  return { status: 400, code: 'bad_request', parserCode }
}

interface FailureWindow { nextLogAt: number; suppressed: number }
const LOG_INTERVAL_MS = 30_000

/**
 * Per-Gateway diagnostics with four fixed sampling slots and no timers or request-selected keys.
 * Each kind records once immediately, then at most once per 30 seconds with suppressed counts.
 * A sink failure cannot change a response, retry a write or expose the diagnostic sink's error.
 */
export class HttpFailureRecorder {
  private readonly windows: Record<HttpFailureEntry['kind'], FailureWindow> = {
    parser: { nextLogAt: 0, suppressed: 0 },
    transport: { nextLogAt: 0, suppressed: 0 },
    target: { nextLogAt: 0, suppressed: 0 },
    upstream: { nextLogAt: 0, suppressed: 0 },
  }
  private observerFailureReported = false

  constructor(
    private readonly observe: ((entry: HttpFailureEntry) => void) | undefined,
    private readonly now: () => number = () => performance.now(),
    private readonly reportObserverFailure: () => void = () => {
      process.emitWarning('Mobile access HTTP diagnostics could not be recorded', { code: 'DSH_MOBILE_HTTP_LOG_FAILED' })
    },
  ) {}

  /** Classify an inbound parser rejection and sample only its fixed status and safe code. */
  recordParser(nodeCode: string | undefined): HttpParserFailure {
    const failure = classifyHttpParserFailure(nodeCode)
    this.record({ kind: 'parser', status: failure.status, code: failure.parserCode })
    return failure
  }

  /** Classify a client socket error without assigning an HTTP status to a transport failure. */
  recordClientError(nodeCode: string | undefined): HttpClientFailure {
    switch (nodeCode) {
      case 'ECONNRESET':
      case 'EPIPE':
      case 'ETIMEDOUT':
      case 'ERR_STREAM_PREMATURE_CLOSE': {
        const failure = { kind: 'transport', code: nodeCode } as const
        this.record(failure)
        return failure
      }
      default:
        return { kind: 'parser', ...this.recordParser(nodeCode) }
    }
  }

  /** Sample an invalid request target without retaining its raw or decoded URL. */
  recordTarget(): void {
    this.record({ kind: 'target', status: 400, code: 'bad_request' })
  }

  /** Sample only authenticated prompt rejections; the caller must authorize before forwarding. */
  recordUpstream(method: string | undefined, pathname: string, status: number): void {
    if (method !== 'POST' || pathname !== '/api/session/prompt'
      || !Number.isInteger(status) || status < 400 || status > 599) return
    this.record({ kind: 'upstream', status, method: 'POST', path: '/api/session/prompt' })
  }

  private record(entry: HttpFailureEntry): void {
    if (this.observe === undefined) return
    const now = this.now()
    const window = this.windows[entry.kind]
    if (now < window.nextLogAt) {
      window.suppressed = Math.min(Number.MAX_SAFE_INTEGER, window.suppressed + 1)
      return
    }
    const suppressed = window.suppressed
    window.nextLogAt = now + LOG_INTERVAL_MS
    window.suppressed = 0
    try {
      this.observe({ ...entry, ...(suppressed === 0 ? {} : { suppressed }) })
    } catch (observerError) {
      void observerError // Diagnostic failure does not replace the owning HTTP result.
      if (this.observerFailureReported) return
      this.observerFailureReported = true
      try { this.reportObserverFailure() }
      catch (reporterError) { void reporterError /* HTTP handling remains independent of diagnostic output. */ }
    }
  }
}
