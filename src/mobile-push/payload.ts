import type { PushCategory, PushLocale } from './contracts.js'
import { MAX_PAYLOAD_BYTES } from './contracts.js'

const messages: Readonly<Record<PushLocale, Readonly<Record<PushCategory, readonly [title: string, body: string]>>>> = {
  en: {
    question: ['Input requested', 'A response needs your attention.'],
    plan: ['Plan review requested', 'A plan review needs your attention.'],
    approval: ['Permission requested', 'A permission request needs your attention.'],
    response: ['Response ready', 'A response is ready to view.'],
    goal: ['Goal update', 'A goal has an important update.'],
    failure: ['Attention needed', 'A run needs your attention.'],
    test: ['Test notification', 'Your notification settings are working.'],
  },
  'zh-CN': {
    question: ['需要输入', '有一项回复需要您关注。'],
    plan: ['需要审核计划', '有一项计划审核需要您关注。'],
    approval: ['需要授权', '有一项授权请求需要您关注。'],
    response: ['回复已就绪', '有一项回复已准备好查看。'],
    goal: ['目标更新', '有一项目标状态更新。'],
    failure: ['需要关注', '有一项运行需要您关注。'],
    test: ['测试通知', '通知设置已正常工作。'],
  },
  it: {
    question: ['Input richiesto', 'Una risposta richiede la tua attenzione.'],
    plan: ['Revisione del piano richiesta', 'Una revisione del piano richiede la tua attenzione.'],
    approval: ['Autorizzazione richiesta', 'Una richiesta di autorizzazione richiede la tua attenzione.'],
    response: ['Risposta pronta', 'Una risposta è pronta da visualizzare.'],
    goal: ['Aggiornamento obiettivo', 'Un obiettivo ha un aggiornamento importante.'],
    failure: ['Attenzione richiesta', 'Un’esecuzione richiede la tua attenzione.'],
    test: ['Notifica di prova', 'Le impostazioni delle notifiche funzionano.'],
  },
  ja: {
    question: ['入力が必要です', '返答にご確認が必要です。'],
    plan: ['プランの確認が必要です', 'プランの確認が必要です。'],
    approval: ['権限が必要です', '権限リクエストにご確認が必要です。'],
    response: ['返答が準備できました', '表示できる返答があります。'],
    goal: ['目標の更新', '目標に重要な更新があります。'],
    failure: ['ご確認が必要です', '実行にご確認が必要です。'],
    test: ['テスト通知', '通知設定は正常に動作しています。'],
  },
  ko: {
    question: ['입력이 필요합니다', '응답을 확인해 주십시오.'],
    plan: ['계획 확인이 필요합니다', '계획을 확인해 주십시오.'],
    approval: ['권한이 필요합니다', '권한 요청을 확인해 주십시오.'],
    response: ['응답이 준비되었습니다', '확인할 수 있는 응답이 있습니다.'],
    goal: ['목표 업데이트', '목표에 중요한 업데이트가 있습니다.'],
    failure: ['확인이 필요합니다', '실행을 확인해 주십시오.'],
    test: ['테스트 알림', '알림 설정이 정상적으로 작동합니다.'],
  },
  es: {
    question: ['Se necesita tu entrada', 'Hay una respuesta que requiere tu atención.'],
    plan: ['Revisión del plan solicitada', 'Hay un plan que revisar.'],
    approval: ['Permiso solicitado', 'Hay una solicitud de permiso pendiente.'],
    response: ['Respuesta lista', 'Hay una respuesta disponible para ver.'],
    goal: ['Actualización del objetivo', 'Un objetivo tiene una actualización importante.'],
    failure: ['Se necesita atención', 'Una ejecución requiere tu atención.'],
    test: ['Notificación de prueba', 'La configuración de notificaciones funciona correctamente.'],
  },
  fr: {
    question: ['Saisie nécessaire', 'Une réponse attend votre attention.'],
    plan: ['Validation du plan demandée', 'Un plan attend votre validation.'],
    approval: ['Autorisation demandée', 'Une demande d’autorisation attend votre attention.'],
    response: ['Réponse prête', 'Une réponse est prête à être consultée.'],
    goal: ['Mise à jour de l’objectif', 'Un objectif a une mise à jour importante.'],
    failure: ['Attention nécessaire', 'Une exécution nécessite votre attention.'],
    test: ['Notification de test', 'Les paramètres de notification fonctionnent.'],
  },
  de: {
    question: ['Eingabe erforderlich', 'Eine Antwort benötigt Ihre Aufmerksamkeit.'],
    plan: ['Planprüfung angefordert', 'Ein Plan wartet auf Ihre Prüfung.'],
    approval: ['Berechtigung angefordert', 'Eine Berechtigungsanfrage wartet auf Sie.'],
    response: ['Antwort bereit', 'Eine Antwort ist zum Ansehen bereit.'],
    goal: ['Ziel aktualisiert', 'Ein Ziel hat eine wichtige Aktualisierung.'],
    failure: ['Aufmerksamkeit erforderlich', 'Eine Ausführung benötigt Ihre Aufmerksamkeit.'],
    test: ['Testbenachrichtigung', 'Die Benachrichtigungseinstellungen funktionieren.'],
  },
}

function validateNavigate(navigate: string, category: PushCategory): void {
  // Internal route templates stay root-relative (Test has no source Session, so its tap target is
  // the bare app root; every alert category keeps the opaque one-time reference route unchanged).
  // The sender resolves this template against the registration origin before encryption because
  // WebKit's declarative parser applies `navigate` without any base URL.
  if (category === 'test' && navigate === '/') return
  if (typeof navigate !== 'string' || !/^\/\?mobile-push=[A-Za-z0-9_-]{1,256}$/u.test(navigate)) {
    throw new TypeError('push_navigation_invalid')
  }
}

/** Build Apple's declarative Web Push schema with generic, locale-owned text. */
export function buildDeclarativePayload(
  category: PushCategory,
  locale: PushLocale,
  navigate: string,
  tag: string,
  custom?: { readonly title: string; readonly body: string },
): string {
  validateNavigate(navigate, category)
  if (!(locale in messages) || !(category in messages[locale])
    || typeof tag !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(tag)) {
    throw new TypeError('push_payload_invalid')
  }
  if (custom !== undefined && (typeof custom.title !== 'string' || custom.title.length === 0 || custom.title.length > 80
    || typeof custom.body !== 'string' || custom.body.length === 0 || custom.body.length > 200)) {
    throw new TypeError('push_payload_invalid')
  }
  const [title, body] = custom === undefined ? messages[locale][category] : [custom.title, custom.body]
  const payload = JSON.stringify({
    web_push: 8030,
    notification: { title, body, lang: locale, navigate, tag },
  })
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) throw new TypeError('push_payload_too_large')
  return payload
}
