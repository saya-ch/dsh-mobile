import { createHash, generateKeyPairSync } from 'node:crypto'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
vi.mock('react', async importOriginal => {
  const react = await importOriginal<typeof import('react')>()
  return { ...react, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() }
})
import { MemoryPushStore } from '../src/mobile-push/store.js'
import { PushRegistry } from '../src/mobile-push/registry.js'
import { createMobilePushBrowserApi } from '../src/mobile-push/browser-api.js'
import { browserPushEnvironment, createMobilePushController, type MobilePushApiAdapter, type MobilePushEnvironment } from '../src/mobile-push/client.js'
import type { PushConfig, PushEnrollment, PushEnrollmentResult, PushOwner, PushPreferences, PushSubscriptionData, VapidKeys } from '../src/mobile-push/contracts.js'
import { MOBILE_PUSH_SETTINGS_COPY, MobilePushSettings } from '../src/mobile-push/settings.js'
import { requirePublicMobilePushSwitch, type MobilePushSwitchProps } from '../src/mobile-push/switch-component.js'

/** Stand-in sharing only the public Switch render signature; native rendering is proven by the strict packed smoke. */
const publicSwitchProbe = (props: MobilePushSwitchProps): ReactElement =>
  createElement('button', { type: 'button', role: 'switch', 'aria-checked': props.checked, 'aria-label': props.label })

