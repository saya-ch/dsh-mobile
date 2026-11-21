import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import {
  renderLoginPage,
  renderLoginScript,
  renderPairPage,
  renderPairScript,
  resolveAuthPageLocale,
  type AuthPageLocale,
} from '../src/auth-pages.js'
import { MOBILE_VIEWPORT_CONTENT } from '../src/mobile-viewport.js'

interface PairReply { readonly ok: boolean; readonly status: number }

/** Execute the generated browser script against a form without real credentials or a server. */
function pairingForm(locale: AuthPageLocale = 'zh', reply: () => Promise<PairReply> = async () => ({ ok: false, status: 401 })) {
  const attributes = new Map<string, string>()
  let focused = false
  let onInput = () => {}
  let onSubmit: (event: { preventDefault(): void }) => Promise<void> = async () => { throw new Error('Submit listener missing') }
  const token = {
    value: 'A'.repeat(43),
    setAttribute(name: string, value: string) { attributes.set(name, value) },
    removeAttribute(name: string) { attributes.delete(name) },
    focus() { focused = true },
    addEventListener(_type: string, listener: () => void) { onInput = listener },
  }
  const label = { value: '' }
  const status = { value: '' }
  const button = { disabled: false }
  const form = {
    querySelector: () => button,
    addEventListener(_type: string, listener: typeof onSubmit) { onSubmit = listener },
  }
  const nodes = new Map<string, object>([
    ['pair-token', token], ['device-label', label], ['pair-status', status], ['pair-form', form],
  ])
  const requests: Array<{ url: string; credentials: string; body: string }> = []
  const redirects: string[] = []
  runInNewContext(renderPairScript(locale), {
    document: { getElementById: (id: string) => nodes.get(id) },
    URLSearchParams,
    history: { replaceState() {} },
    location: { hash: '', pathname: '/mobile-access/pair', replace: (path: string) => { redirects.push(path) } },
    fetch: async (url: string, request: { credentials: string; body: string }) => {
      requests.push({ url, ...request })
      return reply()
    },
  })
  return { token, label, status, button, attributes, requests, redirects,
    submit: () => onSubmit({ preventDefault() {} }), edit: () => onInput(), focused: () => focused }
}

function loginReturn(candidate: string) {
  const requests: Array<{ url: string; method: string; credentials: string; headers: Record<string, string>; body: string }> = []
  let navigate = (_path: string): void => { throw new Error('Login return did not navigate') }
  const navigation = new Promise<string>(resolve => { navigate = resolve })
  const elements = new Map<string, { hidden: boolean; textContent: string }>([
    ['login-progress', { hidden: false, textContent: '' }],
    ['login-failed', { hidden: true, textContent: '' }],
  ])
  const query = new URLSearchParams({ return: candidate }).toString()
  runInNewContext(renderLoginScript('en'), {
    URL,
    location: { href: `https://mobile.example.test/mobile-access/login?${query}`, origin: 'https://mobile.example.test', replace: navigate },
    fetch: async (url: string, options: { method: string; credentials: string; headers: Record<string, string>; body: string }) => {
      requests.push({ url, ...options })
      return { ok: true }
    },
    document: { getElementById: (id: string) => elements.get(id) },
  })
  return { requests, navigation }
}

