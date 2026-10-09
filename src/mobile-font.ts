/** Device-local typography for authenticated mobile pages, without Host settings writes. */
import { createElement, useEffect, useState, useSyncExternalStore } from 'react'

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

  private persist(typography: MobileTypography): void {
    this.typography = Object.freeze(typography)
    try { this.storage?.setItem(MOBILE_TYPOGRAPHY_STORAGE_KEY, JSON.stringify(typography)) }
    catch (error) { /* Adjust the current page even when persistence is unavailable. */ }
    try { this.storage?.setItem(MOBILE_FONT_STORAGE_KEY, String(typography.sizes.text)) }
    catch (error) { /* Adjust the current page even when persistence is unavailable. */ }
    for (const listener of this.listeners) listener()
  }
}

/** Keep mobile typography independent from Host theme changes, including body-level portals. */
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
    for (const role of MOBILE_FONT_ROLES) {
      for (const [property, value] of [[roleSpecs[role].variable, `${typography.sizes[role]}px`], [`--dsh-font-family-${role}`, typography.families[role]]] as const) {
        const current = style.getPropertyValue(property)
        const priority = style.getPropertyPriority(property)
        const last = owned.get(property)
        if (last !== undefined && (current !== last.value || priority !== last.priority)) previous.set(property, { value: current, priority })
        owned.set(property, { value, priority: '' })
        if (current === value && priority === '') continue
        if (value === '') style.removeProperty(property)
        else style.setProperty(property, value)
      }
    }
  }
  apply()
  const unsubscribe = preference.subscribe(apply)
  const observer = new MutationObserver(apply)
  observer.observe(document.body, { attributes: true, attributeFilter: ['style'] })
  return { preference, dispose: () => {
    observer.disconnect()
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
  zh: { title: '移动端字号', description: '仅保存在当前访问地址的本地数据中，不影响电脑或其他设备。', decrease: '减小移动端字号', increase: '增大移动端字号', more: '更多字体设置', reset: '恢复默认', defaultFamily: '默认字体', familyHint: '填写设备已有的字体，多个名称用逗号分隔；留空使用默认字体。', codeSize: '代码字号', textFamily: '正文字体', codeFamily: '代码字体' },
  en: { title: 'Mobile font size', description: 'Saved locally for this address, without changing your computer or other devices.', decrease: 'Decrease mobile font size', increase: 'Increase mobile font size', more: 'More font settings', reset: 'Restore defaults', defaultFamily: 'Default font', familyHint: 'Use fonts already on your device, separated by commas. Leave empty for the default.', codeSize: 'Code font size', textFamily: 'Text font', codeFamily: 'Code font' },
  it: { title: 'Dimensione testo mobile', description: 'Salvata localmente per questo indirizzo, senza modificare il computer o altri dispositivi.', decrease: 'Riduci il testo mobile', increase: 'Aumenta il testo mobile', more: 'Altre impostazioni dei caratteri', reset: 'Ripristina predefiniti', defaultFamily: 'Carattere predefinito', familyHint: 'Usa caratteri presenti sul dispositivo, separati da virgole. Lascia vuoto per il predefinito.', codeSize: 'Dimensione codice', textFamily: 'Carattere testo', codeFamily: 'Carattere codice' },
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
    createElement('details', { className: 'dsh-mobile-settings_fontDetails' },
      createElement('summary', null, copy.more),
      createElement('p', { className: 'dsh-mobile-settings_desc' }, copy.familyHint),
      createElement('div', { className: 'dsh-mobile-settings_row' },
        createElement('span', { className: 'dsh-mobile-settings_rowText dsh-mobile-settings_title' }, copy.codeSize),
        controls('code', copy.codeSize)),
      ...MOBILE_FONT_ROLES.map(role => createElement(FontFamilyInput, { key: role, preference, role, value: typography.families[role],
        label: role === 'text' ? copy.textFamily : copy.codeFamily, placeholder: copy.defaultFamily })),
      createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', onClick: () => { preference.reset() } }, copy.reset)))
}
