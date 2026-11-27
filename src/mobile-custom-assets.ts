import type { MobileControlLocale } from './client-messages.js'

/** Failures that can be reported without exposing authentication or local file contents. */
export type MobileAssetLoadFailure = 'gateway_required' | 'authentication_required' | 'manifest_unavailable' | 'manifest_invalid' | 'resource_unavailable' | 'refresh_failed'

const COPY: Record<MobileControlLocale, Record<MobileAssetLoadFailure | 'recovered', string>> = {
  en: {
    gateway_required: 'Custom mobile CSS, scripts and extensions require a paired DSH Mobile access entry. This page is not using the Mobile gateway.',
    authentication_required: 'Mobile customization was not refreshed because device authentication is unavailable. Reconnect through the current Mobile access entry.',
    manifest_unavailable: 'The mobile extension manifest is unavailable. Check the plugin version and proxy routing; legacy custom files can still load when authorized.',
    manifest_invalid: 'The mobile extension manifest is invalid. Existing customization is retained; check the plugin version and proxy routing.',
    resource_unavailable: 'A mobile customization resource could not be loaded or activated. Check the custom files and current Mobile access entry.',
    refresh_failed: 'Mobile customization could not be refreshed. Check the connection and current Mobile access entry.',
    recovered: 'Mobile customization is available again.',
  },
  it: {
    gateway_required: 'CSS, script ed estensioni mobili personalizzati richiedono un accesso DSH Mobile abbinato. Questa pagina non usa il gateway Mobile.',
    authentication_required: 'La personalizzazione mobile non è stata aggiornata perché l’autenticazione del dispositivo non è disponibile. Riconnettiti tramite l’accesso Mobile attuale.',
    manifest_unavailable: 'Il manifest delle estensioni mobili non è disponibile. Controlla la versione del plugin e le route del proxy; i file personalizzati legacy possono essere caricati se autorizzati.',
    manifest_invalid: 'Il manifest delle estensioni mobili non è valido. La personalizzazione esistente viene mantenuta; controlla la versione del plugin e le route del proxy.',
    resource_unavailable: 'Una risorsa mobile personalizzata non è stata caricata o attivata. Controlla i file personalizzati e l’accesso Mobile attuale.',
    refresh_failed: 'Impossibile aggiornare la personalizzazione mobile. Controlla la connessione e l’accesso Mobile attuale.',
    recovered: 'La personalizzazione mobile è di nuovo disponibile.',
  },
  zh: {
    gateway_required: '自定义移动样式、脚本与扩展需要通过已配对的 DSH Mobile 入口访问；当前页面不是移动网关页面。',
    authentication_required: '设备认证不可用，移动定制暂未刷新；请通过当前移动访问入口重新连接。',
    manifest_unavailable: '移动扩展清单不可用；请检查插件版本及反向代理路由。通过认证时，旧版自定义文件仍可加载。',
    manifest_invalid: '移动扩展清单无效，保留现有定制；请检查插件版本及反向代理路由。',
    resource_unavailable: '移动定制资源加载或激活失败；请检查定制文件及当前移动访问入口。',
    refresh_failed: '移动定制暂未刷新；请检查网络及当前移动访问入口。',
    recovered: '移动定制已恢复加载。',
  },
  ja: {
    gateway_required: 'モバイル用のカスタム CSS、スクリプト、拡張機能には、ペアリング済みの DSH Mobile アクセスエントリが必要です。このページはモバイルゲートウェイを使用していません。',
    authentication_required: 'デバイス認証を利用できないため、モバイルカスタマイズは更新されませんでした。現在のモバイルアクセスエントリから再接続してください。',
    manifest_unavailable: 'モバイル拡張機能のマニフェストを取得できません。プラグインのバージョンとプロキシのルーティングを確認してください。認証されていれば従来のカスタムファイルは引き続き読み込めます。',
    manifest_invalid: 'モバイル拡張機能のマニフェストが無効です。既存のカスタマイズは保持されます。プラグインのバージョンとプロキシのルーティングを確認してください。',
    resource_unavailable: 'モバイルカスタマイズのリソースを読み込むか有効化できませんでした。カスタムファイルと現在のモバイルアクセスエントリを確認してください。',
    refresh_failed: 'モバイルカスタマイズを更新できませんでした。接続と現在のモバイルアクセスエントリを確認してください。',
    recovered: 'モバイルカスタマイズを再び利用できます。',
  },
  ko: {
    gateway_required: '모바일 사용자 지정 CSS, 스크립트 및 확장은 페어링된 DSH Mobile 액세스 항목이 필요합니다. 이 페이지는 모바일 게이트웨이를 사용하지 않습니다.',
    authentication_required: '기기 인증을 사용할 수 없어 모바일 사용자 지정을 새로 고치지 않았습니다. 현재 모바일 액세스 항목을 통해 다시 연결하십시오.',
    manifest_unavailable: '모바일 확장 매니페스트를 사용할 수 없습니다. 플러그인 버전과 프록시 라우팅을 확인하십시오. 인증되면 레거시 사용자 지정 파일은 계속 불러올 수 있습니다.',
    manifest_invalid: '모바일 확장 매니페스트가 유효하지 않습니다. 기존 사용자 지정은 유지됩니다. 플러그인 버전과 프록시 라우팅을 확인하십시오.',
    resource_unavailable: '모바일 사용자 지정 리소스를 불러오거나 활성화하지 못했습니다. 사용자 지정 파일과 현재 모바일 액세스 항목을 확인하십시오.',
    refresh_failed: '모바일 사용자 지정을 새로 고치지 못했습니다. 연결과 현재 모바일 액세스 항목을 확인하십시오.',
    recovered: '모바일 사용자 지정을 다시 사용할 수 있습니다.',
  },
  es: {
    gateway_required: 'El CSS, los scripts y las extensiones personalizados para móvil requieren una entrada de acceso de DSH Mobile emparejada. Esta página no usa la puerta de enlace móvil.',
    authentication_required: 'La personalización móvil no se actualizó porque la autenticación del dispositivo no está disponible. Vuelve a conectarte mediante la entrada de acceso móvil actual.',
    manifest_unavailable: 'El manifiesto de extensiones móviles no está disponible. Comprueba la versión del plugin y el enrutamiento del proxy; los archivos personalizados heredados aún pueden cargarse cuando están autorizados.',
    manifest_invalid: 'El manifiesto de extensiones móviles no es válido. La personalización existente se conserva; comprueba la versión del plugin y el enrutamiento del proxy.',
    resource_unavailable: 'No se pudo cargar ni activar un recurso de personalización móvil. Comprueba los archivos personalizados y la entrada de acceso móvil actual.',
    refresh_failed: 'No se pudo actualizar la personalización móvil. Comprueba la conexión y la entrada de acceso móvil actual.',
    recovered: 'La personalización móvil vuelve a estar disponible.',
  },
  fr: {
    gateway_required: 'Le CSS, les scripts et les extensions personnalisés pour mobile nécessitent une entrée d’accès DSH Mobile appairée. Cette page n’utilise pas la passerelle mobile.',
    authentication_required: 'La personnalisation mobile n’a pas été actualisée car l’authentification de l’appareil est indisponible. Reconnectez-vous via l’entrée d’accès mobile actuelle.',
    manifest_unavailable: 'Le manifeste des extensions mobiles est indisponible. Vérifiez la version du plugin et le routage du proxy ; les anciens fichiers personnalisés peuvent encore être chargés s’ils sont autorisés.',
    manifest_invalid: 'Le manifeste des extensions mobiles n’est pas valide. La personnalisation existante est conservée ; vérifiez la version du plugin et le routage du proxy.',
    resource_unavailable: 'Une ressource de personnalisation mobile n’a pas pu être chargée ni activée. Vérifiez les fichiers personnalisés et l’entrée d’accès mobile actuelle.',
    refresh_failed: 'La personnalisation mobile n’a pas pu être actualisée. Vérifiez la connexion et l’entrée d’accès mobile actuelle.',
    recovered: 'La personnalisation mobile est de nouveau disponible.',
  },
  de: {
    gateway_required: 'Benutzerdefiniertes mobiles CSS, Skripte und Erweiterungen erfordern einen gekoppelten DSH Mobile-Zugangseintrag. Diese Seite verwendet nicht das mobile Gateway.',
    authentication_required: 'Die mobile Anpassung wurde nicht aktualisiert, weil die Geräteauthentifizierung nicht verfügbar ist. Verbinden Sie sich über den aktuellen mobilen Zugangseintrag erneut.',
    manifest_unavailable: 'Das Manifest der mobilen Erweiterungen ist nicht verfügbar. Prüfen Sie die Plugin-Version und das Proxy-Routing; ältere benutzerdefinierte Dateien können weiterhin geladen werden, wenn sie autorisiert sind.',
    manifest_invalid: 'Das Manifest der mobilen Erweiterungen ist ungültig. Die vorhandene Anpassung bleibt erhalten; prüfen Sie die Plugin-Version und das Proxy-Routing.',
    resource_unavailable: 'Eine benutzerdefinierte mobile Ressource konnte nicht geladen oder aktiviert werden. Prüfen Sie die benutzerdefinierten Dateien und den aktuellen mobilen Zugangseintrag.',
    refresh_failed: 'Die mobile Anpassung konnte nicht aktualisiert werden. Prüfen Sie die Verbindung und den aktuellen mobilen Zugangseintrag.',
    recovered: 'Die mobile Anpassung ist wieder verfügbar.',
  },
}