describe('browser authentication page localization', () => {
  it('negotiates the supported languages and falls back to English', () => {
    expect(resolveAuthPageLocale('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh')
    expect(resolveAuthPageLocale('it-IT,en-US;q=0.8')).toBe('it')
    expect(resolveAuthPageLocale('en-US;q=0.5,zh-CN;q=0.9')).toBe('zh')
    expect(resolveAuthPageLocale('zh-CN;q=0,en-US;q=0.8')).toBe('en')
    expect(resolveAuthPageLocale('fr-FR,de;q=0.8')).toBe('en')
    expect(resolveAuthPageLocale(undefined)).toBe('en')
  })

  it('renders the pairing form and script in the negotiated language', () => {
    const page = renderPairPage('zh')
    const script = renderPairScript('it')

    expect(page).toContain('<html lang="zh-CN">')
    expect(page).toContain('配对码')
    expect(page).toContain('配对')
    expect(script).toContain('Abbinamento…')
    expect(script).toContain('Abbinamento non riuscito')
    expect(script).toContain("/mobile-access/auth/pair")
  })

  it('resizes both browser pages with the software keyboard', () => {
    for (const page of [renderPairPage('en'), renderLoginPage('en')]) {
      expect(page).toContain(`<meta name="viewport" content="${MOBILE_VIEWPORT_CONTENT}">`)
    }
  })

  it('keeps pairing inputs above the Safari 16px focus-zoom threshold', () => {
    // Pre-auth pages load before the mobile client, so no stylesheet floor
    // exists yet; Safari zooms any focused editable under 16px and never
    // zooms back.
    const page = renderPairPage('en')
    expect(page).toContain('<style>input,textarea{font-size:16px}</style>')
    expect(page).toContain('aria-describedby="pair-token-hint pair-status"')
    expect(page).toContain('id="pair-token-hint"')
    expect(page).toContain('43-character')
  })

  it('renders localized reauthentication failure guidance', () => {
    const page = renderLoginPage('it')
    const script = renderLoginScript('zh')

    expect(page).toContain('<html lang="it-IT">')
    expect(page).toContain('Riconnetti questo dispositivo')
    expect(script).toContain('电脑当前不可用，请检查连接后重试。')
    expect(script).toContain("/mobile-access/auth/renew")
  })
})

describe('browser pairing input and recovery feedback', () => {
  it.each(['dsh1', 'dsh2'])('explains an %s app key locally without transmitting it', async prefix => {
    const form = pairingForm()
    form.token.value = `${prefix}.${'a'.repeat(64)}.${'A'.repeat(43)}`
    await form.submit()
    expect(form.requests).toEqual([])
    expect(form.status.value).toContain('Android App 密钥')
    expect(form.attributes.get('aria-invalid')).toBe('true')
    expect(form.focused()).toBe(true)
    expect(form.button.disabled).toBe(false)
    form.edit()
    expect(form.attributes.has('aria-invalid')).toBe(false)
    expect(form.status.value).toBe('')
  })

  it.each(['', 'A'.repeat(42), 'A'.repeat(44), '/'.repeat(43), 'https://example.invalid/#token=secret'])('rejects a malformed pairing code', async code => {
    const form = pairingForm()
    form.token.value = code
    await form.submit()
    expect(form.requests).toEqual([])
    expect(form.status.value).toContain('43 位配对码')
  })

  it('trims a copied code and keeps pairing on the current origin', async () => {
    const form = pairingForm('en', async () => ({ ok: true, status: 201 }))
    form.token.value = ` \n${'A'.repeat(43)}\t `
    form.label.value = 'Phone'
    await form.submit()
    expect(form.requests).toHaveLength(1)
    expect(form.requests[0]?.url).toBe('/mobile-access/auth/pair')
    expect(form.requests[0]?.credentials).toBe('same-origin')
    expect(JSON.parse(form.requests[0]!.body)).toEqual({ token: 'A'.repeat(43), label: 'Phone' })
    expect(form.redirects).toEqual(['/'])
    expect(form.button.disabled).toBe(false)
  })

  it.each([
    [401, '无效或已过期'], [409, '设备上限'], [429, '过于频繁'], [503, '电脑当前不可用'], [403, '请检查输入'],
  ])('offers specific retry guidance for HTTP %i without echoing credentials', async (status, expected) => {
    const form = pairingForm('zh', async () => ({ ok: false, status }))
    await form.submit()
    expect(form.status.value).toContain(expected)
    expect(form.status.value).not.toContain(form.token.value)
    expect(form.redirects).toEqual([])
    expect(form.button.disabled).toBe(false)
  })

  it.each<AuthPageLocale>(['zh', 'en', 'it'])('localizes app-key guidance in %s', async locale => {
    const form = pairingForm(locale)
    form.token.value = 'dsh1.invalid'
    await form.submit()
    const expected = { zh: 'Android App 密钥', en: 'Android app key', it: 'chiave per l’app Android' }
    expect(form.status.value).toContain(expected[locale])
    expect(form.requests).toEqual([])
  })

  it('does not submit the same one-time pairing request twice while it is pending', async () => {
    let complete: (reply: PairReply) => void = () => { throw new Error('Reply resolver missing') }
    const pending = new Promise<PairReply>(resolve => { complete = resolve })
    const form = pairingForm('zh', () => pending)
    const first = form.submit()
    expect(form.button.disabled).toBe(true)
    await form.submit()
    expect(form.requests).toHaveLength(1)
    complete({ ok: false, status: 401 })
    await first
    expect(form.button.disabled).toBe(false)
  })

  it('does not mark an edited code invalid because an older submission failed', async () => {
    let complete: (reply: PairReply) => void = () => { throw new Error('Reply resolver missing') }
    const pending = new Promise<PairReply>(resolve => { complete = resolve })
    const form = pairingForm('zh', () => pending)
    const first = form.submit()
    form.token.value = 'B'.repeat(43)
    form.edit()
    complete({ ok: false, status: 401 })
    await first
    expect(form.status.value).toBe('')
    expect(form.attributes.has('aria-invalid')).toBe(false)
    expect(form.button.disabled).toBe(false)
  })

  it('keeps the entered code and re-enables retry after a network failure', async () => {
    const form = pairingForm('zh', async () => { throw new Error('network unavailable') })
    const code = form.token.value
    await form.submit()
    expect(form.status.value).toContain('检查连接后重试')
    expect(form.token.value).toBe(code)
    expect(form.button.disabled).toBe(false)
  })

  it('preserves the opaque mobile-push return metadata across successful renewal', async () => {
    const attempt = loginReturn('/?mobile-push=opaque-ref&keep=1')
    expect(await attempt.navigation).toBe('/?mobile-push=opaque-ref&keep=1')
    expect(attempt.requests).toEqual([{ url: '/mobile-access/auth/renew', method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' }])
  })

  it.each([
    'https://evil.example/steal',
    '//evil.example/steal',
    '/mobile-access/login',
    '/mobile-access/pair?token=secret',
  ])('rejects reserved and foreign login return target %s', async candidate => {
    const attempt = loginReturn(candidate)
    expect(await attempt.navigation).toBe('/')
  })
})
