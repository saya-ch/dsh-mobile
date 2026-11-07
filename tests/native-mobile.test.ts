import { readFileSync } from 'node:fs'
import { stockOwnsMobileDrawer } from '../src/native-mobile.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeSessionForSoftEnter, applyNativeMobileLanguageMarker, BROWSER_COMPOSER_EDITOR_QUERY, bindBrowserComposerSoftEnter, bindComposerSoftEnter, bindHistoryAutoLoadGate, composerIsLandingHero, createDocumentCompositionGuard, createHeaderStripPanController, createHistoryAutoLoadGate, createSwitchComputerHold, dispatchComposerImageDrop, drawerScrimVisible, HISTORY_INTENT_LISTENER_OPTIONS, HISTORY_SCROLL_QUIET_MS, installNativeMobileSurface, installStockMobileBack, isBrowserTouchEnterLineBreak, isComposerMediaOriginCurrent, isSoftKeyboardEnterLineBreak, markNativeMobileSettings, measureHeaderStripOverflow, mediaActionClassName, nativeAppOwnsComposerEnter, NATIVE_MOBILE_OVERLAY_QUERY, NATIVE_MOBILE_STYLES, NATIVE_MOBILE_TOGGLE_QUERY, preflightComposerImageDrop, resolveBrowserComposerEditor, resolveComposerSessionOrigin, resolveHistoryGateIdentity, resolveNativeMobileFrame, resolveNativeMobileLanguage, shouldAutoLoadEarlier, stockMainPanelOpen, syncHistoryLoaderLabel, SWITCH_COMPUTER_CLICK_SUPPRESSION_MS, SWITCH_COMPUTER_LONG_PRESS_MS, SWITCH_COMPUTER_MOVE_TOLERANCE_PX, SWITCH_COMPUTER_NATIVE_ACTION } from '../src/native-mobile.js'

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
  it('leaves a stock responsive drawer with a public opener under upstream ownership', () => {
    const querySelector = vi.fn().mockReturnValue(null)
    const frame = { querySelector }
    expect(stockOwnsMobileDrawer(undefined)).toBe(false)
    expect(stockOwnsMobileDrawer(frame)).toBe(false)
    querySelector.mockReturnValue({})
    expect(stockOwnsMobileDrawer(frame)).toBe(true)
    expect(querySelector).toHaveBeenLastCalledWith('[data-sidebar-opener]')
  })

  it('keeps a scrollable workspace seat when a narrow drawer has long panel and footer seats', () => {
    const [, overlay] = NATIVE_MOBILE_STYLES.split(`@media ${NATIVE_MOBILE_OVERLAY_QUERY}`)
    expect(overlay).toContain('[data-dsh-mobile-sidebar][data-open="true"]:not(:has([data-dsh-mobile-settings])) [data-dsh-mobile-sidebar-root] { overflow-y:auto !important; overscroll-behavior-y:contain; }')
    expect(overlay).toContain('[data-dsh-mobile-sidebar][data-open="true"]:not(:has([data-dsh-mobile-settings])) [data-dsh-mobile-sidebar-root] > [class*="_regionArea"] { flex:1 0 50% !important; }')
    expect(overlay).not.toContain('min-height:220px')
  })

  it('lets only the marked stock content columns reclaim frame hit testing', () => {
    const [, overlay] = NATIVE_MOBILE_STYLES.split(`@media ${NATIVE_MOBILE_OVERLAY_QUERY}`)
    expect(overlay).toContain('html.dsh-native-mobile-active [data-dsh-mobile-frame] { pointer-events:none !important; }')
    expect(overlay).toContain('[data-dsh-mobile-frame] > :is([data-dsh-mobile-sidebar],[data-dsh-mobile-center],[class*="_rightbarCol"]) { pointer-events:auto !important; }')
    expect(overlay).not.toContain('[data-dsh-mobile-frame] > * { pointer-events:auto')
    expect(overlay).not.toContain('[class*="_overlayLayer"] { pointer-events:auto')
  })

  it('raises public floating surfaces above narrow drawers without intercepting empty space', () => {
    const [, overlay] = NATIVE_MOBILE_STYLES.split(`@media ${NATIVE_MOBILE_OVERLAY_QUERY}`)
    expect(overlay).toContain('html.dsh-native-mobile-active [data-shell-overlay] { z-index:300 !important; pointer-events:none !important; }')
    expect(overlay).not.toContain('[data-shell-overlay] > * { pointer-events:auto')
  })

  it('styles the injected attachment actions on every viewport, not only the narrow overlay', () => {
    const shared = NATIVE_MOBILE_STYLES.slice(0, NATIVE_MOBILE_STYLES.indexOf('@media'))
    expect(shared).toContain('.dsh-mobile-media-action { box-sizing:border-box; display:flex;')
    expect(shared).toContain('.dsh-mobile-media-action:disabled { cursor:default; opacity:.38; }')
    const [, overlay] = NATIVE_MOBILE_STYLES.split(`@media ${NATIVE_MOBILE_OVERLAY_QUERY}`)
    expect(overlay).not.toContain('.dsh-mobile-media-action {')
  })

  it('keeps the plugin fallback class when the stock Add item has no class of its own', () => {
    // An empty className is not nullish. Trusting it left the injected action
    // with no class at all, so it rendered as a bordered, centred UA button.
    expect(mediaActionClassName(undefined)).toBe('dsh-mobile-media-action')
    expect(mediaActionClassName({ className: '' })).toBe('dsh-mobile-media-action')
    expect(mediaActionClassName({ className: '   ' })).toBe('dsh-mobile-media-action')
    // A stock item that does carry classes still wins, so the action follows
    // the native menu's own spacing, colours and dark-mode states.
    expect(mediaActionClassName({ className: 'VOzbGW_item VOzbGW_camera' })).toBe('VOzbGW_item VOzbGW_camera')
    expect(mediaActionClassName({ className: '  VOzbGW_item  ' })).toBe('VOzbGW_item')
  })

  it('reserves the full settings close target inside its padded header', () => {
    const shared = NATIVE_MOBILE_STYLES.slice(0, NATIVE_MOBILE_STYLES.indexOf('@media'))
    expect(shared).toContain('html.dsh-native-mobile-active [data-dsh-mobile-settings-header] { box-sizing:border-box !important; height:56px !important; min-height:56px !important; padding:4px 12px !important; }')
    expect(shared).toContain('html.dsh-native-mobile-active [data-dsh-mobile-settings-header] [class*="_close"] { box-sizing:border-box !important; flex:none !important; width:48px !important; min-width:48px !important; height:48px !important; min-height:48px !important; }')
  })

  it('collapses the unfocused viewport and retains stock touch actions', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('[data-composer-card]:not(:focus-within) > [data-input-scroll] { max-height:72px !important; overflow-y:auto !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-composer-row] button:not([role="switch"]):not(:where(')
    expect(NATIVE_MOBILE_STYLES).toContain('min-width:44px !important; min-height:44px !important; touch-action:manipulation; }')
    expect(NATIVE_MOBILE_STYLES).toContain('> button[class*="_primary"] { min-width:44px !important; flex-shrink:0 !important; }')
    expect(NATIVE_MOBILE_STYLES).not.toContain('[data-dsh-mobile-composer-row] button { min-width:44px')
  })

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
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-sidebar]:has([data-dsh-mobile-settings]) { width:100vw !important; inset:0 !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-sidebar]:has([data-dsh-mobile-settings]) > * { width:100vw !important; overflow:visible !important; }')
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

  it('hides the passive pinned marker while keeping mobile sidebar actions visible', () => {
    const [, overlay] = NATIVE_MOBILE_STYLES.split(`@media ${NATIVE_MOBILE_OVERLAY_QUERY}`)
    expect(overlay).toContain('html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_sessionRow"] [class*="_pinIndicator"] { display:none !important; }')
    expect(overlay).toContain('[class*="_rowActions"] { display:inline-flex !important;')
  })

  it('uses a minimum editable font on narrow and wide native surfaces', () => {
    // The html-level class exists on every non-desktop mobile page, so it also
    // covers body-level portals (model picker search) the center column never
    // contained.
    expect(NATIVE_MOBILE_STYLES).toContain(
      'html.dsh-native-mobile-active :is(input,textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[contenteditable=""])',
    )
    // The center marker scope survives a disposed surface, which removes the
    // html class while its applied style string can outlive it.
    expect(NATIVE_MOBILE_STYLES).toContain(
      ' [data-dsh-mobile-center] :is(input,textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[contenteditable=""]) { font-size:max(16px,1em,var(--dsh-content-font-size,1em)) !important; }',
    )
    expect(NATIVE_MOBILE_STYLES).not.toContain('[data-dsh-mobile-center] textarea { font-size:16px !important; }')
  })

  it('keeps the drawer scrim invisible wherever the overlay query stops matching', () => {
    // The surface appends the scrim on every non-loopback page load, but every
    // rule that gives it a box lives inside the overlay query. Outside that
    // query the element fell back to the UA button box: an empty, nameless
    // button in normal flow at the document's bottom-left, whose click still
    // collapsed the sidebar.
    const [neutral] = NATIVE_MOBILE_STYLES.split(`@media ${NATIVE_MOBILE_OVERLAY_QUERY}`)
    expect(neutral).toContain('.dsh-native-mobile-backdrop,.dsh-mobile-branch-toast,.dsh-mobile-media-toast { display:none; }')
    expect(NATIVE_MOBILE_STYLES).toContain('.dsh-native-mobile-backdrop { display:block; position:fixed; z-index:235;')
    expect(NATIVE_MOBILE_STYLES).toContain('.dsh-mobile-branch-toast,.dsh-mobile-media-toast { display:block; position:fixed;')
    expect(NATIVE_MOBILE_STYLES).toContain('.dsh-native-mobile-backdrop[hidden] { display:none; }')
  })

  it('shows the drawer scrim only while the overlay drawer is open', () => {
    expect(drawerScrimVisible(false, true)).toBe(true)
    expect(drawerScrimVisible(true, true)).toBe(false)
    expect(drawerScrimVisible(false, false)).toBe(false)
    expect(drawerScrimVisible(true, false)).toBe(false)
  })

  it('tracks the overlay breakpoint while the surface is mounted', () => {
    const source = installNativeMobileSurface.toString()
    expect(source).toContain('window.matchMedia(NATIVE_MOBILE_OVERLAY_QUERY)')
    expect(source).toContain('drawerScrimVisible(')
    expect(source).toMatch(/backdrop\.hidden = frame === (?:undefined|void 0) \|\|/)
    expect(source).toMatch(/if \(frame !== (?:undefined|void 0)\) sidebar\.dataset\.open/)
    expect(source).toContain('overlayQuery.addEventListener("change", schedule)')
    expect(source).toContain('overlayQuery.removeEventListener("change", schedule)')
    expect(source).toContain('disposed = true')
    expect(source).toContain('completionFallback: false')
  })

  it('returns from stock details, narrow drawer, and selected main panel in order', () => {
    const view = new EventTarget()
    const layers = { detailsOpen: true, drawerOpen: true, mainPanelOpen: true }
    const closeDetails = vi.fn(() => { layers.detailsOpen = false })
    const closeDrawer = vi.fn(() => { layers.drawerOpen = false })
    const closeMainPanel = vi.fn(() => { layers.mainPanelOpen = false })
    const stop = installStockMobileBack(view as never, () => layers, { closeDetails, closeDrawer, closeMainPanel })
    const back = (): Event => {
      const event = new Event('dsh-mobile:native-back', { cancelable: true })
      view.dispatchEvent(event)
      return event
    }

    expect(back().defaultPrevented).toBe(true)
    expect(closeDetails).toHaveBeenCalledOnce()
    expect(closeDrawer).not.toHaveBeenCalled()
    expect(back().defaultPrevented).toBe(true)
    expect(closeDrawer).toHaveBeenCalledOnce()
    expect(closeMainPanel).not.toHaveBeenCalled()
    expect(back().defaultPrevented).toBe(true)
    expect(closeMainPanel).toHaveBeenCalledOnce()
    expect(back().defaultPrevented).toBe(false)
    stop()
  })

  it('does not claim noncancelable, already claimed, absent-stock, or disposed Back requests', () => {
    const view = new EventTarget()
    const closeDetails = vi.fn()
    const closeDrawer = vi.fn()
    const closeMainPanel = vi.fn()
    let stock = true
    const stop = installStockMobileBack(view as never,
      () => stock ? { detailsOpen: true, drawerOpen: true, mainPanelOpen: true } : null,
      { closeDetails, closeDrawer, closeMainPanel })
    const noncancelable = new Event('dsh-mobile:native-back')
    view.dispatchEvent(noncancelable)
    const claimed = new Event('dsh-mobile:native-back', { cancelable: true })
    claimed.preventDefault()
    view.dispatchEvent(claimed)
    stock = false
    const absent = new Event('dsh-mobile:native-back', { cancelable: true })
    view.dispatchEvent(absent)
    stock = true
    stop()
    const disposed = new Event('dsh-mobile:native-back', { cancelable: true })
    view.dispatchEvent(disposed)
    expect(absent.defaultPrevented).toBe(false)
    expect(disposed.defaultPrevented).toBe(false)
    expect(closeDetails).not.toHaveBeenCalled()
    expect(closeDrawer).not.toHaveBeenCalled()
    expect(closeMainPanel).not.toHaveBeenCalled()
  })

  it('reads a selected stock panel only through available layout features', () => {
    expect(stockMainPanelOpen(undefined)).toBe(false)
    expect(stockMainPanelOpen({})).toBe(false)
    expect(stockMainPanelOpen({ selectPanel() {}, panelInfo: {} })).toBe(false)
    let activePanelId: string | null = null
    const panelInfo = { getSnapshot: () => ({ activePanelId }) }
    const layout = { selectPanel: vi.fn(), panelInfo }
    expect(stockMainPanelOpen(layout)).toBe(false)
    activePanelId = 'plugins'
    expect(stockMainPanelOpen(layout)).toBe(true)
  })

  it('stacks narrow settings and conversation metadata instead of squeezing text', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('data-slot="settings.general.item"')
    expect(NATIVE_MOBILE_STYLES).toContain('flex-direction:column !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-disclosure-row]')
    expect(NATIVE_MOBILE_STYLES).toContain('gap:0 !important; --dsh-chat-flow-gap:10px;')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-message-scroll] { box-sizing:border-box !important; width:100% !important')
    expect(NATIVE_MOBILE_STYLES).toContain('min-height:40px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('line-height:19px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('grid-template-columns:16px minmax(0,1fr)')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-context-fields]')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-composer-card] ~ * [class*="_root"]')
    // The dock and hint rows pin small !important font sizes at (0,3,0),
    // beating the 16px editable floor's (0,2,1); editables landing in those
    // slots must stay exempt so Safari cannot zoom them.
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-center] [data-composer-card] ~ * [class*="_root"]:not(:where(input,textarea,[contenteditable])) {')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-slot="conversation.composer.dock"] [class*="_root"]:not(:where(input,textarea,[contenteditable])) { font-size:10px !important; line-height:16px !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_root"]:has(> [class*="_trigger"][aria-haspopup="dialog"]) { width:auto !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_dock"]:has([data-composer-stats]) { display:flex !important; flex-wrap:wrap !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_root"][data-composer-stats] { box-sizing:border-box !important; width:auto !important')
    expect(NATIVE_MOBILE_STYLES).toContain('white-space:normal !important; overflow:visible !important')
    expect(NATIVE_MOBILE_STYLES).toContain('margin-bottom:-6px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('.dsh-mobile-media-action')
    expect(NATIVE_MOBILE_STYLES).toContain('background:transparent')
    expect(NATIVE_MOBILE_STYLES).toContain('.dsh-mobile-media-action:focus-visible')
    expect(NATIVE_MOBILE_STYLES).toContain('.dsh-mobile-settings_row')
    expect(NATIVE_MOBILE_STYLES).toContain('.dsh-mobile-settings_selector')
    expect(NATIVE_MOBILE_STYLES).toContain('.dsh-mobile-settings_selector:focus-visible')
    expect(NATIVE_MOBILE_STYLES).toContain('min-height:48px !important')
    expect(NATIVE_MOBILE_STYLES).not.toContain('grid-template-columns:44px 44px')
    expect(NATIVE_MOBILE_STYLES).not.toContain('grid-column:4 / 6')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-composer-row] { display:flex !important; flex-wrap:wrap !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-composer-trailing] { display:flex !important; flex:1 0 auto !important; flex-wrap:nowrap !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-composer-model-label] { flex:1 1 auto !important; max-width:none !important; min-width:0 !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-history-loader] button { min-width:48px !important; touch-action:manipulation; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_rowHead"]:has(> [class*="_rowIdentity"]) { flex-wrap:nowrap !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_rowActions"] { flex:0 0 auto !important; flex-wrap:nowrap !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_rowActions"] button { flex:none !important; width:auto !important; min-width:44px !important')
    expect(NATIVE_MOBILE_STYLES).toContain('white-space:nowrap !important; word-break:keep-all !important; writing-mode:horizontal-tb !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-variant="think"]) { margin-bottom:12px !important; }')
  })

  it('reserves idle label space without hiding the native history button or clipping larger text', () => {
    const loaderStyles = NATIVE_MOBILE_STYLES.substring(NATIVE_MOBILE_STYLES.indexOf('[data-dsh-mobile-history-loader] {'))
      .split("/* DSH's sibling margins", 1)[0]
    expect(loaderStyles).toContain('display:grid !important')
    expect(loaderStyles).toContain('flex:0 0 auto !important; min-height:48px !important')
    expect(loaderStyles).toContain('grid-area:1/1 !important; min-height:48px !important; max-width:100% !important')
    expect(loaderStyles).toContain('font:inherit !important; white-space:normal !important; overflow-wrap:anywhere')
    expect(loaderStyles).toContain('content:attr(data-dsh-mobile-history-label); visibility:hidden; pointer-events:none')
    expect(loaderStyles).not.toContain('height:28px')
    expect(loaderStyles).not.toContain('height:1px')
    expect(loaderStyles).not.toContain('clip-path')
    expect(loaderStyles).not.toContain('overflow:hidden')
    expect(loaderStyles).not.toContain('button:not(:disabled)')
    expect(loaderStyles).not.toContain('button:disabled')
  })

  it('caps only the draft scrollport when the narrow focused viewport is short', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('@media (max-width:720px) and (max-height:500px)')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-center] [data-composer-card] > [data-input-scroll] { max-height:72px !important; overflow-y:auto !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('@media (max-width:720px) and (max-height:400px)')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-center] [data-composer-card] { gap:8px !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-center] [data-composer-card] > [data-input-scroll] { max-height:48px !important; }')
    expect(NATIVE_MOBILE_STYLES).not.toContain('[data-dsh-mobile-composer-row] { display:grid')
  })

  it('spaces the message column through the shared flow gap so folded seats cost nothing', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-message-column] { box-sizing:border-box !important; width:100% !important; max-width:none !important; margin:0 !important; padding:0 !important; gap:0 !important; --dsh-chat-flow-gap:10px; }')
    expect(NATIVE_MOBILE_STYLES).not.toContain('margin:0 !important; padding:0 !important; gap:10px !important; }')
  })

  it('wraps the composer dock instead of assuming a fixed column count', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_dock"]:has([data-composer-stats]) { display:flex !important; flex-wrap:wrap !important; justify-content:flex-start !important; align-items:center !important')
    expect(NATIVE_MOBILE_STYLES).not.toContain('grid-template-columns:minmax(0,1fr) max-content !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-slot="conversation.composer.dock"] > :not([data-composer-stats]) { flex:0 1 100% !important; min-width:0 !important; max-width:100% !important; }')
  })

  it('keeps the context ring on the statistics row however many dock entries exist', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_dock"]:has([data-composer-stats]) [data-composer-stats] { order:-2 !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_dock"]:has([data-composer-stats]) > [class*="_root"]:has(> [class*="_trigger"][aria-haspopup="dialog"]) { order:-1 !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[class*="_dock"]:has([data-composer-stats]) [data-slot="conversation.composer.dock"] > * { margin-bottom:0 !important; }')
  })

  it('keeps interactive statistics compact while static statistics can wrap', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('flex:1 1 0 !important; flex-wrap:nowrap !important; justify-content:flex-start !important; overflow:hidden !important')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-center] [data-composer-stats] [class*="_pill"] { display:block !important; min-width:0 !important; white-space:nowrap !important; overflow:hidden !important; text-overflow:ellipsis !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-center] [data-composer-stats] [class*="_pill"] svg { display:inline-block !important; vertical-align:-2px !important; margin-right:6px !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-composer-stats]:has(span[class*="_pill"]) { flex-wrap:wrap !important; overflow:visible !important; }')
    expect(NATIVE_MOBILE_STYLES).toContain('span[class*="_pill"] { flex:0 1 auto !important; max-width:100% !important; white-space:normal !important; overflow:visible !important; overflow-wrap:anywhere !important; text-overflow:clip !important; }')
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

  it('keeps the four-seat upstream settings grid while marking its close header', () => {
    const title = fakeElement(['SettingsRoot_a1_navTitle'])
    const nav = fakeElement(['SettingsRoot_a1_nav'])
    const header = fakeElement(['SettingsRoot_a1_header'])
    const options = fakeElement(['SettingsRoot_a1_options'])
    const settings = fakeElement(['SettingsRoot_a1_panel'], { children: [title, nav, header, options] })
    settings.setAttribute('data-shortcut-modal', 'settings')
    const unrelated = fakeElement(['OtherPanel_b2_panel'], { children: ['_navTitle', '_nav', '_header', '_options']
      .map(suffix => fakeElement([`OtherPanel_b2${suffix}`])) })

    expect(markNativeMobileSettings(fakeRoot([], [unrelated, settings]))).toBe(1)
    expect(settings.dataset.dshMobileSettings).toBe('grid')
    expect(unrelated.dataset.dshMobileSettings).toBeUndefined()
    expect(header.getAttribute('data-dsh-mobile-settings-header')).toBe('true')
    expect(nav.dataset.dshMobileSettingsNav).toBeUndefined()
    expect(options.getAttribute('data-dsh-mobile-settings-options')).toBeNull()
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-settings="true"] { flex-direction:column')
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
    const transfer = events[1]?.dataTransfer
    expect(transfer?.files.item(0)).toBe(file)
    expect(transfer?.files.item(999)).toBeNull()
    expect([...transfer?.items ?? []].map(item => ({ kind: item.kind, type: item.type, file: item.getAsFile(), directory: item.webkitGetAsEntry() })))
      .toEqual([{ kind: 'file', type: 'image/png', file, directory: null }])
  })

  it('supplies iterable file items to a directory-aware DSH drop consumer', () => {
    const file = new File(['image'], 'image.png', { type: 'image/png' })
    const delivered: File[] = []
    const target = {
      dispatchEvent(event: Event): boolean {
        const drag = event as DragEvent
        if (drag.type === 'dragover' && drag.dataTransfer !== null) drag.dataTransfer.dropEffect = 'copy'
        if (drag.type === 'drop' && drag.dataTransfer !== null) {
          for (const item of drag.dataTransfer.items) {
            if (item.kind === 'file' && item.webkitGetAsEntry() === null) {
              const selected = item.getAsFile()
              if (selected !== null) delivered.push(selected)
            }
          }
        }
        return true
      },
    }
    expect(dispatchComposerImageDrop(target, [file])).toBe(true)
    expect(delivered).toEqual([file])
  })

  it('falls back to the complete file payload when exposed browser constructors fail', () => {
    vi.stubGlobal('DataTransfer', class { constructor() { throw new Error('unsupported transfer constructor') } })
    vi.stubGlobal('DragEvent', class { constructor() { throw new Error('unsupported drag constructor') } })
    try {
      const file = new File(['image'], 'image.png', { type: 'image/png' })
      const seen: File[][] = []
      const target = { dispatchEvent: (event: Event) => {
        const transfer = (event as DragEvent).dataTransfer
        if (event.type === 'dragover' && transfer !== null) transfer.dropEffect = 'copy'
        if (event.type === 'drop' && transfer !== null) seen.push([...transfer.files])
        return true
      } }
      expect(dispatchComposerImageDrop(target, [file])).toBe(true)
      expect(seen).toEqual([[file]])
    } finally { vi.unstubAllGlobals() }
  })

  it('keeps a successful preflight separate from an attachment acknowledgement', () => {
    const file = new File(['image'], 'image.png', { type: 'image/png' })
    const target = { dispatchEvent(event: Event): boolean {
      const drag = event as DragEvent
      if (event.type === 'dragover' && drag.dataTransfer !== null) drag.dataTransfer.dropEffect = 'copy'
      return true
    } }
    expect(dispatchComposerImageDrop(target, [file])).toBe(true)
  })

  it('rejects nominal native transfers that refuse items even if their file count appears populated', () => {
    const file = new File(['image'], 'image.png', { type: 'image/png' })
    vi.stubGlobal('DataTransfer', class { files = [file]; items = { add: () => null } })
    try {
      const received: File[] = []
      const target = { dispatchEvent(event: Event): boolean {
        const transfer = (event as DragEvent).dataTransfer
        if (event.type === 'dragover' && transfer !== null) transfer.dropEffect = 'copy'
        if (event.type === 'drop' && transfer !== null) for (const item of transfer.items) {
          const selected = item.getAsFile()
          if (selected !== null) received.push(selected)
        }
        return true
      } }
      expect(dispatchComposerImageDrop(target, [file])).toBe(true)
      expect(received).toEqual([file])
    } finally { vi.unstubAllGlobals() }
  })

  it('falls back when DragEvent ignores its transfer rather than delivering a null payload', () => {
    vi.stubGlobal('DragEvent', class extends Event { readonly dataTransfer = null })
    try {
      const file = new File(['image'], 'image.png', { type: 'image/png' })
      const received: File[] = []
      const target = { dispatchEvent(event: Event): boolean {
        const transfer = (event as DragEvent).dataTransfer
        if (event.type === 'dragover' && transfer !== null) transfer.dropEffect = 'copy'
        if (event.type === 'drop' && transfer !== null) received.push(...transfer.files)
        return true
      } }
      expect(dispatchComposerImageDrop(target, [file])).toBe(true)
      expect(received).toEqual([file])
    } finally { vi.unstubAllGlobals() }
  })

  it('falls back when a native item constructor does not populate its FileList', () => {
    const file = new File(['image'], 'image.png', { type: 'image/png' })
    vi.stubGlobal('DataTransfer', class { files: File[] = []; items = { add: () => ({ kind: 'file', getAsFile: () => file }) } })
    try {
      let length = 0
      const target = { dispatchEvent(event: Event): boolean {
        const transfer = (event as DragEvent).dataTransfer
        if (event.type === 'dragover' && transfer !== null) transfer.dropEffect = 'copy'
        if (event.type === 'drop' && transfer !== null) length = transfer.files.length
        return true
      } }
      expect(dispatchComposerImageDrop(target, [file])).toBe(true)
      expect(length).toBe(1)
    } finally { vi.unstubAllGlobals() }
  })

  it('falls back when native transfer controls ignore writes despite accepting file items', () => {
    const file = new File(['image'], 'image.png', { type: 'image/png' })
    for (const locked of ['effectAllowed', 'dropEffect']) {
      vi.stubGlobal('DataTransfer', class {
        files: File[] = []
        items = { add: (selected: File) => { this.files.push(selected); return { kind: 'file', getAsFile: () => selected } } }
        private effect = 'none'
        private drop = 'none'
        get effectAllowed(): string { return this.effect }
        set effectAllowed(value: string) { if (locked !== 'effectAllowed') this.effect = value }
        get dropEffect(): string { return this.drop }
        set dropEffect(value: string) { if (locked !== 'dropEffect') this.drop = value }
      })
      try {
        const received: File[] = []
        const target = { dispatchEvent(event: Event): boolean {
          const transfer = (event as DragEvent).dataTransfer
          if (event.type === 'dragover' && transfer !== null) transfer.dropEffect = 'copy'
          if (event.type === 'drop' && transfer !== null) for (const item of transfer.items) {
            const selected = item.getAsFile()
            if (selected !== null) received.push(selected)
          }
          return true
        } }
        expect(preflightComposerImageDrop(target, [file]), locked).toBe(true)
        expect(dispatchComposerImageDrop(target, [file]), locked).toBe(true)
        expect(received, locked).toEqual([file])
      } finally { vi.unstubAllGlobals() }
    }
  })

  it('rejects asynchronous media results after session, composer, or lifecycle changes', () => {
    const composer = {}
    const sessionRoot = {}
    const origin = { generation: 2, href: 'https://dsh.test/session', composer, sessionRoot, sessionId: 'session-a' }
    const current = { ...origin, disposed: false, composerConnected: true }
    expect(isComposerMediaOriginCurrent(origin, current)).toBe(true)
    expect(isComposerMediaOriginCurrent(origin, { ...current, sessionId: 'session-b' })).toBe(false)
    expect(isComposerMediaOriginCurrent(origin, { ...current, href: 'https://dsh.test/other' })).toBe(false)
    expect(isComposerMediaOriginCurrent(origin, { ...current, sessionRoot: {} })).toBe(false)
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

  it('places camera and dedicated-page Gallery in the native Add section using the shared chooser', () => {
    const source = installNativeMobileSurface.toString()
    expect(source).toContain('pickBrowserFiles')
    expect(source).toContain('signal: mediaPickerAbortController.signal')
    expect(source).not.toContain('scheduleCleanup')
    expect(source).not.toContain('browserPickerCleanups')
    expect(source).toContain('placeCameraAction(commandMenu)')
    expect(source).toContain('querySelector("[data-trigger-menu]")')
    expect(source).toContain('button[aria-haspopup=\\"listbox\\"][aria-expanded=\\"true\\"]')
    expect(source).toContain('cameraButton.addEventListener("pointerdown", quietMediaPointer)')
    expect(source).toContain('active.isContentEditable')
    expect(source).toContain('label("Scatta foto", "Take photo", "拍照")')
    expect(source).toContain('button.setAttribute("role", "option")')
    expect(source).toContain('mediaActionClassName(nativeItem)')
    expect(source).toContain('label("Galleria", "Gallery", "相册")')
    expect(source).toContain('multiple: true')
    expect(source).toContain('galleryButton.addEventListener("click", chooseGallery)')
    expect(source).toContain('galleryButton.removeEventListener("click", chooseGallery)')
    expect(source).toContain('galleryBusy')
    expect(source).toContain('sectionTitle.nextElementSibling')
    expect(source).not.toContain('fileButton')
    expect(source).not.toContain('chooseImage')
    expect(source).not.toContain('files.pick')
    expect(source).not.toContain('commandMenu.prepend')
    expect(source).not.toContain('📎')
    expect(source).toContain('"readonly"')
    expect(source).toContain('"aria-busy"')
    expect(source).toContain('"aria-selected"')
    expect(source).toContain('backdrop.lang = language')
    expect(source).toContain('branchToast.lang = language')
    expect(source).toContain('mediaToast.lang = language')
    expect(source).toContain('dispatchComposerImageDrop(document, files)')
    expect(source).toContain('if (!dispatchComposerImageDrop(document, files))')
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

class TestKeyboardEvent extends Event {
  readonly key: string
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly isComposing: boolean
  readonly keyCode: number
  readonly repeat: boolean
  private readonly altGraph: boolean
  constructor(type: string, init: KeyboardEventInit & { trusted?: boolean; altGraph?: boolean; keyCode?: number } = {}) {
    super(type, init)
    this.key = init.key ?? ''
    this.shiftKey = init.shiftKey ?? false
    this.altKey = init.altKey ?? false
    this.ctrlKey = init.ctrlKey ?? false
    this.metaKey = init.metaKey ?? false
    this.isComposing = init.isComposing ?? false
    this.keyCode = init.keyCode ?? 13
    this.repeat = init.repeat ?? false
    this.altGraph = init.altGraph ?? false
    if (init.trusted === true) Object.defineProperty(this, 'isTrusted', { value: true })
  }
  getModifierState(name: string): boolean { return name === 'AltGraph' && this.altGraph }
}

function fakeComposerEditor(): { editor: HTMLElement; attributes: Map<string, string> } {
  const attributes = new Map([['contenteditable', 'true']])
  const editor = Object.assign(new EventTarget(), {
    isConnected: true,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    hasAttribute: (name: string) => attributes.has(name),
  }) as unknown as HTMLElement
  return { editor, attributes }
}

const eligibleContext = () => ({
  nativeState: { imeVisible: true, noHardwareKeyboard: true },
  editable: true,
  activeSession: true,
  commandMenuOpen: false,
  recentlyComposing: false,
})

describe('composer soft-keyboard Enter', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('requires an exact native soft-keyboard signal and a live, unobstructed session editor', () => {
    const event = new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true }) as unknown as KeyboardEvent
    expect(isSoftKeyboardEnterLineBreak(event, eligibleContext())).toBe(true)
    const context = eligibleContext()
    expect(isSoftKeyboardEnterLineBreak(event, { ...context, nativeState: null })).toBe(false)
    expect(isSoftKeyboardEnterLineBreak(event, { ...context, nativeState: { imeVisible: false, noHardwareKeyboard: true } })).toBe(false)
    expect(isSoftKeyboardEnterLineBreak(event, { ...context, nativeState: { imeVisible: true, noHardwareKeyboard: false } })).toBe(false)
    expect(isSoftKeyboardEnterLineBreak(event, { ...context, editable: false })).toBe(false)
    expect(isSoftKeyboardEnterLineBreak(event, { ...context, activeSession: false })).toBe(false)
    expect(isSoftKeyboardEnterLineBreak(event, { ...context, commandMenuOpen: true })).toBe(false)
    expect(isSoftKeyboardEnterLineBreak(event, { ...context, recentlyComposing: true })).toBe(false)
  })

  it('preserves synthetic, modified, repeated, and composing Enter events', () => {
    const context = eligibleContext()
    for (const options of [
      {}, { key: 'Tab', trusted: true }, { key: 'Enter', trusted: true, shiftKey: true },
      { key: 'Enter', trusted: true, altKey: true }, { key: 'Enter', trusted: true, ctrlKey: true },
      { key: 'Enter', trusted: true, metaKey: true }, { key: 'Enter', trusted: true, altGraph: true },
      { key: 'Enter', trusted: true, isComposing: true }, { key: 'Enter', trusted: true, keyCode: 229 },
      { key: 'Enter', trusted: true, repeat: true },
    ]) {
      expect(isSoftKeyboardEnterLineBreak(new TestKeyboardEvent('keydown', options) as unknown as KeyboardEvent, context)).toBe(false)
    }
  })

  it('lets stock key handling see no-session/menu Enter and translates only eligible Enter', () => {
    vi.stubGlobal('KeyboardEvent', TestKeyboardEvent)
    let context = eligibleContext()
    const { editor } = fakeComposerEditor()
    const keys: KeyboardEvent[] = []
    const dispose = bindComposerSoftEnter(editor, () => context)
    editor.addEventListener('keydown', event => { keys.push(event) })
    const noSession = new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true, cancelable: true })
    context = { ...context, activeSession: false }
    editor.dispatchEvent(noSession)
    expect(noSession.defaultPrevented).toBe(false)
    expect(keys).toHaveLength(1)
    expect(keys[0]?.shiftKey).toBe(false)
    context = { ...context, activeSession: true, commandMenuOpen: true }
    editor.dispatchEvent(new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true, cancelable: true }))
    expect(keys).toHaveLength(2)
    expect(keys[1]?.shiftKey).toBe(false)
    context = eligibleContext()
    const softEnter = new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true, cancelable: true })
    editor.dispatchEvent(softEnter)
    expect(softEnter.defaultPrevented).toBe(true)
    expect(keys).toHaveLength(3)
    expect(keys[2]?.shiftKey).toBe(true)
    dispose()
    editor.dispatchEvent(new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true, cancelable: true }))
    expect(keys).toHaveLength(4)
    expect(keys[3]?.shiftKey).toBe(false)
  })

  it('keeps composition ownership until ten milliseconds after compositionend', () => {
    vi.stubGlobal('KeyboardEvent', TestKeyboardEvent)
    const now = vi.spyOn(performance, 'now').mockReturnValue(100)
    const { editor, attributes } = fakeComposerEditor()
    const keys: KeyboardEvent[] = []
    const dispose = bindComposerSoftEnter(editor, eligibleContext)
    editor.addEventListener('keydown', event => { keys.push(event) })
    editor.dispatchEvent(new Event('compositionstart'))
    editor.dispatchEvent(new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true, cancelable: true }))
    editor.dispatchEvent(new Event('compositionend'))
    editor.dispatchEvent(new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true, cancelable: true }))
    expect(keys).toHaveLength(2)
    now.mockReturnValue(111)
    attributes.set('data-composer-composing', '')
    editor.dispatchEvent(new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true, cancelable: true }))
    expect(keys).toHaveLength(3)
    attributes.delete('data-composer-composing')
    editor.dispatchEvent(new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true, cancelable: true }))
    expect(keys).toHaveLength(4)
    expect(keys[3]?.shiftKey).toBe(true)
    dispose()
  })

  it('installs only on the live DSH editor and keeps the original toolbar unchanged', () => {
    const source = readFileSync(new URL('../src/native-mobile.ts', import.meta.url), 'utf8')
    expect(source).toContain('[data-composer-input][contenteditable="true"]')
    expect(source).toContain('window.__DSH_MOBILE_NATIVE__ === undefined ? null : window.__DSH_MOBILE_KEYBOARD_STATE__')
    expect(source).toContain("editor.getAttribute('aria-haspopup') !== 'menu'")
    expect(source).toContain('[data-trigger-menu],button[aria-haspopup="listbox"][aria-expanded="true"]')
    expect(source).toContain("editor.addEventListener('keydown', onKeyDown, { capture: true })")
    expect(source).not.toContain('lineBreakButton')
  })

  it('uses the real conversation id for id-less mobile layout and rejects an old photo after navigation', () => {
    let actualSessionId: string | null = 'session-a'
    const main = { classList: ['dshm-main'], parentElement: null, getAttribute: () => null } as unknown as Element
    const conversation = {
      classList: ['conversation_body'], parentElement: main,
      getAttribute: (name: string) => name === 'data-conversation-session' ? actualSessionId : null,
    } as unknown as Element
    const card = {
      classList: ['composer_card'], parentElement: conversation,
      closest: (selector: string) => selector === '[data-conversation-session]' && actualSessionId !== null
        ? conversation
        : selector === '.dshm-main' ? main : null,
    } as unknown as Element
    const tokenForRow = vi.fn(() => 'unused')
    const first = resolveComposerSessionOrigin(card, null, tokenForRow)
    expect(first).toEqual({ sessionRoot: conversation, sessionId: 'session-a' })
    expect(activeSessionForSoftEnter(card, first.sessionId)).toBe(true)
    expect(tokenForRow).not.toHaveBeenCalled()

    const origin = { generation: 1, href: 'https://dsh.test/', composer: card, ...first }
    actualSessionId = 'session-b'
    const second = resolveComposerSessionOrigin(card, null, tokenForRow)
    expect(second).toEqual({ sessionRoot: conversation, sessionId: 'session-b' })
    expect(isComposerMediaOriginCurrent(origin, {
      ...origin, ...second, disposed: false, composerConnected: true,
    })).toBe(false)

    actualSessionId = null
    const unpublished = resolveComposerSessionOrigin(card, null, tokenForRow)
    expect(unpublished).toEqual({ sessionRoot: null, sessionId: null })
    expect(activeSessionForSoftEnter(card, unpublished.sessionId)).toBe(true)
    expect(isComposerMediaOriginCurrent({ ...origin, ...unpublished }, {
      ...origin, ...unpublished, disposed: false, composerConnected: true,
    })).toBe(false)
    const enter = new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true }) as unknown as KeyboardEvent
    expect(isSoftKeyboardEnterLineBreak(enter, { ...eligibleContext(), activeSession: activeSessionForSoftEnter(card, unpublished.sessionId) })).toBe(true)
  })

  it('does not infer a session for the landing hero or for an id-less stock composer', () => {
    const main = { classList: ['dshm-main'], parentElement: null } as unknown as Element
    const heroRoot = { classList: ['composer_root', 'composer_hero'], parentElement: main } as unknown as Element
    const heroCard = {
      classList: ['composer_card'], parentElement: heroRoot,
      closest: (selector: string) => selector === '.dshm-main' ? main : null,
    } as unknown as Element
    const stockCard = {
      classList: ['composer_card'], parentElement: null,
      closest: () => null,
    } as unknown as Element
    expect(composerIsLandingHero(heroCard)).toBe(true)
    expect(activeSessionForSoftEnter(heroCard, null)).toBe(false)
    expect(activeSessionForSoftEnter(stockCard, null)).toBe(false)
    expect(activeSessionForSoftEnter(null, null)).toBe(false)
    const enter = new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true }) as unknown as KeyboardEvent
    expect(isSoftKeyboardEnterLineBreak(enter, { ...eligibleContext(), activeSession: activeSessionForSoftEnter(heroCard, null) })).toBe(false)
    expect(resolveComposerSessionOrigin(heroCard, null, () => 'unused')).toEqual({ sessionRoot: null, sessionId: null })

    const selectedRow = {
      getAttribute: (name: string) => name === 'data-session-id' ? 'stock-session' : null,
      textContent: 'Stock session',
    } as unknown as Element
    expect(resolveComposerSessionOrigin(stockCard, selectedRow, () => 'row-1')).toEqual({
      sessionRoot: selectedRow, sessionId: 'row-1:stock-session',
    })
  })
})
function headerPanHarness(initialRange = 220) {
  let range = initialRange
  let now = 0
  let rendered = 0
  const pan = createHeaderStripPanController({
    range: () => range,
    render: offset => { rendered = offset },
    now: () => now,
  })
  return {
    pan,
    rendered: () => rendered,
    setRange: (value: number) => { range = value },
    setTime: (value: number) => { now = value },
  }
}

