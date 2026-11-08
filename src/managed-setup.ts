import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
  randomBytes,
} from 'node:crypto'
import { execFileText as execFile } from './exec-file.js'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { generate } from 'selfsigned'
import { restrictPrivateFile } from './private-file.js'
import { parseCidr } from './network.js'

/** One active private IPv4 address tied to a stable operating-system interface name. */
export interface LanNetwork {
  readonly name: string
  readonly address: string
  readonly cidr: string
}

/** Versioned setup that survives DHCP address changes on the selected interface. */
export interface ManagedSetup {
  readonly version: 2
  readonly networkInterface: string
  readonly listenPort: number
  /** Legacy setup snapshot retained for file compatibility; the active WebServer port wins at runtime. */
  readonly upstreamOrigin: string
  /** Additional admin-selected source networks; the active LAN subnet remains trusted. */
  readonly extraAllowedCidrs?: readonly string[]
  readonly tls: {
    readonly mode: 'managed'
    readonly caCertFile: string
    readonly caKeyFile: string
    readonly certFile: string
    readonly keyFile: string
  }
}

type InterfaceTable = NodeJS.Dict<NetworkInterfaceInfo[]>
type RouteCommand = (file: string, args: readonly string[]) => Promise<string>

const VIRTUAL_INTERFACE_MARKERS = [
  'bridge', 'docker', 'hyper-v', 'mihomo', 'radmin', 'tailscale', 'tap', 'tun',
  'utun', 'vbox', 'veth', 'virtual', 'vmware', 'vpn', 'vethernet', 'wsl', 'zerotier',
]

/** Route inspection is advisory; never let a system command hold setup open indefinitely. */
const ROUTE_COMMAND_TIMEOUT_MS = 5_000

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

/** Validate the durable managed setup before it controls network and filesystem operations. */
export function parseManagedSetup(value: unknown): ManagedSetup {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('mobile setup file must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.version !== 2 || Reflect.ownKeys(record)
    .some(key => typeof key !== 'string' || !['version', 'networkInterface', 'listenPort', 'upstreamOrigin', 'tls', 'extraAllowedCidrs'].includes(key))) {
    throw new Error('mobile setup file has an unsupported format')
  }
  if (!Number.isSafeInteger(record.listenPort) || (record.listenPort as number) < 1024
    || (record.listenPort as number) > 65535) {
    throw new Error('mobile setup listenPort must be from 1024 through 65535')
  }
  if (typeof record.tls !== 'object' || record.tls === null || Array.isArray(record.tls)) {
    throw new Error('mobile setup tls must be an object')
  }
  const tls = record.tls as Record<string, unknown>
  if (tls.mode !== 'managed' || Reflect.ownKeys(tls)
    .some(key => typeof key !== 'string' || !['mode', 'caCertFile', 'caKeyFile', 'certFile', 'keyFile'].includes(key))) {
    throw new Error('mobile setup tls has an unsupported format')
  }
  return Object.freeze({
    version: 2,
    networkInterface: requiredString(record.networkInterface, 'mobile setup networkInterface'),
    listenPort: record.listenPort as number,
    upstreamOrigin: requiredString(record.upstreamOrigin, 'mobile setup upstreamOrigin'),
    ...(record.extraAllowedCidrs === undefined ? {} : { extraAllowedCidrs: parseAdditionalTrustedNetworks(record.extraAllowedCidrs) }),
    tls: Object.freeze({
      mode: 'managed',
      caCertFile: requiredString(tls.caCertFile, 'mobile setup tls.caCertFile'),
      caKeyFile: requiredString(tls.caKeyFile, 'mobile setup tls.caKeyFile'),
      certFile: requiredString(tls.certFile, 'mobile setup tls.certFile'),
      keyFile: requiredString(tls.keyFile, 'mobile setup tls.keyFile'),
    }),
  })
}

/** Validate explicitly trusted networks without adding implicit VPN or private ranges.
 * @param value - CIDR strings submitted by the computer administrator.
 * @returns Deduplicated validated CIDRs in input order.
 */
