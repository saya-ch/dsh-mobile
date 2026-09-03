import { execFileText as execFile } from './exec-file.js'
import { lookup } from 'node:dns/promises'

import type { RemoteProvider } from './remote.js'
import { DSH_MOBILE_VERSION, MINIMUM_ANDROID_APP_VERSION } from './version.js'

export type DiagnosticStatus = 'ok' | 'warning' | 'error' | 'info'
export type DiagnosticReason =
  | 'versions-current'
  | 'network-unavailable' | 'network-interface' | 'network-fixed'
  | 'lan-ready' | 'lan-off'
  | 'firewall-ready' | 'firewall-missing' | 'firewall-unknown'
  | 'remote-off' | 'remote-ready' | 'remote-rate-limited' | 'remote-fake-ip' | 'remote-unreachable'
  | 'remote-needs-login' | 'remote-connecting' | 'remote-controller-error'
  | 'phone-network-unknown'

export interface DiagnosticFacts {
  readonly provider?: RemoteProvider
  readonly latencyMs?: number
  readonly interfaceName?: string
  readonly endpointSuffix?: string
  readonly controllerCode?: string
}

/** One user-facing diagnostic result with stable localization data and server fallback copy. */
export interface DiagnosticCheck {
  readonly id: string
  readonly status: DiagnosticStatus
  readonly reason: DiagnosticReason
  readonly facts?: DiagnosticFacts
  readonly label: string
  readonly detail: string
  readonly action?: string
}

/** Runtime facts available without exposing credentials or local file paths. */
export interface DiagnosticSnapshot {
  readonly dshVersion: string
  readonly lan: {
    readonly running: boolean
    readonly origin?: string
    readonly configuredInterface?: string
    readonly interfaceName?: string
    readonly networkError?: string
    readonly port?: number
  }
  readonly remote: {
    readonly provider: RemoteProvider
    readonly running: boolean
    readonly state: string
    readonly origin?: string
    readonly errorCode?: string
  }
}

interface FirewallObservation {
  readonly state: 'ready' | 'missing' | 'unknown' | 'not-applicable'
}

interface RemoteObservation {
  readonly state: 'ready' | 'rate-limited' | 'unreachable' | 'not-applicable'
  readonly latencyMs?: number
  readonly fakeIp?: boolean
}

/** Injectable probes keep diagnostics deterministic in tests. */
export interface DiagnosticProbes {
  readonly firewall?: (port: number | undefined) => Promise<FirewallObservation>
  readonly remote?: (origin: string | undefined) => Promise<RemoteObservation>
}

/** Sanitized diagnostic response copied by the desktop UI. */
export interface ConnectionDiagnostics {
  readonly version: 1
  readonly generatedAt: number
  readonly overall: 'ok' | 'attention' | 'error'
  readonly versions: {
    readonly plugin: string
    readonly dsh: string
    readonly minimumAndroidApp: string
  }
  readonly summary: string
  readonly checks: readonly DiagnosticCheck[]
  readonly report: string
}

const REMOTE_ERROR_GUIDANCE: Readonly<Record<string, string>> = Object.freeze({
  component_missing: '重新安装完整插件包。',
  funnel_permission_required: '继续完成 Tailscale Funnel 授权。',
  funnel_https_required: '继续完成 Tailscale HTTPS 授权。',
  funnel_start_failed: '重新打开授权页并允许 Funnel。',
  funnel_start_timeout: '检查网络后点击“重新连接”。',
  tailscale_dns_missing: '确认 Tailscale 登录仍有效后重新连接。',
  sidecar_launch_failed: '重新安装完整插件包后重试。',
  sidecar_stopped: '点击“重新连接”。',
  sidecar_exited: '点击“重新连接”；仍失败时复制诊断报告。',
  control_channel_failed: '点击“重新连接”。',
  cpolar_component_missing: '先安装 cpolar 官方组件。',
  cpolar_component_invalid: '彻底移除 cpolar 组件后重新安装。',
  cpolar_config_missing: '保存 cpolar Authtoken 后重试。',
  cpolar_config_invalid: '重新保存 cpolar Authtoken。',
  cpolar_start_timeout: '检查网络后点击“重新连接”。',
  cpolar_stopped: '点击“重新连接”。',
  cpolar_exited: '点击“重新连接”；仍失败时复制诊断报告。',
  frp_component_missing: '先安装 FRP 官方组件。',
  frp_component_invalid: '彻底清理 FRP 组件后重新安装。',
  frp_config_missing: '先保存自建 FRP 连接配置。',
  frp_config_verify_failed: '检查服务器地址、端口、Token 和公开域名。',
  frp_vhost_publicly_reachable: '将 frps 的 HTTP vhost 监听限制到 127.0.0.1。',
  frp_vhost_probe_failed: '确认 VPS 地址可解析后重新连接。',
  frp_launch_failed: '重新安装 FRP 官方组件后重试。',
  frp_start_timeout: '确认 frps、Caddy 和域名解析正常后重新连接。',
  frp_discovery_mismatch: '公开域名连接到了另一台电脑，请核对 Caddy 与 frps 配置。',
  frp_discovery_invalid: '公开域名返回了非 DSH Mobile 响应。',
  frp_stopped: '点击“重新连接”。',
  frp_exited: '检查 VPS 配置后重新连接；仍失败时复制诊断报告。',
  gateway_start_failed: '确认 DSH 正在运行后重新连接。',
})

