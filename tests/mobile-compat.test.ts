import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { createContext, runInContext, type Context } from 'node:vm'
import { build } from 'tsdown'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mobileCompatibilityBuild } from '../tsdown.config.js'
import { ensureMobileCompatibility, MOBILE_COMPAT_PATH, mobileCompatibilityRevision, mobileCompatibilityRevisionPath } from '../src/mobile-compat-bootstrap.js'

let directory: string
let bundle: string
let nativeShim: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-compat-'))
  await build({ ...mobileCompatibilityBuild, config: false, outDir: directory, sourcemap: false })
  bundle = await readFile(join(directory, 'mobile-compat.js'), 'utf8')
  const source = await readFile(join(import.meta.dirname, '../apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/WebViewCompatibilityShim.kt'), 'utf8')
  const match = /internal const val BROWSER_COMPATIBILITY_SHIM = """([\s\S]*?)"""/u.exec(source)
  if (match?.[1] === undefined) throw new Error('Android document-start source was not found')
  nativeShim = match[1]
})

afterAll(async () => {
  if (directory === undefined) return
  const withinTemp = relative(tmpdir(), directory)
  if (!withinTemp || withinTemp.startsWith('..') || isAbsolute(withinTemp)) throw new Error('unsafe test cleanup path')
  await rm(directory, { recursive: true, force: true })
})

function legacyPage(options: { missingReason?: boolean } = {}): Context {
  const signal = class PageAbortSignal extends AbortSignal {}
  Object.defineProperty(signal, 'any', { value: undefined, writable: true, configurable: true })
  Object.defineProperty(signal.prototype, 'throwIfAborted', { value: undefined, writable: true, configurable: true })
  for (const name of ['aborted', 'reason']) {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, name)
    if (descriptor === undefined) throw new Error(`Native AbortSignal.${name} getter was not found`)
    Object.defineProperty(signal.prototype, name, descriptor)
  }
  if (options.missingReason) Object.defineProperty(signal.prototype, 'reason', { value: undefined, configurable: true })
  const controller = class PageAbortController extends AbortController {
    constructor() {
      super()
      Object.setPrototypeOf(this.signal, signal.prototype)
    }
  }
  for (const name of ['signal', 'abort']) {
    const descriptor = Object.getOwnPropertyDescriptor(AbortController.prototype, name)
    if (descriptor === undefined) throw new Error(`Native AbortController.${name} was not found`)
    Object.defineProperty(controller.prototype, name, descriptor)
  }
  const page = createContext({ AbortSignal: signal, AbortController: controller, DOMException, Event, EventTarget, URL })
  runInContext('var intrinsicIterator = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); ' +
    'for (var key of Reflect.ownKeys(intrinsicIterator)) { if (key !== Symbol.iterator) delete intrinsicIterator[key]; } ' +
    'delete globalThis.Iterator; delete Promise.withResolvers; ' +
    'delete Object.hasOwn; delete Array.prototype.at; delete String.prototype.at; ' +
    'delete Array.prototype.findLast; delete Array.prototype.findLastIndex; ' +
    'delete Array.prototype.toSorted; delete Array.prototype.toReversed; delete globalThis.structuredClone; ' +
    // The reported regression (#450): assistant text never rendered on an Android 12 WebView
    // because URL.canParse was missing, so the conversation node slot threw while rendering.
    'delete URL.canParse; delete URL.parse;', page)
  return page
}

function load(page: Context): void {
  runInContext(bundle, page, { timeout: 5_000 })
}

