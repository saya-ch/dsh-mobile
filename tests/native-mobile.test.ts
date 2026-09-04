import { describe, expect, it } from 'vitest'
import { applyNativeMobileLanguageMarker, dispatchComposerImageDrop, installNativeMobileSurface, isComposerMediaOriginCurrent, markNativeMobileSettings, NATIVE_MOBILE_STYLES, preflightComposerImageDrop, resolveNativeMobileFrame, resolveNativeMobileLanguage, shouldAutoLoadEarlier } from '../src/native-mobile.js'

interface FakeElementOptions {
  readonly children?: readonly HTMLElement[]
  readonly descendants?: readonly HTMLElement[]
}

function fakeElement(classes: readonly string[], options: FakeElementOptions = {}): HTMLElement {
  const attributes = new Map<string, string>()
  return {
    children: options.children ?? [],
    classList: classes,
    dataset: {},
    querySelectorAll: () => options.descendants ?? [],
    setAttribute: (name: string, value: string) => { attributes.set(name, value) },
    getAttribute: (name: string) => attributes.get(name) ?? null,
  } as unknown as HTMLElement
}

function fakeRoot(elements: readonly HTMLElement[], dialogs: readonly HTMLElement[] = []): ParentNode {
  return {
    querySelectorAll: (selector: string) => selector === '[role="dialog"]' ? dialogs : elements,
  } as unknown as ParentNode
}

