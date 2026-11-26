# 托管 Caddy

[English](CADDY_MANAGED.en.md)

> 插件 0.6.9 起，Windows/Linux x64 可按需安装托管 Caddy，由插件管理 HTTPS 与证书。组件来自 DSH Mobile 审核发布的固定构建，不是 Caddy 官方定制下载接口。已有 Cloudflared 等通道和自备反向代理继续可用，无需迁移或升级 Android App。

## 适用条件

托管 Caddy 为自建连接管理 HTTPS 代理和证书，不提供内网穿透。你需要自己的域名、可由腾讯云 DNSPod 凭据修改的 DNS-01 验证记录，以及能到达运行 DSH 电脑的公网 HTTPS 入站端口。电脑位于可管理的路由器之后时，需要把公网端口映射到本机 Caddy 端口；云主机则需检查安全组和主机防火墙。DNS-01 只验证域名控制权，不会打通 CGNAT、校园网隔离或没有入站权限的网络；这类网络可选择 Cloudflare Tunnel、cpolar，或已有 VPS 上的 FRP。

当前面板只支持 `tencentcloud` DNS 模块与腾讯云 DNSPod 凭据，不支持把其他 DNS 服务商的密钥填入此模式。使用 Cloudflare DNS 的用户可以继续使用 Cloudflared，无需为本功能迁移 DNS；不要把 Cloudflared 连接器 Token 填入腾讯云密钥栏。

```text
Android App / 浏览器 → 公网 HTTPS 域名（Caddy 终止 TLS）
                  → 127.0.0.1 上的独立 HTTP Gateway
                  → 当前 DSH WebServer
```

## 与自备反向代理的关系

两者属于「自备反向代理」提供方的不同上游模式。默认仍为自备代理：你维护 Lucky、Nginx 或 Caddy，插件只提供 HTTP 后端。切换为托管模式后，插件拥有一个独立的 Caddy 子进程和回环 Gateway，先停止旧模式再启动新模式；原有代理配置和已配对设备记录保留，不会被托管配置覆盖。

公网入口、DNS-01 凭据与本机 HTTPS 端口需单独配置。公网 URL 可以使用 443，而路由器转发到本机 8443；「本机 HTTPS 端口」是 Caddy 实际绑定的端口，范围为 1024–65535，3080、3443、3444 保留不可选。确认本机端口未占用，并在主机防火墙、路由器或云安全组中放行所需 HTTPS 入站；不要开放回环 HTTP 后端。DNS-01 凭据应使用仅能管理目标 DNS 区域的最小权限账号，不要提供云账号的主密钥。

## 安装、启动与就绪

