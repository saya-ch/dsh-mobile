# DeepSeek Harness 0.1.5 局域网适配说明

本文件记录 `local/0.1.5-lan` 分支相对已发布 `0.3.14`（`main` @ `ee83482`）改了什么、在哪套环境验证过、以及明确没有做的事。

## 适配与验证版本

| 项目 | 版本 / 结果 |
|------|-------------|
| 插件底版 | `dsh-mobile` **0.3.14** |
| 目标宿主 | DeepSeek Harness **0.1.5-rc.1** |
| 已验证路径 | **仅局域网**（HTTPS 网关、配对、会话列表、对话区、新会话、右侧栏） |
| 未验证路径 | Tailscale Funnel、cpolar、自建 FRP |

局域网实测环境：本机 `dsh --profile web`（`0.1.5-rc.1`），插件以 `link:` 安装，`setup` 绑定 `en0`，手机端走插件 LAN HTTPS。

## 改了什么

运行时代码来自上游未合并的 [PR #60](https://github.com/saya-ch/dsh-mobile/pull/60)（`longisland-icetea`），本分支在其之上补充本说明，并完成局域网实测。

### 1. 移动 layout 契约（`src/mobile-layout.ts`）

0.1.5 把会话面板从 `conversation` 迁到 keyed `main`，并由官方 layout 发布根 hook `panelInfo`。本分支的 dedicated 布局补齐：

- 声明并渲染 `main: { kind: 'keyed', scope: 'root' }`，`entryKey` 为 `activePanelId ?? 'conversation'`
- `slots.provideRoot` 发布 `panelInfo`；实现 `selectPanel` / `retainMainPanels`
- `ctx.layout.openRightbar` / `closeRightbar` 映射到 details 抽屉；`canShow: true`（手机宽度下右侧栏不再被立刻收起）
- `beginNavigation()`，否则侧栏「新会话」会静默失败
- 仍保留 `conversation` 与 `details` 声明，便于旧宿主

### 2. 移动 boot batch（`src/gateway.ts`）

0.1.5 客户端 entry 变多后，组装 `/mobile-access/mobile-boot/*.js` 时上游偶发 `ECONNRESET`，整页 502。本分支：

- 瞬时失败最多重试 4 次
- fan-out 从 8 降到 3
- 同一 batch 的并发请求共用一次组装

### 3. 测试（`tests/mobile-layout.test.ts`）

断言 `main` 槽、`panelInfo` 流转、rightbar 开合、`beginNavigation` 取消上一轮导航。

### 4. 文档（本文件、README、CHANGELOG）

标明适配版本、已测范围、未做事项，避免把「局域网可用」写成「0.1.5 全功能官方支持」。

## 没有做

- **没有测试远程访问**（Funnel / cpolar / FRP）。远程与 LAN 共用网关内核，但隧道、公网 TLS、独立设备库未在 0.1.5-rc.1 上回归。
- **没有发布新的 npm / GitHub Release**。`package.json` 版本仍为 `0.3.14`。
- **没有扩展 `peerDependencies` 到 `^0.1.5-0`**。现有范围止于 `^0.1.3-0`；`0.1.5-rc.1` 在严格 semver 下可能告警，但不按版本号拒绝启动。
- **没有改 `scripts/check-dsh-compatibility.mjs`**。该脚本仍要求 layout 源码含 `'conversation': { kind: 'single', scope: 'session-maybe' }`，对 0.1.5 源码树会失败（与 PR #60 的 CI 红灯同类）。
- **没有改 Android App、配对协议、证书模型、LAN `setup` CLI**。现有 0.3.3–0.3.14 App 按项目策略无需重新配对；本分支未单独打新 APK。
- **没有做成 LAN-only 裁剪版**。远程相关模块仍在仓库中，只是本分支未验证它们。

## 使用本分支

```sh
dsh plugin --profile web add <this-checkout>
dsh plugin --profile web exec dsh-mobile setup
dsh --profile web
```

重启 DSH 后只打开 **移动访问 → 局域网**。不要依赖本分支作为远程访问的发布保证。
