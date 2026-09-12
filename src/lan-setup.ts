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

async function runElevatedPowerShell(script: string): Promise<void> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const launch = [
    "$ErrorActionPreference = 'Stop'; $process = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru",
    `  -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}')`,
    '; exit $process.ExitCode',
  ].join(' ')
  await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', launch], { windowsHide: true })
}

/** Install the two Windows inbound rules used by the managed LAN listener. */
export async function configureWindowsFirewall(port: number): Promise<void> {
  if (process.platform !== 'win32') return
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Get-NetFirewallRule -DisplayName '${FIREWALL_TCP_RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    `Get-NetFirewallRule -DisplayName '${FIREWALL_UDP_RULE}' -ErrorAction SilentlyContinue | Remove-NetFirewallRule`,
    `New-NetFirewallRule -DisplayName '${FIREWALL_TCP_RULE}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${String(port)} -RemoteAddress LocalSubnet -Profile Any | Out-Null`,
    `New-NetFirewallRule -DisplayName '${FIREWALL_UDP_RULE}' -Direction Inbound -Action Allow -Protocol UDP -LocalPort ${String(port)} -RemoteAddress LocalSubnet -Profile Any | Out-Null`,
  ].join('; ')
  await runElevatedPowerShell(script)
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
  if (!Number.isSafeInteger(options.listenPort) || options.listenPort < 1024 || options.listenPort > 65535) {
    throw new Error('managed LAN listenPort must be from 1024 through 65535')
  }
  if (!Number.isSafeInteger(options.dshPort) || options.dshPort < 1024 || options.dshPort > 65535) {
    throw new Error('managed LAN dshPort must be from 1024 through 65535')
  }
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
