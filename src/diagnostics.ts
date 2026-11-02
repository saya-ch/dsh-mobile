import { execFileText as execFile } from './exec-file.js'
import { diagnosticFailureStage, probeDiagnosticDns, type DiagnosticDnsContext, type DiagnosticFailureStage, type DiagnosticLookup } from './diagnostic-network-context.js'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { request as proxyRequest } from 'node:http'
import type { Socket } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { connect as tlsConnect } from 'node:tls'

import type { RemoteProvider } from './remote.js'
import { DSH_MOBILE_VERSION, MINIMUM_ANDROID_APP_VERSION } from './version.js'

export type DiagnosticStatus = 'ok' | 'warning' | 'error' | 'info'
export type DiagnosticReason =
  | 'versions-current'
  | 'lan-setup-required' | 'network-unavailable' | 'network-interface' | 'network-fixed'
  | 'lan-ready' | 'lan-off'
  | 'firewall-ready' | 'firewall-missing' | 'firewall-unknown' | 'firewall-inactive'
  | 'remote-off' | 'remote-ready' | 'remote-origin-ready' | 'remote-iroh-ready' | 'remote-rate-limited' | 'remote-fake-ip' | 'remote-unreachable'
  | 'remote-needs-login' | 'remote-connecting' | 'remote-controller-error'
  | 'remote-service-ready' | 'remote-tailnet-shadowed'
  | 'dns-public' | 'dns-tailnet' | 'dns-fake-ip' | 'dns-private' | 'dns-mixed' | 'dns-unknown'
  | 'remote-dns-failed' | 'remote-connect-failed' | 'remote-tls-failed' | 'remote-probe-timeout' | 'remote-http-failed'
  | 'competing-remote-channel'
  | 'plugin-inspection-unavailable'
  | 'phone-network-unknown'

export interface DiagnosticFacts {
  readonly provider?: RemoteProvider
  readonly latencyMs?: number
  readonly interfaceName?: string
  readonly endpointSuffix?: string
  readonly controllerCode?: string
  /** The reachability answer came from the machine's configured relay egress. */
  readonly viaProxy?: boolean
  readonly dnsKind?: DiagnosticDnsContext['kind']
  readonly dnsFamily?: DiagnosticDnsContext['family']
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
  /** Which side supplied evidence; a computer check is never phone acceptance. */
  readonly scope?: 'configuration' | 'computer' | 'phone'
}

