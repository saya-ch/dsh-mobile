import { createElement, useEffect, useState, useSyncExternalStore } from 'react'
import {
  DIAGNOSTIC_REASON_MESSAGES,
  DIAGNOSTIC_NETWORK_MESSAGES,
  DIAGNOSTIC_SCOPE_MESSAGES,
  LOCALIZED_DIAGNOSTIC_COPY,
  MOBILE_CONTROL_MESSAGES,
  type MobileControlLocale,
} from './client-messages.js'
import { createRestrictedFrpServerTemplate } from './frp-template.js'
import { createFrpAttachFrpcToml, createFrpAttachTemplate } from './frp-attach.js'
import { parseFrpSettings, type FrpSettings } from './frp-config.js'
import { FRP_FORM_ERRORS, validateFrpForm, type FrpFormIssue, type FrpFormValues } from './frp-form-validation.js'
import { installNativeMobileSurface, NATIVE_MOBILE_STYLES, resolveNativeMobileLanguage } from './native-mobile.js'
import { installVoiceSession } from './voice-session.js'
import { installDraftTransfer } from './draft-transfer.js'
import { installMobileFontPreference, MobileFontSizeRow } from './mobile-font.js'
import { MobileDisplayScaleRow } from './mobile-display-scale.js'
import { MobileNativeSettingsActionController, type MobileNativeSettingsAction } from './mobile-native-settings-action.js'
import { CLIENT_MODULE_STYLES, ClientModuleSettingsRow, closeClientModuleDialog, disposeClientModuleDialogs } from './client-module-ui.js'
import { isDesktopAdminSurface, localAdminRequestHeaders } from './local-admin-host.js'
import { fireDeviceRevoked, fireTaskNotifyEvent, isDeviceRevokedPayload, parseTaskNotifyPayload, taskCompletionTag } from './task-notify.js'
import { EXTENSION_RECOVERY_STYLES, installExtensionRecoveryControl } from './extension-recovery-ui.js'
import { invokeBoundNativeCapability } from './native-capability.js'
import { pickBrowserFiles } from './browser-file-picker.js'
import { createMobileAssetLoadReporter, ownsMobileCustomization, readMobileAssetText, type MobileAssetLoadFailure } from './mobile-custom-assets.js'
import { installCustomizationNotice } from './mobile-customization-notice.js'
import { EXTENSION_LIMITS, LEGACY_CUSTOM_ASSET_LIMIT } from './extension-limits.js'
import { installMobileConnectionRecovery, type MobileConnectionState } from './client-recovery.js'
import { installMobileUiLocalePersistence } from './mobile-ui-locale.js'
import { createMobilePushBrowserApi, type MobilePushBrowserApi } from './mobile-push/browser-api.js'
import { browserPushEnvironment, createMobilePushController, type MobilePushEnvironment } from './mobile-push/client.js'
import { MobilePushSettings } from './mobile-push/settings.js'
import { installPushNavigation } from './mobile-push/navigation.js'
import { dismissMobileDirectoryPicker, hasUpstreamBrowsePicker, installMobileDirectoryPicker } from './mobile-directory-picker.js'

export { shouldNudgeReconnect, shouldRenewSession } from './client-recovery.js'
export type { MobileConnectionState } from './client-recovery.js'

export { DIAGNOSTIC_REASON_MESSAGES, DIAGNOSTIC_NETWORK_MESSAGES, DIAGNOSTIC_SCOPE_MESSAGES, LOCALIZED_DIAGNOSTIC_COPY, MOBILE_CONTROL_MESSAGES } from './client-messages.js'
export type { MobileControlLocale } from './client-messages.js'

/**
 * Remote provider names the control UI knows about.
 *
 * This mirrors the server-side union in `src/remote.ts`, which cannot be imported
 * here because it pulls in Node-only modules. An unrecognized value from the
 * host falls back to the built-in provider, so a missing name would silently
 * render another provider's wording instead of failing loudly.
 */
export type MobileRemoteProvider = 'tailscale' | 'cpolar' | 'cloudflared' | 'frp' | 'origin' | 'iroh'

/** Map a host-reported provider onto the UI union, defaulting to the built-in one. */
export function parseMobileRemoteProvider(value: unknown): MobileRemoteProvider {
  return value === 'cpolar' || value === 'cloudflared' || value === 'frp' || value === 'origin' || value === 'iroh'
    ? value
    : 'tailscale'
}

interface ClientContext {
  effect(effect: () => void | (() => void), label?: string): void
  get(name: 'connection'): MobileConnectionHandle | undefined
  get(name: string): unknown
  /** Public Cordis child lifecycle; optional so minimal harness contexts without the navigation feature stay valid. */
  inject?(services: readonly MobilePushNavigationService[], callback: (context: ClientNavigationContext) => (() => void) | undefined): { dispose(): unknown }
  slots: {
    inject(key: string, callback: () => (() => void)): () => void
    register<Props>(options: { name: string; id: string; order?: number; priority?: number; label?: string }, component: (props: Props) => unknown): () => void
  }
}

/** Public client services the authenticated tap consumer follows (scoped child lifecycle, never a required plugin dependency). */
const mobilePushNavigationServices = ['sessions', 'workspaces', 'uiWorkspace'] as const
type MobilePushNavigationService = typeof mobilePushNavigationServices[number]

/** Shape of the public navigation services as provided on a scoped child context. */
interface ClientNavigationContext {
  readonly sessions: { readonly list: { getSnapshot(): { readonly phase: string; readonly byId: Readonly<Record<string, unknown>>; readonly ids: readonly string[] }; subscribe(listener: () => void): () => void } }
  readonly workspaces: { readonly list: { getSnapshot(): { readonly phase: string; readonly items: readonly unknown[] }; subscribe(listener: () => void): () => void } }
  readonly uiWorkspace: { openSession(sessionId: string): void }
}

interface MobileConnectionHandle {
  isLoopback: boolean
  /** Present on a live client connection; absent in the headless test harness. */
  readonly state?: {
    getSnapshot: () => MobileConnectionState
    subscribe: (listener: () => void) => () => void
  }
  reconnect?: () => void
}

interface MobileExtensionContext {
  readonly document: Document
  readonly request: (path: string, init?: RequestInit) => Promise<Response>
  readonly root: HTMLElement
  readonly window: Window
}

type MobileExtensionMount = (context: MobileExtensionContext) => void | (() => void)
type MobileSurfacePlacement = 'page' | 'sidebar-action' | 'header-action' | 'composer-dock' | 'settings-section' | 'overlay'

/**
 * Set a surface's visibility; opening a page or overlay brings it to the front.
 * @param container - the registered surface element.
 * @param open - whether to show it.
 */
export function setMobileSurfaceOpen(container: HTMLElement, open: boolean): void {
  container.hidden = !open
  if (open && container.isConnected
    && (container.dataset.dshMobileSurfacePlacement === 'page' || container.dataset.dshMobileSurfacePlacement === 'overlay')) {
    container.parentElement?.append(container)
  }
}

function visibleBackLayer(view: Window, element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.closest('[hidden],[inert],[aria-hidden="true"]') !== null) return false
  const style = view.getComputedStyle(element)
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
}

/**
 * Consume page-level surfaces and dismissible DSH overlays before layout navigation.
 * Composer model popups use DSH's Escape handling to return from a pane before closing.
 * @param view - the page window receiving the native Back request.
 * @param page - the current DSH document.
 * @param blocked - feedback for a foreground layer without a safe close action.
 * @returns a disposer for the capture listener.
 */
export function installMobileNativeBack(view: Window, page: Document, blocked: () => void): () => void {
  const onBack = (event: Event): void => {
    if (!event.cancelable || event.defaultPrevented) return
    const claim = (): void => { event.preventDefault(); event.stopImmediatePropagation() }
    if (closeClientModuleDialog()) { claim(); return }
    const surfaces = [...page.querySelectorAll<HTMLElement>('[data-dsh-mobile-surface-placement="page"], [data-dsh-mobile-surface-placement="overlay"]')]
    const surface = surfaces.filter(element => visibleBackLayer(view, element)).at(-1)
    if (surface !== undefined) {
      setMobileSurfaceOpen(surface, false)
      claim()
      return
    }

    const modelPopups = new Map<HTMLElement, HTMLElement>()
    for (const trigger of page.querySelectorAll<HTMLElement>('[data-dsh-mobile-composer-model-trigger][aria-expanded="true"]')) {
      const popupId = trigger.getAttribute('aria-controls')
      const popup = popupId === null ? null : page.getElementById(popupId)
      if (popup !== null && visibleBackLayer(view, trigger) && visibleBackLayer(view, popup)
        && (popup.getAttribute('role') === 'menu' || popup.getAttribute('role') === 'group')) {
        modelPopups.set(popup, trigger)
      }
    }
    const modalSelector = '[role="dialog"][aria-modal="true"], [role="menu"], [role="group"][id]'
    const layers = [...page.querySelectorAll<HTMLElement>(modalSelector)].filter(element => visibleBackLayer(view, element)
      && (element.getAttribute('role') !== 'group' || modelPopups.has(element)))
    const top = layers.at(-1)
    if (top === undefined) return
    claim()
    if (dismissMobileDirectoryPicker(top)) return
    const modelEntry = [...modelPopups].find(([popup]) => popup.contains(top))
    if (modelEntry !== undefined) {
      const [modelPopup, trigger] = modelEntry
      // Overlapping foreign layers do not establish that the model popup is foreground.
      if (layers.some(layer => !modelPopup.contains(layer))) { blocked(); return }
      const focused = page.activeElement
      const target = focused !== null && modelPopup.contains(focused) ? focused : trigger
      const escape = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })
      target.dispatchEvent(escape)
      if (!escape.defaultPrevented) blocked()
      return
    }
    if (top.getAttribute('role') === 'dialog') {
      const wrapper = top.parentElement
      const mask = wrapper?.firstElementChild as HTMLElement | null | undefined
      const maskStyle = mask === undefined || mask === null ? undefined : view.getComputedStyle(mask)
      if (wrapper?.getAttribute('role') === 'presentation' && wrapper.children.length === 2
        && wrapper.lastElementChild === top && mask?.tagName === 'DIV'
        && mask.getAttribute('aria-hidden') !== 'false' && mask.getAttribute('role') === null
        && mask.getAttribute('tabindex') === null && mask.getAttribute('contenteditable') === null
        && mask.children.length === 0 && (mask.textContent ?? '').trim() === '' && mask.isConnected && !mask.hidden
        && maskStyle?.display !== 'none' && maskStyle?.visibility !== 'hidden' && mask.getClientRects().length > 0) {
        mask.click()
        return
      }
    } else if (top.getAttribute('data-menu-material') === 'translucent'
      && layers.filter(layer => layer.getAttribute('role') === 'menu').length === 1) {
      // DSH Menu closes on an outside pointerdown. Dispatch on the document,
      // never on an arbitrary menu item or third-party action.
      page.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      return
    }
    blocked()
  }
  const capture = { capture: true }
  view.addEventListener('dsh-mobile:native-back', onBack, capture)
  return () => { view.removeEventListener('dsh-mobile:native-back', onBack, capture) }
}

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
      invoke(action: string, input?: unknown, options?: { readonly signal?: AbortSignal }): Promise<unknown>
    }
    __DSH_MOBILE_KEYBOARD_STATE__?: { readonly imeVisible: boolean; readonly noHardwareKeyboard: boolean } | null
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

/**
 * Guidance when an open third-party layer has no safe close action.
 * @param locale - current Mobile UI language.
 * @returns localized guidance.
 */
export function mobileBackBlockedMessage(locale: MobileControlLocale): string {
  const messages: Record<MobileControlLocale, string> = {
    en: 'Close the open panel first.',
    it: 'Chiudi prima il pannello aperto.',
    zh: '请先关闭当前弹层。',
  }
  return messages[locale]
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

interface MobileSwitchComputerCopy {
  readonly title: string
  readonly description: string
  readonly action: string
  readonly busy: string
  readonly retry: string
  readonly error: string
}

function mobileSwitchComputerCopy(locale: MobileControlLocale): MobileSwitchComputerCopy {
  if (locale === 'zh') return {
    title: '切换电脑',
    description: '返回已配对设备列表，选择要打开的电脑。',
    action: '切换电脑',
    busy: '正在切换…',
    retry: '重试',
    error: '切换失败，请重试。',
  }
  if (locale === 'it') return {
    title: 'Cambia computer',
    description: 'Torna all’elenco dei computer associati e scegli quale aprire.',
    action: 'Cambia computer',
    busy: 'Cambio in corso…',
    retry: 'Riprova',
    error: 'Cambio non riuscito. Riprova.',
  }
  return {
    title: 'Switch computer',
    description: 'Return to the paired-device list and choose a computer to open.',
    action: 'Switch computer',
    busy: 'Switching…',
    retry: 'Retry',
    error: 'Could not switch computers. Try again.',
  }
}

function useMobileNativeSettingsAction(action: MobileNativeSettingsAction) {
  const [controller] = useState(() => new MobileNativeSettingsActionController(action, () => window.__DSH_MOBILE_NATIVE__))
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    controller.start()
    window.addEventListener('dsh-mobile-native-ready', controller.refresh)
    return () => {
      window.removeEventListener('dsh-mobile-native-ready', controller.refresh)
      controller.stop()
    }
  }, [controller])
  return { ...snapshot, invoke: controller.invoke }
}

/** Render the native-app-only action in DSH's General settings row style. */
function MobileSwitchComputerRow(): unknown {
  const { supported, state, invoke } = useMobileNativeSettingsAction('mobile.switch-computer')
  if (!supported) return null
  const locale = selectedMobileControlLocale()
  const copy = mobileSwitchComputerCopy(locale)
  // Native navigation owns the successful WebView replacement.
  const busy = state === 'busy' || state === 'success'
  return createElement('div', { className: 'dsh-mobile-settings_row', lang: locale },
    createElement('div', { className: 'dsh-mobile-settings_rowText' },
      createElement('div', { className: 'dsh-mobile-settings_title' }, copy.title),
      createElement('div', { className: 'dsh-mobile-settings_desc', 'aria-live': 'polite' }, state === 'error' ? copy.error : copy.description),
    ),
    createElement('button', {
      type: 'button',
      className: 'dsh-mobile-settings_selector',
      disabled: busy,
      'aria-busy': busy ? 'true' : undefined,
      onClick: invoke,
    }, busy ? copy.busy : state === 'error' ? copy.retry : copy.action),
  )
}

interface MobileTaskNotificationCopy {
  readonly title: string
  readonly description: string
  readonly action: string
  readonly busy: string
  readonly success: string
  readonly reopen: string
  readonly error: string
  readonly retry: string
}

function mobileTaskNotificationCopy(locale: MobileControlLocale): MobileTaskNotificationCopy {
  if (locale === 'zh') return {
    title: '任务通知',
    description: '在 Android 系统中开启任务完成和待确认提醒。',
    action: '通知设置',
    busy: '正在打开…',
    success: '请在系统提示或设置中确认任务通知权限。',
    reopen: '重新打开',
    error: '无法打开通知设置，请重试。',
    retry: '重试',
  }
  if (locale === 'it') return {
    title: 'Notifiche delle attività',
    description: 'Attiva gli avvisi Android per le attività completate o in attesa di conferma.',
    action: 'Impostazioni notifiche',
    busy: 'Apertura…',
    success: 'Conferma il permesso nella richiesta o nelle impostazioni di sistema.',
    reopen: 'Riapri',
    error: 'Impossibile aprire le impostazioni delle notifiche. Riprova.',
    retry: 'Riprova',
  }
  return {
    title: 'Task notifications',
    description: 'Enable Android reminders for completed tasks and pending confirmation.',
    action: 'Notification settings',
    busy: 'Opening…',
    success: 'Confirm notification access in the system prompt or settings.',
    reopen: 'Open again',
    error: 'Could not open notification settings. Try again.',
    retry: 'Retry',
  }
}

/** Render the Android-only notification permission entry in DSH General settings. */
function MobileTaskNotificationRow(): unknown {
  const { supported, state, invoke } = useMobileNativeSettingsAction('notification.settings')
  if (!supported) return null
  const locale = selectedMobileControlLocale()
  const copy = mobileTaskNotificationCopy(locale)
  return createElement('div', { className: 'dsh-mobile-settings_row', lang: locale },
    createElement('div', { className: 'dsh-mobile-settings_rowText' },
      createElement('div', { className: 'dsh-mobile-settings_title' }, copy.title),
      createElement('div', { className: 'dsh-mobile-settings_desc', 'aria-live': 'polite' },
        state === 'success' ? copy.success : state === 'error' ? copy.error : copy.description),
    ),
    createElement('button', {
      type: 'button',
      className: 'dsh-mobile-settings_selector',
      disabled: state === 'busy',
      'aria-busy': state === 'busy' ? 'true' : undefined,
      onClick: invoke,
    }, state === 'busy' ? copy.busy : state === 'success' ? copy.reopen : state === 'error' ? copy.retry : copy.action),
  )
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
  /** Full 64-bit APK that also ships the optional iroh transport. */
  readonly androidIrohDownloadUrl?: string
  /** Published APK byte sizes resolved from the release assets. */
  readonly androidCompatBytes?: number
  readonly androidIrohBytes?: number
  /** Trimmed release notes body for the preview card (best effort). */
  readonly releaseNotes?: string
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
  const expectedAndroidDownloadUrls = androidVersion === undefined
    ? []
    : ['v', 'android-v'].map(prefix => `${GITHUB_RELEASES_URL}/download/${prefix}${androidVersion}/dsh-mobile-android-v${androidVersion}.apk`)
  const androidDownloadUrl = typeof data.androidDownloadUrl === 'string' && expectedAndroidDownloadUrls.includes(data.androidDownloadUrl)
    ? data.androidDownloadUrl
    : GITHUB_RELEASES_URL
  // The full build shares the same release tag and only adds the -iroh suffix, so
  // its URL is derived from the validated version instead of a separate response field.
  const androidIrohDownloadUrl = androidVersion === undefined || androidDownloadUrl === GITHUB_RELEASES_URL
    ? undefined
    : `${GITHUB_RELEASES_URL}/download/android-v${androidVersion}/dsh-mobile-android-v${androidVersion}-iroh.apk`
  return {
    updateAvailable: data.updateAvailable === true && latestVersion !== undefined,
    ...(latestVersion === undefined ? {} : { latestVersion }),
    ...(androidVersion === undefined ? {} : { androidVersion }),
    androidDownloadUrl,
    ...(androidIrohDownloadUrl === undefined ? {} : { androidIrohDownloadUrl }),
    ...(typeof data.androidCompatBytes === 'number' && data.androidCompatBytes > 0 ? { androidCompatBytes: data.androidCompatBytes } : {}),
    ...(typeof data.androidIrohBytes === 'number' && data.androidIrohBytes > 0 ? { androidIrohBytes: data.androidIrohBytes } : {}),
    ...(typeof data.releaseNotes === 'string' && data.releaseNotes !== '' ? { releaseNotes: data.releaseNotes.slice(0, 4000) } : {}),
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
      headers: localAdminRequestHeaders(init, location),
    })
    // Read the text first: a proxy, an older host, or a non-plugin route can answer
    // with a plain-text body, and response.json() would surface a raw SyntaxError.
    const text = await response.text()
    let body: Record<string, unknown> = {}
    if (text.trim() !== '') {
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error(!response.ok
          ? `HTTP ${String(response.status)} (${path})`
          : `${controlTranslator()('invalidResponse')} (${path})`)
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(!response.ok
          ? `HTTP ${String(response.status)} (${path})`
          : `${controlTranslator()('invalidResponse')} (${path})`)
      }
      body = parsed as Record<string, unknown>
    }
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

/** Raw attach form values exactly as typed in the panel. */
export interface FrpAttachClipboardForm {
  readonly serverAddress: string
  readonly serverPort: number
  readonly token: string
  readonly publicOrigin: string
  readonly entryTls: 'public-ip-cert' | 'self-signed'
  readonly vhostHttpPort?: number
  readonly publicPort?: number
}

/**
 * Options of the two attach artefacts the panel builds locally.
 *
 * `revealToken` defaults to false, so the ordinary copy button always produces
 * masked text. Only the dedicated reveal action sets it, and its result goes
 * straight to the clipboard — never into a stored state, a log, or localStorage.
 */
export interface FrpAttachClipboardOptions {
  readonly revealToken?: boolean
  /**
   * Installation-derived proxy name reported by the host's FRP configuration.
   *
   * The panel rebuilds the token-bearing frpc.toml locally (the saved token never
   * leaves the host), so it needs the same name the provider writes; without it
   * the copied file would register the legacy fixed name and collide on a shared
   * frps. Omitted only by legacy callers.
   */
  readonly proxyName?: string
}

/**
 * Validate the panel form with the same parser the host uses, so a runbook can
 * never describe a topology the provider would later refuse to start.
 */
function attachClipboardSettings(form: FrpAttachClipboardForm): FrpSettings {
  return parseFrpSettings({
    serverAddress: form.serverAddress,
    serverPort: form.serverPort,
    token: form.token,
    publicOrigin: form.publicOrigin,
    mode: 'attach',
    entryTls: form.entryTls,
    ...(form.entryTls === 'self-signed' || form.vhostHttpPort === undefined
      ? {}
      : { vhostHttpPort: form.vhostHttpPort }),
    ...(form.publicPort === undefined ? {} : { publicPort: form.publicPort }),
  })
}

/**
 * Build the copy-only attach runbook locally, so the shared token never leaves
 * the browser: the panel only ever copies text out. The text is masked by
 * default; `options.revealToken` is the explicit opt-in.
 */
export function createFrpAttachTemplateForClipboard(
  form: FrpAttachClipboardForm,
  options: FrpAttachClipboardOptions = {},
): string {
  return createFrpAttachTemplate(attachClipboardSettings(form), options)
}

/**
 * The frpc.toml exactly as the plugin writes it (0600), for the panel's explicit
 * reveal action only. Every other path keeps the token masked.
 */
export function createFrpAttachFrpcTomlForClipboard(
  form: FrpAttachClipboardForm,
  options: FrpAttachClipboardOptions = {},
): string {
  return createFrpAttachFrpcToml(attachClipboardSettings(form), options)
}

/**
 * Attach-mode validation for the panel. The parser is the single source of
 * truth, so the panel reports exactly the codes the host would return instead of
 * duplicating the rules (and drifting from them).
 */
export function frpAttachFormErrorCode(form: FrpAttachClipboardForm): string | undefined {
  try {
    createFrpAttachTemplateForClipboard(form)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : 'frp_settings_invalid'
  }
}

const ORIGIN_ERROR_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  origin_public_origin_invalid: 'originPublicOriginInvalid',
  origin_listen_host_invalid: 'originListenHostInvalid',
  origin_listen_port_invalid: 'originListenPortInvalid',
  origin_listen_port_reserved: 'originListenPortReserved',
  origin_allowed_cidrs_invalid: 'originAllowedCidrsInvalid',
  origin_settings_invalid: 'originSettingsInvalid',
  origin_config_missing: 'originConfigMissing',
  origin_config_invalid: 'originConfigInvalid',
  origin_config_target_invalid: 'originConfigTargetInvalid',
  origin_controller_unavailable: 'originControllerUnavailable',
  origin_listen_port_in_use: 'originPortInUse',
  origin_listen_address_unavailable: 'originAddressUnavailable',
  origin_gateway_start_failed: 'originStartFailed',
}

/** Provider failure codes shared by status, failed requests, and diagnostics. */
const REMOTE_ERROR_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  funnel_permission_required: 'funnelPermission',
  funnel_https_required: 'funnelHttps',
  funnel_start_failed: 'funnelStart',
  funnel_start_timeout: 'funnelTimeout',
  funnel_state_invalid: 'funnelStateInvalid',
  cpolar_path_invalid: 'componentPathUnsafe',
  cloudflared_path_invalid: 'componentPathUnsafe',
  cloudflared_tunnel_path_invalid: 'componentPathUnsafe',
  frp_path_invalid: 'componentPathUnsafe',
  frp_config_path_invalid: 'componentPathUnsafe',
  frp_ingress_path_invalid: 'componentPathUnsafe',
  caddy_path_invalid: 'componentPathUnsafe',
  tailscale_dns_missing: 'tailscaleDnsMissing',
  gateway_start_failed: 'gatewayStartFailed',
  control_channel_failed: 'controlChannelFailed',
  cpolar_component_missing: 'cpolarMissing',
  cpolar_component_invalid: 'cpolarInvalid',
  cpolar_download_failed: 'cpolarDownloadFailed',
  cpolar_download_timeout: 'cpolarDownloadTimeout',
  cpolar_download_size_mismatch: 'cpolarIntegrityFailed',
  cpolar_download_hash_mismatch: 'cpolarIntegrityFailed',
  cpolar_executable_hash_mismatch: 'cpolarIntegrityFailed',
  cpolar_download_redirect_missing: 'cpolarDownloadFailed',
  cpolar_download_redirect_invalid: 'cpolarDownloadFailed',
  cpolar_download_redirect_rejected: 'cpolarDownloadFailed',
  cpolar_installer_missing: 'cpolarExtractFailed',
  cpolar_executable_missing: 'cpolarExtractFailed',
  cpolar_extract_failed: 'cpolarExtractFailed',
  cpolar_extract_tools_failed: 'cpolarExtractToolsFailed',
  cpolar_extract_archive_failed: 'cpolarExtractArchiveFailed',
  cpolar_extract_database_failed: 'cpolarExtractDatabaseFailed',
  cpolar_extract_cabinet_failed: 'cpolarExtractCabinetFailed',
  cpolar_extract_file_failed: 'cpolarExtractFileFailed',
  cpolar_storage_failed: 'cpolarStorageFailed',
  cpolar_config_missing: 'cpolarConfigMissing',
  cpolar_config_invalid: 'cpolarConfigInvalid',
  cpolar_port_unavailable: 'cpolarPortUnavailable',
  cpolar_launch_failed: 'cpolarLaunchFailed',
  cpolar_start_timeout: 'cpolarTimeout',
  cpolar_stopped: 'cpolarStopped',
  cpolar_exited: 'cpolarExited',
  cpolar_invalid_output: 'cpolarOutputInvalid',
  cpolar_invalid_origin: 'cpolarOriginInvalid',
  cloudflared_component_missing: 'cloudflaredMissing',
  cloudflared_component_invalid: 'cloudflaredInvalid',
  cloudflared_port_unavailable: 'cloudflaredPortUnavailable',
  cloudflared_launch_failed: 'cloudflaredLaunchFailed',
  cloudflared_start_timeout: 'cloudflaredTimeout',
  cloudflared_stopped: 'cloudflaredStopped',
  cloudflared_exited: 'cloudflaredExited',
  cloudflared_invalid_output: 'cloudflaredOutputInvalid',
  cloudflared_invalid_origin: 'cloudflaredOriginInvalid',
  cloudflared_tunnel_port_unavailable: 'cloudflaredTunnelPortUnavailable',
  cloudflared_tunnel_hostname_invalid: 'cloudflaredTunnelHostnameInvalid',
  cloudflared_tunnel_port_invalid: 'cloudflaredTunnelPortInvalid',
  cloudflared_tunnel_port_reserved: 'cloudflaredTunnelPortReserved',
  cloudflared_tunnel_token_invalid: 'cloudflaredTunnelTokenInvalid',
  cloudflared_tunnel_settings_invalid: 'cloudflaredTunnelSettingsInvalid',
  cloudflared_tunnel_config_missing: 'cloudflaredTunnelConfigMissing',
  cloudflared_tunnel_config_invalid: 'cloudflaredTunnelInvalid',
  cloudflared_tunnel_target_invalid: 'cloudflaredTunnelTargetInvalid',
  cloudflared_component_unsupported: 'cloudflaredComponentUnsupported',
  cloudflared_download_hash_mismatch: 'cloudflaredDownloadHashMismatch',
  cloudflared_download_size_mismatch: 'cloudflaredDownloadSizeMismatch',
  cloudflared_executable_hash_mismatch: 'cloudflaredExecutableHashMismatch',
  cloudflared_download_redirect_missing: 'cloudflaredDownloadRedirectMissing',
  cloudflared_download_redirect_invalid: 'cloudflaredDownloadRedirectInvalid',
  cloudflared_download_redirect_rejected: 'cloudflaredDownloadRedirectRejected',
  cloudflared_port_reservation_failed: 'cloudflaredPortReservationFailed',
  frp_component_missing: 'frpMissing',
  frp_component_invalid: 'frpInvalid',
  frp_config_missing: 'frpConfigMissing',
  frp_config_verify_failed: 'frpConfigVerifyFailed',
  frp_vhost_publicly_reachable: 'frpVhostPublic',
  frp_vhost_probe_failed: 'frpVhostProbeFailed',
  frp_launch_failed: 'frpLaunchFailed',
  frp_start_timeout: 'frpTimeout',
  frp_proxy_name_in_use: 'frpProxyNameInUse',
  frp_remote_port_in_use: 'frpRemotePortInUse',
  frp_proxy_start_failed: 'frpProxyStartFailed',
  frp_discovery_mismatch: 'frpDiscoveryMismatch',
  frp_discovery_invalid: 'frpDiscoveryInvalid',
  frp_stopped: 'frpStopped',
  frp_exited: 'frpExited',
  iroh_companion_missing: 'irohCompanionMissing',
  iroh_data_directory_invalid: 'irohDataDirectoryInvalid',
  iroh_sidecar_invalid: 'irohSidecarInvalid',
  iroh_download_failed: 'irohDownloadFailed',
  iroh_download_size_mismatch: 'irohDownloadFailed',
  iroh_download_hash_mismatch: 'irohSidecarInvalid',
  iroh_download_timeout: 'irohTimeout',
  iroh_platform_unsupported: 'irohPlatformUnsupported',
  iroh_identity_failed: 'irohIdentityFailed',
  iroh_identity_timeout: 'irohIdentityFailed',
  iroh_identity_invalid: 'irohIdentityFailed',
  iroh_launch_failed: 'irohLaunchFailed',
  iroh_start_timeout: 'irohTimeout',
  iroh_start_failed: 'irohLaunchFailed',
  iroh_exited: 'irohExited',
  iroh_not_ready: 'irohNotReady',
  iroh_pairing_failed: 'irohPairingFailed',
  iroh_component_running: 'irohComponentRunning',
  frp_server_address_invalid: 'frpServerAddressInvalid',
  frp_server_port_invalid: 'frpServerPortInvalid',
  frp_token_invalid: 'frpTokenInvalid',
  frp_public_origin_invalid: 'frpPublicOriginInvalid',
  frp_attach_mode_requires_vhost_port: 'frpAttachModeRequiresVhostPort',
  frp_attach_cert_unknown: 'frpAttachCertUnknownError',
  frp_entry_tls_invalid: 'frpEntryTlsInvalid',
  frp_self_signed_requires_public_ipv4: 'frpSelfSignedRequiresPublicIpv4',
  frp_ingress_ca_expired: 'frpIngressCaExpired',
  frp_ingress_ca_invalid: 'frpIngressCaInvalid',
  frp_ingress_ca_changed: 'frpIngressCaChanged',
  frp_ingress_renewal_failed: 'frpIngressRenewalFailed',
  ...ORIGIN_ERROR_MESSAGE_KEYS,
}

const DIAGNOSTIC_CONTROLLER_ACTION_OVERRIDES: Readonly<Record<string, string>> = {
  component_missing: 'remoteUnavailableTailscale',
  sidecar_launch_failed: 'remoteUnavailableTailscale',
  sidecar_stopped: 'controlChannelFailed',
  sidecar_exited: 'controlChannelFailed',
}

/** Only codes with a specific diagnostic action use the status message key. */
const DIAGNOSTIC_CONTROLLER_ACTION_CODES: ReadonlySet<string> = new Set([
  ...Object.keys(ORIGIN_ERROR_MESSAGE_KEYS),
  'funnel_permission_required', 'funnel_https_required', 'funnel_start_failed', 'funnel_start_timeout',
  'tailscale_dns_missing', 'control_channel_failed', 'gateway_start_failed',
  'cpolar_component_missing', 'cpolar_component_invalid', 'cpolar_config_missing', 'cpolar_config_invalid',
  'cpolar_extract_tools_failed', 'cpolar_extract_archive_failed', 'cpolar_extract_database_failed',
  'cpolar_extract_cabinet_failed', 'cpolar_extract_file_failed',
  'funnel_state_invalid',
  'cpolar_start_timeout', 'cpolar_stopped', 'cpolar_exited',
  'cloudflared_component_missing', 'cloudflared_component_invalid', 'cloudflared_component_unsupported',
  'cloudflared_port_unavailable', 'cloudflared_port_reservation_failed', 'cloudflared_launch_failed',
  'cloudflared_start_timeout', 'cloudflared_stopped', 'cloudflared_exited', 'cloudflared_invalid_origin',
  'cloudflared_tunnel_port_unavailable', 'cloudflared_tunnel_config_invalid', 'cloudflared_tunnel_target_invalid',
  'cloudflared_download_hash_mismatch', 'cloudflared_download_size_mismatch', 'cloudflared_executable_hash_mismatch',
  'frp_component_missing', 'frp_component_invalid', 'frp_config_missing', 'frp_config_verify_failed',
  'frp_vhost_publicly_reachable', 'frp_vhost_probe_failed', 'frp_launch_failed', 'frp_start_timeout',
  'frp_proxy_name_in_use', 'frp_remote_port_in_use', 'frp_proxy_start_failed',
  'frp_discovery_mismatch', 'frp_discovery_invalid', 'frp_stopped', 'frp_exited',
  'frp_attach_mode_requires_vhost_port', 'frp_attach_cert_unknown', 'frp_entry_tls_invalid',
  'frp_self_signed_requires_public_ipv4', 'frp_ingress_ca_expired', 'frp_ingress_ca_invalid',
  'frp_ingress_ca_changed', 'frp_ingress_renewal_failed',
])

/** Resolve the next-step text for a remote-controller diagnostic. */
export function diagnosticControllerAction(code: unknown, locale: MobileControlLocale, fallback: string): string {
  if (typeof code !== 'string') return fallback
  const key = (Object.prototype.hasOwnProperty.call(DIAGNOSTIC_CONTROLLER_ACTION_OVERRIDES, code)
    ? DIAGNOSTIC_CONTROLLER_ACTION_OVERRIDES[code] : undefined)
    ?? (DIAGNOSTIC_CONTROLLER_ACTION_CODES.has(code) ? REMOTE_ERROR_MESSAGE_KEYS[code] : undefined)
  return key === undefined ? fallback : controlTranslator(locale)(key)
}

/**
 * Localize a diagnostic entry, retaining Host text for unknown diagnostic reasons.
 * @param entry Diagnostic fields received from the control API.
 * @param locale Language of the mounted control panel.
 * @param versions Optional version fields from the diagnostic response.
 * @returns Detail and next-step text shared by the visible card and copied report.
 */
export function localizedDiagnosticEntryCopy(
  entry: Readonly<Record<string, unknown>>,
  locale: MobileControlLocale,
  versions?: unknown,
): { readonly detail: string; readonly action: string } {
  const t = controlTranslator(locale)
  const localeTag = locale === 'it' ? 'it-IT' : locale === 'zh' ? 'zh-CN' : 'en-US'
  const serverCopy = diagnosticServerCopy(entry)
  const reason = typeof entry.reason === 'string' ? entry.reason : ''
  const facts = entry.facts !== null && typeof entry.facts === 'object' ? entry.facts as Record<string, unknown> : {}
  const copyReason = facts.viaProxy === true && (reason === 'remote-ready' || reason === 'remote-rate-limited')
    ? `${reason}-via-proxy` : reason
  const catalog = DIAGNOSTIC_REASON_MESSAGES[locale] as Readonly<Record<string, readonly [string, string]>>
  const networkCatalog = DIAGNOSTIC_NETWORK_MESSAGES[locale] as Readonly<Record<string, readonly [string, string]>>
  const templates = Object.prototype.hasOwnProperty.call(networkCatalog, copyReason) ? networkCatalog[copyReason]
    : Object.prototype.hasOwnProperty.call(catalog, copyReason) ? catalog[copyReason] : undefined
  if (templates === undefined) return serverCopy
  const providerNames: Record<string, string> = {
    tailscale: 'Tailscale Funnel', cpolar: 'cpolar', cloudflared: 'cloudflared',
    frp: t('frpName'), origin: t('originName'), iroh: t('irohName'),
  }
  const providerId = typeof facts.provider === 'string' ? facts.provider : ''
  const controllerCode = typeof facts.controllerCode === 'string' ? facts.controllerCode : ''
  const controllerKey = Object.prototype.hasOwnProperty.call(REMOTE_ERROR_MESSAGE_KEYS, controllerCode)
    ? REMOTE_ERROR_MESSAGE_KEYS[controllerCode] : undefined
  const values: Record<string, string> = {
    provider: providerNames[providerId] ?? '',
    latencyMs: typeof facts.latencyMs === 'number' && Number.isFinite(facts.latencyMs) ? new Intl.NumberFormat(localeTag).format(facts.latencyMs) : '',
    interfaceName: typeof facts.interfaceName === 'string' ? facts.interfaceName : '',
    endpointSuffix: typeof facts.endpointSuffix === 'string' ? facts.endpointSuffix : '',
    controllerCode,
  }
  const interpolate = (template: string): string => template.replace(/\{(\w+)\}/gu, (_match, key: string) => values[key] ?? '')
  let detail = reason === 'remote-controller-error' && controllerCode === '' ? t('remoteError') : interpolate(templates[0])
  let action = interpolate(templates[1])
  if (reason.startsWith('dns-')) {
    const families: Readonly<Record<string, string>> = { ipv4: 'IPv4', ipv6: 'IPv6', dual: 'IPv4 + IPv6' }
    const family = typeof facts.dnsFamily === 'string' && Object.hasOwn(families, facts.dnsFamily) ? families[facts.dnsFamily] : undefined
    if (family !== undefined) detail += ` (${family})`
  }
  if (reason === 'versions-current') {
    const fields = versions !== null && typeof versions === 'object' ? versions as Record<string, unknown> : {}
    if ([fields.plugin, fields.dsh, fields.minimumAndroidApp].every(value => typeof value === 'string')) {
      detail += ` plugin ${String(fields.plugin)}, DSH ${String(fields.dsh)}, Android ${String(fields.minimumAndroidApp)}.`
    }
  }
  if (reason === 'remote-controller-error') {
    action = diagnosticControllerAction(controllerCode, locale, controllerKey === undefined ? action : t(controllerKey))
  }
  return { detail, action }
}

