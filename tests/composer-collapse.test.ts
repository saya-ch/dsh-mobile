import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPOSER_COLLAPSE_DEFAULTS,
  COMPOSER_COLLAPSE_STORAGE_KEY,
  ComposerCollapseTracker,
  composerCollapseConfigFrom,
  readComposerCollapseEnabled,
  subscribeComposerCollapseEnabled,
  writeComposerCollapseEnabled,
} from '../src/composer-collapse.js'
import { COMPOSER_COLLAPSE_COPY } from '../src/composer-collapse-settings.js'
import { NATIVE_MOBILE_STYLES } from '../src/native-mobile.js'

function enabledConfig(overrides: Partial<typeof COMPOSER_COLLAPSE_DEFAULTS> = {}) {
  return { ...COMPOSER_COLLAPSE_DEFAULTS, enabled: true, ...overrides }
}

function memStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v) },
  }
}

const restores: Array<() => void> = []
afterEach(() => { while (restores.length > 0) restores.pop()!() })

/**
 * The plugin runs in a browser, but vitest runs in node: give the module the
 * global event bus and storage it expects so the cross-bundle path is real
 * rather than a mock of the module under test.
 */
function installBrowserGlobals(storage: ReturnType<typeof memStorage>) {
  const bus = new EventTarget()
  const define = (key: string, value: unknown) => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
    restores.push(() => {
      if (previous === undefined) delete (globalThis as Record<string, unknown>)[key]
      else Object.defineProperty(globalThis, key, previous)
    })
  }
  define('addEventListener', bus.addEventListener.bind(bus))
  define('removeEventListener', bus.removeEventListener.bind(bus))
  define('dispatchEvent', bus.dispatchEvent.bind(bus))
  define('localStorage', storage)
  class FakeStorageEvent extends Event {
    readonly key: string | null
    constructor(type: string, init: { key?: string | null } = {}) {
      super(type)
      this.key = init.key ?? null
    }
  }
  define('StorageEvent', FakeStorageEvent)
  return { bus, FakeStorageEvent }
}

describe('ComposerCollapseTracker', () => {
  it('tracks reading progress and collapses at the threshold', () => {
    const t = new ComposerCollapseTracker(enabledConfig({ collapseThresholdPx: 480 }))
    expect(t.sample(100)).toBe('expanded')
    expect(t.sample(200)).toBe('expanded')
    expect(t.sample(200)).toBe('collapsed') // 500 >= 480
  })

  it('reduces reading progress when scrolling back up', () => {
    const t = new ComposerCollapseTracker(enabledConfig({ collapseThresholdPx: 480 }))
    t.sample(100)
    t.sample(200)
    expect(t.sample(-150)).toBe('expanded')
    expect(t.progress()).toBe(150)
  })

  it('stays collapsed until the upward run reaches reverseResetPx', () => {
    const t = new ComposerCollapseTracker(enabledConfig({ collapseThresholdPx: 100, reverseResetPx: 80 }))
    t.sample(120)
    expect(t.stateValue).toBe('collapsed')
    // The reset distance is a dead zone, so a few pixels are not enough.
    expect(t.sample(-10)).toBe('collapsed')
    expect(t.sample(-70)).toBe('expanded')
    expect(t.progress()).toBe(0)
  })

  it('restarts the upward run when scrolling down again', () => {
    const t = new ComposerCollapseTracker(enabledConfig({ collapseThresholdPx: 100, reverseResetPx: 80 }))
    t.sample(120)
    t.sample(-70)
    t.sample(30)
    expect(t.sample(-70)).toBe('collapsed')
    expect(t.sample(-15)).toBe('expanded')
  })

  it('expand() restores the composer and clears progress', () => {
    const t = new ComposerCollapseTracker(enabledConfig({ collapseThresholdPx: 100 }))
    t.sample(120)
    t.expand()
    expect(t.stateValue).toBe('expanded')
    expect(t.progress()).toBe(0)
  })

  it('ignores everything when disabled and reports the switch', () => {
    const t = new ComposerCollapseTracker(COMPOSER_COLLAPSE_DEFAULTS)
    expect(t.enabled).toBe(false)
    expect(t.sample(200)).toBe('expanded')
    expect(t.sample(500)).toBe('expanded')
    t.setEnabled(true)
    expect(t.enabled).toBe(true)
    expect(t.sample(600)).toBe('collapsed')
    t.setEnabled(false)
    expect(t.stateValue).toBe('expanded')
  })

  it('builds a config from the persisted switch', () => {
    expect(composerCollapseConfigFrom(true).enabled).toBe(true)
    expect(composerCollapseConfigFrom(false).collapseThresholdPx).toBe(COMPOSER_COLLAPSE_DEFAULTS.collapseThresholdPx)
  })
})

