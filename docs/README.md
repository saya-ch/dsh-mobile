# DSH Mobile 文档 / Documentation

本目录收录需要展开说明的指南。内置的远程通道（Tailscale Funnel、cpolar、cloudflared）为零配置或按需安装，说明见根目录 [README](../README.md#连接教程)，不单独成文；cloudflared 的命名隧道需要在 Cloudflare 控制台建隧道、配公开主机名并取令牌，步骤较多，单独成文。

## 面向用户 / User guides

| 中文 | English | 内容 |
| --- | --- | --- |
| [Cloudflare 命名隧道](CLOUDFLARE_TUNNEL.md) | [Cloudflare named tunnel](CLOUDFLARE_TUNNEL.en.md) | 用 Cloudflare 账号令牌把 cloudflared 从随机快速隧道换成固定公网域名 |
| [自建 FRP 使用指南](SELF_HOSTED_FRP.md) | [Self-hosted FRP guide](SELF_HOSTED_FRP.en.md) | 已有 VPS 时用 frps + Caddy 自建远程通道，避开公共隧道带宽限制 |
| [接入你既有的 frps](ATTACH_EXISTING_FRPS.md) | [Attach to an existing frps](ATTACH_EXISTING_FRPS.en.md) | 复用 VPS 上已运行的 frps，不自动修改服务器；可选公开 CA + Caddy 或自签 CA + TCP 透传，须核对监听与证书有效期。 |
| [自有 HTTPS 反向代理](SELF_HOSTED_ORIGIN.md) | [Own HTTPS reverse proxy](SELF_HOSTED_ORIGIN.en.md) | 复用已有的 Lucky / Nginx / Caddy 公网 HTTPS 入口，无需隧道组件 |

> 命名隧道与两个自建提供方都要求手机端走 App 的**远程访问**扫码流程；`SELF_HOSTED_ORIGIN.en.md` 是精简版，字段表与排错清单以中文版为准。

> 既有 frps 接入从 0.4.6 起提供；其中自签入口需要 0.4.6 Android App，旧版不能配对。

## 验证记录 / Verification records

| 文档 | 内容 |
| --- | --- |
| [DSH 0.1.5 局域网验证记录](DSH_0.1.5_LAN.md) | DSH Mobile 0.3.15 的历史局域网实测；当前版本组合请看[兼容性表](../README.md#兼容性) |

## 面向维护者 / Maintainer notes

维护者文档面向改代码的人，**不随 npm 包发布**，只在仓库中阅读：

- [自建 FRP 维护记录](HANDOFF_SELF_HOSTED_FRP.md) —— 0.4.6 开发时的代码地图、安全检查点与历史真机验证；当前使用步骤以本页上方的用户指南为准。
