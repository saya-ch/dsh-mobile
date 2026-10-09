import { describe, expect, it } from 'vitest'
import { buildMobileGuide, type MobileGuideState } from '../src/mobile-guide.js'

function guide(overrides: Partial<MobileGuideState> = {}): string {
  return buildMobileGuide({
    directory: 'C:/dsh/mobile-access',
    hasCustomCss: false,
    hasCustomJs: false,
    extensions: [],
    failedExtensionCount: 0,
    ...overrides,
  })
}

describe('buildMobileGuide', () => {
  it('injects the customization directory', () => {
    expect(guide()).toContain('C:/dsh/mobile-access')
  })

  it('reports present and absent override files distinctly', () => {
    expect(guide({ hasCustomCss: true, hasCustomJs: true })).toContain('mobile.css：存在')
    expect(guide({ hasCustomCss: true, hasCustomJs: true })).toContain('mobile.js：存在')
    const bare = guide()
    expect(bare).toContain('mobile.css：不存在')
    expect(bare).toContain('mobile.js：不存在')
  })

  it('lists installed extensions', () => {
    const text = guide({ extensions: [{ id: 'media-remote', name: '媒体遥控', version: '0.1.0' }] })
    expect(text).toContain('media-remote（媒体遥控 v0.1.0）')
  })

  it('notes when no extension is installed', () => {
    expect(guide()).toContain('已安装扩展：\n（无）')
  })

  it('reports actual execution and recovery status without describing every Host as a Worker', () => {
    const text = guide({ extensions: [
      { id: 'plain', name: 'Plain', version: '1', executionMode: 'in-process', executionState: 'ready' },
      { id: 'isolated', name: 'Worker', version: '1', executionMode: 'worker', executionState: 'unavailable' },
      { id: 'plugin-host', name: 'Plugin', version: '1' },
    ] })
    expect(text).toContain('plain（Plain v1） · in-process')
    expect(text).toContain('isolated（Worker v1） · worker · 当前不可用，需要显式重启扩展')
    expect(text).toContain('plugin-host（Plugin v1）\n')
    expect(text).toContain('Worker 中 api.context 只有 logger')
    expect(text).toContain('Desktop 请在上方实际定制目录创建文件')
    expect(text).toContain('不要通过无意义改文件或自动重放原动作实现恢复')
  })

  it('warns about failed hosts only when present', () => {
    const warned = guide({ failedExtensionCount: 1 })
    expect(warned).toContain('host 激活失败')
    expect(guide()).not.toContain('host 激活失败')
  })

  it('teaches how to restore defaults', () => {
    const text = guide()
    expect(text).toContain('恢复默认')
    expect(text).toContain('删除 mobile.css 与 mobile.js')
  })

  it('uses the running DSH frontend as a read-only reference for existing UI changes', () => {
    const text = guide()
    expect(text).toContain('若要调整 DSH 自带的输入框、侧栏或设置等现有界面')
    expect(text).toContain('专用移动页面或 ?frontend=stock')
    expect(text).toContain('只读核对运行页面的 DOM')
    expect(text).toContain('同版本前端源码')
    expect(text).toContain('没有源码时可查看已安装的客户端产物，不必下载源码')
    expect(text).toContain('只读查看不改变前述写入范围')
    expect(text).toContain('无法观察运行页面时，明确告诉用户尚未实测')
  })

  it('retains the static customization body', () => {
    const text = guide()
    expect(text).toContain('window.dshMobile.register')
    expect(text).toContain('extension.json')
    expect(text).toContain('完成前请自检')
  })
})
