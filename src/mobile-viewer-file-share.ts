/** Original-file handoff for the paired browser; never uses the active Session or the path label for reads. */
export interface ViewerFile { readonly sessionId: string; readonly path: string }
export interface ViewerStat { readonly bytes?: number | undefined; readonly absolutePath: string; readonly version: string }
export type ViewerStatReader = (file: ViewerFile, signal: AbortSignal) => Promise<ViewerStat>
export const VIEWER_FILE_LIMIT = 8 * 1024 * 1024

/** Only the documented Session-file scope; don't let URL normalization rewrite path segments. */
export function parseViewerAddress(address: string): ViewerFile | undefined {
  const parts = /^dsh-resource:\/\/file\/session\/([^/?#]+)\/([^?#]+)/u.exec(address)
  if (!parts?.[1] || !parts[2]) return undefined
  try { return { sessionId: decodeURIComponent(parts[1]), path: decodeURIComponent(parts[2]) } } catch { return undefined }
}
const mime: Record<string, string> = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mp3: 'audio/mpeg' }

/** Use the existing authenticated complete-read RPC (never ranges). Bound the decoded wire
 * body BEFORE multipart parsing: a file may have grown since stat, and the Host cap is separate. */
export async function readViewerFile(file: ViewerFile, signal: AbortSignal, stat: ViewerStatReader, send: typeof fetch): Promise<File> {
  const before = await stat(file, signal)
  signal.throwIfAborted()
  const size = before.bytes
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0 || size > VIEWER_FILE_LIMIT || !before.version || !before.absolutePath) throw Error('size')
  const rpcId = crypto.randomUUID(), method = 'workspaceFiles/readBytes'
  const response = await send(`/api/${method}`, { method: 'POST', credentials: 'same-origin', redirect: 'error', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { workspaceFileScopeId: file.sessionId, path: file.path, options: {} } } }) })
  const limit = size + 64 * 1024 // room for the RPC metadata and multipart framing only
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('multipart/form-data;') || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel(); throw Error('read')
  }
  const reader = response.body.getReader(), chunks: BlobPart[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read(); signal.throwIfAborted()
      if (part.done) break
      length += part.value.byteLength
      if (length > limit) throw Error('size')
      chunks.push(new Uint8Array(part.value))
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error } finally { reader.releaseLock() }
  const form = await new Response(new Blob(chunks), { headers: { 'content-type': response.headers.get('content-type')! } }).formData()
  const meta = JSON.parse(String(form.get('metadata')))
  const attachment = meta.attachments?.[0], value = meta.result?.value
  if (meta.type !== 'server-response' || meta.rpcId !== rpcId || meta.result?.ok !== true || meta.attachments?.length !== 1 || attachment?.codec !== 'bytes' || attachment.path?.length !== 1 || attachment.path[0] !== 'data' || typeof attachment.part !== 'string' || value?.data !== null || value.offset !== 0 || value.eof !== true || value.bytes !== size || value.version !== before.version || value.absolutePath !== before.absolutePath) throw Error('changed')
  const blob = form.get(attachment.part)
  if (!(blob instanceof Blob) || blob.size !== size) throw Error('changed')
  signal.throwIfAborted()
  const name = file.path.split('/').pop()
  if (!name) throw Error('name')
  return new File([blob], name, { type: mime[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream' })
}

export type ShareStage = 'reading' | 'ready' | 'sharing' | 'failed' | 'size'
interface BrowserHandoff {
  read(signal: AbortSignal): Promise<File>; current(): boolean; active(): boolean; canShare(file: File): boolean
  share(file: File): Promise<void>; state(stage: ShareStage): void; done(): void
}
/** One menu owns one read and at most one prepared File. The ready branch enters share synchronously. */
export function browserHandoff(io: BrowserHandoff) {
  const controller = new AbortController()
  let prepared: File | undefined, timer: ReturnType<typeof setTimeout> | undefined, busy = false
  let expiresAt = 0
  function dispose() { controller.abort(); clearTimeout(timer); prepared = undefined }
  function expire() { dispose(); io.done() }
  const live = () => !controller.signal.aborted && io.current()
  async function choose() {
    if (busy || !live()) return
    busy = true
    try {
      if (!prepared) {
        io.state('reading'); const file = await io.read(controller.signal)
        if (!live()) return
        if (!io.canShare(file)) throw Error('unsupported')
        prepared = file
        if (!io.active()) { io.state('ready'); expiresAt = Date.now() + 60_000; timer = setTimeout(expire, 60_000); return }
      } else if (Date.now() >= expiresAt) { expire(); return }
      const file = prepared; prepared = undefined; clearTimeout(timer)
      io.state('sharing'); await io.share(file)
      if (live()) { dispose(); io.done() }
    } catch (error) {
      if (live()) {
        if (error instanceof Error && error.name === 'AbortError') { dispose(); io.done() }
        else io.state(error instanceof Error && error.message === 'size' ? 'size' : 'failed')
      }
    } finally { busy = false }
  }
  return { choose, dispose }
}
