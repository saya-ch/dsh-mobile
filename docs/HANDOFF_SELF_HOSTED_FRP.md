# 自建 FRP 维护说明

面向维护者。用户文档见 [SELF_HOSTED_FRP.md](SELF_HOSTED_FRP.md)。

## 代码地图

- `src/frp-config.ts`：配置校验与持久化。`validateFrpPublicOrigin` 要求 IPv4 入口全局可路由（文档/私网/保留地址拒绝）；`serverAddress` 保持宽松以兼容本地回环测试，VPS 操作另行收紧。`mergeSavedFrpSettings`/`mergeSavedFrpTarget` 让空白字段沿用已保存配置（面板“已保存时可留空”）。
- `src/frp-template.ts`：`createCaddySite` 片段构建器（自动/手动共用）、手动 IPv4 证书指引、`import` 行常量。手动模板与自动部署内容同源。
- `src/network.ts`：`isGloballyRoutableIpv4`（IANA 特殊用途全表，含 TEST-NET-1/2/3），与 Android `RemoteHostPolicy` 保持同表。任一侧改表必须同步另一侧与双方测试。
- `src/vps-deploy.ts`：`fetchVpsHostKeys`（keyscan → Git 版 keyscan → 认证直读的三级扫描，同一确认管线）、`buildPinnedKnownHosts`（已确认集合全包含才放行）、`validateVpsServerTarget`（所有 VPS 操作共用：禁 IPv6 与非公网目标）、`deployVps`/`uninstallVps`（部署前/清理前重新扫描并全量核对，SSH/SCP 全程 `StrictHostKeyChecking=yes` + 临时 known_hosts + 保活）、`createVpsUninstallScript`（只删自有产物；Caddy 只删 snippet 与 import 行，用户内容不动；账户凭 `.owns-account` 标记删除）。
- `src/plugin.ts`：`vps/host-keys`、`vps/deploy`、`vps/uninstall-script`、`vps/uninstall` 四个回环管理路由；日志只记指纹与计数，不记密钥与 Token。
- `src/client.ts` + `src/client-messages.ts`（en/it/zh）：变更清单展示、指纹确认对话框、卸载入口。三语 key 必须对齐（translator 有英文 fallback，但 CI 期待完整翻译）。
- Android `RemoteHostPolicy.kt` + `RemoteHostPolicyTest.kt` + `PairingScanPolicyTest.kt`：远程入口识别。

## 错误码

- `vps_host_key_unconfirmed`：未提供已确认指纹（400/409 经 `vps_` 前缀映射）。
- `vps_host_key_mismatch`：服务器当前密钥不在已确认集合（轮换/替换/多余密钥，fail-closed）。
- `vps_host_key_unavailable` / `vps_host_key_invalid`：keyscan 无输出或输出不可解析。
- `vps_server_not_public`：SSH 目标是回环/私网/文档 IPv4（网络碰触前拒绝）。
- `vps_ipv6_ssh_not_supported`：SSH 目标是 IPv6（所有 VPS 操作共用校验）。
- `frp_config_missing`：无已保存配置且请求字段空白。
- `vps_uninstall_failed`：清理脚本未回 `DSH_MOBILE_UNINSTALL_OK`。

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
- `DSH_MOBILE_FRP_LOCAL=1 npx vitest run tests/frp-live.test.ts`：真实官方 frps+frpc 数据链路（需外网下载固定版本）。
- 真机 VPS 发布验证按用户指南末尾的清单逐项执行并记录。

## 真机验证记录（2026-09-03，腾讯云 Ubuntu 24.04，IP 模式）

- 部署 → frpc 安装 → 公网 discovery `ready` 全链路通过；`https://VPS/mobile-access/discovery` 独立验证 200，Let's Encrypt 短期 IP 证书有效。
- 一键清理后服务端无残留：单元、配置/二进制/证书目录、续期定时器、系统用户、LE 证书均已移除；Caddy 本体与占位 Caddyfile 保留。
- 真机发现并修复两个问题：
  1. 重部署不断开旧 frps（`enable --now` 对已运行服务是 no-op）导致 Token 失配——部署脚本现改为 `enable` + `restart`，并有回归测试锁定。
  2. 本机旧版 `ssh-keyscan` 与 OpenSSH 9.6 协商 KEX 失败——`defaultRunKeyscan` 增加 Git 版 keyscan 重试，仍无输出时回退到认证连接直读公钥（同一确认-固定管线），并有回归测试锁定。
  3. 长会话（apt/pip 分钟级无输出）曾被中间设备 reset——SSH/SCP 会话现带 `ServerAliveInterval=15` 保活。
  4. `sed -i` 原地删除在部署通道里不可靠（重复 import 增生导致全局块重复，`caddy validate` 报 adapting 错误）：Caddyfile 改写统一用 `grep -v` 重建 + 导入行计数校验，失败即中止不落盘。

## 安全边界（改动时复核）

- frps HTTP vhost 永远只绑 `127.0.0.1:7080`；公网只暴露 Caddy HTTPS。
- 永远不回退到 `accept-new`；已知密钥静默替换必须失败。
- 卸载脚本只删 DSH Mobile 前缀路径、自有 systemd 单元、带标记 UFW 规则；Caddyfile 仅在含管理标记时清空为占位。
- 私钥路径只在本机使用；Token 不进日志/状态/localStorage。
