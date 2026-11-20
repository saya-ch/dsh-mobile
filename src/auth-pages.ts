/** Browser-facing pairing and reauthentication pages with language negotiation. */
import { MOBILE_VIEWPORT_CONTENT } from './mobile-viewport.js'

export type AuthPageLocale = 'zh' | 'en' | 'it'

interface AuthPageCopy {
  readonly lang: string
  readonly pairTitle: string
  readonly pairHeading: string
  readonly pairingCode: string
  readonly pairingCodeHint: string
  readonly invalidPairingCode: string
  readonly appKeyNotCode: string
  readonly deviceName: string
  readonly pair: string
  readonly pairing: string
  readonly pairFailed: string
  readonly pairingExpired: string
  readonly pairingLimited: string
  readonly deviceLimit: string
  readonly unavailable: string
  readonly reconnectTitle: string
  readonly reconnectHeading: string
  readonly restoring: string
  readonly noLongerPaired: string
  readonly openPairing: string
}

const COPY: Record<AuthPageLocale, AuthPageCopy> = {
  en: {
    lang: 'en', pairTitle: 'Pair DSH mobile access', pairHeading: 'Pair this device',
    pairingCode: 'Pairing code', deviceName: 'Device name', pair: 'Pair', pairing: 'Pairing…',
    pairingCodeHint: 'Use the 43-character pairing code shown on the computer. Keys starting with dsh1. or dsh2. are for the Android app.',
    invalidPairingCode: 'Enter the 43-character pairing code from the current pairing window on the computer.',
    appKeyNotCode: 'This is an Android app key. Use it in the app, or copy the browser pairing code from the computer.',
    pairFailed: 'Pairing failed. Check the code or generate a new one on the computer.',
    pairingExpired: 'The pairing code is invalid or has expired. Generate a new code on the computer and try again.',
    pairingLimited: 'Too many pairing attempts. Wait a moment and try again.',
    deviceLimit: 'The paired-device limit has been reached. Remove an unused device and generate a new pairing code on the computer.',
    unavailable: 'The computer is unavailable. Check the connection and try again.',
    reconnectTitle: 'Reconnect DSH mobile access', reconnectHeading: 'Reconnect this device',
    restoring: 'Restoring the secure Session…', noLongerPaired: 'This device is no longer paired. Open pairing on the computer, then pair it again.',
    openPairing: 'Open pairing',
  },
  zh: {
    lang: 'zh-CN', pairTitle: '配对 DSH 移动访问', pairHeading: '配对此设备',
    pairingCode: '配对码', deviceName: '设备名称', pair: '配对', pairing: '正在配对…',
    pairingCodeHint: '请输入电脑端显示的 43 位配对码。以 dsh1. 或 dsh2. 开头的密钥用于 Android App。',
    invalidPairingCode: '请输入电脑端当前配对窗口中的 43 位配对码。',
    appKeyNotCode: '这是 Android App 密钥。请在 App 中使用，或回到电脑端复制浏览器配对码。',
    pairFailed: '配对失败，请检查输入或在电脑端重新生成配对码。',
    pairingExpired: '配对码无效或已过期，请在电脑端重新生成后重试。',
    pairingLimited: '配对尝试过于频繁，请稍后再试。',
    deviceLimit: '已达到配对设备上限，请在电脑端移除不需要的设备后重新生成配对码。',
    unavailable: '电脑当前不可用，请检查连接后重试。',
    reconnectTitle: '重新连接 DSH 移动访问', reconnectHeading: '重新连接此设备',
    restoring: '正在恢复安全会话…', noLongerPaired: '此设备已不在配对列表中。请在电脑端打开配对，然后重新配对。',
    openPairing: '打开配对页面',
  },
  it: {
    lang: 'it-IT', pairTitle: 'Abbina accesso mobile DSH', pairHeading: 'Abbina questo dispositivo',
    pairingCode: 'Codice di abbinamento', deviceName: 'Nome dispositivo', pair: 'Abbina', pairing: 'Abbinamento…',
    pairingCodeHint: 'Usa il codice di abbinamento di 43 caratteri mostrato sul computer. Le chiavi che iniziano con dsh1. o dsh2. sono per l’app Android.',
    invalidPairingCode: 'Inserisci il codice di 43 caratteri dalla finestra di abbinamento attuale sul computer.',
    appKeyNotCode: 'Questa è una chiave per l’app Android. Usala nell’app oppure copia il codice di abbinamento per il browser dal computer.',
    pairFailed: 'Abbinamento non riuscito. Controlla il codice o generane uno nuovo sul computer.',
    pairingExpired: 'Il codice non è valido o è scaduto. Genera un nuovo codice sul computer e riprova.',
    pairingLimited: 'Troppi tentativi di abbinamento. Attendi un momento e riprova.',
    deviceLimit: 'È stato raggiunto il limite di dispositivi abbinati. Rimuovi un dispositivo inutilizzato e genera un nuovo codice sul computer.',
    unavailable: 'Il computer non è disponibile. Controlla la connessione e riprova.',
    reconnectTitle: 'Riconnetti accesso mobile DSH', reconnectHeading: 'Riconnetti questo dispositivo',
    restoring: 'Ripristino della sessione sicura…', noLongerPaired: 'Questo dispositivo non è più abbinato. Apri l’abbinamento sul computer e ripeti la procedura.',
    openPairing: 'Apri abbinamento',
  },
}

