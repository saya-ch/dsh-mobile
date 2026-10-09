# Cloudflare 命名隧道（固定公网域名）

[English guide](CLOUDFLARE_TUNNEL.en.md)

内置的 cloudflared 通道有两种模式，在面板 **移动访问 → 远程 → cloudflared → 隧道类型** 中切换：

| | 快速隧道（默认） | 命名隧道 |
| --- | --- | --- |
| 账号 | 不需要 | 需要 Cloudflare 账号 |
| 地址 | 每次启动随机分配 `*.trycloudflare.com` | 你自己域名下的固定主机名 |
| 重启后 | 地址变化，需要重新扫码 | 地址不变，已配对设备继续可用 |
| 可用性 | 官方定位为测试用途：有限流、无可用性保证 | 由你的 Cloudflare 账号承载 |
| 配置项 | 无 | 连接器令牌、公网域名、本机转发端口 |

Cloudflare 提供公网域名与 TLS，插件在本机运行 `cloudflared`，把请求交给有设备配对认证的私有网关。在 Android App 中请选择 **远程访问**；手机浏览器也可打开公开 HTTPS 配对链接。隧道不能替代 DSH Mobile 配对。

## 快速隧道的功能限制

[Cloudflare 官方限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/#limitations)包括无可用性保证、最多 200 个并发进行中的请求，以及不支持 SSE。插件通过 SSE 传递扩展变更、任务完成和在线设备撤销事件：快速隧道中扩展更新会退回定期检测，完成提醒与在线撤销提示可能无法及时送达，没有离线完成事件补发。服务端撤销认证仍然有效；长期使用请选择命名隧道或其他通道。

## 前置条件

1. 一个已接入 Cloudflare 的域名（该域名的 NS 必须指向 Cloudflare 分配的名称服务器，在域名注册商处修改；改完通常几分钟到 24 小时生效）。
2. 可以管理该域名和 Tunnel 的 Cloudflare 账号。
3. 面板中 cloudflared 组件已安装（命名隧道和快速隧道使用同一个官方客户端）。

组件支持 Windows x64、Linux x64/arm64 与 macOS x64/arm64。所有平台都在安装前校验官方发布文件；macOS 另校验解压后的可执行文件，组件仅保存在 DSH Mobile 私有目录。

## 在 Cloudflare 控制台创建隧道

1. 在 Cloudflare 控制台打开 **Networking → Tunnels**，创建隧道并命名，例如 `dsh-mobile`。
2. 在连接器安装说明中取得 Tunnel token。**不要执行系统服务安装命令**：本插件会管理已校验的 cloudflared 进程。
3. 打开 **Routes → Add route → Published application**，添加公网主机名：
   - Subdomain：`dsh`，Domain：选你的域名（得到 `dsh.example.com`）
   - Service：**HTTP** → `127.0.0.1:3444`
4. 保存路由，再把连接器令牌填写到下节的 DSH Mobile 面板。令牌是凭据，不要发到 issue、截图或日志中。

步骤按 [Cloudflare 当前官方指南](https://developers.cloudflare.com/tunnel/get-started/)核对；旧控制台可能仍将公开路由称为 Public Hostname。此处的 Service 使用 HTTP 回环后端，不需要关闭 TLS 验证。

> `127.0.0.1:3444` 就是面板里的「本机转发端口」。Cloudflare 把公网主机名固定转发到这个端口，所以它必须与面板中填写的端口一致，并且长期不变。

## 在 DSH Mobile 面板中填写

1. **移动访问 → 远程 → cloudflared**。
2. 隧道类型选 **命名隧道**。
3. 依次填写：
   - **公网域名**：`dsh.example.com`
   - **本机转发端口**：`3444`（与第 3 步的 Service 端口一致）
   - **连接器令牌**：粘贴上一步复制的令牌
4. 点击 **保存并连接**。

已保存后令牌输入框留空表示不更改；输入框里不会再回显已保存的令牌。「移除已保存的令牌」会**同时停止 cloudflared 通道**并把配置改回快速隧道。不会自动重连，之后需要手动重新打开开关。

## 用手机连上命名隧道

切到固定域名后，**已经配对过的手机必须重新配对**：App 不会把已存设备令牌发送给未经新配对验证的 Origin。这是客户端的精确地址发送策略，不代表服务端令牌自动按域名失效；远程通道共用设备注册表。请使用可信且由你控制的入口，怀疑凭据泄漏时在电脑端撤销设备。

1. 电脑面板 → **远程** → 点 **生成远程配对二维码**。这一步打开有时限的配对窗口；未打开时不能新增配对，已有配对不受影响。
2. 手机 App → **先进入「远程」入口**（连接中心的远程访问设置页）→ 再扫描二维码。

> **命名隧道必须在「远程」入口里扫码。** App 只把 `.ts.net`、cpolar、`.trycloudflare.com` 这类平台后缀当作「无需询问即为远程」；你自己的域名同样会被识别为可远程的候选地址，但「局域网」流程只接受非候选地址，所以在局域网界面扫码会被判为无效并提示**无效二维码 / Invalid QR code**，看起来就像「连不上」。先进入「远程」流程再扫即可。
>
> 不想扫码时，完整链接（`https://你的域名/mobile-access/pair#instance=…&token=…`）可以整条复制到手机上粘贴，App 的输入框接受完整链接。

旧地址在重新配对前可能显示「地址可能已变化」或暂不可达。重新配对同一台电脑后，App 会按设备标识更新原远程记录，保留自定义名称；无需删除它。

## 安全边界

- 令牌只写入 DSH Mobile 私有目录（默认 `$DSH_HOME/mobile-access/remote/cloudflared/tunnel.json`；Unix 权限 `0600`，Windows 使用受限 ACL），并且**只**通过子进程环境变量 `TUNNEL_TOKEN` 传给 `cloudflared`，不出现在命令行里。
- 令牌从不回传给浏览器或手机端；面板状态里只有「是否已配置」、域名和端口。
- 隧道背后是 DSH Mobile 自己的认证网关：公网主机名只暴露该网关，DSH 本体仍然需要配对设备凭据。
- 插件不会创建系统服务、开机启动项、注册表项或 PATH 项；关闭通道即结束进程。

## 错误码

| 面板提示 | 实际错误码 | 含义与处理 |
| --- | --- | --- |
| 本机转发端口不可用 | `cloudflared_tunnel_port_unavailable` | 配置的端口已被占用。命名隧道不能改用其他端口（Cloudflare 固定转发到该端口），请释放端口或换一个端口并同步修改 Cloudflare 的 Service。 |
| 公网域名无效 | `cloudflared_tunnel_hostname_invalid` | 必须是本账号下域名的真实主机名；不接受 IP、通配符、`.trycloudflare.com` 与 `.cfargotunnel.com`。 |
| 转发端口无效 | `cloudflared_tunnel_port_invalid` | 端口需在 1024–65535 之间。 |
| 转发端口被保留 | `cloudflared_tunnel_port_reserved` | **3443** 是保留的默认 LAN HTTPS 端口，此模式不接受它；选择 3444、3445 或其他允许且未占用的端口。保留规则不表示 LAN 始终在监听。 |
| 令牌无效 | `cloudflared_tunnel_token_invalid` | 令牌需从控制台完整复制，不能有空格或换行。 |
| 设置未通过校验 | `cloudflared_tunnel_settings_invalid` | 请求里带了不该有的字段（例如快速隧道模式下携带端口）。 |
| 需要同时填写令牌、域名和端口 | `cloudflared_tunnel_config_missing` | 首次配置命名隧道时三项都必填。 |
| 已保存配置无法读取 | `cloudflared_tunnel_config_invalid` | 配置文件损坏或不符合格式；插件会退回快速隧道，重新保存即可。 |
| 已保存配置不是普通文件 | `cloudflared_tunnel_target_invalid` | `tunnel.json` 变成了符号链接或非常规文件。移除它并重新保存设置。 |
| 无法预留本机端口 | `cloudflared_port_reservation_failed` | 本机端口预留本身失败（不是端口被占）。重试；若持续出现请检查系统资源。 |
| 组件下载校验失败 | `cloudflared_download_hash_mismatch` / `cloudflared_download_size_mismatch` | 下载到的二进制与固定版本的大小或 SHA-256 不符。重新安装；若反复失败说明中间链路在改包。 |
| 已安装组件校验失败 | `cloudflared_executable_hash_mismatch` | 本机那份 cloudflared 与校验过的版本不一致。彻底移除后重新安装。 |
| 当前构建不支持该组件 | `cloudflared_component_unsupported` | 当前平台不在支持范围内（支持 Windows x64、Linux x64/arm64 与 macOS x64/arm64）。 |
| 等待隧道可用超时 | `cloudflared_start_timeout` | connector 在超时预算内没有打印 `Registered tunnel connection`。命名隧道下进程活着会继续等（最多约 5 分钟）；常见原因是网络到 Cloudflare 边缘不通。 |
| 组件未安装 | `cloudflared_component_missing` | 还没安装官方组件。按上面的准备步骤安装。 |
| 组件校验失败 | `cloudflared_component_invalid` | 本机组件与校验过的版本不符。彻底移除后重新安装。 |
| 无法分配端口 | `cloudflared_port_unavailable` | 快速隧道模式下无法分配本机网关端口。重试。 |
| 客户端启动失败 | `cloudflared_launch_failed` | cloudflared 进程没能启动。检查本地日志。 |
| 连接已停止 / 意外退出 | `cloudflared_stopped` / `cloudflared_exited` | 通道已断开，点重新连接。 |
| 返回内容无法识别 | `cloudflared_invalid_output` / `cloudflared_invalid_origin` | cloudflared 输出或公网地址未通过校验。重新连接并复制诊断报告。 |
| 网关启动失败 | `gateway_start_failed` | 隧道背后的认证网关没能启动（不是端口冲突）。检查本地日志。 |
| 下载跳转异常 | `cloudflared_download_redirect_missing` / `_invalid` / `_rejected` | 官方下载页没有跳到固定发布资源，或目标未通过校验。稍后重试或更新插件；全局安装的 cloudflared 不会替代插件的私有固定组件。 |

## 排错

- **连接一直停在「正在连接」**：命名隧道只有在 connector 向 Cloudflare 注册后才显示就绪。检查 DSH 日志中的 cloudflared 输出，以及本机到 Cloudflare 边缘的 DNS、UDP/QUIC 和 TCP 连通性。
- **公网访问返回 1033**：Cloudflare 认为该主机名没有健康的 connector。确认隧道在控制台显示 Healthy，且路由的 Service 端口与面板一致。
- **`cloudflared` 报 `Unauthorized` 或隧道 ID 不存在**：令牌与控制台里的隧道不匹配（例如隧道被删除后重建）。重新复制令牌。
- **手机卡在「正在加载插件」或远程页面明显慢，而本机开着 TUN/透明代理**：先检查 `cloudflared` 到 `*.argotunnel.com` 的连接是否被兜底规则送进代理节点。曾有这种路由导致启动资源传输很慢；它不等于配对失败。以下是 Windows 上 Clash 客户端的规则示例；Linux 的进程名与具体规则语法应按所用客户端调整，并让直连规则排在兜底规则前：

  ```yaml
  prepend-rules:
    - PROCESS-NAME,cloudflared.exe,DIRECT
    - DOMAIN-SUFFIX,argotunnel.com,DIRECT
    - DOMAIN-SUFFIX,trycloudflare.com,DIRECT
  ```

  改完后让 cloudflared **重连**，使已建立的连接使用新路由（面板里点重连，或开关一次提供方）。对比同一资源经局域网与远程入口的加载速度；若远程入口在电脑上也慢，优先检查电脑到 Cloudflare 的路径，若只有手机慢，再检查手机网络。
- **域名解析还是旧地址**：改完 NS 后 Cloudflare 需要把 zone 从 Pending 变为 Active；A/CNAME 在 zone 激活前不会对外生效。
