import { createElement } from 'react'
import {
  DIAGNOSTIC_REASON_MESSAGES,
  LOCALIZED_DIAGNOSTIC_COPY,
  MOBILE_CONTROL_MESSAGES,
  type MobileControlLocale,
} from './client-messages.js'
import { createRestrictedFrpServerTemplate } from './frp-template.js'
import { installNativeMobileSurface, NATIVE_MOBILE_STYLES } from './native-mobile.js'

export { DIAGNOSTIC_REASON_MESSAGES, MOBILE_CONTROL_MESSAGES } from './client-messages.js'
export type { MobileControlLocale } from './client-messages.js'

interface ClientContext {
  effect(effect: () => void | (() => void), label?: string): void
  get(name: 'connection'): MobileConnectionHandle
  slots: {
    inject(key: string, callback: () => (() => void)): () => void
    register<Props>(options: { name: string; id: string; order?: number; label?: string }, component: (props: Props) => unknown): () => void
  }
}

interface MobileConnectionHandle {
  isLoopback: boolean
}

interface MobileExtensionContext {
  readonly document: Document
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly root: HTMLElement
  readonly window: Window
}

type MobileExtensionMount = (context: MobileExtensionContext) => void | (() => void)
type MobileSurfacePlacement = 'page' | 'sidebar-action' | 'header-action' | 'composer-dock' | 'settings-section' | 'overlay'
interface MobileSurface {
  readonly id: string
  readonly placement: MobileSurfacePlacement
  readonly label: string
  mount(container: HTMLElement): void | (() => void)
}
interface MobileClientApi {
  readonly host: {
    invoke(action: string, input: unknown): Promise<unknown>
    fetch(path: string, init?: RequestInit): Promise<Response>
    assetUrl(path: string): string
  }
  readonly ui: {
    registerSurface(surface: MobileSurface): () => void
    open(surfaceId: string): void
    close(surfaceId: string): void
    toast(message: string): void
  }
  readonly native: {
    capabilities(): Promise<readonly string[]>
    invoke(action: string, input?: unknown): Promise<unknown>
  }
  readonly signal: AbortSignal
  readonly document: Document
  readonly window: Window
}
interface MobileClientDefinition {
  readonly apiVersion: 1
  readonly id: string
  activate(api: MobileClientApi): void | (() => void) | Promise<void | (() => void)>
}

declare global {
  interface Window {
    dshMobile?: {
      register(mount: MobileExtensionMount): void
      define(definition: MobileClientDefinition): void
    }
    __DSH_MOBILE_FRONTEND__?: 'dedicated'
    __DSH_MOBILE_NATIVE__?: {
      capabilities(): Promise<readonly string[]> | readonly string[]
      invoke(action: string, input?: unknown): Promise<unknown>
    }
  }
}

const queuedDefinitions: MobileClientDefinition[] = []
let queuedLegacyMount: MobileExtensionMount | undefined
if (typeof window !== 'undefined' && window.dshMobile === undefined) {
  window.dshMobile = {
    register: mount => { queuedLegacyMount = mount },
    define: definition => { queuedDefinitions.push(definition) },
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
}

export function selectMobileControlLocale(documentLanguage = '', navigatorLanguages: readonly string[] = []): MobileControlLocale {
  for (const value of [documentLanguage, ...navigatorLanguages]) {
    const language = value.trim().toLowerCase().split(/[-_]/u)[0]
    if (language === 'it' || language === 'en' || language === 'zh') return language
  }
  return 'en'
}

export function selectedMobileControlLocale(): MobileControlLocale {
  return selectMobileControlLocale(document.documentElement.lang, navigator.languages?.length ? navigator.languages : [navigator.language])
}

/** Remount one plugin-owned surface when DSH changes the document language. */
export function installDshLanguageBoundSurface(install: () => () => void): () => void {
  let locale = selectedMobileControlLocale()
  let dispose = install()
  const observer = new MutationObserver(() => {
    const next = selectedMobileControlLocale()
    if (next === locale) return
    dispose()
    locale = next
    dispose = install()
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  return () => {
    observer.disconnect()
    dispose()
  }
}

function controlTranslator(locale = selectedMobileControlLocale()): (key: string, values?: Readonly<Record<string, string | number>>) => string {
  const messages = MOBILE_CONTROL_MESSAGES as Record<MobileControlLocale, Record<string, string>>
  return (key, values = {}) => {
    const template = messages[locale][key] ?? messages.en[key] ?? key
    return template.replace(/\{(\w+)\}/gu, (_match: string, name: string) => String(values[name] ?? `{${name}}`))
  }
}

export function normalizeDiagnosticOverall(value: unknown): 'ok' | 'attention' | 'error' {
  return value === 'ok' ? 'ok' : value === 'attention' ? 'attention' : 'error'
}

export function normalizeDiagnosticStatus(value: unknown): 'ok' | 'warning' | 'error' | 'info' {
  return value === 'ok' || value === 'warning' || value === 'error' || value === 'info' ? value : 'error'
}

export function diagnosticOverallForChecks(value: unknown, statuses: readonly unknown[]): 'ok' | 'attention' | 'error' {
  const normalized = statuses.map(normalizeDiagnosticStatus)
  const payloadOverall = normalizeDiagnosticOverall(value)
  if (payloadOverall === 'error' || normalized.includes('error')) return 'error'
  if (payloadOverall === 'attention' || normalized.includes('warning')) return 'attention'
  return 'ok'
}

export function validateDiagnosticChecks(value: unknown): { readonly entries: readonly Record<string, unknown>[]; readonly malformed: boolean } {
  if (!Array.isArray(value)) return { entries: [], malformed: true }
  const entries: Record<string, unknown>[] = []
  let malformed = false
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) { malformed = true; continue }
    entries.push(candidate as Record<string, unknown>)
  }
  return { entries, malformed }
}

export function diagnosticEntriesForRender(data: Readonly<Record<string, unknown>>): readonly Record<string, unknown>[] {
  const overallKnown = data.overall === 'ok' || data.overall === 'attention' || data.overall === 'error'
  const validated = validateDiagnosticChecks(data.checks)
  const statusesKnown = validated.entries.every(entry => entry.status === 'ok' || entry.status === 'warning' || entry.status === 'error' || entry.status === 'info')
  if (!overallKnown || validated.malformed || validated.entries.length === 0 || !statusesKnown) {
    throw new TypeError('diagnostics envelope is unavailable')
  }
  return validated.entries
}

export function renderDiagnosticPayloadSafely(
  data: Record<string, unknown>,
  render: (data: Record<string, unknown>) => void,
  onFailure: (error: unknown) => void,
): void {
  try { render(data) } catch (error) { onFailure(error) }
}

export function diagnosticServerCopy(entry: Readonly<Record<string, unknown>>): { readonly label: string; readonly detail: string; readonly action: string } {
  return {
    label: typeof entry.label === 'string' ? entry.label : '',
    detail: typeof entry.detail === 'string' ? entry.detail : '',
    action: typeof entry.action === 'string' ? entry.action : '',
  }
}

/**
 * Match DSH's client-side privilege hint to the authenticated mobile gateway.
 * The gateway authenticates the paired device and forwards allowed requests to
 * DSH's loopback listener, so settings RPCs receive the same Host-side checks
 * as the desktop page even though the phone's visible URL is a LAN address.
 */
export function trustAuthenticatedGatewayConnection(connection: MobileConnectionHandle): () => void {
  const previous = connection.isLoopback
  connection.isLoopback = true
  return () => { connection.isLoopback = previous }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  return node
}

const CONTROL_REQUEST_TIMEOUT_MS = 15_000
const LONG_CONTROL_REQUEST_TIMEOUT_MS = 210_000
const GITHUB_RELEASES_URL = 'https://github.com/saya-ch/dsh-mobile/releases'
const CONTROL_PANEL_ID = 'dsh-mobile-control-panel'

export interface ClientReleaseInfo {
  readonly updateAvailable: boolean
  readonly latestVersion?: string
  readonly androidVersion?: string
  readonly androidDownloadUrl: string
}

function releaseVersion(value: unknown): string | undefined {
  return typeof value === 'string'
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)
    ? value
    : undefined
}

/** Reduce the loopback release response to trusted text and download metadata. */
export function clientReleaseInfo(data: Readonly<Record<string, unknown>>): ClientReleaseInfo {
  const latestVersion = releaseVersion(data.latestVersion)
  const androidVersion = releaseVersion(data.androidVersion)
  const expectedAndroidDownloadUrl = androidVersion === undefined
    ? undefined
    : `${GITHUB_RELEASES_URL}/download/v${androidVersion}/dsh-mobile-android-v${androidVersion}.apk`
  const androidDownloadUrl = expectedAndroidDownloadUrl !== undefined && data.androidDownloadUrl === expectedAndroidDownloadUrl
    ? expectedAndroidDownloadUrl
    : GITHUB_RELEASES_URL
  return {
    updateAvailable: data.updateAvailable === true && latestVersion !== undefined,
    ...(latestVersion === undefined ? {} : { latestVersion }),
    ...(androidVersion === undefined ? {} : { androidVersion }),
    androidDownloadUrl,
  }
}

async function requestJson(
  path: string,
  init?: RequestInit,
  timeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  const controller = new AbortController()
  const upstreamSignal = init?.signal
  const abortFromUpstream = (): void => { controller.abort(upstreamSignal?.reason) }
  if (upstreamSignal?.aborted === true) abortFromUpstream()
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true })
  const timer = window.setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...init?.headers },
    })
    const body = await response.json() as Record<string, unknown>
    if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `HTTP ${String(response.status)}`)
    return body
  } catch (error) {
    if (controller.signal.aborted && upstreamSignal?.aborted !== true) {
      throw new Error(controlTranslator()('requestTimeout'))
    }
    throw error
  } finally {
    clearTimeout(timer)
    upstreamSignal?.removeEventListener('abort', abortFromUpstream)
  }
}

function officialFunnelSetupUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) return ''
  let url: URL
  try { url = new URL(value) } catch { return '' }
  const normalized = url.toString().replace(/\/$/u, '')
  if (normalized === 'https://tailscale.com/s/no-funnel' || normalized === 'https://tailscale.com/s/https') return normalized
  if (url.protocol !== 'https:' || url.hostname !== 'login.tailscale.com' || url.port !== ''
    || url.username !== '' || url.password !== '') return ''
  return url.toString()
}

/** Build the copy-only restricted VPS template without sending the token to the host API. */
export function createFrpServerTemplateForClipboard(serverPort: number, token: string, publicOrigin: string): string {
  return createRestrictedFrpServerTemplate(serverPort, token, publicOrigin)
}

