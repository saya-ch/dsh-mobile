import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  PATH_COPY_REVIEW_SCOPE, PATH_COPY_TARGET_SELECTOR, PATH_COPY_TOUCH_QUERY,
  type CopyIo, copyPathText, createPathCopyToast, domCopyIo, installMobilePathCopy,
  formatPathCopyMessage, pathCopyOwner, pathCopyText,
} from '../src/mobile-path-copy.js'

/** An element-shaped recording stub: closest() answers from a per-selector table and records calls. */
function recordingTarget(answers: Partial<Record<string, object | null>>): { target: unknown; calls: string[] } {
  const calls: string[] = []
  const target = {
    closest(selector: string): object | null { calls.push(selector); return answers[selector] ?? null },
  }
  return { target, calls }
}

function titledElement(title: string | null): { getAttribute(name: 'title'): string | null } {
  return { getAttribute: (name: 'title') => name === 'title' ? title : null }
}

describe('formatPathCopyMessage', () => {
  it('substitutes {path}', () => {
    expect(formatPathCopyMessage('Copied: {path}', 'topics/x/report.md')).toBe('Copied: topics/x/report.md')
  })
  it('inserts a path containing replacement patterns literally', () => {
    for (const path of ['a$&b.md', "a$'b.md", 'a$`b.md', 'a$1b.md', 'a$$b.md']) {
      expect(formatPathCopyMessage('Copied: {path}', path)).toBe(`Copied: ${path}`)
    }
  })
})

describe('pathCopyText', () => {
  it('returns a nonblank title verbatim, preserving legal trailing whitespace', () => {
    expect(pathCopyText(titledElement('  /tmp/report.md '))).toBe('  /tmp/report.md ')
  })
  it('returns undefined for missing title', () => {
    expect(pathCopyText(titledElement(null))).toBeUndefined()
  })
  it('returns undefined for empty title', () => {
    expect(pathCopyText(titledElement(''))).toBeUndefined()
  })
  it('returns undefined for whitespace-only title', () => {
    expect(pathCopyText(titledElement('   '))).toBeUndefined()
  })
})

describe('pathCopyOwner', () => {
  it('returns the resolved owner element for a matching ancestor', () => {
    const owner = titledElement('/abs/report.md')
    const { target, calls } = recordingTarget({ [PATH_COPY_TARGET_SELECTOR]: owner })
    expect(pathCopyOwner(target)).toBe(owner)
    expect(calls[0]).toBe(PATH_COPY_TARGET_SELECTOR)
  })
  it('checks the review scope after resolving an owner', () => {
    const owner = titledElement('/abs/report.md')
    const { target, calls } = recordingTarget({ [PATH_COPY_TARGET_SELECTOR]: owner, [PATH_COPY_REVIEW_SCOPE]: {} })
    expect(pathCopyOwner(target)).toBeNull()
    expect(calls).toEqual([PATH_COPY_TARGET_SELECTOR, PATH_COPY_REVIEW_SCOPE])
  })
  it('returns null when no owner resolves', () => {
    const { target, calls } = recordingTarget({})
    expect(pathCopyOwner(target)).toBeNull()
    expect(calls).toEqual([PATH_COPY_TARGET_SELECTOR])
  })
  it('returns null when the owner has no copyable title', () => {
    const owner = titledElement('   ')
    const { target } = recordingTarget({ [PATH_COPY_TARGET_SELECTOR]: owner })
    expect(pathCopyOwner(target)).toBeNull()
  })
  it('returns null for non-element targets', () => {
    expect(pathCopyOwner(null)).toBeNull()
    expect(pathCopyOwner(undefined)).toBeNull()
    expect(pathCopyOwner({})).toBeNull()
    expect(pathCopyOwner('span')).toBeNull()
  })
})

describe('copyPathText', () => {
  const fakeIo = (over: Partial<CopyIo>): CopyIo => ({
    writeText: over.writeText ?? (() => Promise.resolve()),
    execCopy: over.execCopy ?? (() => false),
  })
  it('resolves true on api success', async () => {
    await expect(copyPathText('p', fakeIo({ writeText: () => Promise.resolve() }))).resolves.toBe(true)
  })
  it('falls back when api rejects', async () => {
    const execCopy = vi.fn(() => true)
    await expect(copyPathText('p', fakeIo({ writeText: () => Promise.reject(new Error('no')), execCopy }))).resolves.toBe(true)
    expect(execCopy).toHaveBeenCalledWith('p')
  })
  it('falls back when writeText is missing', async () => {
    const io = { execCopy: () => true } as unknown as CopyIo
    await expect(copyPathText('p', io)).resolves.toBe(true)
  })
  it('returns false when both fail without throwing', async () => {
    const io = fakeIo({ writeText: () => Promise.reject(new Error('no')), execCopy: () => false })
    await expect(copyPathText('p', io)).resolves.toBe(false)
  })
  it('returns false when the fallback throws instead of returning', async () => {
    const io = fakeIo({ writeText: () => Promise.reject(new Error('no')), execCopy: () => { throw new Error('SecurityError') } })
    await expect(copyPathText('p', io)).resolves.toBe(false)
  })
})

