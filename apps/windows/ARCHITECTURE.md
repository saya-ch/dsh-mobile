# 架构与安全模型

本文说明 Windows 客户端的内部结构，便于维护者审阅与后续对齐。功能与构建见 [README.md](README.md)。

## 组件职责

| 文件 | 职责 |
| --- | --- |
| `MainWindow.xaml(.cs)` | WPF 外壳：连接页 + 浏览器页、设备列表、连接/重连编排 |
| `UrlPairing.cs` | 解析 `https://…/mobile-access/pair#…` 链接（legacy `instance/token` 或 `dsh1`/`dsh2` key），并按 `RemoteHostPolicy` 区分局域网/远程 |
| `PairingDescriptor.cs` | 解析 iroh 配对 JSON 描述符（EndpointId / Hostname / Origin / LocalPort / InstanceId / CA） |
| `GatewayAuth.cs` | TLS 载体上的第二层授权：`native-pair` / `native-renew`，以及 `/mobile-access/ca.cer` 引导 |
| `CertificatePolicy.cs` | 配对 CA 固定、叶子证书校验、CA 指纹锚定 |
| `IrohCarrier.cs` | 管理固定版本的 `phone-sim` sidecar 进程 |
| `DeviceStore.cs` | 设备记录的原子读写、DPAPI 加密与逐次校验 |

## 两层结构

1. **TLS 载体**：证书固定到配对 CA（或 dsh1 remote 的平台信任）。
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

### 局域网 / 远程（直连）

```
客户端 ──TCP──▶ https origin ──GET /mobile-access/ca.cer(TOFU)──▶ 固定 CA ──SslStream(pin)──▶ native-pair/renew
```

- 链接形态：`https://<origin>/mobile-access/pair#instance=<64hex>&token=<43base64url>`，
  或 `#key=dsh1|dsh2.<64hex>.<43base64url>`；也接受裸 `https://origin`（仍需 fragment 凭据）。
- 分类：`RemoteHostPolicy` 按公网/隧道后缀（`*.ts.net`、`*.cpolar.*`、`*.trycloudflare.com`）与私有网段判定 remote / lan。
- 引导：先以 TOFU 连接取 `/mobile-access/ca.cer`；`dsh2` 与 legacy 链接强制需要 CA，`dsh1` remote 允许在 404 时回退平台信任。

## 信任模型

- **配对 CA 是固定通道的唯一信任锚**。
- TOFU 只用于取回 `ca.cer`：握手阶段接受任意证书；**真正的信任决策**是 `ValidateFetchedCa(der, instanceId)`——
  CA 的 SHA-256 必须等于链接里的 `instanceId`，因此攻击者无法伪造出同指纹的 CA。
- 叶子校验顺序：`Issuer` → 有效期 → 非 CA → `EKU(serverAuth)` → 链固定到 CA → `SAN`
  （DNS 精确或单层通配；局域网网关也出 IP SAN，按 IP 逐字节比较）。
- WebView2 `ServerCertificateErrorDetected`：仅当上述固定校验通过才放行；`Expired`/`Revoked` 一律拒绝。
- 落盘再校验：`SavedDevice.Validate()` 每次加载都重算 `SHA-256(CA) == instanceId`、断言自签、
  `Origin` 与主机/端口一致，篡改存储无法注入新的信任锚。

## 持久化与便携边界

- `Root = AppContext.BaseDirectory`；`data/` 存放 `devices.json`、`client.log`、WebView2 用户目录。
- iroh 身份由 sidecar 强制存放于 `%USERPROFILE%\.dsh-mobile-win\iroh`（其私有目录 ACL 校验拒绝盘符根目录）。
- `deviceToken` 以 DPAPI(CurrentUser) 加密后落盘，不跨用户/跨机可用；一次性 `irohCode` / `gatewayToken` 从不持久化。

## 构建与测试状态

- 构建前置：.NET 8 SDK(x64) + WebView2 Evergreen；`dotnet build -c Release` 本机验证 0 警告 0 错误。
- 已实测：iroh 跨机连接、免扫码重连。
- 未完整实测：局域网 / 远程通道按 Android 端规则实现并做了边界用例校验，尚未跑完整真机矩阵。