function installControl(): { remove: () => void; toggle: () => void; isOpen: () => boolean } {
  const locale = selectedMobileControlLocale()
  const localeTag = locale === 'it' ? 'it-IT' : locale === 'zh' ? 'zh-CN' : 'en-US'
  const t = controlTranslator(locale)
  const lifecycle = new AbortController()
  const controlRequestJson = (path: string, init?: RequestInit, timeoutMs?: number): Promise<Record<string, unknown>> => requestJson(path, { ...init, signal: lifecycle.signal }, timeoutMs)
  const root = element('div', 'dsh-mobile-control'); root.lang = locale
  const panel = element('section', 'dsh-mobile-control__panel'); panel.id = CONTROL_PANEL_ID; panel.hidden = true; panel.lang = locale
  panel.setAttribute('aria-label', t('mobileAccess'))
  const header = element('header', 'dsh-mobile-control__header')
  const title = element('h2'); title.textContent = t('mobileAccess')
  const headerActions = element('div', 'dsh-mobile-control__header-actions')
  const updatePlugin = element('button', 'dsh-mobile-control__update-plugin'); updatePlugin.type = 'button'; updatePlugin.textContent = t('updatePlugin'); updatePlugin.hidden = true
  const diagnosticsEntry = element('button', 'dsh-mobile-control__diagnostic-entry'); diagnosticsEntry.type = 'button'; diagnosticsEntry.textContent = t('diagnostics'); diagnosticsEntry.setAttribute('aria-label', t('openDiagnostics')); diagnosticsEntry.setAttribute('aria-pressed', 'false')
  const close = element('button', 'dsh-mobile-control__close'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', t('collapseMobileAccess'))
  headerActions.append(updatePlugin, diagnosticsEntry, close)
  const releaseNotice = element('p', 'dsh-mobile-control__release-notice'); releaseNotice.hidden = true; releaseNotice.setAttribute('role', 'status'); releaseNotice.setAttribute('aria-live', 'polite')
  const appDownload = element('a', 'dsh-mobile-control__app-download'); appDownload.href = GITHUB_RELEASES_URL; appDownload.target = '_blank'; appDownload.rel = 'noopener noreferrer'; appDownload.textContent = t('downloadAndroid'); appDownload.setAttribute('aria-label', t('downloadAndroidAria'))
  const switcher = element('div', 'dsh-mobile-control__switcher')
  const lanTab = element('button', 'dsh-mobile-control__tab is-active'); lanTab.type = 'button'; lanTab.textContent = t('lan')
  const remoteTab = element('button', 'dsh-mobile-control__tab'); remoteTab.type = 'button'; remoteTab.textContent = t('remote')
  lanTab.setAttribute('aria-pressed', 'true'); remoteTab.setAttribute('aria-pressed', 'false'); switcher.append(lanTab, remoteTab)
  const lanView = element('div', 'dsh-mobile-control__view')
  const access = element('div', 'dsh-mobile-control__access'); access.hidden = true
  const accessLabel = element('span', 'dsh-mobile-control__access-label'); accessLabel.textContent = t('browserAccess')
  const accessLink = element('a', 'dsh-mobile-control__access-link'); accessLink.target = '_blank'; accessLink.rel = 'noreferrer'
  access.append(accessLabel, accessLink)
  const qrBox = element('div', 'dsh-mobile-control__qr'); qrBox.hidden = true
  const status = element('p', 'dsh-mobile-control__status'); status.textContent = t('loadingStatus')
  const extensionStatus = element('p', 'dsh-mobile-control__extensions'); extensionStatus.hidden = true
  const actions = element('div', 'dsh-mobile-control__actions')
  const toggle = element('button', 'dsh-mobile-control__secondary'); toggle.type = 'button'
  const pair = element('button', 'dsh-mobile-control__primary'); pair.type = 'button'; pair.textContent = t('generateCopyKey')
  const linkPair = element('button', 'dsh-mobile-control__secondary'); linkPair.type = 'button'; linkPair.textContent = t('copyPairLink')
  const manageRow = element('div', 'dsh-mobile-control__manage-row')
  const manageDevices = element('button', 'dsh-mobile-control__manage'); manageDevices.type = 'button'; manageDevices.textContent = t('managePairedDevices')
  const resetAll = element('button', 'dsh-mobile-control__manage'); resetAll.type = 'button'; resetAll.textContent = t('clearAllDevices')
  manageRow.append(manageDevices, resetAll)
  const devicePanel = element('div', 'dsh-mobile-control__devices'); devicePanel.hidden = true
  const remoteView = element('div', 'dsh-mobile-control__view is-remote'); remoteView.hidden = true
  const remoteIntro = element('p', 'dsh-mobile-control__intro'); remoteIntro.textContent = t('remoteIntro')
  const providerSection = element('section', 'dsh-mobile-control__provider-section')
  const providerHeading = element('h3', 'dsh-mobile-control__section-title'); providerHeading.textContent = t('chooseProvider')
  const providerInfo = element('div', 'dsh-mobile-control__provider-info')
  const providerInfoButton = element('button', 'dsh-mobile-control__provider-info-button'); providerInfoButton.type = 'button'; providerInfoButton.setAttribute('aria-label', t('providerInfoAria')); providerInfoButton.setAttribute('aria-expanded', 'false'); providerInfoButton.setAttribute('aria-controls', 'dsh-mobile-provider-info'); providerInfoButton.setAttribute('aria-describedby', 'dsh-mobile-provider-info')
  const providerInfoGlyph = element('span', 'dsh-mobile-control__provider-info-glyph'); providerInfoGlyph.textContent = 'i'; providerInfoGlyph.setAttribute('aria-hidden', 'true')
  const providerInfoPopover = element('div', 'dsh-mobile-control__provider-info-popover'); providerInfoPopover.id = 'dsh-mobile-provider-info'; providerInfoPopover.setAttribute('role', 'tooltip'); providerInfoPopover.hidden = true
  const providerInfoTitle = element('strong'); providerInfoTitle.textContent = t('providerSafeTitle')
  const providerInfoText = element('span'); providerInfoText.textContent = t('providerSafeText')
  providerInfoButton.append(providerInfoGlyph); providerInfoPopover.append(providerInfoTitle, providerInfoText); providerInfo.append(providerInfoButton, providerInfoPopover)
  const providerChoices = element('div', 'dsh-mobile-control__provider-choices'); providerChoices.setAttribute('role', 'radiogroup'); providerChoices.setAttribute('aria-label', t('providerGroupAria'))
  const tailscaleChoice = element('button', 'dsh-mobile-control__provider'); tailscaleChoice.type = 'button'; tailscaleChoice.setAttribute('role', 'radio'); tailscaleChoice.setAttribute('aria-checked', 'true')
  const tailscaleChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const tailscaleChoiceName = element('strong'); tailscaleChoiceName.textContent = 'Tailscale Funnel'
  const tailscaleChoiceBadge = element('span', 'dsh-mobile-control__provider-badge'); tailscaleChoiceBadge.textContent = t('builtIn')
  const tailscaleChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); tailscaleChoiceDescription.textContent = t('tailscaleDescription')
  tailscaleChoiceTop.append(tailscaleChoiceName, tailscaleChoiceBadge); tailscaleChoice.append(tailscaleChoiceTop, tailscaleChoiceDescription)
  const cpolarChoice = element('button', 'dsh-mobile-control__provider'); cpolarChoice.type = 'button'; cpolarChoice.setAttribute('role', 'radio'); cpolarChoice.setAttribute('aria-checked', 'false')
  const cpolarChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const cpolarChoiceName = element('strong'); cpolarChoiceName.textContent = 'cpolar'
  const cpolarChoiceBadge = element('span', 'dsh-mobile-control__provider-badge is-cpolar'); cpolarChoiceBadge.textContent = t('mainlandPreferred')
  const cpolarChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); cpolarChoiceDescription.textContent = t('cpolarDescription')
  cpolarChoiceTop.append(cpolarChoiceName, cpolarChoiceBadge); cpolarChoice.append(cpolarChoiceTop, cpolarChoiceDescription)
  providerChoices.append(cpolarChoice, tailscaleChoice)
  const cpolarSetup = element('section', 'dsh-mobile-control__cpolar-setup'); cpolarSetup.hidden = true
  const cpolarSetupTitle = element('h3', 'dsh-mobile-control__section-title'); cpolarSetupTitle.textContent = t('prepareCpolar')
  const cpolarComponentStatus = element('p', 'dsh-mobile-control__component-status'); cpolarComponentStatus.textContent = t('checkingComponent')
  const cpolarInstall = element('button', 'dsh-mobile-control__primary'); cpolarInstall.type = 'button'; cpolarInstall.textContent = t('installOfficial')
  const cpolarAccount = element('div', 'dsh-mobile-control__cpolar-account'); cpolarAccount.hidden = true
  const cpolarAccountText = element('p', 'dsh-mobile-control__component-note'); cpolarAccountText.textContent = t('cpolarAccountNote')
  const cpolarAccountLinks = element('div', 'dsh-mobile-control__link-row')
  const cpolarSignup = element('a', 'dsh-mobile-control__text-link'); cpolarSignup.href = 'https://dashboard.cpolar.com/signup'; cpolarSignup.target = '_blank'; cpolarSignup.rel = 'noopener noreferrer'; cpolarSignup.textContent = t('registerCpolar')
  const cpolarDashboard = element('a', 'dsh-mobile-control__text-link'); cpolarDashboard.href = 'https://dashboard.cpolar.com/auth'; cpolarDashboard.target = '_blank'; cpolarDashboard.rel = 'noopener noreferrer'; cpolarDashboard.textContent = t('openDashboard')
  cpolarAccountLinks.append(cpolarSignup, cpolarDashboard)
  const cpolarTokenLabel = element('label', 'dsh-mobile-control__token-label'); cpolarTokenLabel.textContent = 'Authtoken'
  const cpolarToken = element('input', 'dsh-mobile-control__token'); cpolarToken.type = 'password'; cpolarToken.autocomplete = 'off'; cpolarToken.spellcheck = false; cpolarToken.placeholder = t('tokenPlaceholder'); cpolarTokenLabel.append(cpolarToken)
  const cpolarConfigure = element('button', 'dsh-mobile-control__primary dsh-mobile-control__cpolar-connect'); cpolarConfigure.type = 'button'; cpolarConfigure.textContent = t('saveConnect')
  cpolarAccount.append(cpolarAccountText, cpolarAccountLinks, cpolarTokenLabel, cpolarConfigure)
  const cpolarDetails = element('details', 'dsh-mobile-control__details')
  const cpolarDetailsSummary = element('summary'); cpolarDetailsSummary.textContent = t('componentDetails')
  const cpolarDetailsBody = element('div', 'dsh-mobile-control__details-body')
  const cpolarDetailsText = element('p'); cpolarDetailsText.textContent = t('componentDetailsText')
  const cpolarStorage = element('code', 'dsh-mobile-control__storage'); cpolarStorage.textContent = t('pluginPrivateDirectory')
  const cpolarOfficial = element('a', 'dsh-mobile-control__text-link'); cpolarOfficial.href = 'https://www.cpolar.com/download'; cpolarOfficial.target = '_blank'; cpolarOfficial.rel = 'noopener noreferrer'; cpolarOfficial.textContent = t('officialDownload')
  const cpolarTerms = element('a', 'dsh-mobile-control__text-link'); cpolarTerms.href = 'https://www.cpolar.com/tos'; cpolarTerms.target = '_blank'; cpolarTerms.rel = 'noopener noreferrer'; cpolarTerms.textContent = t('terms')
  const cpolarPurge = element('button', 'dsh-mobile-control__danger'); cpolarPurge.type = 'button'; cpolarPurge.textContent = t('purgeCpolar')
  cpolarDetailsBody.append(cpolarDetailsText, cpolarStorage, cpolarOfficial, cpolarTerms, cpolarPurge); cpolarDetails.append(cpolarDetailsSummary, cpolarDetailsBody)
  cpolarSetup.append(cpolarSetupTitle, cpolarComponentStatus, cpolarInstall, cpolarAccount, cpolarDetails)
  const selfHosted = element('details', 'dsh-mobile-control__self-hosted')
  const selfHostedSummary = element('summary', 'dsh-mobile-control__self-hosted-summary')
  const selfHostedSummaryText = element('span')
  const selfHostedSummaryTitle = element('strong'); selfHostedSummaryTitle.textContent = t('selfHostedConnections')
  const selfHostedSummaryDescription = element('span'); selfHostedSummaryDescription.textContent = t('selfHostedDescription')
  const selfHostedBadge = element('span', 'dsh-mobile-control__provider-badge is-frp'); selfHostedBadge.textContent = t('advanced')
  selfHostedSummaryText.append(selfHostedSummaryTitle, selfHostedSummaryDescription); selfHostedSummary.append(selfHostedSummaryText, selfHostedBadge)
  const selfHostedBody = element('div', 'dsh-mobile-control__self-hosted-body')
  const frpChoice = element('button', 'dsh-mobile-control__provider is-frp'); frpChoice.type = 'button'; frpChoice.setAttribute('aria-pressed', 'false')
  const frpChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const frpChoiceName = element('strong'); frpChoiceName.textContent = t('frpName')
  const frpChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); frpChoiceDescription.textContent = t('frpDescription')
  frpChoiceTop.append(frpChoiceName); frpChoice.append(frpChoiceTop, frpChoiceDescription)
  selfHostedBody.append(frpChoice); selfHosted.append(selfHostedSummary, selfHostedBody)
  providerSection.append(providerHeading, providerInfo, providerChoices, selfHosted)
  const frpSetup = element('section', 'dsh-mobile-control__frp-setup'); frpSetup.hidden = true
  const frpSetupTitle = element('h3', 'dsh-mobile-control__section-title'); frpSetupTitle.textContent = t('prepareFrp')
  const frpStep1 = element('section', 'dsh-mobile-control__frp-step')
  const frpStep1Title = element('strong'); frpStep1Title.textContent = t('frpStep1Title')
  const frpStep1Text = element('p'); frpStep1Text.textContent = t('frpStep1Text')
  const frpFields = element('div', 'dsh-mobile-control__frp-fields')
  const frpServerLabel = element('label', 'dsh-mobile-control__field'); frpServerLabel.textContent = t('frpServerAddress')
  const frpServer = element('input'); frpServer.type = 'text'; frpServer.autocomplete = 'off'; frpServer.spellcheck = false; frpServer.placeholder = t('frpServerAddressPlaceholder')
  const frpPortLabel = element('label', 'dsh-mobile-control__field'); frpPortLabel.textContent = t('frpServerPort')
  const frpPort = element('input'); frpPort.type = 'number'; frpPort.inputMode = 'numeric'; frpPort.min = '1'; frpPort.max = '65535'; frpPort.value = '7000'
  const frpTokenLabel = element('label', 'dsh-mobile-control__field'); frpTokenLabel.textContent = t('frpToken')
  const frpToken = element('input'); frpToken.type = 'password'; frpToken.autocomplete = 'off'; frpToken.spellcheck = false; frpToken.placeholder = t('frpTokenPlaceholder')
  const frpOriginLabel = element('label', 'dsh-mobile-control__field'); frpOriginLabel.textContent = t('frpPublicOrigin')
  const frpOrigin = element('input'); frpOrigin.type = 'url'; frpOrigin.autocomplete = 'off'; frpOrigin.spellcheck = false; frpOrigin.placeholder = t('frpPublicOriginPlaceholder')
  frpServerLabel.append(frpServer); frpPortLabel.append(frpPort); frpTokenLabel.append(frpToken); frpOriginLabel.append(frpOrigin)
  frpFields.append(frpServerLabel, frpPortLabel, frpTokenLabel, frpOriginLabel); frpStep1.append(frpStep1Title, frpStep1Text, frpFields)
  const frpStep2 = element('section', 'dsh-mobile-control__frp-step')
  const frpStep2Title = element('strong'); frpStep2Title.textContent = t('frpStep2Title')
  const frpStep2Text = element('p'); frpStep2Text.textContent = t('frpStep2Text')
  const frpCopyTemplate = element('button', 'dsh-mobile-control__secondary dsh-mobile-control__frp-action'); frpCopyTemplate.type = 'button'; frpCopyTemplate.textContent = t('copyServerTemplate')
  const vpsDeployText = element('p'); vpsDeployText.textContent = t('vpsDeployText')
  const vpsChangesTitle = element('p'); vpsChangesTitle.textContent = t('vpsDeployChangesTitle')
  const vpsChanges = element('ul', 'dsh-mobile-control__frp-changes')
  for (const key of ['vpsDeployChangePackages', 'vpsDeployChangeServices', 'vpsDeployChangeFirewall', 'vpsDeployChangeManual'] as const) {
    const item = element('li'); item.textContent = t(key); vpsChanges.append(item)
  }
  const vpsDeployFields = element('div', 'dsh-mobile-control__frp-fields')
  const vpsSshUserLabel = element('label', 'dsh-mobile-control__field'); vpsSshUserLabel.textContent = t('vpsSshUser')
  const vpsSshUser = element('input'); vpsSshUser.type = 'text'; vpsSshUser.autocomplete = 'username'; vpsSshUser.value = 'ubuntu'; vpsSshUser.spellcheck = false
  const vpsSshPortLabel = element('label', 'dsh-mobile-control__field'); vpsSshPortLabel.textContent = t('vpsSshPort')
  const vpsSshPort = element('input'); vpsSshPort.type = 'number'; vpsSshPort.inputMode = 'numeric'; vpsSshPort.min = '1'; vpsSshPort.max = '65535'; vpsSshPort.value = '22'
  const vpsSshKeyLabel = element('label', 'dsh-mobile-control__field'); vpsSshKeyLabel.textContent = t('vpsSshKey')
  const vpsSshKey = element('input'); vpsSshKey.type = 'text'; vpsSshKey.autocomplete = 'off'; vpsSshKey.spellcheck = false; vpsSshKey.placeholder = t('vpsSshKeyPlaceholder')
  vpsSshUserLabel.append(vpsSshUser); vpsSshPortLabel.append(vpsSshPort); vpsSshKeyLabel.append(vpsSshKey)
  vpsDeployFields.append(vpsSshUserLabel, vpsSshPortLabel, vpsSshKeyLabel)
  const vpsDeploy = element('button', 'dsh-mobile-control__primary dsh-mobile-control__frp-action'); vpsDeploy.type = 'button'; vpsDeploy.textContent = t('vpsDeploy')
  const vpsDeployStatus = element('p', 'dsh-mobile-control__component-status'); vpsDeployStatus.textContent = ''
  const vpsCopyUninstall = element('button', 'dsh-mobile-control__secondary dsh-mobile-control__frp-action'); vpsCopyUninstall.type = 'button'; vpsCopyUninstall.textContent = t('vpsCopyUninstall')
  const vpsUninstall = element('button', 'dsh-mobile-control__danger dsh-mobile-control__frp-action'); vpsUninstall.type = 'button'; vpsUninstall.textContent = t('vpsUninstall')
  frpStep2.append(frpStep2Title, frpStep2Text, frpCopyTemplate, vpsDeployText, vpsChangesTitle, vpsChanges, vpsDeployFields, vpsDeploy, vpsDeployStatus, vpsCopyUninstall, vpsUninstall)
  const frpStep3 = element('section', 'dsh-mobile-control__frp-step')
  const frpStep3Title = element('strong'); frpStep3Title.textContent = t('frpStep3Title')
  const frpStep3Text = element('p'); frpStep3Text.textContent = t('frpStep3Text')
  const frpComponentStatus = element('p', 'dsh-mobile-control__component-status'); frpComponentStatus.textContent = t('checkingComponent')
  const frpInstall = element('button', 'dsh-mobile-control__primary dsh-mobile-control__frp-action'); frpInstall.type = 'button'; frpInstall.textContent = t('installFrpc')
  frpStep3.append(frpStep3Title, frpStep3Text, frpComponentStatus, frpInstall)
  const frpStep4 = element('section', 'dsh-mobile-control__frp-step')
  const frpStep4Title = element('strong'); frpStep4Title.textContent = t('frpStep4Title')
  const frpStep4Text = element('p'); frpStep4Text.textContent = t('frpStep4Text')
  const frpAppRequirement = element('p', 'dsh-mobile-control__frp-requirement'); frpAppRequirement.textContent = t('frpAppRequirement')
  const frpConfigurationStatus = element('p', 'dsh-mobile-control__component-status'); frpConfigurationStatus.textContent = t('frpConfigurationMissing')
  const frpConfigure = element('button', 'dsh-mobile-control__primary dsh-mobile-control__frp-action'); frpConfigure.type = 'button'; frpConfigure.textContent = t('frpSaveConnect')
  frpStep4.append(frpStep4Title, frpStep4Text, frpAppRequirement, frpConfigurationStatus, frpConfigure)
  const frpDetails = element('details', 'dsh-mobile-control__details')
  const frpDetailsSummary = element('summary'); frpDetailsSummary.textContent = t('frpComponentDetails')
  const frpDetailsBody = element('div', 'dsh-mobile-control__details-body')
  const frpDetailsText = element('p'); frpDetailsText.textContent = t('frpComponentDetailsText')
  const frpStorage = element('code', 'dsh-mobile-control__storage'); frpStorage.textContent = t('pluginPrivateDirectory')
  const frpOfficial = element('a', 'dsh-mobile-control__text-link'); frpOfficial.href = 'https://github.com/fatedier/frp/releases/tag/v0.70.1'; frpOfficial.target = '_blank'; frpOfficial.rel = 'noopener noreferrer'; frpOfficial.textContent = t('frpOfficialRelease')
  const frpPurge = element('button', 'dsh-mobile-control__danger'); frpPurge.type = 'button'; frpPurge.textContent = t('purgeFrp')
  frpDetailsBody.append(frpDetailsText, frpStorage, frpOfficial, frpPurge); frpDetails.append(frpDetailsSummary, frpDetailsBody)
  const frpOverview = element('section', 'dsh-mobile-control__frp-overview'); frpOverview.hidden = true
  const frpOverviewMark = element('span', 'dsh-mobile-control__frp-overview-mark'); frpOverviewMark.textContent = '✓'
  const frpOverviewBody = element('div', 'dsh-mobile-control__frp-overview-body')
  const frpOverviewTitle = element('strong'); frpOverviewTitle.textContent = t('frpConfigurationReady')
  const frpOverviewEndpoint = element('span'); frpOverviewEndpoint.textContent = ''
  frpOverviewBody.append(frpOverviewTitle, frpOverviewEndpoint); frpOverview.append(frpOverviewMark, frpOverviewBody)
  const frpConnectionGroup = element('details', 'dsh-mobile-control__frp-group')
  const frpConnectionSummary = element('summary'); frpConnectionSummary.textContent = t('frpStep1Title')
  frpConnectionGroup.append(frpConnectionSummary, frpStep1)
  const frpVpsGroup = element('details', 'dsh-mobile-control__frp-group')
  const frpVpsSummary = element('summary'); frpVpsSummary.textContent = t('vpsDeployTitle')
  frpVpsGroup.append(frpVpsSummary, frpStep2)
  const frpComponentGroup = element('details', 'dsh-mobile-control__frp-group')
  const frpComponentSummary = element('summary'); frpComponentSummary.textContent = t('frpStep3Title')
  frpComponentGroup.append(frpComponentSummary, frpStep3)
  const frpVerifyGroup = element('details', 'dsh-mobile-control__frp-group'); frpVerifyGroup.open = true
  const frpVerifySummary = element('summary'); frpVerifySummary.textContent = t('frpStep4Title')
  frpVerifyGroup.append(frpVerifySummary, frpStep4)
  frpSetup.append(frpSetupTitle, frpOverview, frpConnectionGroup, frpVpsGroup, frpComponentGroup, frpVerifyGroup, frpDetails)
  const tailscaleInfo = element('details', 'dsh-mobile-control__details')
  const tailscaleInfoSummary = element('summary'); tailscaleInfoSummary.textContent = t('tailscaleHelp')
  const tailscaleInfoBody = element('div', 'dsh-mobile-control__details-body')
  const tailscaleInfoText = element('p'); tailscaleInfoText.textContent = t('tailscaleHelpText')
  tailscaleInfoBody.append(tailscaleInfoText); tailscaleInfo.append(tailscaleInfoSummary, tailscaleInfoBody)
  const providerSetupHeader = element('div', 'dsh-mobile-control__stage-header')
  const providerSetupHeading = element('h3', 'dsh-mobile-control__section-title'); providerSetupHeading.textContent = t('currentProvider')
  const providerSetupName = element('span', 'dsh-mobile-control__stage-value'); providerSetupName.textContent = 'Tailscale Funnel'
  const remoteStateBadge = element('span', 'dsh-mobile-control__state-badge'); remoteStateBadge.textContent = t('remoteStateOff')
  const providerSetupMeta = element('div', 'dsh-mobile-control__stage-meta'); providerSetupMeta.append(providerSetupName, remoteStateBadge)
  providerSetupHeader.append(providerSetupHeading, providerSetupMeta)
  const providerSetupBody = element('div', 'dsh-mobile-control__provider-setup-body')
  providerSetupBody.append(cpolarSetup, frpSetup, tailscaleInfo)
  const remoteAccess = element('div', 'dsh-mobile-control__access'); remoteAccess.hidden = true
  const remoteAccessLabel = element('span', 'dsh-mobile-control__access-label'); remoteAccessLabel.textContent = t('remoteAddress')
  const remoteAccessLink = element('a', 'dsh-mobile-control__access-link'); remoteAccessLink.target = '_blank'; remoteAccessLink.rel = 'noreferrer'; remoteAccess.append(remoteAccessLabel, remoteAccessLink)
  const remoteQr = element('div', 'dsh-mobile-control__qr'); remoteQr.hidden = true
  const remoteStatus = element('p', 'dsh-mobile-control__status'); remoteStatus.textContent = t('loadingRemoteStatus'); remoteStatus.setAttribute('aria-live', 'polite')
  const remoteGuide = element('section', 'dsh-mobile-control__guide'); remoteGuide.hidden = true; remoteGuide.setAttribute('aria-label', t('funnelGuideAria'))
  const remoteGuideTitle = element('h3', 'dsh-mobile-control__guide-title'); remoteGuideTitle.textContent = t('funnelGuideTitle')
  const remoteGuideSummary = element('p', 'dsh-mobile-control__guide-summary'); remoteGuideSummary.textContent = t('funnelGuideSummary')
  const remoteGuideSteps = element('ol', 'dsh-mobile-control__guide-steps')
  for (const text of [t('funnelStep1'), t('funnelStep2'), t('funnelStep3')]) {
    const item = element('li'); item.textContent = text; remoteGuideSteps.append(item)
  }
  const remoteGuideNote = element('p', 'dsh-mobile-control__guide-note'); remoteGuideNote.textContent = t('funnelGuideNote')
  const remoteGuideActions = element('div', 'dsh-mobile-control__guide-actions')
  const remoteSetup = element('button', 'dsh-mobile-control__primary'); remoteSetup.type = 'button'; remoteSetup.textContent = t('continueFunnel')
  const remoteSetupRetry = element('button', 'dsh-mobile-control__secondary'); remoteSetupRetry.type = 'button'; remoteSetupRetry.textContent = t('retryNow')
  remoteGuideActions.append(remoteSetup, remoteSetupRetry); remoteGuide.append(remoteGuideTitle, remoteGuideSummary, remoteGuideSteps, remoteGuideNote, remoteGuideActions)
  const remoteActions = element('div', 'dsh-mobile-control__actions')
  const remoteToggle = element('button', 'dsh-mobile-control__primary'); remoteToggle.type = 'button'; remoteToggle.textContent = t('enableRemote')
  const remoteLogin = element('button', 'dsh-mobile-control__primary'); remoteLogin.type = 'button'; remoteLogin.textContent = t('continueLogin'); remoteLogin.hidden = true
  const remoteReconnect = element('button', 'dsh-mobile-control__secondary'); remoteReconnect.type = 'button'; remoteReconnect.textContent = t('reconnect'); remoteReconnect.hidden = true
  const remotePair = element('button', 'dsh-mobile-control__secondary'); remotePair.type = 'button'; remotePair.textContent = t('generateRemoteQr'); remotePair.disabled = true
  remoteActions.append(remoteToggle, remoteLogin, remoteReconnect, remotePair)
  const remoteManageRow = element('div', 'dsh-mobile-control__manage-row')
  const remoteDevices = element('button', 'dsh-mobile-control__manage'); remoteDevices.type = 'button'; remoteDevices.textContent = t('manageRemoteDevices'); remoteDevices.disabled = true
  const remoteReset = element('button', 'dsh-mobile-control__manage'); remoteReset.type = 'button'; remoteReset.textContent = t('resetRemoteLogin')
  remoteManageRow.append(remoteDevices, remoteReset)
  const remoteDevicePanel = element('div', 'dsh-mobile-control__devices'); remoteDevicePanel.hidden = true
  const remoteWorkspace = element('section', 'dsh-mobile-control__remote-workspace')
  remoteWorkspace.append(providerSetupHeader, remoteStatus, remoteAccess, remoteGuide, providerSetupBody, remoteActions, remoteQr, remoteManageRow, remoteDevicePanel)
  const diagnosticsView = element('div', 'dsh-mobile-control__view is-diagnostics'); diagnosticsView.hidden = true
  const diagnosticsIntro = element('p', 'dsh-mobile-control__intro'); diagnosticsIntro.textContent = t('diagnosticsIntro')
  const diagnosticsSummary = element('section', 'dsh-mobile-control__diagnostic-summary is-idle'); diagnosticsSummary.setAttribute('aria-live', 'polite')
  const diagnosticsSummaryMain = element('div', 'dsh-mobile-control__diagnostic-summary-main')
  const diagnosticsSummaryIcon = element('span', 'dsh-mobile-control__diagnostic-summary-icon'); diagnosticsSummaryIcon.setAttribute('aria-hidden', 'true')
  const diagnosticsSummaryBody = element('div', 'dsh-mobile-control__diagnostic-summary-body')
  const diagnosticsSummaryTitle = element('strong'); diagnosticsSummaryTitle.textContent = t('diagnosticsNotRun')
  const diagnosticsSummaryText = element('span'); diagnosticsSummaryText.textContent = t('diagnosticsStartHint')
  const diagnosticsSummaryMeta = element('span', 'dsh-mobile-control__diagnostic-summary-meta'); diagnosticsSummaryMeta.textContent = t('diagnosticsIdleMeta')
  diagnosticsSummaryBody.append(diagnosticsSummaryTitle, diagnosticsSummaryText)
  diagnosticsSummaryMain.append(diagnosticsSummaryIcon, diagnosticsSummaryBody)
  diagnosticsSummary.append(diagnosticsSummaryMain, diagnosticsSummaryMeta)
  const diagnosticsToolbar = element('div', 'dsh-mobile-control__diagnostic-toolbar')
  const diagnosticsRun = element('button', 'dsh-mobile-control__primary dsh-mobile-control__diagnostic-run'); diagnosticsRun.type = 'button'; diagnosticsRun.textContent = t('diagnosticsStart')
  const diagnosticsCopy = element('button', 'dsh-mobile-control__secondary dsh-mobile-control__diagnostic-copy'); diagnosticsCopy.type = 'button'; diagnosticsCopy.textContent = t('diagnosticsCopy'); diagnosticsCopy.disabled = true; diagnosticsCopy.hidden = true
  diagnosticsToolbar.append(diagnosticsRun, diagnosticsCopy)
  const diagnosticsFeedback = element('p', 'dsh-mobile-control__diagnostic-feedback'); diagnosticsFeedback.hidden = true; diagnosticsFeedback.setAttribute('role', 'status'); diagnosticsFeedback.setAttribute('aria-live', 'polite')
  const diagnosticsChecks = element('div', 'dsh-mobile-control__diagnostic-checks'); diagnosticsChecks.hidden = true
  const diagnosticsDetails = element('details', 'dsh-mobile-control__details dsh-mobile-control__diagnostic-details'); diagnosticsDetails.hidden = true
  const diagnosticsDetailsSummary = element('summary'); diagnosticsDetailsSummary.textContent = t('diagnosticsAdvanced')
  const diagnosticsReport = element('pre', 'dsh-mobile-control__diagnostic-report')
  diagnosticsDetails.append(diagnosticsDetailsSummary, diagnosticsReport)
  header.append(title, headerActions); actions.append(toggle, pair, linkPair)
  lanView.append(access, qrBox, status, extensionStatus, actions, manageRow, devicePanel)
  remoteView.append(remoteIntro, providerSection, remoteWorkspace)
  diagnosticsView.append(diagnosticsIntro, diagnosticsSummary, diagnosticsToolbar, diagnosticsFeedback, diagnosticsChecks, diagnosticsDetails)
  panel.append(header, releaseNotice, appDownload, switcher, lanView, remoteView, diagnosticsView); root.append(panel); document.body.append(root)
  let running = false
  let origin = ''
  let remoteRunning = false
  let remoteReady = false
  let remoteProvider: 'tailscale' | 'cpolar' | 'frp' = 'tailscale'
  let remoteLoginUrl = ''
  let remoteSetupUrl = ''
  let remoteSetupPending = false
  let remoteSetupOpenedAt = 0
  let remoteReconnectBusy = false
  let remoteProviderBusy = false
  let cpolarInstalled = false
  let cpolarConfigured = false
  let frpInstalled = false
  let frpConfigured = false
  let frpLayoutInitialized = false
  let frpDownloadSize = '14.0'
  let configuredFrpServer = ''
  let configuredFrpPort = 7000
  let configuredFrpOrigin = ''
  let providerInfoPinned = false
  let providerInfoHovered = false
  let previousAccessView: 'lan' | 'remote' = 'lan'
  let diagnosticsBusy = false
  let copiedDiagnosticReport = ''
  let pluginUpdateAvailable = false
  let pluginLatestVersion = ''
  const renderRelease = (data: Record<string, unknown>): void => {
    const release = clientReleaseInfo(data)
    pluginUpdateAvailable = release.updateAvailable
    pluginLatestVersion = release.latestVersion ?? ''
    updatePlugin.hidden = !pluginUpdateAvailable || !diagnosticsView.hidden
    updatePlugin.textContent = t('updatePlugin')
    if (pluginLatestVersion !== '') updatePlugin.setAttribute('aria-label', t('updatePluginAria', { version: pluginLatestVersion }))
    if (release.androidVersion !== undefined) {
      appDownload.textContent = t('downloadAndroidVersion', { version: release.androidVersion })
      appDownload.setAttribute('aria-label', t('downloadAndroidVersionAria', { version: release.androidVersion }))
    }
    appDownload.href = release.androidDownloadUrl
  }
  const syncProviderInfo = (): void => {
    const open = providerInfoPinned || providerInfoHovered || providerInfo.contains(document.activeElement)
    providerInfoPopover.hidden = !open
    providerInfoButton.setAttribute('aria-expanded', String(open))
  }
  providerInfo.addEventListener('pointerenter', () => { providerInfoHovered = true; syncProviderInfo() })
  providerInfo.addEventListener('pointerleave', () => { providerInfoHovered = false; syncProviderInfo() })
  providerInfo.addEventListener('focusin', syncProviderInfo)
  providerInfo.addEventListener('focusout', () => { window.setTimeout(syncProviderInfo, 0) })
  providerInfoButton.addEventListener('click', () => { providerInfoPinned = !providerInfoPinned; syncProviderInfo() })
  providerInfoButton.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    providerInfoPinned = false
    providerInfoHovered = false
    providerInfoPopover.hidden = true
    providerInfoButton.setAttribute('aria-expanded', 'false')
  })
  const selectView = (view: 'lan' | 'remote' | 'diagnostics'): void => {
    if (view !== 'diagnostics') previousAccessView = view
    lanView.hidden = view !== 'lan'
    remoteView.hidden = view !== 'remote'
    diagnosticsView.hidden = view !== 'diagnostics'
    lanTab.classList.toggle('is-active', view === 'lan')
    remoteTab.classList.toggle('is-active', view === 'remote')
    lanTab.setAttribute('aria-pressed', String(view === 'lan'))
    remoteTab.setAttribute('aria-pressed', String(view === 'remote'))
    diagnosticsEntry.setAttribute('aria-pressed', String(view === 'diagnostics'))
    diagnosticsEntry.textContent = view === 'diagnostics' ? t('back') : t('diagnostics')
    diagnosticsEntry.setAttribute('aria-label', view === 'diagnostics' ? t('backToMobile') : t('openDiagnostics'))
    updatePlugin.hidden = view === 'diagnostics' || !pluginUpdateAvailable
    appDownload.hidden = view === 'diagnostics'
    switcher.hidden = view === 'diagnostics'
    title.textContent = view === 'lan' ? t('lanAccess') : view === 'remote' ? t('remoteAccess') : t('connectionDiagnostics')
  }
  lanTab.addEventListener('click', () => { selectView('lan') })
  remoteTab.addEventListener('click', () => { selectView('remote'); loadRemote() })
  const setOpen = (open: boolean): void => {
    panel.hidden = !open
    for (const trigger of document.querySelectorAll('.dsh-mobile-control__trigger')) trigger.setAttribute('aria-expanded', String(open))
  }
  const render = (data: Record<string, unknown>): void => {
    running = data.running === true
    origin = running && typeof data.origin === 'string' ? data.origin : ''
    access.hidden = origin === ''
    accessLink.href = origin
    accessLink.textContent = origin
    accessLink.title = origin
    status.classList.toggle('is-running', running)
    status.textContent = running ? t('lanOn') : t('lanOff')
    const extensionData = data.extensions
    if (extensionData !== null && typeof extensionData === 'object') {
      const loaded = typeof (extensionData as { loaded?: unknown }).loaded === 'number' ? (extensionData as { loaded: number }).loaded : 0
      const failed = typeof (extensionData as { failed?: unknown }).failed === 'number' ? (extensionData as { failed: number }).failed : 0
      extensionStatus.hidden = false
      extensionStatus.textContent = failed === 0 ? t('extensionsLoaded', { loaded }) : t('extensionsFailed', { loaded, failed })
    } else extensionStatus.hidden = true
    if (!running) qrBox.hidden = true
    toggle.textContent = running ? t('disableLan') : t('enableLan')
    pair.disabled = !running
    linkPair.disabled = !running
    manageDevices.disabled = !running
    resetAll.disabled = !running
  }
  const showQr = (svg: string, target: HTMLDivElement = qrBox): void => {
    target.replaceChildren()
    if (svg === '') { target.hidden = true; return }
    const image = element('img')
    image.alt = t('pairingQr')
    image.width = 176
    image.height = 176
    image.src = `data:image/svg+xml;base64,${btoa(svg)}`
    target.hidden = false
    target.append(image)
  }
  const openPairing = (target: 'key' | 'link'): void => {
    void controlRequestJson('/api/mobile-access/lan/pairing/open', { method: 'POST', body: '{}' }).then(async data => {
      const value = target === 'key'
        ? (typeof data.appKey === 'string' ? data.appKey : '')
        : (typeof data.pairUrl === 'string' ? data.pairUrl : '')
      showQr(typeof data.qrSvg === 'string' ? data.qrSvg : '')
      if (value === '') { status.textContent = t('keyGenerationFailed'); return }
      try {
        await navigator.clipboard.writeText(value)
        status.textContent = target === 'key'
          ? t('keyCopied')
          : t('linkCopied')
      } catch {
        status.textContent = t('copySecret', { kind: target === 'key' ? t('pairingKey') : t('pairingLink'), value })
        status.classList.add('is-key')
      }
    }, error => { status.textContent = t('requestFailed', { error: String(error) }) }).finally(() => {
      pair.disabled = !running
      linkPair.disabled = !running
    })
  }
  toggle.addEventListener('click', () => { toggle.disabled = true; void controlRequestJson('/api/mobile-access/lan/control', { method: 'POST', body: JSON.stringify({ running: !running }) }).then(render, error => { status.textContent = t('requestFailed', { error: String(error) }) }).finally(() => { toggle.disabled = false }) })
  const formatTime = (ms: unknown): string => typeof ms === 'number' ? new Date(ms).toLocaleString(localeTag) : ''
  const formatMegabytes = (bytes: number): string => new Intl.NumberFormat(localeTag, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1024 / 1024)
  const renderDevices = (data: Record<string, unknown>): void => {
    const devices = Array.isArray(data.devices) ? data.devices as Record<string, unknown>[] : []
    devicePanel.replaceChildren()
    if (devices.length === 0) {
      const empty = element('p', 'dsh-mobile-control__device-empty'); empty.textContent = t('noDevices')
      devicePanel.append(empty)
      return
    }
    for (const device of devices) {
      const row = element('div', 'dsh-mobile-control__device')
      const label = element('span', 'dsh-mobile-control__device-label')
      label.textContent = typeof device.label === 'string' ? device.label : t('device')
      const meta = element('span', 'dsh-mobile-control__device-meta'); meta.textContent = t('expires', { time: formatTime(device.expiresAt) })
      const revoke = element('button', 'dsh-mobile-control__device-revoke'); revoke.type = 'button'; revoke.textContent = t('revoke')
      const id = typeof device.id === 'string' ? device.id : ''
      revoke.addEventListener('click', () => {
        void controlRequestJson('/api/mobile-access/lan/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: id }) })
          .then(loadDevices, error => { status.textContent = t('requestFailed', { error: String(error) }) })
      })
      row.append(label, meta, revoke)
      devicePanel.append(row)
    }
  }
  const loadDevices = (): void => {
    void controlRequestJson('/api/mobile-access/lan/devices').then(renderDevices, error => { status.textContent = t('requestFailed', { error: String(error) }) })
  }
  manageDevices.addEventListener('click', () => {
    const show = devicePanel.hidden
    devicePanel.hidden = !show
    if (show) loadDevices()
  })
  resetAll.addEventListener('click', () => {
    if (!window.confirm(t('confirmResetDevices'))) return
    void controlRequestJson('/api/mobile-access/lan/devices/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(loadDevices, error => { status.textContent = t('requestFailed', { error: String(error) }) })
  })
  const renderRemote = (data: Record<string, unknown>): void => {
    remoteRunning = data.running === true
    remoteProvider = data.provider === 'cpolar' ? 'cpolar' : data.provider === 'frp' ? 'frp' : 'tailscale'
    const cpolar = remoteProvider === 'cpolar'
    const frp = remoteProvider === 'frp'
    const tailscale = remoteProvider === 'tailscale'
    tailscaleChoice.classList.toggle('is-selected', tailscale)
    cpolarChoice.classList.toggle('is-selected', cpolar)
    frpChoice.classList.toggle('is-selected', frp)
    tailscaleChoice.setAttribute('aria-checked', String(tailscale))
    cpolarChoice.setAttribute('aria-checked', String(cpolar))
    frpChoice.setAttribute('aria-pressed', String(frp))
    providerSetupName.textContent = cpolar ? 'cpolar' : frp ? t('frpName') : 'Tailscale Funnel'
    tailscaleChoice.disabled = remoteProviderBusy
    cpolarChoice.disabled = remoteProviderBusy
    frpChoice.disabled = remoteProviderBusy
    cpolarSetup.hidden = !cpolar
    frpSetup.hidden = !frp
    if (frp) selfHosted.open = true
    tailscaleInfo.hidden = !tailscale
    remoteReset.textContent = tailscale ? t('resetRemoteLogin') : t('resetRemoteDevices')
    const providers = data.providers !== null && typeof data.providers === 'object' ? data.providers as Record<string, unknown> : {}
    const cpolarProvider = providers.cpolar !== null && typeof providers.cpolar === 'object' ? providers.cpolar as Record<string, unknown> : {}
    const component = cpolarProvider.component !== null && typeof cpolarProvider.component === 'object'
      ? cpolarProvider.component as Record<string, unknown>
      : {}
    cpolarInstalled = component.installed === true
    cpolarConfigured = component.configured === true
    cpolarChoiceBadge.textContent = cpolarConfigured ? t('ready') : cpolarInstalled ? t('installed') : t('mainlandPreferred')
    const cpolarSupported = component.supported !== false
    const componentVersion = typeof component.version === 'string' ? component.version : ''
    const componentDownloadBytes = typeof component.downloadBytes === 'number' ? component.downloadBytes : 0
    const componentStorage = typeof component.storagePath === 'string' ? component.storagePath : `DSH Mobile ${t('pluginPrivateDirectory')}`
    cpolarStorage.textContent = componentStorage
    cpolarStorage.title = componentStorage
    cpolarInstall.hidden = cpolarInstalled || !cpolarSupported
    cpolarInstall.textContent = componentDownloadBytes > 0
      ? t('installWithSize', { size: formatMegabytes(componentDownloadBytes) })
      : t('installOfficial')
    cpolarInstall.disabled = remoteProviderBusy
    cpolarAccount.hidden = !cpolarInstalled || cpolarConfigured
    cpolarConfigure.disabled = remoteProviderBusy
    cpolarPurge.hidden = !cpolarInstalled && !cpolarConfigured
    cpolarComponentStatus.textContent = !cpolarSupported
      ? t('cpolarUnsupported')
      : !cpolarInstalled
        ? t('cpolarNotInstalled')
        : !cpolarConfigured
          ? t('cpolarNeedsToken', { version: componentVersion })
          : t('cpolarReady', { version: componentVersion })
    const frpProvider = providers.frp !== null && typeof providers.frp === 'object' ? providers.frp as Record<string, unknown> : {}
    const frpComponent = frpProvider.component !== null && typeof frpProvider.component === 'object'
      ? frpProvider.component as Record<string, unknown>
      : {}
    const frpConfiguration = frpProvider.configuration !== null && typeof frpProvider.configuration === 'object'
      ? frpProvider.configuration as Record<string, unknown>
      : {}
    frpInstalled = frpComponent.installed === true
    frpConfigured = frpConfiguration.configured === true
    const frpSupported = frpComponent.supported !== false
    const frpVersion = typeof frpComponent.version === 'string' ? frpComponent.version : ''
    const frpDownloadBytes = typeof frpComponent.downloadBytes === 'number' ? frpComponent.downloadBytes : 0
    if (frpDownloadBytes > 0) frpDownloadSize = formatMegabytes(frpDownloadBytes)
    const frpStoragePath = typeof frpComponent.storagePath === 'string' ? frpComponent.storagePath : `DSH Mobile ${t('pluginPrivateDirectory')}`
    configuredFrpServer = typeof frpConfiguration.serverAddress === 'string' ? frpConfiguration.serverAddress : ''
    configuredFrpPort = typeof frpConfiguration.serverPort === 'number' ? frpConfiguration.serverPort : 7000
    configuredFrpOrigin = typeof frpConfiguration.publicOrigin === 'string' ? frpConfiguration.publicOrigin : ''
    if (frpServer.value === '' && configuredFrpServer !== '') frpServer.value = configuredFrpServer
    if ((frpPort.value === '' || frpPort.value === '7000') && configuredFrpPort !== 7000) frpPort.value = String(configuredFrpPort)
    if (frpOrigin.value === '' && configuredFrpOrigin !== '') frpOrigin.value = configuredFrpOrigin
    frpStorage.textContent = frpStoragePath
    frpStorage.title = frpStoragePath
    frpInstall.hidden = frpInstalled || !frpSupported
    frpInstall.textContent = frpDownloadBytes > 0
      ? t('installWithSize', { size: formatMegabytes(frpDownloadBytes) })
      : t('installFrpc')
    frpInstall.disabled = remoteProviderBusy
    frpConfigure.disabled = remoteProviderBusy || !frpInstalled
    vpsDeploy.disabled = remoteProviderBusy || !validVpsDeploymentForm()
    vpsCopyUninstall.disabled = vpsDeploy.disabled
    vpsUninstall.disabled = vpsDeploy.disabled
    frpPurge.hidden = !frpInstalled && !frpConfigured
    frpComponentStatus.textContent = !frpSupported
      ? t('frpUnsupported')
      : frpInstalled ? t('frpComponentReady', { version: frpVersion }) : t('frpNotInstalled')
    frpConfigurationStatus.textContent = frpConfigured ? t('frpConfigurationReady') : t('frpConfigurationMissing')
    frpOverview.hidden = !frpConfigured
    frpOverviewEndpoint.textContent = configuredFrpOrigin === ''
      ? configuredFrpServer
      : `${configuredFrpOrigin} · ${configuredFrpServer}:${String(configuredFrpPort)}`
    frpToken.placeholder = frpConfigured
      ? (locale === 'zh' ? '已安全保存；留空保持不变' : locale === 'it' ? 'Salvato; lascia vuoto per mantenerlo' : 'Saved securely; leave blank to keep it')
      : t('frpTokenPlaceholder')
    vpsDeploy.textContent = frpConfigured
      ? (locale === 'zh' ? '修复或重新部署 VPS' : locale === 'it' ? 'Ripara o ridistribuisci VPS' : 'Repair or redeploy VPS')
      : t('vpsDeploy')
    frpConnectionSummary.textContent = `${frpConfigured ? '✓ ' : ''}${t('frpStep1Title')}`
    frpComponentSummary.textContent = `${frpInstalled ? '✓ ' : ''}${t('frpStep3Title')}`
    if (!frpLayoutInitialized) {
      frpConnectionGroup.open = !frpConfigured
      frpComponentGroup.open = !frpInstalled
      frpVpsGroup.open = false
      frpLayoutInitialized = true
    }
    selfHostedBadge.textContent = frpConfigured && frpInstalled ? t('ready') : t('advanced')
    const state = typeof data.state === 'string' ? data.state : 'error'
    const errorCode = typeof data.errorCode === 'string' ? data.errorCode : ''
    const remoteOrigin = typeof data.origin === 'string' ? data.origin : ''
    remoteLoginUrl = typeof data.loginUrl === 'string' ? data.loginUrl : ''
    const candidateSetupUrl = tailscale ? officialFunnelSetupUrl(data.setupUrl) : ''
    const fallbackSetupUrls: Record<string, string> = {
      funnel_permission_required: 'https://tailscale.com/s/no-funnel',
      funnel_https_required: 'https://tailscale.com/s/https',
      funnel_start_failed: 'https://tailscale.com/s/no-funnel',
    }
    remoteSetupUrl = candidateSetupUrl !== '' ? candidateSetupUrl : (fallbackSetupUrls[errorCode] ?? '')
    const needsFunnelSetup = state === 'error' && remoteSetupUrl !== ''
    remoteReady = remoteRunning && state === 'ready' && remoteOrigin !== ''
    remoteStateBadge.classList.toggle('is-ready', remoteReady)
    remoteStateBadge.classList.toggle('is-busy', state === 'starting' || state === 'connecting' || state === 'needs-login')
    remoteStateBadge.classList.toggle('is-attention', state === 'error' || state === 'unavailable')
    remoteStateBadge.textContent = remoteReady
      ? t('ready')
      : state === 'starting' || state === 'connecting' || state === 'needs-login'
        ? t('remoteStateConnecting')
        : state === 'error' || state === 'unavailable'
          ? t('remoteStateAttention')
          : t('remoteStateOff')
    remoteAccess.hidden = !remoteReady
    remoteAccessLink.href = remoteOrigin
    remoteAccessLink.textContent = remoteOrigin
    remoteAccessLink.title = remoteOrigin
    remoteStatus.classList.toggle('is-running', remoteReady)
    const labels: Record<string, string> = {
      off: t('remoteOff'),
      unavailable: cpolar ? t('remoteUnavailableCpolar') : frp ? t('remoteUnavailableFrp') : t('remoteUnavailableTailscale'),
      starting: cpolar ? t('remoteStartingCpolar') : frp ? t('remoteStartingFrp') : t('remoteStartingTailscale'),
      'needs-login': t('remoteNeedsLogin'),
      connecting: cpolar ? t('remoteConnectingCpolar') : frp ? t('remoteConnectingFrp') : t('remoteConnectingTailscale'),
      ready: t('remoteReady'),
      error: t('remoteError'),
    }
    const errorLabels: Record<string, string> = {
      funnel_permission_required: t('funnelPermission'),
      funnel_https_required: t('funnelHttps'),
      funnel_start_failed: t('funnelStart'),
      funnel_start_timeout: t('funnelTimeout'),
      tailscale_dns_missing: t('tailscaleDnsMissing'),
      gateway_start_failed: t('gatewayStartFailed'),
      control_channel_failed: t('controlChannelFailed'),
      cpolar_component_missing: t('cpolarMissing'),
      cpolar_component_invalid: t('cpolarInvalid'),
      cpolar_config_missing: t('cpolarConfigMissing'),
      cpolar_config_invalid: t('cpolarConfigInvalid'),
      cpolar_port_unavailable: t('cpolarPortUnavailable'),
      cpolar_launch_failed: t('cpolarLaunchFailed'),
      cpolar_start_timeout: t('cpolarTimeout'),
      cpolar_stopped: t('cpolarStopped'),
      cpolar_exited: t('cpolarExited'),
      cpolar_invalid_output: t('cpolarOutputInvalid'),
      cpolar_invalid_origin: t('cpolarOriginInvalid'),
      frp_component_missing: t('frpMissing'),
      frp_component_invalid: t('frpInvalid'),
      frp_config_missing: t('frpConfigMissing'),
      frp_config_verify_failed: t('frpConfigVerifyFailed'),
      frp_vhost_publicly_reachable: t('frpVhostPublic'),
      frp_vhost_probe_failed: t('frpVhostProbeFailed'),
      frp_launch_failed: t('frpLaunchFailed'),
      frp_start_timeout: t('frpTimeout'),
      frp_discovery_mismatch: t('frpDiscoveryMismatch'),
      frp_discovery_invalid: t('frpDiscoveryInvalid'),
      frp_stopped: t('frpStopped'),
      frp_exited: t('frpExited'),
    }
    remoteStatus.textContent = remoteSetupPending && needsFunnelSetup
      ? t('setupOpened')
      : (state === 'error' ? (errorLabels[errorCode] ?? labels.error!) : (labels[state] ?? labels.error!))
    remoteGuide.hidden = !needsFunnelSetup
    remoteSetup.disabled = remoteSetupUrl === '' || remoteReconnectBusy
    remoteSetupRetry.disabled = remoteReconnectBusy
    remoteToggle.textContent = remoteRunning ? t('disableRemote') : t('enableRemote')
    const providerPrepared = cpolar ? cpolarInstalled && cpolarConfigured : frp ? frpInstalled && frpConfigured : true
    remoteToggle.disabled = remoteProviderBusy || !providerPrepared
    remoteLogin.hidden = !tailscale || state !== 'needs-login' || remoteLoginUrl === ''
    remoteReconnect.hidden = needsFunnelSetup || (state !== 'error' && state !== 'unavailable')
      || !providerPrepared
    remoteActions.hidden = !providerPrepared
    remotePair.disabled = !remoteReady
    remoteDevices.disabled = !remoteReady
    if (!remoteReady) remoteQr.hidden = true
    if (!needsFunnelSetup) remoteSetupPending = false
  }
  let remoteLoadInFlight = false
  const loadRemote = (): void => {
    if (remoteLoadInFlight) return
    remoteLoadInFlight = true
    void controlRequestJson('/api/mobile-access/remote/control')
      .then(renderRemote, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
      .finally(() => { remoteLoadInFlight = false })
  }
  const chooseRemoteProvider = (provider: 'tailscale' | 'cpolar' | 'frp'): void => {
    if (remoteProviderBusy || provider === remoteProvider) return
    if (remoteRunning && !window.confirm(t('switchProviderConfirm'))) return
    remoteProviderBusy = true
    tailscaleChoice.disabled = true
    cpolarChoice.disabled = true
    frpChoice.disabled = true
    remoteStatus.textContent = provider === 'cpolar' ? t('switchingCpolar') : provider === 'frp' ? t('switchingFrp') : t('switchingTailscale')
    void controlRequestJson('/api/mobile-access/remote/provider', { method: 'POST', body: JSON.stringify({ provider }) })
      .then(renderRemote, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  }
  tailscaleChoice.addEventListener('click', () => { chooseRemoteProvider('tailscale') })
  cpolarChoice.addEventListener('click', () => { chooseRemoteProvider('cpolar') })
  frpChoice.addEventListener('click', () => { chooseRemoteProvider('frp') })
  cpolarInstall.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const accepted = window.confirm(t('installConfirm'))
    if (!accepted) return
    remoteProviderBusy = true
    cpolarInstall.disabled = true
    cpolarInstall.textContent = t('downloading')
    remoteStatus.textContent = t('installingCpolar')
    void controlRequestJson('/api/mobile-access/remote/cpolar/component/install', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteStatus.textContent = t('installFailed', { error: String(error) }) })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  })
  cpolarConfigure.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const authtoken = cpolarToken.value.trim()
    if (authtoken.length < 20 || /\s/u.test(authtoken)) {
      remoteStatus.textContent = t('invalidToken')
      cpolarToken.focus()
      return
    }
    remoteProviderBusy = true
    cpolarConfigure.disabled = true
    cpolarConfigure.setAttribute('aria-busy', 'true')
    cpolarConfigure.textContent = t('saving')
    void controlRequestJson('/api/mobile-access/remote/cpolar/configure', { method: 'POST', body: JSON.stringify({ authtoken }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(() => {
        cpolarToken.value = ''
        remoteStatus.textContent = t('configuredConnecting')
        return controlRequestJson('/api/mobile-access/remote/control', { method: 'POST', body: JSON.stringify({ running: true }) })
      })
      .then(renderRemote, error => { remoteStatus.textContent = t('configureFailed', { error: String(error) }) })
      .finally(() => { remoteProviderBusy = false; cpolarConfigure.setAttribute('aria-busy', 'false'); cpolarConfigure.textContent = t('saveConnect'); loadRemote() })
  })
  cpolarPurge.addEventListener('click', () => {
    if (remoteProviderBusy) return
    if (!window.confirm(t('purgeConfirm'))) return
    remoteProviderBusy = true
    cpolarPurge.disabled = true
    remoteStatus.textContent = t('purging')
    void controlRequestJson('/api/mobile-access/remote/cpolar/component/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteStatus.textContent = t('purgeFailed', { error: String(error) }) })
      .finally(() => { remoteProviderBusy = false; cpolarPurge.disabled = false; loadRemote() })
  })
  const validFrpServer = (value: string): boolean => value === value.trim() && value.length > 0 && value.length <= 253
    && !/[\s\u0000-\u001f\u007f/\\@?#]/u.test(value)
  const frpForm = (): { readonly serverAddress: string; readonly serverPort: number; readonly token: string; readonly publicOrigin: string } => ({
    serverAddress: String(frpServer.value ?? '').trim(),
    serverPort: Number(frpPort.value),
    token: String(frpToken.value ?? ''),
    publicOrigin: String(frpOrigin.value ?? '').trim(),
  })
  const validFrpForm = (form: ReturnType<typeof frpForm>): boolean => {
    if (!validFrpServer(form.serverAddress)) return false
    try {
      createFrpServerTemplateForClipboard(form.serverPort, form.token, form.publicOrigin)
      return true
    } catch { return false }
  }
  frpCopyTemplate.addEventListener('click', () => {
    const form = frpForm()
    if (!validFrpForm(form)) {
      remoteStatus.textContent = t('frpInputInvalid')
      return
    }
    void navigator.clipboard.writeText(createFrpServerTemplateForClipboard(form.serverPort, form.token, form.publicOrigin))
      .then(() => { remoteStatus.textContent = t('templateCopied') }, () => { remoteStatus.textContent = t('templateCopyFailed') })
  })
  const validVpsSshUser = (value: string): boolean => /^[a-z_][a-z0-9_.-]*[$]?$/iu.test(value) && value.length <= 64
  const validVpsSshKey = (value: string): boolean => value === '' || (/^[a-zA-Z]:[\\/]/u.test(value) || value.startsWith('/'))
  const vpsFormStorageKey = 'dsh-mobile.frp-vps-form.v1'
  try {
    const saved = JSON.parse(localStorage.getItem(vpsFormStorageKey) ?? '{}') as Record<string, unknown>
    if (typeof saved.sshUser === 'string' && validVpsSshUser(saved.sshUser)) vpsSshUser.value = saved.sshUser
    if (typeof saved.sshPort === 'number' && Number.isSafeInteger(saved.sshPort) && saved.sshPort >= 1 && saved.sshPort <= 65_535) vpsSshPort.value = String(saved.sshPort)
    if (typeof saved.sshKeyPath === 'string' && validVpsSshKey(saved.sshKeyPath)) vpsSshKey.value = saved.sshKeyPath
  } catch { /* Browser storage is an optional convenience only. */ }
  const saveVpsForm = (): void => {
    try {
      localStorage.setItem(vpsFormStorageKey, JSON.stringify({
        sshUser: String(vpsSshUser.value ?? '').trim(),
        sshPort: Number(vpsSshPort.value),
        sshKeyPath: String(vpsSshKey.value ?? '').trim(),
      }))
    } catch { /* Private browsing or a full quota must not block deployment. */ }
  }
  const validVpsDeploymentForm = (): boolean => {
    const sshPort = Number(vpsSshPort.value)
    return validVpsFrpForm()
      && validVpsSshUser(String(vpsSshUser.value ?? '').trim())
      && Number.isSafeInteger(sshPort) && sshPort >= 1 && sshPort <= 65_535
      && validVpsSshKey(String(vpsSshKey.value ?? '').trim())
  }
  /**
   * VPS actions accept blank connection fields when a configuration is already
   * saved; blanks keep their saved values ("已保存时可留空"). The token itself
   * is never readable here, so a blank token is merged server-side while the
   * remaining fields still pass the regular template check.
   */
  const vpsEffectiveForm = (): ReturnType<typeof frpForm> => {
    const form = frpForm()
    if (!frpConfigured) return form
    return {
      serverAddress: form.serverAddress === '' ? configuredFrpServer : form.serverAddress,
      serverPort: Number.isSafeInteger(form.serverPort) && form.serverPort >= 1 ? form.serverPort : configuredFrpPort,
      token: form.token,
      publicOrigin: form.publicOrigin === '' ? configuredFrpOrigin : form.publicOrigin,
    }
  }
  const validVpsFrpForm = (): boolean => {
    const form = vpsEffectiveForm()
    const token = form.token === '' && frpConfigured ? '0123456789abcdef' : form.token
    return validFrpForm({ ...form, token })
  }
  const refreshVpsDeployButton = (): void => {
    const disabled = remoteProviderBusy || !validVpsDeploymentForm()
    vpsDeploy.disabled = disabled
    vpsCopyUninstall.disabled = disabled
    vpsUninstall.disabled = disabled
  }
  for (const input of [frpServer, frpPort, frpToken, frpOrigin, vpsSshUser, vpsSshPort, vpsSshKey]) {
    input.addEventListener('input', refreshVpsDeployButton)
  }
  for (const input of [vpsSshUser, vpsSshPort, vpsSshKey]) input.addEventListener('input', saveVpsForm)
  const vpsCertName = (origin: string): string | undefined => {
    try {
      const host = new URL(origin).hostname
      return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) ? host : undefined
    } catch { return undefined }
  }
  const requestVpsHostKeys = (serverAddress: string, sshUser: string, sshPort: number, sshKeyPath: string): Promise<ReadonlyArray<{ readonly display: string; readonly fingerprint: string }>> => {
    const keyPayload: Record<string, unknown> = { serverAddress, sshUser, sshPort }
    if (sshKeyPath !== '') keyPayload.sshKeyPath = sshKeyPath
    return controlRequestJson('/api/mobile-access/remote/frp/vps/host-keys', { method: 'POST', body: JSON.stringify(keyPayload) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(keys => {
        const hostKeys = Array.isArray(keys.vpsHostKeys) ? keys.vpsHostKeys as Array<Record<string, unknown>> : []
        const confirmed = hostKeys
          .filter(key => typeof key.fingerprint === 'string' && typeof key.keyType === 'string')
          .map(key => ({ display: `${String(key.keyType)} ${String(key.fingerprint)}`, fingerprint: String(key.fingerprint) }))
        if (confirmed.length === 0) throw new Error(String(t('vpsHostKeyFailed', { error: 'empty' })))
        return confirmed
      })
  }
  vpsDeploy.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const form = vpsEffectiveForm()
    if (!validVpsFrpForm()) {
      vpsDeployStatus.textContent = t('vpsDeployNotReady')
      return
    }
    const sshUser = vpsSshUser.value.trim()
    const sshPort = Number(vpsSshPort.value)
    const sshKeyPath = vpsSshKey.value.trim()
    saveVpsForm()
    if (!validVpsSshUser(sshUser) || !Number.isSafeInteger(sshPort) || sshPort < 1 || sshPort > 65535 || !validVpsSshKey(sshKeyPath)) {
      vpsDeployStatus.textContent = t('vpsDeployFailed', { error: t('vpsSshKey') })
      return
    }
    remoteProviderBusy = true
    vpsDeploy.disabled = true
    vpsCopyUninstall.disabled = true
    vpsUninstall.disabled = true
    vpsDeployStatus.textContent = t('vpsHostKeyFetching')
    remoteStatus.textContent = t('vpsHostKeyFetching')
    void requestVpsHostKeys(form.serverAddress, sshUser, sshPort, sshKeyPath)
      .then(hostKeys => {
        const display = hostKeys.map(key => key.display).join('\n')
        if (!window.confirm(t('vpsDeployConfirmWithKeys', { fingerprints: display }))) {
          remoteProviderBusy = false
          refreshVpsDeployButton()
          loadRemote()
          return
        }
        vpsDeployStatus.textContent = t('vpsDeploying')
        remoteStatus.textContent = t('vpsDeploying')
        const payload: Record<string, unknown> = {
          confirm: true,
          ...form,
          sshUser,
          sshPort,
          hostFingerprints: hostKeys.map(key => key.fingerprint),
        }
        if (sshKeyPath !== '') payload.sshKeyPath = sshKeyPath
        return controlRequestJson('/api/mobile-access/remote/frp/vps/deploy', { method: 'POST', body: JSON.stringify(payload) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
          .then(data => {
            const deployment = data.vpsDeployment !== null && typeof data.vpsDeployment === 'object' ? data.vpsDeployment as Record<string, unknown> : {}
            vpsDeployStatus.textContent = deployment.deployed === true ? t('vpsDeploySuccess') : t('vpsDeployFailed', { error: t('vpsDeployFailed', { error: 'unknown result' }) })
            remoteStatus.textContent = vpsDeployStatus.textContent
            renderRemote(data)
          }, error => {
            vpsDeployStatus.textContent = t('vpsDeployFailed', { error: String(error) })
            remoteStatus.textContent = vpsDeployStatus.textContent
          })
          .finally(() => { remoteProviderBusy = false; loadRemote() })
      }, error => {
        vpsDeployStatus.textContent = t('vpsHostKeyFailed', { error: String(error) })
        remoteStatus.textContent = vpsDeployStatus.textContent
        remoteProviderBusy = false
        refreshVpsDeployButton()
        loadRemote()
      })
  })
  const readVpsSshForm = (): { sshUser: string; sshPort: number; sshKeyPath: string } | undefined => {
    const sshUser = vpsSshUser.value.trim()
    const sshPort = Number(vpsSshPort.value)
    const sshKeyPath = vpsSshKey.value.trim()
    saveVpsForm()
    if (!validVpsSshUser(sshUser) || !Number.isSafeInteger(sshPort) || sshPort < 1 || sshPort > 65535 || !validVpsSshKey(sshKeyPath)) {
      vpsDeployStatus.textContent = t('vpsDeployFailed', { error: t('vpsSshKey') })
      return undefined
    }
    return { sshUser, sshPort, sshKeyPath }
  }
  vpsCopyUninstall.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const form = vpsEffectiveForm()
    if (!validVpsFrpForm()) {
      vpsDeployStatus.textContent = t('vpsDeployNotReady')
      return
    }
    remoteProviderBusy = true
    refreshVpsDeployButton()
    const scriptPayload: Record<string, unknown> = { serverPort: form.serverPort }
    const certName = vpsCertName(form.publicOrigin)
    if (certName !== undefined) scriptPayload.certName = certName
    void controlRequestJson('/api/mobile-access/remote/frp/vps/uninstall-script', { method: 'POST', body: JSON.stringify(scriptPayload) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(data => {
        const script = typeof data.vpsUninstallScript === 'string' ? data.vpsUninstallScript : ''
        if (script === '') throw new Error('empty script')
        return navigator.clipboard.writeText(script)
      })
      .then(() => { vpsDeployStatus.textContent = t('vpsUninstallScriptCopied') }, error => {
        vpsDeployStatus.textContent = t('vpsUninstallScriptFailed', { error: String(error) })
      })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  })
  vpsUninstall.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const form = vpsEffectiveForm()
    if (!validVpsFrpForm()) {
      vpsDeployStatus.textContent = t('vpsDeployNotReady')
      return
    }
    const ssh = readVpsSshForm()
    if (ssh === undefined) return
    remoteProviderBusy = true
    refreshVpsDeployButton()
    vpsDeployStatus.textContent = t('vpsHostKeyFetching')
    remoteStatus.textContent = t('vpsHostKeyFetching')
    void requestVpsHostKeys(form.serverAddress, ssh.sshUser, ssh.sshPort, ssh.sshKeyPath)
      .then(hostKeys => {
        if (!window.confirm(t('vpsUninstallConfirmWithKeys', { fingerprints: hostKeys.map(key => key.display).join('\n') }))) {
          remoteProviderBusy = false
          refreshVpsDeployButton()
          loadRemote()
          return
        }
        vpsDeployStatus.textContent = t('vpsUninstalling')
        remoteStatus.textContent = t('vpsUninstalling')
        const payload: Record<string, unknown> = {
          confirm: true,
          serverAddress: form.serverAddress,
          serverPort: form.serverPort,
          sshUser: ssh.sshUser,
          sshPort: ssh.sshPort,
          hostFingerprints: hostKeys.map(key => key.fingerprint),
        }
        if (ssh.sshKeyPath !== '') payload.sshKeyPath = ssh.sshKeyPath
        const certName = vpsCertName(form.publicOrigin)
        if (certName !== undefined) payload.certName = certName
        return controlRequestJson('/api/mobile-access/remote/frp/vps/uninstall', { method: 'POST', body: JSON.stringify(payload) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
          .then(data => {
            const removal = data.vpsUninstall !== null && typeof data.vpsUninstall === 'object' ? data.vpsUninstall as Record<string, unknown> : {}
            vpsDeployStatus.textContent = removal.removed === true ? t('vpsUninstallSuccess') : t('vpsUninstallFailed', { error: t('vpsUninstallFailed', { error: 'unknown result' }) })
            remoteStatus.textContent = vpsDeployStatus.textContent
            renderRemote(data)
          }, error => {
            vpsDeployStatus.textContent = t('vpsUninstallFailed', { error: String(error) })
            remoteStatus.textContent = vpsDeployStatus.textContent
          })
          .finally(() => { remoteProviderBusy = false; loadRemote() })
      }, error => {
        vpsDeployStatus.textContent = t('vpsHostKeyFailed', { error: String(error) })
        remoteStatus.textContent = vpsDeployStatus.textContent
        remoteProviderBusy = false
        refreshVpsDeployButton()
        loadRemote()
      })
  })
  frpInstall.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const accepted = window.confirm(t('frpInstallConfirm', { size: frpDownloadSize }))
    if (!accepted) return
    remoteProviderBusy = true
    frpInstall.disabled = true
    frpInstall.textContent = t('downloading')
    remoteStatus.textContent = t('installingFrp')
    void controlRequestJson('/api/mobile-access/remote/frp/component/install', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteStatus.textContent = t('installFailed', { error: String(error) }) })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  })
  frpConfigure.addEventListener('click', () => {
    if (remoteProviderBusy || !frpInstalled) return
    const form = frpForm()
    const unchanged = frpConfigured && form.token === '' && form.serverAddress === configuredFrpServer
      && form.serverPort === configuredFrpPort && form.publicOrigin === configuredFrpOrigin
    if (!unchanged && !validFrpForm(form)) {
      remoteStatus.textContent = t('frpInputInvalid')
      return
    }
    remoteProviderBusy = true
    frpConfigure.disabled = true
    frpConfigure.setAttribute('aria-busy', 'true')
    frpConfigure.textContent = t('saving')
    const configure = unchanged
      ? Promise.resolve<Record<string, unknown>>({})
      : controlRequestJson('/api/mobile-access/remote/frp/configure', { method: 'POST', body: JSON.stringify(form) })
    void configure.then(() => {
      frpToken.value = ''
      remoteStatus.textContent = t('frpSavingConnecting')
      return controlRequestJson('/api/mobile-access/remote/control', { method: 'POST', body: JSON.stringify({ running: true }) })
    }).then(renderRemote, error => { remoteStatus.textContent = t('configureFailed', { error: String(error) }) })
      .finally(() => {
        remoteProviderBusy = false
        frpConfigure.setAttribute('aria-busy', 'false')
        frpConfigure.textContent = t('frpSaveConnect')
        loadRemote()
      })
  })
  frpPurge.addEventListener('click', () => {
    if (remoteProviderBusy || !window.confirm(t('purgeFrpConfirm'))) return
    remoteProviderBusy = true
    frpPurge.disabled = true
    remoteStatus.textContent = t('purgingFrp')
    void controlRequestJson('/api/mobile-access/remote/frp/component/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteStatus.textContent = t('purgeFailed', { error: String(error) }) })
      .finally(() => { remoteProviderBusy = false; frpPurge.disabled = false; loadRemote() })
  })
  remoteToggle.addEventListener('click', () => {
    remoteToggle.disabled = true
    void controlRequestJson('/api/mobile-access/remote/control', { method: 'POST', body: JSON.stringify({ running: !remoteRunning }) })
      .then(renderRemote, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
      .finally(loadRemote)
  })
  remoteLogin.addEventListener('click', () => {
    if (remoteLoginUrl !== '') window.open(remoteLoginUrl, '_blank', 'noopener,noreferrer')
  })
  const reconnectRemote = (): void => {
    if (remoteReconnectBusy) return
    remoteReconnectBusy = true
    remoteReconnect.disabled = true
    remoteSetup.disabled = true
    remoteSetupRetry.disabled = true
    remoteStatus.textContent = remoteProvider === 'cpolar' ? t('reconnectingCpolar') : remoteProvider === 'frp' ? t('reconnectingFrp') : t('reconnectingTailscale')
    void controlRequestJson('/api/mobile-access/remote/reconnect', { method: 'POST', body: '{}' })
      .then(renderRemote, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
      .finally(() => {
        remoteReconnectBusy = false
        remoteReconnect.disabled = false
        remoteSetup.disabled = remoteSetupUrl === ''
        remoteSetupRetry.disabled = false
      })
  }
  remoteReconnect.addEventListener('click', reconnectRemote)
  remoteSetupRetry.addEventListener('click', () => { remoteSetupPending = false; reconnectRemote() })
  remoteSetup.addEventListener('click', () => {
    if (remoteSetupUrl === '') return
    remoteSetupPending = true
    remoteSetupOpenedAt = Date.now()
    remoteStatus.textContent = t('setupOpened')
    window.open(remoteSetupUrl, '_blank', 'noopener,noreferrer')
  })
  const retryAfterSetup = (): void => {
    if (!remoteSetupPending || document.visibilityState === 'hidden' || Date.now() - remoteSetupOpenedAt < 800) return
    remoteSetupPending = false
    reconnectRemote()
  }
  window.addEventListener('focus', retryAfterSetup)
  document.addEventListener('visibilitychange', retryAfterSetup)
  remotePair.addEventListener('click', () => {
    remotePair.disabled = true
    void controlRequestJson('/api/mobile-access/remote/pairing/open', { method: 'POST', body: '{}' }).then(async data => {
      const pairUrl = typeof data.pairUrl === 'string' ? data.pairUrl : ''
      showQr(typeof data.qrSvg === 'string' ? data.qrSvg : '', remoteQr)
      if (pairUrl !== '') {
        try { await navigator.clipboard.writeText(pairUrl) } catch { /* QR remains the primary remote handoff. */ }
      }
      remoteStatus.textContent = t('remoteQrReady')
    }, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) }).finally(() => { remotePair.disabled = !remoteReady })
  })
  const renderRemoteDevices = (data: Record<string, unknown>): void => {
    const devices = Array.isArray(data.devices) ? data.devices as Record<string, unknown>[] : []
    remoteDevicePanel.replaceChildren()
    if (devices.length === 0) {
      const empty = element('p', 'dsh-mobile-control__device-empty'); empty.textContent = t('noRemoteDevices'); remoteDevicePanel.append(empty); return
    }
    for (const device of devices) {
      const row = element('div', 'dsh-mobile-control__device')
      const label = element('span', 'dsh-mobile-control__device-label'); label.textContent = typeof device.label === 'string' ? device.label : t('device')
      const meta = element('span', 'dsh-mobile-control__device-meta'); meta.textContent = t('expires', { time: formatTime(device.expiresAt) })
      const revoke = element('button', 'dsh-mobile-control__device-revoke'); revoke.type = 'button'; revoke.textContent = t('revoke')
      const id = typeof device.id === 'string' ? device.id : ''
      revoke.addEventListener('click', () => {
        void controlRequestJson('/api/mobile-access/remote/devices/revoke', { method: 'POST', body: JSON.stringify({ deviceId: id }) })
          .then(loadRemoteDevices, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
      })
      row.append(label, meta, revoke); remoteDevicePanel.append(row)
    }
  }
  const loadRemoteDevices = (): void => {
    void controlRequestJson('/api/mobile-access/remote/devices').then(renderRemoteDevices, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
  }
  remoteDevices.addEventListener('click', () => {
    const show = remoteDevicePanel.hidden
    remoteDevicePanel.hidden = !show
    if (show) loadRemoteDevices()
  })
  remoteReset.addEventListener('click', () => {
    const prompt = remoteProvider === 'cpolar'
      ? t('resetCpolarConfirm')
      : remoteProvider === 'frp' ? t('resetFrpConfirm') : t('resetTailscaleConfirm')
    if (!window.confirm(prompt)) return
    void controlRequestJson('/api/mobile-access/remote/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(renderRemote, error => { remoteStatus.textContent = t('requestFailed', { error: String(error) }) })
  })
  const renderDiagnostics = (data: Record<string, unknown>): void => {
    const entries = [...diagnosticEntriesForRender(data)]
    const overall = diagnosticOverallForChecks(data.overall, entries.map(entry => entry.status))
    diagnosticsSummary.className = `dsh-mobile-control__diagnostic-summary is-${overall}`
    diagnosticsSummaryTitle.textContent = overall === 'ok' ? t('diagnosticsComplete') : overall === 'attention' ? t('diagnosticsAttention') : t('diagnosticsProblem')
    diagnosticsSummaryText.textContent = locale === 'zh' && data.overall === overall && typeof data.summary === 'string' ? data.summary : t('diagnosticsCompleteFallback')
    diagnosticsChecks.replaceChildren()
    const statusLabels: Record<string, string> = { ok: t('diagnosticStatusOk'), warning: t('diagnosticStatusWarning'), error: t('diagnosticStatusError'), info: t('diagnosticStatusInfo') }
    const diagnosticLabelKeys: Record<string, string> = {
      versions: 'diagnosticLabelVersions', network: 'diagnosticLabelNetwork', lan: 'diagnosticLabelLan',
      firewall: 'diagnosticLabelFirewall', remote: 'diagnosticLabelRemote', 'phone-network': 'diagnosticLabelPhone',
    }
    const statusOf = (entry: Record<string, unknown>): 'ok' | 'warning' | 'error' | 'info' => normalizeDiagnosticStatus(entry.status)
    const localizedEntryCopy = (entry: Record<string, unknown>): { readonly detail: string; readonly action: string } => {
      const serverCopy = diagnosticServerCopy(entry)
      const reason = typeof entry.reason === 'string' ? entry.reason : ''
      const catalog = DIAGNOSTIC_REASON_MESSAGES[locale] as Readonly<Record<string, readonly [string, string]>>
      const templates = catalog[reason]
      if (templates === undefined) return serverCopy
      const facts = entry.facts !== null && typeof entry.facts === 'object' ? entry.facts as Record<string, unknown> : {}
      const values: Record<string, string> = {
        provider: facts.provider === 'tailscale' || facts.provider === 'cpolar' || facts.provider === 'frp' ? facts.provider : '',
        latencyMs: typeof facts.latencyMs === 'number' && Number.isFinite(facts.latencyMs) ? new Intl.NumberFormat(localeTag).format(facts.latencyMs) : '',
        interfaceName: typeof facts.interfaceName === 'string' ? facts.interfaceName : '',
        endpointSuffix: typeof facts.endpointSuffix === 'string' ? facts.endpointSuffix : '',
        controllerCode: typeof facts.controllerCode === 'string' ? facts.controllerCode : '',
      }
      const interpolate = (template: string): string => template.replace(/\{(\w+)\}/gu, (_match, key: string) => values[key] ?? '')
      let detail = interpolate(templates[0])
      let action = interpolate(templates[1])
      if (reason === 'versions-current') {
        const versions = data.versions !== null && typeof data.versions === 'object' ? data.versions as Record<string, unknown> : {}
        if ([versions.plugin, versions.dsh, versions.minimumAndroidApp].every(value => typeof value === 'string')) {
          detail += ` plugin ${String(versions.plugin)}, DSH ${String(versions.dsh)}, Android ${String(versions.minimumAndroidApp)}.`
        }
      }
      if (reason === 'remote-controller-error') {
        const controllerActionKeys: Readonly<Record<string, string>> = {
          component_missing: 'remoteUnavailableTailscale', funnel_permission_required: 'funnelPermission', funnel_https_required: 'funnelHttps', funnel_start_failed: 'funnelStart', funnel_start_timeout: 'funnelTimeout', tailscale_dns_missing: 'tailscaleDnsMissing',
          sidecar_launch_failed: 'remoteUnavailableTailscale', sidecar_stopped: 'controlChannelFailed', sidecar_exited: 'controlChannelFailed', control_channel_failed: 'controlChannelFailed',
          cpolar_component_missing: 'cpolarMissing', cpolar_component_invalid: 'cpolarInvalid', cpolar_config_missing: 'cpolarConfigMissing', cpolar_config_invalid: 'cpolarConfigInvalid', cpolar_start_timeout: 'cpolarTimeout', cpolar_stopped: 'cpolarStopped', cpolar_exited: 'cpolarExited',
          frp_component_missing: 'frpMissing', frp_component_invalid: 'frpInvalid', frp_config_missing: 'frpConfigMissing', frp_config_verify_failed: 'frpConfigVerifyFailed', frp_vhost_publicly_reachable: 'frpVhostPublic', frp_vhost_probe_failed: 'frpVhostProbeFailed', frp_launch_failed: 'frpLaunchFailed', frp_start_timeout: 'frpTimeout', frp_discovery_mismatch: 'frpDiscoveryMismatch', frp_discovery_invalid: 'frpDiscoveryInvalid', frp_stopped: 'frpStopped', frp_exited: 'frpExited', gateway_start_failed: 'gatewayStartFailed',
        }
        const actionKey = controllerActionKeys[values.controllerCode ?? '']
        if (actionKey !== undefined) action = t(actionKey)
      }
      return { detail, action }
    }
    const appendGroup = (label: string, groupEntries: Record<string, unknown>[]): void => {
      if (groupEntries.length === 0) return
      const group = element('section', 'dsh-mobile-control__diagnostic-group')
      const groupHeader = element('header', 'dsh-mobile-control__diagnostic-group-header')
      const groupTitle = element('h3'); groupTitle.textContent = label
      const groupCount = element('span'); groupCount.textContent = t('diagnosticItems', { count: groupEntries.length })
      const list = element('div', 'dsh-mobile-control__diagnostic-list'); list.setAttribute('role', 'list')
      groupHeader.append(groupTitle, groupCount)
      for (const entry of groupEntries) {
        const state = statusOf(entry)
        const row = element('section', `dsh-mobile-control__diagnostic-check is-${state}`); row.setAttribute('role', 'listitem')
        const marker = element('span', 'dsh-mobile-control__diagnostic-marker'); marker.setAttribute('aria-hidden', 'true')
        const rowBody = element('div', 'dsh-mobile-control__diagnostic-check-body')
        const rowHeader = element('div', 'dsh-mobile-control__diagnostic-check-header')
        const labelKey = typeof entry.id === 'string' ? diagnosticLabelKeys[entry.id] : undefined
        const rowTitle = element('strong'); rowTitle.textContent = locale !== 'zh' && labelKey !== undefined ? t(labelKey) : typeof entry.label === 'string' ? entry.label : t('diagnosticCheck')
        const badge = element('span', 'dsh-mobile-control__diagnostic-badge'); badge.textContent = statusLabels[state]!
        const localizedCopy = localizedEntryCopy(entry)
        const detail = element('p'); detail.textContent = localizedCopy.detail
        rowHeader.append(rowTitle, badge); rowBody.append(rowHeader, detail)
        if (localizedCopy.action !== '') {
          const action = element('p', 'dsh-mobile-control__diagnostic-action')
          const actionLabel = element('span'); actionLabel.textContent = t('diagnosticAction')
          action.append(actionLabel, document.createTextNode(localizedCopy.action)); rowBody.append(action)
        }
        row.append(marker, rowBody); list.append(row)
      }
      group.append(groupHeader, list); diagnosticsChecks.append(group)
    }
    const issues = entries.filter(entry => statusOf(entry) === 'error' || statusOf(entry) === 'warning')
    const otherChecks = entries.filter(entry => statusOf(entry) !== 'error' && statusOf(entry) !== 'warning')
    appendGroup(t('diagnosticNeedsAction'), issues)
    appendGroup(issues.length === 0 ? t('diagnosticDetails') : t('diagnosticOther'), otherChecks)
    diagnosticsSummaryMeta.textContent = issues.length === 0
      ? t('diagnosticNoBlockers', { count: entries.length })
      : t('diagnosticNeedsCount', { count: entries.length, issues: issues.length })
    diagnosticsChecks.hidden = entries.length === 0
    const reportCopy = LOCALIZED_DIAGNOSTIC_COPY[locale]
    const generatedAt = typeof data.generatedAt === 'number' ? new Date(data.generatedAt).toLocaleString(localeTag) : new Date().toLocaleString(localeTag)
    const lines = entries.map(entry => {
      const state = statusOf(entry)
      const labelKey = typeof entry.id === 'string' ? diagnosticLabelKeys[entry.id] : undefined
      const label = labelKey === undefined && typeof entry.label === 'string' ? entry.label : labelKey === undefined ? t('diagnosticCheck') : t(labelKey)
      const localizedCopy = localizedEntryCopy(entry)
      return `[${statusLabels[state]!}] ${label}: ${localizedCopy.detail}${localizedCopy.action === '' ? '' : ` ${localizedCopy.action}`}`
    })
    copiedDiagnosticReport = [reportCopy.reportTitle, `${reportCopy.generated}: ${generatedAt}`, ...lines].join('\n')
    diagnosticsReport.textContent = copiedDiagnosticReport
    diagnosticsDetails.hidden = copiedDiagnosticReport === ''
    diagnosticsCopy.disabled = copiedDiagnosticReport === ''
    diagnosticsCopy.hidden = copiedDiagnosticReport === ''
    diagnosticsToolbar.classList.toggle('has-report', copiedDiagnosticReport !== '')
  }
  const showDiagnosticsFailure = (error: unknown): void => {
    diagnosticsSummary.className = 'dsh-mobile-control__diagnostic-summary is-error'
    diagnosticsSummaryTitle.textContent = t('diagnosticsIncomplete')
    diagnosticsSummaryText.textContent = t('diagnosticsReadFailed', { error: String(error) })
    diagnosticsSummaryMeta.textContent = t('diagnosticsUnavailable')
    diagnosticsChecks.replaceChildren()
    diagnosticsChecks.hidden = true
    copiedDiagnosticReport = ''
    diagnosticsReport.textContent = ''
    diagnosticsDetails.hidden = true
    diagnosticsCopy.disabled = true
    diagnosticsCopy.hidden = true
    diagnosticsToolbar.classList.remove('has-report')
  }
  const loadDiagnostics = (): void => {
    if (diagnosticsBusy) return
    diagnosticsBusy = true
    diagnosticsRun.disabled = true
    diagnosticsRun.setAttribute('aria-busy', 'true')
    diagnosticsRun.textContent = t('diagnosticsChecking')
    diagnosticsSummary.className = 'dsh-mobile-control__diagnostic-summary is-running'
    diagnosticsSummaryTitle.textContent = t('diagnosticsCheckingTitle')
    diagnosticsSummaryText.textContent = t('diagnosticsCheckingText')
    diagnosticsSummaryMeta.textContent = t('diagnosticsRunningMeta')
    diagnosticsFeedback.hidden = true
    diagnosticsChecks.classList.add('is-refreshing')
    diagnosticsChecks.setAttribute('aria-busy', 'true')
    void controlRequestJson('/api/mobile-access/diagnostics').then(
      data => { renderDiagnosticPayloadSafely(data, renderDiagnostics, showDiagnosticsFailure) },
      showDiagnosticsFailure,
    ).finally(() => {
      diagnosticsBusy = false
      diagnosticsRun.disabled = false
      diagnosticsRun.setAttribute('aria-busy', 'false')
      diagnosticsRun.textContent = t('diagnosticsRetry')
      diagnosticsChecks.classList.remove('is-refreshing')
      diagnosticsChecks.setAttribute('aria-busy', 'false')
    })
  }
  diagnosticsEntry.addEventListener('click', () => {
    if (!diagnosticsView.hidden) { selectView(previousAccessView); return }
    selectView('diagnostics'); loadDiagnostics()
  })
  diagnosticsRun.addEventListener('click', loadDiagnostics)
  updatePlugin.addEventListener('click', () => {
    if (!pluginUpdateAvailable || pluginLatestVersion === '') return
    updatePlugin.disabled = true
    updatePlugin.textContent = t('updatingPlugin')
    releaseNotice.hidden = true
    releaseNotice.classList.remove('is-error')
    void controlRequestJson('/api/mobile-access/release/update', { method: 'POST', body: '{}' }, LONG_CONTROL_REQUEST_TIMEOUT_MS).then(data => {
      const installedVersion = releaseVersion(data.installedVersion) ?? pluginLatestVersion
      pluginUpdateAvailable = false
      updatePlugin.hidden = true
      releaseNotice.textContent = t('pluginUpdatedRestart', { version: installedVersion })
      releaseNotice.hidden = false
    }, error => {
      updatePlugin.textContent = t('updatePlugin')
      releaseNotice.textContent = t('pluginUpdateFailed', { error: String(error) })
      releaseNotice.classList.add('is-error')
      releaseNotice.hidden = false
    }).finally(() => { updatePlugin.disabled = false })
  })
  diagnosticsCopy.addEventListener('click', () => {
    if (copiedDiagnosticReport === '') return
    void navigator.clipboard.writeText(copiedDiagnosticReport).then(() => {
      diagnosticsFeedback.textContent = t('diagnosticsCopied')
      diagnosticsFeedback.hidden = false
    }, () => {
      diagnosticsDetails.open = true
      diagnosticsFeedback.textContent = t('diagnosticsCopyManual')
      diagnosticsFeedback.hidden = false
    })
  })
  pair.addEventListener('click', () => { pair.disabled = true; openPairing('key') })
  linkPair.addEventListener('click', () => { linkPair.disabled = true; openPairing('link') })
  close.addEventListener('click', () => { setOpen(false) })
  const dismiss = (event: PointerEvent): void => {
    if (panel.hidden || !(event.target instanceof Node)) return
    if (!providerInfo.contains(event.target)) {
      providerInfoPinned = false
      providerInfoHovered = false
      syncProviderInfo()
    }
    if (!panel.contains(event.target) && !document.querySelector('.dsh-mobile-control__trigger')?.contains(event.target)) setOpen(false)
  }
  document.addEventListener('pointerdown', dismiss)
  void controlRequestJson('/api/mobile-access/release').then(renderRelease, () => {})
  void controlRequestJson('/api/mobile-access/lan/control').then(render, error => { status.textContent = t('requestFailed', { error: String(error) }) })
  loadRemote()
  const remotePoll = window.setInterval(() => { if (!panel.hidden && !remoteView.hidden) loadRemote() }, 1_500)
  return { remove: () => { lifecycle.abort(); window.clearInterval(remotePoll); window.removeEventListener('focus', retryAfterSetup); document.removeEventListener('visibilitychange', retryAfterSetup); document.removeEventListener('pointerdown', dismiss); root.remove() }, toggle: () => { setOpen(panel.hidden !== false) }, isOpen: () => !panel.hidden }
}

function mobileRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const target = new URL(path, location.href)
  if (target.origin !== location.origin) throw new TypeError('mobile extension requests must stay on the DSH origin')
  const headers = new Headers(init.headers)
  const method = (init.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('dsh_ma_csrf='))?.slice(12)
    if (csrf !== undefined) headers.set('x-dsh-mobile-csrf', csrf)
  }
  return fetch(target, { ...init, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
}

export interface CombinedClientSignal {
  readonly signal: AbortSignal
  readonly cleanup: () => void
}

/** Combine extension and caller abort lifetimes and expose deterministic listener cleanup. */
export function combineClientSignalLifetime(first: AbortSignal, second: AbortSignal): CombinedClientSignal {
  if (first.aborted || second.aborted) {
    const aborted = new AbortController()
    aborted.abort(first.aborted ? first.reason : second.reason)
    return { signal: aborted.signal, cleanup: () => undefined }
  }
  const controller = new AbortController()
  const cleanup = (): void => {
    first.removeEventListener('abort', abortFirst)
    second.removeEventListener('abort', abortSecond)
  }
  const abortFirst = (): void => { cleanup(); controller.abort(first.reason) }
  const abortSecond = (): void => { cleanup(); controller.abort(second.reason) }
  first.addEventListener('abort', abortFirst, { once: true })
  second.addEventListener('abort', abortSecond, { once: true })
  return { signal: controller.signal, cleanup }
}

/** Combine extension and caller abort lifetimes on WebViews without AbortSignal.any. */
export function combineClientSignals(first: AbortSignal, second: AbortSignal): AbortSignal {
  return combineClientSignalLifetime(first, second).signal
}

/** Keep a combined request lifetime until a streamed response is consumed or cancelled. */
export function bindClientResponseLifetime(response: Response, cleanup: () => void): Response {
  if (response.body === null) {
    cleanup()
    return response
  }
  const reader = response.body.getReader()
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    cleanup()
  }
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read()
        if (result.done) {
          release()
          controller.close()
        } else controller.enqueue(result.value)
      } catch (error) {
        release()
        controller.error(error)
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason) } finally { release() }
    },
  })
  try {
    const retained = new Response(body, { headers: response.headers, status: response.status, statusText: response.statusText })
    Object.defineProperties(retained, {
      redirected: { configurable: true, value: response.redirected },
      type: { configurable: true, value: response.type },
      url: { configurable: true, value: response.url },
    })
    return retained
  } catch (error) {
    void reader.cancel(error)
    release()
    throw error
  }
}

