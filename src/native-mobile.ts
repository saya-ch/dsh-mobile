/**
 * Viewport below which the injected chrome becomes an overlay drawer: the
 * sidebar slides in as a sheet, the right panel as a drawer, and the scrim dims
 * the page behind them. The stylesheet and the scrim's visibility both read
 * this query, so a wider viewport never grows drawer chrome whose rules cannot
 * style it.
 */
import { installTaskCompletionWatcher, type TaskNotifyKind } from './task-notify.js'
import { MOBILE_COMPOSER_TOOLBAR_STYLES } from './mobile-composer-toolbar.js'
import { pickBrowserFiles } from './browser-file-picker.js'
import { installMobileSidebarScrollMemory } from './mobile-sidebar-scroll.js'
import { WIDE_LAYOUT_ATTRIBUTE } from './mobile-layout-attributes.js'

export const NATIVE_MOBILE_OVERLAY_QUERY = '(max-width:720px)'

/** Mobile feature and compatibility rules applied to DSH React surfaces. */
export const NATIVE_MOBILE_STYLES = `
/* The surface appends chrome to <body> on every non-loopback page load, but
   every rule that gives that chrome a box lives inside the overlay query
   below. Outside the query the scrim kept the UA button box: an empty,
   nameless button in normal flow at the document's bottom-left, whose click
   still collapsed the sidebar. Keep the neutral state explicitly invisible —
   the query restores the fixed scrim, and its more specific [hidden] rule
   keeps winning there. */
 .dsh-native-mobile-backdrop,.dsh-mobile-branch-toast,.dsh-mobile-media-toast { display:none; }
 /* The content-font preference may exceed Safari's focused-editable minimum.
    The html-level class exists on every non-desktop mobile page, so it also
    covers body-level portals (model picker search) the center column never
    contained; the center marker stays alongside it because a disposed
    surface removes the html class while styles applied from its string can
    outlive the class on a page that still carries the center column. */
 html.dsh-native-mobile-active :is(input,textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[contenteditable=""]),
 [data-dsh-mobile-center] :is(input,textarea,[contenteditable="true"],[contenteditable="plaintext-only"],[contenteditable=""]) { font-size:max(16px,1em,var(--dsh-content-font-size,1em)) !important; }
 .dsh-mobile-settings_row { display:flex; align-items:center; gap:8px; padding:16px 0; border-bottom:0.5px solid var(--dsw-alias-border-l2); }
 .dsh-mobile-settings_rowText { flex:1; min-width:0; display:flex; flex-direction:column; gap:4px; padding-right:48px; }
 .dsh-mobile-settings_title { color:var(--dsw-alias-label-primary); font-size:14px; font-weight:400; line-height:22px; }
 .dsh-mobile-settings_desc { color:var(--dsw-alias-label-tertiary); font-size:12px; font-weight:400; line-height:18px; }
 .dsh-mobile-settings_selector { display:inline-flex; align-items:center; justify-content:center; min-width:max-content; min-height:48px; padding:0 14px; border:0; border-radius:24px; background:var(--dsw-alias-bg-module-platform); color:var(--dsw-alias-label-primary); font:inherit; font-size:14px; line-height:22px; cursor:pointer; }
 .dsh-mobile-settings_selector:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
 .dsh-mobile-settings_selector:active:not(:disabled) { background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover)); }
 .dsh-mobile-settings_selector:focus-visible { outline:2px solid var(--dsw-alias-label-primary-bluish,#2563eb); outline-offset:2px; }
/* Row switches (session prefetch, composer collapse) pair a visually-hidden
   native checkbox with an On/Off pill. Hide the checkbox so the pill is the only
   visible control, while the label keeps the 48px row a tap target and the input
   stays keyboard-focusable; the pill's :focus-visible ring is driven by the
   checkbox's focus via :has. */
 .dsh-mobile-settings_switchInput { position:absolute; width:1px; height:1px; margin:-1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; border:0; opacity:0; }
 .dsh-mobile-settings_row:has(.dsh-mobile-settings_switchInput:focus-visible) .dsh-mobile-settings_selector { outline:2px solid var(--dsw-alias-label-primary-bluish,#2563eb); outline-offset:2px; }
 .dsh-mobile-settings_selector:disabled { cursor:wait; opacity:.55; }
 .dsh-mobile-settings_fontControls { display:flex; align-items:center; gap:8px; flex-shrink:0; }
 .dsh-mobile-settings_fontControls button { min-width:48px; padding:0 12px; }
 .dsh-mobile-settings_fontControls output { min-width:42px; text-align:center; font-variant-numeric:tabular-nums; }
 .dsh-mobile-settings_fontDetails { min-width:0; padding:0 0 16px; border-bottom:0.5px solid var(--dsw-alias-border-l2); }
 .dsh-mobile-settings_fontDetails > summary { display:list-item; min-height:48px; padding:14px 0; box-sizing:border-box; color:var(--dsw-alias-label-primary); font-size:14px; cursor:pointer; }
 .dsh-mobile-settings_fontDetails .dsh-mobile-settings_rowText { padding-right:8px; }
 .dsh-mobile-settings_fontFamily { display:flex; flex-wrap:wrap; align-items:center; gap:8px; min-width:0; padding:12px 0; }
 .dsh-mobile-settings_fontFamily > span { flex:1 1 100px; }
 .dsh-mobile-settings_fontFamily input { box-sizing:border-box; flex:1 1 180px; width:100%; min-width:0; min-height:48px; padding:8px 12px; border:0.5px solid var(--dsw-alias-border-l2); border-radius:10px; background:var(--dsw-alias-bg-module-platform); color:var(--dsw-alias-label-primary); font:inherit; }
 .dsh-mobile-settings_fontFamily input:focus-visible,.dsh-mobile-settings_fontDetails > summary:focus-visible { outline:2px solid var(--dsw-alias-label-primary-bluish,#2563eb); outline-offset:2px; }
 /* Push category rows: compact label-left / native-Switch-right rows. The control is
    the actual public @deepseek-ai/dsh-client-ui-primitives Switch provided by the DSH
    web shell: its track/thumb paint, dimensions, focus ring and motion are owned by
    the shell stylesheet and are never re-created, resized or overridden here. Each
    row is a label associated with its switch button, so the full 48px row remains
    one tap target while the button keeps native keyboard semantics. Category names
    match the General settings row title typography (14px/20px, regular weight). */
 .dsh-mobile-push-categories { display:flex; flex-direction:column; width:100%; margin:8px 0 4px; border-top:0.5px solid var(--dsw-alias-border-l2,#e8ebef); }
 .dsh-mobile-push-category { display:flex; align-items:center; justify-content:space-between; gap:12px; box-sizing:border-box; width:100%; min-height:48px; padding:6px 0; border-bottom:0.5px solid var(--dsw-alias-border-l2,#e8ebef); cursor:pointer; }
 .dsh-mobile-push-categoryName { flex:1 1 auto; min-width:0; color:var(--dsw-alias-label-primary,#171a21); font-size:14px; line-height:20px; font-weight:400; overflow-wrap:anywhere; }
 html.dsh-native-mobile-active [data-dsh-mobile-settings-header] { box-sizing:border-box !important; height:56px !important; min-height:56px !important; padding:4px 12px !important; }
 html.dsh-native-mobile-active [data-dsh-mobile-settings-header] [class*="_close"] { box-sizing:border-box !important; flex:none !important; width:48px !important; min-width:48px !important; height:48px !important; min-height:48px !important; }
 /* The mobile row replaces the Host-backed font control, not the theme selector. */
 html.dsh-native-mobile-active [data-slot="settings.general.item"]:has([data-mobile-font-setting]) > :not([data-mobile-font-setting])[class*="_row"]:has([class*="_control"] > [class*="_stepper"] > [class*="_arrows"]) { display:none !important; }
/* The injected attachment actions exist on every viewport, not only under the
   narrow overlay: a tablet shows the same Add menu, and with no native item to
   mirror they fell back to an unstyled UA button box (bordered, centred). Keep
   this fallback outside the overlay query so the rows read like native ones. */
.dsh-mobile-media-action { box-sizing:border-box; display:flex; align-items:center; justify-content:flex-start; gap:8px; width:100%; min-width:0; min-height:40px; padding:8px 10px; border:0; border-radius:10px; background:transparent; color:var(--dsw-alias-label-primary,inherit); cursor:pointer; font:inherit; font-size:14px; line-height:22px; text-align:left; touch-action:manipulation; }
.dsh-mobile-media-action:active { opacity:.72; }
.dsh-mobile-media-action:focus-visible { outline:2px solid var(--dsw-alias-state-business-primary,#4c82f7); outline-offset:1px; }
.dsh-mobile-media-action:disabled { cursor:default; opacity:.38; }
.dsh-mobile-media-action svg { flex:none; width:16px; height:16px; color:var(--dsw-alias-label-tertiary,currentColor); }
.dsh-mobile-media-action span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@media ${NATIVE_MOBILE_OVERLAY_QUERY} {
  html.dsh-native-mobile-active,html.dsh-native-mobile-active body { width:100%; height:100%; overflow:hidden; }
  html.dsh-native-mobile-active { --dsh-mobile-motion-duration:200ms; --dsh-mobile-motion-ease:cubic-bezier(.22,1,.36,1); }
  html.dsh-native-mobile-active :is(a,button,[role="button"],[role="tab"],[tabindex]) { -webkit-tap-highlight-color:transparent; }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [role="treeitem"] { -webkit-tap-highlight-color:transparent; touch-action:manipulation; }
  html.dsh-native-mobile-active[data-dsh-mobile-input="touch"] :is(a,button,[role="button"],[role="tab"],[tabindex]):focus { outline:none !important; }
  html.dsh-native-mobile-active [role="tooltip"] { display:none !important; }
  /* Touch has no persistent hover affordance: keep workspace rows neutral after a tap. */
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] { --dsw-alias-interactive-bg-hover:transparent !important; }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [role="treeitem"]:is(:hover,:active,:focus,[aria-selected="true"]),
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_sessionRow"][class*="_selected"],
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_searchResultRow"][class*="_selected"] { background:transparent !important; outline:0 !important; box-shadow:none !important; }
  /* Sidebar row menus are hover-only on desktop. Touch has no hover, so keep
     the ellipsis action visible and give it a reliable hit target. */
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_rowActions"] { display:inline-flex !important; align-items:center !important; gap:8px !important; }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_sessionRow"] [class*="_time"] { display:none !important; }
  /* The always-visible pin action already conveys pinned state. Desktop only
     hides this passive marker on hover; touch rows must hide it throughout. */
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_sessionRow"] [class*="_pinIndicator"] { display:none !important; }
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_rowActions"] button { box-sizing:border-box !important; width:32px !important; min-width:32px !important; height:32px !important; min-height:32px !important; }
  [data-dsh-mobile-frame] { grid-template-columns:0 minmax(0,1fr) 0 !important; width:100% !important; height:100dvh !important; overflow:hidden !important; }
  /* The stock frame owns layout, not a tap target. Restore only its content
     columns; the stock shell-overlay retains its own descendant hit policy. */
  html.dsh-native-mobile-active [data-dsh-mobile-frame] { pointer-events:none !important; }
  html.dsh-native-mobile-active [data-dsh-mobile-frame] > :is([data-dsh-mobile-sidebar],[data-dsh-mobile-center],[class*="_rightbarCol"]) { pointer-events:auto !important; }
  /* Floating slot surfaces paint above mobile drawers; their empty layer
     stays click-through and each stock occupant retains its own hit policy. */
  html.dsh-native-mobile-active [data-shell-overlay] { z-index:300 !important; pointer-events:none !important; }
  [data-dsh-mobile-center] { grid-column:2 !important; width:100vw !important; min-width:0 !important; }
  [data-dsh-mobile-center] > * { min-width:0 !important; }
  [data-dsh-mobile-header] { box-sizing:border-box !important; width:calc(100% - 16px) !important; margin:0 8px !important; min-width:0; padding-top:max(4px,env(safe-area-inset-top)) !important; padding-right:8px !important; padding-left:42px !important; }
  [data-dsh-mobile-header] :is([class*="_titleRow"],[class*="_headerLeading"]) { touch-action:pan-y; }
  [data-dsh-mobile-header] [class*="_titleRow"] { box-sizing:border-box !important; display:flex !important; align-items:center !important; min-width:0; min-height:32px !important; height:32px !important; gap:6px !important; padding:0 6px !important; }
  [data-dsh-mobile-header] [class*="_titleCluster"] { min-width:0; }
  [data-dsh-mobile-header] [class*="_crumbs"] { min-width:0; overflow:hidden; }
  [data-dsh-mobile-header] [class*="_crumb"] { max-width:46vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  /* Nested header actions (including the Jobs menu) must paint outside the row. */
  [data-dsh-mobile-header] [class*="_headerActions"] { flex:none; min-width:max-content; overflow:visible; }
  [data-dsh-mobile-header] [class*="_headerUtilities"] { gap:2px !important; }
  [data-dsh-mobile-header] [class*="_sessionLogButton"] { width:40px; min-width:40px; padding:0 !important; overflow:hidden; color:transparent; font-size:0 !important; }
  [data-dsh-mobile-header] [class*="_sessionLogButton"] > * { display:none !important; }
  [data-dsh-mobile-header] [class*="_sessionLogButton"]::after { color:var(--dsw-alias-label-primary, #171a21); content:"Log"; font-size:11px; font-weight:600; }
  html[data-dsh-mobile-language="zh"] [data-dsh-mobile-header] [class*="_sessionLogButton"]::after { content:"日志"; }
  [data-dsh-mobile-header] [class*="_tabs"] { box-sizing:border-box !important; width:max-content !important; max-width:calc(100% - 58px) !important; min-height:28px !important; height:28px !important; margin-top:0 !important; padding-left:6px !important; padding-right:6px !important; overflow-x:auto; scrollbar-width:none; }
  [data-dsh-mobile-header] [class*="_tab"] { padding-bottom:5px !important; }
  [data-dsh-mobile-header] [class*="_tabs"]::-webkit-scrollbar { display:none; }
  [data-dsh-mobile-sidebar] { position:fixed !important; z-index:240 !important; inset:0 auto 0 0 !important; width:0 !important; overflow:visible !important; }
  [data-dsh-mobile-sidebar-root] { position:fixed !important; z-index:241 !important; inset:max(env(safe-area-inset-top),0px) auto 0 0 !important; height:auto !important; transition:width 180ms var(--dsh-mobile-motion-ease),box-shadow 180ms ease !important; }
  [data-dsh-mobile-sidebar][data-open="true"] [data-dsh-mobile-sidebar-root] { width:min(88vw,340px) !important; padding-top:0 !important; box-shadow:18px 0 46px rgb(15 23 42 / 18%); }
  /* Extra panel/footer seats may exceed a short drawer. Keep a bounded
     workspace scrollport and let the drawer scroll to the remaining seats. */
  [data-dsh-mobile-sidebar][data-open="true"]:not(:has([data-dsh-mobile-settings])) [data-dsh-mobile-sidebar-root] { overflow-y:auto !important; overscroll-behavior-y:contain; }
  [data-dsh-mobile-sidebar][data-open="true"]:not(:has([data-dsh-mobile-settings])) [data-dsh-mobile-sidebar-root] > [class*="_regionArea"] { flex:1 0 50% !important; }
  [data-dsh-mobile-sidebar][data-open="true"] [data-dsh-mobile-sidebar-root] [class*="_logoRow"] { height:52px !important; padding:4px 0 4px 4px !important; margin-bottom:4px !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] { width:0 !important; border:0 !important; background:transparent !important; box-shadow:none !important; overflow:visible !important; }
  [data-dsh-mobile-sidebar][data-open="false"]:not(:has([data-dsh-mobile-settings])) [data-dsh-mobile-sidebar-root] { box-sizing:border-box !important; min-width:0 !important; padding:0 !important; pointer-events:none !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-toggle] { pointer-events:auto !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :not(:has([data-dsh-mobile-toggle])) { display:none !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :has([data-dsh-mobile-toggle]) { position:fixed !important; z-index:244 !important; top:env(safe-area-inset-top) !important; left:0 !important; box-sizing:border-box !important; width:50px !important; height:52px !important; padding:4px !important; border:0 !important; background:transparent !important; }
   [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :has([data-dsh-mobile-toggle]) > :not([data-dsh-mobile-toggle]) { display:none !important; }
   /* The stock settings shell is mounted under the collapsed sidebar. Let
      its fixed overlay escape the zero-width drawer while it is open. */
   [data-dsh-mobile-sidebar]:has([data-dsh-mobile-settings]) { width:100vw !important; inset:0 !important; }
   [data-dsh-mobile-sidebar]:has([data-dsh-mobile-settings]) > * { width:100vw !important; overflow:visible !important; }
   [data-dsh-mobile-toggle] { width:44px !important; height:44px !important; min-width:44px !important; min-height:44px !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-toggle] > svg[class*="_railFish"] { transform:translateY(-4px) !important; }
  .dsh-native-mobile-backdrop { display:block; position:fixed; z-index:235; inset:env(safe-area-inset-top) 0 0; border:0; background:rgb(15 23 42 / 32%); }
  .dsh-native-mobile-backdrop:not([hidden]) { animation:dsh-mobile-fade-in var(--dsh-mobile-motion-duration) ease-out; }
  .dsh-native-mobile-backdrop[hidden] { display:none; }
  [data-dsh-mobile-details] { position:fixed !important; z-index:250 !important; inset:0 0 0 auto !important; width:min(94vw,460px) !important; max-width:none !important; transform:translateX(100%); transition:transform var(--dsh-mobile-motion-duration) var(--dsh-mobile-motion-ease); background:var(--dsw-alias-bg-layer-1, #fff); box-shadow:-18px 0 46px rgb(15 23 42 / 18%); }
  [data-dsh-mobile-details][data-open="true"] { transform:translateX(0); }
  [data-dsh-mobile-handle] { display:none !important; }
  [data-dsh-mobile-settings="true"] { flex-direction:column !important; width:100vw !important; height:100dvh !important; max-width:none !important; border-radius:0 !important; animation:dsh-mobile-panel-in var(--dsh-mobile-motion-duration) var(--dsh-mobile-motion-ease); }
  [data-dsh-mobile-settings-nav] { flex:none !important; width:100% !important; padding:max(14px,env(safe-area-inset-top)) 12px 8px !important; gap:10px !important; border-bottom:1px solid var(--dsw-alias-border-l2,#e8ebef); }
  [data-dsh-mobile-settings-nav] [class*="_navTitle"] { padding:0 8px !important; font-size:18px !important; line-height:28px !important; }
  [data-dsh-mobile-settings-list] { flex-direction:row !important; gap:4px !important; overflow-x:auto !important; scrollbar-width:none; }
  [data-dsh-mobile-settings-list]::-webkit-scrollbar { display:none; }
  [data-dsh-mobile-settings-list] [class*="_navCell"] { flex:0 0 auto !important; min-width:max-content !important; height:44px !important; padding:10px 12px !important; }
  [data-dsh-mobile-settings-list] [aria-current="true"] { border-color:transparent !important; outline:0 !important; box-shadow:none !important; }
  [data-dsh-mobile-settings-content] { flex:1 1 auto !important; width:100% !important; min-height:0 !important; }
   [data-dsh-mobile-settings-options] { box-sizing:border-box !important; width:100% !important; padding:4px 16px max(24px,env(safe-area-inset-bottom)) !important; overflow-x:hidden !important; }
   [data-dsh-mobile-settings-options] > * { width:100% !important; min-width:0 !important; }
   [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] > [class*="_row"] { flex-direction:column !important; align-items:stretch !important; gap:12px !important; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] [class*="_rowText"] { width:100% !important; padding-right:0 !important; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] [class*="_selector"] { box-sizing:border-box !important; align-self:flex-start !important; justify-content:space-between !important; min-width:0 !important; min-height:48px !important; max-width:100% !important; }
  [data-dsh-mobile-settings-options] :is(input,select,textarea,button) { max-width:100%; }
  [data-dsh-mobile-settings-options] :is(input,select,textarea) { box-sizing:border-box; width:100%; min-width:0; }
  /* Local steppers and native page-scale controls keep their own touch targets. */
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] .dsh-mobile-settings_fontControls button { flex:0 0 auto !important; width:auto !important; min-width:48px !important; align-self:center !important; justify-content:center !important; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] .dsh-mobile-settings_fontControls select { flex:0 0 auto !important; width:auto !important; min-width:76px !important; align-self:center !important; }
  [data-dsh-mobile-settings-options] [data-mobile-font-setting] .dsh-mobile-settings_row { flex-wrap:wrap !important; }
  [data-dsh-mobile-settings-options] [data-mobile-font-setting] .dsh-mobile-settings_rowText { flex:1 1 140px !important; width:auto !important; padding-right:8px !important; }
  [data-dsh-mobile-settings-options] [class*="_head"] { min-width:0; flex-wrap:wrap; }
  /* Provider names may shrink, but their edit/delete actions remain horizontal
     and retain a full touch target on narrow screens. */
  [data-dsh-mobile-settings-options] [class*="_rowHead"]:has(> [class*="_rowIdentity"]) { flex-wrap:nowrap !important; align-items:center !important; }
  [data-dsh-mobile-settings-options] [class*="_rowIdentity"] { flex:1 1 auto !important; min-width:0 !important; overflow:hidden !important; }
  [data-dsh-mobile-settings-options] [class*="_rowName"] { min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-mobile-settings-options] [class*="_rowActions"] { flex:0 0 auto !important; flex-wrap:nowrap !important; width:max-content !important; min-width:max-content !important; max-width:none !important; }
  [data-dsh-mobile-settings-options] [class*="_rowActions"] button { flex:none !important; width:auto !important; min-width:44px !important; max-width:none !important; min-height:44px !important; padding-inline:10px !important; white-space:nowrap !important; word-break:keep-all !important; writing-mode:horizontal-tb !important; }
  [data-dsh-mobile-settings-content][data-dsh-mobile-view-transition="true"],
  [data-dsh-mobile-view][data-dsh-mobile-view-transition="true"] { animation:dsh-mobile-view-in var(--dsh-mobile-motion-duration) var(--dsh-mobile-motion-ease); }
  /* Markdown tables use content-sized columns. Small tables fill the phone;
     wider tables keep readable cells and scroll inside their own region. */
  [data-dsh-mobile-table-scroll] { box-sizing:border-box; width:100%; max-width:100%; overflow-x:auto; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch; }
  [data-dsh-mobile-table-scroll] table { display:table !important; width:max-content !important; min-width:100% !important; max-width:none !important; table-layout:auto !important; }
  [data-dsh-mobile-table-scroll] :is(th,td) { box-sizing:border-box; min-width:8ch; max-width:32ch; overflow-wrap:anywhere; word-break:break-word; vertical-align:top; }
  [data-dsh-mobile-center] pre { max-width:100%; overflow-x:auto; }
  [data-dsh-mobile-center] :is(img,video,canvas,svg) { max-width:100%; }
  [data-dsh-mobile-message-scroll] { box-sizing:border-box !important; width:100% !important; padding:8px 10px 20px !important; }
  [data-dsh-mobile-history-loader] { position:relative !important; display:grid !important; grid-template-columns:minmax(0,1fr) !important; justify-items:center !important; flex:0 0 auto !important; min-height:48px !important; font-size:var(--dsh-content-font-size-secondary,13px); line-height:1.5; }
  [data-dsh-mobile-history-loader]::before,[data-dsh-mobile-history-loader] button { box-sizing:border-box !important; grid-area:1/1 !important; min-height:48px !important; max-width:100% !important; padding:8px 12px !important; font:inherit !important; white-space:normal !important; overflow-wrap:anywhere; }
  [data-dsh-mobile-history-loader]::before { content:attr(data-dsh-mobile-history-label); visibility:hidden; pointer-events:none; }
  [data-dsh-mobile-history-loader] button { min-width:48px !important; touch-action:manipulation; }
  /* DSH's sibling margins exclude hidden and empty Chat Node Seats. Keep that
     spacing rule so searchable hidden seats contribute no folded-turn gaps. */
  [data-dsh-mobile-message-column] { box-sizing:border-box !important; width:100% !important; max-width:none !important; margin:0 !important; padding:0 !important; gap:0 !important; --dsh-chat-flow-gap:10px; }
  [data-dsh-mobile-message-column] > * { width:100% !important; max-width:100% !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] { box-sizing:border-box !important; display:grid !important; grid-template-columns:16px minmax(0,1fr) !important; grid-auto-rows:auto !important; align-items:center !important; column-gap:6px !important; width:100% !important; height:auto !important; min-height:40px !important; padding:4px 0 !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > [class*="_leading"] { grid-column:1 !important; grid-row:1 !important; margin-right:0 !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > [class*="_title"] { grid-column:2 !important; grid-row:1 !important; min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > :is([class*="_sep"],[class*="_separator"]) { display:none !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > :is([class*="_summary"],[class*="_fileLink"]) { grid-column:2 !important; grid-row:2 !important; width:100% !important; min-width:0 !important; max-width:100% !important; overflow:hidden !important; line-height:19px !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-mobile-message-column] [data-disclosure-row] > [class*="_summarySuffix"] { grid-column:2 !important; grid-row:3 !important; margin-left:0 !important; }
  [data-dsh-mobile-message-column] [data-context-fields] > * { display:grid !important; grid-template-columns:minmax(72px,30%) minmax(0,1fr) !important; gap:4px 10px !important; }
  [data-dsh-mobile-message-column] [class*="_ioSection"] { grid-template-columns:1fr !important; row-gap:4px !important; }
  [data-dsh-mobile-message-column] [class*="_body"] { max-width:100% !important; overflow-wrap:anywhere; }
  /* Keep folded and expanded reasoning visually separate from the reply. */
  [data-dsh-mobile-message-column] [class*="_body"] > div:has(> [data-variant="think"]) { margin-bottom:12px !important; }
  [data-dsh-mobile-center] [data-composer-card] ~ [class*="_root"]:not(:where(input,textarea,[contenteditable])),
  [data-dsh-mobile-center] [data-composer-card] ~ * [class*="_root"]:not(:where(input,textarea,[contenteditable])) { box-sizing:border-box !important; width:100% !important; max-width:100% !important; margin-bottom:-6px !important; padding:3px 4px 0 !important; font-size:11px !important; line-height:18px !important; white-space:normal !important; overflow:visible !important; text-overflow:clip !important; }
  [data-dsh-mobile-center] [data-composer-card] ~ [class*="_root"] [class*="_sep"],
  [data-dsh-mobile-center] [data-composer-card] ~ * [class*="_root"] [class*="_sep"] { margin:0 6px !important; }
  /* Composer dock stats strip (turns/steps/tokens) reads small on phones.
     :not(:where(...)) keeps editables exempt at zero specificity cost, so
     the small !important fonts cannot beat the 16px editable floor while
     the dock spacing rules keep their cascade position. */
  [data-dsh-mobile-center] [data-slot="conversation.composer.dock"] [class*="_root"]:not(:where(input,textarea,[contenteditable])) { font-size:10px !important; line-height:16px !important; }
  /* The context ring is a composer-metadata _root too, so the metadata rule
     above stretched it across the whole dock. It cannot shrink, which left the
     session statistics beside it a few pixels wide, every number clipped to an
     ellipsis. Keep the ring at its own size and let it hold the row the numbers
     are on. */
  [data-dsh-mobile-center] [data-composer-card] ~ * [class*="_root"]:has(> [class*="_trigger"][aria-haspopup="dialog"]) { width:auto !important; max-width:none !important; flex:0 0 auto !important; }
  /* Slot entries participate in this flex layout through display:contents.
     Keep core statistics and the meter together; extra entries use their own
     rows instead of taking the statistics' remaining width on phones. */
  [data-dsh-mobile-center] [class*="_dock"]:has([data-composer-stats]) { display:flex !important; flex-wrap:wrap !important; justify-content:flex-start !important; align-items:center !important; column-gap:12px !important; row-gap:2px !important; width:100% !important; max-width:100% !important; }
  /* Dock row gaps replace the single-row metadata's negative margin. */
  [data-dsh-mobile-center] [class*="_dock"]:has([data-composer-stats]) > *,
  [data-dsh-mobile-center] [class*="_dock"]:has([data-composer-stats]) [data-slot="conversation.composer.dock"] > * { margin-bottom:0 !important; }
  [data-dsh-mobile-center] [class*="_dock"]:has([data-composer-stats]) [data-slot="conversation.composer.dock"] > :not([data-composer-stats]) { flex:0 1 100% !important; min-width:0 !important; max-width:100% !important; }
  [data-dsh-mobile-center] [class*="_dock"]:has([data-composer-stats]) [data-composer-stats] { order:-2 !important; }
  [data-dsh-mobile-center] [class*="_dock"]:has([data-composer-stats]) > [class*="_root"]:has(> [class*="_trigger"][aria-haspopup="dialog"]) { order:-1 !important; }
  /* Interactive pills expose complete values in their labels and dialogs.
     Static compact or untimed pills have no disclosure, so they may wrap. */
  [data-dsh-mobile-center] [data-composer-card] ~ * [class*="_root"][data-composer-stats] { box-sizing:border-box !important; width:auto !important; max-width:none !important; flex:1 1 0 !important; flex-wrap:nowrap !important; justify-content:flex-start !important; overflow:hidden !important; row-gap:2px !important; }
  [data-dsh-mobile-center] [data-composer-stats] > * { min-width:0 !important; }
  [data-dsh-mobile-center] [data-composer-stats] [class*="_pill"] { display:block !important; min-width:0 !important; white-space:nowrap !important; overflow:hidden !important; text-overflow:ellipsis !important; }
  [data-dsh-mobile-center] [data-composer-stats] [class*="_pill"] svg { display:inline-block !important; vertical-align:-2px !important; margin-right:6px !important; }
  [data-dsh-mobile-center] [data-composer-stats]:has(span[class*="_pill"]) { flex-wrap:wrap !important; overflow:visible !important; }
  [data-dsh-mobile-center] [data-composer-stats] span[class*="_pill"] { flex:0 1 auto !important; max-width:100% !important; white-space:normal !important; overflow:visible !important; overflow-wrap:anywhere !important; text-overflow:clip !important; }
  /* Message runtime details are inline on desktop. Give the clock/runtime
     label its own wrapping row on narrow screens so TTFT and throughput do
     not push the action buttons or clip at the viewport edge. */
  [data-dsh-mobile-center] [class*="_actions"]:has(> [class*="_timeStart"]),
  [data-dsh-mobile-center] [class*="_actions"]:has(> [class*="_timeEnd"]) { box-sizing:border-box !important; width:100% !important; flex-wrap:wrap !important; justify-content:flex-end !important; height:auto !important; min-height:28px !important; row-gap:2px !important; }
  [data-dsh-mobile-center] [class*="_timeStart"],
  [data-dsh-mobile-center] [class*="_timeEnd"] { box-sizing:border-box !important; flex:1 1 100% !important; order:2 !important; min-width:0 !important; max-width:100% !important; padding:0 !important; line-height:20px !important; text-align:center !important; white-space:normal !important; overflow-wrap:anywhere !important; }
  [data-dsh-mobile-center] [class*="_timeStart"] { box-sizing:border-box !important; flex:1 1 100% !important; order:2 !important; min-width:0 !important; max-width:100% !important; padding:0 !important; line-height:20px !important; text-align:center !important; white-space:normal !important; overflow-wrap:anywhere !important; }
  [data-dsh-mobile-center] [class*="_timeStart"] [class*="_runTimeDot"],
  [data-dsh-mobile-center] [class*="_timeEnd"] [class*="_runTimeDot"] { margin:0 6px !important; }
  /* Keep the context meter's legend rows as readable label/value pairs.
     Generic mobile flex rules can otherwise place the rows side by side and
     break Chinese labels in the middle of a word. */
  [data-dsh-mobile-center] [role="dialog"][aria-label*="上下文"],
  [data-dsh-mobile-center] [role="dialog"][aria-label*="Context"] { width:min(264px,calc(100vw - 32px)) !important; min-width:0 !important; max-width:calc(100vw - 32px) !important; }
  [data-dsh-mobile-center] [role="dialog"][aria-label*="上下文"] [class*="_rows"],
  [data-dsh-mobile-center] [role="dialog"][aria-label*="Context"] [class*="_rows"] { display:block !important; }
  [data-dsh-mobile-center] [role="dialog"][aria-label*="上下文"] [class*="_rows"] > [class*="_row"],
  [data-dsh-mobile-center] [role="dialog"][aria-label*="Context"] [class*="_rows"] > [class*="_row"] { display:flex !important; align-items:center !important; justify-content:space-between !important; width:100% !important; min-width:0 !important; white-space:nowrap !important; }
  [data-dsh-mobile-center] [role="dialog"][aria-label*="上下文"] :is(dt,dd),
  [data-dsh-mobile-center] [role="dialog"][aria-label*="Context"] :is(dt,dd) { white-space:nowrap !important; word-break:keep-all !important; }
  .dsh-mobile-branch-toast,.dsh-mobile-media-toast { display:block; position:fixed; z-index:330; top:max(12px,env(safe-area-inset-top)); left:50%; max-width:calc(100vw - 32px); box-sizing:border-box; padding:7px 14px; border:1px solid rgb(15 23 42 / 10%); border-radius:999px; background:rgb(15 23 42 / 92%); color:#fff; font-size:13px; line-height:20px; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:0; pointer-events:none; transform:translate(-50%,-8px); transition:opacity 160ms ease,transform 160ms ease; }
  .dsh-mobile-branch-toast[data-visible="true"],.dsh-mobile-media-toast[data-visible="true"] { opacity:1; transform:translate(-50%,0); }
  [data-dsh-mobile-center] [class*="_composer"] { padding-left:8px !important; padding-right:8px !important; padding-bottom:max(8px,env(safe-area-inset-bottom)) !important; }
  /* Collapse the scroll viewport only; the editor, draft and attachments stay
     owned by DSH. Toolbar focus keeps the card expanded during menu taps. */
  [data-dsh-mobile-center] [data-composer-card]:not(:focus-within) > [data-input-scroll] { max-height:72px !important; overflow-y:auto !important; }
  [data-dsh-mobile-center] [class*="_root"]:has(> [class*="_card"] textarea) { box-sizing:border-box !important; width:100% !important; padding:0 0 8px !important; }
  [data-dsh-mobile-center] [class*="_root"]:has(> [class*="_card"] textarea) > [class=""]:last-child { display:none !important; }
}
@media (max-width:720px) and (max-height:500px) {
  /* An open software keyboard leaves less room for the focused draft. */
  html.dsh-native-mobile-active [data-dsh-mobile-center] [data-composer-card] > [data-input-scroll] { max-height:72px !important; overflow-y:auto !important; }
}
@media (max-width:720px) and (max-height:400px) {
  [data-dsh-mobile-center] [data-composer-card] { gap:8px !important; }
  html.dsh-native-mobile-active [data-dsh-mobile-center] [data-composer-card] > [data-input-scroll] { max-height:48px !important; }
}
@keyframes dsh-mobile-fade-in { from { opacity:0; } }
@keyframes dsh-mobile-panel-in { from { opacity:.72; transform:translateY(6px); } }
@keyframes dsh-mobile-view-in { from { opacity:.58; transform:translateY(5px); } }
@media (max-width:420px) {
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] [class*="_selector"] { align-self:stretch !important; width:100% !important; }
  [data-dsh-mobile-message-column] [data-context-fields] > * { grid-template-columns:1fr !important; }
}
@media (prefers-reduced-motion:reduce) {
  [data-dsh-mobile-sidebar-root],[data-dsh-mobile-details] { transition:none !important; }
  .dsh-native-mobile-backdrop:not([hidden]),[data-dsh-mobile-settings],
  [data-dsh-mobile-settings-content][data-dsh-mobile-view-transition="true"],
  [data-dsh-mobile-view][data-dsh-mobile-view-transition="true"] { animation:none !important; }
}
` + MOBILE_COMPOSER_TOOLBAR_STYLES