describe('early published-client collection APIs', () => {
  it('repairs the observed missing APIs before client code uses them', () => {
    const page = legacyPage()
    for (const expression of ['Object.hasOwn({}, "field")', '[1].at(-1)', '"text".at(-1)', '[1].findLast(Boolean)', '[1].findLastIndex(Boolean)', '[1].toSorted()', '[1].toReversed()', 'structuredClone({})']) {
      expect(() => runInContext(expression, page)).toThrow()
    }
    // #450: this threw inside the conversation node slot, so assistant text never mounted.
    expect(() => runInContext('URL.canParse("https://example.com")', page)).toThrow()
    load(page)
    expect(runInContext('URL.canParse("https://example.com/a?b=1")', page)).toBe(true)
    expect(runInContext('URL.canParse("not a url")', page)).toBe(false)
    expect(runInContext('typeof URL.parse', page)).toBe("function")
    expect(runInContext('URL.parse("https://example.com/a").pathname', page)).toBe("/a")
    expect(runInContext('URL.parse("not a url")', page)).toBe(null)
    expect(runInContext('Object.hasOwn(Object.create({ inherited: true }), "inherited")', page)).toBe(false)
    expect(runInContext('Object.hasOwn(Object.assign(Object.create(null), { field: 1 }), "field")', page)).toBe(true)
    expect(runInContext('[[1, 2, 3].at(-1), [1].at(2), "text".at(-1), "text".at(9)]', page)).toEqual([3, undefined, 't', undefined])
    expect(runInContext('var calls = []; var context = {}; var value = [1, , 3].findLast(function (value, index) { calls.push([value, index, this === context]); return index === 1; }, context); [value, calls]', page)).toEqual([undefined, [[3, 2, true], [undefined, 1, true]]])
    expect(runInContext('Array.prototype.findLast.call({ 0: "old", 1: "new", length: 2 }, Boolean)', page)).toBe('new')
    expect(runInContext('[[1, 2, 3].findLastIndex(value => value < 3), [1].findLastIndex(value => value > 1)]', page)).toEqual([1, -1])
    expect(runInContext('var original = [3, 1, 2]; [original.toSorted((a, b) => a - b), original.toReversed(), original]', page)).toEqual([[1, 2, 3], [2, 1, 3], [3, 1, 2]])
    expect(runInContext('var sparse = [, 1]; [sparse.toSorted(), sparse.toReversed(), 0 in sparse]', page)).toEqual([[1, undefined], [1, undefined], false])
    for (const expression of ['Object.hasOwn(null, "field")', 'Array.prototype.at.call(null, 0)', '[1].findLast(null)', '[1].findLastIndex(null)', '[1].toSorted(null)', 'Array.prototype.toReversed.call(null)']) {
      expect(() => runInContext(expression, page)).toThrow()
    }
    for (const expression of ['Object.getOwnPropertyDescriptor(Object, "hasOwn")', 'Object.getOwnPropertyDescriptor(Array.prototype, "at")', 'Object.getOwnPropertyDescriptor(String.prototype, "at")', 'Object.getOwnPropertyDescriptor(Array.prototype, "findLast")', 'Object.getOwnPropertyDescriptor(Array.prototype, "findLastIndex")', 'Object.getOwnPropertyDescriptor(Array.prototype, "toSorted")', 'Object.getOwnPropertyDescriptor(Array.prototype, "toReversed")']) {
      expect(runInContext(`${expression}.enumerable`, page)).toBe(false)
    }
  })

  it('preserves native implementations and remains stable after repeated loads', () => {
    const page = createContext({})
    const expressions = ['Object.hasOwn', 'Array.prototype.at', 'String.prototype.at', 'Array.prototype.findLast', 'Array.prototype.findLastIndex', 'Array.prototype.toSorted', 'Array.prototype.toReversed']
    const native = expressions.map(expression => runInContext(expression, page))
    load(page)
    load(page)
    expect(expressions.map(expression => runInContext(expression, page))).toEqual(native)
  })

  it('clones settings data without losing cycles, shared references or non-JSON values', () => {
    const page = legacyPage()
    load(page)
    expect(runInContext(`
      var shared = { enabled: true }, input = { left: shared, right: shared, settings: new Map([['date', new Date(0)]]), bytes: new Uint8Array([7, 9]) };
      input.self = input;
      var copy = structuredClone(input);
      copy.left.enabled = false;
      copy.bytes[0] = 1;
      [copy !== input, copy.self === copy, copy.left === copy.right, input.left.enabled, copy.settings.get('date').getTime(), input.bytes[0], copy.bytes[0]];
    `, page)).toEqual([true, true, true, true, 0, 7, 1])
    expect(runInContext('try { structuredClone({ callback() {} }); } catch (error) { error.name; }', page)).toBe('DataCloneError')
    const clone = runInContext('structuredClone', page)
    load(page)
    expect(runInContext('structuredClone', page)).toBe(clone)
  })
})