/** Dispose an old UI when its replacement Host generation cannot be activated. */
export function failClosedExtensionGenerationReplacement(
  hasActive: boolean,
  activeGeneration: string | undefined,
  replacementGeneration: string | undefined,
  dispose: () => void,
): boolean {
  if (!hasActive || activeGeneration === replacementGeneration) return false
  dispose()
  return true
}

/** Resolve one SDK route and prove its normalized path remains in the current extension namespace. */
export function extensionRouteUrl(id: string, path: string, baseUrl: string): URL {
  const rawPathname = path.split(/[?#]/u, 1)[0] ?? ''
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id) || !path.startsWith('/') || path.startsWith('//')
    || rawPathname.includes('\\') || rawPathname.includes('\0') || /%(?:2f|5c)/iu.test(rawPathname)) {
    throw new TypeError('extension routes must be relative')
  }
  const origin = new URL(baseUrl).origin
  const prefix = `/mobile-access/extensions/${id}/routes`
  let target: URL
  try { target = new URL(`${prefix}${path}`, origin) } catch { throw new TypeError('extension routes must be relative') }
  let decodedPathname: string
  try { decodedPathname = decodeURIComponent(target.pathname) } catch { throw new TypeError('extension routes must be relative') }
  if (target.origin !== origin || target.hash !== '' || decodedPathname.includes('\\')
    || decodedPathname !== prefix && !decodedPathname.startsWith(`${prefix}/`)) {
    throw new TypeError('extension routes must be relative')
  }
  const relative = decodedPathname.slice(prefix.length)
  if (relative.split('/').some(part => part === '.' || part === '..')) throw new TypeError('extension routes must be relative')
  return target
}