describe('native mobile presentation', () => {
  it('keeps touch focus quiet without removing keyboard focus globally', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('-webkit-tap-highlight-color:transparent')
    expect(NATIVE_MOBILE_STYLES).toContain('data-dsh-mobile-input="touch"')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-sidebar] [role="treeitem"] { -webkit-tap-highlight-color:transparent; touch-action:manipulation; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[role="tooltip"] { display:none !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-sidebar] { --dsw-alias-interactive-bg-hover:transparent !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-sidebar] [role="treeitem"]:is(:hover,:active,:focus,[aria-selected="true"])')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_sessionRow"][class*="_selected"],')
    expect(NATIVE_MOBILE_STYLES).toContain('padding-top:max(4px,env(safe-area-inset-top)) !important')
    expect(NATIVE_MOBILE_STYLES).toContain('inset:max(env(safe-area-inset-top),0px) auto 0 0 !important; height:auto !important')
    expect(NATIVE_MOBILE_STYLES).toContain('width:min(88vw,340px) !important; padding-top:0 !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_logoRow"] { height:52px !important; padding:4px 0 4px 4px !important; margin-bottom:4px !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('inset:env(safe-area-inset-top) 0 0; border:0; background:rgb(15 23 42 / 32%)')
    expect(NATIVE_MOBILE_STYLES).toContain('box-sizing:border-box !important; width:50px !important; height:52px !important; padding:4px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-toggle] > svg[class*="_railFish"] { transform:translateY(-4px) !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('min-height:32px !important; height:32px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('min-height:28px !important; height:28px !important; margin-top:0 !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_tab"] { padding-bottom:5px !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('width:max-content !important; max-width:calc(100% - 58px) !important')
    expect(NATIVE_MOBILE_STYLES).toContain('width:calc(100% - 16px) !important; margin:0 8px !important')
    expect(NATIVE_MOBILE_STYLES).not.toContain(':is([data-dsh-mobile-header], header)')
    expect(NATIVE_MOBILE_STYLES).not.toContain('[data-dsh-mobile-toggle] svg { display:none !important; }')
    expect(NATIVE_MOBILE_STYLES).not.toContain('[data-dsh-mobile-toggle]::after')
    expect(NATIVE_MOBILE_STYLES).not.toContain('html.dsh-native-mobile-active :focus { outline:none')
  })

  it('stacks narrow settings and conversation metadata instead of squeezing text', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('data-slot="settings.general.item"')
    expect(NATIVE_MOBILE_STYLES).toContain('flex-direction:column !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-disclosure-row]')
    expect(NATIVE_MOBILE_STYLES).toContain('gap:10px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-message-scroll] { box-sizing:border-box !important; width:100% !important')
    expect(NATIVE_MOBILE_STYLES).toContain('min-height:40px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('line-height:19px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('grid-template-columns:16px minmax(0,1fr)')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-context-fields]')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-composer-card] ~ * [class*="_root"]')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-slot="conversation.composer.dock"] [class*="_root"] { font-size:10px !important; line-height:16px !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('white-space:normal !important; overflow:visible !important')
    expect(NATIVE_MOBILE_STYLES).toContain('margin-bottom:-6px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('.dsh-mobile-media-shortcuts')
    expect(NATIVE_MOBILE_STYLES).toContain('grid-template-columns:repeat(2,minmax(0,1fr))')
    expect(NATIVE_MOBILE_STYLES).toContain('.dsh-mobile-media-action')
    expect(NATIVE_MOBILE_STYLES).toContain('min-height:44px')
    expect(NATIVE_MOBILE_STYLES).toContain('.dsh-mobile-media-action:focus-visible')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-composer-row] { display:grid !important; grid-template-columns:max-content minmax(0,1fr) !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-composer-trailing] { display:flex !important; flex-wrap:nowrap !important; width:100% !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-composer-model] { flex:1 1 0 !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-composer-model-label] { flex:1 1 auto !important; max-width:none !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-history-loader] button:not(:disabled)')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-history-loader] button:disabled')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_rowHead"]:has(> [class*="_rowIdentity"]) { flex-wrap:nowrap !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_rowActions"] { flex:0 0 auto !important; flex-wrap:nowrap !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_rowActions"] button { flex:none !important; width:auto !important; min-width:44px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('white-space:nowrap !important; word-break:keep-all !important; writing-mode:horizontal-tb !important')
  })

  it('keeps unrelated feature frames from suppressing the dedicated mobile layout', () => {
    const unrelatedFrame = fakeElement(['QuestionComposer_a1_frame'], {
      descendants: [fakeElement(['QuestionComposer_a1_body'])],
    })
    const sidebar = fakeElement(['AppFrame_b2_sidebarCol'])
    const center = fakeElement(['AppFrame_b2_centerCol'])
    const stockFrame = fakeElement(['AppFrame_b2_frame'], { descendants: [sidebar, center] })
    const dedicatedCenter = fakeElement(['dshm-main'])
    const root = fakeRoot([unrelatedFrame, stockFrame])

    expect(resolveNativeMobileFrame(root, dedicatedCenter)).toBeUndefined()
    expect(resolveNativeMobileFrame(root, undefined)).toBe(stockFrame)
  })

  it('marks settings dialogs independently from the conversation shell', () => {
    const navList = fakeElement(['SettingsRoot_a1_navList'])
    const nav = fakeElement(['SettingsRoot_a1_nav'], { descendants: [navList] })
    const header = fakeElement(['SettingsRoot_a1_header'])
    const options = fakeElement(['SettingsRoot_a1_options'])
    const content = fakeElement(['SettingsRoot_a1_content'], { descendants: [header, options] })
    const settings = fakeElement(['SettingsRoot_a1_root'], { children: [nav, content] })
    const unrelatedDialog = fakeElement(['QuestionDialog_b2_root'], { children: [fakeElement(['QuestionDialog_b2_body'])] })

    expect(markNativeMobileSettings(fakeRoot([], [unrelatedDialog, settings]))).toBe(1)
    expect(settings.dataset.dshMobileSettings).toBe('true')
    expect(nav.dataset.dshMobileSettingsNav).toBe('true')
    expect(content.dataset.dshMobileSettingsContent).toBe('true')
    expect(navList.getAttribute('data-dsh-mobile-settings-list')).toBe('true')
    expect(header.getAttribute('data-dsh-mobile-settings-header')).toBe('true')
    expect(options.getAttribute('data-dsh-mobile-settings-options')).toBe('true')
  })

  it('uses the DSH semantic text token for the compact log action in both themes', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_sessionLogButton"]::after { color:var(--dsw-alias-label-primary, #171a21)')
    expect(NATIVE_MOBILE_STYLES).not.toContain('color:var(--dsw-text, #171a21)')
  })

  it('preflights the official document DnD contract and drops only when it reports copy', () => {
    const file = new File(['image'], 'image.png', { type: 'image/png' })
    let canCopy = false
    const events: DragEvent[] = []
    const target = {
      dispatchEvent(event: Event): boolean {
        const drag = event as DragEvent
        events.push(drag)
        if (drag.type === 'dragover') {
          drag.preventDefault()
          if (canCopy && drag.dataTransfer !== null) drag.dataTransfer.dropEffect = 'copy'
        }
        return !drag.defaultPrevented
      },
    }

    expect(preflightComposerImageDrop(target, [file])).toBe(false)
    expect(events.at(-1)?.defaultPrevented).toBe(true)
    events.length = 0
    expect(dispatchComposerImageDrop(target, [file])).toBe(false)
    expect(events.map(event => event.type)).toEqual(['dragover'])

    canCopy = true
    expect(preflightComposerImageDrop(target, [file])).toBe(true)
    events.length = 0
    expect(dispatchComposerImageDrop(target, [file])).toBe(true)
    expect(events.map(event => event.type)).toEqual(['dragover', 'drop'])
    expect([...(events[1]?.dataTransfer?.files ?? [])]).toEqual([file])
  })

  it('rejects asynchronous media results after session, composer, or lifecycle changes', () => {
    const composer = {}
    const sessionRoot = {}
    const origin = { generation: 2, href: 'https://dsh.test/session', composer, sessionRoot, sessionId: 'session-a' }
    const current = { ...origin, disposed: false, composerConnected: true }
    expect(isComposerMediaOriginCurrent(origin, current)).toBe(true)
    expect(isComposerMediaOriginCurrent(origin, { ...current, sessionId: 'session-b' })).toBe(false)
    expect(isComposerMediaOriginCurrent(origin, { ...current, composer: {} })).toBe(false)
    expect(isComposerMediaOriginCurrent(origin, { ...current, generation: 3 })).toBe(false)
    expect(isComposerMediaOriginCurrent(origin, { ...current, disposed: true })).toBe(false)
    expect(isComposerMediaOriginCurrent(origin, { ...current, composerConnected: false })).toBe(false)
    expect(isComposerMediaOriginCurrent({ ...origin, sessionRoot: null, sessionId: null }, { ...current, sessionRoot: null, sessionId: null })).toBe(false)
  })

  it('follows the DSH document language before the browser fallback', () => {
    expect(resolveNativeMobileLanguage('it-IT', ['en-US'])).toBe('it')
    expect(resolveNativeMobileLanguage('zh-CN', ['it-IT', 'en-US'])).toBe('zh')
    expect(resolveNativeMobileLanguage('', ['de-DE', 'en-GB'])).toBe('en')
    expect(resolveNativeMobileLanguage('', ['de-DE'])).toBe('en')

    const selected = resolveNativeMobileLanguage('zh-CN', ['en-US'])
    const root = { dataset: {} as DOMStringMap }
    const restore = applyNativeMobileLanguageMarker(root, selected)
    expect(root.dataset.dshMobileLanguage).toBe('zh')
    restore()
    expect(root.dataset.dshMobileLanguage).toBeUndefined()
    expect(NATIVE_MOBILE_STYLES).toContain('html[data-dsh-mobile-language="zh"]')
    expect(NATIVE_MOBILE_STYLES).not.toContain('html:lang(zh)')
  })

  it('places touch-safe media actions at the top of the native command menu', () => {
    const source = installNativeMobileSurface.toString()
    expect(source).toContain('input.addEventListener("change", onChange)')
    expect(source).toContain('input.addEventListener("cancel", cleanup)')
    expect(source).toContain('window.addEventListener("focus", scheduleCleanup)')
    expect(source).toContain('document.addEventListener("visibilitychange", onVisibilityChange)')
    expect(source).toContain('signal.addEventListener("abort", cleanup')
    expect(source).toMatch(/window\.setTimeout\(cleanup, (?:300_000|3e5)\)/u)
    expect(source).toContain('if (cleaned) return')
    expect(source).toContain('commandMenu.prepend(mediaActions)')
    expect(source).toContain('querySelector("[data-trigger-menu]")')
    expect(source).toContain('button[aria-haspopup=\\"listbox\\"][aria-expanded=\\"true\\"]')
    expect(source).toContain('fileButton.addEventListener("pointerdown", quietMediaPointer)')
    expect(source).toContain('cameraButton.addEventListener("pointerdown", quietMediaPointer)')
    expect(source).toContain('active.isContentEditable')
    expect(source).toContain('label("Scegli immagine", "Choose image", "选择图片")')
    expect(source).toContain('label("Scatta foto", "Take photo", "拍照")')
    expect(source).not.toContain('📎')
    expect(source).toContain('"readonly"')
    expect(source).toContain('"aria-busy"')
    expect(source).toContain('"aria-selected"')
    expect(source).toContain('mediaActions.lang = language')
    expect(source).toContain('backdrop.lang = language')
    expect(source).toContain('branchToast.lang = language')
    expect(source).toContain('mediaToast.lang = language')
    expect(source).toContain('dispatchComposerImageDrop(document, files)')
    expect(source).toContain('const attachmentBlocked = !canAcceptComposerDrop()')
    expect(source).toContain('label("Allegati immagine non disponibili", "Image attachments are unavailable", "图片附件不可用")')
    expect(source).not.toContain('AttachmentOwner')
    expect(source).toContain('label("Ramo corrente", "Current branch", "当前分支")')
  })

  it('loads older history only after an upward scroll reaches the top zone', () => {
    expect(shouldAutoLoadEarlier(180, 64)).toBe(true)
    expect(shouldAutoLoadEarlier(65, 64)).toBe(true)
    expect(shouldAutoLoadEarlier(64, 64)).toBe(false)
    expect(shouldAutoLoadEarlier(40, 48)).toBe(false)
    expect(shouldAutoLoadEarlier(180, 80)).toBe(false)
  })

  it('uses bounded motion and disables every added animation for reduced motion', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('--dsh-mobile-motion-duration:200ms')
    expect(NATIVE_MOBILE_STYLES).toContain('@keyframes dsh-mobile-view-in')
    expect(NATIVE_MOBILE_STYLES).toContain('@media (prefers-reduced-motion:reduce)')
    expect(NATIVE_MOBILE_STYLES).not.toContain('dsh-native-mobile-sheet')
  })
})
