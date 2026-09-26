# 自建 FRP 历史维护记录

本文保留 0.4.6 开发时的代码地图和验证记录，供维护者核对；当前用户操作以 [SELF_HOSTED_FRP.md](SELF_HOSTED_FRP.md) 和 [ATTACH_EXISTING_FRPS.md](ATTACH_EXISTING_FRPS.md) 为准。既有 frps 接入与自签入口从 0.4.6 起提供；自签档需要 0.4.6 或更新的 Android App。下文的 2026-09-03 真机记录只验证托管部署的公开证书 IP 档，不是 attach 档验收结果。

面向维护者。用户文档见 [SELF_HOSTED_FRP.md](SELF_HOSTED_FRP.md)；「接入既有 frps + 自签穿透」用户指南见
[ATTACH_EXISTING_FRPS.md](ATTACH_EXISTING_FRPS.md)。

## 两档置备方式（`mode`）与两档入口证书（`entryTls`）

| | `mode: 'deploy'`（缺省） | `mode: 'attach'` |
|---|---|---|
| 谁装 frps | 插件在 VPS 上装并托管 | **用户既有的 frps，插件绝不安装/修改/重启** |
| 谁做 TLS 终止 | VPS 的 Caddy | 公开证书档由 VPS Caddy 终止；自签档由 frps TCP 透传到本机网关终止 |
| 需要的 SSH | 是（`vps/deploy`） | **否（零 SSH）** |
| 产出 | frps.toml + Caddy 片段 + systemd 单元 | 本机 frpc.toml + VPS 侧待办清单（可复制） |

| | `entryTls: 'public-ip-cert'`（缺省） | `entryTls: 'self-signed'`（仅 attach） |
|---|---|---|
| 公网入口 | `443`；域名由 Caddy 自动管理证书，公网 IPv4 用 certbot IP 证书 | `publicPort`（缺省 **33080**），frps 纯 TCP 透传 |
| frpc proxy 类型 | `type = "http"` + `customDomains` | `type = "tcp"` + `remotePort = publicPort` |
| 证书来源 | 域名由 Caddy 自动管理；公网 IPv4 用 Let's Encrypt 短期证书（约 6 天） | 网关自签 CA（5 年）+ 叶证书（397 天）；需监控到期并处理 CA 轮换与重新配对 |
| App 信任 | 系统信任库（公开 CA） | 固定网关 CA（`GET /mobile-access/ca.cer`） |
| 手机浏览器 | 正常 | 提示证书不受信任；仅 0.4.6 及更新 App 可在明确配对后使用该自签入口 |

## 代码地图

