import { isIP } from 'node:net'

/** A parsed IP network used to authorize directly connected clients. */
export interface ParsedCidr {
  readonly bits: 32 | 128
  readonly network: bigint
  readonly prefix: number
  readonly source: string
}

/** A normalized public authority. A missing port is filled from the bound listener. */
export interface AuthoritySpec {
  readonly hostname: string
  readonly port?: number
}

function parseIpv4(address: string): bigint {
  const parts = address.split('.')
  if (parts.length !== 4) throw new Error(`invalid IPv4 address ${JSON.stringify(address)}`)
  let value = 0n
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) throw new Error(`invalid IPv4 address ${JSON.stringify(address)}`)
    const octet = Number(part)
    if (octet > 255) throw new Error(`invalid IPv4 address ${JSON.stringify(address)}`)
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

function parseIpv6Part(part: string, address: string): number[] {
  if (part.includes('.')) {
    const ipv4 = parseIpv4(part)
    return [Number((ipv4 >> 16n) & 0xffffn), Number(ipv4 & 0xffffn)]
  }
  if (!/^[\da-f]{1,4}$/iu.test(part)) throw new Error(`invalid IPv6 address ${JSON.stringify(address)}`)
  return [Number.parseInt(part, 16)]
}

function parseIpv6(address: string): bigint {
  const withoutZone = address.split('%', 1)[0] ?? address
  if (withoutZone.split('::').length > 2) throw new Error(`invalid IPv6 address ${JSON.stringify(address)}`)
  const [leftText, rightText] = withoutZone.split('::')
  const left = leftText === '' ? [] : leftText!.split(':').flatMap(part => parseIpv6Part(part, address))
  const right = rightText === undefined || rightText === ''
    ? []
    : rightText.split(':').flatMap(part => parseIpv6Part(part, address))
  const omitted = 8 - left.length - right.length
  if (rightText === undefined ? omitted !== 0 : omitted < 1) {
    throw new Error(`invalid IPv6 address ${JSON.stringify(address)}`)
  }
  const groups = [...left, ...Array.from({ length: omitted }, () => 0), ...right]
  if (groups.length !== 8) throw new Error(`invalid IPv6 address ${JSON.stringify(address)}`)
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n)
}

function mappedIpv4(address: string): string | undefined {
  const match = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address)
  return match?.[1]
}

function parseIp(address: string): { bits: 32 | 128; value: bigint } {
  const unwrapped = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address
  const mapped = mappedIpv4(unwrapped)
  if (mapped !== undefined) return { bits: 32, value: parseIpv4(mapped) }
  const version = isIP(unwrapped.split('%', 1)[0] ?? unwrapped)
  if (version === 4) return { bits: 32, value: parseIpv4(unwrapped) }
  if (version === 6) return { bits: 128, value: parseIpv6(unwrapped) }
  throw new Error(`invalid IP address ${JSON.stringify(address)}`)
}

/** Parse and canonicalize one IPv4 or IPv6 CIDR. */
export function parseCidr(source: string): ParsedCidr {
  const slash = source.lastIndexOf('/')
  if (slash <= 0 || slash === source.length - 1) throw new Error(`invalid CIDR ${JSON.stringify(source)}`)
  const address = source.slice(0, slash)
  const parsed = parseIp(address)
  const prefixText = source.slice(slash + 1)
  if (!/^\d{1,3}$/u.test(prefixText)) throw new Error(`invalid CIDR ${JSON.stringify(source)}`)
  const prefix = Number(prefixText)
  if (prefix > parsed.bits) throw new Error(`invalid CIDR ${JSON.stringify(source)}`)
  const hostBits = BigInt(parsed.bits - prefix)
  const mask = hostBits === BigInt(parsed.bits)
    ? 0n
    : ((1n << BigInt(parsed.bits)) - 1n) ^ ((1n << hostBits) - 1n)
  const network = parsed.value & mask
  if (network !== parsed.value) {
    throw new Error(`CIDR ${JSON.stringify(source)} has host bits set`)
  }
  return Object.freeze({ bits: parsed.bits, network, prefix, source })
}