function classToken(element: Element, suffix: string): boolean {
  return Array.from(element.classList).some(value => value.endsWith(suffix))
}

function firstByClassSuffix(root: ParentNode, suffix: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>('[class]')).find(element => classToken(element, suffix))
}

/**
 * Whether this composer is the landing hero rather than the composer of an open
 * conversation. DSH marks the hero composer's root with a `_hero` class and drops
 * it once a session owns the surface, which is the only difference available
 * without the layout's session id.
 */
export function composerIsLandingHero(composer: Element | null, depth = 4): boolean {
  let node: Element | null = composer
  for (let step = 0; step < depth && node !== null; step += 1) {
    if (classToken(node, '_hero')) return true
    node = node.parentElement
  }
  return false
}

/** Resolve only identities published by the current conversation or selected session row. */
export function resolveComposerSessionOrigin(
  composer: Element | null,
  selectedRow: Element | null,
  selectedRowToken: (row: Element) => string,
): { readonly sessionRoot: Element | null; readonly sessionId: string | null } {
  const conversationRoot = composer?.closest('[data-conversation-session]') ?? null
  const conversationId = conversationRoot?.getAttribute('data-conversation-session')
  if (conversationRoot !== null && conversationId) return { sessionRoot: conversationRoot, sessionId: conversationId }

  const dedicatedRoot = composer?.closest('[data-dsh-mobile-session]') ?? null
  const dedicatedId = dedicatedRoot?.getAttribute('data-dsh-mobile-session')
  if (dedicatedRoot !== null && dedicatedId) return { sessionRoot: dedicatedRoot, sessionId: dedicatedId }

  if (selectedRow === null) return { sessionRoot: null, sessionId: null }
  const identity = selectedRow.getAttribute('data-session-id')
    ?? selectedRow.getAttribute('aria-label')
    ?? selectedRow.textContent?.trim()
    ?? ''
  return { sessionRoot: selectedRow, sessionId: `${selectedRowToken(selectedRow)}:${identity}` }
}