/** Runtime facts available without exposing credentials or local file paths. */
export interface DiagnosticSnapshot {
  readonly dshVersion: string
  /** Another plugin injects a remote transport before the DSH client boots. */
  readonly competingRemoteChannelBoot?: boolean
  /** An optional index-injection observation failed; do not conclude that no competing script exists. */
  readonly indexInspectionUnavailable?: boolean
  readonly lan: {
    readonly configured?: boolean
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
  readonly viaProxy?: boolean
  readonly dns?: DiagnosticDnsContext
  readonly failureStage?: DiagnosticFailureStage
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
  readonly coverage: { readonly measuredFrom: 'computer'; readonly unverified: readonly string[] }
}

/** Recognize the active remote-web-ui boot hook without evaluating or modifying it. */
export function hasCompetingRemoteChannelBoot(rows: readonly { readonly kind: string; readonly text?: string }[]): boolean {
  return rows.some(row => row.kind === 'script' && row.text?.includes('__DSH_REMOTE_CHANNEL_BOOT__') === true)
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
  cloudflared_component_missing: '先安装 cloudflared 官方组件。',
  cloudflared_component_invalid: '彻底移除 cloudflared 组件后重新安装。',
  cloudflared_port_unavailable: '无法分配本机远程网关端口，请重试。',
  cloudflared_launch_failed: '重新安装 cloudflared 官方组件后重试。',
  cloudflared_start_timeout: '检查网络后点击“重新连接”。',
  cloudflared_stopped: '点击“重新连接”。',
  cloudflared_exited: '点击“重新连接”；仍失败时复制诊断报告。',
  cloudflared_invalid_output: 'cloudflared 返回了无法识别的状态。',
  cloudflared_invalid_origin: 'cloudflared 返回的公网地址未通过校验。',
  origin_config_missing: '先保存自有反向代理配置。',
  origin_config_invalid: '重新保存自有反向代理配置。',
  origin_listen_port_in_use: '更换 HTTP 后端端口；不要使用局域网的 3443、DSH 自身的 3080，或已被 cloudflared 隧道占用的 3444。',
  origin_listen_address_unavailable: '监听地址不属于当前电脑，请重新选择本机的私网 IPv4 地址。',
  origin_gateway_start_failed: '检查 HTTP 后端监听地址和端口后重新连接。',
  frp_component_missing: '先安装 FRP 官方组件。',
  frp_component_invalid: '彻底清理 FRP 组件后重新安装。',
  frp_config_missing: '先保存自建 FRP 连接配置。',
  frp_config_verify_failed: '检查服务器地址、端口、Token 和公开域名。',
  frp_vhost_publicly_reachable: '将 frps 的 HTTP vhost 监听限制到 127.0.0.1。',
  frp_vhost_probe_failed: '确认 VPS 地址可解析后重新连接。',
  frp_launch_failed: '重新安装 FRP 官方组件后重试。',
  frp_start_timeout: '确认 frps、Caddy 和域名解析正常后重新连接。',
  frp_proxy_name_in_use: '该 frps 上已有同名代理：在另一台 DSH 电脑上关闭自建 FRP，或在 frps 上清掉该代理后重新连接。',
  frp_remote_port_in_use: '公网入口端口被其他代理占用：改用其他入口端口后重新连接。',
  frp_proxy_start_failed: '查看 frps 日志与 allowPorts，确认它能接受该代理名和入口端口。',
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
  const scope = id === 'versions' ? 'configuration' : id === 'phone-network' ? 'phone' : 'computer'
  return Object.freeze({ id, status, reason, scope, ...(facts === undefined ? {} : { facts: Object.freeze(facts) }), label, detail, ...(action === undefined ? {} : { action }) })
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
    if (hostname.endsWith('.trycloudflare.com')) return '*.trycloudflare.com'
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

/** Reserve one six-second window per egress so the desktop's 15-second request can finish. */
export function remoteDiagnosticTimeoutMs(_origin: string): number {
  return 6_000
}

interface RemoteHealthObservation {
  readonly status: number
  readonly latencyMs: number
}

/** One tunnel attempt through the machine's configured HTTP relay egress. */
export type ProxyHealthTunnel = (target: URL, proxy: URL, budgetMs: number) => Promise<RemoteHealthObservation>

/** Raw observation from the direct (default) path, checked before any relay. */
export type DirectHealthProbe = (target: URL, budgetMs: number) => Promise<RemoteObservation>

const TUNNEL_HEADER_LIMIT_BYTES = 64 * 1024

function proxyExcludedByNoProxy(target: URL, raw: string): boolean {
  const text = raw.trim().toLowerCase()
  if (text === '') return false
  const hostname = target.hostname.toLowerCase()
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const targetPort = target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port)
  for (const entry of text.split(/[\s,]+/)) {
    let value = entry
    if (value === '') continue
    if (value === '*') return true
    if (value.includes('/')) continue
    let port: number | undefined
    if (value.startsWith('[')) {
      const bracket = value.indexOf(']')
      if (bracket < 0) continue
      const tail = value.slice(bracket + 1)
      if (tail !== '') {
        if (!/^:\d+$/u.test(tail)) continue
        port = Number(tail.slice(1))
      }
      value = value.slice(1, bracket)
    } else if ((value.match(/:/gu) ?? []).length === 1) {
      const separator = value.lastIndexOf(':')
      const suffix = value.slice(separator + 1)
      if (!/^\d+$/u.test(suffix)) continue
      port = Number(suffix)
      value = value.slice(0, separator)
    }
    if (port !== undefined && port !== targetPort) continue
    if (value.startsWith('*.')) value = value.slice(2)
    else if (value.startsWith('.')) value = value.slice(1)
    if (value === '') continue
    if (host === value || host.endsWith(`.${value}`)) return true
  }
  return false
}

/**
 * Resolve the relay egress configured in the environment for `origin`.
 *
 * Honors `HTTPS_PROXY` (then `ALL_PROXY`, then the generic `HTTP_PROXY`) for an
 * HTTPS target, and `http_proxy`/`HTTP_PROXY`/`ALL_PROXY` for a plain one, unless
 * `NO_PROXY`/`no_proxy` covers the host. Only a plain `http://<host>:<port>`
 * relay is usable: SOCKS or a TLS-to-proxy configuration would need a different
 * tunnel, so absent that the probe keeps its direct semantics.
 */
export function configuredProxyFor(origin: string, env: NodeJS.ProcessEnv = process.env): URL | undefined {
  let target: URL
  try {
    target = new URL(origin)
  } catch {
    return undefined
  }
  if (proxyExcludedByNoProxy(target, env.NO_PROXY ?? env.no_proxy ?? '')) return undefined
  const isHttps = target.protocol === 'https:'
  const candidates = isHttps
    ? [env.https_proxy ?? env.HTTPS_PROXY, env.all_proxy ?? env.ALL_PROXY, env.http_proxy ?? env.HTTP_PROXY]
    : [env.http_proxy ?? env.HTTP_PROXY, env.all_proxy ?? env.ALL_PROXY]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    try {
      const proxy = new URL(candidate.trim())
      if (proxy.protocol !== 'http:' || proxy.hostname === '') continue
      return proxy
    } catch {
      continue
    }
  }
  return undefined
}

