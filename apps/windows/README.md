# DSH Mobile Windows 客户端

[English](README.en.md) · [返回项目首页](../../README.md) · [架构与安全模型](ARCHITECTURE.md)

DSH Mobile 的便携 Windows 客户端，与仓库内 Android App（`apps/mobile/android/`）对应：让 Windows 通过电脑端 DSH Mobile 插件提供的认证 HTTPS 页面使用 DSH 会话。程序本体是一个带配对与证书校验的 WebView2 外壳，不打包另一套前端。

- 显示名称与 Android 版一致：**DeepSeek Harness**
- 启动图标复用 Android 主启动图标（`apps/mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png`，`DshMobile.Win/app.ico` 由该 PNG 转换而来）
- 组件职责、三通道数据流与信任模型见 [ARCHITECTURE.md](ARCHITECTURE.md)

## 状态与支持范围

- **源码预览，尚未发布**：本目录已合入 `main`，但**尚未随任何 Release 发布**，没有官方下载包，也不在 npm 包的 `files` 中；需要按下方命令自行编译。
- **尚未完成维护者验收**：维护者尚未在真实 Windows 机器上完成 iroh / 局域网 / 远程 / WebView2 五类策略的验收矩阵；本文与 `ARCHITECTURE.md` 描述的是设计与已入库的检查，**不承诺可用性**。
- **支持范围**：Windows 10 1809+ / Windows 11，**x64**。不支持 Windows ARM64，也不支持在 Linux/macOS 上构建（WPF `net8.0-windows` + `RuntimeIdentifiers=win-x64`）。
- **前置**：.NET 8 SDK（x64）、WebView2 Evergreen Runtime（Windows 11 自带；Windows 10 需安装，见 https://developer.microsoft.com/microsoft-edge/webview2 ）；首次 iroh 连接需要联网下载并校验官方 sidecar（约 14.8 MB / 14,865,920 字节）。

## 功能

- **三种连接通道**
  - `iroh`：粘贴 iroh 配对 JSON 描述符，经官方 sidecar（`phone-sim`）建立 QUIC 隧道 + 本地回环 TLS 载体；sidecar 不随仓库分发，按固定 URL + SHA-256 获取并在每次启动进程前校验；
  - `局域网` / `远程`：粘贴 `https://…/mobile-access/pair#…` 配对链接（legacy `instance/token` 或 `dsh1`/`dsh2` key），从 `/mobile-access/ca.cer` 引导获取配对 CA（TOFU + instanceId 指纹锚定），直连网关。
- **免扫码重连**：首次配对保存设备凭据（deviceToken 经 DPAPI 加密落盘），后续启动直接点「连接」，iroh 走 Hello、直连走 `native-renew`。
- **设备管理**：多设备卡片、重命名、删除；每张卡片显示通道类型与凭据有效期。
- **安全**：配对 CA 是固定通道的唯一信任锚；叶子证书按 `Issuer` → CA/叶子有效期 → 非 CA → `EKU(serverAuth)` → 链固定到 CA → `SAN`（DNS 精确或单层通配；局域网网关的 IP SAN 逐字节比较）逐项校验后才放行 WebView2 证书错误。WebView2 错误路径对 `Expired`/`Revoked` 一律拒绝；自定义 CA 的 native TLS 通道不查吊销（`X509RevocationMode.NoCheck`，配对 CA 自签、无吊销信息）。
- **顶栏与标题栏**：原生标题栏下方的窗口级顶栏行（设备列表 / 连接状态 / 断开），颜色与 DWM 标题栏一致；页面 DOM 零注入、零改动。
- **深浅色**：语义颜色 token（`design-system/dsh-mobile/MASTER.md`），跟随系统深浅色；环境变量 `DSH_MOBILE_THEME=light|dark` 可覆盖。

## 目录结构