describe('early WebView Iterator compatibility', () => {
  it('reproduces the missing global and fixes the actual standalone browser bundle without a DSH module loader', () => {
    const page = legacyPage()
    expect(() => runInContext('Iterator.from([1, 2, 3])', page)).toThrow('Iterator is not defined')
    load(page)
    expect(runInContext('typeof Iterator', page)).toBe('function')
    expect(runInContext('typeof __ModuleLoader__', page)).toBe('undefined')
    expect(runInContext('Iterator.from([1, 2, 3, 4]).filter(x => x % 2 === 0).map(x => x * 2).take(2).toArray()', page)).toEqual([4, 8])
    expect(runInContext('Iterator.from([1, 2, 3]).reduce((sum, x) => sum + x, 0)', page)).toBe(6)
    expect(Buffer.byteLength(bundle)).toBeLessThan(256 * 1024)
  })

  it('installs real prototype helpers on built-in iterators and Iterator subclasses', () => {
    const page = legacyPage()
    load(page)
    expect(runInContext('[1, 2, 3].values().map(x => x + 1).toArray()', page)).toEqual([2, 3, 4])
    expect(runInContext('new Map([[1, "a"], [2, "b"]]).values().join("-")', page)).toBe('a-b')
    expect(runInContext('(class extends Iterator { value = 0; next() { return { value: ++this.value, done: false }; } })', page)).toBeTypeOf('function')
    expect(runInContext('new (class extends Iterator { value = 0; next() { return { value: ++this.value, done: false }; } })().take(3).toArray()', page)).toEqual([1, 2, 3])
    expect(runInContext('Object.getOwnPropertyDescriptor(Iterator.prototype, "map").enumerable', page)).toBe(false)
  })

  it('retains lazy evaluation, iterator closing, and callback errors instead of using an Array.from shim', () => {
    const page = legacyPage()
    load(page)
    expect(runInContext('var calls = 0; var lazy = Iterator.from([1, 2, 3]).map(x => { calls++; return x; }); calls', page)).toBe(0)
    expect(runInContext('lazy.next().value', page)).toBe(1)
    expect(runInContext('calls', page)).toBe(1)
    expect(runInContext('var closed = false; function* source() { try { yield 1; yield 2; } finally { closed = true; } } source().take(1).toArray(); closed', page)).toBe(true)
    expect(() => runInContext('Iterator.from([1]).map(() => { throw new Error("callback failed"); }).toArray()', page)).toThrow('callback failed')
    expect(() => runInContext('Iterator.from([]).reduce((a, b) => a + b)', page)).toThrow()
  })

  it('keeps the native constructor while feature-detecting helpers and is safe to load twice', () => {
    const page = createContext({})
    const nativeIterator = runInContext('Iterator', page)
    load(page)
    expect(runInContext('Iterator', page)).toBe(nativeIterator)
    // Older native helpers fail to close on an invalid callback (ECMA-262 #3467).
    // core-js deliberately repairs those helpers; function identity is not the contract.
    expect(runInContext('var closedOnError = false; try { Iterator.prototype.map.call({ next() { return { done: true }; }, return() { closedOnError = true; return { done: true }; } }, -1); } catch (error) { if (!(error instanceof TypeError)) throw error; } closedOnError', page)).toBe(true)
    const installedMap = runInContext('Iterator.prototype.map', page)
    load(page)
    expect(runInContext('Iterator', page)).toBe(nativeIterator)
    expect(runInContext('Iterator.prototype.map', page)).toBe(installedMap)
    expect(runInContext('[1, 2].values().map(x => x * 2).join(",")', page)).toBe('2,4')
  })

  it('runs before even the first DSH boot script and preserves preceding CSP metadata and its nonce', () => {
    const input = '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'nonce-test\'">' +
      '<script nonce="test">globalThis.bootResult = Iterator.from([1, 2]).join(",");</script>' +
      '<script src="/bootstrap.js"></script></head></html>'
    const output = ensureMobileCompatibility(input)
    expect(output).toContain('<script src="' + MOBILE_COMPAT_PATH + '" nonce="test"></script><script nonce="test">')
    expect(output.indexOf('Content-Security-Policy')).toBeLessThan(output.indexOf(MOBILE_COMPAT_PATH))
    expect(output).not.toMatch(/<script[^>]+(?:async|defer)/u)
    expect(ensureMobileCompatibility(output)).toBe(output)
    const page = legacyPage()
    for (const script of output.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)) {
      if (script[1]?.includes(MOBILE_COMPAT_PATH)) load(page)
      else if (script[2]) runInContext(script[2], page)
    }
    expect(runInContext('bootResult', page)).toBe('1,2')
  })

  it('accepts a single-quoted nonce and leaves an index with no script usable', () => {
    expect(ensureMobileCompatibility("<script nonce='test'>boot()</script>")).toContain('nonce="test"></script><script')
    // The bundle is an enhancement: a document it cannot be placed in must still be
    // served, because throwing here took the whole mobile frontend down with a 502.
    const headless = '<html><head><title>no scripts</title></head></html>'
    expect(ensureMobileCompatibility(headless)).toBe(headless)
  })

  it('names the bundle by content and recognises an already-revisioned document', () => {
    const digest = 'a'.repeat(64)
    const revisioned = mobileCompatibilityRevisionPath(digest)
    expect(revisioned).toBe(`/mobile-access/compat-${digest}.js`)
    expect(mobileCompatibilityRevision(revisioned)).toBe(digest)
    expect(mobileCompatibilityRevision(MOBILE_COMPAT_PATH)).toBeUndefined()
    expect(mobileCompatibilityRevision('/mobile-access/compat-abc.js')).toBeUndefined()
    const input = '<html><head><script src="/bootstrap.js"></script></head></html>'
    const output = ensureMobileCompatibility(input, revisioned)
    expect(output).toContain(`<script src="${revisioned}"></script><script src="/bootstrap.js">`)
    // A second pass over a revisioned document must not inject the bundle again.
    expect(ensureMobileCompatibility(output, revisioned)).toBe(output)
    expect(ensureMobileCompatibility(output, MOBILE_COMPAT_PATH)).toBe(output)
  })

  it('never anchors to markup that an HTML comment made inert', () => {
    // Injecting into the comment would place the bundle in text that never runs, so
    // the fix would silently not apply while the page still looked fine.
    const commented = '<!-- <script src="/a.js"></script> --><html><body></body></html>'
    expect(ensureMobileCompatibility(commented)).toBe(commented)
    // With a live script later in the document, that one becomes the anchor instead.
    const mixed = '<!-- <script src="/a.js"></script> --><script src="/b.js"></script>'
    const output = ensureMobileCompatibility(mixed)
    expect(output).toContain(`<script src="/b.js"></script>`)
    expect(output.indexOf(MOBILE_COMPAT_PATH)).toBeGreaterThan(output.indexOf('-->'))
  })

  it('treats an already-injected bundle as present whatever quoting the document uses', () => {
    const single = `<html><script src='${MOBILE_COMPAT_PATH}'></script></html>`
    expect(ensureMobileCompatibility(single)).toBe(single)
    const spaced = `<html><script  src = "${MOBILE_COMPAT_PATH}" ></script></html>`
    expect(ensureMobileCompatibility(spaced)).toBe(spaced)
  })

  it('reads the real nonce instead of text that merely resembles one', () => {
    // A value that contains the attribute text must not be mistaken for the attribute.
    const decoy = `<script title='say nonce="fake"' nonce="real"></script>`
    expect(ensureMobileCompatibility(decoy)).toContain(`<script src="${MOBILE_COMPAT_PATH}" nonce="real"></script>`)
    const after = `<script nonce="real" data-nonce="decoy"></script>`
    expect(ensureMobileCompatibility(after)).toContain(`nonce="real"`)
  })
})