/** One reachability probe through an HTTP relay: CONNECT, TLS, then a status line. */
export async function relayProbeThroughProxy(target: URL, proxy: URL, budgetMs = remoteDiagnosticTimeoutMs(target.origin)): Promise<RemoteHealthObservation> {
  const started = performance.now()
  return new Promise<RemoteHealthObservation>((resolve, reject) => {
    let settled = false
    let hopRequest: ClientRequest | undefined
    let rawSocket: Socket | undefined
    let secureSocket: TLSSocket | undefined
    let timer: NodeJS.Timeout | undefined
    const finish = (outcome: { readonly value?: RemoteHealthObservation; readonly error?: Error }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      secureSocket?.destroy()
      rawSocket?.end()
      rawSocket?.destroy()
      hopRequest?.destroy()
      if (outcome.error !== undefined) reject(outcome.error)
      else resolve(outcome.value ?? { status: 0, latencyMs: 0 })
    }
    timer = setTimeout(() => { finish({ error: new Error('proxy_tunnel_timeout') }) }, Math.max(1, budgetMs))
    timer.unref()
    // The CONNECT target must always carry an explicit port: a bare hostname is
    // resolved by the relay against its own default (port 80), which answers
    // plaintext and breaks the TLS handshake with a wrong-version error.
    const hopPort = target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port)
    const hopPath = `${target.hostname}:${hopPort}`
    const headers: Record<string, string> = { host: hopPath, 'proxy-connection': 'keep-alive' }
    if (proxy.username !== '') {
      headers['proxy-authorization'] = `Basic ${Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
        'utf8',
      ).toString('base64')}`
    }
    hopRequest = proxyRequest({
      host: proxy.hostname,
      port: proxy.port === '' ? 80 : Number(proxy.port),
      method: 'CONNECT',
      path: hopPath,
      headers,
      agent: false,
    })
    hopRequest.once('connect', (response: IncomingMessage, socket: Socket) => {
      if (settled) { socket.destroy(); return }
      rawSocket = socket
      if (response.statusCode !== 200) {
        finish({ error: new Error(`proxy_tunnel_rejected_${response.statusCode ?? 'unknown'}`) })
        return
      }
      const secure = tlsConnect({
        socket,
        servername: target.hostname,
        rejectUnauthorized: true,
      })
      secureSocket = secure
      secure.once('secureConnect', () => {
        if (settled) return
        secure.write([
          `GET ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${target.host}`,
          'User-Agent: dsh-mobile-diagnostics',
          'Accept-Encoding: identity',
          'Connection: close',
          '',
          '',
        ].join('\r\n'))
      })
      let buffered = Buffer.alloc(0)
      secure.on('data', (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk])
        if (buffered.byteLength > TUNNEL_HEADER_LIMIT_BYTES) {
          finish({ error: new Error('proxy_tunnel_oversized_response') })
          return
        }
        const end = buffered.indexOf('\r\n\r\n')
        if (end < 0) return
        const statusLine = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/u.exec(buffered.subarray(0, end).toString('latin1'))?.[1]
        const status = Number.parseInt(statusLine ?? '', 10)
        if (!Number.isSafeInteger(status) || status < 100) {
          finish({ error: new Error('proxy_tunnel_invalid_response') })
          return
        }
        finish({ value: { status, latencyMs: Math.max(0, Math.round(performance.now() - started)) } })
      })
      secure.once('error', (error: Error) => { finish({ error }) })
      secure.once('close', () => { finish({ error: new Error('proxy_tunnel_closed') }) })
    })
    hopRequest.once('error', (error: Error) => { finish({ error }) })
    hopRequest.end()
  })
}

