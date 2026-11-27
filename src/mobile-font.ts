/** Device-local typography for authenticated mobile pages, without Host settings writes. */
import { createElement, useEffect, useState, useSyncExternalStore } from 'react'
import { NO_ADVANCED_MOBILE_TYPOGRAPHY, readMobileTypographyCapabilities, type MobileTypographyCapabilities } from './mobile-font-capabilities.js'

export const MOBILE_FONT_STORAGE_KEY = 'dsh-mobile.content-font-size.v1'
export const MOBILE_TYPOGRAPHY_STORAGE_KEY = 'dsh-mobile.typography.v1'
export const DEFAULT_MOBILE_FONT_SIZE = 16
export const MIN_MOBILE_FONT_SIZE = 12
export const MAX_MOBILE_FONT_SIZE = 32
export const MOBILE_FONT_ROLES = ['text', 'code'] as const
export type MobileFontRole = typeof MOBILE_FONT_ROLES[number]
const roleSpecs = {
  text: { default: DEFAULT_MOBILE_FONT_SIZE, min: MIN_MOBILE_FONT_SIZE, variable: '--dsh-content-font-size' },
  code: { default: 11, min: 10, variable: '--dsh-code-font-size' },
} as const

export interface MobileTypography {
  readonly sizes: Readonly<Record<MobileFontRole, number>>
  readonly families: Readonly<Record<MobileFontRole, string>>
}

const genericFamilies = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont'])
const MAX_FONT_FAMILY_LENGTH = 1024

