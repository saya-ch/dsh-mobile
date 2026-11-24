/** Authority parsing for custom schemes on engines that treat it as an opaque path. */

const RESOURCE_SCHEME = 'dsh-resource:'
const RESOURCE_PROBE = 'dsh-resource://file/probe'

/** The authority (`host[:port]`) as written, because the parser may have discarded it. */
function writtenAuthority(href: string): string | undefined {
  const prefix = `${RESOURCE_SCHEME.slice(0, -1)}://`
  if (!href.startsWith(prefix)) return undefined
  const rest = href.slice(prefix.length)
  const end = rest.search(/[/?#]/u)
  const authority = end === -1 ? rest : rest.slice(0, end)
  return authority === '' ? undefined : authority
}

/** The host part of an authority, matching the lowercase form the parser reports. */
function hostOf(authority: string): string {
  const colon = authority.lastIndexOf(':')
  if (colon === -1) return authority.toLowerCase()
  return /^\d*$/u.test(authority.slice(colon + 1)) ? authority.slice(0, colon).toLowerCase() : authority.toLowerCase()
}

/**
 * Report the authority of a `dsh-resource:` address on engines that parse it as an
 * opaque path, which leaves `hostname` and `host` empty while `protocol` still reads
 * `dsh-resource:`.
 *
 * A client resource record is filed under `new URL(address).hostname`, so an empty
 * hostname files it under protocol `undefined`: the `file` provider is never attached
 * to the record and every preview shows the unavailable-resource notice instead of the
 * file. Desktop engines return `file` for the same address, which is why only phones
 * failed (#415).
 *
 * Only `dsh-resource:` is repaired. Other custom schemes keep the engine's own
 * answer, so no unrelated library changes behaviour. An engine that already reports
 * the authority needs nothing, which also keeps a second installation a no-op.
 */
export function installUrlAuthorityCompatibility(): void {
  if (typeof URL !== 'function') return
  const protocol = Object.getOwnPropertyDescriptor(URL.prototype, 'protocol')?.get
  const href = Object.getOwnPropertyDescriptor(URL.prototype, 'href')?.get
  const hostname = Object.getOwnPropertyDescriptor(URL.prototype, 'hostname')?.get
  const host = Object.getOwnPropertyDescriptor(URL.prototype, 'host')?.get
  if (protocol === undefined || href === undefined || hostname === undefined || host === undefined) return
  const reported = ((): string | undefined => {
    try {
      return hostname.call(new URL(RESOURCE_PROBE))
    } catch {
      return undefined
    }
  })()
  if (reported === undefined || reported !== '') return
  const authority = (instance: URL): string | undefined => {
    if (protocol.call(instance) !== RESOURCE_SCHEME) return undefined
    return writtenAuthority(href.call(instance))
  }
  Object.defineProperty(URL.prototype, 'hostname', {
    configurable: true, enumerable: true,
    // The name must differ from the captured getters: a named function expression binds its own
    // name in scope, so `function hostname` would shadow the native getter and recurse forever.
    get: function resourceHostname(this: URL): string {
      const value = hostname.call(this)
      if (value !== '') return value
      const written = authority(this)
      return written === undefined ? value : hostOf(written)
    },
  })
  Object.defineProperty(URL.prototype, 'host', {
    configurable: true, enumerable: true,
    get: function resourceHost(this: URL): string {
      const value = host.call(this)
      if (value !== '') return value
      const written = authority(this)
      return written === undefined ? value : written.toLowerCase()
    },
  })
}
