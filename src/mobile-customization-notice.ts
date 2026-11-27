/**
 * A visible notice for a customization channel that silently stopped working.
 *
 * Issue #298: when DSH restarts, the in-memory Session dies while the paired
 * device credential survives. `/mobile-access/custom.css`, `mobile.js` and
 * `/mobile-access/extensions/*` then answer 401, so the user's own styling and
 * plugin extensions vanish. Until now the only trace was a `console.warn`, which
 * a phone user never sees — they conclude a third-party plugin broke.
 *
 * This notice names the failure, offers the one action the user can take, and
 * disappears as soon as the channel recovers. It never claims a recovery that did
 * not happen: with no native bridge it points at the pairing entry instead of
 * promising automatic renewal.
 */
import type { MobileAssetLoadFailure } from './mobile-custom-assets.js'

/** Copy for the notice, per locale, kept beside the existing dictionaries. */
const NOTICE_COPY: Record<'en' | 'zh' | 'it' | 'ja' | 'ko' | 'es' | 'fr' | 'de', {
  readonly title: Record<'authentication_required' | 'gateway_required' | 'other', string>
  readonly action: string
  readonly dismiss: string
}> = {
  en: {
    title: {
      authentication_required: 'Device authentication is unavailable.',
      gateway_required: 'Custom mobile CSS, scripts and extensions need the paired Mobile access entry.',
      other: 'Mobile customization could not be loaded.',
    },
    action: 'Retry loading',
    dismiss: 'Dismiss',
  },
  zh: {
    title: {
      authentication_required: '设备认证暂不可用。',
      gateway_required: '自定义移动样式、脚本与扩展需要通过已配对的移动访问入口打开。',
      other: '移动定制加载失败。',
    },
    action: '重试加载',
    dismiss: '忽略',
  },
  it: {
    title: {
      authentication_required: 'Autenticazione del dispositivo non disponibile.',
      gateway_required: 'CSS, script ed estensioni mobili richiedono l’accesso Mobile abbinato.',
      other: 'Impossibile caricare la personalizzazione mobile.',
    },
    action: 'Riprova il caricamento',
    dismiss: 'Ignora',
  },
  ja: {
    title: {
      authentication_required: 'デバイスの認証を利用できません。',
      gateway_required: 'カスタムのモバイル CSS、スクリプト、拡張機能は、ペアリング済みのモバイルアクセス入口から開く必要があります。',
      other: 'モバイルのカスタマイズを読み込めませんでした。',
    },
    action: '再読み込み',
    dismiss: '無視',
  },
  ko: {
    title: {
      authentication_required: '기기 인증을 사용할 수 없습니다.',
      gateway_required: '사용자 지정 모바일 CSS, 스크립트, 확장 기능은 페어링된 모바일 액세스 진입점을 통해 열어야 합니다.',
      other: '모바일 사용자 지정을 불러오지 못했습니다.',
    },
    action: '다시 불러오기',
    dismiss: '무시',
  },
  es: {
    title: {
      authentication_required: 'La autenticación del dispositivo no está disponible.',
      gateway_required: 'Los CSS, scripts y extensiones móviles personalizados necesitan la entrada de acceso móvil emparejada.',
      other: 'No se pudo cargar la personalización móvil.',
    },
    action: 'Reintentar la carga',
    dismiss: 'Descartar',
  },
  fr: {
    title: {
      authentication_required: 'L’authentification de l’appareil n’est pas disponible.',
      gateway_required: 'Les CSS, scripts et extensions mobiles personnalisés nécessitent l’entrée d’accès mobile appairée.',
      other: 'Impossible de charger la personnalisation mobile.',
    },
    action: 'Réessayer le chargement',
    dismiss: 'Ignorer',
  },
  de: {
    title: {
      authentication_required: 'Die Geräteauthentifizierung ist nicht verfügbar.',
      gateway_required: 'Benutzerdefiniertes mobiles CSS, Skripte und Erweiterungen benötigen den gekoppelten Eintrag für mobilen Zugriff.',
      other: 'Die mobile Anpassung konnte nicht geladen werden.',
    },
    action: 'Erneut laden',
    dismiss: 'Ausblenden',
  },
}

/** Which locale dictionary to use; mirrors the plugin's supported set. */
export type CustomizationNoticeLocale = keyof typeof NOTICE_COPY

const NOTICE_ATTRIBUTE = 'data-dsh-mobile-customization-notice'