export function parseAdditionalTrustedNetworks(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error('extraAllowedCidrs must be an array of CIDR strings')
  }
  const sources = value.map((entry: unknown): string => {
    if (typeof entry !== 'string' || entry.trim() === '') throw new Error('extraAllowedCidrs must be an array of CIDR strings')
    return entry.trim()
  })
  const entries: string[] = []
  const seen = new Set<string>()
  for (const cidr of sources) {
    const parsed = parseCidr(cidr)
    const key = `${parsed.bits}:${parsed.network}:${parsed.prefix}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(cidr)
  }
  return Object.freeze(entries)
}

/**
 * Refresh the legacy `upstreamOrigin` snapshot to the DSH port actually in use.
 *
 * The runtime deliberately follows the WebServer port instead of this field (a Desktop
 * profile can start with `--port 0`), but a stale snapshot is indistinguishable from a
 * stale gateway to whoever reads the file while diagnosing a restart — #273 became a
 * manual edit because of it. Rewriting it keeps the file honest without changing which
 * upstream the gateway uses.
 *
 * @param setupFile - Existing managed setup file.
 * @param setup - The setup as it was read.
 * @param webServerPort - The port the active DSH WebServer bound.
 * @returns Whether the file needed rewriting.
 */
export async function refreshManagedUpstreamOrigin(
  setupFile: string,
  setup: ManagedSetup,
  webServerPort: number,
): Promise<boolean> {
  if (!Number.isInteger(webServerPort) || webServerPort <= 0) return false
  const upstreamOrigin = `http://127.0.0.1:${String(webServerPort)}`
  if (setup.upstreamOrigin === upstreamOrigin) return false
  const next = Object.freeze({ ...setup, upstreamOrigin })
  await atomicWrite(setupFile, `${JSON.stringify(next, null, 2)}\n`)
  return true
}

/** Save extra trusted networks without replacing the interface or pairing identity.
 * @param setupFile - Existing managed setup file.
 * @param values - Explicitly selected additional networks.
 * @returns The saved managed setup.
 */
export async function saveManagedTrustedNetworks(setupFile: string, values: unknown): Promise<ManagedSetup> {
  const extraAllowedCidrs = parseAdditionalTrustedNetworks(values)
  const setup = parseManagedSetup(JSON.parse(await readFile(setupFile, 'utf8')))
  const next = Object.freeze({ ...setup, extraAllowedCidrs })
  await atomicWrite(setupFile, `${JSON.stringify(next, null, 2)}\n`)
  await restrictPrivateFile(setupFile)
  return next
}

/** Persist an existing managed setup without resetting its identity, paths or extra trusted networks. */
export async function saveManagedSetup(setupFile: string, setup: ManagedSetup): Promise<void> {
  const validated = parseManagedSetup(setup)
  await atomicWrite(setupFile, `${JSON.stringify(validated, null, 2)}\n`)
}

function privateIpv4(value: string): boolean {
  const parts = value.split('.').map(Number)
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    && (parts[0] === 10
      || (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127)
      || (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31)
      || (parts[0] === 192 && parts[1] === 168))
}

function networkCidr(address: string, cidr: string): string {
  const prefix = Number(cidr.slice(cidr.lastIndexOf('/') + 1))
  const value = address.split('.').reduce((total, part) => ((total << 8) | Number(part)) >>> 0, 0)
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const network = (value & mask) >>> 0
  return `${[24, 16, 8, 0].map(shift => (network >>> shift) & 255).join('.')}/${String(prefix)}`
}

/** List current private IPv4 candidates with their interface identity. */
export function availableLanNetworks(table: InterfaceTable = networkInterfaces()): LanNetwork[] {
  const candidates = Object.entries(table).flatMap(([name, entries]) => (entries ?? [])
    .filter(entry => entry.family === 'IPv4' && !entry.internal && privateIpv4(entry.address) && entry.cidr !== null)
    .map(entry => ({ name, address: entry.address, cidr: networkCidr(entry.address, entry.cidr!) })))
  return [...new Map(candidates.map(entry => [`${entry.name}\0${entry.address}`, entry])).values()]
}

function likelyVirtualInterface(name: string): boolean {
  const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, ' ')
  return VIRTUAL_INTERFACE_MARKERS.some(marker => normalized.includes(marker.replaceAll('-', ' ')))
    || /^(?:br|wg)\d*\b/u.test(normalized)
}

async function runRouteCommand(file: string, args: readonly string[]): Promise<string> {
  const result = await execFile(file, [...args], { encoding: 'utf8', timeout: ROUTE_COMMAND_TIMEOUT_MS })
  return result.stdout
}

function uniqueLines(output: string): string[] {
  return [...new Set(output.split(/\r?\n/gu).map(line => line.trim()).filter(Boolean))]
}