function check(
  id: string,
  status: DiagnosticStatus,
  reason: DiagnosticReason,
  label: string,
  detail: string,
  action?: string,
  facts?: DiagnosticFacts,
): DiagnosticCheck {
  return Object.freeze({ id, status, reason, ...(facts === undefined ? {} : { facts: Object.freeze(facts) }), label, detail, ...(action === undefined ? {} : { action }) })
}

function maskLanOrigin(origin: string | undefined): string {
  if (origin === undefined) return '未分配'
  try {
    const url = new URL(origin)
    const octets = url.hostname.split('.')
    const host = octets.length === 4 ? `${octets[0]}.${octets[1]}.${octets[2]}.x` : '局域网地址'
    return `${url.protocol}//${host}${url.port === '' ? '' : `:${url.port}`}`
  } catch {
    return '地址格式无效'
  }
}

function remoteSuffix(origin: string | undefined): string {
  if (origin === undefined) return '未分配'
  try {
    const hostname = new URL(origin).hostname
    if (hostname.endsWith('.ts.net')) return '*.ts.net'
    for (const suffix of ['.cpolar.cn', '.cpolar.io', '.cpolar.top', '.cpolar.com']) {
      if (hostname.endsWith(suffix)) return `*${suffix}`
    }
    return '公共 HTTPS 地址'
  } catch {
    return '地址格式无效'
  }
}

function defaultFirewallProbe(platform: NodeJS.Platform = process.platform): (port: number | undefined) => Promise<FirewallObservation> {
  return async (port) => {
    if (platform !== 'win32') return { state: 'not-applicable' }
    if (port === undefined) return { state: 'unknown' }
    const script = [
      "$specs = @(@{ Name = 'DSH Mobile HTTPS'; Protocol = 'TCP' }, @{ Name = 'DSH Mobile Discovery'; Protocol = 'UDP' })",
      '$ready = $true',
      '$specs | ForEach-Object {',
      '  $spec = $_',
      "  $rule = Get-NetFirewallRule -DisplayName $spec.Name -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | Select-Object -First 1",
      '  if ($null -eq $rule) { $ready = $false; return }',
      '  $filters = @($rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue)',
      `  $matching = @($filters | Where-Object { $_.Protocol -eq $spec.Protocol -and ($_.LocalPort -eq 'Any' -or $_.LocalPort -eq '${String(port)}') })`,
      '  if ($matching.Count -eq 0) { $ready = $false }',
      '}',
      "if ($ready) { 'ready' } else { 'missing' }",
    ].join('; ')
    try {
      const result = await execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
      })
      return { state: result.stdout.trim() === 'ready' ? 'ready' : 'missing' }
    } catch {
      return { state: 'unknown' }
    }
  }
}

/** Allow remote relays enough time to answer without making diagnostics unbounded. */
export function remoteDiagnosticTimeoutMs(origin: string): number {
  const hostname = new URL(origin).hostname.toLowerCase()
  if (hostname.endsWith('.ts.net') || hostname.includes('.cpolar.')) return 10_000
  return 10_000
}