describe('browser composer touch Enter', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  const browserContext = () => ({
    appBridge: false,
    browserTouch: true,
    editable: true,
    activeSession: true,
    commandMenuOpen: false,
    recentlyComposing: false,
    hasDraft: true,
  })

  it('reserves Enter for the App before its adapter or keyboard state is available', () => {
    const earlyApp = { dshMobileNative: { postMessage: vi.fn() } }
    const event = new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true }) as never
    expect(nativeAppOwnsComposerEnter(earlyApp)).toBe(true)
    expect(isBrowserTouchEnterLineBreak(event, {
      ...browserContext(), appBridge: nativeAppOwnsComposerEnter(earlyApp),
    })).toBe(false)
    expect(isSoftKeyboardEnterLineBreak(event, { ...eligibleContext(), nativeState: undefined })).toBe(false)
    expect(isSoftKeyboardEnterLineBreak(event, { ...eligibleContext(), nativeState: null })).toBe(false)
    expect(isSoftKeyboardEnterLineBreak(event, eligibleContext())).toBe(true)
    expect(earlyApp.dshMobileNative.postMessage).not.toHaveBeenCalled()
  })

  it('retains adapter-only App ownership and ignores absent or unusable WebMessage channels', () => {
    expect(nativeAppOwnsComposerEnter({ __DSH_MOBILE_NATIVE__: {} })).toBe(true)
    for (const channel of [undefined, null, false, 'App', {}, { postMessage: undefined }, { postMessage: 'send' }]) {
      expect(nativeAppOwnsComposerEnter({ dshMobileNative: channel })).toBe(false)
    }
  })

  it('reads native ownership on each keydown and removes its listener on disposal', () => {
    const nativeView: { dshMobileNative?: { postMessage: (message: string) => void } } = {}
    vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) })
    const documentTarget = new EventTarget()
    const card = { querySelector: () => null } as never
    const editor = {
      textContent: 'Draft',
      querySelector: () => null,
      hasAttribute: () => false,
      closest: (selector: string) => selector === BROWSER_COMPOSER_EDITOR_QUERY ? editor : card,
    } as never
    const dispose = bindBrowserComposerSoftEnter(documentTarget as Document, () => ({
      ...browserContext(), appBridge: nativeAppOwnsComposerEnter(nativeView),
    }))
    const pressEnter = (): number => {
      const event = new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true })
      Object.defineProperty(event, 'target', { value: editor })
      const stopped = vi.spyOn(event, 'stopPropagation')
      documentTarget.dispatchEvent(event)
      return stopped.mock.calls.length
    }
    try {
      expect(pressEnter()).toBe(1)
      nativeView.dshMobileNative = { postMessage: vi.fn() }
      expect(pressEnter()).toBe(0)
      delete nativeView.dshMobileNative
      expect(pressEnter()).toBe(1)
      dispose()
      expect(pressEnter()).toBe(0)
    } finally {
      dispose()
    }
  })

  it('translates a plain trusted Enter only on a touch-primary browser without the App bridge', () => {
    const event = new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true }) as never
    expect(isBrowserTouchEnterLineBreak(event, browserContext())).toBe(true)
    const context = browserContext()
    expect(isBrowserTouchEnterLineBreak(event, { ...context, browserTouch: false })).toBe(false)
    expect(isBrowserTouchEnterLineBreak(event, { ...context, appBridge: true })).toBe(false)
    expect(isBrowserTouchEnterLineBreak(event, { ...context, editable: false })).toBe(false)
    expect(isBrowserTouchEnterLineBreak(event, { ...context, activeSession: false })).toBe(false)
    expect(isBrowserTouchEnterLineBreak(event, { ...context, commandMenuOpen: true })).toBe(false)
    expect(isBrowserTouchEnterLineBreak(event, { ...context, recentlyComposing: true })).toBe(false)
    expect(isBrowserTouchEnterLineBreak(event, { ...context, hasDraft: false })).toBe(false)
  })

  it('keeps synthetic, modified, and composing Enters but follows native held-key repeat', () => {
    const context = browserContext()
    for (const options of [
      {}, { key: 'Escape', trusted: true }, { key: 'Enter', trusted: true, shiftKey: true },
      { key: 'Enter', trusted: true, altKey: true }, { key: 'Enter', trusted: true, ctrlKey: true },
      { key: 'Enter', trusted: true, metaKey: true }, { key: 'Enter', trusted: true, altGraph: true },
      { key: 'Enter', trusted: true, isComposing: true }, { key: 'Enter', trusted: true, keyCode: 229 },
    ]) {
      expect(isBrowserTouchEnterLineBreak(new TestKeyboardEvent('keydown', options) as never, context)).toBe(false)
    }
    const held = new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true, repeat: true }) as never
    expect(isBrowserTouchEnterLineBreak(held, context)).toBe(true)
  })

  it('keeps an already-prevented Enter under stock control in both paths', () => {
    const preventedApp = new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true, cancelable: true })
    preventedApp.preventDefault()
    expect(isSoftKeyboardEnterLineBreak(preventedApp as never, eligibleContext())).toBe(false)
    const preventedBrowser = new TestKeyboardEvent('keydown', { key: 'Enter', trusted: true, cancelable: true })
    preventedBrowser.preventDefault()
    expect(isBrowserTouchEnterLineBreak(preventedBrowser as never, browserContext())).toBe(false)
  })

  it('tracks document-level composition ownership for ten milliseconds', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(100)
    const view = new EventTarget()
    const guard = createDocumentCompositionGuard(view)
    expect(guard.recentlyComposing()).toBe(false)
    view.dispatchEvent(new Event('compositionstart'))
    expect(guard.recentlyComposing()).toBe(true)
    view.dispatchEvent(new Event('compositionend'))
    expect(guard.recentlyComposing()).toBe(true)
    now.mockReturnValue(111)
    expect(guard.recentlyComposing()).toBe(false)
    guard.dispose()
    view.dispatchEvent(new Event('compositionstart'))
    expect(guard.recentlyComposing()).toBe(false)
  })

  it('locates the stock editor from the event target or an inner node, never other editables', () => {
    const card = {} as HTMLElement
    const editor = Object.assign(new EventTarget(), {
      closest: (selector: string) => selector === BROWSER_COMPOSER_EDITOR_QUERY ? editor : card,
    }) as never
    const inner = Object.assign(new EventTarget(), {
      closest: () => editor,
    })
    const textarea = Object.assign(new EventTarget(), {
      closest: () => null,
    })
    expect(resolveBrowserComposerEditor(editor)).toEqual({ editor, card })
    expect(resolveBrowserComposerEditor(inner)).toEqual({ editor, card })
    expect(resolveBrowserComposerEditor(textarea)).toBeNull()
    expect(resolveBrowserComposerEditor(null)).toBeNull()
  })

  it('installs stopPropagation-only glue wired at event time', () => {
    const source = readFileSync(new URL('../src/native-mobile.ts', import.meta.url), 'utf8')
    expect(source).toContain("const BROWSER_TOUCH_PRIMARY_QUERY = '(hover: none), (pointer: coarse)'")
    expect(source).toContain('appBridge: nativeAppOwnsComposerEnter(window)')
    expect(source).toContain('typeof window.matchMedia === \'function\'')
    expect(source).toContain("editor.getAttribute('inputmode') !== 'none'")
    expect(source).toContain('browserComposerHasDraft(target.editor, target.card)')
    expect(source).toContain('event.stopPropagation()')
    expect(source).toContain('bindBrowserComposerSoftEnter(document')
    expect(source).toContain('disposeBrowserComposerSoftEnter')
  })

  it('keeps the browser touch query identical to the layout module query', () => {
    const layout = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')
    const native = readFileSync(new URL('../src/native-mobile.ts', import.meta.url), 'utf8')
    const match = layout.match(/TOUCH_PRIMARY_QUERY = '([^']+)'/)
    expect(match).not.toBeNull()
    expect(native).toContain(`BROWSER_TOUCH_PRIMARY_QUERY = '${match?.[1] ?? ''}'`)
  })
})