function installControl(): { remove: () => void; toggle: () => void; isOpen: () => boolean } {

  /** The table above, translated, for the status repaint. */
  const translatedRemoteErrors = (): Record<string, string> =>
    Object.fromEntries(Object.entries(REMOTE_ERROR_MESSAGE_KEYS).map(([code, key]) => [code, t(key)]))

  /**
   * Text for a failed control request.
   *
   * A rejection carries its code in `error.message`, so a known code renders its
   * translated sentence; only an unrecognized one falls back to the generic message,
   * and it shows the bare message rather than a stringified Error.
   */
  const remoteFailureTextFor = (error: unknown, fallbackKey: string): string => {
    const message = error instanceof Error ? error.message : String(error)
    const cpolarHttpStatus = /^cpolar_download_http_(\d{3})$/u.exec(message)?.[1]
    if (cpolarHttpStatus !== undefined) return t('cpolarDownloadHttp', { status: cpolarHttpStatus })
    const key = REMOTE_ERROR_MESSAGE_KEYS[message]
    return key === undefined ? t(fallbackKey, { error: message }) : t(key)
  }
  const locale = selectedMobileControlLocale()
  const localeTag = locale === 'it' ? 'it-IT' : locale === 'zh' ? 'zh-CN' : 'en-US'
  const t = controlTranslator(locale)
  const lifecycle = new AbortController()
  const controlRequestJson = (path: string, init?: RequestInit, timeoutMs?: number): Promise<Record<string, unknown>> => requestJson(path, { ...init, signal: lifecycle.signal }, timeoutMs)
  const extensionRecovery = installExtensionRecoveryControl({ document, signal: lifecycle.signal, request: controlRequestJson, confirm: message => window.confirm(message), translate: t })
  const root = element('div', 'dsh-mobile-control'); root.lang = locale
  const panel = element('section', 'dsh-mobile-control__panel'); panel.id = CONTROL_PANEL_ID; panel.hidden = true; panel.lang = locale
  panel.setAttribute('aria-label', t('mobileAccess'))
  const header = element('header', 'dsh-mobile-control__header')
  const title = element('h2'); title.textContent = t('mobileAccess')
  const headerActions = element('div', 'dsh-mobile-control__header-actions')
  const updatePlugin = element('button', 'dsh-mobile-control__update-plugin'); updatePlugin.type = 'button'; updatePlugin.textContent = t('updatePlugin'); updatePlugin.hidden = true
  // Preview card shown before applying an update: what’s new + notices, then confirm.
  const updateCard = element('div', 'dsh-mobile-control__update-card'); updateCard.hidden = true
  const updateCardTitle = element('div', 'dsh-mobile-control__update-card-title')
  const updateCardNotes = element('pre', 'dsh-mobile-control__update-notes'); updateCardNotes.setAttribute('tabindex', '0')
  const updateCardNotice = element('p', 'dsh-mobile-control__update-notice'); updateCardNotice.textContent = t('updateNotice')
  const updateActions = element('div', 'dsh-mobile-control__update-actions')
  const updateNow = element('button', 'dsh-mobile-control__primary'); updateNow.type = 'button'; updateNow.textContent = t('updateNow')
  const updateLater = element('button', 'dsh-mobile-control__secondary'); updateLater.type = 'button'; updateLater.textContent = t('updateLater')
  updateActions.append(updateLater, updateNow); updateCard.append(updateCardTitle, updateCardNotes, updateCardNotice, updateActions)
  const diagnosticsEntry = element('button', 'dsh-mobile-control__diagnostic-entry'); diagnosticsEntry.type = 'button'; diagnosticsEntry.textContent = t('diagnostics'); diagnosticsEntry.setAttribute('aria-label', t('openDiagnostics')); diagnosticsEntry.setAttribute('aria-pressed', 'false')
  const close = element('button', 'dsh-mobile-control__close'); close.type = 'button'; close.textContent = '×'; close.setAttribute('aria-label', t('collapseMobileAccess'))
  const devicesEntry = element('button', 'dsh-mobile-control__diagnostic-entry'); devicesEntry.type = 'button'; devicesEntry.textContent = t('device'); devicesEntry.setAttribute('aria-label', t('managePairedDevices')); devicesEntry.setAttribute('aria-pressed', 'false')
  headerActions.append(updatePlugin, diagnosticsEntry, devicesEntry, close)
  const releaseNotice = element('p', 'dsh-mobile-control__release-notice'); releaseNotice.hidden = true; releaseNotice.setAttribute('role', 'status'); releaseNotice.setAttribute('aria-live', 'polite')
  // Two App builds exist: the compatibility APK (32-bit friendly, no iroh) and the
  // full 64-bit APK that adds the optional iroh transport.
  const appDownloads = element('div', 'dsh-mobile-control__app-downloads')
  const appDownload = element('a', 'dsh-mobile-control__app-download'); appDownload.href = GITHUB_RELEASES_URL; appDownload.target = '_blank'; appDownload.rel = 'noopener noreferrer'; appDownload.textContent = t('downloadAndroid'); appDownload.setAttribute('aria-label', t('downloadAndroidAria'))
  const appDownloadIroh = element('a', 'dsh-mobile-control__app-download is-iroh'); appDownloadIroh.href = GITHUB_RELEASES_URL; appDownloadIroh.target = '_blank'; appDownloadIroh.rel = 'noopener noreferrer'; appDownloadIroh.textContent = t('downloadAndroidIroh'); appDownloadIroh.setAttribute('aria-label', t('downloadAndroidIrohAria')); appDownloadIroh.hidden = true
  appDownloads.append(appDownload, appDownloadIroh)
  const switcher = element('div', 'dsh-mobile-control__switcher')
  const lanTab = element('button', 'dsh-mobile-control__tab is-active'); lanTab.type = 'button'; lanTab.textContent = t('lan')
  const remoteTab = element('button', 'dsh-mobile-control__tab'); remoteTab.type = 'button'; remoteTab.textContent = t('remote')
  lanTab.setAttribute('aria-pressed', 'true'); remoteTab.setAttribute('aria-pressed', 'false'); switcher.append(lanTab, remoteTab)
  const lanView = element('div', 'dsh-mobile-control__view')
  const lanSetup = element('section', 'dsh-mobile-control__lan-setup'); lanSetup.hidden = true
  const lanSetupTitle = element('h3', 'dsh-mobile-control__section-title'); lanSetupTitle.textContent = t('lanSetupTitle')
  const lanSetupIntro = element('p', 'dsh-mobile-control__intro'); lanSetupIntro.textContent = t('lanSetupIntro')
  const lanSetupForm = element('div', 'dsh-mobile-control__lan-setup-form')
  const lanSetupLabel = element('label', 'dsh-mobile-control__field'); lanSetupLabel.textContent = t('lanSetupNetwork')
  const lanSetupSelect = element('select'); lanSetupSelect.setAttribute('aria-label', t('lanSetupNetwork'))
  const lanSetupNote = element('p', 'dsh-mobile-control__component-note'); lanSetupNote.textContent = t('lanSetupFirewallNote')
  const lanSetupActions = element('div', 'dsh-mobile-control__lan-setup-actions')
  const lanSetupRefresh = element('button', 'dsh-mobile-control__secondary'); lanSetupRefresh.type = 'button'; lanSetupRefresh.textContent = t('lanSetupRefresh')
  const lanSetupConfigure = element('button', 'dsh-mobile-control__primary'); lanSetupConfigure.type = 'button'; lanSetupConfigure.textContent = t('lanSetupConfigure')
  const lanSetupStatus = element('p', 'dsh-mobile-control__status'); lanSetupStatus.setAttribute('role', 'status'); lanSetupStatus.setAttribute('aria-live', 'polite')
  // Changing the bound network after setup: re-enumerate interfaces, confirm, keep CA/pairings.
  const lanChange = element('section', 'dsh-mobile-control__lan-setup'); lanChange.hidden = true
  const lanChangeTitle = element('h3', 'dsh-mobile-control__section-title'); lanChangeTitle.textContent = t('lanChangeTitle')
  const lanChangeIntro = element('p', 'dsh-mobile-control__intro'); lanChangeIntro.textContent = t('lanChangeIntro')
  const lanChangeForm = element('div', 'dsh-mobile-control__lan-setup-form')
  const lanChangeLabel = element('label', 'dsh-mobile-control__field'); lanChangeLabel.textContent = t('lanChangeSelect')
  const lanChangeSelect = element('select'); lanChangeSelect.setAttribute('aria-label', t('lanChangeSelect'))
  lanChangeLabel.append(lanChangeSelect)
  const lanChangeActions = element('div', 'dsh-mobile-control__lan-setup-actions')
  const lanChangeRefresh = element('button', 'dsh-mobile-control__secondary'); lanChangeRefresh.type = 'button'; lanChangeRefresh.textContent = t('lanChangeRefresh')
  const lanChangeConfirm = element('button', 'dsh-mobile-control__primary'); lanChangeConfirm.type = 'button'; lanChangeConfirm.textContent = t('lanChangeConfirm')
  lanChangeActions.append(lanChangeRefresh, lanChangeConfirm)
  const lanChangeStatus = element('p', 'dsh-mobile-control__status'); lanChangeStatus.setAttribute('role', 'status'); lanChangeStatus.setAttribute('aria-live', 'polite')
  lanChangeForm.append(lanChangeLabel, lanChangeActions)
  lanChange.append(lanChangeTitle, lanChangeIntro, lanChangeForm, lanChangeStatus)
  const trustedNetworks = element('details', 'dsh-mobile-control__details')
  const trustedNetworksSummary = element('summary'); trustedNetworksSummary.textContent = t('trustedNetworksTitle')
  const trustedNetworksHelp = element('p', 'dsh-mobile-control__component-note'); trustedNetworksHelp.textContent = t('trustedNetworksHelp')
  const trustedNetworksLabel = element('label', 'dsh-mobile-control__field'); trustedNetworksLabel.textContent = t('trustedNetworksLabel')
  const trustedNetworksInput = element('textarea'); trustedNetworksInput.rows = 2; trustedNetworksInput.placeholder = '11.24.0.0/24\n2001:db8::/32'; trustedNetworksInput.autocomplete = 'off'; trustedNetworksInput.spellcheck = false
  const trustedNetworksSave = element('button', 'dsh-mobile-control__secondary'); trustedNetworksSave.type = 'button'; trustedNetworksSave.textContent = t('trustedNetworksSave')
  const trustedNetworksStatus = element('p', 'dsh-mobile-control__status'); trustedNetworksStatus.setAttribute('role', 'status'); trustedNetworksStatus.setAttribute('aria-live', 'polite')
  trustedNetworksLabel.append(trustedNetworksInput); trustedNetworks.append(trustedNetworksSummary, trustedNetworksHelp, trustedNetworksLabel, trustedNetworksSave, trustedNetworksStatus)
  let trustedNetworksLoaded = false
  let trustedNetworksLoading = false
  let trustedNetworksSupported = false
  let trustedNetworksDirty = false
  let trustedNetworksBusy = false
  const syncTrustedNetworksControls = (): void => {
    const enabled = trustedNetworksLoaded && trustedNetworksSupported && !trustedNetworksLoading && !trustedNetworksBusy
    trustedNetworksInput.disabled = !enabled
    trustedNetworksSave.disabled = !enabled
    trustedNetworks.setAttribute('aria-busy', String(trustedNetworksLoading || trustedNetworksBusy))
  }
  syncTrustedNetworksControls()
  const renderTrustedNetworks = (data: Record<string, unknown>): void => {
    trustedNetworksLoaded = true
    trustedNetworksSupported = data.supported === true
    syncTrustedNetworksControls()
    if (!trustedNetworksDirty) trustedNetworksInput.value = Array.isArray(data.extraAllowedCidrs) ? data.extraAllowedCidrs.filter(value => typeof value === 'string').join('\n') : ''
    trustedNetworksStatus.textContent = !trustedNetworksSupported ? t('trustedNetworksUnavailable') : data.restartRequired === true ? t('trustedNetworksRestart') : ''
    trustedNetworksHelp.textContent = `${t('trustedNetworksHelp')}${data.windowsFirewall === true ? ` ${t('trustedNetworksWindows')}` : ''}`
  }
  trustedNetworks.addEventListener('toggle', () => {
    if (!trustedNetworks.open || trustedNetworksLoaded || trustedNetworksLoading) return
    trustedNetworksLoading = true
    syncTrustedNetworksControls()
    trustedNetworksStatus.textContent = t('loadingStatus')
    void controlRequestJson('/api/mobile-access/lan/trusted-networks').then(renderTrustedNetworks, () => {
      trustedNetworksLoaded = false; trustedNetworksSupported = false; trustedNetworksStatus.textContent = t('trustedNetworksFailed')
    }).finally(() => { trustedNetworksLoading = false; syncTrustedNetworksControls() })
  })
  trustedNetworksInput.addEventListener('input', () => { trustedNetworksDirty = true; trustedNetworksInput.removeAttribute('aria-invalid') })
  trustedNetworksSave.addEventListener('click', () => {
    if (trustedNetworksBusy || !trustedNetworksLoaded || !trustedNetworksSupported) return
    trustedNetworksBusy = true; syncTrustedNetworksControls()
    const extraAllowedCidrs = trustedNetworksInput.value.trim().split(/[\s,]+/u).filter(Boolean)
    void controlRequestJson('/api/mobile-access/lan/trusted-networks', { method: 'POST', body: JSON.stringify({ extraAllowedCidrs }) }).then(data => {
      trustedNetworksDirty = false; renderTrustedNetworks(data)
    }, () => { trustedNetworksStatus.textContent = t('trustedNetworksInvalid'); trustedNetworksInput.setAttribute('aria-invalid', 'true') }).finally(() => {
      trustedNetworksBusy = false; syncTrustedNetworksControls()
    })
  })
  lanSetupLabel.append(lanSetupSelect); lanSetupActions.append(lanSetupRefresh, lanSetupConfigure); lanSetupForm.append(lanSetupLabel, lanSetupNote, lanSetupActions); lanSetup.append(lanSetupTitle, lanSetupIntro, lanSetupForm, lanSetupStatus)
  const access = element('div', 'dsh-mobile-control__access'); access.hidden = true
  const accessLabel = element('span', 'dsh-mobile-control__access-label'); accessLabel.textContent = t('browserAccess')
  const accessLink = element('a', 'dsh-mobile-control__access-link'); accessLink.target = '_blank'; accessLink.rel = 'noreferrer'
  access.append(accessLabel, accessLink)
  const qrBox = element('div', 'dsh-mobile-control__qr')
  const lanPairingValidity = element('p', 'dsh-mobile-control__component-status'); lanPairingValidity.hidden = true
  let activeLanPairUrl = ''
  let activeLanPairExpiresAt = 0
  let lanPairingBusy = false
  let lanPairingGeneration = 0
  const status = element('p', 'dsh-mobile-control__status'); status.textContent = t('loadingStatus')
  const extensionStatus = element('p', 'dsh-mobile-control__extensions'); extensionStatus.hidden = true
  const actions = element('div', 'dsh-mobile-control__actions')
  const toggle = element('button', 'dsh-mobile-control__secondary'); toggle.type = 'button'
  const pair = element('button', 'dsh-mobile-control__primary'); pair.type = 'button'; pair.textContent = t('generateCopyKey')
  const linkPair = element('button', 'dsh-mobile-control__secondary'); linkPair.type = 'button'; linkPair.textContent = t('copyPairLink')
  const manageRow = element('div', 'dsh-mobile-control__manage-row')
  const manageDevices = element('button', 'dsh-mobile-control__manage'); manageDevices.type = 'button'; manageDevices.textContent = t('managePairedDevices')
  const resetAll = element('button', 'dsh-mobile-control__manage'); resetAll.type = 'button'; resetAll.textContent = t('clearAllDevices')
  manageRow.append(manageDevices)
  const devicePanel = element('div', 'dsh-mobile-control__devices')
  const remoteView = element('div', 'dsh-mobile-control__view is-remote')
  const remoteIntro = element('p', 'dsh-mobile-control__intro'); remoteIntro.textContent = t('remoteIntro')
  const httpFrameWarning = element('p', 'dsh-mobile-control__http-frame-warning'); httpFrameWarning.textContent = t('httpFrameWarning'); httpFrameWarning.hidden = location.protocol !== 'https:'; httpFrameWarning.setAttribute('role', 'note')
  const providerSection = element('section', 'dsh-mobile-control__provider-section')
  const providerHeading = element('h3', 'dsh-mobile-control__section-title'); providerHeading.textContent = t('chooseProvider')
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
  const cloudflaredChoice = element('button', 'dsh-mobile-control__provider'); cloudflaredChoice.type = 'button'; cloudflaredChoice.setAttribute('role', 'radio'); cloudflaredChoice.setAttribute('aria-checked', 'false')
  const cloudflaredChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const cloudflaredChoiceName = element('strong'); cloudflaredChoiceName.textContent = 'cloudflared'
  const cloudflaredChoiceBadge = element('span', 'dsh-mobile-control__provider-badge'); cloudflaredChoiceBadge.textContent = t('cloudflaredBadge')
  const cloudflaredChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); cloudflaredChoiceDescription.textContent = t('cloudflaredDescription')
  cloudflaredChoiceTop.append(cloudflaredChoiceName, cloudflaredChoiceBadge); cloudflaredChoice.append(cloudflaredChoiceTop, cloudflaredChoiceDescription)
  providerChoices.append(cpolarChoice, cloudflaredChoice, tailscaleChoice)
  // ARIA radios normally move focus and selection together, but choosing a provider switches
  // the remote channel behind a confirmation. The arrow keys therefore move focus only, Enter
  // or Space performs the guarded selection, and the group keeps a single tab stop.
  const providerCardOrder = [cpolarChoice, cloudflaredChoice, tailscaleChoice]
  providerChoices.addEventListener('keydown', event => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    const jump = event.key === 'Home' ? 0 : event.key === 'End' ? providerCardOrder.length - 1 : undefined
    if (step === 0 && jump === undefined) return
    const current = providerCardOrder.indexOf(document.activeElement as HTMLButtonElement)
    if (current < 0) return
    const next = jump ?? (current + step + providerCardOrder.length) % providerCardOrder.length
    event.preventDefault()
    providerCardOrder[next]?.focus()
  })
  const cpolarSetup = element('section', 'dsh-mobile-control__cpolar-setup'); cpolarSetup.hidden = true
  const cpolarSetupTitle = element('h3', 'dsh-mobile-control__section-title'); cpolarSetupTitle.textContent = t('prepareCpolar')
  const cpolarComponentStatus = element('p', 'dsh-mobile-control__component-status'); cpolarComponentStatus.textContent = t('checkingComponent')
  const cpolarInstall = element('button', 'dsh-mobile-control__primary'); cpolarInstall.type = 'button'; cpolarInstall.textContent = t('installOfficial'); cpolarInstall.hidden = true
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
  cpolarSetup.append(cpolarSetupTitle, cpolarComponentStatus, cpolarAccount)
  // Share the managed-component setup layout: a quick tunnel has no account
  // section, so only the install action, the temporary-address warning, and the
  // component source/cleanup disclosure remain.
  const cloudflaredSetup = element('section', 'dsh-mobile-control__cpolar-setup dsh-mobile-control__cloudflared-setup'); cloudflaredSetup.hidden = true
  const cloudflaredSetupTitle = element('h3', 'dsh-mobile-control__section-title'); cloudflaredSetupTitle.textContent = t('prepareCloudflared')
  // Tunnel type comes first: it decides whether an account token is needed at all,
  // while the component below is required either way.
  const cloudflaredTunnelTitle = element('h3', 'dsh-mobile-control__section-title'); cloudflaredTunnelTitle.textContent = t('cloudflaredTunnelTitle')
  const cloudflaredMode = element('div', 'dsh-mobile-control__switcher')
  const cloudflaredModeQuick = element('button', 'dsh-mobile-control__tab is-active'); cloudflaredModeQuick.type = 'button'; cloudflaredModeQuick.textContent = t('cloudflaredTunnelQuick')
  const cloudflaredModeNamed = element('button', 'dsh-mobile-control__tab'); cloudflaredModeNamed.type = 'button'; cloudflaredModeNamed.textContent = t('cloudflaredTunnelNamed')
  cloudflaredMode.append(cloudflaredModeQuick, cloudflaredModeNamed)
  const cloudflaredModeHint = element('p', 'dsh-mobile-control__component-status'); cloudflaredModeHint.textContent = t('cloudflaredTunnelQuickHint')
  // Tunnel-mode notes are tucked behind an info icon inside this panel rather than
  // shown as a long banner in the form.
  const cloudflaredNotesToggle = element('button', 'dsh-mobile-control__notes-toggle'); cloudflaredNotesToggle.type = 'button'; cloudflaredNotesToggle.textContent = 'i'; cloudflaredNotesToggle.setAttribute('aria-label', t('providerInfoAria')); cloudflaredNotesToggle.setAttribute('aria-expanded', 'false')
  const cloudflaredNotesPanel = element('div', 'dsh-mobile-control__notes-panel'); cloudflaredNotesPanel.hidden = true
  const cloudflaredNotesQuick = element('p'); cloudflaredNotesQuick.textContent = t('cloudflaredQuickNote')
  const cloudflaredNotesNamed = element('p'); cloudflaredNotesNamed.textContent = t('cloudflaredNamedNote')
  cloudflaredNotesPanel.append(cloudflaredNotesQuick, cloudflaredNotesNamed)
  const cloudflaredModeRow = element('div', 'dsh-mobile-control__mode-row'); cloudflaredModeRow.append(cloudflaredMode, cloudflaredNotesToggle, cloudflaredNotesPanel)
  const setCloudflaredNotesOpen = (open: boolean): void => {
    cloudflaredNotesPanel.hidden = !open
    cloudflaredNotesToggle.setAttribute('aria-expanded', String(open))
  }
  // Hover shows the notes; only touch (no hover) falls back to tapping.
  // matchMedia is feature-detected: hardened test documents may not provide it.
  const hoverCapable = typeof window.matchMedia === 'function' ? window.matchMedia('(hover: hover)') : undefined
  cloudflaredModeRow.addEventListener('pointerenter', () => { if (hoverCapable?.matches) setCloudflaredNotesOpen(true) })
  cloudflaredModeRow.addEventListener('pointerleave', () => { if (hoverCapable?.matches) setCloudflaredNotesOpen(false) })
  cloudflaredNotesToggle.addEventListener('click', event => {
    setCloudflaredNotesOpen(hoverCapable?.matches && event.detail !== 0 ? true : Boolean(cloudflaredNotesPanel.hidden))
  })
  cloudflaredModeRow.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || cloudflaredNotesPanel.hidden) return
    event.preventDefault()
    event.stopPropagation()
    setCloudflaredNotesOpen(false)
    cloudflaredNotesToggle.focus()
  })
  const cloudflaredTunnel = element('div', 'dsh-mobile-control__tunnel'); cloudflaredTunnel.hidden = true
  const cloudflaredTunnelFields = element('div', 'dsh-mobile-control__frp-fields')
  const cloudflaredHostnameLabel = element('label', 'dsh-mobile-control__field'); cloudflaredHostnameLabel.textContent = t('cloudflaredTunnelHostname')
  const cloudflaredHostname = element('input'); cloudflaredHostname.type = 'text'; cloudflaredHostname.autocomplete = 'off'; cloudflaredHostname.spellcheck = false; cloudflaredHostname.placeholder = t('cloudflaredTunnelHostnamePlaceholder')
  const cloudflaredPortLabel = element('label', 'dsh-mobile-control__field'); cloudflaredPortLabel.textContent = t('cloudflaredTunnelPort')
  const cloudflaredPort = element('input'); cloudflaredPort.type = 'number'; cloudflaredPort.inputMode = 'numeric'; cloudflaredPort.min = '1024'; cloudflaredPort.max = '65535'; cloudflaredPort.value = '3444'
  const cloudflaredTokenLabel = element('label', 'dsh-mobile-control__field'); cloudflaredTokenLabel.textContent = t('cloudflaredTunnelToken')
  const cloudflaredToken = element('input'); cloudflaredToken.type = 'password'; cloudflaredToken.autocomplete = 'off'; cloudflaredToken.spellcheck = false; cloudflaredToken.placeholder = t('cloudflaredTunnelTokenPlaceholder')
  cloudflaredHostnameLabel.append(cloudflaredHostname); cloudflaredPortLabel.append(cloudflaredPort); cloudflaredTokenLabel.append(cloudflaredToken)
  cloudflaredTunnelFields.append(cloudflaredHostnameLabel, cloudflaredPortLabel, cloudflaredTokenLabel)
  const cloudflaredTunnelStatus = element('p', 'dsh-mobile-control__component-status'); cloudflaredTunnelStatus.textContent = t('cloudflaredTunnelMissing')
  const cloudflaredTunnelHint = element('p', 'dsh-mobile-control__component-status'); cloudflaredTunnelHint.textContent = t('cloudflaredTunnelHint', { port: '3444' })
  const cloudflaredTunnelSave = element('button', 'dsh-mobile-control__primary dsh-mobile-control__frp-action'); cloudflaredTunnelSave.type = 'button'; cloudflaredTunnelSave.textContent = t('cloudflaredTunnelSave')
  /** The button commits the shown mode, so quick mode must not promise to save settings. */
  const cloudflaredSaveLabel = (): string => (cloudflaredModeDraft ?? cloudflaredTunnelMode) === 'named'
    ? t('cloudflaredTunnelSave') : t('cloudflaredTunnelSaveQuick')
  const cloudflaredTunnelForget = element('button', 'dsh-mobile-control__danger dsh-mobile-control__frp-action'); cloudflaredTunnelForget.type = 'button'; cloudflaredTunnelForget.textContent = t('cloudflaredTunnelForget'); cloudflaredTunnelForget.hidden = true
  const cloudflaredTunnelToggle = element('button', 'dsh-mobile-control__tunnel-toggle'); cloudflaredTunnelToggle.type = 'button'; cloudflaredTunnelToggle.textContent = t('cloudflaredShowConfig') + ' ▾'; cloudflaredTunnelToggle.hidden = true
  const cloudflaredEditButton = element('button', 'dsh-mobile-control__secondary'); cloudflaredEditButton.type = 'button'; cloudflaredEditButton.textContent = t('cloudflaredEditConfig'); cloudflaredEditButton.hidden = true
  // Only the named-tunnel inputs live in this container. Save and Forget stay
  // outside it: Save is also how a quick tunnel is committed, so hiding the
  // container must never take the only way to submit the form with it.
  const cloudflaredTunnelFeedback = element('p', 'dsh-mobile-control__component-status'); cloudflaredTunnelFeedback.hidden = true
  cloudflaredTunnel.append(cloudflaredTunnelFields, cloudflaredTunnelStatus, cloudflaredTunnelHint, cloudflaredEditButton, cloudflaredTunnelSave, cloudflaredTunnelForget, cloudflaredTunnelFeedback)
  const cloudflaredComponentStatus = element('p', 'dsh-mobile-control__component-status'); cloudflaredComponentStatus.textContent = t('checkingComponent')
  const cloudflaredInstall = element('button', 'dsh-mobile-control__primary'); cloudflaredInstall.type = 'button'; cloudflaredInstall.textContent = t('installOfficial'); cloudflaredInstall.hidden = true
  const cloudflaredNote = element('p', 'dsh-mobile-control__origin-warning'); cloudflaredNote.textContent = t('cloudflaredQuickNote')
  const cloudflaredDetails = element('details', 'dsh-mobile-control__details')
  const cloudflaredDetailsSummary = element('summary'); cloudflaredDetailsSummary.textContent = t('componentDetails')
  const cloudflaredDetailsBody = element('div', 'dsh-mobile-control__details-body')
  const cloudflaredDetailsText = element('p'); cloudflaredDetailsText.textContent = t('cloudflaredComponentNote')
  const cloudflaredStorage = element('code', 'dsh-mobile-control__storage'); cloudflaredStorage.textContent = t('pluginPrivateDirectory')
  const cloudflaredOfficial = element('a', 'dsh-mobile-control__text-link'); cloudflaredOfficial.href = 'https://github.com/cloudflare/cloudflared/releases'; cloudflaredOfficial.target = '_blank'; cloudflaredOfficial.rel = 'noopener noreferrer'; cloudflaredOfficial.textContent = t('officialDownload')
  const cloudflaredTerms = element('a', 'dsh-mobile-control__text-link'); cloudflaredTerms.href = 'https://www.cloudflare.com/website-terms/'; cloudflaredTerms.target = '_blank'; cloudflaredTerms.rel = 'noopener noreferrer'; cloudflaredTerms.textContent = t('terms')
  const cloudflaredPurge = element('button', 'dsh-mobile-control__danger'); cloudflaredPurge.type = 'button'; cloudflaredPurge.textContent = t('purgeCloudflared')
  cloudflaredDetailsBody.append(cloudflaredDetailsText, cloudflaredStorage, cloudflaredOfficial, cloudflaredTerms, cloudflaredPurge); cloudflaredDetails.append(cloudflaredDetailsSummary, cloudflaredDetailsBody)
  cloudflaredSetup.append(cloudflaredSetupTitle, cloudflaredTunnelTitle, cloudflaredModeRow, cloudflaredModeHint, cloudflaredTunnelToggle, cloudflaredTunnel, cloudflaredComponentStatus)
  const frpChoice = element('button', 'dsh-mobile-control__provider is-frp'); frpChoice.type = 'button'; frpChoice.setAttribute('aria-pressed', 'false')
  const frpChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const frpChoiceName = element('strong'); frpChoiceName.textContent = t('frpName')
  const frpChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); frpChoiceDescription.textContent = t('frpDescription')
  const frpChoiceBadge = element('span', 'dsh-mobile-control__provider-badge is-frp'); frpChoiceBadge.textContent = t('advanced')
  frpChoiceTop.append(frpChoiceName, frpChoiceBadge); frpChoice.append(frpChoiceTop, frpChoiceDescription)
  const originChoice = element('button', 'dsh-mobile-control__provider is-origin'); originChoice.type = 'button'; originChoice.setAttribute('aria-pressed', 'false')
  const originChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const originChoiceName = element('strong'); originChoiceName.textContent = t('originName')
  const originChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); originChoiceDescription.textContent = t('originDescription')
  const originChoiceBadge = element('span', 'dsh-mobile-control__provider-badge'); originChoiceBadge.textContent = t('advanced')
  originChoiceTop.append(originChoiceName, originChoiceBadge); originChoice.append(originChoiceTop, originChoiceDescription)
  const irohChoice = element('button', 'dsh-mobile-control__provider is-iroh'); irohChoice.type = 'button'; irohChoice.setAttribute('aria-pressed', 'false')
  const irohChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const irohChoiceName = element('strong'); irohChoiceName.textContent = t('irohName')
  const irohChoiceBadge = element('span', 'dsh-mobile-control__provider-badge is-iroh'); irohChoiceBadge.textContent = t('irohExperimental')
  const irohChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); irohChoiceDescription.textContent = t('irohDescription')
  irohChoiceTop.append(irohChoiceName, irohChoiceBadge); irohChoice.append(irohChoiceTop, irohChoiceDescription)
  // iroh is a peer-to-peer transport with relay fallback, not a self-hosted inbound
  // endpoint: keep it beside the other managed channels instead of filing it under
  // "self-hosted" (own VPS / reverse proxy).
  providerChoices.append(irohChoice, frpChoice, originChoice)
  // LAN joins the channel list as the first entry, so "local" and "remote" share one
  // left column and the right pane just renders whichever channel is selected.
  const lanChoice = element('button', 'dsh-mobile-control__provider is-lan'); lanChoice.type = 'button'; lanChoice.setAttribute('role', 'radio'); lanChoice.setAttribute('aria-checked', 'true')
  const lanChoiceTop = element('span', 'dsh-mobile-control__provider-top')
  const lanChoiceName = element('strong'); lanChoiceName.textContent = t('lan')
  const lanChoiceBadge = element('span', 'dsh-mobile-control__provider-badge'); lanChoiceBadge.textContent = t('builtIn')
  const lanChoiceDescription = element('span', 'dsh-mobile-control__provider-description'); lanChoiceDescription.textContent = t('lanChoiceDescription')
  lanChoiceTop.append(lanChoiceName, lanChoiceBadge); lanChoice.append(lanChoiceTop, lanChoiceDescription)
  providerSection.append(providerHeading, lanChoice, providerChoices)
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
  const frpModeLabel = element('label', 'dsh-mobile-control__field'); frpModeLabel.textContent = t('frpMode')
  const frpMode = element('select')
  for (const [value, label] of [['deploy', t('frpModeDeploy')], ['attach', t('frpModeAttach')]] as const) {
    const option = element('option'); option.value = value; option.textContent = label; frpMode.append(option)
  }
  const frpModeHint = element('p', 'dsh-mobile-control__frp-hint'); frpModeHint.textContent = t('frpModeHint')
  frpModeLabel.append(frpMode, frpModeHint)
  const frpEntryTlsLabel = element('label', 'dsh-mobile-control__field'); frpEntryTlsLabel.textContent = t('frpEntryTls')
  const frpEntryTls = element('select')
  for (const [value, label] of [['public-ip-cert', t('frpEntryTlsPublic')], ['self-signed', t('frpEntryTlsSelfSigned')]] as const) {
    const option = element('option'); option.value = value; option.textContent = label; frpEntryTls.append(option)
  }
  frpEntryTlsLabel.append(frpEntryTls)
  const frpVhostLabel = element('label', 'dsh-mobile-control__field'); frpVhostLabel.textContent = t('frpVhostHttpPort')
  const frpVhostPort = element('input'); frpVhostPort.type = 'number'; frpVhostPort.inputMode = 'numeric'; frpVhostPort.min = '1'; frpVhostPort.max = '65535'; frpVhostPort.placeholder = '7080'
  const frpVhostHint = element('p', 'dsh-mobile-control__frp-hint'); frpVhostHint.id = 'dsh-mobile-frp-vhost-hint'; frpVhostHint.textContent = t('frpVhostHttpPortHint')
  frpVhostPort.setAttribute('aria-describedby', frpVhostHint.id)
  frpVhostLabel.append(frpVhostPort, frpVhostHint)
  const frpPublicPortLabel = element('label', 'dsh-mobile-control__field'); frpPublicPortLabel.textContent = t('frpPublicPort')
  const frpPublicPort = element('input'); frpPublicPort.type = 'number'; frpPublicPort.inputMode = 'numeric'; frpPublicPort.min = '1'; frpPublicPort.max = '65535'; frpPublicPort.value = '33080'; frpPublicPort.placeholder = '33080'
  const frpPublicPortHint = element('p', 'dsh-mobile-control__frp-hint'); frpPublicPortHint.textContent = t('frpPublicPortHint')
  frpPublicPortLabel.append(frpPublicPort, frpPublicPortHint)
  frpServerLabel.append(frpServer); frpPortLabel.append(frpPort); frpTokenLabel.append(frpToken); frpOriginLabel.append(frpOrigin)
  const frpInputs: Record<keyof FrpFormValues, HTMLInputElement | HTMLSelectElement> = {
    serverAddress: frpServer, serverPort: frpPort, token: frpToken, publicOrigin: frpOrigin,
    mode: frpMode, entryTls: frpEntryTls, vhostHttpPort: frpVhostPort, publicPort: frpPublicPort,
  }
  const frpInputLabels: Record<keyof FrpFormValues, HTMLLabelElement> = {
    serverAddress: frpServerLabel, serverPort: frpPortLabel, token: frpTokenLabel, publicOrigin: frpOriginLabel,
    mode: frpModeLabel, entryTls: frpEntryTlsLabel, vhostHttpPort: frpVhostLabel, publicPort: frpPublicPortLabel,
  }
  const frpLabelKeys: Record<keyof FrpFormValues, string> = {
    serverAddress: 'frpServerAddress', serverPort: 'frpServerPort', token: 'frpToken', publicOrigin: 'frpPublicOrigin',
    mode: 'frpMode', entryTls: 'frpEntryTls', vhostHttpPort: 'frpVhostHttpPort', publicPort: 'frpPublicPort',
  }
  const frpErrors = new Map<keyof FrpFormValues, HTMLParagraphElement>()
  for (const [name, input] of Object.entries(frpInputs)) {
    input.id = `dsh-mobile-frp-${name}`
    input.setAttribute('aria-label', t(frpLabelKeys[name as keyof FrpFormValues]))
    const error = element('p', 'dsh-mobile-control__origin-feedback is-error')
    error.id = `${input.id}-error`; error.hidden = true
    input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), error.id].filter(Boolean).join(' '))
    frpInputLabels[name as keyof FrpFormValues].append(error)
    frpErrors.set(name as keyof FrpFormValues, error)
  }
  const frpOriginHint = element('p', 'dsh-mobile-control__frp-hint'); frpOriginHint.id = 'dsh-mobile-frp-origin-hint'; frpOriginHint.textContent = t('frpPublicOriginHint')
  frpOriginLabel.append(frpOriginHint)
  frpOrigin.setAttribute('aria-describedby', `${frpOriginHint.id} ${frpOrigin.getAttribute('aria-describedby') ?? ''}`)
  frpFields.append(frpServerLabel, frpPortLabel, frpTokenLabel, frpOriginLabel, frpModeLabel, frpEntryTlsLabel, frpVhostLabel, frpPublicPortLabel)
  frpStep1.append(frpStep1Title, frpStep1Text, frpFields)
  const frpStep2 = element('section', 'dsh-mobile-control__frp-step')
  const frpStep2Title = element('strong'); frpStep2Title.textContent = t('frpStep2Title')
  const frpStep2Text = element('p'); frpStep2Text.textContent = t('frpStep2Text')
  const frpCopyTemplate = element('button', 'dsh-mobile-control__secondary dsh-mobile-control__frp-action'); frpCopyTemplate.type = 'button'; frpCopyTemplate.textContent = t('copyServerTemplate')
  const frpCopyAttachPlan = element('button', 'dsh-mobile-control__secondary dsh-mobile-control__frp-action'); frpCopyAttachPlan.type = 'button'; frpCopyAttachPlan.textContent = t('frpAttachPlan'); frpCopyAttachPlan.hidden = true; frpCopyAttachPlan.disabled = true
  // The only path that puts a plaintext token on the clipboard, and only after a
  // deliberate click; the default copy button above always stays masked.
  const frpCopyAttachToken = element('button', 'dsh-mobile-control__secondary dsh-mobile-control__frp-action'); frpCopyAttachToken.type = 'button'; frpCopyAttachToken.textContent = t('frpAttachToken'); frpCopyAttachToken.hidden = true; frpCopyAttachToken.disabled = true
  const frpSelfCheckButton = element('button', 'dsh-mobile-control__secondary dsh-mobile-control__frp-action'); frpSelfCheckButton.type = 'button'; frpSelfCheckButton.textContent = t('frpAttachSelfCheck'); frpSelfCheckButton.hidden = true
  const frpSelfCheckStatus = element('p', 'dsh-mobile-control__component-status'); frpSelfCheckStatus.textContent = ''; frpSelfCheckStatus.hidden = true
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
  frpStep2.append(frpStep2Title, frpStep2Text, frpCopyTemplate, frpCopyAttachPlan, frpCopyAttachToken, frpSelfCheckButton, frpSelfCheckStatus, vpsDeployText, vpsChangesTitle, vpsChanges, vpsDeployFields, vpsDeploy, vpsDeployStatus, vpsCopyUninstall, vpsUninstall)
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
  const frpFeedback = element('p', 'dsh-mobile-control__origin-feedback is-error'); frpFeedback.setAttribute('role', 'status'); frpFeedback.setAttribute('aria-live', 'polite'); frpFeedback.hidden = true
  const frpActionHint = element('p', 'dsh-mobile-control__frp-hint'); frpActionHint.id = 'dsh-mobile-frp-action-hint'; frpActionHint.hidden = true
  const frpConfigure = element('button', 'dsh-mobile-control__primary dsh-mobile-control__frp-action'); frpConfigure.type = 'button'; frpConfigure.textContent = t('frpSaveConnect')
  frpConfigure.setAttribute('aria-describedby', frpActionHint.id)
  frpStep4.append(frpStep4Title, frpStep4Text, frpAppRequirement, frpConfigurationStatus, frpFeedback, frpActionHint, frpConfigure)
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
  const frpVpsSummary = element('summary'); frpVpsSummary.textContent = t('frpStep2Title')
  frpVpsGroup.append(frpVpsSummary, frpStep2)
  const frpComponentGroup = element('details', 'dsh-mobile-control__frp-group')
  const frpComponentSummary = element('summary'); frpComponentSummary.textContent = t('frpStep3Title')
  frpComponentGroup.append(frpComponentSummary, frpStep3)
  const frpVerifyGroup = element('details', 'dsh-mobile-control__frp-group'); frpVerifyGroup.open = true
  const frpVerifySummary = element('summary'); frpVerifySummary.textContent = t('frpStep4Title')
  frpVerifyGroup.append(frpVerifySummary, frpStep4)
  frpSetup.append(frpSetupTitle, frpOverview, frpConnectionGroup, frpVpsGroup, frpComponentGroup, frpVerifyGroup)
  const originSetup = element('section', 'dsh-mobile-control__origin-setup'); originSetup.hidden = true
  const originSetupTitle = element('h3', 'dsh-mobile-control__section-title'); originSetupTitle.textContent = t('originHttpsTitle')
  const originHelp = element('p', 'dsh-mobile-control__component-note'); originHelp.id = 'dsh-mobile-origin-help'; originHelp.textContent = t('originHelp')
  const originWarning = element('p', 'dsh-mobile-control__origin-warning'); originWarning.textContent = t('originWarning')
  const originFields = element('div', 'dsh-mobile-control__origin-fields')
  const originPublicLabel = element('label', 'dsh-mobile-control__field dsh-mobile-control__field--full'); originPublicLabel.textContent = t('originPublicOrigin')
  const originPublic = element('input'); originPublic.type = 'url'; originPublic.placeholder = 'https://phone.example.com:8815'; originPublic.maxLength = 512
  const originHostLabel = element('label', 'dsh-mobile-control__field'); originHostLabel.textContent = t('originListenHost')
  const originHost = element('input'); originHost.type = 'text'; originHost.value = '127.0.0.1'; originHost.maxLength = 45
  const originPortLabel = element('label', 'dsh-mobile-control__field'); originPortLabel.textContent = t('originListenPort')
  const originPort = element('input'); originPort.type = 'number'; originPort.inputMode = 'numeric'; originPort.min = '1024'; originPort.max = '65535'; originPort.step = '1'; originPort.value = '3444'
  const originCidrsLabel = element('label', 'dsh-mobile-control__field dsh-mobile-control__field--full'); originCidrsLabel.textContent = t('originAllowedCidrs')
  const originCidrs = element('input'); originCidrs.type = 'text'; originCidrs.value = '127.0.0.0/8'; originCidrs.maxLength = 1040
  for (const input of [originPublic, originHost, originPort, originCidrs]) {
    input.required = true; input.autocomplete = 'off'; input.spellcheck = false
    input.setAttribute('aria-describedby', 'dsh-mobile-origin-help dsh-mobile-origin-feedback')
  }
  originPublicLabel.append(originPublic); originHostLabel.append(originHost); originPortLabel.append(originPort); originCidrsLabel.append(originCidrs)
  originFields.append(originPublicLabel, originHostLabel, originPortLabel, originCidrsLabel)
  const originFeedback = element('p', 'dsh-mobile-control__origin-feedback'); originFeedback.id = 'dsh-mobile-origin-feedback'; originFeedback.setAttribute('role', 'status'); originFeedback.setAttribute('aria-live', 'polite'); originFeedback.hidden = true
  const originConfigure = element('button', 'dsh-mobile-control__primary'); originConfigure.type = 'button'; originConfigure.textContent = t('originSaveStart')
  const originPurge = element('button', 'dsh-mobile-control__danger'); originPurge.type = 'button'; originPurge.textContent = t('originPurge'); originPurge.hidden = true
  const originFormActions = element('div', 'dsh-mobile-control__actions'); originFormActions.append(originConfigure, originPurge)
  const originBackend = element('div', 'dsh-mobile-control__origin-backend'); originBackend.hidden = true
  const originBackendLabel = element('span', 'dsh-mobile-control__access-label')
  const originBackendAddress = element('code', 'dsh-mobile-control__storage')
  const originCopyBackend = element('button', 'dsh-mobile-control__secondary'); originCopyBackend.type = 'button'; originCopyBackend.textContent = t('originCopyBackend')
  originBackend.append(originBackendLabel, originBackendAddress, originCopyBackend)
  const caddyModeRow = element('fieldset', 'dsh-mobile-control__origin-modes')
  const caddyModeLegend = element('legend'); caddyModeLegend.textContent = t('originHttpsMode')
  const caddyModeManagedLabel = element('label', 'dsh-mobile-control__origin-mode')
  const caddyModeManaged = element('input'); caddyModeManaged.type = 'radio'; caddyModeManaged.name = 'caddy-mode'; caddyModeManaged.value = 'managed'
  const caddyModeExternalLabel = element('label', 'dsh-mobile-control__origin-mode')
  const caddyModeExternal = element('input'); caddyModeExternal.type = 'radio'; caddyModeExternal.name = 'caddy-mode'; caddyModeExternal.value = 'external'
  const caddyManagedText = element('span'); caddyManagedText.textContent = t('caddyModeManaged')
  const caddyExternalText = element('span'); caddyExternalText.textContent = t('caddyModeExternal')
  caddyModeManagedLabel.append(caddyModeManaged, caddyManagedText)
  caddyModeExternalLabel.append(caddyModeExternal, caddyExternalText)
  caddyModeRow.append(caddyModeLegend, caddyModeExternalLabel, caddyModeManagedLabel)
  const caddyModePreviewNote = element('p', 'dsh-mobile-control__component-note'); caddyModePreviewNote.textContent = t('caddyModePreviewNote'); caddyModePreviewNote.hidden = true
  const caddyForm = element('div', 'dsh-mobile-control__caddy-form'); caddyForm.hidden = true
  const caddyFields = element('div', 'dsh-mobile-control__origin-fields')
  const caddyDomainLabel = element('label', 'dsh-mobile-control__field dsh-mobile-control__field--full'); caddyDomainLabel.textContent = t('caddyDomain')
  const caddyDomain = element('input'); caddyDomain.type = 'url'; caddyDomain.placeholder = 'https://phone.example.com:8443'; caddyDomain.maxLength = 512; caddyDomain.autocomplete = 'off'; caddyDomain.spellcheck = false
  const caddyProviderLabel = element('label', 'dsh-mobile-control__field dsh-mobile-control__field--full'); caddyProviderLabel.textContent = t('caddyDnsProvider')
  const caddyProvider = element('select')
  const caddyProviderOption = document.createElement('option'); caddyProviderOption.value = 'tencentcloud'; caddyProviderOption.textContent = 'Tencent Cloud DNSPod'
  caddyProvider.append(caddyProviderOption)
  const caddySecretIdLabel = element('label', 'dsh-mobile-control__field'); caddySecretIdLabel.textContent = t('caddySecretId')
  const caddySecretId = element('input'); caddySecretId.type = 'password'; caddySecretId.autocomplete = 'off'; caddySecretId.spellcheck = false
  const caddySecretKeyLabel = element('label', 'dsh-mobile-control__field'); caddySecretKeyLabel.textContent = t('caddySecretKey')
  const caddySecretKey = element('input'); caddySecretKey.type = 'password'; caddySecretKey.autocomplete = 'off'; caddySecretKey.spellcheck = false
  const caddyPortLabel = element('label', 'dsh-mobile-control__field dsh-mobile-control__field--full'); caddyPortLabel.textContent = t('caddyListenPort')
  const caddyPort = element('input'); caddyPort.type = 'number'; caddyPort.inputMode = 'numeric'; caddyPort.min = '1024'; caddyPort.max = '65535'; caddyPort.step = '1'; caddyPort.value = '8443'
  caddyDomainLabel.append(caddyDomain); caddyProviderLabel.append(caddyProvider); caddySecretIdLabel.append(caddySecretId); caddySecretKeyLabel.append(caddySecretKey); caddyPortLabel.append(caddyPort)
  caddyFields.append(caddyDomainLabel, caddyProviderLabel, caddySecretIdLabel, caddySecretKeyLabel, caddyPortLabel)
  const caddyInstall = element('button', 'dsh-mobile-control__primary'); caddyInstall.type = 'button'; caddyInstall.textContent = t('caddyInstall')
  const caddyInstallNote = element('p', 'dsh-mobile-control__component-note'); caddyInstallNote.textContent = t('caddyInstallNote')
  const caddyStatus = element('p', 'dsh-mobile-control__component-status'); caddyStatus.hidden = true
  const caddySave = element('button', 'dsh-mobile-control__primary'); caddySave.type = 'button'; caddySave.textContent = t('caddySaveConnect'); caddySave.hidden = true
  const caddyPurgeButton = element('button', 'dsh-mobile-control__danger'); caddyPurgeButton.type = 'button'; caddyPurgeButton.textContent = t('caddyPurge'); caddyPurgeButton.hidden = true
  const caddyFeedback = element('p', 'dsh-mobile-control__origin-feedback'); caddyFeedback.setAttribute('role', 'status'); caddyFeedback.setAttribute('aria-live', 'polite'); caddyFeedback.hidden = true
  const caddyActions = element('div', 'dsh-mobile-control__actions dsh-mobile-control__caddy-actions')
  caddyActions.append(caddyInstall, caddySave, caddyPurgeButton)
  caddyForm.append(caddyFields, caddyInstallNote, caddyStatus, caddyActions, caddyFeedback)
  originSetup.append(originSetupTitle, caddyModeRow, caddyModePreviewNote, originHelp, originWarning, originFields, originFeedback, originFormActions, caddyForm, originBackend)
  const tailscaleInfo = element('details', 'dsh-mobile-control__details')
  const tailscaleInfoSummary = element('summary'); tailscaleInfoSummary.textContent = t('tailscaleHelp')
  const tailscaleInfoBody = element('div', 'dsh-mobile-control__details-body')
  const tailscaleInfoText = element('p'); tailscaleInfoText.textContent = t('tailscaleHelpText')
  tailscaleInfoBody.append(tailscaleInfoText); tailscaleInfo.append(tailscaleInfoSummary, tailscaleInfoBody)
  const providerSetupBody = element('div', 'dsh-mobile-control__provider-setup-body')
  const irohSetup = element('section', 'dsh-mobile-control__frp-setup'); irohSetup.hidden = true
  const irohSetupTitle = element('h3', 'dsh-mobile-control__section-title'); irohSetupTitle.textContent = t('prepareIroh')
  const irohPhaseNote = element('p', 'dsh-mobile-control__component-note'); irohPhaseNote.textContent = t('irohPhaseNote')
  const irohComponentStatus = element('p', 'dsh-mobile-control__component-status'); irohComponentStatus.textContent = t('checkingComponent'); irohComponentStatus.setAttribute('role', 'status'); irohComponentStatus.setAttribute('aria-live', 'polite')
  const irohInstall = element('button', 'dsh-mobile-control__primary'); irohInstall.type = 'button'; irohInstall.textContent = t('installOfficial')
  const irohInstallProgress = element('progress', 'dsh-mobile-control__progress'); irohInstallProgress.hidden = true; irohInstallProgress.setAttribute('aria-hidden', 'true')
  const irohPairing = element('div', 'dsh-mobile-control__iroh-pairing')
  const irohPairingTitle = element('p', 'dsh-mobile-control__component-status'); irohPairingTitle.textContent = t('irohPairingTitle')
  const irohPair = element('button', 'dsh-mobile-control__primary'); irohPair.type = 'button'; irohPair.textContent = t('generateIrohQr')
  const irohQr = element('div', 'dsh-mobile-control__qr is-expandable'); irohQr.hidden = true
  const irohPairStatus = element('p', 'dsh-mobile-control__component-status')
  const irohCopyDescriptor = element('button', 'dsh-mobile-control__secondary'); irohCopyDescriptor.type = 'button'; irohCopyDescriptor.textContent = t('copyPairLink'); irohCopyDescriptor.hidden = true; irohCopyDescriptor.disabled = true
  // The pairing trigger sits beside enable/disable remote access; the QR code and
  // its status stay in the card below as the result area.
  irohPairing.append(irohPairingTitle, irohQr, irohPairStatus)
  const irohDetails = element('details', 'dsh-mobile-control__details')
  const irohDetailsSummary = element('summary'); irohDetailsSummary.textContent = t('componentDetails')
  const irohDetailsBody = element('div', 'dsh-mobile-control__details-body')
  const irohDetailsText = element('p'); irohDetailsText.textContent = t('irohComponentNote')
  const irohInstallNote = element('p'); irohInstallNote.textContent = t('irohInstallNote')
  const irohStorage = element('code', 'dsh-mobile-control__storage'); irohStorage.textContent = t('pluginPrivateDirectory')
  const irohOfficial = element('a', 'dsh-mobile-control__text-link'); irohOfficial.href = 'https://www.npmjs.com/package/dsh-mobile-iroh'; irohOfficial.target = '_blank'; irohOfficial.rel = 'noopener noreferrer'; irohOfficial.textContent = t('officialDownload')
  const irohPurge = element('button', 'dsh-mobile-control__danger'); irohPurge.type = 'button'; irohPurge.textContent = t('purgeIroh')
  irohDetailsBody.append(irohDetailsText, irohInstallNote, irohStorage, irohOfficial, irohPurge); irohDetails.append(irohDetailsSummary, irohDetailsBody)
  irohSetup.append(irohSetupTitle, irohPhaseNote, irohComponentStatus, irohInstall, irohInstallProgress, irohPairing)
  providerSetupBody.append(cpolarSetup, cloudflaredSetup, frpSetup, originSetup, irohSetup, tailscaleInfo)
  // Fullscreen viewer for the dense iroh pairing QR: the encoded descriptor
  // is far too small to scan reliably at inline size.
  const irohQrZoom = element('div', 'dsh-mobile-control__qr-zoom'); irohQrZoom.hidden = true
  const irohQrZoomImage = element('img', 'dsh-mobile-control__qr-zoom-image'); irohQrZoomImage.alt = t('pairingQr')
  const irohQrZoomClose = element('button', 'dsh-mobile-control__qr-zoom-close'); irohQrZoomClose.type = 'button'; irohQrZoomClose.textContent = '×'; irohQrZoomClose.setAttribute('aria-label', t('closeEnlargedQr'))
  // The viewer is mounted with the rest of the control root, so its dialog
  // semantics may only exist while it is actually open. A hidden element that
  // permanently claims role=dialog/aria-modal makes every consumer of the
  // current-modal query (this plugin, third-party scripts, mobile fixtures)
  // observe a modal that the user cannot see. The attributes are added on open
  // and withdrawn on close, including the reset path below.
  const setIrohQrZoomOpen = (open: boolean): void => {
    if (open) {
      irohQrZoom.setAttribute('role', 'dialog')
      irohQrZoom.setAttribute('aria-modal', 'true')
      irohQrZoom.setAttribute('aria-label', t('enlargeQr'))
    } else {
      irohQrZoom.removeAttribute('role')
      irohQrZoom.removeAttribute('aria-modal')
      irohQrZoom.removeAttribute('aria-label')
    }
    irohQrZoom.hidden = !open
  }
  irohQrZoom.append(irohQrZoomImage, irohQrZoomClose)
  root.append(irohQrZoom)
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
  // macOS only: the host reports whether Full Disk Access is already granted.
  // Shown once per session while the grant is missing, and never on other platforms.
  const remotePermission = element('section', 'dsh-mobile-control__guide'); remotePermission.hidden = true
  remotePermission.setAttribute('aria-label', t('macPermissionTitle'))
  const remotePermissionTitle = element('h3', 'dsh-mobile-control__guide-title'); remotePermissionTitle.textContent = t('macPermissionTitle')
  const remotePermissionSummary = element('p', 'dsh-mobile-control__guide-summary'); remotePermissionSummary.textContent = t('macPermissionSummary')
  const remotePermissionSteps = element('p', 'dsh-mobile-control__guide-note'); remotePermissionSteps.textContent = t('macPermissionSteps')
  const remotePermissionActions = element('div', 'dsh-mobile-control__guide-actions')
  const remotePermissionOpen = element('button', 'dsh-mobile-control__primary'); remotePermissionOpen.type = 'button'; remotePermissionOpen.textContent = t('macPermissionOpen')
  const remotePermissionDismissButton = element('button', 'dsh-mobile-control__secondary'); remotePermissionDismissButton.type = 'button'; remotePermissionDismissButton.textContent = t('macPermissionDismiss')
  remotePermissionActions.append(remotePermissionOpen, remotePermissionDismissButton)
  remotePermission.append(remotePermissionTitle, remotePermissionSummary, remotePermissionSteps, remotePermissionActions)
  const remoteActions = element('div', 'dsh-mobile-control__actions')
  const remoteToggle = element('button', 'dsh-mobile-control__primary'); remoteToggle.type = 'button'; remoteToggle.textContent = t('enableRemote')
  const remoteLogin = element('button', 'dsh-mobile-control__primary'); remoteLogin.type = 'button'; remoteLogin.textContent = t('continueLogin'); remoteLogin.hidden = true
  const remoteReconnect = element('button', 'dsh-mobile-control__secondary'); remoteReconnect.type = 'button'; remoteReconnect.textContent = t('reconnect'); remoteReconnect.hidden = true
  const remotePair = element('button', 'dsh-mobile-control__secondary'); remotePair.type = 'button'; remotePair.textContent = t('generateRemoteQr'); remotePair.disabled = true
  const remoteCopyLink = element('button', 'dsh-mobile-control__secondary'); remoteCopyLink.type = 'button'; remoteCopyLink.textContent = t('copyRemoteLink'); remoteCopyLink.disabled = true
  const remotePairLink = element('p', 'dsh-mobile-control__status'); remotePairLink.hidden = true
  const pairingValidity = element('p', 'dsh-mobile-control__component-status'); pairingValidity.hidden = true
  let activeRemotePairUrl = ''
  let activeRemotePairExpiresAt = 0
  let remotePairingBusy = false
  let remotePairingGeneration = 0
  let activeIrohDescriptor = ''
  let activeIrohPairExpiresAt = 0
  let activeIrohQrSvg = ''
  remoteActions.append(remoteToggle, irohPair, irohCopyDescriptor, remoteLogin, remoteReconnect, remotePair, remoteCopyLink)
  const remoteManageRow = element('div', 'dsh-mobile-control__manage-row')
  const remoteDevices = element('button', 'dsh-mobile-control__manage'); remoteDevices.type = 'button'; remoteDevices.textContent = t('manageRemoteDevices'); remoteDevices.disabled = true
  const remoteReset = element('button', 'dsh-mobile-control__manage'); remoteReset.type = 'button'; remoteReset.textContent = t('resetRemoteLogin')
  remoteManageRow.append(remoteDevices, remoteReset)
  const remoteDevicePanel = element('div', 'dsh-mobile-control__devices')
  const wsPathsSection = element('section', 'dsh-mobile-control__ws-paths')
  const wsPathsTitle = element('h3', 'dsh-mobile-control__section-title'); wsPathsTitle.textContent = t('wsPathsTitle')
  const wsPathsIntro = element('p', 'dsh-mobile-control__intro'); wsPathsIntro.textContent = t('wsPathsIntro')
  const wsPathsDetected = element('div', 'dsh-mobile-control__ws-paths-detected'); wsPathsDetected.hidden = true
  const wsPathsDetectedTitle = element('p', 'dsh-mobile-control__ws-paths-detected-title'); wsPathsDetectedTitle.textContent = t('wsPathsDetected')
  const wsPathsDetectedList = element('ul', 'dsh-mobile-control__ws-paths-list')
  wsPathsDetected.append(wsPathsDetectedTitle, wsPathsDetectedList)
  const wsPathsList = element('ul', 'dsh-mobile-control__ws-paths-list')
  const wsPathsAdvanced = element('details', 'dsh-mobile-control__ws-paths-advanced')
  const wsPathsAdvancedSummary = element('summary'); wsPathsAdvancedSummary.textContent = t('wsPathsAdvancedToggle')
  const wsPathsAdvancedHint = element('p', 'dsh-mobile-control__intro'); wsPathsAdvancedHint.textContent = t('wsPathsAdvancedHint')
  const wsPathsRow = element('div', 'dsh-mobile-control__ws-paths-row')
  const wsPathsInput = element('input', 'dsh-mobile-control__ws-paths-input'); wsPathsInput.type = 'text'; wsPathsInput.placeholder = t('wsPathsPlaceholder'); wsPathsInput.setAttribute('aria-label', t('wsPathsTitle'))
  const wsPathsAdd = element('button', 'dsh-mobile-control__primary'); wsPathsAdd.type = 'button'; wsPathsAdd.textContent = t('wsPathsAdd')
  const wsPathsStatus = element('p', 'dsh-mobile-control__status'); wsPathsStatus.hidden = true; wsPathsStatus.setAttribute('aria-live', 'polite')
  wsPathsRow.append(wsPathsInput, wsPathsAdd)
  wsPathsAdvanced.append(wsPathsAdvancedSummary, wsPathsAdvancedHint, wsPathsRow, wsPathsStatus)
  wsPathsSection.append(wsPathsTitle, wsPathsIntro, wsPathsDetected, wsPathsList, wsPathsAdvanced)
  let wsPathsCurrent: string[] = []
  let wsPathsBlocked: { readonly path: string; readonly attempts: number }[] = []
  let wsPathsLoaded = false
  const renderWsPaths = (paths: readonly string[]): void => {
    wsPathsCurrent = [...paths]
    wsPathsList.replaceChildren()
    if (paths.length === 0) {
      const empty = element('li', 'dsh-mobile-control__ws-paths-empty'); empty.textContent = t('wsPathsEmpty'); wsPathsList.append(empty)
    }
    for (const path of paths) {
      const item = element('li', 'dsh-mobile-control__ws-paths-item')
      const label = element('code'); label.textContent = path
      const remove = element('button', 'dsh-mobile-control__ws-paths-remove'); remove.type = 'button'; remove.textContent = t('wsPathsRemove'); remove.setAttribute('aria-label', `${t('wsPathsRemove')}: ${path}`)
      remove.addEventListener('click', () => { void saveWsPaths(wsPathsCurrent.filter(entry => entry !== path)) })
      item.append(label, remove)
      wsPathsList.append(item)
    }
  }
  const wsGroupOf = (path: string): string => {
    const slash = path.lastIndexOf('/')
    return slash > 0 ? path.slice(0, slash) : '/'
  }
  let wsPathsSeenAttempts = 0
  let wsDotAnnounced = 0
  const wsDotStatus = element('p', 'dsh-mobile-control__ws-sr-status')
  wsDotStatus.setAttribute('role', 'status'); wsDotStatus.setAttribute('aria-atomic', 'true')
  const wsBlockedTotal = (blocked: readonly { readonly attempts: number }[]): number =>
    blocked.reduce((sum, entry) => sum + entry.attempts, 0)
  const renderWsDot = (): void => {
    for (const stale of document.querySelectorAll('.dsh-mobile-control__ws-dot')) stale.remove()
    if (!wsDotStatus.isConnected) root.append(wsDotStatus)
    const pending = wsPathsBlocked.filter(entry => !wsPathsCurrent.includes(entry.path))
    const pendingCount = pending.length
    if (pendingCount === 0 || wsBlockedTotal(wsPathsBlocked) <= wsPathsSeenAttempts) {
      if (pendingCount === 0 && wsDotAnnounced !== 0) { wsDotAnnounced = 0; wsDotStatus.textContent = '' }
      return
    }
    if (wsDotAnnounced !== pendingCount) {
      wsDotAnnounced = pendingCount
      wsDotStatus.textContent = t('wsPathsAnnounce', { n: String(pendingCount) })
    }
    for (const trigger of document.querySelectorAll('.dsh-mobile-control__trigger, .dsh-mobile-control__diagnostic-entry')) {
      const dot = element('span', 'dsh-mobile-control__ws-dot'); dot.textContent = String(pendingCount); dot.title = t('wsPathsNewBlocked'); dot.setAttribute('aria-hidden', 'true')
      dot.addEventListener('click', event => { event.stopPropagation(); setOpen(true); selectView('diagnostics') })
      trigger.append(dot)
    }
  }
  const renderWsBlocked = (blocked: readonly { readonly path: string; readonly attempts: number }[]): void => {
    wsPathsDetectedList.replaceChildren()
    const pending = blocked.filter(entry => !wsPathsCurrent.includes(entry.path))
    wsPathsDetected.hidden = pending.length === 0
    const groups = new Map<string, { readonly path: string; readonly attempts: number }[]>()
    for (const entry of pending) {
      const group = wsGroupOf(entry.path)
      const list = groups.get(group)
      if (list) list.push(entry); else groups.set(group, [entry])
    }
    for (const [group, entries] of groups) {
      const groupItem = element('li', 'dsh-mobile-control__ws-paths-group')
      const groupHead = element('div', 'dsh-mobile-control__ws-paths-group-head')
      const groupLabel = element('code'); groupLabel.textContent = `${group}/*`
      const groupCount = element('span', 'dsh-mobile-control__ws-count')
      groupCount.textContent = t('wsPathsGroupMeta', { n: entries.length, m: entries.reduce((sum, entry) => sum + entry.attempts, 0) })
      groupHead.append(groupLabel, groupCount)
      if (entries.length > 1) {
        const allowAll = element('button', 'dsh-mobile-control__primary'); allowAll.type = 'button'; allowAll.textContent = t('wsPathsAllowAll')
        allowAll.addEventListener('click', () => { saveWsPaths([...wsPathsCurrent, ...entries.map(entry => entry.path)]) })
        groupHead.append(allowAll)
      }
      groupItem.append(groupHead)
      for (const entry of entries) {
        const item = element('div', 'dsh-mobile-control__ws-paths-item is-child')
        const label = element('code'); label.textContent = `${entry.path} ×${String(entry.attempts)}`
        const allow = element('button', 'dsh-mobile-control__primary'); allow.type = 'button'; allow.textContent = t('wsPathsAllow'); allow.setAttribute('aria-label', `${t('wsPathsAllow')}: ${entry.path}`)
        allow.addEventListener('click', () => { saveWsPaths([...wsPathsCurrent, entry.path]) })
        item.append(label, allow)
        groupItem.append(item)
      }
      wsPathsDetectedList.append(groupItem)
    }
    renderWsDot()
  }
  const loadWsPaths = (): void => {
    void controlRequestJson('/api/mobile-access/remote/websocket-paths').then(data => {
      wsPathsLoaded = true
      wsPathsStatus.hidden = true
      renderWsPaths(Array.isArray(data.paths) ? data.paths.filter((entry): entry is string => typeof entry === 'string') : [])
      void controlRequestJson('/api/mobile-access/remote/websocket-paths/blocked').then(blocked => {
        const entries = Array.isArray(blocked.blocked) ? blocked.blocked : []
        wsPathsBlocked = entries.filter((entry): entry is { path: string; attempts: number } =>
          typeof entry === 'object' && entry !== null
          && typeof (entry as { path?: unknown }).path === 'string'
          && typeof (entry as { attempts?: unknown }).attempts === 'number')
        renderWsBlocked(wsPathsBlocked)
      }, () => { /* approved list already rendered; detected list stays hidden */ })
    }, error => {
      wsPathsStatus.hidden = false
      wsPathsStatus.textContent = t('requestFailed', { error: String(error) })
    })
  }
  const saveWsPaths = (paths: readonly string[]): void => {
    wsPathsStatus.hidden = true
    void controlRequestJson('/api/mobile-access/remote/websocket-paths', { method: 'POST', body: JSON.stringify({ paths }) }).then(data => {
      wsPathsLoaded = true
      renderWsPaths(Array.isArray(data.paths) ? data.paths.filter((entry): entry is string => typeof entry === 'string') : [])
      renderWsBlocked(wsPathsBlocked)
    }, error => {
      wsPathsStatus.hidden = false
      wsPathsStatus.textContent = t('requestFailed', { error: String(error) })
    })
  }
  wsPathsAdd.addEventListener('click', () => {
    const value = wsPathsInput.value.trim()
    if (value === '') {
      wsPathsStatus.hidden = false
      wsPathsStatus.textContent = t('wsPathsInvalid')
      return
    }
    wsPathsInput.value = ''
    saveWsPaths([...wsPathsCurrent, value])
  })
  const remoteWorkspace = element('div', 'dsh-mobile-control__remote-workspace')
  // Provider component install buttons live below the QR / above the enable row,
  // not buried inside the provider setup form.
  const providerInstallRow = element('div', 'dsh-mobile-control__provider-install')
  providerInstallRow.append(cpolarInstall, cloudflaredInstall)
  // Component source/cleanup disclosures always sit at the very bottom of the
  // provider page, below the action buttons, regardless of the active provider.
  const setupDetailsRow = element('div', 'dsh-mobile-control__setup-details')
  for (const disclosure of [cpolarDetails, cloudflaredDetails, frpDetails, irohDetails]) { disclosure.hidden = true; setupDetailsRow.append(disclosure) }
  remoteWorkspace.append(remoteStatus, remoteAccess, remoteGuide, remotePermission, providerSetupBody, remoteQr, pairingValidity, providerInstallRow, remoteActions, remotePairLink, setupDetailsRow)
  const diagnosticsView = element('div', 'dsh-mobile-control__view is-diagnostics'); diagnosticsView.hidden = true
  // Paired-device management is its own page (like diagnostics), reached from the
  // LAN view's "Manage paired devices" button, instead of expanding inline.
  const devicesView = element('div', 'dsh-mobile-control__view is-devices'); devicesView.hidden = true
  const devicesSwitcher = element('div', 'dsh-mobile-control__switcher')
  const devicesLanTab = element('button', 'dsh-mobile-control__tab is-active'); devicesLanTab.type = 'button'; devicesLanTab.textContent = t('devicesLanTitle')
  const devicesRemoteTab = element('button', 'dsh-mobile-control__tab'); devicesRemoteTab.type = 'button'; devicesRemoteTab.textContent = t('devicesRemoteTitle')
  devicesSwitcher.append(devicesLanTab, devicesRemoteTab)
  const devicesLanGroup = element('div')
  const devicesLanRow = element('div', 'dsh-mobile-control__manage-row'); devicesLanRow.append(resetAll)
  devicesLanGroup.append(devicePanel, devicesLanRow)
  const devicesRemoteGroup = element('div'); devicesRemoteGroup.hidden = true
  const devicesRemoteRow = element('div', 'dsh-mobile-control__manage-row'); devicesRemoteRow.append(remoteReset)
  devicesRemoteGroup.append(remoteDevicePanel, devicesRemoteRow)
  devicesView.append(devicesSwitcher, devicesLanGroup, devicesRemoteGroup)
  const showDevicesGroup = (which: 'lan' | 'remote'): void => {
    const lan = which === 'lan'
    devicesLanGroup.hidden = !lan
    devicesRemoteGroup.hidden = lan
    devicesLanTab.classList.toggle('is-active', lan)
    devicesRemoteTab.classList.toggle('is-active', !lan)
    if (lan) loadDevices(); else loadRemoteDevices()
  }
  devicesLanTab.addEventListener('click', () => showDevicesGroup('lan'))
  devicesRemoteTab.addEventListener('click', () => showDevicesGroup('remote'))
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
  lanView.append(lanSetup, lanChange, access, qrBox, lanPairingValidity, status, extensionStatus, actions, trustedNetworks)
  // Two-column remote layout: the channel list on the left, its configuration on
  // the right, so switching providers no longer scrolls the setup out of view.
  const channelPane = element('div', 'dsh-mobile-control__channel-pane')
  channelPane.append(lanView, remoteWorkspace)
  const remoteColumns = element('div', 'dsh-mobile-control__remote-columns')
  remoteColumns.append(providerSection, channelPane)
  remoteView.append(remoteIntro, httpFrameWarning, remoteColumns)
  diagnosticsView.append(diagnosticsIntro, diagnosticsSummary, diagnosticsToolbar, diagnosticsFeedback, diagnosticsChecks, wsPathsSection, diagnosticsDetails)
  panel.append(header, releaseNotice, updateCard, appDownloads, extensionRecovery.section, remoteView, diagnosticsView, devicesView); root.append(panel); document.body.append(root)
  let running = false
  let origin = ''
  let lanConfigured = true
  let lanRestartRequired = false
  let lanSetupLoaded = false
  let lanChangeLoaded = false
  let lanChangeBusy = false
  let lanChangeRequest: Promise<void> | undefined
  let remoteRunning = false
  let remoteReady = false
  let remoteProvider: MobileRemoteProvider = 'tailscale'
  let remoteLoginUrl = ''
  let remoteSetupUrl = ''
  let remoteSetupPending = false
  let remotePermissionDismissed = false
  let remoteSetupOpenedAt = 0
  let remoteReconnectBusy = false
  let remoteProviderBusy = false
  // A failed control action stores its message here so the repaint that loadRemote() runs in the
  // action's finally cannot replace it before the user reads it. The repaint that would have
  // erased it consumes the value instead, so it never lingers over a later state.
  let remoteFailureText: string | undefined
  let cpolarInstalled = false
  let cpolarConfigured = false
  let cloudflaredInstalled = false
  let cloudflaredDownloadSize = ''
  let cloudflaredTunnelMode: 'quick' | 'named' = 'quick'
  let cloudflaredConfigEditing = false
  let cloudflaredModeDraft: 'quick' | 'named' | null = null
  let cloudflaredTunnelConfigured = false
  let configuredCloudflaredHostname = ''
  let configuredCloudflaredPort = 3444
  // Once the user types in a field, polls must stop writing to it, or a stale
  // value the user is mid-edit would be silently replaced by the saved one.
  let cloudflaredHostnameDirty = false
  let cloudflaredPortDirty = false
  let originConfigured = false
  let originFormDirty = false
  let originFormBusy = false
  let caddyFormBusy = false
  let caddyModeManagedSelected = false
  let caddyFormDirty = false
  let caddyModePreviewDirty = false
  const showCaddyFeedback = (message: string, isError = false): void => {
    caddyFeedback.textContent = message
    caddyFeedback.classList.toggle('is-error', isError)
    caddyFeedback.hidden = false
  }
  const setCaddyFormBusy = (busy: boolean): void => {
    caddyFormBusy = busy
    remoteProviderBusy = busy
    remoteSnapshotEpoch += 1
    caddyInstall.setAttribute('aria-busy', String(busy))
    caddySave.setAttribute('aria-busy', String(busy))
    renderRemote(latestRemoteState)
  }
  let remoteSnapshotEpoch = 0
  let latestRemoteState: Record<string, unknown> = {}
  let frpInstalled = false
  let frpConfigured = false
  let irohInstalled = false
  /** True while a companion checksum verification is in flight; polls must not wipe its progress. */
  let irohVerifying = false
  let frpLayoutInitialized = false
  let frpDownloadSize = '14.0'
  let configuredFrpServer = ''
  let configuredFrpPort = 7000
  let configuredFrpOrigin = ''
  let configuredFrpVhostPort = 7080
  let configuredFrpPublicPort = 33_080
  /** Proxy name the host writes into its frpc.toml; the local clipboard copy must match. */
  let configuredFrpProxyName: string | undefined
  let frpConfiguredMode: 'deploy' | 'attach' = 'deploy'
  let frpConfiguredEntryTls: 'public-ip-cert' | 'self-signed' = 'public-ip-cert'
  let frpModeDraft = false
  let frpEntryTlsDraft = false
  let frpVhostDraft = false
  let frpAttachVhostExplicit = false
  let previousAccessView: 'lan' | 'remote' = 'lan'
  let diagnosticsBusy = false
  let copiedDiagnosticReport = ''
  let pluginUpdateAvailable = false
  let pluginLatestVersion = ''
  let pluginReleaseNotes = ''
  let updateInFlight = false
  const renderRelease = (data: Record<string, unknown>): void => {
    const release = clientReleaseInfo(data)
    pluginUpdateAvailable = release.updateAvailable
    pluginLatestVersion = release.latestVersion ?? ''
    pluginReleaseNotes = release.releaseNotes ?? ''
    updatePlugin.hidden = !pluginUpdateAvailable || !diagnosticsView.hidden || !updateCard.hidden
    updatePlugin.textContent = t('updatePlugin')
    if (pluginLatestVersion !== '') updatePlugin.setAttribute('aria-label', t('updatePluginAria', { version: pluginLatestVersion }))
    if (release.androidVersion !== undefined) {
      const version = release.androidVersion
      const sizeMb = (bytes: number | undefined): string | undefined => bytes === undefined ? undefined : (bytes / 1048576).toFixed(1)
      const compatSize = sizeMb(release.androidCompatBytes)
      const irohSize = sizeMb(release.androidIrohBytes)
      appDownload.textContent = compatSize === undefined ? t('downloadAndroidVersion', { version }) : t('downloadAndroidVersionSize', { version, size: compatSize })
      appDownload.setAttribute('aria-label', t('downloadAndroidVersionAria', { version }))
      appDownloadIroh.textContent = irohSize === undefined ? t('downloadAndroidIrohVersion', { version }) : t('downloadAndroidIrohVersionSize', { version, size: irohSize })
      appDownloadIroh.setAttribute('aria-label', t('downloadAndroidIrohAria', { version }))
    }
    appDownload.href = release.androidDownloadUrl
    if (release.androidIrohDownloadUrl === undefined) {
      appDownloadIroh.hidden = true
    } else {
      appDownloadIroh.href = release.androidIrohDownloadUrl
      appDownloadIroh.hidden = false
    }
  }
  let currentAccessView: 'lan' | 'remote' | 'diagnostics' | 'devices' = 'lan'
  // Single source of truth for the left-column selection. Exactly one channel
  // is highlighted: LAN view -> the LAN row; remote view -> the active remote
  // provider. Previously the LAN row and the active remote provider could both
  // show as selected, and iroh never got a selected state at all.
  const applyChoiceSelection = (): void => {
    const inRemote = currentAccessView === 'remote'
    lanChoice.classList.toggle('is-selected', currentAccessView === 'lan')
    lanChoice.setAttribute('aria-checked', String(currentAccessView === 'lan'))
    tailscaleChoice.classList.toggle('is-selected', inRemote && remoteProvider === 'tailscale')
    cpolarChoice.classList.toggle('is-selected', inRemote && remoteProvider === 'cpolar')
    cloudflaredChoice.classList.toggle('is-selected', inRemote && remoteProvider === 'cloudflared')
    frpChoice.classList.toggle('is-selected', inRemote && remoteProvider === 'frp')
    originChoice.classList.toggle('is-selected', inRemote && remoteProvider === 'origin')
    irohChoice.classList.toggle('is-selected', inRemote && remoteProvider === 'iroh')
  }
  const selectView = (view: 'lan' | 'remote' | 'diagnostics' | 'devices'): void => {
    if (!panel.hidden) void extensionRecovery.refresh()
    currentAccessView = view
    if (view === 'lan' || view === 'remote') previousAccessView = view
    const subpage = view === 'diagnostics' || view === 'devices'
    remoteView.hidden = subpage
    lanView.hidden = view !== 'lan'
    remoteWorkspace.hidden = view !== 'remote'
    diagnosticsView.hidden = view !== 'diagnostics'
    devicesView.hidden = view !== 'devices'
    lanTab.classList.toggle('is-active', view === 'lan')
    remoteTab.classList.toggle('is-active', view === 'remote')
    applyChoiceSelection()
    lanTab.setAttribute('aria-pressed', String(view === 'lan'))
    remoteTab.setAttribute('aria-pressed', String(view === 'remote'))
    diagnosticsEntry.setAttribute('aria-pressed', String(view === 'diagnostics'))
    diagnosticsEntry.textContent = view === 'diagnostics' ? t('back') : t('diagnostics')
    diagnosticsEntry.setAttribute('aria-label', view === 'diagnostics' ? t('backToMobile') : t('openDiagnostics'))
    devicesEntry.setAttribute('aria-pressed', String(view === 'devices'))
    devicesEntry.textContent = view === 'devices' ? t('back') : t('device')
    devicesEntry.setAttribute('aria-label', view === 'devices' ? t('backToMobile') : t('managePairedDevices'))
    if (view === 'diagnostics') {
      wsPathsSeenAttempts = wsBlockedTotal(wsPathsBlocked)
      renderWsDot()
      if (!wsPathsLoaded) loadWsPaths()
    }
    updatePlugin.hidden = subpage || !pluginUpdateAvailable
    appDownloads.hidden = subpage
    switcher.hidden = subpage
    title.textContent = view === 'lan' ? t('lanAccess') : view === 'remote' ? t('remoteAccess') : view === 'devices' ? t('managePairedDevices') : t('connectionDiagnostics')
  }
  lanTab.addEventListener('click', () => { selectView('lan') })
  lanChoice.addEventListener('click', () => { selectView('lan') })
  providerChoices.addEventListener('click', () => { selectView('remote'); loadRemote() })
  remoteTab.addEventListener('click', () => { selectView('remote'); loadRemote() })
  selectView('lan')
  let returnFocus: HTMLElement | undefined
  const setOpen = (open: boolean): void => {
    const changed = panel.hidden === open
    if (open && changed && document.activeElement instanceof HTMLElement) returnFocus = document.activeElement
    panel.hidden = !open
    if (open) { panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true') }
    else { panel.removeAttribute('role'); panel.removeAttribute('aria-modal') }
    if (open) void extensionRecovery.refresh()
    if (open && changed) void controlRequestJson('/api/mobile-access/release').then(renderRelease, () => {})
    if (changed) {
      if (open) close.focus()
      else if (returnFocus?.isConnected) returnFocus.focus()
    }
    for (const trigger of document.querySelectorAll('.dsh-mobile-control__trigger')) trigger.setAttribute('aria-expanded', String(open))
  }
  panel.addEventListener('keydown', event => {
    if (event.defaultPrevented) return
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return }
    if (event.key !== 'Tab') return
    const controls = [...panel.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,[tabindex]')]
      .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && node.getClientRects().length > 0)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first && last !== undefined) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && document.activeElement === last && first !== undefined) { event.preventDefault(); first.focus() }
  })
  const renderLanPairingExpiry = (): void => {
    if (!running || activeLanPairExpiresAt === 0) return
    lanPairingValidity.hidden = false
    if (Date.now() >= activeLanPairExpiresAt) {
      activeLanPairUrl = ''
      showQr('')
      qrBox.textContent = t('pairingExpired')
      lanPairingValidity.textContent = t('pairingExpired')
    } else lanPairingValidity.textContent = t('pairingExpires', { time: formatTime(activeLanPairExpiresAt) })
  }
  const render = (data: Record<string, unknown>): void => {
    const previousOrigin = origin
    lanConfigured = data.configured !== false
    lanRestartRequired = data.restartRequired === true
    running = data.running === true
    lanChoiceBadge.textContent = running ? t('lanBadgeOn') : t('lanBadgeOff')
    origin = running && typeof data.origin === 'string' ? data.origin : ''
    lanSetup.hidden = lanConfigured && !lanRestartRequired
    lanChange.hidden = !lanConfigured || lanRestartRequired || data.rebindSupported !== true
    if (!lanChange.hidden && !lanChangeLoaded) loadLanChange()
    lanSetupForm.hidden = lanRestartRequired
    lanSetupIntro.hidden = lanRestartRequired
    status.hidden = !lanConfigured || lanRestartRequired
    if (!lanConfigured && !lanSetupLoaded) loadLanSetup()
    if (lanRestartRequired) {
      const pendingOrigin = typeof data.pendingOrigin === 'string' ? data.pendingOrigin : ''
      lanSetupStatus.textContent = t('lanSetupRestart', { origin: pendingOrigin })
    } else if (!lanConfigured && lanSetupStatus.textContent === '') {
      lanSetupStatus.textContent = t('lanSetupRequired')
    }
    access.hidden = origin === ''
    accessLink.href = origin
    accessLink.textContent = origin
    accessLink.title = origin
    status.classList.toggle('is-running', running)
    status.textContent = data.recoveryRequired === true ? t('lanChangeRecoveryRequired') : !lanConfigured ? t('lanSetupRequired') : lanRestartRequired ? t('lanSetupRestart', { origin: typeof data.pendingOrigin === 'string' ? data.pendingOrigin : '' }) : running ? t('lanOn') : t('lanOff')
    const extensionData = data.extensions
    if (extensionData !== null && typeof extensionData === 'object') {
      const loaded = typeof (extensionData as { loaded?: unknown }).loaded === 'number' ? (extensionData as { loaded: number }).loaded : 0
      const failed = typeof (extensionData as { failed?: unknown }).failed === 'number' ? (extensionData as { failed: number }).failed : 0
      extensionStatus.hidden = false
      extensionStatus.textContent = failed === 0 ? t('extensionsLoaded', { loaded }) : t('extensionsFailed', { loaded, failed })
    } else extensionStatus.hidden = true
    if (!running || previousOrigin !== origin) {
      lanPairingGeneration += 1
      activeLanPairUrl = ''
      activeLanPairExpiresAt = 0
      lanPairingValidity.hidden = true
      showQr('')
    } else renderLanPairingExpiry()
    toggle.textContent = running ? t('disableLan') : t('enableLan')
    actions.hidden = !lanConfigured || lanRestartRequired
    manageRow.hidden = !lanConfigured || lanRestartRequired
    pair.disabled = !running || lanPairingBusy
    linkPair.disabled = !running || lanPairingBusy
    manageDevices.disabled = !running
    resetAll.disabled = !running
  }
  const renderLanSetup = (data: Record<string, unknown>): void => {
    if (data.restartRequired === true || data.configured === true) {
      render(data)
      return
    }
    const networks = Array.isArray(data.networks) ? data.networks.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null) : []
    lanSetupSelect.replaceChildren()
    const hasRecommended = networks.some(network => network.recommended === true)
    if (!hasRecommended && networks.length > 1) {
      const placeholder = element('option'); placeholder.value = ''; placeholder.textContent = t('lanSetupChooseNetwork'); placeholder.disabled = true; placeholder.selected = true
      lanSetupSelect.append(placeholder)
    }
    for (const network of networks) {
      if (typeof network.address !== 'string' || typeof network.name !== 'string') continue
      const option = element('option'); option.value = network.address
      option.textContent = `${network.name} · ${network.address}${network.recommended === true ? ` · ${t('lanSetupRecommended')}` : ''}`
      option.selected = network.recommended === true || (!hasRecommended && networks.length === 1)
      lanSetupSelect.append(option)
    }
    const available = networks.some(network => typeof network.address === 'string' && typeof network.name === 'string')
    lanSetupConfigure.disabled = lanSetupSelect.value === ''
    lanSetupStatus.textContent = available ? t('lanSetupRequired') : t('lanSetupNoNetworks')
    lanSetupNote.hidden = data.windowsFirewall !== true
  }
  lanSetupSelect.addEventListener('change', () => { lanSetupConfigure.disabled = lanSetupSelect.value === '' })
  const loadLanSetup = (): void => {
    lanSetupLoaded = true
    lanSetupRefresh.disabled = true
    void controlRequestJson('/api/mobile-access/lan/setup').then(renderLanSetup, () => {
      lanSetupStatus.textContent = t('lanSetupFailed')
    }).finally(() => { lanSetupRefresh.disabled = false })
  }
  lanSetupRefresh.addEventListener('click', () => { loadLanSetup() })
  lanSetupConfigure.addEventListener('click', () => {
    if (lanSetupSelect.value === '') return
    lanSetupConfigure.disabled = true
    lanSetupRefresh.disabled = true
    lanSetupConfigure.textContent = t('lanSetupConfiguring')
    lanSetupStatus.textContent = t('lanSetupConfiguring')
    void controlRequestJson('/api/mobile-access/lan/setup', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, address: lanSetupSelect.value, configureFirewall: true }),
    }, LONG_CONTROL_REQUEST_TIMEOUT_MS).then(renderLanSetup, () => {
      lanSetupStatus.textContent = t('lanSetupFailed')
    }).finally(() => {
      lanSetupConfigure.textContent = t('lanSetupConfigure')
      lanSetupRefresh.disabled = false
      lanSetupConfigure.disabled = lanRestartRequired || lanSetupSelect.options.length === 0
    })
  })
  const syncLanChange = (): void => {
    const waiting = lanChangeBusy || lanChangeRequest !== undefined
    lanChangeSelect.disabled = waiting
    lanChangeRefresh.disabled = waiting
    lanChangeConfirm.disabled = waiting || lanChangeSelect.options.length === 0
  }
  const renderLanChange = (data: Record<string, unknown>): void => {
    const networks = Array.isArray(data.networks)
      ? data.networks.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
      : []
    lanChangeSelect.replaceChildren()
    for (const network of networks) {
      const name = typeof network.name === 'string' ? network.name : ''
      const address = typeof network.address === 'string' ? network.address : ''
      if (name === '') continue
      const option = element('option')
      option.value = name
      option.textContent = `${name} · ${address}${network.current === true ? ` · ${t('lanChangeCurrent')}` : ''}`
      if (network.current === true) option.selected = true
      lanChangeSelect.append(option)
    }
    syncLanChange()
  }
  const loadLanChange = (): Promise<void> => {
    if (lanChangeRequest !== undefined) return lanChangeRequest
    lanChangeLoaded = true
    lanChangeRequest = Promise.all([
      controlRequestJson('/api/mobile-access/lan/networks'),
      controlRequestJson('/api/mobile-access/lan/control'),
    ]).then(([data, control]) => {
      if (!lifecycle.signal.aborted) { renderLanChange(data); render(control) }
    }, () => {
      if (!lifecycle.signal.aborted) lanChangeStatus.textContent = t('lanChangeRefreshFailed')
    }).finally(() => { lanChangeRequest = undefined; if (!lifecycle.signal.aborted) syncLanChange() })
    syncLanChange()
    return lanChangeRequest
  }
  lanChangeRefresh.addEventListener('click', () => { void loadLanChange() })
  lanChangeSelect.addEventListener('change', syncLanChange)
  lanChangeConfirm.addEventListener('click', () => {
    if (lanChangeSelect.value === '' || lanChangeBusy || lanChangeRequest !== undefined) return
    lanChangeBusy = true
    syncLanChange()
    lanChangeConfirm.textContent = t('lanChangeBusy')
    lanChangeStatus.textContent = t('lanChangeBusy')
    void controlRequestJson('/api/mobile-access/lan/rebind', {
      method: 'POST',
      body: JSON.stringify({ networkInterface: lanChangeSelect.value }),
    }, LONG_CONTROL_REQUEST_TIMEOUT_MS).then(async data => {
      if (lifecycle.signal.aborted) return
      lanChangeStatus.textContent = data.disconnected === true && data.ready === true ? t('lanChangeOkDisconnected') : t('lanChangeOk')
      try {
        const control = await controlRequestJson('/api/mobile-access/lan/control')
        if (lifecycle.signal.aborted) return
        render(control)
        await loadLanChange()
        if (!lifecycle.signal.aborted && data.ready === true) openPairing('key')
      } catch {
        if (!lifecycle.signal.aborted) lanChangeStatus.textContent = t('lanChangeRefreshFailed')
      }
    }, error => {
      if (lifecycle.signal.aborted) return
      const text = String(error)
      lanChangeStatus.textContent = text.includes('lan_rebind_unchanged') ? t('lanChangeUnchanged')
        : text.includes('lan_rebind_network_unavailable') ? t('lanChangeUnavailable')
        : text.includes('lan_rebind_unsupported') ? t('lanChangeUnsupported')
        : text.includes('lan_rebind_recovery_required') ? t('lanChangeRecoveryRequired')
        : t('lanChangeFailed')
    }).finally(() => {
      lanChangeBusy = false
      if (lifecycle.signal.aborted) return
      lanChangeConfirm.textContent = t('lanChangeConfirm')
      syncLanChange()
    })
  })
  const clearQrTarget = (target: HTMLDivElement): void => {
    if (typeof target.replaceChildren === 'function') {
      target.replaceChildren()
      return
    }
    // Fake DOM nodes in tests may lack replaceChildren; emulate it.
    try {
      while (target.firstChild) target.removeChild(target.firstChild)
    } catch { /* keep whatever the fake DOM supports */ }
  }
  const showQr = (svg: string, target: HTMLDivElement = qrBox): void => {
    clearQrTarget(target)
    if (svg === '') {
      const placeholderText = target === irohQr ? t('irohQrPlaceholder') : target === remoteQr ? t('remoteQrPlaceholder') : target === qrBox ? t('qrPlaceholder') : undefined
      if (placeholderText !== undefined) {
        const placeholder = element('span', 'dsh-mobile-control__qr-placeholder')
        placeholder.textContent = placeholderText
        target.hidden = false
        target.append(placeholder)
      } else {
        target.hidden = true
      }
      return
    }
    const image = element('img')
    image.alt = t('pairingQr')
    image.width = 176
    image.height = 176
    image.src = `data:image/svg+xml;base64,${btoa(svg)}`
    target.hidden = false
    target.append(image)
  }
  showQr('')
  const showIrohQrPlaceholder = (): void => {
    clearQrTarget(irohQr)
    const placeholder = element('span', 'dsh-mobile-control__qr-placeholder')
    placeholder.textContent = t('irohQrPlaceholder')
    irohQr.hidden = false
    irohQr.append(placeholder)
  }
  const showRemoteQrPlaceholder = (text: string): void => {
    clearQrTarget(remoteQr)
    const placeholder = element('span', 'dsh-mobile-control__qr-placeholder')
    placeholder.textContent = text
    remoteQr.hidden = false
    remoteQr.append(placeholder)
  }
  const openPairing = (target: 'key' | 'link'): void => {
    if (lanPairingBusy || !running) return
    lanPairingBusy = true
    pair.disabled = true
    linkPair.disabled = true
    const pairingOrigin = origin
    const generation = lanPairingGeneration
    if (target === 'key' || activeLanPairExpiresAt <= Date.now()) {
      activeLanPairUrl = ''
      activeLanPairExpiresAt = 0
      lanPairingValidity.hidden = true
      status.classList.remove('is-key')
      showQr('')
    }
    const operation = target === 'link' && activeLanPairUrl !== '' && activeLanPairExpiresAt > Date.now()
      ? Promise.resolve({ pairUrl: activeLanPairUrl, expiresAt: activeLanPairExpiresAt })
      : controlRequestJson('/api/mobile-access/lan/pairing/open', { method: 'POST', body: '{}' })
    void operation.then(async data => {
      if (lifecycle.signal.aborted || !running || origin !== pairingOrigin || generation !== lanPairingGeneration) return
      const value = typeof data.pairUrl === 'string' ? data.pairUrl : ''
      if (value === '' || typeof data.expiresAt !== 'number' || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now()) {
        status.textContent = t('keyGenerationFailed')
        return
      }
      activeLanPairUrl = value
      activeLanPairExpiresAt = data.expiresAt
      lanPairingValidity.hidden = false
      lanPairingValidity.textContent = t('pairingExpires', { time: formatTime(data.expiresAt) })
      if ('qrSvg' in data) showQr(typeof data.qrSvg === 'string' ? data.qrSvg : '')
      // Generating the LAN pairing code only shows the QR; it no longer copies
      // the plaintext key to the clipboard. Copying stays explicit via the link.
      if (target === 'key') { status.classList.remove('is-key'); status.textContent = t('qrGenerated'); return }
      if (value === '') { status.textContent = t('keyGenerationFailed'); return }
      try {
        await navigator.clipboard.writeText(value)
        status.textContent = t('linkCopied')
      } catch {
        status.textContent = t('copySecret', { kind: t('pairingLink'), value })
        status.classList.add('is-key')
      }
    }, error => { status.textContent = t('requestFailed', { error: String(error) }) }).finally(() => {
      lanPairingBusy = false
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
    void controlRequestJson('/api/mobile-access/lan/devices').then(renderDevices, error => {
      status.textContent = t('requestFailed', { error: String(error) })
      devicePanel.replaceChildren()
      const note = element('p', 'dsh-mobile-control__device-empty'); note.textContent = t('noDevices')
      devicePanel.append(note)
    })
  }
  manageDevices.addEventListener('click', () => {
    selectView('devices')
    loadDevices()
  })
  resetAll.addEventListener('click', () => {
    if (!window.confirm(t('confirmResetDevices'))) return
    void controlRequestJson('/api/mobile-access/lan/devices/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(loadDevices, error => { status.textContent = t('requestFailed', { error: String(error) }) })
  })
  const renderRemote = (data: Record<string, unknown>): void => {
    if (data.provider !== latestRemoteState.provider || data.origin !== latestRemoteState.origin) {
      remotePairingGeneration += 1
      activeRemotePairUrl = ''
      activeRemotePairExpiresAt = 0
      remotePairLink.hidden = true
      remotePairLink.textContent = ''
      pairingValidity.hidden = true
      showQr('', remoteQr)
    }
    latestRemoteState = data
    remoteRunning = data.running === true
    remoteProvider = parseMobileRemoteProvider(data.provider)
    const cpolar = remoteProvider === 'cpolar'
    const cloudflared = remoteProvider === 'cloudflared'
    const frp = remoteProvider === 'frp'
    const origin = remoteProvider === 'origin'
    const iroh = remoteProvider === 'iroh'
    // Current-connection copy follows the controller, never the unsaved form mode.
    const managedOrigin = origin && data.originMode === 'managed'
    const tailscale = remoteProvider === 'tailscale'
    tailscaleChoice.setAttribute('aria-checked', String(tailscale))
    cpolarChoice.setAttribute('aria-checked', String(cpolar))
    cloudflaredChoice.setAttribute('aria-checked', String(cloudflared))
    // One tab stop for the group: only the checked card is reachable with Tab.
    tailscaleChoice.tabIndex = tailscale ? 0 : -1
    cpolarChoice.tabIndex = cpolar ? 0 : -1
    cloudflaredChoice.tabIndex = cloudflared ? 0 : -1
    frpChoice.setAttribute('aria-pressed', String(frp))
    originChoice.setAttribute('aria-pressed', String(origin))
    irohChoice.setAttribute('aria-pressed', String(iroh))
    applyChoiceSelection()
    tailscaleChoice.disabled = remoteProviderBusy
    cpolarChoice.disabled = remoteProviderBusy
    cloudflaredChoice.disabled = remoteProviderBusy
    frpChoice.disabled = remoteProviderBusy
    originChoice.disabled = remoteProviderBusy
    irohChoice.disabled = remoteProviderBusy
    cpolarSetup.hidden = !cpolar
    cloudflaredSetup.hidden = !cloudflared
    frpSetup.hidden = !frp
    originSetup.hidden = !origin
    irohSetup.hidden = !iroh
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
    cpolarInstall.hidden = !cpolar || cpolarInstalled || !cpolarSupported
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
    const cloudflaredProvider = providers.cloudflared !== null && typeof providers.cloudflared === 'object' ? providers.cloudflared as Record<string, unknown> : {}
    const cloudflaredComponent = cloudflaredProvider.component !== null && typeof cloudflaredProvider.component === 'object'
      ? cloudflaredProvider.component as Record<string, unknown>
      : {}
    cloudflaredInstalled = cloudflaredComponent.installed === true
    const cloudflaredSupported = cloudflaredComponent.supported !== false
    const cloudflaredComponentError = typeof cloudflaredComponent.errorCode === 'string' ? cloudflaredComponent.errorCode : ''
    const cloudflaredVersion = typeof cloudflaredComponent.version === 'string' ? cloudflaredComponent.version : ''
    const cloudflaredDownloadBytes = typeof cloudflaredComponent.downloadBytes === 'number' ? cloudflaredComponent.downloadBytes : 0
    if (cloudflaredDownloadBytes > 0) cloudflaredDownloadSize = formatMegabytes(cloudflaredDownloadBytes)
    const cloudflaredStoragePath = typeof cloudflaredComponent.storagePath === 'string'
      ? cloudflaredComponent.storagePath
      : `DSH Mobile ${t('pluginPrivateDirectory')}`
    cloudflaredStorage.textContent = cloudflaredStoragePath
    cloudflaredStorage.title = cloudflaredStoragePath
    cloudflaredChoiceBadge.textContent = cloudflaredInstalled ? t('ready') : t('cloudflaredBadge')
    // A quick tunnel needs no account, so installation is the only precondition.
    cloudflaredInstall.hidden = !cloudflared || cloudflaredInstalled || !cloudflaredSupported
    cloudflaredInstall.textContent = cloudflaredDownloadBytes > 0
      ? t('installWithSize', { size: formatMegabytes(cloudflaredDownloadBytes) })
      : t('installOfficial')
    cloudflaredInstall.disabled = remoteProviderBusy
    cloudflaredPurge.hidden = !cloudflaredInstalled
    cloudflaredComponentStatus.textContent = !cloudflaredSupported
      ? t('cloudflaredUnsupported')
      : !cloudflaredInstalled
        // A component that exists but failed verification must not be reported as
        // absent: that sends the user to reinstall something already installed.
        ? (cloudflaredComponentError === 'cloudflared_component_invalid' ? t('cloudflaredInvalid') : t('cloudflaredNotInstalled'))
        : t('cloudflaredReady', { version: cloudflaredVersion })
    const cloudflaredTunnelConfiguration = cloudflaredProvider.configuration !== null
      && typeof cloudflaredProvider.configuration === 'object'
      ? cloudflaredProvider.configuration as Record<string, unknown>
      : {}
    cloudflaredTunnelMode = cloudflaredTunnelConfiguration.mode === 'named' ? 'named' : 'quick'
    cloudflaredTunnelConfigured = cloudflaredTunnelConfiguration.configured === true
    configuredCloudflaredHostname = typeof cloudflaredTunnelConfiguration.hostname === 'string' ? cloudflaredTunnelConfiguration.hostname : ''
    configuredCloudflaredPort = typeof cloudflaredTunnelConfiguration.port === 'number' ? cloudflaredTunnelConfiguration.port : 3444
    const cloudflaredTunnelError = typeof cloudflaredTunnelConfiguration.errorCode === 'string' ? cloudflaredTunnelConfiguration.errorCode : ''
    // A staged choice survives polls until the saved configuration agrees with it.
    if (cloudflaredModeDraft !== null && cloudflaredModeDraft === cloudflaredTunnelMode) cloudflaredModeDraft = null
    const cloudflaredShownMode = cloudflaredModeDraft ?? cloudflaredTunnelMode
    cloudflaredModeQuick.classList.toggle('is-active', cloudflaredShownMode === 'quick')
    cloudflaredModeNamed.classList.toggle('is-active', cloudflaredShownMode === 'named')
    cloudflaredModeQuick.setAttribute('aria-pressed', String(cloudflaredShownMode === 'quick'))
    cloudflaredModeNamed.setAttribute('aria-pressed', String(cloudflaredShownMode === 'named'))
    cloudflaredModeQuick.disabled = remoteProviderBusy
    cloudflaredModeNamed.disabled = remoteProviderBusy
    cloudflaredModeHint.textContent = cloudflaredShownMode === 'named' ? t('cloudflaredTunnelNamedHint') : t('cloudflaredTunnelQuickHint')
    // The component note describes whichever tunnel is about to run, so a
    // quick-tunnel warning never sits next to named-tunnel settings.
    cloudflaredNote.textContent = cloudflaredShownMode === 'named' ? t('cloudflaredNamedNote') : t('cloudflaredQuickNote')
    cloudflaredTunnelSave.textContent = cloudflaredSaveLabel()
    syncCloudflaredForm()
    // Untouched fields always mirror the saved configuration, so a field can never
    // keep showing a value that is no longer in effect.
    if (!cloudflaredHostnameDirty) cloudflaredHostname.value = configuredCloudflaredHostname
    if (!cloudflaredPortDirty) cloudflaredPort.value = String(configuredCloudflaredPort)
    cloudflaredToken.placeholder = cloudflaredTunnelConfigured ? t('cloudflaredTunnelTokenSaved') : t('cloudflaredTunnelTokenPlaceholder')
    // The hint must describe the port Cloudflare will actually be pointed at, which
    // is the one in the field, not the last saved value.
    const cloudflaredFieldPort = String(cloudflaredPort.value ?? '').trim()
    cloudflaredTunnelHint.textContent = t('cloudflaredTunnelHint', {
      port: cloudflaredFieldPort === '' ? String(configuredCloudflaredPort) : cloudflaredFieldPort,
    })
    cloudflaredTunnelStatus.textContent = cloudflaredTunnelError !== ''
      ? t('cloudflaredTunnelInvalid')
      : cloudflaredTunnelConfigured
        ? t('cloudflaredTunnelConfigured', { hostname: configuredCloudflaredHostname, port: String(configuredCloudflaredPort) })
        : t('cloudflaredTunnelMissing')
    cloudflaredTunnelSave.disabled = remoteProviderBusy || !cloudflaredInstalled
    cloudflaredTunnelForget.hidden = !cloudflaredTunnelConfigured
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
    // Provisioning mode and entry certificate hydrate from the saved status only
    // while the form is untouched, exactly like the other saved fields.
    const configuredFrpMode = frpConfiguration.mode === 'attach' ? 'attach' : 'deploy'
    const configuredFrpEntryTls = frpConfiguration.entryTls === 'self-signed' ? 'self-signed' : 'public-ip-cert'
    if (frpConfigured) {
      frpConfiguredMode = configuredFrpMode
      frpConfiguredEntryTls = configuredFrpEntryTls
    }
    if (frpConfigured && !frpModeDraft) frpMode.value = configuredFrpMode
    if (frpConfigured && !frpEntryTlsDraft) frpEntryTls.value = configuredFrpEntryTls
    if (typeof frpConfiguration.vhostHttpPort === 'number') configuredFrpVhostPort = frpConfiguration.vhostHttpPort
    if (typeof frpConfiguration.publicPort === 'number') configuredFrpPublicPort = frpConfiguration.publicPort
    configuredFrpProxyName = typeof frpConfiguration.proxyName === 'string' && frpConfiguration.proxyName !== ''
      ? frpConfiguration.proxyName
      : undefined
    if (!frpVhostDraft) {
      if (frpMode.value === 'attach' && configuredFrpMode === 'attach' && configuredFrpEntryTls === 'public-ip-cert') {
        frpVhostPort.value = String(configuredFrpVhostPort)
        frpAttachVhostExplicit = true
      } else {
        frpVhostPort.value = frpMode.value === 'deploy' ? String(configuredFrpVhostPort) : ''
      }
    }
    if (frpPublicPort.value === '' || frpPublicPort.value === '33080') frpPublicPort.value = String(configuredFrpPublicPort)
    // Attach mode never installs or deploys anything on the VPS: the runbook is
    // the whole deliverable, so the SSH/deploy controls disappear.
    const attachSelected = frpMode.value === 'attach'
    const selfSignedSelected = attachSelected && frpEntryTls.value === 'self-signed'
    frpStep2Title.textContent = t(attachSelected ? 'frpStep2TitleAttach' : 'frpStep2Title')
    // The step-2 group <summary> is its visible heading while the group is
    // collapsed, so it has to follow the same mode switch as the inner <strong>.
    frpVpsSummary.textContent = t(attachSelected ? 'frpStep2TitleAttach' : 'frpStep2Title')
    frpStep2Text.textContent = attachSelected && configuredFrpProxyName === undefined
      ? t('loadingRemoteStatus') : t(attachSelected ? 'frpStep2TextAttach' : 'frpStep2Text')
    frpStep4Text.textContent = t(attachSelected ? 'frpStep4TextAttach' : 'frpStep4Text')
    frpAppRequirement.textContent = t(selfSignedSelected ? 'frpAppRequirementSelfSigned' : 'frpAppRequirement')
    frpCopyTemplate.hidden = attachSelected
    frpCopyAttachPlan.hidden = !attachSelected
    frpCopyAttachToken.hidden = !attachSelected
    frpCopyAttachPlan.disabled = remoteProviderBusy || configuredFrpProxyName === undefined
    frpCopyAttachToken.disabled = remoteProviderBusy || configuredFrpProxyName === undefined
    frpSelfCheckButton.hidden = !frpConfigured
    frpVhostPort.disabled = selfSignedSelected
    frpVhostLabel.hidden = selfSignedSelected
    frpVhostPort.required = attachSelected && !selfSignedSelected
    frpVhostHint.textContent = frpVhostPort.required ? t('frpAttachModeRequiresVhostPort') : t('frpVhostHttpPortHint')
    frpEntryTls.disabled = !attachSelected
    frpEntryTlsLabel.hidden = !attachSelected
    frpPublicPortLabel.hidden = !selfSignedSelected
    vpsDeployText.hidden = attachSelected
    vpsChangesTitle.hidden = attachSelected
    vpsChanges.hidden = attachSelected
    vpsDeployFields.hidden = attachSelected
    vpsDeploy.hidden = attachSelected
    vpsDeployStatus.hidden = attachSelected
    vpsCopyUninstall.hidden = attachSelected
    vpsUninstall.hidden = attachSelected
    frpInstall.hidden = frpInstalled || !frpSupported
    frpInstall.textContent = frpDownloadBytes > 0
      ? t('installWithSize', { size: formatMegabytes(frpDownloadBytes) })
      : t('installFrpc')
    frpInstall.disabled = remoteProviderBusy
    frpConfigure.disabled = remoteProviderBusy || !frpInstalled
    frpActionHint.hidden = !frpConfigure.disabled
    frpActionHint.textContent = t(remoteProviderBusy ? 'frpActionBusy' : !frpSupported ? 'frpUnsupported' : 'frpInstallBeforeConnect')
    vpsDeploy.disabled = remoteProviderBusy || !validVpsDeploymentForm()
    vpsCopyUninstall.disabled = vpsDeploy.disabled
    vpsUninstall.disabled = vpsDeploy.disabled
    frpPurge.hidden = !frpInstalled && !frpConfigured
    frpComponentStatus.textContent = !frpSupported
      ? t('frpUnsupported')
      : frpInstalled ? t('frpComponentReady', { version: frpVersion }) : t('frpNotInstalled')
    frpConfigurationStatus.textContent = frpConfigured
      ? t('frpConfigurationReady') : t(attachSelected ? 'frpConfigurationMissingAttach' : 'frpConfigurationMissing')
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
      frpVpsGroup.open = !frpConfigured
      frpLayoutInitialized = true
    }
    const irohProvider = providers.iroh !== null && typeof providers.iroh === 'object' ? providers.iroh as Record<string, unknown> : {}
    const irohComponent = irohProvider.component !== null && typeof irohProvider.component === 'object'
      ? irohProvider.component as Record<string, unknown>
      : {}
    irohInstalled = irohComponent.installed === true
    const irohSupported = irohComponent.supported !== false
    const irohComponentError = typeof irohComponent.errorCode === 'string' ? irohComponent.errorCode : ''
    const irohVersion = typeof irohComponent.version === 'string' ? irohComponent.version : ''
    const irohDownloadBytes = typeof irohComponent.downloadBytes === 'number' ? irohComponent.downloadBytes : 0
    const irohStoragePath = typeof irohComponent.storagePath === 'string' ? irohComponent.storagePath : `DSH Mobile ${t('pluginPrivateDirectory')}`
    irohInstall.hidden = irohInstalled || !irohSupported
    irohPurge.hidden = !irohInstalled
    irohPurge.disabled = iroh && remoteRunning
    if (irohVerifying) {
      // A poll that lands mid-verification must not wipe the in-flight
      // progress: the checksum check is one quick round trip, so the bar
      // stays indeterminate until this flag clears.
      irohInstallProgress.hidden = false
      irohInstall.disabled = true
      irohInstall.textContent = t('installingIroh')
      irohInstall.setAttribute('aria-busy', 'true')
      irohComponentStatus.textContent = t('installingIroh')
    } else {
      irohInstallProgress.hidden = true
      irohInstall.setAttribute('aria-busy', 'false')
      irohInstall.disabled = remoteProviderBusy
      irohInstall.textContent = irohDownloadBytes > 0
        ? t('installWithSize', { size: formatMegabytes(irohDownloadBytes) })
        : t('installOfficial')
      irohComponentStatus.textContent = !irohSupported
        ? t('irohPlatformUnsupported')
          : irohInstalled ? t('installed') + (irohVersion === '' ? '' : ` · ${irohVersion}`)
          // A sidecar that exists but failed verification must not be
          // reported as merely absent: that sends the user to install over
          // something broken without naming it.
          : irohComponentError === 'irohSidecarInvalid' ? t('irohSidecarInvalid')
            : t('irohUnavailable')
    }
    irohStorage.textContent = irohStoragePath
    irohStorage.title = irohStoragePath
    const originProvider = providers.origin !== null && typeof providers.origin === 'object' ? providers.origin as Record<string, unknown> : {}
    const originConfiguration = originProvider.configuration !== null && typeof originProvider.configuration === 'object'
      ? originProvider.configuration as Record<string, unknown> : {}
    originConfigured = originConfiguration.configured === true
    if (!originFormDirty && !originFormBusy) {
      originPublic.value = typeof originConfiguration.publicOrigin === 'string' ? originConfiguration.publicOrigin : ''
      originHost.value = typeof originConfiguration.listenHost === 'string' ? originConfiguration.listenHost : '127.0.0.1'
      originPort.value = typeof originConfiguration.listenPort === 'number' ? String(originConfiguration.listenPort) : '3444'
      originCidrs.value = Array.isArray(originConfiguration.allowedCidrs) ? originConfiguration.allowedCidrs.filter(value => typeof value === 'string').join(', ') : '127.0.0.0/8'
    }
    originSetup.setAttribute('aria-busy', String(originFormBusy))
    originConfigure.setAttribute('aria-busy', String(originFormBusy))
    originConfigure.textContent = originFormBusy ? t('saving') : t('originSaveStart')
    for (const input of [originPublic, originHost, originPort, originCidrs]) input.disabled = remoteProviderBusy
    originConfigure.disabled = remoteProviderBusy
    originPurge.disabled = remoteProviderBusy
    originPurge.hidden = !originConfigured && originConfiguration.errorCode !== 'origin_config_invalid' && originProvider.running !== true
    const originListening = origin && originProvider.state === 'ready' && originProvider.running === true
    const backendOrigin = originListening && typeof data.backendOrigin === 'string' ? data.backendOrigin
      : typeof originConfiguration.backendOrigin === 'string' ? originConfiguration.backendOrigin : ''
    originBackend.hidden = backendOrigin === ''
    originBackendLabel.textContent = originListening ? t('originBackendListening') : t('originBackendSaved')
    originBackendAddress.textContent = backendOrigin
    originCopyBackend.disabled = remoteProviderBusy || backendOrigin === ''
    const caddyComponentInfo = originProvider.component as Record<string, unknown> | undefined
    const caddyInstalled = caddyComponentInfo !== undefined && caddyComponentInfo.installed === true
    const caddySupported = caddyComponentInfo !== undefined && caddyComponentInfo.supported === true
    if (!caddyModePreviewDirty) caddyModeManagedSelected = data.originMode === 'managed'
    const showManaged = origin && caddyModeManagedSelected
    caddyModePreviewNote.hidden = !origin || !caddyModePreviewDirty || caddyModeManagedSelected === managedOrigin
    const caddyConfiguration = typeof data.caddyConfiguration === 'object' && data.caddyConfiguration !== null ? data.caddyConfiguration as Record<string, unknown> : {}
    const caddyState = typeof data.caddyState === 'object' && data.caddyState !== null ? data.caddyState as Record<string, unknown> : {}
    caddyModeRow.hidden = !origin
    caddyForm.hidden = !showManaged
    originFields.hidden = showManaged
    originFormActions.hidden = showManaged
    originHelp.hidden = showManaged
    originWarning.hidden = showManaged
    if (showManaged) originBackend.hidden = true
    caddyInstall.hidden = !showManaged || caddyInstalled
    caddyInstallNote.hidden = !showManaged
    caddySave.hidden = !showManaged || !caddyInstalled
    caddyPurgeButton.hidden = !showManaged || (!caddyInstalled && caddyConfiguration.configured !== true)
    caddyStatus.hidden = !showManaged
    caddyStatus.textContent = !caddySupported && !caddyInstalled ? t('caddyUnavailable')
      : caddyState.enabled === true && caddyState.state === 'ready' ? t('caddyVerified')
        : caddyState.state === 'starting' || caddyState.state === 'connecting' ? t('remoteStateConnecting')
          : caddyState.state === 'error' ? t('caddyConnectionFailed') : caddyInstalled ? t('caddyInstalled') : t('caddyInstallNote')
    caddyModeManaged.checked = caddyModeManagedSelected
    caddyModeExternal.checked = !caddyModeManagedSelected
    caddyModeManaged.disabled = remoteProviderBusy
    caddyModeExternal.disabled = remoteProviderBusy
    if (!caddyFormBusy && !caddyFormDirty) {
      caddyDomain.value = typeof caddyConfiguration.publicOrigin === 'string' ? caddyConfiguration.publicOrigin : ''
      caddyPort.value = typeof caddyConfiguration.listenPort === 'number' ? String(caddyConfiguration.listenPort) : '8443'
    }
    caddyInstall.disabled = remoteProviderBusy || !caddySupported || caddyInstalled
    caddySave.disabled = remoteProviderBusy || !caddySupported || !caddyInstalled
    caddyPurgeButton.disabled = remoteProviderBusy
    for (const input of [caddyDomain, caddyProvider, caddySecretId, caddySecretKey, caddyPort]) input.disabled = remoteProviderBusy || !caddySupported
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
    // Absent on every other platform, so Windows and Linux never see this block.
    const macFileAccess = data.macFileAccess === 'missing' ? 'missing' : data.macFileAccess === 'ok' ? 'ok' : undefined
    remotePermission.hidden = macFileAccess !== 'missing' || remotePermissionDismissed || !remoteRunning
    frpChoiceBadge.textContent = frpConfigured && frpInstalled ? t('ready') : t('advanced')
    originChoiceBadge.textContent = managedOrigin ? t(remoteReady ? 'ready' : 'advanced') : originListening ? t('originBackendReady') : t('advanced')
    // The selected provider and its state already live in the left column. The
    // status line is only meaningful while connecting or when attention/errors
    // occur; hide it with display:none (not just hidden text) so it takes no space.
    if (remoteStatus.style) remoteStatus.style.display = state === 'off' && remoteFailureText === '' ? 'none' : ''
    remoteAccess.hidden = !remoteReady
    remoteAccessLink.href = remoteOrigin
    remoteAccessLink.textContent = remoteOrigin
    remoteAccessLink.title = remoteOrigin
    remoteStatus.classList.toggle('is-running', remoteReady)
    const labels: Record<string, string> = {
      off: t('remoteOff'),
      unavailable: cpolar ? t('remoteUnavailableCpolar')
        : cloudflared ? t('remoteUnavailableCloudflared')
          : frp ? t('remoteUnavailableFrp') : origin ? t('originUnavailable')
            : iroh ? (irohInstalled ? t('irohInstalledNotReady') : t('irohUnavailable')) : t('remoteUnavailableTailscale'),
      starting: cpolar ? t('remoteStartingCpolar')
        : cloudflared ? t('remoteStartingCloudflared')
          : frp ? t('remoteStartingFrp') : origin ? t('originStarting') : iroh ? t('irohStarting') : t('remoteStartingTailscale'),
      'needs-login': t('remoteNeedsLogin'),
      connecting: cpolar ? t('remoteConnectingCpolar')
        : cloudflared ? t('remoteConnectingCloudflared')
          : frp ? t('remoteConnectingFrp') : iroh ? t('irohConnecting') : t('remoteConnectingTailscale'),
      ready: origin ? t(managedOrigin ? 'caddyVerified' : 'originReady') : t('remoteReady'),
      error: t('remoteError'),
    }
    const errorLabels: Record<string, string> = translatedRemoteErrors()
    remoteStatus.textContent = remoteSetupPending && needsFunnelSetup
      ? t('setupOpened')
      : (state === 'error' ? (errorLabels[errorCode] ?? labels.error!) : (labels[state] ?? labels.error!))
    // Keep a just-failed action's message for this one repaint, then release it.
    if (remoteFailureText !== undefined) {
      remoteStatus.textContent = remoteFailureText
      remoteFailureText = undefined
    }
    remoteGuide.hidden = !needsFunnelSetup
    remoteSetup.disabled = remoteSetupUrl === '' || remoteReconnectBusy
    remoteSetupRetry.disabled = remoteReconnectBusy
    remoteToggle.textContent = remoteRunning ? t('disableRemote') : t('enableRemote')
    const originPrepared = data.originMode === 'managed' ? caddySupported && caddyInstalled && caddyConfiguration.configured === true : originConfigured && !caddyModeManagedSelected
    const providerPrepared = cpolar ? cpolarInstalled && cpolarConfigured
      : cloudflared ? cloudflaredInstalled
        : frp ? frpInstalled && frpConfigured : origin ? originPrepared : iroh ? irohInstalled : true
    const namedUnconfigured = cloudflared && cloudflaredShownMode === 'named' && cloudflaredTunnelMode !== 'named' && !remoteRunning
    remoteToggle.disabled = remoteProviderBusy || (!providerPrepared && !(origin && remoteRunning)) || namedUnconfigured
    if (namedUnconfigured) {
      remoteStatus.textContent = t('cloudflaredEnableNeedsConfig')
      if (remoteStatus.style) remoteStatus.style.display = ''
    }
    remoteLogin.hidden = !tailscale || state !== 'needs-login' || remoteLoginUrl === ''
    remoteReconnect.hidden = needsFunnelSetup || (state !== 'error' && state !== 'unavailable')
      || !providerPrepared
    remoteActions.hidden = !providerPrepared && !(origin && remoteRunning)
    // No pairing QR is possible until the provider component is installed/prepared.
    if (!providerPrepared) remoteQr.hidden = true
    providerInstallRow.hidden = cpolarInstall.hidden && cloudflaredInstall.hidden
    remotePair.disabled = !remoteReady || remoteProviderBusy || remotePairingBusy
    remoteCopyLink.disabled = !remoteReady || remoteProviderBusy || remotePairingBusy
    remoteDevices.disabled = !remoteReady || remoteProviderBusy
    // The generic pair link points at the selected provider's origin. Under
    // iroh that origin only resolves inside the iroh transport while the app
    // expects the pairing descriptor above, so the generic pair actions would
    // only strand a scanner: hide them while iroh owns the remote slot.
    remotePair.hidden = iroh
    remoteCopyLink.hidden = iroh
    if (iroh) {
      remoteQr.hidden = true
      remotePairLink.hidden = true
    }
    irohPair.disabled = !remoteReady || !iroh || remoteProviderBusy
    // The trigger now lives in the shared action row, so it must hide for the
    // other remote providers instead of showing a permanently disabled button.
    irohPair.hidden = !iroh
    irohCopyDescriptor.hidden = !iroh
    if (iroh && irohInstalled && activeIrohQrSvg === '') showIrohQrPlaceholder()
    else if (!iroh || !irohInstalled) irohQr.hidden = true
    if ((!iroh || !remoteReady) && activeIrohDescriptor !== '') {
      activeIrohDescriptor = ''
      activeIrohPairExpiresAt = 0
      activeIrohQrSvg = ''
      showQr('', irohQr)
      setIrohQrZoomOpen(false)
      irohPairStatus.textContent = ''
    }
    irohCopyDescriptor.disabled = !iroh || !remoteReady || remoteProviderBusy || activeIrohDescriptor === '' || activeIrohPairExpiresAt <= Date.now()
    if (origin) { remoteReconnect.disabled = remoteProviderBusy || remoteReconnectBusy; remoteReset.disabled = remoteProviderBusy }
    else remoteReset.disabled = false
    if (!remoteReady) {
      remotePairingGeneration += 1
      remotePairLink.hidden = true
      activeRemotePairUrl = ''
      activeRemotePairExpiresAt = 0
      pairingValidity.hidden = true
      if (iroh) remoteQr.hidden = true
      else showRemoteQrPlaceholder(t('remoteQrPlaceholderIdle'))
    } else if (!iroh && activeRemotePairExpiresAt > 0 && Date.now() >= activeRemotePairExpiresAt) {
      // The pairing window is server-authoritative; the poll only reflects expiry
      // here — no background timer, no re-mint, and a stale QR can never survive.
      activeRemotePairUrl = ''
      remotePairLink.hidden = true
      remotePairLink.textContent = ''
      showRemoteQrPlaceholder(t('pairingExpired'))
      pairingValidity.hidden = false
      pairingValidity.textContent = t('pairingExpired')
    } else if (!iroh && activeRemotePairUrl !== '') {
      pairingValidity.hidden = false
      pairingValidity.textContent = t('pairingExpires', { time: formatTime(activeRemotePairExpiresAt) })
    } else {
      pairingValidity.hidden = true
      if (!iroh) showQr('', remoteQr)
    }
    // Source/cleanup disclosures are pinned to the bottom and only shown for the
    // provider that owns them.
    cpolarDetails.hidden = !cpolar
    cloudflaredDetails.hidden = !cloudflared
    frpDetails.hidden = !frp
    irohDetails.hidden = !iroh
    if (!needsFunnelSetup) remoteSetupPending = false
  }
  frpMode.addEventListener('change', () => {
    frpModeDraft = true
    if (frpMode.value === 'attach') {
      if (!frpAttachVhostExplicit) {
        frpVhostPort.value = ''
        frpVhostDraft = true
      }
    } else {
      frpEntryTls.value = 'public-ip-cert'
      frpEntryTlsDraft = true
      if (frpVhostPort.value === '') frpVhostPort.value = String(configuredFrpVhostPort)
      frpVhostDraft = true
    }
    frpVhostPort.removeAttribute('aria-invalid')
    renderRemote(latestRemoteState)
  })
  frpEntryTls.addEventListener('change', () => {
    frpEntryTlsDraft = true
    if (frpMode.value === 'attach' && frpEntryTls.value === 'public-ip-cert' && !frpAttachVhostExplicit) {
      frpVhostPort.value = ''
      frpVhostDraft = true
    }
    frpVhostPort.removeAttribute('aria-invalid')
    renderRemote(latestRemoteState)
  })
  frpVhostPort.addEventListener('input', () => {
    frpVhostDraft = true
    if (frpMode.value === 'attach') frpAttachVhostExplicit = frpVhostPort.value.trim() !== ''
    frpVhostPort.removeAttribute('aria-invalid')
  })
  let remoteLoadInFlight = false
  const loadRemote = (): void => {
    if (remoteLoadInFlight || originFormBusy || caddyFormBusy) return
    const epoch = remoteSnapshotEpoch
    remoteLoadInFlight = true
    void controlRequestJson('/api/mobile-access/remote/control')
      .then(data => { if (epoch === remoteSnapshotEpoch) renderRemote(data) }, error => {
        if (epoch === remoteSnapshotEpoch) remoteStatus.textContent = t('requestFailed', { error: String(error) })
      })
      .finally(() => { remoteLoadInFlight = false })
  }
  const chooseRemoteProvider = (provider: MobileRemoteProvider): void => {
    if (remoteProviderBusy || provider === remoteProvider) return
    if (remoteRunning && !window.confirm(t('switchProviderConfirm'))) return
    remoteProviderBusy = true
    tailscaleChoice.disabled = true
    cpolarChoice.disabled = true
    cloudflaredChoice.disabled = true
    frpChoice.disabled = true
    originChoice.disabled = true
    irohChoice.disabled = true
    remoteStatus.textContent = provider === 'cpolar' ? t('switchingCpolar')
      : provider === 'cloudflared' ? t('switchingCloudflared')
        : provider === 'frp' ? t('switchingFrp') : provider === 'origin' ? t('switchingOrigin') : provider === 'iroh' ? t('switchingIroh') : t('switchingTailscale')
    void controlRequestJson('/api/mobile-access/remote/provider', { method: 'POST', body: JSON.stringify({ provider }) })
      .then(renderRemote, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  }
  tailscaleChoice.addEventListener('click', () => { chooseRemoteProvider('tailscale') })
  cpolarChoice.addEventListener('click', () => { chooseRemoteProvider('cpolar') })
  cloudflaredChoice.addEventListener('click', () => { chooseRemoteProvider('cloudflared') })
  frpChoice.addEventListener('click', () => { chooseRemoteProvider('frp') })
  originChoice.addEventListener('click', () => { chooseRemoteProvider('origin') })
  irohChoice.addEventListener('click', () => { chooseRemoteProvider('iroh') })
  irohInstall.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const accepted = window.confirm(t('irohInstallConfirm'))
    if (!accepted) return
    remoteProviderBusy = true
    irohVerifying = true
    irohInstall.disabled = true
    irohInstall.textContent = t('installingIroh')
    irohInstall.setAttribute('aria-busy', 'true')
    irohInstallProgress.hidden = false
    irohComponentStatus.textContent = t('installingIroh')
    remoteStatus.textContent = t('installingIroh')
    void controlRequestJson('/api/mobile-access/remote/iroh/component/install', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => {
        remoteFailureText = remoteFailureTextFor(error, 'installFailed')
        remoteStatus.textContent = remoteFailureText
        // Keep the failure next to the button too: the shared status line
        // sits far above this section.
        irohComponentStatus.textContent = remoteFailureText
      })
      .finally(() => { remoteProviderBusy = false; irohVerifying = false; loadRemote() })
  })
  irohPurge.addEventListener('click', () => {
    if (remoteProviderBusy) return
    if (!window.confirm(t('irohPurgeConfirm'))) return
    remoteProviderBusy = true
    irohPurge.disabled = true
    irohComponentStatus.textContent = t('purgingIroh')
    remoteStatus.textContent = t('purgingIroh')
    void controlRequestJson('/api/mobile-access/remote/iroh/component/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => {
        remoteFailureText = remoteFailureTextFor(error, 'purgeFailed')
        remoteStatus.textContent = remoteFailureText
        irohComponentStatus.textContent = remoteFailureText
      })
      .finally(() => { remoteProviderBusy = false; irohPurge.disabled = false; loadRemote() })
  })
  const openIrohQrZoom = (): void => {
    if (activeIrohQrSvg === '' || irohQr.hidden) return
    irohQrZoomImage.src = `data:image/svg+xml;base64,${btoa(activeIrohQrSvg)}`
    setIrohQrZoomOpen(true)
    irohQrZoomClose.focus()
  }
  const closeIrohQrZoom = (): void => {
    setIrohQrZoomOpen(false)
    if (!irohQr.hidden) irohQr.focus()
  }
  irohQr.setAttribute('role', 'button')
  irohQr.setAttribute('tabindex', '0')
  irohQr.setAttribute('aria-label', t('enlargeQr'))
  irohQr.addEventListener('click', openIrohQrZoom)
  irohQr.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    openIrohQrZoom()
  })
  irohQrZoom.addEventListener('click', closeIrohQrZoom)
  irohQrZoomClose.addEventListener('click', closeIrohQrZoom)
  irohQrZoom.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    closeIrohQrZoom()
  })
  const openIrohPairing = async (): Promise<void> => {
    const generation = remotePairingGeneration
    activeIrohDescriptor = ''
    activeIrohPairExpiresAt = 0
    irohCopyDescriptor.disabled = true
    const data = await controlRequestJson('/api/mobile-access/remote/iroh/pairing/begin', { method: 'POST', body: '{}' })
    if (lifecycle.signal.aborted || remoteProvider !== 'iroh' || !remoteReady || generation !== remotePairingGeneration) return
    const record = data as Record<string, unknown>
    const qrSvg = typeof record.qrSvg === 'string' ? record.qrSvg : ''
    const code = typeof record.irohCode === 'string' ? record.irohCode : ''
    const expiresAt = typeof record.expiresAt === 'number' && Number.isFinite(record.expiresAt) ? record.expiresAt : 0
    showQr(qrSvg, irohQr)
    if (qrSvg === '' || code === '' || expiresAt <= Date.now()) { activeIrohQrSvg = ''; irohPairStatus.textContent = t('keyGenerationFailed'); return }
    activeIrohQrSvg = qrSvg
    // The QR and the copy action share the same one-time window. Re-copying
    // cannot invalidate a code the phone may already be scanning.
    const fields = ['version', 'type', 'endpointId', 'origin', 'localPort', 'irohCode', 'gatewayToken', 'caCertificate', 'instanceId', 'expiresAt']
    const descriptor: Record<string, unknown> = {}
    for (const field of fields) descriptor[field] = record[field]
    activeIrohDescriptor = JSON.stringify(descriptor)
    activeIrohPairExpiresAt = expiresAt
    irohPairStatus.textContent = t('irohPairingReady', { code })
  }
  irohPair.addEventListener('click', () => {
    if (remoteProviderBusy || !remoteReady || remoteProvider !== 'iroh') return
    remoteProviderBusy = true
    remoteSnapshotEpoch += 1
    renderRemote(latestRemoteState)
    irohPair.disabled = true
    irohPairStatus.textContent = t('loadingRemoteStatus')
    void openIrohPairing()
      .catch(error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); irohPairStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  })
  irohCopyDescriptor.addEventListener('click', () => {
    if (remoteProviderBusy || !remoteReady || remoteProvider !== 'iroh' || activeIrohDescriptor === '' || activeIrohPairExpiresAt <= Date.now()) return
    void navigator.clipboard.writeText(activeIrohDescriptor).then(
      () => { irohPairStatus.textContent = t('irohLinkCopied') },
      () => { irohPairStatus.textContent = t('remoteQrReady') },
    )
  })
  cloudflaredInstall.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const accepted = window.confirm(t('installConfirmCloudflared', { size: cloudflaredDownloadSize }))
    if (!accepted) return
    remoteProviderBusy = true
    cloudflaredInstall.disabled = true
    cloudflaredInstall.textContent = t('downloading')
    remoteStatus.textContent = t('installingCloudflared')
    void controlRequestJson('/api/mobile-access/remote/cloudflared/component/install', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteFailureText = remoteFailureTextFor(error, 'installFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  })
  cloudflaredPurge.addEventListener('click', () => {
    if (remoteProviderBusy) return
    if (!window.confirm(t('purgeCloudflaredConfirm'))) return
    remoteProviderBusy = true
    cloudflaredPurge.disabled = true
    remoteStatus.textContent = t('purgingCloudflared')
    void controlRequestJson('/api/mobile-access/remote/cloudflared/component/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteFailureText = t('purgeFailed', { error: String(error) }); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; cloudflaredPurge.disabled = false; loadRemote() })
  })
  // Tunnel type is staged locally and only reaches the provider through Save, so
  // clicking between the two never silently discards a saved token.
  const syncCloudflaredForm = (): void => {
    const mode = cloudflaredModeDraft ?? cloudflaredTunnelMode
    const named = mode === 'named'
    const locked = named && cloudflaredTunnelConfigured && cloudflaredTunnelMode === 'named' && !cloudflaredConfigEditing
    cloudflaredHostname.disabled = locked || remoteProviderBusy
    cloudflaredPort.disabled = locked || remoteProviderBusy
    cloudflaredToken.disabled = locked || remoteProviderBusy
    cloudflaredEditButton.disabled = remoteProviderBusy
    cloudflaredTunnelForget.disabled = remoteProviderBusy
    cloudflaredTunnelToggle.hidden = !named
    cloudflaredEditButton.hidden = !locked
    cloudflaredTunnelSave.hidden = !named || locked
    cloudflaredTunnelForget.hidden = !named || cloudflaredTunnelMode !== 'named' || cloudflaredConfigEditing
  }
  const showCloudflaredMode = (mode: 'quick' | 'named'): void => {
    cloudflaredModeDraft = mode
    cloudflaredModeQuick.classList.toggle('is-active', mode === 'quick')
    cloudflaredModeNamed.classList.toggle('is-active', mode === 'named')
    cloudflaredModeQuick.setAttribute('aria-pressed', String(mode === 'quick'))
    cloudflaredModeNamed.setAttribute('aria-pressed', String(mode === 'named'))
    cloudflaredModeHint.textContent = mode === 'named' ? t('cloudflaredTunnelNamedHint') : t('cloudflaredTunnelQuickHint')
    cloudflaredNote.textContent = mode === 'named' ? t('cloudflaredNamedNote') : t('cloudflaredQuickNote')
    cloudflaredTunnel.hidden = true
    cloudflaredTunnelToggle.textContent = t('cloudflaredShowConfig') + ' ▾'
    cloudflaredTunnelSave.textContent = cloudflaredSaveLabel()
    syncCloudflaredForm()
    if (mode === 'named' && cloudflaredTunnelMode !== 'named') {
      remoteToggle.disabled = true
      remoteStatus.textContent = t('cloudflaredEnableNeedsConfig')
      if (remoteStatus.style) remoteStatus.style.display = ''
    }
  }
  cloudflaredTunnelToggle.addEventListener('click', () => {
    const open = cloudflaredTunnel.hidden
    cloudflaredTunnel.hidden = !open
    cloudflaredTunnelToggle.textContent = open ? t('cloudflaredHideConfig') + ' ▴' : t('cloudflaredShowConfig') + ' ▾'
  })
  cloudflaredEditButton.addEventListener('click', () => {
    cloudflaredConfigEditing = true
    syncCloudflaredForm()
    cloudflaredTunnel.hidden = false
    cloudflaredTunnelToggle.textContent = t('cloudflaredHideConfig') + ' ▴'
  })
  const switchCloudflaredMode = (mode: 'quick' | 'named'): void => {
    if (remoteProviderBusy || (cloudflaredModeDraft ?? cloudflaredTunnelMode) === mode) return
    // Quick and named are different cloudflared tunnels; only one can run at a
    // time, so switching while connected must first close the current remote
    // connection (otherwise the UI shows the new mode while the old tunnel runs).
    const activeState = typeof latestRemoteState.state === 'string' ? latestRemoteState.state : 'off'
    if (remoteRunning || activeState !== 'off') {
      if (!window.confirm(t('cloudflaredSwitchModeDisconnect'))) return
      remoteProviderBusy = true
      remoteSnapshotEpoch += 1
      renderRemote(latestRemoteState)
      void controlRequestJson('/api/mobile-access/remote/control', { method: 'POST', body: JSON.stringify({ running: false, provider: 'cloudflared' }) })
        .then(data => { renderRemote(data); showCloudflaredMode(mode) }, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
        .finally(() => { remoteProviderBusy = false; loadRemote() })
      return
    }
    // Not connected: switch straight away, no dialog.
    showCloudflaredMode(mode)
  }
  cloudflaredModeQuick.addEventListener('click', () => { switchCloudflaredMode('quick') })
  cloudflaredModeNamed.addEventListener('click', () => { switchCloudflaredMode('named') })
  cloudflaredHostname.addEventListener('input', () => { cloudflaredHostnameDirty = true })
  cloudflaredPort.addEventListener('input', () => { cloudflaredPortDirty = true })
  cloudflaredTunnelSave.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const report = (message: string): void => {
      remoteStatus.textContent = message
      cloudflaredTunnelFeedback.hidden = false
      cloudflaredTunnelFeedback.textContent = message
    }
    const mode = cloudflaredModeDraft ?? cloudflaredTunnelMode
    const hostname = String(cloudflaredHostname.value ?? '').trim()
    const portValue = String(cloudflaredPort.value ?? '').trim()
    const port = Number(portValue)
    const token = String(cloudflaredToken.value ?? '')
    // The provider re-validates everything; these checks only keep an obviously
    // incomplete form from costing a round trip.
    if (mode === 'named') {
      if (hostname === '') { report(t('cloudflaredTunnelHostnameInvalid')); return }
      if (portValue === '' || !Number.isSafeInteger(port) || port < 1024 || port > 65535) {
        report(t('cloudflaredTunnelPortInvalid'))
        return
      }
      // The LAN gateway owns 3443 for as long as DSH runs, so this is not a
      // transient conflict worth a round trip.
      if (port === 3443) { report(t('cloudflaredTunnelPortReserved')); return }
      if (token === '' && !cloudflaredTunnelConfigured) { report(t('cloudflaredTunnelConfigMissing')); return }
      if (token !== '' && (token.length < 32 || !/^[A-Za-z0-9_=+/-]+$/u.test(token))) {
        report(t('cloudflaredTunnelTokenInvalid'))
        return
      }
    }
    remoteProviderBusy = true
    remoteSnapshotEpoch += 1
    renderRemote(latestRemoteState)
    cloudflaredTunnelSave.disabled = true
    cloudflaredTunnelSave.textContent = t('saving')
    report(mode === 'named' ? t('cloudflaredTunnelSaving') : t('switchingCloudflared'))
    void controlRequestJson('/api/mobile-access/remote/cloudflared/tunnel', {
      method: 'POST',
      body: JSON.stringify(mode === 'named' ? { mode, hostname, port, token, connect: true } : { mode: 'quick', connect: true }),
    })
      .then(data => {
        // The token is write-only: never keep a copy in the DOM after saving.
        cloudflaredToken.value = ''
        cloudflaredModeDraft = null
        cloudflaredConfigEditing = false
        // The saved values are now authoritative, so let the next poll restore them.
        cloudflaredHostnameDirty = false
        cloudflaredPortDirty = false
        remoteFailureText = ''
        cloudflaredTunnelFeedback.hidden = false
        cloudflaredTunnelFeedback.textContent = t('cloudflaredTunnelSaved')
        renderRemote(data)
      }, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); report(remoteFailureText) })
      .finally(() => {
        remoteProviderBusy = false
        cloudflaredTunnelSave.disabled = false
        cloudflaredTunnelSave.textContent = cloudflaredSaveLabel()
        loadRemote()
      })
  })
  cloudflaredTunnelForget.addEventListener('click', () => {
    if (remoteProviderBusy) return
    if (!window.confirm(t('cloudflaredTunnelForgetConfirm'))) return
    remoteProviderBusy = true
    cloudflaredTunnelForget.disabled = true
    remoteStatus.textContent = t('cloudflaredTunnelForgetting')
    void controlRequestJson('/api/mobile-access/remote/cloudflared/tunnel/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(data => {
        cloudflaredToken.value = ''
        cloudflaredHostname.value = ''
        cloudflaredPort.value = '3444'
        cloudflaredModeDraft = null
        cloudflaredHostnameDirty = false
        cloudflaredPortDirty = false
        remoteFailureText = ''
        renderRemote(data)
      }, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; cloudflaredTunnelForget.disabled = false; loadRemote() })
  })
  cpolarInstall.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const accepted = window.confirm(t('installConfirm'))
    if (!accepted) return
    remoteProviderBusy = true
    cpolarInstall.disabled = true
    cpolarInstall.textContent = t('downloading')
    remoteStatus.textContent = t('installingCpolar')
    void controlRequestJson('/api/mobile-access/remote/cpolar/component/install', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteFailureText = remoteFailureTextFor(error, 'installFailed'); remoteStatus.textContent = remoteFailureText })
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
      .then(renderRemote, error => { remoteFailureText = t('configureFailed', { error: String(error) }); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; cpolarConfigure.setAttribute('aria-busy', 'false'); cpolarConfigure.textContent = t('saveConnect'); loadRemote() })
  })
  cpolarPurge.addEventListener('click', () => {
    if (remoteProviderBusy) return
    if (!window.confirm(t('purgeConfirm'))) return
    remoteProviderBusy = true
    cpolarPurge.disabled = true
    remoteStatus.textContent = t('purging')
    void controlRequestJson('/api/mobile-access/remote/cpolar/component/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteFailureText = t('purgeFailed', { error: String(error) }); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; cpolarPurge.disabled = false; loadRemote() })
  })
  const frpForm = (): {
    readonly serverAddress: string
    readonly serverPort: number
    readonly token: string
    readonly publicOrigin: string
    readonly mode: 'deploy' | 'attach'
    readonly entryTls: 'public-ip-cert' | 'self-signed'
    readonly vhostHttpPort?: number
    readonly publicPort?: number
  } => {
    const vhostHttpPort = Number(frpVhostPort.value)
    const publicPort = Number(frpPublicPort.value)
    const mode = frpMode.value === 'attach' ? 'attach' as const : 'deploy' as const
    return {
      serverAddress: String(frpServer.value ?? '').trim(),
      serverPort: Number(frpPort.value),
      token: String(frpToken.value ?? ''),
      publicOrigin: String(frpOrigin.value ?? '').trim(),
      mode,
      entryTls: frpEntryTls.value === 'self-signed' ? 'self-signed' as const : 'public-ip-cert' as const,
      // A blank vhost port in attach mode must stay blank: the host refuses to
      // guess 7080 rather than silently probing the wrong port.
      ...(frpEntryTls.value === 'self-signed' || frpVhostPort.value.trim() === '' ? {} : { vhostHttpPort }),
      ...(frpEntryTls.value === 'self-signed' ? { publicPort } : {}),
    }
  }
  /** Attach mode never installs frps; every other combination keeps the managed path. */
  const frpAttachSelected = (): boolean => frpForm().mode === 'attach'
  /**
   * Attach-mode artefacts are built locally, so the token never reaches the host
   * API and the runbook can be produced before anything is saved.
   */
  const attachClipboardForm = (form: ReturnType<typeof frpForm>): Parameters<typeof createFrpAttachTemplateForClipboard>[0] => ({
    serverAddress: form.serverAddress,
    serverPort: form.serverPort,
    token: form.token === '' && frpConfigured ? '0123456789abcdef' : form.token,
    publicOrigin: form.publicOrigin,
    entryTls: form.entryTls,
    ...(form.entryTls === 'self-signed' || form.vhostHttpPort === undefined ? {} : { vhostHttpPort: form.vhostHttpPort }),
    ...(form.publicPort === undefined ? {} : { publicPort: form.publicPort }),
  })
  const validFrpForm = (form: ReturnType<typeof frpForm>): boolean => {
    return validateFrpForm(form).length === 0
  }
  let frpValidationShown = false
  let frpValidationAllowsSavedToken = false
  const renderFrpIssues = (issues: readonly FrpFormIssue[], focus = false): void => {
    for (const [name, input] of Object.entries(frpInputs)) {
      const issue = issues.find(item => item.field === name)
      const feedback = frpErrors.get(name as keyof FrpFormValues)!
      if (issue === undefined) input.removeAttribute('aria-invalid')
      else input.setAttribute('aria-invalid', 'true')
      feedback.hidden = issue === undefined
      feedback.textContent = issue === undefined ? '' : t(issue.messageKey)
    }
    frpFeedback.hidden = issues.length === 0
    frpFeedback.textContent = issues.map(issue => t(issue.messageKey)).join(' ')
    if (issues.length !== 0 && focus) {
      frpConnectionGroup.open = true
      frpInputs[issues[0]!.field].focus()
    }
  }
  const checkFrpForm = (form: FrpFormValues, allowSavedToken = false): boolean => {
    const issues = validateFrpForm(form, allowSavedToken)
    frpValidationShown = true
    frpValidationAllowsSavedToken = allowSavedToken
    renderFrpIssues(issues, true)
    return issues.length === 0
  }
  for (const [name, input] of Object.entries(frpInputs)) {
    input.addEventListener(name === 'mode' || name === 'entryTls' ? 'change' : 'input', () => {
      if (frpValidationShown) renderFrpIssues(validateFrpForm(frpForm(), frpValidationAllowsSavedToken))
    })
  }
  frpCopyTemplate.addEventListener('click', () => {
    const form = frpForm()
    if (!checkFrpForm(form)) return
    void navigator.clipboard.writeText(createFrpServerTemplateForClipboard(form.serverPort, form.token, form.publicOrigin))
      .then(() => { remoteStatus.textContent = t('templateCopied') }, () => { remoteStatus.textContent = t('templateCopyFailed') })
  })
  const frpAttachErrorText = (code: string): string => t(REMOTE_ERROR_MESSAGE_KEYS[code] ?? 'frpInputInvalid')
  const showFrpAttachError = (code: string): void => {
    const message = frpAttachErrorText(code)
    const issue = FRP_FORM_ERRORS[code]
    if (issue !== undefined) { frpValidationShown = true; renderFrpIssues([issue], true) }
    else { frpFeedback.textContent = message; frpFeedback.hidden = false }
    remoteStatus.textContent = message
  }
  const frpClipboardProxyName = (): string | undefined => {
    if (configuredFrpProxyName === undefined) {
      remoteStatus.textContent = t('loadingRemoteStatus')
      loadRemote()
    }
    return configuredFrpProxyName
  }
  frpCopyAttachPlan.addEventListener('click', () => {
    const form = frpForm()
    if (!checkFrpForm(form, frpConfigured)) return
    if (form.token !== '') {
      // Everything needed is local, so the token stays in the browser.
      const attachForm = attachClipboardForm(form)
      const code = frpAttachFormErrorCode(attachForm)
      if (code !== undefined) {
        showFrpAttachError(code)
        return
      }
      const proxyName = frpClipboardProxyName()
      if (proxyName === undefined) return
      void navigator.clipboard.writeText(createFrpAttachTemplateForClipboard(attachForm, { proxyName }))
        .then(() => { remoteStatus.textContent = t('frpAttachPlanCopied') },
          () => { remoteStatus.textContent = t('frpAttachPlanFailed', { error: t('templateCopyFailed') }) })
      return
    }
    if (!frpConfigured) {
      remoteStatus.textContent = t('frpInputInvalid')
      return
    }
    // The saved token is deliberately unreadable here, so the loopback host
    // merges it and returns the same runbook text.
    remoteProviderBusy = true
    frpCopyAttachPlan.disabled = true
    void controlRequestJson('/api/mobile-access/remote/frp/attach-plan', { method: 'POST', body: JSON.stringify(form) })
      .then(data => {
        const text = typeof data.frpAttachTemplate === 'string' ? data.frpAttachTemplate : ''
        if (text === '') throw new Error('frp_settings_invalid')
        return navigator.clipboard.writeText(text).then(() => { remoteStatus.textContent = t('frpAttachPlanCopied') })
      }, error => { showFrpAttachError(error instanceof Error ? error.message : String(error)); return undefined })
      .catch(error => { remoteStatus.textContent = t('frpAttachPlanFailed', { error: String(error) }) })
      .finally(() => { remoteProviderBusy = false; frpCopyAttachPlan.disabled = configuredFrpProxyName === undefined })
  })
  /** Copy a token-bearing frpc.toml only from the token the user just typed. */
  frpCopyAttachToken.addEventListener('click', () => {
    const form = frpForm()
    if (!checkFrpForm(form, frpConfigured)) return
    if (form.token !== '') {
      // The typed token is already in this browser, so the file is built locally.
      const attachForm = attachClipboardForm(form)
      const code = frpAttachFormErrorCode(attachForm)
      if (code !== undefined) {
        showFrpAttachError(code)
        return
      }
      const proxyName = frpClipboardProxyName()
      if (proxyName === undefined) return
      void navigator.clipboard.writeText(createFrpAttachFrpcTomlForClipboard(attachForm, {
        revealToken: true,
        proxyName,
      }))
        .then(() => { remoteStatus.textContent = t('frpAttachTokenCopied') },
          () => { remoteStatus.textContent = t('frpAttachTokenFailed', { error: t('templateCopyFailed') }) })
      return
    }
    frpToken.focus()
    remoteStatus.textContent = t('frpAttachTokenReenter')
  })
  const certificateStatusText = (status: Record<string, unknown> | undefined): string => {
    if (status === undefined) return ''
    const state = typeof status.state === 'string' ? status.state : 'unknown'
    const days = typeof status.daysRemaining === 'number' ? String(status.daysRemaining) : '0'
    if (state === 'ok') return t('frpAttachCertOk', { days })
    if (state === 'expiring') return t('frpAttachCertExpiring', { days })
    if (state === 'expired') return t('frpAttachCertExpired')
    return t('frpAttachCertUnknown')
  }
  const caStatusText = (status: Record<string, unknown> | undefined): string => {
    if (status === undefined) return ''
    const state = typeof status.state === 'string' ? status.state : 'unknown'
    const days = typeof status.daysRemaining === 'number' ? String(status.daysRemaining) : '0'
    if (state === 'ok') return t('frpAttachCaOk', { days })
    if (state === 'expiring') return t('frpAttachCaExpiring', { days })
    if (state === 'expired') return t('frpIngressCaExpired')
    return t('frpIngressCaInvalid')
  }
  frpSelfCheckButton.addEventListener('click', () => {
    if (remoteProviderBusy) return
    remoteProviderBusy = true
    frpSelfCheckButton.disabled = true
    frpSelfCheckStatus.hidden = false
    frpSelfCheckStatus.textContent = t('loadingStatus')
    void controlRequestJson('/api/mobile-access/remote/frp/self-check')
      .then(data => {
        const check = data.frpSelfCheck !== null && typeof data.frpSelfCheck === 'object'
          ? data.frpSelfCheck as Record<string, unknown> : {}
        const lines: string[] = []
        const caCertificate = check.caCertificate !== null && typeof check.caCertificate === 'object'
          ? check.caCertificate as Record<string, unknown> : undefined
        const caText = caStatusText(caCertificate)
        if (caText !== '') lines.push(caText)
        const certificate = check.certificate !== null && typeof check.certificate === 'object'
          ? check.certificate as Record<string, unknown> : undefined
        const certificateText = certificateStatusText(certificate)
        if (certificateText !== '') lines.push(certificateText)
        lines.push(check.frpsReachable === true ? t('frpAttachFrpsReachable') : t('frpAttachFrpsUnreachable'))
        if (check.entryTls === 'self-signed') {
          lines.push(check.entryReachable === true ? t('frpAttachEntryReachable') : t('frpAttachEntryUnreachable'))
        }
        frpSelfCheckStatus.textContent = lines.join(' · ')
      }, error => { frpSelfCheckStatus.textContent = t('requestFailed', { error: String(error) }) })
      .finally(() => { remoteProviderBusy = false; frpSelfCheckButton.disabled = false })
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
      mode: form.mode,
      entryTls: form.entryTls,
      ...(form.vhostHttpPort === undefined ? {} : { vhostHttpPort: form.vhostHttpPort }),
      ...(form.publicPort === undefined ? {} : { publicPort: form.publicPort }),
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
      .then(renderRemote, error => { remoteFailureText = remoteFailureTextFor(error, 'installFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
  })
  frpConfigure.addEventListener('click', () => {
    if (remoteProviderBusy || !frpInstalled) return
    const form = frpForm()
    const unchanged = frpConfigured && form.token === '' && form.serverAddress === configuredFrpServer
      && form.serverPort === configuredFrpPort && form.publicOrigin === configuredFrpOrigin
      // A mode or entry-certificate change is a real change even when the four
      // connection fields are untouched.
      && form.mode === (frpConfiguredMode === 'attach' ? 'attach' : 'deploy')
      && form.entryTls === (frpConfiguredEntryTls === 'self-signed' ? 'self-signed' : 'public-ip-cert')
      && (form.vhostHttpPort ?? configuredFrpVhostPort) === configuredFrpVhostPort
      && (form.publicPort ?? configuredFrpPublicPort) === configuredFrpPublicPort
    if (!unchanged) {
      // Attach mode is validated by the same parser the host uses, so the panel
      // reports the exact code (for example a missing vhostHTTPPort) instead of a
      // generic "invalid input".
      if (!checkFrpForm(form)) return
    }
    renderFrpIssues([])
    remoteProviderBusy = true
    frpConfigure.disabled = true
    frpActionHint.hidden = false
    frpActionHint.textContent = t('frpActionBusy')
    frpConfigure.setAttribute('aria-busy', 'true')
    frpConfigure.textContent = t('saving')
    const configure = unchanged
      ? Promise.resolve<Record<string, unknown>>({})
      : controlRequestJson('/api/mobile-access/remote/frp/configure', { method: 'POST', body: JSON.stringify(form) })
    void configure.then(() => {
      frpToken.value = ''
      remoteStatus.textContent = t('frpSavingConnecting')
      return controlRequestJson('/api/mobile-access/remote/control', { method: 'POST', body: JSON.stringify({ running: true }) })
    }).then(renderRemote, error => {
      const code = error instanceof Error ? error.message : String(error)
      if (FRP_FORM_ERRORS[code] !== undefined) showFrpAttachError(code)
      else { remoteFailureText = t('configureFailed', { error: String(error) }); remoteStatus.textContent = remoteFailureText }
    })
      .finally(() => {
        remoteProviderBusy = false
        frpConfigure.setAttribute('aria-busy', 'false')
        frpConfigure.textContent = t('frpSaveConnect')
        loadRemote()
      })
  })
  frpPurge.addEventListener('click', () => {
    if (remoteProviderBusy || !window.confirm(t(frpConfiguredMode === 'attach' && frpConfiguredEntryTls === 'self-signed'
      ? 'purgeFrpConfirmSelfSigned' : 'purgeFrpConfirm'))) return
    remoteProviderBusy = true
    frpPurge.disabled = true
    remoteStatus.textContent = t('purgingFrp')
    void controlRequestJson('/api/mobile-access/remote/frp/component/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) }, LONG_CONTROL_REQUEST_TIMEOUT_MS)
      .then(renderRemote, error => { remoteFailureText = t('purgeFailed', { error: String(error) }); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remoteProviderBusy = false; frpPurge.disabled = false; loadRemote() })
  })
  const clearOriginValidation = (): void => {
    for (const input of [originPublic, originHost, originPort, originCidrs]) input.removeAttribute('aria-invalid')
  }
  const showOriginFeedback = (message: string, error = false): void => {
    originFeedback.textContent = message
    originFeedback.hidden = false
    originFeedback.classList.toggle('is-error', error)
  }
  const showOriginError = (error: unknown): void => {
    const code = error instanceof Error ? error.message : String(error)
    const key = ORIGIN_ERROR_MESSAGE_KEYS[code]
    const fields: Record<string, HTMLInputElement> = {
      origin_public_origin_invalid: originPublic, origin_listen_host_invalid: originHost,
      origin_listen_address_unavailable: originHost, origin_listen_port_invalid: originPort,
      origin_listen_port_reserved: originPort, origin_listen_port_in_use: originPort,
      origin_allowed_cidrs_invalid: originCidrs,
    }
    clearOriginValidation()
    const input = fields[code]
    input?.setAttribute('aria-invalid', 'true')
    showOriginFeedback(key === undefined ? t('configureFailed', { error: String(error) }) : t(key), true)
  }
  const setOriginFormBusy = (busy: boolean): void => {
    originFormBusy = busy
    remoteProviderBusy = busy
    remoteSnapshotEpoch += 1
    renderRemote(latestRemoteState)
  }
  for (const input of [originPublic, originHost, originPort, originCidrs]) {
    input.addEventListener('input', () => {
      originFormDirty = true
      clearOriginValidation()
      originFeedback.hidden = true
    })
  }
  const syncCaddyModeVisibility = (): void => {
    caddyModeManagedSelected = caddyModeManaged.checked
    caddyModePreviewDirty = true
    renderRemote(latestRemoteState)
  }
  caddyModeManaged.addEventListener('change', () => {
    if (remoteProviderBusy) return
    originFeedback.hidden = true
    syncCaddyModeVisibility()
  })
  caddyModeExternal.addEventListener('change', () => {
    if (remoteProviderBusy) return
    if (latestRemoteState.originMode === 'managed' && !window.confirm(t('caddyModeChangeConfirm'))) { caddyModeManaged.checked = true; caddyModeExternal.checked = false; return }
    originFeedback.hidden = true
    syncCaddyModeVisibility()
    if (latestRemoteState.originMode !== 'managed') return
    setCaddyFormBusy(true)
    void controlRequestJson('/api/mobile-access/remote/origin/mode', { method: 'POST', body: JSON.stringify({ mode: 'external' }) }).then(data => {
      caddyModePreviewDirty = false; renderRemote(data)
    }, () => {
      caddyModePreviewDirty = false
      renderRemote(latestRemoteState)
      showOriginFeedback(t('caddyConnectionFailed'), true)
    }).finally(() => { setCaddyFormBusy(false); loadRemote() })
  })
  for (const input of [caddyDomain, caddyProvider, caddySecretId, caddySecretKey, caddyPort]) input.addEventListener('input', () => { caddyFormDirty = true })
  caddyProvider.addEventListener('change', () => { caddyFormDirty = true })
  caddyInstall.addEventListener('click', () => {
    if (remoteProviderBusy || caddyInstall.disabled || !window.confirm(t('caddyInstallConfirm'))) return
    setCaddyFormBusy(true)
    showCaddyFeedback(t('checkingComponent'))
    void controlRequestJson('/api/mobile-access/remote/caddy/component/install', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(data => { renderRemote(data); showCaddyFeedback(t('caddyInstalled')) }, () => showCaddyFeedback(t('caddyInstallFailed'), true))
      .finally(() => { setCaddyFormBusy(false); loadRemote() })
  })
  caddySave.addEventListener('click', () => {
    if (remoteProviderBusy || caddySave.disabled || !caddyModeManagedSelected) return
    clearOriginValidation()
    for (const input of [caddyDomain, caddySecretId, caddySecretKey, caddyPort]) {
      if (!input.reportValidity()) return
    }
    const body = {
      settings: {
        version: 1,
        publicOrigin: caddyDomain.value.trim(),
        dnsProvider: caddyProvider.value,
        listenPort: Number(caddyPort.value),
      },
      secretId: caddySecretId.value.trim(),
      secretKey: caddySecretKey.value.trim(),
      connect: true,
    }
    setCaddyFormBusy(true)
    showCaddyFeedback(t('saving'))
    void controlRequestJson('/api/mobile-access/remote/caddy/settings', { method: 'POST', body: JSON.stringify(body) })
      .then(data => {
        caddySecretId.value = ''; caddySecretKey.value = ''; caddyFormDirty = false
        caddyModePreviewDirty = false; renderRemote(data)
        if (data.state === 'error') showCaddyFeedback(t('caddyConnectionFailed'), true)
      }, () => showCaddyFeedback(t('caddyConnectionFailed'), true))
      .finally(() => { setCaddyFormBusy(false); loadRemote() })
  })
  caddyPurgeButton.addEventListener('click', () => {
    if (remoteProviderBusy || !window.confirm(t('caddyPurgeConfirm'))) return
    setCaddyFormBusy(true)
    void controlRequestJson('/api/mobile-access/remote/caddy/component/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(data => { caddySecretId.value = ''; caddySecretKey.value = ''; caddyFormDirty = false; caddyModePreviewDirty = false; renderRemote(data) }, () => showCaddyFeedback(t('caddyPurgeFailed'), true))
      .finally(() => { setCaddyFormBusy(false); loadRemote() })
  })

  originConfigure.addEventListener('click', () => {
    if (remoteProviderBusy || remoteProvider !== 'origin') return
    clearOriginValidation()
    for (const input of [originPublic, originHost, originPort, originCidrs]) {
      if (!input.reportValidity()) return
    }
    const form = {
      publicOrigin: originPublic.value.trim(), listenHost: originHost.value.trim(),
      listenPort: Number(originPort.value), allowedCidrs: originCidrs.value.trim().split(/[\s,]+/u).filter(Boolean),
    }
    setOriginFormBusy(true)
    showOriginFeedback(t('originSaving'))
    void controlRequestJson('/api/mobile-access/remote/origin/configure', { method: 'POST', body: JSON.stringify(form) })
      .then(() => controlRequestJson('/api/mobile-access/remote/origin/mode', { method: 'POST', body: JSON.stringify({ mode: 'external' }) }))
      .then(() => controlRequestJson('/api/mobile-access/remote/control', { method: 'POST', body: JSON.stringify({ running: true }) }))
      .then(data => {
        originFormDirty = false
        renderRemote(data)
        if (data.state === 'error') showOriginError(new Error(typeof data.errorCode === 'string' ? data.errorCode : 'origin_gateway_start_failed'))
        else originFeedback.hidden = true
      }, showOriginError)
      .finally(() => {
        setOriginFormBusy(false)
        const invalidInput = [originPublic, originHost, originPort, originCidrs].find(input => input.getAttribute('aria-invalid') === 'true')
        invalidInput?.focus()
        loadRemote()
      })
  })
  originPurge.addEventListener('click', () => {
    if (remoteProviderBusy || !window.confirm(t('originPurgeConfirm'))) return
    setOriginFormBusy(true)
    showOriginFeedback(t('originPurging'))
    void controlRequestJson('/api/mobile-access/remote/origin/purge', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(data => {
        originFormDirty = false
        clearOriginValidation()
        renderRemote(data)
        showOriginFeedback(t('originPurged'))
      }, showOriginError)
      .finally(() => { setOriginFormBusy(false); loadRemote() })
  })
  originCopyBackend.addEventListener('click', () => {
    const address = originBackendAddress.textContent ?? ''
    if (address === '' || remoteProviderBusy) return
    void Promise.resolve().then(() => navigator.clipboard.writeText(address))
      .then(() => { showOriginFeedback(t('originBackendCopied')) }, error => { showOriginFeedback(t('requestFailed', { error: String(error) }), true) })
  })
  remoteToggle.addEventListener('click', () => {
    if (remoteProviderBusy) return
    const nextRunning = !remoteRunning
    const provider = remoteProvider
    remoteProviderBusy = true
    remoteSnapshotEpoch += 1
    renderRemote(latestRemoteState)
    // A staged cloudflared mode that differs from the saved one must be committed
    // first: otherwise "Enable" would start the previously saved tunnel type while
    // the UI shows the newly selected one.
    const operation = nextRunning && provider === 'cloudflared' && cloudflaredModeDraft !== null && cloudflaredModeDraft !== cloudflaredTunnelMode
      ? controlRequestJson('/api/mobile-access/remote/cloudflared/tunnel', { method: 'POST', body: JSON.stringify({ mode: cloudflaredModeDraft, connect: true }) })
      : controlRequestJson('/api/mobile-access/remote/control', { method: 'POST', body: JSON.stringify({ running: nextRunning, provider }) })
    void operation
      .then(renderRemote, error => {
        remoteFailureText = remoteFailureTextFor(error, 'requestFailed')
        remoteStatus.textContent = remoteFailureText
        if (remoteProvider === 'cloudflared') {
          cloudflaredTunnelFeedback.hidden = false
          cloudflaredTunnelFeedback.textContent = remoteFailureText
        }
      })
      .finally(() => { remoteProviderBusy = false; loadRemote() })
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
    remoteStatus.textContent = remoteProvider === 'cpolar' ? t('reconnectingCpolar')
      : remoteProvider === 'cloudflared' ? t('reconnectingCloudflared')
        : remoteProvider === 'frp' ? t('reconnectingFrp') : remoteProvider === 'origin' ? t('reconnectingOrigin') : remoteProvider === 'iroh' ? t('reconnectingIroh') : t('reconnectingTailscale')
    void controlRequestJson('/api/mobile-access/remote/reconnect', { method: 'POST', body: '{}' })
      .then(renderRemote, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => {
        remoteReconnectBusy = false
        remoteReconnect.disabled = false
        remoteSetup.disabled = remoteSetupUrl === ''
        remoteSetupRetry.disabled = false
      })
  }
  remoteReconnect.addEventListener('click', reconnectRemote)
  remoteSetupRetry.addEventListener('click', () => { remoteSetupPending = false; reconnectRemote() })
  remotePermissionOpen.addEventListener('click', () => {
    window.open('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles', '_self', 'noopener,noreferrer')
  })
  remotePermissionDismissButton.addEventListener('click', () => {
    remotePermissionDismissed = true
    remotePermission.hidden = true
  })
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
  const copyRemotePairUrl = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(activeRemotePairUrl)
      remoteStatus.textContent = t('linkCopied')
    } catch {
      remoteStatus.textContent = t('remoteQrReady')
    }
  }
  const openRemotePairing = (): Promise<void> => {
    const provider = remoteProvider
    const origin = latestRemoteState.origin
    const generation = remotePairingGeneration
    activeRemotePairUrl = ''
    activeRemotePairExpiresAt = 0
    pairingValidity.hidden = true
    remotePairLink.hidden = true
    remotePairLink.textContent = ''
    showQr('', remoteQr)
    return controlRequestJson('/api/mobile-access/remote/pairing/open', { method: 'POST', body: '{}' }).then(async data => {
      if (lifecycle.signal.aborted || !remoteReady || provider !== remoteProvider || origin !== latestRemoteState.origin || generation !== remotePairingGeneration) return
      const pairUrl = typeof data.pairUrl === 'string' ? data.pairUrl : ''
      const expiresAt = typeof data.expiresAt === 'number' && Number.isFinite(data.expiresAt) ? data.expiresAt : 0
      if (pairUrl === '' || expiresAt <= Date.now()) { remoteStatus.textContent = t('keyGenerationFailed'); return }
      showQr(typeof data.qrSvg === 'string' ? data.qrSvg : '', remoteQr)
      // QR and copy actions share the same one-time pairing window. Re-copying
      // cannot invalidate a QR that the phone may already be scanning.
      activeRemotePairUrl = pairUrl
      activeRemotePairExpiresAt = expiresAt
      pairingValidity.hidden = false
      pairingValidity.textContent = t('pairingExpires', { time: formatTime(expiresAt) })
      remotePairLink.textContent = pairUrl
      remotePairLink.classList.add('is-key')
      remotePairLink.hidden = false
      await copyRemotePairUrl()
    })
  }
  remotePair.addEventListener('click', () => {
    if (!remoteReady || remoteProviderBusy || remotePairingBusy) return
    remotePairingBusy = true
    remotePair.disabled = true
    remoteCopyLink.disabled = true
    void openRemotePairing()
      .catch(error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remotePairingBusy = false; remotePair.disabled = !remoteReady || remoteProviderBusy; remoteCopyLink.disabled = !remoteReady || remoteProviderBusy })
  })
  remoteCopyLink.addEventListener('click', () => {
    if (!remoteReady || remoteProviderBusy || remotePairingBusy) return
    remotePairingBusy = true
    remotePair.disabled = true
    remoteCopyLink.disabled = true
    const operation = activeRemotePairUrl !== '' && activeRemotePairExpiresAt > Date.now()
      ? copyRemotePairUrl()
      : openRemotePairing()
    void operation
      .catch(error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      .finally(() => { remotePairingBusy = false; remotePair.disabled = !remoteReady || remoteProviderBusy; remoteCopyLink.disabled = !remoteReady || remoteProviderBusy })
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
          .then(loadRemoteDevices, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
      })
      row.append(label, meta, revoke); remoteDevicePanel.append(row)
    }
  }
  const loadRemoteDevices = (): void => {
    void controlRequestJson('/api/mobile-access/remote/devices').then(renderRemoteDevices, error => {
      remoteFailureText = remoteFailureTextFor(error, 'requestFailed')
      remoteStatus.textContent = remoteFailureText
      // The remote status line lives on the remote workspace, which is hidden on
      // the devices page; surface an explicit empty state inside the group.
      remoteDevicePanel.replaceChildren()
      const note = element('p', 'dsh-mobile-control__device-empty')
      note.textContent = remoteRunning ? t('noRemoteDevices') : t('remoteOff')
      remoteDevicePanel.append(note)
    })
  }
  remoteDevices.addEventListener('click', () => {
    const show = remoteDevicePanel.hidden
    remoteDevicePanel.hidden = !show
    if (show) loadRemoteDevices()
  })
  remoteReset.addEventListener('click', () => {
    const prompt = remoteProvider === 'cpolar'
      ? t('resetCpolarConfirm')
      : remoteProvider === 'cloudflared' ? t('resetCloudflaredConfirm')
        : remoteProvider === 'frp' ? t('resetFrpConfirm') : remoteProvider === 'origin' ? t('resetOriginConfirm') : remoteProvider === 'iroh' ? t('resetIrohConfirm') : t('resetTailscaleConfirm')
    if (!window.confirm(prompt)) return
    void controlRequestJson('/api/mobile-access/remote/reset', { method: 'POST', body: JSON.stringify({ confirm: true }) })
      .then(renderRemote, error => { remoteFailureText = remoteFailureTextFor(error, 'requestFailed'); remoteStatus.textContent = remoteFailureText })
  })
  const renderDiagnostics = (data: Record<string, unknown>): void => {
    const scopeCopy = DIAGNOSTIC_SCOPE_MESSAGES[locale]
    const scopeOf = (entry: Record<string, unknown>): string => entry.scope === 'configuration' || entry.id === 'versions' ? scopeCopy.configuration : entry.scope === 'phone' || entry.id === 'phone-network' ? scopeCopy.phone : scopeCopy.computer
    const entries = [...diagnosticEntriesForRender(data)]
    const overall = diagnosticOverallForChecks(data.overall, entries.map(entry => entry.status))
    diagnosticsSummary.className = `dsh-mobile-control__diagnostic-summary is-${overall}`
    diagnosticsSummaryTitle.textContent = `${scopeCopy.computer} · ${overall === 'ok' ? t('diagnosticsComplete') : overall === 'attention' ? t('diagnosticsAttention') : t('diagnosticsProblem')}`
    diagnosticsSummaryText.textContent = scopeCopy.coverage
    diagnosticsChecks.replaceChildren()
    const statusLabels: Record<string, string> = { ok: t('diagnosticStatusOk'), warning: t('diagnosticStatusWarning'), error: t('diagnosticStatusError'), info: t('diagnosticStatusInfo') }
    const diagnosticLabelKeys: Record<string, string> = {
      versions: 'diagnosticLabelVersions', network: 'diagnosticLabelNetwork', lan: 'diagnosticLabelLan',
      firewall: 'diagnosticLabelFirewall', remote: 'diagnosticLabelRemote', 'phone-network': 'diagnosticLabelPhone',
    }
    const statusOf = (entry: Record<string, unknown>): 'ok' | 'warning' | 'error' | 'info' => normalizeDiagnosticStatus(entry.status)
    const localizedEntryCopy = (entry: Record<string, unknown>): { readonly detail: string; readonly action: string } =>
      localizedDiagnosticEntryCopy(entry, locale, data.versions)
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
        if (entry.id === 'versions') rowTitle.textContent = scopeCopy.versions
        else if (entry.id === 'remote-service') rowTitle.textContent = scopeCopy.provider
        else if (entry.id === 'remote-dns') rowTitle.textContent = scopeCopy.dns
        else if (entry.id === 'plugin-inspection' || entry.id === 'remote-plugin-conflict') rowTitle.textContent = scopeCopy.scripts
        const scope = element('small', 'dsh-mobile-control__diagnostic-scope'); scope.textContent = scopeOf(entry)
        rowHeader.append(rowTitle, badge); rowBody.append(rowHeader, scope, detail)
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
      const scopedLabel = entry.id === 'versions' ? scopeCopy.versions : entry.id === 'remote-service' ? scopeCopy.provider : entry.id === 'remote-dns' ? scopeCopy.dns : entry.id === 'plugin-inspection' || entry.id === 'remote-plugin-conflict' ? scopeCopy.scripts : label
      return `[${statusLabels[state]!}][${scopeOf(entry)}] ${scopedLabel}: ${localizedCopy.detail}${localizedCopy.action === '' ? '' : ` ${localizedCopy.action}`}`
    })
    copiedDiagnosticReport = [reportCopy.reportTitle, `${reportCopy.generated}: ${generatedAt}`, scopeCopy.coverage, ...lines].join('\n')
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
  devicesEntry.addEventListener('click', () => {
    if (!devicesView.hidden) { selectView(previousAccessView); return }
    selectView('devices'); showDevicesGroup('lan')
  })
  diagnosticsRun.addEventListener('click', loadDiagnostics)
  diagnosticsRun.addEventListener('click', () => { void extensionRecovery.refresh() })
  const closeUpdateCard = (): void => {
    updateCard.hidden = true
    if (pluginUpdateAvailable && pluginLatestVersion !== '') updatePlugin.hidden = !diagnosticsView.hidden
  }
  const runPluginUpdate = (): void => {
    if (!pluginUpdateAvailable || pluginLatestVersion === '' || updateInFlight) return
    updateInFlight = true
    updateNow.disabled = true
    updateLater.disabled = true
    updateCardTitle.textContent = t('updatingPlugin')
    releaseNotice.hidden = true
    releaseNotice.classList.remove('is-error')
    void controlRequestJson('/api/mobile-access/release/update', { method: 'POST', body: '{}' }, LONG_CONTROL_REQUEST_TIMEOUT_MS).then(data => {
      const installedVersion = releaseVersion(data.installedVersion) ?? pluginLatestVersion
      pluginUpdateAvailable = false
      updateCard.hidden = true
      updatePlugin.hidden = true
      releaseNotice.textContent = t('pluginUpdatedRestart', { version: installedVersion })
      releaseNotice.hidden = false
    }, error => {
      updateCard.hidden = true
      updatePlugin.hidden = false
      releaseNotice.textContent = t('pluginUpdateFailed', { error: String(error) })
      releaseNotice.classList.add('is-error')
      releaseNotice.hidden = false
    }).finally(() => {
      updateInFlight = false
      updateNow.disabled = false
      updateLater.disabled = false
    })
  }
  updatePlugin.addEventListener('click', () => {
    if (!pluginUpdateAvailable || pluginLatestVersion === '' || updateInFlight) return
    updatePlugin.hidden = true
    updateCardTitle.textContent = t('updateTo', { version: pluginLatestVersion })
    updateCardNotes.textContent = pluginReleaseNotes === '' ? t('updateNotesEmpty') : pluginReleaseNotes
    updateCardNotes.hidden = pluginReleaseNotes === ''
    updateCard.hidden = false
  })
  updateNow.addEventListener('click', runPluginUpdate)
  updateLater.addEventListener('click', closeUpdateCard)
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
  pair.addEventListener('click', () => { openPairing('key') })
  linkPair.addEventListener('click', () => { openPairing('link') })
  close.addEventListener('click', () => { setOpen(false) })
  const dismiss = (event: PointerEvent): void => {
    if (panel.hidden || !(event.target instanceof Node)) return
    if (!panel.contains(event.target) && !irohQrZoom.contains(event.target) && !document.querySelector('.dsh-mobile-control__trigger')?.contains(event.target)) setOpen(false)
  }
  document.addEventListener('pointerdown', dismiss)
  void controlRequestJson('/api/mobile-access/release').then(renderRelease, () => {})
  void controlRequestJson('/api/mobile-access/lan/control').then(render, error => { status.textContent = t('requestFailed', { error: String(error) }) })
  loadRemote()
  const remotePoll = window.setInterval(() => { if (!panel.hidden && !remoteView.hidden) { renderLanPairingExpiry(); loadRemote() } }, 1_500)
  const pollWsBlocked = (): void => {
    void controlRequestJson('/api/mobile-access/remote/websocket-paths/blocked').then(blocked => {
      const raw = Array.isArray(blocked.blocked) ? blocked.blocked : []
      wsPathsBlocked = raw.filter((entry): entry is { path: string; attempts: number } =>
        typeof entry === 'object' && entry !== null
        && typeof (entry as { path?: unknown }).path === 'string'
        && typeof (entry as { attempts?: unknown }).attempts === 'number')
      renderWsDot()
      if (!diagnosticsView.hidden) renderWsBlocked(wsPathsBlocked)
    }, () => { /* gateway unreachable; dot keeps its last state */ })
  }
  const wsBlockedPoll = window.setInterval(() => { pollWsBlocked(); if (!panel.hidden) void extensionRecovery.refresh() }, 20_000)
  return { remove: () => { lifecycle.abort(); extensionRecovery.dispose(); window.clearInterval(remotePoll); window.clearInterval(wsBlockedPoll); window.removeEventListener('focus', retryAfterSetup); document.removeEventListener('visibilitychange', retryAfterSetup); document.removeEventListener('pointerdown', dismiss); root.remove() }, toggle: () => { setOpen(panel.hidden !== false) }, isOpen: () => !panel.hidden }
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

/** Build the JSON request used by a mobile extension to invoke a Host action. */
export function extensionActionRequestInit(generation: string | undefined, input: unknown, signal: AbortSignal): RequestInit {
  return {
    method: 'POST',
    headers: extensionGenerationHeaders(generation, { 'content-type': 'application/json' }),
    body: JSON.stringify(input ?? {}),
    signal,
  }
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
  if (signal.aborted) return false
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
  onTaskEvent?: (payload: unknown) => void,
  onDeviceRevoked?: () => void,
  initiallyEnabled = true,
): (() => void) & { setEnabled(enabled: boolean): void } {
  let source: ReturnType<ExtensionEventRuntime['create']> | undefined
  let timer: number | undefined
  let disposed = false
  let enabled = initiallyEnabled
  let retryMs = 1_000
  const clearTimer = (): void => {
    if (timer === undefined) return
    runtime.window.clearTimeout(timer)
    timer = undefined
  }
  const connect = (): void => {
    if (disposed || !enabled || source !== undefined) return
    clearTimer()
    const next = runtime.create('/mobile-access/extensions/events')
    source = next
    const current = (): boolean => !disposed && enabled && source === next
    next.onopen = () => { if (current()) retryMs = 1_000 }
    next.addEventListener('extensions-changed', () => { if (current()) changed() })
    if (onTaskEvent !== undefined) {
      next.addEventListener('task-notify', (message: Event) => {
        if (!current()) return
        const data = (message as MessageEvent).data
        onTaskEvent(data)
      })
    }
    if (onDeviceRevoked !== undefined) {
      next.addEventListener('device-revoked', (message: Event) => {
        if (!current()) return
        const data = (message as MessageEvent).data
        if (isDeviceRevokedPayload(data)) onDeviceRevoked()
      })
    }
    next.onerror = () => {
      if (source !== next) return
      next.close()
      source = undefined
      if (disposed || !enabled) return
      const delay = retryMs
      retryMs = Math.min(30_000, retryMs * 2)
      timer = runtime.window.setTimeout(connect, delay)
    }
  }
  const reconnectNow = (): void => {
    if (disposed || !enabled) return
    source?.close()
    source = undefined
    retryMs = 1_000
    connect()
  }
  runtime.window.addEventListener('online', reconnectNow)
  connect()
  const stop = (): void => {
    disposed = true
    clearTimer()
    source?.close()
    source = undefined
    runtime.window.removeEventListener('online', reconnectNow)
  }
  return Object.assign(stop, { setEnabled(value: boolean): void {
    if (disposed || value === enabled) return
    enabled = value
    if (value) connect()
    else { clearTimer(); source?.close(); source = undefined }
  } })
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

/**
 * Install authenticated customization refresh, retaining assets through temporary failures.
 * @param recovery - optional instance-owned authentication feedback and refresh registration.
 * @returns synchronous teardown for the customization UI and refresh admission.
 */
export function installCustomAssets(recovery?: {
  readonly rejected: (status: number) => void
  readonly retry: () => boolean
  readonly registerRefresh: (refresh: () => void) => () => void
}): () => void {
  const reporter = createMobileAssetLoadReporter(selectedMobileControlLocale)
  let refreshNow = (): void => { /* Assigned before the first resource result. */ }
  const customizationOwner = ownsMobileCustomization(document.querySelector('meta[name="dsh-mobile-gateway"][content="authenticated"]') !== null, window.__DSH_MOBILE_FRONTEND__)
  // A silent failure leaves the user thinking a third-party plugin broke, so the
  // channel that failed is also shown on screen (issue #298). The action only
  // claims a recovery when this page can actually request one.
  const removeNotice = customizationOwner
    ? installCustomizationNotice(document, {
      locale: () => {
        const locale = selectedMobileControlLocale()
        return locale === 'zh' || locale === 'it' ? locale : 'en'
      },
      reconnect: () => {
        // With a native bridge the recovery owner renews and reconnects; without
        // one there is nothing this page can do, so do not promise it.
        const attempted = recovery?.retry() ?? false
        refreshNow()
        return attempted
      },
      subscribe: listener => reporter.subscribe(listener),
      message: reason => reporter.message(reason),
    })
    : () => {}
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
  // Keep the HTTP validator separate from the content digest used to decide
  // whether the script needs evaluating. The Gateway emits quoted ETags while
  // the local digest is an unquoted SHA-256 value.
  const scriptEtags = new Map<string, string>()
  const scriptDigests = new Map<string, string>()
  const activeHostGenerations = new Map<string, string | undefined>()
  const activationKeys = new Map<string, { readonly definition: MobileClientDefinition; readonly generation?: string }>()
  const manifestExtensionIds = new Set<string>()
  const managedDefinitionIds = new Set<string>()
  let manifestEtag = ''
  let disposed = false
  let events: ReturnType<typeof startExtensionChangeStream> | undefined
  const failed = (reason: MobileAssetLoadFailure, signal: AbortSignal): void => {
    if (disposed || signal.aborted) return
    reporter.fail(reason, signal)
    if (reason === 'authentication_required') events?.setEnabled(false)
  }
  const unavailable = (response: Response, signal: AbortSignal, fallback: MobileAssetLoadFailure): void => {
    const rejectedAuth = response.status === 401 || response.status === 403
    failed(rejectedAuth ? 'authentication_required' : fallback, signal)
    // Issue #298: a rejected authenticated request means the Session is gone even
    // if the live transport still reports `connected`. Ask the single recovery
    // owner for one renewal instead of waiting for a disconnect that may not come.
    if (rejectedAuth && !disposed && !signal.aborted) recovery?.rejected(response.status)
    void response.body?.cancel().catch((error: unknown) => {
      // Unread rejected bodies are disposed without replacing the reported HTTP failure.
      void error
    })
  }
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
  const stopNativeBack = installMobileNativeBack(window, document, () => { toast(mobileBackBlockedMessage(selectedMobileControlLocale())) })
  if (!customizationOwner) {
    reporter.fail('gateway_required')
    return () => {
      disposed = true
      reporter.dispose()
      stopNativeBack()
      legacyStyle.remove()
      document.querySelector('[data-dsh-mobile-extension-layer]')?.remove()
    }
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
      return invokeBoundNativeCapability(bridge, () => window.__DSH_MOBILE_NATIVE__, action, input, signal).then(materializeNativeFile)
    }
    if (action === 'share' && typeof navigator.share === 'function') { await navigator.share((input ?? {}) as ShareData); return { ok: true } }
    if (action === 'clipboard.read' && navigator.clipboard !== undefined) return { text: await navigator.clipboard.readText() }
    if (action === 'clipboard.write' && navigator.clipboard !== undefined) { await navigator.clipboard.writeText(typeof input === 'object' && input !== null && 'text' in input ? String((input as { text: unknown }).text) : ''); return { ok: true } }
    if (action === 'files.pick' || action === 'camera.capture') {
      return pickBrowserFiles({ signal, accept: action === 'camera.capture' ? 'image/*' : '*/*',
        ...(action === 'camera.capture' ? { capture: 'environment' } : {}), abortReason }).then(files => files?.[0])
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
        const container = element('section'); container.dataset.dshMobileSurface = surface.id; container.dataset.dshMobileSurfacePlacement = surface.placement; container.hidden = surface.placement === 'page' || surface.placement === 'overlay'; container.style.cssText = surface.placement === 'page' || surface.placement === 'overlay' ? 'position:absolute;inset:0;overflow:auto;background:var(--dsw-alias-bg-layer-1,#fff);padding:16px;pointer-events:auto' : 'pointer-events:auto'
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
          return mobileRequest(`/mobile-access/extensions/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, extensionActionRequestInit(hostGeneration, input, controller.signal)).then(async response => { const value = await response.json() as unknown; if (!response.ok) throw new Error(typeof value === 'object' && value !== null && 'error' in value ? String((value as { error: unknown }).error) : `HTTP ${String(response.status)}`); return value })
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
        open: surfaceId => { ensureCurrent(); const entry = surfaces.get(surfaceId); if (entry !== undefined) setMobileSurfaceOpen(entry.container, true) },
        close: surfaceId => { ensureCurrent(); const entry = surfaces.get(surfaceId); if (entry !== undefined) setMobileSurfaceOpen(entry.container, false) },
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
      if (!response.ok) { unavailable(response, signal, 'resource_unavailable'); return false }
      const nextEtag = response.headers.get('etag') ?? ''
      const nextModified = response.headers.get('last-modified') ?? ''
      const next = await readMobileAssetText(response, signal, LEGACY_CUSTOM_ASSET_LIMIT)
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
    } catch { pendingRoot?.remove(); legacyMount = previousMount; failed('resource_unavailable', signal); return false }
  }
  let legacyScriptRevision = ''
  let legacyStyleRevision = ''
  const disposeManifestExtension = (id: string): void => {
    activations.remove(id)
    styleNodes.get(id)?.remove(); styleNodes.delete(id); styleEtags.delete(id); scriptEtags.delete(id); scriptDigests.delete(id); activeHostGenerations.delete(id); activationKeys.delete(id)
    if (managedDefinitionIds.delete(id)) definitions.delete(id)
  }
  const managedManifestIdSources = (): readonly Iterable<string>[] => [styleNodes.keys(), styleEtags.keys(), scriptEtags.keys(), scriptDigests.keys(), managedDefinitionIds]
  const clearManifestExtensions = (): void => {
    publishAuthoritativeExtensionIds(manifestExtensionIds, new Set(), managedManifestIdSources(), disposeManifestExtension)
    manifestEtag = ''
  }
  const refreshExtensions = async (signal: AbortSignal): Promise<boolean> => {
    let failureStage: MobileAssetLoadFailure = 'manifest_unavailable'
    try {
      const headers: Record<string, string> = {}
      if (manifestEtag !== '') headers['if-none-match'] = manifestEtag
      const response = await fetch('/mobile-access/extensions/manifest', { credentials: 'same-origin', cache: 'no-store', headers, signal })
      if (disposed || signal.aborted) {
        void response.body?.cancel().catch((error: unknown) => {
          // A withdrawn refresh must not apply a response or replace its cancellation with cleanup failure.
          void error
        })
        return false
      }
      if (response.status === 404) {
        unavailable(response, signal, 'manifest_unavailable')
        legacyScriptRevision = ''
        legacyStyleRevision = ''
        const legacyLoaded = await handleMissingExtensionManifest(
          clearManifestExtensions,
          () => Promise.all([refreshLegacy(signal), refreshCssLegacy(legacyStyle, signal, legacyCssState, unavailable)]),
          signal,
        )
        if (!legacyLoaded) failed('resource_unavailable', signal)
        return false
      }
      if (response.status === 304) { if (!signal.aborted) events?.setEnabled(true); return true }
      if (!response.ok) { unavailable(response, signal, 'manifest_unavailable'); return false }
      const nextManifestEtag = response.headers.get('etag') ?? ''
      const manifestSource = await readMobileAssetText(response, signal, undefined)
      let payload: ReturnType<typeof parseMobileExtensionManifest>
      try { payload = parseMobileExtensionManifest(JSON.parse(manifestSource)) }
      catch { failed('manifest_invalid', signal); return false }
      if (refreshAborted(signal)) return false
      if (payload === undefined) { failed('manifest_invalid', signal); return false }
      failureStage = 'resource_unavailable'
      events?.setEnabled(true)
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
        if (await refreshCssLegacy(legacyStyle, signal, legacyCssState, unavailable)) legacyStyleRevision = styleRevision
        else { failed('resource_unavailable', signal); refreshComplete = false }
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
              if (!cssResponse.ok) { unavailable(cssResponse, signal, 'resource_unavailable'); throw new Error('mobile extension style failed to load') }
              pendingStyleEtag = cssResponse.headers.get('etag') ?? undefined
              pendingCss = await readMobileAssetText(cssResponse, signal, EXTENSION_LIMITS.css)
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
            scriptEtags.delete(entry.id)
            scriptDigests.delete(entry.id)
            if (managedDefinitionIds.delete(entry.id)) definitions.delete(entry.id)
          } else {
            const scriptHeaders: Record<string, string> = {}
            const storedEtag = scriptEtags.get(entry.id)
            if (storedEtag !== undefined) scriptHeaders['if-none-match'] = storedEtag
            const scriptResponse = await fetch(scriptUrl, { credentials: 'same-origin', cache: 'no-store', headers: scriptHeaders, signal })
            let nextDigest: string | undefined
            let nextEtag: string | undefined
            if (scriptResponse.status !== 304) {
              if (!scriptResponse.ok) { unavailable(scriptResponse, signal, 'resource_unavailable'); throw new Error('mobile extension script failed to load') }
              nextEtag = scriptResponse.headers.get('etag') ?? undefined
              const source = await readMobileAssetText(scriptResponse, signal, EXTENSION_LIMITS.script)
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
            // A 304 has no new representation metadata to commit. Keep the
            // validator that produced it; only a fresh 200 may replace or
            // clear the stored HTTP ETag.
            if (scriptResponse.status !== 304) {
              if (nextEtag === undefined || nextEtag === '') scriptEtags.delete(entry.id)
              else scriptEtags.set(entry.id, nextEtag)
            }
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
          failed('resource_unavailable', signal)
          refreshComplete = false
        }
      }
      if (refreshAborted(signal)) return false
      if (refreshComplete) {
        publishAuthoritativeExtensionIds(manifestExtensionIds, seen, managedManifestIdSources(), disposeManifestExtension)
        manifestEtag = nextManifestEtag
      } else manifestEtag = ''
      return refreshComplete
    } catch { failed(failureStage, signal); return false }
  }
  started = true
  for (const definition of definitions.values()) void activateDefinition(definition)
  const stopRefresh = startLifecycleRefreshScheduler(async signal => {
    if (await refreshExtensions(signal) && !disposed && !signal.aborted) {
      reporter.recover(signal)
      events?.setEnabled(true)
    }
  })
  refreshNow = () => { stopRefresh.refresh() }
  const unregisterRefresh = recovery?.registerRefresh(refreshNow)
  const stopEvents = startExtensionChangeStream(
    () => { stopRefresh.refresh() },
    undefined,
    payload => {
      // Host-pushed task completion: exact, no guessing. Each completed turn
      // keeps its own notification, and generic text avoids attributing a
      // background task to whichever session happens to be open on the phone.
      if (document.hidden !== true) return
      const parsed = parseTaskNotifyPayload(payload)
      if (parsed === undefined) return
      const language = resolveNativeMobileLanguage(
        document.documentElement.lang,
        navigator.languages.length > 0 ? [...navigator.languages] : [navigator.language],
      )
      const label = (italian: string, english: string, chinese: string): string =>
        language === 'it' ? italian : language === 'zh' ? chinese : english
      fireTaskNotifyEvent({
        kind: 'done',
        title: label('Attività completata', 'Task finished', '任务已完成'),
        body: label('Il tuo task DSH è terminato', 'Your DSH task finished', '你的 DSH 任务已完成'),
        tag: taskCompletionTag(parsed.sessionId, parsed.turn),
      })
    },
    () => { fireDeviceRevoked() },
    false,
  )
  events = stopEvents
return () => { disposed = true; unregisterRefresh?.(); removeNotice(); reporter.dispose(); stopNativeBack(); stopEvents(); stopRefresh(); started = false; legacyDispose?.(); legacyDispose = undefined; legacyRoot?.remove(); legacyRoot = undefined; legacyStyle.remove(); activations.dispose(); for (const node of styleNodes.values()) node.remove(); styleNodes.clear(); const layer = document.querySelector('[data-dsh-mobile-extension-layer]'); layer?.remove(); for (const host of document.querySelectorAll('[data-dsh-mobile-surface-host]')) host.remove(); if (previous === undefined) delete window.dshMobile; else window.dshMobile = previous }
}

interface LegacyCssState { etag: string; modified: string }
async function refreshCssLegacy(style: HTMLStyleElement, signal: AbortSignal, state: LegacyCssState, unavailable: (response: Response, signal: AbortSignal, reason: MobileAssetLoadFailure) => void): Promise<boolean> {
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
      const css = await readMobileAssetText(response, signal, LEGACY_CUSTOM_ASSET_LIMIT)
      if (refreshAborted(signal)) return false
      style.textContent = css
      state.etag = nextEtag
      state.modified = nextModified
      return true
    }
    unavailable(response, signal, 'resource_unavailable')
    return false
  } catch { return false }
}

/** Theme-aware desktop Mobile Access panel styles. */
export const CONTROL_STYLES = `
.dsh-mobile-control{position:fixed;z-index:1000;left:16px;bottom:112px;font:14px/1.45 system-ui;color:var(--dsw-alias-label-primary,#16181d)}
.dsh-mobile-control__panel{box-sizing:border-box;width:min(704px,calc(100vw - 32px));max-height:calc(100vh - 140px);overflow-y:auto;padding:16px;border:0;border-radius:16px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 12px 34px rgb(15 23 42 / 13%)}.dsh-mobile-control__remote-columns{display:grid;grid-template-columns:minmax(230px,300px) minmax(0,1fr);gap:14px;align-items:start;max-height:calc(100vh - 330px)}
/* Floating panel with dense, borderless content. */
.dsh-mobile-control{inset:auto;left:16px;bottom:112px;pointer-events:none}
.dsh-mobile-control__panel{position:relative;inset:auto;width:min(704px,calc(100vw - 32px));height:auto;max-height:calc(100vh - 140px);border:0;border-radius:16px;box-shadow:0 12px 34px rgb(15 23 42 / 13%);display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__panel[hidden]{display:none}
.dsh-mobile-control__header{flex:none;margin:0;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#e1e5eb)}
.dsh-mobile-control__app-downloads{flex:none;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#e1e5eb);margin:0}
.dsh-mobile-control__view.is-remote{flex:1;min-height:0;display:flex;flex-direction:column}
.dsh-mobile-control__remote-columns{flex:1;min-height:0;display:grid;grid-template-columns:260px minmax(0,1fr);gap:0;max-height:none;align-items:stretch}
.dsh-mobile-control__remote-columns>.dsh-mobile-control__provider-section{overflow-y:auto;border-right:1px solid var(--dsw-alias-border-l2,#e1e5eb);background:var(--dsw-alias-bg-layer-1,#f7f8fa);padding:10px 8px}
.dsh-mobile-control__channel-pane{overflow-y:auto;padding:14px 20px;min-width:0;scrollbar-gutter:stable}
.dsh-mobile-control__provider{position:relative;border:0;border-radius:8px;padding:8px 10px;min-height:0;background:transparent;box-shadow:none}
.dsh-mobile-control__provider:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f5f9)}
.dsh-mobile-control__provider.is-selected{background:var(--dsw-alias-interactive-bg-active,#f5f8ff);box-shadow:none}
.dsh-mobile-control__provider.is-selected::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:2px;border-radius:2px;background:var(--dsw-alias-label-primary-bluish,#2563eb)}
.dsh-mobile-control__remote-workspace section{border:0;border-radius:0;padding:12px 0;background:transparent;box-shadow:none;border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}
.dsh-mobile-control__remote-workspace section:first-child{border-top:0}
.dsh-mobile-control__remote-workspace .dsh-mobile-control__details{border:0;border-radius:0;background:transparent;box-shadow:none}
.dsh-mobile-control__btn,.dsh-mobile-control__primary,.dsh-mobile-control__secondary{min-height:32px;padding:6px 12px;border-radius:8px;font-size:12px}
.dsh-mobile-control__self-hosted{border:0;border-radius:0;background:transparent;box-shadow:none}
.dsh-mobile-control__self-hosted-summary{border-bottom:1px solid var(--dsw-alias-border-l2,#e1e5eb)}
.dsh-mobile-control__self-hosted-body{padding:0}
@media (max-width:860px){.dsh-mobile-control__remote-columns{grid-template-columns:1fr}.dsh-mobile-control__remote-columns>.dsh-mobile-control__provider-section{border-right:0;border-bottom:1px solid var(--dsw-alias-border-l2,#e1e5eb);max-height:40vh}}
.dsh-mobile-control__channel-pane{min-width:0;overflow-y:auto;padding-right:4px;max-height:100%}.dsh-mobile-control__channel-pane>.dsh-mobile-control__view{display:block}.dsh-mobile-control__provider.is-lan{border-color:var(--dsw-alias-label-primary-bluish,#2563eb);background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-layer-1,#f5f8ff))}.dsh-mobile-control__remote-columns>.dsh-mobile-control__provider-section{overflow-y:auto;padding-right:4px}.dsh-mobile-control__remote-columns>.dsh-mobile-control__remote-workspace{overflow-y:auto;padding-right:4px}.dsh-mobile-control__remote-columns>.dsh-mobile-control__provider-section{margin:0}@media (max-width:760px){.dsh-mobile-control__remote-columns{grid-template-columns:1fr}}
.dsh-mobile-control__header{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}.dsh-mobile-control__panel h2{margin:0;font-size:17px;line-height:24px}.dsh-mobile-control__header-actions{display:flex;align-items:center;gap:2px}.dsh-mobile-control__update-plugin,.dsh-mobile-control__diagnostic-entry,.dsh-mobile-control__close{display:inline-flex;align-items:center;justify-content:center;min-width:44px;height:44px;padding:0;border:0;border-radius:10px;background:transparent;color:inherit;cursor:pointer}.dsh-mobile-control__update-plugin,.dsh-mobile-control__diagnostic-entry{padding:0 8px;color:var(--dsw-alias-label-primary-bluish,#2563eb);font:650 12px/1 system-ui;white-space:nowrap}.dsh-mobile-control__update-plugin[hidden]{display:none}.dsh-mobile-control__update-plugin:disabled{cursor:wait;opacity:.55}.dsh-mobile-control__close{font-size:24px;line-height:1}.dsh-mobile-control__update-plugin:hover:not(:disabled),.dsh-mobile-control__diagnostic-entry:hover,.dsh-mobile-control__close:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}
.dsh-mobile-control__release-notice{margin:-2px 0 10px;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-1,#eff6ff);color:var(--dsw-alias-label-primary,#1d4ed8);font-size:11px;line-height:1.45}.dsh-mobile-control__release-notice.is-error{color:var(--dsw-alias-label-primary,#dc2626);border-left:3px solid var(--dsw-alias-state-error-primary,#dc2626)}.dsh-mobile-control__release-notice[hidden]{display:none}.dsh-mobile-control__update-card{margin:0 0 10px;padding:11px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__update-card[hidden]{display:none}.dsh-mobile-control__update-card-title{margin:0 0 7px;color:var(--dsw-alias-label-primary,#16181d);font:650 13px/1.4 system-ui}.dsh-mobile-control__update-notes{display:block;box-sizing:border-box;max-height:150px;overflow-y:auto;margin:0 0 8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2,#e1e5eb);border-radius:9px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#475569);white-space:pre-wrap;word-break:break-word;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.dsh-mobile-control__update-notes[hidden]{display:none}.dsh-mobile-control__update-notice{margin:0 0 9px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-state-warn-tertiary,#fff4d6);color:var(--dsw-alias-state-warn-label,#92400e);font-size:11px;line-height:1.5}.dsh-mobile-control__update-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px}.dsh-mobile-control__primary{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:40px;padding:9px 14px;border:1px solid var(--dsw-alias-label-primary-bluish,#2563eb);border-radius:10px;background:var(--dsw-alias-label-primary-bluish,#2563eb);color:#fff;font:600 12px/1.3 system-ui;cursor:pointer;touch-action:manipulation}.dsh-mobile-control__primary:hover:not(:disabled){border-color:#1d4ed8;background:#1d4ed8}.dsh-mobile-control__primary:active:not(:disabled){border-color:#1e40af;background:#1e40af}.dsh-mobile-control__primary:disabled{cursor:wait;opacity:.55}.dsh-mobile-control__primary[hidden]{display:none}.dsh-mobile-control__update-actions .dsh-mobile-control__primary,.dsh-mobile-control__update-actions .dsh-mobile-control__secondary{min-height:36px;padding:0 12px}.dsh-mobile-control__app-download{display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;min-height:44px;margin:0 0 10px;padding:8px 11px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:11px;background:var(--dsw-alias-bg-layer-1,#f7f8fa);color:var(--dsw-alias-label-primary,#16181d);font:600 12px/1.3 system-ui;text-decoration:none}.dsh-mobile-control__app-downloads{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}.dsh-mobile-control__app-downloads .dsh-mobile-control__app-download{flex:1 1 240px;margin:0}.dsh-mobile-control__app-download.is-iroh{border-color:var(--dsw-alias-label-primary-bluish,#2563eb);color:var(--dsw-alias-label-primary-bluish,#2563eb)}.dsh-mobile-control__app-download.is-iroh[hidden]{display:none}.dsh-mobile-control__app-download[hidden]{display:none}.dsh-mobile-control__app-download::after{color:var(--dsw-alias-label-primary-bluish,#2563eb);font-size:14px;content:"↗"}.dsh-mobile-control__app-download:hover{border-color:#9fb9e8;background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-layer-2,#f5f8ff));color:var(--dsw-alias-label-primary,#1d4ed8)}
.dsh-mobile-control__switcher{display:grid;grid-template-columns:repeat(2,1fr);gap:4px;margin:0 0 14px;padding:4px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#f3f5f8)}.dsh-mobile-control__switcher[hidden]{display:none}.dsh-mobile-control__tab{min-height:36px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#606873);font:600 13px/1 system-ui;cursor:pointer}.dsh-mobile-control__tab.is-active{background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);box-shadow:0 1px 3px rgb(15 23 42 / 10%)}.dsh-mobile-control__view[hidden]{display:none}.dsh-mobile-control__intro{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#606873);font-size:12px;line-height:1.55}.dsh-mobile-control__http-frame-warning{box-sizing:border-box;margin:-4px 0 12px;padding:8px 10px;border:1px solid #d6a83f;border-radius:9px;background:var(--dsw-alias-bg-layer-1,#fff7df);color:var(--dsw-alias-label-primary,#694b00);font-size:11px;line-height:1.5;overflow-wrap:anywhere}.dsh-mobile-control__http-frame-warning[hidden]{display:none}.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions button[hidden]{display:none}
.dsh-mobile-control__provider-section{position:relative;margin:0 0 14px}.dsh-mobile-control__section-title{margin:0 0 8px;color:var(--dsw-alias-label-primary,#16181d);font:650 13px/1.4 system-ui}.dsh-mobile-control__provider-section>.dsh-mobile-control__section-title{padding-right:42px}.dsh-mobile-control__provider-choices{display:grid;grid-template-columns:1fr;gap:8px}.dsh-mobile-control__provider{display:flex;min-width:0;flex-direction:column;gap:6px;min-height:94px;padding:10px 11px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);text-align:left;cursor:pointer;touch-action:manipulation;transition:border-color 160ms ease,background-color 160ms ease,box-shadow 160ms ease}.dsh-mobile-control__provider:hover{border-color:#6f96db;background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-layer-1,#f8fbff))}.dsh-mobile-control__provider.is-selected{border-color:var(--dsw-alias-label-primary-bluish,#2563eb);background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-bg-layer-1,#f5f8ff));box-shadow:0 0 0 1px var(--dsw-alias-label-primary-bluish,#2563eb) inset}.dsh-mobile-control__provider:disabled{cursor:wait;opacity:.62}.dsh-mobile-control__provider-top{display:flex;min-width:0;align-items:flex-start;justify-content:space-between;gap:5px}.dsh-mobile-control__provider-top strong{min-width:0;font-size:12px;line-height:1.3}.dsh-mobile-control__provider-badge{flex:none;padding:2px 5px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary,#e8f0ff);color:var(--dsw-alias-label-primary,#1d4ed8);font:650 11px/1.25 system-ui}.dsh-mobile-control__provider-badge.is-cpolar{background:var(--dsw-alias-state-success-tertiary,#eaf8f2);color:var(--dsw-alias-label-primary,#087454)}.dsh-mobile-control__provider-description{color:var(--dsw-alias-label-secondary,#606873);font-size:12px;line-height:1.45}.dsh-mobile-control__provider-info{position:absolute;z-index:5;top:-13px;right:-8px}.dsh-mobile-control__provider-info-button{display:flex;align-items:center;justify-content:center;width:44px;height:44px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#475569);cursor:pointer;touch-action:manipulation}.dsh-mobile-control__provider-info-button:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f5f9);color:var(--dsw-alias-label-primary-bluish,#2563eb)}.dsh-mobile-control__provider-info-glyph{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:18px;height:18px;border:1.5px solid currentColor;border-radius:50%;font:700 12px/1 system-ui}.dsh-mobile-control__provider-info-popover{position:absolute;z-index:6;top:38px;right:4px;box-sizing:border-box;width:min(292px,calc(100vw - 72px));padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 10px 28px rgb(15 23 42 / 16%)}.dsh-mobile-control__provider-info-popover[hidden]{display:none}.dsh-mobile-control__provider-info-popover strong,.dsh-mobile-control__provider-info-popover span{display:block}.dsh-mobile-control__provider-info-popover strong{margin-bottom:3px;font-size:12px}.dsh-mobile-control__provider-info-popover span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.55}
.dsh-mobile-control__self-hosted{margin:8px 0 0;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__self-hosted-summary{display:flex;box-sizing:border-box;min-height:48px;align-items:center;justify-content:space-between;gap:10px;padding:8px 11px;cursor:pointer;list-style-position:inside}.dsh-mobile-control__self-hosted-summary>span:first-child{display:flex;min-width:0;flex-direction:column;gap:1px}.dsh-mobile-control__self-hosted-summary strong{font-size:11px}.dsh-mobile-control__self-hosted-summary span span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.35}.dsh-mobile-control__provider-badge.is-frp{background:var(--dsw-alias-bg-layer-1,#eef0f3);color:var(--dsw-alias-label-secondary,#475569)}.dsh-mobile-control__self-hosted-body{padding:0 8px 8px}.dsh-mobile-control__provider.is-frp{width:100%;min-height:64px;background:var(--dsw-alias-bg-layer-2,#fff)}
.dsh-mobile-control__frp-setup input[aria-invalid=true],.dsh-mobile-control__frp-setup select[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary,#bc3030)}
.dsh-mobile-control__frp-setup .dsh-mobile-control__field>.dsh-mobile-control__origin-feedback{margin:0}
/* The cloudflared setup section deliberately reuses this card, so
   .dsh-mobile-control__cloudflared-setup is a DOM hook for targeting rather than a
   style rule of its own. */
.dsh-mobile-control__cpolar-setup{margin:0 0 12px;padding:12px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__cpolar-setup[hidden],.dsh-mobile-control__cpolar-account[hidden],.dsh-mobile-control__details[hidden],.dsh-mobile-control__view.is-remote .dsh-mobile-control__actions[hidden],.dsh-mobile-control__danger[hidden]{display:none}.dsh-mobile-control__component-status,.dsh-mobile-control__component-note{margin:0 0 10px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.55}.dsh-mobile-control__progress{box-sizing:border-box;width:100%;height:6px;margin:0 0 10px}.dsh-mobile-control__progress[hidden]{display:none}.dsh-mobile-control__cpolar-setup>.dsh-mobile-control__primary{width:100%;min-height:44px;padding:9px 12px;border-radius:10px;font:600 12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__cpolar-account{margin-top:10px}.dsh-mobile-control__link-row{display:flex;flex-wrap:wrap;gap:6px 12px;margin:0 0 10px}.dsh-mobile-control__text-link{color:var(--dsw-alias-label-primary-bluish,#2563eb);font-size:11px;text-decoration:none}.dsh-mobile-control__text-link:hover{text-decoration:underline}.dsh-mobile-control__token-label{display:flex;flex-direction:column;gap:5px;margin:0 0 8px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px}.dsh-mobile-control__token{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#fff));color:var(--dsw-alias-label-primary,#16181d);font:16px/1.4 system-ui}.dsh-mobile-control__cpolar-connect{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;min-height:44px;padding:10px 14px;border-radius:12px;font:650 13px/1.2 system-ui;cursor:pointer;transition:background-color 160ms ease,border-color 160ms ease,opacity 160ms ease}.dsh-mobile-control__cpolar-connect:hover:not(:disabled){border-color:#1d4ed8;background:#1d4ed8}.dsh-mobile-control__cpolar-connect:active:not(:disabled){border-color:#1e40af;background:#1e40af}.dsh-mobile-control__cpolar-connect:disabled{cursor:wait;opacity:.55}.dsh-mobile-control__details{margin:10px 0 0;border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb);padding-top:9px}.dsh-mobile-control__details>summary{min-height:36px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:30px;cursor:pointer}.dsh-mobile-control__details-body{display:flex;flex-wrap:wrap;align-items:center;gap:7px 12px;padding:4px 0}.dsh-mobile-control__details-body p{flex:1 0 100%;margin:0;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__storage{display:block;flex:1 0 100%;max-width:100%;overflow:hidden;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f3f5f8);color:var(--dsw-alias-label-secondary,#475569);font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__danger{flex:1 0 100%;min-height:44px;margin-top:3px;padding:7px 10px;border:1px solid var(--dsw-alias-state-error-primary,#dc2626);border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary,#dc2626);font:12px/1.3 system-ui;cursor:pointer}
.dsh-mobile-control__danger:hover:not(:disabled),.dsh-mobile-control__device-revoke:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgb(220 38 38 / 8%))}
.dsh-mobile-control__frp-setup{margin:0;padding:12px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__frp-setup[hidden]{display:none}.dsh-mobile-control__frp-step{padding:11px 0}.dsh-mobile-control__frp-step + .dsh-mobile-control__frp-step{border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}.dsh-mobile-control__frp-step>strong{display:block;margin-bottom:3px;font-size:12px;line-height:1.4}.dsh-mobile-control__frp-step>p{margin:0 0 9px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__frp-changes{margin:0 0 9px;padding:0;list-style:none;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__frp-changes li{position:relative;margin:0;padding-left:12px}.dsh-mobile-control__frp-changes li+li{margin-top:5px}.dsh-mobile-control__frp-changes li::before{content:"•";position:absolute;left:2px;color:var(--dsw-alias-label-tertiary,#98a1ad)}.dsh-mobile-control__frp-step>.dsh-mobile-control__frp-requirement{padding:8px 9px;border-radius:9px;background:var(--dsw-alias-bg-layer-1,#f3f5f8);color:var(--dsw-alias-label-primary,#384152);font-size:11px}.dsh-mobile-control__frp-fields{display:grid;grid-template-columns:minmax(0,1fr) 96px;gap:8px}.dsh-mobile-control__frp-fields[hidden]{display:none}.dsh-mobile-control__frp-fields>.dsh-mobile-control__field:nth-child(5),.dsh-mobile-control__frp-fields>.dsh-mobile-control__field:nth-child(6){grid-column:1/-1}.dsh-mobile-control__frp-fields>.dsh-mobile-control__field[hidden]{display:none}.dsh-mobile-control__frp-fields select{box-sizing:border-box;width:100%;min-height:44px;padding:9px 32px 9px 10px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);font:14px/1.4 system-ui}.dsh-mobile-control__frp-fields select:disabled{cursor:not-allowed;opacity:.55}.dsh-mobile-control__frp-hint{margin:0;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__field{display:flex;min-width:0;flex-direction:column;gap:5px;color:var(--dsw-alias-label-secondary,#606873);font-size:11px}.dsh-mobile-control__field:nth-child(3),.dsh-mobile-control__field:nth-child(4){grid-column:1/-1}.dsh-mobile-control__field input{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);font:16px/1.4 system-ui}.dsh-mobile-control__frp-action{box-sizing:border-box;width:100%;min-height:44px;padding:9px 12px;border-radius:10px;font:650 12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__frp-action:disabled{cursor:not-allowed;opacity:.5}.dsh-mobile-control__remote-workspace{margin:0;padding:12px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:15px;background:var(--dsw-alias-bg-layer-1,#f7f8fa)}.dsh-mobile-control__stage-header{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:9px}.dsh-mobile-control__stage-header .dsh-mobile-control__section-title{margin:0}.dsh-mobile-control__stage-meta{display:flex;min-width:0;align-items:center;justify-content:flex-end;gap:5px}.dsh-mobile-control__stage-value{max-width:115px;overflow:hidden;color:var(--dsw-alias-label-primary,#16181d);font:650 11px/1.3 system-ui;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__state-badge{flex:none;padding:3px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary,#606873);font:650 11px/1.25 system-ui}.dsh-mobile-control__state-badge.is-ready{background:var(--dsw-alias-state-success-tertiary,#e6f7f0);color:var(--dsw-alias-label-primary,#087454)}.dsh-mobile-control__state-badge.is-busy{background:var(--dsw-alias-state-business-tertiary,#e8f0ff);color:var(--dsw-alias-label-primary,#1d4ed8)}.dsh-mobile-control__state-badge.is-attention{background:var(--dsw-alias-state-warn-tertiary,#fff4dc);color:var(--dsw-alias-label-primary,#935100)}.dsh-mobile-control__remote-workspace>.dsh-mobile-control__status{box-sizing:border-box;margin:0 0 10px;padding:9px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);font-size:11px;line-height:1.45}.dsh-mobile-control__provider-setup-body{margin:0 0 10px}.dsh-mobile-control__provider-setup-body>.dsh-mobile-control__cpolar-setup{margin:0}.dsh-mobile-control__provider-setup-body>.dsh-mobile-control__cpolar-setup>.dsh-mobile-control__section-title,.dsh-mobile-control__provider-setup-body>.dsh-mobile-control__frp-setup>.dsh-mobile-control__section-title{display:none}.dsh-mobile-control__provider-setup-body>.dsh-mobile-control__details{margin:0;padding:9px 10px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:11px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__remote-workspace>.dsh-mobile-control__actions{margin-top:2px}.dsh-mobile-control__remote-workspace>.dsh-mobile-control__qr{margin:10px 0 0}.dsh-mobile-control__remote-workspace>.dsh-mobile-control__manage-row{margin-top:10px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}
.dsh-mobile-control__frp-overview{display:grid;grid-template-columns:32px minmax(0,1fr);align-items:center;gap:10px;margin:0 0 10px;padding:10px;border:1px solid var(--dsw-alias-state-success-primary,#a9dfc9);border-radius:11px;background:var(--dsw-alias-state-success-tertiary,#edf9f4)}.dsh-mobile-control__frp-overview[hidden]{display:none}.dsh-mobile-control__frp-overview-mark{display:grid;width:32px;height:32px;place-items:center;border-radius:50%;background:#087454;color:#fff;font:700 15px/1 system-ui}.dsh-mobile-control__frp-overview-body{display:flex;min-width:0;flex-direction:column;gap:2px}.dsh-mobile-control__frp-overview-body strong{color:var(--dsw-alias-label-primary,#075d46);font-size:12px;line-height:1.35}.dsh-mobile-control__frp-overview-body span{overflow:hidden;color:var(--dsw-alias-label-secondary,#357061);font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__frp-group{margin:8px 0 0;overflow:hidden;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:11px;background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__frp-group>summary{box-sizing:border-box;min-height:44px;padding:12px 34px 10px 12px;color:var(--dsw-alias-label-primary,#16181d);font:650 12px/1.4 system-ui;cursor:pointer}.dsh-mobile-control__frp-group[open]>summary{border-bottom:1px solid var(--dsw-alias-border-l2,#e1e5eb);background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__frp-group>.dsh-mobile-control__frp-step{padding:12px}.dsh-mobile-control__frp-group>.dsh-mobile-control__frp-step>strong:first-child{display:none}.dsh-mobile-control__frp-group .dsh-mobile-control__frp-step{border-top:0}.dsh-mobile-control__frp-setup>.dsh-mobile-control__frp-step{margin-bottom:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:11px;background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__tunnel{margin:0 0 10px}.dsh-mobile-control__tunnel[hidden]{display:none}
.dsh-mobile-control__lan-setup{box-sizing:border-box;margin:0 0 12px;padding:14px;border:1px solid #6f96db;border-radius:15px;background:var(--dsw-alias-bg-layer-1,#f5f8ff)}.dsh-mobile-control__lan-setup[hidden],.dsh-mobile-control__lan-setup-form[hidden]{display:none}.dsh-mobile-control__lan-setup>.dsh-mobile-control__section-title{margin-bottom:5px}.dsh-mobile-control__lan-setup>.dsh-mobile-control__intro{margin-bottom:12px}.dsh-mobile-control__lan-setup-form{display:grid;gap:9px}.dsh-mobile-control__lan-setup .dsh-mobile-control__field select{box-sizing:border-box;width:100%;min-height:44px;padding:9px 32px 9px 10px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);font:14px/1.4 system-ui}.dsh-mobile-control__lan-setup .dsh-mobile-control__component-note{margin:0}.dsh-mobile-control__lan-setup-actions{display:grid;grid-template-columns:1fr 1.35fr;gap:8px}.dsh-mobile-control__lan-setup-actions button{box-sizing:border-box;min-width:0;min-height:44px;padding:9px 10px;border-radius:10px;font:650 12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__lan-setup-actions button:disabled{cursor:wait;opacity:.55}.dsh-mobile-control__lan-setup>.dsh-mobile-control__status{margin:10px 0 0;line-height:1.5}.dsh-mobile-control__lan-setup>.dsh-mobile-control__status:empty{display:none}
.dsh-mobile-control__access{display:flex;align-items:baseline;gap:6px;min-width:0;margin:0 0 12px}.dsh-mobile-control__access[hidden]{display:none}.dsh-mobile-control__access-label{flex:none;color:var(--dsw-alias-label-secondary,#606873);white-space:nowrap}.dsh-mobile-control__access-label::after{content:"："}.dsh-mobile-control__access-link{min-width:0;overflow:hidden;color:var(--dsw-alias-label-primary-bluish,#2563eb);text-decoration:none;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__access-link:hover{text-decoration:underline}.dsh-mobile-control__qr{display:flex;justify-content:center;margin:0 0 12px}.dsh-mobile-control__qr[hidden]{display:none}.dsh-mobile-control__qr img{border-radius:12px;background:#fff;padding:8px}.dsh-mobile-control__qr.is-expandable{cursor:zoom-in}.dsh-mobile-control__qr.is-expandable:focus-visible{outline:3px solid var(--dsw-alias-state-business-primary,#2563eb);outline-offset:2px;border-radius:12px}.dsh-mobile-control__qr-zoom{position:fixed;inset:0;z-index:1001;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72)}.dsh-mobile-control__qr-zoom[hidden]{display:none}.dsh-mobile-control__qr-zoom-image{width:min(84vw,360px);height:min(84vw,360px);border-radius:12px;background:#fff;padding:12px}.dsh-mobile-control__qr-zoom-close{position:absolute;top:12px;right:16px;min-width:44px;min-height:44px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);font:600 18px/1 system-ui;cursor:pointer}
.dsh-mobile-control__status{margin:0 0 14px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary,#606873)}.dsh-mobile-control__status::before{display:inline-block;width:8px;height:8px;margin-right:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#98a1ad);content:""}.dsh-mobile-control__status.is-running::before{background:var(--dsw-alias-state-success-primary,#16a36a)}.dsh-mobile-control__status.is-key{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;word-break:break-all}
.dsh-mobile-control__guide{margin:0 0 14px;padding:12px;border:1px solid #6f96db;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#eff6ff)}.dsh-mobile-control__guide[hidden]{display:none}.dsh-mobile-control__guide-title{margin:0;color:var(--dsw-alias-label-primary,#172554);font:650 13px/1.45 system-ui}.dsh-mobile-control__guide-summary,.dsh-mobile-control__guide-note{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#475569);font-size:12px;line-height:1.5}.dsh-mobile-control__guide-steps{margin:8px 0 0;padding-left:20px;color:var(--dsw-alias-label-primary,#1e293b);font-size:12px;line-height:1.6}.dsh-mobile-control__guide-note{color:var(--dsw-alias-label-secondary,#64748b)}.dsh-mobile-control__guide-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.dsh-mobile-control__guide-actions button{min-width:0;min-height:44px;padding:8px;border-radius:10px;font:12px/1.25 system-ui;cursor:pointer}.dsh-mobile-control__guide-actions button:disabled{cursor:not-allowed;opacity:.45}
.dsh-mobile-control__extensions{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#606873);font-size:12px}
.dsh-mobile-control__view.is-diagnostics{--dsh-diagnostic-ok:var(--dsw-alias-state-success-primary,#087454);--dsh-diagnostic-warning:var(--dsw-alias-state-warn-primary,#a35b00);--dsh-diagnostic-error:var(--dsw-alias-state-error-primary,#c62828);--dsh-diagnostic-info:var(--dsw-alias-label-secondary,#526071)}.dsh-mobile-control__diagnostic-summary{box-sizing:border-box;margin:0;padding:13px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:16px;background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__diagnostic-summary-main{display:grid;grid-template-columns:36px minmax(0,1fr);align-items:center;gap:11px}.dsh-mobile-control__diagnostic-summary-icon{position:relative;display:block;width:36px;height:36px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#e8edf3);color:var(--dsh-diagnostic-info)}.dsh-mobile-control__diagnostic-summary-icon::before,.dsh-mobile-control__diagnostic-summary-icon::after{position:absolute;content:""}.dsh-mobile-control__diagnostic-summary-body{display:flex;min-width:0;flex-direction:column;gap:2px}.dsh-mobile-control__diagnostic-summary-body strong{font-size:13px;line-height:1.35}.dsh-mobile-control__diagnostic-summary-body span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5}.dsh-mobile-control__diagnostic-summary-meta{display:block;margin-top:11px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l2,#dbe1e8);color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.45}.dsh-mobile-control__diagnostic-summary.is-ok .dsh-mobile-control__diagnostic-summary-icon{background:var(--dsw-alias-state-success-tertiary,#e6f7f0);color:var(--dsh-diagnostic-ok)}.dsh-mobile-control__diagnostic-summary.is-ok .dsh-mobile-control__diagnostic-summary-icon::before{top:10px;left:10px;width:13px;height:7px;border-bottom:2px solid currentColor;border-left:2px solid currentColor;transform:rotate(-45deg)}.dsh-mobile-control__diagnostic-summary.is-attention .dsh-mobile-control__diagnostic-summary-icon{background:var(--dsw-alias-state-warn-tertiary,#fff4dc);color:var(--dsh-diagnostic-warning)}.dsh-mobile-control__diagnostic-summary.is-error .dsh-mobile-control__diagnostic-summary-icon{background:var(--dsw-alias-state-error-secondary,#fdecec);color:var(--dsh-diagnostic-error)}.dsh-mobile-control__diagnostic-summary.is-attention .dsh-mobile-control__diagnostic-summary-icon::before,.dsh-mobile-control__diagnostic-summary.is-error .dsh-mobile-control__diagnostic-summary-icon::before{top:8px;left:17px;width:2px;height:13px;border-radius:2px;background:currentColor}.dsh-mobile-control__diagnostic-summary.is-attention .dsh-mobile-control__diagnostic-summary-icon::after,.dsh-mobile-control__diagnostic-summary.is-error .dsh-mobile-control__diagnostic-summary-icon::after{bottom:8px;left:17px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-summary.is-running .dsh-mobile-control__diagnostic-summary-icon{background:var(--dsw-alias-state-business-tertiary,#e8f0ff);color:var(--dsw-alias-label-primary-bluish,#2563eb)}.dsh-mobile-control__diagnostic-summary.is-running .dsh-mobile-control__diagnostic-summary-icon::before{inset:9px;border:2px solid rgb(37 99 235 / 24%);border-top-color:currentColor;border-radius:50%;animation:dsh-diagnostic-spin .8s linear infinite}
.dsh-mobile-control__diagnostic-summary.is-idle .dsh-mobile-control__diagnostic-summary-icon::before{top:8px;left:17px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-summary.is-idle .dsh-mobile-control__diagnostic-summary-icon::after{top:13px;left:17px;width:2px;height:11px;border-radius:2px;background:currentColor}
.dsh-mobile-control__diagnostic-toolbar{display:grid;grid-template-columns:1fr;gap:8px;margin-top:10px}.dsh-mobile-control__diagnostic-toolbar.has-report{grid-template-columns:1fr 1fr}.dsh-mobile-control__diagnostic-run,.dsh-mobile-control__diagnostic-copy{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border-radius:11px;font:650 12px/1.3 system-ui;cursor:pointer;touch-action:manipulation}.dsh-mobile-control__diagnostic-copy[hidden]{display:none}.dsh-mobile-control__diagnostic-run:disabled{cursor:wait;opacity:.58}.dsh-mobile-control__diagnostic-feedback{margin:8px 0 0;padding:8px 10px;border-radius:9px;background:var(--dsw-alias-state-business-tertiary,#eff6ff);color:var(--dsw-alias-label-primary,#1d4ed8);font-size:11px;line-height:1.45}.dsh-mobile-control__diagnostic-feedback[hidden]{display:none}
.dsh-mobile-control__diagnostic-checks{display:grid;gap:12px;margin-top:12px;animation:dsh-diagnostic-reveal 160ms ease-out both}.dsh-mobile-control__diagnostic-checks[hidden]{display:none}.dsh-mobile-control__diagnostic-group{overflow:hidden;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__diagnostic-group-header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 11px;border-bottom:1px solid var(--dsw-alias-border-l2,#e1e5eb);background:var(--dsw-alias-bg-layer-1,#f8fafc)}.dsh-mobile-control__diagnostic-group-header h3{margin:0;font:650 11px/1.4 system-ui}.dsh-mobile-control__diagnostic-group-header span{color:var(--dsw-alias-label-secondary,#606873);font-size:11px}.dsh-mobile-control__diagnostic-list{display:flex;flex-direction:column}.dsh-mobile-control__diagnostic-check{display:grid;grid-template-columns:26px minmax(0,1fr);gap:9px;padding:11px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__diagnostic-check + .dsh-mobile-control__diagnostic-check{border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}.dsh-mobile-control__diagnostic-marker{position:relative;width:26px;height:26px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#edf1f5);color:var(--dsh-diagnostic-info)}.dsh-mobile-control__diagnostic-marker::before,.dsh-mobile-control__diagnostic-marker::after{position:absolute;content:""}.dsh-mobile-control__diagnostic-check.is-ok .dsh-mobile-control__diagnostic-marker{background:var(--dsw-alias-state-success-tertiary,#e6f7f0);color:var(--dsh-diagnostic-ok)}.dsh-mobile-control__diagnostic-check.is-ok .dsh-mobile-control__diagnostic-marker::before{top:7px;left:7px;width:9px;height:5px;border-bottom:1.8px solid currentColor;border-left:1.8px solid currentColor;transform:rotate(-45deg)}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-marker{background:var(--dsw-alias-state-warn-tertiary,#fff4dc);color:var(--dsh-diagnostic-warning)}.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-marker{background:var(--dsw-alias-state-error-secondary,#fdecec);color:var(--dsh-diagnostic-error)}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-marker::before,.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-marker::before{top:6px;left:12px;width:2px;height:9px;border-radius:2px;background:currentColor}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-marker::after,.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-marker::after{bottom:6px;left:12px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-check.is-info .dsh-mobile-control__diagnostic-marker::before{top:6px;left:12px;width:2px;height:2px;border-radius:50%;background:currentColor}.dsh-mobile-control__diagnostic-check.is-info .dsh-mobile-control__diagnostic-marker::after{top:10px;left:12px;width:2px;height:9px;border-radius:2px;background:currentColor}.dsh-mobile-control__diagnostic-check-body{min-width:0}.dsh-mobile-control__diagnostic-check-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.dsh-mobile-control__diagnostic-check-header strong{min-width:0;font-size:12px;line-height:1.4}.dsh-mobile-control__diagnostic-badge{flex:none;padding:2px 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,#edf1f5);color:var(--dsh-diagnostic-info);font:650 11px/1.3 system-ui}.dsh-mobile-control__diagnostic-check.is-ok .dsh-mobile-control__diagnostic-badge{background:var(--dsw-alias-state-success-tertiary,#e6f7f0);color:var(--dsh-diagnostic-ok)}.dsh-mobile-control__diagnostic-check.is-warning .dsh-mobile-control__diagnostic-badge{background:var(--dsw-alias-state-warn-tertiary,#fff4dc);color:var(--dsh-diagnostic-warning)}.dsh-mobile-control__diagnostic-check.is-error .dsh-mobile-control__diagnostic-badge{background:var(--dsw-alias-state-error-secondary,#fdecec);color:var(--dsh-diagnostic-error)}.dsh-mobile-control__diagnostic-check p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;line-height:1.5;overflow-wrap:anywhere}.dsh-mobile-control__diagnostic-check .dsh-mobile-control__diagnostic-action{margin-top:7px;padding:7px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f8fafc);color:var(--dsw-alias-label-primary,#16181d)}.dsh-mobile-control__diagnostic-action span{display:inline-block;margin-right:6px;color:var(--dsw-alias-label-primary-bluish,#2563eb);font-weight:700}.dsh-mobile-control__diagnostic-details{margin-top:12px}.dsh-mobile-control__diagnostic-details[hidden]{display:none}.dsh-mobile-control__diagnostic-details>summary{box-sizing:border-box;min-height:44px;line-height:44px}.dsh-mobile-control__diagnostic-report{box-sizing:border-box;max-height:220px;margin:4px 0 0;overflow:auto;padding:10px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#f3f5f8);color:var(--dsw-alias-label-secondary,#606873);font:11px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-mobile-control__diagnostic-checks{transition:opacity 150ms ease}.dsh-mobile-control__diagnostic-checks.is-refreshing{opacity:.52}
@keyframes dsh-diagnostic-spin{to{transform:rotate(360deg)}}@keyframes dsh-diagnostic-reveal{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.dsh-mobile-control__actions{display:flex;flex-wrap:nowrap;gap:6px}.dsh-mobile-control__actions[hidden],.dsh-mobile-control__manage-row[hidden]{display:none}.dsh-mobile-control__actions button{flex:1 1 0;min-width:0;min-height:44px;padding:8px 4px;border-radius:10px;font:12px/1.2 system-ui;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-mobile-control__secondary{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:40px;padding:9px 14px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:transparent;color:inherit;font:600 12px/1.3 system-ui;cursor:pointer;touch-action:manipulation}.dsh-mobile-control__secondary:hover:not(:disabled){border-color:#6f96db;background:var(--dsw-alias-interactive-bg-hover-solid,var(--dsw-alias-bg-layer-1,#f8fbff))}.dsh-mobile-control__secondary:disabled{cursor:wait;opacity:.55}.dsh-mobile-control__secondary[hidden]{display:none}.dsh-mobile-control__primary{border:1px solid #2563eb;background:#2563eb;color:#fff}.dsh-mobile-control__actions button:disabled{cursor:not-allowed;opacity:.45}
.dsh-mobile-control button:focus-visible,.dsh-mobile-control a:focus-visible,.dsh-mobile-control input:focus-visible,.dsh-mobile-control select:focus-visible,.dsh-mobile-control summary:focus-visible{outline:3px solid rgb(37 99 235 / 28%);outline-offset:2px}
/* 42px matches the DSH sidebar footer row; it is not one of the panel target tiers. */
/* Other footer entries share the shell's row; only our own action becomes compact. */
.dsh-mobile-control__trigger:not(.is-rail):not(:only-child){flex:0 0 44px;width:44px;min-width:44px;padding:0;justify-content:center;gap:0}.dsh-mobile-control__trigger:not(.is-rail):not(:only-child) .dsh-mobile-control__trigger-label{display:none}
.dsh-mobile-control__trigger{box-sizing:border-box;flex:1 1 auto;display:flex;align-items:center;gap:8px;width:100%;height:42px;margin:4px 0;padding:0 10px 0 8px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,#16181d);font-family:inherit;font-size:14px;line-height:22px;cursor:pointer;overflow:hidden}.dsh-mobile-control__trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}.dsh-mobile-control__trigger:active,.dsh-mobile-control__trigger[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-active,#e8ebf0)}.dsh-mobile-control__trigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:2px}.dsh-mobile-control__trigger.is-rail{flex:0 0 auto;width:36px;height:36px;margin:8px 0 10px;padding:0;justify-content:center;gap:0;border-radius:50%}.dsh-mobile-control__trigger-icon{display:block;flex:none}.dsh-mobile-control__trigger-label{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.dsh-mobile-control__manage-row{display:flex;justify-content:space-between;gap:8px;margin-top:10px}.dsh-mobile-control__manage{flex:1 1 0;min-width:0;min-height:36px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:transparent;color:inherit;font:12px/1.3 system-ui;cursor:pointer}.dsh-mobile-control__devices{margin-top:10px;border:1px solid var(--dsw-alias-border-l2,#e1e5eb);border-radius:10px;padding:8px;max-height:220px;overflow-y:auto}.dsh-mobile-control__device-empty{color:var(--dsw-alias-label-secondary,#606873);font-size:12px;margin:0}.dsh-mobile-control__device{display:flex;align-items:center;gap:8px;padding:6px 2px}.dsh-mobile-control__device + .dsh-mobile-control__device{border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}.dsh-mobile-control__device-label{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.dsh-mobile-control__device-meta{flex:none;color:var(--dsw-alias-label-secondary,#606873);font-size:11px;white-space:nowrap}.dsh-mobile-control__device-revoke{flex:none;min-height:36px;padding:4px 8px;border:1px solid var(--dsw-alias-state-error-primary,#dc2626);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#dc2626);font:12px/1.2 system-ui;cursor:pointer}.dsh-mobile-control__ws-paths{margin:10px 0 0;padding:12px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__ws-paths-list{margin:0 0 8px;padding:0;list-style:none}.dsh-mobile-control__ws-paths-empty{color:var(--dsw-alias-label-secondary,#606873);font-size:12px}.dsh-mobile-control__ws-paths-item{display:flex;align-items:center;gap:8px;padding:6px 0}.dsh-mobile-control__ws-paths-item + .dsh-mobile-control__ws-paths-item{border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}.dsh-mobile-control__ws-paths-item code{flex:1 1 0;min-width:0;overflow:hidden;font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;text-overflow:ellipsis;white-space:nowrap}.dsh-mobile-control__ws-paths-remove{flex:none;min-height:36px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:8px;background:transparent;color:inherit;font:12px/1.2 system-ui;cursor:pointer}.dsh-mobile-control__trigger,.dsh-mobile-control__diagnostic-entry{position:relative}.dsh-mobile-control__ws-dot{position:absolute;top:2px;right:2px;z-index:1;min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-state-error-primary,#dc2626);color:#fff;font:650 11px/16px system-ui;text-align:center;cursor:pointer}.dsh-mobile-control__ws-dot::after{content:'';position:absolute;inset:-5px}.dsh-mobile-control__ws-sr-status{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}.dsh-mobile-control__ws-paths-row{display:flex;gap:8px}.dsh-mobile-control__ws-paths-row .dsh-mobile-control__primary{width:auto;flex:none;padding:9px 14px;border-radius:10px}.dsh-mobile-control__ws-paths-group{padding:6px 0}.dsh-mobile-control__ws-paths-group + .dsh-mobile-control__ws-paths-group{border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}.dsh-mobile-control__ws-paths-group-head{display:flex;align-items:center;gap:8px}.dsh-mobile-control__ws-count{flex:none;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-state-business-tertiary,#e8f0ff);color:var(--dsw-alias-label-primary,#1d4ed8);font:650 11px/1.6 system-ui}.dsh-mobile-control__ws-paths-item.is-child{padding-left:12px}.dsh-mobile-control__ws-paths-group-head .dsh-mobile-control__primary,.dsh-mobile-control__ws-paths-item .dsh-mobile-control__primary{width:auto;flex:none;min-height:36px;padding:6px 12px;border-radius:10px}.dsh-mobile-control__ws-paths-row input{flex:1 1 0;min-width:0;box-sizing:border-box;min-height:44px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);font:16px/1.4 system-ui}.dsh-mobile-control__ws-paths-row button{flex:none}.dsh-mobile-control__ws-paths-detected-title{margin:0 0 2px;font:600 12px/1.4 system-ui}.dsh-mobile-control__ws-paths-advanced{margin-top:8px}.dsh-mobile-control__ws-paths-advanced summary{cursor:pointer;color:var(--dsw-alias-label-secondary,#606873);font:12px/1.4 system-ui;user-select:none}.dsh-mobile-control__ws-paths-advanced summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,currentColor);outline-offset:2px;border-radius:4px}.dsh-mobile-control__ws-paths-advanced[open] summary{margin-bottom:6px}.dsh-mobile-control__ws-paths-advanced .dsh-mobile-control__status{margin:6px 0 0}
@media (max-width:359px){.dsh-mobile-control__provider{min-height:68px}}@media (prefers-reduced-motion:reduce){.dsh-mobile-control__provider,.dsh-mobile-control__cpolar-connect{transition:none}.dsh-mobile-control__diagnostic-summary.is-running .dsh-mobile-control__diagnostic-summary-icon::before,.dsh-mobile-control__diagnostic-checks{animation:none}}

.dsh-mobile-control__origin-setup{margin:0;padding:12px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:13px;background:var(--dsw-alias-bg-layer-2,#fff)}.dsh-mobile-control__origin-setup[hidden],.dsh-mobile-control__origin-setup [hidden]{display:none}
/* Mode choices are not text fields; preserve native radio sizing and keyboard behavior. */
.dsh-mobile-control__origin-modes{min-width:0;margin:0 0 14px;padding:0;border:0}.dsh-mobile-control__origin-modes legend{margin:0 0 8px;padding:0;color:var(--dsw-alias-label-secondary,#606873);font:600 12px/1.4 system-ui}.dsh-mobile-control__origin-mode{display:flex;box-sizing:border-box;min-height:44px;align-items:center;gap:10px;padding:10px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#f3f5f8);font:12px/1.5 system-ui;cursor:pointer}.dsh-mobile-control__origin-mode+.dsh-mobile-control__origin-mode{margin-top:8px}.dsh-mobile-control__origin-mode:has(input:checked){border-color:var(--dsw-alias-label-primary-bluish,#2563eb)}.dsh-mobile-control__origin-mode:focus-within{outline:2px solid var(--dsw-alias-state-business-primary,#2563eb);outline-offset:2px}.dsh-mobile-control__origin-mode:has(input:disabled){cursor:wait;opacity:.55}.dsh-mobile-control__origin-mode input[type=radio]{flex:0 0 18px;box-sizing:border-box;width:18px;height:18px;min-height:18px;margin:0;padding:0;accent-color:var(--dsw-alias-label-primary-bluish,#2563eb)}.dsh-mobile-control__origin-mode span{min-width:0;overflow-wrap:anywhere}
/* Base the columns on the card width, not the desktop viewport behind the popup. */
.dsh-mobile-control__origin-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,140px),1fr));gap:12px}.dsh-mobile-control__origin-fields>.dsh-mobile-control__field{min-width:0;grid-column:auto;font-size:12px}.dsh-mobile-control__origin-fields>.dsh-mobile-control__field--full{grid-column:1/-1}.dsh-mobile-control__origin-fields select{box-sizing:border-box;width:100%;min-height:44px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);font:16px/1.4 system-ui}.dsh-mobile-control__origin-fields select:disabled{cursor:not-allowed;opacity:.55}.dsh-mobile-control__caddy-form{display:grid;gap:12px}.dsh-mobile-control__caddy-form>.dsh-mobile-control__component-note,.dsh-mobile-control__caddy-form>.dsh-mobile-control__component-status,.dsh-mobile-control__caddy-form>.dsh-mobile-control__origin-feedback{margin:0;overflow-wrap:anywhere}.dsh-mobile-control__origin-setup .dsh-mobile-control__actions.dsh-mobile-control__caddy-actions{grid-template-columns:minmax(0,1fr);margin:0}.dsh-mobile-control__caddy-actions button{box-sizing:border-box;min-width:0;min-height:44px;padding:10px 12px;border-radius:10px;font:600 12px/1.4 system-ui;cursor:pointer}.dsh-mobile-control__origin-warning{margin:12px 0;padding:10px 12px;border-left:3px solid var(--dsw-alias-state-warn-primary,#a56810);border-radius:4px;background:var(--dsw-alias-bg-layer-1,#f3f5f8);color:var(--dsw-alias-label-primary,#384152);font-size:12px;line-height:1.6}.dsh-mobile-control__origin-feedback{font-size:12px;line-height:1.6;overflow-wrap:anywhere}.dsh-mobile-control__origin-feedback.is-error{color:var(--dsw-alias-state-error-primary,#bc3030)}.dsh-mobile-control__origin-fields input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary,#bc3030)}.dsh-mobile-control__origin-backend{display:flex;min-width:0;flex-direction:column;align-items:stretch;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,#dbe1e8)}.dsh-mobile-control__origin-backend button{align-self:flex-start;min-height:44px}.dsh-mobile-control__self-hosted-body .is-origin{margin-top:8px}
/* Final overrides: dense borderless layout must beat the base rules above.
   The earlier dense block sits before those base rules, so these repeat the
   essential de-boxing here at the end of the sheet where they win. */
.dsh-mobile-control__provider{position:relative;border:0;border-radius:8px;padding:8px 10px;min-height:0;background:transparent;box-shadow:none}
.dsh-mobile-control__provider:hover{border-color:transparent;background:var(--dsw-alias-interactive-bg-hover,#f1f5f9)}
.dsh-mobile-control__provider.is-selected{border-color:transparent;background:var(--dsw-alias-interactive-bg-active,#f5f8ff);box-shadow:none}
.dsh-mobile-control__provider.is-lan:not(.is-selected){border-color:transparent;background:transparent}
.dsh-mobile-control__view:not(.is-remote)>.dsh-mobile-control__actions{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.dsh-mobile-control__view.is-diagnostics,.dsh-mobile-control__view.is-devices{flex:1;min-height:0;overflow-y:auto;padding:14px 20px}
.dsh-mobile-control__view.is-devices .dsh-mobile-control__devices{max-height:none;margin-top:0}
.dsh-mobile-control__actions button{white-space:normal;overflow:visible;text-overflow:clip;line-height:1.25;height:auto;padding-top:8px;padding-bottom:8px;word-break:break-word}
.dsh-mobile-control__qr-placeholder{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:192px;height:192px;padding:12px;border:1px dashed var(--dsw-alias-border-l2,#dbe1e8);border-radius:12px;color:var(--dsw-alias-label-secondary,#606873);font-size:12px;line-height:1.5;text-align:center}
.dsh-mobile-control__lan-setup .dsh-mobile-control__actions,.dsh-mobile-control__cpolar-setup .dsh-mobile-control__actions,.dsh-mobile-control__frp-setup .dsh-mobile-control__actions,.dsh-mobile-control__origin-setup .dsh-mobile-control__actions{margin-top:12px}
.dsh-mobile-control__origin-setup .dsh-mobile-control__actions.dsh-mobile-control__caddy-actions{margin-top:12px}
.dsh-mobile-control__qr-zoom{pointer-events:auto}
.dsh-mobile-control__iroh-pairing{border:0;border-radius:0;background:transparent;padding:0;margin:12px 0 0}
/* Config setup panels: drop the rounded card frame so provider configuration
   reads as one flat page with hairline dividers instead of nested boxes. */
.dsh-mobile-control__lan-setup,.dsh-mobile-control__cpolar-setup,.dsh-mobile-control__frp-setup,.dsh-mobile-control__origin-setup{border:0;border-radius:0;background:transparent;padding:0;margin:0 0 12px}
.dsh-mobile-control__frp-setup>.dsh-mobile-control__frp-step,.dsh-mobile-control__frp-group,.dsh-mobile-control__frp-overview{border:0;border-radius:0;background:transparent}
.dsh-mobile-control__ws-paths{border:0;border-radius:0;background:transparent;padding:0;margin:10px 0 0}
.dsh-mobile-control__view.is-remote .dsh-mobile-control__remote-workspace>.dsh-mobile-control__actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.dsh-mobile-control__view.is-remote .dsh-mobile-control__remote-workspace>.dsh-mobile-control__actions[hidden]{display:none}
.dsh-mobile-control__view.is-remote .dsh-mobile-control__origin-setup .dsh-mobile-control__actions.dsh-mobile-control__caddy-actions{display:grid;grid-template-columns:minmax(0,1fr)}
.dsh-mobile-control__remote-workspace{border:0;border-radius:0;background:transparent;box-shadow:none}
.dsh-mobile-control__stage-header{border:0;border-radius:0;background:transparent;box-shadow:none}
.dsh-mobile-control__app-downloads{display:flex;gap:8px;padding:6px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#e1e5eb)}
.dsh-mobile-control__app-download{flex:1 1 0;display:flex;align-items:center;justify-content:space-between;gap:6px;box-sizing:border-box;min-height:34px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#16181d);font-size:12px;text-decoration:none;white-space:normal}
.dsh-mobile-control__app-download.is-iroh{border-color:var(--dsw-alias-label-primary-bluish,#2563eb)}
.dsh-mobile-control__setup-details{margin-top:12px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}
.dsh-mobile-control__remote-workspace>.dsh-mobile-control__qr{margin-bottom:18px}
.dsh-mobile-control__stage-header{display:none}
.dsh-mobile-control__provider-install{margin:0 0 12px}
.dsh-mobile-control__provider-install>.dsh-mobile-control__primary{width:100%;min-height:44px}
.dsh-mobile-control__tunnel-toggle{display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;margin:0 0 10px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary-bluish,#2563eb);font:600 12px/1 system-ui;cursor:pointer}
.dsh-mobile-control__tunnel-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}
.dsh-mobile-control__tunnel>.dsh-mobile-control__primary,.dsh-mobile-control__tunnel>.dsh-mobile-control__secondary{width:100%;min-height:44px;margin-top:10px}
.dsh-mobile-control__provider-info-popover p{margin:0 0 8px;font-size:11px;line-height:1.5}
.dsh-mobile-control__provider-info-popover p:last-child{margin-bottom:0}
.dsh-mobile-control__provider-info-popover{max-width:240px;max-height:44vh;overflow:auto;white-space:normal}
.dsh-mobile-control__mode-row{position:relative;display:flex;align-items:center;gap:8px;margin:0 0 8px}
.dsh-mobile-control__mode-row>.dsh-mobile-control__switcher{flex:1 1 auto;margin:0}
.dsh-mobile-control__notes-toggle{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid var(--dsw-alias-border-l3,#cfd5dd);border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#606873);font:600 13px/1 system-ui;cursor:pointer}
.dsh-mobile-control__notes-toggle:hover{background:var(--dsw-alias-interactive-bg-hover,#f1f3f6)}
.dsh-mobile-control__notes-panel{position:absolute;top:calc(100% + 6px);right:0;z-index:40;width:min(320px,78vw);max-height:50vh;overflow:auto;box-sizing:border-box;margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#dbe1e8);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 6px 20px rgb(15 23 42 / 12%);font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#475569)}
.dsh-mobile-control__notes-panel p{margin:0 0 8px}.dsh-mobile-control__notes-panel p:last-child{margin:0}
.dsh-mobile-control__notes-panel[hidden]{display:none}
.dsh-mobile-control__tunnel-toggle[hidden]{display:none}
.dsh-mobile-control__provider-setup-body .dsh-mobile-control__switcher{border-radius:0;background:transparent;padding:0;gap:8px}
.dsh-mobile-control__provider-setup-body .dsh-mobile-control__tab{border-radius:0;box-shadow:none;border-bottom:2px solid transparent}
.dsh-mobile-control__provider-setup-body .dsh-mobile-control__tab.is-active{background:transparent;box-shadow:none;border-bottom-color:var(--dsw-alias-label-primary-bluish,#2563eb)}
.dsh-mobile-control__origin-setup .dsh-mobile-control__origin-mode{border-radius:0;background:transparent}
.dsh-mobile-control__devices{border:0;border-radius:0;padding:0;margin:0;background:transparent;max-height:none}
.dsh-mobile-control__provider.is-frp:not(.is-selected),.dsh-mobile-control__provider.is-origin:not(.is-selected),.dsh-mobile-control__provider.is-iroh:not(.is-selected){border-color:transparent;background:transparent}
.dsh-mobile-control__provider.is-selected::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:2px;border-radius:2px;background:var(--dsw-alias-label-primary-bluish,#2563eb)}
.dsh-mobile-control__remote-workspace section{border:0;border-radius:0;padding:12px 0;background:transparent;box-shadow:none;border-top:1px solid var(--dsw-alias-border-l2,#e1e5eb)}
.dsh-mobile-control__remote-workspace section:first-child{border-top:0}
.dsh-mobile-control__remote-workspace .dsh-mobile-control__details{border:0;border-radius:0;background:transparent;box-shadow:none}
.dsh-mobile-control__self-hosted{border:0;border-radius:0;background:transparent;box-shadow:none}
` + EXTENSION_RECOVERY_STYLES

interface MobilePushEntryRuntime {
  readonly page: Document
  readonly view: Window
  readonly api?: MobilePushBrowserApi
  readonly environment?: MobilePushEnvironment
  /** Optional notice sink for isolated tests; production uses the accessible page notice. */
  readonly notify?: (key: 'session-unavailable' | 'session-resolved') => void
}

/** Resolve safe, locale-owned copy for tap-navigation results. */
export function mobilePushNavigationNotice(locale: MobileControlLocale, key: 'session-unavailable' | 'session-resolved'): string {
  const messages: Record<MobileControlLocale, Record<typeof key, string>> = {
    en: { 'session-unavailable': 'This conversation is no longer available.', 'session-resolved': 'Opened the conversation.' },
    it: { 'session-unavailable': 'Questa conversazione non è più disponibile.', 'session-resolved': 'Conversazione aperta.' },
    zh: { 'session-unavailable': '此会话已不可用。', 'session-resolved': '已打开会话。' },
  }
  return messages[locale][key]
}

function showMobilePushNavigationNotice(page: Document, view: Window, key: 'session-unavailable' | 'session-resolved'): void {
  const node = page.createElement('div')
  node.className = 'dsh-mobile-push-navigation-notice'
  node.setAttribute('role', 'status')
  node.setAttribute('aria-live', 'polite')
  node.lang = selectedMobileControlLocale()
  node.textContent = mobilePushNavigationNotice(selectedMobileControlLocale(), key)
  node.style.cssText = 'position:fixed;z-index:1201;left:50%;bottom:max(24px,env(safe-area-inset-bottom));transform:translateX(-50%);max-width:calc(100vw - 32px);padding:10px 16px;border-radius:12px;background:var(--dsw-alias-bg-layer-3,#20242b);color:var(--dsw-alias-label-primary,#fff);font:14px/1.45 system-ui,sans-serif;box-shadow:0 8px 24px #0003;pointer-events:none'
  page.body.append(node)
  view.setTimeout(() => node.remove(), 3_000)
}

/** Own the browser-only push controller, settings row, and optional authenticated tap navigation. */
export function installMobilePushBrowserClient(ctx: ClientContext, runtime: MobilePushEntryRuntime): () => void {
  const { page, view } = runtime
  if (view.__DSH_MOBILE_FRONTEND__ !== 'dedicated' || view.__DSH_MOBILE_NATIVE__ !== undefined
    || page.querySelector('meta[name="dsh-mobile-gateway"][content="authenticated"]') === null) return () => undefined

  const api = runtime.api ?? createMobilePushBrowserApi(mobileRequest)
  const controller = createMobilePushController(api, runtime.environment ?? browserPushEnvironment(view))
  controller.start()
  const removeSettings = ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'dsh-mobile-push-browser', order: 120,
  }, () => createElement(MobilePushSettings, { controller, locale: selectedMobileControlLocale() })))

  const refresh = (): void => { controller.refresh() }
  const onVisible = (): void => { if (page.visibilityState === 'visible') refresh() }
  view.addEventListener('focus', refresh)
  page.addEventListener('visibilitychange', onVisible)
  const connection = ctx.get('connection')
  const unbindConnection = connection?.state?.subscribe(() => {
    if (connection.state?.getSnapshot() === 'connected') refresh()
  }) ?? (() => undefined)

  // The tap consumer follows the public navigation services through a scoped
  // child lifecycle: on a cold load the plugin activates with `slots` before
  // sessions/workspaces/uiWorkspace are provided, and a plain effect never
  // re-runs, so a one-shot availability check would silently drop every
  // reference-carrying cold load. The child activates once all three services
  // are active, disposes on provider loss or plugin teardown, and re-runs on
  // re-provision; each activation re-checks the one-time reference so a
  // consumed URL can never resolve or notify twice.
  let removeNavigation: () => void = () => undefined
  let disposeNavigationLifecycle: () => void = () => undefined
  const reference = new URLSearchParams(view.location.search).get('mobile-push')
  if (reference !== null && reference !== '' && ctx.inject !== undefined) {
    let navigationClosed = false
    const navigationFiber = ctx.inject(mobilePushNavigationServices, navigationContext => {
      if (navigationClosed) return () => undefined
      const pending = new URLSearchParams(view.location.search).get('mobile-push')
      if (pending === null || pending === '') return () => undefined
      const remove = installPushNavigation(navigationContext as unknown as Parameters<typeof installPushNavigation>[0], {
        resolve: value => api.resolve(value),
        notify: key => {
          if (key !== 'session-unavailable' && key !== 'session-resolved') return
          if (runtime.notify) runtime.notify(key)
          else showMobilePushNavigationNotice(page, view, key)
        },
        browser: { location: view.location, history: view.history },
      })
      removeNavigation = remove
      return () => {
        if (removeNavigation === remove) removeNavigation = () => undefined
        remove()
      }
    })
    disposeNavigationLifecycle = () => {
      if (navigationClosed) return
      navigationClosed = true
      removeNavigation()
      void navigationFiber.dispose()
    }
  }

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    view.removeEventListener('focus', refresh)
    page.removeEventListener('visibilitychange', onVisible)
    unbindConnection()
    disposeNavigationLifecycle()
    removeSettings()
    controller.stop()
  }
}

/** Mount the desktop control or mobile feature enhancements. */
export function apply(ctx: ClientContext): void {
  let gatewayRejectionSink: ((status: number) => void) | undefined
  let retryRecovery: (() => boolean) | undefined
  let refreshCustomization: (() => void) | undefined
  ctx.effect(() => installMobileUiLocalePersistence(document, window), 'dsh-mobile: browser UI locale persistence')

  ctx.effect(() => {
    if (window.__DSH_MOBILE_FRONTEND__ !== 'dedicated') return
    const connection = ctx.get('connection')
    if (connection !== undefined) return trustAuthenticatedGatewayConnection(connection)
  }, 'dsh-mobile: authenticated gateway client trust')

  ctx.effect(() => {
    const gatewayPage = document.querySelector('meta[name="dsh-mobile-gateway"][content="authenticated"]') !== null
    if (!ownsMobileCustomization(gatewayPage, window.__DSH_MOBILE_FRONTEND__)) return
    let ownedRejection: ((status: number) => void) | undefined
    const recovery = installMobileConnectionRecovery(
      () => ctx.get('connection'), window, document,
      (rejected, retry) => { ownedRejection = rejected; gatewayRejectionSink = rejected; retryRecovery = retry },
      () => { refreshCustomization?.() },
    )
    if (recovery === undefined) { gatewayRejectionSink = undefined; retryRecovery = undefined; return }
    return () => {
      if (gatewayRejectionSink === ownedRejection) { gatewayRejectionSink = undefined; retryRecovery = undefined }
      return recovery()
    }
  }, 'dsh-mobile: connection recovery')

  ctx.effect(() => installMobilePushBrowserClient(ctx, { page: document, view: window }), 'dsh-mobile: authenticated browser push lifecycle')

  ctx.effect(() => {
    const desktopAdmin = isDesktopAdminSurface(location.hostname, location.search, window.__DSH_MOBILE_FRONTEND__, location.protocol)
    const gatewayCustomization = ownsMobileCustomization(document.querySelector('meta[name="dsh-mobile-gateway"][content="authenticated"]') !== null, window.__DSH_MOBILE_FRONTEND__)
    const style = element('style'); style.dataset.plugin = 'dsh-mobile'; style.textContent = desktopAdmin
      ? CONTROL_STYLES
      : NATIVE_MOBILE_STYLES
    style.textContent += CLIENT_MODULE_STYLES
    document.head.append(style)
    const removeCustom = !desktopAdmin || gatewayCustomization ? installCustomAssets({
      rejected: status => { gatewayRejectionSink?.(status) },
      retry: () => retryRecovery?.() ?? false,
      registerRefresh: refresh => {
        refreshCustomization = refresh
        return () => { if (refreshCustomization === refresh) refreshCustomization = undefined }
      },
    }) : () => undefined
    const removeVoiceSession = installVoiceSession(!desktopAdmin)
    const removeDraftTransfer = !desktopAdmin && document.querySelector('meta[name="dsh-mobile-gateway"][content="authenticated"]') !== null
      ? installDraftTransfer(ctx, window, document) : () => undefined
    const removeModuleSettings = ctx.slots.inject('settings.general.item', () => ctx.slots.register({
      name: 'settings.general.item', id: 'dsh-mobile-client-modules', order: 120,
    }, () => createElement(ClientModuleSettingsRow, { scope: desktopAdmin ? 'computer' : 'device', locale: selectedMobileControlLocale() })))
    if (!desktopAdmin) {
      const localFont = installMobileFontPreference()
      const removeSettingsAction = ctx.slots.inject('settings.general.item', () => {
        const removeFontSize = ctx.slots.register({
          name: 'settings.general.item', id: 'font-size', order: 11, priority: -1,
        }, () => createElement(MobileFontSizeRow, { preference: localFont.preference, locale: selectedMobileControlLocale() }))
        const removeDisplayScale = ctx.slots.register({
          name: 'settings.general.item', id: 'dsh-mobile-display-scale', order: 12,
        }, () => createElement(MobileDisplayScaleRow, { locale: selectedMobileControlLocale() }))
        const removeSwitchComputer = ctx.slots.register({
          name: 'settings.general.item',
          id: 'dsh-mobile-switch-computer',
          order: 100,
        }, MobileSwitchComputerRow)
        const removeTaskNotifications = ctx.slots.register({
          name: 'settings.general.item',
          id: 'dsh-mobile-task-notifications',
          order: 110,
        }, MobileTaskNotificationRow)
        return () => { removeTaskNotifications(); removeSwitchComputer(); removeDisplayScale(); removeFontSize() }
      })
      const removeSurface = installDshLanguageBoundSurface(() => installNativeMobileSurface({
        getLayout: () => ctx.get('layout'),
        getSidebarRight: () => ctx.get('sidebarRight'),
      }))
      // The dedicated page owns its directory flow only when DSH's own picker
      // cannot serve a remote browser: the desktop composition keeps DSH's
      // adaptive picker (a native OS chooser there), which no remote browser
      // can reach. When DSH resolved the browse interaction, its own web
      // implementation already fills these slots, and shadowing it would take
      // away the upstream folder creation.
      const removeDirectoryPicker = window.__DSH_MOBILE_FRONTEND__ === 'dedicated'
        && !hasUpstreamBrowsePicker(window)
        ? installMobileDirectoryPicker(ctx, document) : () => Promise.resolve()
      return async () => {
        // Start the picker removal synchronously so no new flow can open, but run
        // the existing teardown in the tick it always used. Awaiting the picker
        // first would defer composer and queued native-call cancellation to a later
        // microtask, letting an already-disposed owner reach the device
        // (smoke:voice-session asserts a cancelled call must not).
        const removal = removeDirectoryPicker()
        try {
          disposeClientModuleDialogs(); removeModuleSettings(); removeSettingsAction(); removeCustom(); removeSurface(); removeVoiceSession(); removeDraftTransfer(); localFont.dispose(); style.remove()
        } finally { await removal }
      }
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
    return () => { disposeClientModuleDialogs(); removeModuleSettings(); removeControl(); removeCustom(); removeVoiceSession(); removeDraftTransfer(); style.remove() }
  }, 'dsh-mobile: stock mobile adaptation and local control')
}

/** Client services required by the mobile adaptation. */
export const inject: readonly string[] = ['slots']
