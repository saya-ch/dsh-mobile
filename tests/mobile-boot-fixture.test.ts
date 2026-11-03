import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const helperUrl = new URL('../scripts/mobile-boot-fixture.mjs', import.meta.url)
const fixture: {
  removeTemporaryRoot: (root: string, prefix?: string) => Promise<void>
  sanitized: (text: string) => string
  mobileProfilePnpmConfiguration: (options?: { packageStoreDirectory?: string; packageImportMethod?: string }) => string
  dismissOnboarding: (phone: ReturnType<typeof onboardingPhone>['phone']) => Promise<void>
  openMobileSettings: (phone: ReturnType<typeof settingsPhone>['phone'], options?: {
    sidebar?: ReturnType<typeof settingsPhone>['sidebar']
    activate?: (button: { click: () => Promise<void> }, stage: string) => Promise<void>
  }) => Promise<void>
} = await import(helperUrl.href)
const roots: string[] = []
const prefix = 'dsh-mobile-fixture-test-'

afterEach(async () => { for (const root of roots.splice(0)) await fixture.removeTemporaryRoot(root, prefix) })

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

interface OnboardingDialog {
  readonly label: string
  readonly buttons: readonly { readonly text: string; readonly ariaLabel?: string }[]
}

/**
 * Fake the shared fixture's `[role="dialog"][aria-modal="true"]` first() lookup.
 * `hiddenModalsBefore` models elements that stay in the DOM ahead of the real
 * onboarding while hidden, which is exactly what first() would return.
 */
function onboardingPhone(dialogs: readonly OnboardingDialog[], { hiddenModalsBefore = [], stalled = false }: {
  hiddenModalsBefore?: readonly OnboardingDialog[]
  stalled?: boolean
} = {}) {
  let index = 0
  const clicked: string[] = []
  const waited: string[] = []
  const current = () => dialogs[index]
  const click = async (button: number): Promise<void> => {
    const selected = current()?.buttons[button]
    if (selected === undefined) throw new Error('No current fixture button')
    clicked.push(selected.ariaLabel ?? selected.text)
    if (!stalled) index += 1
  }
  // first() resolves the earliest matching node in DOM order, so a persistent
  // hidden modal wins over every later dialog and is never consumed.
  const firstMatch = () => hiddenModalsBefore[0] ?? current()
  const dialog = {
    waitFor: async () => {},
    count: async () => firstMatch() === undefined ? 0 : 1,
    getAttribute: async () => firstMatch()?.label ?? null,
    locator: () => ({
      allTextContents: async () => firstMatch()?.buttons.map(button => button.text) ?? [],
      nth: (button: number) => ({ click: () => click(button) }),
    }),
    getByRole: (_role: string, { name }: { name: RegExp }) => {
      const matching = firstMatch()?.buttons.map((button, buttonIndex) => ({ button, buttonIndex }))
        .filter(({ button }) => name.test(button.ariaLabel ?? button.text)) ?? []
      return {
        count: async () => matching.length,
        click: async () => {
          if (matching.length !== 1) throw new Error('No unique fixture close action')
          await click(matching[0]!.buttonIndex)
        },
      }
    },
  }
  const phone = {
    locator: () => ({ first: () => dialog }),
    evaluate: async () => ({ modals: [{ label: firstMatch()?.label, visible: true, alerts: ['controlled acknowledgement failure'] }] }),
    waitForFunction: async (_predicate: unknown, previous: string) => {
      waited.push(previous)
      if (stalled) throw new Error('Controlled onboarding completion timeout')
      expect(current()?.label).not.toBe(previous)
    },
  }
  return { phone, clicked, waited }
}

function settingsPhone(generation: 'direct' | 'account' | 'unknown', hasSettings = true, alreadyOpen = false) {
  const clicked: string[] = []
  const item = { count: async () => hasSettings ? 1 : 0, click: async () => { clicked.push('settings menu item') } }
  const menu = { waitFor: async () => {}, getByRole: () => ({ filter: () => item }) }
  const account = {
    count: async () => generation === 'account' ? 1 : 0,
    getAttribute: async () => 'menu',
    click: async () => { clicked.push('account menu') },
  }
  const direct = {
    count: async () => generation === 'direct' ? 1 : 0,
    click: async () => { clicked.push('direct settings') },
    or: () => ({ waitFor: async () => {} }),
  }
  const drawer = {
    getAttribute: async () => 'false',
    locator: (selector: string) => selector.includes('data-dsh-mobile-toggle')
      ? { ...direct, click: async () => { clicked.push('drawer') } } : direct,
    getByRole: () => account,
  }
  const phone = {
    locator: (selector: string) => selector === '.dsh-mobile-settings_row'
      ? { first: () => ({ isVisible: async () => alreadyOpen }) } : drawer,
    waitForFunction: async () => {},
    getByRole: () => menu,
    getByText: () => ({}),
  }
  return { phone, sidebar: drawer, clicked }
}