describe('header strip pan', () => {
  it('does not reserve a button column that squeezes the header actions', () => {
    expect(NATIVE_MOBILE_STYLES).not.toContain('data-dsh-mobile-pan-available')
    expect(NATIVE_MOBILE_STYLES).not.toContain('data-dsh-mobile-header-pan')
    expect(installNativeMobileSurface.toString()).not.toContain('dshMobileHeaderPan')
  })

  it('does not let an open Jobs menu invent horizontal overflow', () => {
    const box = (right: number) => ({ getBoundingClientRect: () => ({ right }) }) as unknown as Element
    const row = {
      clientWidth: 309,
      scrollWidth: 439, // Includes the absolute menu, but is not the chrome width.
      children: [box(190), box(353)],
      querySelector: () => box(190),
      getBoundingClientRect: () => ({ left: 50 }),
    } as unknown as HTMLElement
    expect(measureHeaderStripOverflow(row)).toBe(0)
    const overflowing = { ...row, clientWidth: 261, children: [box(800)], querySelector: () => null } as unknown as HTMLElement
    expect(measureHeaderStripOverflow(overflowing)).toBe(489)
  })

  it('keeps taps and vertical scrolls untouched while a horizontal touch crosses the threshold', () => {
    const { pan, rendered } = headerPanHarness()
    pan.start(200, 20)
    expect(pan.move(195, 20)).toBe(false)
    expect(rendered()).toBe(0)
    pan.end()
    expect(pan.suppressClick(true, 1)).toBe(false)
    pan.start(200, 20)
    expect(pan.move(190, 40)).toBe(false)
    expect(pan.move(170, 40)).toBe(false)
    expect(rendered()).toBe(0)
    pan.start(200, 20)
    expect(pan.move(180, 22)).toBe(true)
    expect(rendered()).toBe(20)
  })

  it('keeps following the touch stream independently of pointercancel', () => {
    const { pan, rendered } = headerPanHarness()
    pan.start(200, 20)
    expect(pan.move(185, 20)).toBe(true)
    expect(pan.move(120, 20)).toBe(true)
    expect(pan.move(120, 20)).toBe(true)
    expect(rendered()).toBe(80)
    pan.end()
    expect(pan.suppressClick(true, 1)).toBe(true)
  })

  it('ends touchcancel cleanly and permits the next touch to move the strip', () => {
    const { pan, rendered } = headerPanHarness()
    pan.start(200, 20)
    pan.move(170, 20)
    pan.cancel()
    expect(pan.move(120, 20)).toBe(false)
    pan.start(200, 20)
    expect(pan.move(160, 20)).toBe(true)
    expect(rendered()).toBe(70)
  })

  it('does not consume a later unrelated tap, a keyboard click, or a click outside the header', () => {
    const { pan, setTime } = headerPanHarness()
    pan.start(200, 20)
    pan.move(150, 20)
    pan.end()
    expect(pan.suppressClick(true, 0)).toBe(false)
    expect(pan.suppressClick(false, 1)).toBe(false)
    expect(pan.suppressClick(true, 1)).toBe(false)
    pan.start(200, 20)
    pan.move(150, 20)
    pan.end()
    pan.resetClickSuppression()
    expect(pan.suppressClick(true, 1)).toBe(false)
    pan.start(200, 20)
    pan.move(150, 20)
    pan.end()
    setTime(401)
    expect(pan.suppressClick(true, 1)).toBe(false)
  })

  it('re-clamps after header changes and reveals keyboard-focused off-screen controls', () => {
    const { pan, rendered, setRange } = headerPanHarness()
    pan.reveal(300, 340, 40, 260)
    expect(rendered()).toBe(80)
    pan.reveal(10, 50, 40, 260)
    expect(rendered()).toBe(50)
    setRange(20)
    pan.sync()
    expect(rendered()).toBe(20)
    setRange(0)
    pan.sync()
    expect(rendered()).toBe(0)
  })

  it('stops immediately without inertia and resets on disposal', () => {
    const { pan, rendered, setTime } = headerPanHarness()
    pan.start(200, 20)
    pan.move(150, 20)
    pan.end()
    setTime(1_000)
    expect(rendered()).toBe(50)
    pan.dispose()
    expect(rendered()).toBe(0)
  })

  it('keeps touch-action scoped to the actual phone header and leaves menus unclipped', () => {
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-header] :is([class*="_titleRow"],[class*="_headerLeading"]) { touch-action:pan-y; }')
    expect(NATIVE_MOBILE_STYLES).not.toContain('.dshm-shell header { touch-action: pan-y; }')
    expect(NATIVE_MOBILE_STYLES).toContain('.dsh-native-mobile-backdrop,.dsh-mobile-branch-toast,.dsh-mobile-media-toast { display:none; }')
    expect(NATIVE_MOBILE_STYLES).toContain('[data-dsh-mobile-header] [class*="_headerActions"] { flex:none; min-width:max-content; overflow:visible; }')
    expect(NATIVE_MOBILE_STYLES).not.toContain('[data-dsh-mobile-header] [class*="_headerActions"] { max-width:42vw; }')
    const source = installNativeMobileSurface.toString()
    expect(source).toContain('document.addEventListener("touchmove", onStripTouchMove')
    expect(source).not.toContain('onStripPointerCancel')
    expect(source).not.toContain('onStripPointerMove')
    expect(source).toContain('document.addEventListener("focusin", onStripFocus, true)')
    expect(source.indexOf('document.addEventListener("click", onStripClickCapture, true)')).toBeLessThan(source.indexOf('document.addEventListener("click", onBranchClick, true)'))
  })
})

