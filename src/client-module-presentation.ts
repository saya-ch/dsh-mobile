/** Presentation-only grouping and drafts for the authenticated frontend catalog. */
export interface ClientModuleRow {
  readonly id: string
  readonly required: boolean
  readonly dependencies: readonly string[]
  /** Source bytes measured by the Gateway, when available. */
  readonly bytes?: number
  /** Gzipped bytes the phone would receive, when available. */
  readonly gzipBytes?: number
  /** The plugin package's own one-line description, when available. */
  readonly description?: string
}

export type ClientModuleGroup = 'extensions' | 'advanced' | 'required'
export type ClientModuleFilter = 'all' | 'loaded' | 'excluded'

export interface InvalidClientModuleExclusion {
  readonly id: string
  readonly reason: 'missing' | 'required'
}

/** Group boot-protected entries before considering their package namespace.
 * @param entry - Catalog entry with server-owned required and dependency fields.
 * @returns Display group, never an authorization or compatibility decision.
 */
export function clientModuleGroup(entry: ClientModuleRow): ClientModuleGroup {
  if (entry.required) return 'required'
  return entry.id.startsWith('@deepseek-ai/') ? 'advanced' : 'extensions'
}

/** Format the package leaf mechanically; the catalog has no product titles.
 * @param id - Exact module ID from the server catalog.
 * @returns Unscoped package words without guessed function or plugin ownership.
 */
export function clientModuleDisplayName(id: string): string {
  const leaf = id.startsWith('@') && id.includes('/') ? id.slice(id.indexOf('/') + 1) : id
  const shortName = leaf.replace(/^dsh-(?:client-(?:ui-)?)?/u, '')
  return (shortName || leaf || id).replace(/[-_]+/gu, ' ')
}

function matchesQuery(id: string, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return needle === '' || `${id}\n${clientModuleDisplayName(id)}`.toLowerCase().includes(needle)
}

/** Match the visible title or exact ID and the current draft loading choice.
 * @param entry - Catalog entry to consider.
 * @param excluded - Current draft exclusions, not a runtime loading observation.
 * @param query - User-entered search text.
 * @param filter - All, selected for loading, or selected for omission.
 * @returns Whether the row belongs in the current filtered list.
 */
export function clientModuleMatches(entry: ClientModuleRow, excluded: ReadonlySet<string>, query: string, filter: ClientModuleFilter): boolean {
  const omitted = !entry.required && excluded.has(entry.id)
  return matchesQuery(entry.id, query) && (filter === 'all' || (filter === 'excluded' ? omitted : !omitted))
}


/** Format a module's measured transfer size for the settings panel.
 * @param entry - Catalog row with optional measured sizes.
 * @returns A short size label, or `undefined` when nothing was measured.
 */
export function formatClientModuleSize(entry: ClientModuleRow): string | undefined {
  const value = entry.gzipBytes ?? entry.bytes
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined
  if (value === 0) return '0 KB'
  const kilobytes = value / 1024
  return kilobytes >= 1024
    ? `${(kilobytes / 1024).toFixed(1)} MB`
    : `${String(Math.max(1, Math.round(kilobytes)))} KB`
}

/** Sort measured modules largest first, keeping unknown sizes last and ties stable by ID. */
export function sortClientModulesBySize(entries: readonly ClientModuleRow[]): readonly ClientModuleRow[] {
  return [...entries].sort((left, right) => {
    const leftBytes = left.gzipBytes ?? left.bytes
    const rightBytes = right.gzipBytes ?? right.bytes
    if (leftBytes === undefined && rightBytes !== undefined) return 1
    if (rightBytes === undefined && leftBytes !== undefined) return -1
    const delta = (rightBytes ?? 0) - (leftBytes ?? 0)
    return delta || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  })
}

/**
 * Choose the smallest loadable set: required entries plus everything they depend on.
 *
 * Excluding every optional entry naively would keep a required module pointing at
 * an excluded dependency, which the Gateway rejects on save. The closure keeps
 * those dependencies loaded instead.
 * @param entries - Full catalog with declared dependencies.
 * @returns IDs to exclude, in catalog order.
 */
export function clientModuleMinimalExclusion(entries: readonly ClientModuleRow[]): readonly string[] {
  const byId = new Map(entries.map(entry => [entry.id, entry]))
  const keep = new Set(entries.filter(entry => entry.required).map(entry => entry.id))
  const pending = [...keep]
  while (pending.length > 0) {
    const entry = byId.get(pending.pop()!)
    if (entry === undefined) continue
    for (const dependency of entry.dependencies) {
      if (keep.has(dependency)) continue
      keep.add(dependency)
      pending.push(dependency)
    }
  }
  return entries.filter(entry => !keep.has(entry.id)).map(entry => entry.id)
}

/**
 * Describe the optional modules removed by the minimal preset without treating unmeasured sizes as zero.
 * @param entries - The complete displayed catalog, including required dependencies.
 * @returns Excluded count, known gzip bytes when measured, and the number still unmeasured.
 */
export function clientModuleMinimalImpact(entries: readonly ClientModuleRow[]): { readonly count: number; readonly gzipBytes?: number; readonly unknown: number } {
  const excluded = new Set(clientModuleMinimalExclusion(entries))
  const rows = entries.filter(entry => excluded.has(entry.id))
  const measured = rows.filter(entry => entry.gzipBytes !== undefined)
  return {
    count: rows.length,
    ...(measured.length === 0 ? {} : { gzipBytes: measured.reduce((sum, entry) => sum + entry.gzipBytes!, 0) }),
    unknown: rows.length - measured.length,
  }
}