describe('early Promise capabilities', () => {
  for (const mode of ['bundle', 'Android document-start'] as const) {
    const install = (page: Context): void => { runInContext(mode === 'bundle' ? bundle : nativeShim, page) }

    it(`${mode} preserves constructor receivers, settlements and non-enumerable properties`, async () => {
      const page = legacyPage()
      install(page)
      expect(runInContext('class P extends Promise {}; P.withResolvers().promise instanceof P', page)).toBe(true)
      expect(() => runInContext('Promise.withResolvers.call({})', page)).toThrow()
      expect(() => runInContext('Promise.withResolvers.call(function () {})', page)).toThrow()
      expect(() => runInContext('Promise.withResolvers.call(function (executor) { executor(1, 2); })', page)).toThrow()
      expect(runInContext('Object.getOwnPropertyDescriptor(Promise, "withResolvers").enumerable', page)).toBe(false)
      expect(runInContext('Object.getOwnPropertyDescriptor(Promise, "withResolvers").writable', page)).toBe(true)
      await expect(runInContext('var fulfilled = Promise.withResolvers(); fulfilled.resolve(17); fulfilled.promise', page)).resolves.toBe(17)
      await expect(runInContext('var rejected = Promise.withResolvers(); rejected.reject("cancelled"); rejected.promise', page)).rejects.toBe('cancelled')
      const installed = runInContext('Promise.withResolvers', page)
      install(page)
      expect(runInContext('Promise.withResolvers', page)).toBe(installed)
      expect(runInContext('var bootReady = Promise.withResolvers(); typeof bootReady.resolve', page)).toBe('function')
    })

    it(`${mode} leaves native capabilities unchanged`, () => {
      const page = createContext({})
      const native = runInContext('Promise.withResolvers', page)
      install(page)
      expect(runInContext('Promise.withResolvers', page)).toBe(native)
    })
  }
})

