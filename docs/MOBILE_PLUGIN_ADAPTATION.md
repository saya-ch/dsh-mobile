# 移动端插件适配指南

[English](MOBILE_PLUGIN_ADAPTATION.en.md) · [返回文档索引](README.md)

> 验收级别与数字出处见[插件移动端基线](MOBILE_PLUGIN_BASELINE.md)；本文负责做法与示例。

这份指南面向 DSH 插件作者，目标是**小屏可用，桌面功能不回退**。DSH Mobile 提供连接、页面布局和公共入口，不会逐个重排第三方插件的内部控件。可以先用浏览器完成适配，再补充真机验证；没有 Android 设备并不妨碍开始。

## 先确认面板所在位置

| 当前移动页面行为 | 插件应如何处理 |
| --- | --- |
| 打开 `main` 槽中的面板时，布局在面板上方提供「返回会话」栏 | 使用容器实际可用高度；该栏至少 56px，安全区和内容可能增加高度，不要手动从屏幕高度固定减去 56px |
| 窄屏侧栏以抽屉显示，展开宽度不超过 `min(88vw, 340px)`；宽屏可以常驻显示 | 不假设侧栏永远是 340px，入口文字和按钮应能收缩 |
| 移动布局带有 `.dshm-shell` 和 `[data-pane="conversation"]`、`[data-pane="sidebar"]` 标记 | 排障时可用这些标记定位区域；插件内部样式优先作用于自己的根节点，不依赖宿主私有 CSS 类名 |
| 移动外壳为输入框和可编辑区域设置至少 16px 的字体，同时保留更大的继承字号 | 为输入区域预留高度，不用更小的固定字体抵消用户设置 |
| 公共入口的适配不会保证任意第三方控件的可点击区域 | 插件作者仍需检查按钮、关闭键、复选框和菜单的实际命中区域 |

这些是当前布局行为，不是要求插件复制的固定尺寸。浮层、侧栏和主面板的可用空间不同，需在实际挂载位置验证。

## 返回键、全屏浮层与安全区

Android 返回不是浏览器的 `popstate`：App 会先派发可取消的 `dsh-mobile:native-back` 事件，页面里没有任何监听者认领时，App 才执行自己的根行为（退出）。因此：

- 自己全屏展开面板或浮层的插件，必须监听 `dsh-mobile:native-back`，在展开时收起并调用 `preventDefault()`；只监听 DOM 的 Escape 或 `popstate` 不足以接管 Android 返回。
- 不要假设 `env(safe-area-inset-top)` 在 Android WebView 中可用：App 通常已按系统栏内缩 WebView，页面里的 `env()` 经常是 0。`position:fixed; top:0` 的自建宿主会紧贴页面顶部，顶部按钮可能被状态栏或刘海挡住；请把控件放在页面顶部以下，或提供不依赖顶部安全区的收起入口。
- 优先通过公开 slot（`main`、侧栏、右栏或 overlay）渲染。DSH Mobile 会为 `main` 面板提供返回栏，并处理 details/rightbar 的返回；直接 `appendChild(document.body)` 的全屏宿主不会进入移动布局，也不会获得这些行为。
- 持久化展开态时，窄屏应默认收起，或保证收起入口在顶部安全区之外。

## 按可用空间适配

先让基础布局能够收缩：给 flex/grid 子项设置 `min-width: 0`，允许工具栏换行，使用内容驱动的高度。面板宽度不一定等于视口宽度：桌面侧栏中的 400px 面板也需要紧凑布局。

只改变排列时，可用 CSS 容器查询；全屏页面的视口适配仍可使用媒体查询。下面的 `600px` 是示例断点，应按插件内容选择：

```css
.plugin-panel-host { container-type: inline-size; min-width: 0; }
.plugin-panel { min-width: 0; }
.plugin-panel .toolbar { display: flex; flex-wrap: wrap; gap: 8px; }

@container (max-width: 600px) {
  .plugin-panel .toolbar { display: grid; grid-template-columns: minmax(0, 1fr); }
}
```

`.plugin-panel-host` 应包住 `.plugin-panel`。对不支持容器查询的引擎，基础的换行和流式宽度仍应可用，不要把必需操作藏在唯一的查询分支里。

确实需要脚本分支时，可以在组件内部观察根节点宽度，而不是判断手机 UA：

```js
const rootRef = useRef(null)
const [panelWidth, setPanelWidth] = useState(null)
const isNarrow = panelWidth !== null && panelWidth <= 600

useEffect(() => {
  const element = rootRef.current
  if (element === null) return undefined
  const measure = () => setPanelWidth(element.getBoundingClientRect().width)
  measure()
  window.addEventListener('resize', measure)
  const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(measure) : null
  observer?.observe(element)
  return () => {
    window.removeEventListener('resize', measure)
    observer?.disconnect()
  }
}, [])

// 组件返回值中的根节点；初次测量前也应保留可用的基础布局。
h('section', { ref: rootRef, className: 'plugin-panel', 'data-narrow': isNarrow ? 'true' : 'false' }, contents)
```