const preferences: PushPreferences = { question: true, plan: true, approval: true, response: true, goal: true, failure: true }
const subscriptionData: PushSubscriptionData = { endpoint: 'https://push.example/sub', keys: { p256dh: 'p256dh', auth: 'auth' } }
const config: PushConfig = {
  available: true, publicKey: 'AQID', keyFingerprint: 'fingerprint', installationId: 'install-id',
  ownerGeneration: 1, registrationGeneration: 0, status: 'disabled', preferences,
}
function enrollment(mutationGeneration?: number): PushEnrollmentResult {
  return { registration: {
    scopeId: 'scope', deviceId: 'device', origin: 'https://example.test', installationId: 'install-id',
    subscription: subscriptionData, locale: 'en', preferences, generation: 1, keyFingerprint: 'fingerprint',
    enabled: true, health: 'ready',
  }, ...(mutationGeneration === undefined ? {} : { mutationGeneration }) }
}
function setup(overrides: Partial<MobilePushEnvironment> = {}, apiOverrides: Partial<MobilePushApiAdapter> = {}) {
  const subscription = { endpoint: subscriptionData.endpoint, options: { applicationServerKey: new Uint8Array([1, 2, 3]) }, unsubscribe: vi.fn(async () => true), toJSON: () => subscriptionData }
  const pushManager = {
    getSubscription: vi.fn(async () => null),
    subscribe: vi.fn(async () => subscription),
  }
  const api: MobilePushApiAdapter = {
    getConfig: vi.fn(async () => config),
    enroll: vi.fn(async () => enrollment(7)),
    disable: vi.fn(async () => undefined),
    updatePreferences: vi.fn(async () => undefined),
    sendTest: vi.fn(async () => undefined),
    ...apiOverrides,
  }
  const environment: MobilePushEnvironment = {
    secureContext: true, isTopLevel: true, standalone: true, permission: 'default',
    pushManager, storage: { getItem: vi.fn(() => null), setItem: vi.fn() },
    origin: 'https://example.test', randomUUID: () => 'f12a9c10-7b4e-4d8a-9c21-5e6f0a1b2c3d',
    ...overrides,
  }
  return { controller: createMobilePushController(api, environment), api, environment, pushManager, subscription }
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}
function registryKeys(): VapidKeys {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' })
  return { publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url'), privateKey: jwk.d! }
}
function registryApi(
  service: PushRegistry, owner: PushOwner, calls: Array<{ installationId: string; ifGeneration?: number }>,
  enroll: (value: PushEnrollment) => Promise<PushEnrollmentResult> = value => service.upsert(owner, value),
): MobilePushApiAdapter {
  return {
    getConfig: installationId => service.config(owner, installationId),
    enroll,
    disable: async value => {
      calls.push(value)
      const ifGeneration = Reflect.get(value, 'ifGeneration') as number | undefined
      await service.disable({ ...owner, installationId: value.installationId }, ifGeneration)
    },
    updatePreferences: async () => undefined,
    sendTest: async () => undefined,
  }
}
function createRegistryBrowserEnvironment(installationId: string, publicKey: string): { environment: MobilePushEnvironment } {
  const subscription = {
    endpoint: 'https://push.apple.com/topic/token-a',
    options: { applicationServerKey: new Uint8Array(Buffer.from(publicKey, 'base64url')) },
    toJSON: () => ({ endpoint: 'https://push.apple.com/topic/token-a', keys: { p256dh: 'p256dh-a', auth: 'auth-a' } }),
    unsubscribe: async () => true,
  }
  return { environment: {
    secureContext: true, isTopLevel: true, standalone: true, permission: 'default', origin: 'https://example.test',
    randomUUID: () => installationId,
    storage: { getItem: () => null, setItem: () => undefined },
    pushManager: { getSubscription: async () => null, subscribe: async () => subscription },
  } }
}
describe('mobile push browser controller', () => {
  it('renders Enable for the explicit disabled state', () => {
    const snapshot = { state: 'disabled' as const, preferences }
    const controller = { subscribe: () => () => undefined, getSnapshot: () => snapshot, enableFromGesture: vi.fn(), disable: vi.fn(), updatePreferences: vi.fn(), sendTest: vi.fn(), start: vi.fn(), stop: vi.fn(), refresh: vi.fn() }
    const row = MobilePushSettings({ controller, locale: 'en' }) as unknown as { props: { children: unknown } }
    const visit = (value: unknown): Array<{ type: unknown; props?: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(visit)
      if (typeof value !== 'object' || value === null || !('type' in value)) return []
      const element = value as { type: unknown; props?: Record<string, unknown> }
      return [element, ...visit(element.props?.children)]
    }
    const enable = visit(row).find(element => element.type === 'button' && element.props?.children === 'Enable')
    expect(enable).toBeDefined()
    expect(enable?.props?.disabled).not.toBe(true)
  })

  it.each(['en', 'zh', 'it'] as const)('renders six %s categories through the injected public Switch with localized labels left', locale => {
    const snapshot = { state: 'ready' as const, preferences }
    const controller = { subscribe: vi.fn(() => () => undefined), getSnapshot: () => snapshot, enableFromGesture: vi.fn(), disable: vi.fn(), updatePreferences: vi.fn(), sendTest: vi.fn(), start: vi.fn(), stop: vi.fn(), refresh: vi.fn() }
    const row = MobilePushSettings({ controller, locale, switchComponent: publicSwitchProbe }) as unknown as { props: { children: unknown } }
    const visit = (value: unknown): Array<{ type: unknown; props?: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(visit)
      if (typeof value !== 'object' || value === null || !('type' in value)) return []
      const element = value as { type: unknown; props?: Record<string, unknown> }
      return [element, ...visit(element.props?.children)]
    }
    const elements = visit(row)
    const copy = MOBILE_PUSH_SETTINGS_COPY[locale]
    const categoryKeys = ['question', 'plan', 'approval', 'response', 'goal', 'failure'] as const
    type CategoryKey = (typeof categoryKeys)[number]
    const rows = elements.filter(element => element.type === 'label' && element.props?.className === 'dsh-mobile-push-category')
    expect(rows).toHaveLength(6)
    rows.forEach((categoryRow, index) => {
      const key = categoryKeys[index] as CategoryKey
      const children = Array.isArray(categoryRow.props?.children) ? categoryRow.props.children : [categoryRow.props?.children]
      const name = children.findIndex(child => (child as { props?: { className?: string } })?.props?.className === 'dsh-mobile-push-categoryName')
      const control = children.findIndex(child => (child as { type?: unknown })?.type === publicSwitchProbe)
      expect(name).toBeGreaterThanOrEqual(0)
      expect(control).toBeGreaterThanOrEqual(0)
      expect(name).toBeLessThan(control)
      expect((children[name] as { props?: { children?: unknown } }).props?.children).toBe(copy.categories[index])
      const switchProps = (children[control] as { props?: Record<string, unknown> }).props
      expect(switchProps).toMatchObject({ checked: preferences[key], label: copy.categories[index] })
      expect(switchProps?.onChange).toBeTypeOf('function')
    })
    expect(elements.some(element => element.type === 'input')).toBe(false)
  })

  it.each(['ready', 'enabled'] as const)('owns a full-width category column above its %s actions without a legacy settings wrapper', state => {
    const snapshot = { state, preferences }
    const controller = { subscribe: vi.fn(() => () => undefined), getSnapshot: () => snapshot, enableFromGesture: vi.fn(), disable: vi.fn(), updatePreferences: vi.fn(), sendTest: vi.fn(), start: vi.fn(), stop: vi.fn(), refresh: vi.fn() }
    const row = MobilePushSettings({ controller, locale: 'en', switchComponent: publicSwitchProbe }) as ReactElement<{ style: Record<string, unknown>; children: ReactElement<{ style: Record<string, unknown>; className: string; children: unknown }>[] }>
    // The component is mounted without an ancestor or shell marker here. Removing
    // this owned column makes the generic settings row put actions beside all six
    // categories in the newer settings grid.
    expect(row.props.style).toMatchObject({ flexDirection: 'column', alignItems: 'stretch' })
    const [content, actions] = row.props.children
    expect(content?.props.style.paddingRight).toBe(0)
    expect(actions?.props.className).toBe('dsh-mobile-push-actions')
    const buttons = actions?.props.children as ReactElement<{ children: string }>[]
    expect(buttons.filter(Boolean).map(button => button.props.children)).toEqual(state === 'enabled' ? ['Send test', 'Disable'] : ['Enable'])
  })

  it('sends exactly one guarded update per public Switch boolean change and preserves the other five', () => {
    const snapshot = { state: 'ready' as const, preferences }
    const controller = { subscribe: vi.fn(() => () => undefined), getSnapshot: () => snapshot, enableFromGesture: vi.fn(), disable: vi.fn(), updatePreferences: vi.fn(), sendTest: vi.fn(), start: vi.fn(), stop: vi.fn(), refresh: vi.fn() }
    const row = MobilePushSettings({ controller, locale: 'en', switchComponent: publicSwitchProbe }) as unknown as { props: { children: unknown } }
    const visit = (value: unknown): Array<{ type: unknown; props?: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(visit)
      if (typeof value !== 'object' || value === null || !('type' in value)) return []
      const element = value as { type: unknown; props?: Record<string, unknown> }
      return [element, ...visit(element.props?.children)]
    }
    const controls = visit(row).filter(element => element.type === publicSwitchProbe)
    expect(controls).toHaveLength(6)
    const categoryKeys = ['question', 'plan', 'approval', 'response', 'goal', 'failure'] as const
    type CategoryKey = (typeof categoryKeys)[number]
    controls.forEach((control, index) => {
      const key = categoryKeys[index] as CategoryKey
      const onChange = control.props?.onChange as (next: boolean) => void
      expect(onChange).toBeTypeOf('function')
      onChange(!preferences[key])
      expect(controller.updatePreferences).toHaveBeenLastCalledWith({ ...preferences, [key]: !preferences[key] })
    })
    expect(controller.updatePreferences).toHaveBeenCalledTimes(6)
  })

  it('renders category switches without requesting any controller action', () => {
    const snapshot = { state: 'ready' as const, preferences }
    const controller = { subscribe: vi.fn(() => () => undefined), getSnapshot: () => snapshot, enableFromGesture: vi.fn(), disable: vi.fn(), updatePreferences: vi.fn(), sendTest: vi.fn(), start: vi.fn(), stop: vi.fn(), refresh: vi.fn() }
    MobilePushSettings({ controller, locale: 'en', switchComponent: publicSwitchProbe })
    for (const action of [controller.enableFromGesture, controller.disable, controller.updatePreferences, controller.sendTest, controller.start, controller.stop, controller.refresh]) {
      expect(action).not.toHaveBeenCalled()
    }
  })

  it('withdraws category controls when no public Switch component can be resolved', () => {
    const snapshot = { state: 'ready' as const, preferences }
    const controller = { subscribe: vi.fn(() => () => undefined), getSnapshot: () => snapshot, enableFromGesture: vi.fn(), disable: vi.fn(), updatePreferences: vi.fn(), sendTest: vi.fn(), start: vi.fn(), stop: vi.fn(), refresh: vi.fn() }
    expect(requirePublicMobilePushSwitch()).toBeUndefined()
    const row = MobilePushSettings({ controller, locale: 'en' }) as unknown as { props: { children: unknown } }
    const visit = (value: unknown): Array<{ type: unknown; props?: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(visit)
      if (typeof value !== 'object' || value === null || !('type' in value)) return []
      const element = value as { type: unknown; props?: Record<string, unknown> }
      return [element, ...visit(element.props?.children)]
    }
    const elements = visit(row)
    expect(elements.some(element => String(element.props?.className ?? '').includes('dsh-mobile-push-categories'))).toBe(false)
    expect(elements.some(element => element.type === 'button' && element.props?.children === 'Enable')).toBe(true)
  })

  it('provides localized action copy in English, Chinese and Italian', () => {
    expect(MOBILE_PUSH_SETTINGS_COPY.en.enable).toBe('Enable')
    expect(MOBILE_PUSH_SETTINGS_COPY.zh.enable).toBe('启用')
    expect(MOBILE_PUSH_SETTINGS_COPY.it.enable).toBe('Attiva')
    expect(MOBILE_PUSH_SETTINGS_COPY.en.test).toBe('Send test')
    expect(MOBILE_PUSH_SETTINGS_COPY.zh.test).toBe('发送测试')
    expect(MOBILE_PUSH_SETTINGS_COPY.it.test).toBe('Invia test')
    expect(MOBILE_PUSH_SETTINGS_COPY.en.testBusy).toBe('Sending…')
    expect(MOBILE_PUSH_SETTINGS_COPY.zh.testBusy).toBe('发送中…')
    expect(MOBILE_PUSH_SETTINGS_COPY.it.testBusy).toBe('Invio…')
  })
  it('passes its generated installation id to the public config adapter', async () => {
    const { controller, api } = setup()
    controller.start()
    await flush()
    expect(api.getConfig).toHaveBeenCalledWith('f12a9c10-7b4e-4d8a-9c21-5e6f0a1b2c3d')
    controller.stop()
  })

  it('rechecks live browser permission after focus refresh on the same controller', async () => {
    let permission: NotificationPermission = 'default'
    const pushManager = { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => { throw new Error('unexpected subscribe') }) }
    const page = { documentElement: { lang: 'en' } }
    const view = {
      isSecureContext: true, location: { origin: 'https://example.test' }, navigator: { standalone: true },
      matchMedia: () => ({ matches: true }), crypto: { randomUUID: () => 'f12a9c10-7b4e-4d8a-9c21-5e6f0a1b2c3d' },
      pushManager, document: page, top: null as unknown, self: null as unknown,
    }
    view.top = view
    view.self = view
    Object.defineProperty(view, 'Notification', { get: () => ({ permission }) })
    const api = { getConfig: vi.fn(async () => config), enroll: vi.fn(async () => enrollment(2)), disable: vi.fn(async () => undefined), updatePreferences: vi.fn(async () => undefined), sendTest: vi.fn(async () => undefined) }
    const environment = browserPushEnvironment(view as never)
    const controller = createMobilePushController(api, environment)
    controller.start()
    await flush()
    expect(controller.getSnapshot().state).toBe('ready')
    permission = 'denied'
    controller.refresh()
    await flush()
    expect(controller.getSnapshot().state).toBe('denied')
    expect(api.getConfig).toHaveBeenCalledTimes(1)
    permission = 'granted'
    controller.refresh()
    await flush()
    expect(controller.getSnapshot().state).toBe('ready')
    expect(api.getConfig).toHaveBeenCalledTimes(2)
    expect(pushManager.subscribe).not.toHaveBeenCalled()
    controller.stop()
  })

  it('refreshes from config without prompting or creating a subscription', async () => {
    const { controller, pushManager } = setup()
    controller.start()
    await flush()
    controller.refresh()
    await flush()
    expect(pushManager.subscribe).not.toHaveBeenCalled()
    expect(controller.getSnapshot().state).toBe('ready')
    controller.stop()
  })

  it('uses a memory installation id when local storage is inaccessible', async () => {
    const storage = { getItem: vi.fn(() => { throw new Error('denied') }), setItem: vi.fn(() => { throw new Error('denied') }) }
    const { controller, api } = setup({ storage })
    controller.start()
    await flush()
    expect(controller.getSnapshot().state).toBe('ready')
    expect(api.getConfig).toHaveBeenCalledWith('f12a9c10-7b4e-4d8a-9c21-5e6f0a1b2c3d')
    controller.stop()
  })

  it('keeps insecure, unsupported, tab and denied states distinct', async () => {
    const cases: Array<[Partial<MobilePushEnvironment>, string]> = [
      [{ secureContext: false }, 'unsupported'], [{ pushManager: undefined }, 'unsupported'],
      [{ standalone: false }, 'install'], [{ permission: 'denied' }, 'denied'],
    ]
    for (const [environment, state] of cases) {
      const { controller, pushManager } = setup(environment)
      controller.start()
      await flush()
      expect(controller.getSnapshot().state).toBe(state)
      expect(pushManager.subscribe).not.toHaveBeenCalled()
      controller.stop()
    }
  })

  it.each([null, 1_800_000])('projects standard PushSubscriptionJSON expirationTime=%s before registry enrollment', async expirationTime => {
    const keys = registryKeys()
    const installationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const owner = { scopeId: 'scope-test', deviceId: 'device-test', origin: 'https://example.test' }
    const service = new PushRegistry(new MemoryPushStore(), () => keys)
    await service.initialize()
    const initial = await service.config(owner, installationId)
    const browserJson = { endpoint: subscriptionData.endpoint, expirationTime, keys: subscriptionData.keys }
    const subscription = {
      endpoint: browserJson.endpoint,
      options: { applicationServerKey: new Uint8Array(Buffer.from(initial.publicKey!, 'base64url')) },
      unsubscribe: vi.fn(async () => true), toJSON: () => browserJson,
    }
    const pushManager = { getSubscription: vi.fn(async () => null), subscribe: vi.fn(async () => subscription) }
    const wire: Array<{ path: string; init?: RequestInit }> = []
    const api = createMobilePushBrowserApi(async (path, init) => {
      wire.push(init === undefined ? { path } : { path, init })
      const url = new URL(path, owner.origin)
      if (init?.method === 'GET') {
        return new Response(JSON.stringify(await service.config(owner, url.searchParams.get('installationId') ?? '')), { status: 200 })
      }
      if (path === '/mobile-access/push/subscription') {
        const value = JSON.parse(String(init?.body)) as PushEnrollment
        return new Response(JSON.stringify(await service.upsert(owner, value)), { status: 200 })
      }
      throw new Error(`unexpected test request: ${path}`)
    })
    const controller = createMobilePushController(api, {
      secureContext: true, isTopLevel: true, standalone: true, permission: 'default', pushManager,
      origin: owner.origin, randomUUID: () => installationId,
    })
    controller.start()
    await new Promise<void>(resolve => {
      let unsubscribe = (): void => undefined
      const settle = (): void => {
        if (controller.getSnapshot().state === 'pending') return
        unsubscribe()
        resolve()
      }
      unsubscribe = controller.subscribe(settle)
      settle()
    })
    expect(controller.getSnapshot().state).toBe('ready')
    await controller.enableFromGesture()
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().state).toBe('enabled')
    const enrollmentRequest = wire.find(request => request.path === '/mobile-access/push/subscription')
    expect(enrollmentRequest).toBeDefined()
    const payload = JSON.parse(String(enrollmentRequest?.init?.body)) as PushEnrollment
    expect(payload.subscription).toStrictEqual(subscriptionData)
    const registration = service.snapshot().registrations.find(row => row.installationId === installationId)
    expect(registration?.subscription).toStrictEqual(subscriptionData)
    controller.stop()
    await service.close()
  })

  it('creates a subscription synchronously in the explicit gesture before unrelated awaits', async () => {
    const { controller, pushManager } = setup()
    controller.start()
    await flush()
    const pending = controller.enableFromGesture()
    expect(pushManager.subscribe).toHaveBeenCalledExactlyOnceWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) })
    await pending
    expect(controller.getSnapshot().state).toBe('enabled')
    controller.stop()
  })

  it('sends category preference updates as one guarded host mutation', async () => {
    const nextPreferences = { ...preferences, approval: false, failure: false }
    const getConfig = vi.fn().mockResolvedValueOnce(config).mockResolvedValue({ ...config, preferences: nextPreferences })
    const { controller, api } = setup({}, { getConfig })
    controller.start()
    await flush()
    await controller.updatePreferences(nextPreferences)
    expect(api.updatePreferences).toHaveBeenCalledExactlyOnceWith({
      installationId: 'install-id', ownerGeneration: 1, registrationGeneration: 0, preferences: nextPreferences,
    })
    expect(controller.getSnapshot().preferences).toEqual(nextPreferences)
    controller.stop()
  })

  it('does not retry a host rate-limited Send test and hides raw provider errors', async () => {
    const throttled = Object.assign(new Error('private upstream detail'), { code: 'rate_limited' })
    const enabledConfig = { ...config, status: 'enabled' as const }
    const sendTest = vi.fn(async () => { throw throttled })
    const { controller, api } = setup({}, { getConfig: vi.fn(async () => enabledConfig), sendTest })
    controller.start()
    await flush()
    await controller.sendTest()
    expect(sendTest).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).toMatchObject({ state: 'enabled', error: 'push.test.rateLimited' })
    expect(controller.getSnapshot().error).not.toContain('private upstream detail')
    controller.stop()
  })

  it('persists host opt-out without unsubscribing the browser subscription', async () => {
    const order: string[] = []
    const { controller, api, pushManager, subscription } = setup({}, {
      disable: vi.fn(async () => { order.push('disable') }),
    })
    subscription.unsubscribe.mockImplementation(async () => { order.push('unsubscribe'); throw Error('cleanup') })
    controller.start()
    await flush()
    await controller.enableFromGesture()
    await controller.disable()
    expect(order).toEqual(['disable'])
    expect(api.disable).toHaveBeenCalledTimes(1)
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(controller.getSnapshot().state).toBe('disabled')
    controller.stop()
  })

  it('refreshes guards after Disable and permits only a new explicit Enable intent', async () => {
    const nextConfig = { ...config, ownerGeneration: 2, registrationGeneration: 1 }
    const getConfig = vi.fn().mockResolvedValueOnce(config).mockResolvedValue(nextConfig)
    const { controller, api, pushManager } = setup({}, { getConfig })
    controller.start()
    await flush()
    await controller.disable()
    expect(controller.getSnapshot().state).toBe('disabled')
    const reenabling = controller.enableFromGesture()
    expect(pushManager.subscribe).toHaveBeenCalledTimes(1)
    await reenabling
    expect(api.getConfig).toHaveBeenCalledTimes(2)
    expect(api.enroll).toHaveBeenCalledWith(expect.objectContaining({ ownerGeneration: 2, registrationGeneration: 1 }))
    expect(controller.getSnapshot().state).toBe('enabled')
    controller.stop()
  })

  it('unsubscribes a subscription created by an attempt whose save fails', async () => {
    const { controller, subscription } = setup({}, { enroll: vi.fn(async () => { throw new Error('host failure') }) })
    controller.start()
    await flush()
    await controller.enableFromGesture()
    expect(subscription.unsubscribe).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().state).toBe('failed')
    controller.stop()
  })

  it('rejects foreign application-server keys without unsubscribing them', async () => {
    const foreign = { endpoint: 'https://push.example/foreign', options: { applicationServerKey: new Uint8Array([9, 9, 9]) }, unsubscribe: vi.fn(async () => true), toJSON: () => subscriptionData }
    const { controller, pushManager, api } = setup()
    pushManager.getSubscription.mockResolvedValue(foreign as never)
    controller.start()
    await flush()
    await controller.enableFromGesture()
    expect(foreign.unsubscribe).not.toHaveBeenCalled()
    expect(pushManager.subscribe).not.toHaveBeenCalled()
    expect(api.enroll).not.toHaveBeenCalled()
    controller.stop()
  })

  it('allows explicit disable to invalidate a held enrollment and conditionally clean its late success', async () => {
    let finish!: (value: PushEnrollmentResult) => void
    const enroll = vi.fn(() => new Promise<PushEnrollmentResult>(resolve => { finish = resolve }))
    const { controller, api } = setup({}, { enroll })
    controller.start()
    await flush()
    const enabling = controller.enableFromGesture()
    await flush()
    await controller.disable()
    finish(enrollment(19))
    await enabling
    await flush()
    expect(api.disable).toHaveBeenNthCalledWith(1, { installationId: 'install-id' })
    expect(api.disable).toHaveBeenNthCalledWith(2, { installationId: 'install-id', ifGeneration: 19 })
    expect(controller.getSnapshot().state).toBe('disabled')
    controller.stop()
  })

  it('keeps committed enrollment disabled when explicit opt-out precedes its held acknowledgement', async () => {
    const keys = registryKeys()
    const installationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const owner = { scopeId: 'scope-test', deviceId: 'device-test', origin: 'https://example.test' }
    const service = new PushRegistry(new MemoryPushStore(), () => keys)
    await service.initialize()
    const committed = deferred<PushEnrollmentResult>()
    const ack = deferred<void>()
    const calls: Array<{ installationId: string; ifGeneration?: number }> = []
    const api = registryApi(service, owner, calls, async enrollment => {
      const result = await service.upsert(owner, enrollment)
      committed.resolve(result)
      await ack.promise
      return result
    })
    const browser = createRegistryBrowserEnvironment(installationId, keys.publicKey)
    const controller = createMobilePushController(api, browser.environment)
    controller.start()
    await flush()
    const enabling = controller.enableFromGesture()
    const saved = await committed.promise
    await controller.disable()
    const disabled = await service.config(owner, installationId)
    expect(disabled.status).toBe('disabled')
    ack.resolve()
    await enabling
    const afterLateCleanup = await service.config(owner, installationId)
    expect(afterLateCleanup.status).toBe('disabled')
    expect(afterLateCleanup.ownerGeneration).toBe(disabled.ownerGeneration)
    expect(calls).toEqual([{ installationId }, { installationId, ifGeneration: saved.mutationGeneration }])
    controller.stop()
    await service.close()
  })

  it('does not let a stale created-subscription cleanup unlink newer re-enabled consent', async () => {
    const keys = registryKeys()
    const installationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const owner = { scopeId: 'scope-test', deviceId: 'device-test', origin: 'https://example.test' }
    const service = new PushRegistry(new MemoryPushStore(), () => keys)
    await service.initialize()
    const subscription = {
      endpoint: 'https://push.apple.com/topic/re-enabled',
      options: { applicationServerKey: new Uint8Array(Buffer.from(keys.publicKey, 'base64url')) },
      toJSON: () => ({ endpoint: 'https://push.apple.com/topic/re-enabled', keys: { p256dh: 'p256dh-b', auth: 'auth-b' } }),
      unsubscribe: vi.fn(async () => false),
    }
    let hasSubscription = false
    const pushManager = {
      getSubscription: vi.fn(async () => hasSubscription ? subscription : null),
      subscribe: vi.fn(async () => { hasSubscription = true; return subscription }),
    }
    const environment: MobilePushEnvironment = {
      secureContext: true, isTopLevel: true, standalone: true, permission: 'default', pushManager,
      origin: owner.origin, randomUUID: () => installationId, storage: { getItem: () => null, setItem: () => undefined },
    }
    const firstCommitted = deferred<PushEnrollmentResult>()
    const ack = deferred<void>()
    let enrollmentCount = 0
    const disableCalls: Array<{ installationId: string; ifGeneration?: number }> = []
    const api = registryApi(service, owner, disableCalls, async value => {
      const result = await service.upsert(owner, value)
      if (++enrollmentCount === 1) { firstCommitted.resolve(result); await ack.promise }
      return result
    })
    const controller = createMobilePushController(api, environment)
    controller.start()
    await flush()
    const firstEnable = controller.enableFromGesture()
    const first = await firstCommitted.promise
    await controller.disable()
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    const secondEnable = controller.enableFromGesture()
    await secondEnable
    const secondConsent = await service.config(owner, installationId)
    expect(secondConsent.status).toBe('enabled')
    ack.resolve()
    await firstEnable
    const finalConsent = await service.config(owner, installationId)
    expect(finalConsent.status).toBe('enabled')
    expect(finalConsent.ownerGeneration).toBe(secondConsent.ownerGeneration)
    expect(subscription.unsubscribe).not.toHaveBeenCalled()
    expect(disableCalls).toEqual([{ installationId }, { installationId, ifGeneration: first.mutationGeneration }])
    controller.stop()
    await service.close()
  })

  it('advances the owner barrier on explicit disable even before a held enrollment reaches commit', async () => {
    const keys = registryKeys()
    const installationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const owner = { scopeId: 'scope-test', deviceId: 'device-test', origin: 'https://example.test' }
    const service = new PushRegistry(new MemoryPushStore(), () => keys)
    await service.initialize()
    const entered = deferred<void>()
    const release = deferred<void>()
    const calls: Array<{ installationId: string; ifGeneration?: number }> = []
    let rejectedByAdvancedBarrier = false
    const api = registryApi(service, owner, calls, async enrollment => {
      entered.resolve()
      await release.promise
      try { return await service.upsert(owner, enrollment) }
      catch (error) { rejectedByAdvancedBarrier = error instanceof Error && /generation/u.test(error.message); throw error }
    })
    const browser = createRegistryBrowserEnvironment(installationId, keys.publicKey)
    const controller = createMobilePushController(api, browser.environment)
    controller.start()
    await flush()
    const enabling = controller.enableFromGesture()
    await entered.promise
    await controller.disable()
    expect((await service.config(owner, installationId)).status).toBe('disabled')
    release.resolve()
    await enabling
    expect(rejectedByAdvancedBarrier).toBe(true)
    expect(calls).toEqual([{ installationId }])
    expect((await service.config(owner, installationId)).status).toBe('disabled')
    controller.stop()
    await service.close()
  })

  it('refreshes config after stale-generation rejection without replaying the mutation', async () => {
    const stale = Object.assign(new Error('stale'), { code: 'stale_generation' })
    const { controller, api } = setup({}, { updatePreferences: vi.fn(async () => { throw stale }) })
    controller.start()
    await flush()
    await controller.updatePreferences({ ...preferences, question: false })
    await flush()
    expect(api.updatePreferences).toHaveBeenCalledTimes(1)
    expect(api.getConfig).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().state).toBe('ready')
    controller.stop()
  })

  it('does not revoke established host consent when stopped', async () => {
    const { controller, api } = setup({})
    controller.start()
    await flush()
    controller.stop()
    expect(api.disable).not.toHaveBeenCalled()
  })

  it('does not compensate a canonical read-only recovery response', async () => {
    const { controller, api, subscription, pushManager } = setup({
      permission: 'granted',
    }, { enroll: vi.fn(async () => enrollment(undefined)) })
    pushManager.getSubscription.mockResolvedValue(subscription as never)
    controller.start()
    await flush()
    await controller.enableFromGesture()
    expect(api.disable).not.toHaveBeenCalled()
    controller.stop()
  })

  const validStoredId = '3f2a9c10-7b4e-4d8a-9c21-5e6f0a1b2c3d'
  const storageKey = 'dsh-mobile-push-installation'

  it('keeps a valid stored installation id byte-for-byte stable', async () => {
    const stored: Record<string, string> = { [storageKey]: validStoredId }
    const getConfig = vi.fn(async (id: string) => ({ ...config, installationId: id }))
    const { controller, api } = setup({ storage: { getItem: (k: string) => stored[k] ?? null, setItem: (k: string, v: string) => { stored[k] = v } } }, { getConfig })
    controller.start()
    await flush()
    expect(api.getConfig).toHaveBeenCalledWith(validStoredId)
    expect(stored[storageKey]).toBe(validStoredId)
  })

  it.each([
    ['all-zero pseudo-UUID', '00000000-0000-0000-0000-000000000000'],
    ['wrong version nibble', '3f2a9c10-7b4e-9d8a-9c21-5e6f0a1b2c3d'],
    ['wrong variant nibble', '3f2a9c10-7b4e-4d8a-cc21-5e6f0a1b2c3d'],
  ])('generates and saves one valid new installation id when the saved value is an %s', async (_name, saved) => {
    const stored: Record<string, string> = { [storageKey]: saved }
    const setItem = vi.fn((k: string, v: string) => { stored[k] = v })
    const getConfig = vi.fn(async (id: string) => ({ ...config, installationId: id }))
    const { controller, api } = setup({ storage: { getItem: (k: string) => stored[k] ?? null, setItem }, randomUUID: () => validStoredId }, { getConfig })
    controller.start()
    await flush()
    expect(api.getConfig).toHaveBeenCalledWith(validStoredId)
    expect(stored[storageKey]).toBe(validStoredId)
  })

  it('keeps one stable in-memory installation id when storage access is blocked', async () => {
    let generated = 0
    const requested: string[] = []
    const getConfig = vi.fn(async (id: string) => { requested.push(id); return { ...config, installationId: id } })
    const { controller } = setup({
      storage: { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } },
      randomUUID: () => { generated += 1; return validStoredId },
    }, { getConfig })
    controller.start()
    await flush()
    controller.refresh()
    await flush()
    expect(generated).toBe(1)
    expect(requested.length).toBeGreaterThanOrEqual(2)
    expect(requested.every(id => id === validStoredId)).toBe(true)
  })

  async function reachEnabled(overrides: Partial<MobilePushApiAdapter> = {}, environmentOverrides: Partial<MobilePushEnvironment> = {}) {
    const getConfig = overrides.getConfig ?? vi.fn(async () => ({ ...config, status: 'enabled' as const }))
    const harness = setup(environmentOverrides, { ...overrides, getConfig })
    harness.controller.start()
    await flush()
    await harness.controller.enableFromGesture()
    await flush()
    expect(harness.controller.getSnapshot().state).toBe('enabled')
    return harness
  }

  it('keeps enabled controls and category state with a test-specific message when the Test fails', async () => {
    const { controller } = await reachEnabled({ sendTest: vi.fn(async () => { throw Object.assign(new Error('provider detail'), { code: 'request_failed' }) }) })
    await controller.sendTest()
    const snapshot = controller.getSnapshot()
    expect(snapshot.state).toBe('enabled')
    expect(snapshot.error).toBe('push.test.failed')
    expect(snapshot.preferences).toEqual(preferences)
  })

  it('reports a rate-limited Test without disabling controls', async () => {
    const { controller } = await reachEnabled({ sendTest: vi.fn(async () => { throw Object.assign(new Error('throttled'), { code: 'rate_limited' }) }) })
    await controller.sendTest()
    const snapshot = controller.getSnapshot()
    expect(snapshot.state).toBe('enabled')
    expect(snapshot.error).toBe('push.test.rateLimited')
    expect(snapshot.preferences).toEqual(preferences)
  })

  it('reads config back once after a failed Test so provider health is reflected', async () => {
    let getConfigCalls = 0
    let status: PushConfig['status'] = 'enabled'
    const { controller } = await reachEnabled({
      getConfig: vi.fn(async () => { getConfigCalls += 1; return { ...config, status, installationId: validStoredId } }),
      sendTest: vi.fn(async () => { status = 'suspended'; throw Object.assign(new Error('gone'), { code: 'request_failed' }) }),
    })
    expect(getConfigCalls).toBe(1)
    await controller.sendTest()
    expect(getConfigCalls).toBe(2)
    expect(controller.getSnapshot().state).toBe('suspended')
    expect(controller.getSnapshot().error).toBeUndefined()
  })

  it('never lets a late Test result overwrite newer Disable state', async () => {
    const gate = deferred<void>()
    let status: PushConfig['status'] = 'enabled'
    const disableApi = vi.fn(async () => { status = 'disabled' })
    const { controller, api } = await reachEnabled({
      getConfig: vi.fn(async () => ({ ...config, status, installationId: validStoredId })),
      sendTest: vi.fn(async () => { await gate.promise }),
      disable: disableApi,
    })
    const testPromise = controller.sendTest()
    await flush()
    await controller.disable()
    expect(controller.getSnapshot().state).toBe('disabled')
    expect(api.disable).toHaveBeenCalled()
    gate.resolve()
    await testPromise
    await flush()
    expect(controller.getSnapshot().state).toBe('disabled')
  })

  it('guards duplicate Send-test taps with a visible in-flight state', async () => {
    const gate = deferred<void>()
    const { controller, api } = await reachEnabled({ sendTest: vi.fn(async () => { await gate.promise }) })
    const first = controller.sendTest()
    await flush()
    expect(api.sendTest).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().testInFlight).toBe(true)
    // An unrelated mid-flight publish (a config refresh) still reports the live flag.
    await controller.refresh()
    await flush()
    expect(controller.getSnapshot().testInFlight).toBe(true)
    void controller.sendTest()
    await flush()
    expect(api.sendTest).toHaveBeenCalledTimes(1)
    gate.resolve()
    await first
    await flush()
    expect(controller.getSnapshot().testInFlight).toBe(false)
  })

  it('clears the in-flight Test flag when Disable supersedes it, without overwriting Disable state', async () => {
    const gate = deferred<void>()
    let status: PushConfig['status'] = 'enabled'
    const { controller } = await reachEnabled({
      getConfig: vi.fn(async () => ({ ...config, status, installationId: validStoredId })),
      sendTest: vi.fn(async () => { await gate.promise }),
      disable: vi.fn(async () => { status = 'disabled' }),
    })
    const testPromise = controller.sendTest()
    await flush()
    expect(controller.getSnapshot().testInFlight).toBe(true)
    await controller.disable()
    gate.resolve()
    await testPromise
    await flush()
    expect(controller.getSnapshot().state).toBe('disabled')
    expect(controller.getSnapshot().testInFlight).toBe(false)
  })

  it('clears the in-flight Test flag on stop()', async () => {
    const gate = deferred<void>()
    const { controller } = await reachEnabled({ sendTest: vi.fn(async () => { await gate.promise }) })
    const testPromise = controller.sendTest()
    await flush()
    expect(controller.getSnapshot().testInFlight).toBe(true)
    controller.stop()
    gate.resolve()
    await testPromise
    await flush()
    expect(controller.getSnapshot().testInFlight).toBe(false)
  })

  it('disables only the Send-test button while a Test is in flight', () => {
    const copy = MOBILE_PUSH_SETTINGS_COPY.en
    const snapshot = { state: 'enabled' as const, preferences, testInFlight: true }
    const controller = { subscribe: () => () => undefined, getSnapshot: () => snapshot, enableFromGesture: vi.fn(), disable: vi.fn(), updatePreferences: vi.fn(), sendTest: vi.fn(), start: vi.fn(), stop: vi.fn(), refresh: vi.fn() }
    const row = MobilePushSettings({ controller, locale: 'en' }) as unknown as { props: { children: unknown } }
    const visit = (value: unknown): Array<{ type: unknown; props?: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(visit)
      if (typeof value !== 'object' || value === null || !('type' in value)) return []
      const element = value as { type: unknown; props?: Record<string, unknown> }
      return [element, ...visit(element.props?.children)]
    }
    const buttons = visit(row).filter(element => element.type === 'button')
    const testButton = buttons.find(element => element.props?.children === copy.testBusy)
    const disableButton = buttons.find(element => element.props?.children === copy.disable)
    expect(testButton).toBeDefined()
    expect(testButton?.props?.disabled).toBe(true)
    expect(testButton?.props?.['aria-busy']).toBe('true')
    expect(disableButton).toBeDefined()
    expect(disableButton?.props?.disabled).not.toBe(true)
  })

  it('keeps a newer Test in flight when an older Test settles after stop()', async () => {
    const gateA = deferred<void>()
    const gateB = deferred<void>()
    let sendCalls = 0
    const sendTest = vi.fn(async () => {
      sendCalls += 1
      if (sendCalls === 1) await gateA.promise
      else await gateB.promise
    })
    const { controller } = await reachEnabled({ sendTest })
    const oldTest = controller.sendTest()
    await flush()
    expect(controller.getSnapshot().testInFlight).toBe(true)
    controller.stop()
    controller.start()
    await flush()
    expect(controller.getSnapshot().state).toBe('enabled')
    const newTest = controller.sendTest()
    await flush()
    expect(sendTest).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().testInFlight).toBe(true)
    // The OLD Test settling after stop()/restart must not clear the NEW Test's in-flight flag.
    gateA.resolve()
    await oldTest
    await flush()
    expect(controller.getSnapshot().testInFlight).toBe(true)
    gateB.resolve()
    await newTest
    await flush()
    expect(controller.getSnapshot().testInFlight).toBe(false)
  })

  it.each(['en', 'zh', 'it'] as const)('renders the distinct %s conflict and Test-failure messages', locale => {
    const copy = MOBILE_PUSH_SETTINGS_COPY[locale]
    const visit = (value: unknown): Array<{ type: unknown; props?: Record<string, unknown> }> => {
      if (Array.isArray(value)) return value.flatMap(visit)
      if (typeof value !== 'object' || value === null || !('type' in value)) return []
      const element = value as { type: unknown; props?: Record<string, unknown> }
      return [element, ...visit(element.props?.children)]
    }
    const cases = [
      [{ state: 'failed' as const, error: 'push.error.subscriptionConflict', preferences }, copy.conflict],
      [{ state: 'enabled' as const, error: 'push.test.failed', preferences }, copy.testFailed],
      [{ state: 'enabled' as const, error: 'push.test.rateLimited', preferences }, copy.testRateLimited],
    ] as const
    for (const [snapshot, expected] of cases) {
      const controller = { subscribe: vi.fn(() => () => undefined), getSnapshot: () => snapshot, enableFromGesture: vi.fn(), disable: vi.fn(), updatePreferences: vi.fn(), sendTest: vi.fn(), start: vi.fn(), stop: vi.fn(), refresh: vi.fn() }
      const row = MobilePushSettings({ controller, locale, switchComponent: publicSwitchProbe }) as unknown as { props: { children: unknown } }
      const live = visit(row).find(element => element.props?.['aria-live'] === 'polite')
      expect(live?.props?.children).toBe(expected)
    }
  })
})
