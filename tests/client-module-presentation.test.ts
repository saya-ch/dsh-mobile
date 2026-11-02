import { describe, expect, it } from 'vitest'
import { ClientModuleDraft, clientModuleDisplayName, clientModuleGroup, clientModuleMatches, clientModuleMinimalExclusion, clientModuleMinimalImpact, formatClientModuleSize, sortClientModulesBySize, type ClientModuleRow } from '../src/client-module-presentation.js'

describe('minimal preset impact', () => {
  it('counts unmeasured and raw-only sizes separately from the gzip subtotal', () => {
    expect(clientModuleMinimalImpact([
      { id: 'core', required: true, dependencies: ['dependency'] },
      { id: 'dependency', required: false, dependencies: [], gzipBytes: 900 },
      { id: 'known', required: false, dependencies: [], gzipBytes: 42 },
      { id: 'raw-only', required: false, dependencies: [], bytes: 800 },
      { id: 'unknown', required: false, dependencies: [] },
    ])).toEqual({ count: 3, gzipBytes: 42, unknown: 2 })
  })

  it('distinguishes a measured empty resource from an unmeasured resource', () => {
    expect(clientModuleMinimalImpact([{ id: 'empty', required: false, dependencies: [], gzipBytes: 0 }])).toEqual({ count: 1, gzipBytes: 0, unknown: 0 })
    expect(clientModuleMinimalImpact([{ id: 'unknown', required: false, dependencies: [] }])).toEqual({ count: 1, unknown: 1 })
  })
})

const rows: readonly ClientModuleRow[] = [
  { id: 'skin-client', required: false, dependencies: [] },
  { id: '@someone/side_panel', required: false, dependencies: ['@deepseek-ai/dsh-client-slots'] },
  { id: '@deepseek-ai/dsh-client-ui-optional', required: false, dependencies: [] },
  { id: '@someone/essential-client', required: true, dependencies: [] },
  { id: '@deepseek-ai/dsh-client-slots', required: true, dependencies: [] },
]