/** Resolve one generation-pinned static asset URL in the current extension namespace. */
export function extensionAssetUrl(id: string, generation: string | undefined, path: string, baseUrl: string): URL {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id) || generation !== undefined && !/^[a-f\d]{64}$/u.test(generation)) {
    throw new TypeError('extension asset path is invalid')
  }
  const normalized = path.replaceAll('\\', '/')
  if (normalized.length === 0 || normalized.startsWith('/') || normalized.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new TypeError('extension asset path is invalid')
  }
  const target = new URL(`/mobile-access/extensions/${id}/assets/${normalized.split('/').map(encodeURIComponent).join('/')}`, new URL(baseUrl).origin)
  if (generation !== undefined) target.searchParams.set('generation', generation)
  return target
}

/** Add the immutable Host generation selected for one activated mobile UI. */
export function extensionGenerationHeaders(generation: string | undefined, headers?: HeadersInit): Headers {
  const result = new Headers(headers)
  if (generation !== undefined) result.set('x-dsh-mobile-extension-generation', generation)
  return result
}

export function registerUniqueDisposable<T extends { readonly dispose: () => void }>(
  entries: Map<string, T>,
  claimedIds: Set<string>,
  id: string,
  mount: () => T,
): () => void {
  if (claimedIds.has(id)) throw new Error(`duplicate lifecycle id: ${id}`)
  claimedIds.add(id)
  let mounted: T
  try { mounted = mount() } catch (error) { claimedIds.delete(id); throw error }
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    mounted.dispose()
  }
  const entry = { ...mounted, dispose } as T
  entries.set(id, entry)
  return () => {
    if (entries.get(id) === entry) { entries.delete(id); claimedIds.delete(id) }
    dispose()
  }
}