describe('early AbortSignal cancellation checks', () => {
  it('repairs missing throwIfAborted before the first DSH cancellation check', () => {
    const page = legacyPage()
    expect(() => runInContext('new AbortController().signal.throwIfAborted()', page)).toThrow('throwIfAborted is not a function')
    load(page)
    expect(runInContext('new AbortController().signal.throwIfAborted()', page)).toBeUndefined()
    expect(runInContext(`
      var source = new AbortController(), reason = {};
      source.abort(reason);
      try { source.signal.throwIfAborted(); } catch (error) { error === reason; }
    `, page)).toBe(true)
  })

  it('preserves native reasons including falsy values and rejects non-signal receivers', () => {
    const page = legacyPage()
    load(page)
    expect(runInContext(`
      [null, false, 0, '', { message: 'cancelled' }].map(reason => {
        var controller = new AbortController();
        controller.abort(reason);
        try { controller.signal.throwIfAborted(); return false; } catch (error) { return error === reason; }
      });
    `, page)).toEqual([true, true, true, true, true])
    for (const receiver of ['undefined', 'null', '{}', '{ aborted: false }', 'Object.create(AbortSignal.prototype)']) {
      expect(() => runInContext(`AbortSignal.prototype.throwIfAborted.call(${receiver})`, page)).toThrow()
    }
    expect(runInContext(`
      var source = new AbortController();
      source.abort();
      try { source.signal.throwIfAborted(); } catch (error) { error === source.signal.reason && error.name === 'AbortError'; }
    `, page)).toBe(true)
  })

  it('uses native internal state for synthetic events, shadowed properties and signals from another realm', () => {
    const page = legacyPage()
    const other = new AbortController()
    page.otherSignal = other.signal
    load(page)
    expect(runInContext('var pending = new AbortController(); pending.signal.dispatchEvent(new Event("abort")); pending.signal.throwIfAborted()', page)).toBeUndefined()
    expect(runInContext('AbortSignal.prototype.throwIfAborted.call(otherSignal)', page)).toBeUndefined()
    const reason = { message: 'other realm' }
    other.abort(reason)
    expect(() => runInContext('AbortSignal.prototype.throwIfAborted.call(otherSignal)', page)).toThrow(reason)
    expect(runInContext(`
      var source = new AbortController();
      source.abort('internal reason');
      Object.defineProperty(source.signal, 'aborted', { value: false });
      Object.defineProperty(source.signal, 'reason', { value: 'shadowed' });
      try { source.signal.throwIfAborted(); } catch (error) { error; }
    `, page)).toBe('internal reason')
  })

  it('retains cancellation reasons before native abort listeners run when the reason getter is missing', () => {
    const page = legacyPage({ missingReason: true })
    const nativeAbort = AbortController.prototype.abort
    const nativeReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get
    load(page)
    expect(runInContext(`
      var source = new AbortController(), reason = {}, observed;
      var pending = source.signal.reason;
      source.signal.addEventListener('abort', () => { observed = source.signal.reason; });
      source.signal.dispatchEvent(new Event('abort'));
      var synthetic = source.signal.reason;
      var combined = AbortSignal.any([source.signal]);
      source.abort(reason);
      source.abort('later');
      var exact;
      try { source.signal.throwIfAborted(); } catch (error) { exact = error === reason; }
      [pending, synthetic, source.signal.aborted, observed === reason, source.signal.reason === reason, combined.reason === reason, exact];
    `, page)).toEqual([undefined, undefined, true, true, true, true, true])
    expect(runInContext(`
      var source = new AbortController(); source.abort();
      var reason = source.signal.reason; source.abort('later');
      [reason.name, reason === source.signal.reason];
    `, page)).toEqual(['AbortError', true])
    expect(() => runInContext('AbortController.prototype.abort.call({})', page)).toThrow()
    expect(runInContext(`
      var inspected = false;
      try { AbortController.prototype.abort.call({ get signal() { inspected = true; } }); } catch (error) {}
      inspected;
    `, page)).toBe(false)
    expect(() => runInContext('Object.getOwnPropertyDescriptor(AbortSignal.prototype, "reason").get.call({})', page)).toThrow()
    expect(runInContext(`
      [null, false, 0, ''].map(reason => {
        var source = new AbortController(); source.abort(reason);
        return source.signal.reason === reason && AbortSignal.any([source.signal]).reason === reason;
      });
    `, page)).toEqual([true, true, true, true])
    expect(AbortController.prototype.abort).toBe(nativeAbort)
    expect(Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get).toBe(nativeReason)
  })

  it('provides a stable default reason for old signals aborted before installation', () => {
    const page = legacyPage({ missingReason: true })
    runInContext('var source = new AbortController(); source.abort();', page)
    load(page)
    expect(runInContext('var reason = source.signal.reason; [reason.name, reason === source.signal.reason, AbortSignal.any([source.signal]).reason === reason]', page)).toEqual(['AbortError', true, true])
  })

  it('preserves static abort factory reasons when the reason getter is missing', () => {
    const page = legacyPage({ missingReason: true })
    const nativeFactory = AbortSignal.abort
    load(page)
    expect(runInContext(`
      var reason = {}, source = AbortSignal.abort(reason), fallback = AbortSignal.abort();
      var getter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get;
      var exact;
      try { AbortSignal.prototype.throwIfAborted.call(source); } catch (error) { exact = error === reason; }
      [getter.call(source) === reason, AbortSignal.any([source]).reason === reason, exact, getter.call(fallback).name, getter.call(fallback) === getter.call(fallback)];
    `, page)).toEqual([true, true, true, 'AbortError', true])
    expect(AbortSignal.abort).toBe(nativeFactory)
  })

  it('keeps native methods and the installed missing methods unchanged on subsequent loads', () => {
    const nativePage = createContext({ AbortSignal, AbortController })
    load(nativePage)
    expect(runInContext('AbortSignal.prototype.throwIfAborted', nativePage)).toBe(AbortSignal.prototype.throwIfAborted)
    expect(runInContext('AbortController.prototype.abort', nativePage)).toBe(AbortController.prototype.abort)
    for (const missingReason of [false, true]) {
      const page = legacyPage({ missingReason })
      load(page)
      const check = runInContext('AbortSignal.prototype.throwIfAborted', page)
      const abort = runInContext('AbortController.prototype.abort', page)
      load(page)
      expect(runInContext('AbortSignal.prototype.throwIfAborted', page)).toBe(check)
      expect(runInContext('AbortController.prototype.abort', page)).toBe(abort)
    }
  })

  it('repairs a missing cancellation check even when composition is already native', () => {
    const page = legacyPage()
    page.nativeAny = AbortSignal.any
    runInContext('AbortSignal.any = nativeAny;', page)
    load(page)
    expect(runInContext('new AbortController().signal.throwIfAborted()', page)).toBeUndefined()
    expect(runInContext('AbortSignal.any', page)).toBe(AbortSignal.any)
  })
})