/** Normalize a comma-separated local font list without loading or discovering fonts. */
export function normalizeMobileFontFamily(value: string): string {
  let result = ''
  for (const part of value.slice(0, MAX_FONT_FAMILY_LENGTH * 2).split(',')) {
    const name = part.replace(/["'\\<>\u0000-\u001f\u007f]/gu, '').replace(/\s+/gu, ' ').trim()
    if (name === '') continue
    const generic = genericFamilies.has(name.toLowerCase())
    const separator = result === '' ? '' : ', '
    const remaining = MAX_FONT_FAMILY_LENGTH - result.length - separator.length - (generic ? 0 : 2)
    if (remaining < 1 || (generic && name.length > remaining)) break
    result += separator + (generic ? name : `"${name.slice(0, remaining)}"`)
  }
  return result
}

function defaultTypography(textSize = DEFAULT_MOBILE_FONT_SIZE): MobileTypography {
  return Object.freeze({ sizes: Object.freeze({ text: textSize, code: roleSpecs.code.default }),
    families: Object.freeze({ text: '', code: '' }) })
}

/** Durable local JSON is validated independently for each typography role. */
function readTypography(value: string | null, legacySize: number): MobileTypography {
  const fallback = defaultTypography(legacySize)
  if (value === null) return fallback
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch (error) { return fallback }
  if (typeof parsed !== 'object' || parsed === null || !('sizes' in parsed) || !('families' in parsed)) return fallback
  const sizes = { ...fallback.sizes }
  const families = { ...fallback.families }
  for (const role of MOBILE_FONT_ROLES) {
    if (typeof parsed.sizes === 'object' && parsed.sizes !== null && role in parsed.sizes) {
      const size: unknown = Reflect.get(parsed.sizes, role)
      if (typeof size === 'number' && Number.isInteger(size) && size >= roleSpecs[role].min && size <= MAX_MOBILE_FONT_SIZE) sizes[role] = size
    }
    if (typeof parsed.families === 'object' && parsed.families !== null && role in parsed.families) {
      const family: unknown = Reflect.get(parsed.families, role)
      if (typeof family === 'string') families[role] = normalizeMobileFontFamily(family)
    }
  }
  return Object.freeze({ sizes: Object.freeze(sizes), families: Object.freeze(families) })
}

/** Read one local storage value; malformed or unavailable preferences use the mobile default. */
export function parseMobileFontSize(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return DEFAULT_MOBILE_FONT_SIZE
  const size = Number(value)
  return Number.isInteger(size) && size >= MIN_MOBILE_FONT_SIZE && size <= MAX_MOBILE_FONT_SIZE
    ? size : DEFAULT_MOBILE_FONT_SIZE
}

/** Local preference storage; unavailable browser storage still permits in-page adjustment. */
export class MobileFontPreference {
  private typography = defaultTypography()
  private readonly listeners = new Set<() => void>()
  private capabilities = NO_ADVANCED_MOBILE_TYPOGRAPHY
  private readonly capabilityListeners = new Set<() => void>()

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    let legacySize = DEFAULT_MOBILE_FONT_SIZE
    try { legacySize = parseMobileFontSize(storage?.getItem(MOBILE_FONT_STORAGE_KEY) ?? null) }
    catch (error) { /* Private or restricted storage keeps the in-page default. */ }
    this.typography = defaultTypography(legacySize)
    try { this.typography = readTypography(storage?.getItem(MOBILE_TYPOGRAPHY_STORAGE_KEY) ?? null, legacySize) }
    catch (error) { /* Keep a readable legacy preference if the newer key is inaccessible. */ }
  }

  getSnapshot = (): number => this.typography.sizes.text
  getTypographySnapshot = (): MobileTypography => this.typography
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  getCapabilitiesSnapshot = (): MobileTypographyCapabilities => this.capabilities
  subscribeCapabilities = (listener: () => void): (() => void) => {
    this.capabilityListeners.add(listener)
    return () => { this.capabilityListeners.delete(listener) }
  }

  /** Update observed theme support without changing stored values or Host settings. */
  updateCapabilities(capabilities: MobileTypographyCapabilities): void {
    if (this.capabilities.codeSize === capabilities.codeSize && this.capabilities.textFamily === capabilities.textFamily
      && this.capabilities.codeFamily === capabilities.codeFamily) return
    this.capabilities = Object.freeze({ ...capabilities })
    for (const listener of this.capabilityListeners) listener()
  }

  /** Apply a user-selected size locally; never send it to DSH's settings RPC. */
  set(size: number): void {
    this.setRoleSize('text', size)
  }

  /** Change one mobile font role independently; all values remain address-local. */
  setRoleSize(role: MobileFontRole, size: number): void {
    if (!Number.isInteger(size) || size < roleSpecs[role].min || size > MAX_MOBILE_FONT_SIZE) {
      throw new RangeError(`Mobile ${role} font size must be an integer from ${roleSpecs[role].min} to ${MAX_MOBILE_FONT_SIZE}`)
    }
    if (this.typography.sizes[role] === size) return
    this.persist({ sizes: Object.freeze({ ...this.typography.sizes, [role]: size }), families: this.typography.families })
  }

  /** Select existing local fonts; an empty list uses DSH's built-in font stack. */
  setRoleFamily(role: MobileFontRole, family: string): void {
    const normalized = normalizeMobileFontFamily(family)
    if (this.typography.families[role] === normalized) return
    this.persist({ sizes: this.typography.sizes, families: Object.freeze({ ...this.typography.families, [role]: normalized }) })
  }

  /** Restore mobile sizes and built-in font stacks without modifying Host settings. */
  reset(): void {
    const next = defaultTypography()
    if (MOBILE_FONT_ROLES.every(role => this.typography.sizes[role] === next.sizes[role] && this.typography.families[role] === '')) return
    this.persist(next)
  }

  /** Reset visible supported controls while retaining preferences an older theme cannot consume. */
  resetSupported(): void {
    const defaults = defaultTypography()
    const sizes = { text: defaults.sizes.text, code: this.capabilities.codeSize ? defaults.sizes.code : this.typography.sizes.code }
    const families = { text: this.capabilities.textFamily ? '' : this.typography.families.text,
      code: this.capabilities.codeFamily ? '' : this.typography.families.code }
    if (MOBILE_FONT_ROLES.every(role => this.typography.sizes[role] === sizes[role] && this.typography.families[role] === families[role])) return
    this.persist({ sizes: Object.freeze(sizes), families: Object.freeze(families) })
  }

  private persist(typography: MobileTypography): void {
    this.typography = Object.freeze(typography)
    try { this.storage?.setItem(MOBILE_TYPOGRAPHY_STORAGE_KEY, JSON.stringify(typography)) }
    catch (error) { /* Adjust the current page even when persistence is unavailable. */ }
    try { this.storage?.setItem(MOBILE_FONT_STORAGE_KEY, String(typography.sizes.text)) }
    catch (error) { /* Adjust the current page even when persistence is unavailable. */ }
    for (const listener of this.listeners) listener()
  }
}

/**
 * Keep mobile typography independent from Host theme changes, including body-level portals.
 * Recheck head-owned stylesheets and body presentation attributes, not conversation DOM updates.
 * Arbitrary stylesheets inserted into body are not observed.
 */
export function installMobileFontPreference(): { preference: MobileFontPreference; dispose: () => void } {
  let storage: Storage | null = null
  try { storage = window.localStorage }
  catch (error) { /* Some browser privacy modes deny access to localStorage entirely. */ }
  const preference = new MobileFontPreference(storage)
  const style = document.body.style
  const properties = MOBILE_FONT_ROLES.flatMap(role => [roleSpecs[role].variable, `--dsh-font-family-${role}`])
  const previous = new Map(properties.map(property => [property, { value: style.getPropertyValue(property), priority: style.getPropertyPriority(property) }]))
  const owned = new Map<string, { value: string; priority: string }>()
  const apply = (): void => {
    const typography = preference.getTypographySnapshot()
    const capabilities = preference.getCapabilitiesSnapshot()
    for (const role of MOBILE_FONT_ROLES) {
      for (const [property, value] of [[roleSpecs[role].variable, `${typography.sizes[role]}px`], [`--dsh-font-family-${role}`, typography.families[role]]] as const) {
        const current = style.getPropertyValue(property)
        const priority = style.getPropertyPriority(property)
        const last = owned.get(property)
        const supported = property === roleSpecs[role].variable ? role === 'text' || capabilities.codeSize
          : role === 'text' ? capabilities.textFamily : capabilities.codeFamily
        if (!supported) {
          if (last !== undefined) {
            if (current === last.value && priority === last.priority) {
              const foreign = previous.get(property)!
              if (foreign.value === '') style.removeProperty(property)
              else style.setProperty(property, foreign.value, foreign.priority)
            } else previous.set(property, { value: current, priority })
            owned.delete(property)
          }
          continue
        }
        if (last === undefined || current !== last.value || priority !== last.priority) previous.set(property, { value: current, priority })
        owned.set(property, { value, priority: '' })
        if (current === value && priority === '') continue
        if (value === '') style.removeProperty(property)
        else style.setProperty(property, value)
      }
    }
  }
  let lastBodyState = ''
  const bodyState = (): string => `${style.cssText}|${document.body.className}|${document.body.getAttribute('data-ds-dark-theme')}`
  const applyAndRemember = (): void => { apply(); lastBodyState = bodyState() }
  const refresh = (): void => { preference.updateCapabilities(readMobileTypographyCapabilities(document)); applyAndRemember() }
  refresh()
  const unsubscribe = preference.subscribe(applyAndRemember)
  const observer = new MutationObserver(() => { if (bodyState() !== lastBodyState) refresh() })
  observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'class', 'data-ds-dark-theme'] })
  const themeObserver = new MutationObserver(records => {
    const isSheet = (node: Node): boolean => node instanceof Element && (node.matches('style,link[rel="stylesheet"]') || node.querySelector('style,link[rel="stylesheet"]') !== null)
    if (records.some(record => (record.target instanceof Element && record.target.closest('style,link[rel="stylesheet"]') !== null)
      || [...record.addedNodes, ...record.removedNodes].some(isSheet))) refresh()
  })
  themeObserver.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['href', 'media', 'disabled', 'rel'] })
  const sheetLoaded = (event: Event): void => {
    if (event.target instanceof Element && event.target.matches('link[rel="stylesheet"]')) refresh()
  }
  document.head.addEventListener('load', sheetLoaded, true)
  return { preference, dispose: () => {
    observer.disconnect()
    themeObserver.disconnect()
    document.head.removeEventListener('load', sheetLoaded, true)
    unsubscribe()
    for (const [property, value] of previous) {
      const last = owned.get(property)
      if (last === undefined || style.getPropertyValue(property) !== last.value || style.getPropertyPriority(property) !== last.priority) continue
      if (value.value === '') style.removeProperty(property)
      else style.setProperty(property, value.value, value.priority)
    }
  } }
}

