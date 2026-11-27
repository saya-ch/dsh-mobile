/** Browser-facing pairing and reauthentication pages with language negotiation. */
import { MOBILE_VIEWPORT_CONTENT } from './mobile-viewport.js'

export type AuthPageLocale = 'zh' | 'en' | 'it' | 'ja' | 'ko' | 'es' | 'fr' | 'de'

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
  ja: {
    lang: 'ja-JP', pairTitle: 'DSH モバイルアクセスをペアリング', pairHeading: 'このデバイスをペアリング',
    pairingCode: 'ペアリングコード', deviceName: 'デバイス名', pair: 'ペアリング', pairing: 'ペアリングしています…',
    pairingCodeHint: 'コンピューターに表示されている 43 文字のペアリングコードを使用してください。dsh1. または dsh2. で始まるキーは Android アプリ用です。',
    invalidPairingCode: 'コンピューターの現在のペアリングウィンドウに表示されている 43 文字のペアリングコードを入力してください。',
    appKeyNotCode: 'これは Android アプリ用のキーです。アプリで使用するか、コンピューターからブラウザー用のペアリングコードをコピーしてください。',
    pairFailed: 'ペアリングに失敗しました。コードを確認するか、コンピューターで新しいコードを生成してください。',
    pairingExpired: 'ペアリングコードが無効か、有効期限が切れています。コンピューターで新しいコードを生成して、もう一度お試しください。',
    pairingLimited: 'ペアリングの試行回数が多すぎます。しばらく待ってからもう一度お試しください。',
    deviceLimit: 'ペアリング済みデバイスの上限に達しました。コンピューターで未使用のデバイスを削除し、新しいペアリングコードを生成してください。',
    unavailable: 'コンピューターに接続できません。接続を確認して、もう一度お試しください。',
    reconnectTitle: 'DSH モバイルアクセスを再接続', reconnectHeading: 'このデバイスを再接続',
    restoring: '安全なセッションを復元しています…', noLongerPaired: 'このデバイスはペアリングされていません。コンピューターでペアリングを開き、もう一度ペアリングしてください。',
    openPairing: 'ペアリングを開く',
  },
  ko: {
    lang: 'ko-KR', pairTitle: 'DSH 모바일 액세스 페어링', pairHeading: '이 기기 페어링',
    pairingCode: '페어링 코드', deviceName: '기기 이름', pair: '페어링', pairing: '페어링하는 중…',
    pairingCodeHint: '컴퓨터에 표시된 43자리 페어링 코드를 사용하십시오. dsh1. 또는 dsh2.로 시작하는 키는 Android 앱용입니다.',
    invalidPairingCode: '컴퓨터의 현재 페어링 창에 표시된 43자리 페어링 코드를 입력하십시오.',
    appKeyNotCode: '이것은 Android 앱 키입니다. 앱에서 사용하거나 컴퓨터에서 브라우저용 페어링 코드를 복사하십시오.',
    pairFailed: '페어링에 실패했습니다. 코드를 확인하거나 컴퓨터에서 새 코드를 생성하십시오.',
    pairingExpired: '페어링 코드가 유효하지 않거나 만료되었습니다. 컴퓨터에서 새 코드를 생성한 후 다시 시도하십시오.',
    pairingLimited: '페어링 시도가 너무 많습니다. 잠시 기다린 후 다시 시도하십시오.',
    deviceLimit: '페어링된 기기 한도에 도달했습니다. 컴퓨터에서 사용하지 않는 기기를 제거하고 새 페어링 코드를 생성하십시오.',
    unavailable: '컴퓨터를 사용할 수 없습니다. 연결을 확인한 후 다시 시도하십시오.',
    reconnectTitle: 'DSH 모바일 액세스 다시 연결', reconnectHeading: '이 기기 다시 연결',
    restoring: '보안 세션을 복원하는 중…', noLongerPaired: '이 기기는 더 이상 페어링되지 않았습니다. 컴퓨터에서 페어링을 연 후 다시 페어링하십시오.',
    openPairing: '페어링 열기',
  },
  es: {
    lang: 'es-ES', pairTitle: 'Emparejar el acceso móvil de DSH', pairHeading: 'Empareja este dispositivo',
    pairingCode: 'Código de emparejamiento', deviceName: 'Nombre del dispositivo', pair: 'Empareja', pairing: 'Emparejando…',
    pairingCodeHint: 'Usa el código de emparejamiento de 43 caracteres que se muestra en la computadora. Las claves que empiezan con dsh1. o dsh2. son para la app de Android.',
    invalidPairingCode: 'Introduce el código de emparejamiento de 43 caracteres de la ventana de emparejamiento actual en la computadora.',
    appKeyNotCode: 'Esta es una clave de la app de Android. Úsala en la app o copia el código de emparejamiento para el navegador desde la computadora.',
    pairFailed: 'No se pudo emparejar. Comprueba el código o genera uno nuevo en la computadora.',
    pairingExpired: 'El código de emparejamiento no es válido o ha caducado. Genera un código nuevo en la computadora y reintenta.',
    pairingLimited: 'Demasiados intentos de emparejamiento. Espera un momento y reintenta.',
    deviceLimit: 'Se alcanzó el límite de dispositivos emparejados. Elimina un dispositivo que no uses y genera un nuevo código de emparejamiento en la computadora.',
    unavailable: 'La computadora no está disponible. Comprueba la conexión y reintenta.',
    reconnectTitle: 'Reconectar el acceso móvil de DSH', reconnectHeading: 'Reconecta este dispositivo',
    restoring: 'Restaurando la sesión segura…', noLongerPaired: 'Este dispositivo ya no está emparejado. Abre el emparejamiento en la computadora y vuelve a emparejarlo.',
    openPairing: 'Abre el emparejamiento',
  },
  fr: {
    lang: 'fr-FR', pairTitle: 'Appairer l’accès mobile DSH', pairHeading: 'Appairer cet appareil',
    pairingCode: 'Code d’appairage', deviceName: 'Nom de l’appareil', pair: 'Appairer', pairing: 'Appairage…',
    pairingCodeHint: 'Utiliser le code d’appairage de 43 caractères affiché sur l’ordinateur. Les clés commençant par dsh1. ou dsh2. sont destinées à l’app Android.',
    invalidPairingCode: 'Saisir le code d’appairage de 43 caractères de la fenêtre d’appairage actuelle sur l’ordinateur.',
    appKeyNotCode: 'Il s’agit d’une clé de l’app Android. L’utiliser dans l’app ou copier le code d’appairage pour le navigateur depuis l’ordinateur.',
    pairFailed: 'Échec de l’appairage. Vérifier le code ou en générer un nouveau sur l’ordinateur.',
    pairingExpired: 'Le code d’appairage n’est pas valide ou a expiré. Générer un nouveau code sur l’ordinateur, puis réessayer.',
    pairingLimited: 'Trop de tentatives d’appairage. Patienter un instant, puis réessayer.',
    deviceLimit: 'La limite d’appareils appairés est atteinte. Supprimer un appareil inutilisé et générer un nouveau code d’appairage sur l’ordinateur.',
    unavailable: 'L’ordinateur n’est pas disponible. Vérifier la connexion, puis réessayer.',
    reconnectTitle: 'Reconnecter l’accès mobile DSH', reconnectHeading: 'Reconnecter cet appareil',
    restoring: 'Restauration de la session sécurisée…', noLongerPaired: 'Cet appareil n’est plus appairé. Ouvrir l’appairage sur l’ordinateur, puis l’appairer de nouveau.',
    openPairing: 'Ouvrir l’appairage',
  },
  de: {
    lang: 'de-DE', pairTitle: 'DSH-Mobilzugriff koppeln', pairHeading: 'Dieses Gerät koppeln',
    pairingCode: 'Kopplungscode', deviceName: 'Gerätename', pair: 'Koppeln', pairing: 'Kopplung läuft…',
    pairingCodeHint: 'Den auf dem Computer angezeigten 43-stelligen Kopplungscode verwenden. Schlüssel, die mit dsh1. oder dsh2. beginnen, sind für die Android-App bestimmt.',
    invalidPairingCode: 'Den 43-stelligen Kopplungscode aus dem aktuellen Kopplungsfenster auf dem Computer eingeben.',
    appKeyNotCode: 'Dies ist ein Schlüssel der Android-App. Diesen in der App verwenden oder den Kopplungscode für den Browser vom Computer kopieren.',
    pairFailed: 'Kopplung fehlgeschlagen. Prüfen Sie den Code oder erzeugen Sie auf dem Computer einen neuen.',
    pairingExpired: 'Der Kopplungscode ist ungültig oder abgelaufen. Erzeugen Sie auf dem Computer einen neuen Code und versuchen Sie es erneut.',
    pairingLimited: 'Zu viele Kopplungsversuche. Warten Sie einen Moment und versuchen Sie es erneut.',
    deviceLimit: 'Das Limit gekoppelter Geräte ist erreicht. Entfernen Sie ein ungenutztes Gerät und erzeugen Sie auf dem Computer einen neuen Kopplungscode.',
    unavailable: 'Der Computer ist nicht verfügbar. Prüfen Sie die Verbindung und versuchen Sie es erneut.',
    reconnectTitle: 'DSH-Mobilzugriff erneut verbinden', reconnectHeading: 'Dieses Gerät erneut verbinden',
    restoring: 'Sichere Sitzung wird wiederhergestellt…', noLongerPaired: 'Dieses Gerät ist nicht mehr gekoppelt. Öffnen Sie die Kopplung auf dem Computer und koppeln Sie es erneut.',
    openPairing: 'Kopplung öffnen',
  },
}

/** Choose Chinese, Japanese, Korean, Italian, Spanish, French, German, or English from an HTTP Accept-Language header. */
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
    if (value.startsWith('ja')) return 'ja'
    if (value.startsWith('ko')) return 'ko'
    if (value.startsWith('es')) return 'es'
    if (value.startsWith('fr')) return 'fr'
    if (value.startsWith('de')) return 'de'
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
