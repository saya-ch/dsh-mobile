import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode, Ref } from 'react'

/** Nodes created by the core InputBar: this presenter never owns their behavior. */
export interface MobileComposerToolbarProps {
  readonly stock: ReactNode
  readonly rowRef: Ref<HTMLDivElement>
  readonly rowClassName: string
  readonly leading: ReactNode
  readonly model: ReactNode
  readonly actions: ReactNode
  readonly pluginsLeft: ReactNode
  readonly pluginsRight: ReactNode
  readonly activity: ReactNode
  readonly activityActive: boolean
}

const PHONE_QUERY = '(max-width:720px)'
function subscribePhone(listener: () => void): () => void {
  const media = window.matchMedia(PHONE_QUERY)
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
function phoneSnapshot(): boolean { return window.matchMedia(PHONE_QUERY).matches }

/** One upper scrollport, one lower fixed toolbar. Original nodes mount once. */
export function MobileComposerToolbar(props: MobileComposerToolbarProps): ReactNode {
  const phone = useSyncExternalStore(subscribePhone, phoneSnapshot, () => false)
  // Never reparent a live recorder because the device rotates across a breakpoint.
  const layoutMode = useRef(phone)
  if (!props.activityActive) layoutMode.current = phone
  const mobile = layoutMode.current
  const scroll = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: false, end: false })
  useEffect(() => {
    const seat = scroll.current
    if (!mobile || seat === null) return
    const measure = (): void => {
      const next = { start: seat.scrollLeft > 1, end: seat.scrollLeft + seat.clientWidth < seat.scrollWidth - 1 }
      setEdges(old => old.start === next.start && old.end === next.end ? old : next)
    }
    const resize = new ResizeObserver(measure)
    resize.observe(seat)
    const watchChildren = (): void => {
      for (const child of Array.from(seat.children)) resize.observe(child)
      measure()
    }
    const mutation = new MutationObserver(watchChildren)
    mutation.observe(seat, { childList: true, subtree: true, attributes: true, characterData: true })
    seat.addEventListener('scroll', measure, { passive: true })
    watchChildren()
    return () => { resize.disconnect(); mutation.disconnect(); seat.removeEventListener('scroll', measure) }
  }, [mobile, props.activityActive])
  if (!mobile) return props.stock
  return createElement('div', {
    className: 'dshm-composer-toolbar',
    'data-mobile-toolbar-layout': 'plugins-above',
  },
  createElement('div', {
    className: 'dshm-composer-plugin-frame',
    'data-activity-active': props.activityActive,
    'data-overflow-start': edges.start,
    'data-overflow-end': edges.end,
  }, createElement('div', { ref: scroll, className: 'dshm-composer-plugin-scroll', 'data-mobile-plugin-scroll': true },
    props.pluginsLeft, props.pluginsRight,
    createElement('div', { className: 'dshm-composer-activity' }, props.activity))),
  createElement('div', { ref: props.rowRef, className: `dshm-composer-core ${props.rowClassName}` },
    createElement('div', { className: 'dshm-composer-leading', 'data-dsh-mobile-core-leading': true }, props.leading),
    createElement('div', { className: 'dshm-composer-trailing', 'data-dsh-mobile-core-trailing': true },
      createElement('div', { className: 'dshm-composer-model' }, props.model),
      createElement('div', { className: 'dshm-composer-actions' }, props.actions))))
}

