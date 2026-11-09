# 使用指南 / Documentation

第一次使用请先看[快速开始](../README.md#快速开始)和[局域网／远程连接教程](../README.md#连接教程)。这里收录需要进一步配置或排障的专题；不必为了完成首次配对读完所有页面。

## 已发布功能 / Released features

| 你想做什么 | 中文 | English |
| --- | --- | --- |
| 使用 Android App、了解返回键、权限与升级 | [App 手册](../apps/mobile/README.zh-CN.md) | [Android app](../apps/mobile/README.md) |
| 用 iPhone/iPad 的 Safari 配对、添加到主屏幕（PWA） | [iPhone/iPad 入门](<../README.md#iphone-与-ipad主屏幕-web-apppwa>) | [iPhone/iPad quick start](<../README.en.md#iphone-and-ipad-home-screen-web-app-pwa>) |
| 在 iPhone/iPad 主屏幕 App 开启六类网页推送通知（0.8.0 起） | [网页推送](WEB_PUSH.md) | [Web Push](WEB_PUSH.en.md) |
| 使用固定 Cloudflare 域名，而非临时随机地址 | [命名隧道](CLOUDFLARE_TUNNEL.md) | [Named tunnel](CLOUDFLARE_TUNNEL.en.md) |
| 请求 cpolar 账号已预留的固定子域名（0.6.7 起） | [固定子域名](CPOLAR_SUBDOMAIN.md) | [Reserved subdomain](CPOLAR_SUBDOMAIN.en.md) |
| 在已有 VPS 上新部署 FRP 与 HTTPS 入口 | [自建 FRP](SELF_HOSTED_FRP.md) | [Self-hosted FRP](SELF_HOSTED_FRP.en.md) |
| 复用已经运行的 frps，不自动修改服务器 | [接入既有 frps](ATTACH_EXISTING_FRPS.md) | [Existing frps](ATTACH_EXISTING_FRPS.en.md) |
| 复用 Lucky、Nginx 或 Caddy 的公开 HTTPS 入口 | [自有反向代理](SELF_HOSTED_ORIGIN.md) | [Own reverse proxy](SELF_HOSTED_ORIGIN.en.md) |
| 由插件安装 Caddy 并管理 HTTPS 证书（0.6.9 起） | [托管 Caddy](CADDY_MANAGED.md) | [Managed Caddy](CADDY_MANAGED.en.md) |
| iroh 加密直连实验通道 | [iroh 实验通道](IROH.md) | [iroh experimental channel](IROH.en.md) |
| 页面加载慢、实时连接反复重连或长操作超时 | [慢链路与重连](SLOW_CONNECTIONS.md) | [Slow links and reconnection](SLOW_CONNECTIONS.en.md) |
| 了解输入栏换行、附加控件与触摸目标 | [移动输入栏](MOBILE_COMPOSER_TOOLBAR.md) | [Mobile composer](MOBILE_COMPOSER_TOOLBAR.en.md) |
| 保留电脑皮肤，排查移动页面的背景与可读性 | [皮肤与移动布局](SKIN_COMPATIBILITY.md) | [Skins and mobile layout](SKIN_COMPATIBILITY.en.md) |

在 Android App 中连接公开隧道或自建入口时请选择 **远程访问**。公开受信任证书也可用手机浏览器配对；既有 frps 的自签入口需要 **0.4.6 或更高版本 App** 固定远程 CA。**iroh 则使用完整版 App 0.7.0 的独立配对流程**，不支持兼容版 APK 或手机浏览器。各通道仍要求 DSH Mobile 配对，不能直接暴露普通 DSH 或私有 HTTP 后端。

## 页面与网络设置 / Page and network settings

按需选择移动页面模块和受信任的局域网来源；这些设置不会创建 VPN，也不会自动刷新当前会话。

| 功能 | 中文 | English | 使用状态 |
| --- | --- | --- | --- |
| 区分电脑、DNS、出口与手机的诊断证据 | [连接诊断](CONNECTION_DIAGNOSTICS.md) | [Connection diagnostics](CONNECTION_DIAGNOSTICS.en.md) | 分层报告自 0.8.2 起提供；不代表手机路径已验收 |
| 核对移动字号、字体与 App 页面缩放 | [显示大小](MOBILE_COMPOSER_TOOLBAR.md#显示大小与可用空间) | [Display size](MOBILE_COMPOSER_TOOLBAR.en.md#display-size-and-available-space) | 字体按主题能力显示；App 缩放与网页字号独立 |
| 为移动页面选择加载模块 | [模块设置](CLIENT_MODULES.md) | [Module settings](CLIENT_MODULES.en.md) | 电脑默认与设备覆盖分别保存，不自动刷新会话 |
| 允许受控路由网络访问 LAN Gateway | [额外可信网段](TRUSTED_NETWORKS.md) | [Trusted networks](TRUSTED_NETWORKS.en.md) | 不建立 VPN，不自动扩大防火墙规则 |

## 插件移动适配 / Plugin mobile adaptation

给插件作者的响应式布局、触控与验收建议：优先复用现有组件，兼顾小屏与桌面，并区分结构检查、真实浏览器和真机证据。

| 主题 | 中文 | English |
| --- | --- | --- |
| 让第三方插件面板在手机上可用 | [移动端插件适配指南](MOBILE_PLUGIN_ADAPTATION.md) | [Mobile plugin adaptation](MOBILE_PLUGIN_ADAPTATION.en.md) |

## 开发与安全 / Development and security

0.6.3 的 [扩展 Worker 指南](EXTENSION_WORKERS.md)／[Worker guide](EXTENSION_WORKERS.en.md) 介绍按扩展启用、预算与显式恢复；此功能不迁移普通 Cordis 插件，也不是权限沙箱。
[插件移动端基线](MOBILE_PLUGIN_BASELINE.md)／[Plugin mobile baseline](MOBILE_PLUGIN_BASELINE.en.md) 把「小屏可用、桌面不回退」拆成三级要求与验收证据；做法与示例见[适配指南](MOBILE_PLUGIN_ADAPTATION.md)／[guide](MOBILE_PLUGIN_ADAPTATION.en.md)。

- [贡献指南](https://github.com/saya-ch/dsh-mobile/blob/main/CONTRIBUTING.md)：本地检查、浏览器与 Android 验证、发布要求。
- [安全说明](../SECURITY.md)：配对授权、TLS、组件清理与私密漏洞反馈。
- [贡献记录](../CONTRIBUTORS.md)与[更新记录](../CHANGELOG.md)：分别查看社区参与和版本变化。

## 历史验证 / Historical records

以下记录保留原来的版本和测试范围，不能当作当前版本或你的网络环境已验证的证明。

| 记录 | 范围 |
| --- | --- |
| [DSH 0.1.5 局域网验证](DSH_0.1.5_LAN.md) | 0.3.15 的历史实测；当前组合见[兼容性](../README.md#兼容性) |
| [FRP 维护交接](https://github.com/saya-ch/dsh-mobile/blob/main/docs/HANDOFF_SELF_HOSTED_FRP.md) | 0.4.6 开发时的代码地图与历史证据，仅在仓库阅读，不随 npm 包发布 |
