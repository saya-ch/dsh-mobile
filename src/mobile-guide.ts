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
    : state.extensions.map(entry => `- ${entry.id}（${entry.name} v${entry.version}）`).join('\n')
  const failureLine = state.failedExtensionCount > 0
    ? `注意：${state.failedExtensionCount} 个扩展的电脑端 host 激活失败，如改动相关扩展请先检查其 host.mjs 与 extension.json。`
    : ''
  const currentState = `## 手机端当前状态（改名前必读，避免覆盖已有定制）

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

2. 电脑端能力 —— 手机需要读电脑文件、执行命令或访问硬件时，创建扩展：
   - 目录：$DSH_HOME/mobile-access/extensions/<id>/，id 用小写字母数字和连字符（如 media-remote）
   - extension.json：{"schemaVersion":1,"id":"<id>","name":"显示名","version":"0.1.0","description":"说明"}
   - host.mjs：电脑端 Node.js 代码（可信本地代码，可读写文件、执行命令）。导出默认函数 (api) => { ... }，用 api.action('名称', { input, run }) 注册动作、api.route({ method, path, handle }) 注册路由、api.effect(fn) 注册清理
   - mobile.js：手机端脚本，用 window.dshMobile.define({ apiVersion:1, id:'<id>', activate(api) { ... } })，activate 返回清理函数
   - mobile.css：手机端样式（可选）
   - assets/：手机端静态资源（可选）
   - mobile.js 里用 api.host.invoke('动作名', 输入) 调 host.mjs 的 action，api.host.fetch('/路由路径') 调 route，api.host.assetUrl('相对路径') 生成与当前版本绑定的资源地址
   - 也可以先用命令生成模板：dsh plugin --profile web exec dsh-mobile extension create <id> --name "<名称>"，再在模板上改

安全约束：
- host.mjs 拥有电脑用户的完整权限，绝不能放入不可信代码，也不要让手机端无条件执行任意命令
- 所有改动只限 $DSH_HOME/mobile-access/，不要动 DeepSeek Harness 源码

完成前请自检：
- 改动涉及 mobile.js 或扩展的 mobile.js / host.mjs 时，先做语法检查再保存（如 node --check <file>），确保没有语法错误
- 创建或修改扩展后，确认 extension.json 的 schemaVersion 为 1、id 与目录名一致、且 id 只含小写字母数字和连字符
- 扩展的 host.mjs 若在完成前无法激活，先修正而不是留下损坏的扩展
- 完成后检查自己实际写入了哪些文件，向用户简要说明改了什么、手机端会有什么变化`
