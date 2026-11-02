/** Device-local module selection and the computer's defaults share a read-only catalog. */
import { createElement, type ReactElement } from 'react'
import { localAdminRequestHeaders } from './local-admin-host.js'
import type { MobileControlLocale } from './client-messages.js'
import { ClientModuleDraft, clientModuleDisplayName, clientModuleGroup, clientModuleMinimalExclusion, formatClientModuleSize, sortClientModulesBySize, type ClientModuleFilter, type ClientModuleGroup, type ClientModuleRow } from './client-module-presentation.js'

export type { ClientModuleRow } from './client-module-presentation.js'

export const CLIENT_MODULE_COPY = {
  zh: {
    measure: '测量体积', measuring: '正在测量…', cancelMeasure: '取消测量', measured: '测量结束，未测到的项目保持未知。你的模块选择未变。', measureFailed: '测量未完成，已保留模块选择和已有体积。', totalPartial: '已测合计约 {size}；另有 {count} 项未知',
    title: '移动页面模块', computer: '设置此电脑的移动访问默认项；电脑插件不变。', device: '仅本设备，下次打开生效；电脑插件不变。', open: '管理', help: '加载规则',
    loading: '正在读取模块…', hint: '勾选表示下次打开时加载。启动必需项受保护；依赖冲突会在保存时说明，不会自动取消其他模块。',
    save: '保存选择', reset: '恢复默认', close: '关闭', required: '启动必需', dependencies: '依赖：', noDependencies: '无声明的前端依赖', details: '模块详情', moduleId: '模块 ID',
    saved: '已保存，下次打开 DSH 生效。不会自动刷新当前页面或丢弃草稿。', failed: '暂时无法读取模块。请确认移动访问已启用后重试。', saveFailed: '未确认保存成功，已保留你的选择。可重新保存，或重新读取已保存设置。',
    conflict: '无法保存：', catalogChanged: '模块目录已变化（插件或版本有更新），本次保存已取消。请点「重新读取」，确认后再保存。', computerSource: '当前来源：电脑默认设置', deviceSource: '当前来源：本设备设置', pluginSource: '当前来源：插件默认设置',
    resetConfirm: '恢复默认模块选择？仅下次打开生效，不会重新加载当前会话。', discardConfirm: '放弃未保存的模块选择并关闭？', reloadConfirm: '重新读取会替换未保存的选择。继续吗？', savingCloseConfirm: '保存结果尚未确认。现在关闭不会撤销可能已完成的保存，确定关闭吗？',
    search: '搜索模块', searchPlaceholder: '搜索名称或模块 ID', filter: '加载选择', all: '全部', loaded: '加载', excluded: '不加载', empty: '没有符合条件的模块。', clearFilters: '清除筛选',
    extensions: '可选扩展', extensionsHint: '可选择不加载的前端模块；一项模块不一定等于一个完整插件。', advanced: 'DSH 可选组件（高级）', advancedHint: 'DSH 的可选前端组件。只修改你了解的项目。', requiredGroup: '启动必需项', requiredHint: '这些模块保证页面启动，不能关闭。',
    changes: '未保存：{count} 项改动', unchanged: '没有未保存的改动', results: '匹配 {visible} / {total} 项', sizeHint: '按传输体积从大到小排列；数字为 gzip 后的字节。说明取自插件包自身的描述字段，不代表上游认证。', total: '勾选合计约 {size}', totalUnknown: '勾选合计：部分模块未测到体积', minimal: '仅必需（最小加载）', minimalConfirm: '把除了启动必需项及其依赖之外全部设为不加载？保存后下次打开生效。', minimalDetail: '将排除 {count} 个可选模块，约 {size}；启动必需项及其依赖会保留。', retry: '重新读取', saving: '正在保存…', readTimeout: '读取超时。当前页面和已保存设置未变，请重试。', writeTimeout: '保存超时，结果尚未确认。保留了你的选择；请重新读取确认，不会自动重试保存。', nextOpen: '仅下次打开生效',
    invalidSelections: '失效的旧选择', invalidHint: '这些旧排除已与当前模块目录不符。移除后仍需保存选择。', invalidMissing: '当前模块目录中不存在。', invalidRequired: '当前已是启动必需项，不能排除。', clearInvalid: '移除旧排除',
  },
  en: {
    measure: 'Measure sizes', measuring: 'Measuring…', cancelMeasure: 'Cancel measurement', measured: 'Measurement ended; unavailable sizes stay unknown. Your module choices are unchanged.', measureFailed: 'Measurement did not complete. Your choices and known sizes are kept.', totalPartial: 'Measured ≈ {size}; {count} sizes unknown',
    title: 'Mobile page modules', computer: 'Mobile defaults for this computer. Desktop plugins are unchanged.', device: 'For this device’s next open only. Computer plugins are unchanged.', open: 'Manage', help: 'Loading rules',
    loading: 'Reading modules…', hint: 'Checked means load on the next open. Required entries are protected; saving explains dependency conflicts without unchecking other modules.',
    save: 'Save selection', reset: 'Restore defaults', close: 'Close', required: 'Required for boot', dependencies: 'Depends on: ', noDependencies: 'No declared frontend dependencies', details: 'Module details', moduleId: 'Module ID',
    saved: 'Saved for the next DSH open. This page is not refreshed and its draft is kept.', failed: 'Could not read modules. Enable mobile access and try again.', saveFailed: 'Saving was not confirmed. Your choices are kept. Save again or reread the saved settings.',
    conflict: 'Could not save: ', catalogChanged: 'The module catalog changed (a plugin or version update). This save was cancelled; reread the settings, then confirm again.', computerSource: 'Source: computer defaults', deviceSource: 'Source: this device’s settings', pluginSource: 'Source: plugin defaults',
    resetConfirm: 'Restore default selections for the next open? The current conversation will not reload.', discardConfirm: 'Discard unsaved module choices and close?', reloadConfirm: 'Rereading replaces unsaved choices. Continue?', savingCloseConfirm: 'Saving is not confirmed. Closing will not undo a save that may have completed. Close anyway?',
    search: 'Search modules', searchPlaceholder: 'Search name or module ID', filter: 'Loading selection', all: 'All', loaded: 'Load', excluded: 'Do not load', empty: 'No modules match these filters.', clearFilters: 'Clear filters',
    extensions: 'Optional extensions', extensionsHint: 'Optional frontend modules; one module is not necessarily a complete plugin.', advanced: 'DSH optional components (advanced)', advancedHint: 'Optional DSH frontend components. Change only entries you understand.', requiredGroup: 'Required for boot', requiredHint: 'These modules keep the page bootable and cannot be disabled.',
    changes: 'Unsaved: {count} changes', unchanged: 'No unsaved changes', results: 'Matching {visible} / {total}', sizeHint: 'Sorted by transfer size; numbers are gzipped bytes. Descriptions come from each plugin package; this is not an upstream endorsement.', total: 'Selection ≈ {size}', totalUnknown: 'Selection total: some sizes are unknown', minimal: 'Required only (minimal load)', minimalConfirm: 'Mark everything except required modules and their dependencies as not loaded? Applies on the next open after saving.', minimalDetail: 'This excludes {count} optional modules (about {size}); required modules and their dependencies stay loaded.', retry: 'Reread settings', saving: 'Saving…', readTimeout: 'Reading timed out. This page and saved settings are unchanged; try again.', writeTimeout: 'Saving timed out and its result is unconfirmed. Your choices are kept. Reread to confirm; saving is not retried automatically.', nextOpen: 'Applies on next open only',
    invalidSelections: 'Outdated selections', invalidHint: 'These old exclusions no longer match the module catalog. Save your choices after removing them.', invalidMissing: 'Not present in the current module catalog.', invalidRequired: 'Now required for boot and cannot be excluded.', clearInvalid: 'Remove old exclusion',
  },
  it: {
    measure: 'Misura dimensioni', measuring: 'Misurazione…', cancelMeasure: 'Annulla misurazione', measured: 'Misurazione terminata; le dimensioni non disponibili restano sconosciute. Le scelte non cambiano.', measureFailed: 'Misurazione incompleta. Scelte e dimensioni note conservate.', totalPartial: 'Misurati ≈ {size}; {count} dimensioni sconosciute',
    title: 'Moduli della pagina mobile', computer: 'Predefiniti mobile del computer; i plugin non cambiano.', device: 'Solo alla prossima apertura su questo dispositivo; i plugin del computer non cambiano.', open: 'Gestisci', help: 'Regole di caricamento',
    loading: 'Lettura dei moduli…', hint: 'Selezionato significa caricare alla prossima apertura. I moduli obbligatori sono protetti; il salvataggio mostra i conflitti senza deselezionare altri moduli.',
    save: 'Salva selezione', reset: 'Ripristina predefiniti', close: 'Chiudi', required: 'Obbligatorio', dependencies: 'Dipende da: ', noDependencies: 'Nessuna dipendenza frontend dichiarata', details: 'Dettagli modulo', moduleId: 'ID modulo',
    saved: 'Salvato per la prossima apertura di DSH. La pagina non si aggiorna e la bozza resta.', failed: 'Impossibile leggere i moduli. Abilita accesso mobile e riprova.', saveFailed: 'Salvataggio non confermato. Le scelte restano; salva di nuovo o rileggi le impostazioni salvate.',
    conflict: 'Impossibile salvare: ', catalogChanged: 'Il catalogo dei moduli è cambiato (aggiornamento di plugin o versione). Salvataggio annullato: rileggi le impostazioni e conferma di nuovo.', computerSource: 'Origine: predefiniti del computer', deviceSource: 'Origine: impostazioni del dispositivo', pluginSource: 'Origine: predefiniti del plugin',
    resetConfirm: 'Ripristinare i predefiniti per la prossima apertura? La conversazione attuale non verrà ricaricata.', discardConfirm: 'Scartare le scelte non salvate e chiudere?', reloadConfirm: 'Rileggere sostituisce le scelte non salvate. Continuare?', savingCloseConfirm: 'Salvataggio non confermato. Chiudere non annulla un salvataggio già completato. Chiudere comunque?',
    search: 'Cerca moduli', searchPlaceholder: 'Cerca nome o ID modulo', filter: 'Selezione caricamento', all: 'Tutti', loaded: 'Carica', excluded: 'Non caricare', empty: 'Nessun modulo corrisponde ai filtri.', clearFilters: 'Cancella filtri',
    extensions: 'Estensioni facoltative', extensionsHint: 'Moduli frontend facoltativi; un modulo non è necessariamente un plugin completo.', advanced: 'Componenti DSH facoltativi (avanzate)', advancedHint: 'Componenti frontend DSH facoltativi. Modifica solo quelli che conosci.', requiredGroup: 'Moduli obbligatori', requiredHint: 'Questi moduli permettono l’avvio e non possono essere disattivati.',
    changes: 'Non salvate: {count} modifiche', unchanged: 'Nessuna modifica non salvata', results: 'Corrispondenti {visible} / {total}', sizeHint: 'Ordinati per dimensione trasferita; i numeri sono byte gzip. Le descrizioni provengono dal pacchetto del plugin; non sono un’approvazione upstream.', total: 'Selezione ≈ {size}', totalUnknown: 'Totale selezione: alcune dimensioni sono sconosciute', minimal: 'Solo obbligatori (caricamento minimo)', minimalConfirm: 'Impostare come non caricati tutti i moduli tranne gli obbligatori e le loro dipendenze? Vale alla prossima apertura dopo il salvataggio.', minimalDetail: 'Verranno esclusi {count} moduli facoltativi (circa {size}); gli obbligatori e le loro dipendenze restano caricati.', retry: 'Rileggi impostazioni', saving: 'Salvataggio…', readTimeout: 'Lettura scaduta. Pagina e impostazioni salvate non cambiano; riprova.', writeTimeout: 'Salvataggio scaduto e non confermato. Le scelte restano. Rileggi per confermare; nessun tentativo automatico.', nextOpen: 'Solo alla prossima apertura',
    invalidSelections: 'Scelte obsolete', invalidHint: 'Queste esclusioni precedenti non corrispondono più al catalogo. Salva le scelte dopo averle rimosse.', invalidMissing: 'Assente dal catalogo attuale dei moduli.', invalidRequired: 'Ora obbligatorio per l’avvio e non può essere escluso.', clearInvalid: 'Rimuovi esclusione precedente',
  },
} as const

