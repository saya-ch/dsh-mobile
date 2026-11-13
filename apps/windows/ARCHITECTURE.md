# 架构与安全模型

本文说明 Windows 客户端的内部结构，便于维护者审阅与后续对齐。功能与构建见 [README.md](README.md)。

## 组件职责

| 文件 | 职责 |
| --- | --- |
| `MainWindow.xaml(.cs)` | WPF 外壳：连接页 + 浏览器页、设备列表、连接/重连编排、WebView2 边界策略 |
| `UrlPairing.cs` | 解析 `https://…/mobile-access/pair#…` 链接（legacy `instance/token` 或 `dsh1`/`dsh2` key），并按 `RemoteHostPolicy` 区分局域网/远程 |
| `PairingTrustPolicy.cs` | `ca.cer` 回执的决策（404 是否允许平台信任），对齐 Android `PairingTrust.selectTrustAnchor` / `RemotePairingTrust.decide` |
| `PairingDescriptor.cs` | 解析 iroh 配对 JSON 描述符（EndpointId / Hostname / Origin / LocalPort / InstanceId / CA） |
| `GatewayAuth.cs` | TLS 载体上的第二层授权：`native-pair` / `native-renew`，以及 `/mobile-access/ca.cer` 引导 |
| `CertificatePolicy.cs` | 配对 CA 固定、叶子证书校验、CA 指纹锚定 |
| `IrohCarrier.cs` | 管理固定版本的 `phone-sim` sidecar 进程；启动前复核二进制 pin |
| `SidecarProvisioner.cs` | 按固定 URL/字节数/SHA-256 获取并校验官方 sidecar，不随仓库分发二进制 |
| `DeviceStore.cs` | 设备记录的原子读写、DPAPI 加密与逐次校验 |
| `DshMobile.Win.Tests/` | 纯逻辑单测（配对链接、信任决策、证书链/SAN、设备存储、sidecar pin） |

## 两层结构

1. **TLS 载体**：证书固定到配对 CA（或公共 CA 远程 key 的平台信任）。
2. **应用层认证**：在已建立的 TLS 上再做一次 `native-pair`（首次）或 `native-renew`（重连），与证书校验相互独立。

## 三种连接通道

### iroh

```
客户端 ──SslStream──▶ 127.0.0.1:<LocalPort> ──sidecar──▶ QUIC(ALPN dsh-mobile-iroh/0) ──▶ 远端 Gateway
```

- sidecar 参数：`phone-sim --data-dir <dir> --peer <EndpointId> --name … --proxy-listen 127.0.0.1:<LocalPort>`；首次配对追加 `--code <pairingCode>`。
- Wire：带 code 走 `Pair`，不带 code 走 `Hello`（已配对设备免扫码重连）。
- sidecar 使用 `presets::N0`（发现 + 中继）；本地回环只转发**原始 TLS 字节**，TLS 终点仍在远端 Gateway。
- 客户端连 `127.0.0.1:<LocalPort>`，SNI 用远端 `Hostname`，叶子证书按固定 CA 校验。
- **sidecar 不进仓库**：pin 唯一来源于 `src/iroh-component.ts` 的 `IROH_COMPONENT_RELEASES['win32-x64']`（镜像在 `sidecar/manifest.json`）。`SidecarProvisioner` 首次使用时按固定 URL 下载、按字节数 + SHA-256 校验，或复用 DSH Mobile 插件已校验的副本；损坏缓存删除重取；`IrohCarrier.StartAsync` 在启动进程前再校验一次，哈希不符拒绝启动。许可文本随 `sidecar/` 附带。

### 局域网 / 远程（直连）

```
客户端 ──TCP──▶ https origin ──GET /mobile-access/ca.cer(TOFU)──▶ 固定 CA ──SslStream(pin)──▶ native-pair/renew
```

- 链接形态：`https://<origin>/mobile-access/pair#instance=<64hex>&token=<43base64url>`，
  或 `#key=dsh1|dsh2.<64hex>.<43base64url>`；也接受裸 `https://origin`（仍需 fragment 凭据）。
