/**
 * Compact the stock InputBar without changing its React ownership, handlers,
 * activity tree or the two groups observed by DSH's model-width controller.
 * Extra controls wrap inside their own group; menus remain overflow-visible.
 */
export const MOBILE_COMPOSER_TOOLBAR_STYLES = `
/* These markers are attached only to the stock composer on the mobile page.
   Body portals and inline dialogs are not part of the compact toolbar. */
[data-dsh-mobile-composer-row] { min-width:0 !important; max-width:100% !important; }
[data-dsh-mobile-composer-tools]:not([hidden]),[data-dsh-mobile-composer-controls]:not([hidden]) { flex-wrap:wrap !important; min-width:0 !important; max-width:100% !important; }
[data-dsh-mobile-composer-tools] > :not(:where(dialog,[popover],[role="dialog"],[role="menu"],[role="listbox"],[data-trigger-menu])),
[data-dsh-mobile-composer-tools] > [data-slot] > :not(:where(dialog,[popover],[role="dialog"],[role="menu"],[role="listbox"],[data-trigger-menu])),
[data-dsh-mobile-composer-controls] > :not(:where(dialog,[popover],[role="dialog"],[role="menu"],[role="listbox"],[data-trigger-menu])),
[data-dsh-mobile-composer-controls] > [data-slot] > :not(:where(dialog,[popover],[role="dialog"],[role="menu"],[role="listbox"],[data-trigger-menu])) { min-width:0 !important; max-width:100% !important; }
[data-dsh-mobile-composer-tools] button:not(:where(dialog *,[popover] *,[role="dialog"] *,[role="menu"] *,[role="listbox"] *,[data-trigger-menu] *)),
[data-dsh-mobile-composer-controls] button:not(:where(dialog *,[popover] *,[role="dialog"] *,[role="menu"] *,[role="listbox"] *,[data-trigger-menu] *)) { white-space:normal !important; overflow-wrap:anywhere !important; }
@media (max-width:720px) {
  [data-dsh-mobile-composer-row] button:not([role="switch"]):not(:where(dialog *,[popover] *,[role="dialog"] *,[role="menu"] *,[role="listbox"] *,[data-trigger-menu] *)) { min-width:44px !important; min-height:44px !important; touch-action:manipulation; }
  [data-dsh-mobile-composer-trailing] > button[class*="_primary"] { min-width:44px !important; flex-shrink:0 !important; }
  [data-dsh-mobile-composer-row] { display:flex !important; flex-wrap:wrap !important; align-items:center !important; gap:4px 8px !important; min-width:0 !important; max-width:100% !important; }
  [data-dsh-mobile-composer-tools]:not([hidden]) { display:flex !important; flex:0 1 auto !important; flex-wrap:wrap !important; width:auto !important; min-width:0 !important; max-width:100% !important; gap:6px !important; }
  /* The activity seat can be wider than a single icon. Intrinsic demand, not
     a fixed 100px reserve, decides whether this intact group needs to wrap. */
  [data-dsh-mobile-composer-trailing] { display:flex !important; flex:1 0 auto !important; flex-wrap:nowrap !important; width:auto !important; min-width:0 !important; max-width:100% !important; gap:6px !important; margin-left:0 !important; justify-content:flex-end !important; }
  [data-dsh-mobile-composer-controls]:not([hidden]) { display:flex !important; flex:1 1 0 !important; flex-wrap:wrap !important; justify-content:flex-end !important; min-width:44px !important; max-width:100% !important; gap:6px !important; }
  [data-dsh-mobile-composer-model] { flex:0 1 auto !important; width:auto !important; min-width:44px !important; max-width:100% !important; }
  [data-dsh-mobile-composer-model-trigger] { box-sizing:border-box !important; width:100% !important; max-width:100% !important; min-width:0 !important; padding-left:6px !important; padding-right:4px !important; }
  [data-dsh-mobile-composer-model-label] { flex:1 1 auto !important; max-width:none !important; min-width:0 !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }
}
`