/** An id-less non-hero composer still accepts App soft-keyboard line breaks, but not camera results. */
export function activeSessionForSoftEnter(composer: Element | null, sessionId: string | null): boolean {
  return sessionId !== null || (composer !== null && composer.closest('.dshm-main') !== null && !composerIsLandingHero(composer))
}

/** Find the stock DSH application frame without mistaking a feature card for the shell. */
export function resolveNativeMobileFrame(root: ParentNode, dedicatedCenter: HTMLElement | undefined): HTMLElement | undefined {
  if (dedicatedCenter !== undefined) return undefined
  return Array.from(root.querySelectorAll<HTMLElement>('[class]')).find(candidate => {
    return classToken(candidate, '_frame')
      && firstByClassSuffix(candidate, '_sidebarCol') !== undefined
      && firstByClassSuffix(candidate, '_centerCol') !== undefined
  })
}

/**
 * Detect upstream ownership before applying legacy frame geometry.
 * @param frame - the stock frame's element lookup, if mounted.
 * @returns whether it provides the responsive sidebar opener.
 */
export function stockOwnsMobileDrawer(frame: Pick<ParentNode, 'querySelector'> | undefined): boolean {
  return frame?.querySelector('[data-sidebar-opener]') != null
}

/**
 * Mirror the classes of the stock Add-menu item on an injected attachment action.
 *
 * An empty class name is not nullish: trusting it would strip the plugin's own
 * fallback class and leave a bordered, centred UA button on that Host version.
 * A stock item that does carry classes still wins, so the injected action keeps
 * following the native menu's spacing, colours and dark-mode states.
 */
export function mediaActionClassName(nativeItem: Pick<Element, 'className'> | undefined): string {
  const nativeClass = nativeItem?.className
  const trimmed = typeof nativeClass === 'string' ? nativeClass.trim() : ''
  return trimmed === '' ? 'dsh-mobile-media-action' : trimmed
}

/** Mark every mounted settings dialog so its mobile layout does not depend on the conversation shell. */
export function markNativeMobileSettings(root: ParentNode): number {
  let marked = 0
  for (const dialog of root.querySelectorAll<HTMLElement>('[role="dialog"]')) {
    const children = Array.from(dialog.children) as HTMLElement[]
    const nav = children.find(child => classToken(child, '_nav'))
    const content = children.find(child => classToken(child, '_content'))
    if (nav === undefined) continue
    if (content === undefined) {
      const header = children.find(child => classToken(child, '_header'))
      const options = children.find(child => classToken(child, '_options'))
      const title = children.find(child => classToken(child, '_navTitle'))
      if (dialog.getAttribute('data-shortcut-modal') !== 'settings'
        || header === undefined || options === undefined || title === undefined) continue
      // The four-seat shell owns responsive grid placement and navigation.
      // Retain it; only the existing close-target treatment is shared.
      dialog.dataset.dshMobileSettings = 'grid'
      header.setAttribute('data-dsh-mobile-settings-header', 'true')
      marked += 1
      continue
    }
    dialog.dataset.dshMobileSettings = 'true'
    nav.dataset.dshMobileSettingsNav = 'true'
    content.dataset.dshMobileSettingsContent = 'true'
    firstByClassSuffix(nav, '_navList')?.setAttribute('data-dsh-mobile-settings-list', 'true')
    firstByClassSuffix(content, '_header')?.setAttribute('data-dsh-mobile-settings-header', 'true')
    firstByClassSuffix(content, '_options')?.setAttribute('data-dsh-mobile-settings-options', 'true')
    marked += 1
  }
  return marked
}

const AUTO_HISTORY_THRESHOLD_PX = 64

/** Travel, in CSS pixels, that separates a header strip pan from a tap on a chip. */
const STRIP_DRAG_THRESHOLD_PX = 8

/** Measure flowing title controls without counting an open absolute-positioned menu. */
export function measureHeaderStripOverflow(row: HTMLElement): number {
  const left = row.getBoundingClientRect().left
  const controls: Element[] = Array.from(row.children)
  const actions = row.querySelector(':scope > [class*="_titleCluster"] [class*="_headerActions"]')
  if (actions !== null) controls.push(actions)
  const right = Math.max(left, ...controls.map(control => control.getBoundingClientRect().right))
  return Math.max(0, right - left - row.clientWidth)
}

/** Touch-only pan state; browser pointer cancellation does not interrupt the touch stream. */
export function createHeaderStripPanController(options: {
  readonly range: () => number
  readonly render: (offset: number) => void
  readonly now: () => number
}) {
  let offset = 0
  let drag: { readonly x: number; readonly y: number; readonly offset: number; claimed: boolean } | undefined
  let suppressUntil = 0
  const clamp = (value: number): number => Math.min(Math.max(0, options.range()), Math.max(0, value))
  const setOffset = (value: number): void => {
    const next = clamp(value)
    if (next === offset) return
    offset = next
    options.render(offset)
  }
  const end = (): void => {
    if (drag === undefined) return
    if (drag.claimed) suppressUntil = options.now() + 400
    drag = undefined
  }
  const cancel = (): void => {
    if (drag?.claimed) suppressUntil = options.now() + 400
    drag = undefined
  }
  return {
    offset: () => offset,
    start: (x: number, y: number) => {
      drag = { x, y, offset, claimed: false }
      suppressUntil = 0
    },
    move: (x: number, y: number) => {
      if (drag === undefined) return false
      const travel = x - drag.x
      if (!drag.claimed) {
        const drift = y - drag.y
        if (Math.abs(travel) < STRIP_DRAG_THRESHOLD_PX && Math.abs(drift) < STRIP_DRAG_THRESHOLD_PX) return false
        if (Math.abs(drift) > Math.abs(travel)) { drag = undefined; return false }
        drag.claimed = true
      }
      setOffset(drag.offset - travel)
      return true
    },
    end,
    cancel,
    sync: () => {
      if (options.range() === 0) { drag = undefined; suppressUntil = 0 }
      setOffset(offset)
    },
    reveal: (left: number, right: number, visibleLeft: number, visibleRight: number) => {
      if (left < visibleLeft) setOffset(offset - (visibleLeft - left))
      else if (right > visibleRight) setOffset(offset + right - visibleRight)
    },
    resetClickSuppression: () => { suppressUntil = 0 },
    suppressClick: (inHeader: boolean, detail: number) => {
      if (suppressUntil === 0 || detail === 0) return false
      const suppress = inHeader && options.now() <= suppressUntil
      suppressUntil = 0
      return suppress
    },
    dispose: () => { drag = undefined; suppressUntil = 0; setOffset(0) },
  }
}

export type NativeMobileLanguage = 'it' | 'en' | 'zh'

interface FileDropTarget { dispatchEvent(event: Event): boolean }

