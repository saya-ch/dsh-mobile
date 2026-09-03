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

  it('retains the static customization body', () => {
    const text = guide()
    expect(text).toContain('window.dshMobile.register')
    expect(text).toContain('extension.json')
    expect(text).toContain('完成前请自检')
  })
})
