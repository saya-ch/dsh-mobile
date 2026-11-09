import { execFileText as execFile } from './exec-file.js'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  ensureManagedCa,
  refreshManagedServerCertificate,
  type LanNetwork,
  type ManagedSetup,
} from './managed-setup.js'
import { restrictPrivateFile } from './private-file.js'

const FIREWALL_TCP_RULE = 'DSH Mobile HTTPS'
const FIREWALL_UDP_RULE = 'DSH Mobile Discovery'
const MIN_MANAGED_PORT = 1024
const MAX_MANAGED_PORT = 65535

/** Files and active address produced by one explicit LAN setup confirmation. */
export interface ManagedLanSetupResult {
  readonly setup: ManagedSetup
  readonly network: LanNetwork
  readonly origin: string
  readonly androidCertificate: string
}

/** Inputs required to prepare the managed LAN listener without starting it. */
export interface ManagedLanSetupOptions {
  readonly setupFile: string
  readonly controlFile: string
  readonly network: LanNetwork
  readonly listenPort: number
  readonly dshPort: number
  readonly configureFirewall: boolean
}

function assertManagedPort(port: number, name: string): void {
  if (!Number.isSafeInteger(port) || port < MIN_MANAGED_PORT || port > MAX_MANAGED_PORT) {
    throw new Error(`${name} must be from ${String(MIN_MANAGED_PORT)} through ${String(MAX_MANAGED_PORT)}`)
  }
}

/** Longest failure detail carried in the thrown message. */
const MAX_FAILURE_DETAIL_CHARS = 512

/**
 * Strip the elevated invocation and filesystem locations from PowerShell text.
 *
 * The launcher's stderr quotes the command it ran, including the base64
 * `-EncodedCommand` payload, and the elevated script quotes its own scratch
 * path. Neither helps an operator, and both can push the one useful line past
 * the length bound, so they are replaced before the detail is bounded.
 */
function redactPowerShellDetail(value: string): string {
  return value
    .replace(/EncodedCommand\s+\S+/giu, 'EncodedCommand <redacted>')
    .replace(/\b[A-Za-z0-9+/]{64,}={0,2}\b/gu, '<redacted>')
    .replace(/(?<![A-Za-z])[A-Za-z]:[\\/][^\s'"]*/gu, '<path>')
}

/** Bounded, redacted detail for a failed elevated Windows operation. */
export function powerShellFailureDetail(error: unknown, innerError = ''): string {
  if (!(error instanceof Error)) return 'unknown failure'
  // A non-zero exit surfaces as a numeric code; a spawn failure uses a string.
  const code = 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number')
    ? ` (${String(error.code)})`
    : ''
  // The elevated process cannot write to the launcher's stderr, so its own
  // catch block persists the record first; that text wins over the launcher's.
  const stderr = innerError.trim() === '' && 'stderr' in error && typeof error.stderr === 'string'
    ? error.stderr
    : innerError
  const detail = redactPowerShellDetail(stderr).trim().replace(/\s+/gu, ' ').slice(0, MAX_FAILURE_DETAIL_CHARS)
  return `${code}${detail === '' ? '' : `: ${detail}`}`
}

/** Default sink for a scratch directory that could not be removed. */
function warnFirewallCleanupFailure(detail: string): void {
  process.emitWarning(`Windows firewall temporary cleanup failed (${detail})`, {
    code: 'DSH_MOBILE_FIREWALL_CLEANUP_FAILED',
  })
}

/**
 * Remove the elevated helper's scratch directory without touching the run's outcome.
 *
 * The directory is created before elevation and removed in a `finally`, so a
 * cleanup failure must not replace the firewall error that explains the
 * failure, and must not fail a run that already succeeded. It stays observable
 * instead: the removal error's code is reported to the warning sink, whose own
 * failure is ignored for the same reason.
 * @param directory - scratch path created for this run.
 * @param options - injectable removal and warning sink for tests.
 */
export async function discardFirewallScratch(
  directory: string,
  options: { readonly remove?: (path: string) => Promise<void>; readonly warn?: (detail: string) => void } = {},
): Promise<void> {
  const remove = options.remove ?? ((path: string) => rm(path, { recursive: true, force: true }))
  try {
    await remove(directory)
  } catch (error) {
    const code = error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'unknown'
    const warn = options.warn ?? warnFirewallCleanupFailure
    try { warn(code) } catch { /* a warning observer must not replace the primary outcome */ }
  }
}

async function runElevatedPowerShell(script: string): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-mobile-firewall-'))
  const errorFile = join(temporary, 'error.log')
  const escapedErrorFile = errorFile.replaceAll("'", "''")
  const wrapped = [
    `$__dshMobileErrorFile = '${escapedErrorFile}'`,
    'try {',
    script,
    '} catch {',
    '  try { [IO.File]::WriteAllText($__dshMobileErrorFile, ($_ | Out-String)) } catch {}',
    '  throw',
    '}',
  ].join('\n')
  const encoded = Buffer.from(wrapped, 'utf16le').toString('base64')
  const launch = [
    "$ErrorActionPreference = 'Stop'; $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru",
    `  -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}')`,
    '; exit $process.ExitCode',
  ].join(' ')
  try {
    await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launch], { windowsHide: true })
  } catch (error) {
    let innerError = ''
    try {
      innerError = (await readFile(errorFile, 'utf8')).replace(/^\uFEFF/u, '')
    } catch {
      // The elevated process may not have started or reached its catch block.
    }
    throw new Error(`Windows firewall operation failed${powerShellFailureDetail(error, innerError)}`, { cause: error })
  } finally {
    await discardFirewallScratch(temporary)
  }
}

