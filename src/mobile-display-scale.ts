/** Native App page scaling in DSH General settings, independent from local typography. */
import { createElement, useEffect, useState, useSyncExternalStore } from 'react'

export interface MobileDisplayScaleBridge {
  capabilities(): Promise<readonly string[]> | readonly string[]
  invoke(action: string, input?: unknown): Promise<unknown>
}

export interface MobileDisplayScaleValue {
  readonly percent: number
  readonly minPercent: number
  readonly maxPercent: number
}

interface ScaleSnapshot {
  readonly state: 'hidden' | 'loading' | 'ready' | 'busy' | 'error'
  readonly value: MobileDisplayScaleValue | null
}

/** Validate the native reply before displaying or reusing its values in a request. */
export function parseMobileDisplayScale(value: unknown): MobileDisplayScaleValue {
  if (typeof value !== 'object' || value === null || !('percent' in value) || !('minPercent' in value) || !('maxPercent' in value)) {
    throw new TypeError('Native display scale reply is invalid')
  }
  const { percent, minPercent, maxPercent } = value
  if (typeof percent !== 'number' || !Number.isInteger(percent) || typeof minPercent !== 'number' ||
      !Number.isInteger(minPercent) || typeof maxPercent !== 'number' || !Number.isInteger(maxPercent) ||
      minPercent < 80 || maxPercent > 125 || minPercent > 100 || maxPercent < 100 ||
      percent < minPercent || percent > maxPercent) {
    throw new TypeError('Native display scale reply is invalid')
  }
  return Object.freeze({ percent, minPercent, maxPercent })
}

/** Serial native requests; a replaced bridge or disposed row cannot publish stale results. */
export class MobileDisplayScaleController {
  private snapshot: ScaleSnapshot = { state: 'hidden', value: null }
  private readonly listeners = new Set<() => void>()
  private bridge: MobileDisplayScaleBridge | undefined
  private generation = 0
  private active = false

  constructor(private readonly getBridge: () => MobileDisplayScaleBridge | undefined) {}

  getSnapshot = (): ScaleSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  start(): void { this.active = true; this.refresh() }
  stop(): void { this.active = false; this.generation += 1; this.bridge = undefined }

  /** Discover both capabilities before showing a control or querying its current native value. */
  refresh = (): void => {
    if (!this.active) return
    const generation = ++this.generation
    const bridge = this.getBridge()
    this.bridge = bridge
    this.publish({ state: 'hidden', value: null })
    if (bridge === undefined) return
    void Promise.resolve().then(() => bridge.capabilities()).then(async capabilities => {
      if (!this.current(bridge, generation)) return
      if (!capabilities.includes('mobile.display-scale.get') || !capabilities.includes('mobile.display-scale.set')) return
      this.publish({ state: 'loading', value: null })
      try {
        const value = parseMobileDisplayScale(await bridge.invoke('mobile.display-scale.get', {}))
        if (this.current(bridge, generation)) this.publish({ state: 'ready', value })
      } catch (error) {
        if (this.current(bridge, generation)) this.publish({ state: 'error', value: null })
      }
    }, () => { /* Browsers and older or unavailable native adapters have no scale control. */ })
  }

  /** Apply a device-local value once, preserving the last confirmed value when the native request fails. */
  setPercent(percent: number): void {
    const value = this.snapshot.value
    const bridge = this.bridge
    if (!this.active || bridge === undefined || bridge !== this.getBridge() || value === null ||
        this.snapshot.state === 'busy' || this.snapshot.state === 'loading') return
    if (!Number.isInteger(percent) || percent < value.minPercent || percent > value.maxPercent) return
    if (percent === value.percent && this.snapshot.state !== 'error') return
    const generation = this.generation
    this.publish({ state: 'busy', value })
    void Promise.resolve().then(() => this.current(bridge, generation)
      ? bridge.invoke('mobile.display-scale.set', { percent }) : undefined).then(reply => {
      if (!this.current(bridge, generation)) return
      try { this.publish({ state: 'ready', value: parseMobileDisplayScale(reply) }) }
      catch (error) { this.publish({ state: 'error', value }) }
    }, () => {
      if (this.current(bridge, generation)) this.publish({ state: 'error', value })
    })
  }

