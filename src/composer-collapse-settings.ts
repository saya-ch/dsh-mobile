import { createElement, useSyncExternalStore } from 'react'
import {
  readComposerCollapseEnabled,
  subscribeComposerCollapseEnabled,
  writeComposerCollapseEnabled,
} from './composer-collapse.js'

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
} as const

export interface ComposerCollapseSettingsProps {
  readonly locale: 'en' | 'zh' | 'it'
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