function switchComputerHarness(overrides: {
  readonly canSwitchComputer?: () => Promise<boolean> | boolean
} = {}) {
  let now = 1_000
  let nextHandle = 1
  let probes = 0
  const timers = new Map<number, { readonly due: number; readonly callback: () => void }>()
  const switches: number[] = []
  const hold = createSwitchComputerHold({
    now: () => now,
    setTimer: (callback, delayMs) => {
      const handle = nextHandle
      nextHandle += 1
      timers.set(handle, { due: now + delayMs, callback })
      return handle
    },
    clearTimer: handle => { timers.delete(handle) },
    canSwitchComputer: () => {
      probes += 1
      return overrides.canSwitchComputer === undefined ? true : overrides.canSwitchComputer()
    },
    switchComputer: () => { switches.push(now) },
  })
  /** Let the capability probe settle; the App adapter answers in a microtask. */
  const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
  /** Advance the clock and run only the timers that came due, like the platform timer queue. */
  const elapse = (ms: number): void => {
    now += ms
    for (const [handle, timer] of [...timers]) {
      if (timer.due > now) continue
      timers.delete(handle)
      timer.callback()
    }
  }
  return {
    hold,
    settle,
    elapse,
    switches: () => switches,
    pending: () => timers.size,
    probes: () => probes,
    setTime: (value: number) => { now = value },
  }
}