describe('early AbortSignal composition', () => {
  it('accepts iterables, validates the complete sequence and retains first-aborted ordering', () => {
    const page = legacyPage()
    load(page)
    expect(runInContext('var first = new AbortController(); var second = new AbortController(); first.abort("first"); second.abort("second"); AbortSignal.any(new Set([second.signal, first.signal])).reason', page)).toBe('second')
    expect(runInContext('AbortSignal.any((function* () { yield first.signal; })()).reason', page)).toBe('first')
    expect(runInContext('AbortSignal.any([]).aborted', page)).toBe(false)
    for (const input of ['null', '{}', '[first.signal, {}]', '[{ aborted: false, addEventListener() {} }]']) {
      expect(() => runInContext(`AbortSignal.any(${input})`, page)).toThrow()
    }
    expect(runInContext('Object.getOwnPropertyDescriptor(AbortSignal, "any").enumerable', page)).toBe(false)
    expect(runInContext('var pending = new AbortController(); var iterable = AbortSignal.any(new Set([pending.signal])); pending.abort("iterable"); iterable.reason', page)).toBe('iterable')
    expect(runInContext('var closed = false; try { AbortSignal.any((function* () { try { yield {}; throw new Error("must not advance"); } finally { closed = true; } })()); } catch (error) {} closed', page)).toBe(true)
  })

  it('aborts synchronously with exact reason identity and detaches every source listener', () => {
    const page = legacyPage()
    load(page)
    expect(runInContext(`
      var sources = [new AbortController(), new AbortController()];
      var added = 0, removed = 0;
      for (var source of sources) {
        var signal = source.signal;
        signal.addEventListener = function (...args) { added++; return EventTarget.prototype.addEventListener.apply(this, args); };
        signal.removeEventListener = function (...args) { removed++; return EventTarget.prototype.removeEventListener.apply(this, args); };
      }
      var result = AbortSignal.any([sources[0].signal, sources[1].signal, sources[0].signal]);
      var events = 0, reason = {};
      result.addEventListener('abort', () => events++);
      sources[1].abort(reason);
      sources[0].abort('later');
      [result.aborted, result.reason === reason, events, added, removed];
    `, page)).toEqual([true, true, 1, 2, 2])
  })

  it('ignores synthetic abort events without consuming the real cancellation listener', () => {
    const page = legacyPage()
    load(page)
    expect(runInContext('var source = new AbortController(); var result = AbortSignal.any([source.signal]); source.signal.dispatchEvent(new Event("abort")); result.aborted', page)).toBe(false)
    expect(runInContext('source.abort("actual"); result.reason', page)).toBe('actual')
  })

  it('accepts native signals from another realm and does not mutate the process constructor', () => {
    const native = AbortSignal.any
    const page = legacyPage()
    const other = new AbortController()
    page.otherSignal = other.signal
    load(page)
    expect(runInContext('var result = AbortSignal.any([otherSignal]); result.aborted', page)).toBe(false)
    other.abort('other realm')
    expect(runInContext('result.reason', page)).toBe('other realm')
    expect(AbortSignal.any).toBe(native)
  })

  it('does not replace native composition and remains stable after a second load', () => {
    const nativePage = createContext({ AbortSignal, AbortController })
    load(nativePage)
    expect(runInContext('AbortSignal.any', nativePage)).toBe(AbortSignal.any)
    const legacy = legacyPage()
    load(legacy)
    const installed = runInContext('AbortSignal.any', legacy)
    load(legacy)
    expect(runInContext('AbortSignal.any', legacy)).toBe(installed)
  })

  it('still composes and detaches sources when weak-reference APIs are absent', () => {
    const page = legacyPage()
    runInContext('delete globalThis.WeakRef; delete globalThis.FinalizationRegistry;', page)
    load(page)
    expect(runInContext('var source = new AbortController(); var removed = 0; source.signal.removeEventListener = function (...args) { removed++; return EventTarget.prototype.removeEventListener.apply(this, args); }; var result = AbortSignal.any([source.signal]); source.abort("fallback"); [result.reason, removed]', page)).toEqual(['fallback', 1])
  })
})