/** A recording DOM stand-in: enough surface for domCopyIo's textarea fallback. */
function fakeDocument(execResult: boolean): {
  document: Document
  textarea: { style: Record<string, string>; readOnly: boolean; select: ReturnType<typeof vi.fn>; value: string }
  appended: unknown[]
  removed: unknown[]
  execCommand: ReturnType<typeof vi.fn>
  focusPrior: ReturnType<typeof vi.fn>
  addRange: ReturnType<typeof vi.fn>
} {
  const textarea = { style: {} as Record<string, string>, readOnly: false, value: '', select: vi.fn(() => { documentElement.scrollTop = 42 }) }
  const appended: unknown[] = []
  const removed: unknown[] = []
  const execCommand = vi.fn(() => execResult)
  const focusPrior = vi.fn()
  const addRange = vi.fn()
  const documentElement = { scrollLeft: 0, scrollTop: 0 }
  const priorElement = { focus: vi.fn((options?: { preventScroll?: boolean }) => {
    focusPrior(options)
    // A focus that ignores preventScroll and scrolls anyway, like the reviewer's probe.
    if (options?.preventScroll !== true) documentElement.scrollTop = 1112
  }) }
  const savedRange = { cloneRange: () => savedRange }
  const document = {
    createElement: () => textarea,
    body: { appendChild: (el: unknown) => appended.push(el), removeChild: (el: unknown) => removed.push(el) },
    execCommand,
    activeElement: priorElement as unknown as Element | null,
    documentElement,
    getSelection: () => ({ rangeCount: 1, getRangeAt: () => savedRange, removeAllRanges: vi.fn(), addRange }),
  } as unknown as Document
  return { document, textarea, appended, removed, execCommand, focusPrior, addRange }
}

describe('domCopyIo execCopy', () => {
  it('uses an off-screen rendered readonly textarea', () => {
    const fake = fakeDocument(true)
    domCopyIo(fake.document).execCopy('p')
    expect(fake.textarea.style.position).toBe('fixed')
    expect(fake.textarea.style.left).toBe('-9999px')
    expect(fake.textarea.readOnly).toBe(true)
  })
  it('copies, removes the textarea, and reports success', () => {
    const fake = fakeDocument(true)
    expect(domCopyIo(fake.document).execCopy('p')).toBe(true)
    expect(fake.execCommand).toHaveBeenCalledWith('copy')
    expect(fake.appended).toHaveLength(1)
    expect(fake.removed).toEqual(fake.appended)
  })
  it('removes the textarea even when execCommand fails and reports false', () => {
    const fake = fakeDocument(false)
    expect(domCopyIo(fake.document).execCopy('p')).toBe(false)
    expect(fake.appended).toHaveLength(1)
    expect(fake.removed).toEqual(fake.appended)
  })
  it('removes the textarea, restores state, and reports false when execCommand throws', () => {
    const fake = fakeDocument(true)
    fake.execCommand.mockImplementation(() => { throw new Error('SecurityError') })
    expect(domCopyIo(fake.document).execCopy('p')).toBe(false)
    expect(fake.appended).toHaveLength(1)
    expect(fake.removed).toEqual(fake.appended)
    expect(fake.focusPrior).toHaveBeenCalled()
    expect(fake.document.documentElement.scrollTop).toBe(0)
  })
  it('restores prior focus, selection, and scroll', () => {
    const fake = fakeDocument(true)
    domCopyIo(fake.document).execCopy('p')
    expect(fake.focusPrior).toHaveBeenCalledWith(expect.objectContaining({ preventScroll: true }))
    expect(fake.addRange).toHaveBeenCalled()
    expect(fake.document.documentElement.scrollTop).toBe(0)
  })
})

describe('domCopyIo writeText routing', () => {
  it('delegates to navigator.clipboard.writeText when present', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    try {
      await domCopyIo(fakeDocument(true).document).writeText('p')
      expect(writeText).toHaveBeenCalledWith('p')
    } finally { vi.unstubAllGlobals() }
  })
  it('rejects when the clipboard api is absent, routing to the fallback', async () => {
    vi.stubGlobal('navigator', {})
    try {
      await expect(domCopyIo(fakeDocument(true).document).writeText('p')).rejects.toBeTruthy()
    } finally { vi.unstubAllGlobals() }
  })
})

/** Flush the microtask queue so async copy results reach the toast. */
async function flush(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve() }

