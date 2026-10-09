/** Local desktop controls for explicitly restarting an unavailable extension worker. */

interface UnavailableExtensionHost {
  readonly id: string
  readonly name: string
  readonly generation: string
}

/** Validate the Host response and select only stopped workers, never in-process hosts. */
export function parseUnavailableExtensionHosts(payload: unknown): readonly UnavailableExtensionHost[] | undefined {
  if (typeof payload !== 'object' || payload === null || !('hosts' in payload) || !Array.isArray(payload.hosts)) return undefined
  const ids = new Set<string>()
  const hosts: UnavailableExtensionHost[] = []
  for (const value of payload.hosts) {
    if (typeof value !== 'object' || value === null) return undefined
    const entry = value as { id?: unknown; name?: unknown; mode?: unknown; state?: unknown; generation?: unknown }
    if (typeof entry.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(entry.id) || ids.has(entry.id)
      || typeof entry.name !== 'string' || entry.name.trim() === ''
      || (entry.mode !== 'worker' && entry.mode !== 'in-process') || (entry.state !== 'ready' && entry.state !== 'unavailable')
      || typeof entry.generation !== 'string' || !/^[a-f\d]{64}$/u.test(entry.generation)) return undefined
    ids.add(entry.id)
    if (entry.mode === 'worker' && entry.state === 'unavailable') hosts.push({ id: entry.id, name: entry.name, generation: entry.generation })
  }
  return hosts
}

interface ExtensionRecoveryOptions {
  readonly document: Document
  readonly signal: AbortSignal
  readonly request: (path: string, init?: RequestInit) => Promise<unknown>
  readonly confirm: (message: string) => boolean
  readonly translate: (key: string, values?: Record<string, string | number>) => string
}