/** Editable selections retain unknown server exclusions and never cascade dependencies. */
export class ClientModuleDraft {
  private readonly initial: Set<string>
  private readonly excluded: Set<string>
  private readonly entriesById: Map<string, ClientModuleRow>
  private catalogEntries: readonly ClientModuleRow[]

  constructor(entries: readonly ClientModuleRow[], excludedIds: readonly string[]) {
    this.catalogEntries = entries
    this.initial = new Set(excludedIds)
    this.excluded = new Set(excludedIds)
    this.entriesById = new Map(entries.map(entry => [entry.id, entry]))
  }

  /** @returns The original catalog with its most recently measured metadata. */
  get entries(): readonly ClientModuleRow[] { return this.catalogEntries }

  /** @returns Number of changed loading choices, including hidden filtered rows. */
  get changeCount(): number {
    let count = 0
    for (const id of this.initial) if (!this.excluded.has(id)) count += 1
    for (const id of this.excluded) if (!this.initial.has(id)) count += 1
    return count
  }

  /** @returns A snapshot of exclusions suitable for authenticated saving. */
  get excludedIds(): readonly string[] { return [...this.excluded] }

  /** @returns Retained exclusions that cannot be saved against the current catalog. */
  get invalidExclusions(): readonly InvalidClientModuleExclusion[] {
    return [...this.excluded].flatMap((id): readonly InvalidClientModuleExclusion[] => {
      const entry = this.entriesById.get(id)
      return entry === undefined ? [{ id, reason: 'missing' }] : entry.required ? [{ id, reason: 'required' }] : []
    })
  }

  /** Explicitly remove an old exclusion; ordinary optional choices use setLoaded.
   * @param id - Exact ID of a retained missing or now-required exclusion.
   * @returns Whether this draft changed; no server request is made.
   */
  clearInvalidExclusion(id: string): boolean {
    const entry = this.entriesById.get(id)
    if (!this.initial.has(id) || (entry !== undefined && !entry.required)) return false
    return this.excluded.delete(id)
  }

  /** @returns Whether a catalog entry is selected for loading, not already loaded. */
  isLoaded(id: string): boolean { return this.entriesById.get(id)?.required === true || !this.excluded.has(id) }

  /** Change one optional choice; required and unknown entries cannot be edited.
   * @param id - Exact catalog ID.
   * @param loaded - Whether to load the entry on the next open.
   */
  setLoaded(id: string, loaded: boolean): void {
    const entry = this.entriesById.get(id)
    if (entry === undefined || entry.required) return
    if (loaded) this.excluded.delete(id)
    else this.excluded.add(id)
  }


  /** @returns Bytes the current selection still downloads, when sizes were measured. */
  loadedTransferBytes(): number {
    let total = 0
    for (const entry of this.entries) {
      if (!this.isLoaded(entry.id)) continue
      total += entry.gzipBytes ?? entry.bytes ?? 0
    }
    return total
  }

  /** @returns Number of selected modules whose transfer size is still unknown. */
  loadedUnknownSizeCount(): number {
    return this.entries.filter(entry => this.isLoaded(entry.id) && entry.gzipBytes === undefined && entry.bytes === undefined).length
  }

  /** Refresh metadata without replacing saved or unsaved loading choices. */
  updateMeasurements(entries: readonly ClientModuleRow[]): void {
    const measured = new Map(entries.map(entry => [entry.id, entry]))
    for (const entry of this.entries) {
      const next = measured.get(entry.id)
      if (next === undefined) continue
      const refreshed = { ...entry }
      delete refreshed.bytes; delete refreshed.gzipBytes; delete refreshed.description
      this.entriesById.set(entry.id, { ...refreshed,
        ...(next.bytes === undefined ? {} : { bytes: next.bytes }),
        ...(next.gzipBytes === undefined ? {} : { gzipBytes: next.gzipBytes }),
        ...(next.description === undefined ? {} : { description: next.description }),
      })
    }
    this.catalogEntries = this.entries.map(entry => this.entriesById.get(entry.id)!)
  }

  /** Exclude every optional entry except dependencies a required entry still needs.
   * @returns Whether this draft changed; saving remains a separate action.
   */
  applyMinimalSelection(): boolean {
    const target = new Set(clientModuleMinimalExclusion(this.entries))
    let changed = false
    for (const entry of this.entries) {
      if (entry.required) continue
      const shouldExclude = target.has(entry.id)
      if (shouldExclude !== this.excluded.has(entry.id)) changed = true
      if (shouldExclude) this.excluded.add(entry.id)
      else this.excluded.delete(entry.id)
    }
    return changed
  }

  /** Filter a draft without changing hidden choices.
   * @param query - Search input.
   * @param filter - Requested loading selection.
   * @returns Catalog entries in their original stable order.
   */
  matchingEntries(query: string, filter: ClientModuleFilter): readonly ClientModuleRow[] {
    return this.entries.map(entry => this.entriesById.get(entry.id)!).filter(entry => clientModuleMatches(entry, this.excluded, query, filter))
  }

  /** Find invalid old exclusions by name or ID, independently from the protected catalog row.
   * @param query - Search input.
   * @param filter - Old exclusions appear in all and excluded selections, not loaded.
   * @returns Invalid draft exclusions in their retained order.
   */
  matchingInvalidExclusions(query: string, filter: ClientModuleFilter): readonly InvalidClientModuleExclusion[] {
    return filter === 'loaded' ? [] : this.invalidExclusions.filter(entry => matchesQuery(entry.id, query))
  }
}
