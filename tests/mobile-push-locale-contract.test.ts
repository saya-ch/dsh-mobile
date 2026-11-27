import { describe, expect, it } from 'vitest'
import { PUSH_LOCALES, isPushLocale } from '../src/mobile-push/contracts.js'
import { buildDeclarativePayload } from '../src/mobile-push/payload.js'

describe('push locale contract', () => {
  it('accepts exactly the shipped locales and rejects everything else', () => {
    for (const locale of PUSH_LOCALES) {
      expect(isPushLocale(locale), locale).toBe(true)
    }
    // A dropped entry would make every enrollment for that language fail with 400, and the
    // type alone does not catch it: the guard is a runtime set.
    expect(PUSH_LOCALES.length).toBe(8)
    expect(new Set(PUSH_LOCALES).size).toBe(8)
    for (const rejected of ['jp', 'zh', 'zh-Hant', 'de-DE', 'EN', '', 'en-US', null, 42, {}]) {
      expect(isPushLocale(rejected), String(rejected)).toBe(false)
    }
  })

  it('gives every category a distinct title and body in every locale', () => {
    const categories = ['question', 'plan', 'approval', 'response', 'goal', 'failure', 'test'] as const
    for (const locale of PUSH_LOCALES) {
      for (const category of categories) {
        const payload = JSON.parse(
          buildDeclarativePayload(category, locale, '/?mobile-push=opaque-123', 'push-tag-1'))
        const title = String(payload.notification.title).replace(/[。.!！]+$/u, '')
        const body = String(payload.notification.body).replace(/[。.!！]+$/u, '')
        // A body that only repeats the title wastes the second line of a lock-screen
        // notification; the Japanese plan message shipped like that before this check.
        expect(body, `${locale}/${category} body repeats the title`).not.toBe(title)
      }
    }
  })
})
