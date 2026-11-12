# DSH Mobile Windows 客户端

DSH Mobile 的便携 Windows 客户端，与仓库内 Android App（`apps/mobile/android/`）对应：让 Windows 通过电脑端 DSH Mobile 插件提供的认证 HTTPS 页面使用 DSH 会话。程序本体是一个带配对与证书校验的 WebView2 外壳，不打包另一套前端。

- 显示名称与 Android 版一致：**DeepSeek Harness**
- 启动图标复用 Android 主启动图标（`apps/mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png`，生成于 `DshMobile.Win/app.ico`）

## 功能

- **三种连接通道**
  - `iroh`：粘贴 iroh 配对 JSON 描述符，经官方 sidecar（`phone-sim`）建立 QUIC 隧道 + 本地回环 TLS 载体；
  - `局域网` / `远程`：粘贴 `https://…/mobile-access/pair#…` 配对链接（legacy `instance/token` 或 `dsh1`/`dsh2` key），从 `/mobile-access/ca.cer` 引导获取配对 CA（TOFU + instanceId 指纹锚定），直连网关。
- **免扫码重连**：首次配对保存设备凭据（deviceToken 经 DPAPI 加密落盘），后续启动直接点「连接」，iroh 走 Hello、直连走 `native-renew`。
- **设备管理**：多设备卡片、重命名、删除；每张卡片显示通道类型与凭据有效期。
- **安全**：配对 CA 是唯一信任锚；叶子证书按 链 → SAN（含 IP）→ EKU → 有效期 严格校验后才放行 WebView2 证书错误；过期/吊销一律拒绝。
- **顶栏与标题栏**：原生标题栏下方的窗口级顶栏行（设备列表 / 连接状态 / 断开），颜色与 DWM 标题栏一致；页面 DOM 零注入、零改动。
- **深浅色**：语义颜色 token（`design-system/dsh-mobile/MASTER.md`），跟随系统深浅色；环境变量 `DSH_MOBILE_THEME=light|dark` 可覆盖。

## 目录结构

```
apps/windows/
├── .gitignore                # 忽略 bin/ obj/ data/
└── DshMobile.Win/
    ├── *.cs / *.xaml          # 源码（WPF + WebView2）
    ├── app.ico                # Android 同款启动图标
    ├── DshMobile.Win.csproj
    └── sidecar/
        ├── dsh-mobile-iroh-host-win32-x64.exe   # 固定版本的官方 iroh sidecar
        └── manifest.json                         # 上游发布的 SHA-256 清单
```

## 编译与发布

前置条件：

- .NET 8 SDK（x64）
- WebView2 Evergreen Runtime（Win11 自带；未安装时访问 https://developer.microsoft.com/microsoft-edge/webview2 ）
- 无需 Rust/Android 工具链：iroh 传输复用官方发布的 sidecar exe，版本与 SHA-256 见 `sidecar/manifest.json`

```bash
cd apps/windows/DshMobile.Win

# 编译
dotnet restore
dotnet build -c Release

# 发布便携版（自包含 .NET，输出为独立目录，拷走即用）
dotnet publish -c Release -r win-x64 --self-contained true -o <目标目录>
```

依赖取自 NuGet 默认源（nuget.org）。若所处网络访问较慢，请在**用户级**加镜像而不是改仓库配置：`dotnet nuget add source <镜像地址> -n <名称>`。

发布产物无需安装、不写注册表；程序、WebView2 用户目录与日志都在输出目录的 `data\` 内。

## 便携边界

- iroh 客户端身份数据由 sidecar 强制存放于 `%USERPROFILE%\.dsh-mobile-win\iroh`（其私有目录 ACL 校验拒绝盘符根目录），换机需重新扫码配对；
- 已配对设备记录在 `data\devices.json`，其中 deviceToken 经 DPAPI(CurrentUser) 加密，不随文件夹跨机迁移；
- 日志：`data\client.log`。

## 与上游仓库的关系

本目录是新增端，不修改插件与 Android 既有代码；仓库约定见根目录 `AGENTS.md`（上游 DSH 源码只读，改动仅留在本仓库）。向本仓库提 PR 时，`git diff` 不应包含 `apps/windows/` 以外的任何变更。
