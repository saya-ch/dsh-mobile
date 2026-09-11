# DeepSeek Harness 0.1.5 局域网验证

本页记录 DSH Mobile 0.3.15 对 DeepSeek Harness 0.1.5 的局域网兼容性证据，以及该次实测没有覆盖的远程路径。

## 验证环境

| 项目 | 版本 / 结果 |
| --- | --- |
| DSH Mobile | `0.3.15` 开发版本 |
| DeepSeek Harness | `0.1.5-rc.1` |
| 安装方式 | 本地 `link:` 插件，`setup` 绑定 `en0` |
| 访问路径 | 手机通过插件提供的局域网 HTTPS 地址连接 |
| 验证人 | [@idoall](https://github.com/idoall) |

局域网配对、会话列表、对话区、新建会话和右侧栏均可用。DeepSeek Harness `0.1.5-rc.2` 继续通过仓库的前端接口检查。

## 兼容范围

移动布局支持 0.1.5 的 keyed `main`、根级 `panelInfo`、导航生命周期和根级右栏，并保留较早宿主使用的 `conversation` 与 `details` 路径。

移动启动批处理对暂态上游连接失败执行有限重试，并让并发客户端共用一次独立于单个请求的组装任务。非法路径、非 200 响应和超限内容直接失败。

## 未覆盖路径

该次贡献者实测没有覆盖 Tailscale Funnel、cpolar 或自建 FRP。远程路径在正式发布前由维护者单独验证；局域网结果不作为远程服务可用性的证明。

本次适配不改变 Android 配对协议、证书模型或局域网 `setup` 命令。现有已配对 App 不需要因布局适配重新配对。
