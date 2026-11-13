/** Tap-to-copy for the stock preview header path on touch devices.
 *
 * Taps land on `PathLabel`'s nested directory/name spans, so the titled owner is
 * resolved through `closest()`; the changes-review file switcher keeps its own tap.
 */

/** The repository's shared touch predicate; kept identical to `TOUCH_PRIMARY_QUERY` (mobile-layout.ts)
 * and `BROWSER_TOUCH_PRIMARY_QUERY` (native-mobile.ts) by a source drift test. */
export const PATH_COPY_TOUCH_QUERY = '(hover: none), (pointer: coarse)'

/** Stock-DSH element whose `title` carries the path shown to the user: the preview
 * header path bar. The presented-file card is deliberately NOT a target — its tap
 * stays a pure open action, so opening a file never replaces the clipboard. */
export const PATH_COPY_TARGET_SELECTOR = '[data-textpreview-path]'

/** The changes-review pane: its header path is a file-switcher menu, never a copy target. */
export const PATH_COPY_REVIEW_SCOPE = '[data-changes-review]'

/** Replace `{path}` in a localized toast template with the copied value. */
export function formatPathCopyMessage(template: string, path: string): string {
  return template.replaceAll('{path}', path)
}

/** The `title` of a copy target, verbatim — trailing spaces are legal in file names —
 * or `undefined` when the attribute is absent or blank (blankness judged after trimming). */
export function pathCopyText(element: { getAttribute(name: 'title'): string | null }): string | undefined {
  const title = element.getAttribute('title')
  const blank = title?.trim()
  return title !== null && blank !== undefined && blank !== '' ? title : undefined
}

/** Anything element-shaped: Node tests stub this, the browser supplies the real Element. */
interface ClosestCarrier { closest(selector: string): Element | null }

function isClosestCarrier(value: unknown): value is ClosestCarrier {
  return typeof (value as ClosestCarrier | null)?.closest === 'function'
}

/** Resolve the copy target owning the tapped node: the titled ancestor outside the review scope.
 * @param target - an event target; non-elements resolve to `null`.
 * @returns the element whose `title` to copy, or `null` when the tap is not a copy target. */
export function pathCopyOwner(target: unknown): Element | null {
  if (!isClosestCarrier(target)) return null
  const owner = target.closest(PATH_COPY_TARGET_SELECTOR)
  if (owner === null) return null
  if (target.closest(PATH_COPY_REVIEW_SCOPE) !== null) return null
  return pathCopyText(owner) === undefined ? null : owner
}

/** Clipboard operations the copy path needs; fakes stand in for Node tests. */
export interface CopyIo {
  /** The async clipboard API write, or a rejection standing in for its absence. */
  writeText(text: string): Promise<void>
  /** The `execCommand` fallback; returns whether the copy was accepted. */
  execCopy(value: string): boolean
}

/** Copy through the API, falling back to `execCopy`; resolves, never rejects.
 * @param text - the value to place on the clipboard.
 * @param io - the clipboard operations to use.
 * @returns whether the value reached the clipboard by either route. */
export async function copyPathText(text: string, io: CopyIo): Promise<boolean> {
  try {
    await io.writeText(text)
    return true
  } catch {
    try {
      return io.execCopy(text)
    } catch {
      return false
    }
  }
}

/** Build the browser clipboard adapter for one document.
 *
 * `writeText` delegates to `navigator.clipboard` when present and rejects otherwise, so
 * {@link copyPathText} routes to the fallback. `execCopy` copies through an off-screen but
 * rendered readonly textarea — `display:none` is not a reliable copy source — and restores
 * focus, selection, and scroll on every path.
 * @param document - the document that will host the fallback textarea.
 * @returns the adapter bound to that document and this window's navigator. */