describe('composer collapse opt-in persistence', () => {
  it('defaults to off when nothing is stored', () => {
    expect(readComposerCollapseEnabled(memStorage())).toBe(false)
  })

  it('reads a stored true value and rejects other values', () => {
    expect(readComposerCollapseEnabled(memStorage({ [COMPOSER_COLLAPSE_STORAGE_KEY]: 'true' }))).toBe(true)
    expect(readComposerCollapseEnabled(memStorage({ [COMPOSER_COLLAPSE_STORAGE_KEY]: 'yes' }))).toBe(false)
  })

  it('keeps the safe default when storage is missing or throws', () => {
    const throwing = { getItem: () => { throw new Error('blocked') } }
    expect(readComposerCollapseEnabled(throwing)).toBe(false)
    expect(readComposerCollapseEnabled(null)).toBe(false)
    // Resolved inside the try: a blocked localStorage getter is the same failure.
    expect(readComposerCollapseEnabled()).toBe(false)
  })

  it('persists the value and announces it on this page', () => {
    const storage = memStorage()
    installBrowserGlobals(storage)
    const seen: boolean[] = []
    const off = subscribeComposerCollapseEnabled(enabled => { seen.push(enabled) })
    writeComposerCollapseEnabled(true, storage)
    expect(storage.getItem(COMPOSER_COLLAPSE_STORAGE_KEY)).toBe('true')
    expect(seen).toEqual([true])
    off()
  })

  it('reacts to a storage event carrying this key only', () => {
    const storage = memStorage({ [COMPOSER_COLLAPSE_STORAGE_KEY]: 'true' })
    const { FakeStorageEvent } = installBrowserGlobals(storage)
    const seen: boolean[] = []
    const off = subscribeComposerCollapseEnabled(enabled => { seen.push(enabled) })
    globalThis.dispatchEvent(new FakeStorageEvent('storage', { key: 'other-key' }))
    globalThis.dispatchEvent(new FakeStorageEvent('storage', { key: COMPOSER_COLLAPSE_STORAGE_KEY }))
    expect(seen).toEqual([true])
    off()
  })

  it('shares the switch across two bundle instances', async () => {
    // tsdown emits client.js and mobile-layout.js as independent CJS modules that
    // each inline this file, so neither side may rely on a module singleton: the
    // row would flip its own copy and the layout would keep the boot-time value.
    // Two fresh module registries stand in for those two bundles.
    const storage = memStorage()
    installBrowserGlobals(storage)
    vi.resetModules()
    const clientBundle = await import('../src/composer-collapse.js')
    vi.resetModules()
    const layoutBundle = await import('../src/composer-collapse.js')
    const seen: boolean[] = []
    const off = layoutBundle.subscribeComposerCollapseEnabled(enabled => { seen.push(enabled) })
    clientBundle.writeComposerCollapseEnabled(true)
    expect(layoutBundle.readComposerCollapseEnabled()).toBe(true)
    expect(seen).toEqual([true])
    off()
  })
})

describe('ComposerCollapseSettings row', () => {
  // A mounted-row test would need jsdom and a second React tree; what actually
  // regressed in review was the control the row renders and the fact that no
  // style rule matched it, so assert those against the real sources.
  const row = readFileSync(new URL('../src/composer-collapse-settings.ts', import.meta.url), 'utf8')

  it('renders the shared switch row instead of a bare checkbox', () => {
    expect(row).toContain("className: 'dsh-mobile-settings_row'")
    expect(row).toContain("className: 'dsh-mobile-settings_switchInput'")
    expect(row).toContain("role: 'switch'")
    expect(row).toContain("'aria-checked'")
    expect(row).toContain("className: 'dsh-mobile-settings_selector'")
  })

  it('has a style rule for the control class it uses', () => {
    // Without this the browser renders the native checkbox next to the On/Off pill.
    expect(NATIVE_MOBILE_STYLES).toContain('.dsh-mobile-settings_switchInput {')
    expect(NATIVE_MOBILE_STYLES).toContain(':has(.dsh-mobile-settings_switchInput:focus-visible)');
  })

  it('persists only through the shared store', () => {
    expect(row).toContain('readComposerCollapseEnabled')
    expect(row).toContain('writeComposerCollapseEnabled')
    expect(row).toContain('subscribeComposerCollapseEnabled')
  })

  it('keeps every locale populated', () => {
    for (const locale of ['en', 'zh', 'it'] as const) {
      expect(COMPOSER_COLLAPSE_COPY[locale].title.length).toBeGreaterThan(0)
      expect(COMPOSER_COLLAPSE_COPY[locale].desc.length).toBeGreaterThan(0)
      expect(COMPOSER_COLLAPSE_COPY[locale].on).not.toBe(COMPOSER_COLLAPSE_COPY[locale].off)
    }
  })
})

describe('layout integration contract', () => {
  // Pins the defects a review found (document scroll sampling, a switch only one
  // bundle could see, a control injected into a React-managed card) plus the
  // affordances the feature depends on.
  const layout = readFileSync(new URL('../src/mobile-layout.ts', import.meta.url), 'utf8')

  it('samples the conversation scroller instead of the document', () => {
    expect(layout).toContain("querySelector('[data-conversation-scroll]')")
    expect(layout).not.toMatch(/window\.scrollY/)
  })

  it('only reacts to scroll events from that container', () => {
    expect(layout).toContain("hasAttribute('data-conversation-scroll')")
  })

  it('reads the switch through the shared persisted store', () => {
    expect(layout).toContain('subscribeComposerCollapseEnabled')
    expect(layout).toContain('readComposerCollapseEnabled')
  })

  it('never injects a control into the React-managed composer card', () => {
    expect(layout).not.toContain('dshMobileComposerRestore')
    expect(layout).toContain('--dshm-composer-restore-label')
    expect(layout).toContain('data-dsh-mobile-composer-collapsed')
  })

  it('never collapses while a draft, a submission, or a running reply is present', () => {
    expect(layout).toContain('composerHasDraft(editor, card)')
    expect(layout).toContain("'adjudicating', 'submitting'")
    // A streaming reply returns the composer phase to plain, so the Session
    // summary flag is the only truthful signal.
    expect(layout).toContain('session.byId[current]?.running')
    expect(layout).not.toMatch(/\[data-composer-card\]\{display:none/)
  })

  it('keeps the visualViewport guard on the layout source', () => {
    expect(layout).not.toContain('visualViewport')
  })
})