- 分类：`RemoteHostPolicy` 按公网/隧道后缀（`*.ts.net`、`*.cpolar.*`、`*.trycloudflare.com`）与私有网段判定 remote / lan。
- 引导：先以 TOFU 连接取 `/mobile-access/ca.cer`。`dsh2`（`requiresCa=true`）强制要求配对 CA，**404 视为身份不匹配并硬失败**；`dsh1` 与 legacy `instance/token` 描述公共 CA 网关，仅当通道为 remote 且收到显式 404 时允许回退平台信任；LAN 的 404 一律硬失败；已 pin 的设备永不降级。该决策集中在 `PairingTrustPolicy.Decide`，`requiresCa` 持久化在设备记录中并在每次加载时校验。

## 信任模型

- **配对 CA 是固定通道的唯一信任锚**。
- TOFU 只用于取回 `ca.cer`：握手阶段接受任意证书；**真正的信任决策**是 `ValidateFetchedCa(der, instanceId)`——
  CA 的 SHA-256 必须等于链接里的 `instanceId`，因此攻击者无法伪造出同指纹的 CA。
- 叶子校验顺序：`Issuer` → 有效期 → 非 CA → `EKU(serverAuth)` → 链固定到 CA → `SAN`
  （DNS 精确或单层通配；局域网网关也出 IP SAN，按 IP 逐字节比较）。
- WebView2 `ServerCertificateErrorDetected`：仅当上述固定校验通过才放行；`Expired`/`Revoked` 一律拒绝。
- 落盘再校验：`SavedDevice.Validate()` 每次加载都重算 `SHA-256(CA) == instanceId`、断言自签、
  `Origin` 与主机/端口一致，篡改存储无法注入新的信任锚。

## WebView2 边界策略

对齐 Android 的 `SecureWebViewClient` / `GatewayUrlPolicy` / `MainActivity`，明确定义而不是留空：

| 事件 | 策略 |
| --- | --- |
| `NavigationStarting` | 仅允许已配对网关的**精确 origin**（含端口）与 `about:blank`；其他一律取消，https 外链交给系统浏览器 |
| `NewWindowRequested` | 阻止弹窗；https 外链交给系统浏览器 |
| `DownloadStarting` | 一律取消并提示（客户端暂不支持下载） |
| `PermissionRequested` | 一律 `Deny`；麦克风被拒时明确提示「暂不支持语音输入」 |
| `ProcessFailed` | 浏览器进程退出提示重连；渲染/frame 进程崩溃自动 `Reload` 并提示 |

提示按类别每会话只显示一次，避免权限/下载事件反复弹窗。

## 持久化与便携边界

- `Root = AppContext.BaseDirectory`；`data/` 存放 `devices.json`、`client.log`、WebView2 用户目录。
- iroh 身份由 sidecar 强制存放于 `%USERPROFILE%\.dsh-mobile-win\iroh`（其私有目录 ACL 校验拒绝盘符根目录）。
- sidecar 缓存于 `data/components/iroh/<version>/`，损坏或不匹配 pin 时删除重取，绝不启动未校验的二进制。
- `deviceToken` 以 DPAPI(CurrentUser) 加密后落盘，不跨用户/跨机可用；一次性 `irohCode` / `gatewayToken` 从不持久化。

## 构建与测试状态

- 构建前置：.NET 8 SDK(x64) + WebView2 Evergreen；`dotnet build -c Release` 本机验证 0 警告 0 错误。
- CI：`.github/workflows/windows-client.yml` 在 `windows-latest` 跑 `dotnet restore` / `dotnet build -c Release` / `dotnet test`，可作为合并门槛。
- 单测：`DshMobile.Win.Tests/` 覆盖 `UrlPairing`、`PairingDescriptor`、`PairingTrustPolicy`（含 404 的 dsh2 硬失败 / dsh1 回退两条）、`CertificatePolicy`（`ValidateFetchedCa`、DNS/通配/IP SAN）、`DeviceStore.Validate`、`SidecarProvisioner` pin；本机 44 例全通过。
- 已实测：iroh 跨机连接、免扫码重连、Release 构建与上述单测。
- 未完整实测：局域网 / 远程通道按 Android 端规则实现并做了边界用例校验，尚未跑完整真机矩阵；WebView2 五个策略 handler 尚未在真实页面上逐一验证。以上均需有 Windows 机器的人按验收清单复核。
