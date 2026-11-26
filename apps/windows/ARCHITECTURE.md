# 架构与安全模型

[English](ARCHITECTURE.en.md) · [返回 README](README.md)

本文说明 Windows 客户端的内部结构，便于维护者审阅与后续对齐。功能、构建命令、系统要求与发布状态见 [README.md](README.md)。

> 状态：本客户端已合入 `main`，并作为预发布发布在 `windows-v*` 轨道（`0.1.0-alpha`～`0.1.2-alpha`）；维护者真机验收仍未完成。支持范围见 README「系统要求」，alpha 预览与真机验收状态见「下载」下方的 alpha 预览说明。

## 组件职责

| 文件 | 职责 |
| --- | --- |
| `App.xaml(.cs)` | 应用启动、系统深浅色跟随与 `DSH_MOBILE_THEME=light\|dark` 覆盖 |
| `MainWindow.xaml(.cs)` | WPF 外壳：连接页 + 浏览器页、连接/重连编排、WebView2 边界策略、原生 TLS 固定校验（`VerifyPinnedOriginAsync`） |
| `MainWindow.Devices.cs` / `MainWindow.DevicePage.cs` | 设备列表页的两个分部类：卡片渲染、可达状态接线、排序菜单、删除与 5 秒撤销（`Devices`），以及品牌标识、空状态的三种配对入口与方法页签（`DevicePage`）；设置页在 `MainWindow.xaml(.cs)` 中 |
| `AppSettings.cs` | `data/settings.json`：图标、启动方式、主题、任务完成提醒、上次连接的电脑；缺文件或损坏时回退默认值，不报错 |
| `AppIcons.cs` | 与 Android 同款的 10 种启动图标（4 种吉祥物姿态 + 6 种鲸鱼），标题栏与托盘共用，预览取文件里最大一帧 |
| `StartupBehavior.cs` | 启动后「显示设备列表」还是「自动连接上次的电脑」的决策；凭据过期或读不出的记录永不自动连接 |
| `DeviceOrder.cs` | 列表显示顺序（`SortOrder`）与「上移一位 / 移到最前」，对齐 Android `PairedDeviceOrderPolicy` |
| `DeviceStatus.cs` / `DeviceReachability.cs` | 八种可达状态到文案与语义色 token 的映射；15 秒一轮探测、8 秒超时、连接期间暂停 |
| `ClientLog.cs` | `data/client.log` 追加写入；达到 2 MB 轮转为 `client.log.1`，写日志失败不影响运行 |
| `PortableData.cs` | `data/` 可写性探测（写入再删除试探文件）；放在 Program Files 等不可写目录时给出一条可执行提示 |
| `ConnectionDiagnosis.cs` | 连接失败分类（凭据失效、协议版本、WebView2 缺失、CA 不符、DNS、HTTP 426/429/5xx）与用户文案 |
| `WebView2Availability.cs` | 启动前探测 WebView2 Evergreen 运行时；缺失时直接给出安装地址与 x64 提示，而不是等初始化超时 |
| `UpdateCheck.cs` | `windows-v*` Release 的版本比较与选择，并取出安装包与同名 `.sha256` 资产（纯逻辑） |
| `UpdateInstaller.cs` | 更新链路：下载安装包（整体/单次读取两层超时 + 取消）、比对 SHA-256、启动 Inno Setup 静默升级；校验不过绝不安装 |
| `CrashGuard.cs` / `RelativeTime.cs` | 未捕获异常兜底；设备卡片「19 分钟前」这类相对时间文案 |
| `UrlPairing.cs` | 解析 `https://…/mobile-access/pair#…` 链接（legacy `instance/token` 或 `dsh1`/`dsh2` key），并按同文件的 `RemoteHostPolicy` 区分局域网/远程 |
| `PairingTrustPolicy.cs` | `ca.cer` 回执的决策（404 是否允许平台信任），对齐 Android `PairingTrust.selectTrustAnchor` / `RemotePairingTrust.decide` |
| `PairingDescriptor.cs` | 解析 iroh 配对 JSON 描述符（EndpointId / Hostname / Origin / LocalPort / InstanceId / CA） |
| `GatewayAuth.cs` | TLS 载体上的第二层授权：`native-pair` / `native-renew`，以及 `/mobile-access/ca.cer` 引导 |
| `CertificatePolicy.cs` | 配对 CA 固定、叶子证书校验、CA 指纹锚定 |
| `IrohCarrier.cs` | 管理固定版本的 `phone-sim` sidecar 进程；启动前复核二进制 pin |
| `SidecarProvisioner.cs` | 按固定 URL/字节数/SHA-256 获取并校验官方 sidecar，不随仓库分发二进制 |
| `DeviceStore.cs` | 设备记录的原子读写、DPAPI 加密与逐次校验；`AdoptNewOrigin` 跟随搬家的网关（同 instanceId 才允许） |
| `LanDiscovery.cs` | 局域网发现：UDP 公告校验、手输地址归一化、单点 `/mobile-access/discovery` 探测、网段扫描 |
| `BackgroundEventWatcher.cs` | 连接期间订阅 `/mobile-access/background-events`，任务完成弹桌面气球；`SseParser` 逐行解析 SSE |
| `WebViewPolicy.cs` | 精确网关 origin 判定（导航/下载/麦克风共用），无 WebView2 类型依赖以便单测 |
| `DshMobile.Win.Tests/` | 纯逻辑单测（配对链接、信任决策、证书链/SAN、固定 origin 校验、设备存储与排序、可达状态、启动行为、日志轮转、便携目录、失败诊断、更新选择、WebView2 探测） |

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
- **sidecar 不进仓库**：pin 的权威值在 `src/iroh-component.ts` 的 `IROH_COMPONENT_RELEASES['win32-x64']`；`SidecarProvisioner` 硬编码同值，`sidecar/manifest.json` 只是镜像，三处由 `scripts/check-windows-sidecar-pin.mjs` 在 `windows-client.yml` 中机器校验（升级上游 pin 时需同步）。`SidecarProvisioner` 首次使用时按固定 URL 下载、按字节数 + SHA-256 校验，或复用 DSH Mobile 插件已校验的副本（仅默认 `~/.dsh` 布局）；损坏缓存删除重取；`IrohCarrier.StartAsync` 在启动进程前再校验一次，哈希不符拒绝启动。许可文本在仓库 `sidecar/` 下；`dotnet publish` 本身不复制它们，由发布流程复制到发布包的 `licenses/`。

