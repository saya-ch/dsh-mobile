import { describe, expect, it } from 'vitest'
import { parseFrpSettings } from '../src/frp-config.js'
import { validateFrpForm, type FrpFormValues } from '../src/frp-form-validation.js'
import { MOBILE_CONTROL_MESSAGES } from '../src/client-messages.js'

const valid: FrpFormValues = {
  serverAddress: 'frp.example.com', serverPort: 7000, token: 'a'.repeat(32),
  publicOrigin: 'https://phone.example.com', mode: 'deploy', entryTls: 'public-ip-cert',
}

describe('FRP field feedback', () => {
  it.each([
    ['serverAddress', 'https://frp.example.com:7000', 'frpServerAddressInvalid'],
    ['serverAddress', 'unqualified', 'frpServerAddressInvalid'],
    ['serverPort', 0, 'frpServerPortInvalid'],
    ['serverPort', 7000.5, 'frpServerPortInvalid'],
    ['token', 'short', 'frpTokenInvalid'],
    ['token', `${'a'.repeat(20)}\n`, 'frpTokenInvalid'],
    ['user', 'has space', 'frpUserInvalid'],
    ['user', 'x'.repeat(129), 'frpUserInvalid'],
    ['publicOrigin', 'phone.example.com', 'frpPublicOriginInvalid'],
    ['publicOrigin', 'http://phone.example.com', 'frpPublicOriginInvalid'],
    ['publicOrigin', 'https://1.2.3.4:33080', 'frpPublicOriginInvalid'],
    ['publicOrigin', 'https://192.168.1.2', 'frpPublicOriginInvalid'],
    ['publicOrigin', 'https://203.0.113.10', 'frpPublicOriginInvalid'],
    ['publicOrigin', 'https://phone.example.com/path', 'frpPublicOriginInvalid'],
    ['mode', 'unknown', 'frpModeInvalid'],
    ['entryTls', 'unknown', 'frpEntryTlsInvalid'],
    ['vhostHttpPort', Number.NaN, 'frpVhostPortInvalid'],
    ['vhostHttpPort', 65536, 'frpVhostPortInvalid'],
    ['publicPort', 3443, 'frpPublicPortInvalid'],
  ])('identifies %s without disclosing its value', (field, value, messageKey) => {
    const form = { ...valid, [field]: value }
    const issues = validateFrpForm(form)
    expect(issues).toContainEqual(expect.objectContaining({ field, messageKey }))
    for (const locale of ['en', 'it', 'zh'] as const) {
      expect(MOBILE_CONTROL_MESSAGES[locale][messageKey as keyof typeof MOBILE_CONTROL_MESSAGES.en]).toBeTruthy()
    }
    expect(() => parseFrpSettings(form)).toThrow()
  })

  it('collects errors in visual field order and clears corrected values', () => {
    expect(validateFrpForm({ ...valid, serverAddress: '', token: '', publicOrigin: '' }).map(issue => issue.field))
      .toEqual(['serverAddress', 'token', 'publicOrigin'])
    expect(validateFrpForm(valid)).toEqual([])
    expect(parseFrpSettings(valid).publicOrigin).toBe(valid.publicOrigin)
  })

  it('requires the explicit attach vhost port and the self-signed public IPv4', () => {
    expect(validateFrpForm({ ...valid, mode: 'attach' })).toEqual([
      expect.objectContaining({ field: 'vhostHttpPort', messageKey: 'frpAttachModeRequiresVhostPort' }),
    ])
    expect(validateFrpForm({ ...valid, mode: 'attach', entryTls: 'self-signed', publicPort: 33080 }))
      .toEqual([expect.objectContaining({ field: 'publicOrigin', messageKey: 'frpSelfSignedRequiresPublicIpv4' })])
    expect(validateFrpForm({ ...valid, mode: 'attach', entryTls: 'self-signed', publicOrigin: 'https://1.2.3.4', publicPort: 33080 }))
      .toEqual([])
    expect(validateFrpForm({ ...valid, mode: 'attach', entryTls: 'self-signed', publicOrigin: 'https://1.2.3.4' }))
      .toEqual([expect.objectContaining({ field: 'publicPort', messageKey: 'frpPublicPortInvalid' })])
  })

  it('only permits blank saved tokens for read-only saved-setting previews', () => {
    expect(validateFrpForm({ ...valid, token: '' })).toEqual([expect.objectContaining({ field: 'token' })])
    expect(validateFrpForm({ ...valid, token: '' }, true)).toEqual([])
    expect(validateFrpForm({ ...valid, token: 'short' }, true)).toEqual([expect.objectContaining({ field: 'token' })])
  })

  it('treats the user field as optional and accepts a well-formed value', () => {
    expect(validateFrpForm({ ...valid, user: '' })).toEqual([])
    expect(validateFrpForm({ ...valid, user: 'shared-frp.user_1' })).toEqual([])
    expect(parseFrpSettings({ ...valid, user: '' })).not.toHaveProperty('user')
  })
})