/** A read-only, file-only transfer for engines without usable native constructors. */
function controlledFileTransfer(files: readonly File[], initialDropEffect: DataTransfer['dropEffect']): DataTransfer {
  const snapshot = [...files]
  const fileList: FileList = Object.assign(snapshot, { item: (index: number) => snapshot[index] ?? null })
  const items: DataTransferItemList = Object.assign(snapshot.map((file): DataTransferItem => ({
    kind: 'file', type: file.type, getAsFile: () => file,
    getAsString: () => { /* File-only items have no string data. */ },
    webkitGetAsEntry: () => null,
  })), {
    add: () => null,
    clear: () => { /* Drag payload members are read-only. */ },
    remove: () => { /* Drag payload members are read-only. */ },
  })
  Object.freeze(fileList); Object.freeze(items)
  return {
    dropEffect: initialDropEffect,
    effectAllowed: 'copy',
    files: fileList,
    items,
    types: Object.freeze(['Files']),
    clearData: () => { /* File-only drops do not carry string data. */ },
    getData: () => '',
    setData: () => { /* File-only drops do not carry string data. */ },
    setDragImage: () => { /* No drag image is painted for programmatic delivery. */ },
  }
}

function nativeFileTransfer(files: readonly File[], initialDropEffect: DataTransfer['dropEffect']): DataTransfer {
  const transfer = new DataTransfer()
  for (const file of files) if (transfer.items.add(file) === null) throw new Error('file_transfer_unavailable')
  if (transfer.files.length !== files.length) throw new Error('file_transfer_unavailable')
  transfer.effectAllowed = 'copy'; transfer.dropEffect = 'copy'
  if (transfer.effectAllowed !== 'copy' || transfer.dropEffect !== 'copy') throw new Error('file_transfer_unavailable')
  transfer.dropEffect = initialDropEffect
  if (transfer.dropEffect !== initialDropEffect) throw new Error('file_transfer_unavailable')
  return transfer
}

function controlledFileDragEvent(type: 'dragover' | 'drop', files: readonly File[], initialDropEffect: DataTransfer['dropEffect']): Event & { readonly dataTransfer: DataTransfer | null } {
  let transfer: DataTransfer
  if (typeof DataTransfer === 'function') {
    try { transfer = nativeFileTransfer(files, initialDropEffect) }
    catch (_error) { /* Some engines cannot populate transfers or change their preview effects. */ transfer = controlledFileTransfer(files, initialDropEffect) }
  } else transfer = controlledFileTransfer(files, initialDropEffect)
  if (typeof DragEvent === 'function') {
    try {
      const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer })
      if (event.dataTransfer !== null) return event
    }
    catch (_error) { /* Older engines may reject a constructed or fallback transfer. */ }
  }
  return Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer: transfer })
}

/** Ask the official document dragover listener whether the current composer accepts files. */
export function preflightComposerImageDrop(target: FileDropTarget, files: readonly File[]): boolean {
  if (files.length === 0) return false
  const event = controlledFileDragEvent('dragover', files, 'none')
  target.dispatchEvent(event)
  return event.dataTransfer?.dropEffect === 'copy'
}

/** Dispatch a real drop only after a fresh official-listener preflight; the result is not an attachment ACK. */
export function dispatchComposerImageDrop(target: FileDropTarget, files: readonly File[]): boolean {
  if (!preflightComposerImageDrop(target, files)) return false
  target.dispatchEvent(controlledFileDragEvent('drop', files, 'copy'))
  return true
}

/** Apply the resolved locale independently from the document's possibly different lang attribute. */
export function applyNativeMobileLanguageMarker(root: Pick<HTMLElement, 'dataset'>, language: NativeMobileLanguage): () => void {
  const previous = root.dataset.dshMobileLanguage
  root.dataset.dshMobileLanguage = language
  return () => {
    if (root.dataset.dshMobileLanguage !== language) return
    if (previous === undefined) delete root.dataset.dshMobileLanguage
    else root.dataset.dshMobileLanguage = previous
  }
}

/** Resolve the supported language used by native-mobile controls. */
export function resolveNativeMobileLanguage(
  documentLanguage: string,
  browserLanguages: readonly string[],
): NativeMobileLanguage {
  return [documentLanguage, ...browserLanguages]
    .map(value => value.trim().toLowerCase().split(/[-_]/u)[0])
    .find((value): value is NativeMobileLanguage => value === 'it' || value === 'en' || value === 'zh') ?? 'en'
}

/** Whether a user-driven scroll moved upward into the automatic history-loading zone. */
export function shouldAutoLoadEarlier(previousTop: number, currentTop: number): boolean {
  return currentTop <= AUTO_HISTORY_THRESHOLD_PX && currentTop < previousTop - 0.5
}

/**
 * Retain the native idle label's wrapping space while its button displays a shorter busy label.
 * @param loader - the row whose hidden sizing text shares the button's grid cell.
 * @param button - the upstream control which owns the localized idle and busy labels.
 */
export function syncHistoryLoaderLabel(
  loader: Pick<HTMLElement, 'dataset'>,
  button: Pick<HTMLButtonElement, 'disabled' | 'textContent'>,
): void {
  if (button.disabled) return
  const label = button.textContent?.trim() ?? ''
  if (loader.dataset.dshMobileHistoryLabel !== label) loader.dataset.dshMobileHistoryLabel = label
}

/**
 * Maximum gap between input or scrolling events before an unused loading intent expires.
 * A held pending intent expires without loading; a fresh gesture can create another intent.
 */
export const HISTORY_SCROLL_QUIET_MS = 1600

/**
 * One shared options object for every intent listener, so a listener is removed by
 * exactly the registration it came from. Capture keeps `wheel` and `touchmove`
 * visible even where DSH stops propagation, and is harmless for the scroller's own
 * `scroll`/`scrollend`.
 */
export const HISTORY_INTENT_LISTENER_OPTIONS: AddEventListenerOptions = { passive: true, capture: true }

/**
 * The events that carry a history-loading intent. The scroller is not focusable, so
 * there is no `keydown`: a keyboard reader scrolls it through the page instead.
 */
const HISTORY_INTENT_EVENTS = ['touchstart', 'touchmove', 'wheel', 'scroll', 'scrollend', 'touchend', 'touchcancel'] as const

export interface HistoryAutoLoadHooks {
  /** The scroller's `scrollTop`, clamped to >= 0. */
  readonly getTop: () => number
  /** Whether a move from `previousTop` to `currentTop` is an upward scroll into the zone. */
  readonly shouldLoad: (previousTop: number, currentTop: number) => boolean
  /** Click the loader button when it accepts a click; report `false` otherwise. */
  readonly tryLoad: () => boolean
  readonly schedule: (fn: () => void, ms: number) => unknown
  readonly cancel: (id: unknown) => void
}

/** Touch changes identify the contacts whose start/end this scroller actually observed. */
export interface HistoryIntentEvent {
  readonly type: string
  readonly changedTouches?: ArrayLike<{ readonly identifier: number }>
}

export interface HistoryAutoLoadGate {
  /** Process input and scrolling events belonging to the bound conversation scroller. */
  readonly handleEvent: (event: HistoryIntentEvent) => void
  /** Session switch or rebind: disarm and clear the quiet timer. */
  readonly reset: (top: number) => void
  /** Clear the quiet timer only; the binder owns listener add/remove. */
  readonly dispose: () => void
  readonly state: () => { armed: boolean; previousTop: number; pendingIntent: boolean }
}

export interface HistoryGateIdentityInput {
  /** The history gate's session id from the previous sync pass. */
  readonly previousSessionId: string | null
  /** The composer the CURRENT sync pass resolved from the live center. */
  readonly composer: Element | null
  readonly selectedRow: Element | null
  readonly selectedRowToken: (row: Element) => string
}

export interface HistoryGateIdentity {
  readonly sessionId: string | null
  /** Whether the gate must drop the previous session's arm. */
  readonly sessionChanged: boolean
}

/**
 * The history gate's session identity for one sync pass. `composer` must be the
 * composer this pass resolved itself: the media binding captures the composer
 * only later in the same sync, so resolving through that capture lags one pass
 * behind, and a session switch that reuses the scroller node while replacing
 * the composer would still report the previous session's id, skip the reset,
 * and leave the old arm live inside the new session.
 */
export function resolveHistoryGateIdentity(input: HistoryGateIdentityInput): HistoryGateIdentity {
  const { sessionId } = resolveComposerSessionOrigin(input.composer, input.selectedRow, input.selectedRowToken)
  return { sessionId, sessionChanged: sessionId !== input.previousSessionId }
}

/**
 * Decide whether a scroll near the top of the history is the user's, because DSH
 * writes `scrollTop` itself while it prepends a loaded page. An ungated listener read
 * that compensation as another upward fling, clicked "Load earlier" again, and shook
 * the view in a chain. Only fresh input arms the gate, one arm buys at most one
 * successful load, and an arm with no further input expires quietly.
 *
 * A touch-driven eligible scroll never clicks while the gesture is live: DSH retains
 * a paging anchor while a page loads, and its preservation writes fight a drag still
 * in progress. The gate records a pending intent instead and spends it only once the
 * gesture settles — a `scrollend` after every owned contact ends, or the quiet lease
 * expiring with no contact listed — and only while the reader still holds the top
 * zone. The intent dies with its arm: it is never spendable after the arm ends, and
 * the lease re-anchors ownership instead of clicking under a listed finger. Wheel
 * input outside a touch gesture keeps the immediate click: a wheel flick has no held
 * gesture to fight.
 */
export function createHistoryAutoLoadGate(hooks: HistoryAutoLoadHooks): HistoryAutoLoadGate {
  let armed = false
  let armedByWheel = false
  let pendingIntent = false
  const touchIds = new Set<number>()
  let disposed = false
  let previousTop = hooks.getTop()
  let quietPending = false
  let quietId: unknown

  const cancelQuiet = (): void => {
    if (!quietPending) return
    quietPending = false
    hooks.cancel(quietId)
    quietId = undefined
  }
  /**
   * Spend a pending loading intent only after every owned contact ends in the top zone.
   * @returns whether a load was issued.
   */
  const settle = (): boolean => {
    if (!pendingIntent || touchIds.size > 0) return false
    if (hooks.getTop() > AUTO_HISTORY_THRESHOLD_PX) {
      // The reader left the zone before settling; the intent is stale.
      pendingIntent = false
      return false
    }
    if (!hooks.tryLoad()) return false
    pendingIntent = false
    return true
  }
  const onQuiet = (): void => {
    quietPending = false
    quietId = undefined
    if (touchIds.size > 0) {
      // A listed contact keeps the gesture open: never click under a finger. An
      // intent held by the lease dies here, and its ownership is re-anchored, so
      // an undelivered touch end cannot poison later settles.
      if (pendingIntent) touchIds.clear()
      pendingIntent = false
      armed = false
      return
    }
    settle()
    armed = false
    pendingIntent = false
  }
  const restartQuiet = (): void => {
    cancelQuiet()
    if (disposed) return
    quietPending = true
    quietId = hooks.schedule(onQuiet, HISTORY_SCROLL_QUIET_MS)
  }
  const arm = (byWheel: boolean): void => {
    armed = true
    armedByWheel = byWheel
    restartQuiet()
  }
  const onScroll = (): void => {
    const top = hooks.getTop()
    const eligible = armed && hooks.shouldLoad(previousTop, top)
    // Track the top while disarmed too: a script-driven write is a fact about the
    // viewport, and hiding it would let the next drag look like a longer upward move.
    previousTop = top
    if (eligible) {
      if (armedByWheel) {
        // A wheel flick has no held gesture to fight DSH's paging anchor.
        // A refused click leaves the arm unspent for the loader's next enablement.
        if (hooks.tryLoad()) {
          armed = false
          pendingIntent = false
          cancelQuiet()
          return
        }
      } else {
        // A touch drag records its intent; the click waits for the settle.
        pendingIntent = true
      }
    }
    // Momentum keeps the scroller emitting `scroll` after the fingers lift. Every
    // one is the gesture still unfolding, so it restarts the quiet window while
    // the arm is live; a disarmed scroll must never re-arm it.
    if (armed) restartQuiet()
  }

  return {
    handleEvent: event => {
      if (disposed) return
      switch (event.type) {
        case 'touchstart': {
          const changed = Array.from(event.changedTouches ?? [])
          if (changed.length === 0) break
          // A new gesture cannot spend an intent left by a previously refused load.
          if (touchIds.size === 0) pendingIntent = false
          for (const touch of changed) touchIds.add(touch.identifier)
          arm(false)
          break
        }
        case 'touchmove':
          if (Array.from(event.changedTouches ?? []).some(touch => touchIds.has(touch.identifier))) arm(false)
          break
        case 'wheel':
          // A listed contact keeps wheel input on the deferred path even after
          // an unused arm expires. Contact-free wheel input still loads immediately.
          if (touchIds.size === 0) pendingIntent = false
          arm(touchIds.size === 0)
          break
        case 'touchend':
        case 'touchcancel': {
          let endedOwnedTouch = false
          for (const touch of Array.from(event.changedTouches ?? [])) {
            if (touchIds.delete(touch.identifier)) endedOwnedTouch = true
          }
          if (endedOwnedTouch) restartQuiet()
          break
        }
        case 'scrollend': {
          if (pendingIntent && settle()) {
            armed = false
            cancelQuiet()
            break
          }
          if (pendingIntent) {
            // A live contact still owns the gesture, or the loader refused the
            // click: the intent waits for the next settle. The lease bounds the wait.
            restartQuiet()
            break
          }
          armed = false
          cancelQuiet()
          break
        }
        case 'scroll':
          onScroll()
          break
        default:
          break
      }
    },
    reset: top => {
      armed = false
      armedByWheel = false
      pendingIntent = false
      // The finger belonged to the previous session or node; it cannot arm this one.
      touchIds.clear()
      previousTop = top
      cancelQuiet()
    },
    dispose: () => {
      disposed = true
      armed = false
      armedByWheel = false
      pendingIntent = false
      touchIds.clear()
      cancelQuiet()
    },
    state: () => ({ armed, previousTop, pendingIntent }),
  }
}

/** Observe descendant input but only this scroller's movement; return its listener disposer. */
export function bindHistoryAutoLoadGate(scroller: EventTarget, gate: Pick<HistoryAutoLoadGate, 'handleEvent'>): () => void {
  const onEvent = (event: Event): void => {
    if ((event.type === 'scroll' || event.type === 'scrollend') && event.target !== scroller) return
    gate.handleEvent(event)
  }
  for (const type of HISTORY_INTENT_EVENTS) scroller.addEventListener(type, onEvent, HISTORY_INTENT_LISTENER_OPTIONS)
  return () => {
    for (const type of HISTORY_INTENT_EVENTS) scroller.removeEventListener(type, onEvent, HISTORY_INTENT_LISTENER_OPTIONS)
  }
}

/**
 * Whether the overlay scrim belongs on screen. The scrim exists for the
 * slide-in drawer only — it dims the page and catches the tap that closes the
 * drawer — so it is shown while that drawer is open *and* the overlay query is
 * in force. `hidden` carries the whole decision rather than the width rules
 * alone: the attribute still hides the element when the injected stylesheet
 * never lands (a CSP without inline styles, a shell that drops the <style>
 * node), where the element would otherwise fall back to the UA button box.
 */
export function drawerScrimVisible(sidebarCollapsed: boolean, overlayActive: boolean): boolean {
  return !sidebarCollapsed && overlayActive
}

interface StockMobileBackLayers {
  readonly detailsOpen: boolean
  readonly drawerOpen: boolean
  readonly mainPanelOpen: boolean
}

