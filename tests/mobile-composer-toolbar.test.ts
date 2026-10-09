import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactElement, ReactNode } from 'react'
const mock = vi.hoisted(() => ({ phone: true }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useSyncExternalStore: () => mock.phone, useEffect: () => {}, useRef: (initial: unknown) => ({ current: initial }), useState: () => [{ start: false, end: false }, () => {}] }
})
import { createElement } from 'react'
import { MobileComposerToolbar, MOBILE_COMPOSER_TOOLBAR_STYLES, type MobileComposerToolbarProps } from '../src/mobile-composer-toolbar.js'

function element(node: ReactNode): ReactElement<Record<string, unknown>> { return node as ReactElement<Record<string, unknown>> }
function children(node: ReactNode): ReactNode[] { const value = element(node).props.children; return Array.isArray(value) ? value as ReactNode[] : [value as ReactNode] }
function props(): MobileComposerToolbarProps {
  return {
    stock: createElement('div', { id: 'stock' }), rowRef: { current: null }, rowClassName: 'core_row',
    leading: createElement('button', { id: 'upload' }), model: createElement('button', { id: 'model' }), actions: createElement('button', { id: 'send', onClick: vi.fn() }),
    pluginsLeft: createElement('div', { id: 'left' }), pluginsRight: createElement('div', { id: 'right' }),
    activity: createElement('button', { id: 'voice' }), activityActive: false,
  }
}

describe('dedicated mobile composer toolbar', () => {
  beforeEach(() => { mock.phone = true })
  it('mounts all plugin nodes in one upper scrollport, with native controls below', () => {
    const p = props(); const output = MobileComposerToolbar(p)
    const [frame, core] = children(output)
    const scroll = children(frame)[0]
    const [left, right, activity] = children(scroll)
    expect(element(scroll).props['data-mobile-plugin-scroll']).toBe(true)
    expect(left).toBe(p.pluginsLeft); expect(right).toBe(p.pluginsRight)
    expect(children(activity)[0]).toBe(p.activity)
    const [leading, trailing] = children(core)
    expect(children(leading)[0]).toBe(p.leading)
    const [model, actions] = children(trailing)
    expect(children(model)[0]).toBe(p.model); expect(children(actions)[0]).toBe(p.actions)
    expect((core as ReactElement & { ref: unknown }).ref).toBe(p.rowRef)
    expect(element(core).props.className).toContain(p.rowClassName)
  })
  it('keeps the recording subtree at the same React path while expanding it', () => {
    const p = props(); const before = MobileComposerToolbar(p); const after = MobileComposerToolbar({ ...p, activityActive: true })
    const frameBefore = children(before)[0]; const frameAfter = children(after)[0]
    expect(element(frameBefore).type).toBe(element(frameAfter).type)
    expect(element(frameAfter).props['data-activity-active']).toBe(true)
    const scrollBefore = children(frameBefore)[0]; const scrollAfter = children(frameAfter)[0]
    expect(element(scrollBefore).type).toBe(element(scrollAfter).type)
    expect(children(children(scrollBefore)[2])[0]).toBe(p.activity)
    expect(children(children(scrollAfter)[2])[0]).toBe(p.activity)
  })
  it('returns the exact original toolbar for a wide dedicated viewport', () => {
    mock.phone = false; const p = props(); expect(MobileComposerToolbar(p)).toBe(p.stock)
  })
  it('reserves the closed shell rail only for a held recorder at tablet widths', () => {
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('@media(min-width:721px) and (max-width:899px)')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('.dshm-shell:has(.dshm-drawer[data-open="false"]) .dshm-composer-plugin-frame[data-activity-active="true"]{box-sizing:border-box;padding-left:56px}')
  })
  it('does not impose toolbar intrinsic widths or compact button sizes on plugin dialogs', () => {
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('[data-slot="conversation.input.right"]>:not(dialog):not([popover]):not([role="dialog"]):not([role="menu"]):not([role="listbox"])')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain(':not(dialog button):not([popover] button):not([role="dialog"] button)')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('[data-slot="conversation.input.right"]>*{flex:0 0 auto;min-width:max-content')
  })
  it('restricts scrolling to the plugin seat and leaves switches at their native size', () => {
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('overflow-x:auto;overflow-y:hidden')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('scrollbar-width:none')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('button[role="switch"]{min-width:0!important;min-height:0!important')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).toContain('[data-activity-active="true"] .dshm-composer-plugin-scroll{overflow:visible')
    expect(MOBILE_COMPOSER_TOOLBAR_STYLES).not.toContain('grid-template-columns:44px 44px')
  })
})