```
apps/windows/
├── .gitignore                # 忽略 bin/ obj/ data/
├── ARCHITECTURE.md           # 架构与安全模型（中文）
├── ARCHITECTURE.en.md        # 架构与安全模型（英文）
├── README.en.md              # 英文说明
├── DshMobile.Win/            # 客户端源码（WPF + WebView2）
│   ├── *.cs / *.xaml          # 源码
│   ├── app.ico                # Android 同款启动图标（由 PNG 转换）
│   ├── DshMobile.Win.csproj
│   └── sidecar/
│       ├── manifest.json                 # 固定版本 / 下载地址 / 字节数 / SHA-256 pin（镜像）
│       ├── LICENSE.dsh-mobile-iroh      # 以下三份来自 native/iroh-host/
│       ├── LICENSE.dsh-tether
│       └── NOTICE.dsh-mobile-iroh
└── DshMobile.Win.Tests/      # 纯逻辑单测（xunit）
    └── DshMobile.Win.Tests.csproj
```

## 编译与发布

前置条件见「状态与支持范围」。仅支持在 Windows x64 上构建与运行。

```bash
cd apps/windows/DshMobile.Win

# 编译
dotnet restore
dotnet build -c Release

# 纯逻辑单测（无需设备或网关）
dotnet test ../DshMobile.Win.Tests/DshMobile.Win.Tests.csproj -c Release

# 发布便携版（自包含 .NET，输出为独立目录，拷走即用）
dotnet publish -c Release -r win-x64 --self-contained true -o <目标目录>
```

无需 Rust/Android 工具链：iroh 传输复用官方发布的 sidecar，**二进制不进仓库**。pin 的权威值在 `src/iroh-component.ts` 的 `IROH_COMPONENT_RELEASES['win32-x64']`；`SidecarProvisioner` 硬编码同值，`sidecar/manifest.json` 只是镜像，三处没有机器校验（升级上游 pin 时需同步）。首次 iroh 连接时按固定 URL 下载并按字节数 + SHA-256 校验；若本机插件把同一副本装在默认 `~/.dsh/mobile-access/components/iroh/<version>/`，则直接复用（自定义 DSH home 不复用，回退为联网下载）。每次启动 sidecar 进程前都会重新校验，哈希不符拒绝启动。

`.github/workflows/windows-client.yml` 在 `windows-latest` 上先 restore 测试项目，再以 `--no-restore` 构建主项目并运行测试（效果等价于上面的 restore/build/test），只覆盖源码构建与纯逻辑单测；不产出发布包，也不做 WebView2/真机验收。该 job 是否被设为 required check 由维护者在 GitHub 分支保护中配置，仓库内无法体现。依赖取自 NuGet 默认源（nuget.org）。若所处网络访问较慢，请在**用户级**加镜像而不是改仓库配置：`dotnet nuget add source <镜像地址> -n <名称>`。

发布目录根部是 `DshMobile.Win.exe` 与 .NET 依赖；运行时数据（`devices.json`、`client.log`、WebView2 用户目录、下载的 sidecar 缓存）都在该目录的 `data\` 内。sidecar 与 `sidecar/` 下的许可文本不随发布目录分发。

## 便携边界

- iroh 客户端身份数据由 sidecar 强制存放于 `%USERPROFILE%\.dsh-mobile-win\iroh`（其私有目录 ACL 校验拒绝盘符根目录），换机需重新扫码配对；
- sidecar 缓存于 `data\components\iroh\<version>\`，损坏或不匹配 pin 时删除重取，绝不启动未校验的二进制；
- 已配对设备记录在 `data\devices.json`，其中 deviceToken 经 DPAPI(CurrentUser) 加密，不随文件夹跨机迁移；
- 日志：`data\client.log`。

## 与上游仓库的关系

本目录是新增端，不修改插件与 Android 既有代码；仓库约定见根目录 `AGENTS.md`（上游 DSH 源码只读，改动仅留在本仓库）。功能改动集中在 `apps/windows/`；唯一的仓库级例外是 `.github/workflows/windows-client.yml`（Windows 客户端的 CI job），其余上游文件不应出现在 diff 中。