没有 ResizeObserver 的回退只能在窗口变化时重测；如果面板会独立调整宽度，还需接入插件已有的布局通知。观察器和监听器应随组件卸载清理。

## 适配清单

### 触控目标与间距

本项目建议主要 Web 操作提供至少 **44×44 CSS px** 的命中区域，主操作有空间时可用 48px；这不是 Android dp 或 iOS pt 的换算。相邻操作保留间距，不通过覆盖邻居来扩大点击区。

```css
.plugin-panel :is(button, select, input:not([type="checkbox"]):not([type="radio"])) { min-height: 44px; }
.plugin-panel .icon-button { min-width: 44px; }
.plugin-panel .actions { display: flex; flex-wrap: wrap; gap: 8px; }
.plugin-panel .check-label { box-sizing: border-box; display: inline-flex; align-items: center; gap: 8px; min-width: 44px; min-height: 44px; padding-inline: 8px; }
```

小复选框可放在关联的 `label` 中，扩大标签的可点击区域，不必放大图标。用实际点按和 `elementFromPoint()` 检查边缘命中；声明了 `min-height` 仍可能被布局压缩、裁切或遮挡。

### 筛选条、标签与行内动作

过长的筛选条可以换行，或放入能横向滚动的独立容器；不要让页面整体横向溢出。保留焦点可见性和足够的内边距，使最后一项也能滚入视野：

```css
.plugin-panel .chips { display: flex; gap: 8px; overflow-x: auto; padding: 4px; }
.plugin-panel .chip { flex: 0 0 auto; min-height: 44px; }
```

有明确含义的行内动作可以在窄屏收成图标，但要保留可访问名称，必要时在菜单中保留文字说明。不能靠悬停提示作为手机上唯一的操作说明。

```js
h('button', { className: 'icon-button', 'aria-label': label }, h(Icon, { 'aria-hidden': true, name: 'play' }))
```

窄屏不代表没有键盘。可以收起装饰性的快捷键角标，但保留实际快捷键、帮助入口、Tab 顺序和可见焦点；不要只按宽度移除键盘可用功能。

### 字体、密度与完整信息

继承 DSH 的字体和语义颜色；需要跟随移动页面字号时，可在自己的内容根节点使用 `--dsh-content-font-size`，未提供该变量时保留继承值：

```css
.plugin-panel { font-size: var(--dsh-content-font-size, inherit); line-height: 1.5; }
.plugin-panel .meta { color: var(--dsw-alias-label-secondary, currentColor); }
```

压缩装饰性标题和空白，不压缩触摸目标。长标题允许换行或提供可访问的完整查看入口；错误、待确认内容和关键操作名称不能只剩截断文本。大字号、长路径与中英文内容都要检查。

### 弹层、表单与滚动边界

浮层应受实际容器和可视区约束，避免固定宽高把按钮推到屏幕外。先使用 DSH 的现有浮层组件；自有弹层需保留可达的关闭入口、焦点管理和 Escape 行为。

```css
.plugin-panel .form-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.plugin-panel .scroll-body { min-height: 0; overflow: auto; overscroll-behavior: contain; }
.plugin-panel textarea { box-sizing: border-box; width: 100%; min-height: 96px; }
```

只有确实延伸到屏幕边缘且未被宿主处理的区域才追加 `env(safe-area-inset-*)`，避免重复留白。键盘打开后，保存、取消和错误提示仍应可见或可滚动到达；独立滚动区域不应拖动背后的页面。

### 浮层层级与 portal

专用移动布局通过 `isolation:isolate` 将抽屉和面板限制在外壳自身的层叠上下文。直接挂载到 `document.body`、具有定位和正 `z-index` 的菜单可以显示在外壳上方，无需超过抽屉内部的层级值。原生布局适配器保留既有层级值。

这不代表任意 body 子元素都能覆盖所有对话框。负值、零值／auto 的绘制顺序、祖先的层叠上下文以及浏览器顶层都会影响结果；外壳内部的菜单仍受祖先约束。优先使用宿主已有的浮层能力，所属面板关闭或模态层获得焦点时收起菜单，不要统一抬高第三方组件或修改 DSH 对话框层级。

在窄屏与宽屏下，分别打开抽屉、详情和设置，检查实际可见性、焦点及 `document.elementFromPoint()` 命中。`smoke:plugin-portal-layers` 的受控场景检查正层级 body 菜单和浏览器顶层对话框，不代表所有社区插件均已验收。

## 宿主兜底：触控命中区

主槽打开第三方插件面板时，移动层会做三件兜底的事：