/** Only the authenticated Gateway owns customization APIs; the older dedicated marker remains supported. */
export function ownsMobileCustomization(gateway: boolean | undefined, frontend: string | undefined): boolean {
  return gateway === true || frontend === 'dedicated'
}

/**
 * Emit each safe failure once until recovery, and ignore work after cancellation
 * or disposal.
 *
 * A failure that only reaches the console is invisible to the user, who sees the
 * customization disappear and cannot tell it from a third-party plugin bug
 * (issue #298). The reporter therefore also publishes its current state so the
 * page can render a visible, localized notice with an explicit recovery action.
 * @param locale - resolves the active UI locale for the copy.
 * @param output - console sink for the developer-facing line.
 * @returns the reporting calls plus a subscribable snapshot.
 */
export function createMobileAssetLoadReporter(
  locale: () => MobileControlLocale,
  output: Pick<Console, 'warn' | 'info'> = console,
): {
  fail(reason: MobileAssetLoadFailure, signal?: AbortSignal): void
  recover(signal: AbortSignal): void
  dispose(): void
  /** Current visible-notice state; `undefined` once everything recovered. */
  getState(): MobileAssetLoadFailure | undefined
  /** Observe state changes; returns a disposer. */
  subscribe(listener: (state: MobileAssetLoadFailure | undefined) => void): () => void
  /** Copy for one failure, so the page and the console share one dictionary. */
  message(reason: MobileAssetLoadFailure): string
} {
  const reported = new Set<MobileAssetLoadFailure>()
  const listeners = new Set<(state: MobileAssetLoadFailure | undefined) => void>()
  let disposed = false
  // The notice must name the failure the user can act on, so prefer the
  // authentication case over the generic resource failure it also produces.
  const visible = (): MobileAssetLoadFailure | undefined => {
    if (reported.has('authentication_required')) return 'authentication_required'
    if (reported.has('gateway_required')) return 'gateway_required'
    return reported.values().next().done === true ? undefined : reported.values().next().value
  }
  const publish = (): void => {
    const state = visible()
    for (const listener of listeners) {
      try { listener(state) } catch (error) { void error }
    }
  }
  return {
    fail(reason, signal) {
      if (disposed || signal?.aborted === true || reported.has(reason)) return
      if (reason === 'resource_unavailable' && reported.has('authentication_required')) return
      reported.add(reason)
      output.warn(`[DSH Mobile] ${COPY[locale()][reason]}`)
      publish()
    },
    recover(signal) {
      if (disposed || signal.aborted || reported.size === 0) return
      reported.clear()
      output.info(`[DSH Mobile] ${COPY[locale()].recovered}`)
      publish()
    },
    dispose() { disposed = true; reported.clear(); listeners.clear() },
    getState() { return disposed ? undefined : visible() },
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    message(reason) { return COPY[locale()][reason] },
  }
}