describe('owned Mobile development fixture', () => {
  it('keeps restored General settings open without clicking a covered launcher', async () => {
    const state = settingsPhone('account', true, true)
    await fixture.openMobileSettings(state.phone)
    expect(state.clicked).toEqual([])
  })

  it('opens the earlier direct Settings trigger without using an account action', async () => {
    const state = settingsPhone('direct')
    await fixture.openMobileSettings(state.phone)
    expect(state.clicked).toEqual(['drawer', 'direct settings'])
  })

  it('opens only Settings through the upstream account launcher', async () => {
    const state = settingsPhone('account')
    await fixture.openMobileSettings(state.phone)
    expect(state.clicked).toEqual(['drawer', 'account menu', 'settings menu item'])
  })

  it('uses the supplied stock sidebar without locating a dedicated drawer', async () => {
    const state = settingsPhone('account')
    const phone = { ...state.phone, locator: (selector: string) => {
      if (selector !== '.dsh-mobile-settings_row') throw new Error('Dedicated drawer is not mounted')
      return state.phone.locator(selector)
    } }
    await fixture.openMobileSettings(phone, { sidebar: state.sidebar })
    expect(state.clicked).toEqual(['account menu', 'settings menu item'])
  })

  it('runs hit-target inspection on the real launcher and menu action', async () => {
    const state = settingsPhone('account')
    const inspected: string[] = []
    await fixture.openMobileSettings(state.phone, { sidebar: state.sidebar, activate: async (button, stage) => {
      inspected.push(stage)
      await button.click()
    } })
    expect(inspected).toEqual(['launcher', 'menuitem'])
    expect(state.clicked).toEqual(['account menu', 'settings menu item'])
  })

  it('refuses an unrecognized Settings launcher instead of choosing another drawer action', async () => {
    const state = settingsPhone('unknown')
    await expect(fixture.openMobileSettings(state.phone)).rejects.toThrow('Unexpected Mobile settings launcher')
    expect(state.clicked).toEqual(['drawer'])
  })

  it('refuses an account menu without its exact Settings item', async () => {
    const state = settingsPhone('account', false)
    await expect(fixture.openMobileSettings(state.phone)).rejects.toThrow('Unexpected Mobile account settings action')
    expect(state.clicked).toEqual(['drawer', 'account menu'])
  })

  it.each([
    ['Get started', 'Close', 'Add API Key', 'Sign in'],
    ['开始使用', '关闭', '添加 API Key', '登录'],
  ])('dismisses only the recognized %s account onboarding without entering credentials', async (label, close, key, signIn) => {
    const state = onboardingPhone([{ label: label!, buttons: [
      { text: '', ariaLabel: close! }, { text: key! }, { text: signIn! },
    ] }])
    await fixture.dismissOnboarding(state.phone)
    expect(state.clicked).toEqual([close])
    expect(state.waited).toEqual([label])
  })

  it.each(['Permission required', 'Approve a tool'])('rejects the unknown %s dialog even with a close button', async label => {
    const state = onboardingPhone([{ label, buttons: [
      { text: '', ariaLabel: 'Close' }, { text: 'Add API Key' }, { text: 'Sign in' },
    ] }])
    await expect(fixture.dismissOnboarding(state.phone)).rejects.toThrow('Unexpected initial DSH dialog choices')
    expect(state.clicked).toEqual([])
  })

  it('rejects a familiar title with different actions instead of treating it as account onboarding', async () => {
    const state = onboardingPhone([{ label: 'Get started', buttons: [
      { text: '', ariaLabel: 'Close' }, { text: 'Approve' }, { text: 'Reject' },
    ] }])
    await expect(fixture.dismissOnboarding(state.phone)).rejects.toThrow('Unexpected initial DSH dialog choices')
    expect(state.clicked).toEqual([])
  })

  it.each([0, 2])('rejects account onboarding with %s matching close actions', async count => {
    const state = onboardingPhone([{ label: 'Get started', buttons: [
      ...Array.from({ length: count }, () => ({ text: '', ariaLabel: 'Close' })),
      { text: 'Add API Key' }, { text: 'Sign in' },
    ] }])
    await expect(fixture.dismissOnboarding(state.phone)).rejects.toThrow('Unexpected initial DSH account close action')
    expect(state.clicked).toEqual([])
  })

  it('retains the earlier configure-later and single acknowledgement sequence', async () => {
    const state = onboardingPhone([
      { label: 'Add an API key to get started', buttons: [{ text: 'Configure later' }, { text: 'Save and continue' }] },
      { label: 'Internal Testing Notice', buttons: [{ text: 'Continue' }] },
    ])
    await fixture.dismissOnboarding(state.phone)
    expect(state.clicked).toEqual(['Configure later', 'Continue'])
    expect(state.waited).toEqual(['Add an API key to get started', 'Internal Testing Notice'])
  })

  it('reports a stalled acknowledged action without replaying it or skipping the dialog', async () => {
    const state = onboardingPhone([{ label: 'Preview Notice', buttons: [{ text: 'Continue' }] }], { stalled: true })
    const failure = await fixture.dismissOnboarding(state.phone).then(() => undefined, (error: Error) => error)
    expect(failure?.message).toContain('Owned onboarding action did not finish:')
    expect(failure?.message).toContain('controlled acknowledgement failure')
    expect(failure?.cause).toEqual(new Error('Controlled onboarding completion timeout'))
    expect(state.clicked).toEqual(['Continue'])
    expect(state.waited).toEqual(['Preview Notice'])
  })

  it.each(['Internal Testing Notice', 'Preview Notice', '内测声明', '预览版说明'])('acknowledges only the known %s preview notice', async label => {
    const text = /[\u4e00-\u9fff]/u.test(label) ? '继续' : 'Continue'
    const state = onboardingPhone([{ label, buttons: [{ text }] }])
    await fixture.dismissOnboarding(state.phone)
    expect(state.clicked).toEqual([text])
  })

  it.each([
    ['Approve a tool', ['Continue']],
    ['Permission required', ['Approve']],
    ['Approve a tool', ['Configure later', 'Approve']],
    ['Preview Notice', ['Approve']],
  ] as const)('refuses unrelated %s choices even when there is one button or a skip-like label', async (label, choices) => {
    const state = onboardingPhone([{ label, buttons: choices.map(text => ({ text })) }])
    await expect(fixture.dismissOnboarding(state.phone)).rejects.toThrow('Unexpected initial DSH dialog choices')
    expect(state.clicked).toEqual([])
  })

  // A hidden element that permanently carries role=dialog/aria-modal="true" is
  // the product defect that broke the four DSH 0.2.x legs: the real onboarding
  // follows it in DOM order, so first() lands on an element the user cannot
  // see. The fixture must keep reporting that, not learn to skip hidden nodes,
  // or the next component would reintroduce it silently. The owner fixed the
  // QR viewer to declare its dialog role only while open (see
  // tests/client-lifecycle.test.ts); this case guards the fixture's refusal.
  it('refuses a hidden role=dialog element ahead of the real onboarding instead of skipping it', async () => {
    const state = onboardingPhone([{ label: 'Preview Notice', buttons: [{ text: 'Continue' }] }], {
      hiddenModalsBefore: [{ label: 'Enlarge the QR code', buttons: [{ text: '×' }] }],
    })
    await expect(fixture.dismissOnboarding(state.phone)).rejects.toThrow('Unexpected initial DSH dialog choices')
    expect(state.clicked).toEqual([])
    expect(state.waited).toEqual([])
  })

  it('still refuses a visible unknown dialog when a hidden modal is also present', async () => {
    const state = onboardingPhone([{ label: 'Permission required', buttons: [{ text: 'Approve' }] }], {
      hiddenModalsBefore: [{ label: 'Enlarge the QR code', buttons: [{ text: '×' }] }],
    })
    await expect(fixture.dismissOnboarding(state.phone)).rejects.toThrow('Unexpected initial DSH dialog choices')
    expect(state.clicked).toEqual([])
  })

  it('copies package files by default while retaining an explicit import-method probe', () => {
    const settings = fixture.mobileProfilePnpmConfiguration()
    expect(settings).toContain('packageImportMethod: "copy"')
    expect(settings).toContain('nodeLinker: hoisted')
    expect(settings).not.toContain('storeDir:')
    const diagnostic = fixture.mobileProfilePnpmConfiguration({ packageImportMethod: 'auto', packageStoreDirectory: 'C:\\owned\\private-store' })
    expect(diagnostic).toContain('packageImportMethod: "auto"')
    expect(diagnostic).toContain('storeDir: "C:\\\\owned\\\\private-store"')
  })

  it('removes projected links without deleting their outside target', async () => {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    const kept = join(outside, 'kept.txt')
    await writeFile(kept, 'keep outside data')
    await mkdir(join(root, 'profile', 'node_modules'), { recursive: true })
    await symlink(outside, join(root, 'profile', 'node_modules', 'projected'), process.platform === 'win32' ? 'junction' : 'dir')
    await fixture.removeTemporaryRoot(root, prefix)
    roots.splice(roots.indexOf(root), 1)
    expect(await readFile(kept, 'utf8')).toBe('keep outside data')
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a temporary path whose owner prefix does not match', async () => {
    const root = await temporaryRoot()
    await expect(fixture.removeTemporaryRoot(root, 'different-owner-')).rejects.toThrow('outside this owned temporary root')
    expect((await lstat(root)).isDirectory()).toBe(true)
  })

  it('redacts launch tokens and pairing fragments from error output', () => {
    const message = fixture.sanitized('http://127.0.0.1/?token=launch-secret /pair#token=pair-secret&label=demo /pair#key=key-secret')
    expect(message).not.toContain('launch-secret')
    expect(message).not.toContain('pair-secret')
    expect(message).not.toContain('key-secret')
    expect(message).toContain('&label=demo')
  })
})