- 粗指针下，面板中的普通按钮、选择框和文本输入控件获得 **44×44 CSS px 的最小布局尺寸**。这会改变控件盒子及其视觉尺寸，不是不可见的命中区扩展；开关、复选框、范围滑块等控件保持自有几何，多行输入由面板自己处理。DSH 内置插件管理页的卡片通过标题按钮打开详情，其覆盖层已拥有整张卡片的命中区，因此这类标题按钮保持紧凑尺寸、不参与最小尺寸兜底；
- 面板根若是 `width:100vw` 或固定像素宽，会被收进可用宽度，不再横向溢出；
- 面板内容区可以滚动并阻止滚动链，不把整个主区也变成第二层滚动容器；插件自己的滚动容器仍是第一选择。

这是**兜底**，不是替插件做适配。插件若自带一套触控几何、不希望被覆盖，在根节点加：

```html
<main data-dsh-adapt="off">…</main>
```

根节点退出时，尺寸和外层滚动覆盖也一起退出；内部控件组也可以使用该属性保留自有控件尺寸。这些规则只在粗指针下生效，不修改细指针页面的布局或滚动。完整适配仍由插件作者按可用空间实现；这不是任意插件组合的兼容保证。

## 验证：代码检查、浏览器与真机分别证明什么

### 结构检查

单测可验证窄屏分支、可访问名称、状态保留和卸载清理。服务端渲染不会执行浏览器布局测量；给测试提供宽度或布局桩，只能证明选中了哪个分支，不能证明真实尺寸、可点击性或桌面像素一致。不要把 CSS 中出现 `44px` 当成触摸验收。

### 真实浏览器检查

将插件挂到实际 DSH 页面后，至少检查 375px、390px 窄屏、横屏、桌面全宽和桌面窄侧栏。若维护静态预览，还要在浏览器中加载它，并明确它与真实宿主的差异。

- 覆盖列表、详情、设置、空状态、长内容和出错状态；
- 检查元素边界、裁切祖先和实际命中，确认首尾操作都能触达；
- 用键盘验证 Tab、Escape、焦点恢复，以及浮层打开时背景不会误操作；
- 改变宽度和字号，确认输入草稿、选择与展开状态保留；
- 检查浅色、深色和桌面基线；截图差异需解释，不要求有意改进也逐像素不变。

例如，在 Playwright 中对已有面板入口执行实际操作后，可检查控件几何和命中；以下选择器应替换为插件自己的稳定标记：

```js
const action = page.locator('[data-plugin-action="save"]')
await action.scrollIntoViewIfNeeded()
const box = await action.boundingBox()
if (box === null || box.width < 44 || box.height < 44) throw new Error('Save target is too small')
const hit = await action.evaluate(element => {
  const box = element.getBoundingClientRect()
  return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
})
if (!hit) throw new Error('Save target is obscured')
```

中心点命中只是起点，不能替代边缘点按、滚动、焦点与状态检查。具体启动和验证流程见[贡献指南](../CONTRIBUTING.md#select-behavior-checks)。

### 真机补充

浏览器模拟不能代替真实 WebView、输入法、安全区、惯性滚动或外接键盘验收。记录设备、App/WebView 版本、连接方式和实际步骤；没有验证的部分直接说明，不宣称已全平台通过。

## 给插件作者的模板

### Issue

```markdown
## 插件与小屏
- 插件名和版本：
- DSH、DSH Mobile 与 App/浏览器版本：
- 面板位置与可用宽度（主面板 / 侧栏 / 浮层）：
- 复现步骤、期望与实际表现：
- 截图及可定位的控件（隐藏凭据和私人内容）：
- 关闭其他可选前端模块后的对照结果（如已测试）：

## 验收目标
- [ ] 必需操作可见、可点，长内容不被截断
- [ ] 触控区域、相邻间距和首尾项经过实际检查
- [ ] 键盘焦点、返回/关闭和草稿状态无回退
- [ ] 弹层与表单在窄屏和大字号下可用
- [ ] 桌面主要流程无回退；注明尚未验证的设备行为
```

### PR

- [ ] 说明受影响入口和内容，不按 UA 硬分手机与桌面；
- [ ] 优先复用组件与状态；确需不同排列时避免复制业务逻辑；
- [ ] 给出真实浏览器的窄屏和桌面对照、操作步骤及相关测试；
- [ ] 检查焦点、命中、长内容、错误和清理，不仅检查 CSS 文本；
- [ ] 说明真机已验证与未验证的范围，不复制其他版本的结果。

## 范围

本指南来自社区插件适配实践与 [#279 讨论](https://github.com/saya-ch/dsh-mobile/discussions/279)，提供可复用的实现与验收思路，不代表这里已独立验证任何第三方插件的新版本。主题细节还可参考[皮肤与移动布局](SKIN_COMPATIBILITY.md)。

DSH Mobile 不按第三方私有类名维护通用覆盖表，也不保证依赖原生窗口的插件能在远程页面直接使用。适配应由拥有该组件的插件维护，并使用 DSH 的公开扩展接口；发现宿主缺失的能力时应单独报告，不修改已安装的 DSH 产物来绕过问题。