### 局域网 / 远程（直连）

```
客户端 ──TCP──▶ https origin ──GET /mobile-access/ca.cer(TOFU)──▶ 固定 CA ──SslStream(pin)──▶ native-pair/renew
```

- 链接形态：`https://<origin>/mobile-access/pair#instance=<64hex>&token=<43base64url>`，
  或 `#key=dsh1|dsh2.<64hex>.<43base64url>`；也接受裸 `https://origin`（仍需 fragment 凭据）。
- 分类：`RemoteHostPolicy` 按隧道后缀（`*.ts.net`、`.cpolar.cn` / `.cpolar.io` / `.cpolar.top` / `.cpolar.com`、`*.trycloudflare.com`）、私有/回环/链路本地网段，以及 `.local` / `.lan` / `.home` / `.internal` / `.localhost` 与单标签主机名判定 remote / lan。
- 引导：先以 TOFU 连接取 `/mobile-access/ca.cer`。`dsh2`（`requiresCa=true`）强制要求配对 CA，**404 视为身份不匹配并硬失败**；`dsh1` 与 legacy `instance/token` 描述公共 CA 网关，仅当通道为 remote 且收到显式 404 时允许回退平台信任；LAN 的 404 一律硬失败；已 pin 的设备永不降级。该决策集中在 `PairingTrustPolicy.Decide`，`requiresCa` 持久化在设备记录中并在每次加载时校验。

### 发现与地址跟随

- 发现（`LanDiscovery`）：UDP 广播 `DSH_MOBILE_DISCOVER_V1` 并收集网关公告，超时后按本机各 IPv4 的 /24 逐个探测 `GET /mobile-access/discovery`；也接受手输 `IP/host/host:port/https://…` 单点探测。公告五字段必须自洽且 origin 须为应答地址（伪造公告直接丢弃）；发现不是信任决策，配对仍按 instanceId 指纹固定 CA。
- 配对时若链接 origin 与已选发现结果不一致，提示确认，防止贴错另一台电脑的链接。
- 跟随（`SavedDevice.AdoptNewOrigin`）：已保存的 lan/remote 电脑失联或凭据过期时，可粘贴同一台电脑的当前链接更新地址；要求 instanceId 一致，保留用户名称，丢弃旧 CA pin 与设备令牌，更新后走一次全新 `native-pair`。已要求固定 CA 的记录不接受不要求固定 CA 的链接，跟随地址因此不会把它降级到平台信任；只允许从未固定到固定的方向。

## 信任模型

