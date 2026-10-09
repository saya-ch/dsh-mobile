# 托管 Caddy

[English](CADDY_MANAGED.en.md)

> 托管模式的代码和隔离测试已接入；固定组件尚未正式分发，当前安装和连接按钮保持禁用。已有的自备 HTTPS 反向代理模式不受影响。

## 适用条件

托管 Caddy 为自建连接管理 HTTPS 代理和证书，不提供内网穿透。你需要自己的域名、由腾讯云 DNSPod 管理的 DNS，以及可从公网访问的入站端口；路由器需把公网端口映射到运行 DSH 的电脑。CGNAT、校园网隔离或没有入站权限的网络不能仅靠 DNS-01 绕过限制，可以使用 Cloudflare Tunnel、cpolar，或已有 VPS 上的 FRP。

```text
Android App / 浏览器 → 公网 HTTPS 域名（Caddy 终止 TLS）
                  → 127.0.0.1 上的独立 HTTP Gateway
                  → 当前 DSH WebServer
```

## 与自备反向代理的关系

两者属于「自备反向代理」提供方的不同上游模式。默认仍为自备代理：你维护 Lucky、Nginx 或 Caddy，插件只提供 HTTP 后端。切换为托管模式后，插件拥有一个独立的 Caddy 子进程和回环 Gateway，先停止旧模式再启动新模式；原有代理配置和已配对设备记录保留，不会被托管配置覆盖。

公网入口、DNS-01 凭据与本机 HTTPS 端口需单独配置。公网 URL 可以使用 443，而路由器转发到本机 8443；「本机 HTTPS 端口」是 Caddy 实际绑定的端口。3080、3443、3444 在此模式中保留，不可选择；其他端口仍需确认未被占用。DNS-01 凭据应使用仅能管理目标 DNS 区域的最小权限账号，不要提供云账号的主密钥。

## 安装、启动与就绪

官方组件分发本身不启用安装：还需独立验证实际资产，并通过后续独立审核的生产目录 PR 固定来源。完成第二阶段后，安装仍需要你明确确认下载。插件检查完整大小、SHA-256、Caddy 核心版本和 DNS 模块版本；来源不可用或验证失败时不执行文件。组件已安装不等于连接就绪：本地配置完成解析后启动代理，只有公网 HTTPS 证书通过验证，并确认 discovery 属于当前 DSH 实例，才显示已就绪。

首次 DNS-01 签发需要等待 DNS 生效和证书签发。期间电脑保持在线，避免反复重启触发签发限流。托管模式不安装系统服务、不修改 PATH、不设置开机启动、不导入系统证书；Caddy 的管理 API 和自动配置落盘均关闭。

## 隐私与清理

设置与 DNS 凭据原子保存在插件私有目录，Caddyfile 只包含环境变量占位符。子进程只获得必要的 DNS 凭据和运行环境，不继承其他 API 密钥或代理、管理口配置；原始 DNS 模块日志不保存。证书、私钥、配置缓存和运行文件也保存在该私有目录。

停止访问或切换提供方会等待 Caddy 与 Gateway 退出，但保留设置。确认「移除托管 Caddy 与配置」后删除受管二进制、DNS 凭据、证书私钥、日志与缓存，不删除其他提供方、局域网或设备配对数据。已有手动安装的代理不归插件所有，也不会被插件卸载。

## 维护者构建与验证

以下构建和验证工具需在本仓库源码 checkout 中运行；npm 插件包不包含这些维护脚本，也不需要普通用户自行编译 Caddy。

[构建脚本](<../scripts/build-caddy-component.mjs>) 固定 Go 1.26.6、xcaddy v0.4.7、Caddy v2.11.6 和腾讯云 DNS v0.4.3。[输入锁](<../scripts/caddy-component-lock.json>) 固定源码提交和编译依赖版本/校验和。每次构建使用全新的私有编译缓存及模块缓存，执行 Go 校验和、源码来源与保留模块校验；未知依赖、替换模块、编译器或原生设置漂移会在运行生成的 Caddy 前拒绝。

选择精确 Go 编译器（可用 `GO_BINARY`），输出目录必须是全新绝对路径：

```sh
node scripts/build-caddy-component.mjs --output-dir /absolute/new/first
node scripts/build-caddy-component.mjs --output-dir /absolute/new/second
node scripts/compare-caddy-builds.mjs --first /absolute/new/first --second /absolute/new/second --target linux-x64
```

Windows 使用原生绝对路径和 `--target win32-x64`。可复现指二进制字节、大小、SHA-256 一致，不保证操作系统镜像或所有元数据/许可证文本逐字一致。[工作流](<../.github/workflows/caddy-component.yml>) 在 Windows/Linux x64 分别独立构建两次，审核完整产物，并使用独立 manifest 测试真正安装后的二进制：默认版本/模块检查、目录提升、无重复下载的重启、损坏下载回滚、TLS/配对/API/WSS、持久设备凭据与停止后清理，保留邻近文件及配对数据。其他架构仍未审核。

PR 和普通手动运行只产生只读审查产物。只有授权的 `abworks-dev/dsh-mobile` fork 上已有 `caddy-component-2.11.6-tencentcloud-0.4.3-review.N` 标签，经明确手动启用且两个原生任务均通过，才发布 **TEST 预发布版**：

```sh
gh workflow run caddy-component.yml --repo abworks-dev/dsh-mobile --ref caddy-component-2.11.6-tencentcloud-0.4.3-review.1 -f publish_review_prerelease=true
```