/** Dispose resources omitted by a successfully fetched authoritative manifest. */
export function reconcileRemovedExtensions(currentIds: Iterable<string>, seen: ReadonlySet<string>, dispose: (id: string) => void): void {
  for (const id of new Set(currentIds)) if (!seen.has(id)) dispose(id)
}

/** Reconcile managed resources against one validated authoritative id set. */
export function publishAuthoritativeExtensionIds(
  authoritativeIds: Set<string>,
  seen: ReadonlySet<string>,
  managedIdSources: readonly Iterable<string>[],
  dispose: (id: string) => void,
): void {
  const current = new Set(authoritativeIds)
  for (const source of managedIdSources) for (const id of source) current.add(id)
  reconcileRemovedExtensions(current, seen, dispose)
  authoritativeIds.clear()
  for (const id of seen) authoritativeIds.add(id)
}

interface MobileExtensionManifestEntry {
  readonly id: string
  readonly generation?: string
  readonly scriptUrl?: string
  readonly styleUrl?: string
  readonly assetsUrl?: string
}
interface MobileExtensionManifest {
  readonly extensions: readonly MobileExtensionManifestEntry[]
  readonly legacy: { readonly scriptRevision: string; readonly styleRevision: string }
}

function validManifestResourceUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.includes('://')
    && !value.split('/').some(part => part === '..' || part === '.')
}