/** Scoped to the dedicated presenter; stock/desktop rules are not overridden. */
export const MOBILE_COMPOSER_TOOLBAR_STYLES = `
.dshm-composer-toolbar{display:flex;flex-direction:column;gap:4px;min-width:0;padding:0 8px 8px;box-sizing:border-box;width:100%}
.dshm-composer-toolbar>.dshm-composer-core{display:flex;flex-wrap:nowrap;align-items:center;gap:8px;min-width:0;width:100%;padding:0;box-sizing:border-box}
.dshm-composer-leading{flex:0 0 auto;min-width:0}
.dshm-composer-leading>[class*="_tools"]{display:flex;flex-wrap:nowrap;gap:6px;padding:0;align-items:center}
.dshm-composer-leading>[hidden]{display:none!important}
.dshm-composer-leading [class*="_modes"]{display:flex;flex-wrap:nowrap;gap:4px}
.dshm-composer-trailing{flex:1 1 0;display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0}
.dshm-composer-model{flex:1 1 0;min-width:0;max-width:100%}
.dshm-composer-model>[class*="_standardControls"]{display:flex;flex:1 1 0;flex-wrap:nowrap;min-width:0;width:100%;justify-content:flex-end}
.dshm-composer-model>[hidden]{display:none!important}
.dshm-composer-model [data-dsh-mobile-composer-model]{flex:1 1 0!important;min-width:0!important;max-width:100%!important}
.dshm-composer-model [data-dsh-mobile-composer-model-trigger]{width:100%!important;min-width:0!important;padding:0 4px!important}
.dshm-composer-model [data-dsh-mobile-composer-model-label]{min-width:0!important;overflow:hidden!important;text-overflow:ellipsis!important;white-space:nowrap!important}
.dshm-composer-actions{display:flex;flex:0 0 auto;gap:6px;align-items:center}
.dshm-composer-core button:not([role="switch"]){min-height:44px!important;touch-action:manipulation}
.dshm-composer-actions button,.dshm-composer-leading>div>button{min-width:44px!important;flex-shrink:0!important}
.dshm-composer-plugin-frame{position:relative;min-width:0;width:100%}
.dshm-composer-plugin-frame::before,.dshm-composer-plugin-frame::after{content:"";position:absolute;z-index:1;top:0;bottom:0;width:16px;pointer-events:none;opacity:0}
.dshm-composer-plugin-frame::before{left:0;background:linear-gradient(to right,var(--dsw-specific-input-major,#fff),transparent)}
.dshm-composer-plugin-frame::after{right:0;background:linear-gradient(to left,var(--dsw-specific-input-major,#fff),transparent)}
.dshm-composer-plugin-frame[data-overflow-start="true"]::before,.dshm-composer-plugin-frame[data-overflow-end="true"]::after{opacity:1}
.dshm-composer-plugin-scroll{display:flex;align-items:center;gap:10px;flex-wrap:nowrap;min-width:0;max-width:100%;min-height:44px;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;touch-action:pan-x pinch-zoom;scrollbar-width:none}
.dshm-composer-plugin-scroll::-webkit-scrollbar{display:none}
.dshm-composer-plugin-scroll>[data-slot],.dshm-composer-plugin-scroll>[data-slot]>[data-entry]{display:contents!important}
.dshm-composer-plugin-scroll>*{flex:0 0 auto;min-width:max-content;max-width:none}
.dshm-composer-plugin-scroll [data-slot="conversation.input.left"]>:not(dialog):not([popover]):not([role="dialog"]):not([role="menu"]):not([role="listbox"]),.dshm-composer-plugin-scroll [data-slot="conversation.input.right"]>:not(dialog):not([popover]):not([role="dialog"]):not([role="menu"]):not([role="listbox"]){flex:0 0 auto;min-width:max-content;max-width:none}
.dshm-composer-plugin-scroll button:not([role="switch"]):not(dialog button):not([popover] button):not([role="dialog"] button):not([role="menu"] button):not([role="listbox"] button){min-width:32px!important;min-height:32px!important;height:32px!important;white-space:nowrap!important;overflow-wrap:normal!important;flex-shrink:0!important;touch-action:manipulation}
.dshm-composer-plugin-scroll button[role="switch"]{min-width:0!important;min-height:0!important;flex:none!important}
.dshm-composer-plugin-scroll .dshAcComposer{display:inline-flex;align-items:center;flex:none;gap:6px;min-height:44px;white-space:nowrap;font-size:12px}
.dshm-composer-plugin-scroll .dshAcSwitchTarget{display:inline-flex;align-items:center;min-height:44px}
.dshm-composer-plugin-scroll [data-openai-codex-quota]{flex:none!important;white-space:nowrap;min-width:max-content;font-size:11px}
.dshm-composer-activity{display:flex;align-items:center;flex:0 0 auto}
.dshm-composer-plugin-frame[data-activity-active="true"] .dshm-composer-plugin-scroll{overflow:visible;touch-action:auto}
.dshm-composer-plugin-frame[data-activity-active="true"] .dshm-composer-plugin-scroll>[data-slot]{display:none!important}
.dshm-composer-plugin-frame[data-activity-active="true"] .dshm-composer-activity{flex:1 1 0;min-width:0;max-width:100%;width:100%}
.dshm-composer-plugin-frame[data-activity-active="true"] .dshm-composer-activity>[class*="_activity"]{width:100%;min-width:0;max-width:100%}
.dshm-composer-plugin-frame[data-activity-active="true"]::before,.dshm-composer-plugin-frame[data-activity-active="true"]::after{display:none}
/* The dedicated shell keeps a 56px closed navigation rail at tablet widths.
   A live recorder retains the phone tree during rotation; keep its cancel
   control out of that rail's hit area without moving or remounting it. */
@media(min-width:721px) and (max-width:899px){.dshm-shell:has(.dshm-drawer[data-open="false"]) .dshm-composer-plugin-frame[data-activity-active="true"]{box-sizing:border-box;padding-left:56px}}
`
