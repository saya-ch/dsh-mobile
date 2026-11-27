import { createElement, useSyncExternalStore } from 'react'
import {
  readComposerCollapseEnabled,
  subscribeComposerCollapseEnabled,
  writeComposerCollapseEnabled,
} from './composer-collapse.js'
import type { MobileControlLocale } from './client-messages.js'

/**
 * General-settings row for the reading-mode composer-collapse opt-in (issue #194).
 *
 * The row and the layout bundle are separate bundles, so the value is persisted
 * and broadcast by ./composer-collapse.js rather than held in a shared singleton.
 */
export const COMPOSER_COLLAPSE_SETTINGS_ORDER = 15

export const COMPOSER_COLLAPSE_COPY = {
  en: {
    title: 'Reading mode: collapse composer',
    desc: 'Collapse the composer editor while scrolling down a long conversation; tap it, focus it, or scroll back up to restore. It never collapses while a draft or a running reply is present.',
    on: 'On',
    off: 'Off',
  },
  zh: {
    title: '阅读模式：收起输入栏',
    desc: '向下滚动阅读长会话时收起输入框编辑区；点按、聚焦或向上回滚即恢复。有草稿或回复生成中时不会收起。',
    on: '已开启',
    off: '已关闭',
  },
  it: {
    title: 'Modalità lettura: comprimi il campo',
    desc: 'Comprime l’editor del campo mentre scorri una conversazione lunga; toccalo, mettilo a fuoco o scorri verso l’alto per ripristinarlo. Non si comprime con una bozza o una risposta in corso.',
    on: 'Attivo',
    off: 'Disattivo',
  },
  ja: {
    title: 'リーディングモード：入力欄を折りたたむ',
    desc: '長い会話を下にスクロールしている間、入力欄の編集領域を折りたたみます。タップする、フォーカスする、または上にスクロールすると元に戻ります。下書きがあるときや返信の生成中は折りたたみません。',
    on: 'オン',
    off: 'オフ',
  },
  ko: {
    title: '읽기 모드: 입력창 접기',
    desc: '긴 대화를 아래로 스크롤하는 동안 입력창 편집 영역을 접습니다. 탭하거나 포커스하거나 위로 스크롤하면 다시 펼쳐집니다. 임시 저장된 초안이 있거나 답변을 생성하는 중에는 접지 않습니다.',
    on: '켜짐',
    off: '꺼짐',
  },
  es: {
    title: 'Modo lectura: contraer el editor',
    desc: 'Contrae el área de edición del compositor mientras desplazas una conversación larga; tócalo, enfócalo o desplázate hacia arriba para restaurarlo. Nunca se contrae si hay un borrador o una respuesta en curso.',
    on: 'Activado',
    off: 'Desactivado',
  },
  fr: {
    title: 'Mode lecture : réduire le champ de saisie',
    desc: "Réduit la zone d'édition du champ de saisie pendant le défilement d'une longue conversation ; touchez-la, donnez-lui le focus ou remontez pour la restaurer. Elle n'est jamais réduite en présence d'un brouillon ou d'une réponse en cours.",
    on: 'Activé',
    off: 'Désactivé',
  },
  de: {
    title: 'Lesemodus: Eingabefeld einklappen',
    desc: 'Klappt den Bearbeitungsbereich des Eingabefelds beim Scrollen durch eine lange Unterhaltung ein; antippen, fokussieren oder nach oben scrollen stellt ihn wieder her. Bei einem Entwurf oder einer laufenden Antwort wird nie eingeklappt.',
    on: 'Ein',
    off: 'Aus',
  },
} as const

export interface ComposerCollapseSettingsProps {
  readonly locale: MobileControlLocale
  /** Injected in tests; defaults to the persisted store. */
  readonly read?: () => boolean
  readonly write?: (enabled: boolean) => void
  readonly subscribe?: (listener: (enabled: boolean) => void) => () => void
}

/** Browser-only settings row; toggling it only persists the flag. */
export function ComposerCollapseSettings({ locale, read, write, subscribe }: ComposerCollapseSettingsProps): ReturnType<typeof createElement> {
  const readEnabled = read ?? (() => readComposerCollapseEnabled())
  const writeEnabled = write ?? ((enabled: boolean) => { writeComposerCollapseEnabled(enabled) })
  const subscribeEnabled = subscribe ?? ((listener: (enabled: boolean) => void) => subscribeComposerCollapseEnabled(listener))
  const enabled = useSyncExternalStore(subscribeEnabled, readEnabled, () => false)
  const copy = COMPOSER_COLLAPSE_COPY[locale]
  // Reuse the shell's switch row markup: the whole row is the hit target, the
  // control keeps a >=44px touch box and a visible focus ring via the shared
  // classes in NATIVE_MOBILE_STYLES.
  return createElement('label', { className: 'dsh-mobile-settings_row', lang: locale === 'zh' ? 'zh-CN' : locale, 'data-dsh-mobile-composer-collapse': enabled ? 'on' : 'off' },
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
