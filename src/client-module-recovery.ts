/** Authenticated recovery document for a saved module selection that cannot boot the current DSH graph. */
import type { AuthPageLocale } from './auth-pages.js'
import { MOBILE_VIEWPORT_CONTENT } from './mobile-viewport.js'

export const CLIENT_MODULE_RECOVERY_COPY = {
  zh: {
    title: '移动页面模块需要调整',
    explanation: '电脑上的插件或依赖关系已变化，之前保存的模块选择无法加载当前页面。',
    scope: '可为本设备加载全部模块并重新打开 DSH。不会修改电脑默认设置、其他设备或已安装的插件。',
    action: '为本设备加载全部模块并重试',
    working: '正在更新本设备的模块选择…',
    failed: '未能恢复。请确认电脑和远程通道仍在线，然后重试。',
  },
  en: {
    title: 'Mobile page modules need attention',
    explanation: 'The computer’s plugins or dependencies have changed. The saved module selection can no longer load this page.',
    scope: 'Load all modules for this device and reopen DSH. Computer defaults, other devices, and installed plugins are unchanged.',
    action: 'Load all modules for this device and retry',
    working: 'Updating this device’s module selection…',
    failed: 'Could not restore the page. Check that the computer and remote connection are online, then retry.',
  },
  it: {
    title: 'I moduli della pagina mobile richiedono attenzione',
    explanation: 'I plugin o le dipendenze del computer sono cambiati. La selezione salvata non può più caricare questa pagina.',
    scope: 'Carica tutti i moduli per questo dispositivo e riapri DSH. I predefiniti del computer, gli altri dispositivi e i plugin installati non cambiano.',
    action: 'Carica tutti i moduli per questo dispositivo e riprova',
    working: 'Aggiornamento dei moduli per questo dispositivo…',
    failed: 'Ripristino non riuscito. Verifica che il computer e la connessione remota siano online, poi riprova.',
  },
} as const

/** Render an explicit device-only recovery action without interpolating graph diagnostics or credentials.
 * @param locale - Negotiated browser display language.
 * @returns An owned HTML page which changes no selection until the user activates its button.
 */
export function renderClientModuleRecoveryPage(locale: AuthPageLocale): string {
  const copy = CLIENT_MODULE_RECOVERY_COPY[locale]
  return `<!doctype html>
<html lang="${locale === 'zh' ? 'zh-CN' : locale}">
<head><meta charset="utf-8"><meta name="viewport" content="${MOBILE_VIEWPORT_CONTENT}">
<meta name="color-scheme" content="light dark"><title>${copy.title}</title>
<style>
body{margin:0;background:Canvas;color:CanvasText;font:16px/1.5 system-ui,sans-serif}
main{box-sizing:border-box;max-width:640px;margin:32px auto;padding:24px max(24px,env(safe-area-inset-left)) 24px max(24px,env(safe-area-inset-right));overflow-wrap:anywhere}
h1{font-size:24px;line-height:1.3}button{min-height:48px;max-width:100%;padding:12px 20px;border:1px solid ButtonText;border-radius:12px;background:ButtonFace;color:ButtonText;font:inherit;cursor:pointer}
button:focus-visible{outline:2px solid Highlight;outline-offset:3px}button:disabled{opacity:.6;cursor:wait}#recovery-status{min-height:1.5em}
</style></head>
<body><main><h1>${copy.title}</h1><p>${copy.explanation}</p><p>${copy.scope}</p>
<button id="load-all-modules" type="button">${copy.action}</button><p id="recovery-status" role="status" aria-live="polite"></p>
</main><script>${renderClientModuleRecoveryScript(locale)}</script></body></html>
`
}

/** Render the fixed same-origin action; CSRF values are read from the active browser cookie only at user activation.
 * @param locale - Negotiated browser display language.
 * @returns JavaScript that preserves selections on failure and reloads only after an authorized save succeeds.
 */
export function renderClientModuleRecoveryScript(locale: AuthPageLocale): string {
  const copy = CLIENT_MODULE_RECOVERY_COPY[locale]
  return `(() => {
  const button = document.getElementById('load-all-modules')
  const status = document.getElementById('recovery-status')
  button.addEventListener('click', async () => {
    if (button.disabled) return
    button.disabled = true
    status.textContent = ${JSON.stringify(copy.working)}
    try {
      const values = document.cookie.split(';').map(value => value.trim())
      const host = values.filter(value => value.startsWith('__Host-dsh_ma_csrf='))
      const candidates = host.length === 0 ? values.filter(value => value.startsWith('dsh_ma_csrf=')) : host
      if (candidates.length !== 1) throw new Error('csrf_unavailable')
      const csrf = candidates[0].slice(candidates[0].indexOf('=') + 1)
      const response = await fetch('/mobile-access/client-modules', {
        method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-dsh-mobile-csrf': csrf },
        body: JSON.stringify({ excludedClientModules: [] }),
      })
      if (!response.ok) throw new Error('recovery_failed')
      location.reload()
    } catch {
      status.textContent = ${JSON.stringify(copy.failed)}
      button.disabled = false
    }
  })
})()`
}
