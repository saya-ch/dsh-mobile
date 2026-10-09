import { describe, expect, it } from 'vitest'
import { EXTENSION_RECOVERY_MESSAGES, MOBILE_CONTROL_MESSAGES } from '../src/client-messages.js'
import { parseUnavailableExtensionHosts } from '../src/extension-recovery-ui.js'

const stopped = { id: 'fixture-worker', name: 'Fixture worker', mode: 'worker', state: 'unavailable', generation: 'a'.repeat(64) }

describe('desktop worker recovery response', () => {
  it('selects only unavailable workers without requiring the unused budget display', () => {
    expect(parseUnavailableExtensionHosts({ hosts: [stopped, { ...stopped, id: 'ready-worker', state: 'ready' }, { ...stopped, id: 'inline', mode: 'in-process' }] })).toEqual([{ id: stopped.id, name: stopped.name, generation: stopped.generation }])
    expect(parseUnavailableExtensionHosts({ hosts: [] })).toEqual([])
  })

  it.each([null, {}, { hosts: {} }, { hosts: [null] }, { hosts: [stopped, stopped] },
    ...['id', 'name', 'generation'].map(key => ({ hosts: [{ ...stopped, [key]: '' }] })),
    { hosts: [{ ...stopped, id: '../other' }] }, { hosts: [{ ...stopped, generation: 'stale' }] },
    { hosts: [{ ...stopped, mode: ['worker'] }] }, { hosts: [{ ...stopped, state: ['unavailable'] }] },
    { hosts: [{ ...stopped, mode: 'unknown' }] }, { hosts: [{ ...stopped, state: 'unknown' }] },
  ])('rejects invalid or ambiguous host responses: %j', payload => {
    expect(parseUnavailableExtensionHosts(payload)).toBeUndefined()
  })

  it('keeps an untrusted display name as plain text data', () => {
    const name = '<img src=x onerror="throw 1">'
    expect(parseUnavailableExtensionHosts({ hosts: [{ ...stopped, name }] })?.[0]?.name).toBe(name)
  })

  it('provides all recovery copy in Chinese, English and Italian', () => {
    const keys = Object.keys(EXTENSION_RECOVERY_MESSAGES.en).sort()
    for (const locale of ['en', 'zh', 'it'] as const) {
      expect(Object.keys(EXTENSION_RECOVERY_MESSAGES[locale]).sort()).toEqual(keys)
      for (const key of keys) expect(Reflect.get(MOBILE_CONTROL_MESSAGES[locale], key)).toEqual(Reflect.get(EXTENSION_RECOVERY_MESSAGES[locale], key))
    }
  })
})