const MANIFEST_RETRY_DELAYS_MS = [1_000, 2_000] as const
const RETRYABLE_MANIFEST_STATUSES = new Set([408, 502, 503, 504])

function manifestRetryDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const abort = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, delayMs)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Give the transport time to recover before reporting a transient manifest GET failure. */
export async function fetchMobileExtensionManifest(headers: Record<string, string>, signal: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    if (signal.aborted) throw signal.reason
    const delay = MANIFEST_RETRY_DELAYS_MS[attempt]
    let response: Response | undefined
    try {
      response = await fetch('/mobile-access/extensions/manifest', { credentials: 'same-origin', cache: 'no-store', headers, signal })
    } catch (error) {
      if (signal.aborted || delay === undefined) throw error
    }
    if (response !== undefined) {
      // Let the caller discard a late response or handle terminal status codes as before.
      if (signal.aborted || delay === undefined || !RETRYABLE_MANIFEST_STATUSES.has(response.status)) return response
      void response.body?.cancel().catch(() => {})
    }
    if (delay !== undefined) await manifestRetryDelay(delay, signal)
  }
}

/** Read customization text within its file budget; the aggregate manifest has no existing byte cap. */
export async function readMobileAssetText(response: Response, signal: AbortSignal, maxBytes: number | undefined): Promise<string> {
  const assertActive = (): void => { if (signal.aborted) throw signal.reason ?? new DOMException('mobile customization cancelled', 'AbortError') }
  if (response.body === null) { assertActive(); return '' }
  const reader = response.body.getReader()
  let cancelled: Promise<void> | undefined
  const cancel = (): Promise<void> => cancelled ??= reader.cancel().catch((error: unknown) => {
    // A failed stream cancellation must not replace the original read or abort failure.
    void error
  })
  const aborted = (): void => { void cancel() }
  signal.addEventListener('abort', aborted, { once: true })
  let completed = false
  try {
    assertActive()
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const next = await reader.read()
      assertActive()
      if (next.done) { completed = true; break }
      bytes += next.value.byteLength
      if (maxBytes !== undefined && bytes > maxBytes) throw new Error('mobile customization resource is too large')
      chunks.push(next.value)
    }
    const body = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder().decode(body)
  } finally {
    signal.removeEventListener('abort', aborted)
    if (!completed) await cancel()
    reader.releaseLock()
  }
}