/** Whether a directly connected socket address belongs to at least one allowed CIDR. */
export function addressAllowed(address: string | undefined, cidrs: readonly ParsedCidr[]): boolean {
  if (address === undefined) return false
  let parsed: ReturnType<typeof parseIp>
  try {
    parsed = parseIp(address)
  } catch {
    return false
  }
  return cidrs.some((cidr) => {
    if (cidr.bits !== parsed.bits) return false
    const hostBits = BigInt(cidr.bits - cidr.prefix)
    const mask = hostBits === BigInt(cidr.bits)
      ? 0n
      : ((1n << BigInt(cidr.bits)) - 1n) ^ ((1n << hostBits) - 1n)
    return (parsed.value & mask) === cidr.network
  })
}

/** Whether an IP literal is loopback and therefore eligible for HTTP-only development. */
export function isLoopbackAddress(address: string): boolean {
  try {
    const parsed = parseIp(address)
    if (parsed.bits === 32) return (parsed.value >> 24n) === 127n
    return parsed.value === 1n
  } catch {
    return false
  }
}

/**
 * IPv4 ranges that are never a public VPS endpoint (IANA special-purpose,
 * private, shared, loopback, link-local, documentation, benchmark, multicast,
 * and reserved space). Kept in sync with Android `RemoteHostPolicy`.
 */
const NON_ROUTABLE_IPV4_RANGES: ReadonlyArray<readonly [network: bigint, prefix: number]> = Object.freeze([
  [0x00000000n, 8], // "This network" / software scope
  [0x0a000000n, 8], // Private-Use (RFC 1918)
  [0x64400000n, 10], // Shared address space / CGNAT (RFC 6598)
  [0x7f000000n, 8], // Loopback (RFC 1122)
  [0xa9fe0000n, 16], // Link-local (RFC 3927)
  [0xac100000n, 12], // Private-Use (RFC 1918)
  [0xc0000000n, 24], // IETF protocol assignments (RFC 6890)
  [0xc0000200n, 24], // Documentation TEST-NET-1 (RFC 5737)
  [0xc01fc400n, 24], // AS112-v4 (RFC 7534)
  [0xc034c100n, 24], // AMT relay (RFC 7450)
  [0xc0586300n, 24], // 6to4 relay anycast, deprecated (RFC 7526)
  [0xc0a80000n, 16], // Private-Use (RFC 1918)
  [0xc0af3000n, 24], // Direct delegation AS112 (RFC 7535)
  [0xc6120000n, 15], // Benchmarking (RFC 2544)
  [0xc6336400n, 24], // Documentation TEST-NET-2 (RFC 5737)
  [0xcb007100n, 24], // Documentation TEST-NET-3 (RFC 5737)
  [0xe0000000n, 4], // Multicast (RFC 1112, incl. MCAST-TEST-NET)
  [0xf0000000n, 4], // Reserved for future use + broadcast (RFC 1112)
])

function parseStrictIpv4Octets(address: string): readonly [number, number, number, number] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) return undefined
    const octet = Number(part)
    if (octet > 255) return undefined
    octets.push(octet)
  }
  return octets as [number, number, number, number]
}

/**
 * Whether a dotted-quad IPv4 literal is globally routable and therefore usable
 * as a public VPS / remote HTTPS endpoint. Rejects documentation addresses such
 * as 203.0.113.10 alongside private, shared, and reserved space.
 */
export function isGloballyRoutableIpv4(address: string): boolean {
  const octets = parseStrictIpv4Octets(address)
  if (octets === undefined) return false
  const value = (BigInt(octets[0]) << 24n) | (BigInt(octets[1]) << 16n) | (BigInt(octets[2]) << 8n) | BigInt(octets[3])
  return !NON_ROUTABLE_IPV4_RANGES.some(([network, prefix]) => {
    if (prefix === 0) return true
    const hostBits = BigInt(32 - prefix)
    const mask = ((1n << 32n) - 1n) ^ ((1n << hostBits) - 1n)
    return (value & mask) === network
  })
}