/** Return operating-system default-route interfaces in routing preference order. */
export async function preferredLanInterfaceNames(
  platform: NodeJS.Platform = process.platform,
  run: RouteCommand = runRouteCommand,
): Promise<string[]> {
  try {
    if (platform === 'win32') {
      const script = [
        "$routes = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop",
        "$ranked = $routes | Where-Object { $_.State -eq 'Alive' -and $_.NextHop -ne '0.0.0.0' } | ForEach-Object {",
        '  $route = $_',
        '  $adapter = Get-NetAdapter -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue',
        '  $ip = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction SilentlyContinue',
        "  if ($adapter -and $ip -and $adapter.Status -eq 'Up' -and $adapter.HardwareInterface -eq $true -and $adapter.Virtual -ne $true) {",
        '    [pscustomobject]@{ Name = $route.InterfaceAlias; Metric = [int]$route.RouteMetric + [int]$ip.InterfaceMetric }',
        '  }',
        '}',
        '$ranked | Sort-Object Metric | Select-Object -ExpandProperty Name -Unique',
      ].join('; ')
      return uniqueLines(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]))
    }
    if (platform === 'linux') {
      const routes = uniqueLines(await run('ip', ['-o', '-4', 'route', 'show', 'default']))
        .map(line => ({
          name: /(?:^|\s)dev\s+(\S+)/u.exec(line)?.[1],
          metric: Number(/(?:^|\s)metric\s+(\d+)/u.exec(line)?.[1] ?? 0),
        }))
        .filter((route): route is { name: string; metric: number } => route.name !== undefined
          && !likelyVirtualInterface(route.name))
        .sort((left, right) => left.metric - right.metric)
      return [...new Set(routes.map(route => route.name))]
    }
    if (platform === 'darwin') {
      const name = /^\s*interface:\s*(\S+)\s*$/mu.exec(await run('route', ['-n', 'get', 'default']))?.[1]
      return name === undefined || likelyVirtualInterface(name) ? [] : [name]
    }
  } catch {
    // Route discovery is advisory; deterministic candidate checks below remain the fallback.
  }
  return []
}

/** Select an active LAN, optionally by address or by a previously saved interface name. */
export function selectLanNetwork(
  requestedAddress?: string,
  requestedInterface?: string,
  table?: InterfaceTable,
  preferredInterfaces: readonly string[] = [],
): LanNetwork {
  const candidates = availableLanNetworks(table)
  if (requestedAddress !== undefined) {
    const match = candidates.find(candidate => candidate.address === requestedAddress)
    if (match === undefined) throw new Error(`--address ${requestedAddress} is not an active private LAN address`)
    return match
  }
  if (requestedInterface !== undefined) {
    const matches = candidates.filter(candidate => candidate.name === requestedInterface)
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) {
      throw new Error(`saved LAN interface ${JSON.stringify(requestedInterface)} is not connected`)
    }
    throw new Error(`saved LAN interface ${JSON.stringify(requestedInterface)} has more than one private IPv4 address`)
  }
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length === 0) throw new Error('no active private LAN address was found; connect to Wi-Fi or Ethernet')
  for (const name of preferredInterfaces) {
    const matches = candidates.filter(candidate => candidate.name === name)
    if (matches.length === 1) return matches[0]!
  }
  const physicalCandidates = candidates.filter(candidate => !likelyVirtualInterface(candidate.name))
  if (physicalCandidates.length === 1) return physicalCandidates[0]!
  throw new Error(`more than one LAN address is active; rerun with --address and one of: ${candidates.map(entry => `${entry.name}=${entry.address}`).join(', ')}`)
}

/**
 * True when the failure came from LAN selection (the configured network is
 * gone, nothing is up, or several are) rather than from config/TLS code.
 * Callers use it to degrade (warn + stay down) instead of failing boot.
 * Pinned to the selectLanNetwork message contract — keep in sync.
 */
export function isNetworkSelectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes('is not connected')
    || message.includes('no active private LAN address was found')
    || message.includes('more than one LAN address is active')
    || message.includes('has more than one private IPv4 address')
    || message.includes('is not an active private LAN address')
}

function assertMatchingCa(certPem: string, keyPem: string): X509Certificate {
  const certificate = new X509Certificate(certPem)
  if (!certificate.ca || certificate.subject !== certificate.issuer
    || !certificate.verify(certificate.publicKey)) {
    throw new Error('managed TLS CA must be a self-signed CA certificate')
  }
  const privatePublic = createPublicKey(createPrivateKey(keyPem)).export({ format: 'der', type: 'spki' })
  const certificatePublic = certificate.publicKey.export({ format: 'der', type: 'spki' })
  if (!privatePublic.equals(certificatePublic)) throw new Error('managed TLS CA certificate and key do not match')
  if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error('managed TLS CA certificate is not currently valid')
  }
  return certificate
}

