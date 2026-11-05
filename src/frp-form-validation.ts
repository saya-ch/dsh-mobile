import {
  parseFrpSettings, validateFrpEntryTls, validateFrpMode, validateFrpPublicOrigin,
  validateFrpPublicPort, validateFrpServerAddress, validateFrpServerPort,
  validateFrpToken, validateFrpUser, validateFrpVhostHttpPort,
} from './frp-config.js'

/** Editable FRP values; invalid numeric input remains invalid rather than becoming a default. */
export interface FrpFormValues {
  readonly serverAddress: string
  readonly serverPort: number
  readonly token: string
  readonly user?: string
  readonly publicOrigin: string
  readonly mode: string
  readonly entryTls: string
  readonly vhostHttpPort?: number
  readonly publicPort?: number
}

/** One field error without reflecting the user's address or secret. */
export interface FrpFormIssue {
  readonly field: keyof FrpFormValues
  readonly code: string
  readonly messageKey: string
}

/** Field ownership for errors returned by the Host parser. */
export const FRP_FORM_ERRORS: Readonly<Record<string, FrpFormIssue>> = {
  frp_server_address_invalid: { field: 'serverAddress', code: 'frp_server_address_invalid', messageKey: 'frpServerAddressInvalid' },
  frp_server_port_invalid: { field: 'serverPort', code: 'frp_server_port_invalid', messageKey: 'frpServerPortInvalid' },
  frp_token_invalid: { field: 'token', code: 'frp_token_invalid', messageKey: 'frpTokenInvalid' },
  frp_public_origin_invalid: { field: 'publicOrigin', code: 'frp_public_origin_invalid', messageKey: 'frpPublicOriginInvalid' },
  frp_user_invalid: { field: 'user', code: 'frp_user_invalid', messageKey: 'frpUserInvalid' },
  frp_attach_mode_requires_vhost_port: { field: 'vhostHttpPort', code: 'frp_attach_mode_requires_vhost_port', messageKey: 'frpAttachModeRequiresVhostPort' },
  frp_entry_tls_invalid: { field: 'entryTls', code: 'frp_entry_tls_invalid', messageKey: 'frpEntryTlsInvalid' },
  frp_self_signed_requires_public_ipv4: { field: 'publicOrigin', code: 'frp_self_signed_requires_public_ipv4', messageKey: 'frpSelfSignedRequiresPublicIpv4' },
}

/** Collect field errors using the Host validators; token omission is permitted only for saved configuration. */
export function validateFrpForm(form: FrpFormValues, allowSavedToken = false): readonly FrpFormIssue[] {
  const issues: FrpFormIssue[] = []
  const check = (field: keyof FrpFormValues, messageKey: string, validate: () => unknown): void => {
    try { validate() } catch (error) {
      issues.push({ field, messageKey, code: error instanceof Error ? error.message : 'frp_settings_invalid' })
    }
  }
  check('serverAddress', 'frpServerAddressInvalid', () => validateFrpServerAddress(form.serverAddress))
  check('serverPort', 'frpServerPortInvalid', () => validateFrpServerPort(form.serverPort))
  if (form.token !== '' || !allowSavedToken) check('token', 'frpTokenInvalid', () => validateFrpToken(form.token))
  if (form.user !== undefined && form.user !== '') check('user', 'frpUserInvalid', () => validateFrpUser(form.user))
  check('publicOrigin', 'frpPublicOriginInvalid', () => validateFrpPublicOrigin(form.publicOrigin))
  check('mode', 'frpModeInvalid', () => validateFrpMode(form.mode))
  check('entryTls', 'frpEntryTlsInvalid', () => validateFrpEntryTls(form.entryTls))
  if (form.entryTls === 'self-signed' && form.mode !== 'attach') {
    issues.push(FRP_FORM_ERRORS.frp_entry_tls_invalid!)
  }
  if (form.entryTls !== 'self-signed' && form.vhostHttpPort !== undefined) {
    check('vhostHttpPort', 'frpVhostPortInvalid', () => validateFrpVhostHttpPort(form.vhostHttpPort))
  } else if (form.entryTls !== 'self-signed' && form.mode === 'attach') {
    issues.push(FRP_FORM_ERRORS.frp_attach_mode_requires_vhost_port!)
  }
  if (form.publicPort !== undefined || form.entryTls === 'self-signed') {
    check('publicPort', 'frpPublicPortInvalid', () => validateFrpPublicPort(form.publicPort))
  }
  if (issues.length === 0) {
    try {
      parseFrpSettings({ ...form, token: form.token === '' && allowSavedToken ? '0123456789abcdef' : form.token })
    } catch (error) {
      const code = error instanceof Error ? error.message : 'frp_settings_invalid'
      issues.push(FRP_FORM_ERRORS[code] ?? { field: 'mode', code, messageKey: 'frpInputInvalid' })
    }
  }
  return issues
}
