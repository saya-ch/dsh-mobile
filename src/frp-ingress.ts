import { X509Certificate } from 'node:crypto'
import { lstat, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readCertificateRenewal, type CertRenewalStatus } from './cert-renewal.js'
import {
  frpEntryOrigin,
  isFrpSelfSignedIngress,
  resolveFrpEntryTls,
  resolveFrpMode,
  resolveFrpPublicPort,
  resolveFrpVhostHttpPort,
  type FrpSettings,
} from './frp-config.js'
import { ensureManagedCa, issueServerCertificate, readManagedCa } from './managed-setup.js'
import { restrictPrivateFile } from './private-file.js'
import { assertManagedParents, ensureManagedDirectory, writeManagedPrivateFile } from './managed-files.js'

/** Private files owned by the self-signed FRP ingress. */
export interface FrpIngressPaths {
  readonly directory: string
  readonly caCertFile: string
  readonly caKeyFile: string
  readonly certFile: string
  readonly keyFile: string
  readonly statusFile: string
}

/** Signed ingress material plus the fingerprint the app must pin. */
export interface FrpIngressCertificate {
  readonly paths: FrpIngressPaths
  readonly ca: X509Certificate
  readonly leaf: X509Certificate
  readonly caFingerprint: string
  readonly status: CertRenewalStatus
}

/** Everything the panel needs for the on-demand self-check. */
export interface FrpIngressSelfCheck {
  readonly mode: 'deploy' | 'attach'
  readonly entryTls: 'public-ip-cert' | 'self-signed'
  readonly vhostHttpPort: number
  readonly publicPort: number
  readonly publicOrigin: string
  /** Reachable HTTPS entry; includes the TCP proxy port in self-signed mode. */
  readonly entryOrigin: string
  readonly serverAddress: string
  readonly serverPort: number
  readonly caFingerprint?: string
  readonly certificate?: CertRenewalStatus
  readonly caCertificate?: CertRenewalStatus
  readonly inbound: { readonly listenHost: '127.0.0.1'; readonly allowedCidrs: readonly string[] }
}

/** Private ingress directory, always a sibling of the remote device file. */
export function frpIngressPaths(stateFile: string): FrpIngressPaths {
  const directory = join(dirname(stateFile), 'ingress')
  return Object.freeze({
    directory,
    caCertFile: join(directory, 'ca.pem'),
    caKeyFile: join(directory, 'ca-key.pem'),
    certFile: join(directory, 'server.pem'),
    keyFile: join(directory, 'server-key.pem'),
    // Keep the identity marker outside the certificate directory so deleting
    // that directory cannot silently create a replacement CA on next start.
    statusFile: join(dirname(stateFile), 'ingress-identity.json'),
  })
}

