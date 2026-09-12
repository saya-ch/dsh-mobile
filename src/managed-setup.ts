import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto'
import { execFileText as execFile } from './exec-file.js'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { generate } from 'selfsigned'
import { restrictPrivateFile } from './private-file.js'

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
    .some(key => typeof key !== 'string' || !['version', 'networkInterface', 'listenPort', 'upstreamOrigin', 'tls'].includes(key))) {
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
    tls: Object.freeze({
      mode: 'managed',
      caCertFile: requiredString(tls.caCertFile, 'mobile setup tls.caCertFile'),
      caKeyFile: requiredString(tls.caKeyFile, 'mobile setup tls.caKeyFile'),
      certFile: requiredString(tls.certFile, 'mobile setup tls.certFile'),
      keyFile: requiredString(tls.keyFile, 'mobile setup tls.keyFile'),
    }),
  })
}

function privateIpv4(value: string): boolean {
  const parts = value.split('.').map(Number)
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    && (parts[0] === 10
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
  const result = await execFile(file, [...args], { encoding: 'utf8', windowsHide: true })
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

async function atomicWrite(file: string, contents: string | Uint8Array): Promise<void> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.${basename(file)}.${process.pid}.tmp`)
  await writeFile(temporary, contents, { mode: 0o600 })
  await rename(temporary, file)
  await restrictPrivateFile(file)
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

/** Sign and atomically install a server leaf for the interface's current address. */
export async function refreshManagedServerCertificate(setup: ManagedSetup, address: string): Promise<void> {
  await Promise.all([restrictPrivateFile(setup.tls.caCertFile), restrictPrivateFile(setup.tls.caKeyFile)])
  const [caCert, caKey] = await Promise.all([
    readFile(setup.tls.caCertFile, 'utf8'),
    readFile(setup.tls.caKeyFile, 'utf8'),
  ])
  assertMatchingCa(caCert, caKey)
  const now = new Date()
  const notAfter = new Date(now)
  notAfter.setDate(notAfter.getDate() + 397)
  const server = await generate([{ name: 'commonName', value: 'DeepSeek Harness Mobile' }], {
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
      { name: 'subjectAltName', altNames: [{ type: 7, ip: address }] },
    ],
  })
  await Promise.all([
    atomicWrite(setup.tls.certFile, server.cert),
    atomicWrite(setup.tls.keyFile, server.private),
  ])
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
    allowedCidrs: [network.cidr],
    instanceId: ca.fingerprint256.replaceAll(':', '').toLowerCase(),
    pairingCaFile: setup.tls.caCertFile,
    tls: {
      mode: 'provided',
      certFile: setup.tls.certFile,
      keyFile: setup.tls.keyFile,
    },
  }
}