interface ClientModuleView {
  readonly entries: readonly ClientModuleRow[]
  /** Catalog fingerprint from a server that reports one; older gateways omit it. */
  readonly revision?: string
  readonly excludedClientModules: readonly string[]
  readonly source: 'device' | 'computer' | 'plugin'
}

class ClientModuleUiConflict extends Error {
  constructor(readonly detail: string, readonly code: 'invalid_selection' | 'catalog_changed' = 'invalid_selection') {
    super('client_module_conflict')
  }
}

/** A deadline does not imply that a POST was rolled back by the server. */
export class ClientModuleRequestTimeout extends Error {
  constructor(readonly mutation: boolean) { super('client_module_request_timeout') }
}

export const CLIENT_MODULE_REQUEST_TIMEOUT_MS = { read: 15_000, write: 20_000 } as const

/** Describe measured bytes without presenting unmeasured modules as a complete total. */
export function clientModuleTotalLabel(draft: ClientModuleDraft | undefined, locale: MobileControlLocale): string {
  const copy = CLIENT_MODULE_COPY[locale]
  const unknownSizes = draft?.loadedUnknownSizeCount() ?? 0
  const size = formatClientModuleSize({ id: '', required: false, dependencies: [], gzipBytes: draft?.loadedTransferBytes() ?? 0 }) ?? '0 KB'
  return unknownSizes > 0
    ? copy.totalPartial.replace('{size}', size).replace('{count}', String(unknownSizes))
    : copy.total.replace('{size}', size)
}

