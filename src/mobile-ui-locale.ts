import type { AuthPageLocale } from './auth-pages.js'
import { browserUiLocaleCookie } from './browser-ui-locale.js'

/** Remember the DSH display language only on authenticated Mobile Gateway documents. */
export function installMobileUiLocalePersistence(page: Document, view: Window): () => void {
  if (page.querySelector('meta[name="dsh-mobile-gateway"][content="authenticated"]') === null) return () => {}
  let disposed = false
  let previous: AuthPageLocale | undefined
  const sync = (): void => {
    if (disposed) return
    const language = page.documentElement.lang.trim().toLowerCase()
    if (language === '') return
    const base = language.split(/[-_]/u)[0]
    const locale: AuthPageLocale = base === 'zh' || base === 'it' || base === 'ja' || base === 'ko' || base === 'es' || base === 'fr' || base === 'de' ? base : 'en'
    if (locale === previous) return
    try {
      page.cookie = browserUiLocaleCookie(locale, view.location.protocol === 'https:')
      previous = locale
    } catch {
      // Storage denial must not interrupt the authenticated page or its lifecycle.
    }
  }
  const observer = new (view as Window & typeof globalThis).MutationObserver(sync)
  observer.observe(page.documentElement, { attributes: true, attributeFilter: ['lang'] })
  sync()
  return () => { disposed = true; observer.disconnect() }
}