export function domCopyIo(document: Document): CopyIo {
  return {
    writeText: (text: string) => {
      const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?(text: string): Promise<void> } } }).navigator?.clipboard
      if (clipboard?.writeText === undefined) return Promise.reject(new Error('clipboard api unavailable'))
      return clipboard.writeText(text)
    },
    execCopy: (value: string): boolean => {
      const activeElement = document.activeElement
      const selection = document.getSelection()
      const savedRanges = selection === null ? [] : Array.from({ length: selection.rangeCount }, (_, at) => selection.getRangeAt(at).cloneRange())
      const root = document.documentElement
      // Focus restoration can scroll the document and every scrollable ancestor of
      // the focused element, so their positions are saved and restored after focus.
      const scrollOwners: Array<Element> = [root]
      for (let node: Element | null = activeElement; node !== null && node !== root; node = node.parentElement ?? null) scrollOwners.push(node)
      const savedScroll = scrollOwners.map(owner => ({ owner, top: owner.scrollTop, left: owner.scrollLeft }))
      const area = document.createElement('textarea')
      area.value = value
      area.readOnly = true
      area.style.position = 'fixed'
      area.style.left = '-9999px'
      document.body.appendChild(area)
      try {
        area.select()
        return document.execCommand('copy')
      } catch {
        return false
      } finally {
        document.body.removeChild(area)
        if (selection !== null) {
          selection.removeAllRanges()
          for (const range of savedRanges) selection.addRange(range)
        }
        if (activeElement !== null) (activeElement as { focus?: (options?: { preventScroll?: boolean }) => void }).focus?.({ preventScroll: true })
        for (const { owner, top, left } of savedScroll) {
          owner.scrollTop = top
          owner.scrollLeft = left
        }
      }
    },
  }
}

/** The transient confirmation toast; visible at every viewport width via NATIVE_MOBILE_STYLES. */
export interface PathCopyToast {
  /** Set the message and show it, restarting the single hide timer. */
  show(message: string): void
  /** The hosted status element. */
  readonly node: HTMLElement
  /** Clear the timer and remove the element. */
  dispose(): void
}

/** Host the copy confirmation toast on one document.
 * @param document - the document whose body hosts the toast.
 * @returns the toast handle. */
export function createPathCopyToast(document: Document): PathCopyToast {
  const node = document.createElement('div')
  node.className = 'dsh-mobile-path-toast'
  node.setAttribute('role', 'status')
  node.setAttribute('aria-live', 'polite')
  ;(node as { lang?: string }).lang = document.documentElement.lang
  document.body.appendChild(node)
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    node,
    show(message: string): void {
      node.textContent = message
      node.setAttribute('data-visible', 'true')
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        node.removeAttribute('data-visible')
        timer = undefined
      }, 2200)
    },
    dispose(): void {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      node.removeAttribute('data-visible')
      document.body.removeChild(node)
    },
  }
}

/** Localized toast templates for the copy outcome. */
export interface PathCopyLabels { readonly copied: string; readonly failed: string }

/** Installer inputs; the io and document shapes allow Node-test fakes. */
export interface MobilePathCopyDeps {
  readonly document: Document
  /** Whether the touch predicate currently matches; evaluated per tap. */
  readonly isTouchPrimary: () => boolean
  readonly labels: PathCopyLabels
  /** Clipboard adapter override for tests; defaults to the document's own. */
  readonly io?: CopyIo
}

/** Install the delegated tap-to-copy listener and its toast.
 *
 * The listener neither prevents nor stops propagation: the preview header keeps its
 * own focus behavior, and taps on other elements keep their own actions. Disposal
 * stops new copies, cancels the fallback of a still-pending write, and drops a
 * completion that lands after disposal.
 * @param deps - document, touch gate, localized templates, optional clipboard adapter.
 * @returns the disposer. */
export function installMobilePathCopy(deps: MobilePathCopyDeps): () => void {
  const source = deps.io ?? domCopyIo(deps.document)
  const toast = createPathCopyToast(deps.document)
  let disposed = false
  const io: CopyIo = {
    writeText: (text: string) => source.writeText(text),
    execCopy: (value: string) => (disposed ? false : source.execCopy(value)),
  }
  const onClick = (event: { target: unknown }): void => {
    if (disposed || !deps.isTouchPrimary()) return
    const owner = pathCopyOwner(event.target)
    if (owner === null) return
    const path = pathCopyText(owner)
    if (path === undefined) return
    void copyPathText(path, io).then(ok => {
      if (disposed) return
      toast.show(formatPathCopyMessage(ok ? deps.labels.copied : deps.labels.failed, path))
    })
  }
  deps.document.addEventListener('click', onClick)
  return () => {
    disposed = true
    deps.document.removeEventListener('click', onClick)
    toast.dispose()
  }
}
