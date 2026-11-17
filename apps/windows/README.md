# DSH Mobile Windows 客户端

[English](README.en.md) · [返回项目首页](../../README.md) · [架构与安全模型](ARCHITECTURE.md)

DSH Mobile 的便携 Windows 客户端，与仓库内 Android App（`apps/mobile/android/`）对应：让 Windows 通过电脑端 DSH Mobile 插件提供的认证 HTTPS 页面使用 DSH 会话。程序本体是一个带配对与证书校验的 WebView2 外壳，不打包另一套前端。

- 显示名称与 Android 版一致：**DeepSeek Harness**
- 启动图标复用 Android 主启动图标（`apps/mobile/android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png`，`DshMobile.Win/app.ico` 由该 PNG 转换而来）
- 组件职责、三通道数据流与信任模型见 [ARCHITECTURE.md](ARCHITECTURE.md)

## 状态与支持范围

- **暂时没有安装包**：这个客户端还在开发中，没有官方下载包，也不在 npm 包里；想试用需要按下方命令自己编译。
- **可能连不上**：还没有在任何一台 Windows 机器上完成 iroh / 局域网 / 远程的完整验收，本文与 `ARCHITECTURE.md` 描述的是设计与已入库的检查。遇到问题属预期内，请附 `data\client.log` 反馈。
- **能用在哪**：Windows 10 1809+ / Windows 11 的 **x64** 电脑。不支持 Windows ARM64；也不能在 Linux/macOS 上编译这个客户端。
- **前置**：.NET 8 SDK（x64）、WebView2 Evergreen Runtime（Windows 11 自带；Windows 10 需安装，见 https://developer.microsoft.com/microsoft-edge/webview2 ）；首次 iroh 连接需要联网下载并校验官方 sidecar（约 14.8 MB / 14,865,920 字节）。

## 功能

- **三种连接通道**
  - `iroh`：粘贴 iroh 配对内容，由官方组件建立加密隧道；
  - `局域网` / `远程`：粘贴 `https://…/mobile-access/pair#…` 配对链接，直连网关。
- **局域网发现**：扫描局域网或手动输入地址查找电脑，选中后再粘贴该电脑的配对链接；链接地址与发现结果不一致会提醒确认。
- **地址跟随**：远程地址变化（如 cpolar 临时地址）或凭据过期时，可粘贴同一台电脑的当前链接更新地址并保留名称。已固定证书的电脑只接受同样要求固定证书的链接，不会被降级成不校验证书。
- **免扫码重连**：配对一次后，以后直接点「连接」即可，不用再粘贴。
- **任务完成提醒**：连接期间任务完成会弹出桌面通知，点击回到页面；电脑端撤销设备会提示并停止提醒。
- **下载与语音**：配对网关同源的下载经保存对话框落盘，非网关地址仍阻止；配对网关的页面可用麦克风（走电脑端语音），摄像头与其他权限仍拒绝。
- **设备管理**：多设备卡片、重命名、删除；每张卡片显示连接方式和凭据有效期。
- **安全**：配对时自动固定这台电脑的证书，对不上就拒绝连接，不会让你往系统里装证书。凭据用 Windows 账户加密保存在本目录，换台电脑或换个用户就要重新配对。WebView2 路径下过期或已吊销的证书一律拒绝；这些固定通道使用的自定义 CA 通道不查吊销，因为配对 CA 自签、没有吊销信息。
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

无需 Rust/Android 工具链：iroh 传输复用官方发布的组件，**组件本身不进仓库**。首次 iroh 连接时按固定地址下载并校验大小和 SHA-256；如果电脑上已有插件装好的同一份副本，会直接复用。每次启动组件前都会重新校验，对不上就拒绝启动。

`.github/workflows/windows-client.yml` 在 `windows-latest` 上先 restore 测试项目，再以 `--no-restore` 构建主项目并运行测试（效果等价于上面的 restore/build/test），只覆盖源码构建与纯逻辑单测；不产出发布包，也不做 WebView2/真机验收。该 job 是否被设为 required check 由维护者在 GitHub 分支保护中配置，仓库内无法体现。依赖取自 NuGet 默认源（nuget.org）。若所处网络访问较慢，请在**用户级**加镜像而不是改仓库配置：`dotnet nuget add source <镜像地址> -n <名称>`。

发布目录根部是 `DshMobile.Win.exe` 与 .NET 依赖；运行时数据（`devices.json`、`client.log`、WebView2 用户目录、下载的 sidecar 缓存）都在该目录的 `data\` 内。sidecar 与 `sidecar/` 下的许可文本不随发布目录分发。

## 便携边界

- iroh 客户端身份数据由 sidecar 强制存放于 `%USERPROFILE%\.dsh-mobile-win\iroh`（其私有目录 ACL 校验拒绝盘符根目录），换机需重新扫码配对；
- sidecar 缓存于 `data\components\iroh\<version>\`，损坏或不匹配 pin 时删除重取，绝不启动未校验的二进制；
- 已配对设备记录在 `data\devices.json`，其中 deviceToken 经 DPAPI(CurrentUser) 加密，不随文件夹跨机迁移；
- 日志：`data\client.log`。

## 给维护者

iroh 组件的 pin 存在三处，`scripts/check-windows-sidecar-pin.mjs` 会在 Windows 客户端 CI 里断言三处一致：`src/iroh-component.ts` 里的 `IROH_COMPONENT_RELEASES['win32-x64']` 是权威值，`apps/windows/DshMobile.Win/SidecarProvisioner.cs` 硬编码同值，`apps/windows/DshMobile.Win/sidecar/manifest.json` 只是镜像；升级 pin 时三处必须一起改，否则该检查会失败。

本目录是新增端，不修改插件与 Android 既有代码；仓库约定见根目录 `AGENTS.md`（上游 DSH 源码只读，改动仅留在本仓库）。功能改动集中在 `apps/windows/`；唯一的仓库级例外是 `.github/workflows/windows-client.yml`（Windows 客户端的 CI job），其余上游文件不应出现在 diff 中。
