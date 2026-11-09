import { createElement, useSyncExternalStore } from 'react'
import type { MobilePushController, MobilePushSnapshot } from './client.js'
import type { PushPreferences } from './contracts.js'
import { requirePublicMobilePushSwitch, type MobilePushSwitchComponent } from './switch-component.js'

export const MOBILE_PUSH_SETTINGS_ORDER = 120
export interface MobilePushSettingsProps { readonly controller: MobilePushController; readonly locale: 'en' | 'zh' | 'it'; readonly switchComponent?: MobilePushSwitchComponent }
export const MOBILE_PUSH_SETTINGS_COPY = {
  en: { title: 'Web push notifications', desc: 'Receive notifications when this page is closed. Disable stops sends but keeps the browser subscription so it can be reused safely.', permission: { granted: 'System permission: granted. A reinstalled Home Screen app can inherit this site-level grant.', default: 'System permission: not decided.', denied: 'System permission: blocked.', unknown: 'System permission: unavailable.' }, enable: 'Enable', disable: 'Disable', test: 'Send test', testBusy: 'Sending…', accepted: 'Accepted by the push provider; lock-screen delivery is not confirmed.', install: 'Add this site to your Home Screen to enable push.', denied: 'Notifications are blocked in browser settings.', unsupported: 'Web push is unavailable in this context.', error: 'Could not update push settings. Try again.', testFailed: 'The test notification could not be sent. Your notification settings are unchanged.', testRateLimited: 'Too many test notifications; wait a moment before trying again.', conflict: 'This device already has a push subscription for an earlier server key, so enabling cannot complete. Retrying will not fix this; the server operator must check the push key state first.', busy: 'Working…', categories: ['Questions', 'Plans', 'Approvals', 'Responses', 'Goals', 'Failures'] },
  zh: { title: '网页推送通知', desc: '关闭此页面后仍可接收通知。停用会停止发送，但保留浏览器订阅，便于安全地重新启用。', permission: { granted: '系统权限：已允许。重新安装的主屏幕 App 可能继承站点级授权。', default: '系统权限：尚未选择。', denied: '系统权限：已阻止。', unknown: '系统权限：不可读取。' }, enable: '启用', disable: '停用', test: '发送测试', testBusy: '发送中…', accepted: '推送服务商已接受；不代表锁屏一定送达。', install: '请将此网站添加到主屏幕以启用推送。', denied: '浏览器设置已阻止通知。', unsupported: '此环境不支持网页推送。', error: '无法更新推送设置，请重试。', testFailed: '测试通知未能发送。通知设置保持不变。', testRateLimited: '测试通知发送过于频繁，请稍后再试。', conflict: '此设备已存在与旧服务器密钥绑定的推送订阅，因此无法完成启用。重试无法解决；请先由服务器管理员检查推送密钥状态。', busy: '处理中…', categories: ['问题', '计划', '审批', '回复', '目标', '失败'] },
  it: { title: 'Notifiche Web push', desc: 'Ricevi notifiche quando la pagina è chiusa. La disattivazione interrompe gli invii ma conserva l’iscrizione del browser per poterla riutilizzare.', permission: { granted: 'Permesso di sistema: concesso. Una Web App reinstallata può ereditare questa autorizzazione del sito.', default: 'Permesso di sistema: non ancora scelto.', denied: 'Permesso di sistema: bloccato.', unknown: 'Permesso di sistema: non disponibile.' }, enable: 'Attiva', disable: 'Disattiva', test: 'Invia test', testBusy: 'Invio…', accepted: 'Accettata dal provider; la consegna sulla schermata di blocco non è confermata.', install: 'Aggiungi il sito alla schermata Home per attivare il push.', denied: 'Le notifiche sono bloccate nelle impostazioni del browser.', unsupported: 'Web push non disponibile in questo contesto.', error: 'Impossibile aggiornare le impostazioni push. Riprova.', testFailed: 'Impossibile inviare la notifica di test. Le impostazioni delle notifiche restano invariate.', testRateLimited: 'Troppe notifiche di test; attendi qualche istante prima di riprovare.', conflict: 'Questo dispositivo ha già una sottoscrizione push associata a una chiave server precedente, quindi l’attivazione non può completarsi. Riprovare non risolve il problema; l’operatore del server deve prima controllare lo stato della chiave push.', busy: 'Operazione…', categories: ['Domande', 'Piani', 'Approvazioni', 'Risposte', 'Obiettivi', 'Errori'] },
} as const
const KEYS = ['question', 'plan', 'approval', 'response', 'goal', 'failure'] as const
function message(snapshot: MobilePushSnapshot, copy: (typeof MOBILE_PUSH_SETTINGS_COPY)[keyof typeof MOBILE_PUSH_SETTINGS_COPY]): string {
  if (snapshot.state === 'install') return copy.install
  if (snapshot.state === 'denied') return copy.denied
  if (snapshot.state === 'unsupported') return copy.unsupported
  if (snapshot.state === 'enabled' && snapshot.error === 'push.test.accepted') return copy.accepted
  if (snapshot.state === 'enabled' && snapshot.error === 'push.test.rateLimited') return copy.testRateLimited
  if (snapshot.state === 'enabled' && snapshot.error === 'push.test.failed') return copy.testFailed
  if (snapshot.state === 'failed' && snapshot.error === 'push.error.subscriptionConflict') return copy.conflict
  return snapshot.state === 'failed' ? copy.error : copy.desc
}
/** Browser-only settings row; mounting it never requests permission or creates a subscription. */
export function MobilePushSettings({ controller, locale, switchComponent }: MobilePushSettingsProps): ReturnType<typeof createElement> | null {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const copy = MOBILE_PUSH_SETTINGS_COPY[locale]
  if (snapshot.state === 'unsupported') return null
  const prefs = snapshot.preferences
  // Actual public DSH Switch, provided by the shell module loader at render time (or
  // injected by an owning fixture); without it the category controls are withdrawn
  // rather than replaced with a painted approximation.
  const Switch = switchComponent ?? requirePublicMobilePushSwitch()
  const permission = typeof Notification === 'undefined' ? 'unknown' : Notification.permission
  const toggle = (key: typeof KEYS[number], checked: boolean): void => {
    if (!prefs) return
    void controller.updatePreferences({ ...prefs, [key]: checked } as PushPreferences)
  }
  // Keep this multi-row section independent of the shell's legacy settings
  // markers: the native category Switches need the full width, with actions below.
  return createElement('div', { className: 'dsh-mobile-settings_row', style: { flexDirection: 'column', alignItems: 'stretch', gap: 12 }, lang: locale === 'zh' ? 'zh-CN' : locale },
    createElement('div', { className: 'dsh-mobile-settings_rowText', style: { paddingRight: 0 } },
      createElement('div', { className: 'dsh-mobile-settings_title' }, copy.title),
      createElement('div', { className: 'dsh-mobile-settings_desc', 'aria-live': 'polite' }, message(snapshot, copy)),
      createElement('div', { className: 'dsh-mobile-settings_desc' }, copy.permission[permission]),
      prefs && Switch !== undefined ? createElement('div', { className: 'dsh-mobile-push-categories' }, ...KEYS.map((key, index) => {
        const name = copy.categories[index]
        if (name === undefined) return null
        return createElement('label', { key, className: 'dsh-mobile-push-category' },
          createElement('span', { className: 'dsh-mobile-push-categoryName' }, name),
          createElement(Switch, { checked: prefs[key], label: name, onChange: (next: boolean): void => { toggle(key, next) } }))
      })) : null,
    ),
    createElement('div', { className: 'dsh-mobile-push-actions', style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
      snapshot.state === 'enabled' ? createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', disabled: snapshot.testInFlight === true, 'aria-busy': snapshot.testInFlight === true ? 'true' : undefined, onClick: () => void controller.sendTest() }, snapshot.testInFlight ? copy.testBusy : copy.test) : null,
      snapshot.state === 'enabled' || snapshot.state === 'suspended' ? createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', onClick: () => void controller.disable() }, copy.disable) : snapshot.state === 'ready' || snapshot.state === 'failed' || snapshot.state === 'disabled' ? createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', onClick: () => void controller.enableFromGesture() }, copy.enable) : createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', disabled: true }, copy.busy),
    ),
  )
}