/** A toast node stand-in with attribute and text recording. */
function fakeNode(): { node: HTMLElement; attrs: Record<string, string>; text: string } {
  const attrs: Record<string, string> = {}
  const node = {
    className: '', textContent: '',
    setAttribute: (k: string, v: string) => { attrs[k] = v },
    removeAttribute: (k: string) => { delete attrs[k] },
  }
  return { node: node as unknown as HTMLElement, attrs, text: '' }
}

/** A document stand-in capturing the delegated listener and hosting toast nodes. */
function listenerDocument(): {
  document: Document
  clicks: Array<{ target: unknown }>
  handler: (event: { target: unknown }) => void
  body: { appended: unknown[]; removed: unknown[] }
} {
  let handler: ((event: { target: unknown }) => void) | undefined
  const body = { appended: [] as unknown[], removed: [] as unknown[] }
  const document = {
    addEventListener: (type: string, listener: (event: { target: unknown }) => void) => { if (type === 'click') handler = listener },
    removeEventListener: () => { handler = undefined },
    createElement: () => fakeNode().node,
    body: { appendChild: (el: unknown) => body.appended.push(el), removeChild: (el: unknown) => body.removed.push(el) },
    getSelection: () => null,
    activeElement: null,
    documentElement: { scrollLeft: 0, scrollTop: 0 },
    execCommand: () => false,
  } as unknown as Document
  return { document, clicks: [], handler: (event) => handler?.(event), body }
}

function ownerStub(title: string): unknown {
  return { getAttribute: (name: string) => name === 'title' ? title : null }
}

function tapTarget(owner: unknown, reviewScope: unknown = null): unknown {
  return { closest: (selector: string) => selector.includes('changes-review') ? reviewScope : owner }
}