describe('switch computer hold', () => {
  it('switches only after a full hold and leaves shorter presses to the drawer', async () => {
    const harness = switchComputerHarness()
    harness.hold.start(20, 20)
    await harness.settle()
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS - 1)
    expect(harness.switches()).toEqual([])
    harness.hold.end()
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    expect(harness.switches()).toEqual([])
    harness.hold.start(20, 20)
    await harness.settle()
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    expect(harness.switches()).toHaveLength(1)
  })

  it('keeps the stock tap for a hold that is replaced by a second press', async () => {
    const harness = switchComputerHarness()
    harness.hold.start(20, 20)
    await harness.settle()
    harness.hold.start(20, 20)
    expect(harness.pending()).toBe(1)
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    expect(harness.switches()).toHaveLength(1)
  })

  it('cancels on travel beyond the tolerance and accepts travel inside it', async () => {
    const harness = switchComputerHarness()
    harness.hold.start(20, 20)
    await harness.settle()
    harness.hold.move(20 + SWITCH_COMPUTER_MOVE_TOLERANCE_PX + 1, 20)
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    expect(harness.switches()).toEqual([])
    harness.hold.start(20, 20)
    await harness.settle()
    harness.hold.move(20 + SWITCH_COMPUTER_MOVE_TOLERANCE_PX, 20 - SWITCH_COMPUTER_MOVE_TOLERANCE_PX)
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    expect(harness.switches()).toHaveLength(1)
  })

  it('waits for an App that does not advertise the action, then accepts the next hold', async () => {
    let supported = false
    const harness = switchComputerHarness({ canSwitchComputer: () => supported })
    harness.hold.start(20, 20)
    await harness.settle()
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    expect(harness.switches()).toEqual([])
    supported = true
    harness.hold.start(20, 20)
    await harness.settle()
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    expect(harness.switches()).toHaveLength(1)
  })

  it('probes the bridge until the App confirms the action and then stops asking', async () => {
    const harness = switchComputerHarness()
    harness.hold.start(20, 20)
    await harness.settle()
    expect(harness.probes()).toBe(1)
    harness.hold.end()
    harness.hold.start(20, 20)
    await harness.settle()
    expect(harness.probes()).toBe(1)
  })

  it('swallows exactly the click that follows a completed hold', async () => {
    const harness = switchComputerHarness()
    harness.hold.start(20, 20)
    await harness.settle()
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    harness.hold.end()
    expect(harness.hold.consumeClickSuppression(1)).toBe(true)
    expect(harness.hold.consumeClickSuppression(1)).toBe(false)
  })

  it('keeps the stock click when the press never completed or never armed', async () => {
    const harness = switchComputerHarness()
    expect(harness.hold.consumeClickSuppression(1)).toBe(false)
    harness.hold.start(20, 20)
    await harness.settle()
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS - 1)
    harness.hold.end()
    expect(harness.hold.consumeClickSuppression(1)).toBe(false)
    // A keyboard-activated click carries detail 0 and keeps DSH's own handling.
    harness.hold.start(20, 20)
    await harness.settle()
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    harness.hold.end()
    expect(harness.hold.consumeClickSuppression(0)).toBe(false)
  })

  it('expires the suppression so a later tap still opens the drawer', async () => {
    const harness = switchComputerHarness()
    harness.hold.start(20, 20)
    await harness.settle()
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    harness.hold.end()
    harness.elapse(SWITCH_COMPUTER_CLICK_SUPPRESSION_MS + 1)
    expect(harness.hold.consumeClickSuppression(1)).toBe(false)
  })

  it('arms the next press without the previous hold suppression', async () => {
    const harness = switchComputerHarness()
    harness.hold.start(20, 20)
    await harness.settle()
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    harness.hold.end()
    harness.hold.start(20, 20)
    expect(harness.hold.consumeClickSuppression(1)).toBe(false)
  })

  it('owns the long-press menu only around a completed hold', async () => {
    const harness = switchComputerHarness()
    expect(harness.hold.blocksContextMenu()).toBe(false)
    harness.hold.start(20, 20)
    await harness.settle()
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    expect(harness.hold.blocksContextMenu()).toBe(true)
    harness.elapse(SWITCH_COMPUTER_CLICK_SUPPRESSION_MS + 1)
    expect(harness.hold.blocksContextMenu()).toBe(false)
  })

  it('stops a pending hold and its suppression on disposal', async () => {
    const harness = switchComputerHarness()
    harness.hold.start(20, 20)
    await harness.settle()
    harness.hold.dispose()
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    expect(harness.switches()).toEqual([])
    expect(harness.pending()).toBe(0)
    harness.hold.start(20, 20)
    await harness.settle()
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    harness.hold.end()
    expect(harness.hold.consumeClickSuppression(1)).toBe(false)
    expect(harness.switches()).toEqual([])
  })

  it('ignores capability results that arrive after disposal', async () => {
    let resolveSupport: ((supported: boolean) => void) | undefined
    const harness = switchComputerHarness({ canSwitchComputer: () => new Promise<boolean>(resolve => { resolveSupport = resolve }) })
    harness.hold.start(20, 20)
    await harness.settle()
    harness.hold.dispose()
    resolveSupport?.(true)
    await harness.settle()
    harness.hold.start(20, 20)
    harness.elapse(SWITCH_COMPUTER_LONG_PRESS_MS)
    expect(harness.switches()).toEqual([])
    expect(harness.pending()).toBe(0)
  })

  it('binds the hold to the App drawer toggle and releases it with the surface', () => {
    const source = readFileSync(new URL('../src/native-mobile.ts', import.meta.url), 'utf8')
    expect(SWITCH_COMPUTER_NATIVE_ACTION).toBe('mobile.switch-computer')
    expect(NATIVE_MOBILE_TOGGLE_QUERY).toBe('[data-dsh-mobile-toggle]')
    expect(source).toContain("capabilities()).includes(SWITCH_COMPUTER_NATIVE_ACTION)")
    expect(source).toContain("bridge.invoke(SWITCH_COMPUTER_NATIVE_ACTION, {})")
    expect(source).toContain("if (!event.isPrimary || event.button !== 0 || !isDrawerToggleTarget(event.target)) return")
    expect(source).toContain("target instanceof Element && target.closest(NATIVE_MOBILE_TOGGLE_QUERY) !== null")
    expect(source).toContain("document.addEventListener('pointerdown', onTogglePointerDown, true)")
    expect(source).toContain("document.addEventListener('pointerup', onTogglePointerEnd, true)")
    expect(source).toContain("document.addEventListener('pointercancel', onTogglePointerEnd, true)")
    expect(source).toContain("document.addEventListener('click', onToggleClickCapture, true)")
    expect(source).toContain("document.addEventListener('contextmenu', onToggleContextMenu, true)")
    expect(source).toContain("document.removeEventListener('pointerdown', onTogglePointerDown, true)")
    expect(source).toContain("document.removeEventListener('contextmenu', onToggleContextMenu, true)")
    expect(source).toContain("window.removeEventListener('blur', onTogglePointerEnd)")
    expect(source).toContain("document.removeEventListener('visibilitychange', onToggleVisibilityChange)")
    expect(source).toContain('switchComputerHold.dispose()')
    // The gesture never invents drawer chrome of its own.
    expect(NATIVE_MOBILE_STYLES).not.toContain('dsh-mobile-switch-computer')
  })
})

