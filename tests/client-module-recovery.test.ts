import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { CLIENT_MODULE_RECOVERY_COPY, renderClientModuleRecoveryPage, renderClientModuleRecoveryScript } from '../src/client-module-recovery.js'

function scriptFixture(cookie: string, ok = true) {
  let click: (() => Promise<void>) | undefined
  const button = { disabled: false, addEventListener: (_type: string, listener: () => Promise<void>) => { click = listener } }
  const status = { textContent: '' }
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ ok }))
  const reload = vi.fn()
  runInNewContext(renderClientModuleRecoveryScript('en'), {
    document: { cookie, getElementById: (id: string) => id === 'load-all-modules' ? button : status },
    fetch, location: { reload },
  })
  return { click: async () => click!(), button, status, fetch, reload }
}

describe('explicit client module recovery', () => {
  it('keeps every supported language aligned and presents a touch-sized explicit device-only action', () => {
    for (const locale of ['zh', 'en', 'it'] as const) {
      expect(Object.keys(CLIENT_MODULE_RECOVERY_COPY[locale]).sort()).toEqual(Object.keys(CLIENT_MODULE_RECOVERY_COPY.en).sort())
      const page = renderClientModuleRecoveryPage(locale)
      expect(page).toContain(CLIENT_MODULE_RECOVERY_COPY[locale].action)
      expect(page).toContain('min-height:48px')
      expect(page).toContain('interactive-widget=resizes-content')
      expect(page).toContain('role="status" aria-live="polite"')
      expect(page).not.toContain('__DSH_BOOT__')
      expect(page).not.toContain('deviceId')
      expect(page).not.toContain('deviceToken')
    }
  })

  it('does not fetch or reload on page creation and prefers the protected cookie after an explicit click', async () => {
    const fixture = scriptFixture('dsh_ma_csrf=old-value; __Host-dsh_ma_csrf=host-value')
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(fixture.reload).not.toHaveBeenCalled()
    await fixture.click()
    expect(fixture.fetch).toHaveBeenCalledWith('/mobile-access/client-modules', {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-dsh-mobile-csrf': 'host-value' },
      body: JSON.stringify({ excludedClientModules: [] }),
    })
    expect(fixture.reload).toHaveBeenCalledOnce()
  })

  it('uses the legacy cookie only when no protected cookie is present', async () => {
    const fixture = scriptFixture('analytics=unrelated; dsh_ma_csrf=legacy-value')
    await fixture.click()
    expect(new Headers(fixture.fetch.mock.calls[0]![1].headers).get('x-dsh-mobile-csrf')).toBe('legacy-value')
    expect(fixture.reload).toHaveBeenCalledOnce()
  })

  it.each(['', 'dsh_ma_csrf=a; dsh_ma_csrf=b', '__Host-dsh_ma_csrf=a; __Host-dsh_ma_csrf=b; dsh_ma_csrf=legacy'])('retains the page and exposes a retry when the CSRF cookie is unavailable or ambiguous: %s', async cookie => {
    const fixture = scriptFixture(cookie)
    await fixture.click()
    expect(fixture.fetch).not.toHaveBeenCalled()
    expect(fixture.reload).not.toHaveBeenCalled()
    expect(fixture.button.disabled).toBe(false)
    expect(fixture.status.textContent).toBe(CLIENT_MODULE_RECOVERY_COPY.en.failed)
  })

  it('does not reload after an authorization or save failure', async () => {
    const fixture = scriptFixture('dsh_ma_csrf=valid-value', false)
    await fixture.click()
    expect(fixture.reload).not.toHaveBeenCalled()
    expect(fixture.button.disabled).toBe(false)
    expect(fixture.status.textContent).toBe(CLIENT_MODULE_RECOVERY_COPY.en.failed)
  })
})