async function defaultRemoteProbe(origin: string | undefined): Promise<RemoteObservation> {
  if (origin === undefined) return { state: 'not-applicable' }
  const hostname = new URL(origin).hostname
  const started = performance.now()
  try {
    const response = await fetch(new URL('/mobile-access/health', origin), {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(remoteDiagnosticTimeoutMs(origin)),
    })
    const latencyMs = Math.max(0, Math.round(performance.now() - started))
    if (response.status === 429) return { state: 'rate-limited', latencyMs }
    return response.ok ? { state: 'ready', latencyMs } : { state: 'unreachable', latencyMs }
  } catch {
    let fakeIp = false
    try {
      const addresses = await lookup(hostname, { all: true })
      fakeIp = addresses.some(({ address }) => {
        const [first, second] = address.split('.').map(Number)
        return first === 198 && (second === 18 || second === 19)
      })
    } catch {
      // DNS lookup is supplementary; the failed HTTPS probe remains authoritative.
    }
    return { state: 'unreachable', ...(fakeIp ? { fakeIp: true } : {}) }
  }
}

function reportLine(entry: DiagnosticCheck): string {
  return `[${entry.status.toUpperCase()}] ${entry.label}: ${entry.detail}${entry.action === undefined ? '' : ` ${entry.action}`}`
}