/** Validate the manifest before treating it as authoritative state. */
export function parseMobileExtensionManifest(payload: unknown): MobileExtensionManifest | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const candidate = payload as { protocol?: unknown; extensions?: unknown; legacy?: unknown }
  if (candidate.protocol !== 1 || !Array.isArray(candidate.extensions) || typeof candidate.legacy !== 'object' || candidate.legacy === null) return undefined
  const legacy = candidate.legacy as { scriptRevision?: unknown; styleRevision?: unknown }
  if (typeof legacy.scriptRevision !== 'string' || typeof legacy.styleRevision !== 'string') return undefined
  const ids = new Set<string>()
  const extensions: MobileExtensionManifestEntry[] = []
  for (const value of candidate.extensions) {
    if (typeof value !== 'object' || value === null) return undefined
    const entry = value as { id?: unknown; generation?: unknown; scriptUrl?: unknown; styleUrl?: unknown; assetsUrl?: unknown }
    if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(entry.id) || ids.has(entry.id)) return undefined
    if (entry.generation !== undefined && (typeof entry.generation !== 'string' || !/^[a-f\d]{64}$/u.test(entry.generation))) return undefined
    if (entry.scriptUrl !== undefined && !validManifestResourceUrl(entry.scriptUrl)) return undefined
    if (entry.styleUrl !== undefined && !validManifestResourceUrl(entry.styleUrl)) return undefined
    if (entry.assetsUrl !== undefined && !validManifestResourceUrl(entry.assetsUrl)) return undefined
    ids.add(entry.id)
    extensions.push({
      id: entry.id,
      ...(entry.generation === undefined ? {} : { generation: entry.generation }),
      ...(entry.scriptUrl === undefined ? {} : { scriptUrl: entry.scriptUrl }),
      ...(entry.styleUrl === undefined ? {} : { styleUrl: entry.styleUrl }),
      ...(entry.assetsUrl === undefined ? {} : { assetsUrl: entry.assetsUrl }),
    })
  }
  return { extensions, legacy: { scriptRevision: legacy.scriptRevision, styleRevision: legacy.styleRevision } }
}

/** A missing manifest is authoritative before optional legacy resources finish refreshing. */
export async function handleMissingExtensionManifest(
  clearManifestResources: () => void,
  refreshLegacyResources: () => Promise<readonly boolean[]>,
  signal: AbortSignal,
): Promise<boolean> {
  clearManifestResources()
  const results = await refreshLegacyResources()
  return !signal.aborted && results.every(Boolean)
}

interface LifecycleSchedulerRuntime {
  readonly document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'>
}

export interface LifecycleRefreshController {
  (): void
  refresh(): void
}

function refreshAborted(signal: AbortSignal): boolean { return signal.aborted }

/** Run one coalesced refresh cycle, slowing down when the page is hidden. */
export function startLifecycleRefreshScheduler(
  refresh: (signal: AbortSignal) => void | Promise<void>,
  options: { readonly visibleIntervalMs?: number; readonly hiddenIntervalMs?: number; readonly cycleTimeoutMs?: number } = {},
  runtime: LifecycleSchedulerRuntime = { document, window },
): LifecycleRefreshController {
  const visibleIntervalMs = options.visibleIntervalMs ?? 45_000
  const hiddenIntervalMs = options.hiddenIntervalMs ?? 300_000
  const cycleTimeoutMs = options.cycleTimeoutMs ?? 30_000
  let timer: number | undefined
  let cycleTimer: number | undefined
  let running = false
  let queued = false
  let disposed = false
  let controller: AbortController | undefined
  const clearTimer = (): void => {
    if (timer === undefined) return
    runtime.window.clearTimeout(timer)
    timer = undefined
  }
  const clearCycleTimer = (): void => {
    if (cycleTimer === undefined) return
    runtime.window.clearTimeout(cycleTimer)
    cycleTimer = undefined
  }
  const schedule = (): void => {
    if (disposed) return
    clearTimer()
    const delay = runtime.document.visibilityState === 'hidden' ? hiddenIntervalMs : visibleIntervalMs
    timer = runtime.window.setTimeout(run, delay)
  }
  const run = (): void => {
    if (disposed) return
    clearTimer()
    if (running) { queued = true; return }
    running = true
    const current = new AbortController()
    controller = current
    const refreshPromise = Promise.resolve().then(() => refresh(current.signal))
    const timeoutPromise = new Promise<void>(resolve => {
      cycleTimer = runtime.window.setTimeout(() => {
        cycleTimer = undefined
        current.abort(new DOMException('mobile extension refresh timed out', 'TimeoutError'))
        resolve()
      }, cycleTimeoutMs)
    })
    void Promise.race([refreshPromise, timeoutPromise]).catch(() => { /* Keep the last good resources during reconnects. */ }).finally(() => {
      clearCycleTimer()
      if (controller === current) controller = undefined
      running = false
      if (disposed) return
      if (queued) { queued = false; run() } else schedule()
    })
    void refreshPromise.catch(() => { /* A timed-out refresh may reject after the scheduler has moved on. */ })
  }
  const onVisibilityChange = (): void => {
    if (runtime.document.visibilityState === 'hidden') schedule()
    else run()
  }
  runtime.document.addEventListener('visibilitychange', onVisibilityChange)
  runtime.window.addEventListener('focus', run)
  runtime.window.addEventListener('online', run)
  run()
  const stop = (): void => {
    disposed = true
    queued = false
    controller?.abort()
    controller = undefined
    clearCycleTimer()
    clearTimer()
    runtime.document.removeEventListener('visibilitychange', onVisibilityChange)
    runtime.window.removeEventListener('focus', run)
    runtime.window.removeEventListener('online', run)
  }
  return Object.assign(stop, { refresh: run })
}

interface ExtensionEventRuntime {
  readonly window: Pick<Window, 'addEventListener' | 'removeEventListener' | 'setTimeout' | 'clearTimeout'>
  readonly create: (url: string) => Pick<EventSource, 'close' | 'onopen' | 'onerror' | 'addEventListener'>
}

/** Maintain one authenticated same-origin extension event stream with bounded reconnect backoff. */
export function startExtensionChangeStream(
  changed: () => void,
  runtime: ExtensionEventRuntime = {
    window,
    create: url => new EventSource(url, { withCredentials: true }),
  },
): () => void {
  let source: ReturnType<ExtensionEventRuntime['create']> | undefined
  let timer: number | undefined
  let disposed = false
  let retryMs = 1_000
  const clearTimer = (): void => {
    if (timer === undefined) return
    runtime.window.clearTimeout(timer)
    timer = undefined
  }
  const connect = (): void => {
    if (disposed || source !== undefined) return
    clearTimer()
    const next = runtime.create('/mobile-access/extensions/events')
    source = next
    next.onopen = () => { retryMs = 1_000 }
    next.addEventListener('extensions-changed', changed)
    next.onerror = () => {
      if (source !== next) return
      next.close()
      source = undefined
      if (disposed) return
      const delay = retryMs
      retryMs = Math.min(30_000, retryMs * 2)
      timer = runtime.window.setTimeout(connect, delay)
    }
  }
  const reconnectNow = (): void => {
    if (disposed) return
    source?.close()
    source = undefined
    retryMs = 1_000
    connect()
  }
  runtime.window.addEventListener('online', reconnectNow)
  connect()
  return () => {
    disposed = true
    clearTimer()
    source?.close()
    source = undefined
    runtime.window.removeEventListener('online', reconnectNow)
  }
}

export interface ActivationWork<T> {
  readonly result: Promise<T>
  readonly cancel: () => void
  readonly commit?: (value: T) => void
  readonly dispose: (value: T) => void
}

interface PendingActivation<T> {
  readonly key: object
  readonly generation: number
  readonly controller: AbortController
  readonly cancel: () => void
  readonly completion: Promise<boolean>
}

/** Keep at most one activation in flight per id and commit only its latest generation. */
export class PerIdActivationLifecycle<T> {
  private readonly active = new Map<string, { readonly value: T; readonly dispose: () => void }>()
  private readonly pending = new Map<string, PendingActivation<T>>()
  private readonly generations = new Map<string, number>()
  private disposed = false

  hasActive(id: string): boolean { return this.active.has(id) }
  getActive(id: string): T | undefined { return this.active.get(id)?.value }
  pendingCount(): number { return this.pending.size }

  async activate(
    id: string,
    key: object,
    cycleSignal: AbortSignal | undefined,
    create: (controller: AbortController, generation: number) => ActivationWork<T>,
  ): Promise<boolean> {
    if (this.disposed || cycleSignal?.aborted === true) return false
    const existing = this.pending.get(id)
    if (existing !== undefined) {
      if (existing.key === key && !existing.controller.signal.aborted) return this.waitFor(existing, cycleSignal)
      existing.cancel()
    }
    const generation = (this.generations.get(id) ?? 0) + 1
    this.generations.set(id, generation)
    const controller = new AbortController()
    let work: ActivationWork<T>
    try { work = create(controller, generation) } catch {
      controller.abort(new DOMException('mobile extension activation failed to start', 'AbortError'))
      return false
    }
    let cancelled = false
    let pending = {} as PendingActivation<T>
    const cancel = (): void => {
      if (cancelled) return
      cancelled = true
      if (this.pending.get(id) === pending) this.pending.delete(id)
      if (this.generations.get(id) === generation) this.generations.set(id, generation + 1)
      controller.abort(new DOMException('mobile extension activation cancelled', 'AbortError'))
      work.cancel()
    }
    const completion = Promise.resolve(work.result).then(value => {
      const current = this.pending.get(id)
      const canCommit = !this.disposed && current === pending && current.generation === this.generations.get(id)
        && !controller.signal.aborted
      if (!canCommit) {
        try { work.dispose(value) } catch { /* A stale extension disposer must not break lifecycle cleanup. */ }
        return false
      }
      try { work.commit?.(value) } catch {
        try { work.dispose(value) } catch { /* Keep the previous active extension intact. */ }
        return false
      }
      const previous = this.active.get(id)
      let valueDisposed = false
      const dispose = (): void => {
        if (valueDisposed) return
        valueDisposed = true
        controller.abort(new DOMException('mobile extension deactivated', 'AbortError'))
        try { work.dispose(value) } catch { /* Disposers are isolated per extension. */ }
      }
      this.active.set(id, { value, dispose })
      previous?.dispose()
      return true
    }, () => {
      cancel()
      return false
    }).finally(() => {
      if (this.pending.get(id) === pending) this.pending.delete(id)
    })
    Object.assign(pending, { key, generation, controller, cancel, completion })
    this.pending.set(id, pending)
    return this.waitFor(pending, cycleSignal)
  }

  remove(id: string): void {
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1)
    this.active.get(id)?.dispose()
    this.active.delete(id)
    this.pending.get(id)?.cancel()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const current of this.active.values()) current.dispose()
    this.active.clear()
    for (const current of this.pending.values()) current.cancel()
  }

  private waitFor(pending: PendingActivation<T>, signal: AbortSignal | undefined): Promise<boolean> {
    if (signal === undefined) return pending.completion
    if (signal.aborted) { pending.cancel(); return Promise.resolve(false) }
    return new Promise<boolean>(resolve => {
      let settled = false
      const finish = (value: boolean): void => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      const onAbort = (): void => { pending.cancel(); finish(false) }
      signal.addEventListener('abort', onAbort, { once: true })
      void pending.completion.then(finish)
    })
  }
}