/** The scroller events a history auto-load intent may come from; asserted against the real binder. */
const HISTORY_INTENT_EVENTS = ['touchstart', 'touchmove', 'wheel', 'scroll', 'scrollend', 'touchend', 'touchcancel']

interface HistoryGateHarnessOptions {
  readonly top?: number
  /** Whether the loader button accepts a click; an absent hook always accepts it. */
  readonly loadable?: () => boolean
}

/** An EventTarget-backed scroller plus the hooks the gate reads, in this suite's factory style. */
function historyGateHarness(options: HistoryGateHarnessOptions = {}) {
  const scroller = new EventTarget()
  const pending = new Set<ReturnType<typeof setTimeout>>()
  let top = options.top ?? 400
  let clicks = 0
  const gate = createHistoryAutoLoadGate({
    getTop: () => Math.max(0, top),
    shouldLoad: shouldAutoLoadEarlier,
    tryLoad: () => {
      if (options.loadable !== undefined && !options.loadable()) return false
      clicks += 1
      return true
    },
    schedule: (callback, ms) => {
      const handle = setTimeout(() => { pending.delete(handle); callback() }, ms)
      pending.add(handle)
      return handle
    },
    cancel: id => {
      const handle = id as ReturnType<typeof setTimeout>
      pending.delete(handle)
      clearTimeout(handle)
    },
  })
  const touchEvent = (type: string, changed: readonly number[], active: readonly number[] = changed): Event => {
    const event = new Event(type)
    Object.defineProperty(event, 'changedTouches', { value: changed.map(identifier => ({ identifier })) })
    Object.defineProperty(event, 'touches', { value: active.map(identifier => ({ identifier })) })
    return event
  }
  return {
    gate,
    scroller,
    bind: () => bindHistoryAutoLoadGate(scroller, gate),
    /** Fresh user input on the scroller. */
    input: (type: string) => { scroller.dispatchEvent(type.startsWith('touch')
      ? touchEvent(type, [1], type === 'touchend' || type === 'touchcancel' ? [] : [1]) : new Event(type)) },
    touchEvent,
    /** Real touch changes can leave unrelated contacts elsewhere in the document. */
    touch: (type: string, changed: readonly number[], active: readonly number[] = changed) => { scroller.dispatchEvent(touchEvent(type, changed, active)) },
    /** A scroll event after the top moved, whether a finger or a script moved it. */
    scroll: (value: number) => { top = value; scroller.dispatchEvent(new Event('scroll')) },
    clicks: () => clicks,
    pending: () => pending.size,
  }
}

