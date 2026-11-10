# cpolar 固定子域名

[English guide](CPOLAR_SUBDOMAIN.en.md)

> 需要插件 **0.6.7 或更新版本**；0.6.6 及之前版本尚不读取这两个配置项。此功能不要求更新 Android App。

cpolar 默认分配临时公网地址。账号预留子域名后，可请求使用固定地址，减少重启隧道后更新书签或重新配对的次数。固定地址不意味着隧道永远在线，也不取消设备凭据过期或撤销后的重新配对要求。

公网入口仍由 DSH Mobile Gateway 处理，沿用 HTTPS、设备配对和授权检查；不是直接开放 DSH 的普通 WebServer。此通道由电脑主动连接 cpolar，不要求家中有公网入站端口或使用腾讯云 DNSPod；隧道可用性与速度仍取决于 cpolar 套餐和两端网络。

## 前置条件

1. 确认 cpolar 套餐支持保留二级子域名。[官方教程](https://www.cpolar.com/blog/cpolar-quick-start-tutorial-raspberry-pi-series)以基础套餐及以上为例；当前资格、可用地区及命名规则以你的账号控制台为准。
2. 在 [cpolar 控制台](https://dashboard.cpolar.com)的 **预留 → 保留二级子域名** 中保留名字，记录对应地区。
3. 在 DSH **移动访问 → cpolar** 中安装组件并保存 Authtoken。

地区必须与预留记录一致。官方命令示例使用 `cn_vip`，但不要将它照抄到其他地区的预留记录；其他地区的配置值请按 cpolar 当前说明确认。本指南不提供固定地区或域名后缀对照表。

## 配置

> 面板暂时没有子域名和地区输入框，需要编辑当前 DSH profile 的 `cordis.patch.yml`。先备份；不要改生成的 `cordis.yml` 或插件管理的 `cpolar.yml`。

找到当前 profile 目录，例如 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。修改已有的 `mobile-access` 配置覆盖条目；没有时，可在已加载 DSH Mobile bundle 的 profile 中添加下面的覆盖。**不要新增第二个 `mobile-access` 实例，也不要重新复制 bundle 的 `insert` 列表。**

DSH 加载器会整体替换条目的 `config`，不是逐键合并。因此不能只粘贴子域名和地区两个字段。下面展示本仓库标准 bundle 的 `config` 块全部字段，再追加两个设置；**仅适用于尚未自定义该条目的标准安装**：

```yaml
- id: mobile-access
  name: dsh-mobile
  config:
    setupFile: !!js dshHomePath('mobile-access/setup.json')
    stateFile: !!js dshHomePath('mobile-access/devices.json')
    controlFile: !!js dshHomePath('mobile-access/control.json')
    customCssFile: !!js dshHomePath('mobile-access/mobile.css')
    customScriptFile: !!js dshHomePath('mobile-access/mobile.js')
    initiallyEnabled: false
    listenHost: 127.0.0.1
    listenPort: 3443
    allowedCidrs: [127.0.0.0/8]
    tls:
      mode: disabled
    cpolarSubdomain: your-reserved-name
    cpolarRegion: cn_vip
```

已有自定义路径、监听、TLS 或其他设置时，**保留你当前的完整 `config`，只在其中添加这两个字段**；不要用示例覆盖它，否则可能改变数据位置或访问设置。无需在配置中填写 Authtoken，它仍通过面板保存。

| 字段 | 填写内容 |
| --- | --- |
| `cpolarSubdomain` | 控制台预留的名字本身，不是完整域名、HTTPS 地址或路径。省略、空字符串或纯空白表示不请求固定名字。 |
| `cpolarRegion` | 与预留记录匹配的地区标识；上例 `cn_vip` 只是官方示例。省略、空字符串或纯空白时不传地区参数，由 cpolar 决定线路；固定名字建议填写匹配地区。 |

配置值会去除首尾空白。插件的名字检查仅限制请求格式：以字母或数字开头，只含字母、数字、`.`、`_`、`-`，长度不超过 63 字符；这不是 DNS 标签规范，也不代表 cpolar 服务端会接受。预留是否有效仍取决于账号、地区和 cpolar 的实际规则。[官方子域名配置说明](https://www.cpolar.com/docs#configure-secondary-subdomain)与教程说明了 `-subdomain`、`-region` 参数。

确认没有正在运行的任务后，完整退出并重开 DSH，再在 **移动访问 → cpolar** 中连接。连接后使用面板实际显示的 HTTPS 地址，不要自行拼接域名后缀。

## 验证与配对

1. 核对面板显示的公网主机名与账号预留记录一致。
2. 从手机实际使用的外网打开 `https://<面板显示的主机名>/mobile-access/health`，检查 HTTPS 证书并确认响应为 `{"ok":true}`。这是基础连通性检查；单独的 HTTP `401`、`301` 或“网页能打开”不能证明请求到达你的 DSH。
3. 若需确认目标电脑，比较该地址 `/mobile-access/discovery` 返回的 `instanceId` 与本机网关的值；不要公开完整 discovery 响应、配对码或凭据。
4. 在 Android App 选择 **远程访问**，使用面板生成的远程配对二维码连接，确认工作区和会话可以读取、实时连接正常；也可查看面板的连接诊断。不需要发送模型请求来验证连通性。

已有配对记录绑定精确 HTTPS Origin。由临时地址换成固定地址时，需要重新配对一次；以后地址保持不变且授权仍有效时可继续使用原记录。固定域名不会阻止 Token 过期、设备撤销、证书问题或提供方故障。

## 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| 仍显示临时地址 | 确认插件为 0.6.7 或更新版本、字段位于已有 `mobile-access` 的完整 `config` 中，并已完整重启。再核对账号预留和地区，不要仅凭本地字段存在判断成功。 |
| 插件报 `cpolar subdomain is invalid` | 检查前述请求格式和 63 字符上限，只填预留名字；符合本地格式仍可能被 cpolar 拒绝。 |
| 插件报 `cpolar region is invalid` | 地区格式为小写字母开头，后续仅小写字母、数字或下划线，最多 32 字符；再按账号预留记录确认它确实有效。 |
| cpolar 拒绝固定名字或无法启动 | 核对当前套餐、账号、预留名字和地区；查看错误信息并按 cpolar 当前说明处理。插件不会把请求值当成成功返回的公网地址。 |
| 健康检查正常但工作区加载失败 | 继续检查配对授权和实际 WebSocket 连接，使用连接诊断；健康接口成功不等于完整会话可用。 |
| 改配置后数据或监听异常 | 检查是否遗漏了原有完整 `config`，从备份恢复原路径与访问设置；不要删除配对文件。 |

## 安全边界

- 这两个设置只追加 `cpolar http` 的 `-subdomain` 与 `-region` 参数，不改变网关配对、TLS 或设备授权逻辑。
- 插件仍只使用 cpolar 实际报告并校验通过的公网地址，不会把填写的名字直接当成可信 Origin。
- Authtoken 保持原有私有存储方式；预留名字会出现在公网域名中，不是秘密，但不要连同 Token、Cookie 或配对二维码公开。