/** Validate catalog response fields before creating interactive controls.
 * @param value - Gateway or computer-admin JSON response.
 * @returns The fields used by the module-selection dialog.
 */
export function parseClientModuleView(value: unknown): ClientModuleView {
  if (typeof value !== 'object' || value === null || !('entries' in value) || !Array.isArray(value.entries)
    || !('excludedClientModules' in value) || !Array.isArray(value.excludedClientModules)
    || !('source' in value) || (value.source !== 'device' && value.source !== 'computer' && value.source !== 'plugin')) throw new Error('invalid_module_catalog')
  const entries = value.entries.map((entry: unknown): ClientModuleRow => {
    if (typeof entry !== 'object' || entry === null || !('id' in entry) || typeof entry.id !== 'string'
      || !('required' in entry) || typeof entry.required !== 'boolean' || !('dependencies' in entry) || !Array.isArray(entry.dependencies)) throw new Error('invalid_module_catalog')
    const dependencies = entry.dependencies.map((dependency: unknown): string => {
      if (typeof dependency !== 'string') throw new Error('invalid_module_catalog')
      return dependency
    })
    if (entry.id.trim() === '') throw new Error('invalid_module_catalog')
    const sizes: { bytes?: number; gzipBytes?: number; description?: string } = {}
    for (const field of ['bytes', 'gzipBytes'] as const) {
      if (!(field in entry)) continue
      const measured = (entry as Record<string, unknown>)[field]
      if (typeof measured !== 'number' || !Number.isSafeInteger(measured) || measured < 0) throw new Error('invalid_module_catalog')
      sizes[field] = measured
    }
    if ('description' in entry) {
      const description = (entry as Record<string, unknown>).description
      if (typeof description !== 'string' || description.trim() === '' || description.length > 240) throw new Error('invalid_module_catalog')
      sizes.description = description
    }
    return { id: entry.id, required: entry.required, dependencies, ...sizes }
  })
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('invalid_module_catalog')
  const revision = (value as Record<string, unknown>).revision
  if (revision !== undefined && (typeof revision !== 'string' || revision === '' || revision.length > 64)) throw new Error('invalid_module_catalog')
  const excludedClientModules = value.excludedClientModules.map((id: unknown): string => {
    if (typeof id !== 'string') throw new Error('invalid_module_catalog')
    return id
  })
  return {
    entries,
    ...(typeof revision === 'string' ? { revision } : {}),
    excludedClientModules,
    source: value.source === 'device' ? 'device' : value.source === 'computer' ? 'computer' : 'plugin',
  }
}

