# 插件移动端基线

[English](MOBILE_PLUGIN_BASELINE.en.md) · [返回文档索引](README.md) · [适配指南（做法与示例）](MOBILE_PLUGIN_ADAPTATION.md)

这份文档给**插件自有的网页面板（浏览器或 WebView）**定一个可验收的基线：三级要求、每条数字的出处、一份可直接复制的样式，以及怎么证明它成立。它回答「做到什么程度算过」；怎么做见[适配指南](MOBILE_PLUGIN_ADAPTATION.md)，本项目自己的视觉与数值口径见[设计参考](https://github.com/saya-ch/dsh-mobile/blob/main/design-system/dsh-mobile/MASTER.md)。

这是**说明性适配指南**，不改变既有边界：移动层负责连接与页面布局，不重排第三方插件的内部控件；面板在小屏上是否好用由插件作者负责。级别不是发布门槛，用于 issue 勾选、PR 自检，或作者与用户之间的约定。未达标不等于缺陷——按[贡献指南](https://github.com/saya-ch/dsh-mobile/blob/main/CONTRIBUTING.md)的口径，兼容请求不构成对任意第三方组合的承诺。**本基线是本项目的适配建议，不是 DSH 官方标准，也不代表 DSH 官方立场。**

## 三个级别

| 级别 | 名称 | 要求（必须 / 应当） | 典型证据 |
| --- | --- | --- | --- |
| L1 | 可点 | **必须**：主要 Web 操作命中区至少 44×44 CSS px（主操作有空间时 48px）；相邻操作保留间距；输入/可编辑区域继承不小于 16px 的字号；键盘焦点可见；375px 宽下没有页面级横向溢出；不因收窄而隐藏唯一入口 | 375px 与 390px 宽度的截图，附命中区尺寸 |
| L2 | 顺手 | **应当**：按面板**实测宽度**切档（建议 ≤600px）；横向 chip/标签条可横滑；行内文字动作收成图标并保留可访问名称；正文跟随 `--dsh-content-font-size`；贴边区域让出 `env(safe-area-inset-*)`；独立滚动容器设 `overscroll-behavior: contain`；表单在窄档收成单列 | 同一面板在窄容器与宽容器各一张 |
| L3 | 可回归 | **应当**：静态预览能指定渲染宽度；把 L1/L2 的结构断言接进渲染检查；桌面渲染有基线可对比；真机未验证项写明 | 断言输出、截图基线、PR 说明 |

L1 可以先在 390px 桌面浏览器预检，但这不覆盖真机键盘、字体缩放和安全区；L2 必须在**面板宽度不等于视口宽度**的场合验（桌面窄栏、抽屉）；L3 是把前两级钉住的手段，不是新的交互要求。

## 数字与出处的对照

Web、iOS 和 Android 的单位与适用范围不同。项目建议不代替平台规范或无障碍要求，也不能把 pt、dp 与 CSS px 直接等同。

| 要求 | 出处 | 说明 |
| --- | --- | --- |
| 44×44 CSS px 命中区 | 本项目[设计参考](https://github.com/saya-ch/dsh-mobile/blob/main/design-system/dsh-mobile/MASTER.md)（Web 目标 ≥44px，主操作 48px）；[Apple HIG · Buttons](https://developer.apple.com/design/human-interface-guidelines/buttons)（命中区至少 44×44 pt）；[WCAG 2.2 SC 2.5.5](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)（AAA，44×44 CSS px） | pt、dp、CSS px 是三种单位，不做换算；这里只是沿用同一个数量级 |
| 24×24 CSS px | [WCAG 2.2 SC 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)（AA，含间距例外） | 这是最小值，不是目标；本项目取 44 |
| 48dp | [Android 交互组件最小尺寸](https://developer.android.com/reference/kotlin/androidx/compose/material/minimumInteractiveComponentSize.modifier) | 只适用于原生控件；不要换算成 CSS px 写进 Web 面板 |
| 输入字号 ≥16px | [设计参考](https://github.com/saya-ch/dsh-mobile/blob/main/design-system/dsh-mobile/MASTER.md)（移动外壳已强制）；iOS 在聚焦字号小于 16px 的表单控件时会自动放大页面 | 插件不要把输入框写成更小的固定字号来「塞进」布局 |
| `env(safe-area-inset-*)` | [MDN · env()](https://developer.mozilla.org/en-US/docs/Web/CSS/env) | 需要 `viewport-fit=cover`；只在确实贴边、且外壳未处理的区域追加，避免重复留白 |
| `@container` | [MDN · 容器查询](https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_containment/Container_queries) | 组件按容器宽度排版；主流浏览器自 2023 年起支持，更旧的引擎要保留流式回退 |
| `overscroll-behavior: contain` | [MDN · overscroll-behavior](https://developer.mozilla.org/en-US/docs/Web/CSS/overscroll-behavior) | 阻止滚动链：面板到底时不要把背后的页面带走 |
| `prefers-reduced-motion` | [MDN · prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) | 收起装饰性动画；加载指示可以保留 |

### 关于 44px 的两点常见误用

- **命中区不是视觉尺寸**。圆形勾选框可以保持 24px 视觉，用关联的标签提供完整点击区域；把整张卡片放大不是适配。
- **不要把相邻操作「盖」大**。扩大的命中区不应覆盖邻居，也不应改变换行与焦点顺序；用间距而不是重叠来满足 44px。

## 一份可复制的基线样式

把 `plugin-panel` 换成你自己的根类名；`data-mobile="1"` 只在面板实测宽度进入窄档时启用，宽档不命中这些规则，桌面窄栏也可以启用。开关本身（容器查询或实测宽度）见[适配指南](MOBILE_PLUGIN_ADAPTATION.md#按可用空间适配)。

属性名是插件自己的约定，指南的脚本示例用的是 `data-narrow`；叫什么不重要，重要的是**整档样式只挂在同一个开关上**，并且宽档不出现该值；它表示窄档，不是设备类型。

```css
/* 字号跟随外壳设置；没有该变量时保持继承，不影响桌面。 */
.plugin-panel[data-mobile="1"] { font-size: var(--dsh-content-font-size, inherit); }

/* 给普通动作和文本输入加对应类；不要用于原生开关或范围滑块。这会改变布局尺寸。 */
.plugin-panel[data-mobile="1"] :is(.action, .icon-button, .primary-action, .text-input, select) { min-width: 44px; min-height: 44px; }
.plugin-panel[data-mobile="1"] .icon-button { min-width: 44px; }
.plugin-panel[data-mobile="1"] .primary-action { min-height: 48px; }

/* 使用 <label class="check-label"><input type="checkbox">名称</label>，不覆盖邻近控件。 */
.plugin-panel[data-mobile="1"] .check-label { display: inline-flex; align-items: center; gap: 8px; min-width: 44px; min-height: 44px; padding: 10px; box-sizing: border-box; }
.plugin-panel[data-mobile="1"] .check-label input { width: 24px; height: 24px; margin: 0; }

/* 横向 chip 条改为可横滑；分隔条在横滑行里会挂成孤线。 */
.plugin-panel[data-mobile="1"] .chips { display: flex; flex-wrap: nowrap; gap: 8px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; }
.plugin-panel[data-mobile="1"] .chips::-webkit-scrollbar { display: none; }
.plugin-panel[data-mobile="1"] .chip { flex: 0 0 auto; min-height: 44px; }
.plugin-panel[data-mobile="1"] .chips .divider { display: none; }

/* 行内文字动作收成图标；文字仍留在菜单/详情里，可访问名称不能丢。 */
.plugin-panel[data-mobile="1"] .action-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.plugin-panel[data-mobile="1"] .row-action { min-width: 44px; padding: 0; justify-content: center; }

/* 仅隐藏重复的装饰性快捷键提示，唯一的操作说明应保留。 */
.plugin-panel[data-mobile="1"] .kbd { display: none; }

/* 贴边区域让出安全区；面板自己的滚动容器阻止滚动链。 */
.plugin-panel[data-mobile="1"] .content { padding-bottom: max(28px, calc(14px + env(safe-area-inset-bottom))); }
.plugin-panel[data-mobile="1"] .scroll-body { overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }

/* 表单收成单列，多行输入保留可用高度。 */
.plugin-panel[data-mobile="1"] .form-row { grid-template-columns: minmax(0, 1fr); }
.plugin-panel[data-mobile="1"] textarea { min-height: 96px; }

/* 仅对装饰性、重复文案使用收起规则，不隐藏必要操作说明。 */
.plugin-panel[data-mobile="1"] .title { font-size: 1.2em; line-height: 1.4; }
.plugin-panel[data-mobile="1"] .subtitle { display: none; }

@media (prefers-reduced-motion: reduce) {
  .plugin-panel[data-mobile="1"] .chips { scroll-behavior: auto; }
}
```

## 怎么证明

| 级别 | 证据 | 说明 |
| --- | --- | --- |
| L1 | 390×844 渲染 + 命中区尺寸 | 用实际布局盒量，不要只读 CSS 声明；`min-height` 仍可能被压缩、裁切或遮挡 |
| L2 | 窄容器与宽容器各一张 | 窄容器指 ≤600px 的面板，不是把视口缩小；这正是实测宽度与容器查询要解决的问题 |
| L3 | 结构断言 + 桌面基线 | 断言至少覆盖：窄档标记出现、44px 规则存在、安全区与字号变量存在、窄档规则都挂在同一个开关下、被收起的动作仍有可访问名称；在固定浏览器、字体和尺寸下对比桌面基线，说明预期差异；字符串存在断言不代替几何和交互检查 |

静态检查只能证明相应声明存在。几何和命中需要浏览器验证，以下项目还需真机验证并注明覆盖范围：

- 软键盘弹出后的可视区与焦点滚动；
- 真实的 `env(safe-area-inset-*)` 数值；
- 惯性滚动与回弹手感；
- 系统字号放大后的换行与截断。

## 与既有文档的分工

| 文档 | 回答的问题 |
| --- | --- |
| [适配指南](MOBILE_PLUGIN_ADAPTATION.md) | 怎么做：宿主行为、示例代码、逐项做法、浮层层级 |
| 本文 | 做到什么算过：级别、数字出处、基线样式、验收口径 |
| [设计参考](https://github.com/saya-ch/dsh-mobile/blob/main/design-system/dsh-mobile/MASTER.md) | 本项目自己的视觉与数值口径（颜色、字号、圆角、命中区） |
| [贡献指南](https://github.com/saya-ch/dsh-mobile/blob/main/CONTRIBUTING.md) | 怎么提交、跑哪些检查、兼容请求的边界 |

## 边界

- 只覆盖插件自有的网页面板（浏览器或 WebView）；后台服务型、依赖原生窗口的插件不适用。
- 不要求重做交互，不要求复制一套移动端组件树；详情与列表仍应只有一份实现。
- 不在移动层按类名注入第三方 CSS：类名一变就碎，而且会同时影响桌面。
- 不以 UA 或单纯 `pointer: coarse` 代替实测宽度；混合输入设备（触屏笔记本、带鼠标的平板）会让这两类判断都失真。