- **配对 CA 是固定通道的唯一信任锚**。
- TOFU 只用于取回 `ca.cer`：握手阶段接受任意证书；**真正的信任决策**是 `ValidateFetchedCa(der, instanceId)`——
  CA 的 SHA-256 必须等于链接里的 `instanceId`，因此攻击者无法伪造出同指纹的 CA。
- 叶子校验顺序：`Issuer` → CA/叶子有效期 → 非 CA → `EKU(serverAuth)` → 链固定到 CA → `SAN`
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
| `DownloadStarting` | 仅配对网关同源允许，经保存对话框落盘；非网关地址一律取消并提示 |
| `PermissionRequested` | 仅配对网关页面的麦克风允许（走电脑端语音）；摄像头与其他权限一律 `Deny` |
| `ProcessFailed` | 浏览器进程退出提示重连；渲染/frame 进程崩溃自动 `Reload` 并提示 |

提示按类别每会话只显示一次，避免权限/下载事件反复弹窗。

## 已知差距

- **真机验收未完成**：iroh / 局域网 / 远程三通道与五类 WebView2 策略尚未在维护者的 Windows 机器上完整走查，本文描述的是设计与已入库的自动检查。
- **更新流程无签名**：安装包未做代码签名，首次运行会触发 SmartScreen；`PrivilegesRequired=lowest` 使其无需管理员权限，但用户若把客户端装在受保护目录，升级会因写权限失败（安装程序的错误对话框是唯一提示）。启动安装程序后当前进程即退出，不请求 Inno 的 Restart Manager 重新拉起客户端，所以升级后需要用户重新打开。

## 持久化与便携边界

- `Root = AppContext.BaseDirectory`；`data/` 存放 `devices.json`、`settings.json`、`client.log`（达到 2 MB 轮转出 `client.log.1`）与 WebView2 用户目录 `data/webview2/`。
- `settings.json` 保存图标、启动方式、主题、任务完成提醒开关和上次连接的电脑；它是外壳偏好，不是信任数据，损坏或缺失时按默认值继续运行。
- iroh 身份由 sidecar 强制存放于 `%USERPROFILE%\.dsh-mobile-win\iroh`（其私有目录 ACL 校验拒绝盘符根目录）。
- sidecar 缓存于 `data/components/iroh/<version>/`，损坏或不匹配 pin 时删除重取，绝不启动未校验的二进制。
- `deviceToken` 以 DPAPI(CurrentUser) 加密后落盘，不跨用户/跨机可用；一次性 `irohCode` / `gatewayToken` 从不持久化。

## 构建与测试

- 前置：.NET 8 SDK（x64）+ WebView2 Evergreen；构建与运行仅支持 Windows x64（见 README「系统要求」）。
- 命令：`dotnet restore` / `dotnet build -c Release` / `dotnet test ../DshMobile.Win.Tests/DshMobile.Win.Tests.csproj -c Release`。
- CI：`.github/workflows/windows-client.yml` 在 `windows-latest` 上执行同一组 restore/build/test 步骤（restore 测试项目，再以 `--no-restore` 构建主项目并测试）；不产出发布包，也不做 WebView2/真机验收。发布包只由 `.github/workflows/windows-release.yml` 在推送 `windows-v<版本>` 标签时产出（自包含 win-x64 目录 → zip + SHA-256 → 预发布）。
- 单元测试：`DshMobile.Win.Tests/` 覆盖 `UrlPairing`、`PairingDescriptor`、`PairingTrustPolicy`（含 404 的 dsh2 硬失败 / dsh1 回退）、`CertificatePolicy`（`ValidateFetchedCa`、DNS/通配/IP SAN、固定 origin 前置校验）、`DeviceStore.Validate`（含 `AdoptNewOrigin` 与排序）、`DeviceOrder`、`DeviceStatus`/`DeviceReachability`、`StartupBehavior`、`ClientLog` 轮转、`PortableData`、`ConnectionDiagnosis`、`UpdateCheck`（含安装包/校验资产选择）、`UpdateInstaller`（校验值解析与比对、中断/超时/取消、校验不过不启动安装程序）、`WebView2Availability`、`SidecarProvisioner.Verify`、`LanDiscovery`（公告校验、手输归一化、子网推导、UDP 收听）、`SseParser`、`WebViewPolicy`（同源判定）；用例数与结果以实际运行 `dotnet test` 为准，文档不记录一次性本机结果。
- 验收状态：iroh / 局域网 / 远程通道与 WebView2 五类策略尚未完成维护者真机验收；需要 Windows 机器按验收清单复核。