/** Parse a bare host or host:port authority without accepting URL components. */
export function parseAuthority(source: string): AuthoritySpec {
  if (source.trim() !== source || source.length === 0 || /[/?#@\\]/u.test(source)) {
    throw new Error(`invalid public authority ${JSON.stringify(source)}`)
  }
  let url: URL
  try {
    url = new URL(`https://${source}`)
  } catch {
    throw new Error(`invalid public authority ${JSON.stringify(source)}`)
  }
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new Error(`invalid public authority ${JSON.stringify(source)}`)
  }
  const explicitPort = /\]:\d+$/u.test(source) || (!source.startsWith('[') && /:\d+$/u.test(source))
  const hostname = url.hostname.toLowerCase()
  const port = explicitPort ? Number(url.port === '' ? 443 : url.port) : undefined
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`invalid public authority ${JSON.stringify(source)}`)
  }
  return port === undefined ? Object.freeze({ hostname }) : Object.freeze({ hostname, port })
}

function formatHostname(hostname: string): string {
  return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
}

/** Resolve an authority against the actual listener port. */
export function resolveAuthority(spec: AuthoritySpec, listenerPort: number): string {
  return `${formatHostname(spec.hostname)}:${String(spec.port ?? listenerPort)}`
}

/** Exact Host/Origin/CIDR policy for the directly exposed listener. */
export class RequestTrustPolicy {
  readonly authorities: ReadonlySet<string>
  readonly origins: ReadonlySet<string>
  private readonly scheme: 'http' | 'https'

  constructor(
    specs: readonly AuthoritySpec[],
    listenerPort: number,
    readonly cidrs: readonly ParsedCidr[],
    tls: boolean,
  ) {
    this.scheme = tls ? 'https' : 'http'
    this.authorities = new Set(specs.map(spec => resolveAuthority(spec, listenerPort).toLowerCase()))
    this.origins = new Set([...this.authorities].map(
      authority => new URL(`${this.scheme}://${authority}`).origin.toLowerCase(),
    ))
  }

  /** Validate the exact Host header after WHATWG authority normalization. */
  acceptsHost(header: string | undefined): boolean {
    return this.canonicalHost(header) !== undefined
  }

  /** Return the canonical accepted Host authority, otherwise undefined. */
  canonicalHost(header: string | undefined): string | undefined {
    if (header === undefined || /[/?#@\\]/u.test(header)) return undefined
    let normalized: string
    try {
      const parsed = new URL(`${this.scheme}://${header}`)
      if (parsed.pathname !== '/' || parsed.username !== '' || parsed.password !== '') return undefined
      normalized = resolveAuthority({
        hostname: parsed.hostname,
        port: Number(parsed.port || (this.scheme === 'https' ? '443' : '80')),
      }, 80).toLowerCase()
    } catch {
      return undefined
    }
    return this.authorities.has(normalized) ? normalized : undefined
  }

  /** Validate an exact same-scheme browser Origin. */
  acceptsOrigin(header: string | undefined): boolean {
    return this.canonicalOrigin(header) !== undefined
  }

  /** Return the canonical accepted Origin, otherwise undefined. */
  canonicalOrigin(header: string | undefined): string | undefined {
    if (header === undefined) return undefined
    // 微信小程序 wx.connectSocket 会把允许的 Origin 与 undefined 用逗号合并。
    let normalized: string | undefined
    for (const part of header.split(',')) {
      const trimmed = part.trim()
      if (trimmed === 'undefined') continue
      let candidate: string
      try {
        const parsed = new URL(trimmed)
        if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '' || parsed.username !== '' || parsed.password !== '') {
          return undefined
        }
        candidate = parsed.origin.toLowerCase()
      } catch {
        return undefined
      }
      if (!this.origins.has(candidate) || normalized !== undefined) return undefined
      normalized = candidate
    }
    return normalized
  }
}