/** Choose Chinese, Italian, or English from an HTTP Accept-Language header. */
export function resolveAuthPageLocale(header: string | undefined): AuthPageLocale {
  const values = header?.split(',').map((value, index) => {
    const [language, ...parameters] = value.split(';')
    const quality = parameters.find(parameter => parameter.trim().toLowerCase().startsWith('q='))
    const parsedQuality = quality === undefined ? 1 : Number(quality.trim().slice(2))
    return {
      language: language?.trim().toLowerCase() ?? '',
      quality: Number.isFinite(parsedQuality) ? Math.max(0, Math.min(1, parsedQuality)) : 0,
      index,
    }
  }).filter(value => value.quality > 0).sort((left, right) => right.quality - left.quality || left.index - right.index).map(value => value.language) ?? []
  for (const value of values) {
    if (value.startsWith('zh')) return 'zh'
    if (value.startsWith('it')) return 'it'
    if (value.startsWith('en')) return 'en'
  }
  return 'en'
}

/** Render the browser pairing form without reflecting request data into HTML. */
export function renderPairPage(locale: AuthPageLocale): string {
  const copy = COPY[locale]
  return `<!doctype html>
<html lang="${copy.lang}">
<meta charset="utf-8">
<meta name="viewport" content="${MOBILE_VIEWPORT_CONTENT}">
<style>input,textarea{font-size:16px}</style>
<title>${copy.pairTitle}</title>
<main>
  <h1>${copy.pairHeading}</h1>
  <form id="pair-form">
    <label>${copy.pairingCode} <input id="pair-token" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" aria-describedby="pair-token-hint pair-status" required></label>
    <p id="pair-token-hint">${copy.pairingCodeHint}</p>
    <label>${copy.deviceName} <input id="device-label" maxlength="64" autocomplete="off"></label>
    <button type="submit">${copy.pair}</button>
    <output id="pair-status" aria-live="polite"></output>
  </form>
</main>
<script src="/mobile-access/pair.js" defer></script>
</html>
`
}

/** Render the pairing form script with locale-owned status messages. */
export function renderPairScript(locale: AuthPageLocale): string {
  const copy = COPY[locale]
  return `(() => {
  const form = document.getElementById('pair-form')
  const token = document.getElementById('pair-token')
  const label = document.getElementById('device-label')
  const status = document.getElementById('pair-status')
  const submit = form.querySelector('button[type="submit"]')
  let submitting = false
  const fragment = new URLSearchParams(location.hash.slice(1))
  const supplied = fragment.get('token')
  history.replaceState(null, '', location.pathname)
  if (supplied) token.value = supplied
  token.addEventListener('input', () => {
    token.removeAttribute('aria-invalid')
    if (!submitting) status.value = ''
  })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (submitting) return
    const code = token.value.trim()
    token.removeAttribute('aria-invalid')
    if (/^dsh[12]\\./u.test(code) || !/^[A-Za-z0-9_-]{43}$/u.test(code)) {
      status.value = /^dsh[12]\\./u.test(code)
        ? ${JSON.stringify(copy.appKeyNotCode)} : ${JSON.stringify(copy.invalidPairingCode)}
      token.setAttribute('aria-invalid', 'true')
      token.focus()
      return
    }
    submitting = true
    submit.disabled = true
    status.value = ${JSON.stringify(copy.pairing)}
    try {
      const response = await fetch('/mobile-access/auth/pair', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: code, label: label.value || undefined }),
      })
      if (!response.ok) {
        if (token.value.trim() !== code) { status.value = ''; return }
        status.value = response.status === 401 ? ${JSON.stringify(copy.pairingExpired)}
          : response.status === 429 ? ${JSON.stringify(copy.pairingLimited)}
          : response.status === 409 ? ${JSON.stringify(copy.deviceLimit)}
          : response.status >= 500 ? ${JSON.stringify(copy.unavailable)}
          : ${JSON.stringify(copy.pairFailed)}
        if (response.status === 401) token.setAttribute('aria-invalid', 'true')
        return
      }
      location.replace('/')
    } catch {
      status.value = token.value.trim() === code ? ${JSON.stringify(copy.unavailable)} : ''
    } finally {
      submitting = false
      submit.disabled = false
    }
  })
})()
`
}

/** Render the browser reauthentication page. */
export function renderLoginPage(locale: AuthPageLocale): string {
  const copy = COPY[locale]
  return `<!doctype html>
<html lang="${copy.lang}">
<meta charset="utf-8">
<meta name="viewport" content="${MOBILE_VIEWPORT_CONTENT}">
<title>${copy.reconnectTitle}</title>
<main>
  <h1>${copy.reconnectHeading}</h1>
  <p id="login-progress" aria-live="polite">${copy.restoring}</p>
  <section id="login-failed" hidden>
    <p>${copy.noLongerPaired}</p>
    <a href="/mobile-access/pair">${copy.openPairing}</a>
  </section>
</main>
<script src="/mobile-access/login.js" defer></script>
</html>
`
}

/** Render the reauthentication script with locale-owned failure text. */
export function renderLoginScript(locale: AuthPageLocale): string {
  const copy = COPY[locale]
  return `(() => {
  const candidate = new URL(location.href).searchParams.get('return')
  let returnPath = '/'
  if (candidate && candidate.startsWith('/')) {
    try {
      const resolved = new URL(candidate, location.origin)
      const pathname = decodeURIComponent(resolved.pathname)
      if (resolved.origin === location.origin && pathname !== '/mobile-access'
        && !pathname.startsWith('/mobile-access/') && !pathname.includes('\\\\')) {
        returnPath = resolved.pathname + resolved.search + resolved.hash
      }
    } catch {
      // Malformed untrusted return targets keep the safe root default.
    }
  }
  fetch('/mobile-access/auth/renew', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).then((response) => {
    if (response.ok) {
      location.replace(returnPath)
      return
    }
    document.getElementById('login-progress').hidden = true
    document.getElementById('login-failed').hidden = false
  }).catch(() => {
    document.getElementById('login-progress').textContent = ${JSON.stringify(copy.unavailable)}
  })
})()
`
}
