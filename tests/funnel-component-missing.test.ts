import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MOBILE_CONTROL_MESSAGES } from '../src/client-messages.js'

const LOCALES = ['en', 'it', 'zh'] as const

function table(locale: (typeof LOCALES)[number]): Record<string, string> {
  return MOBILE_CONTROL_MESSAGES[locale] as unknown as Record<string, string>
}

describe('missing Funnel component copy', () => {
  it('names the platform package and an action in every locale', () => {
    // The Funnel helper is an optional per-platform package now, so a missing binary
    // is an install problem the reader can fix. A generic "unavailable" line would
    // send them to look for a fault that is not there.
    for (const locale of LOCALES) {
      const text = table(locale).funnelComponentMissing
      expect(text, `locale ${locale}`).toBeTypeOf('string')
      expect(text, `locale ${locale}`).toContain('dsh-mobile-funnel-')
      expect(text, `locale ${locale}`).toContain('pnpm install')
    }
  })

  it('keeps the generic unavailable line free of the old bundled-package wording', () => {
    // The helper no longer ships inside the plugin tarball, so telling the reader to
    // reinstall "the complete plugin package" describes a layout that no longer exists.
    const stale = [/complete plugin package/iu, /pacchetto completo/iu, /完整插件包/u]
    for (const locale of LOCALES) {
      const text = table(locale).remoteUnavailableTailscale
      for (const pattern of stale) {
        expect(text, `locale ${locale}`).not.toMatch(pattern)
      }
    }
  })

  it('routes a missing binary to its own line instead of the generic one', () => {
    // The panel renders the state label for `unavailable`, and the error-label table is
    // only consulted for `error`, so the branch has to live in the label mapping. A
    // regression here would silently fall back to the generic sentence.
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    expect(source).toContain("errorCode === 'component_missing' ? t('funnelComponentMissing')")
  })
})
