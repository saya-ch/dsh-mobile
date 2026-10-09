# 使用指南 / Documentation

第一次使用请先看[快速开始](../README.md#快速开始)和[局域网／远程连接教程](../README.md#连接教程)。这里收录需要进一步配置或排障的专题；不必为了完成首次配对读完所有页面。

## 已发布功能 / Released features

| 你想做什么 | 中文 | English |
| --- | --- | --- |
| 使用 Android App、了解返回键、权限与升级 | [App 手册](../apps/mobile/README.zh-CN.md) | [Android app](../apps/mobile/README.md) |
| 使用固定 Cloudflare 域名，而非临时随机地址 | [命名隧道](CLOUDFLARE_TUNNEL.md) | [Named tunnel](CLOUDFLARE_TUNNEL.en.md) |
| 在已有 VPS 上新部署 FRP 与 HTTPS 入口 | [自建 FRP](SELF_HOSTED_FRP.md) | [Self-hosted FRP](SELF_HOSTED_FRP.en.md) |
| 复用已经运行的 frps，不自动修改服务器 | [接入既有 frps](ATTACH_EXISTING_FRPS.md) | [Existing frps](ATTACH_EXISTING_FRPS.en.md) |
| 复用 Lucky、Nginx 或 Caddy 的公开 HTTPS 入口 | [自有反向代理](SELF_HOSTED_ORIGIN.md) | [Own reverse proxy](SELF_HOSTED_ORIGIN.en.md) |
| 页面加载慢、实时连接反复重连或长操作超时 | [慢链路与重连](SLOW_CONNECTIONS.md) | [Slow links and reconnection](SLOW_CONNECTIONS.en.md) |

在 Android App 中连接公开隧道或自建入口时请选择 **远程访问**。公开受信任证书也可用手机浏览器配对；既有 frps 的自签入口需要 **0.4.6 或更高版本 App** 固定远程 CA。各通道仍要求 DSH Mobile 配对，不能直接暴露普通 DSH 或私有 HTTP 后端。

## 0.6.0 新增功能 / New features

以下指南介绍 0.6.0 的模块管理与局域网高级设置，以及尚未开放安装的托管 Caddy 模式。

| 功能 | 中文 | English | 使用状态 |
| --- | --- | --- | --- |
| 为移动页面选择加载模块 | [模块设置](CLIENT_MODULES.md) | [Module settings](CLIENT_MODULES.en.md) | 电脑默认与设备覆盖分别保存，不自动刷新会话 |
| 允许受控路由网络访问 LAN Gateway | [额外可信网段](TRUSTED_NETWORKS.md) | [Trusted networks](TRUSTED_NETWORKS.en.md) | 不建立 VPN，不自动扩大防火墙规则 |
| 由插件管理 Caddy HTTPS 上游 | [托管 Caddy](CADDY_MANAGED.md) | [Managed Caddy](CADDY_MANAGED.en.md) | 尚无可信固定二进制分发，安装与连接仍禁用 |

## 开发与安全 / Development and security

0.6.3 未发布候选的 [扩展 Worker 指南](EXTENSION_WORKERS.md)／[Worker guide](EXTENSION_WORKERS.en.md) 介绍按扩展启用、预算与显式恢复；此功能不迁移普通 Cordis 插件，也不是权限沙箱。

- [贡献指南](../CONTRIBUTING.md)：本地检查、浏览器与 Android 验证、发布要求。
- [安全说明](../SECURITY.md)：配对授权、TLS、组件清理与私密漏洞反馈。
- [贡献记录](../CONTRIBUTORS.md)与[更新记录](../CHANGELOG.md)：分别查看社区参与和版本变化。

## 历史验证 / Historical records

以下记录保留原来的版本和测试范围，不能当作当前版本或你的网络环境已验证的证明。

| 记录 | 范围 |
| --- | --- |
| [DSH 0.1.5 局域网验证](DSH_0.1.5_LAN.md) | 0.3.15 的历史实测；当前组合见[兼容性](../README.md#兼容性) |
| [FRP 维护交接](HANDOFF_SELF_HOSTED_FRP.md) | 0.4.6 开发时的代码地图与历史证据，仅在仓库阅读，不随 npm 包发布 |