interface StockMobileBackActions {
  closeDetails(): void
  closeDrawer(): void
  closeMainPanel(): void
}

/** Let the stock page close one visible layer before Android navigates its WebView. */
export function installStockMobileBack(
  view: Window,
  current: () => StockMobileBackLayers | null,
  actions: StockMobileBackActions,
): () => void {
  const onBack = (event: Event): void => {
    if (!event.cancelable || event.defaultPrevented) return
    const layers = current()
    if (layers === null) return
    if (layers.detailsOpen) {
      event.preventDefault()
      actions.closeDetails()
    } else if (layers.drawerOpen) {
      event.preventDefault()
      actions.closeDrawer()
    } else if (layers.mainPanelOpen) {
      event.preventDefault()
      actions.closeMainPanel()
    }
  }
  view.addEventListener('dsh-mobile:native-back', onBack)
  return () => { view.removeEventListener('dsh-mobile:native-back', onBack) }
}

interface StockLayoutBackControl {
  closeRightbar?: () => void
  selectPanel?: (panelId: null) => void
  panelInfo?: { getSnapshot?: () => unknown }
}

function stockLayoutBackControl(value: unknown): StockLayoutBackControl | undefined {
  return typeof value === 'object' && value !== null ? value as StockLayoutBackControl : undefined
}

/** Whether the stock layout can return from a selected main panel. */
export function stockMainPanelOpen(value: unknown): boolean {
  const layout = stockLayoutBackControl(value)
  if (typeof layout?.selectPanel !== 'function' || typeof layout.panelInfo?.getSnapshot !== 'function') return false
  const snapshot = layout.panelInfo.getSnapshot()
  return typeof snapshot === 'object' && snapshot !== null
    && typeof (snapshot as { activePanelId?: unknown }).activePanelId === 'string'
}

interface NativeMobileBackServices {
  getLayout(): unknown
  getSidebarRight(): unknown
}

interface SoftEnterContext {
  readonly nativeState: { readonly imeVisible: boolean; readonly noHardwareKeyboard: boolean } | null | undefined
  readonly editable: boolean
  readonly activeSession: boolean
  readonly commandMenuOpen: boolean
  readonly recentlyComposing: boolean
}

/** Only a known on-screen keyboard in an active App composer may change Enter into a line break. */
export function isSoftKeyboardEnterLineBreak(event: KeyboardEvent, context: SoftEnterContext): boolean {
  if (context.nativeState?.imeVisible !== true || context.nativeState.noHardwareKeyboard !== true
    || !context.editable || !context.activeSession || context.commandMenuOpen || context.recentlyComposing) return false
  if (!event.isTrusted || event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat) return false
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.getModifierState('AltGraph')
}

/** Attach the App-only Enter translation while retaining DSH's original physical-key semantics. */
export function bindComposerSoftEnter(editor: HTMLElement, context: () => Omit<SoftEnterContext, 'recentlyComposing'>): () => void {
  let composing = false
  let composingUntil = 0
  const onCompositionStart = (): void => { composing = true }
  const onCompositionEnd = (): void => { composing = false; composingUntil = performance.now() + 10 }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isSoftKeyboardEnterLineBreak(event, {
      ...context(),
      recentlyComposing: composing || editor.hasAttribute('data-composer-composing') || performance.now() < composingUntil,
    })) return
    event.preventDefault()
    event.stopImmediatePropagation()
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
      composed: true,
    }))
  }
  editor.addEventListener('compositionstart', onCompositionStart)
  editor.addEventListener('compositionend', onCompositionEnd)
  editor.addEventListener('keydown', onKeyDown, { capture: true })
  return () => {
    editor.removeEventListener('compositionstart', onCompositionStart)
    editor.removeEventListener('compositionend', onCompositionEnd)
    editor.removeEventListener('keydown', onKeyDown, { capture: true })
  }
}

/**
 * Touch-primary device hint for the browser Enter translation. Duplicates the literal of
 * `TOUCH_PRIMARY_QUERY` in mobile-layout.ts, which builds a separate bundle entry that
 * this module must not import; a source test keeps the two from drifting apart.
 */
const BROWSER_TOUCH_PRIMARY_QUERY = '(hover: none), (pointer: coarse)'

/** The stock composer editor a phone-browser Enter may keep as a native line break. */
export const BROWSER_COMPOSER_EDITOR_QUERY = '[data-composer-input][contenteditable="true"]'

interface ComposerNativeBridgeIndicators {
  readonly __DSH_MOBILE_NATIVE__?: unknown
  readonly dshMobileNative?: unknown
}

/**
 * Whether the App adapter or its earlier origin-scoped WebMessage channel owns Enter.
 * @param view - the page's current native bridge indicators.
 * @returns true without assuming that native keyboard state is already available.
 */
export function nativeAppOwnsComposerEnter(view: ComposerNativeBridgeIndicators): boolean {
  const channel = view.dshMobileNative
  return view.__DSH_MOBILE_NATIVE__ !== undefined
    || (typeof channel === 'object' && channel !== null && 'postMessage' in channel
      && typeof channel.postMessage === 'function')
}

interface BrowserSoftEnterContext {
  /** Whether the Android App reserves Enter translation for native keyboard proof. */
  readonly appBridge: boolean
  /** Whether the touch-primary device hint currently matches. */
  readonly browserTouch: boolean
  readonly editable: boolean
  readonly activeSession: boolean
  readonly commandMenuOpen: boolean
  readonly recentlyComposing: boolean
  /**
   * Whether the composer holds a draft. Stock no-ops a plain Enter on an empty draft
   * (its submit refuses), and translating it would insert an invisible line break into
   * the empty editor — perceived as a swallowed key — and leak a leading newline into
   * the next typed draft, so only real drafts keep the native line break.
   */
  readonly hasDraft: boolean
}

/**
 * Whether a phone-browser plain Enter keeps its native editing action instead of reaching
 * DSH's submit shortcut. Unlike the App gate there is no soft-keyboard proof, so this
 * mirrors the shipped question-card policy: the touch-primary hint plus the same event,
 * editor, and IME guards. A held key (`repeat`) keeps the native behavior every editor
 * has, and already-prevented or modified Enters stay under stock control — Cmd/Ctrl+Enter
 * keeps its stock submit path, which is how an attached hardware keyboard still sends.
 */
