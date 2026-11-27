import { describe, expect, it } from 'vitest'
import { browserUiLocaleCookie, readBrowserUiLocale, resolveBrowserUiLocale } from '../src/browser-ui-locale.js'

describe('remembered browser UI locale', () => {
  it.each(['en', 'zh', 'it', 'ja', 'ko', 'es', 'fr', 'de'] as const)('prefers saved %s to browser language', locale => {
    expect(resolveBrowserUiLocale(`other=bad; dsh_ma_ui_locale=${locale}`, 'zh-HK,en;q=0.8')).toBe(locale)
  })

  it.each([undefined, '', 'other=en', 'dsh_ma_ui_locale=', 'dsh_ma_ui_locale=EN',
    'dsh_ma_ui_locale=%65n', 'dsh_ma_ui_locale=nl', 'dsh_ma_ui_locale=<script>',
    'dsh_ma_ui_locale=en=extra', 'dsh_ma_ui_locale=en; dsh_ma_ui_locale=zh',
    'dsh_ma_ui_locale=en; dsh_ma_ui_locale=en', 'dsh_ma_ui_locale',
    'dsh_ma_ui_locale; dsh_ma_ui_locale=en', 'dsh_ma_ui_locale=en; dsh_ma_ui_locale', 'x'.repeat(8193),
  ])('falls back safely for absent or invalid preference %#', header => {
    expect(readBrowserUiLocale(header)).toBeUndefined()
    expect(resolveBrowserUiLocale(header, 'zh-HK,en;q=0.8')).toBe('zh')
    expect(resolveBrowserUiLocale(header, undefined)).toBe('en')
  })

  it('does not let an unrelated malformed cookie invalidate the preference', () => {
    expect(readBrowserUiLocale('unrelated; dsh_ma_ui_locale=it; other=<bad>')).toBe('it')
    expect(readBrowserUiLocale('dsh_ma_ui_localeX; dsh_ma_ui_locale=it')).toBe('it')
  })

  it('writes a persistent narrow host-only presentation cookie, secure on HTTPS', () => {
    expect(browserUiLocaleCookie('en', true)).toBe('dsh_ma_ui_locale=en; Path=/mobile-access; Max-Age=31536000; SameSite=Lax; Secure')
    expect(browserUiLocaleCookie('zh', false)).toBe('dsh_ma_ui_locale=zh; Path=/mobile-access; Max-Age=31536000; SameSite=Lax')
  })
})
