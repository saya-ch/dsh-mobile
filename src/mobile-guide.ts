/**
 * Instructions handed to the DSH agent when the user runs `/mobile <task>`.
 * The agent edits files under the DSH home; this text is what tells it the
 * layout of the mobile-access customization surface so it does not guess.
 *
 * A snapshot of the current customization state (whether mobile.css /
 * mobile.js exist and which extensions are installed) is injected at the
 * top of the guide so the agent does not overwrite earlier work blindly.
 */

/** One installed extension as seen by the agent. */
export interface MobileGuideExtensionState {
  readonly id: string
  readonly name: string
  readonly version: string
  /** Current local Host execution, omitted for ordinary Cordis-provided extensions. */
  readonly executionMode?: 'in-process' | 'worker'
  /** A stopped Worker needs explicit recovery; editing files is not a recovery action. */
  readonly executionState?: 'ready' | 'unavailable'
}

/** Customization facts collected before steering the agent. */
export interface MobileGuideState {
  /** Absolute path of the mobile-access directory the agent edits. */
  readonly directory: string
  /** True when the user's mobile.css exists (a custom style override). */
  readonly hasCustomCss: boolean
  /** True when the user's mobile.js exists (a custom script override). */
  readonly hasCustomJs: boolean
  /** Extensions currently installed under extensions/. */
  readonly extensions: readonly MobileGuideExtensionState[]
  /** Extensions whose host failed to activate. */
  readonly failedExtensionCount: number
}

/** Compose the guide with the current customization state injected. */
export function buildMobileGuide(state: MobileGuideState): string {
  const styleLine = state.hasCustomCss ? '存在（当前生效的自定义样式）' : '不存在（使用内置默认样式）'
  const scriptLine = state.hasCustomJs ? '存在（当前生效的自定义脚本）' : '不存在（无自定义脚本）'
  const extensionLines = state.extensions.length === 0
    ? '（无）'
    : state.extensions.map(entry => `- ${entry.id}（${entry.name} v${entry.version}）${entry.executionMode === undefined ? '' : ` · ${entry.executionMode}${entry.executionState === 'unavailable' ? ' · 当前不可用，需要显式重启扩展' : ''}`}`).join('\n')
  const failureLine = state.failedExtensionCount > 0
    ? `注意：${state.failedExtensionCount} 个扩展的电脑端 host 激活失败，如改动相关扩展请先检查其 host.mjs 与 extension.json。`
    : ''
  const currentState = `## 手机端当前状态（改动前必读，避免覆盖已有定制）

- 定制目录：${state.directory}（所有改动只允许在这里进行）
- mobile.css：${styleLine}
- mobile.js：${scriptLine}
- 已安装扩展：
${extensionLines}
${failureLine}

“恢复默认”操作说明：当用户要求恢复默认 / 还原初始外观时，删除 mobile.css 与 mobile.js 两个文件（删除后手机端自动回到内置默认外观，无需创建占位文件），并按需删除 extensions/ 下的扩展目录。\n\n`

  return `${currentState}${MOBILE_CUSTOMIZATION_GUIDE_BODY}`
}

/**
 * Static body of the customization guide. Kept separate from the injected
 * state snapshot so the two concerns stay easy to edit independently.
 */
