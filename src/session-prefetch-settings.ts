import { createElement, useSyncExternalStore } from 'react'
import {
  readSessionPrefetchEnabled,
  subscribeSessionPrefetchEnabled,
  writeSessionPrefetchEnabled,
} from './session-prefetch.js'
import type { MobileControlLocale } from './client-messages.js'

/**
 * General-settings row for the session-prefetch opt-in (issue #291).
 *
 * The row and the layout bundle are separate bundles, so the value is persisted
 * and broadcast by ./session-prefetch.js rather than held in a shared singleton.
 */
export const SESSION_PREFETCH_SETTINGS_ORDER = 130

export const SESSION_PREFETCH_COPY = {
  en: {
    title: 'Prefetch the session you just left',
    desc: 'After switching sessions, warm the previous one in the background so switching back opens faster. Read-only, at most one session per switch, with a per-session cooldown.',
    on: 'On',
    off: 'Off',
  },
  zh: {
    title: '预取刚离开的会话',
    desc: '切换会话后在后台预热上一个会话，切回去时打开更快。只读、每次切换最多预热一个会话，并带单会话冷却。',
    on: '已开启',
    off: '已关闭',
  },
  it: {
    title: 'Prefetch della sessione appena lasciata',
    desc: 'Dopo un cambio di sessione riscalda in background quella precedente, così tornare indietro è più rapido. Sola lettura, al massimo una sessione per cambio, con cooldown per sessione.',
    on: 'Attivo',
    off: 'Disattivo',
  },
  ja: {
    title: '直前のセッションを先読みする',
    desc: 'セッションを切り替えた後、前のセッションをバックグラウンドで温めておき、戻ったときに速く開けるようにします。読み取り専用で、切り替えごとに最大 1 セッション、セッションごとのクールダウン付きです。',
    on: 'オン',
    off: 'オフ',
  },
  ko: {
    title: '방금 떠난 세션 미리 불러오기',
    desc: '세션을 전환한 뒤 이전 세션을 백그라운드에서 미리 준비하여 다시 돌아올 때 더 빠르게 열립니다. 읽기 전용이며 전환마다 최대 한 세션, 세션별 대기 시간이 적용됩니다.',
    on: '켜짐',
    off: '꺼짐',
  },
  es: {
    title: 'Precargar la sesión que acabas de dejar',
    desc: 'Tras cambiar de sesión, prepara la anterior en segundo plano para que volver a ella sea más rápido. Solo lectura, como máximo una sesión por cambio y con un tiempo de espera por sesión.',
    on: 'Activado',
    off: 'Desactivado',
  },
  fr: {
    title: 'Précharger la session que vous venez de quitter',
    desc: 'Après un changement de session, prépare la précédente en arrière-plan pour que le retour soit plus rapide. Lecture seule, au plus une session par changement, avec un délai par session.',
    on: 'Activé',
    off: 'Désactivé',
  },
  de: {
    title: 'Zuletzt verlassene Sitzung vorladen',
    desc: 'Bereitet nach einem Sitzungswechsel die vorherige im Hintergrund vor, damit der Wechsel zurück schneller öffnet. Nur lesend, höchstens eine Sitzung pro Wechsel, mit einer Wartezeit je Sitzung.',
    on: 'Ein',
    off: 'Aus',
  },
} as const

export interface SessionPrefetchSettingsProps {
  readonly locale: MobileControlLocale
  /** Injected in tests; defaults to the persisted store. */
  readonly read?: () => boolean
  readonly write?: (enabled: boolean) => void
  readonly subscribe?: (listener: (enabled: boolean) => void) => () => void
}

/** Browser-only settings row; toggling it only persists the flag. */
export function SessionPrefetchSettings({ locale, read, write, subscribe }: SessionPrefetchSettingsProps): ReturnType<typeof createElement> {
  const readEnabled = read ?? readSessionPrefetchEnabled
  const writeEnabled = write ?? writeSessionPrefetchEnabled
  const subscribeEnabled = subscribe ?? subscribeSessionPrefetchEnabled
  const enabled = useSyncExternalStore(subscribeEnabled, readEnabled, () => false)
  const copy = SESSION_PREFETCH_COPY[locale]
  // Reuse the shell's checkbox row markup: the whole row is the hit target, the
  // control keeps a >=44px touch box and a visible focus ring via the shared class.
  return createElement('label', { className: 'dsh-mobile-settings_row', lang: locale === 'zh' ? 'zh-CN' : locale, 'data-dsh-mobile-session-prefetch': enabled ? 'on' : 'off' },
    createElement('div', { className: 'dsh-mobile-settings_rowText' },
      createElement('div', { className: 'dsh-mobile-settings_title' }, copy.title),
      createElement('div', { className: 'dsh-mobile-settings_desc', 'aria-live': 'polite' }, copy.desc),
    ),
    createElement('input', {
      type: 'checkbox',
      role: 'switch',
      className: 'dsh-mobile-settings_switchInput',
      checked: enabled,
      'aria-label': copy.title,
      'aria-checked': enabled ? 'true' : 'false',
      onChange: (event: { readonly currentTarget: { readonly checked: boolean } }): void => {
        writeEnabled(event.currentTarget.checked)
      },
    }),
    createElement('span', { className: 'dsh-mobile-settings_selector', 'aria-hidden': 'true' }, enabled ? copy.on : copy.off),
  )
}
