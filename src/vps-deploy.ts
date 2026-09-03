import { createHash, randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { validateFrpPublicOrigin, validateFrpServerAddress, validateFrpServerPort, validateFrpToken, type FrpSettings } from './frp-config.js'
import {
  FRP_CADDY_IMPORT_LINE,
  FRP_CADDY_SNIPPET_MARKER,
  FRP_CADDY_SNIPPET_PATH,
  createCaddySite,
} from './frp-template.js'
import { isGloballyRoutableIpv4 } from './network.js'

const FRP_VERSION = '0.70.1'
const SSH_TIMEOUT_MS = 300_000
const MAX_OUTPUT_BYTES = 96 * 1024

const LINUX_ARTIFACTS = Object.freeze({
  x64: Object.freeze({
    directory: `frp_${FRP_VERSION}_linux_amd64`,
    url: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_amd64.tar.gz`,
    sha256: '333da23d1b9009d7c01638e9ba38cf4600f7d37d393f854e96ee1396adefa9a6',
  }),
  arm64: Object.freeze({
    directory: `frp_${FRP_VERSION}_linux_arm64`,
    url: `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_arm64.tar.gz`,
    sha256: '3990f396a9a490ee7f0e5f355287750ed41520064ed999eab443b5e9a78d773d',
  }),
})

export interface VpsDeploymentInput {
  readonly sshUser: string
  readonly sshPort: number
  readonly sshKeyPath?: string
  /**
   * User-confirmed SHA256 host-key fingerprints (`SHA256:…`, one per server key).
   * The deployment aborts unless every key the server currently presents is confirmed.
   */
  readonly hostFingerprints: readonly string[]
}

/** One SSH server host key with its OpenSSH-style SHA256 fingerprint. */
export interface VpsHostKey {
  readonly keyType: string
  readonly fingerprint: string
}

export interface VpsDeploymentCheck {
  readonly id: string
  readonly status: 'ok' | 'warning' | 'error'
  readonly detail: string
}

export interface VpsDeploymentResult {
  readonly version: 1
  readonly deployed: boolean
  readonly serverAddress: string
  readonly publicOrigin: string
  readonly checks: readonly VpsDeploymentCheck[]
}

export interface VpsDeploymentOptions {
  readonly runSsh?: (input: VpsDeploymentInput, serverAddress: string, script: string) => Promise<{ stdout: string; stderr: string }>
  readonly runKeyscan?: (input: { readonly sshUser: unknown; readonly sshPort: unknown }, serverAddress: string) => Promise<string>
  readonly runSshFetch?: (input: VpsSshFetchInput, serverAddress: string) => Promise<string>
  readonly runRemoteScript?: (input: VpsDeploymentInput, serverAddress: string, script: string) => Promise<{ stdout: string; stderr: string }>
  readonly log?: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void
}

export class VpsSshError extends Error {
  constructor(message: string, readonly stdout: string, readonly stderr: string, options?: ErrorOptions) {
    super(message, options)
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Reject loopback, private, and other non-routable IPv4 literals as VPS SSH
 * targets. A self-hosted deployment always addresses a public server; the
 * shared frpc settings stay permissive so local loopback test rigs keep working.
 */
function assertPublicSshTarget(serverAddress: string): void {
  if (isIP(serverAddress) === 4 && !isGloballyRoutableIpv4(serverAddress)) {
    throw new Error('vps_server_not_public')
  }
}

/**
 * Validate a VPS address for every operation that opens a network connection
 * to it (scan, deploy, cleanup). IPv6 is unsupported by the SSH flow and
 * loopback/private targets are never valid VPS endpoints.
 */
function validateVpsServerTarget(serverAddress: string): string {
  const address = validateFrpServerAddress(serverAddress)
  if (isIP(address) !== 0 && address.includes(':')) throw new Error('vps_ipv6_ssh_not_supported')
  assertPublicSshTarget(address)
  return address
}

function validSshUser(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || !/^[a-z_][a-z0-9_.-]*[$]?$/iu.test(value)) {
    throw new Error('vps_ssh_user_invalid')
  }
  return value
}

function validSshPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) throw new Error('vps_ssh_port_invalid')
  return Number(value)
}

function validSshKeyPath(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('vps_ssh_key_invalid')
  }
  return resolve(value)
}

export function parseVpsDeploymentInput(value: unknown): VpsDeploymentInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('vps_deploy_input_invalid')
  const record = value as Record<string, unknown>
  if (Reflect.ownKeys(record).some(key => !['sshUser', 'sshPort', 'sshKeyPath', 'hostFingerprints'].includes(String(key)))) {
    throw new Error('vps_deploy_input_invalid')
  }
  const sshKeyPath = validSshKeyPath(record.sshKeyPath)
  return Object.freeze({
    sshUser: validSshUser(record.sshUser),
    sshPort: validSshPort(record.sshPort),
    ...(sshKeyPath === undefined ? {} : { sshKeyPath }),
    hostFingerprints: Object.freeze(parseVpsHostFingerprints(record.hostFingerprints)),
  })
}

/** Validate user-confirmed SHA256 host-key fingerprints (`SHA256:…`). */
export function parseVpsHostFingerprints(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error('vps_host_key_unconfirmed')
  const fingerprints: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !/^SHA256:[A-Za-z0-9+/]{40,60}={0,2}$/u.test(entry) || entry.length > 96) {
      throw new Error('vps_host_key_unconfirmed')
    }
    fingerprints.push(entry)
  }
  return [...new Set(fingerprints)]
}

const SUPPORTED_HOST_KEY_TYPES = new Set([
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'ssh-ed25519',
])

/** Format a raw host public key the way OpenSSH displays it (`SHA256:…` without padding). */
export function fingerprintHostPublicKey(keyType: string, base64Key: string): string {
  if (!SUPPORTED_HOST_KEY_TYPES.has(keyType)) throw new Error('vps_host_key_unsupported_type')
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(base64Key) || base64Key.length < 24 || base64Key.length > 1_024) {
    throw new Error('vps_host_key_invalid')
  }
  const raw = Buffer.from(base64Key, 'base64')
  if (raw.length < 16 || raw.length > 768) throw new Error('vps_host_key_invalid')
  return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/u, '')}`
}

function parseKeyscanOutput(output: string): Array<{ keyType: string; base64Key: string }> {
  const keys: Array<{ keyType: string; base64Key: string }> = []
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    // The host field is optional: ssh-cat fallback lines carry only type and key.
    // It is discarded anyway; pinned known_hosts lines are rebuilt from the
    // validated server address, so accepting host-less lines is safe.
    const match = /^(?:\S+\s+)?(ssh-rsa|ecdsa-sha2-nistp\d+|ssh-ed25519)\s+([A-Za-z0-9+/]+={0,2})(\s|$)/u.exec(trimmed)
    if (match?.[1] === undefined || match[2] === undefined) throw new Error('vps_host_key_invalid')
    keys.push({ keyType: match[1], base64Key: match[2] })
  }
  return keys
}

/** Base SSH options shared by long deployment sessions. Keepalives survive NAT
 *  middleboxes during minute-long apt/pip phases; host identity stays pinned. */
function sshSessionOptions(knownHostsFile: string): string[] {
  return [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8',
    '-o', 'StrictHostKeyChecking=yes', `-o UserKnownHostsFile=${knownHostsFile}`,
  ]
}

/** Lenient scan probe: garbage fails the whole fetch, comment-only output falls back. */
function tryParseKeyscanOutput(output: string): Array<{ keyType: string; base64Key: string }> | undefined {
  try {
    return parseKeyscanOutput(output)
  } catch {
    return undefined
  }
}

async function gitBundledKeyscan(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined
  const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const candidate = join(programFiles, 'Git', 'usr', 'bin', 'ssh-keyscan.exe')
  try {
    const entry = await lstat(candidate)
    if (!entry.isFile()) return undefined
  } catch {
    return undefined
  }
  return candidate
}

async function defaultRunKeyscan(input: { readonly sshUser: unknown; readonly sshPort: unknown }, serverAddress: string): Promise<string> {
  const keyscan = process.platform === 'win32' ? 'ssh-keyscan.exe' : 'ssh-keyscan'
  const args = ['-T', '10', '-p', String(input.sshPort), '-t', 'rsa,ecdsa,ed25519', serverAddress]
  const first = await runProcess(keyscan, args, undefined, 30_000).catch(() => undefined)
  if (first !== undefined && tryParseKeyscanOutput(first.stdout)?.length) return first.stdout
  // Old keyscan binaries fail KEX against modern servers (non-zero exit, no
  // keys); retry with the Git for Windows copy when present before giving up.
  // An empty result lets the caller fall back to an authenticated read.
  const bundled = await gitBundledKeyscan()
  if (bundled !== undefined) {
    const second = await runProcess(bundled, args, undefined, 30_000).catch(() => undefined)
    if (second !== undefined && tryParseKeyscanOutput(second.stdout)?.length) return second.stdout
  }
  return first?.stdout ?? ''
}

export interface VpsSshFetchInput {
  readonly sshUser: unknown
  readonly sshPort: unknown
  readonly sshKeyPath?: unknown
}

/**
 * Read the server's public host keys over an authenticated connection with a
 * throwaway known_hosts file. Fallback for keyscan binaries that cannot
 * negotiate with modern servers; output feeds the same confirm-and-pin pipeline.
 */
async function defaultRunSshFetch(input: VpsSshFetchInput, serverAddress: string): Promise<string> {
  const ssh = process.platform === 'win32' ? 'ssh.exe' : 'ssh'
  const sshUser = validSshUser(input.sshUser)
  const sshPort = validSshPort(input.sshPort)
  const sshKeyPath = validSshKeyPath(input.sshKeyPath)
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'
  const args = [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15',
    '-o', 'StrictHostKeyChecking=no', `-o UserKnownHostsFile=${nullDevice}`,
    ...(sshKeyPath === undefined ? [] : ['-i', sshKeyPath]),
    '-p', String(sshPort), `${sshUser}@${serverAddress}`, 'cat /etc/ssh/ssh_host_*_key.pub',
  ]
  const { stdout } = await runProcess(ssh, args, undefined, 30_000).catch((error: unknown) => {
    throw new VpsSshError('vps_host_key_unavailable', '', error instanceof Error ? error.message : String(error))
  })
  const lines: string[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^(ssh-rsa|ecdsa-sha2-nistp\d+|ssh-ed25519)\s+([A-Za-z0-9+/]+={0,2})(\s|$)/u.exec(line.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) lines.push(`${serverAddress} ${match[1]} ${match[2]}`)
  }
  return lines.length === 0 ? stdout : `${lines.join('\n')}\n`
}

/**
 * Scan host keys with keyscan first, then fall back to an authenticated read
 * when the local keyscan binary cannot negotiate with the server. Both paths
 * feed the same confirm-and-pin pipeline, so a fallback never weakens the
 * user-confirmation gate.
 */
async function scanHostKeys(
  input: VpsSshFetchInput,
  serverAddress: string,
  options: VpsDeploymentOptions,
): Promise<string> {
  const runKeyscan = options.runKeyscan ?? defaultRunKeyscan
  // A rejecting keyscan (old binary failing KEX, missing binary, DNS error)
  // is equivalent to an empty scan: fall through to the authenticated read.
  const scanned = await runKeyscan({ sshUser: input.sshUser, sshPort: input.sshPort }, serverAddress).catch(() => '')
  if (tryParseKeyscanOutput(scanned)?.length) return scanned
  options.log?.('host-keys-keyscan-empty', { serverAddress })
  const runSshFetch = options.runSshFetch ?? defaultRunSshFetch
  const fetched = await runSshFetch(input, serverAddress)
  if (tryParseKeyscanOutput(fetched)?.length) {
    options.log?.('host-keys-ssh-fallback', { serverAddress })
    return fetched
  }
  throw new Error('vps_host_key_unavailable')
}

/**
 * Fetch the server's current host keys and return them with OpenSSH-style
 * fingerprints for the user to confirm out of band (for example against the
 * VPS console) before any destructive or authenticated deployment step.
 */
export async function fetchVpsHostKeys(
  serverAddress: string,
  input: VpsSshFetchInput,
  options: VpsDeploymentOptions = {},
): Promise<readonly VpsHostKey[]> {
  const address = validateVpsServerTarget(serverAddress)
  const sshUser = validSshUser(input.sshUser)
  const sshPort = validSshPort(input.sshPort)
  const output = await scanHostKeys({ sshUser, sshPort, sshKeyPath: input.sshKeyPath }, address, options)
  const keys = parseKeyscanOutput(output)
  if (keys.length === 0) throw new Error('vps_host_key_unavailable')
  const seen = new Set<string>()
  const hostKeys: VpsHostKey[] = []
  for (const key of keys) {
    const fingerprint = fingerprintHostPublicKey(key.keyType, key.base64Key)
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    hostKeys.push(Object.freeze({ keyType: key.keyType, fingerprint }))
  }
  options.log?.('host-keys-fetched', { serverAddress: address, keyTypes: hostKeys.length })
  return Object.freeze(hostKeys)
}

/**
 * Verify that every host key the server currently presents was confirmed by the
 * user, then return a pinned known_hosts body. Fails closed on rotation,
 * replacement, or unexpected extra keys.
 */
export function buildPinnedKnownHosts(
  serverAddress: string,
  sshPort: number,
  keyscanOutput: string,
  confirmedFingerprints: readonly string[],
): string {
  const address = validateFrpServerAddress(serverAddress)
  const port = validSshPort(sshPort)
  const confirmed = new Set(parseVpsHostFingerprints([...confirmedFingerprints]))
  const keys = parseKeyscanOutput(keyscanOutput)
  if (keys.length === 0) throw new Error('vps_host_key_unavailable')
  const host = port === 22 ? address : `[${address}]:${port}`
  const lines: string[] = []
  for (const key of keys) {
    const fingerprint = fingerprintHostPublicKey(key.keyType, key.base64Key)
    if (!confirmed.has(fingerprint)) throw new Error('vps_host_key_mismatch')
    lines.push(`${host} ${key.keyType} ${key.base64Key}`)
  }
  return `${lines.join('\n')}\n`
}

function safeOutput(value: string, token: string): string {
  const redacted = token === '' ? value : value.replaceAll(token, '<redacted>')
  return redacted.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '').slice(0, 8_192).trim()
}

function parseChecks(stdout: string, stderr: string, token: string): readonly VpsDeploymentCheck[] {
  const checks: VpsDeploymentCheck[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^DSH_MOBILE_CHECK\s+([a-z0-9_-]+)\s+(ok|warning|error)\s+(.+)$/iu.exec(line)
    if (match !== null) checks.push(Object.freeze({ id: match[1]!, status: match[2]!.toLowerCase() as VpsDeploymentCheck['status'], detail: safeOutput(match[3]!, token) }))
  }
  if (checks.length === 0 && stderr.trim() !== '') {
    checks.push(Object.freeze({ id: 'remote-command', status: 'error', detail: safeOutput(stderr, token) || 'VPS 返回了未分类错误。' }))
  }
  return Object.freeze(checks)
}

/**
 * One-line failure detail for transport-level failures: prefer the failed
 * remote check, otherwise use the last stderr line (a `set -eu` abort has no
 * check line) instead of dumping the whole transcript into the UI.
 */
function failureDetail(stdout: string, stderr: string, token: string): string {
  const parsed = parseChecks(`${stdout}\n${stderr}`, '', token)
  const failed = parsed.find(check => check.status === 'error')
  if (failed !== undefined) return failed.detail
  for (const stream of [stderr, stdout]) {
    const lines = stream.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
    const last = lines[lines.length - 1]
    if (last !== undefined) return safeOutput(last, token)
  }
  return ''
}

function deploymentScript(settings: FrpSettings): string {
  const amd64 = LINUX_ARTIFACTS.x64
  const arm64 = LINUX_ARTIFACTS.arm64
  const config = [
    'bindAddr = "0.0.0.0"',
    `bindPort = ${String(settings.serverPort)}`,
    'proxyBindAddr = "127.0.0.1"',
    'vhostHTTPPort = 7080',
    'auth.method = "token"',
    `auth.token = ${JSON.stringify(settings.token)}`,
    '',
  ].join('\n')
  const publicHost = new URL(settings.publicOrigin).hostname
  const publicIp = isGloballyRoutableIpv4(publicHost)
  // The site content is shared with the manual template; only the wiring
  // (snippet file + one import line) differs.
  const caddySite = createCaddySite(publicHost)
  const caddySnippet = `${FRP_CADDY_SNIPPET_MARKER}\n${caddySite.trimEnd()}\n`
  const ipCertificateSetup = publicIp ? `
export DEBIAN_FRONTEND=noninteractive
apt-get install -y python3-venv
if [ ! -x /opt/dsh-mobile/certbot-venv/bin/certbot ]; then
  python3 -m venv /opt/dsh-mobile/certbot-venv
  /opt/dsh-mobile/certbot-venv/bin/pip install --disable-pip-version-check 'certbot==5.8.0'
fi
systemctl stop caddy.service || true
if ! /opt/dsh-mobile/certbot-venv/bin/certbot certonly --standalone --preferred-profile shortlived --ip-address ${publicHost} --agree-tos --register-unsafely-without-email --non-interactive --keep-until-expiring; then
  systemctl start caddy.service || true
  fail "公网 IP HTTPS 证书申请失败；请确认 80/tcp 可从公网访问。"
fi
install -d -m 0750 -o caddy -g caddy /var/lib/caddy/dsh-mobile-certs
install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/${publicHost}/fullchain.pem /var/lib/caddy/dsh-mobile-certs/fullchain.pem
install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/${publicHost}/privkey.pem /var/lib/caddy/dsh-mobile-certs/privkey.pem
cat > /usr/local/sbin/dsh-mobile-cert-renew <<'DSH_MOBILE_CERT_RENEW'
#!/bin/sh
set -eu
systemctl stop caddy.service
trap 'systemctl start caddy.service' EXIT
/opt/dsh-mobile/certbot-venv/bin/certbot renew --cert-name ${publicHost} --preferred-profile shortlived --non-interactive
install -d -m 0750 -o caddy -g caddy /var/lib/caddy/dsh-mobile-certs
install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/${publicHost}/fullchain.pem /var/lib/caddy/dsh-mobile-certs/fullchain.pem
install -m 0640 -o caddy -g caddy /etc/letsencrypt/live/${publicHost}/privkey.pem /var/lib/caddy/dsh-mobile-certs/privkey.pem
DSH_MOBILE_CERT_RENEW
chmod 0755 /usr/local/sbin/dsh-mobile-cert-renew
cat > /etc/systemd/system/dsh-mobile-cert-renew.service <<'DSH_MOBILE_CERT_SERVICE'
[Unit]
Description=Renew DSH Mobile public IP TLS certificate
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/dsh-mobile-cert-renew
DSH_MOBILE_CERT_SERVICE
cat > /etc/systemd/system/dsh-mobile-cert-renew.timer <<'DSH_MOBILE_CERT_TIMER'
[Unit]
Description=Daily DSH Mobile public IP TLS certificate renewal check

[Timer]
OnCalendar=daily
RandomizedDelaySec=2h
Persistent=true
Unit=dsh-mobile-cert-renew.service

[Install]
WantedBy=timers.target
DSH_MOBILE_CERT_TIMER
check certificate ok "Let's Encrypt 公网 IP 证书已安装并启用每日自动续期。"
` : ''
  return `#!/bin/sh
set -eu
umask 077

fail() { echo "DSH_MOBILE_CHECK remote-command error $1" >&2; exit 1; }
check() { echo "DSH_MOBILE_CHECK $1 $2 $3"; }

# Serialize concurrent deploys: two writers racing sed -i on the Caddyfile
# can duplicate the import line and break validation. Uninstall takes the
# same lock, so deploy and cleanup also exclude each other.
if command -v flock >/dev/null 2>&1; then
  exec 9>/tmp/dsh-mobile-deploy.lock
  flock -n 9 || fail "已有部署或清理正在进行，请稍后再试。"
fi

[ "$(id -u)" = "0" ] || fail "请使用 root SSH 账号。"
command -v systemctl >/dev/null 2>&1 || fail "VPS 不支持 systemd。"
command -v tar >/dev/null 2>&1 || fail "VPS 缺少 tar。"
command -v curl >/dev/null 2>&1 || fail "VPS 缺少 curl。"
command -v sha256sum >/dev/null 2>&1 || fail "VPS 缺少 sha256sum。"
command -v useradd >/dev/null 2>&1 || fail "VPS 缺少 useradd。"

if [ -r /etc/os-release ]; then . /etc/os-release; else fail "无法识别 VPS 系统。"; fi
case "\${ID:-}" in
  debian|ubuntu) ;;
  *) fail "首版 VPS 部署只支持 Debian/Ubuntu。" ;;
esac
check os ok "\${PRETTY_NAME:-Debian/Ubuntu}"

if command -v ss >/dev/null 2>&1 && ss -ltnH | awk '{print $4}' | grep -Eq '(^|:)${String(settings.serverPort)}$'; then
  systemctl is-active --quiet dsh-mobile-frps.service || fail "端口 ${String(settings.serverPort)} 已被占用。"
fi

if ! command -v caddy >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  # A previous interrupted run may have left these files unreadable because
  # the deployment uses umask 077. APT reads repositories as the _apt user.
  chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
  chmod 0644 /etc/apt/sources.list.d/caddy-stable.list 2>/dev/null || true
  apt-get update
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
  chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi
check caddy ok "Caddy 已安装。"

# The site lives in our own snippet file; the main Caddyfile only gains one
# import line, so existing user content is never rewritten or merged.
caddy_import='${FRP_CADDY_IMPORT_LINE}'
install -d -m 0755 /etc/caddy
caddyfile_ready=false
if [ ! -e /etc/caddy/Caddyfile ]; then
  printf '%s\n' "$caddy_import" > /etc/caddy/Caddyfile
  chmod 0644 /etc/caddy/Caddyfile
  caddyfile_ready=true
elif grep -Eq '^[[:space:]]*import[[:space:]]+/etc/caddy/dsh-mobile-dsh\.caddy([[:space:]]|$)' /etc/caddy/Caddyfile; then
  # The snippet may carry global options (IP mode default_sni), which must
  # precede all site blocks after import inlining: rebuild the file with a
  # single import on top. Removal uses grep -v with the exact gate pattern
  # above (not sed -i, whose in-place delete proved unreliable here), and the
  # result is verified to carry exactly one import before replacing the file.
  {
    printf '%s\n' "$caddy_import"
    grep -Ev '^[[:space:]]*import[[:space:]]+/etc/caddy/dsh-mobile-dsh\.caddy([[:space:]]|$)' /etc/caddy/Caddyfile || true
  } > /etc/caddy/Caddyfile.dsh-new
  [ "$(grep -Ec '^[[:space:]]*import[[:space:]]+/etc/caddy/dsh-mobile-dsh\.caddy([[:space:]]|$)' /etc/caddy/Caddyfile.dsh-new)" = 1 ] \
    || fail "Caddyfile import 整理失败，未做任何修改。"
  cat /etc/caddy/Caddyfile.dsh-new > /etc/caddy/Caddyfile
  rm -f /etc/caddy/Caddyfile.dsh-new
  chmod 0644 /etc/caddy/Caddyfile
  caddyfile_ready=true
elif [ ! -s /etc/caddy/Caddyfile ]; then
  printf '%s\n' "$caddy_import" > /etc/caddy/Caddyfile
  chmod 0644 /etc/caddy/Caddyfile
  caddyfile_ready=true
elif grep -q '^# DSH Mobile removed its site' /etc/caddy/Caddyfile; then
  # Leftover placeholder from our own uninstall: drop only that line, then
  # ensure the import exists exactly once (same grep -v + count discipline).
  grep -Ev '^# DSH Mobile removed its site.*$' /etc/caddy/Caddyfile > /etc/caddy/Caddyfile.dsh-new || true
  grep -Eq '^[[:space:]]*import[[:space:]]+/etc/caddy/dsh-mobile-dsh\.caddy([[:space:]]|$)' /etc/caddy/Caddyfile.dsh-new \
    || printf '%s\n' "$caddy_import" >> /etc/caddy/Caddyfile.dsh-new
  [ "$(grep -Ec '^[[:space:]]*import[[:space:]]+/etc/caddy/dsh-mobile-dsh\.caddy([[:space:]]|$)' /etc/caddy/Caddyfile.dsh-new)" = 1 ] \
    || fail "Caddyfile import 整理失败，未做任何修改。"
  cat /etc/caddy/Caddyfile.dsh-new > /etc/caddy/Caddyfile
  rm -f /etc/caddy/Caddyfile.dsh-new
  chmod 0644 /etc/caddy/Caddyfile
  caddyfile_ready=true
else
  caddy_hash="$(sha256sum /etc/caddy/Caddyfile | awk '{print $1}')"
  if [ "$caddy_hash" = '66177d46fa761acb07208065db9b0274cb1b12c02ac43b9bfc9857b698b1ccfe' ]; then
    printf '%s\n' "$caddy_import" > /etc/caddy/Caddyfile
    chmod 0644 /etc/caddy/Caddyfile
    caddyfile_ready=true
  elif grep -q '^# Managed by DSH Mobile$' /etc/caddy/Caddyfile; then
    # Legacy whole-file layout: the entire file is ours by construction.
    printf '%s\n' "$caddy_import" > /etc/caddy/Caddyfile
    chmod 0644 /etc/caddy/Caddyfile
    caddyfile_ready=true
  elif grep -q '^:80[[:space:]]*{' /etc/caddy/Caddyfile \
    && grep -q 'root [*] /usr/share/caddy' /etc/caddy/Caddyfile \
    && grep -q '^[[:space:]]*file_server[[:space:]]*$' /etc/caddy/Caddyfile; then
    printf '%s\n' "$caddy_import" > /etc/caddy/Caddyfile
    chmod 0644 /etc/caddy/Caddyfile
    caddyfile_ready=true
  fi
fi
if [ "$caddyfile_ready" != true ]; then
  fail "已有 Caddyfile，请先备份，然后加一行 ${FRP_CADDY_IMPORT_LINE}，或手动合并站点。"
fi

${ipCertificateSetup}

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) url=${shellQuote(amd64.url)}; expected=${shellQuote(amd64.sha256)}; directory=${shellQuote(amd64.directory)} ;;
  aarch64|arm64) url=${shellQuote(arm64.url)}; expected=${shellQuote(arm64.sha256)}; directory=${shellQuote(arm64.directory)} ;;
  *) fail "只支持 Linux x86_64 和 arm64。" ;;
esac

tmp="$(mktemp -d /tmp/dsh-mobile-frp.XXXXXX)"
cleanup() { rm -rf "$tmp"; [ -z "\${DSH_MOBILE_FRP_ARCHIVE:-}" ] || rm -f "$DSH_MOBILE_FRP_ARCHIVE"; }
trap cleanup EXIT HUP INT TERM
archive="$tmp/frp.tar.gz"
if [ -n "\${DSH_MOBILE_FRP_ARCHIVE:-}" ]; then
  [ -f "$DSH_MOBILE_FRP_ARCHIVE" ] || fail "上传的 frps 安装包不存在。"
  cp "$DSH_MOBILE_FRP_ARCHIVE" "$archive"
else
  curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "$url"
fi
actual="$(sha256sum "$archive" | awk '{print $1}')"
[ "$actual" = "$expected" ] || fail "frps 下载校验失败。"
tar -xzf "$archive" -C "$tmp" "$directory/frps"

install -d -m 0755 /usr/local/libexec/dsh-mobile/frp/${FRP_VERSION}
install -m 0755 "$tmp/$directory/frps" /usr/local/libexec/dsh-mobile/frp/${FRP_VERSION}/frps
# The account must exist before anything references its group below.
dsh_mobile_created=false
if ! id -u dsh-mobile >/dev/null 2>&1; then
  useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin --no-create-home dsh-mobile
  dsh_mobile_created=true
fi
install -d -m 0750 -o root -g dsh-mobile /etc/dsh-mobile
if [ "$dsh_mobile_created" = true ]; then
  # Ownership record: uninstall removes the account only when this deployment created it.
  touch /etc/dsh-mobile/.owns-account
  check account ok "已创建 dsh-mobile 系统用户。"
else
  check account ok "复用已有的 dsh-mobile 系统用户（卸载时将保留）。"
fi
cat > /etc/dsh-mobile/frps.toml <<'DSH_MOBILE_FRPS_CONFIG'
${config}DSH_MOBILE_FRPS_CONFIG
chown root:dsh-mobile /etc/dsh-mobile/frps.toml
chmod 0640 /etc/dsh-mobile/frps.toml

cat > /etc/systemd/system/dsh-mobile-frps.service <<'DSH_MOBILE_FRPS_UNIT'
[Unit]
Description=DSH Mobile self-hosted FRP server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dsh-mobile
Group=dsh-mobile
ExecStart=/usr/local/libexec/dsh-mobile/frp/${FRP_VERSION}/frps -c /etc/dsh-mobile/frps.toml
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict

[Install]
WantedBy=multi-user.target
DSH_MOBILE_FRPS_UNIT

cat > ${FRP_CADDY_SNIPPET_PATH} <<'DSH_MOBILE_CADDY_SNIPPET'
${caddySnippet}DSH_MOBILE_CADDY_SNIPPET
chmod 0644 ${FRP_CADDY_SNIPPET_PATH}
caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
# Restart (not just start) so a redeploy over a running previous generation
# actually picks up the new frps token and config instead of keeping the old
# process alive with stale credentials.
systemctl enable dsh-mobile-frps.service
systemctl restart dsh-mobile-frps.service
systemctl enable --now caddy.service
${publicIp ? 'systemctl enable --now dsh-mobile-cert-renew.timer' : ''}
systemctl reload caddy.service || systemctl restart caddy.service

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  ufw allow ${String(settings.serverPort)}/tcp comment 'DSH Mobile FRP control' >/dev/null
  ufw allow 80/tcp comment 'DSH Mobile HTTPS redirect' >/dev/null
  ufw allow 443/tcp comment 'DSH Mobile HTTPS' >/dev/null
  check firewall ok "UFW 已放行 FRP 控制端口和 HTTPS。"
else
  check firewall warning "未修改系统防火墙；请确认 ${String(settings.serverPort)}/tcp、80/tcp、443/tcp 已放行。"
fi

systemctl is-active --quiet dsh-mobile-frps.service || fail "frps 服务启动失败。"
systemctl is-active --quiet caddy.service || fail "Caddy 服务启动失败。"
check frps ok "frps ${FRP_VERSION} 已启动，7080 仅绑定回环地址。"
check caddy ok "Caddy 已加载 ${publicHost}。"
echo DSH_MOBILE_DEPLOYMENT_OK
`
}

async function runProcess(command: string, args: readonly string[], stdin?: string, timeoutMs = SSH_TIMEOUT_MS): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString('utf8')}`.slice(-MAX_OUTPUT_BYTES)
    const timer = setTimeout(() => { child.kill(); rejectRun(new VpsSshError('vps_ssh_timeout', stdout, stderr)) }, timeoutMs)
    timer.unref()
    child.stdout.on('data', chunk => { stdout = append(stdout, Buffer.from(chunk)) })
    child.stderr.on('data', chunk => { stderr = append(stderr, Buffer.from(chunk)) })
    child.once('error', error => { clearTimeout(timer); rejectRun(new VpsSshError('vps_ssh_unavailable', stdout, stderr, { cause: error })) })
    child.once('close', code => {
      clearTimeout(timer)
      if (code !== 0) rejectRun(new VpsSshError(stderr.includes('Permission denied') ? 'vps_ssh_auth_failed' : 'vps_deploy_failed', stdout, stderr))
      else resolveRun({ stdout, stderr })
    })
    child.stdin.end(stdin, 'utf8')
  })
}

async function downloadArtifact(artifact: (typeof LINUX_ARTIFACTS)[keyof typeof LINUX_ARTIFACTS], file: string): Promise<number> {
  const curl = process.platform === 'win32' ? 'curl.exe' : 'curl'
  await runProcess(curl, [
    ...(process.platform === 'win32' ? ['--ipv4'] : []),
    '--fail', '--location', '--silent', '--show-error',
    '--connect-timeout', '15', '--max-time', '180',
    '--proto', '=https', '--tlsv1.2', '--output', file, artifact.url,
  ], undefined, 200_000)
  const bytes = await readFile(file)
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('vps_download_hash_mismatch')
  return bytes.byteLength
}

async function defaultRunSsh(
  input: VpsDeploymentInput,
  serverAddress: string,
  script: string,
  knownHostsFile: string,
  log?: VpsDeploymentOptions['log'],
): Promise<{ stdout: string; stderr: string }> {
  const ssh = process.platform === 'win32' ? 'ssh.exe' : 'ssh'
  const scp = process.platform === 'win32' ? 'scp.exe' : 'scp'
  // The server identity is pinned to the user-confirmed fingerprints captured
  // before deployment. Unknown or rotated keys abort instead of being accepted.
  const common = sshSessionOptions(knownHostsFile)
  if (input.sshKeyPath !== undefined) common.push('-i', input.sshKeyPath)
  const target = `${input.sshUser}@${serverAddress}`
  const probe = await runProcess(ssh, [...common, '-p', String(input.sshPort), target, 'uname -m'])
  const architecture = probe.stdout.trim()
  const artifact = architecture === 'x86_64' || architecture === 'amd64'
    ? LINUX_ARTIFACTS.x64
    : architecture === 'aarch64' || architecture === 'arm64' ? LINUX_ARTIFACTS.arm64 : undefined
  if (artifact === undefined) throw new Error('vps_arch_unsupported')
  log?.('architecture', { architecture })
  const localDirectory = await mkdtemp(join(tmpdir(), 'dsh-mobile-frp-'))
  const localArchive = join(localDirectory, 'frp.tar.gz')
  const remoteArchive = `/tmp/dsh-mobile-frp-${randomBytes(12).toString('hex')}.tar.gz`
  try {
    log?.('download-start', { source: 'local', architecture })
    const bytes = await downloadArtifact(artifact, localArchive)
    log?.('download-complete', { source: 'local', bytes })
    const scpResult = await runProcess(scp, [...common, '-P', String(input.sshPort), localArchive, `${target}:${remoteArchive}`])
    log?.('upload-complete', { bytes, stderrBytes: Buffer.byteLength(scpResult.stderr) })
    const remoteCommand = input.sshUser === 'root'
      ? `env DSH_MOBILE_FRP_ARCHIVE=${shellQuote(remoteArchive)} sh -s`
      : `sudo -n env DSH_MOBILE_FRP_ARCHIVE=${shellQuote(remoteArchive)} sh -s`
    return await runProcess(ssh, [...common, '-p', String(input.sshPort), target, remoteCommand], script)
  } finally {
    await rm(localDirectory, { recursive: true, force: true })
  }
}

export async function deployVps(settings: FrpSettings, input: VpsDeploymentInput, options: VpsDeploymentOptions = {}): Promise<VpsDeploymentResult> {
  const serverPort = validateFrpServerPort(settings.serverPort)
  const token = validateFrpToken(settings.token)
  const publicOrigin = validateFrpPublicOrigin(settings.publicOrigin)
  const serverAddress = validateVpsServerTarget(settings.serverAddress)
  const parsedInput = parseVpsDeploymentInput(input)
  if (parsedInput.sshKeyPath !== undefined) {
    const entry = await lstat(parsedInput.sshKeyPath).catch(() => undefined)
    if (entry === undefined || !entry.isFile() || entry.isSymbolicLink()) throw new Error('vps_ssh_key_invalid')
  }
  // Pin the server identity before any authenticated connection: re-scan the
  // host keys now and require every presented key to be user-confirmed, so a
  // rotation between the UI preview and this deployment aborts safely.
  const keyscanOutput = await scanHostKeys(
    { sshUser: parsedInput.sshUser, sshPort: parsedInput.sshPort, sshKeyPath: parsedInput.sshKeyPath },
    serverAddress,
    options,
  )
  const knownHostsBody = buildPinnedKnownHosts(serverAddress, parsedInput.sshPort, keyscanOutput, parsedInput.hostFingerprints)
  options.log?.('host-keys-verified', { serverAddress })
  const runSsh = options.runSsh ?? (async (sshInput, host, scriptBody) => {
    const workDirectory = await mkdtemp(join(tmpdir(), 'dsh-mobile-known-hosts-'))
    try {
      const knownHostsFile = join(workDirectory, 'known_hosts')
      await writeFile(knownHostsFile, knownHostsBody, { encoding: 'utf8', mode: 0o600 })
      return await defaultRunSsh(sshInput, host, scriptBody, knownHostsFile, options.log)
    } finally {
      await rm(workDirectory, { recursive: true, force: true })
    }
  })
  options.log?.('validated', { serverAddress, serverPort, publicOrigin, sshUser: parsedInput.sshUser, sshPort: parsedInput.sshPort, keyProvided: parsedInput.sshKeyPath !== undefined })
  let result: { stdout: string; stderr: string }
  try {
    options.log?.('ssh-start', { serverAddress, sshPort: parsedInput.sshPort })
    result = await runSsh(parsedInput, serverAddress, deploymentScript({ ...settings, serverAddress, serverPort, token, publicOrigin }))
    options.log?.('ssh-complete', { stdoutBytes: Buffer.byteLength(result.stdout), stderrBytes: Buffer.byteLength(result.stderr) })
  } catch (error) {
    if (error instanceof VpsSshError) {
      // Prefer the failed remote check over raw output: the script reports
      // failures through DSH_MOBILE_CHECK lines on either stream, and the raw
      // concatenation would leak protocol framing into the UI.
      const detail = failureDetail(error.stdout, error.stderr, token)
      options.log?.('ssh-failed', { code: error.message, detail: detail || 'no remote output' })
      throw new Error(detail === '' ? error.message : `${error.message}:${detail}`, { cause: error })
    }
    options.log?.('ssh-failed', { code: error instanceof Error ? error.message : 'unknown' })
    throw error
  }
  const checks = parseChecks(result.stdout, result.stderr, token)
  for (const check of checks) options.log?.('remote-check', { id: check.id, status: check.status, detail: check.detail })
  if (!result.stdout.includes('DSH_MOBILE_DEPLOYMENT_OK')) {
    if (checks.length === 0) throw new Error('vps_deploy_failed')
    throw new Error(`vps_deploy_failed:${checks.map(check => check.detail).join(' ')}`)
  }
  return Object.freeze({ version: 1, deployed: true, serverAddress, publicOrigin, checks })
}

export function vpsDeploymentScriptForTesting(settings: FrpSettings): string {
  return deploymentScript(settings)
}

export interface VpsUninstallInput {
  readonly serverPort: unknown
  /** Let's Encrypt certificate name to delete (public-IPv4 mode); omit for domain mode. */
  readonly certName?: unknown
}

export interface VpsUninstallResult {
  readonly version: 1
  readonly removed: boolean
  readonly serverAddress: string
  readonly checks: readonly VpsDeploymentCheck[]
}

function validCertName(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > 253 || !/^[a-z0-9.-]+$/u.test(value)) throw new Error('vps_cert_name_invalid')
  return value.toLowerCase()
}

/**
 * Build a reviewable uninstall script that removes only DSH Mobile-owned
 * server artifacts: its systemd units, config, binaries, venv, renew helper,
 * managed Caddy site, owned UFW rules, and optionally its IP certificate.
 * Existing non-DSH-Mobile Caddy content and firewall rules are never touched.
 */
export function createVpsUninstallScript(input: VpsUninstallInput): string {
  const serverPort = validateFrpServerPort(input.serverPort)
  const certName = validCertName(input.certName)
  const certCleanup = certName === undefined ? '' : `
if [ -x /opt/dsh-mobile/certbot-venv/bin/certbot ]; then
  /opt/dsh-mobile/certbot-venv/bin/certbot delete --cert-name ${shellQuote(certName)} --non-interactive || true
fi
`
  return `#!/bin/sh
# DSH Mobile VPS uninstall. Review before running: only files, services, and
# firewall rules created by the DSH Mobile deployment are removed.
set -eu
umask 077

fail() { echo "DSH_MOBILE_CHECK remote-command error $1" >&2; exit 1; }
check() { echo "DSH_MOBILE_CHECK $1 $2 $3"; }

# Same lock as the deploy script: cleanup and deployment exclude each other
# so their Caddyfile surgeries never interleave.
if command -v flock >/dev/null 2>&1; then
  exec 9>/tmp/dsh-mobile-deploy.lock
  flock -n 9 || fail "已有部署或清理正在进行，请稍后再试。"
fi

[ "$(id -u)" = "0" ] || fail "请使用 root SSH 账号。"
command -v systemctl >/dev/null 2>&1 || fail "VPS 不支持 systemd。"

# Ownership is decided before deleting anything: only an account created by a
# DSH Mobile deployment (marker written at useradd time) may be removed below.
owns_account=false
if [ -f /etc/dsh-mobile/.owns-account ]; then owns_account=true; fi

systemctl disable --now dsh-mobile-cert-renew.timer >/dev/null 2>&1 || true
systemctl disable --now dsh-mobile-frps.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/dsh-mobile-frps.service
rm -f /etc/systemd/system/dsh-mobile-cert-renew.service
rm -f /etc/systemd/system/dsh-mobile-cert-renew.timer
systemctl daemon-reload
check services ok "已停止并删除 dsh-mobile-frps 服务与证书续期定时器。"
${certCleanup}
rm -rf /etc/dsh-mobile
rm -rf /usr/local/libexec/dsh-mobile
rm -rf /opt/dsh-mobile/certbot-venv
rm -f /usr/local/sbin/dsh-mobile-cert-renew
rm -rf /var/lib/caddy/dsh-mobile-certs
rm -f ${FRP_CADDY_SNIPPET_PATH}
check files ok "已删除 DSH Mobile 配置、二进制与证书文件。"

if grep -Eq '^[[:space:]]*import[[:space:]]+/etc/caddy/dsh-mobile-dsh\.caddy([[:space:]]|$)' /etc/caddy/Caddyfile 2>/dev/null; then
  # Rebuild without our import line (grep -v with the gate pattern, verified
  # to remove every copy), keeping all user content byte-identical otherwise.
  grep -Ev '^[[:space:]]*import[[:space:]]+/etc/caddy/dsh-mobile-dsh\.caddy([[:space:]]|$)' /etc/caddy/Caddyfile > /etc/caddy/Caddyfile.dsh-new || true
  if grep -Eq '^[[:space:]]*import[[:space:]]+/etc/caddy/dsh-mobile-dsh\.caddy([[:space:]]|$)' /etc/caddy/Caddyfile.dsh-new; then
    rm -f /etc/caddy/Caddyfile.dsh-new
    fail "Caddyfile import 移除失败，未做任何修改。"
  fi
  cat /etc/caddy/Caddyfile.dsh-new > /etc/caddy/Caddyfile
  rm -f /etc/caddy/Caddyfile.dsh-new
  if [ ! -s /etc/caddy/Caddyfile ]; then
    printf '# DSH Mobile removed its site; the remaining Caddyfile was empty.\n' > /etc/caddy/Caddyfile
    chmod 0644 /etc/caddy/Caddyfile
  fi
  if command -v caddy >/dev/null 2>&1; then
    caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy.service || systemctl restart caddy.service || true
  fi
  check caddy ok "已移除 DSH Mobile 站点引入；其余 Caddy 配置保持原样。"
elif [ -f /etc/caddy/Caddyfile ] && grep -q '^# Managed by DSH Mobile$' /etc/caddy/Caddyfile; then
  # Legacy whole-file layout (pre-snippet releases): the entire file is ours.
  printf '# DSH Mobile removed its site. Restore your own Caddyfile or reinstall the Caddy defaults.\\n' > /etc/caddy/Caddyfile
  chmod 0644 /etc/caddy/Caddyfile
  if command -v caddy >/dev/null 2>&1; then
    caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy.service || systemctl restart caddy.service || true
  fi
  check caddy ok "已清空旧版 DSH Mobile 管理的 Caddy 站点；请按需恢复自己的配置。"
else
  check caddy ok "Caddyfile 非 DSH Mobile 管理，保持原样。"
fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  for rule in $(ufw status numbered 2>/dev/null | grep 'DSH Mobile' | sed -E 's/^\\[ *([0-9]+)\\].*/\\1/' | sort -rn); do
    yes | ufw delete "$rule" >/dev/null 2>&1 || true
  done
  check firewall ok "已删除带 DSH Mobile 标记的 UFW 规则（FRP 控制端口 ${String(serverPort)}、80、443）。"
else
  check firewall ok "UFW 未启用或无需调整。"
fi

if [ "$owns_account" = true ]; then
  if id dsh-mobile >/dev/null 2>&1; then
    if pgrep -u dsh-mobile >/dev/null 2>&1; then
      fail "dsh-mobile 用户仍有运行中的进程，已保留该用户；请先停止相关进程后重试。"
    fi
    userdel dsh-mobile || fail "删除 dsh-mobile 系统用户失败。"
    check account ok "已删除本次部署创建的 dsh-mobile 系统用户。"
  else
    check account ok "dsh-mobile 系统用户已不存在，无需删除。"
  fi
else
  check account ok "dsh-mobile 系统用户非本次部署创建，已保留。"
fi

echo DSH_MOBILE_UNINSTALL_OK
`
}

async function runRemoteScript(
  input: VpsDeploymentInput,
  serverAddress: string,
  script: string,
  environment: Readonly<Record<string, string>>,
  knownHostsFile: string,
  log?: VpsDeploymentOptions['log'],
): Promise<{ stdout: string; stderr: string }> {
  const ssh = process.platform === 'win32' ? 'ssh.exe' : 'ssh'
  const parsedInput = parseVpsDeploymentInput(input)
  const common = sshSessionOptions(knownHostsFile)
  if (parsedInput.sshKeyPath !== undefined) common.push('-i', parsedInput.sshKeyPath)
  const target = `${parsedInput.sshUser}@${serverAddress}`
  const remoteCommand = parsedInput.sshUser === 'root' ? 'sh -s' : 'sudo -n sh -s'
  const envPrefix = Object.entries(environment).map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')
  log?.('uninstall-ssh-start', { serverAddress })
  return await runProcess(ssh, [...common, '-p', String(parsedInput.sshPort), target, `${envPrefix} ${remoteCommand}`.trim()], script)
}

/** Remove DSH Mobile-owned server artifacts over a pinned SSH connection. */
export async function uninstallVps(
  serverAddress: string,
  uninstall: VpsUninstallInput,
  input: VpsDeploymentInput,
  options: VpsDeploymentOptions = {},
): Promise<VpsUninstallResult> {
  const address = validateVpsServerTarget(serverAddress)
  const parsedInput = parseVpsDeploymentInput(input)
  // Identity is verified with a fresh scan immediately before this destructive
  // action: every presented key must still be user-confirmed.
  const keyscanOutput = await scanHostKeys(
    { sshUser: parsedInput.sshUser, sshPort: parsedInput.sshPort, sshKeyPath: parsedInput.sshKeyPath },
    address,
    options,
  )
  const knownHostsBody = buildPinnedKnownHosts(address, parsedInput.sshPort, keyscanOutput, parsedInput.hostFingerprints)
  options.log?.('host-keys-verified', { serverAddress: address })
  const script = createVpsUninstallScript(uninstall)
  options.log?.('uninstall-start', { serverAddress: address })
  const runRemote = options.runRemoteScript ?? (async (sshInput, host, scriptBody) => {
    const workDirectory = await mkdtemp(join(tmpdir(), 'dsh-mobile-known-hosts-'))
    try {
      const knownHostsFile = join(workDirectory, 'known_hosts')
      await writeFile(knownHostsFile, knownHostsBody, { encoding: 'utf8', mode: 0o600 })
      return await runRemoteScript(sshInput, host, scriptBody, {}, knownHostsFile, options.log)
    } finally {
      await rm(workDirectory, { recursive: true, force: true })
    }
  })
  let result: { stdout: string; stderr: string }
  try {
    result = await runRemote(parsedInput, address, script)
  } catch (error) {
    if (error instanceof VpsSshError) {
      // runProcess labels transport failures as deploy errors; relabel them
      // and prefer the failed remote check over raw output (see deployVps).
      const detail = failureDetail(error.stdout, error.stderr, '')
      const code = error.message === 'vps_deploy_failed' ? 'vps_uninstall_failed' : error.message
      options.log?.('uninstall-failed', { code, detail: detail || 'no remote output' })
      throw new Error(detail === '' ? code : `${code}:${detail}`, { cause: error })
    }
    options.log?.('uninstall-failed', { code: error instanceof Error ? error.message : 'unknown' })
    throw error
  }
  const checks = parseChecks(result.stdout, result.stderr, '')
  for (const check of checks) options.log?.('remote-check', { id: check.id, status: check.status, detail: check.detail })
  if (!result.stdout.includes('DSH_MOBILE_UNINSTALL_OK')) {
    if (checks.length === 0) throw new Error('vps_uninstall_failed')
    throw new Error(`vps_uninstall_failed:${checks.map(check => check.detail).join(' ')}`)
  }
  return Object.freeze({ version: 1, removed: true, serverAddress: address, checks })
}