async function fetchRemoteHealth(target: URL, budgetMs: number): Promise<RemoteObservation> {
  const started = performance.now()
  try {
    const response = await fetch(target, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, budgetMs - 500)),
    })
    const latencyMs = Math.max(0, Math.round(performance.now() - started))
    if (response.status === 429) { await response.body?.cancel(); return { state: 'rate-limited', latencyMs } }
    const observation: RemoteObservation = response.ok ? { state: 'ready', latencyMs } : { state: 'unreachable', latencyMs, failureStage: 'http' }
    await response.body?.cancel()
    return observation
  } catch (error) {
    return { state: 'unreachable', failureStage: diagnosticFailureStage(error) }
  }
}

/** Explicit test seams: environment, the direct attempt, and the relay attempt. */
export interface RemoteHealthProbeOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly direct?: DirectHealthProbe
  readonly tunnel?: ProxyHealthTunnel
  readonly lookup?: DiagnosticLookup
}

/**
 * Answer "is the public endpoint reachable" from the machine's own egress.
 *
 * A direct attempt stays authoritative first. When it fails and the environment
 * configures an HTTP relay that `NO_PROXY` does not exclude, one tunnelled
 * attempt runs: a self-managed Funnel origin otherwise resolves to this
 * machine's tailnet address, where nothing serves the funnel port locally, so
 * the direct measurement reports an outage while the relay's egress — the same
 * public path a phone takes — still succeeds. When both fail, the original
 * direct observation (including its Fake-IP context) stands unchanged.
 */
export async function probeRemoteHealth(
  origin: string | undefined,
  options: RemoteHealthProbeOptions = {},
): Promise<RemoteObservation> {
  if (origin === undefined) return { state: 'not-applicable' }
  let target: URL
  try {
    target = new URL('/mobile-access/health', origin)
  } catch {
    return { state: 'not-applicable' }
  }
  const budgetMs = remoteDiagnosticTimeoutMs(origin)
  const direct = options.direct ?? fetchRemoteHealth
  const [observed, dns] = await Promise.all([
    direct(target, budgetMs),
    options.direct !== undefined && options.lookup === undefined ? undefined : probeDiagnosticDns(target.hostname, Math.min(750, budgetMs), options.lookup),
  ])
  const context = dns === undefined ? {} : { dns }
  const observation: RemoteObservation = { ...observed, ...context, ...(dns?.kind === 'fake-ip' ? { fakeIp: true } : {}) }
  if (observation.state !== 'unreachable') return observation
  const relay = configuredProxyFor(origin, options.env ?? process.env)
  if (relay === undefined) return observation
  const tunnel = options.tunnel ?? relayProbeThroughProxy
  try {
    const { status, latencyMs } = await tunnel(target, relay, budgetMs)
    if (status === 429) return { state: 'rate-limited', latencyMs, viaProxy: true, ...context }
    return status >= 200 && status < 300
      ? { state: 'ready', latencyMs, viaProxy: true, ...context }
      : observation
  } catch {
    return observation
  }
}

