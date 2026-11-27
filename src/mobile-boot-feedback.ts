/** Framework-free feedback for a Gateway document whose application entry never renders. */
type BootFailure = 'syntax_error' | 'script_execution_failed' | 'script_load_failed' | 'promise_rejected' | 'startup_stalled'
type BootLocale = 'zh' | 'en' | 'it' | 'ja' | 'ko' | 'es' | 'fr' | 'de'

const COPY = {
  en: {
    title: 'DSH could not start',
    syntax_error: 'A page script could not be read by this web engine. This DSH client may require a newer engine.',
    script_execution_failed: 'A page script stopped before DSH could display its interface.',
    script_load_failed: 'A required page script could not be loaded. Check the connection to this computer.',
    promise_rejected: 'Page startup failed before DSH could display its interface.',
    startup_stalled: 'DSH has not displayed its interface yet. The connection may be slow, or this web engine may not support the client.',
    help: 'Update the system WebView or its browser if an update is available. You can also use this computer’s mobile access address in a supported browser. Pairings have not been removed.',
    retry: 'Reload page',
    dismiss: 'Keep waiting',
  },
  zh: {
    title: 'DSH 未能启动',
    syntax_error: '当前网页内核无法解析页面脚本。此 DSH 客户端可能需要更新的内核。',
    script_execution_failed: '页面脚本在 DSH 显示界面前停止运行。',
    script_load_failed: '必需的页面脚本加载失败，请检查与这台电脑的连接。',
    promise_rejected: '页面启动失败，DSH 尚未显示界面。',
    startup_stalled: 'DSH 尚未显示界面。连接可能较慢，当前网页内核也可能不支持此客户端。',
    help: '如有可用更新，请更新系统 WebView 或提供它的浏览器。也可在受支持的浏览器中打开这台电脑的移动访问地址。已有配对未被删除。',
    retry: '重新载入页面',
    dismiss: '继续等待',
  },
  it: {
    title: 'Impossibile avviare DSH',
    syntax_error: 'Il motore web non riesce a interpretare uno script della pagina. Questo client DSH potrebbe richiedere un motore più recente.',
    script_execution_failed: 'Uno script si è interrotto prima che DSH potesse mostrare l’interfaccia.',
    script_load_failed: 'Impossibile caricare uno script necessario. Controlla la connessione a questo computer.',
    promise_rejected: 'L’avvio della pagina non è riuscito prima che DSH potesse mostrare l’interfaccia.',
    startup_stalled: 'DSH non ha ancora mostrato l’interfaccia. La connessione potrebbe essere lenta o il motore web potrebbe non supportare il client.',
    help: 'Aggiorna WebView di sistema o il browser che lo fornisce, se è disponibile un aggiornamento. Puoi anche aprire l’indirizzo di accesso mobile di questo computer in un browser supportato. Gli abbinamenti non sono stati rimossi.',
    retry: 'Ricarica pagina',
    dismiss: 'Continua ad attendere',
  },
  ja: {
    title: 'DSH を起動できませんでした',
    syntax_error: 'この Web エンジンはページスクリプトを解釈できませんでした。この DSH クライアントには、より新しいエンジンが必要な可能性があります。',
    script_execution_failed: 'DSH が画面を表示する前に、ページスクリプトが停止しました。',
    script_load_failed: '必要なページスクリプトを読み込めませんでした。このコンピューターへの接続を確認してください。',
    promise_rejected: 'DSH が画面を表示する前に、ページの起動に失敗しました。',
    startup_stalled: 'DSH はまだ画面を表示していません。接続が遅いか、この Web エンジンがクライアントに対応していない可能性があります。',
    help: '更新が提供されている場合は、システムの WebView またはそれを提供するブラウザーを更新してください。対応ブラウザーでこのコンピューターのモバイルアクセスアドレスを開くこともできます。既存のペアリングは削除されていません。',
    retry: 'ページを再読み込み',
    dismiss: '待機を続ける',
  },
  ko: {
    title: 'DSH를 시작할 수 없습니다',
    syntax_error: '이 웹 엔진이 페이지 스크립트를 해석할 수 없습니다. 이 DSH 클라이언트에는 더 새로운 엔진이 필요할 수 있습니다.',
    script_execution_failed: 'DSH가 화면을 표시하기 전에 페이지 스크립트가 중지되었습니다.',
    script_load_failed: '필수 페이지 스크립트를 불러올 수 없습니다. 이 컴퓨터와의 연결을 확인하십시오.',
    promise_rejected: 'DSH가 화면을 표시하기 전에 페이지 시작에 실패했습니다.',
    startup_stalled: 'DSH가 아직 화면을 표시하지 않았습니다. 연결이 느리거나 이 웹 엔진이 클라이언트를 지원하지 않을 수 있습니다.',
    help: '사용 가능한 업데이트가 있으면 시스템 WebView 또는 이를 제공하는 브라우저를 업데이트하십시오. 지원되는 브라우저에서 이 컴퓨터의 모바일 액세스 주소를 열 수도 있습니다. 기존 페어링은 삭제되지 않았습니다.',
    retry: '페이지 다시 로드',
    dismiss: '계속 기다리기',
  },
  es: {
    title: 'No se pudo iniciar DSH',
    syntax_error: 'Este motor web no pudo leer un script de la página. Es posible que este cliente de DSH requiera un motor más reciente.',
    script_execution_failed: 'Un script de la página se detuvo antes de que DSH pudiera mostrar su interfaz.',
    script_load_failed: 'No se pudo cargar un script necesario de la página. Comprueba la conexión con esta computadora.',
    promise_rejected: 'No se pudo iniciar la página antes de que DSH mostrara su interfaz.',
    startup_stalled: 'DSH aún no ha mostrado su interfaz. Es posible que la conexión sea lenta o que este motor web no admita el cliente.',
    help: 'Actualiza la WebView del sistema o el navegador que la proporciona si hay una actualización disponible. También puedes abrir la dirección de acceso móvil de esta computadora en un navegador compatible. Los emparejamientos no se han eliminado.',
    retry: 'Vuelve a cargar la página',
    dismiss: 'Sigue esperando',
  },
  fr: {
    title: 'DSH n’a pas pu démarrer',
    syntax_error: 'Ce moteur web n’a pas pu lire un script de la page. Ce client DSH peut nécessiter un moteur plus récent.',
    script_execution_failed: 'Un script de la page s’est arrêté avant que DSH puisse afficher son interface.',
    script_load_failed: 'Impossible de charger un script de page requis. Vérifier la connexion à cet ordinateur.',
    promise_rejected: 'Le démarrage de la page a échoué avant que DSH puisse afficher son interface.',
    startup_stalled: 'DSH n’a pas encore affiché son interface. La connexion est peut-être lente, ou ce moteur web ne prend peut-être pas en charge le client.',
    help: 'Mettre à jour la WebView du système ou le navigateur qui la fournit si une mise à jour est disponible. Il est aussi possible d’ouvrir l’adresse d’accès mobile de cet ordinateur dans un navigateur pris en charge. Les appairages n’ont pas été supprimés.',
    retry: 'Recharger la page',
    dismiss: 'Continuer à attendre',
  },
  de: {
    title: 'DSH konnte nicht gestartet werden',
    syntax_error: 'Diese Web-Engine konnte ein Seitenskript nicht lesen. Dieser DSH-Client benötigt möglicherweise eine neuere Engine.',
    script_execution_failed: 'Ein Seitenskript wurde beendet, bevor DSH seine Oberfläche anzeigen konnte.',
    script_load_failed: 'Ein erforderliches Seitenskript konnte nicht geladen werden. Prüfen Sie die Verbindung zu diesem Computer.',
    promise_rejected: 'Der Seitenstart ist fehlgeschlagen, bevor DSH seine Oberfläche anzeigen konnte.',
    startup_stalled: 'DSH hat seine Oberfläche noch nicht angezeigt. Die Verbindung ist möglicherweise langsam, oder diese Web-Engine unterstützt den Client nicht.',
    help: 'Aktualisieren Sie die System-WebView oder den Browser, der sie bereitstellt, sofern ein Update verfügbar ist. Sie können auch die Mobilzugriffsadresse dieses Computers in einem unterstützten Browser öffnen. Kopplungen wurden nicht entfernt.',
    retry: 'Seite neu laden',
    dismiss: 'Weiter warten',
  },
} satisfies Record<BootLocale, Record<BootFailure | 'title' | 'help' | 'retry' | 'dismiss', string>>

