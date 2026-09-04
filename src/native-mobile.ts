/** Mobile feature and compatibility rules applied to DSH React surfaces. */
export const NATIVE_MOBILE_STYLES = `
@media (max-width:720px) {
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
  html.dsh-native-mobile-active [data-dsh-mobile-sidebar] [class*="_rowActions"] button { box-sizing:border-box !important; width:32px !important; min-width:32px !important; height:32px !important; min-height:32px !important; }
  [data-dsh-mobile-frame] { grid-template-columns:0 minmax(0,1fr) 0 !important; width:100% !important; height:100dvh !important; overflow:hidden !important; }
  [data-dsh-mobile-center] { grid-column:2 !important; width:100vw !important; min-width:0 !important; }
  [data-dsh-mobile-center] > * { min-width:0 !important; }
  [data-dsh-mobile-header] { box-sizing:border-box !important; width:calc(100% - 16px) !important; margin:0 8px !important; min-width:0; padding-top:max(4px,env(safe-area-inset-top)) !important; padding-right:8px !important; padding-left:42px !important; }
  [data-dsh-mobile-header] [class*="_titleRow"] { box-sizing:border-box !important; display:flex !important; align-items:center !important; min-width:0; min-height:32px !important; height:32px !important; gap:6px !important; padding:0 6px !important; }
  [data-dsh-mobile-header] [class*="_titleCluster"] { min-width:0; }
  [data-dsh-mobile-header] [class*="_crumbs"] { min-width:0; overflow:hidden; }
  [data-dsh-mobile-header] [class*="_crumb"] { max-width:46vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  [data-dsh-mobile-header] [class*="_headerActions"] { min-width:0; overflow-x:auto; scrollbar-width:none; }
  [data-dsh-mobile-header] [class*="_headerActions"]::-webkit-scrollbar { display:none; }
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
  [data-dsh-mobile-sidebar][data-open="true"] [data-dsh-mobile-sidebar-root] [class*="_logoRow"] { height:52px !important; padding:4px 0 4px 4px !important; margin-bottom:4px !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] { width:0 !important; border:0 !important; background:transparent !important; box-shadow:none !important; overflow:visible !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :not(:has([data-dsh-mobile-toggle])) { display:none !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :has([data-dsh-mobile-toggle]) { position:fixed !important; z-index:244 !important; top:env(safe-area-inset-top) !important; left:0 !important; box-sizing:border-box !important; width:50px !important; height:52px !important; padding:4px !important; border:0 !important; background:transparent !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-sidebar-root] > :has([data-dsh-mobile-toggle]) > :not([data-dsh-mobile-toggle]) { display:none !important; }
  [data-dsh-mobile-toggle] { width:44px !important; height:44px !important; min-width:44px !important; min-height:44px !important; }
  [data-dsh-mobile-sidebar][data-open="false"] [data-dsh-mobile-toggle] > svg[class*="_railFish"] { transform:translateY(-4px) !important; }
  .dsh-native-mobile-backdrop { position:fixed; z-index:235; inset:env(safe-area-inset-top) 0 0; border:0; background:rgb(15 23 42 / 32%); }
  .dsh-native-mobile-backdrop:not([hidden]) { animation:dsh-mobile-fade-in var(--dsh-mobile-motion-duration) ease-out; }
  .dsh-native-mobile-backdrop[hidden] { display:none; }
  [data-dsh-mobile-details] { position:fixed !important; z-index:250 !important; inset:0 0 0 auto !important; width:min(94vw,460px) !important; max-width:none !important; transform:translateX(100%); transition:transform var(--dsh-mobile-motion-duration) var(--dsh-mobile-motion-ease); background:var(--dsw-bg, #fff); box-shadow:-18px 0 46px rgb(15 23 42 / 18%); }
  [data-dsh-mobile-details][data-open="true"] { transform:translateX(0); }
  [data-dsh-mobile-handle] { display:none !important; }
  [data-dsh-mobile-settings] { flex-direction:column !important; width:100vw !important; height:100dvh !important; max-width:none !important; border-radius:0 !important; animation:dsh-mobile-panel-in var(--dsh-mobile-motion-duration) var(--dsh-mobile-motion-ease); }
  [data-dsh-mobile-settings-nav] { flex:none !important; width:100% !important; padding:max(14px,env(safe-area-inset-top)) 12px 8px !important; gap:10px !important; border-bottom:1px solid var(--dsw-alias-border-subtle,#e8ebef); }
  [data-dsh-mobile-settings-nav] [class*="_navTitle"] { padding:0 8px !important; font-size:18px !important; line-height:28px !important; }
  [data-dsh-mobile-settings-list] { flex-direction:row !important; gap:4px !important; overflow-x:auto !important; scrollbar-width:none; }
  [data-dsh-mobile-settings-list]::-webkit-scrollbar { display:none; }
  [data-dsh-mobile-settings-list] [class*="_navCell"] { flex:0 0 auto !important; min-width:max-content !important; height:44px !important; padding:10px 12px !important; }
  [data-dsh-mobile-settings-list] [aria-current="true"] { border-color:transparent !important; outline:0 !important; box-shadow:none !important; }
  [data-dsh-mobile-settings-content] { flex:1 1 auto !important; width:100% !important; min-height:0 !important; }
  [data-dsh-mobile-settings-header] { height:48px !important; min-height:48px !important; padding:10px 12px 6px !important; }
  [data-dsh-mobile-settings-header] [class*="_close"] { width:36px !important; height:36px !important; }
  [data-dsh-mobile-settings-options] { box-sizing:border-box !important; width:100% !important; padding:4px 16px max(24px,env(safe-area-inset-bottom)) !important; overflow-x:hidden !important; }
  [data-dsh-mobile-settings-options] > * { width:100% !important; min-width:0 !important; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] > [class*="_row"] { flex-direction:column !important; align-items:stretch !important; gap:12px !important; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] [class*="_rowText"] { width:100% !important; padding-right:0 !important; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] [class*="_selector"] { box-sizing:border-box !important; align-self:flex-start !important; justify-content:space-between !important; min-width:0 !important; min-height:44px !important; max-width:100% !important; }
  [data-dsh-mobile-settings-options] :is(input,select,textarea,button) { max-width:100%; }
  [data-dsh-mobile-settings-options] :is(input,select,textarea) { box-sizing:border-box; width:100%; min-width:0; }
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
  [data-dsh-mobile-center] textarea { font-size:16px !important; }
  /* Markdown tables use content-sized columns. Small tables fill the phone;
     wider tables keep readable cells and scroll inside their own region. */
  [data-dsh-mobile-table-scroll] { box-sizing:border-box; width:100%; max-width:100%; overflow-x:auto; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch; }
  [data-dsh-mobile-table-scroll] table { display:table !important; width:max-content !important; min-width:100% !important; max-width:none !important; table-layout:auto !important; }
  [data-dsh-mobile-table-scroll] :is(th,td) { box-sizing:border-box; min-width:8ch; max-width:32ch; overflow-wrap:anywhere; word-break:break-word; vertical-align:top; }
  [data-dsh-mobile-center] pre { max-width:100%; overflow-x:auto; }
  [data-dsh-mobile-center] :is(img,video,canvas,svg) { max-width:100%; }
  [data-dsh-mobile-message-scroll] { box-sizing:border-box !important; width:100% !important; padding:8px 10px 20px !important; }
  [data-dsh-mobile-history-loader] { position:relative !important; min-height:1px !important; }
  [data-dsh-mobile-history-loader] button:not(:disabled) { position:absolute !important; width:1px !important; height:1px !important; margin:-1px !important; padding:0 !important; clip-path:inset(50%) !important; opacity:0 !important; overflow:hidden !important; pointer-events:none !important; }
  [data-dsh-mobile-history-loader] button:disabled { min-height:28px !important; padding:4px 12px !important; }
  [data-dsh-mobile-message-column] { box-sizing:border-box !important; width:100% !important; max-width:none !important; margin:0 !important; padding:0 !important; gap:10px !important; }
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
  [data-dsh-mobile-center] [data-composer-card] ~ [class*="_root"],
  [data-dsh-mobile-center] [data-composer-card] ~ * [class*="_root"] { box-sizing:border-box !important; width:100% !important; max-width:100% !important; margin-bottom:-6px !important; padding:3px 4px 0 !important; font-size:11px !important; line-height:18px !important; white-space:normal !important; overflow:visible !important; text-overflow:clip !important; }
  [data-dsh-mobile-center] [data-composer-card] ~ [class*="_root"] [class*="_sep"],
  [data-dsh-mobile-center] [data-composer-card] ~ * [class*="_root"] [class*="_sep"] { margin:0 6px !important; }
  /* Composer dock stats strip (turns/steps/tokens) reads small on phones. */
  [data-dsh-mobile-center] [data-slot="conversation.composer.dock"] [class*="_root"] { font-size:10px !important; line-height:16px !important; }
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
  .dsh-mobile-branch-toast,.dsh-mobile-media-toast { position:fixed; z-index:330; top:max(12px,env(safe-area-inset-top)); left:50%; max-width:calc(100vw - 32px); box-sizing:border-box; padding:7px 14px; border:1px solid rgb(15 23 42 / 10%); border-radius:999px; background:rgb(15 23 42 / 92%); color:#fff; font-size:13px; line-height:20px; text-align:center; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; opacity:0; pointer-events:none; transform:translate(-50%,-8px); transition:opacity 160ms ease,transform 160ms ease; }
  .dsh-mobile-branch-toast[data-visible="true"],.dsh-mobile-media-toast[data-visible="true"] { opacity:1; transform:translate(-50%,0); }
  .dsh-mobile-media-shortcuts { box-sizing:border-box; display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; width:100%; padding:4px 4px 8px; margin-bottom:4px; border-bottom:1px solid var(--dsw-alias-border-inverted,var(--dsw-alias-border-subtle,rgb(148 163 184 / 28%))); }
  .dsh-mobile-media-action { box-sizing:border-box; display:flex; align-items:center; justify-content:flex-start; gap:8px; width:100%; min-width:0; min-height:44px; padding:8px 10px; border:0; border-radius:10px; background:var(--dsw-alias-interactive-bg-hover,rgb(148 163 184 / 12%)); color:var(--dsw-alias-label-primary,inherit); cursor:pointer; font:inherit; font-size:14px; line-height:22px; text-align:left; touch-action:manipulation; }
  .dsh-mobile-media-action:active { opacity:.72; }
  .dsh-mobile-media-action:focus-visible { outline:2px solid var(--dsw-alias-interactive-border-focus,#4c82f7); outline-offset:1px; }
  .dsh-mobile-media-action:disabled { cursor:default; opacity:.38; }
  .dsh-mobile-media-action svg { flex:none; width:16px; height:16px; color:var(--dsw-alias-label-tertiary,currentColor); }
  .dsh-mobile-media-action span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  [data-dsh-mobile-center] [class*="_composer"] { padding-left:8px !important; padding-right:8px !important; padding-bottom:max(8px,env(safe-area-inset-bottom)) !important; }
  /* The desktop composer intentionally wraps whole toolbar groups. On a phone,
     dynamic model and status labels made that row alternate between one and
     two lines. Keep two stable columns and let only the model label shrink. */
  [data-dsh-mobile-composer-row] { display:grid !important; grid-template-columns:max-content minmax(0,1fr) !important; align-items:center !important; gap:4px 8px !important; }
  [data-dsh-mobile-composer-tools] { display:flex !important; flex-wrap:nowrap !important; width:max-content !important; min-width:0 !important; max-width:max-content !important; gap:6px !important; }
  [data-dsh-mobile-composer-trailing] { display:flex !important; flex-wrap:nowrap !important; width:100% !important; min-width:0 !important; max-width:100% !important; gap:6px !important; margin-left:0 !important; justify-content:flex-end !important; }
  [data-dsh-mobile-composer-model] { flex:1 1 0 !important; width:auto !important; min-width:0 !important; max-width:none !important; }
  [data-dsh-mobile-composer-model-trigger] { box-sizing:border-box !important; width:100% !important; max-width:100% !important; min-width:0 !important; padding-left:6px !important; padding-right:4px !important; }
  [data-dsh-mobile-composer-model-label] { flex:1 1 auto !important; max-width:none !important; min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
  [data-dsh-mobile-center] [class*="_root"]:has(> [class*="_card"] textarea) { box-sizing:border-box !important; width:100% !important; padding:0 0 8px !important; }
  [data-dsh-mobile-center] [class*="_root"]:has(> [class*="_card"] textarea) > [class=""]:last-child { display:none !important; }
}
@keyframes dsh-mobile-fade-in { from { opacity:0; } }
@keyframes dsh-mobile-panel-in { from { opacity:.72; transform:translateY(6px); } }
@keyframes dsh-mobile-view-in { from { opacity:.58; transform:translateY(5px); } }
@media (max-width:420px) {
  [data-dsh-mobile-header] [class*="_headerActions"] { max-width:42vw; }
  [data-dsh-mobile-settings-options] [data-slot="settings.general.item"] [class*="_selector"] { align-self:stretch !important; width:100% !important; }
  [data-dsh-mobile-message-column] [data-context-fields] > * { grid-template-columns:1fr !important; }
}
@media (prefers-reduced-motion:reduce) {
  [data-dsh-mobile-sidebar-root],[data-dsh-mobile-details] { transition:none !important; }
  .dsh-native-mobile-backdrop:not([hidden]),[data-dsh-mobile-settings],
  [data-dsh-mobile-settings-content][data-dsh-mobile-view-transition="true"],
  [data-dsh-mobile-view][data-dsh-mobile-view-transition="true"] { animation:none !important; }
}
`

