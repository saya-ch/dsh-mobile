# 接入你既有的 frps（插件不自动改动服务器）

[English guide](ATTACH_EXISTING_FRPS.en.md)

> **需要 0.4.6 插件**；自签档还必须使用 0.4.6 Android App。Android App 0.3.3–0.4.5 可使用公开证书档，但不支持自签档。

本文面向**已经在一台公网 VPS 上跑着 frps**的用户。插件不会安装、修改或重启你的 frps，也不会自动改动 Caddyfile；若选择公开 CA 档，你需要自行新增 Caddy 片段和 `import`。本机侧不改动 DSH 自身配置。接入前须核对既有 frps 的监听；若它不满足所选入口档的要求，插件不会代你修改。

> 只读预览：面板「自建 FRP → 步骤 2」里的**复制接入清单**按钮不连接 VPS，也不写入配置文件；预览中的 Token 默认遮盖。要复制含 Token 的本机配置，须在面板重新输入 Token 并显式点击对应按钮；已保存的 Token 不会回传页面。

## 三个必读项

| 项 | 含义 | 你要做什么 |
|---|---|---|
| **`vhostHTTPPort`** | 你 frps 上「Caddy ↔ frps」之间的**回环明文 HTTP** 端口（上游默认 7080） | 在面板填写**你真实的那个值**。插件不会替你假定 7080：端口填错会让「明文 vhost 公网可达」的安全闸门失效 |
| **`proxyBindAddr`** | frps 的全局代理监听地址，同时影响 HTTP vhost 和 TCP 代理 | A 档的明文 HTTP vhost 必须只监听回环；B 档的 TCP `remotePort` 要能从公网访问。若既有 frps 设置为 `127.0.0.1`，仅放行防火墙也不会使 B 档公网可达；不要为 B 档盲目改为 `0.0.0.0`，以免暴露同一 frps 上已有的明文 vhost。需先核对整个 frps 的服务与防火墙，必要时改用另一实例或 A 档。 |
| **入口证书档 `entryTls`** | 谁终止公网 TLS | 见下两档，按需二选一 |