  private current(bridge: MobileDisplayScaleBridge, generation: number): boolean {
    return this.active && generation === this.generation && this.bridge === bridge && this.getBridge() === bridge
  }

  private publish(snapshot: ScaleSnapshot): void {
    this.snapshot = Object.freeze(snapshot)
    for (const listener of this.listeners) listener()
  }
}

const messages = {
  zh: { title: '页面缩放', description: '调整整个页面的显示大小，仅保存在当前 App 中，与字号设置独立。', reset: '恢复 100%', loading: '读取中…', busy: '正在调整…', error: '无法调整页面缩放，请重试。', retry: '重试' },
  en: { title: 'Page zoom', description: 'Resize the whole page. Saved in this App, separately from font size.', reset: 'Reset to 100%', loading: 'Loading…', busy: 'Applying…', error: 'Could not change page zoom. Try again.', retry: 'Retry' },
  it: { title: 'Zoom pagina', description: 'Ridimensiona tutta la pagina. Salvato in questa app, separatamente dalla dimensione del testo.', reset: 'Ripristina 100%', loading: 'Caricamento…', busy: 'Applicazione…', error: 'Impossibile modificare lo zoom. Riprova.', retry: 'Riprova' },
} as const

/** Native-only General settings row using the existing DSH Mobile controls and locale. */
export function MobileDisplayScaleRow({ locale }: { locale: keyof typeof messages }) {
  const [controller] = useState(() => new MobileDisplayScaleController(() => window.__DSH_MOBILE_NATIVE__))
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => {
    controller.start()
    window.addEventListener('dsh-mobile-native-ready', controller.refresh)
    return () => { window.removeEventListener('dsh-mobile-native-ready', controller.refresh); controller.stop() }
  }, [controller])
  if (snapshot.state === 'hidden') return null
  const copy = messages[locale]
  const value = snapshot.value
  const busy = snapshot.state === 'busy' || snapshot.state === 'loading'
  const description = snapshot.state === 'error' ? copy.error : snapshot.state === 'loading' ? copy.loading : snapshot.state === 'busy' ? copy.busy : copy.description
  const options = value === null ? [] : [...new Set([value.minPercent, value.maxPercent, value.percent,
    ...[80, 85, 90, 95, 100, 105, 110, 115, 120, 125].filter(percent => percent >= value.minPercent && percent <= value.maxPercent)])].sort((a, b) => a - b)
  return createElement('div', { className: 'dsh-mobile-settings_row', style: { flexWrap: 'wrap' }, lang: locale, 'data-mobile-display-scale-setting': true, 'aria-busy': busy },
    createElement('div', { className: 'dsh-mobile-settings_rowText', style: { flexBasis: 160, paddingRight: 8 } },
      createElement('div', { className: 'dsh-mobile-settings_title' }, copy.title),
      createElement('div', { className: 'dsh-mobile-settings_desc', 'aria-live': 'polite' }, description)),
    createElement('div', { className: 'dsh-mobile-settings_fontControls' },
      value === null ? null : createElement('select', { className: 'dsh-mobile-settings_selector', 'aria-label': copy.title,
        disabled: busy, value: value.percent, onChange: (event: { currentTarget: HTMLSelectElement }) => { controller.setPercent(Number(event.currentTarget.value)) } },
      ...options.map(percent => createElement('option', { key: percent, value: percent }, `${percent}%`))),
      snapshot.state === 'error' ? createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', onClick: controller.refresh }, copy.retry)
        : createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', disabled: busy || value === null || value.percent === 100,
          onClick: () => { controller.setPercent(100) } }, copy.reset)))
}