/** Read an existing managed CA without ever generating a replacement identity. */
export async function readManagedCa(setup: ManagedSetup['tls']): Promise<X509Certificate> {
  const [certPem, keyPem] = await Promise.all([
    readFile(setup.caCertFile, 'utf8'),
    readFile(setup.caKeyFile, 'utf8'),
  ])
  return assertMatchingCa(certPem, keyPem)
}

async function stagePrivateFile(file: string, contents: string | Uint8Array): Promise<string> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${basename(file)}.${randomBytes(12).toString('hex')}.tmp`)
  try {
    await writeFile(temporary, '', { mode: 0o600, flag: 'wx' })
    await restrictPrivateFile(temporary)
    await writeFile(temporary, contents)
    return temporary
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

async function atomicWrite(file: string, contents: string | Uint8Array): Promise<void> {
  const temporary = await stagePrivateFile(file, contents)
  try {
    await rename(temporary, file)
    await restrictPrivateFile(file)
  } finally { await rm(temporary, { force: true }) }
}

const certificatePublications = new Map<string, Promise<void>>()

/** Stage both files before promotion and retain a private rollback copy until the pair is installed. */
async function installServerCertificatePair(output: ServerCertificateFiles, cert: string, key: string): Promise<void> {
  const identity = `${output.certFile}\0${output.keyFile}`
  const previous = certificatePublications.get(identity) ?? Promise.resolve()
  const publication = previous.catch(() => undefined).then(async () => {
    const files = [output.certFile, output.keyFile]
    const contents = [cert, key]
    const staged: string[] = []
    const backups: Array<string | undefined> = []
    let promoted = 0
    let restored = true
    const failures: unknown[] = []
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]!
        staged.push(await stagePrivateFile(file, contents[index]!))
        let old: Buffer | undefined
        try {
          const metadata = await lstat(file)
          if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('managed TLS output is not a regular file')
          old = await readFile(file)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        backups.push(old === undefined ? undefined : await stagePrivateFile(file, old))
      }
      for (let index = 0; index < files.length; index += 1) {
        await rename(staged[index]!, files[index]!)
        promoted += 1
      }
    } catch (error) {
      failures.push(error)
      for (let index = promoted - 1; index >= 0; index -= 1) {
        try {
          const backup = backups[index]
          if (backup === undefined) await rm(files[index]!, { force: true })
          else await rename(backup, files[index]!)
        } catch (restoreError) { restored = false; failures.push(restoreError) }
      }
    } finally {
      const cleanup = await Promise.allSettled(staged.map(file => rm(file, { force: true })))
      for (const result of cleanup) if (result.status === 'rejected') failures.push(result.reason)
      // Failed rollback copies stay private on disk for manual recovery.
      if (restored) {
        const backupCleanup = await Promise.allSettled(backups.filter((file): file is string => file !== undefined).map(file => rm(file, { force: true })))
        for (const result of backupCleanup) if (result.status === 'rejected') failures.push(result.reason)
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, 'managed TLS certificate replacement, rollback or cleanup failed')
    if (failures.length === 1) throw failures[0]
  })
  certificatePublications.set(identity, publication)
  try { await publication } finally { if (certificatePublications.get(identity) === publication) certificatePublications.delete(identity) }
}

/** Create a long-lived CA or migrate the legacy self-signed server certificate as that CA. */
export async function ensureManagedCa(
  setup: ManagedSetup['tls'],
  legacy?: { readonly certFile: string; readonly keyFile: string },
): Promise<X509Certificate> {
  let certPem: string | undefined
  let keyPem: string | undefined
  try {
    [certPem, keyPem] = await Promise.all([readFile(setup.caCertFile, 'utf8'), readFile(setup.caKeyFile, 'utf8')])
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    let migrated = false
    if (legacy !== undefined) {
      try {
        [certPem, keyPem] = await Promise.all([readFile(legacy.certFile, 'utf8'), readFile(legacy.keyFile, 'utf8')])
        assertMatchingCa(certPem, keyPem)
        migrated = true
      } catch (legacyError) {
        if ((legacyError as NodeJS.ErrnoException).code !== 'ENOENT') throw legacyError
      }
    }
    if (!migrated) {
      const now = new Date()
      const notAfter = new Date(now)
      notAfter.setFullYear(notAfter.getFullYear() + 5)
      const generated = await generate([{ name: 'commonName', value: 'DeepSeek Harness Mobile CA' }], {
        keyType: 'ec',
        curve: 'P-256',
        algorithm: 'sha256',
        notBeforeDate: new Date(now.getTime() - 5 * 60_000),
        notAfterDate: notAfter,
        extensions: [
          { name: 'basicConstraints', cA: true, critical: true },
          { name: 'keyUsage', digitalSignature: true, keyCertSign: true, cRLSign: true, critical: true },
        ],
      })
      certPem = generated.cert
      keyPem = generated.private
    }
    if (certPem === undefined || keyPem === undefined) throw new Error('managed TLS CA creation did not produce key material')
    await Promise.all([atomicWrite(setup.caCertFile, certPem), atomicWrite(setup.caKeyFile, keyPem)])
  }
  if (certPem === undefined || keyPem === undefined) throw new Error('managed TLS CA creation did not produce key material')
  await Promise.all([restrictPrivateFile(setup.caCertFile), restrictPrivateFile(setup.caKeyFile)])
  return assertMatchingCa(certPem, keyPem)
}

/** One host a server leaf must be valid for: an IP literal, a DNS name, or both. */
export interface ServerCertificateTarget {
  readonly commonName: string
  readonly ipAddresses?: readonly string[]
  readonly dnsNames?: readonly string[]
}

/** Where a freshly signed server leaf is installed. */
export interface ServerCertificateFiles {
  readonly certFile: string
  readonly keyFile: string
}

/** CA material a leaf is signed with. */
export interface ServerCertificateAuthority {
  readonly caCertFile: string
  readonly caKeyFile: string
}

function subjectAltNames(target: ServerCertificateTarget): { type: 2 | 7; value?: string; ip?: string }[] {
  const names: { type: 2 | 7; value?: string; ip?: string }[] = []
  for (const ip of target.ipAddresses ?? []) names.push({ type: 7, ip })
  for (const dns of target.dnsNames ?? []) names.push({ type: 2, value: dns })
  if (names.length === 0) throw new Error('managed TLS leaf needs at least one server name')
  return names
}

/**
 * Sign one server leaf with an existing self-signed CA and install it privately.
 *
 * Both the LAN listener and the self-signed FRP ingress use this one path, so a
 * certificate can never be produced by two divergent code paths. IP entries are
 * required for console addresses (`type: 7`), DNS entries (`type: 2`) cover named
 * hosts; the Android client accepts either through its pinned CA.
 */
export async function issueServerCertificate(
  authority: ServerCertificateAuthority,
  target: ServerCertificateTarget,
  output: ServerCertificateFiles,
  lifetimeDays = 397,
): Promise<void> {
  const altNames = subjectAltNames(target)
  await Promise.all([restrictPrivateFile(authority.caCertFile), restrictPrivateFile(authority.caKeyFile)])
  const [caCert, caKey] = await Promise.all([
    readFile(authority.caCertFile, 'utf8'),
    readFile(authority.caKeyFile, 'utf8'),
  ])
  assertMatchingCa(caCert, caKey)
  const now = new Date()
  const notAfter = new Date(now)
  notAfter.setDate(notAfter.getDate() + lifetimeDays)
  const server = await generate([{ name: 'commonName', value: target.commonName }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: new Date(now.getTime() - 5 * 60_000),
    notAfterDate: notAfter,
    ca: { cert: caCert, key: caKey },
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames },
    ],
  })
  await installServerCertificatePair(output, server.cert, server.private)
}

/** Sign and atomically install a server leaf for the interface's current address. */
export async function refreshManagedServerCertificate(setup: ManagedSetup, address: string): Promise<void> {
  await issueServerCertificate(
    { caCertFile: setup.tls.caCertFile, caKeyFile: setup.tls.caKeyFile },
    { commonName: 'DeepSeek Harness Mobile', ipAddresses: [address] },
    { certFile: setup.tls.certFile, keyFile: setup.tls.keyFile },
  )
}

/** Resolve the saved interface to the ordinary gateway config consumed by the Host plugin. */
export async function materializeManagedSetup(
  setup: ManagedSetup,
  table?: InterfaceTable,
): Promise<Record<string, unknown>> {
  const network = selectLanNetwork(undefined, setup.networkInterface, table)
  await refreshManagedServerCertificate(setup, network.address)
  const ca = new X509Certificate(await readFile(setup.tls.caCertFile, 'utf8'))
  return {
    publicOrigin: `https://${network.address}:${String(setup.listenPort)}`,
    listenHost: network.address,
    allowedCidrs: parseAdditionalTrustedNetworks([network.cidr, ...(setup.extraAllowedCidrs ?? [])]),
    instanceId: ca.fingerprint256.replaceAll(':', '').toLowerCase(),
    pairingCaFile: setup.tls.caCertFile,
    tls: {
      mode: 'provided',
      certFile: setup.tls.certFile,
      keyFile: setup.tls.keyFile,
    },
  }
}