const messages = {
  zh: { title: '移动端字号', description: '仅保存在当前访问地址的本地数据中，不影响电脑或其他设备。', decrease: '减小移动端字号', increase: '增大移动端字号', more: '更多字体设置', reset: '恢复默认', defaultFamily: '默认字体', familyHint: '填写设备已有的字体，多个名称用逗号分隔；留空使用默认字体。', codeSize: '代码字号', textFamily: '正文字体', codeFamily: '代码字体', limited: '只显示当前 DSH 主题支持的字体选项；其他已保存的设置会保留。' },
  en: { title: 'Mobile font size', description: 'Saved locally for this address, without changing your computer or other devices.', decrease: 'Decrease mobile font size', increase: 'Increase mobile font size', more: 'More font settings', reset: 'Restore defaults', defaultFamily: 'Default font', familyHint: 'Use fonts already on your device, separated by commas. Leave empty for the default.', codeSize: 'Code font size', textFamily: 'Text font', codeFamily: 'Code font', limited: 'Only font options supported by the current DSH theme are shown. Other saved preferences are retained.' },
  it: { title: 'Dimensione testo mobile', description: 'Salvata localmente per questo indirizzo, senza modificare il computer o altri dispositivi.', decrease: 'Riduci il testo mobile', increase: 'Aumenta il testo mobile', more: 'Altre impostazioni dei caratteri', reset: 'Ripristina predefiniti', defaultFamily: 'Carattere predefinito', familyHint: 'Usa caratteri presenti sul dispositivo, separati da virgole. Lascia vuoto per il predefinito.', codeSize: 'Dimensione codice', textFamily: 'Carattere testo', codeFamily: 'Carattere codice', limited: 'Sono mostrate solo le opzioni supportate dal tema DSH corrente. Le altre preferenze salvate vengono mantenute.' },
  ja: { title: 'モバイルの文字サイズ', description: 'このアドレスのローカルデータにのみ保存され、パソコンや他のデバイスには影響しません。', decrease: 'モバイルの文字サイズを小さくする', increase: 'モバイルの文字サイズを大きくする', more: 'その他のフォント設定', reset: '既定に戻す', defaultFamily: '既定のフォント', familyHint: '端末にあるフォントをカンマ区切りで指定します。空欄の場合は既定のフォントを使用します。', codeSize: 'コードの文字サイズ', textFamily: '本文フォント', codeFamily: 'コードフォント', limited: '現在の DSH テーマが対応するフォント設定のみ表示しています。その他の保存済み設定は保持されます。' },
  ko: { title: '모바일 글꼴 크기', description: '이 주소의 로컬 데이터에만 저장되며 컴퓨터나 다른 기기에는 영향을 주지 않습니다.', decrease: '모바일 글꼴 크기 줄이기', increase: '모바일 글꼴 크기 키우기', more: '추가 글꼴 설정', reset: '기본값으로 복원', defaultFamily: '기본 글꼴', familyHint: '기기에 있는 글꼴을 쉼표로 구분해 입력하세요. 비워 두면 기본 글꼴을 사용합니다.', codeSize: '코드 글꼴 크기', textFamily: '본문 글꼴', codeFamily: '코드 글꼴', limited: '현재 DSH 테마가 지원하는 글꼴 옵션만 표시합니다. 그 밖의 저장된 설정은 유지됩니다.' },
  es: { title: 'Tamaño de fuente móvil', description: 'Se guarda localmente para esta dirección, sin cambiar tu computadora ni otros dispositivos.', decrease: 'Reducir el tamaño de fuente móvil', increase: 'Aumentar el tamaño de fuente móvil', more: 'Más ajustes de fuente', reset: 'Restablecer valores predeterminados', defaultFamily: 'Fuente predeterminada', familyHint: 'Usa fuentes que ya estén en tu dispositivo, separadas por comas. Déjalo vacío para usar la predeterminada.', codeSize: 'Tamaño de fuente del código', textFamily: 'Fuente del texto', codeFamily: 'Fuente del código', limited: 'Solo se muestran las opciones de fuente compatibles con el tema DSH actual. Las demás preferencias guardadas se conservan.' },
  fr: { title: 'Taille de police mobile', description: 'Enregistrée localement pour cette adresse, sans modifier votre ordinateur ni vos autres appareils.', decrease: 'Réduire la taille de police mobile', increase: 'Augmenter la taille de police mobile', more: 'Autres réglages de police', reset: 'Rétablir les valeurs par défaut', defaultFamily: 'Police par défaut', familyHint: 'Utiliser des polices déjà présentes sur l’appareil, séparées par des virgules. Laisser vide pour la police par défaut.', codeSize: 'Taille de police du code', textFamily: 'Police du texte', codeFamily: 'Police du code', limited: 'Seules les options de police prises en charge par le thème DSH actuel sont affichées. Les autres préférences enregistrées sont conservées.' },
  de: { title: 'Mobile Schriftgröße', description: 'Wird lokal für diese Adresse gespeichert, ohne Ihren Computer oder andere Geräte zu ändern.', decrease: 'Mobile Schriftgröße verkleinern', increase: 'Mobile Schriftgröße vergrößern', more: 'Weitere Schrift-Einstellungen', reset: 'Standard wiederherstellen', defaultFamily: 'Standardschrift', familyHint: 'Verwenden Sie Schriften, die bereits auf dem Gerät vorhanden sind, getrennt durch Kommas. Leer lassen für die Standardschrift.', codeSize: 'Schriftgröße für Code', textFamily: 'Textschrift', codeFamily: 'Codeschrift', limited: 'Es werden nur Schriftoptionen angezeigt, die das aktuelle DSH-Theme unterstützt. Andere gespeicherte Einstellungen bleiben erhalten.' },
} as const

