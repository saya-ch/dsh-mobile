# DSH Mobile Windows 客户端

[English](README.en.md) · [返回项目首页](../../README.md) · [架构与安全模型](ARCHITECTURE.md)

在 Windows 电脑上使用 DSH Mobile 的 Windows 客户端。它通过电脑端 DSH Mobile 插件提供的认证 HTTPS 页面连接，本体是一个带配对与证书校验的 WebView2 外壳——不打包另一套前端，也不修改页面 DOM。

- 显示名称与 Android 版一致：**DeepSeek Harness**
- 与手机共用同一套启动图标（4 种吉祥物姿态 + 6 种鲸鱼配色，可在设置里切换）
- 组件职责、三通道数据流与信任模型见 [ARCHITECTURE.md](ARCHITECTURE.md)

## 下载

Windows 客户端提供两种形态，按需要选一个：

| 形态 | 下载 | 说明 |
| --- | --- | --- |
| 便携版（zip） | **[dsh-mobile-windows-v0.1.1-alpha-win-x64.zip](https://github.com/saya-ch/dsh-mobile/releases/download/windows-v0.1.1-alpha/dsh-mobile-windows-v0.1.1-alpha-win-x64.zip)**（65.8 MB，解压后约 149 MB） | 解压即用；不写注册表、不需要管理员权限；整个文件夹可以拷走 |
| 安装包（exe） | **[dsh-mobile-windows-v0.1.1-alpha-win-x64-setup.exe](https://github.com/saya-ch/dsh-mobile/releases/download/windows-v0.1.1-alpha/dsh-mobile-windows-v0.1.1-alpha-win-x64-setup.exe)** | 按向导安装到用户目录（可自己选择安装路径）；创建开始菜单快捷方式和可选桌面快捷方式；可从“设置 > 应用”卸载；卸载保留 `data\` |

SHA-256 校验文件：[zip](https://github.com/saya-ch/dsh-mobile/releases/download/windows-v0.1.1-alpha/dsh-mobile-windows-v0.1.1-alpha-win-x64.zip.sha256) · [setup.exe](https://github.com/saya-ch/dsh-mobile/releases/download/windows-v0.1.1-alpha/dsh-mobile-windows-v0.1.1-alpha-win-x64-setup.exe.sha256) · [所有版本](https://github.com/saya-ch/dsh-mobile/releases)

**便携版**：解压到任意可写目录，运行 `DshMobile.Win.exe`。不安装任何东西，也不写注册表。

**安装包**：双击运行 setup.exe，按向导选择安装路径（默认在 `%LocalAppData%\Programs\DshMobile`，不需要管理员权限），完成后从开始菜单启动。卸载时默认保留程序目录下的 `data\`，已配对电脑、设置和日志不会丢；只有卸载向导里明确选择删除才会清除。

两种形态都是**自包含**的：不装 .NET、不需要管理员权限。便携版整个文件夹可以拷走；安装包的 `data\` 在安装目录旁。`devices.json` 里的设备令牌用当前 Windows 账户加密，换机或换用户需要重新配对。

下载后可以用 `Get-FileHash <文件> -Algorithm SHA256` 与校验文件比对。

> **alpha 预览**：当前 `0.1.0-alpha`。它不随插件发布，也不在 npm 包里；插件与 Android App 仍是稳定面。还没有在真实 Windows 机器上完成三通道验收，遇到问题属预期内，请附 `data\client.log` 反馈。

## 系统要求

| 项 | 要求 |
| --- | --- |
| 系统 | Windows 10 1809+ / Windows 11 |
| 架构 | **x64**（不支持 ARM64；也不能在 Linux/macOS 上运行或编译） |
| 运行时 | 不需要安装 .NET（自包含发布） |
| WebView2 | Evergreen Runtime。Windows 11 自带；Windows 10 需装一次，见 https://developer.microsoft.com/microsoft-edge/webview2 |
| 首次 iroh 连接 | 需联网下载并校验官方组件（约 14.8 MB） |

## 功能

### 连接

- **三种通道**：`局域网`、`远程`（都粘贴 `https://…/mobile-access/pair#…` 配对链接）、`iroh`（粘贴 iroh 配对内容，由官方组件建立加密隧道）。
- **局域网发现**：扫描局域网或手动输入地址查找电脑，找到后再粘贴该电脑的配对链接；链接地址与发现结果不一致会提醒确认。
- **免扫码重连**：配对一次后，以后直接点「连接」即可。
- **地址跟随**：远程地址变化或凭据过期时，可粘贴同一台电脑的当前链接更新地址并保留名称。已固定证书的电脑只接受同样要求固定证书的链接，不会被降级。
- **启动行为**：可选择每次打开客户端时显示设备列表，或直接连接上次使用的电脑。

### 设备列表

- **状态可见**：每台电脑显示可达状态（可达 / 检测中 / 暂不可达 / 当前连接 / 配对已过期 / 电脑端已移除），后台定期检测，连接期间暂停。
- **最近连接**：显示上次使用时间（「19 分钟前」「2 天前」）。
- **重命名与排序**：可重命名、上移、移到最前，顺序重启后保持。
- **删除可撤销**：删除后 5 秒内可撤销（只删本机记录，不影响电脑端授权）。

### 提醒与外观

- **任务完成提醒**：连接期间任务完成会弹出桌面通知；可在设置里关闭。电脑端撤销设备会提示并停止提醒。
- **应用图标**：4 种吉祥物姿态 + 6 种鲸鱼配色，与手机 App 相同。低于 32px 的尺寸使用简化鲸鱼标，托盘里也看得清。
- **深浅色**：跟随 Windows，也可在设置里固定浅色或深色。
- **页面缩放、字号、阅读模式**等仍然在 DSH 页面自己的设置里，与手机一致。

### 安全

- **证书固定**：配对时自动固定这台电脑的证书，对不上就拒绝连接，不会让你往系统里装证书。连接前会用原生 TLS 亲手验证一次，不只是依赖浏览器的判定。
- **凭据加密**：设备令牌用 Windows 账户加密保存在本目录，换台电脑或换个用户就要重新配对。
- **下载与权限**：与网关同源的下载经保存对话框落盘，非网关地址阻止；页面可用麦克风（走电脑端语音），摄像头与其他权限一律拒绝。
- **页面零注入**：顶栏是窗口级原生控件，不注入也不改动页面 DOM。

## 使用

1. 便携版解压后运行 `DshMobile.Win.exe`；安装包从开始菜单或安装目录运行 `DshMobile.Win.exe`；
2. 在电脑端 DSH 的「移动访问」面板里生成配对，把配对链接粘贴到客户端，点「配对并连接」；
3. 之后每次打开点「连接」即可。

运行时数据都在程序目录的 `data\` 内：

| 路径 | 内容 |
| --- | --- |
| `data\devices.json` | 已配对电脑（令牌经 Windows 账户加密） |
| `data\settings.json` | 图标、主题、启动方式、通知开关 |
| `data\client.log` | 日志（超过 2 MB 自动轮转，保留上一份） |
| `data\components\iroh\` | 已校验的 iroh 组件缓存 |
| `data\webview2\` | WebView2 用户目录（缓存、Cookie） |

iroh 客户端身份由组件强制存放于 `%USERPROFILE%\.dsh-mobile-win\iroh`，换机需重新配对。

## 从源码构建

前置条件：.NET 8 SDK（x64）。仅支持在 Windows x64 上构建与运行。

```bash
cd apps/windows/DshMobile.Win

dotnet restore
dotnet build -c Release
dotnet test ../DshMobile.Win.Tests/DshMobile.Win.Tests.csproj -c Release

# 便携版（自包含 .NET，输出为独立目录，拷走即用）
dotnet publish -c Release -r win-x64 --self-contained true -o <目标目录>

# 安装包（需要 Inno Setup 6；版本自动从 DshMobile.Win.csproj 读取）
pwsh ../installer/build-installer.ps1 -PublishDir <目标目录>
```

无需 Rust / Android 工具链：iroh 传输复用官方发布的组件，组件本身不进仓库，首次使用时按固定地址下载并校验大小与 SHA-256，每次启动前重新校验。

安装包脚本在 `installer/DshMobile.Win.iss`。Inno Setup 6 可通过 `winget install --id JRSoftware.InnoSetup` 安装；`build-installer.ps1` 会自动查找 ISCC.exe，也可以用 `-IsccPath` 指定。

## 目录结构

```
apps/windows/
├── ARCHITECTURE.md / .en.md   # 架构与安全模型
├── README.md / .en.md         # 本文
├── installer/                 # Inno Setup 安装包脚本 + 简体中文语言文件
├── DshMobile.Win/             # 客户端源码（WPF + WebView2）
│   ├── *.cs / *.xaml
│   ├── icons/                 # 10 种可选图标（多尺寸 ICO + 品牌图）
│   ├── sidecar/               # 固定版本 / 下载地址 / SHA-256 pin + 许可文本
│   └── DshMobile.Win.csproj
└── DshMobile.Win.Tests/       # 纯逻辑单测（xunit）
```

## 给维护者

**版本与发布**：版本号写在 `DshMobile.Win.csproj` 的 `<Version>` 里，与插件版本、iroh 组件 pin 相互独立。发版时打 `windows-v<版本>` 标签，`.github/workflows/windows-release.yml` 会校验标签与项目版本一致，构建、跑单测、打包便携 zip 并用 Inno Setup 编译安装包，两者各附 SHA-256 后以预发布形式上传。

**iroh 组件 pin 有三处**，`scripts/check-windows-sidecar-pin.mjs` 会断言一致：`src/iroh-component.ts` 里的 `IROH_COMPONENT_RELEASES['win32-x64']` 是权威值，`SidecarProvisioner.cs` 硬编码同值，`sidecar/manifest.json` 只是镜像。升级 pin 时三处必须一起改。

**CI**：`.github/workflows/windows-client.yml` 在 `windows-latest` 上构建并跑纯逻辑单测，不产出发布包；发布包只由 `windows-release.yml` 在打标签时产出。

本目录是新增端，不修改插件与 Android 既有代码；仓库约定见根目录 `AGENTS.md`。