/** One section shared across desktop access views; recovery is never automatic. */
export function installExtensionRecoveryControl(options: ExtensionRecoveryOptions): {
  readonly section: HTMLElement
  readonly refresh: () => Promise<void>
  readonly dispose: () => void
} {
  const { document, signal, request, confirm, translate: t } = options
  const section = document.createElement('section'); section.className = 'dsh-mobile-control__extension-recovery'; section.hidden = true
  section.setAttribute('aria-label', t('extensionRecoveryTitle'))
  const title = document.createElement('h3'); title.textContent = t('extensionRecoveryTitle')
  const help = document.createElement('p'); help.textContent = t('extensionRecoveryHelp')
  const list = document.createElement('ul')
  const feedback = document.createElement('p'); feedback.className = 'dsh-mobile-control__extension-recovery-error'; feedback.hidden = true; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite')
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'dsh-mobile-control__secondary'; retry.textContent = t('extensionRecoveryRefresh'); retry.hidden = true
  section.append(title, help, list, feedback, retry)
  const rows = new Map<string, { readonly row: HTMLLIElement; readonly name: HTMLElement; readonly id: HTMLElement; readonly button: HTMLButtonElement }>()
  let hosts: readonly UnavailableExtensionHost[] = []
  let busyId: string | undefined
  let errorText = ''
  let errorSource: 'load' | 'recover' | undefined
  let revision = 0
  let reading = false
  let refreshPending = false
  let disposed = false
  const live = (): boolean => !disposed && !signal.aborted
  const render = (): void => {
    if (!live()) return
    section.hidden = hosts.length === 0
    section.setAttribute('aria-busy', String(busyId !== undefined))
    for (const [id, entry] of rows) {
      if (hosts.some(host => host.id === id)) continue
      entry.row.remove(); rows.delete(id)
    }
    for (const host of hosts) {
      let entry = rows.get(host.id)
      if (entry === undefined) {
        const row = document.createElement('li')
        const text = document.createElement('div')
        const name = document.createElement('strong')
        const id = document.createElement('code')
        const button = document.createElement('button'); button.type = 'button'; button.className = 'dsh-mobile-control__secondary'; button.dataset.extensionRecoveryId = host.id
        button.addEventListener('click', () => { void recover(host.id) })
        text.append(name, id); row.append(text, button); list.append(row)
        entry = { row, name, id, button }; rows.set(host.id, entry)
      }
      entry.name.textContent = host.name; entry.id.textContent = host.id
      entry.button.disabled = busyId !== undefined
      entry.button.textContent = t(busyId === host.id ? 'extensionRecoveryRestarting' : 'extensionRecoveryRestart')
      entry.button.setAttribute('aria-label', t('extensionRecoveryRestartAria', { name: host.name }))
    }
    feedback.hidden = errorText === ''; feedback.textContent = errorText
    retry.hidden = errorText === ''; retry.disabled = reading || busyId !== undefined
  }
  const accept = (payload: unknown, recovered = false): void => {
    const parsed = parseUnavailableExtensionHosts(payload)
    if (parsed === undefined) throw new Error('extension_recovery_invalid_response')
    hosts = parsed
    if (recovered || hosts.length === 0 || errorSource === 'load') { errorText = ''; errorSource = undefined }
    render()
  }
  const refresh = async (): Promise<void> => {
    if (!live()) return
    if (reading || busyId !== undefined) { refreshPending = true; return }
    reading = true
    const current = ++revision
    render()
    try {
      const payload = await request('/api/mobile-access/extensions/hosts')
      if (live() && current === revision) accept(payload)
    } catch (_error) {
      // Older Hosts may lack this optional route. Keep it unobtrusive unless
      // a previously known stopped worker needs an actionable retry.
      if (live() && current === revision && hosts.length > 0 && errorSource !== 'recover') { errorText = t('extensionRecoveryLoadFailed'); errorSource = 'load' }
    } finally {
      reading = false
      if (live()) {
        render()
        if (refreshPending && busyId === undefined) { refreshPending = false; await refresh() }
      }
    }
  }
  const recover = async (id: string): Promise<void> => {
    const host = hosts.find(entry => entry.id === id)
    if (!live() || busyId !== undefined || host === undefined || !confirm(t('extensionRecoveryConfirm', { name: host.name }))) return
    if (!live()) return
    busyId = id; errorText = ''; errorSource = undefined; const current = ++revision; render()
    try {
      const payload = await request('/api/mobile-access/extensions/recover', { method: 'POST', body: JSON.stringify({ id, confirm: true }) })
      if (live() && current === revision) accept(payload, true)
    } catch (error) {
      if (live() && current === revision) {
        errorText = t(error instanceof Error && error.message === 'extension_changed_during_activation' ? 'extensionRecoveryChanged' : 'extensionRecoveryFailed')
        errorSource = 'recover'
      }
    } finally {
      busyId = undefined
      if (live()) {
        render()
        if (refreshPending && !reading) { refreshPending = false; await refresh() }
      }
    }
  }
  retry.addEventListener('click', () => { errorText = ''; errorSource = undefined; void refresh() })
  return { section, refresh, dispose: () => { disposed = true; revision++; section.remove(); rows.clear() } }
}

/** Theme-owned compact recovery rows; normal connection views keep their layout. */
export const EXTENSION_RECOVERY_STYLES = `
.dsh-mobile-control__extension-recovery{margin:0 0 14px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}
.dsh-mobile-control__extension-recovery[hidden]{display:none}
.dsh-mobile-control__extension-recovery h3{margin:0 0 6px;font-size:13px;line-height:1.5;font-weight:600}
.dsh-mobile-control__extension-recovery p{margin:0 0 8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsh-mobile-control__extension-recovery ul{list-style:none;margin:0;padding:0}
.dsh-mobile-control__extension-recovery li{display:flex;align-items:center;gap:12px;padding:6px 0}
.dsh-mobile-control__extension-recovery li>div{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;overflow-wrap:anywhere}
.dsh-mobile-control__extension-recovery strong{font-size:12px;line-height:1.5}
.dsh-mobile-control__extension-recovery code{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.dsh-mobile-control__extension-recovery button{flex:none;box-sizing:border-box;min-height:48px;min-width:48px;white-space:normal}
.dsh-mobile-control__extension-recovery button:disabled{cursor:wait;opacity:.55}
.dsh-mobile-control__extension-recovery button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mobile-control__extension-recovery button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover))}
.dsh-mobile-control__extension-recovery .dsh-mobile-control__extension-recovery-error{color:var(--dsw-alias-label-primary)}
`