function FontFamilyInput({ preference, role, value, label, placeholder }: { preference: MobileFontPreference; role: MobileFontRole; value: string; label: string; placeholder: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return createElement('label', { className: 'dsh-mobile-settings_fontFamily' },
    createElement('span', { className: 'dsh-mobile-settings_title' }, label),
    createElement('input', { type: 'text', value: draft, maxLength: MAX_FONT_FAMILY_LENGTH, placeholder, autoComplete: 'off', spellCheck: false, 'data-mobile-font-family': role,
      onChange: (event: { currentTarget: HTMLInputElement }) => { setDraft(event.currentTarget.value) },
      onBlur: () => { preference.setRoleFamily(role, draft); setDraft(preference.getTypographySnapshot().families[role]) } }))
}

/** General settings row matching the existing Mobile controls and DSH theme tokens. */
export function MobileFontSizeRow({ preference, locale }: { preference: MobileFontPreference; locale: keyof typeof messages }) {
  const typography = useSyncExternalStore(preference.subscribe, preference.getTypographySnapshot)
  const capabilities = useSyncExternalStore(preference.subscribeCapabilities, preference.getCapabilitiesSnapshot)
  const copy = messages[locale]
  const controls = (role: MobileFontRole, title: string) => {
    const size = typography.sizes[role]
    return createElement('div', { className: 'dsh-mobile-settings_fontControls', 'data-mobile-font-role': role },
      createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', 'aria-label': `${copy.decrease}: ${title}`,
        disabled: size === roleSpecs[role].min, onClick: () => { preference.setRoleSize(role, size - 1) } }, '−'),
      createElement('output', { 'aria-live': 'polite', 'aria-label': title }, `${size}px`),
      createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', 'aria-label': `${copy.increase}: ${title}`,
        disabled: size === MAX_MOBILE_FONT_SIZE, onClick: () => { preference.setRoleSize(role, size + 1) } }, '+'))
  }
  return createElement('div', { lang: locale, 'data-mobile-font-setting': true },
    createElement('div', { className: 'dsh-mobile-settings_row' },
      createElement('div', { className: 'dsh-mobile-settings_rowText' },
        createElement('div', { className: 'dsh-mobile-settings_title' }, copy.title),
        createElement('div', { className: 'dsh-mobile-settings_desc' }, copy.description)),
      controls('text', copy.title)),
    !Object.values(capabilities).every(Boolean) && createElement('p', { className: 'dsh-mobile-settings_desc', 'data-mobile-font-limited': true }, copy.limited),
    Object.values(capabilities).some(Boolean) && createElement('details', { className: 'dsh-mobile-settings_fontDetails' },
      createElement('summary', null, copy.more),
      (capabilities.textFamily || capabilities.codeFamily) && createElement('p', { className: 'dsh-mobile-settings_desc' }, copy.familyHint),
      capabilities.codeSize && createElement('div', { className: 'dsh-mobile-settings_row' },
        createElement('span', { className: 'dsh-mobile-settings_rowText dsh-mobile-settings_title' }, copy.codeSize),
        controls('code', copy.codeSize)),
      ...MOBILE_FONT_ROLES.filter(role => role === 'text' ? capabilities.textFamily : capabilities.codeFamily).map(role => createElement(FontFamilyInput, { key: role, preference, role, value: typography.families[role],
        label: role === 'text' ? copy.textFamily : copy.codeFamily, placeholder: copy.defaultFamily }))),
    createElement('div', { className: 'dsh-mobile-settings_row' }, createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector',
      'data-mobile-font-reset': true, onClick: () => { preference.resetSupported() } }, copy.reset)))
}