- `src/frp-config.ts`：配置校验与持久化。`validateFrpPublicOrigin` 要求 IPv4 入口全局可路由（文档/私网/保留地址拒绝）；`serverAddress` 保持宽松以兼容本地回环测试，VPS 操作另行收紧。`mergeSavedFrpSettings`/`mergeSavedFrpTarget` 让空白字段沿用已保存配置（面板“已保存时可留空”）。`mode`/`entryTls`/`vhostHttpPort`/`publicPort` **全部可选**：缺省即上游行为，`parseFrpSettings` 只回填用户显式给出的键，故旧 `settings.json` 逐字节往返不变。
- `src/frp-template.ts`：`createCaddySite(publicHost, options)`（`certDir`/`vhostHttpPort`，第二参数兼容旧的 `certDir: string`）、`manualIpCertificateGuide`（已导出）、`import` 行常量。自签档**不产出 Caddy 站点**（调用即 `frp_entry_tls_invalid`）。
- `src/frp-attach.ts`：`createFrpAttachTemplateParts()`（VPS 侧/本机侧两份互不混杂）、`createFrpAttachTemplate()`、`validateAttachSettings()`、`frpAttachVpsParts()`。VPS 侧**不含** `frps.toml`/`bindPort`/`auth.token`/`systemd` 等安装或改写 frps 的痕迹。
- `src/frp-attach-plan.ts`：`createFrpAttachPlan()` —— **零 SSH** 纯文本待办（不发起任何网络连接、不写任何文件）；自签档仅 3 步（放行端口 / frps 自检 / 端到端验证）。
- `src/frp-ingress.ts` + `plugin.ts` 的 `frpIngressGatewayConfig()`：自签档的 CA/叶证书与入口网关配置。**保留** `pairingCaFile`（网关据此暴露 `GET /mobile-access/ca.cer`），`instanceId` = 该 CA 的 `fingerprint256`，`listenHost` 恒为 `127.0.0.1`，`tls.mode='provided'`，`publicTls=true`，`authorities` = `<公网IP>:<publicPort>`，`allowedCidrs` 恒为 `127.0.0.0/8`。
- `src/managed-setup.ts`：`issueServerCertificate()` —— LAN 与自签 ingress **共用**的「为给定主机签发叶证书」能力（IP 走 `type: 7`，域名走 `type: 2`）；`refreshManagedServerCertificate()` 已改为调用它，签名逻辑无复制粘贴。
- `src/cert-renewal.ts`：只读寿命检查 `evaluateCertificateLifetime()` / `readCertificateRenewal()` / `probeOriginCertificate()`；阈值 `<= 2 天 → expiring`，`<= 0 → expired`，读不到 → `unknown`。
- `src/network.ts`：`isGloballyRoutableIpv4`（IANA 特殊用途全表，含 TEST-NET-1/2/3），与 Android `RemoteHostPolicy` 保持同表。任一侧改表必须同步另一侧与双方测试。`probeTcpReachable()` 仅供按需自检，**不得**用于任何安全判定。
- `src/vps-deploy.ts`：`fetchVpsHostKeys`（keyscan → Git 版 keyscan → 认证直读的三级扫描，同一确认管线）、`buildPinnedKnownHosts`（已确认集合全包含才放行）、`validateVpsServerTarget`（所有 VPS 操作共用：禁 IPv6 与非公网目标）、`deployVps`/`uninstallVps`（部署前/清理前重新扫描并全量核对，SSH/SCP 全程 `StrictHostKeyChecking=yes` + 临时 known_hosts + 保活）、`createVpsUninstallScript`（只删自有产物；Caddy 只删 snippet 与 import 行，用户内容不动；账户凭 `.owns-account` 标记删除）。**attach 模式完全不经过这里**。
- `src/plugin.ts`：`vps/host-keys`、`vps/deploy`、`vps/uninstall-script`、`vps/uninstall` 四个回环管理路由；日志只记指纹与计数，不记密钥与 Token。新增只读路由 `POST remote/frp/attach-plan`（清单预览）与 `GET remote/frp/self-check`（证书寿命 + frps/入口可达性）。
- `src/client.ts` + `src/client-messages.ts`（en/it/zh）：变更清单展示、指纹确认对话框、卸载入口。三语 key 必须对齐（translator 有英文 fallback，但 CI 期待完整翻译）；`tests/frp-messages.test.ts` 断言三语键集完全一致且无空串。
- Android `RemoteHostPolicy.kt` + `RemoteHostPolicyTest.kt` + `PairingScanPolicyTest.kt`：远程入口识别。

## 错误码

- `vps_host_key_unconfirmed`：未提供已确认指纹（400/409 经 `vps_` 前缀映射）。
- `vps_host_key_mismatch`：服务器当前密钥不在已确认集合（轮换/替换/多余密钥，fail-closed）。
- `vps_host_key_unavailable` / `vps_host_key_invalid`：keyscan 无输出或输出不可解析。
- `vps_server_not_public`：SSH 目标是回环/私网/文档 IPv4（网络碰触前拒绝）。
- `vps_ipv6_ssh_not_supported`：SSH 目标是 IPv6（所有 VPS 操作共用校验）。
- `frp_config_missing`：无已保存配置且请求字段空白。
- `vps_uninstall_failed`：清理脚本未回 `DSH_MOBILE_UNINSTALL_OK`。
- `frp_attach_mode_requires_vhost_port`（409）：`mode='attach'` 且为公开 CA 证书档时未提供用户 frps 的真实 `vhostHttpPort`。**绝不允许退化为默认 7080**：探测错误的端口会让「明文 vhost 公网可达」的闸门假阴性放行。自签档（`entryTls='self-signed'`）没有 vhost，无需该端口。
- `frp_attach_cert_unknown`（409）：自签入口的 CA/叶证书缺失、不可读或无法签发；需检查私有入口证书状态，不得绕过指纹固定。`frp_ingress_ca_expired` 表示 CA 已过期，不能静默生成新 CA 继续旧配对，须重新配置并让手机核对新指纹后重新配对。
- `frp_entry_tls_invalid`（409）：入口证书档与置备方式不兼容（`self-signed` 仅限 `attach`），或对该档调用了只服务 Caddy 的模板函数。
- 明文 vhost 暴露**继续沿用**既有 `frp_vhost_publicly_reachable` / `frp_vhost_probe_failed`，未新造代码。

## 验证

```powershell
npm run typecheck
npm test
npm run build
```

```powershell
cd apps/mobile/android
.\gradlew.bat --no-daemon testDebugUnitTest assembleDebug
```