/** Run bounded read-only checks and return a report safe to paste into an issue. */
export async function collectConnectionDiagnostics(
  snapshot: DiagnosticSnapshot,
  probes: DiagnosticProbes = {},
): Promise<ConnectionDiagnostics> {
  const checks: DiagnosticCheck[] = []
  const remoteProbe = snapshot.remote.running && snapshot.remote.state === 'ready' && snapshot.remote.origin !== undefined
    ? (probes.remote ?? defaultRemoteProbe)(snapshot.remote.origin)
    : Promise.resolve<RemoteObservation>({ state: 'not-applicable' })
  const [firewall, remoteObservation] = await Promise.all([
    (probes.firewall ?? defaultFirewallProbe())(snapshot.lan.port),
    remoteProbe,
  ])
  checks.push(check(
    'versions',
    'ok',
    'versions-current',
    '版本兼容',
    `插件 ${DSH_MOBILE_VERSION}，DSH ${snapshot.dshVersion}，Android App 最低 ${MINIMUM_ANDROID_APP_VERSION}。`,
  ))

  if (snapshot.lan.networkError !== undefined) {
    checks.push(check('network', 'error', 'network-unavailable', '局域网网卡', '已保存的网卡当前不可用。', '重新运行 dsh-mobile setup。'))
  } else if (snapshot.lan.configuredInterface !== undefined) {
    const interfaceName = snapshot.lan.interfaceName ?? snapshot.lan.configuredInterface
    checks.push(check(
      'network',
      'ok',
      'network-interface',
      '局域网网卡',
      `正在跟随 ${interfaceName}。`,
      undefined,
      { interfaceName },
    ))
  } else {
    checks.push(check('network', 'info', 'network-fixed', '局域网网卡', '当前使用固定网络配置。'))
  }

  if (snapshot.lan.running && snapshot.lan.origin !== undefined) {
    const endpointSuffix = maskLanOrigin(snapshot.lan.origin)
    checks.push(check('lan', 'ok', 'lan-ready', '局域网网关', `已监听 ${endpointSuffix}，配对入口可用。`, undefined, { endpointSuffix }))
  } else {
    checks.push(check('lan', 'info', 'lan-off', '局域网网关', '当前未开启。', '需要手机直连时开启局域网访问。'))
  }

  if (firewall.state === 'ready') {
    checks.push(check('firewall', 'ok', 'firewall-ready', 'Windows 防火墙', '局域网 TCP 与发现规则已启用。'))
  } else if (firewall.state === 'missing') {
    checks.push(check('firewall', 'warning', 'firewall-missing', 'Windows 防火墙', '未找到完整的局域网放行规则。', '以管理员身份重新运行 dsh-mobile setup。'))
  } else if (firewall.state === 'unknown') {
    checks.push(check('firewall', 'info', 'firewall-unknown', 'Windows 防火墙', '系统未允许插件读取防火墙状态。', '若手机找不到电脑，以管理员身份重新运行 setup。'))
  }

  if (!snapshot.remote.running || snapshot.remote.state === 'off') {
    checks.push(check('remote', 'info', 'remote-off', '远程通道', '当前未启用。', undefined, { provider: snapshot.remote.provider }))
  } else if (snapshot.remote.state === 'ready' && snapshot.remote.origin !== undefined) {
    const endpointSuffix = remoteSuffix(snapshot.remote.origin)
    const facts = { provider: snapshot.remote.provider, endpointSuffix, ...(remoteObservation.latencyMs === undefined ? {} : { latencyMs: remoteObservation.latencyMs }) }
    if (remoteObservation.state === 'ready') {
      checks.push(check('remote', 'ok', 'remote-ready', '远程通道', `${snapshot.remote.provider} 公共地址 ${endpointSuffix} 可达，往返约 ${String(remoteObservation.latencyMs ?? 0)} ms。`, undefined, facts))
    } else if (remoteObservation.state === 'rate-limited') {
      checks.push(check('remote', 'warning', 'remote-rate-limited', '远程通道', '公共地址可达，但本次检查观察到服务限流。', '稍后重试；旧会话会按需加载以减少流量。', facts))
    } else if (snapshot.remote.provider === 'tailscale' && remoteObservation.fakeIp === true) {
      checks.push(check(
        'remote',
        'error',
        'remote-fake-ip',
        '远程通道',
        'Tailscale 地址被当前 VPN 或 DNS 代理接管，但 TLS 链路未建立。',
        '切换 VPN 节点或代理模式；仍失败时改用 cpolar。',
        facts,
      ))
    } else {
      checks.push(check('remote', 'error', 'remote-unreachable', '远程通道', '提供方显示已就绪，但公共地址暂不可达。', '点击“重新连接”；仍失败时检查提供方状态。', facts))
    }
  } else if (snapshot.remote.state === 'starting' || snapshot.remote.state === 'connecting' || snapshot.remote.state === 'needs-login') {
    const needsLogin = snapshot.remote.state === 'needs-login'
    checks.push(check(
      'remote',
      'warning',
      needsLogin ? 'remote-needs-login' : 'remote-connecting',
      '远程通道',
      needsLogin ? '等待完成 Tailscale 登录。' : '仍在建立连接。',
      needsLogin ? '返回远程页继续登录。' : '等待片刻后重新检查。',
      { provider: snapshot.remote.provider },
    ))
  } else {
    const controllerCode = snapshot.remote.errorCode ?? snapshot.remote.state
    checks.push(check(
      'remote',
      'error',
      'remote-controller-error',
      '远程通道',
      `连接未建立（${controllerCode}）。`,
      REMOTE_ERROR_GUIDANCE[controllerCode] ?? '返回远程页点击“重新连接”。',
      { provider: snapshot.remote.provider, controllerCode },
    ))
  }

  checks.push(check(
    'phone-network',
    'info',
    'phone-network-unknown',
    '手机网络',
    '电脑无法判断路由器是否隔离了手机。',
    '局域网仍失败时，确认手机与电脑在同一网络，并关闭访客网络或 AP 隔离。',
  ))

  const overall = checks.some(entry => entry.status === 'error')
    ? 'error'
    : checks.some(entry => entry.status === 'warning') ? 'attention' : 'ok'
  const summary = overall === 'ok' ? '连接基础检查正常。' : overall === 'attention' ? '发现需要留意的项目。' : '发现会影响连接的问题。'
  const report = [
    'DSH Mobile 诊断报告',
    `生成时间: ${new Date().toISOString()}`,
    `版本: plugin=${DSH_MOBILE_VERSION}; dsh=${snapshot.dshVersion}; min-app=${MINIMUM_ANDROID_APP_VERSION}`,
    `LAN: ${snapshot.lan.running ? 'on' : 'off'}; endpoint=${maskLanOrigin(snapshot.lan.origin)}`,
    `Remote: provider=${snapshot.remote.provider}; state=${snapshot.remote.state}; endpoint=${remoteSuffix(snapshot.remote.origin)}`,
    ...checks.map(reportLine),
  ].join('\n')
  return Object.freeze({
    version: 1,
    generatedAt: Date.now(),
    overall,
    versions: Object.freeze({ plugin: DSH_MOBILE_VERSION, dsh: snapshot.dshVersion, minimumAndroidApp: MINIMUM_ANDROID_APP_VERSION }),
    summary,
    checks: Object.freeze(checks),
    report,
  })
}