describe('createPathCopyToast', () => {
  it('shows, resets its timer on a second show, and hides after 2200ms', () => {
    vi.useFakeTimers()
    try {
      const harness = listenerDocument()
      const toast = createPathCopyToast(harness.document)
      const node = harness.body.appended[0] as unknown as { textContent: string; setAttribute(k: string, v: string): void; removeAttribute(k: string): void }
      const attrs: Record<string, string> = {}
      node.setAttribute = (k: string, v: string) => { attrs[k] = v }
      node.removeAttribute = (k: string) => { delete attrs[k] }
      toast.show('Copied: a.md')
      expect(node.textContent).toBe('Copied: a.md')
      expect(attrs['data-visible']).toBe('true')
      vi.advanceTimersByTime(1500)
      toast.show('Copied: b.md')
      expect(node.textContent).toBe('Copied: b.md')
      vi.advanceTimersByTime(1000)
      expect(attrs['data-visible']).toBe('true')
      vi.advanceTimersByTime(1200)
      expect(attrs['data-visible']).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('dispose clears the timer and removes the node', () => {
    vi.useFakeTimers()
    try {
      const harness = listenerDocument()
      const toast = createPathCopyToast(harness.document)
      toast.show('Copied: a.md')
      toast.dispose()
      expect(harness.body.removed).toEqual(harness.body.appended)
      vi.advanceTimersByTime(5000)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})

describe('installMobilePathCopy', () => {
  const labels = { copied: 'Copied: {path}', failed: 'Could not copy the path.' }
  const deferred = <T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } => {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  it('copies and toasts the resolved owner title (synthetic isTouchPrimary gate)', async () => {
    const harness = listenerDocument()
    const io: CopyIo = { writeText: () => Promise.resolve(), execCopy: () => false }
    const dispose = installMobilePathCopy({ document: harness.document, isTouchPrimary: () => true, labels, io })
    harness.handler({ target: tapTarget(ownerStub('  /abs/report.md ')) })
    await flush()
    const node = harness.body.appended[harness.body.appended.length - 1] as unknown as { textContent: string }
    expect(node.textContent).toBe('Copied:   /abs/report.md ')
    expect(io.writeText).toBeDefined()
    dispose()
  })
  it('toasts the failed template when both routes fail', async () => {
    const harness = listenerDocument()
    const dispose = installMobilePathCopy({ document: harness.document, isTouchPrimary: () => true, labels,
      io: { writeText: () => Promise.reject(new Error('no')), execCopy: () => false } })
    harness.handler({ target: tapTarget(ownerStub('p.md')) })
    await flush()
    const node = harness.body.appended[harness.body.appended.length - 1] as unknown as { textContent: string }
    expect(node.textContent).toBe('Could not copy the path.')
    dispose()
  })
  it('is a no-op when not touch primary', async () => {
    const harness = listenerDocument()
    let writes = 0
    const dispose = installMobilePathCopy({ document: harness.document, isTouchPrimary: () => false, labels,
      io: { writeText: () => { writes++; return Promise.resolve() }, execCopy: () => false } })
    harness.handler({ target: tapTarget(ownerStub('p.md')) })
    await flush()
    expect(writes).toBe(0)
    const node = harness.body.appended[harness.body.appended.length - 1] as unknown as { textContent: string }
    expect(node.textContent).toBe('')
    dispose()
  })
  it('is a no-op inside the changes-review scope', async () => {
    const harness = listenerDocument()
    let writes = 0
    const dispose = installMobilePathCopy({ document: harness.document, isTouchPrimary: () => true, labels,
      io: { writeText: () => { writes++; return Promise.resolve() }, execCopy: () => false } })
    harness.handler({ target: tapTarget(ownerStub('p.md'), {}) })
    await flush()
    expect(writes).toBe(0)
    dispose()
  })
  it('is a no-op when the owner title is blank', async () => {
    const harness = listenerDocument()
    let writes = 0
    const dispose = installMobilePathCopy({ document: harness.document, isTouchPrimary: () => true, labels,
      io: { writeText: () => { writes++; return Promise.resolve() }, execCopy: () => false } })
    harness.handler({ target: tapTarget(ownerStub('   ')) })
    await flush()
    expect(writes).toBe(0)
    dispose()
  })
  it('stops copying and removes its toast after dispose', () => {
    const harness = listenerDocument()
    let writes = 0
    const dispose = installMobilePathCopy({ document: harness.document, isTouchPrimary: () => true, labels,
      io: { writeText: () => { writes++; return Promise.resolve() }, execCopy: () => false } })
    const toastNode = harness.body.appended[0]
    dispose()
    harness.handler({ target: tapTarget(ownerStub('p.md')) })
    expect(writes).toBe(0)
    expect(harness.body.removed).toContain(toastNode)
  })
  it('shows no toast and runs no fallback when disposal races a pending write', async () => {
    const harness = listenerDocument()
    const pending = deferred<void>()
    let execCalls = 0
    const dispose = installMobilePathCopy({ document: harness.document, isTouchPrimary: () => true, labels,
      io: { writeText: () => pending.promise, execCopy: () => { execCalls++; return true } } })
    const toastNode = harness.body.appended[0] as unknown as { textContent: string }
    harness.handler({ target: tapTarget(ownerStub('p.md')) })
    dispose()
    pending.resolve()
    await flush()
    expect(toastNode.textContent).toBe('')
    expect(harness.body.removed).toContain(toastNode)
    expect(execCalls).toBe(0)
  })
  it('runs no fallback after disposal when the write rejects late', async () => {
    const harness = listenerDocument()
    const pending = deferred<void>()
    let execCalls = 0
    const dispose = installMobilePathCopy({ document: harness.document, isTouchPrimary: () => true, labels,
      io: { writeText: () => pending.promise, execCopy: () => { execCalls++; return true } } })
    harness.handler({ target: tapTarget(ownerStub('p.md')) })
    dispose()
    pending.reject(new Error('late'))
    await flush()
    expect(execCalls).toBe(0)
  })
  it('a fresh installation after a race still copies', async () => {
    const harness = listenerDocument()
    const pending = deferred<void>()
    const first = installMobilePathCopy({ document: harness.document, isTouchPrimary: () => true, labels,
      io: { writeText: () => pending.promise, execCopy: () => true } })
    harness.handler({ target: tapTarget(ownerStub('p.md')) })
    first()
    pending.resolve()
    await flush()
    const dispose = installMobilePathCopy({ document: harness.document, isTouchPrimary: () => true, labels,
      io: { writeText: () => Promise.resolve(), execCopy: () => false } })
    harness.handler({ target: tapTarget(ownerStub('q.md')) })
    await flush()
    const node = harness.body.appended[harness.body.appended.length - 1] as unknown as { textContent: string }
    expect(node.textContent).toBe('Copied: q.md')
    dispose()
  })
})

describe('touch-query drift guard', () => {
  it('targets only the preview header path — the card stays a pure open action', () => {
    expect(PATH_COPY_TARGET_SELECTOR).toBe('[data-textpreview-path]')
  })
  const literalOf = (file: string, name: string): string => {
    const source = readFileSync(resolve(import.meta.dirname, '..', 'src', file), 'utf8')
    const match = source.match(new RegExp(`(?:export )?const ${name} = '([^']+)'`))
    if (match === null || match[1] === undefined) throw new Error(`${name} literal not found in ${file}`)
    return match[1]
  }
  it('keeps the three touch-query literals identical', () => {
    const layout = literalOf('mobile-layout.ts', 'TOUCH_PRIMARY_QUERY')
    const native = literalOf('native-mobile.ts', 'BROWSER_TOUCH_PRIMARY_QUERY')
    const pathCopy = literalOf('mobile-path-copy.ts', 'PATH_COPY_TOUCH_QUERY')
    expect(new Set([layout, native, pathCopy]).size).toBe(1)
    expect(pathCopy).toBe('(hover: none), (pointer: coarse)')
  })
})