export function isBrowserTouchEnterLineBreak(event: KeyboardEvent, context: BrowserSoftEnterContext): boolean {
  if (context.appBridge || !context.browserTouch || !context.editable || !context.activeSession
    || context.commandMenuOpen || context.recentlyComposing || !context.hasDraft) return false
  if (!event.isTrusted || event.key !== 'Enter' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return false
  return !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.getModifierState('AltGraph')
}

/**
 * Whether the stock composer still holds a draft. Mirrors `composerHasDraft` in
 * mobile-layout.ts, which builds a separate bundle entry this module must not import;
 * keep the two shapes aligned (checked against text, embedded decorators, attachments).
 */
function browserComposerHasDraft(editor: HTMLElement, card: HTMLElement): boolean {
  return (editor.textContent ?? '').replaceAll('\u200b', '').trim() !== ''
    || editor.querySelector('[contenteditable="false"],[data-lexical-decorator],img') !== null
    || card.querySelector('[data-slot="conversation.input.attachments"] [role="group"] > *') !== null
}

/** Document-level composition window shared by every editor the browser binding covers. */
export interface DocumentCompositionGuard {
  recentlyComposing(): boolean
  dispose(): void
}

/**
 * Composition tracking for the document-capture Enter translation. iOS Safari fires the
 * composition-confirming Enter with `isComposing === false` in the same task as
 * `compositionend`, so ownership extends ten milliseconds past the event — the same window
 * the stock composer and the App binder use.
 */
export function createDocumentCompositionGuard(target: EventTarget): DocumentCompositionGuard {
  let composing = false
  let composingUntil = 0
  const onCompositionStart = (): void => { composing = true }
  const onCompositionEnd = (): void => { composing = false; composingUntil = performance.now() + 10 }
  target.addEventListener('compositionstart', onCompositionStart, { capture: true })
  target.addEventListener('compositionend', onCompositionEnd, { capture: true })
  return {
    recentlyComposing: () => composing || performance.now() < composingUntil,
    dispose: () => {
      target.removeEventListener('compositionstart', onCompositionStart, { capture: true })
      target.removeEventListener('compositionend', onCompositionEnd, { capture: true })
    },
  }
}

/** The stock editor and its composer card located from a keydown target. */
export interface BrowserComposerTarget {
  readonly editor: HTMLElement
  readonly card: HTMLElement
}

/** Locate the stock composer editor under a keydown target: the editor itself or a node inside it. */
export function resolveBrowserComposerEditor(target: EventTarget | null): BrowserComposerTarget | null {
  const candidate = target as { closest?: (selector: string) => HTMLElement | null } | null
  if (candidate === null || typeof candidate.closest !== 'function') return null
  const editor = candidate.closest.call(target as object, BROWSER_COMPOSER_EDITOR_QUERY)
  if (editor === null) return null
  const card = editor.closest<HTMLElement>('[data-composer-card]')
  return card === null ? null : { editor, card }
}

/**
 * Phone-browser Enter translation for the stock composer. Lexical refuses keydown Enter
 * on Apple browsers and performs the line break from the native `beforeinput` flow, so
 * unlike the App binding this hides the keydown with `stopPropagation` only — no
 * `preventDefault`, no synthetic event — letting the browser's own insertParagraph produce
 * the same draft line break desktop Shift+Enter yields, while stock submit never runs.
 * `stopPropagation` (never the immediate variant) keeps same-node document listeners such
 * as the send-keyboard typing tracker and the question-card handler running. Document
 * capture runs before React root handlers and needs no per-editor binding lifecycle.
 */
export function bindBrowserComposerSoftEnter(
  view: Document,
  context: (editor: HTMLElement, card: HTMLElement) => Omit<BrowserSoftEnterContext, 'browserTouch' | 'recentlyComposing' | 'hasDraft'>,
): () => void {
  const guard = createDocumentCompositionGuard(view)
  const touchPrimary = typeof window === 'object' && typeof window.matchMedia === 'function'
    ? window.matchMedia(BROWSER_TOUCH_PRIMARY_QUERY)
    : undefined
  const onKeyDown = (event: KeyboardEvent): void => {
    const target = resolveBrowserComposerEditor(event.target)
    if (target === null) return
    if (!isBrowserTouchEnterLineBreak(event, {
      ...context(target.editor, target.card),
      browserTouch: touchPrimary?.matches === true,
      hasDraft: browserComposerHasDraft(target.editor, target.card),
      recentlyComposing: guard.recentlyComposing() || target.editor.hasAttribute('data-composer-composing'),
    })) return
    event.stopPropagation()
  }
  view.addEventListener('keydown', onKeyDown, { capture: true })
  return () => {
    view.removeEventListener('keydown', onKeyDown, { capture: true })
    guard.dispose()
  }
}

interface ComposerMediaOrigin {
  readonly generation: number
  readonly href: string
  readonly composer: object | null
  readonly sessionRoot: object | null
  readonly sessionId: string | null
}

/** Check that an asynchronous picker result still belongs to its originating session and composer. */
export function isComposerMediaOriginCurrent(
  origin: ComposerMediaOrigin,
  current: ComposerMediaOrigin & { readonly disposed: boolean; readonly composerConnected: boolean },
): boolean {
  return !current.disposed
    && origin.generation === current.generation
    && origin.href === current.href
    && origin.composer !== null
    && current.composerConnected
    && origin.composer === current.composer
    && origin.sessionRoot !== null
    && origin.sessionRoot === current.sessionRoot
    && origin.sessionId !== null
    && origin.sessionId === current.sessionId
}

/**
 * The App action that leaves the page for its paired-computer list. Mirrors the literal the
 * General-settings row invokes; the gesture below reads the same name from the bridge
 * capability list, so an App that does not advertise it keeps the stock drawer behavior.
 */
export const SWITCH_COMPUTER_NATIVE_ACTION = 'mobile.switch-computer'
/** The drawer toggle: the whale mark the collapsed header pins into its top-left corner. */
export const NATIVE_MOBILE_TOGGLE_QUERY = '[data-dsh-mobile-toggle]'
/** Hold on the drawer toggle that asks the App to list the paired computers. */
export const SWITCH_COMPUTER_LONG_PRESS_MS = 500
/** Pointer travel that turns the hold back into a scroll, drag, or drawer swipe. */
export const SWITCH_COMPUTER_MOVE_TOLERANCE_PX = 14
/** Keeps the drawer from following the finger Android lifts at the end of a completed hold. */
export const SWITCH_COMPUTER_CLICK_SUPPRESSION_MS = 1200

interface SwitchComputerHoldOptions {
  readonly now: () => number
  readonly setTimer: (callback: () => void, delayMs: number) => number
  readonly clearTimer: (handle: number) => void
  /** Whether this App build advertises the paired-computer list action. */
  readonly canSwitchComputer: () => Promise<boolean> | boolean
  /** Ask the App to open its paired-computer list. */
  readonly switchComputer: () => void
}

export interface SwitchComputerHold {
  /** Arm a hold; a new press replaces any earlier one. */
  start(x: number, y: number): void
  /** Pointer travel beyond the tolerance turns the hold into ordinary navigation. */
  move(x: number, y: number): void
  /** Release or cancel: stop the timer, and keep a fired hold's click suppression. */
  end(): void
  /** Consume the suppression window for the click Android synthesizes after a hold. */
  consumeClickSuppression(detail: number): boolean
  /** Whether a long-press menu belongs to this gesture instead of the toggle. */
  blocksContextMenu(): boolean
  dispose(): void
}

/**
 * Hold policy for the collapsed header's drawer toggle. The App owns the paired-computer
 * list, so a hold only acts once the bridge advertises the action; every other press keeps
 * the stock toggle. DOM events stay in the installer so this policy stays testable.
 */
export function createSwitchComputerHold(options: SwitchComputerHoldOptions): SwitchComputerHold {
  let hold: { readonly x: number; readonly y: number; timer: number; fired: boolean } | undefined
  let supported = false
  let probing = false
  let disposed = false
  let suppressClickUntil = 0
  let firedAt = 0

  const probeSupport = (): void => {
    if (disposed || supported || probing) return
    probing = true
    void Promise.resolve().then(options.canSwitchComputer).then(value => {
      probing = false
      if (!disposed && value) supported = true
    }, () => { probing = false })
  }

  const stopTimer = (): void => {
    if (hold === undefined) return
    options.clearTimer(hold.timer)
    hold = undefined
  }

  const fire = (current: { timer: number; fired: boolean }): void => {
    if (hold !== current || current.fired || !supported) return
    current.fired = true
    firedAt = options.now()
    suppressClickUntil = firedAt + SWITCH_COMPUTER_CLICK_SUPPRESSION_MS
    options.switchComputer()
  }

  return {
    start: (x, y) => {
      if (disposed) return
      stopTimer()
      suppressClickUntil = 0
      firedAt = 0
      probeSupport()
      const current = { x, y, timer: 0, fired: false }
      current.timer = options.setTimer(() => fire(current), SWITCH_COMPUTER_LONG_PRESS_MS)
      hold = current
    },
    move: (x, y) => {
      if (hold === undefined || hold.fired) return
      if (Math.abs(x - hold.x) > SWITCH_COMPUTER_MOVE_TOLERANCE_PX
        || Math.abs(y - hold.y) > SWITCH_COMPUTER_MOVE_TOLERANCE_PX) stopTimer()
    },
    end: stopTimer,
    consumeClickSuppression: detail => {
      if (detail === 0 || suppressClickUntil === 0 || options.now() > suppressClickUntil) return false
      suppressClickUntil = 0
      return true
    },
    blocksContextMenu: () => firedAt !== 0 && options.now() - firedAt <= SWITCH_COMPUTER_CLICK_SUPPRESSION_MS,
    dispose: () => {
      disposed = true
      stopTimer()
      suppressClickUntil = 0
      firedAt = 0
    },
  }
}

/** Add mobile semantics without replacing feature trees. */
export function installNativeMobileSurface(backServices: NativeMobileBackServices): () => void {
  document.documentElement.classList.add('dsh-native-mobile-active')
  const browserLanguages = navigator.languages.length > 0 ? navigator.languages : [navigator.language]
  const language = resolveNativeMobileLanguage(document.documentElement.lang, browserLanguages)
  const restoreLanguageMarker = applyNativeMobileLanguageMarker(document.documentElement, language)
  const label = (italian: string, english: string, chinese: string): string => language === 'it' ? italian : language === 'zh' ? chinese : english
  const mediaIcon = (): SVGSVGElement => {
    const namespace = 'http://www.w3.org/2000/svg'
    const icon = document.createElementNS(namespace, 'svg')
    icon.setAttribute('viewBox', '0 0 16 16')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('aria-hidden', 'true')
    const body = document.createElementNS(namespace, 'path')
    body.setAttribute('d', 'M5.15 3.2 6.05 2h3.9l.9 1.2h1.45c1.05 0 1.9.85 1.9 1.9v6c0 1.05-.85 1.9-1.9 1.9H3.7a1.9 1.9 0 0 1-1.9-1.9v-6c0-1.05.85-1.9 1.9-1.9h1.45Zm-1.45 1.3a.6.6 0 0 0-.6.6v6c0 .33.27.6.6.6h8.6a.6.6 0 0 0 .6-.6v-6a.6.6 0 0 0-.6-.6h-2.1l-.9-1.2H6.7l-.9 1.2H3.7Z')
    body.setAttribute('fill', 'currentColor')
    const lens = document.createElementNS(namespace, 'circle')
    lens.setAttribute('cx', '8')
    lens.setAttribute('cy', '8.1')
    lens.setAttribute('r', '2.15')
    lens.setAttribute('stroke', 'currentColor')
    lens.setAttribute('stroke-width', '1.3')
    icon.append(body, lens)
    return icon
  }
  const createMediaAction = (text: string, kind: 'camera' | 'gallery' = 'camera'): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dsh-mobile-media-action'
    button.lang = language
    button.dataset.dshMobileMediaAction = kind
    button.setAttribute('role', 'option')
    button.setAttribute('aria-selected', 'false')
    button.setAttribute('aria-label', text)
    const icon = document.createElement('span')
    const graphic = mediaIcon()
    if (kind === 'gallery') {
      graphic.replaceChildren()
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', 'M2 2h12v12H2z M2 11l4-4 3 3 2-2 3 3 M10 5h.01')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', '1.3')
      path.setAttribute('stroke-linejoin', 'round')
      graphic.append(path)
    }
    icon.append(graphic)
    button.append(icon)
    const caption = document.createElement('span')
    caption.textContent = text
    button.append(caption)
    return button
  }
  const setInputMode = (mode: 'keyboard' | 'touch'): void => {
    document.documentElement.dataset.dshMobileInput = mode
  }
  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' || event.pointerType === 'pen') setInputMode('touch')
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Tab' || event.key.startsWith('Arrow')) setInputMode('keyboard')
  }
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('keydown', onKeyDown, true)
  const switchComputerHold = createSwitchComputerHold({
    now: () => window.performance.now(),
    setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimer: handle => { window.clearTimeout(handle) },
    canSwitchComputer: async () => {
      const bridge = window.__DSH_MOBILE_NATIVE__
      if (bridge === undefined) return false
      try {
        return (await bridge.capabilities()).includes(SWITCH_COMPUTER_NATIVE_ACTION)
      } catch {
        return false
      }
    },
    switchComputer: () => {
      const bridge = window.__DSH_MOBILE_NATIVE__
      if (bridge === undefined) return
      void Promise.resolve().then(() => bridge.invoke(SWITCH_COMPUTER_NATIVE_ACTION, {})).catch(() => undefined)
    },
  })
  const isDrawerToggleTarget = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest(NATIVE_MOBILE_TOGGLE_QUERY) !== null
  const onTogglePointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary || event.button !== 0 || !isDrawerToggleTarget(event.target)) return
    switchComputerHold.start(event.clientX, event.clientY)
  }
  const onTogglePointerMove = (event: PointerEvent): void => {
    switchComputerHold.move(event.clientX, event.clientY)
  }
  const onTogglePointerEnd = (): void => { switchComputerHold.end() }
  const onToggleVisibilityChange = (): void => { if (document.hidden) switchComputerHold.end() }
  const onToggleClickCapture = (event: MouseEvent): void => {
    if (!isDrawerToggleTarget(event.target) || !switchComputerHold.consumeClickSuppression(event.detail)) return
    event.preventDefault()
    event.stopPropagation()
  }
  const onToggleContextMenu = (event: Event): void => {
    if (!isDrawerToggleTarget(event.target) || !switchComputerHold.blocksContextMenu()) return
    event.preventDefault()
    event.stopPropagation()
  }
  document.addEventListener('pointerdown', onTogglePointerDown, true)
  document.addEventListener('pointermove', onTogglePointerMove, true)
  document.addEventListener('pointerup', onTogglePointerEnd, true)
  document.addEventListener('pointercancel', onTogglePointerEnd, true)
  document.addEventListener('click', onToggleClickCapture, true)
  document.addEventListener('contextmenu', onToggleContextMenu, true)
  window.addEventListener('blur', onTogglePointerEnd)
  document.addEventListener('visibilitychange', onToggleVisibilityChange)
  // The scrim is drawer chrome: it belongs on screen only while the overlay
  // query matches. A resize crosses that breakpoint without touching the DOM
  // the observer below watches, so the query wakes the same sync pass itself.
  const overlayQuery = window.matchMedia(NATIVE_MOBILE_OVERLAY_QUERY)
  const backdrop = document.createElement('button')
  backdrop.type = 'button'
  backdrop.className = 'dsh-native-mobile-backdrop'
  backdrop.lang = language
  backdrop.hidden = true
  backdrop.setAttribute('aria-label', label('Chiudi navigazione area di lavoro', 'Close workspace navigation', '关闭工作区导航'))
  document.body.append(backdrop)
  const branchToast = document.createElement('div')
  branchToast.className = 'dsh-mobile-branch-toast'
  branchToast.lang = language
  branchToast.setAttribute('role', 'status')
  branchToast.setAttribute('aria-live', 'polite')
  document.body.append(branchToast)
  const mediaToast = document.createElement('div')
  mediaToast.className = 'dsh-mobile-media-toast'
  mediaToast.lang = language
  mediaToast.setAttribute('role', 'status')
  mediaToast.setAttribute('aria-live', 'polite')
  document.body.append(mediaToast)
  const cameraButton = createMediaAction(label('Scatta foto', 'Take photo', '拍照'))
  cameraButton.disabled = true
  const galleryButton = createMediaAction(label('Galleria', 'Gallery', '相册'), 'gallery')
  galleryButton.disabled = true
  let galleryBusy = false
  let branchToastTimer = 0
  let mediaToastTimer = 0
  const showMediaToast = (message: string): void => {
    mediaToast.textContent = message
    mediaToast.dataset.visible = 'true'
    if (mediaToastTimer !== 0) window.clearTimeout(mediaToastTimer)
    mediaToastTimer = window.setTimeout(() => {
      mediaToast.removeAttribute('data-visible')
      mediaToastTimer = 0
    }, 2200)
  }
  let mediaRequestGeneration = 0
  let disposed = false
  let boundComposer: Element | null = null
  let boundSessionRoot: Element | null = null
  let boundSessionId: string | null = null
  const preflightFile = new File([], 'dsh-mobile-preflight.png', { type: 'image/png' })
  const canAcceptComposerDrop = (): boolean => preflightComposerImageDrop(document, [preflightFile])
  const mediaPickerAbortController = new AbortController()
  let boundEnterEditor: HTMLElement | null = null
  let boundEnterCard: HTMLElement | null = null
  let disposeEnterBinding: (() => void) | undefined
  const sessionTokens = new WeakMap<Element, string>()
  let nextSessionToken = 0
  type MediaRequestContext = ComposerMediaOrigin & { readonly composer: Element | null; readonly sessionRoot: Element | null }
  const sessionRowToken = (row: Element): string => {
    let token = sessionTokens.get(row)
    if (token === undefined) { token = `stock-${String(++nextSessionToken)}`; sessionTokens.set(row, token) }
    return token
  }
  const currentSessionOrigin = (): { readonly sessionRoot: Element | null; readonly sessionId: string | null } => {
    const selectedRow = document.querySelector<Element>('[role="treeitem"][aria-selected="true"]')
    return resolveComposerSessionOrigin(boundComposer, selectedRow, sessionRowToken)
  }
  // The origin-scoped App channel exists before its onLoaded adapter. Neither
  // presence proves a soft keyboard; native keyboard state remains authoritative.
  const disposeBrowserComposerSoftEnter = bindBrowserComposerSoftEnter(document, (editor, composerCard) => ({
    appBridge: nativeAppOwnsComposerEnter(window),
    editable: editor.isConnected && editor.getAttribute('contenteditable') === 'true'
      && editor.getAttribute('aria-disabled') !== 'true' && editor.getAttribute('aria-haspopup') !== 'menu'
      && composerCard.getAttribute('aria-busy') !== 'true' && editor.getAttribute('inputmode') !== 'none',
    activeSession: activeSessionForSoftEnter(composerCard, currentSessionOrigin().sessionId),
    commandMenuOpen: composerCard.querySelector('[data-trigger-menu],button[aria-haspopup="listbox"][aria-expanded="true"]') !== null,
  }))
  const mediaRequestContext = (): MediaRequestContext => {
    const session = currentSessionOrigin()
    return {
      generation: ++mediaRequestGeneration,
      href: window.location.href,
      composer: boundComposer,
      ...session,
    }
  }
  const mediaRequestIsCurrent = (context: MediaRequestContext): boolean => {
    const session = currentSessionOrigin()
    const composer = boundComposer
    return isComposerMediaOriginCurrent(context, {
      generation: mediaRequestGeneration,
      href: window.location.href,
      composer,
      sessionRoot: session.sessionRoot,
      sessionId: session.sessionId,
      disposed,
      composerConnected: context.composer?.isConnected === true,
    })
  }
  const deliverImages = (files: readonly File[], context: ReturnType<typeof mediaRequestContext>): void => {
    if (files.length === 0 || !mediaRequestIsCurrent(context)) return
    if (!dispatchComposerImageDrop(document, files)) showMediaToast(label('Allegati immagine non disponibili', 'Image attachments are unavailable', '图片附件不可用'))
  }
  const launchBrowserCamera = (context: ReturnType<typeof mediaRequestContext>): void => {
    void pickBrowserFiles({ accept: 'image/*', capture: 'environment', signal: mediaPickerAbortController.signal }).then(files => {
      if (files !== undefined) deliverImages(files, context)
    }).catch((_error: unknown) => {
      if (mediaRequestIsCurrent(context)) showMediaToast(label('Impossibile aggiungere la foto', 'Could not attach the photo', '无法附加照片'))
    })
  }
  const dismissCommandMenu = (): void => {
    const trigger = boundComposer?.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"][aria-expanded="true"]')
    trigger?.click()
  }
  const addGroupLabel = label('Aggiungi', 'Add', '添加')
  const placeCameraAction = (commandMenu: HTMLElement): boolean => {
    const sectionTitle = Array.from(commandMenu.querySelectorAll<HTMLElement>('[role="listbox"] [role="presentation"]'))
      .find(candidate => !candidate.hasAttribute('data-source') && candidate.textContent?.trim() === addGroupLabel)
    if (sectionTitle === undefined) {
      cameraButton.remove()
      galleryButton.remove()
      return false
    }

    // Reuse the current DSH option classes so this injected action follows the
    // native menu's spacing, colors, and dark-mode states instead of creating a
    // second mobile-only visual language.
    const nativeItem = (() => {
      let sibling = sectionTitle.nextElementSibling
      while (sibling instanceof HTMLElement && sibling.getAttribute('role') !== 'presentation') {
        if (!sibling.hasAttribute('data-dsh-mobile-media-action') && sibling.matches('button[role="option"]:not([aria-selected="true"])')) return sibling
        sibling = sibling.nextElementSibling
      }
      return undefined
    })()
    for (const button of [cameraButton, galleryButton]) {
      const className = mediaActionClassName(nativeItem)
      if (button.className !== className) button.className = className
      const icon = button.firstElementChild
      const caption = button.lastElementChild
      const nativeIcon = nativeItem === undefined ? undefined : firstByClassSuffix(nativeItem, '_itemIcon')
      const nativeLabel = nativeItem === undefined ? undefined : firstByClassSuffix(nativeItem, '_itemName')
      if (icon instanceof HTMLElement && nativeIcon !== undefined && icon.className !== nativeIcon.className) icon.className = nativeIcon.className
      if (caption instanceof HTMLElement && nativeLabel !== undefined && caption.className !== nativeLabel.className) caption.className = nativeLabel.className
    }

    let lastItem: Element = sectionTitle
    let sibling = sectionTitle.nextElementSibling
    while (sibling instanceof HTMLElement && sibling.getAttribute('role') !== 'presentation') {
      if (sibling !== cameraButton && sibling !== galleryButton) lastItem = sibling
      sibling = sibling.nextElementSibling
    }
    // Only the dedicated Mobile page promotes attachment actions. Keep every
    // official item in its original relative order (File remains first among them).
    if (boundComposer?.closest('.dshm-main') !== null && boundComposer !== null) {
      if (galleryButton.parentElement !== sectionTitle.parentElement || galleryButton.previousElementSibling !== sectionTitle) sectionTitle.after(galleryButton)
      if (cameraButton.parentElement !== galleryButton.parentElement || cameraButton.previousElementSibling !== galleryButton) galleryButton.after(cameraButton)
    } else {
      galleryButton.remove()
      // Preserve the existing camera placement on stock/desktop pages.
      if (cameraButton.parentElement !== sectionTitle.parentElement || cameraButton.previousElementSibling !== lastItem) lastItem.after(cameraButton)
    }
    return true
  }
  const setCameraActionDisabled = (disabled: boolean, title: string): void => {
    if (cameraButton.disabled !== disabled) cameraButton.disabled = disabled
    if (cameraButton.title !== title) cameraButton.title = title
    const galleryDisabled = disabled || galleryBusy
    if (galleryButton.disabled !== galleryDisabled) galleryButton.disabled = galleryDisabled
    const galleryTitle = disabled ? title : label('Scegli immagini da allegare', 'Choose images to attach', '选择图片并附加到当前消息')
    if (galleryButton.title !== galleryTitle) galleryButton.title = galleryTitle
  }
  const quietMediaPointer = (event: PointerEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const active = document.activeElement
    if (active instanceof HTMLElement && (active.matches('input,textarea') || active.isContentEditable)) active.blur()
  }
  const takePhoto = (): void => {
    if (!canAcceptComposerDrop()) {
      setCameraActionDisabled(true, label('Allegati immagine non disponibili', 'Image attachments are unavailable', '图片附件不可用'))
      dismissCommandMenu()
      return
    }
    const context = mediaRequestContext()
    dismissCommandMenu()
    const bridge = window.__DSH_MOBILE_NATIVE__
    if (bridge === undefined) {
      launchBrowserCamera(context)
      return
    }
    void Promise.resolve().then(() => bridge.invoke('camera.capture', {})).then(value => {
      if (!mediaRequestIsCurrent(context)) return
      if (value instanceof File) deliverImages([value], context)
      else showMediaToast(label('La foto scattata non è utilizzabile', 'The captured photo is unavailable', '所拍照片不可用'))
    }).catch((error: unknown) => {
      if (!mediaRequestIsCurrent(context)) return
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
      if (code === 'cancelled') return
      showMediaToast(code === 'payload_too_large'
        ? label('La foto supera il limite di 8 MiB', 'The photo exceeds the 8 MiB limit', '照片超过 8 MiB 限制')
        : label('Impossibile aggiungere la foto', 'Could not attach the photo', '无法附加照片'))
    })
  }
  const chooseGallery = (): void => {
    if (disposed || galleryBusy || galleryButton.disabled || boundComposer?.closest('.dshm-main') == null) return
    if (!canAcceptComposerDrop()) {
      setCameraActionDisabled(true, label('Allegati immagine non disponibili', 'Image attachments are unavailable', '图片附件不可用'))
      dismissCommandMenu()
      return
    }
    const context = mediaRequestContext()
    galleryBusy = true
    galleryButton.disabled = true
    galleryButton.setAttribute('aria-busy', 'true')
    dismissCommandMenu()
    void pickBrowserFiles({ accept: 'image/*', multiple: true, signal: mediaPickerAbortController.signal }).then(files => {
      if (files !== undefined) deliverImages(files, context)
    }).catch((_error: unknown) => {
      if (mediaRequestIsCurrent(context)) showMediaToast(label('Impossibile aggiungere le immagini', 'Could not attach the images', '无法附加图片'))
    }).finally(() => {
      galleryBusy = false
      galleryButton.removeAttribute('aria-busy')
      if (!disposed) schedule()
    })
  }
  galleryButton.addEventListener('pointerdown', quietMediaPointer)
  galleryButton.addEventListener('click', chooseGallery)
  cameraButton.addEventListener('pointerdown', quietMediaPointer)
  cameraButton.addEventListener('click', takePhoto)
  const showBranchToast = (): void => {
    const header = document.querySelector<HTMLElement>('[data-dsh-mobile-header]')
    const title = header === null ? undefined : header.querySelector<HTMLElement>('[class*="_crumbCurrent"]')?.textContent?.trim()
    const prefix = label('Ramo corrente', 'Current branch', '当前分支')
    branchToast.textContent = title === undefined ? prefix : `${prefix}: ${title}`
    branchToast.dataset.visible = 'true'
    if (branchToastTimer !== 0) window.clearTimeout(branchToastTimer)
    branchToastTimer = window.setTimeout(() => {
      branchToast.removeAttribute('data-visible')
      branchToastTimer = 0
    }, 1600)
  }
  const onBranchClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const branch = event.target.closest<HTMLButtonElement>('button[aria-label*="分支"],button[aria-label*="Branch"],button[aria-label*="branch"],button[aria-label*="Ramo"],button[aria-label*="ramo"]')
    if (branch === null || branch.hasAttribute('disabled') || branch.getAttribute('aria-disabled') === 'true') return
    window.setTimeout(showBranchToast, 80)
  }
  // The title row's popovers must travel with their triggers, so pan with a transform
  // instead of an overflow scroller.
  let stripHeader: HTMLElement | undefined
  const stripParts = (): { readonly row: HTMLElement; readonly lead: HTMLElement | undefined } | undefined => {
    const row = stripHeader?.querySelector<HTMLElement>('[class*="_titleRow"]')
    if (row === undefined || row === null) return undefined
    return { row, lead: stripHeader?.querySelector<HTMLElement>('[class*="_headerLeading"]') ?? undefined }
  }
  const stripRange = (): number => {
    const parts = stripParts()
    if (!overlayQuery.matches || parts === undefined) return 0
    const overflow = measureHeaderStripOverflow(parts.row)
    return overflow > 1 ? overflow : 0
  }
  const applyStrip = (offset: number): void => {
    const parts = stripParts()
    if (parts === undefined) return
    const value = offset === 0 ? '' : `translateX(${-offset}px)`
    if (parts.row.style.transform !== value) parts.row.style.transform = value
    if (parts.lead !== undefined && parts.lead.style.transform !== value) parts.lead.style.transform = value
  }
  const pan = createHeaderStripPanController({
    range: stripRange,
    render: applyStrip,
    now: () => performance.now(),
  })
  const syncPanHeader = (header: HTMLElement | undefined): void => {
    if (header !== stripHeader) {
      pan.dispose()
      stripHeader = header
    }
    pan.sync()
    applyStrip(pan.offset())
  }
  let activeTouchId: number | undefined
  const onStripTouchStart = (event: TouchEvent): void => {
    if (activeTouchId !== undefined) pan.cancel()
    activeTouchId = undefined
    pan.resetClickSuppression()
    if (event.touches.length !== 1) return
    if (!overlayQuery.matches) return
    if (!(event.target instanceof Element)) return
    if (event.target.closest('[data-dsh-mobile-header]') !== stripHeader) return
    if (event.target.closest('[data-dsh-mobile-header] [class*="_titleRow"],[data-dsh-mobile-header] [class*="_headerLeading"]') === null) return
    if (stripRange() === 0) return
    const touch = event.touches[0]
    if (touch === undefined) return
    activeTouchId = touch.identifier
    pan.start(touch.clientX, touch.clientY)
  }
  const onStripTouchMove = (event: TouchEvent): void => {
    if (activeTouchId === undefined) return
    if (event.touches.length !== 1) { activeTouchId = undefined; pan.cancel(); return }
    const touch = event.touches[0]
    if (touch === undefined || touch.identifier !== activeTouchId) return
    if (pan.move(touch.clientX, touch.clientY)) event.preventDefault()
  }
  const onStripTouchEnd = (event: TouchEvent): void => {
    if (activeTouchId === undefined || !Array.from(event.changedTouches).some(touch => touch.identifier === activeTouchId)) return
    activeTouchId = undefined
    pan.end()
  }
  const onStripTouchCancel = (event: TouchEvent): void => {
    if (activeTouchId === undefined || !Array.from(event.changedTouches).some(touch => touch.identifier === activeTouchId)) return
    activeTouchId = undefined
    pan.cancel()
  }
  const onStripFocus = (event: FocusEvent): void => {
    if (!(event.target instanceof HTMLElement)) return
    const header = event.target.closest<HTMLElement>('[data-dsh-mobile-header]')
    if (header === null || header !== stripHeader || stripRange() === 0 || event.target.closest('[class*="_titleRow"],[class*="_headerLeading"]') === null) return
    const focused = event.target.getBoundingClientRect()
    const visible = header.getBoundingClientRect()
    pan.reveal(focused.left, focused.right, visible.left + 42, visible.right - 8)
  }
  const onStripClickCapture = (event: MouseEvent): void => {
    const inHeader = event.target instanceof Element && event.target.closest('[data-dsh-mobile-header]') !== null
    if (!pan.suppressClick(inHeader, event.detail)) return
    event.preventDefault()
    event.stopPropagation()
  }
  document.addEventListener('touchstart', onStripTouchStart, true)
  document.addEventListener('touchmove', onStripTouchMove, { capture: true, passive: false })
  document.addEventListener('touchend', onStripTouchEnd, true)
  document.addEventListener('touchcancel', onStripTouchCancel, true)
  document.addEventListener('focusin', onStripFocus, true)
  document.addEventListener('click', onStripClickCapture, true)
  document.addEventListener('click', onBranchClick, true)
  const sidebarScrollMemory = installMobileSidebarScrollMemory()
  let frame: HTMLElement | undefined
  let sidebar: HTMLElement | undefined
  let sidebarRoot: HTMLElement | undefined
  let toggle: HTMLButtonElement | undefined
  let viewArea: HTMLElement | undefined
  let scheduled = 0
  let transitionFrame = 0
  let transitionRestartFrame = 0
  let transitionTimer = 0
  let transitionTarget: HTMLElement | undefined
  let historyScroller: HTMLElement | undefined
  let historySessionId: string | null = null
  let disposeHistoryGate: (() => void) | undefined
  let historyLoaderBinding: { readonly element: HTMLElement; readonly originalLabel: string | undefined } | undefined
  const historyLabelObserver = new MutationObserver(() => schedule())
  const bindHistoryLoader = (next: HTMLElement | undefined): void => {
    if (historyLoaderBinding?.element === next) return
    historyLabelObserver.disconnect()
    if (historyLoaderBinding !== undefined) {
      const { element, originalLabel } = historyLoaderBinding
      if (originalLabel === undefined) delete element.dataset.dshMobileHistoryLabel
      else element.dataset.dshMobileHistoryLabel = originalLabel
    }
    historyLoaderBinding = next === undefined ? undefined : { element: next, originalLabel: next.dataset.dshMobileHistoryLabel }
    // Native locale changes may replace only the button's text node.
    if (next !== undefined) historyLabelObserver.observe(next, { childList: true, characterData: true, subtree: true })
  }
  const historyLoadButton = (): HTMLButtonElement | undefined => {
    const loader = historyScroller === undefined ? undefined : firstByClassSuffix(historyScroller, '_older')
    return loader?.querySelector<HTMLButtonElement>('button') ?? undefined
  }
  const historyAutoLoadGate = createHistoryAutoLoadGate({
    getTop: () => Math.max(0, historyScroller?.scrollTop ?? 0),
    shouldLoad: shouldAutoLoadEarlier,
    tryLoad: () => {
      const button = historyLoadButton()
      if (button === undefined || button.disabled || button.getAttribute('aria-disabled') === 'true') return false
      button.click()
      return true
    },
    schedule: (fn, ms) => window.setTimeout(fn, ms),
    cancel: id => { window.clearTimeout(id as number) },
  })
  /**
   * Rebind the gate to the conversation scroller, and drop an arm that belongs to a
   * session the reader has already left: DSH can reuse the same scroller node, so the
   * session identity has to be checked even when the node did not change. The
   * composer is this pass's own resolution, never the media binding's capture.
   */
  const bindHistoryScroller = (next: HTMLElement | undefined, composer: Element | null): void => {
    if (historyScroller !== next) {
      disposeHistoryGate?.()
      disposeHistoryGate = undefined
      historyScroller = next
      historyAutoLoadGate.reset(next?.scrollTop ?? 0)
      if (next !== undefined) disposeHistoryGate = bindHistoryAutoLoadGate(next, historyAutoLoadGate)
    }
    const identity = resolveHistoryGateIdentity({
      previousSessionId: historySessionId,
      composer,
      selectedRow: document.querySelector<Element>('[role="treeitem"][aria-selected="true"]'),
      selectedRowToken: sessionRowToken,
    })
    historySessionId = identity.sessionId
    if (!identity.sessionChanged) return
    historyAutoLoadGate.reset(historyScroller?.scrollTop ?? 0)
  }
  const animateNavigation = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const trigger = event.target.closest<HTMLElement>('button,a,[role="tab"],[aria-selected]')
    if (trigger === null || trigger.hasAttribute('disabled') || trigger.getAttribute('aria-disabled') === 'true') return
    if (trigger.getAttribute('aria-selected') === 'true' || trigger.getAttribute('aria-current') === 'true') return
    const settingsNavigation = trigger.closest('[data-dsh-mobile-settings-list]') !== null
    const conversationNavigation = trigger.matches('[role="tab"]')
    const sidebarNavigation = trigger.closest('[data-dsh-mobile-sidebar-root]') !== null
      && trigger.closest('[data-dsh-mobile-toggle]') === null
    if (!settingsNavigation && !conversationNavigation && !sidebarNavigation) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    if (transitionFrame !== 0) cancelAnimationFrame(transitionFrame)
    if (transitionRestartFrame !== 0) cancelAnimationFrame(transitionRestartFrame)
    transitionFrame = requestAnimationFrame(() => {
      transitionFrame = 0
      const target = settingsNavigation
        ? document.querySelector<HTMLElement>('[data-dsh-mobile-settings-content]')
        : viewArea
      if (target === null || target === undefined) return
      transitionTarget?.removeAttribute('data-dsh-mobile-view-transition')
      target.removeAttribute('data-dsh-mobile-view-transition')
      transitionRestartFrame = requestAnimationFrame(() => {
        transitionRestartFrame = 0
        transitionTarget = target
        target.dataset.dshMobileViewTransition = 'true'
        if (transitionTimer !== 0) clearTimeout(transitionTimer)
        transitionTimer = window.setTimeout(() => {
          target.removeAttribute('data-dsh-mobile-view-transition')
          if (transitionTarget === target) transitionTarget = undefined
          transitionTimer = 0
        }, 240)
      })
    })
  }
  document.addEventListener('click', animateNavigation)
  const syncComposerEnterNewline = (composerCard: HTMLElement | null): void => {
    const editor = composerCard?.querySelector<HTMLElement>('[data-composer-input][contenteditable="true"]') ?? null
    if (editor === boundEnterEditor && composerCard === boundEnterCard) return
    disposeEnterBinding?.()
    boundEnterEditor = editor
    boundEnterCard = composerCard
    disposeEnterBinding = editor === null || composerCard === null ? undefined : bindComposerSoftEnter(editor, () => ({
      nativeState: window.__DSH_MOBILE_NATIVE__ === undefined ? null : window.__DSH_MOBILE_KEYBOARD_STATE__,
      editable: editor.isConnected && editor.getAttribute('contenteditable') === 'true'
        && editor.getAttribute('aria-disabled') !== 'true' && editor.getAttribute('aria-haspopup') !== 'menu'
        && composerCard.getAttribute('aria-busy') !== 'true',
      activeSession: activeSessionForSoftEnter(composerCard, currentSessionOrigin().sessionId),
      commandMenuOpen: composerCard.querySelector('[data-trigger-menu],button[aria-haspopup="listbox"][aria-expanded="true"]') !== null,
    }))
  }
  const syncMediaBinding = (composer: Element | null): void => {
    const previousComposer = boundComposer
    boundComposer = composer
    const session = currentSessionOrigin()
    if (composer === previousComposer && session.sessionRoot === boundSessionRoot && session.sessionId === boundSessionId) return
    boundSessionRoot = session.sessionRoot
    boundSessionId = session.sessionId
    mediaRequestGeneration += 1
  }

  const sync = (): void => {
    scheduled = 0
    const dedicatedCenter = document.querySelector<HTMLElement>('.dshm-main') ?? undefined
    const nextFrame = resolveNativeMobileFrame(document, dedicatedCenter)
    if (frame !== nextFrame) frame?.removeAttribute('data-dsh-mobile-frame')
    frame = nextFrame
    const nativeDrawer = stockOwnsMobileDrawer(frame)
    if (frame !== undefined) {
      if (nativeDrawer) frame.removeAttribute('data-dsh-mobile-frame')
      else frame.dataset.dshMobileFrame = 'true'
    }
    if (nativeDrawer) {
      sidebar?.removeAttribute('data-dsh-mobile-sidebar')
      sidebarRoot?.removeAttribute('data-dsh-mobile-sidebar-root')
      toggle?.removeAttribute('data-dsh-mobile-toggle')
      for (const node of frame!.querySelectorAll('[data-dsh-mobile-details],[data-dsh-mobile-handle]')) {
        node.removeAttribute('data-dsh-mobile-details')
        node.removeAttribute('data-dsh-mobile-handle')
      }
      sidebarRoot = undefined
      toggle = undefined
      backdrop.hidden = true
    }
    sidebar = nativeDrawer ? undefined : frame === undefined
      ? document.querySelector<HTMLElement>('.dshm-drawer') ?? undefined
      : firstByClassSuffix(frame, '_sidebarCol')
    const center = frame === undefined ? dedicatedCenter : firstByClassSuffix(frame, '_centerCol')
    const details = frame === undefined || nativeDrawer ? undefined : firstByClassSuffix(frame, '_detailsCol')
    const handle = frame === undefined || nativeDrawer ? undefined : firstByClassSuffix(frame, '_handle')
    markNativeMobileSettings(document)
    if (center === undefined) {
      syncPanHeader(undefined)
      syncComposerEnterNewline(null)
      bindHistoryScroller(undefined, null)
      bindHistoryLoader(undefined)
      syncMediaBinding(null)
      setCameraActionDisabled(true, label('Apri prima una sessione', 'Open a session first', '请先打开会话'))
      cameraButton.remove()
      galleryButton.remove()
      return
    }
    if (center !== undefined) {
      if (nativeDrawer) center.removeAttribute('data-dsh-mobile-center')
      else center.dataset.dshMobileCenter = 'true'
      const header = center.querySelector<HTMLElement>('header') ?? undefined
      if (nativeDrawer) header?.removeAttribute('data-dsh-mobile-header')
      else header?.setAttribute('data-dsh-mobile-header', 'true')
      syncPanHeader(nativeDrawer ? undefined : header)
      viewArea = firstByClassSuffix(center, '_viewArea')
      if (nativeDrawer) viewArea?.removeAttribute('data-dsh-mobile-view')
      else if (viewArea !== undefined) viewArea.dataset.dshMobileView = 'true'
      const conversation = center.querySelector<HTMLElement>('[data-conversation-scroll]')
      // Resolved before the binder call: the history gate's session identity is
      // read from this pass's composer, not the media binding's later capture.
      const composerCard = center.querySelector<HTMLElement>('[data-composer-card]')
      bindHistoryScroller(conversation ?? undefined, composerCard ?? null)
      const historyLoader = conversation === null ? undefined : firstByClassSuffix(conversation, '_older')
      bindHistoryLoader(historyLoader)
      if (historyLoader !== undefined) {
        historyLoader.dataset.dshMobileHistoryLoader = 'true'
        historyLoader.setAttribute('aria-live', 'polite')
        const button = historyLoader.querySelector<HTMLButtonElement>('button')
        if (button !== null) {
          syncHistoryLoaderLabel(historyLoader, button)
        }
      }
      const messageColumn = conversation === null ? undefined : firstByClassSuffix(conversation, '_column')
      const messageScroll = messageColumn?.parentElement
      if (messageColumn !== undefined && messageScroll !== null && messageScroll !== undefined && classToken(messageScroll, '_scroll')) {
        messageColumn.dataset.dshMobileMessageColumn = 'true'
        messageScroll.dataset.dshMobileMessageScroll = 'true'
      }
      for (const table of center.querySelectorAll<HTMLTableElement>('table')) {
        const parent = table.parentElement
        if (parent?.dataset.dshMobileTableScroll === 'true') continue
        const wrapper = document.createElement('div')
        wrapper.dataset.dshMobileTableScroll = 'true'
        table.before(wrapper)
        wrapper.append(table)
      }
      const composerRow = composerCard?.querySelector<HTMLElement>(':scope > [data-input-scroll]')?.nextElementSibling
      if (!(composerRow instanceof HTMLElement)) {
        syncComposerEnterNewline(null)
        syncMediaBinding(null)
        setCameraActionDisabled(true, label('Apri prima una sessione', 'Open a session first', '请先打开会话'))
        cameraButton.remove()
        galleryButton.remove()
      }
      if (composerRow instanceof HTMLElement) {
        composerRow.dataset.dshMobileComposerRow = 'true'
        const groups = Array.from(composerRow.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
        const composerTools = groups[0]
        const composerTrailing = groups.at(-1)
        if (composerTools !== undefined) {
          composerTools.dataset.dshMobileComposerTools = 'true'
          syncMediaBinding(composerCard ?? null)
          syncComposerEnterNewline(composerCard ?? null)
          const composerInput = composerCard?.querySelector<HTMLTextAreaElement>('textarea')
          const composerEditor = composerCard?.querySelector<HTMLElement>('[contenteditable="true"],[contenteditable="plaintext-only"]')
          const composerBusy = composerCard?.getAttribute('aria-busy') === 'true'
            || composerInput?.disabled === true
            || composerInput?.readOnly === true
            || composerEditor?.getAttribute('aria-disabled') === 'true'
          const attachmentBlocked = !canAcceptComposerDrop()
          const mediaDisabled = conversation === null || currentSessionOrigin().sessionId === null || composerBusy || attachmentBlocked
          const mediaTitle = composerBusy
            ? label('Attendi il completamento della risposta', 'Wait for the response to finish', '请等待回复完成')
            : attachmentBlocked
              ? label('Allegati immagine non disponibili', 'Image attachments are unavailable', '图片附件不可用')
              : mediaDisabled
                ? label('Apri prima una sessione', 'Open a session first', '请先打开会话')
                : label('Scatta una foto e allegala', 'Take a photo and attach it', '拍照并附加到当前消息')
          setCameraActionDisabled(mediaDisabled, mediaTitle)
          const commandMenu = composerCard?.querySelector<HTMLElement>('[data-trigger-menu]') ?? null
          if (commandMenu !== null) placeCameraAction(commandMenu)
          else { cameraButton.remove(); galleryButton.remove() }
        } else syncComposerEnterNewline(null)
        if (composerTrailing !== undefined && composerTrailing !== composerTools) {
          composerTrailing.dataset.dshMobileComposerTrailing = 'true'
          const modelTrigger = composerTrailing.querySelector<HTMLButtonElement>('button[aria-label^="选择模型"],button[aria-label^="Select model"],button[aria-label^="Seleziona modello"]')
          if (modelTrigger !== null) {
            const controls = modelTrigger.closest<HTMLElement>('[class*="_standardControls"]')
            if (controls !== null) controls.dataset.dshMobileComposerControls = 'true'
            modelTrigger.dataset.dshMobileComposerModelTrigger = 'true'
            modelTrigger.parentElement?.setAttribute('data-dsh-mobile-composer-model', 'true')
            modelTrigger.querySelector<HTMLElement>('[class*="_triggerLabel"]')?.setAttribute('data-dsh-mobile-composer-model-label', 'true')
          }
        }
      }
    }
    if (handle !== undefined) handle.dataset.dshMobileHandle = 'true'
    if (details !== undefined) {
      details.dataset.dshMobileDetails = 'true'
      const lastColumn = frame?.style.gridTemplateColumns.trim().split(/\s+/).at(-1)
      details.dataset.open = String(lastColumn !== undefined && lastColumn !== '0px' && lastColumn !== '0')
    }
    if (sidebar === undefined) { sidebarScrollMemory.sync(); return }
    sidebar.dataset.dshMobileSidebar = 'true'
    toggle = firstByClassSuffix(sidebar, '_toggle') as HTMLButtonElement | undefined
    let candidate = toggle?.parentElement
    while (candidate !== undefined && candidate !== null && candidate !== sidebar && !classToken(candidate, '_root')) candidate = candidate.parentElement
    sidebarRoot = candidate !== sidebar && candidate !== null ? candidate : undefined
    if (sidebarRoot === undefined) return
    sidebarRoot.dataset.dshMobileSidebarRoot = 'true'
    for (const brand of sidebarRoot.querySelectorAll<HTMLElement>('[class*="_fallbackBrandName"]')) {
      if (brand.textContent?.trim() === 'DSH Local Build') brand.textContent = 'DeepSeek Harness'
    }
    if (toggle !== undefined) toggle.dataset.dshMobileToggle = 'true'
    // The dedicated layout owns data-open directly. DSH's delayed collapsed
    // class describes its fade animation, not the drawer's logical state.
    if (frame !== undefined) sidebar.dataset.open = String(!classToken(sidebarRoot, '_collapsed'))
    backdrop.hidden = frame === undefined || !drawerScrimVisible(classToken(sidebarRoot, '_collapsed'), overlayQuery.matches)
    sidebarScrollMemory.sync()
  }
  const schedule = (): void => { if (scheduled === 0) scheduled = requestAnimationFrame(sync) }
  const observer = new MutationObserver(schedule)
  // React publishes the band after resize; read the committed marker.
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'disabled', 'readonly', 'aria-busy', 'aria-selected', 'data-dsh-mobile-session', WIDE_LAYOUT_ATTRIBUTE] })
  overlayQuery.addEventListener('change', schedule)
  backdrop.addEventListener('click', () => { if (sidebar?.dataset.open === 'true') toggle?.click() })
  sync()
  const stopStockBack = installStockMobileBack(window, () => {
    if (frame?.isConnected !== true) return null
    const lastColumn = frame.style.gridTemplateColumns.trim().split(/\s+/).at(-1)
    return {
      detailsOpen: overlayQuery.matches && lastColumn !== undefined && lastColumn !== ''
        && lastColumn !== '0px' && lastColumn !== '0',
      drawerOpen: overlayQuery.matches && sidebarRoot?.isConnected === true
        && toggle?.isConnected === true && !classToken(sidebarRoot, '_collapsed'),
      mainPanelOpen: stockMainPanelOpen(backServices.getLayout()),
    }
  }, {
    closeDetails: () => {
      const layout = stockLayoutBackControl(backServices.getLayout())
      if (typeof layout?.closeRightbar !== 'function') return
      const sidebarRight = backServices.getSidebarRight()
      if (typeof sidebarRight === 'object' && sidebarRight !== null) {
        const control = sidebarRight as { isExpanded?: () => boolean; toggleExpanded?: () => void }
        if (typeof control.isExpanded === 'function' && typeof control.toggleExpanded === 'function'
          && control.isExpanded()) control.toggleExpanded()
      }
      layout.closeRightbar()
    },
    closeDrawer: () => { toggle?.click() },
    closeMainPanel: () => {
      const layout = stockLayoutBackControl(backServices.getLayout())
      if (typeof layout?.selectPanel === 'function') layout.selectPanel(null)
    },
  })
  const disposeTaskWatcher = installTaskCompletionWatcher({
    // Current gateways announce exact root turn completion. The DOM watcher
    // remains only for explicit pending-input cards, avoiding false completion
    // reminders from unrelated page mutations.
    completionFallback: false,
    label: (kind: TaskNotifyKind, sessionLabel: string) => kind === 'done'
      ? {
          title: label('Attività completata', 'Task finished', '任务已完成'),
          body: sessionLabel === ''
            ? label('Il tuo task DSH è terminato', 'Your DSH task finished', '你的 DSH 任务已完成')
            : label(`Il tuo task DSH è terminato: ${sessionLabel}`, `Your DSH task finished: ${sessionLabel}`, `你的 DSH 任务已完成：${sessionLabel}`),
        }
      : {
          title: label('È richiesto un input', 'Input needed', '需要你确认'),
          body: label('DSH attende una tua scelta', 'DSH waits for your choice', 'DSH 等待你的选择'),
        },
  })
  return () => {
    disposed = true
    stopStockBack()
    sidebarScrollMemory.dispose()
    disposeTaskWatcher()
    mediaRequestGeneration += 1
    mediaPickerAbortController.abort()
    restoreLanguageMarker()
    disposeEnterBinding?.()
    disposeBrowserComposerSoftEnter()
    observer.disconnect()
    overlayQuery.removeEventListener('change', schedule)
    document.removeEventListener('click', onBranchClick, true)
    document.removeEventListener('touchstart', onStripTouchStart, true)
    document.removeEventListener('touchmove', onStripTouchMove, true)
    document.removeEventListener('touchend', onStripTouchEnd, true)
    document.removeEventListener('touchcancel', onStripTouchCancel, true)
    document.removeEventListener('focusin', onStripFocus, true)
    document.removeEventListener('click', onStripClickCapture, true)
    pan.dispose()
    applyStrip(0)
    cameraButton.removeEventListener('pointerdown', quietMediaPointer)
    cameraButton.removeEventListener('click', takePhoto)
    galleryButton.removeEventListener('pointerdown', quietMediaPointer)
    galleryButton.removeEventListener('click', chooseGallery)
    galleryButton.remove()
    if (branchToastTimer !== 0) window.clearTimeout(branchToastTimer)
    if (mediaToastTimer !== 0) window.clearTimeout(mediaToastTimer)
    branchToast.remove()
    mediaToast.remove()
    cameraButton.remove()
    if (scheduled !== 0) cancelAnimationFrame(scheduled)
    if (transitionFrame !== 0) cancelAnimationFrame(transitionFrame)
    if (transitionRestartFrame !== 0) cancelAnimationFrame(transitionRestartFrame)
    if (transitionTimer !== 0) clearTimeout(transitionTimer)
    transitionTarget?.removeAttribute('data-dsh-mobile-view-transition')
    disposeHistoryGate?.()
    disposeHistoryGate = undefined
    historyAutoLoadGate.dispose()
    bindHistoryLoader(undefined)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('pointerdown', onTogglePointerDown, true)
    document.removeEventListener('pointermove', onTogglePointerMove, true)
    document.removeEventListener('pointerup', onTogglePointerEnd, true)
    document.removeEventListener('pointercancel', onTogglePointerEnd, true)
    document.removeEventListener('click', onToggleClickCapture, true)
    document.removeEventListener('contextmenu', onToggleContextMenu, true)
    window.removeEventListener('blur', onTogglePointerEnd)
    document.removeEventListener('visibilitychange', onToggleVisibilityChange)
    switchComputerHold.dispose()
    document.removeEventListener('click', animateNavigation)
    backdrop.remove()
    document.documentElement.classList.remove('dsh-native-mobile-active')
    delete document.documentElement.dataset.dshMobileInput
  }
}
