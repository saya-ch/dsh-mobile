import { execFileText as execFile } from './exec-file.js'
import { lookup } from 'node:dns/promises'
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
  | 'firewall-ready' | 'firewall-missing' | 'firewall-unknown'
  | 'remote-off' | 'remote-ready' | 'remote-origin-ready' | 'remote-rate-limited' | 'remote-fake-ip' | 'remote-unreachable'
  | 'remote-needs-login' | 'remote-connecting' | 'remote-controller-error'
  | 'competing-remote-channel'
  | 'phone-network-unknown'

export interface DiagnosticFacts {
  readonly provider?: RemoteProvider
  readonly latencyMs?: number
  readonly interfaceName?: string
  readonly endpointSuffix?: string
  readonly controllerCode?: string
  /** The reachability answer came from the machine's configured relay egress. */
  readonly viaProxy?: boolean
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
  /** Another plugin injects a remote transport before the DSH client boots. */
  readonly competingRemoteChannelBoot?: boolean
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

/** Bounded supplementary DNS context for a failed direct attempt. */
async function unreachableWithDnsContext(hostname: string, budgetMs: number): Promise<RemoteObservation> {
  let fakeIp = false
  let timer: NodeJS.Timeout | undefined
  try {
    const addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('dns_context_timeout')) }, Math.max(1, budgetMs))
        timer.unref()
      }),
    ])
    fakeIp = addresses.some(({ address }) => {
      const [first, second] = address.split('.').map(Number)
      return first === 198 && (second === 18 || second === 19)
    })
  } catch {
    // DNS lookup is supplementary; the failed HTTPS probe remains authoritative.
  } finally {
    clearTimeout(timer)
  }
  return { state: 'unreachable', ...(fakeIp ? { fakeIp: true } : {}) }
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
    if (response.status === 429) return { state: 'rate-limited', latencyMs }
    return response.ok ? { state: 'ready', latencyMs } : { state: 'unreachable', latencyMs }
  } catch {
    return unreachableWithDnsContext(target.hostname, Math.max(1, budgetMs - (performance.now() - started)))
  }
}

/** Explicit test seams: environment, the direct attempt, and the relay attempt. */
export interface RemoteHealthProbeOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly direct?: DirectHealthProbe
  readonly tunnel?: ProxyHealthTunnel
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
  const observation = await direct(target, budgetMs)
  if (observation.state !== 'unreachable') return observation
  const relay = configuredProxyFor(origin, options.env ?? process.env)
  if (relay === undefined) return observation
  const tunnel = options.tunnel ?? relayProbeThroughProxy
  try {
    const { status, latencyMs } = await tunnel(target, relay, budgetMs)
    if (status === 429) return { state: 'rate-limited', latencyMs, viaProxy: true }
    return status >= 200 && status < 300
      ? { state: 'ready', latencyMs, viaProxy: true }
      : observation
  } catch {
    return observation
  }
}

async function defaultRemoteProbe(origin: string | undefined): Promise<RemoteObservation> {
  return probeRemoteHealth(origin)
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
  const remoteProbe = snapshot.remote.provider !== 'origin' && snapshot.remote.running && snapshot.remote.state === 'ready' && snapshot.remote.origin !== undefined
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

  if (snapshot.competingRemoteChannelBoot === true) {
    checks.push(check(
      'remote-plugin-conflict', 'warning', 'competing-remote-channel', '第三方远程插件',
      '检测到另一套远程请求通道脚本；手机页面可能进入该插件自己的配对流程。',
      '在电脑端关闭 dsh-remote-web-ui 的远程访问后刷新，再使用 DSH Mobile 当前二维码配对；不要混用两种配对码。',
    ))
  }

  if (snapshot.lan.configured === false) {
    checks.push(check('network', 'error', 'lan-setup-required', '局域网配置', '尚未完成局域网初始化。', '返回局域网页选择网卡并完成配置。'))
  } else if (snapshot.lan.networkError !== undefined) {
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
  } else if (snapshot.remote.provider === 'origin' && snapshot.remote.state === 'ready') {
    checks.push(check('remote', 'info', 'remote-origin-ready', '远程通道',
      '私网 HTTP 后端已就绪；未检测公网 HTTPS、证书或 WebSocket 连通性。',
      '在手机上经反向代理验证连接；代理须保留原始 Host（含端口）并支持 WebSocket。',
      { provider: 'origin' }))
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
          : `${snapshot.remote.provider} 公共地址 ${endpointSuffix} 可达，往返约 ${String(remoteObservation.latencyMs ?? 0)} ms。`,
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