describe('frontend module catalog presentation', () => {
  it('prioritizes required protection over package namespaces without changing entries', () => {
    expect(rows.map(clientModuleGroup)).toEqual(['extensions', 'extensions', 'advanced', 'required', 'required'])
    expect(clientModuleGroup({ id: '@deepseek-ai-copy/not-official', required: false, dependencies: [] })).toBe('extensions')
  })

  it('uses mechanical package words without guessed titles, functions or scope ownership', () => {
    expect(rows.map(row => clientModuleDisplayName(row.id))).toEqual(['skin client', 'side panel', 'optional', 'essential client', 'slots'])
    expect(clientModuleDisplayName('@example/dsh-client-ui-skin-maid-atelier')).toBe('skin maid atelier')
    expect(clientModuleDisplayName('dsh-better-sidebar')).toBe('better sidebar')
    expect(clientModuleDisplayName('dsh-client-')).toBe('dsh client ')
    expect(clientModuleDisplayName('a&b<module>')).toBe('a&b<module>')
    expect(clientModuleDisplayName('@invalid')).toBe('@invalid')
  })

  it('matches case-insensitive full IDs and visible short names', () => {
    const excluded = new Set(['skin-client'])
    expect(clientModuleMatches(rows[0]!, excluded, ' SKIN CLIENT ', 'all')).toBe(true)
    expect(clientModuleMatches(rows[1]!, excluded, '@SOMEONE/', 'all')).toBe(true)
    expect(clientModuleMatches(rows[1]!, excluded, 'side panel', 'loaded')).toBe(true)
    expect(clientModuleMatches(rows[0]!, excluded, '', 'excluded')).toBe(true)
    expect(clientModuleMatches(rows[0]!, excluded, '', 'loaded')).toBe(false)
    expect(clientModuleMatches(rows[0]!, excluded, 'missing', 'all')).toBe(false)
    expect(clientModuleMatches(rows[3]!, new Set([rows[3]!.id]), '', 'excluded')).toBe(false)
  })

  it('keeps hidden choices and opaque exclusions while counting only edited optional items', () => {
    const draft = new ClientModuleDraft(rows, ['skin-client', 'not-in-this-catalog'])
    expect(draft.changeCount).toBe(0)
    draft.setLoaded('skin-client', true)
    draft.setLoaded('@someone/side_panel', false)
    expect(draft.changeCount).toBe(2)
    expect(draft.matchingEntries('', 'excluded').map(row => row.id)).toEqual(['@someone/side_panel'])
    expect(draft.matchingEntries('optional', 'all').map(row => row.id)).toEqual(['@deepseek-ai/dsh-client-ui-optional'])
    expect(draft.excludedIds).toEqual(['not-in-this-catalog', '@someone/side_panel'])
    draft.setLoaded('skin-client', false)
    draft.setLoaded('@someone/side_panel', true)
    expect(draft.changeCount).toBe(0)
    expect(new Set(draft.excludedIds)).toEqual(new Set(['skin-client', 'not-in-this-catalog']))
  })

  it('never toggles required, unknown or dependent modules by cascade', () => {
    const draft = new ClientModuleDraft(rows, [])
    draft.setLoaded('@deepseek-ai/dsh-client-slots', false)
    draft.setLoaded('unknown-module', false)
    draft.setLoaded('@someone/side_panel', false)
    expect(draft.isLoaded('@deepseek-ai/dsh-client-slots')).toBe(true)
    expect(draft.excludedIds).toEqual(['@someone/side_panel'])
    expect(draft.changeCount).toBe(1)
    const snapshot = draft.excludedIds
    draft.setLoaded('@someone/side_panel', true)
    expect(snapshot).toEqual(['@someone/side_panel'])
  })

  it('retains missing and now-required exclusions until explicit removal', () => {
    const draft = new ClientModuleDraft(rows, ['not-in-this-catalog', '@deepseek-ai/dsh-client-slots', 'skin-client'])
    expect(draft.invalidExclusions).toEqual([
      { id: 'not-in-this-catalog', reason: 'missing' },
      { id: '@deepseek-ai/dsh-client-slots', reason: 'required' },
    ])
    expect(draft.changeCount).toBe(0)
    expect(draft.isLoaded('@deepseek-ai/dsh-client-slots')).toBe(true)
    draft.setLoaded('not-in-this-catalog', true)
    draft.setLoaded('@deepseek-ai/dsh-client-slots', true)
    expect(draft.excludedIds).toEqual(['not-in-this-catalog', '@deepseek-ai/dsh-client-slots', 'skin-client'])
    expect(draft.clearInvalidExclusion('not-in-this-catalog')).toBe(true)
    expect(draft.changeCount).toBe(1)
    expect(draft.invalidExclusions).toEqual([{ id: '@deepseek-ai/dsh-client-slots', reason: 'required' }])
    expect(draft.clearInvalidExclusion('@deepseek-ai/dsh-client-slots')).toBe(true)
    expect(draft.changeCount).toBe(2)
    expect(draft.invalidExclusions).toEqual([])
    draft.setLoaded('@deepseek-ai/dsh-client-slots', false)
    expect(draft.isLoaded('@deepseek-ai/dsh-client-slots')).toBe(true)
    expect(draft.excludedIds).toEqual(['skin-client'])
  })

  it('rejects ordinary optional and absent exclusions on the recovery action', () => {
    const draft = new ClientModuleDraft(rows, ['skin-client', 'unknown-module'])
    draft.setLoaded('@someone/side_panel', false)
    expect(draft.clearInvalidExclusion('skin-client')).toBe(false)
    expect(draft.clearInvalidExclusion('@someone/side_panel')).toBe(false)
    expect(draft.clearInvalidExclusion('never-excluded')).toBe(false)
    expect(draft.clearInvalidExclusion('@deepseek-ai/dsh-client-slots')).toBe(false)
    expect(draft.clearInvalidExclusion('unknown-module')).toBe(true)
    expect(draft.clearInvalidExclusion('unknown-module')).toBe(false)
    expect(draft.changeCount).toBe(2)
    expect(draft.excludedIds).toEqual(['skin-client', '@someone/side_panel'])
  })

  it('finds old exclusions under search and exclusion filters without pretending required entries are off', () => {
    const draft = new ClientModuleDraft(rows, ['@gone/old_skin', '@deepseek-ai/dsh-client-slots'])
    expect(draft.matchingInvalidExclusions('OLD SKIN', 'all')).toEqual([{ id: '@gone/old_skin', reason: 'missing' }])
    expect(draft.matchingInvalidExclusions('@GONE/', 'excluded')).toEqual([{ id: '@gone/old_skin', reason: 'missing' }])
    expect(draft.matchingInvalidExclusions('client-slots', 'excluded')).toEqual([{ id: '@deepseek-ai/dsh-client-slots', reason: 'required' }])
    expect(draft.matchingEntries('client-slots', 'loaded').map(row => row.id)).toEqual(['@deepseek-ai/dsh-client-slots'])
    expect(draft.matchingInvalidExclusions('', 'loaded')).toEqual([])
    expect(draft.matchingInvalidExclusions('unrelated', 'all')).toEqual([])
    expect(draft.changeCount).toBe(0)
  })

  it('counts each set difference once across invalid cleanup and optional edits', () => {
    const draft = new ClientModuleDraft(rows, ['unknown-module', 'unknown-module', 'skin-client'])
    draft.clearInvalidExclusion('unknown-module')
    draft.setLoaded('skin-client', true)
    draft.setLoaded('@someone/side_panel', false)
    expect(draft.changeCount).toBe(3)
    draft.setLoaded('skin-client', false)
    draft.setLoaded('@someone/side_panel', true)
    expect(draft.changeCount).toBe(1)
    const saved = new ClientModuleDraft(rows, draft.excludedIds)
    expect(saved.changeCount).toBe(0)
    expect(saved.invalidExclusions).toEqual([])
  })
})