const STYLE = `
.dsh-mobile-boot-feedback{--dshm-boot-bg:#fff;--dshm-boot-text:#111827;--dshm-boot-secondary:#475569;--dshm-boot-border:#cbd5e1;box-sizing:border-box;position:fixed;z-index:1000;top:max(16px,env(safe-area-inset-top));right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));left:max(16px,env(safe-area-inset-left));width:auto;max-width:34rem;height:fit-content;max-height:calc(100vh - 32px);overflow:auto;margin:auto;padding:24px;border:1px solid var(--dsw-alias-border-l2,var(--dshm-boot-border));border-radius:16px;background:var(--dsw-alias-bg-layer-2,var(--dshm-boot-bg));color:var(--dsw-alias-label-primary,var(--dshm-boot-text));font:400 1rem/1.5 system-ui,sans-serif;overflow-wrap:anywhere}
.dsh-mobile-boot-feedback h1{margin:0 0 16px;font-size:1.25em;line-height:1.35}.dsh-mobile-boot-feedback p{margin:0 0 16px}.dsh-mobile-boot-feedback small{display:block;margin-bottom:16px;color:var(--dsw-alias-label-secondary,var(--dshm-boot-secondary));font-size:.875em}.dsh-mobile-boot-feedback__actions{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px}.dsh-mobile-boot-feedback button{box-sizing:border-box;flex:1 1 10rem;min-width:0;min-height:48px;padding:10px 16px;border:1px solid var(--dsw-alias-border-l2,var(--dshm-boot-border));border-radius:12px;background:var(--dsw-alias-bg-layer-2,var(--dshm-boot-bg));color:inherit;font:inherit;cursor:pointer;touch-action:manipulation}.dsh-mobile-boot-feedback button:active{opacity:.7}.dsh-mobile-boot-feedback button:focus-visible{outline:3px solid var(--dsw-alias-label-primary-bluish,#2563eb);outline-offset:3px}
@media(prefers-color-scheme:dark){.dsh-mobile-boot-feedback{--dshm-boot-bg:#1e293b;--dshm-boot-text:#f8fafc;--dshm-boot-secondary:#cbd5e1;--dshm-boot-border:#64748b}}
`

