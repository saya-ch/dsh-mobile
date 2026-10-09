import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MOBILE_COMPOSER_TOOLBAR_STYLES } from '../src/mobile-composer-toolbar.js'
import { NATIVE_MOBILE_STYLES } from '../src/native-mobile.js'

describe('stock mobile composer toolbar', () => {
  it('loads its layout through the existing mobile surface instead of an absent parent slot', () => {
    expect(NATIVE_MOBILE_STYLES).toContain(MOBILE_COMPOSER_TOOLBAR_STYLES)
    const layout = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
    expect(layout).not.toContain('conversation.input.toolbar')
    expect(layout).not.toContain('MobileComposerToolbar')
  })

  it('keeps the two stock groups measurable and their children owned by DSH', () => {
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('[data-dsh-mobile-composer-row] { display:flex !important; flex-wrap:wrap !important')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('[data-dsh-mobile-composer-trailing] { display:flex !important; flex:1 0 auto !important; flex-wrap:nowrap !important')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('display:contents')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('order:')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('grid-template')
  })

  it('reserves room for simultaneous primary and Stop actions', () => {
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('> button[class*="_primary"] { min-width:44px !important; flex-shrink:0 !important; }')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('flex:1 0 auto !important; flex-wrap:nowrap')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('min-width:44px !important; max-width:100% !important; gap:6px')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('flex-basis:144px')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('[data-dsh-mobile-composer-model-trigger] { box-sizing:border-box !important; width:100% !important')
  })

  it('does not shrink action targets or override plugin switches', () => {
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('button:not([role="switch"]):not(:where(')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('min-width:44px !important; min-height:44px !important; touch-action:manipulation')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('32px')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('height:32')
  })

  it('leaves menus and dialogs out of intrinsic-width and button rules', () => {
    for (const selector of ['dialog', '[popover]', '[role="dialog"]', '[role="menu"]', '[role="listbox"]', '[data-trigger-menu]']) {
      expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain(selector)
      expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain(`${selector} *`)
    }
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('overflow-x:')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('overflow-y:hidden')
  })

  it('does not guess third-party classes, paint a new surface or hide controls', () => {
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('dshAc')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('codex-quota')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('background:')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('display:none')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('@media (max-width:720px)')
  })
})