async function regularFileExists(file: string): Promise<boolean> {
  try {
    const entry = await lstat(file)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('frp_ingress_file_invalid')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readIngressIdentity(file: string): Promise<string | undefined> {
  if (!(await regularFileExists(file))) return undefined
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid identity')
    const record = parsed as Record<string, unknown>
    if (record.version !== 1 || typeof record.caFingerprint !== 'string'
      || !/^[a-f0-9]{64}$/u.test(record.caFingerprint)) throw new Error('invalid identity')
    return record.caFingerprint
  } catch (error) {
    throw new Error('frp_ingress_ca_invalid', { cause: error })
  }
}

async function writeIngressIdentity(file: string, fingerprint: string, ownedRoot: string): Promise<void> {
  await writeManagedPrivateFile(ownedRoot, file, `${JSON.stringify({ version: 1, caFingerprint: fingerprint })}\n`, 'frp_ingress')
}

function coversPublicIp(certificate: X509Certificate, address: string): boolean {
  const alternatives = certificate.subjectAltName ?? ''
  return alternatives.split(',').some(entry => entry.trim() === `IP Address:${address}`)
}

/**
 * Materialize the CA and leaf the gateway terminates TLS with.
 *
 * The CA remains stable for paired phones; an expired CA must be re-paired, not
 * replaced silently. The leaf is re-signed when expiring or no longer valid for
 * the public IPv4, and the running gateway reloads it after a renewal check.
 */
export async function ensureFrpIngressCertificate(
  settings: FrpSettings,
  stateFile: string,
  now: number = Date.now(),
  expectedCaFingerprint?: string,
  ownedRoot: string = dirname(stateFile),
): Promise<FrpIngressCertificate> {
  if (resolveFrpMode(settings) !== 'attach' || !isFrpSelfSignedIngress(settings)) {
    throw new Error('frp_entry_tls_invalid')
  }
  const paths = frpIngressPaths(stateFile)
  await assertManagedParents(ownedRoot, paths.statusFile, 'frp_ingress')
  await assertManagedParents(ownedRoot, paths.caCertFile, 'frp_ingress')
  try {
    const directory = await lstat(paths.directory)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('frp_ingress_directory_invalid')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const previousFingerprint = await readIngressIdentity(paths.statusFile)
  const [caCertExists, caKeyExists, leafCertExists, leafKeyExists] = await Promise.all([
    regularFileExists(paths.caCertFile), regularFileExists(paths.caKeyFile),
    regularFileExists(paths.certFile), regularFileExists(paths.keyFile),
  ])
  if (caCertExists !== caKeyExists || (!caCertExists && (previousFingerprint !== undefined || leafCertExists || leafKeyExists))) {
    throw new Error('frp_ingress_ca_invalid')
  }
  if (caCertExists && (await readCertificateRenewal(paths.caCertFile, now)).state === 'expired') {
    throw new Error('frp_ingress_ca_expired')
  }
  if (previousFingerprint === undefined) {
    await ensureManagedDirectory(ownedRoot, dirname(paths.statusFile), 'frp_ingress')
    try {
      await writeFile(paths.statusFile, '{"version":1,"pending":true}\n', { flag: 'wx', mode: 0o600 })
      await restrictPrivateFile(paths.statusFile)
    } catch (error) {
      throw new Error('frp_ingress_ca_invalid', { cause: error })
    }
  }
  const caFiles = {
    mode: 'managed',
    caCertFile: paths.caCertFile,
    caKeyFile: paths.caKeyFile,
    certFile: paths.certFile,
    keyFile: paths.keyFile,
  } as const
  let ca: X509Certificate
  try {
    await assertManagedParents(ownedRoot, paths.caCertFile, 'frp_ingress')
    ca = expectedCaFingerprint === undefined ? await ensureManagedCa(caFiles) : await readManagedCa(caFiles)
  } catch (error) {
    throw new Error('frp_ingress_ca_invalid', { cause: error })
  }
  const caFingerprint = ca.fingerprint256.replaceAll(':', '').toLowerCase()
  if (previousFingerprint !== undefined && caFingerprint !== previousFingerprint) {
    throw new Error('frp_ingress_ca_changed')
  }
  if (expectedCaFingerprint !== undefined && caFingerprint !== expectedCaFingerprint) {
    throw new Error('frp_ingress_ca_changed')
  }
  if (previousFingerprint === undefined) await writeIngressIdentity(paths.statusFile, caFingerprint, ownedRoot)
  const publicHost = new URL(settings.publicOrigin).hostname
  let leaf: X509Certificate | undefined
  try {
    leaf = new X509Certificate(await readFile(paths.certFile))
  } catch {
    leaf = undefined
  }
  const reusable = leaf !== undefined
    && Date.parse(leaf.validTo) > now + 24 * 60 * 60_000
    && coversPublicIp(leaf, publicHost)
    && leaf.verify(ca.publicKey)
  if (!reusable) {
    await assertManagedParents(ownedRoot, paths.certFile, 'frp_ingress')
    await issueServerCertificate(
      { caCertFile: paths.caCertFile, caKeyFile: paths.caKeyFile },
      { commonName: 'DSH Mobile FRP ingress', ipAddresses: [publicHost] },
      { certFile: paths.certFile, keyFile: paths.keyFile },
    )
    leaf = new X509Certificate(await readFile(paths.certFile))
  }
  const signed = leaf ?? (() => { throw new Error('frp_attach_cert_unknown') })()
  return Object.freeze({
    paths,
    ca,
    leaf: signed,
    caFingerprint,
    status: await readCertificateRenewal(paths.certFile, now),
  })
}

/**
 * Build the read-only self-check payload shown in the desktop panel.
 *
 * No secret ever leaves this function: the CA is reported by fingerprint only,
 * and the token is never read.
 */
export async function frpIngressSelfCheck(settings: FrpSettings, stateFile: string, ownedRoot: string = dirname(stateFile)): Promise<FrpIngressSelfCheck> {
  const paths = frpIngressPaths(stateFile)
  const base = {
    mode: resolveFrpMode(settings),
    entryTls: resolveFrpEntryTls(settings),
    vhostHttpPort: resolveFrpVhostHttpPort(settings),
    publicPort: resolveFrpPublicPort(settings),
    publicOrigin: settings.publicOrigin,
    entryOrigin: frpEntryOrigin(settings),
    serverAddress: settings.serverAddress,
    serverPort: settings.serverPort,
    inbound: { listenHost: '127.0.0.1' as const, allowedCidrs: Object.freeze(['127.0.0.0/8']) },
  }
  if (!isFrpSelfSignedIngress(settings)) {
    // The public-CA entry keeps its certificate on the VPS; nothing local to read.
    return Object.freeze(base)
  }
  await assertManagedParents(ownedRoot, paths.caCertFile, 'frp_ingress')
  await assertManagedParents(ownedRoot, paths.certFile, 'frp_ingress')
  let caFingerprint: string | undefined
  try {
    caFingerprint = new X509Certificate(await readFile(paths.caCertFile)).fingerprint256.replaceAll(':', '').toLowerCase()
  } catch {
    caFingerprint = undefined
  }
  return Object.freeze({
    ...base,
    ...(caFingerprint === undefined ? {} : { caFingerprint }),
    certificate: await readCertificateRenewal(paths.certFile),
    caCertificate: await readCertificateRenewal(paths.caCertFile),
  })
}

/** Remove only the five files owned by the local self-signed FRP entry. */
export async function purgeFrpIngressCertificates(stateFile: string, ownedRoot: string = dirname(stateFile)): Promise<void> {
  const paths = frpIngressPaths(stateFile)
  await assertManagedParents(ownedRoot, paths.statusFile, 'frp_ingress')
  await assertManagedParents(ownedRoot, paths.directory, 'frp_ingress')
  try {
    const marker = await lstat(paths.statusFile)
    if (!marker.isFile() && !marker.isSymbolicLink()) throw new Error('frp_ingress_file_invalid')
    await unlink(paths.statusFile)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  let directory
  try { directory = await lstat(paths.directory) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (directory.isSymbolicLink()) {
    await unlink(paths.directory)
    return
  }
  if (!directory.isDirectory()) throw new Error('frp_ingress_directory_invalid')
  for (const file of [paths.caCertFile, paths.caKeyFile, paths.certFile, paths.keyFile]) {
    await assertManagedParents(ownedRoot, file, 'frp_ingress')
    let entry
    try { entry = await lstat(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error('frp_ingress_file_invalid')
    await unlink(file)
  }
  try {
    await assertManagedParents(ownedRoot, paths.directory, 'frp_ingress')
    await rmdir(paths.directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