describe('history loader label', () => {
  it('retains the native idle locale while loading and adopts a changed idle locale', () => {
    const loader: Pick<HTMLElement, 'dataset'> = { dataset: {} }
    const button = { disabled: false, textContent: '  加载更早历史  ' }
    syncHistoryLoaderLabel(loader, button)
    expect(loader.dataset.dshMobileHistoryLabel).toBe('加载更早历史')
    button.disabled = true
    button.textContent = '加载中…'
    syncHistoryLoaderLabel(loader, button)
    expect(loader.dataset.dshMobileHistoryLabel).toBe('加载更早历史')
    button.disabled = false
    button.textContent = 'Load earlier history'
    syncHistoryLoaderLabel(loader, button)
    expect(loader.dataset.dshMobileHistoryLabel).toBe('Load earlier history')
  })

  it('writes the sizing label only when the native idle text changes', () => {
    let label: string | undefined
    const write = vi.fn((value: string) => { label = value })
    const dataset: DOMStringMap = {}
    Object.defineProperty(dataset, 'dshMobileHistoryLabel', { get: () => label, set: write })
    const button = { disabled: false, textContent: 'Load earlier history' }
    syncHistoryLoaderLabel({ dataset }, button)
    syncHistoryLoaderLabel({ dataset }, button)
    expect(write).toHaveBeenCalledTimes(1)
    button.textContent = '加载更早历史'
    syncHistoryLoaderLabel({ dataset }, button)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('does not invent an idle translation if a loader is first observed while busy', () => {
    const loader: Pick<HTMLElement, 'dataset'> = { dataset: {} }
    syncHistoryLoaderLabel(loader, { disabled: true, textContent: 'Loading…' })
    expect(loader.dataset.dshMobileHistoryLabel).toBeUndefined()
  })

  it('observes only loader text changes, releases its sizing attribute, and preserves native accessibility', () => {
    const source = readFileSync(new URL('../src/native-mobile.ts', import.meta.url), 'utf8')
    expect(source).toContain('historyLabelObserver.observe(next, { childList: true, characterData: true, subtree: true })')
    expect(source).toContain('historyLabelObserver.disconnect()')
    expect(source).toContain('delete element.dataset.dshMobileHistoryLabel')
    expect(source).toContain('element.dataset.dshMobileHistoryLabel = originalLabel')
    expect(source).toContain('bindHistoryLoader(undefined)')
    const start = source.indexOf('if (historyLoader !== undefined) {')
    const loader = source.slice(start, source.indexOf('const messageColumn =', start))
    expect(loader).toContain('syncHistoryLoaderLabel(historyLoader, button)')
    expect(loader).not.toContain('tabIndex')
    expect(loader).not.toContain('aria-hidden')
  })
})

describe('history auto-load gate', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('never chains loads without fresh user input', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    harness.scroll(60)
    // The gesture is still live: an eligible scroll records the intent only.
    expect(harness.clicks()).toBe(0)
    // DSH prepends the loaded page and writes scrollTop back: two more eligible
    // decreases inside the same gesture must not record another load.
    harness.scroll(50)
    harness.scroll(20)
    expect(harness.clicks()).toBe(0)
    harness.input('touchend')
    harness.input('scrollend')
    expect(harness.clicks()).toBe(1)
    harness.input('touchstart')
    harness.input('touchmove')
    harness.scroll(10)
    expect(harness.clicks()).toBe(1)
    harness.input('touchend')
    harness.input('scrollend')
    expect(harness.clicks()).toBe(2)
  })

  it('holds an eligible drag until the gesture settles', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    harness.input('touchmove')
    harness.scroll(60)
    expect(harness.clicks()).toBe(0)
    expect(harness.gate.state()).toMatchObject({ armed: true, pendingIntent: true })
    harness.input('touchmove')
    harness.scroll(45)
    expect(harness.clicks()).toBe(0)
    harness.input('touchend')
    harness.input('scrollend')
    expect(harness.clicks()).toBe(1)
    expect(harness.gate.state()).toMatchObject({ armed: false, pendingIntent: false })
    // Settle already consumed the intent; later quiet windows cannot re-fire it.
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS * 2)
    expect(harness.clicks()).toBe(1)
  })

  it('drops the intent at lease expiry while a contact is still live', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    harness.input('touchmove')
    harness.scroll(60)
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1)
    expect(harness.clicks()).toBe(0)
    expect(harness.gate.state()).toMatchObject({ armed: false, pendingIntent: false })
    // The resting finger's later moves no longer arm the gate: ownership re-anchored.
    harness.input('touchmove')
    expect(harness.gate.state().armed).toBe(false)
    // The reader lifts and gestures again to load.
    harness.input('touchend')
    harness.input('touchstart')
    harness.input('touchmove')
    harness.scroll(50)
    harness.input('touchend')
    harness.input('scrollend')
    expect(harness.clicks()).toBe(1)
  })

  it('an unspent intent dies with its arm and cannot be spent by later scrolling', () => {
    vi.useFakeTimers()
    let loadable = false
    const harness = historyGateHarness({ top: 400, loadable: () => loadable })
    harness.bind()
    harness.input('touchstart')
    harness.scroll(60)
    harness.input('touchend')
    harness.input('scrollend') // refused: the loader button is disabled
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1) // the lease refuses; the arm dies
    loadable = true
    harness.scroll(55) // no fresh input re-armed the gate
    harness.input('scrollend')
    expect(harness.clicks()).toBe(0)
  })

  it('a wheel-consumed load clears a parked touch intent', () => {
    vi.useFakeTimers()
    let loadable = false
    const harness = historyGateHarness({ top: 400, loadable: () => loadable })
    harness.bind()
    harness.input('touchstart')
    harness.scroll(60)
    harness.input('touchend')
    harness.input('scrollend') // refused
    loadable = true
    harness.input('wheel') // the wheel path loads immediately
    harness.scroll(30)
    expect(harness.clicks()).toBe(1)
    harness.scroll(35) // downhill, in zone: must not spend the parked intent
    harness.input('scrollend')
    expect(harness.clicks()).toBe(1)
  })

  it('a new gesture that never scrolls uphill cannot load', () => {
    vi.useFakeTimers()
    let loadable = false
    const harness = historyGateHarness({ top: 400, loadable: () => loadable })
    harness.bind()
    harness.input('touchstart')
    harness.scroll(60)
    harness.input('touchend')
    harness.input('scrollend') // refused
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1)
    loadable = true
    harness.input('touchstart') // a fresh gesture
    harness.scroll(63) // downhill only: never eligible
    harness.input('touchend')
    harness.input('scrollend')
    expect(harness.clicks()).toBe(0)
  })

  it.each(['touch', 'wheel'])('withdraws a refused intent when new %s input starts before its lease expires', input => {
    vi.useFakeTimers()
    let loadable = false
    const harness = historyGateHarness({ top: 400, loadable: () => loadable })
    harness.bind()
    harness.touch('touchstart', [1])
    harness.scroll(60)
    harness.touch('touchend', [1], [])
    harness.input('scrollend')
    expect(harness.gate.state().pendingIntent).toBe(true)

    if (input === 'touch') harness.touch('touchstart', [2])
    else harness.input('wheel')
    harness.scroll(63)
    if (input === 'touch') harness.touch('touchend', [2], [])
    loadable = true
    harness.input('scrollend')
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1)
    expect(harness.clicks()).toBe(0)

    harness.touch('touchstart', [3])
    harness.scroll(50)
    harness.touch('touchend', [3], [])
    harness.input('scrollend')
    expect(harness.clicks()).toBe(1)
  })

  it('retains a pending intent when another contact joins the same touch gesture', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.touch('touchstart', [1])
    harness.scroll(60)
    harness.touch('touchstart', [2], [1, 2])
    harness.touch('touchend', [1], [2])
    harness.input('scrollend')
    expect(harness.clicks()).toBe(0)
    expect(harness.gate.state().pendingIntent).toBe(true)
    harness.touch('touchend', [2], [])
    harness.input('scrollend')
    expect(harness.clicks()).toBe(1)
  })

  it('ignores a descendant scrollend while the conversation still has a pending intent', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    const added = vi.spyOn(harness.scroller, 'addEventListener')
    harness.bind()
    harness.input('touchstart')
    harness.scroll(60)
    harness.input('touchend')
    expect(harness.gate.state().pendingIntent).toBe(true)

    // EventTarget has no DOM ancestry, so deliver the event to the captured listener.
    const listener = added.mock.calls.find(call => call[0] === 'scrollend')?.[1]
    if (typeof listener !== 'function') throw new Error('History scrollend listener was not bound')
    const childEnd = new Event('scrollend')
    Object.defineProperty(childEnd, 'target', { value: new EventTarget() })
    listener(childEnd)
    expect(harness.clicks()).toBe(0)
    expect(harness.gate.state().pendingIntent).toBe(true)

    harness.input('scrollend')
    expect(harness.clicks()).toBe(1)
  })

  it('keeps the arm and intent through a scrollend delivered mid-gesture', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    harness.input('touchmove')
    harness.scroll(60)
    harness.input('scrollend') // the engine reports scroll-complete while the finger is down
    expect(harness.gate.state()).toMatchObject({ armed: true, pendingIntent: true })
    harness.scroll(45) // the drag continues
    harness.input('touchend')
    harness.input('scrollend')
    expect(harness.clicks()).toBe(1)
  })

  it('treats wheel input inside a touch gesture as touch, not as an immediate load', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    harness.input('wheel') // e.g. a trackpad tick during the drag
    harness.scroll(50)
    expect(harness.clicks()).toBe(0)
    harness.input('touchend')
    harness.input('scrollend')
    expect(harness.clicks()).toBe(1)
  })

  it('keeps wheel input deferred while a held contact outlives an unused arm', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.touch('touchstart', [1])
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1)
    expect(harness.gate.state()).toMatchObject({ armed: false, pendingIntent: false })

    harness.input('wheel')
    harness.scroll(50)
    expect(harness.clicks()).toBe(0)
    expect(harness.gate.state()).toMatchObject({ armed: true, pendingIntent: true })
    harness.input('scrollend')
    expect(harness.clicks()).toBe(0)

    harness.touch('touchend', [1], [])
    harness.input('scrollend')
    expect(harness.clicks()).toBe(1)
    expect(harness.pending()).toBe(0)

    harness.input('wheel')
    harness.scroll(30)
    expect(harness.clicks()).toBe(2)
    expect(harness.pending()).toBe(0)
  })

  it('cancels the pending intent when the reader leaves the zone before settle', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    harness.scroll(60)
    expect(harness.clicks()).toBe(0)
    harness.input('touchend')
    harness.scroll(300)
    harness.input('scrollend')
    expect(harness.clicks()).toBe(0)
    expect(harness.gate.state()).toMatchObject({ pendingIntent: false })
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS * 2)
    expect(harness.clicks()).toBe(0)
  })

  it('drops the pending intent on reset', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    harness.scroll(60)
    expect(harness.gate.state()).toMatchObject({ pendingIntent: true })
    harness.gate.reset(400)
    expect(harness.gate.state()).toMatchObject({ armed: false, pendingIntent: false })
    harness.input('touchend')
    harness.input('scrollend')
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS * 2)
    expect(harness.clicks()).toBe(0)
  })

  it('loads immediately for wheel input without waiting for a settle', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('wheel')
    harness.scroll(30)
    expect(harness.clicks()).toBe(1)
  })

  it('ignores a script-driven scrollTop write until input arms the gate', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.scroll(300)
    expect(harness.clicks()).toBe(0)
    expect(harness.gate.state()).toMatchObject({ armed: false, previousTop: 300 })
    harness.scroll(40)
    expect(harness.clicks()).toBe(0)
    harness.input('touchstart')
    harness.scroll(30)
    // Armed input records the intent; the live gesture still loads nothing.
    expect(harness.clicks()).toBe(0)
    harness.input('touchend')
    harness.input('scrollend')
    expect(harness.clicks()).toBe(1)
  })

  it('expires a stale arm through the input-restarted quiet timer', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    harness.input('touchend')
    expect(harness.pending()).toBe(1)
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS - 1)
    expect(harness.gate.state().armed).toBe(true)
    vi.advanceTimersByTime(1)
    expect(harness.gate.state()).toMatchObject({ armed: false, previousTop: 400 })
    expect(harness.pending()).toBe(0)
    harness.scroll(60)
    expect(harness.clicks()).toBe(0)
  })

  it('expires a held pause without scrollend and re-arms on the next owned touchmove', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS * 2)
    expect(harness.gate.state().armed).toBe(false)
    expect(harness.pending()).toBe(0)
    harness.input('touchmove')
    harness.scroll(60)
    expect(harness.clicks()).toBe(0)
    harness.input('touchend')
    harness.input('scrollend')
    expect(harness.clicks()).toBe(1)
  })

  it('keeps the arm fresh through momentum scroll after the finger lifts', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    harness.input('touchend')
    vi.advanceTimersByTime(1000)
    harness.scroll(350) // momentum keeps scrolling after the lift; still outside the zone
    vi.advanceTimersByTime(1000) // past the quiet window the lift started, inside the one the scroll restarted
    expect(harness.gate.state().armed).toBe(true)
    expect(harness.pending()).toBe(1)
    harness.scroll(50) // the slow fling reaches the zone only after the lift
    expect(harness.clicks()).toBe(0)
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1) // the fling settles on the quiet lease
    expect(harness.clicks()).toBe(1)
    expect(harness.gate.state().armed).toBe(false)
    harness.scroll(40) // a disarmed scroll must not re-arm the gate or park a timer
    expect(harness.pending()).toBe(0)
    expect(harness.clicks()).toBe(1)
    // Without the momentum scroll the arm still expires on the input clock alone.
    const quiet = historyGateHarness({ top: 400 })
    quiet.bind()
    quiet.input('touchstart')
    quiet.input('touchend')
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS * 2)
    expect(quiet.gate.state().armed).toBe(false)
    quiet.scroll(60)
    expect(quiet.clicks()).toBe(0)
  })

  it('retains another finger ownership after one touchend without making its input lease permanent', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.touch('touchstart', [1], [1])
    harness.touch('touchstart', [2], [1, 2])
    harness.touch('touchend', [1], [2]) // one finger lifted, one still on the glass
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1)
    expect(harness.gate.state().armed).toBe(false)
    harness.touch('touchmove', [2], [2])
    expect(harness.gate.state().armed).toBe(true)
    harness.touch('touchend', [2], []) // the last finger lifted
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1)
    expect(harness.gate.state().armed).toBe(false)
    harness.scroll(60)
    expect(harness.clicks()).toBe(0)
  })

  it('expires after its last own contact ends even while another contact remains outside the scroller', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    const outside = new EventTarget()
    harness.touch('touchstart', [1], [1])
    outside.dispatchEvent(harness.touchEvent('touchstart', [2], [1, 2]))
    harness.touch('touchend', [1], [2])
    outside.dispatchEvent(harness.touchEvent('touchend', [2], []))

    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS * 4)
    expect(harness.gate.state().armed).toBe(false)
    expect(harness.pending()).toBe(0)
    harness.scroll(40)
    expect(harness.clicks()).toBe(0)
  })

  it('retains contacts observed on different descendant targets until all of its contacts end', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    // Both starts reach the containing scroller even when their DOM targets differ.
    harness.touch('touchstart', [11], [11])
    harness.touch('touchstart', [22], [11, 22])
    harness.touch('touchcancel', [11], [22])
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS * 2)
    expect(harness.gate.state().armed).toBe(false)
    harness.touch('touchmove', [22], [22])
    harness.scroll(50)
    expect(harness.clicks()).toBe(0)
    harness.touch('touchend', [22], [])
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1)
    expect(harness.clicks()).toBe(1)
    expect(harness.pending()).toBe(0)
  })

  it('expires when a detached original target delivers its ending outside the scroller', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    const detachedTarget = new EventTarget()
    harness.touch('touchstart', [7], [7])
    // A detached Touch.target still receives touchend, but its old ancestor does not.
    detachedTarget.dispatchEvent(harness.touchEvent('touchend', [7], []))
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS * 4)
    expect(harness.gate.state().armed).toBe(false)
    expect(harness.pending()).toBe(0)
    harness.scroll(40)
    expect(harness.clicks()).toBe(0)
    harness.touch('touchstart', [8], [8])
    harness.scroll(20)
    // The ghosted contact keeps the lease from consuming under a listed finger;
    // the intent dies with the arm, and a fresh gesture loads.
    harness.touch('touchend', [8], [])
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1)
    expect(harness.clicks()).toBe(0)
    harness.touch('touchstart', [9], [9])
    harness.touch('touchmove', [9], [9])
    harness.scroll(15)
    harness.touch('touchend', [9], [])
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1)
    expect(harness.clicks()).toBe(1)
  })

  it('ignores moves and endings of contacts whose start this owner never observed', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.touch('touchmove', [91], [91])
    harness.touch('touchend', [91], [])
    expect(harness.gate.state().armed).toBe(false)
    expect(harness.pending()).toBe(0)
    harness.scroll(40)
    expect(harness.clicks()).toBe(0)
  })

  it('releases all owned contacts on a cancelled multi-touch gesture', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.touch('touchstart', [1, 2], [1, 2])
    harness.touch('touchcancel', [1, 2], [])
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1)
    expect(harness.gate.state().armed).toBe(false)
    expect(harness.pending()).toBe(0)
    harness.scroll(40)
    expect(harness.clicks()).toBe(0)
  })

  it('withdraws held contacts across a session reset without accepting their later moves', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.touch('touchstart', [7], [7])
    harness.gate.reset(400)
    harness.touch('touchmove', [7], [7])
    harness.touch('touchend', [7], [])
    expect(harness.pending()).toBe(0)
    harness.scroll(40)
    expect(harness.clicks()).toBe(0)
    harness.touch('touchstart', [8], [8])
    harness.scroll(20)
    expect(harness.clicks()).toBe(0)
    harness.touch('touchend', [8], [])
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1)
    expect(harness.clicks()).toBe(1)
  })

  it('withdraws held contacts and rejects every touch stage after disposal', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.touch('touchstart', [1, 2], [1, 2])
    harness.gate.dispose()
    harness.touch('touchmove', [1], [1, 2])
    harness.touch('touchend', [1], [2])
    harness.touch('touchcancel', [2], [])
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS * 2)
    expect(harness.gate.state().armed).toBe(false)
    expect(harness.pending()).toBe(0)
    harness.scroll(40)
    expect(harness.clicks()).toBe(0)
  })

  it('disarms on scrollend and re-arms on contact-free wheel input', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    harness.input('scrollend')
    expect(harness.gate.state().armed).toBe(false)
    expect(harness.pending()).toBe(0)
    harness.scroll(60)
    expect(harness.clicks()).toBe(0)
    harness.input('touchend')
    harness.input('wheel')
    harness.scroll(30)
    expect(harness.clicks()).toBe(1)
  })

  it('lets a cancelled touch expire its arm', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    harness.input('touchcancel')
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1)
    expect(harness.gate.state().armed).toBe(false)
    harness.scroll(60)
    expect(harness.clicks()).toBe(0)
  })

  it('keeps the pending intent when the loader button refuses the settle click', () => {
    vi.useFakeTimers()
    let loadable = false
    const harness = historyGateHarness({ top: 400, loadable: () => loadable })
    harness.bind()
    harness.input('touchstart')
    harness.scroll(60)
    expect(harness.clicks()).toBe(0)
    expect(harness.gate.state()).toMatchObject({ armed: true, pendingIntent: true })
    harness.input('touchend')
    harness.input('scrollend')
    expect(harness.clicks()).toBe(0)
    loadable = true
    harness.scroll(50)
    expect(harness.clicks()).toBe(0)
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS + 1)
    expect(harness.clicks()).toBe(1)
    harness.scroll(20)
    expect(harness.clicks()).toBe(1)
  })

  it('resets on session switch even when the scroller node is reused', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    expect(harness.gate.state()).toMatchObject({ armed: true, previousTop: 400 })
    harness.gate.reset(400)
    expect(harness.gate.state()).toMatchObject({ armed: false, previousTop: 400 })
    expect(harness.pending()).toBe(0)
    harness.scroll(60)
    expect(harness.clicks()).toBe(0)
    harness.input('touchstart')
    harness.scroll(30)
    expect(harness.clicks()).toBe(0)
    harness.input('touchend')
    harness.input('scrollend')
    expect(harness.clicks()).toBe(1)
  })

  it('resolves the history gate session from the current pass composer, not the previous binding', () => {
    vi.useFakeTimers()
    const sessionRoot = (id: string) => ({
      getAttribute: (name: string) => name === 'data-conversation-session' ? id : null,
    }) as unknown as Element
    const composerFor = (root: Element) => ({
      closest: (selector: string) => selector === '[data-conversation-session]' ? root : null,
    }) as unknown as Element
    const composerA = composerFor(sessionRoot('session-a'))
    const composerB = composerFor(sessionRoot('session-b'))
    const tokenForRow = vi.fn(() => 'unused')
    // Pass 1 records session A through the composer that pass resolved.
    const first = resolveHistoryGateIdentity({ previousSessionId: null, composer: composerA, selectedRow: null, selectedRowToken: tokenForRow })
    expect(first).toEqual({ sessionId: 'session-a', sessionChanged: true })
    expect(tokenForRow).not.toHaveBeenCalled()
    // A session switch reuses the scroller node and replaces the composer. The
    // stale ordering — the composer the previous pass bound — still reports A
    // and would skip the reset; the current pass's composer must win.
    const stale = resolveHistoryGateIdentity({ previousSessionId: first.sessionId, composer: composerA, selectedRow: null, selectedRowToken: tokenForRow })
    expect(stale.sessionChanged).toBe(false)
    const fresh = resolveHistoryGateIdentity({ previousSessionId: first.sessionId, composer: composerB, selectedRow: null, selectedRowToken: tokenForRow })
    expect(fresh).toEqual({ sessionId: 'session-b', sessionChanged: true })
    // Driving the binder decision on the fresh identity clears the old arm.
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    expect(harness.gate.state()).toMatchObject({ armed: true, previousTop: 400 })
    if (fresh.sessionChanged) harness.gate.reset(120)
    expect(harness.gate.state()).toMatchObject({ armed: false, previousTop: 120 })
    harness.scroll(60)
    expect(harness.clicks()).toBe(0)
    expect(tokenForRow).not.toHaveBeenCalled()
  })

  it('clears its quiet timer on dispose and ignores later events', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    harness.bind()
    harness.input('touchstart')
    expect(harness.pending()).toBe(1)
    harness.gate.dispose()
    expect(harness.pending()).toBe(0)
    vi.advanceTimersByTime(HISTORY_SCROLL_QUIET_MS * 2)
    harness.input('touchmove')
    harness.scroll(60)
    expect(harness.clicks()).toBe(0)
    expect(harness.pending()).toBe(0)
  })

  it('adds and removes every gate listener with one shared options constant', () => {
    vi.useFakeTimers()
    const harness = historyGateHarness({ top: 400 })
    const added = vi.spyOn(harness.scroller, 'addEventListener')
    const removed = vi.spyOn(harness.scroller, 'removeEventListener')
    const unbind = harness.bind()
    const listener = added.mock.calls[0]?.[1]
    expect(added.mock.calls.map(call => call[0])).toEqual(HISTORY_INTENT_EVENTS)
    expect(typeof listener).toBe('function')
    expect(added.mock.calls.every(call => call[1] === listener)).toBe(true)
    expect(added.mock.calls.every(call => call[2] === HISTORY_INTENT_LISTENER_OPTIONS)).toBe(true)
    unbind()
    expect(removed.mock.calls.map(call => call[0])).toEqual(HISTORY_INTENT_EVENTS)
    expect(removed.mock.calls.every(call => call[1] === listener)).toBe(true)
    expect(removed.mock.calls.every(call => call[2] === HISTORY_INTENT_LISTENER_OPTIONS)).toBe(true)
    expect(HISTORY_INTENT_LISTENER_OPTIONS).toEqual({ passive: true, capture: true })
    // A released scroller stops feeding the gate.
    harness.input('touchstart')
    harness.scroll(60)
    expect(harness.clicks()).toBe(0)
  })

  it('binds the gate to the conversation scroller and releases it with the surface', () => {
    const source = readFileSync(new URL('../src/native-mobile.ts', import.meta.url), 'utf8')
    expect(HISTORY_SCROLL_QUIET_MS).toBe(1600)
    expect(source).toContain('createHistoryAutoLoadGate({')
    expect(source).toContain('shouldLoad: shouldAutoLoadEarlier')
    expect(source).toContain('bindHistoryAutoLoadGate(next, historyAutoLoadGate)')
    // Rebinding and disposal both remove every listener the binder added.
    expect(source).toContain('disposeHistoryGate?.()')
    expect(source).toContain('historyAutoLoadGate.dispose()')
    // A session switch drops the previous session's arm on a reused scroller
    // node. The identity comes from the CURRENT pass's composer — resolved
    // before the binder call — never the media binding's previous-pass capture,
    // which syncMediaBinding updates only later in the same sync.
    expect(source).toContain('resolveHistoryGateIdentity({')
    expect(source).toContain('previousSessionId: historySessionId')
    expect(source).toContain('historySessionId = identity.sessionId')
    expect(source).toContain('if (!identity.sessionChanged) return')
    expect(source).toContain('historyAutoLoadGate.reset(historyScroller?.scrollTop ?? 0)')
    expect(source).toContain('bindHistoryScroller(conversation ?? undefined, composerCard ?? null)')
    expect(source).toContain('bindHistoryScroller(undefined, null)')
    const composerQuery = source.indexOf("const composerCard = center.querySelector<HTMLElement>('[data-composer-card]')")
    expect(composerQuery).toBeGreaterThan(-1)
    expect(composerQuery).toBeLessThan(source.indexOf('bindHistoryScroller(conversation ?? undefined'))
    expect(source).not.toContain('const sessionId = currentSessionOrigin().sessionId')
    // The ungated scroll listener that fired on DSH's own scrollTop writes is gone.
    expect(source).not.toContain('onHistoryScroll')
    expect(source).not.toContain('historyPreviousTop')
  })
})