describe('module transfer sizes and the minimal selection', () => {
  const sized: readonly ClientModuleRow[] = [
    { id: 'required-core', required: true, dependencies: [] },
    { id: 'needed-by-core', required: false, dependencies: [] },
    { id: 'heavy-optional', required: false, dependencies: [], bytes: 3_355_443, gzipBytes: 2_478_000 },
    { id: 'small-optional', required: false, dependencies: [], gzipBytes: 41_000 },
    { id: 'unmeasured-optional', required: false, dependencies: [] },
    { id: 'dependent-optional', required: false, dependencies: ['needed-by-core'] },
  ]
  const withDependency: readonly ClientModuleRow[] = [
    ...sized.filter(row => row.id !== 'required-core'),
    { id: 'required-core', required: true, dependencies: ['needed-by-core'] },
  ]

  it('formats measured transfer size and stays silent when nothing was measured', () => {
    expect(formatClientModuleSize({ id: 'a', required: false, dependencies: [], gzipBytes: 41_000 })).toBe('40 KB')
    expect(formatClientModuleSize({ id: 'a', required: false, dependencies: [], bytes: 512 })).toBe('1 KB')
    expect(formatClientModuleSize({ id: 'a', required: false, dependencies: [], gzipBytes: 2_478_000 })).toBe('2.4 MB')
    expect(formatClientModuleSize({ id: 'a', required: false, dependencies: [] })).toBeUndefined()
    expect(formatClientModuleSize({ id: 'a', required: false, dependencies: [], gzipBytes: 0 })).toBe('0 KB')
  })

  it('keeps dependencies of required entries when minimizing', () => {
    const excluded = clientModuleMinimalExclusion(withDependency)
    expect(excluded).toEqual(['heavy-optional', 'small-optional', 'unmeasured-optional', 'dependent-optional'])
    expect(excluded).not.toContain('needed-by-core')
    expect(excluded).not.toContain('required-core')
  })

  it('totals only the loaded transfer bytes and prefers gzip', () => {
    const draft = new ClientModuleDraft(sized, [])
    expect(draft.loadedTransferBytes()).toBe(2_478_000 + 41_000)
    draft.setLoaded('heavy-optional', false)
    expect(draft.loadedTransferBytes()).toBe(41_000)
  })

  it('applies the minimal selection as a draft change, not a save', () => {
    const draft = new ClientModuleDraft(withDependency, [])
    expect(draft.applyMinimalSelection()).toBe(true)
    expect(new Set(draft.excludedIds)).toEqual(new Set(['heavy-optional', 'small-optional', 'unmeasured-optional', 'dependent-optional']))
    expect(draft.changeCount).toBe(4)
    expect(draft.applyMinimalSelection()).toBe(false)
  })

  it('sorts measured sizes descending, unknowns last and equal sizes by exact id', () => {
    expect(sortClientModulesBySize([
      { id: 'unknown', required: false, dependencies: [] },
      { id: 'b', required: false, dependencies: [], gzipBytes: 10 },
      { id: 'large', required: false, dependencies: [], gzipBytes: 100 },
      { id: 'a', required: false, dependencies: [], gzipBytes: 10 },
      { id: 'zero', required: false, dependencies: [], gzipBytes: 0 },
    ]).map(entry => entry.id)).toEqual(['large', 'a', 'b', 'zero', 'unknown'])
  })

  it('refreshes measurements without losing unsaved choices, original counts or stale exclusions', () => {
    const draft = new ClientModuleDraft(sized, ['missing-old-module'])
    draft.setLoaded('heavy-optional', false)
    const changed = draft.changeCount
    draft.updateMeasurements(sized.map(entry => entry.id === 'small-optional' ? { ...entry, gzipBytes: 1024 } : entry))
    expect(draft.loadedTransferBytes()).toBe(1024)
    expect(draft.loadedUnknownSizeCount()).toBe(4)
    expect(draft.changeCount).toBe(changed)
    expect(draft.excludedIds).toEqual(['missing-old-module', 'heavy-optional'])
    expect(draft.matchingEntries('', 'all').find(entry => entry.id === 'small-optional')?.gzipBytes).toBe(1024)
  })
})
