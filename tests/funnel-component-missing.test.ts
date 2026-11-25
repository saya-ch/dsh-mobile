import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MOBILE_CONTROL_MESSAGES } from '../src/client-messages.js'

const LOCALES = ['en', 'it', 'zh'] as const

function table(locale: (typeof LOCALES)[number]): Record<string, string> {
  return MOBILE_CONTROL_MESSAGES[locale] as unknown as Record<string, string>
}

describe('missing Funnel component copy', () => {
  it('names the mirror cause and an action that works in every locale', () => {
    // The Funnel helper is an optional per-platform package now. When it is absent the
    // usual cause is a registry mirror that has not mirrored the new package names, and
    // reinstalling alone does not repair that: pnpm skips the unresolved optional
    // dependency silently and the plugin manager only falls back to the official
    // registry on a non-zero exit. So the copy has to point at the install source.
    for (const locale of LOCALES) {
      const text = table(locale).funnelComponentMissing
      expect(text, `locale ${locale}`).toBeTypeOf('string')
      expect(text, `locale ${locale}`).toMatch(/mirror|镜像|mirror/iu)
      expect(text, `locale ${locale}`).toMatch(/registry|源|sorgente/iu)
      // A package id would appear here as an unsubstituted placeholder.
      expect(text, `locale ${locale}`).not.toContain('<platform>')
      expect(text, `locale ${locale}`).not.toContain('dsh-mobile-funnel-')
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