组件标签不以 `v` 开头，避免触发插件正式发布。独立写权限任务拒绝已有 Release，创建非 latest 的预发布草稿，不覆盖资产；下载所有草稿资产与准备字节逐一对比后才公开。产物包括区分平台的原始二进制、manifest、编译/模块/版本/许可证证据、双构建证明、源码提交/运行标识和 SHA256SUMS。[发布后验证器](<../scripts/verify-caddy-release.mjs>) 用 GitHub 元数据及安装器实际 HTTPS/受限重定向下载链路复核 **所有公开资产**，成功后才输出仅供审核的目录。公开后验证失败会保留已公开的标记预发布版、使任务失败且不输出校验目录，不擅自删除或回滚 Release。CI 产物保留 14 天，Release 资产另行保存。

公开定制下载端点曾在请求 v2.11.6 时返回 v2.11.7，动态最新版不能成为信任来源。版本化 GitHub URL 仍可被仓库所有者替换；信任边界是审核过的精确大小/哈希，而非 URL 名称或远端自报校验和。fork 的目录只是审核候选，不会自动写入[生产组件表](<../src/caddy-component.ts>)；正式安装仍等待维护者发布并审核官方分发。

### 官方分发需要独立的两阶段授权

本次仅准备发布通道，不执行发布。第一阶段要求维护者审核工作流 PR，并合入经过审核、受保护的 `main`。维护者必须预先配置 `caddy-component-release`：必需审核者规则、非空审核者列表和 **禁止自我审核**；管理员不得绕过环境批准。GitHub Actions 在唯一发布任务开始前提供真实人工批准；脚本另外读取实际环境策略，在首次修改 Release 前拒绝缺失、格式错误或未保护的环境。环境名称、main 祖先比较、合成策略测试都不能证明人工审核或批准。

官方发布仅允许 **公开** 的 `saya-ch/dsh-mobile` 仓库和已有的固定非 `v` 稳定标签 `caddy-component-2.11.6-tencentcloud-0.4.3`。两个发布输入均默认 false；同时启用会在原生构建前明确失败。错误事件、分支、仓库或通道/标签身份不能发布。发布任务先检查 `/commits/TAG` 的 SHA 与 Actions `GITHUB_SHA` 完全一致，且 `/compare/main...SHA` 状态必须为 `identical` 或 `behind`（只证明属于 main/祖先关系，**不证明代码经过审核**）。准备资产和源码元数据使用同一个 SHA、同一次运行中的两平台原生构建，不复用旧运行的产物。

发布任务仍仅有 `contents: write`，API 使用 `GITHUB_TOKEN`，公开资产不带令牌或 API 请求头。[GitHub Get an environment 文档](<https://docs.github.com/en/rest/deployments/environments?apiVersion=2022-11-28#get-an-environment>) 通常要求 Actions read，但明确允许公开资源在没有该权限时读取。此处只采用公开资源例外作为前提，不声称已验证真实令牌能力：带认证请求的 401/403/404/5xx 或网络失败均在创建 Release 前关闭路径；不重试未认证请求、不提升权限、不增加发布密钥。维护者需确认仓库公开、端点可读以及环境保护配置；认证读取失败应报告缺少读取能力，不放宽策略。fork 审查通道使用 `caddy-component-review`，不要求官方环境策略。

满足以上前提并得到明确发布授权后（不是本次准备任务），维护者才可在已有稳定标签上手动启用 `publish_official_release=true`，保持 review 输入 false。仍只使用现有 Windows/Linux x64 原生矩阵：各独立构建两次，验证原生安装/TLS/API/WSS/不导入信任，并运行完整测试与构建。通用发布器使用 `--draft --prerelease=false --latest=false`，拒绝已占用 Release，不更新、覆盖、删除或破坏性重试；上传并下载 **全部 16 个资产**、逐字节比较，再以 `--draft=false --prerelease=false --latest=false` 公开。fork 仍保留预发布且非 latest 的标志。官方验证允许 `/releases/latest` 的 404（确实没有 latest），但拒绝该组件成为 latest，以及其他错误或格式错误的成功响应。组件不替换 latest 插件，不自动发布 npm/APK。公开后验证失败保留公开 Release、任务失败、不产生候选，不进行破坏性回滚。

prepare/verify CLI 原有严格签名默认 review；只有可选尾参数 `--channel official`（或 `--channel review`）选择共享的精确身份校验。官方 `COMPONENT-RELEASE.json` 使用 `managed-caddy-component-official`；全部资产的公开元数据/大小/哈希及实际 HTTPS/受限重定向检查通过后，才生成 `official-candidate-not-production`。两通道索引与候选均保持 `productionCatalogEnabled: false`，输出有界、独占创建且不覆盖。

第二阶段在 **以后** 进行：独立验证实际发布的官方字节，再提交单独审核的目录 PR，将精确来源/大小/哈希硬编码到 `CADDY_COMPONENT_RELEASES`。本次准备中它仍严格为 `Object.freeze({})`。远端候选 JSON 不是运行时信任或配置。仅支持 Windows/Linux x64、腾讯云 DNS；不要把私有预览替换为目录为空的官方插件包后期待托管重启正常工作。人工真实网络证据与最终候选 CI 分开记录；隔离测试或该人工证据都不证明证书续期通过。

隔离测试仅用回环随机端口、私有内部 CA 和 `skip_install_trust`，不修改系统信任、生产 DNS 或现有代理。**不等于真实公网 DNS-01/ACME 签发或公网路由验收**；后者需要另行授权专用测试域名、最小权限 DNS 凭据和可达入口。