/** Read or explicitly write module choices with a bounded, cancellable operation.
 * @param scope - Computer-admin endpoint or authenticated device endpoint.
 * @param signal - Owning dialog lifetime; cancellation cannot undo a completed write.
 * @param body - Omit for a read; supplied fields are sent once without automatic replay.
 * @returns Validated catalog fields returned by the selected endpoint.
 */
export async function requestClientModuleView(scope: 'computer' | 'device', signal: AbortSignal, body?: Record<string, unknown>): Promise<ClientModuleView> {
  if (signal.aborted) throw new DOMException('Dialog closed', 'AbortError')
  const controller = new AbortController()
  let rejectCancellation: (error: Error) => void = () => {}
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject })
  const abort = (): void => { controller.abort(); rejectCancellation(new DOMException('Dialog closed', 'AbortError')) }
  signal.addEventListener('abort', abort, { once: true })
  const mutation = body !== undefined && body.measure !== true
  const timer = setTimeout(() => {
    rejectCancellation(new ClientModuleRequestTimeout(mutation))
    controller.abort()
  }, mutation ? CLIENT_MODULE_REQUEST_TIMEOUT_MS.write : CLIENT_MODULE_REQUEST_TIMEOUT_MS.read)
  const operation = async (): Promise<ClientModuleView> => {
    const init: RequestInit = { method: body === undefined ? 'GET' : 'POST', signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
    init.headers = scope === 'computer' ? localAdminRequestHeaders(init, location) : { 'content-type': 'application/json' }
    if (scope === 'device' && body !== undefined) {
      const cookies = document.cookie.split(';').map(value => value.trim())
      const csrfCookie = cookies.find(value => value.startsWith('__Host-dsh_ma_csrf=')) ?? cookies.find(value => value.startsWith('dsh_ma_csrf='))
      if (csrfCookie !== undefined) {
        const headers = new Headers(init.headers)
        headers.set('x-dsh-mobile-csrf', csrfCookie.slice(csrfCookie.indexOf('=') + 1))
        init.headers = headers
      }
    }
    const response = await fetch(scope === 'computer' ? '/api/mobile-access/client-modules' : '/mobile-access/client-modules', init)
    const value: unknown = await response.json()
    if (!response.ok) {
      const detail = typeof value === 'object' && value !== null && 'detail' in value && typeof value.detail === 'string' ? value.detail.slice(0, 512) : ''
      const code = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string' ? value.error : ''
      if (response.status === 409 && detail !== '' && code === 'client_module_catalog_changed') throw new ClientModuleUiConflict(detail, 'catalog_changed')
      if (response.status === 409 && detail !== '' && code === 'excluded_client_modules_invalid') throw new ClientModuleUiConflict(detail)
      throw new Error('client_module_request_failed')
    }
    return parseClientModuleView(value)
  }
  try { return await Promise.race([operation(), cancellation]) }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}

