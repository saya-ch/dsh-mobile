import { execFileText as execFile } from './exec-file.js'
import { mkdir, writeFile } from 'node:fs/promises'
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

function powerShellFailureDetail(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown failure'
  const code = 'code' in error && typeof error.code === 'string' ? ` (${error.code})` : ''
  const stderr = 'stderr' in error && typeof error.stderr === 'string'
    ? error.stderr.trim().replace(/\s+/gu, ' ').slice(0, 512)
    : ''
  return `${code}${stderr === '' ? '' : `: ${stderr}`}`
}

async function runElevatedPowerShell(script: string): Promise<void> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const launch = [
    "$ErrorActionPreference = 'Stop'; $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru",
    `  -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}')`,
    '; exit $process.ExitCode',
  ].join(' ')
  try {
    await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launch], { windowsHide: true })
  } catch (error) {
    throw new Error(`Windows firewall operation failed${powerShellFailureDetail(error)}`, { cause: error })
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
    `$verified = @(Get-NetFirewallRule -DisplayName '${name}' -Enabled True -Direction Inbound -Action Allow -Profile Any -ErrorAction Stop)`,
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
