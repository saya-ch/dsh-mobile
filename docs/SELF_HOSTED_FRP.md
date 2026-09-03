# 自建 FRP 使用指南

自建 FRP 适合已有 VPS、希望避开公共隧道带宽限制的用户。手机经 VPS 上的 Caddy 进入加密 FRP 隧道，再到达电脑上的 DSH；FRP 只负责传输，仍需完成 DSH 配对才能进入。

```text
手机 App
  -> HTTPS（域名或公网 IPv4）
  -> VPS 上的 Caddy
  -> 127.0.0.1:7080（frps HTTP vhost，仅回环）
  -> 加密 FRP 隧道
  -> 运行 DSH 的电脑
```

## 两种入口

- **域名模式**：公开地址是自己的域名，Caddy 自动申请并续期证书。
- **公网 IPv4 模式**：公开地址直接是 VPS 公网 IPv4（例如你自己的 VPS 地址），插件用 Certbot 申请约 6 天有效的 Let's Encrypt IP 证书，并安装每日自动续期定时器。注意：文档示例地址（如 `203.0.113.10`）和内网、保留地址会被拒绝，必须填写真实可路由的公网 IP。

需要 Android App 0.3.3 或更高版本（远程自定义入口）；旧版 App 仍可用局域网、cpolar 和 Tailscale。

## 手动部署 vs 自动部署

- **手动部署**：在面板复制受限模板，把 frps 部分存为 `/etc/dsh-mobile/frps.toml`，把 Caddy 片段存为 `/etc/caddy/dsh-mobile-dsh.caddy`，并确保主 Caddyfile 里有且仅需这一行：`import /etc/caddy/dsh-mobile-dsh.caddy`（没有 Caddyfile 就新建一个只写这一行）。复制操作本身不改变任何东西。公网 IPv4 还需要按模板里的注释步骤用 Certbot 申请一次 IP 证书（Caddy 自己签发不了 IP 证书）；域名模式 Caddy 全自动。
- **自动部署**：填写 SSH 用户、端口和本机私钥路径（留空则用 ssh-agent 或 SSH 配置），点击一键部署。要求 Ubuntu/Debian + systemd，只接受密钥登录，不接受密码。

点部署按钮前，面板会列出自动部署将在 VPS 上做的全部改动：从官方 APT 源安装 Caddy、安装 Python venv 与 Certbot、创建 `dsh-mobile` 系统用户（已存在则复用，卸载时保留）、frps 配置与服务、Caddy 片段加主文件里的一行 import、证书续期定时器、在 UFW 放行 FRP 控制端口与 80/443。**主 Caddyfile 里你自己的内容永远不会被改写或合并**：没有 Caddyfile、空文件或官方默认文件时才写入这一行 import；其他情况部署直接停止并告诉你手动加这一行。

## 主机指纹核对（每次必做）

自动部署与一键清理在建立 SSH 连接前都会先读取服务器主机指纹并展示给你：

1. 点击部署/清理后，面板先显示服务器当前的 `KEYTYPE SHA256:…` 指纹列表。
2. 到 VPS 服务商控制台（或首次开通时收到的邮件/控制台信息）核对指纹一致。
3. 一致才点确认继续；不一致或无法核对时取消——插件不会静默接受未知主机密钥，部署期间密钥发生变化也会自动中止。

SSH 用户、端口和私钥路径只保存在当前浏览器的 `localStorage`（键名 `dsh-mobile.frp-vps-form.v1`）方便下次填写；共享 Token 从不进 `localStorage`；私钥文件本身不会上传到任何地方。

## 清理 VPS

本机“彻底移除 FRP”只删除电脑端的 frpc、Token 与配置，不动 VPS。清理 VPS 有两种方式，都只删除 DSH Mobile 明确拥有的文件、服务与带标记的防火墙规则：

1. **复制卸载脚本**：点“复制 VPS 卸载脚本”，审阅后以 root 身份在 VPS 上执行。脚本会停用并删除 frps 服务与证书续期定时器、删除配置/二进制/证书文件与 Caddy 片段、从主 Caddyfile 里删掉那一行 import（你自己的内容原样保留；文件删空时留一句占位注释）、删除带 DSH Mobile 标记的 UFW 规则。只有本次部署创建的 `dsh-mobile` 系统用户才会被删除，之前就存在的会被保留并明确告知。
2. **一键清理**：点“清理 VPS 上的 DSH Mobile”，同样先核对主机指纹，确认后通过 pinned SSH 执行同样的脚本。

公网 IPv4 模式还会删除对应的 Let's Encrypt IP 证书（域名模式的证书由 Caddy 自动管理，无需处理）。

## 运维排障

VPS 上：

```bash
sudo systemctl status dsh-mobile-frps.service caddy dsh-mobile-cert-renew.timer
sudo journalctl -u dsh-mobile-frps.service -u caddy -n 200 --no-pager
sudo ss -lntp
curl -vk https://PUBLIC_HOST/
```

本机优先看插件日志（`$DSH_HOME/mobile-access/logs/dsh-mobile.log`，JSONL，超 5 MB 轮转，自动脱敏 Token 与密钥）与面板诊断报告。Windows 杀毒软件可能隔离 frpc；如确有拦截，只为已校验的组件目录设置最小范围例外。

## 限制

- 中国大陆 VPS 上的未备案域名可能被云厂商拦截，此时改用公网 IPv4 模式。
- IPv4 证书是短期证书，必须保持续期定时器与 Caddy 正常运行。
- SSH 表单按浏览器配置文件保存，换浏览器或清理站点数据后需重填（私钥与密码从不保存）。
- VPS 的 SSH 目前不支持 IPv6 地址。
- frps 明文 vhost 必须只监听 `127.0.0.1`；插件会拒绝公网可达的明文端口，并在公开发现接口确认是当前电脑后才显示“已就绪”。

## 手动端到端验证清单（发布前）

- [x] Ubuntu IP 模式：已部署 VPS 上一键重部署 → 公网 IP 就绪 → App 级 discovery 返回当前电脑（2026-09-03，腾讯云实测）。
- [ ] Ubuntu 域名模式：全新 VPS 一键部署 → 公网域名就绪 → App 远程配对 → 收发消息。
- [x] 既有 Caddy 共存：在已有自有站点 + import 行的 Caddyfile 上部署，确认自有内容逐字节保留、import 恰好一行、validate 通过（2026-09-03，腾讯云实测；并发写有 flock 互斥）。
- [x] 指纹变更中止：未确认密钥集合部署/清理直接 `vps_host_key_mismatch` 中止且零网络碰触（单元测试锁定；真机指纹全量核对通过）。
- [x] 一键清理：部署后执行一键清理，服务、文件、定时器、标记防火墙规则、系统用户、LE 证书均已移除，自有 Caddy 本体保留（2026-09-03，腾讯云实测）。
- [x] 卸载脚本审阅：仅触碰 DSH Mobile 拥有的路径与规则（单元测试断言 + 真机复核）。