export const CLIENT_MODULE_STYLES = `
.dsh-module-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsh-module-rowText{flex:1;min-width:0}.dsh-module-title{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-module-description{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-module-button{min-height:48px;padding:0 14px;border:0;border-radius:24px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer}
.dsh-module-button:focus-visible{outline:2px solid var(--dsw-alias-label-primary-bluish,#2563eb);outline-offset:2px}
.dsh-module-button:not(:disabled):active{background:var(--dsw-alias-interactive-bg-active)}
.dsh-module-dialog{box-sizing:border-box;width:min(640px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel,20px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#171a21);font:16px/1.5 var(--dsw-font-family,sans-serif);overflow:hidden}
.dsh-module-dialog[open]{display:flex;flex-direction:column}.dsh-module-dialog::backdrop{background:rgb(15 23 42 / 40%)}
.dsh-module-header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.dsh-module-header h2{flex:1;min-width:0;font-size:20px;line-height:1.4;margin:0;overflow-wrap:anywhere}.dsh-module-header .dsh-module-button{flex:none}
.dsh-module-packageDescription{margin:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsh-module-description-full{margin:4px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.45}
.dsh-module-body{min-height:0;overflow:auto;overscroll-behavior:contain;padding:16px;scroll-padding:12px}.dsh-module-dialog p{margin:0 0 12px;overflow-wrap:anywhere}
.dsh-module-hint,.dsh-module-source,.dsh-module-choice small,.dsh-module-groupHint,.dsh-module-results{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary))}
.dsh-module-tools{display:grid;grid-template-columns:minmax(0,1fr) minmax(100px,.45fr);gap:12px;margin:16px 0 8px}.dsh-module-field{display:flex;flex-direction:column;gap:4px;min-width:0;font-size:13px}
.dsh-module-help>summary{box-sizing:border-box;min-height:48px;padding:12px 0;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dsh-module-field input,.dsh-module-field select{box-sizing:border-box;width:100%;min-width:0;min-height:48px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-base,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);font:inherit;font-size:16px}
.dsh-module-dialog :is(input,select,summary):focus-visible{outline:2px solid var(--dsw-alias-label-primary-bluish,#2563eb);outline-offset:2px}
.dsh-module-list{display:flex;flex-direction:column;gap:16px;margin:12px 0}.dsh-module-group h3{margin:0 0 8px;font-size:16px;line-height:24px}
.dsh-module-group>summary{min-height:48px;cursor:pointer;font-weight:600;overflow-wrap:anywhere;align-content:center}.dsh-module-group>summary+div{margin-top:8px}
.dsh-module-entry{border-bottom:1px solid var(--dsw-alias-border-l2);padding:8px 0}.dsh-module-choice{display:flex;align-items:center;gap:12px;min-height:48px;cursor:pointer}
.dsh-module-choice input{width:24px;height:24px;flex:none;margin:0}.dsh-module-choice span{min-width:0;overflow-wrap:anywhere}.dsh-module-choiceName{display:block;font-weight:500}
.dsh-module-choice small{display:block}.dsh-module-entryDetails{margin-left:36px;min-width:0}.dsh-module-entryDetails summary{min-height:48px;align-content:center;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-tertiary))}
.dsh-module-invalid-entry code{display:block;min-width:0;overflow-wrap:anywhere;white-space:normal;font-size:13px}.dsh-module-invalid-entry .dsh-module-button{max-width:100%;white-space:normal;line-height:20px;padding:8px 14px}
.dsh-module-entryDetails p,.dsh-module-entryDetails code{overflow-wrap:anywhere;font-size:13px}.dsh-module-entryDetails code{white-space:normal}
.dsh-module-footer{flex:none;padding:12px 16px max(12px,env(safe-area-inset-bottom));border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,#fff)}
.dsh-module-footer p{font-size:13px;line-height:20px;margin:0 0 8px}.dsh-module-actions{display:flex;flex-wrap:wrap;gap:8px}.dsh-module-actions .dsh-module-button{flex:1;min-width:0;white-space:normal;line-height:20px;padding:8px 12px}
.dsh-module-button:disabled{opacity:.5;cursor:default}.dsh-module-save{background:var(--dsw-alias-bg-module-platform);font-weight:600}
.dsh-module-notice:empty{display:none}.dsh-module-notice{max-height:min(96px,24dvh);overflow:auto;font-size:14px;line-height:22px;overscroll-behavior:contain}.dsh-module-empty{padding:16px 0}
@media(max-width:420px){.dsh-module-tools{grid-template-columns:minmax(0,1fr)}.dsh-module-body{padding:12px}.dsh-module-header,.dsh-module-footer{padding-left:12px;padding-right:12px}.dsh-module-header{flex-wrap:wrap;gap:8px}.dsh-module-header h2{flex:1 1 100%}.dsh-module-header .dsh-module-button{flex:1 1 0;min-width:0;white-space:normal;overflow-wrap:anywhere;line-height:1.4;padding:8px 12px}}
.dsh-module-error{color:var(--dsw-alias-state-error-primary,#b42318)}
`

interface OpenClientModuleDialog { readonly dispose: () => void; readonly requestClose: () => void }
const openDialogs = new Set<OpenClientModuleDialog>()

/** Cancel pending dialogs when the owning plugin generation is disposed. */
export function disposeClientModuleDialogs(): void { for (const dialog of [...openDialogs]) dialog.dispose() }

/** Close the foreground module modal before navigating its underlying DSH settings.
 * @returns Whether an open module modal consumed the return action.
 */
export function closeClientModuleDialog(): boolean {
  const dialog = [...openDialogs].at(-1)
  if (dialog === undefined) return false
  dialog.requestClose()
  return true
}

/** Open one modal; closing cancels reads and restores focus without reloading the page.
 * @param scope - Computer defaults or the authenticated device's own override.
 * @param locale - Current DSH display language.
 * @param trigger - Control to focus again when the modal closes.
 */