function installCustomAssets(): () => void {
  const legacyStyle = element('style'); legacyStyle.dataset.plugin = 'dsh-mobile-custom'; document.head.append(legacyStyle)
  const legacyCssState = { etag: '', modified: '' }
  const previous = window.dshMobile
  let legacyMount: MobileExtensionMount | undefined = queuedLegacyMount
  let legacySource = ''
  let legacyRoot: HTMLElement | undefined
  let legacyDispose: (() => void) | undefined
  const definitions = new Map<string, MobileClientDefinition>()
  type ExtensionSurfaceEntry = { readonly dispose: () => void; readonly container: HTMLElement; readonly host: () => HTMLElement }
  type ActiveExtension = { readonly controller: AbortController; readonly surfaces: Map<string, ExtensionSurfaceEntry>; readonly cleanup?: () => void }
  const activations = new PerIdActivationLifecycle<ActiveExtension>()
  const styleNodes = new Map<string, HTMLStyleElement>()
  const styleEtags = new Map<string, string>()
  const scriptDigests = new Map<string, string>()
  const activeHostGenerations = new Map<string, string | undefined>()
  const activationKeys = new Map<string, { readonly definition: MobileClientDefinition; readonly generation?: string }>()
  const manifestExtensionIds = new Set<string>()
  const managedDefinitionIds = new Set<string>()
  let manifestEtag = ''
  let disposed = false
  let expectedDefinitionId: string | undefined
  const SURFACE_HOST_STYLES: Readonly<Record<string, string>> = {
    'sidebar-action': 'position:fixed;z-index:1100;top:calc(env(safe-area-inset-top) + 8px);left:8px;display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'header-action': 'position:fixed;z-index:1100;top:calc(env(safe-area-inset-top) + 8px);right:8px;display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'composer-dock': 'position:fixed;z-index:1100;bottom:calc(env(safe-area-inset-bottom) + 8px);left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;pointer-events:none',
    'settings-section': 'position:fixed;z-index:1100;inset:auto 8px calc(env(safe-area-inset-bottom) + 72px) 8px;max-height:40vh;overflow:auto;pointer-events:none',
  }
  const surfaceHost = (placement: string): HTMLElement | undefined => {
    const existing = document.querySelector<HTMLElement>(`[data-dsh-mobile-surface-host="${placement}"]`)
    if (existing !== null) return existing
    const style = SURFACE_HOST_STYLES[placement]
    if (style === undefined) return undefined
    const host = element('div'); host.dataset.dshMobileSurfaceHost = placement; host.style.cssText = style
    document.body.append(host); return host
  }
  const shellLayer = (): HTMLElement => {
    const existing = document.querySelector<HTMLElement>('[data-dsh-mobile-extension-layer]')
    if (existing !== null) return existing
    const layer = element('div'); layer.dataset.dshMobileExtensionLayer = 'true'; layer.style.cssText = 'position:fixed;inset:0;z-index:1200;pointer-events:none;overflow:hidden'
    document.body.append(layer); return layer
  }
  const toast = (message: string): void => {
    const node = element('div'); node.textContent = message; node.style.cssText = 'position:absolute;top:16px;left:50%;transform:translateX(-50%);padding:9px 14px;border-radius:999px;background:#1f2937;color:white;font:14px system-ui;pointer-events:auto;box-shadow:0 8px 24px #0003'
    shellLayer().append(node); window.setTimeout(() => node.remove(), 2600)
  }
  const materializeNativeFile = (value: unknown): unknown => {
    if (typeof value !== 'object' || value === null || !('base64' in value) || !('name' in value)) return value
    const candidate = value as { base64?: unknown; name?: unknown; type?: unknown }
    if (typeof candidate.base64 !== 'string' || typeof candidate.name !== 'string') return value
    try {
      const encoded = atob(candidate.base64)
      const bytes = Uint8Array.from(encoded, character => character.charCodeAt(0))
      return new File([bytes], candidate.name, { type: typeof candidate.type === 'string' ? candidate.type : 'application/octet-stream' })
    } catch {
      return value
    }
  }
  const invokeNative = async (action: string, input: unknown, signal: AbortSignal): Promise<unknown> => {
    const abortReason = (): unknown => signal.reason ?? new DOMException('mobile extension disposed', 'AbortError')
    if (signal.aborted) throw abortReason()
    const bridge = window.__DSH_MOBILE_NATIVE__
    if (bridge !== undefined) {
      return new Promise<unknown>((resolve, reject) => {
        let settled = false
        const finish = (callback: () => void): void => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); callback() }
        const onAbort = (): void => { finish(() => { reject(abortReason()) }) }
        signal.addEventListener('abort', onAbort, { once: true })
        void Promise.resolve().then(() => bridge.invoke(action, input)).then(
          value => { finish(() => { resolve(materializeNativeFile(value)) }) },
          error => { finish(() => { reject(error) }) },
        )
      })
    }
    if (action === 'share' && typeof navigator.share === 'function') { await navigator.share((input ?? {}) as ShareData); return { ok: true } }
    if (action === 'clipboard.read' && navigator.clipboard !== undefined) return { text: await navigator.clipboard.readText() }
    if (action === 'clipboard.write' && navigator.clipboard !== undefined) { await navigator.clipboard.writeText(typeof input === 'object' && input !== null && 'text' in input ? String((input as { text: unknown }).text) : ''); return { ok: true } }
    if (action === 'files.pick' || action === 'camera.capture') {
      const inputElement = element('input')
      inputElement.type = 'file'
      inputElement.accept = action === 'camera.capture' ? 'image/*' : '*/*'
      if (action === 'camera.capture') inputElement.capture = 'environment'
      inputElement.hidden = true
      return new Promise<File | undefined>((resolve, reject) => {
        let settled = false
        let cleaned = false
        let cleanupTimer = 0
        let watchdogTimer = 0
        const cleanup = (): void => {
          if (cleaned) return
          cleaned = true
          if (cleanupTimer !== 0) window.clearTimeout(cleanupTimer)
          if (watchdogTimer !== 0) window.clearTimeout(watchdogTimer)
          window.removeEventListener('focus', scheduleCancel)
          document.removeEventListener('visibilitychange', onVisibilityChange)
          signal.removeEventListener('abort', onAbort)
          inputElement.removeEventListener('change', onChange)
          inputElement.removeEventListener('cancel', onCancel)
          inputElement.remove()
        }
        const finish = (callback: () => void): void => { if (settled) return; settled = true; cleanup(); callback() }
        const onChange = (): void => { const file = inputElement.files?.[0]; finish(() => { resolve(file) }) }
        const onCancel = (): void => { finish(() => { resolve(undefined) }) }
        const onAbort = (): void => { finish(() => { reject(abortReason()) }) }
        const scheduleCancel = (): void => { if (!settled && cleanupTimer === 0) cleanupTimer = window.setTimeout(onCancel, 1000) }
        const onVisibilityChange = (): void => { if (document.visibilityState === 'visible') scheduleCancel() }
        inputElement.addEventListener('change', onChange, { once: true })
        inputElement.addEventListener('cancel', onCancel, { once: true })
        window.addEventListener('focus', scheduleCancel)
        document.addEventListener('visibilitychange', onVisibilityChange)
        signal.addEventListener('abort', onAbort, { once: true })
        watchdogTimer = window.setTimeout(onCancel, 300_000)
        try {
          document.body.append(inputElement)
          inputElement.click()
        } catch (error) {
          finish(() => { reject(error) })
        }
      })
    }
    throw new Error('native capability is unavailable')
  }
  const makeApi = (id: string, hostGeneration: string | undefined, controller: AbortController, surfaces: Map<string, ExtensionSurfaceEntry>, surfaceIds: Set<string>): MobileClientApi => {
    const ensureCurrent = (): void => { if (controller.signal.aborted) throw controller.signal.reason }
    const requestSignal = (signal?: AbortSignal | null): CombinedClientSignal => signal === undefined || signal === null
      ? { signal: controller.signal, cleanup: () => undefined }
      : combineClientSignalLifetime(controller.signal, signal)
    const mountSurface = (surface: MobileSurface): (() => void) => {
      ensureCurrent()
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(surface.id) || surface.label.length > 120) throw new Error('invalid mobile surface')
      return registerUniqueDisposable(surfaces, surfaceIds, surface.id, () => {
        const container = element('section'); container.dataset.dshMobileSurface = surface.id; container.hidden = surface.placement === 'page' || surface.placement === 'overlay'; container.style.cssText = surface.placement === 'page' || surface.placement === 'overlay' ? 'position:absolute;inset:0;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);padding:16px;pointer-events:auto' : 'pointer-events:auto'
        const host = (): HTMLElement => surface.placement === 'page' || surface.placement === 'overlay' ? shellLayer() : surfaceHost(surface.placement) ?? shellLayer()
        const mounted = surface.mount(container)
        const dispose = (): void => { try { if (typeof mounted === 'function') mounted() } finally { container.remove() } }
        return { dispose, container, host }
      })
    }
    return {
      host: {
        invoke: (action: string, input: unknown) => {
          ensureCurrent()
          return mobileRequest(`/mobile-access/extensions/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, { method: 'POST', headers: extensionGenerationHeaders(hostGeneration), body: JSON.stringify(input ?? {}), signal: controller.signal }).then(async response => { const value = await response.json() as unknown; if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'error' in value ? String((value as { error: unknown }).error) : `HTTP ${String(response.status)}`); return value })
        },
        fetch: (path: string, init?: RequestInit) => {
          ensureCurrent()
          const target = extensionRouteUrl(id, path, location.href)
          const headers = extensionGenerationHeaders(hostGeneration, init?.headers)
          const lifetime = requestSignal(init?.signal)
          return mobileRequest(target.href, { ...init, headers, signal: lifetime.signal }).then(
            response => bindClientResponseLifetime(response, lifetime.cleanup),
            error => { lifetime.cleanup(); throw error },
          )
        },
        assetUrl: path => { ensureCurrent(); return extensionAssetUrl(id, hostGeneration, path, location.href).href },
      },
      ui: {
        registerSurface: mountSurface,
        open: surfaceId => { ensureCurrent(); const entry = surfaces.get(surfaceId); if (entry !== undefined) entry.container.hidden = false },
        close: surfaceId => { ensureCurrent(); const entry = surfaces.get(surfaceId); if (entry !== undefined) entry.container.hidden = true },
        toast: message => { ensureCurrent(); toast(message) },
      },
      native: {
        capabilities: async () => { ensureCurrent(); const bridge = window.__DSH_MOBILE_NATIVE__; return bridge === undefined ? ['files.pick', 'camera.capture', 'share', 'clipboard.read', 'clipboard.write'] : bridge.capabilities() },
        invoke: (action, input) => invokeNative(action, input, controller.signal),
      },
      signal: controller.signal, document, window,
    }
  }
  const activateDefinition = (definition: MobileClientDefinition, cycleSignal?: AbortSignal, commitGeneration?: () => void, hostGeneration?: string): Promise<boolean> => {
    const previousKey = activationKeys.get(definition.id)
    const key = previousKey?.definition === definition && previousKey.generation === hostGeneration
      ? previousKey
      : { definition, ...(hostGeneration === undefined ? {} : { generation: hostGeneration }) }
    activationKeys.set(definition.id, key)
    return activations.activate(
    definition.id,
    key,
    cycleSignal,
    controller => {
      const surfaces = new Map<string, ExtensionSurfaceEntry>()
      const surfaceIds = new Set<string>()
      let pendingDisposed = false
      const disposePending = (): void => {
        if (pendingDisposed) return
        pendingDisposed = true
        for (const surface of surfaces.values()) {
          try { surface.dispose() } catch { /* Dispose every staged surface independently. */ }
        }
        surfaces.clear()
        surfaceIds.clear()
      }
      const result = Promise.resolve().then(() => definition.activate(makeApi(definition.id, hostGeneration, controller, surfaces, surfaceIds))).then(cleanup => ({
        controller,
        surfaces,
        ...(typeof cleanup === 'function' ? { cleanup } : {}),
      }))
      return {
        result,
        cancel: disposePending,
        commit: value => {
          if (definitions.get(definition.id) !== definition || controller.signal.aborted) throw new Error('stale mobile extension activation')
          for (const surface of value.surfaces.values()) surface.host().append(surface.container)
          activeHostGenerations.set(definition.id, hostGeneration)
          commitGeneration?.()
        },
        dispose: value => {
          controller.abort(new DOMException('mobile extension disposed', 'AbortError'))
          try { value.cleanup?.() } finally { disposePending() }
        },
      }
    },
    )
  }
  const define = (definition: MobileClientDefinition): void => {
    if (disposed || definition.apiVersion !== 1 || !/^[a-z][a-z0-9-]{0,63}$/u.test(definition.id) || typeof definition.activate !== 'function') return
    if (expectedDefinitionId !== undefined && definition.id !== expectedDefinitionId) return
    definitions.set(definition.id, definition)
    if (started && expectedDefinitionId === undefined) void activateDefinition(definition)
  }
  let started = false
  window.dshMobile = Object.freeze({ register: mount => { legacyMount = mount }, define })
  for (const definition of queuedDefinitions.splice(0)) define(definition)
  let legacyJsEtag = ''
  let legacyJsModified = ''
  const refreshLegacy = async (signal: AbortSignal): Promise<boolean> => {
    const previousMount = legacyMount
    let pendingRoot: HTMLElement | undefined
    try {
      const headers: Record<string, string> = {}
      if (legacyJsEtag !== '') headers['if-none-match'] = legacyJsEtag
      if (legacyJsModified !== '') headers['if-modified-since'] = legacyJsModified
      const response = await fetch('/mobile-access/custom.js', { credentials: 'same-origin', cache: 'no-store', headers, signal })
      if (response.status === 304) return true
      if (!response.ok) return false
      const nextEtag = response.headers.get('etag') ?? ''
      const nextModified = response.headers.get('last-modified') ?? ''
      const next = await response.text()
      if (refreshAborted(signal)) return false
      if (next === legacySource) { legacyJsEtag = nextEtag; legacyJsModified = nextModified; return true }
      legacyMount = undefined
      const script = element('script'); script.textContent = `${next}\n//# sourceURL=dsh-mobile-custom.js`; document.head.append(script); script.remove()
      if (refreshAborted(signal)) { legacyMount = previousMount; return false }
      const mount = legacyMount as MobileExtensionMount | undefined
      if (mount === undefined) {
        legacyDispose?.(); legacyDispose = undefined
        legacyRoot?.remove(); legacyRoot = undefined
        legacySource = next; legacyJsEtag = nextEtag; legacyJsModified = nextModified
        return true
      }
      const nextRoot = element('div'); pendingRoot = nextRoot; nextRoot.dataset.dshMobileExtension = 'true'; document.body.append(nextRoot)
      const nextDispose = mount({ document, request: mobileRequest, root: nextRoot, window })
      if (refreshAborted(signal)) { if (typeof nextDispose === 'function') nextDispose(); pendingRoot.remove(); pendingRoot = undefined; legacyMount = previousMount; return false }
      legacyDispose?.(); legacyRoot?.remove(); legacyRoot = nextRoot; pendingRoot = undefined; legacyDispose = typeof nextDispose === 'function' ? nextDispose : undefined; legacySource = next
      legacyJsEtag = nextEtag; legacyJsModified = nextModified
      return true
    } catch { pendingRoot?.remove(); legacyMount = previousMount; return false }
  }
  let legacyScriptRevision = ''
  let legacyStyleRevision = ''
  const disposeManifestExtension = (id: string): void => {
    activations.remove(id)
    styleNodes.get(id)?.remove(); styleNodes.delete(id); styleEtags.delete(id); scriptDigests.delete(id); activeHostGenerations.delete(id); activationKeys.delete(id)
    if (managedDefinitionIds.delete(id)) definitions.delete(id)
  }
  const managedManifestIdSources = (): readonly Iterable<string>[] => [styleNodes.keys(), styleEtags.keys(), scriptDigests.keys(), managedDefinitionIds]
  const clearManifestExtensions = (): void => {
    publishAuthoritativeExtensionIds(manifestExtensionIds, new Set(), managedManifestIdSources(), disposeManifestExtension)
    manifestEtag = ''
  }
  const refreshExtensions = async (signal: AbortSignal): Promise<boolean> => {
    try {
      const headers: Record<string, string> = {}
      if (manifestEtag !== '') headers['if-none-match'] = manifestEtag
      const response = await fetch('/mobile-access/extensions/manifest', { credentials: 'same-origin', cache: 'no-store', headers, signal })
      if (response.status === 404) {
        legacyScriptRevision = ''
        legacyStyleRevision = ''
        return handleMissingExtensionManifest(
          clearManifestExtensions,
          () => Promise.all([refreshLegacy(signal), refreshCssLegacy(legacyStyle, signal, legacyCssState)]),
          signal,
        )
      }
      if (response.status === 304) return true
      if (!response.ok) return false
      const nextManifestEtag = response.headers.get('etag') ?? ''
      const payload = parseMobileExtensionManifest(await response.json())
      if (refreshAborted(signal) || payload === undefined) return false
      const entries = payload.extensions
      const seen = new Set(entries.map(entry => entry.id))
      const scriptRevision = payload.legacy.scriptRevision
      const styleRevision = payload.legacy.styleRevision
      let refreshComplete = true
      if (scriptRevision === '' || scriptRevision !== legacyScriptRevision) {
        if (await refreshLegacy(signal)) legacyScriptRevision = scriptRevision
        else refreshComplete = false
      }
      if (styleRevision === '' || styleRevision !== legacyStyleRevision) {
        if (await refreshCssLegacy(legacyStyle, signal, legacyCssState)) legacyStyleRevision = styleRevision
        else refreshComplete = false
      }
      const commitStyle = (id: string, change: 'retain' | 'remove' | 'replace', css?: string, etag?: string): void => {
        if (change === 'retain') return
        const oldStyle = styleNodes.get(id)
        if (change === 'remove') {
          oldStyle?.remove()
          styleNodes.delete(id)
          styleEtags.delete(id)
          return
        }
        if (oldStyle?.textContent !== css) {
          const node = element('style'); node.dataset.dshMobileExtensionStyle = id; node.textContent = css ?? ''; document.head.append(node); styleNodes.set(id, node); oldStyle?.remove()
        }
        if (etag !== undefined && etag !== '') styleEtags.set(id, etag)
      }
      for (const entry of entries) {
        const hadActiveGeneration = activations.hasActive(entry.id)
        const previousHostGeneration = activeHostGenerations.get(entry.id)
        let previousDefinition: MobileClientDefinition | undefined
        let evaluatedDefinition = false
        try {
          let styleChange: 'retain' | 'remove' | 'replace' = entry.styleUrl === undefined ? 'remove' : 'retain'
          let pendingCss: string | undefined
          let pendingStyleEtag: string | undefined
          const cssUrl = typeof entry.styleUrl === 'string' ? entry.styleUrl : undefined
          if (cssUrl !== undefined) {
            const cssHeaders: Record<string, string> = {}
            const storedEtag = styleEtags.get(entry.id)
            if (storedEtag !== undefined) cssHeaders['if-none-match'] = storedEtag
            const cssResponse = await fetch(cssUrl, { credentials: 'same-origin', cache: 'no-store', headers: cssHeaders, signal })
            if (cssResponse.status !== 304) {
              if (!cssResponse.ok) throw new Error('mobile extension style failed to load')
              pendingStyleEtag = cssResponse.headers.get('etag') ?? undefined
              pendingCss = await cssResponse.text()
              styleChange = 'replace'
              if (refreshAborted(signal)) return false
            }
          }

          const scriptUrl = typeof entry.scriptUrl === 'string' ? entry.scriptUrl : undefined
          if (scriptUrl === undefined) {
            if (refreshAborted(signal)) return false
            commitStyle(entry.id, styleChange, pendingCss, pendingStyleEtag)
            activations.remove(entry.id)
            activeHostGenerations.delete(entry.id)
            scriptDigests.delete(entry.id)
            if (managedDefinitionIds.delete(entry.id)) definitions.delete(entry.id)
          } else {
            const scriptHeaders: Record<string, string> = {}
            const storedDigest = scriptDigests.get(entry.id)
            if (storedDigest !== undefined) scriptHeaders['if-none-match'] = storedDigest
            const scriptResponse = await fetch(scriptUrl, { credentials: 'same-origin', cache: 'no-store', headers: scriptHeaders, signal })
            let nextDigest: string | undefined
            if (scriptResponse.status !== 304) {
              if (!scriptResponse.ok) throw new Error('mobile extension script failed to load')
              const source = await scriptResponse.text()
              if (refreshAborted(signal)) return false
              const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source))
              if (refreshAborted(signal)) return false
              const key = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
              if (scriptDigests.get(entry.id) !== key) {
                previousDefinition = definitions.get(entry.id)
                try {
                  expectedDefinitionId = entry.id
                  try {
                    const script = element('script'); script.textContent = `${source}\n//# sourceURL=dsh-mobile-extension-${entry.id}.js`; document.head.append(script); script.remove()
                  } finally { expectedDefinitionId = undefined }
                  const nextDefinition = definitions.get(entry.id)
                  if (nextDefinition === undefined || nextDefinition === previousDefinition) throw new Error('mobile extension did not define its manifest id')
                  evaluatedDefinition = true
                  nextDigest = key
                } catch (error) {
                  if (previousDefinition === undefined) definitions.delete(entry.id)
                  else definitions.set(entry.id, previousDefinition)
                  throw error
                }
              }
            }
            const definition = definitions.get(entry.id)
            const commitGeneration = (): void => { commitStyle(entry.id, styleChange, pendingCss, pendingStyleEtag) }
            if (definition === undefined) throw new Error('mobile extension definition is unavailable')
            if (evaluatedDefinition || !activations.hasActive(entry.id) || activeHostGenerations.get(entry.id) !== entry.generation) {
              if (!await activateDefinition(definition, signal, commitGeneration, entry.generation)) throw new Error('mobile extension activation failed')
            } else {
              if (refreshAborted(signal)) return false
              commitGeneration()
            }
            managedDefinitionIds.add(entry.id)
            if (nextDigest !== undefined) scriptDigests.set(entry.id, nextDigest)
          }
        } catch {
          if (evaluatedDefinition) {
            if (previousDefinition === undefined) definitions.delete(entry.id)
            else definitions.set(entry.id, previousDefinition)
          }
          failClosedExtensionGenerationReplacement(
            hadActiveGeneration,
            previousHostGeneration,
            entry.generation,
            () => { disposeManifestExtension(entry.id) },
          )
          refreshComplete = false
        }
      }
      if (refreshAborted(signal)) return false
      if (refreshComplete) {
        publishAuthoritativeExtensionIds(manifestExtensionIds, seen, managedManifestIdSources(), disposeManifestExtension)
        manifestEtag = nextManifestEtag
      } else manifestEtag = ''
      return refreshComplete
    } catch { return false }
  }
  started = true
  for (const definition of definitions.values()) void activateDefinition(definition)
  const stopRefresh = startLifecycleRefreshScheduler(async signal => {
    await refreshExtensions(signal)
  })
  const stopEvents = startExtensionChangeStream(() => { stopRefresh.refresh() })
  return () => { disposed = true; stopEvents(); stopRefresh(); started = false; legacyDispose?.(); legacyDispose = undefined; legacyRoot?.remove(); legacyRoot = undefined; legacyStyle.remove(); activations.dispose(); for (const node of styleNodes.values()) node.remove(); styleNodes.clear(); const layer = document.querySelector('[data-dsh-mobile-extension-layer]'); layer?.remove(); for (const host of document.querySelectorAll('[data-dsh-mobile-surface-host]')) host.remove(); if (previous === undefined) delete window.dshMobile; else window.dshMobile = previous }
}

interface LegacyCssState { etag: string; modified: string }
async function refreshCssLegacy(style: HTMLStyleElement, signal: AbortSignal, state: LegacyCssState): Promise<boolean> {
  try {
    const headers: Record<string, string> = {}
    if (state.etag !== '') headers['if-none-match'] = state.etag
    if (state.modified !== '') headers['if-modified-since'] = state.modified
    let response = await fetch('/mobile-access/custom.css', { credentials: 'same-origin', cache: 'no-store', headers, signal })
    if (response.status === 304 && style.textContent === '') {
      state.etag = ''
      state.modified = ''
      response = await fetch('/mobile-access/custom.css', { credentials: 'same-origin', cache: 'no-store', signal })
    }
    if (response.status === 304) return true
    if (response.ok) {
      const nextEtag = response.headers.get('etag') ?? ''
      const nextModified = response.headers.get('last-modified') ?? ''
      const css = await response.text()
      if (refreshAborted(signal)) return false
      style.textContent = css
      state.etag = nextEtag
      state.modified = nextModified
      return true
    }
    return false
  } catch { return false }
}

