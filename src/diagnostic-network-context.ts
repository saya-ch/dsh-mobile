import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Address categories are context, not permission checks or proof of public reachability. */
export type DiagnosticDnsKind = 'public' | 'tailnet' | 'fake-ip' | 'private' | 'mixed' | 'unknown'
export interface DiagnosticDnsContext {
  readonly kind: DiagnosticDnsKind
  readonly family: 'ipv4' | 'ipv6' | 'dual' | 'unknown'
}
export type DiagnosticFailureStage = 'dns' | 'connect' | 'tls' | 'timeout' | 'http' | 'unknown'
export type DiagnosticLookup = (hostname: string) => Promise<readonly { readonly address: string; readonly family: number }[]>

function addressKind(address: string): DiagnosticDnsKind {
  if (isIP(address) === 4) {
    const [first, second] = address.split('.').map(Number)
    if (first === 100 && second! >= 64 && second! <= 127) return 'tailnet'
    if (first === 198 && (second === 18 || second === 19)) return 'fake-ip'
    if (first === 0 || first === 10 || first === 127 || first! >= 224
      || (first === 169 && second === 254) || (first === 172 && second! >= 16 && second! <= 31)
      || (first === 192 && second === 168)) return 'private'
    return 'public'
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase()
    if (lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4) return addressKind(lower.slice(7))
    if (lower.startsWith('fd7a:115c:a1e0:')) return 'tailnet'
    if (lower === '::' || lower === '::1' || /^(?:f[cd]|fe[89ab]|ff)/u.test(lower)) return 'private'
    return 'public'
  }
  return 'unknown'
}

/**
 * Collapse system resolver results into non-identifying categories, without retaining addresses.
 * @param addresses - Addresses supplied by the system resolver.
 * @returns Address category and observed IP families; mixed answers are not treated as tailnet-only.
 */
export function classifyDiagnosticDns(addresses: readonly { readonly address: string; readonly family: number }[]): DiagnosticDnsContext {
  const kinds = new Set(addresses.map(entry => addressKind(entry.address)))
  const families = new Set(addresses.map(entry => isIP(entry.address)).filter(value => value !== 0))
  return {
    kind: kinds.size === 0 ? 'unknown' : kinds.size === 1 ? [...kinds][0]! : 'mixed',
    family: families.size === 0 ? 'unknown' : families.size > 1 ? 'dual' : families.has(4) ? 'ipv4' : 'ipv6',
  }
}

/**
 * Read bounded system-DNS context; never consult an external DNS service or modify settings.
 * @param hostname - The configured endpoint's hostname.
 * @param budgetMs - Maximum wait; OS lookup completion itself cannot be cancelled.
 * @param resolve - System lookup or an instance-local controlled fixture.
 * @returns Unknown on failure/deadline, not a conclusion that DNS or the public service is down.
 */
export async function probeDiagnosticDns(hostname: string, budgetMs: number, resolve: DiagnosticLookup = host => lookup(host, { all: true })): Promise<DiagnosticDnsContext> {
  let timer: NodeJS.Timeout | undefined
  try {
    const addresses = await Promise.race([
      resolve(hostname),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('dns_context_timeout')), Math.max(1, budgetMs)); timer.unref() }),
    ])
    return classifyDiagnosticDns(addresses)
  } catch {
    return { kind: 'unknown', family: 'unknown' }
  } finally { clearTimeout(timer) }
}

/**
 * Classify fixed transport machine codes without reflecting messages, URLs or nested errors.
 * @param error - A failed endpoint request.
 * @returns The last observed transport stage, or unknown rather than a guessed cause.
 */
export function diagnosticFailureStage(error: unknown): DiagnosticFailureStage {
  let current = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth++) {
    const code = 'code' in current && typeof current.code === 'string' ? current.code : ''
    if ('name' in current && current.name === 'TimeoutError') return 'timeout'
    if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns'
    if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code)) return 'connect'
    if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code)) return 'timeout'
    if (['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_SSL_WRONG_VERSION_NUMBER'].includes(code)) return 'tls'
    current = 'cause' in current ? current.cause : undefined
  }
  return 'unknown'
}