1. 在电脑端打开 **移动访问 → 自有反向代理**，选择 **托管 Caddy**。
2. 点击 **安装托管 Caddy** 并确认下载。插件从固定的 [DSH Mobile 组件分发](https://github.com/saya-ch/dsh-mobile/releases/tag/caddy-component-2.11.7-tencentcloud-0.4.3-r1) 下载，核对完整大小、SHA-256、Caddy 核心与 DNS 模块版本；来源不可用或校验失败时不会执行文件。
3. 填写公网 HTTPS 地址，例如 `https://dsh.example.com`，选择腾讯云 DNSPod，填写具有所需区域权限的 `SecretId` 和 `SecretKey`，再设置本机 HTTPS 端口，例如 `8443`。让域名解析到你的公网入口，并按需将公网 TCP 443 映射至电脑的 8443。
4. 点击 **保存并启动 Caddy**。组件已安装不等于连接就绪：只有电脑端经公网 HTTPS 验证证书，并确认入口属于当前 DSH 实例后，面板才显示已就绪。这个探测仍不能证明手机网络可达。
5. 在远程面板生成配对二维码（按钮与局域网同名），在 Android App 的 **远程访问** 中扫码，或用手机浏览器打开配对链接。用手机流量验证实际页面加载、会话同步与 WebSocket；不要只以电脑端健康检查代替手机访问。

首次 DNS-01 签发需要等待 DNS 生效和证书签发。期间电脑保持在线，避免反复重启触发签发限流。托管模式不安装系统服务、不修改 PATH、不设置开机启动、不导入系统证书；Caddy 的管理 API 和自动配置落盘均关闭。

## 隐私与清理

设置与 DNS 凭据原子保存在插件私有目录，Caddyfile 只包含环境变量占位符。子进程只获得必要的 DNS 凭据和运行环境，不继承其他 API 密钥或代理、管理口配置；原始 DNS 模块日志不保存。证书、私钥、配置缓存和运行文件也保存在该私有目录。

停止访问或切换提供方会等待 Caddy 与 Gateway 退出，但保留设置和证书，以便下次连接。确认「移除托管 Caddy 与配置」后删除受管二进制、DNS 凭据、证书私钥、日志与缓存，不删除其他提供方、局域网或设备配对数据。清理失败会报告错误并保留可重试的状态，不会把未完成的删除显示为成功。已有手动安装的代理不归插件所有，也不会被插件卸载。

## 维护者构建与验证

以下构建和验证工具需在本仓库源码 checkout 中运行；npm 插件包不包含这些维护脚本，也不需要普通用户自行编译 Caddy。

[构建脚本](<https://github.com/saya-ch/dsh-mobile/blob/main/scripts/build-caddy-component.mjs>) 固定 Go 1.26.9、xcaddy v0.4.7、Caddy v2.11.7、腾讯云 DNS v0.4.3 及 golang.org/x/net v0.60.0。[输入锁](<https://github.com/saya-ch/dsh-mobile/blob/main/scripts/caddy-component-lock.json>) 固定源码提交和编译依赖版本/校验和。每次构建使用全新的私有编译缓存及模块缓存，执行 Go 校验和、源码来源与保留模块校验；未知依赖、替换模块、编译器或原生设置漂移会在运行生成的 Caddy 前拒绝。

选择精确 Go 编译器（可用 `GO_BINARY`），输出目录必须是全新绝对路径：

```sh
node scripts/build-caddy-component.mjs --output-dir /absolute/new/first
node scripts/build-caddy-component.mjs --output-dir /absolute/new/second
node scripts/compare-caddy-builds.mjs --first /absolute/new/first --second /absolute/new/second --target linux-x64
```

Windows 使用原生绝对路径和 `--target win32-x64`。可复现指二进制字节、大小、SHA-256 一致，不保证操作系统镜像或所有元数据/许可证文本逐字一致。[工作流](<https://github.com/saya-ch/dsh-mobile/blob/main/.github/workflows/caddy-component.yml>) 在 Windows/Linux x64 分别独立构建两次，审核完整产物，并使用独立 manifest 测试真正安装后的二进制：默认版本/模块检查、目录提升、无重复下载的重启、损坏下载回滚、TLS/配对/API/WSS、持久设备凭据与停止后清理，保留邻近文件及配对数据。其他架构仍未审核。

PR 和普通手动运行只产生只读审查产物。只有授权的 `abworks-dev/dsh-mobile` fork 上已有 `caddy-component-2.11.7-tencentcloud-0.4.3-review.N` 标签，经明确手动启用且两个原生任务均通过，才发布 **TEST 预发布版**：

```sh
gh workflow run caddy-component.yml --repo abworks-dev/dsh-mobile --ref caddy-component-2.11.7-tencentcloud-0.4.3-review.1 -f publish_review_prerelease=true
```

组件标签不以 `v` 开头，避免触发插件正式发布。独立写权限任务拒绝已有 Release，创建非 latest 的预发布草稿，不覆盖资产；下载所有草稿资产与准备字节逐一对比后才公开。产物包括区分平台的原始二进制、manifest、编译/模块/版本/许可证证据、双构建证明、源码提交/运行标识和 SHA256SUMS。[发布后验证器](<https://github.com/saya-ch/dsh-mobile/blob/main/scripts/verify-caddy-release.mjs>) 用 GitHub 元数据及安装器实际 HTTPS/受限重定向下载链路复核 **所有公开资产**，成功后才输出仅供审核的目录。公开后验证失败会保留已公开的标记预发布版、使任务失败且不输出校验目录，不擅自删除或回滚 Release。CI 产物保留 14 天，Release 资产另行保存。

公开定制下载端点曾在请求 v2.11.6 时返回 v2.11.7，动态最新版不能成为信任来源。版本化 GitHub URL 仍可被仓库所有者替换；信任边界是审核过的精确大小/哈希，而非 URL 名称或远端自报校验和。fork 的目录只是审核候选，不会自动写入[生产组件表](<https://github.com/saya-ch/dsh-mobile/blob/main/src/caddy-component.ts>)。

### 正式分发与安装开放

正式组件由有仓库发布权限的维护者确认候选后手动发布，单维护者即可完成；不要求第二个人批准，也不要求预先配置 GitHub Environment。两个发布输入默认 false，PR 和普通构建不会发布。贡献者的实测可以按其版本、环境和实际验证范围作为验收依据，不要求在维护者本机重复搭建同一环境；不得将隔离测试或旧候选结果写成新二进制的公网签发、续期验收。

官方发布仅允许公开的 `saya-ch/dsh-mobile` 仓库和版本绑定的非 `v` 标签 `caddy-component-2.11.7-tencentcloud-0.4.3-r1`。维护者在已审核的 main 提交上创建该标签，然后手动运行现有工作流，显式设置 `publish_official_release=true`，保持 review 输入 false。已创建的标签不移动或覆盖；本次发布准备修正使用新的固定 `-r1` 修订标签，原标签保留。发布器检查标签 SHA 与本次 Actions SHA 相同、提交属于 main，并要求同一次运行的 Windows/Linux 原生双构建、测试和插件构建通过。错误事件、分支、仓库、互斥输入、失败原生任务或不匹配标签均拒绝发布。

唯一发布任务使用 `contents: write` 和现有 `GITHUB_TOKEN`，创建非 latest 的正式组件分发，不发布 npm/APK。已占用的 Release 不覆盖；全部 16 个草稿资产下载后逐字节比较，再公开并通过安装器实际 HTTPS 下载链路独立复核公开元数据、大小和哈希。验证失败保留实际已发布状态并使任务失败，不擅自删除或破坏性重试。

组件更新分两阶段：先发布并验证官方分发，再通过单独审核的插件目录变更，把实际公开二进制的来源、大小和 SHA-256 固定到 `CADDY_COMPONENT_RELEASES`。0.6.9 开放 Windows/Linux x64 的固定目录；将来发布新的组件资产不会自动更换用户运行的版本。

prepare/verify CLI 默认 review；尾参数 `--channel official` 选择官方身份校验。官方验证成功后生成 `official-candidate-not-production`，仍保持 `productionCatalogEnabled: false`：该 JSON 是审核输入，不是运行时配置，也不会自行启用安装。贡献者的实网反馈按其版本与部署范围采用。

隔离验证使用回环随机端口、私有内部 CA 与 `skip_install_trust`，不修改系统信任、生产 DNS 或现有代理。本次固定组件尚未取得另行的公网 DNS-01/ACME 签发与长周期续期验收；证书签发、续期、公网可达和实际页面/API/流传递应分别验证，不能由隔离 CI 或旧候选的实测替代。
