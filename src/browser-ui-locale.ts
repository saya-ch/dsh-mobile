import { resolveAuthPageLocale, type AuthPageLocale } from './auth-pages.js'

const UI_LOCALE_COOKIE = 'dsh_ma_ui_locale'

/** Read presentation data only; malformed or ambiguous cookies keep browser negotiation. */
export function readBrowserUiLocale(cookieHeader: string | undefined): AuthPageLocale | undefined {
  if (cookieHeader === undefined || cookieHeader.length > 8192) return undefined
  let locale: AuthPageLocale | undefined
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=')
    const name = (separator === -1 ? part : part.slice(0, separator)).trim()
    if (name !== UI_LOCALE_COOKIE) continue
    const value = separator === -1 ? '' : part.slice(separator + 1).trim()
    if (locale !== undefined || (value !== 'en' && value !== 'zh' && value !== 'it' && value !== 'ja' && value !== 'ko' && value !== 'es' && value !== 'fr' && value !== 'de')) return undefined
    locale = value
  }
  return locale
}

/** Prefer the last DSH display language over the browser's default language. */
export function resolveBrowserUiLocale(cookieHeader: string | undefined, acceptLanguage: string | undefined): AuthPageLocale {
  return readBrowserUiLocale(cookieHeader) ?? resolveAuthPageLocale(acceptLanguage)
}

/** Host-only, non-secret preference, independent of the short authentication session. */
export function browserUiLocaleCookie(locale: AuthPageLocale, secure: boolean): string {
  return `${UI_LOCALE_COOKIE}=${locale}; Path=/mobile-access; Max-Age=31536000; SameSite=Lax${secure ? '; Secure' : ''}`
}