export function openClientModuleSettings(scope: 'computer' | 'device', locale: MobileControlLocale, trigger?: HTMLElement): void {
  const copy = CLIENT_MODULE_COPY[locale]
  const controller = new AbortController()
  const dialog = document.createElement('dialog'); dialog.className = 'dsh-module-dialog'; dialog.setAttribute('aria-label', copy.title); dialog.lang = locale
  const button = (text: string): HTMLButtonElement => { const result = document.createElement('button'); result.type = 'button'; result.className = 'dsh-module-button'; result.textContent = text; return result }
  const paragraph = (text: string, className = ''): HTMLParagraphElement => { const result = document.createElement('p'); result.textContent = text; result.className = className; return result }
  const header = document.createElement('div'); header.className = 'dsh-module-header'
  const title = document.createElement('h2'); title.textContent = copy.title
  const close = button(copy.close); const measure = button(copy.measure); measure.dataset.clientModuleMeasure = 'true'; header.append(title, measure, close)
  const body = document.createElement('div'); body.className = 'dsh-module-body'
  const intro = paragraph(copy[scope]); const hint = paragraph(copy.hint, 'dsh-module-hint')
  const help = document.createElement('details'); help.className = 'dsh-module-help'
  const helpTitle = document.createElement('summary'); helpTitle.textContent = copy.help; help.append(helpTitle, hint)
  help.append(paragraph(copy.sizeHint, 'dsh-module-hint'))
  const source = paragraph('', 'dsh-module-source')
  const status = paragraph('', 'dsh-module-notice'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.tabIndex = -1
  const tools = document.createElement('div'); tools.className = 'dsh-module-tools'
  const searchLabel = document.createElement('label'); searchLabel.className = 'dsh-module-field'; searchLabel.textContent = copy.search
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = copy.searchPlaceholder; search.setAttribute('aria-label', copy.search); searchLabel.append(search)
  const filterLabel = document.createElement('label'); filterLabel.className = 'dsh-module-field'; filterLabel.textContent = copy.filter
  const filter = document.createElement('select'); filter.dataset.clientModuleFilter = 'true'; filter.setAttribute('aria-label', copy.filter)
  for (const value of ['all', 'loaded', 'excluded'] as const) { const option = document.createElement('option'); option.value = value; option.textContent = copy[value]; filter.append(option) }
  filterLabel.append(filter); tools.append(searchLabel, filterLabel)
  const results = paragraph('', 'dsh-module-results'); results.setAttribute('aria-live', 'polite')
  const list = document.createElement('div'); list.className = 'dsh-module-list'
  const footer = document.createElement('div'); footer.className = 'dsh-module-footer'
  const changes = paragraph(copy.unchanged); changes.setAttribute('role', 'status'); changes.setAttribute('aria-live', 'polite')
  const actions = document.createElement('div'); actions.className = 'dsh-module-actions'
  const save = button(copy.save); save.classList.add('dsh-module-save'); const minimal = button(copy.minimal); const reset = button(copy.reset); const reread = button(copy.retry)
  actions.append(save, reset, reread); footer.append(changes, status, actions)
  body.append(intro, source, tools, results, minimal, list, help); dialog.append(header, body, footer)
  let disposed = false
  let busy: 'read' | 'write' | 'measure' | undefined
  let measurementController: AbortController | undefined
  let generation = 0
  let draft: ClientModuleDraft | undefined
  let catalogRevision: string | undefined
  let unconfirmedWrite = false
  const expansion = new Map<ClientModuleGroup, boolean>([['extensions', true], ['advanced', false], ['required', false]])
  const choices = new Map<string, HTMLInputElement>()
  const invalidActions = new Map<string, HTMLButtonElement>()
  const filterValue = (): ClientModuleFilter => filter.value === 'loaded' ? 'loaded' : filter.value === 'excluded' ? 'excluded' : 'all'
  const updateControls = (): void => {
    const changed = draft?.changeCount ?? 0
    save.disabled = busy !== undefined || changed === 0; reset.disabled = busy !== undefined || draft === undefined; minimal.disabled = busy !== undefined || draft === undefined
    measure.disabled = (busy !== undefined && busy !== 'measure') || draft === undefined
    measure.textContent = busy === 'measure' ? copy.cancelMeasure : copy.measure
    reread.disabled = busy !== undefined; search.disabled = busy !== undefined || draft === undefined; filter.disabled = search.disabled
    save.textContent = busy === 'write' ? copy.saving : copy.save
    const total = clientModuleTotalLabel(draft, locale)
    changes.textContent = `${changed === 0 ? copy.unchanged : copy.changes.replace('{count}', String(changed))} · ${total} · ${copy.nextOpen}`
    list.setAttribute('aria-busy', String(busy !== undefined))
    for (const input of choices.values()) input.disabled = busy !== undefined || input.dataset.required === 'true'
    for (const action of invalidActions.values()) action.disabled = busy !== undefined
  }
  const renderList = (): void => {
    choices.clear(); invalidActions.clear(); list.replaceChildren()
    if (draft === undefined) { results.textContent = ''; return }
    const visible = draft.matchingEntries(search.value, filterValue())
    const invalid = draft.matchingInvalidExclusions(search.value, filterValue())
    results.textContent = copy.results.replace('{visible}', String(visible.length + invalid.length)).replace('{total}', String(draft.entries.length + draft.invalidExclusions.length))
    const filtered = search.value.trim() !== '' || filterValue() !== 'all'
    if (visible.length === 0 && invalid.length === 0) {
      const empty = document.createElement('div'); empty.className = 'dsh-module-empty'; empty.append(paragraph(copy.empty))
      const clear = button(copy.clearFilters); clear.addEventListener('click', () => { search.value = ''; filter.value = 'all'; renderList(); search.focus({ preventScroll: true }) }); empty.append(clear); list.append(empty)
    }
    if (invalid.length > 0) {
      const section = document.createElement('section'); section.className = 'dsh-module-group'; section.dataset.clientModuleGroup = 'invalid'
      const heading = document.createElement('h3'); heading.textContent = `${copy.invalidSelections} (${invalid.length})`
      section.append(heading, paragraph(copy.invalidHint, 'dsh-module-groupHint'))
      for (const entry of invalid) {
        const row = document.createElement('div'); row.className = 'dsh-module-entry dsh-module-invalid-entry'; row.dataset.invalidClientModuleId = entry.id
        const id = document.createElement('code'); id.textContent = entry.id
        const remove = button(copy.clearInvalid); remove.setAttribute('aria-label', `${copy.clearInvalid}: ${entry.id}`)
        remove.addEventListener('click', () => {
          if (disposed || busy !== undefined || draft?.clearInvalidExclusion(entry.id) !== true) return
          status.textContent = ''; status.classList.remove('dsh-module-error'); renderList()
          const nextAction = invalidActions.values().next().value ?? save
          nextAction.focus({ preventScroll: true })
        })
        row.append(id, paragraph(entry.reason === 'missing' ? copy.invalidMissing : copy.invalidRequired), remove)
        invalidActions.set(entry.id, remove); section.append(row)
      }
      list.append(section)
    }
    for (const group of ['extensions', 'advanced', 'required'] as const) {
      const entries = sortClientModulesBySize(visible.filter(entry => clientModuleGroup(entry) === group))
      if (entries.length === 0) continue
      const section = document.createElement(group === 'extensions' ? 'section' : 'details'); section.className = 'dsh-module-group'; section.dataset.group = group
      section.dataset.clientModuleGroup = group === 'advanced' ? 'system' : group
      const headingText = `${group === 'required' ? copy.requiredGroup : copy[group]} (${entries.length})`
      if (section instanceof HTMLDetailsElement) {
        section.open = filtered || expansion.get(group) === true
        const heading = document.createElement('summary'); heading.textContent = headingText; section.append(heading)
        section.addEventListener('toggle', () => { if (!filtered) expansion.set(group, section.open) })
      } else { const heading = document.createElement('h3'); heading.textContent = headingText; section.append(heading) }
      const content = document.createElement('div'); content.append(paragraph(group === 'required' ? copy.requiredHint : group === 'advanced' ? copy.advancedHint : copy.extensionsHint, 'dsh-module-groupHint'))
      for (const entry of entries) {
        const row = document.createElement('div'); row.className = 'dsh-module-entry'; row.dataset.clientModuleId = entry.id
        const label = document.createElement('label'); label.className = 'dsh-module-choice'
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = draft.isLoaded(entry.id); if (entry.required) input.dataset.required = 'true'
        const name = document.createElement('span'); const shortName = document.createElement('span'); shortName.className = 'dsh-module-choiceName'; shortName.textContent = clientModuleDisplayName(entry.id)
        const selected = document.createElement('small'); selected.textContent = entry.required ? copy.required : input.checked ? copy.loaded : copy.excluded
        const size = formatClientModuleSize(entry)
        const sizeLabel = document.createElement('small'); sizeLabel.className = 'dsh-module-size'; sizeLabel.textContent = size ?? ''
        if (size !== undefined) sizeLabel.dataset.clientModuleSize = 'true'
        name.append(shortName, selected, sizeLabel); label.append(input, name); row.append(label)
        if (entry.description !== undefined) {
          const summary = paragraph(entry.description, 'dsh-module-packageDescription')
          summary.dataset.clientModuleDescription = 'true'
          row.append(summary)
        }
        const detail = document.createElement('details'); detail.className = 'dsh-module-entryDetails'
        const detailSummary = document.createElement('summary'); detailSummary.textContent = copy.details
        const id = paragraph(`${copy.moduleId}: `); const code = document.createElement('code'); code.textContent = entry.id; id.append(code)
        detail.append(detailSummary, id)
        if (entry.description !== undefined) detail.append(paragraph(entry.description, 'dsh-module-description-full'))
        detail.append(paragraph(entry.dependencies.length === 0 ? copy.noDependencies : `${copy.dependencies}${entry.dependencies.join(', ')}`)); row.append(detail)
        input.addEventListener('change', () => {
          if (busy !== undefined || draft === undefined) return
          draft.setLoaded(entry.id, input.checked); input.checked = draft.isLoaded(entry.id); selected.textContent = entry.required ? copy.required : input.checked ? copy.loaded : copy.excluded
          status.textContent = ''; status.classList.remove('dsh-module-error')
          if (filterValue() !== 'all') { renderList(); filter.focus({ preventScroll: true }) }
          updateControls()
        })
        choices.set(entry.id, input); content.append(row)
      }
      section.append(content); list.append(section)
    }
    updateControls()
  }
  const render = (view: ClientModuleView): void => {
    draft = new ClientModuleDraft(view.entries, view.excludedClientModules)
    catalogRevision = view.revision
    source.textContent = view.source === 'device' ? copy.deviceSource : view.source === 'computer' ? copy.computerSource : copy.pluginSource
    renderList()
  }
  const failed = (error: unknown, mutation: boolean): void => {
    status.classList.add('dsh-module-error')
    status.textContent = error instanceof ClientModuleUiConflict
      ? (error.code === 'catalog_changed' ? copy.catalogChanged : `${copy.conflict}${error.detail}`)
      : error instanceof ClientModuleRequestTimeout ? (error.mutation ? copy.writeTimeout : copy.readTimeout) : mutation ? copy.saveFailed : copy.failed
    status.focus({ preventScroll: true })
  }
  const runRequest = (payload?: Record<string, unknown>): void => {
    if (disposed || busy !== undefined || (payload !== undefined && draft === undefined)) return
    const measuring = payload?.measure === true
    const mutation = payload !== undefined && !measuring
    const ownGeneration = ++generation; busy = measuring ? 'measure' : mutation ? 'write' : 'read'
    if (mutation) unconfirmedWrite = true
    if (measuring) measurementController = new AbortController()
    status.classList.remove('dsh-module-error'); status.textContent = measuring ? copy.measuring : mutation ? copy.saving : copy.loading; updateControls()
    void requestClientModuleView(scope, measuring ? measurementController!.signal : controller.signal, payload).then(view => {
      if (disposed || ownGeneration !== generation) return
      if (measuring && draft !== undefined) { draft.updateMeasurements(view.entries); renderList() }
      else { unconfirmedWrite = false; render(view) }
      status.textContent = measuring ? copy.measured : mutation ? copy.saved : ''
    }, error => {
      if (disposed || ownGeneration !== generation) return
      if (measuring) { status.textContent = copy.measureFailed; return }
      if (error instanceof ClientModuleUiConflict) unconfirmedWrite = false
      failed(error, mutation)
    }).finally(() => {
      if (disposed || ownGeneration !== generation) return
      measurementController = undefined
      busy = undefined; updateControls()
    })
  }
  search.addEventListener('input', renderList); filter.addEventListener('change', renderList)
  save.addEventListener('click', () => { if ((draft?.changeCount ?? 0) > 0) runRequest({ excludedClientModules: draft?.excludedIds, ...(catalogRevision === undefined ? {} : { revision: catalogRevision }) }) })
  reset.addEventListener('click', () => { if (busy === undefined && draft !== undefined && window.confirm(copy.resetConfirm)) runRequest({ reset: true }) })
  minimal.addEventListener('click', () => {
    if (busy !== undefined || draft === undefined) return
    const target = new Set(clientModuleMinimalExclusion(draft.entries))
    const excludedRows = draft.entries.filter(entry => target.has(entry.id))
    const excludedBytes = excludedRows.reduce((sum, entry) => sum + (entry.gzipBytes ?? entry.bytes ?? 0), 0)
    const detail = copy.minimalDetail
      .replace('{count}', String(excludedRows.length))
      .replace('{size}', excludedBytes > 0 ? formatClientModuleSize({ id: '', required: false, dependencies: [], gzipBytes: excludedBytes }) ?? '—' : '—')
    if (!window.confirm(`${copy.minimalConfirm}\n\n${detail}`)) return
    if (draft.applyMinimalSelection()) { renderList(); search.focus({ preventScroll: true }) }
    updateControls()
  })
  measure.addEventListener('click', () => {
    if (busy === 'measure') measurementController?.abort()
    else if (busy === undefined && draft !== undefined) runRequest({ measure: true })
  })
  reread.addEventListener('click', () => { if (busy === undefined && ((draft?.changeCount ?? 0) === 0 || window.confirm(copy.reloadConfirm))) runRequest() })
  const dispose = (): void => {
    if (disposed) return
    disposed = true; ++generation; controller.abort(); measurementController?.abort(); openDialogs.delete(openDialog); window.removeEventListener('dsh-mobile:native-back', onBack, true); window.removeEventListener('keydown', onEscape, true); if (dialog.open) dialog.close(); dialog.remove()
    if (trigger?.isConnected) trigger.focus({ preventScroll: true })
  }
  const requestClose = (): void => {
    if (disposed) return
    if (unconfirmedWrite && !window.confirm(copy.savingCloseConfirm)) return
    if (!unconfirmedWrite && (draft?.changeCount ?? 0) > 0 && !window.confirm(copy.discardConfirm)) return
    dispose()
  }
  const onBack = (event: Event): void => {
    if (!event.cancelable || !dialog.open || event.defaultPrevented || [...openDialogs].at(-1) !== openDialog) return
    event.preventDefault(); event.stopImmediatePropagation(); requestClose()
  }
  // Own Escape before the stock settings listener closes the layer underneath.
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || event.isComposing || event.ctrlKey || event.altKey || event.metaKey
      || event.defaultPrevented || !dialog.open || [...openDialogs].at(-1) !== openDialog) return
    event.preventDefault(); event.stopImmediatePropagation(); requestClose()
  }
  const openDialog = { dispose, requestClose }
  openDialogs.add(openDialog); window.addEventListener('dsh-mobile:native-back', onBack, true)
  window.addEventListener('keydown', onEscape, true)
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose() })
  dialog.addEventListener('close', dispose, { once: true }); close.addEventListener('click', requestClose)
  document.body.append(dialog); dialog.showModal(); runRequest()
}

/** Settings row used on mobile pages and on the computer's General settings.
 * @param props - Selection scope and current locale.
 * @returns A native-style General settings row.
 */
export function ClientModuleSettingsRow(props: { readonly scope: 'computer' | 'device'; readonly locale: MobileControlLocale }): ReactElement {
  const copy = CLIENT_MODULE_COPY[props.locale]
  return createElement('div', { className: 'dsh-module-row', lang: props.locale },
    createElement('div', { className: 'dsh-module-rowText' }, createElement('div', { className: 'dsh-module-title' }, copy.title), createElement('div', { className: 'dsh-module-description' }, copy[props.scope])),
    createElement('button', { type: 'button', className: 'dsh-module-button', onClick: (event: { currentTarget: HTMLElement }) => { openClientModuleSettings(props.scope, props.locale, event.currentTarget) } }, copy.open),
  )
}