const NOTICE_STYLES = `
[${NOTICE_ATTRIBUTE}]{position:fixed;z-index:1000;left:8px;right:8px;bottom:calc(env(safe-area-inset-bottom) + 8px);display:flex;align-items:flex-start;gap:10px;box-sizing:border-box;padding:10px 12px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 8px 24px rgb(15 23 42 / 18%);font:13px/1.45 system-ui;color:var(--dsw-alias-label-primary,#16181d)}
[${NOTICE_ATTRIBUTE}][hidden]{display:none}
[${NOTICE_ATTRIBUTE}] .dshm-notice-text{flex:1 1 auto;min-width:0}
[${NOTICE_ATTRIBUTE}] button{flex:none;box-sizing:border-box;min-height:44px;min-width:44px;padding:0 10px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary,#16181d);font:600 13px/1.2 system-ui;cursor:pointer}
[${NOTICE_ATTRIBUTE}] button.dshm-notice-action{background:var(--dsw-alias-state-business-primary,#2563eb);color:#fff;border-color:transparent}
[${NOTICE_ATTRIBUTE}] button:hover{opacity:.9}
[${NOTICE_ATTRIBUTE}]{max-height:40vh;overflow:auto;left:max(8px,env(safe-area-inset-left));right:max(8px,env(safe-area-inset-right));flex-wrap:wrap}
[${NOTICE_ATTRIBUTE}] .dshm-notice-text{margin:0;flex-basis:100%}
[${NOTICE_ATTRIBUTE}] button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
[${NOTICE_ATTRIBUTE}]{background-color:Canvas;background-image:linear-gradient(var(--dsw-alias-bg-layer-2,Canvas),var(--dsw-alias-bg-layer-2,Canvas));color:var(--dsw-alias-label-primary,CanvasText)}
`

/** Copy key for a failure, so the notice and the console never disagree. */
function titleKey(reason: MobileAssetLoadFailure): 'authentication_required' | 'gateway_required' | 'other' {
  return reason === 'authentication_required' || reason === 'gateway_required' ? reason : 'other'
}

/**
 * Mount one visible notice that follows the customization reporter's state.
 * @param document - the page that owns the notice.
 * @param options - locale lookup and the reconnect action.
 * @returns a disposer that removes the notice and its stylesheet.
 */
export function installCustomizationNotice(
  document: Document,
  options: {
    readonly locale: () => CustomizationNoticeLocale
    /**
     * Ask for a recovery. Returns whether anything was actually attempted, so the
     * notice can avoid promising a renewal the page cannot perform.
     */
    readonly reconnect: () => boolean
    /** Observe the reporter; the listener receives the current failure. */
    readonly subscribe: (listener: (reason: MobileAssetLoadFailure | undefined) => void) => () => void
    readonly message: (reason: MobileAssetLoadFailure) => string
  },
): () => void {
  // The installer runs on a real page, but unit fixtures provide a minimal DOM
  // stub. A missing element API means there is nothing to draw on, and the console
  // line from the reporter is still emitted, so this degrades instead of throwing
  // into the caller's load path.
  const canRender = typeof document.createElement === 'function'
    && typeof document.body?.append === 'function'
    && typeof document.head?.append === 'function'
  if (!canRender) return () => {}

  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-mobile-notice'
  style.textContent = NOTICE_STYLES
  document.head.append(style)

  const notice = document.createElement('div')
  if (typeof notice.setAttribute !== 'function' || typeof notice.append !== 'function') {
    style.remove()
    return () => {}
  }
  notice.setAttribute(NOTICE_ATTRIBUTE, '')
  notice.setAttribute('role', 'status')
  notice.setAttribute('aria-live', 'polite')
  notice.hidden = true

  const text = document.createElement('p')
  text.className = 'dshm-notice-text'
  const action = document.createElement('button')
  action.type = 'button'
  action.className = 'dshm-notice-action'
  const dismiss = document.createElement('button')
  dismiss.type = 'button'

  notice.append(text, action, dismiss)
  document.body.append(notice)

  let current: MobileAssetLoadFailure | undefined
  // A dismissed notice stays dismissed for that same failure; a different failure
  // or a recovery-then-failure cycle brings it back, so the user is never left
  // without the signal after a new outage.
  let dismissed: MobileAssetLoadFailure | undefined

  const render = (): void => {
    const copy = NOTICE_COPY[options.locale()] ?? NOTICE_COPY.en
    if (current === undefined || current === dismissed) { notice.hidden = true; return }
    const detail = options.message(current)
    text.textContent = `${copy.title[titleKey(current)]} ${detail}`
    action.textContent = copy.action
    dismiss.textContent = copy.dismiss
    notice.hidden = false
  }

  let disposed = false
  const retry = (): void => {
    if (!disposed) options.reconnect()
  }
  const close = (): void => {
    if (disposed) return
    dismissed = current
    render()
  }
  action.addEventListener('click', retry)
  dismiss.addEventListener('click', close)

  const unsubscribe = options.subscribe(reason => {
    if (reason !== current) dismissed = undefined
    current = reason
    render()
  })
  render()

  return () => {
    disposed = true
    action.removeEventListener('click', retry)
    dismiss.removeEventListener('click', close)
    unsubscribe()
    notice.remove()
    style.remove()
  }
}