function firewallRuleScript(name: string, protocol: 'TCP' | 'UDP', port: number): readonly string[] {
  return [
    `$rules = @(Get-NetFirewallRule -DisplayName '${name}' -ErrorAction SilentlyContinue)`,
    'if ($rules.Count -eq 0) {',
    `  New-NetFirewallRule -DisplayName '${name}' -Direction Inbound -Action Allow -Protocol ${protocol} -LocalPort ${String(port)} -RemoteAddress LocalSubnet -Profile Any | Out-Null`,
    '} else {',
    '  foreach ($rule in $rules) {',
    '    $rule | Set-NetFirewallRule -Enabled True -Direction Inbound -Action Allow -Profile Any',
    `    $rule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol ${protocol} -LocalPort ${String(port)}`,
    '    $rule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet',
    '  }',
    '}',
    `$verified = @(Get-NetFirewallRule -DisplayName '${name}' -ErrorAction Stop | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' -and $_.Profile -eq 'Any' })`,
    `$matchingPort = @($verified | Get-NetFirewallPortFilter | Where-Object { $_.Protocol -eq '${protocol}' -and $_.LocalPort -contains '${String(port)}' })`,
    `$matchingAddress = @($verified | Get-NetFirewallAddressFilter | Where-Object { $_.RemoteAddress -contains 'LocalSubnet' })`,
    `if ($verified.Count -eq 0 -or $matchingPort.Count -eq 0 -or $matchingAddress.Count -eq 0) { throw "DSH Mobile firewall rule '${name}' is not active with the expected scope" }`,
  ]
}

/** Build the elevated Windows firewall script without removing a working rule first. */
export function windowsFirewallSetupScript(port: number): string {
  assertManagedPort(port, 'Windows firewall port')
  return [
    "$ErrorActionPreference = 'Stop'",
    ...firewallRuleScript(FIREWALL_TCP_RULE, 'TCP', port),
    ...firewallRuleScript(FIREWALL_UDP_RULE, 'UDP', port),
  ].join('\n')
}

/** Install or update the two Windows inbound rules used by the managed LAN listener. */
export async function configureWindowsFirewall(port: number): Promise<void> {
  if (process.platform !== 'win32') return
  await runElevatedPowerShell(windowsFirewallSetupScript(port))
}

/** Remove only the two Windows firewall rules owned by DSH Mobile. */
export async function removeWindowsFirewall(): Promise<void> {
  if (process.platform !== 'win32') return
  await runElevatedPowerShell([
    "$ErrorActionPreference = 'Stop'",
    `Get-NetFirewallRule -DisplayName '${FIREWALL_TCP_RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    `Get-NetFirewallRule -DisplayName '${FIREWALL_UDP_RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
  ].join('; '))
}

/** Generate private TLS material and persist a managed setup selected by the user. */
export async function prepareManagedLanSetup(options: ManagedLanSetupOptions): Promise<ManagedLanSetupResult> {
  if (!isAbsolute(options.setupFile) || !isAbsolute(options.controlFile)) {
    throw new Error('managed LAN setup paths must be absolute')
  }
  assertManagedPort(options.listenPort, 'managed LAN listenPort')
  assertManagedPort(options.dshPort, 'managed LAN dshPort')
  const directory = dirname(options.setupFile)
  const tlsDirectory = join(directory, 'tls')
  await mkdir(tlsDirectory, { recursive: true, mode: 0o700 })
  const managedTls: ManagedSetup['tls'] = {
    mode: 'managed',
    caCertFile: join(tlsDirectory, 'ca.pem'),
    caKeyFile: join(tlsDirectory, 'ca-key.pem'),
    certFile: join(tlsDirectory, 'server-cert.pem'),
    keyFile: join(tlsDirectory, 'server-key.pem'),
  }
  const ca = await ensureManagedCa(managedTls, {
    certFile: join(tlsDirectory, 'cert.pem'),
    keyFile: join(tlsDirectory, 'key.pem'),
  })
  const setup: ManagedSetup = {
    version: 2,
    networkInterface: options.network.name,
    listenPort: options.listenPort,
    upstreamOrigin: `http://127.0.0.1:${String(options.dshPort)}`,
    tls: managedTls,
  }
  await refreshManagedServerCertificate(setup, options.network.address)
  const androidCertificate = join(tlsDirectory, 'dsh-mobile-ca.cer')
  await writeFile(androidCertificate, ca.raw, { mode: 0o600 })
  await Promise.all([
    ...Object.values(managedTls).filter(value => value !== 'managed').map(file => restrictPrivateFile(file)),
    restrictPrivateFile(androidCertificate),
  ])
  if (options.configureFirewall) await configureWindowsFirewall(options.listenPort)
  await Promise.all([
    writeFile(options.setupFile, `${JSON.stringify({
      ...setup,
      tls: Object.fromEntries(Object.entries(setup.tls)
        .map(([key, value]) => [key, typeof value === 'string' ? value.replaceAll('\\', '/') : value])),
    }, null, 2)}\n`, { mode: 0o600 }),
    writeFile(options.controlFile, '{"version":1,"enabled":true}\n', { mode: 0o600 }),
  ])
  await Promise.all([restrictPrivateFile(options.setupFile), restrictPrivateFile(options.controlFile)])
  return Object.freeze({
    setup: Object.freeze(setup),
    network: Object.freeze({ ...options.network }),
    origin: `https://${options.network.address}:${String(options.listenPort)}`,
    androidCertificate,
  })
}