/** Theme-aware desktop Mobile Access panel styles. */
export const CONTROL_STYLES = `
.dsh-mobile-control{position:fixed;z-index:1000;left:16px;bottom:112px;font:14px/1.45 system-ui;color:var(--dsw-alias-label-primary,#16181d)}
.dsh-mobile-control__panel{box-sizing:border-box;width:min(380px,calc(100vw - 32px));max-height:calc(100vh - 140px);overflow-y:auto;padding:16px;border:1px solid var(--dsw-alias-border-subtle,#e1e5eb);border-radius:18px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 18px 50px rgb(15 23 42 / 18%)}
.dsh-mobile-control__header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}.dsh-mobile-control__panel h2{margin:0;font-size:17px;line-height:24px}.dsh-mobile-control__header-actions{display:flex;align-items:center;gap:2px}.dsh-mobile-control__update-plugin,.dsh-mobile-control__diagnostic-entry,.dsh-mobile-control__close{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:44px;padding:0;border:0;border-radius:10px;background:transparent;color:inherit;cursor:pointer}.dsh-mobile-control__update-plugin,.dsh-mobile-control__diagnostic-entry{padding:0 8px;color:#2563eb;font:650 12px/1 system-ui;white-space:nowrap}.dsh-mobile-control__update-plugin[hidden]{display:none}.dsh-mobile-control__update-plugin:disabled{cursor:wait;opacity:.55}.dsh-mobile-control__close{font-size:24px;line-height:1}.dsh-mobile-control__update-plugin:hover:not(:disabled),.dsh-mobile-control__diagnostic-entry:hover,.dsh-mobile-control__close:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}
.dsh-mobile-control__release-notice{margin:-2px 0 10px;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-1,#eff6ff);color:var(--dsw-alias-label-primary,#1d4ed8);font-size:11px;line-height:1.45}.dsh-mobile-control__release-notice.is-error{color:#dc2626}.dsh-mobile-control__release-notice[hidden]{display:none}.dsh-mobile-control__app-download{display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;min-height:38px;margin:0 0 10px;padding:8px 11px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:11px;background:var(--dsw-alias-bg-layer-1,#f7f8fa);color:var(--dsw-alias-label-primary,#16181d);font:600 12px/1.3 system-ui;text-decoration:none}.dsh-mobile-control__app-download[hidden]{display:none}.dsh-mobile-control__app-download::after{color:#2563eb;font-size:14px;content:"↗"}.dsh-mobile-control__app-download:hover{border-color:#9fb9e8;background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-layer-2,#f5f8ff));color:var(--dsw-alias-label-primary,#1d4ed8)}
.dsh-mobile-control__switcher{display:grid;grid-template-columns:repeat(2,1fr);gap:4px;margin:0 0 14px;padding:4px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#f3f5f8)}.dsh-mobile-control__switcher[hidden]{display:none}.dsh-mobile-control__tab{min-height:36px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#606873);font:600 13px/1 system-ui;cursor:pointer}.dsh-mobile-control__tab.is-active{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);box-shadow:0 1px 3px rgb(15 23 42 / 10%)}.dsh-mobile-control__view[hidden]{display:none}.dsh-mobile-control__intro{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#606873);font-size:12px;line-height:1.55}.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions button[hidden]{display:none}
.dsh-mobile-control__provider-section{position:relative;margin:0 0 14px}.dsh-mobile-control__section-title{margin:0 0 8px;color:var(--dsw-alias-label-primary,#16181d);font:650 13px/1.4 system-ui}.dsh-mobile-control__provider-section>.dsh-mobile-control__section-title{padding-right:42px}.dsh-mobile-control__provider-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.dsh-mobile-control__provider{display:flex;min-width:0;flex-direction:column;gap:6px;min-height:94px;padding:10px 11px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);text-align:left;cursor:pointer;touch-action:manipulation;transition:border-color 160ms ease,background-color 160ms ease,box-shadow 160ms ease}.dsh-mobile-control__provider:hover{border-color:#6f96db;background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-layer-1,#f8fbff))}.dsh-mobile-control__provider.is-selected{border-color:#2563eb;background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-layer-1,#f5f8ff));box-shadow:0 0 0 1px #2563eb inset}.dsh-mobile-control__provider:disabled{cursor:wait;opacity:.62}.dsh-mobile-control__provider-top{display:flex;min-width:0;align-items:flex-start;justify-content:space-between;gap:5px}.dsh-mobile-control__provider-top strong{min-width:0;font-size:12px;line-height:1.3}.dsh-mobile-control__provider-badge{flex:none;padding:2px 5px;border-radius:999px;background:#e8f0ff;color:#1d4ed8;font:650 9px/1.25 system-ui}.dsh-mobile-control__provider-badge.is-cpolar{background:#eaf8f2;color:#087454}.dsh-mobile-control__provider-description{color:var(--dsw-alias-label-secondary,#606873);font-size:10px;line-height:1.45}.dsh-mobile-control__provider-info{position:absolute;z-index:5;top:-13px;right:-8px}.dsh-mobile-control__provider-info-button{display:flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#475569);cursor:pointer;touch-action:manipulation}.dsh-mobile-control__provider-info-button:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f5f9);color:#2563eb}.dsh-mobile-control__provider-info-glyph{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:18px;height:18px;border:1.5px solid currentColor;border-radius:50%;font:700 12px/1 system-ui}.dsh-mobile-control__provider-info-popover{position:absolute;z-index:6;top:38px;right:4px;box-sizing:border-box;width:min(292px,calc(100vw - 72px));padding:10px 12px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 10px 28px rgb(15 23 42 / 16%)}.dsh-mobile-control__provider-info-popover[hidden]{display:none}.dsh-mobile-control__provider-info-popover strong,.dsh-mobile-control__provider-info-popover span{display:block}.dsh-mobile-control__provider-info-popover strong{margin-bottom:3px;font-size:12px}.dsh-mobile-control__provider-info-popover span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.55}
.dsh-mobile-control__self-hosted{margin:8px 0 0;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__self-hosted-summary{display:flex;box-sizing:border-box;min-height:48px;align-items:center;justify-content:space-between;gap:10px;padding:8px 11px;cursor:pointer;list-style-position:inside}.dsh-mobile-control__self-hosted-summary>span:first-child{display:flex;min-width:0;flex-direction:column;gap:1px}.dsh-mobile-control__self-hosted-summary strong{font-size:11px}.dsh-mobile-control__self-hosted-summary span span{color:var(--dsw-alias-label-secondary,#606873);font-size:9px;line-height:1.35}.dsh-mobile-control__provider-badge.is-frp{background:#eef0f3;color:#475569}.dsh-mobile-control__self-hosted-body{padding:0 8px 8px}.dsh-mobile-control__provider.is-frp{width:100%;min-height:64px;background:var(--dsw-alias-bg-layer-2,#fff)}
.dsh-mobile-control__cpolar-setup{margin:0 0 12px;padding:12px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__cpolar-setup[hidden],.dsh-mobile-control__cpolar-account[hidden],.dsh-mobile-control__details[hidden],.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions[hidden],.dsh-mobile-control__danger[hidden]{display:none}.dsh-mobile-control__component-status,.dsh-mobile-control__component-note{margin:0 0 10px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.55}.dsh-mobile-control__cpolar-setup>.dsh-mobile-control__primary{width:100%;min-height:44px;padding:9px 12px;border-radius:10px;font:600 12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__cpolar-account{margin-top:10px}.dsh-mobile-control__link-row{display:flex;flex-wrap:wrap;gap:6px 12px;margin:0 0 10px}.dsh-mobile-control__text-link{color:#2563eb;font-size:11px;text-decoration:none}.dsh-mobile-control__text-link:hover{text-decoration:underline}.dsh-mobile-control__token-label{display:flex;flex-direction:column;gap:5px;margin:0 0 8px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px}.dsh-mobile-control__token{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border:1px solid var(--dsw-alias-border-normal,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#fff));color:var(--dsw-alias-label-primary,#16181d);font:16px/1.4 system-ui}.dsh-mobile-control__cpolar-connect{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;min-height:44px;padding:10px 14px;border-radius:12px;font:650 13px/1.2 system-ui;cursor:pointer;transition:background-color 160ms ease,border-color 160ms ease,opacity 160ms ease}.dsh-mobile-control__cpolar-connect:hover:not(:disabled){border-color:#1d4ed8;background:#1d4ed8}.dsh-mobile-control__cpolar-connect:active:not(:disabled){border-color:#1e40af;background:#1e40af}.dsh-mobile-control__cpolar-connect:disabled{cursor:wait;opacity:.55}.dsh-mobile-control__details{margin:10px 0 0;border-top:1px solid var(--dsw-alias-border-subtle,#e1e5eb);padding-top:9px}.dsh-mobile-control__details>summary{min-height:30px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:30px;cursor:pointer}.dsh-mobile-control__details-body{display:flex;flex-wrap:wrap;align-items:center;gap:7px 12px;padding:4px 0}.dsh-mobile-control__details-body p{flex:1 0 100%;margin:0;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__storage{display:block;flex:1 0 100%;max-width:100%;overflow:hidden;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f3f5f8);color:var(--dsw-alias-label-secondary,#475569);font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__danger{flex:1 0 100%;min-height:38px;margin-top:3px;padding:7px 10px;border:1px solid #dc2626;border-radius:9px;background:transparent;color:#dc2626;font:12px/1.3 system-ui;cursor:pointer}
.dsh-mobile-control__frp-setup{margin:0;padding:12px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__frp-setup[hidden]{display:none}.dsh-mobile-control__frp-step{padding:11px 0}.dsh-mobile-control__frp-step + .dsh-mobile-control__frp-step{border-top:1px solid var(--dsw-alias-border-subtle,#e1e5eb)}.dsh-mobile-control__frp-step>strong{display:block;margin-bottom:3px;font-size:12px;line-height:1.4}.dsh-mobile-control__frp-step>p{margin:0 0 9px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__frp-step>.dsh-mobile-control__frp-requirement{padding:8px 9px;border-radius:9px;background:var(--dsw-alias-bg-layer-1,#f3f5f8);color:var(--dsw-alias-label-primary,#384152);font-size:11px}.dsh-mobile-control__frp-fields{display:grid;grid-template-columns:minmax(0,1fr) 96px;gap:8px}.dsh-mobile-control__field{display:flex;min-width:0;flex-direction:column;gap:5px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px}.dsh-mobile-control__field:nth-child(3),.dsh-mobile-control__field:nth-child(4){grid-column:1/-1}.dsh-mobile-control__field input{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border:1px solid var(--dsw-alias-border-normal,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);font:16px/1.4 system-ui}.dsh-mobile-control__frp-action{box-sizing:border-box;width:100%;min-height:44px;padding:9px 12px;border-radius:10px;font:650 12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__frp-action:disabled{cursor:not-allowed;opacity:.5}.dsh-mobile-control__remote-workspace{margin:0;padding:12px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:15px;background:var(--dsw-alias-bg-layer-1,#f7f8fa)}.dsh-mobile-control__stage-header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.dsh-mobile-control__stage-header .dsh-mobile-control__section-title{margin:0}.dsh-mobile-control__stage-meta{display:flex;min-width:0;align-items:center;justify-content:flex-end;gap:5px}.dsh-mobile-control__stage-value{max-width:115px;overflow:hidden;color:var(--dsw-alias-label-primary,#16181d);font:650 10px/1.3 system-ui;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__state-badge{flex:none;padding:3px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#606873);font:650 9px/1.25 system-ui}.dsh-mobile-control__state-badge.is-ready{background:#e6f7f0;color:#087454}.dsh-mobile-control__state-badge.is-busy{background:#e8f0ff;color:#1d4ed8}.dsh-mobile-control__state-badge.is-attention{background:#fff4dc;color:#935100}.dsh-mobile-control__remote-workspace>.dsh-mobile-control__status{box-sizing:border-box;margin:0 0 10px;padding:9px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);font-size:11px;line-height:1.45}.dsh-mobile-control__provider-setup-body{margin:0 0 10px}.dsh-mobile-control__provider-setup-body>.dsh-mobile-control__cpolar-setup{margin:0}.dsh-mobile-control__provider-setup-body>.dsh-mobile-control__cpolar-setup>.dsh-mobile-control__section-title,.dsh-mobile-control__provider-setup-body>.dsh-mobile-control__frp-setup>.dsh-mobile-control__section-title{display:none}.dsh-mobile-control__provider-setup-body>.dsh-mobile-control__details{margin:0;padding:9px 10px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:11px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__remote-workspace>.dsh-mobile-control__actions{margin-top:2px}.dsh-mobile-control__remote-workspace>.dsh-mobile-control__qr{margin:10px 0 0}.dsh-mobile-control__remote-workspace>.dsh-mobile-control__manage-row{margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-subtle,#e1e5eb)}
.dsh-mobile-control__frp-overview{display:grid;grid-template-columns:32px minmax(0,1fr);align-items:center;gap:10px;margin:0 0 10px;padding:10px;border:1px solid #a9dfc9;border-radius:11px;background:#edf9f4}.dsh-mobile-control__frp-overview[hidden]{display:none}.dsh-mobile-control__frp-overview-mark{display:grid;width:32px;height:32px;place-items:center;border-radius:50%;background:#087454;color:#fff;font:700 15px/1 system-ui}.dsh-mobile-control__frp-overview-body{display:flex;min-width:0;flex-direction:column;gap:2px}.dsh-mobile-control__frp-overview-body strong{color:#075d46;font-size:12px;line-height:1.35}.dsh-mobile-control__frp-overview-body span{overflow:hidden;color:#357061;font:10px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__frp-group{margin:8px 0 0;overflow:hidden;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:11px;background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__frp-group>summary{box-sizing:border-box;min-height:44px;padding:12px 34px 10px 12px;color:var(--dsw-alias-label-primary,#16181d);font:650 12px/1.4 system-ui;cursor:pointer}.dsh-mobile-control__frp-group[open]>summary{border-bottom:1px solid var(--dsw-alias-border-subtle,#e1e5eb);background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__frp-group>.dsh-mobile-control__frp-step{padding:12px}.dsh-mobile-control__frp-group>.dsh-mobile-control__frp-step>strong:first-child{display:none}.dsh-mobile-control__frp-group .dsh-mobile-control__frp-step{border-top:0}.dsh-mobile-control__frp-setup>.dsh-mobile-control__frp-step{margin-bottom:8px;padding:10px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:11px;background:var(--dsw-alias-bg-layer-1,#f8fafc)}
.dsh-mobile-control__access{display:flex;align-items:baseline;gap:6px;min-width:0;margin:0 0 12px}.dsh-mobile-control__access[hidden]{display:none}.dsh-mobile-control__access-label{flex:none;color:var(--dsw-alias-label-secondary,#606873);white-space:nowrap}.dsh-mobile-control__access-label::after{content:"："}.dsh-mobile-control__access-link{min-width:0;overflow:hidden;color:#2563eb;text-decoration:none;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__access-link:hover{text-decoration:underline}.dsh-mobile-control__qr{display:flex;justify-content:center;margin:0 0 12px}.dsh-mobile-control__qr[hidden]{display:none}.dsh-mobile-control__qr img{border-radius:12px;background:#fff;padding:8px}
.dsh-mobile-control__status{margin:0 0 14px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#606873)}.dsh-mobile-control__status::before{display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:50%;background:#98a1ad;content:""}.dsh-mobile-control__status.is-running::before{background:#16a36a}.dsh-mobile-control__status.is-key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}
.dsh-mobile-control__guide{margin:0 0 14px;padding:12px;border:1px solid #6f96db;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#eff6ff)}.dsh-mobile-control__guide[hidden]{display:none}.dsh-mobile-control__guide-title{margin:0;color:var(--dsw-alias-label-primary,#172554);font:650 13px/1.45 system-ui}.dsh-mobile-control__guide-summary,.dsh-mobile-control__guide-note{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#475569);font-size:12px;line-height:1.5}.dsh-mobile-control__guide-steps{margin:8px 0 0;padding-left:20px;color:var(--dsw-alias-label-primary,#1e293b);font-size:12px;line-height:1.6}.dsh-mobile-control__guide-note{color:var(--dsw-alias-label-secondary,#64748b)}.dsh-mobile-control__guide-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.dsh-mobile-control__guide-actions button{min-width:0;min-height:44px;padding:8px;border-radius:10px;font:12px/1.25 system-ui;cursor:pointer}.dsh-mobile-control__guide-actions button:disabled{cursor:not-allowed;opacity:.45}
.dsh-mobile-control__extensions{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#606873);font-size:12px}
.dsh-mobile-control__view.is-diagnostics{--dsh-diagnostic-ok:#087454;--dsh-diagnostic-warning:#a35b00;--dsh-diagnostic-error:#c62828;--dsh-diagnostic-info:#526071}.dsh-mobile-control__diagnostic-summary{box-sizing:border-box;margin:0;padding:13px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:16px;background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__diagnostic-summary-main{display:grid;grid-template-columns:36px minmax(0,1fr);align-items:center;gap:11px}.dsh-mobile-control__diagnostic-summary-icon{position:relative;display:block;width:36px;height:36px;border-radius:50%;background:#e8edf3;color:var(--dsh-diagnostic-info)}.dsh-mobile-control__diagnostic-summary-icon::before,.dsh-mobile-control__diagnostic-summary-icon::after{position:absolute;content:""}.dsh-mobile-control__diagnostic-summary-body{display:flex;min-width:0;flex-direction:column;gap:2px}.dsh-mobile-control__diagnostic-summary-body strong{font-size:13px;line-height:1.35}.dsh-mobile-control__diagnostic-summary-body span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__diagnostic-summary-meta{display:block;margin-top:11px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-subtle,#dbe1e8);color:var(--dsw-alias-label-secondary,#606873);font-size:10px;line-height:1.45}.dsh-mobile-control__diagnostic-summary.is-ok .dsh-mobile-control__diagnostic-summary-icon{background:#e6f7f0;color:var(--dsh-diagnostic-ok)}.dsh-mobile-control__diagnostic-summary.is-ok .dsh-mobile-control__diagnostic-summary-icon::before{top:10px;left:10px;width:13px;height:7px;border-bottom:2px solid currentColor;border-left:2px solid currentColor;transform:rotate(-45deg)}.dsh-mobile-control__diagnostic-summary.is-attention .dsh-mobile-control__diagnostic-summary-icon{background:#fff4dc;color:var(--dsh-diagnostic-warning)}.dsh-mobile-control__diagnostic-summary.is-error .dsh-mobile-control__diagnostic-summary-icon{background:#fdecec;color:var(--dsh-diagnostic-error)}.dsh-mobile-control__diagnostic-summary.is-attention .dsh-mobile-control__diagnostic-summary-icon::before,.dsh-mobile-control__diagnostic-summary.is-error .dsh-mobile-control__diagnostic-summary-icon::before{top:8px;left:17px;width:2px;height:13px;border-radius:2px;background:currentColor}.dsh-mobile-control__diagnostic-summary.is-attention .dsh-mobile-control__diagnostic-summary-icon::after,.dsh-mobile-control__diagnostic-summary.is-error .dsh-mobile-control__diagnostic-summary-icon::after{bottom:8px;left:17px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-summary.is-running .dsh-mobile-control__diagnostic-summary-icon{background:#e8f0ff;color:#2563eb}.dsh-mobile-control__diagnostic-summary.is-running .dsh-mobile-control__diagnostic-summary-icon::before{inset:9px;border:2px solid rgb(37 99 235 / 24%);border-top-color:currentColor;border-radius:50%;animation:dsh-diagnostic-spin .8s linear infinite}
.dsh-mobile-control__diagnostic-summary.is-idle .dsh-mobile-control__diagnostic-summary-icon::before{top:8px;left:17px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-summary.is-idle .dsh-mobile-control__diagnostic-summary-icon::after{top:13px;left:17px;width:2px;height:11px;border-radius:2px;background:currentColor}
.dsh-mobile-control__diagnostic-toolbar{display:grid;grid-template-columns:1fr;gap:8px;margin-top:10px}.dsh-mobile-control__diagnostic-toolbar.has-report{grid-template-columns:1fr 1fr}.dsh-mobile-control__diagnostic-run,.dsh-mobile-control__diagnostic-copy{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border-radius:11px;font:650 12px/1.3 system-ui;cursor:pointer;touch-action:manipulation}.dsh-mobile-control__diagnostic-copy[hidden]{display:none}.dsh-mobile-control__diagnostic-run:disabled{cursor:wait;opacity:.58}.dsh-mobile-control__diagnostic-feedback{margin:8px 0 0;padding:8px 10px;border-radius:9px;background:#eff6ff;color:#1d4ed8;font-size:11px;line-height:1.45}.dsh-mobile-control__diagnostic-feedback[hidden]{display:none}
.dsh-mobile-control__diagnostic-checks{display:grid;gap:12px;margin-top:12px;animation:dsh-diagnostic-reveal 160ms ease-out both}.dsh-mobile-control__diagnostic-checks[hidden]{display:none}.dsh-mobile-control__diagnostic-group{overflow:hidden;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__diagnostic-group-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 11px;border-bottom:1px solid var(--dsw-alias-border-subtle,#e1e5eb);background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__diagnostic-group-header h3{margin:0;font:650 11px/1.4 system-ui}.dsh-mobile-control__diagnostic-group-header span{color:var(--dsw-alias-label-secondary,#606873);font-size:10px}.dsh-mobile-control__diagnostic-list{display:flex;flex-direction:column}.dsh-mobile-control__diagnostic-check{display:grid;grid-template-columns:26px minmax(0,1fr);gap:9px;padding:11px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__diagnostic-check + .dsh-mobile-control__diagnostic-check{border-top:1px solid var(--dsw-alias-border-subtle,#e1e5eb)}.dsh-mobile-control__diagnostic-marker{position:relative;width:26px;height:26px;border-radius:50%;background:#edf1f5;color:var(--dsh-diagnostic-info)}.dsh-mobile-control__diagnostic-marker::before,.dsh-mobile-control__diagnostic-marker::after{position:absolute;content:""}.dsh-mobile-control__diagnostic-check.is-ok .dsh-mobile-control__diagnostic-marker{background:#e6f7f0;color:var(--dsh-diagnostic-ok)}.dsh-mobile-control__diagnostic-check.is-ok .dsh-mobile-control__diagnostic-marker::before{top:7px;left:7px;width:9px;height:5px;border-bottom:1.8px solid currentColor;border-left:1.8px solid currentColor;transform:rotate(-45deg)}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-marker{background:#fff4dc;color:var(--dsh-diagnostic-warning)}.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-marker{background:#fdecec;color:var(--dsh-diagnostic-error)}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-marker::before,.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-marker::before{top:6px;left:12px;width:2px;height:9px;border-radius:2px;background:currentColor}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-marker::after,.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-marker::after{bottom:6px;left:12px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-check.is-info .dsh-mobile-control__diagnostic-marker::before{top:6px;left:12px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-check.is-info .dsh-mobile-control__diagnostic-marker::after{top:10px;left:12px;width:2px;height:9px;border-radius:2px;background:currentColor}.dsh-mobile-control__diagnostic-check-body{min-width:0}.dsh-mobile-control__diagnostic-check-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.dsh-mobile-control__diagnostic-check-header strong{min-width:0;font-size:12px;line-height:1.4}.dsh-mobile-control__diagnostic-badge{flex:none;padding:2px 6px;border-radius:999px;background:#edf1f5;color:var(--dsh-diagnostic-info);font:650 10px/1.3 system-ui}.dsh-mobile-control__diagnostic-check.is-ok .dsh-mobile-control__diagnostic-badge{background:#e6f7f0;color:var(--dsh-diagnostic-ok)}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-badge{background:#fff4dc;color:var(--dsh-diagnostic-warning)}.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-badge{background:#fdecec;color:var(--dsh-diagnostic-error)}.dsh-mobile-control__diagnostic-check p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5;overflow-wrap:anywhere}.dsh-mobile-control__diagnostic-check .dsh-mobile-control__diagnostic-action{margin-top:7px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f8fafc);color:var(--dsw-alias-label-primary,#16181d)}.dsh-mobile-control__diagnostic-action span{display:inline-block;margin-right:6px;color:#2563eb;font-weight:700}.dsh-mobile-control__diagnostic-details{margin-top:12px}.dsh-mobile-control__diagnostic-details[hidden]{display:none}.dsh-mobile-control__diagnostic-details>summary{box-sizing:border-box;min-height:44px;line-height:44px}.dsh-mobile-control__diagnostic-report{box-sizing:border-box;max-height:220px;margin:4px 0 0;overflow:auto;padding:10px;border:1px solid var(--dsw-alias-border-subtle,#dbe1e8);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#f3f5f8);color:var(--dsw-alias-label-secondary,#606873);font:10px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-mobile-control__diagnostic-checks{transition:opacity 150ms ease}.dsh-mobile-control__diagnostic-checks.is-refreshing{opacity:.52}
@keyframes dsh-diagnostic-spin{to{transform:rotate(360deg)}}@keyframes dsh-diagnostic-reveal{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.dsh-mobile-control__actions{display:flex;flex-wrap:nowrap;gap:6px}.dsh-mobile-control__actions button{flex:1 1 0;min-width:0;min-height:40px;padding:8px 4px;border-radius:10px;font:12px/1.2 system-ui;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-mobile-control__secondary{border:1px solid var(--dsw-alias-border-normal,#cfd5dd);background:transparent;color:inherit}.dsh-mobile-control__primary{border:1px solid #2563eb;background:#2563eb;color:#fff}.dsh-mobile-control__actions button:disabled{cursor:not-allowed;opacity:.45}
.dsh-mobile-control button:focus-visible,.dsh-mobile-control a:focus-visible,.dsh-mobile-control input:focus-visible,.dsh-mobile-control summary:focus-visible{outline:3px solid rgb(37 99 235 / 28%);outline-offset:2px}
.dsh-mobile-control__trigger{box-sizing:border-box;flex:none;display:flex;align-items:center;gap:8px;width:calc(100% + 4px);height:42px;margin:4px -2px;padding:0 10px 0 8px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,#16181d);font-family:inherit;font-size:14px;line-height:22px;cursor:pointer;overflow:hidden}.dsh-mobile-control__trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}.dsh-mobile-control__trigger:active,.dsh-mobile-control__trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-active,#e8ebf0)}.dsh-mobile-control__trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:2px}.dsh-mobile-control__trigger.is-rail{width:36px;height:36px;margin:8px 0 10px;padding:0;justify-content:center;gap:0;border-radius:50%}.dsh-mobile-control__trigger-icon{display:block;flex:none}.dsh-mobile-control__trigger-label{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dsh-mobile-control__manage-row{display:flex;justify-content:space-between;gap:8px;margin-top:10px}.dsh-mobile-control__manage{flex:1 1 0;min-width:0;min-height:34px;padding:6px 8px;border:1px solid var(--dsw-alias-border-normal,#cfd5dd);border-radius:10px;background:transparent;color:inherit;font:12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__devices{margin-top:10px;border:1px solid var(--dsw-alias-border-subtle,#e1e5eb);border-radius:10px;padding:8px;max-height:220px;overflow-y:auto}.dsh-mobile-control__device-empty{color:var(--dsw-alias-label-secondary,#606873);font-size:12px;margin:0}.dsh-mobile-control__device{display:flex;align-items:center;gap:8px;padding:6px 2px}.dsh-mobile-control__device + .dsh-mobile-control__device{border-top:1px solid var(--dsw-alias-border-subtle,#e1e5eb)}.dsh-mobile-control__device-label{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.dsh-mobile-control__device-meta{flex:none;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;white-space:nowrap}.dsh-mobile-control__device-revoke{flex:none;min-height:28px;padding:4px 8px;border:1px solid #dc2626;border-radius:8px;background:transparent;color:#dc2626;font:12px/1.2 system-ui;cursor:pointer}
@media (max-width:359px){.dsh-mobile-control__provider-choices{grid-template-columns:1fr}.dsh-mobile-control__provider{min-height:68px}}@media (prefers-reduced-motion:reduce){.dsh-mobile-control__provider,.dsh-mobile-control__cpolar-connect{transition:none}.dsh-mobile-control__diagnostic-summary.is-running .dsh-mobile-control__diagnostic-summary-icon::before,.dsh-mobile-control__diagnostic-checks{animation:none}}
`

/** Mount the desktop control or mobile feature enhancements. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    if (window.__DSH_MOBILE_FRONTEND__ !== 'dedicated') return
    return trustAuthenticatedGatewayConnection(ctx.get('connection'))
  }, 'dsh-mobile: authenticated gateway client trust')

  ctx.effect(() => {
    const loopback = isLoopbackHost(location.hostname) && !new URLSearchParams(location.search).has('dsh-mobile-preview')
    const style = element('style'); style.dataset.plugin = 'dsh-mobile'; style.textContent = loopback
      ? CONTROL_STYLES
      : NATIVE_MOBILE_STYLES
    document.head.append(style)
    if (!loopback) {
      const removeCustom = installCustomAssets()
      const removeSurface = installDshLanguageBoundSurface(installNativeMobileSurface)
      return () => { removeCustom(); removeSurface(); style.remove() }
    }
    const removeControl = installDshLanguageBoundSurface(() => {
      const control = installControl()
      const triggerLocale = selectedMobileControlLocale()
      const t = controlTranslator(triggerLocale)
      const disposeSlot = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register<{ wide: boolean }>({ name: 'sidebar.footer.action', id: 'dsh-mobile' }, ({ wide }) => createElement('button', {
        'aria-expanded': control.isOpen(),
        'aria-controls': CONTROL_PANEL_ID,
        'aria-label': t('mobileAccess'),
        className: `dsh-mobile-control__trigger${wide ? '' : ' is-rail'}`,
        lang: triggerLocale,
        type: 'button',
        title: t('mobileAccess'),
        onClick: control.toggle,
      }, createElement('svg', {
        'aria-hidden': true,
        className: 'dsh-mobile-control__trigger-icon',
        focusable: false,
        width: wide ? 16 : 18,
        height: wide ? 16 : 18,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.5,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      }, createElement('rect', { x: 4, y: 1, width: 8, height: 14, rx: 2 }), createElement('path', { d: 'M7 12h2' })), wide ? createElement('span', { className: 'dsh-mobile-control__trigger-label' }, t('mobileAccess')) : undefined)))
      return () => { disposeSlot(); control.remove() }
    })
    return () => { removeControl(); style.remove() }
  }, 'dsh-mobile: stock mobile adaptation and local control')
}

/** Client services required by the mobile adaptation. */
export const inject: readonly string[] = ['slots']