/** Pick only supported languages without reading user settings or Host state. */
function locale(): BootLocale {
  for (const value of [...(navigator.languages ?? [navigator.language]), document.documentElement.lang]) {
    const language = value.toLowerCase().split(/[-_]/u)[0]
    if (language === 'en' || language === 'it' || language === 'zh' || language === 'ja' || language === 'ko'
      || language === 'es' || language === 'fr' || language === 'de') return language
  }
  return 'en'
}

/**
 * Observe early script failures only until DSH renders into its own mount point.
 * The notice never replaces application content, retries automatically, transfers
 * credentials, or reads error messages, stacks, resource URLs, or stored pairings.
 * @returns Removes this document's listeners, timer and notice.
 */
export function installMobileBootFeedback(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined'
    || document.querySelector('meta[name="dsh-mobile-gateway"][content="authenticated"]') === null
    || document.documentElement.hasAttribute('data-dsh-mobile-boot-feedback-installed')) return () => {}
  document.documentElement.setAttribute('data-dsh-mobile-boot-feedback-installed', '')
  // Browsers intentionally hide a connected script's nonce from getAttribute().
  const nonce = document.currentScript?.nonce ?? ''
  let failure: BootFailure | undefined
  let notice: HTMLElement | undefined
  let style: HTMLStyleElement | undefined
  let observer: MutationObserver | undefined
  let stopped = false
  const stop = (): void => {
    stopped = true
    window.clearTimeout(deadline)
    window.removeEventListener('error', onError, true)
    window.removeEventListener('unhandledrejection', onRejection)
    window.removeEventListener('pagehide', stop)
    document.removeEventListener('DOMContentLoaded', inspect)
    observer?.disconnect()
    notice?.remove()
    style?.remove()
  }
  const inspect = (): void => {
    if (stopped) return
    const root = document.getElementById('root')
    if (root === null || document.body === null) return
    // DSH owns its loader and error page as soon as it renders. In particular,
    // never hide [data-dsh-boot] to bypass the App's native readiness checks.
    if (root.childElementCount > 0 || root.textContent?.trim()) { stop(); return }
    if (observer === undefined) {
      observer = new MutationObserver(inspect)
      observer.observe(root, { childList: true, characterData: true, subtree: true })
    }
    if (failure === undefined || notice !== undefined) return
    const copy = COPY[locale()]
    style = document.createElement('style')
    if (nonce !== '') style.setAttribute('nonce', nonce)
    style.textContent = STYLE
    document.head.append(style)
    notice = document.createElement('section')
    notice.className = 'dsh-mobile-boot-feedback'
    notice.setAttribute('data-dsh-mobile-boot-failure', failure)
    notice.setAttribute('role', 'alert')
    notice.setAttribute('aria-labelledby', 'dsh-mobile-boot-feedback-title')
    const title = document.createElement('h1')
    title.id = 'dsh-mobile-boot-feedback-title'
    title.textContent = copy.title
    const summary = document.createElement('p')
    summary.textContent = copy[failure]
    const help = document.createElement('p')
    help.textContent = copy.help
    const code = document.createElement('small')
    code.textContent = `DSH Mobile · ${failure}`
    const actions = document.createElement('div')
    actions.className = 'dsh-mobile-boot-feedback__actions'
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = copy.retry
    retry.addEventListener('click', () => { stop(); window.location.reload() })
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.textContent = copy.dismiss
    dismiss.addEventListener('click', stop)
    actions.append(retry, dismiss)
    notice.append(title, summary, actions, help, code)
    document.body.append(notice)
  }
  const record = (kind: BootFailure): void => {
    if (stopped || failure !== undefined) return
    failure = kind
    inspect()
  }
  const onError = (event: Event): void => {
    if (event.target !== null && 'tagName' in event.target && event.target.tagName === 'SCRIPT') record('script_load_failed')
    else if (event instanceof ErrorEvent) record(event.error instanceof SyntaxError ? 'syntax_error' : 'script_execution_failed')
  }
  const onRejection = (): void => { record('promise_rejected') }
  const deadline = window.setTimeout(() => { record('startup_stalled') }, 12_000)
  window.addEventListener('error', onError, true)
  window.addEventListener('unhandledrejection', onRejection)
  window.addEventListener('pagehide', stop)
  document.addEventListener('DOMContentLoaded', inspect, { once: true })
  inspect()
  return stop
}