async function defaultRemoteProbe(origin: string | undefined): Promise<RemoteObservation> {
  return probeRemoteHealth(origin)
}

function reportLine(entry: DiagnosticCheck): string {
  return `[${entry.status.toUpperCase()}][${entry.scope}] ${entry.label}: ${entry.detail}${entry.action === undefined ? '' : ` ${entry.action}`}`
}

/** Run bounded read-only checks and return a report safe to paste into an issue. */
export async function collectConnectionDiagnostics(
  snapshot: DiagnosticSnapshot,
  probes: DiagnosticProbes = {},
): Promise<ConnectionDiagnostics> {
  const checks: DiagnosticCheck[] = []
  const remoteProbe = snapshot.remote.provider !== 'origin' && snapshot.remote.provider !== 'iroh' && snapshot.remote.running && snapshot.remote.state === 'ready' && snapshot.remote.origin !== undefined
    ? (probes.remote ?? defaultRemoteProbe)(snapshot.remote.origin)
    : Promise.resolve<RemoteObservation>({ state: 'not-applicable' })
  const [firewall, remoteObservation] = await Promise.all([
    snapshot.lan.running ? (probes.firewall ?? defaultFirewallProbe())(snapshot.lan.port) : Promise.resolve<FirewallObservation>({ state: 'not-applicable' }),
    remoteProbe,
  ])
  checks.push(check(
    'versions',
    'ok',
    'versions-current',
    '版本信息',
    `插件 ${DSH_MOBILE_VERSION}，DSH ${snapshot.dshVersion}，Android App 最低 ${MINIMUM_ANDROID_APP_VERSION}。`,
  ))

  if (snapshot.competingRemoteChannelBoot === true) {
    checks.push(check(
      'remote-plugin-conflict', 'warning', 'competing-remote-channel', '第三方远程插件',
      '检测到另一套远程请求通道脚本；手机页面可能进入该插件自己的配对流程。',
      '在电脑端关闭 dsh-remote-web-ui 的远程访问后刷新，再使用 DSH Mobile 当前二维码配对；不要混用两种配对码。',
    ))
  }
  if (snapshot.indexInspectionUnavailable === true) {
    checks.push(check('plugin-inspection', 'warning', 'plugin-inspection-unavailable', '页面脚本检查',
      '本次未能检查活动页面脚本；不能据此认定不存在其他远程通道。', '其余网络项目独立检查；保留复现环境并核对相关插件。'))
  }

  if (snapshot.lan.configured === false) {
    checks.push(check('network', snapshot.lan.running ? 'error' : 'info', 'lan-setup-required', '局域网配置', '尚未完成局域网初始化。', '需要局域网连接时，返回局域网页选择网卡并完成配置。'))
  } else if (snapshot.lan.networkError !== undefined) {
    checks.push(check('network', snapshot.lan.running ? 'error' : 'info', 'network-unavailable', '局域网网卡', '已保存的网卡当前不可用。', snapshot.lan.running ? '在局域网页重新确认网卡配置。' : '局域网未启用；此配置不用于判断远程入口。'))
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
    checks.push(check('lan', 'ok', 'lan-ready', '局域网网关', `电脑网关已监听 ${endpointSuffix}；尚未验证手机能否到达。`, undefined, { endpointSuffix }))
  } else {
    checks.push(check('lan', 'info', 'lan-off', '局域网网关', '当前未开启。', '需要手机直连时开启局域网访问。'))
  }

  if (!snapshot.lan.running) {
    checks.push(check('firewall', 'info', 'firewall-inactive', 'Windows 防火墙', '局域网未启用，本次未检查局域网防火墙规则。', '不据此判断远程入口；需要局域网时再启用并检查。'))
  } else if (firewall.state === 'ready') {
    checks.push(check('firewall', 'ok', 'firewall-ready', 'Windows 防火墙', '局域网 TCP 与发现规则已启用。'))
  } else if (firewall.state === 'missing') {
    checks.push(check('firewall', snapshot.lan.running ? 'warning' : 'info', 'firewall-missing', 'Windows 防火墙', '未找到完整的局域网放行规则。', snapshot.lan.running ? '确认需要局域网连接，再检查相应规则；不要关闭整个防火墙。' : '局域网未启用，不据此判断远程入口失败。'))
  } else if (firewall.state === 'unknown') {
    checks.push(check('firewall', 'info', 'firewall-unknown', 'Windows 防火墙', '系统未允许插件读取防火墙状态。', '若手机找不到电脑，以管理员身份重新运行 setup。'))
  }

  if (snapshot.remote.running && snapshot.remote.state === 'ready') {
    checks.push(check('remote-service', 'ok', 'remote-service-ready', '本机通道状态', '提供方报告本机组件已就绪；不代表公网或手机路径已验证。', undefined, { provider: snapshot.remote.provider }))
  }
  if (remoteObservation.dns !== undefined) {
    const kind = remoteObservation.dns.kind
    checks.push(check('remote-dns', kind === 'fake-ip' ? 'warning' : 'info', `dns-${kind}`, '系统 DNS', `电脑系统解析分类：${kind}；IP：${remoteObservation.dns.family}。未查询公共 DNS，地址不写入报告。`, undefined, { dnsKind: kind, dnsFamily: remoteObservation.dns.family }))
  }
  if (!snapshot.remote.running || snapshot.remote.state === 'off') {
    checks.push(check('remote', 'info', 'remote-off', '远程通道', '当前未启用。', undefined, { provider: snapshot.remote.provider }))
  } else if (snapshot.remote.provider === 'origin' && snapshot.remote.state === 'ready') {
    checks.push(check('remote', 'info', 'remote-origin-ready', '远程通道',
      '私网 HTTP 后端已就绪；未检测公网 HTTPS、证书或 WebSocket 连通性。',
      '在手机上经反向代理验证连接；代理须保留原始 Host（含端口）并支持 WebSocket。',
      { provider: 'origin' }))
  } else if (snapshot.remote.provider === 'iroh' && snapshot.remote.state === 'ready') {
    checks.push(check('remote', 'info', 'remote-iroh-ready', '远程通道',
      'iroh 通道已就绪；端点身份为回环 TLS，不从电脑端探测手机可达性。',
      '在手机上用配对二维码验证连接；二维码过期或通道报错时重新生成并重连。',
      { provider: 'iroh' }))
  } else if (snapshot.remote.state === 'ready' && snapshot.remote.origin !== undefined) {
    const endpointSuffix = remoteSuffix(snapshot.remote.origin)
    const facts = {
      provider: snapshot.remote.provider,
      endpointSuffix,
      ...(remoteObservation.latencyMs === undefined ? {} : { latencyMs: remoteObservation.latencyMs }),
      ...(remoteObservation.viaProxy === true ? { viaProxy: true as const } : {}),
    }
    if (remoteObservation.state === 'ready') {
      checks.push(check(
        'remote',
        remoteObservation.viaProxy === true ? 'warning' : 'ok',
        'remote-ready',
        '远程通道',
        remoteObservation.viaProxy === true
          ? `电脑经代理可访问 ${endpointSuffix}，但尚未验证手机能否连接。`
          : `电脑当前出口可访问 ${snapshot.remote.provider} 入口 ${endpointSuffix}，往返约 ${String(remoteObservation.latencyMs ?? 0)} ms；公网及手机路径未独立验证。`,
        remoteObservation.viaProxy === true ? '请在手机上测试远程连接。' : undefined,
        facts,
      ))
    } else if (remoteObservation.state === 'rate-limited') {
      checks.push(check(
        'remote', 'warning', 'remote-rate-limited', '远程通道',
        remoteObservation.viaProxy === true
          ? '电脑经代理访问时观察到限流，尚未验证手机能否连接。'
          : '公共地址可达，但本次检查观察到服务限流。',
        '稍后重试；旧会话会按需加载以减少流量。', facts,
      ))
    } else if (snapshot.remote.provider === 'tailscale' && remoteObservation.dns?.kind === 'tailnet'
      && (remoteObservation.failureStage === 'connect' || remoteObservation.failureStage === 'timeout')) {
      checks.push(check('remote', 'warning', 'remote-tailnet-shadowed', '电脑出口探测',
        '本机系统 DNS 返回 tailnet 地址，当前 Funnel-only 监听不接受此私网路径；本次失败不能证明公网 Funnel 故障。',
        '用 tailnet 外的网络单独验证；如自愿临时调整设备 DNS，注意其对其他私网服务的影响并在对照后恢复。', facts))
    } else if (snapshot.remote.provider === 'tailscale' && (remoteObservation.fakeIp === true || remoteObservation.dns?.kind === 'fake-ip')
      && remoteObservation.failureStage !== 'tls' && remoteObservation.failureStage !== 'http') {
      checks.push(check(
        'remote',
        'error',
        'remote-fake-ip',
        '远程通道',
        '本机系统 DNS 返回 Fake-IP 网段，本次出口探测未成功；这不是公网故障的证明。',
        '核对 DNS 与代理路由，用其他网络对照，不要关闭证书验证。',
        facts,
      ))
    } else {
      const reason: DiagnosticReason = remoteObservation.failureStage === 'dns' ? 'remote-dns-failed'
        : remoteObservation.failureStage === 'connect' ? 'remote-connect-failed'
        : remoteObservation.failureStage === 'tls' ? 'remote-tls-failed'
        : remoteObservation.failureStage === 'timeout' ? 'remote-probe-timeout'
        : remoteObservation.failureStage === 'http' ? 'remote-http-failed' : 'remote-unreachable'
      checks.push(check('remote', 'error', reason, '电脑出口探测', '电脑当前出口的探测未通过；不代表其他网络或手机一定失败。', '按失败阶段核对 DNS、路由、证书或代理，并用手机当前网络对照。', facts))
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
    '电脑没有验证手机网络、认证页面、资源加载或 WebSocket。',
    '请用手机当前网络实际连接，记录失败阶段；不要提供配对凭据或直接关闭安全隔离措施。',
  ))

  const overall = checks.some(entry => entry.status === 'error')
    ? 'error'
    : checks.some(entry => entry.status === 'warning') ? 'attention' : 'ok'
  const summary = overall === 'ok' ? '电脑端基础检查完成；手机、认证页面、资源与 WebSocket 尚未验证。' : overall === 'attention' ? '电脑端检查有待确认项目；请区分测量路径与实际手机连接。' : '电脑端检查有失败项目；不据此推断所有网络均不可达。'
  const report = [
    'DSH Mobile 诊断报告',
    `生成时间: ${new Date().toISOString()}`,
    `版本: plugin=${DSH_MOBILE_VERSION}; dsh=${snapshot.dshVersion}; min-app=${MINIMUM_ANDROID_APP_VERSION}`,
    `LAN: ${snapshot.lan.running ? 'on' : 'off'}; endpoint=${maskLanOrigin(snapshot.lan.origin)}`,
    `Remote: provider=${snapshot.remote.provider}; state=${snapshot.remote.state}; endpoint=${remoteSuffix(snapshot.remote.origin)}`,
    'Coverage: computer-side only; phone, authenticated page, resources and WebSocket remain unverified.',
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
    coverage: Object.freeze({ measuredFrom: 'computer' as const, unverified: Object.freeze(['phone', 'authenticated-page', 'resources', 'websocket']) }),
  })
}
