import { describe, expect, it } from 'vitest'
import { diagnosticControllerAction, frpAttachFormErrorCode } from '../src/client.js'
import {
  DIAGNOSTIC_REASON_MESSAGES,
  LOCALIZED_DIAGNOSTIC_COPY,
  MOBILE_CONTROL_MESSAGES,
} from '../src/client-messages.js'

const LOCALES = ['en', 'it', 'zh'] as const

/** Every key added for the attach mode and the self-signed entry. */
const ATTACH_KEYS = [
  'frpMode', 'frpModeDeploy', 'frpModeAttach', 'frpModeHint',
  'frpEntryTls', 'frpEntryTlsPublic', 'frpEntryTlsSelfSigned',
  'frpVhostHttpPort', 'frpVhostHttpPortHint', 'frpPublicPort', 'frpPublicPortHint',
  'frpUser', 'frpUserPlaceholder', 'frpUserHint', 'frpUserInvalid',
  'frpAttachPlan', 'frpAttachPlanCopied', 'frpAttachPlanFailed',
  'frpAttachCertOk', 'frpAttachCertExpiring', 'frpAttachCertExpired', 'frpAttachCertUnknown',
  'frpAttachSelfCheck', 'frpAttachFrpsReachable', 'frpAttachFrpsUnreachable',
  'frpAttachEntryReachable', 'frpAttachEntryUnreachable',
  'frpAttachModeRequiresVhostPort', 'frpAttachCertUnknownError', 'frpEntryTlsInvalid',
  'frpAttachStepWriteSnippet', 'frpAttachStepAddImport', 'frpAttachStepIssueCert',
  'frpAttachStepCertTimer', 'frpAttachStepVerifyHttps',
  'frpAttachStepOpenPort', 'frpAttachStepVerifyFrps', 'frpAttachStepVerifyEntry',
] as const

/** Every error code the panel must be able to translate. */
const FRP_ERROR_KEYS = [
  'frpMissing', 'frpInvalid', 'frpConfigMissing', 'frpConfigVerifyFailed',
  'frpVhostPublic', 'frpVhostProbeFailed', 'frpLaunchFailed', 'frpTimeout',
  'frpDiscoveryMismatch', 'frpDiscoveryInvalid', 'frpStopped', 'frpExited',
  'frpAttachModeRequiresVhostPort', 'frpAttachCertUnknownError', 'frpEntryTlsInvalid',
] as const

function table(locale: (typeof LOCALES)[number]): Record<string, string> {
  return MOBILE_CONTROL_MESSAGES[locale] as unknown as Record<string, string>
}

describe('three-locale message parity', () => {
  it('keeps the control-message key set identical across en, it, and zh', () => {
    const reference = Object.keys(table('en')).sort()
    expect(reference.length).toBeGreaterThan(300)
    for (const locale of LOCALES) {
      expect(Object.keys(table(locale)).sort(), `locale ${locale}`).toEqual(reference)
    }
  })

  it('never ships an empty translation', () => {
    for (const locale of LOCALES) {
      const empty = Object.entries(table(locale))
        .filter(([, value]) => typeof value !== 'string' || value.trim().length === 0)
        .map(([key]) => key)
      expect(empty, `locale ${locale}`).toEqual([])
    }
  })

  it('translates every attach key and every FRP error key in all three locales', () => {
    for (const locale of LOCALES) {
      for (const key of [...ATTACH_KEYS, ...FRP_ERROR_KEYS]) {
        expect(table(locale)[key], `${locale}.${key}`).toBeTruthy()
      }
    }
    expect(table('en').frpVhostPublic).toContain('plaintext')
    expect(table('zh').frpAttachModeRequiresVhostPort).toContain('vhostHTTPPort')
    expect(table('it').frpEntryTlsSelfSigned).toContain('autofirmato')
  })

  it('keeps the diagnostic-copy block and the reason table in sync too', () => {
    const diagnostic = Object.keys(LOCALIZED_DIAGNOSTIC_COPY.en).sort()
    for (const locale of LOCALES) {
      expect(Object.keys(LOCALIZED_DIAGNOSTIC_COPY[locale]).sort(), `locale ${locale}`).toEqual(diagnostic)
    }
    for (const key of ['certificateOk', 'certificateExpiring', 'certificateExpired', 'certificateUnknown', 'certificateAction'] as const) {
      for (const locale of LOCALES) {
        expect((LOCALIZED_DIAGNOSTIC_COPY[locale] as Record<string, string>)[key], `${locale}.${key}`).toBeTruthy()
      }
    }
    const reasons = Object.keys(DIAGNOSTIC_REASON_MESSAGES.en).sort()
    for (const locale of LOCALES) {
      expect(Object.keys(DIAGNOSTIC_REASON_MESSAGES[locale]).sort(), `locale ${locale}`).toEqual(reasons)
      for (const [key, value] of Object.entries(DIAGNOSTIC_REASON_MESSAGES[locale])) {
        expect(Array.isArray(value) && value.length === 2 && value.every(part => typeof part === 'string'), `${locale}.${key}`).toBe(true)
      }
    }
  })
})

describe('panel error-code mapping', () => {
  it('uses the Host attach error code for localized diagnostic guidance', () => {
    const code = frpAttachFormErrorCode({
      serverAddress: '1.2.3.4', serverPort: 7000, token: '0'.repeat(32),
      publicOrigin: 'https://1.2.3.4', entryTls: 'public-ip-cert',
    })
    expect(code).toBe('frp_attach_mode_requires_vhost_port')
    for (const locale of LOCALES) {
      const fallback = DIAGNOSTIC_REASON_MESSAGES[locale]['remote-controller-error'][1]
      expect(diagnosticControllerAction(code, locale, fallback)).toBe(table(locale).frpAttachModeRequiresVhostPort)
      expect(diagnosticControllerAction('frp_attach_cert_unknown', locale, fallback)).toBe(table(locale).frpAttachCertUnknownError)
      expect(diagnosticControllerAction('frp_entry_tls_invalid', locale, fallback)).toBe(table(locale).frpEntryTlsInvalid)
    }
  })
})
