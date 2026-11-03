import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const policy: { assertPinnedSslSource: (source: string) => void } = await import(new URL('../scripts/android-ssl-release-policy.mjs', import.meta.url).href)
const source = await readFile(new URL('../apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/SecureWebViewClient.kt', import.meta.url), 'utf8')

describe('Android pinned SSL release wiring', () => {
  it('accepts the complete checked callback and predicate', () => {
    expect(() => policy.assertPinnedSslSource(source)).not.toThrow()
  })

  it.each([
    'caCertificate != null',
    'primaryError == SslError.SSL_UNTRUSTED',
    'GatewayUrlPolicy.isPinnedAuthority(origin, url)',
    'PinnedTls.acceptsWebViewLeaf(origin, caCertificate, leaf)',
    'acceptsPinnedWebViewSslError(origin, caCertificate, error.primaryError,',
    'error.url, error.certificate.x509Certificate)',
    'if (pinned)',
    'handler.proceed()',
    'handler.cancel()',
    'onFailure(LoadFailure.TLS)',
  ])('rejects removing %s rather than accepting a weaker callback', fragment => {
    expect(source).toContain(fragment)
    expect(() => policy.assertPinnedSslSource(source.replace(fragment, '/* removed */'))).toThrow('complete pinned')
  })
})
