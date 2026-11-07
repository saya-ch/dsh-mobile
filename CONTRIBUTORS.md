# 贡献者 / Contributors

GitHub 的 [Contributors 图表](https://github.com/saya-ch/dsh-mobile/graphs/contributors) 按进入默认分支的提交自动统计，无法手动加入仅提交 issue 或 PR 提案的成员。本页按实际参与方式感谢社区成员；仓库维护者与自动依赖更新仍可在 GitHub 历史记录中查看。

GitHub's Contributors graph counts commits on the default branch; issue reports and PR proposals cannot be manually added to it. This page credits community members by how they contributed. The repository maintainer and automated dependency updates remain visible in GitHub's history.

## 0.8.5 贡献 / Contributions for 0.8.5

感谢 [@lyc0110](https://github.com/lyc0110) 在 [#364](https://github.com/saya-ch/dsh-mobile/issues/364) 报告 Windows 防火墙先删后建的风险，[@fgql](https://github.com/fgql) 在 [#365](https://github.com/saya-ch/dsh-mobile/issues/365) 提供 iroh 私有目录失败的完整诊断，[@LunarFeller](https://github.com/LunarFeller) 在 [#355](https://github.com/saya-ch/dsh-mobile/pull/355) 提供 macOS 完全磁盘访问提示及真机验证，以及 [@chenForbear](https://github.com/chenForbear) 在 [#363](https://github.com/saya-ch/dsh-mobile/issues/363) 提供模块批次测量。

Thanks [@lyc0110](https://github.com/lyc0110) for reporting the Windows firewall replacement risk in [#364](https://github.com/saya-ch/dsh-mobile/issues/364), [@fgql](https://github.com/fgql) for the detailed iroh private-directory diagnosis in [#365](https://github.com/saya-ch/dsh-mobile/issues/365), [@LunarFeller](https://github.com/LunarFeller) for the macOS Full Disk Access notice and device verification in [#355](https://github.com/saya-ch/dsh-mobile/pull/355), and [@chenForbear](https://github.com/chenForbear) for the module-batch measurements in [#363](https://github.com/saya-ch/dsh-mobile/issues/363).

## 0.8.4 贡献 / Contributions for 0.8.4

感谢 [@owenzhao](https://github.com/owenzhao) 在 [#361](https://github.com/saya-ch/dsh-mobile/issues/361) 报告相对重定向导致移动图片预览失败。感谢 [@aaalzk](https://github.com/aaalzk) 独立确认，以及 [@LUgABeEEE](https://github.com/LUgABeEEE) 在 [#362](https://github.com/saya-ch/dsh-mobile/pull/362) 提供折叠栏布局修复。原作者提交保留；维护者修正另记。

Thanks [@owenzhao](https://github.com/owenzhao) for reporting the mobile image-preview redirect failure in [#361](https://github.com/saya-ch/dsh-mobile/issues/361). Thanks [@aaalzk](https://github.com/aaalzk) for independently confirming it, and [@LUgABeEEE](https://github.com/LUgABeEEE) for the folded-rail layout fix in [#362](https://github.com/saya-ch/dsh-mobile/pull/362). Original commits are retained, with maintainer corrections recorded separately.

## 0.8.3 贡献 / Contributions for 0.8.3

感谢 [@xaxka](https://github.com/xaxka) 在 [#344](https://github.com/saya-ch/dsh-mobile/pull/344) 提供共享 FRP 用户名支持，[@LUgABeEEE](https://github.com/LUgABeEEE) 在 [#346](https://github.com/saya-ch/dsh-mobile/pull/346) 提供横屏布局判断，以及 [@chintoleung](https://github.com/chintoleung) 在 [#351](https://github.com/saya-ch/dsh-mobile/pull/351) 和 [#353](https://github.com/saya-ch/dsh-mobile/pull/353) 修复推送设置与插件页布局。原作者提交保留，维护者修正另记。

Thanks [@xaxka](https://github.com/xaxka) for the shared-FRP username in [#344](https://github.com/saya-ch/dsh-mobile/pull/344), [@LUgABeEEE](https://github.com/LUgABeEEE) for the landscape layout in [#346](https://github.com/saya-ch/dsh-mobile/pull/346), and [@chintoleung](https://github.com/chintoleung) for the push-settings and Plugins-page layout fixes in [#351](https://github.com/saya-ch/dsh-mobile/pull/351) and [#353](https://github.com/saya-ch/dsh-mobile/pull/353). Original commits are retained, with maintainer corrections recorded separately.

## 0.8.2 贡献 / Contributions for 0.8.2

感谢 [@LUgABeEEE](https://github.com/LUgABeEEE) 通过 [#343](https://github.com/saya-ch/dsh-mobile/pull/343) 修正 Android 固定证书的 WebSocket 地址判断。原作者提交保留；维护者补充完整证书决策组合回归。该原生改动归入独立编号的 Android 0.7.2 候选，不由 npm 升级替代。

Thanks [@LUgABeEEE](https://github.com/LUgABeEEE) for the Android pinned-WebSocket authority fix in [#343](https://github.com/saya-ch/dsh-mobile/pull/343). Original commits are retained alongside maintainer combined-certificate regressions. This native change belongs to the independently versioned Android 0.7.2 candidate, not an npm-only update.

感谢 [@LunarFeller](https://github.com/LunarFeller) 在 [#341](https://github.com/saya-ch/dsh-mobile/issues/341) 定位 FRP 接入模式的标题与 SSH 字段残留，并通过 [#342](https://github.com/saya-ch/dsh-mobile/pull/342) 提交修复；候选保留原作者提交，并补充浏览器回归。

Thanks [@LunarFeller](https://github.com/LunarFeller) for diagnosing the FRP attach-mode heading and SSH-field remnants in [#341](https://github.com/saya-ch/dsh-mobile/issues/341) and contributing the fix in [#342](https://github.com/saya-ch/dsh-mobile/pull/342). The candidate preserves the original commit and adds browser regression coverage.

感谢 [@madlogos](https://github.com/madlogos) 在[后续反馈](https://github.com/saya-ch/dsh-mobile/issues/337#issuecomment-6593356950)中指出最小加载后的设置访问与全量恢复问题，推动旧选择重启恢复流程的验收和说明。

Thanks [@madlogos](https://github.com/madlogos) for the [follow-up report](https://github.com/saya-ch/dsh-mobile/issues/337#issuecomment-6593356950) about settings access and loading all modules after minimal loading, informing restart-recovery acceptance and guidance.

感谢 [@z2140014118-stack](https://github.com/z2140014118-stack) 在 [#340](https://github.com/saya-ch/dsh-mobile/issues/340) 提供 MagicDNS 前后对照，帮助定位诊断的测量范围误报。诊断修正不表示 tailnet 内的连接限制已解除。

Thanks [@z2140014118-stack](https://github.com/z2140014118-stack) for the MagicDNS comparison in [#340](https://github.com/saya-ch/dsh-mobile/issues/340), helping identify misleading diagnostic scope. Correcting the report does not remove the private-tailnet connection limitation.

感谢 [@LUgABeEEE](https://github.com/LUgABeEEE) 在 [#328](https://github.com/saya-ch/dsh-mobile/pull/328) 提供模块目录版本校验，以及 [@smlfx](https://github.com/smlfx) 在 [#338](https://github.com/saya-ch/dsh-mobile/issues/338) 提供 iroh 与 HTTP 诊断报告。报告原始故障仍在调查，不因署名而视为已解决。

Thanks [@LUgABeEEE](https://github.com/LUgABeEEE) for module-catalog revision validation in [#328](https://github.com/saya-ch/dsh-mobile/pull/328), and [@smlfx](https://github.com/smlfx) for the iroh/HTTP diagnostic report in [#338](https://github.com/saya-ch/dsh-mobile/issues/338). The original reported failure remains under investigation; credit does not imply resolution.

## 0.6.18 代码贡献与反馈 / Code contributions and reports for 0.6.18

感谢 [@OranImp](https://github.com/OranImp) 在 [#271](https://github.com/saya-ch/dsh-mobile/issues/271) 反馈目录选择流程缺少新建文件夹，[@LzBsA](https://github.com/LzBsA) 在 [#272](https://github.com/saya-ch/dsh-mobile/issues/272) 提出受控 NAS 管理入口需求，以及 [@LUgABeEEE](https://github.com/LUgABeEEE) 在 [#275](https://github.com/saya-ch/dsh-mobile/issues/275)、[#276](https://github.com/saya-ch/dsh-mobile/issues/276) 提供慢链路启动与模块恢复的详细报告。[@LUgABeEEE](https://github.com/LUgABeEEE) 的 [#274](https://github.com/saya-ch/dsh-mobile/pull/274) 配置快照修正和 [#280](https://github.com/saya-ch/dsh-mobile/pull/280) 插件适配指南保留原作者提交，并另附维护者修正。#275 的原生加载修复随独立编号的 App 发布，不由插件升级替代。

Thanks [@OranImp](https://github.com/OranImp) for reporting missing folder creation in [#271](https://github.com/saya-ch/dsh-mobile/issues/271), [@LzBsA](https://github.com/LzBsA) for the controlled NAS administration request in [#272](https://github.com/saya-ch/dsh-mobile/issues/272), and [@LUgABeEEE](https://github.com/LUgABeEEE) for the detailed slow-link boot and module-recovery reports in [#275](https://github.com/saya-ch/dsh-mobile/issues/275) and [#276](https://github.com/saya-ch/dsh-mobile/issues/276). Original commits for [@LUgABeEEE](https://github.com/LUgABeEEE)'s setup snapshot correction in [#274](https://github.com/saya-ch/dsh-mobile/pull/274) and adaptation guide in [#280](https://github.com/saya-ch/dsh-mobile/pull/280) are retained alongside maintainer corrections. The native loading fix for #275 belongs to the independently versioned App, not a plugin-only update.

## 0.6.17 代码贡献与反馈 / Code contributions and reports for 0.6.17

感谢 [@LUgABeEEE](https://github.com/LUgABeEEE) 提供 [#259](https://github.com/saya-ch/dsh-mobile/pull/259)、[#260](https://github.com/saya-ch/dsh-mobile/pull/260)、[#261](https://github.com/saya-ch/dsh-mobile/pull/261)、[#262](https://github.com/saya-ch/dsh-mobile/pull/262) 的慢链路压缩、启动分批、模块体积与最小预设、静态资源校验方案。原始提交已随 0.6.17 进入默认分支，维护者的兼容性、生命周期和交互修正作为追加提交保留在旁。另保留 [#263](https://github.com/saya-ch/dsh-mobile/pull/263) 的 API 短缓存提案与贡献历史，但本版不启用泛 API 响应缓存；该提案不计入本版功能。

Thanks [@LUgABeEEE](https://github.com/LUgABeEEE) for the slow-link compression, boot batching, module-size/minimal-preset and static-resource revalidation work in [#259](https://github.com/saya-ch/dsh-mobile/pull/259), [#260](https://github.com/saya-ch/dsh-mobile/pull/260), [#261](https://github.com/saya-ch/dsh-mobile/pull/261) and [#262](https://github.com/saya-ch/dsh-mobile/pull/262). Original commits entered the default branch with 0.6.17, with maintainer compatibility, lifecycle and interaction corrections retained as follow-up commits. The proposal and original history of [#263](https://github.com/saya-ch/dsh-mobile/pull/263) are also retained, but generic API-response caching is not enabled in this release and does not count as a 0.6.17 feature.

感谢 [@ChaoPhone](https://github.com/ChaoPhone) 在 [#257](https://github.com/saya-ch/dsh-mobile/issues/257) 提供官方 Desktop 目录选择器重复注册的分析，以及 [@bvbhu](https://github.com/bvbhu) 在 [#258](https://github.com/saya-ch/dsh-mobile/issues/258) 提供停用目录选择界面后工作区入口消失的复现，帮助明确桌面原生选择器与移动页面浏览器应分别管理。对应修复随 0.6.17 发布。

Thanks [@ChaoPhone](https://github.com/ChaoPhone) for analyzing duplicate directory-picker registration in official Desktop in [#257](https://github.com/saya-ch/dsh-mobile/issues/257), and [@bvbhu](https://github.com/bvbhu) for reproducing missing workspace actions after disabling the picker surface in [#258](https://github.com/saya-ch/dsh-mobile/issues/258). These reports helped separate desktop-native selection from mobile in-page browsing. The related fix shipped in 0.6.17.

## 0.6.16 代码贡献与反馈 / Code contributions and reports for 0.6.16

[@abworks-dev](https://github.com/abworks-dev) 的 [#252](https://github.com/saya-ch/dsh-mobile/pull/252) 提供经认证的同电脑通道切换与有限纯文本草稿迁移；[@chintoleung](https://github.com/chintoleung) 的 [#253](https://github.com/saya-ch/dsh-mobile/pull/253) 让浏览器配对／重连页记住 DSH 语言偏好。原作者提交保留，维护者另补桥接生命周期和回归测试修正。插件相关改动随 0.6.16 发布，原生切换功能随独立的 Android App 0.6.7 发布。

[@abworks-dev](https://github.com/abworks-dev)'s [#252](https://github.com/saya-ch/dsh-mobile/pull/252) contributes authenticated same-computer endpoint switching and limited plain-text draft transfer; [@chintoleung](https://github.com/chintoleung)'s [#253](https://github.com/saya-ch/dsh-mobile/pull/253) remembers DSH's language for browser pairing/reconnect pages. Original author commits are retained alongside maintainer Bridge-lifecycle and regression-test corrections. Plugin changes shipped in 0.6.16; native switching shipped independently in Android App 0.6.7.

[@abworks-dev](https://github.com/abworks-dev) 的 [#249](https://github.com/saya-ch/dsh-mobile/pull/249) 提供相册图片选择入口；[@ayiejosh](https://github.com/ayiejosh) 的 [#241](https://github.com/saya-ch/dsh-mobile/pull/241) 提供前台恢复与原生续期方案。两份 PR 的原作者提交保留，随后追加选择器、恢复归属、取消和 Cookie 写入修正；未保留上游前端包改写。感谢 [@chenyxuan](https://github.com/chenyxuan) 在 [#250](https://github.com/saya-ch/dsh-mobile/issues/250) 反馈 FRP 表单报错不明确，推动字段级提示改进。插件改进随 0.6.16 发布，原生恢复改进随 App 0.6.7 发布；审查与整合历史见对应 PR。

[@abworks-dev](https://github.com/abworks-dev)'s [#249](https://github.com/saya-ch/dsh-mobile/pull/249) contributes the Gallery image-picker shortcut; [@ayiejosh](https://github.com/ayiejosh)'s [#241](https://github.com/saya-ch/dsh-mobile/pull/241) contributes foreground recovery and native renewal proposals. Both authors' original commits are retained alongside picker, recovery ownership, cancellation and Cookie-write corrections; upstream frontend-bundle rewriting is not retained. Thanks [@chenyxuan](https://github.com/chenyxuan) for reporting unclear FRP form errors in [#250](https://github.com/saya-ch/dsh-mobile/issues/250), informing field-level feedback. Plugin improvements shipped in 0.6.16, while native recovery improvements shipped in App 0.6.7; the linked PRs record their review and integration history.

## 0.6.15 反馈 / Reports for 0.6.15

感谢 [@axlrose](https://github.com/axlrose) 在 [#246](https://github.com/saya-ch/dsh-mobile/issues/246) 提供 Firefox 管理请求被拒的复现线索，促成 0.6.15 对缺少来源头场景的兼容与跨站拒绝测试。

Thanks [@axlrose](https://github.com/axlrose) for the Firefox management-request rejection report in [#246](https://github.com/saya-ch/dsh-mobile/issues/246), informing compatibility for omitted source headers and cross-origin rejection tests in 0.6.15.

感谢 [@Void-LifeStream](https://github.com/Void-LifeStream) 在 [#243](https://github.com/saya-ch/dsh-mobile/issues/243) 反馈启动、重载和会话显示问题，推动本轮模块通知、Android 自动恢复与诊断检查。插件 0.6.15 和 App 0.6.6 分别包含相关改进，不代表该报告中的全部现象已复现或解决。

Thanks [@Void-LifeStream](https://github.com/Void-LifeStream) for reporting startup, reload and session-display problems in [#243](https://github.com/saya-ch/dsh-mobile/issues/243), prompting the module-notification, Android recovery and diagnostic investigation. Related improvements belong to plugin 0.6.15 and App 0.6.6 independently; not every reported symptom has been reproduced or resolved.

## 0.6.14 代码贡献与反馈 / Code contributions and reports for 0.6.14

[@chintoleung](https://github.com/chintoleung) 的 [#239](https://github.com/saya-ch/dsh-mobile/pull/239) 将触摸历史自动加载延后至手势落定，并增加真实分页回归。0.6.14 保留原作者的三个提交，并追加维护者对滚动事件归属、新手势意图和混合输入的修正。感谢 [@gugubb5](https://github.com/gugubb5) 在 [#237](https://github.com/saya-ch/dsh-mobile/issues/237) 反馈侧栏入口共存问题，以及 [@faruzanCN](https://github.com/faruzanCN) 在 [#238](https://github.com/saya-ch/dsh-mobile/issues/238) 提出 IPv6 反代需求。

[@chintoleung](https://github.com/chintoleung)'s [#239](https://github.com/saya-ch/dsh-mobile/pull/239) defers touch-driven history loading until the gesture settles and adds real pagination regressions. Version 0.6.14 retains the author's three commits alongside maintainer fixes for scroll-event ownership, new-gesture intent and mixed input. Thanks [@gugubb5](https://github.com/gugubb5) for reporting sidebar-entry coexistence in [#237](https://github.com/saya-ch/dsh-mobile/issues/237), and [@faruzanCN](https://github.com/faruzanCN) for the IPv6 reverse-proxy request in [#238](https://github.com/saya-ch/dsh-mobile/issues/238).

## 0.6.12 问题定位 / Issue findings for 0.6.12

感谢 [@jamorzzz](https://github.com/jamorzzz) 在 [#230](https://github.com/saya-ch/dsh-mobile/issues/230) 提供社区认证插件的导航响应与网关握手分析，[@Akiyuki1130](https://github.com/Akiyuki1130) 在 [#231](https://github.com/saya-ch/dsh-mobile/issues/231) 复现共享代理下的匿名限流耗尽，以及 [@yunyunlyk](https://github.com/yunyunlyk) 在 [#232](https://github.com/saya-ch/dsh-mobile/issues/232) 提供具体华为内核版本与 App／浏览器对照。这些报告分别促成认证握手、凭据限流和旧内核启动反馈改进；未将报告者真机写成已完成修复验收。

Thanks [@jamorzzz](https://github.com/jamorzzz) for the community-auth navigation and Gateway exchange analysis in [#230](https://github.com/saya-ch/dsh-mobile/issues/230), [@Akiyuki1130](https://github.com/Akiyuki1130) for reproducing anonymous rate-limit exhaustion behind a shared proxy in [#231](https://github.com/saya-ch/dsh-mobile/issues/231), and [@yunyunlyk](https://github.com/yunyunlyk) for the exact Huawei engine version and App/browser comparison in [#232](https://github.com/saya-ch/dsh-mobile/issues/232). These reports informed authentication, credential-admission and old-engine startup feedback improvements; they are not recorded as completed acceptance on the reporters' devices.

## 0.6.11 代码贡献 / Code contributions in 0.6.11

[@ayiejosh](https://github.com/ayiejosh) 的 [#226](https://github.com/saya-ch/dsh-mobile/pull/226) 为 HTTP 认证和 CSRF 拒绝添加诊断记录。0.6.11 保留原作者提交 [`115b174`](https://github.com/saya-ch/dsh-mobile/commit/115b174d65c5bcb33f96f671e83dcb15db461e3f)，并追加隐私、限频、统计和错误隔离修正。

[@ayiejosh](https://github.com/ayiejosh)'s [#226](https://github.com/saya-ch/dsh-mobile/pull/226) adds diagnostic records for HTTP authentication and CSRF rejections. Version 0.6.11 retains author commit [`115b174`](https://github.com/saya-ch/dsh-mobile/commit/115b174d65c5bcb33f96f671e83dcb15db461e3f) alongside privacy, rate-limit, counting and failure-containment corrections.

[@chintoleung](https://github.com/chintoleung) 在 [#228](https://github.com/saya-ch/dsh-mobile/issues/228) 定位历史加载时的滚动抖动，并在 [#229](https://github.com/saya-ch/dsh-mobile/pull/229) 提供加载行尺寸、自动加载输入判定及浏览器回归测试。0.6.11 保留原作者的五个提交，包括最终修正 [`675154d`](https://github.com/saya-ch/dsh-mobile/commit/675154d5739c3a2de663e7c35da6ba8657017a5e)，并追加维护者修正。

[@chintoleung](https://github.com/chintoleung) traced history-loading scroll oscillation in [#228](https://github.com/saya-ch/dsh-mobile/issues/228) and contributed loader sizing, input-aware auto-loading and browser regression checks in [#229](https://github.com/saya-ch/dsh-mobile/pull/229). Version 0.6.11 retains the author's five commits, including final correction [`675154d`](https://github.com/saya-ch/dsh-mobile/commit/675154d5739c3a2de663e7c35da6ba8657017a5e), alongside maintainer corrections.

## 0.6.7 代码贡献 / Code contributions in 0.6.7

[@GavinQiEr](https://github.com/GavinQiEr) 在 [#207](https://github.com/saya-ch/dsh-mobile/issues/207) 提出 cpolar 固定子域名支持，并在 [#208](https://github.com/saya-ch/dsh-mobile/pull/208) 提供配置、启动参数和文档实现。[#211](https://github.com/saya-ch/dsh-mobile/pull/211) 的整合保留原作者提交 [`8dd7574`](https://github.com/saya-ch/dsh-mobile/commit/8dd75749d3823aecafdb6f5d9faccf674577e7b1)，并追加维护者修正，纳入 0.6.7。

[@GavinQiEr](https://github.com/GavinQiEr) requested reserved cpolar subdomains in [#207](https://github.com/saya-ch/dsh-mobile/issues/207) and implemented the configuration, process arguments and guides in [#208](https://github.com/saya-ch/dsh-mobile/pull/208). Integration [#211](https://github.com/saya-ch/dsh-mobile/pull/211) retains author commit [`8dd7574`](https://github.com/saya-ch/dsh-mobile/commit/8dd75749d3823aecafdb6f5d9faccf674577e7b1) alongside maintainer corrections for 0.6.7.

## 0.6.4 代码贡献 / Code contributions in 0.6.4

[@abworks-dev](https://github.com/abworks-dev) 的 [#200](https://github.com/saya-ch/dsh-mobile/pull/200) 提供窄屏输入栏包装层与按钮点击区域的尺寸修正及回归测试，代码已随 0.6.4 发布；随后以合并提交 [`71754e5`](https://github.com/saya-ch/dsh-mobile/commit/71754e5191d3e9eadfedad16982e144491272f26) 保留原作者提交 [`03604ae`](https://github.com/saya-ch/dsh-mobile/commit/03604ae7623ceb42090ff4c4ed0e84d4aff7144a)。这次历史补全不改变已发布的功能或标签。

[@abworks-dev](https://github.com/abworks-dev)'s [#200](https://github.com/saya-ch/dsh-mobile/pull/200) supplies the narrow-screen composer wrapper sizing fix and regression checks shipped in 0.6.4. The subsequent merge [`71754e5`](https://github.com/saya-ch/dsh-mobile/commit/71754e5191d3e9eadfedad16982e144491272f26) retains the original author commit [`03604ae`](https://github.com/saya-ch/dsh-mobile/commit/03604ae7623ceb42090ff4c4ed0e84d4aff7144a) without changing the released functionality or tags.

## 0.6.3 代码贡献 / Code contributions in 0.6.3

[@abworks-dev](https://github.com/abworks-dev) 的 [#190](https://github.com/saya-ch/dsh-mobile/pull/190)、[#191](https://github.com/saya-ch/dsh-mobile/pull/191)、[#192](https://github.com/saya-ch/dsh-mobile/pull/192)，以及 [@chintoleung](https://github.com/chintoleung) 在 [#189](https://github.com/saya-ch/dsh-mobile/issues/189) 提供的三个 Worker 原型提交参与本版，保留原始提交并追加适配与修正。具体范围见 [更新记录](CHANGELOG.md#063---2026-10-10)。

[@abworks-dev](https://github.com/abworks-dev)'s [#190](https://github.com/saya-ch/dsh-mobile/pull/190), [#191](https://github.com/saya-ch/dsh-mobile/pull/191) and [#192](https://github.com/saya-ch/dsh-mobile/pull/192), plus three Worker prototype commits supplied by [@chintoleung](https://github.com/chintoleung) through [#189](https://github.com/saya-ch/dsh-mobile/issues/189), contribute to this release with original history and maintainer corrections. See the [release scope](CHANGELOG.md#063---2026-10-10).

## 已合并 PR / Merged PRs

| 社区成员 / Community member | 已合并 PR / Merged PRs |
| --- | --- |
| [@1624318455](https://github.com/1624318455) | [#93](https://github.com/saya-ch/dsh-mobile/pull/93) |
| [@abworks-dev](https://github.com/abworks-dev) | [#91](https://github.com/saya-ch/dsh-mobile/pull/91), [#98](https://github.com/saya-ch/dsh-mobile/pull/98), [#99](https://github.com/saya-ch/dsh-mobile/pull/99), [#152](https://github.com/saya-ch/dsh-mobile/pull/152), [#184](https://github.com/saya-ch/dsh-mobile/pull/184), [#185](https://github.com/saya-ch/dsh-mobile/pull/185), [#200](https://github.com/saya-ch/dsh-mobile/pull/200) |
| [@ayiejosh](https://github.com/ayiejosh) | [#109](https://github.com/saya-ch/dsh-mobile/pull/109), [#110](https://github.com/saya-ch/dsh-mobile/pull/110), [#116](https://github.com/saya-ch/dsh-mobile/pull/116), [#117](https://github.com/saya-ch/dsh-mobile/pull/117), [#119](https://github.com/saya-ch/dsh-mobile/pull/119), [#124](https://github.com/saya-ch/dsh-mobile/pull/124), [#125](https://github.com/saya-ch/dsh-mobile/pull/125), [#133](https://github.com/saya-ch/dsh-mobile/pull/133), [#136](https://github.com/saya-ch/dsh-mobile/pull/136), [#226](https://github.com/saya-ch/dsh-mobile/pull/226) |
| [@chintoleung](https://github.com/chintoleung) | [#104](https://github.com/saya-ch/dsh-mobile/pull/104), [#147](https://github.com/saya-ch/dsh-mobile/pull/147), [#148](https://github.com/saya-ch/dsh-mobile/pull/148), [#158](https://github.com/saya-ch/dsh-mobile/pull/158), [#161](https://github.com/saya-ch/dsh-mobile/pull/161), [#162](https://github.com/saya-ch/dsh-mobile/pull/162), [#167](https://github.com/saya-ch/dsh-mobile/pull/167), [#229](https://github.com/saya-ch/dsh-mobile/pull/229), [#297](https://github.com/saya-ch/dsh-mobile/pull/297), [#302](https://github.com/saya-ch/dsh-mobile/pull/302) |
| [@cjxh21](https://github.com/cjxh21) | [#154](https://github.com/saya-ch/dsh-mobile/pull/154), [#155](https://github.com/saya-ch/dsh-mobile/pull/155) |
| [@fengfanfan-max](https://github.com/fengfanfan-max) | [#143](https://github.com/saya-ch/dsh-mobile/pull/143) |
| [@fqf060420](https://github.com/fqf060420) | [#170](https://github.com/saya-ch/dsh-mobile/pull/170) |
| [@idoall](https://github.com/idoall) | [#61](https://github.com/saya-ch/dsh-mobile/pull/61), [#66](https://github.com/saya-ch/dsh-mobile/pull/66), [#67](https://github.com/saya-ch/dsh-mobile/pull/67), [#77](https://github.com/saya-ch/dsh-mobile/pull/77) |
| [@JackRushante](https://github.com/JackRushante) | [#16](https://github.com/saya-ch/dsh-mobile/pull/16) |
| [@liudasheng](https://github.com/liudasheng) | [#100](https://github.com/saya-ch/dsh-mobile/pull/100), [#130](https://github.com/saya-ch/dsh-mobile/pull/130) |
| [@longisland-icetea](https://github.com/longisland-icetea) | [#59](https://github.com/saya-ch/dsh-mobile/pull/59), [#60](https://github.com/saya-ch/dsh-mobile/pull/60), [#63](https://github.com/saya-ch/dsh-mobile/pull/63) |
| [@qzyqmzn](https://github.com/qzyqmzn) | [#38](https://github.com/saya-ch/dsh-mobile/pull/38), [#75](https://github.com/saya-ch/dsh-mobile/pull/75), [#284](https://github.com/saya-ch/dsh-mobile/pull/284) |
| [@Sanksu](https://github.com/Sanksu) | [#118](https://github.com/saya-ch/dsh-mobile/pull/118) |
| [@StrawberryAO](https://github.com/StrawberryAO) | [#34](https://github.com/saya-ch/dsh-mobile/pull/34), [#40](https://github.com/saya-ch/dsh-mobile/pull/40) |
| [@xhwxt](https://github.com/xhwxt) | [#105](https://github.com/saya-ch/dsh-mobile/pull/105), [#134](https://github.com/saya-ch/dsh-mobile/pull/134) |
| [@xingleiwu](https://github.com/xingleiwu) | [#79](https://github.com/saya-ch/dsh-mobile/pull/79), [#84](https://github.com/saya-ch/dsh-mobile/pull/84), [#85](https://github.com/saya-ch/dsh-mobile/pull/85), [#86](https://github.com/saya-ch/dsh-mobile/pull/86) |

## 0.6.0 代码贡献 / Code contributions in 0.6.0

以下 PR 通过整合 [#182](https://github.com/saya-ch/dsh-mobile/pull/182) 纳入 0.6.0，保留原作者提交并追加维护者修正。 / These PRs contribute code to 0.6.0 through integration [#182](https://github.com/saya-ch/dsh-mobile/pull/182); original author commits are retained alongside maintainer corrections.

这批贡献包含资源重试、托管 Caddy 实现、应用图标、扫码改进、电脑切换快捷方式和设备排序；实际发布范围及组件可用性见 [更新记录](CHANGELOG.md#060---2026-10-07)。 / These contributions cover resource retries, the managed Caddy implementation, launcher icons, scanning, the computer-switch shortcut and device ordering. See [release notes](CHANGELOG.md#060---2026-10-07) for the shipped scope and component availability.

| 社区成员 / Community member | 已整合 PR / Integrated PRs |
| --- | --- |
| [@abworks-dev](https://github.com/abworks-dev) | [#173](https://github.com/saya-ch/dsh-mobile/pull/173), [#175](https://github.com/saya-ch/dsh-mobile/pull/175), [#176](https://github.com/saya-ch/dsh-mobile/pull/176), [#177](https://github.com/saya-ch/dsh-mobile/pull/177), [#179](https://github.com/saya-ch/dsh-mobile/pull/179) |
| [@xhwxt](https://github.com/xhwxt) | [#180](https://github.com/saya-ch/dsh-mobile/pull/180), [#181](https://github.com/saya-ch/dsh-mobile/pull/181) |

## 已吸收但未直接合并的 PR / Incorporated without a direct merge

[@BlueandwhiteXD](https://github.com/BlueandwhiteXD) 的 [#15](https://github.com/saya-ch/dsh-mobile/pull/15) 提出了并实现了 Android 键盘遮挡修复。由于发布分支已有重叠的状态栏改动，该方案改写后进入主线提交 [`09ef315`](https://github.com/saya-ch/dsh-mobile/commit/09ef31590219f2a436bd801214703338c215b00d)，并在 [`04e6a0d`](https://github.com/saya-ch/dsh-mobile/commit/04e6a0da030353d4f0897419d0f692dc538a752d) 以 `Co-authored-by` 致谢。PR 的 Closed 状态不应掩盖这项已采用的代码贡献。

[@qzyqmzn](https://github.com/qzyqmzn) 的 [#32](https://github.com/saya-ch/dsh-mobile/pull/32) 和 [#37](https://github.com/saya-ch/dsh-mobile/pull/37) 被后续已合并的 [#38](https://github.com/saya-ch/dsh-mobile/pull/38) 取代；其正式贡献已列在上方。

[@BlueandwhiteXD](https://github.com/BlueandwhiteXD)'s [#15](https://github.com/saya-ch/dsh-mobile/pull/15) supplied the Android keyboard-overlap fix. It was adapted into [`09ef315`](https://github.com/saya-ch/dsh-mobile/commit/09ef31590219f2a436bd801214703338c215b00d) alongside overlapping status-bar work and credited with `Co-authored-by` in [`04e6a0d`](https://github.com/saya-ch/dsh-mobile/commit/04e6a0da030353d4f0897419d0f692dc538a752d). Its Closed PR status does not mean the code contribution was rejected. @qzyqmzn's [#32](https://github.com/saya-ch/dsh-mobile/pull/32) and [#37](https://github.com/saya-ch/dsh-mobile/pull/37) were superseded by merged [#38](https://github.com/saya-ch/dsh-mobile/pull/38).

## 问题反馈与建议 / Issue reports and ideas

感谢 [@Void-LifeStream](https://github.com/Void-LifeStream) 在 [#225](https://github.com/saya-ch/dsh-mobile/issues/225) 提供不可达局域网连接长期停留在等待界面的详细计时与复现，促成 Android 取消连接和超时收尾改进。 / Thanks [@Void-LifeStream](https://github.com/Void-LifeStream) for the timed reproduction of an unreachable LAN connection remaining on its waiting screen in [#225](https://github.com/saya-ch/dsh-mobile/issues/225), informing Android cancellation and timeout handling.

感谢 [@Anyways366](https://github.com/Anyways366) 在 [#223](https://github.com/saya-ch/dsh-mobile/issues/223) 提供 Funnel 错误覆盖和诊断信息缺失的详细复现与修正建议。 / Thanks [@Anyways366](https://github.com/Anyways366) for the detailed Funnel error-overwrite and missing-diagnostic reproduction and proposed corrections in [#223](https://github.com/saya-ch/dsh-mobile/issues/223).

感谢 [@Yurzi](https://github.com/Yurzi) 在 [#213](https://github.com/saya-ch/dsh-mobile/issues/213) 报告不同电脑的远程配对记录互相覆盖。 / Thanks [@Yurzi](https://github.com/Yurzi) for reporting remote pairing records on different computers overwriting one another in [#213](https://github.com/saya-ch/dsh-mobile/issues/213).

感谢 [@Dantezcx](https://github.com/Dantezcx) 在 [#209](https://github.com/saya-ch/dsh-mobile/issues/209) 和 [#210](https://github.com/saya-ch/dsh-mobile/issues/210) 提供侧栏命中、短屏布局和定制资源加载的详细诊断。 / Thanks [@Dantezcx](https://github.com/Dantezcx) for the detailed sidebar hit-testing, short-viewport and customization-loading diagnostics in [#209](https://github.com/saya-ch/dsh-mobile/issues/209) and [#210](https://github.com/saya-ch/dsh-mobile/issues/210).

感谢 [@xhwxt](https://github.com/xhwxt) 在 [#203](https://github.com/saya-ch/dsh-mobile/pull/203) 中提出文档选择器改进方案，以及 [@Void-LifeStream](https://github.com/Void-LifeStream) 在 [#205](https://github.com/saya-ch/dsh-mobile/issues/205) 中提供附件选择与回传问题的详细反馈。

Thanks [@xhwxt](https://github.com/xhwxt) for the document-picker proposal in [#203](https://github.com/saya-ch/dsh-mobile/pull/203), and [@Void-LifeStream](https://github.com/Void-LifeStream) for the detailed attachment-selection and delivery report in [#205](https://github.com/saya-ch/dsh-mobile/issues/205).

以下名单包括提出问题、复现缺陷和建议功能的成员；出现在本表不表示提交过代码。 / These members opened repository issues; listing them does not imply code authorship.

| 反馈贡献者 / Issue reporter | 提交的问题 / Issues |
| --- | --- |
| [@1624318455](https://github.com/1624318455) | [#92](https://github.com/saya-ch/dsh-mobile/issues/92) |
| [@2647954284](https://github.com/2647954284) | [#199](https://github.com/saya-ch/dsh-mobile/issues/199) |
| [@abworks-dev](https://github.com/abworks-dev) | [#174](https://github.com/saya-ch/dsh-mobile/issues/174) |
| [@Ann-luo](https://github.com/Ann-luo) | [#150](https://github.com/saya-ch/dsh-mobile/issues/150) |
| [@Anyways366](https://github.com/Anyways366) | [#223](https://github.com/saya-ch/dsh-mobile/issues/223) |
| [@BrainZombie](https://github.com/BrainZombie) | [#128](https://github.com/saya-ch/dsh-mobile/issues/128) |
| [@bvbhu](https://github.com/bvbhu) | [#258](https://github.com/saya-ch/dsh-mobile/issues/258) |
| [@CESAEREE](https://github.com/CESAEREE) | [#1](https://github.com/saya-ch/dsh-mobile/issues/1) |
| [@ChaoPhone](https://github.com/ChaoPhone) | [#257](https://github.com/saya-ch/dsh-mobile/issues/257) |
| [@CharlesLueng](https://github.com/CharlesLueng) | [#68](https://github.com/saya-ch/dsh-mobile/issues/68) |
| [@chintoleung](https://github.com/chintoleung) | [#103](https://github.com/saya-ch/dsh-mobile/issues/103), [#166](https://github.com/saya-ch/dsh-mobile/issues/166), [#189](https://github.com/saya-ch/dsh-mobile/issues/189), [#228](https://github.com/saya-ch/dsh-mobile/issues/228) |
| [@chmzs](https://github.com/chmzs) | [#73](https://github.com/saya-ch/dsh-mobile/issues/73) |
| [@faruzanCN](https://github.com/faruzanCN) | [#238](https://github.com/saya-ch/dsh-mobile/issues/238) |
| [@gjzbbs](https://github.com/gjzbbs) | [#123](https://github.com/saya-ch/dsh-mobile/issues/123) |
| [@gugubb5](https://github.com/gugubb5) | [#237](https://github.com/saya-ch/dsh-mobile/issues/237) |
| [@fishdivinity](https://github.com/fishdivinity) | [#202](https://github.com/saya-ch/dsh-mobile/issues/202) |
| [@hairyf](https://github.com/hairyf) | [#114](https://github.com/saya-ch/dsh-mobile/issues/114) |
| [@helan-1997](https://github.com/helan-1997) | [#168](https://github.com/saya-ch/dsh-mobile/issues/168) |
| [@hpsks416](https://github.com/hpsks416) | [#132](https://github.com/saya-ch/dsh-mobile/issues/132) |
| [@idoall](https://github.com/idoall) | [#42](https://github.com/saya-ch/dsh-mobile/issues/42), [#45](https://github.com/saya-ch/dsh-mobile/issues/45), [#46](https://github.com/saya-ch/dsh-mobile/issues/46), [#47](https://github.com/saya-ch/dsh-mobile/issues/47), [#62](https://github.com/saya-ch/dsh-mobile/issues/62), [#64](https://github.com/saya-ch/dsh-mobile/issues/64) |
| [@IvyC-zz](https://github.com/IvyC-zz) | [#58](https://github.com/saya-ch/dsh-mobile/issues/58), [#78](https://github.com/saya-ch/dsh-mobile/issues/78) |
| [@jackfocus15-spec](https://github.com/jackfocus15-spec) | [#285](https://github.com/saya-ch/dsh-mobile/issues/285) |
| [@jillkayat](https://github.com/jillkayat) | [#10](https://github.com/saya-ch/dsh-mobile/issues/10) |
| [@jonaskilli](https://github.com/jonaskilli) | [#198](https://github.com/saya-ch/dsh-mobile/issues/198) |
| [@jueruibo](https://github.com/jueruibo) | [#101](https://github.com/saya-ch/dsh-mobile/issues/101) |
| [@KMGTPEZY](https://github.com/KMGTPEZY) | [#95](https://github.com/saya-ch/dsh-mobile/issues/95) |
| [@luoyangshovel](https://github.com/luoyangshovel) | [#187](https://github.com/saya-ch/dsh-mobile/issues/187) |
| [@LWping](https://github.com/LWping) | [#94](https://github.com/saya-ch/dsh-mobile/issues/94) |
| [@miqian-nomad](https://github.com/miqian-nomad) | [#97](https://github.com/saya-ch/dsh-mobile/issues/97) |
| [@MLYR](https://github.com/MLYR) | [#193](https://github.com/saya-ch/dsh-mobile/issues/193) |
| [@oliverwan97](https://github.com/oliverwan97) | [#26](https://github.com/saya-ch/dsh-mobile/issues/26) |
| [@optttt](https://github.com/optttt) | [#111](https://github.com/saya-ch/dsh-mobile/issues/111) |
| [@qjjer](https://github.com/qjjer) | [#156](https://github.com/saya-ch/dsh-mobile/issues/156) |
| [@Quadrapole](https://github.com/Quadrapole) | [#178](https://github.com/saya-ch/dsh-mobile/issues/178) |
| [@reducm](https://github.com/reducm) | [#127](https://github.com/saya-ch/dsh-mobile/issues/127) |
| [@rgshendong](https://github.com/rgshendong) | [#87](https://github.com/saya-ch/dsh-mobile/issues/87) |
| [@RonaldinhoL](https://github.com/RonaldinhoL) | [#89](https://github.com/saya-ch/dsh-mobile/issues/89) |
| [@rushpixy](https://github.com/rushpixy) | [#165](https://github.com/saya-ch/dsh-mobile/issues/165), [#194](https://github.com/saya-ch/dsh-mobile/issues/194) |
| [@sanmaoAI1432](https://github.com/sanmaoAI1432) | [#169](https://github.com/saya-ch/dsh-mobile/issues/169) |
| [@shengyvself](https://github.com/shengyvself) | [#13](https://github.com/saya-ch/dsh-mobile/issues/13), [#14](https://github.com/saya-ch/dsh-mobile/issues/14) |
| [@snailium](https://github.com/snailium) | [#144](https://github.com/saya-ch/dsh-mobile/issues/144) |
| [@sznyhgm](https://github.com/sznyhgm) | [#96](https://github.com/saya-ch/dsh-mobile/issues/96) |
| [@sortjiajun](https://github.com/sortjiajun) | [#90](https://github.com/saya-ch/dsh-mobile/issues/90) |
| [@StrawberryAO](https://github.com/StrawberryAO) | [#39](https://github.com/saya-ch/dsh-mobile/issues/39) |
| [@Surpass567](https://github.com/Surpass567) | [#80](https://github.com/saya-ch/dsh-mobile/issues/80), [#81](https://github.com/saya-ch/dsh-mobile/issues/81) |
| [@Void-LifeStream](https://github.com/Void-LifeStream) | [#205](https://github.com/saya-ch/dsh-mobile/issues/205), [#219](https://github.com/saya-ch/dsh-mobile/issues/219), [#225](https://github.com/saya-ch/dsh-mobile/issues/225), [#234](https://github.com/saya-ch/dsh-mobile/issues/234) |
| [@WalkerJay666](https://github.com/WalkerJay666) | [#201](https://github.com/saya-ch/dsh-mobile/issues/201) |
| [@wintekk](https://github.com/wintekk) | [#306](https://github.com/saya-ch/dsh-mobile/issues/306) |
| [@up-and-down-0618](https://github.com/up-and-down-0618) | [#115](https://github.com/saya-ch/dsh-mobile/issues/115) |
| [@taki-ohh](https://github.com/taki-ohh) | [#19](https://github.com/saya-ch/dsh-mobile/issues/19) |
| [@tianyimc](https://github.com/tianyimc) | [#126](https://github.com/saya-ch/dsh-mobile/issues/126) |
| [@Xingcheng-wang](https://github.com/Xingcheng-wang) | [#76](https://github.com/saya-ch/dsh-mobile/issues/76) |
| [@xhwxt](https://github.com/xhwxt) | [#107](https://github.com/saya-ch/dsh-mobile/issues/107), [#108](https://github.com/saya-ch/dsh-mobile/issues/108), [#145](https://github.com/saya-ch/dsh-mobile/issues/145), [#146](https://github.com/saya-ch/dsh-mobile/issues/146), [#149](https://github.com/saya-ch/dsh-mobile/issues/149), [#171](https://github.com/saya-ch/dsh-mobile/issues/171) |
| [@Yurzi](https://github.com/Yurzi) | [#17](https://github.com/saya-ch/dsh-mobile/issues/17), [#213](https://github.com/saya-ch/dsh-mobile/issues/213) |
| [@Ztyss](https://github.com/Ztyss) | [#22](https://github.com/saya-ch/dsh-mobile/issues/22), [#23](https://github.com/saya-ch/dsh-mobile/issues/23) |
| [@ZinChl](https://github.com/ZinChl) | [#308](https://github.com/saya-ch/dsh-mobile/issues/308) |