function classToken(element: Element, suffix: string): boolean {
  return Array.from(element.classList).some(value => value.endsWith(suffix))
}

function firstByClassSuffix(root: ParentNode, suffix: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>('[class]')).find(element => classToken(element, suffix))
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

/** Mark every mounted settings dialog so its mobile layout does not depend on the conversation shell. */
export function markNativeMobileSettings(root: ParentNode): number {
  let marked = 0
  for (const dialog of root.querySelectorAll<HTMLElement>('[role="dialog"]')) {
    const children = Array.from(dialog.children) as HTMLElement[]
    const nav = children.find(child => classToken(child, '_nav'))
    const content = children.find(child => classToken(child, '_content'))
    if (nav === undefined || content === undefined) continue
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

export type NativeMobileLanguage = 'it' | 'en' | 'zh'

interface FileDropTarget { dispatchEvent(event: Event): boolean }

function controlledFileDragEvent(type: 'dragover' | 'drop', files: readonly File[], initialDropEffect: DataTransfer['dropEffect']): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent
  const dataTransfer = {
    dropEffect: initialDropEffect,
    effectAllowed: 'copy',
    files: Object.freeze([...files]),
    types: Object.freeze(['Files']),
  } as unknown as DataTransfer
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
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

/** Add mobile semantics without replacing feature trees. */
export function installNativeMobileSurface(): () => void {
  document.documentElement.classList.add('dsh-native-mobile-active')
  const browserLanguages = navigator.languages.length > 0 ? navigator.languages : [navigator.language]
  const language = resolveNativeMobileLanguage(document.documentElement.lang, browserLanguages)
  const restoreLanguageMarker = applyNativeMobileLanguageMarker(document.documentElement, language)
  const label = (italian: string, english: string, chinese: string): string => language === 'it' ? italian : language === 'zh' ? chinese : english
  const mediaIcon = (kind: 'attachment' | 'camera'): SVGSVGElement => {
    const namespace = 'http://www.w3.org/2000/svg'
    const icon = document.createElementNS(namespace, 'svg')
    icon.setAttribute('viewBox', '0 0 16 16')
    icon.setAttribute('fill', 'none')
    icon.setAttribute('aria-hidden', 'true')
    if (kind === 'attachment') {
      const path = document.createElementNS(namespace, 'path')
      // DSH IconPaperclipOutline16, kept in the same currentColor icon language as the composer.
      path.setAttribute('d', 'M5.5498 9.75V5H6.9502V9.75C6.9502 10.3299 7.4201 10.7998 8 10.7998C8.5799 10.7998 9.0498 10.3299 9.0498 9.75V4.5C9.0498 2.9536 7.7964 1.7002 6.25 1.7002C4.7036 1.7002 3.4502 2.9536 3.4502 4.5V9.75C3.4502 12.2629 5.4871 14.2998 8 14.2998C10.5129 14.2998 12.5498 12.2629 12.5498 9.75V4H13.9502V9.75C13.9502 13.0361 11.2861 15.7002 8 15.7002C4.71391 15.7002 2.0498 13.0361 2.0498 9.75V4.5C2.04981 2.1804 3.9304 0.299806 6.25 0.299805C8.5696 0.299805 10.4502 2.1804 10.4502 4.5V9.75C10.4502 11.1031 9.3531 12.2002 8 12.2002C6.6469 12.2002 5.5498 11.1031 5.5498 9.75Z')
      path.setAttribute('fill', 'currentColor')
      icon.append(path)
      return icon
    }
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
  const createMediaAction = (kind: 'attachment' | 'camera', text: string): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'dsh-mobile-media-action'
    button.lang = language
    button.dataset.dshMobileMediaAction = kind
    button.append(mediaIcon(kind))
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
  const mediaActions = document.createElement('div')
  mediaActions.className = 'dsh-mobile-media-shortcuts'
  mediaActions.lang = language
  mediaActions.dataset.dshMobileMediaShortcuts = 'true'
  mediaActions.setAttribute('role', 'group')
  mediaActions.setAttribute('aria-label', label('Aggiungi immagine', 'Add image', '添加图片'))
  const fileButton = createMediaAction('attachment', label('Scegli immagine', 'Choose image', '选择图片'))
  const cameraButton = createMediaAction('camera', label('Scatta foto', 'Take photo', '拍照'))
  fileButton.disabled = true
  cameraButton.disabled = true
  mediaActions.append(fileButton, cameraButton)
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
  const browserPickerCleanups = new Set<() => void>()
  const sessionTokens = new WeakMap<Element, string>()
  let nextSessionToken = 0
  type MediaRequestContext = ComposerMediaOrigin & { readonly composer: Element | null; readonly sessionRoot: Element | null }
  const currentSessionOrigin = (): { readonly sessionRoot: Element | null; readonly sessionId: string | null } => {
    const dedicatedRoot = boundComposer?.closest('[data-dsh-mobile-session]') ?? null
    const dedicatedId = dedicatedRoot?.getAttribute('data-dsh-mobile-session')
    if (dedicatedRoot !== null && typeof dedicatedId === 'string' && dedicatedId !== '') {
      return { sessionRoot: dedicatedRoot, sessionId: dedicatedId }
    }
    const selectedRow = document.querySelector<Element>('[role="treeitem"][aria-selected="true"]')
    if (selectedRow === null) return { sessionRoot: null, sessionId: null }
    let token = sessionTokens.get(selectedRow)
    if (token === undefined) { token = `stock-${String(++nextSessionToken)}`; sessionTokens.set(selectedRow, token) }
    const identity = selectedRow.getAttribute('data-session-id')
      ?? selectedRow.getAttribute('aria-label')
      ?? selectedRow.textContent?.trim()
      ?? ''
    return { sessionRoot: selectedRow, sessionId: `${token}:${identity}` }
  }
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
    dispatchComposerImageDrop(document, files)
  }
  const launchBrowserPicker = (camera: boolean, context: ReturnType<typeof mediaRequestContext>): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/gif'
    if (camera) input.capture = 'environment'
    input.hidden = true
    const signal = mediaPickerAbortController.signal
    let cleanupTimer = 0
    let watchdogTimer = 0
    let cleaned = false
    const scheduleCleanup = (): void => {
      if (!cleaned && cleanupTimer === 0) cleanupTimer = window.setTimeout(cleanup, 1000)
    }
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') scheduleCleanup()
    }
    const onChange = (): void => {
      if (cleaned) return
      const files = input.files === null ? [] : [...input.files]
      cleanup()
      deliverImages(files, context)
    }
    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      if (cleanupTimer !== 0) window.clearTimeout(cleanupTimer)
      if (watchdogTimer !== 0) window.clearTimeout(watchdogTimer)
      cleanupTimer = 0
      watchdogTimer = 0
      input.removeEventListener('change', onChange)
      input.removeEventListener('cancel', cleanup)
      window.removeEventListener('focus', scheduleCleanup)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      signal.removeEventListener('abort', cleanup)
      browserPickerCleanups.delete(cleanup)
      input.remove()
    }
    input.addEventListener('change', onChange)
    input.addEventListener('cancel', cleanup)
    window.addEventListener('focus', scheduleCleanup)
    document.addEventListener('visibilitychange', onVisibilityChange)
    signal.addEventListener('abort', cleanup, { once: true })
    watchdogTimer = window.setTimeout(cleanup, 300_000)
    browserPickerCleanups.add(cleanup)
    if (signal.aborted) { cleanup(); return }
    try {
      document.body.append(input)
      input.click()
    } catch {
      cleanup()
      if (mediaRequestIsCurrent(context)) showMediaToast(label('Impossibile aprire il selettore immagini', 'Could not open the image picker', '无法打开图片选择器'))
    }
  }
  const dismissCommandMenu = (): void => {
    const trigger = boundComposer?.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"][aria-expanded="true"]')
    trigger?.click()
  }
  const setMediaActionsDisabled = (disabled: boolean, title: string): void => {
    for (const button of [fileButton, cameraButton]) {
      if (button.disabled !== disabled) button.disabled = disabled
      if (button.title !== title) button.title = title
    }
  }
  const quietMediaPointer = (event: PointerEvent): void => {
    event.preventDefault()
    event.stopPropagation()
    const active = document.activeElement
    if (active instanceof HTMLElement && (active.matches('input,textarea') || active.isContentEditable)) active.blur()
  }
  const pickImage = (camera: boolean): void => {
    if (!canAcceptComposerDrop()) {
      setMediaActionsDisabled(true, label('Allegati immagine non disponibili', 'Image attachments are unavailable', '图片附件不可用'))
      dismissCommandMenu()
      return
    }
    const context = mediaRequestContext()
    dismissCommandMenu()
    const bridge = window.__DSH_MOBILE_NATIVE__
    if (bridge === undefined) {
      launchBrowserPicker(camera, context)
      return
    }
    const action = camera ? 'camera.capture' : 'files.pick'
    const input = camera ? {} : { accept: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] }
    void Promise.resolve().then(() => bridge.invoke(action, input)).then(value => {
      if (!mediaRequestIsCurrent(context)) return
      if (value instanceof File) deliverImages([value], context)
      else showMediaToast(label('Il file selezionato non è utilizzabile', 'The selected file is unavailable', '所选文件不可用'))
    }).catch((error: unknown) => {
      if (!mediaRequestIsCurrent(context)) return
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
      if (code === 'cancelled') return
      showMediaToast(code === 'payload_too_large'
        ? label('L’immagine supera il limite di 8 MiB', 'The image exceeds the 8 MiB limit', '图片超过 8 MiB 限制')
        : label('Impossibile aggiungere l’immagine', 'Could not attach the image', '无法附加图片'))
    })
  }
  const chooseImage = (): void => { pickImage(false) }
  const takePhoto = (): void => { pickImage(true) }
  fileButton.addEventListener('pointerdown', quietMediaPointer)
  cameraButton.addEventListener('pointerdown', quietMediaPointer)
  fileButton.addEventListener('click', chooseImage)
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
  document.addEventListener('click', onBranchClick, true)
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
  let historyPreviousTop = 0
  const historyLoadButton = (): HTMLButtonElement | undefined => {
    const loader = historyScroller === undefined ? undefined : firstByClassSuffix(historyScroller, '_older')
    return loader?.querySelector<HTMLButtonElement>('button') ?? undefined
  }
  const onHistoryScroll = (): void => {
    if (historyScroller === undefined) return
    const currentTop = Math.max(0, historyScroller.scrollTop)
    const shouldLoad = shouldAutoLoadEarlier(historyPreviousTop, currentTop)
    historyPreviousTop = currentTop
    if (!shouldLoad) return
    const button = historyLoadButton()
    if (button === undefined || button.disabled || button.getAttribute('aria-disabled') === 'true') return
    button.click()
  }
  const bindHistoryScroller = (next: HTMLElement | undefined): void => {
    if (historyScroller === next) return
    historyScroller?.removeEventListener('scroll', onHistoryScroll)
    historyScroller = next
    historyPreviousTop = next?.scrollTop ?? 0
    historyScroller?.addEventListener('scroll', onHistoryScroll, { passive: true })
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
    if (frame !== undefined) frame.dataset.dshMobileFrame = 'true'
    sidebar = frame === undefined
      ? document.querySelector<HTMLElement>('.dshm-drawer') ?? undefined
      : firstByClassSuffix(frame, '_sidebarCol')
    const center = frame === undefined ? dedicatedCenter : firstByClassSuffix(frame, '_centerCol')
    const details = frame === undefined ? undefined : firstByClassSuffix(frame, '_detailsCol')
    const handle = frame === undefined ? undefined : firstByClassSuffix(frame, '_handle')
    markNativeMobileSettings(document)
    if (center === undefined) {
      bindHistoryScroller(undefined)
      syncMediaBinding(null)
      setMediaActionsDisabled(true, label('Apri prima una sessione', 'Open a session first', '请先打开会话'))
      mediaActions.remove()
      return
    }
    if (center !== undefined) {
      center.dataset.dshMobileCenter = 'true'
      center.querySelector<HTMLElement>('header')?.setAttribute('data-dsh-mobile-header', 'true')
      viewArea = firstByClassSuffix(center, '_viewArea')
      if (viewArea !== undefined) viewArea.dataset.dshMobileView = 'true'
      const conversation = center.querySelector<HTMLElement>('[data-conversation-scroll]')
      bindHistoryScroller(conversation ?? undefined)
      const historyLoader = conversation === null ? undefined : firstByClassSuffix(conversation, '_older')
      if (historyLoader !== undefined) {
        historyLoader.dataset.dshMobileHistoryLoader = 'true'
        historyLoader.setAttribute('aria-live', 'polite')
        const button = historyLoader.querySelector<HTMLButtonElement>('button')
        if (button !== null) {
          button.tabIndex = -1
          if (button.disabled) button.removeAttribute('aria-hidden')
          else button.setAttribute('aria-hidden', 'true')
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
      const composerCard = center.querySelector<HTMLElement>('[data-composer-card]')
      const composerRow = composerCard?.querySelector<HTMLElement>(':scope > [data-input-scroll]')?.nextElementSibling
      if (!(composerRow instanceof HTMLElement)) {
        syncMediaBinding(null)
        setMediaActionsDisabled(true, label('Apri prima una sessione', 'Open a session first', '请先打开会话'))
        mediaActions.remove()
      }
      if (composerRow instanceof HTMLElement) {
        composerRow.dataset.dshMobileComposerRow = 'true'
        const groups = Array.from(composerRow.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
        const composerTools = groups[0]
        const composerTrailing = groups.at(-1)
        if (composerTools !== undefined) {
          composerTools.dataset.dshMobileComposerTools = 'true'
          syncMediaBinding(composerCard ?? null)
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
                : label('Allega screenshot, immagine o foto', 'Attach screenshot, image, or photo', '附加截图、图片或照片')
          setMediaActionsDisabled(mediaDisabled, mediaTitle)
          const commandMenu = composerCard?.querySelector<HTMLElement>('[data-trigger-menu]') ?? null
          if (commandMenu !== null && (mediaActions.parentElement !== commandMenu || commandMenu.firstElementChild !== mediaActions)) {
            commandMenu.prepend(mediaActions)
          }
        }
        if (composerTrailing !== undefined && composerTrailing !== composerTools) {
          composerTrailing.dataset.dshMobileComposerTrailing = 'true'
          const modelTrigger = composerTrailing.querySelector<HTMLButtonElement>('button[aria-label^="选择模型"],button[aria-label^="Select model"],button[aria-label^="Seleziona modello"]')
          if (modelTrigger !== null) {
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
    if (sidebar === undefined) return
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
    const collapsed = classToken(sidebarRoot, '_collapsed')
    sidebar.dataset.open = String(!collapsed)
    backdrop.hidden = collapsed
  }
  const schedule = (): void => { if (scheduled === 0) scheduled = requestAnimationFrame(sync) }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'disabled', 'readonly', 'aria-busy', 'aria-selected', 'data-dsh-mobile-session'] })
  backdrop.addEventListener('click', () => { if (sidebar?.dataset.open === 'true') toggle?.click() })
  sync()
  return () => {
    disposed = true
    mediaRequestGeneration += 1
    mediaPickerAbortController.abort()
    restoreLanguageMarker()
    for (const cleanup of [...browserPickerCleanups]) cleanup()
    observer.disconnect()
    document.removeEventListener('click', onBranchClick, true)
    fileButton.removeEventListener('pointerdown', quietMediaPointer)
    cameraButton.removeEventListener('pointerdown', quietMediaPointer)
    fileButton.removeEventListener('click', chooseImage)
    cameraButton.removeEventListener('click', takePhoto)
    if (branchToastTimer !== 0) window.clearTimeout(branchToastTimer)
    if (mediaToastTimer !== 0) window.clearTimeout(mediaToastTimer)
    branchToast.remove()
    mediaToast.remove()
    mediaActions.remove()
    if (scheduled !== 0) cancelAnimationFrame(scheduled)
    if (transitionFrame !== 0) cancelAnimationFrame(transitionFrame)
    if (transitionRestartFrame !== 0) cancelAnimationFrame(transitionRestartFrame)
    if (transitionTimer !== 0) clearTimeout(transitionTimer)
    transitionTarget?.removeAttribute('data-dsh-mobile-view-transition')
    historyScroller?.removeEventListener('scroll', onHistoryScroll)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    document.removeEventListener('click', animateNavigation)
    backdrop.remove()
    document.documentElement.classList.remove('dsh-native-mobile-active')
    delete document.documentElement.dataset.dshMobileInput
  }
}
