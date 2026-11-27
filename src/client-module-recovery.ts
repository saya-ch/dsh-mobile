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
  ja: {
    title: 'モバイルページのモジュールを調整する必要があります',
    explanation: 'コンピューターのプラグインまたは依存関係が変更されたため、保存されたモジュール選択ではこのページを読み込めません。',
    scope: 'このデバイスのすべてのモジュールを読み込んで DSH を開き直します。コンピューターの既定設定、ほかのデバイス、インストール済みのプラグインは変更されません。',
    action: 'このデバイスのすべてのモジュールを読み込んで再試行',
    working: 'このデバイスのモジュール選択を更新しています…',
    failed: '復元できませんでした。コンピューターとリモート接続がオンラインであることを確認して、再試行してください。',
  },
  ko: {
    title: '모바일 페이지 모듈을 조정해야 합니다',
    explanation: '컴퓨터의 플러그인 또는 종속성이 변경되어 저장된 모듈 선택으로는 이 페이지를 불러올 수 없습니다.',
    scope: '이 기기의 모든 모듈을 불러오고 DSH를 다시 엽니다. 컴퓨터의 기본 설정, 다른 기기, 설치된 플러그인은 변경되지 않습니다.',
    action: '이 기기의 모든 모듈을 불러오고 다시 시도',
    working: '이 기기의 모듈 선택을 업데이트하는 중…',
    failed: '복원하지 못했습니다. 컴퓨터와 원격 연결이 온라인인지 확인한 후 다시 시도하십시오.',
  },
  es: {
    title: 'Los módulos de la página móvil necesitan atención',
    explanation: 'Los plugins o las dependencias de la computadora cambiaron. La selección de módulos guardada ya no puede cargar esta página.',
    scope: 'Carga todos los módulos para este dispositivo y vuelve a abrir DSH. Los valores predeterminados de la computadora, otros dispositivos y los plugins instalados no cambian.',
    action: 'Cargar todos los módulos de este dispositivo y reintentar',
    working: 'Actualizando la selección de módulos de este dispositivo…',
    failed: 'No se pudo restaurar la página. Comprueba que la computadora y la conexión remota estén en línea y vuelve a intentarlo.',
  },
  fr: {
    title: 'Les modules de la page mobile nécessitent une intervention',
    explanation: 'Les plugins ou les dépendances de l’ordinateur ont changé. La sélection de modules enregistrée ne peut plus charger cette page.',
    scope: 'Charger tous les modules pour cet appareil et rouvrir DSH. Les valeurs par défaut de l’ordinateur, les autres appareils et les plugins installés ne changent pas.',
    action: 'Charger tous les modules de cet appareil et réessayer',
    working: 'Mise à jour de la sélection de modules de cet appareil…',
    failed: 'Impossible de restaurer la page. Vérifiez que l’ordinateur et la connexion distante sont en ligne, puis réessayez.',
  },
  de: {
    title: 'Module der mobilen Seite benötigen Aufmerksamkeit',
    explanation: 'Die Plugins oder Abhängigkeiten des Computers haben sich geändert. Die gespeicherte Modulauswahl kann diese Seite nicht mehr laden.',
    scope: 'Alle Module für dieses Gerät laden und DSH erneut öffnen. Standardwerte des Computers, andere Geräte und installierte Plugins bleiben unverändert.',
    action: 'Alle Module für dieses Gerät laden und erneut versuchen',
    working: 'Modulauswahl dieses Geräts wird aktualisiert…',
    failed: 'Die Seite konnte nicht wiederhergestellt werden. Prüfen Sie, ob der Computer und die Remote-Verbindung online sind, und versuchen Sie es erneut.',
  },
} as const

/** Regional HTML tags for the negotiated page languages; the bare language code is used otherwise. */
const CLIENT_MODULE_RECOVERY_HTML_LANG: Readonly<Record<string, string>> = {
  zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', es: 'es-ES', fr: 'fr-FR', de: 'de-DE',
}

/** Render an explicit device-only recovery action without interpolating graph diagnostics or credentials.
 * @param locale - Negotiated browser display language.
 * @returns An owned HTML page which changes no selection until the user activates its button.
 */
export function renderClientModuleRecoveryPage(locale: AuthPageLocale): string {
  const copy = CLIENT_MODULE_RECOVERY_COPY[locale]
  return `<!doctype html>
<html lang="${CLIENT_MODULE_RECOVERY_HTML_LANG[locale] ?? locale}">
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