[FRP 官方服务端配置](https://gofrp.org/zh-cn/docs/reference/server-configures/)将 `proxyBindAddr` 定义为代理监听地址，将 `vhostHTTPPort` 定义为 HTTP 类型代理监听端口；两者都由你既有 frps 的实际配置决定。

## 两档入口证书

### A. 公开 CA 证书档（`public-ip-cert`，缺省）

- 公网入口：`443`，由 **VPS 上的 Caddy** 终止 TLS，它再反代到 `127.0.0.1:<vhostHTTPPort>`。
- 证书：域名入口由 Caddy 自动申请与续期；公网 IPv4 入口使用 Certbot 5.8.0 的 `--standalone --preferred-profile shortlived --ip-address` 签发 [Let's Encrypt 的约 6 天 IP 证书](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)。此 attach 流程**不会**安装续期定时器或部署 hook；你须在到期前续签、将新证书安装到 Caddy 并重载它。
- 受信任的公开证书可供手机浏览器与支持自定义远程 Origin 的 Android App（0.3.3 及更新）使用；仍须完成设备配对。
- VPS 侧要做：手动新增 Caddy 片段（`/etc/caddy/dsh-mobile-dsh.caddy`）和 Caddyfile 顶部一行 `import`；公网 IPv4 还需安排证书初次签发与持续续期。当前清单的 Certbot `--standalone` 命令会短暂停止 Caddy 以占用 80 端口，可能中断同机原有网站；请安排维护窗口。若不能接受中断，优先选域名公开证书档，或使用 0.4.6 App 的自签 TCP 档。

### B. 自签穿透档（`self-signed`）——**不需要公开证书**

- 公网入口：`publicPort`（缺省 **33080**，可改；不得为 3080/3443/3444）。frps 只做**纯 TCP 透传，不解密**。
- TLS 由**运行 DSH 的电脑上的网关终止**，当前仅使用公网 IPv4 入口。插件自签 CA 有效期 5 年，公网 IPv4 叶证书有效期 397 天；叶证书可在保留同一 CA 时续签，CA 到期会阻止连接，不能静默换成新 CA。应留意面板证书状态，CA 到期或更换后须重新配对。
- 此档需要 **0.4.6 Android App**：二维码、链接和 App 配对密钥以 `dsh2` 标记必须固定 CA；App 会从网关的 `GET /mobile-access/ca.cer` 读取 CA，并核对密钥中的指纹，若接口返回 404 也不会降级为系统信任。旧版 App 不支持此档，仍可使用 A 档。
- 手机**浏览器**访问会提示证书不受信任（这是自签的必然结果），请用 App 扫码配对使用。
- VPS 不需要为此入口配置 Caddy、certbot 或新的 HTTP vhost；但既有 frps 的代理监听地址必须允许该 TCP 入口公网访问，且不得因此暴露其他明文服务。

> 拓扑：`手机 ──HTTPS(:33080)──▶ frps TCP 代理（透传）──加密隧道──▶ 本机 frpc ──▶ 127.0.0.1:<网关HTTPS端口> ──▶ dsh web 127.0.0.1:3080`

## 公开 CA 证书档：操作与验收

1. 在面板选「接入我已有的 frps」和「公开 CA 证书」，填入真实公网域名或公网 IPv4、frps 控制端口、共享 Token，以及既有 frps 的实际 `vhostHTTPPort`。公网入口使用 HTTPS 443，不填写自签 TCP 入口端口。
2. 复制接入清单，先核对 frps 的明文 vhost 只在回环监听，再按清单手动添加 Caddy 片段与 `import`。域名证书由 Caddy 管理；公网 IPv4 请在维护窗口运行清单固定的 Certbot 5.8.0 `--standalone` 命令，它会短暂停止 Caddy。此 attach 流程只查询现有 `certbot.timer`，不代你配置续期、证书复制或重载 hook；须自行保持这些步骤运行。插件不会代你修改 VPS。
3. 在电脑端按需安装官方 `frpc`，保存并验证连接。在独立外部网络打开公开地址的 `/mobile-access/discovery`，确认可信证书、HTTP 200 与当前电脑的安装标识；然后从 App 的「远程访问」或手机浏览器完成配对。仅在电脑端的自检通过不代表外网可达。

## 操作步骤（自签穿透档，共 7 步）

### 本机（3 步）

1. 面板「自建 FRP → 步骤 1」填写：VPS 地址、frps 端口（你 frps 的 `bindPort`）、Token、公网入口
   `https://<公网IP>`；**置备方式 = 接入我已有的 frps**；**入口证书档 = 自签穿透**；公网入口端口 = `33080`（或你选的端口）。
2. 「复制接入清单」，核对其中脱敏的 `frpc.toml` 和 VPS 待办；复制本身不会保存配置。完成下一步并点击「保存并验证连接」后，插件才将实际配置写入私有目录 `…/remote/frp/config/frpc.toml`（Unix 为 `0600`，Windows 使用受限 ACL）。若重新输入 Token 并明确复制含 Token 的本机配置，请及时清除剪贴板。
3. 装官方 frpc（面板「步骤 3」）→ 点「保存并验证连接」。启动前插件会自检 `frpc verify -c <配置>`。

### VPS（2 步）

4. 在既有 frps 控制端口已经可从电脑连接的前提下，为**新增 TCP 入口**放行公网端口：
   ```sh
   ufw allow 33080/tcp
   ufw status | grep 33080
   ```
   若用 firewalld 或云厂商安全组，放行同样的 **TCP 33080**。
5. 确认既有 frps 已就绪，并核对 TCP 入口实际监听地址（插件不会改它的配置；若不是 systemd 服务，使用你自己的管理方式检查进程）：
   ```sh
   systemctl is-active frps || true
   ss -lnt | grep -E ':(<你的 bindPort>|33080)\b' || true
   ```

### 手机（2 步）

6. 在电脑面板「远程访问」生成**远程配对二维码 / 配对链接**（含 CA 指纹、一次性 Token 和必须固定 CA 的 `dsh2` 标记）。
7. 用 Android App 扫码（或粘贴链接）完成配对，即可远程进入 DSH。

### 端到端验证（在 VPS 或任意外部机器执行）

```sh
# 先把 YOUR_PUBLIC_IPV4 与 33080 换成实际公网入口，再从外部网络执行。
curl -k -sS -o /dev/null -w '%{http_code}\n' https://YOUR_PUBLIC_IPV4:33080/mobile-access/discovery
# 期望输出 200；-k 仅跳过 curl 的证书校验，用于检查连通性，不证明入口身份。
```

面板「步骤 2 → 运行自检」还会显示：入口证书剩余天数、CA 指纹、frps 控制端口可达性、公网入口可达性。
**本机探测 ≠ 公网验证**：请在外部再跑一次上面的 curl（手机流量即可），然后让 0.4.6 App 校验配对密钥里的 CA 指纹并实际建立会话。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| `frp_attach_mode_requires_vhost_port` | 选了公开 CA 证书档却没填你 frps 的真实 `vhostHTTPPort`。填上真实值即可（插件不会替你假定 7080） |
| `frp_vhost_publicly_reachable` | 公开 CA 档的明文 vhost 端口从公网可达。限制其监听或改用独立 frps 实例；若同一实例还要提供自签档公网 TCP 入口，不要盲目把全局 `proxyBindAddr` 改为回环或公网地址。 |
| `frp_attach_cert_unknown` | 自签入口证书缺失或不可读；检查面板证书状态与私有目录的 `remote/ingress/`，不要绕过指纹验证。 |
| `frp_ingress_ca_expired` | 自签 CA 已过期，插件不会静默替换受信任 CA；重新生成 CA 后，手机须核对新指纹并重新配对。 |
| 手机浏览器提示证书不受信任 | 自签档的正常现象；请在 App 内配对使用 |
| 自检显示「公网入口不可达」 | 端口未放行、frpc 未启动，或 frps 未把该 `remotePort` 转发出来 |
| App 报「连接到另一台 DSH」 | 公网入口指向了别的 DSH：检查 `remotePort` 与 frpc 是否在本机运行 |

## 与其他通道的关系

- **`origin` 自有反代通道**（默认 3444）是另一条独立路径，TLS 由**你自己的外部反代**终止，与本档互不影响。
- **deploy 模式**（由插件安装 frps + Caddy）保持不变，仍需要 SSH；attach 模式**零 SSH**。

本机的「彻底移除 FRP」只清理插件管理的 frpc、私有配置和自签入口材料，不会删除或重启 VPS 上你已有的 frps、Caddy、证书或防火墙规则。托管部署及其独立的服务器清理步骤见[自建 FRP 使用指南](SELF_HOSTED_FRP.md)。