const MOBILE_CUSTOMIZATION_GUIDE_BODY = `你在为用户定制 DSH Mobile 的手机端。DSH Mobile 是一个把电脑上的 DeepSeek Harness 带到手机浏览器的插件，手机端界面和能力都来自本机文件。

所有改动只允许在 $DSH_HOME/mobile-access/ 目录内进行，绝不修改 DeepSeek Harness 的源码或其他目录。$DSH_HOME 是 DeepSeek Harness 的配置目录（通常为 ~/.dsh），先确认它的实际路径再操作。

手机端的能力分两层，按用户需求选择改动目标：

1. 界面与交互 —— 只改外观和交互，不需要碰电脑的文件或程序：
   - $DSH_HOME/mobile-access/mobile.css：手机端样式
   - $DSH_HOME/mobile-access/mobile.js：手机端脚本，用 window.dshMobile.register(({ root }) => { ... }) 把内容挂载到 root，返回清理函数
   - 保存后手机端几秒内自动应用，无需重启

动手前先读已有的定制文件。若要调整 DSH 自带的输入框、侧栏或设置等现有界面，先确认当前 DSH 版本与手机页面模式（专用移动页面或 ?frontend=stock），只读核对运行页面的 DOM、属性和样式；本机有同版本前端源码时可参考相应组件，没有源码时可查看已安装的客户端产物，不必下载源码。优先使用扩展 API、插槽和稳定的 data-* 标记，不凭猜测依赖构建类名。只读查看不改变前述写入范围。

2. 电脑端能力 —— 手机需要读电脑文件、执行命令或访问硬件时，创建扩展：
   - 目录：$DSH_HOME/mobile-access/extensions/<id>/，id 用小写字母数字和连字符（如 media-remote）
   - extension.json：{"schemaVersion":1,"id":"<id>","name":"显示名","version":"0.1.0","description":"说明"}
   - host.mjs：电脑端 Node.js 代码（可信本地代码，可读写文件、执行命令）。导出默认函数 (api) => { ... }，用 api.action('名称', { input, run }) 注册动作、api.route({ method, path, handle }) 注册路由、api.effect(fn) 注册清理。input 可以直接使用 api.schema.object(...) 等 Schemastery schema，也可以传入带 parse(value) 的适配器；两种形式都会在动作执行前校验并规范化输入。
   - 执行方式见上方实际状态。默认 in-process；插件配置可按扩展选择 worker。Worker 中 api.context 只有 logger，不能调用 Cordis 服务；api.manifest、schema、action、route、effect 仍可用。不要把需要 Cordis 的扩展偷偷改成 Worker，也不要在 extension.json 中添加执行模式字段。
   - 动作与路由的执行有时间预算：默认 30 秒（输入校验也计入），可用 api.action('名称', { input, run, timeoutMs }) 或 api.route({ ..., timeoutMs }) 按操作覆盖（1–300000 的整数毫秒）。超时或调用方取消后，调用方收到 500 extension_action_timeout / extension_route_timeout（或取消原因）；这只表示调用方不再等待，底层代码可能仍在运行并已产生副作用，请在 run / handle 中响应 signal 实现协作式取消。路由的预算到 handle() 返回响应为止，不影响已返回流的存活。若某扩展存在调用方已离开（超时或取消）但仍未结束的操作，后续对该扩展的新调用会收到 503 extension_busy，直到该操作真正结束。
   - mobile.js：手机端脚本，用 window.dshMobile.define({ apiVersion:1, id:'<id>', activate(api) { ... } })，activate 返回清理函数
   - mobile.css：手机端样式（可选）
   - assets/：手机端静态资源（可选）
   - mobile.js 里用 api.host.invoke('动作名', 输入) 调 host.mjs 的 action（请求会按 application/json 发送），api.host.fetch('/路由路径') 调 route，api.host.assetUrl('相对路径') 生成与当前版本绑定的资源地址
   - DSH Web 可先用命令生成模板：dsh plugin --profile web exec dsh-mobile extension create <id> --name "<名称>"，再在模板上改；Desktop 请在上方实际定制目录创建文件，不要误改 Web profile

安全约束：
- host.mjs 拥有电脑用户的完整权限，绝不能放入不可信代码，也不要让手机端无条件执行任意命令
- in-process 的同步阻塞会卡住网关事件循环，超时不能打断；Worker 可约束 JavaScript 阻塞，但不是安全沙箱，不约束全部原生内存，也不回滚副作用。两种模式都应响应 signal，避免编写不可取消的同步循环
- Worker 终止后其他未完成调用会失败，已开始的操作不会自动重试。相同内容的停止实例需要操作者在电脑端“移动访问 → 扩展需要重启”中确认恢复；不要通过无意义改文件或自动重放原动作实现恢复
- 所有改动只限 $DSH_HOME/mobile-access/，不要动 DeepSeek Harness 源码

完成前请自检：
- 改动涉及 mobile.js 或扩展的 mobile.js / host.mjs 时，先做语法检查再保存（如 node --check <file>），确保没有语法错误
- 改动 DSH 现有界面后尽可能在实际手机页面核对效果；无法观察运行页面时，明确告诉用户尚未实测
- 创建或修改扩展后，确认 extension.json 的 schemaVersion 为 1、id 与目录名一致、且 id 只含小写字母数字和连字符
- 扩展的 host.mjs 若在完成前无法激活，先修正而不是留下损坏的扩展
- 完成后检查自己实际写入了哪些文件，向用户简要说明改了什么、手机端会有什么变化`