- `tests/vps-deploy.test.ts`：指纹确认、轮换中止、卸载脚本内容断言、非公网目标零网络碰触；`sh -n` 语法检查仅在非 Windows 运行（CI 的 Ubuntu 节点覆盖）。
- `tests/network.test.ts`：可路由/特殊用途边界。
- `tests/frp-backward-compat.test.ts`：**字节级兼容闸门** —— 缺省参数下的 `frpc.toml` / `frps.toml` / Caddy 片段 / `parseFrpSettings` / 状态字段与改动前逐字节相同（期望串由**执行上游实现**采集）。
- `tests/frp-attach.test.ts`：attach 产物分离（VPS 侧不含 `frps.toml`/`bindPort`/`auth.token`/`systemd`）、零 SSH 清单不发网络请求、自签档 TCP 透传、`vhostHttpPort` 贯穿。
- `tests/frp-ingress.test.ts`：自签叶证书 SAN 含公网 IP、CA 指纹即 `instanceId`、`pairingCaFile` 保留、`listenHost=127.0.0.1`、真实 TLS 监听返回 `ca.cer` 与 `discovery`。
- `tests/cert-renewal.test.ts`：寿命四态与阈值、本地自签 HTTPS 端点探测。
- `tests/frp-messages.test.ts`：三语键集一致 + 无空串。
- `DSH_MOBILE_FRP_LOCAL=1 npx vitest run tests/frp-live.test.ts`：真实官方 frps+frpc 数据链路（需外网下载固定版本）。
- 真机 VPS 发布验证按用户指南末尾的清单逐项执行并记录；**attach 自签档**另按 [ATTACH_EXISTING_FRPS.md](ATTACH_EXISTING_FRPS.md) 的清单执行。

## 安全边界（attach 与自签档新增，改动时逐条复核）

- HTTP 档：frps vhost 只绑 `127.0.0.1`；公网只暴露 Caddy HTTPS；明文 vhost 公网可达必须拒启（探测端口 = 用户真实 `vhostHTTPPort`）。
- 自签档：网关**只监听 `127.0.0.1`**（公网入口是 frps 的 TCP 代理，不是网关直绑）；`allowedCidrs` 恒为 `127.0.0.0/8`；**绝不**把 `listenHost` 设为 `0.0.0.0`。
- 自签档不做 vhost 探测（无明文 vhost）；其等价暴露面是「公网入口端口可直连」——**这是设计使然**（入口本身就是网关的 HTTPS 服务），安全依赖网关自身的设备配对与鉴权。
- attach 模式不得触碰用户既有 frps 配置与 Caddyfile 其他内容；本机也不改动 DSH 自身配置。
- Token / 私钥 / CA 私钥路径不进日志、不进状态、不进 localStorage；`GET remote/frp/self-check` 可返回非秘密的公开入口、端口、证书寿命与 CA 指纹，但不返回 Token 或私钥。

## 真机验证记录（2026-09-03，腾讯云 Ubuntu 24.04，IP 模式）

- 部署 → frpc 安装 → 公网 discovery `ready` 全链路通过；`https://VPS/mobile-access/discovery` 独立验证 200，Let's Encrypt 短期 IP 证书有效。
- 一键清理后服务端无残留：单元、配置/二进制/证书目录、续期定时器、系统用户、LE 证书均已移除；Caddy 本体与占位 Caddyfile 保留。
- 该次真机验证记录的修复：
  1. 重部署不断开旧 frps（`enable --now` 对已运行服务是 no-op）导致 Token 失配——部署脚本现改为 `enable` + `restart`，并有回归测试锁定。
  2. 本机旧版 `ssh-keyscan` 与 OpenSSH 9.6 协商 KEX 失败——`defaultRunKeyscan` 增加 Git 版 keyscan 重试，仍无输出时回退到认证连接直读公钥（同一确认-固定管线），并有回归测试锁定。
  3. 长会话（apt/pip 分钟级无输出）曾被中间设备 reset——SSH/SCP 会话现带 `ServerAliveInterval=15` 保活。
  4. `sed -i` 原地删除在部署通道里不可靠（重复 import 增生导致全局块重复，`caddy validate` 报 adapting 错误）：Caddyfile 改写统一用 `grep -v` 重建 + 导入行计数校验，失败即中止不落盘。

## 安全边界（改动时复核）

- 公开证书 HTTP 档的 frps vhost 仅可由回环访问；端口须为该实例实际配置的 `vhostHTTPPort`（托管默认 7080），公网只暴露 Caddy HTTPS。自签 TCP 档没有 DSH 的明文 HTTP vhost，但要审查既有 frps 的其他代理监听。
- 永远不回退到 `accept-new`；已知密钥静默替换必须失败。
- 卸载脚本只删 DSH Mobile 前缀路径、自有 systemd 单元、带标记 UFW 规则；Caddyfile 仅在含管理标记时清空为占位。
- 私钥路径只在本机使用；Token 不进日志/状态/localStorage。
