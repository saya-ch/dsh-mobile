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
): string {
  validateNavigate(navigate, category)
  if (!(locale in messages) || !(category in messages[locale])
    || typeof tag !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(tag)) {
    throw new TypeError('push_payload_invalid')
  }
  const [title, body] = messages[locale][category]
  const payload = JSON.stringify({
    web_push: 8030,
    notification: { title, body, lang: locale, navigate, tag },
  })
  if (Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) throw new TypeError('push_payload_too_large')
  return payload
}
