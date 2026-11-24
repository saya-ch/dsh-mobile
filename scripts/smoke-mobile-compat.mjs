import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const bundleUrl = new URL('../lib/mobile-compat.js', import.meta.url)
const bundle = await readFile(bundleUrl, 'utf8')
const source = await readFile(new URL('../apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/WebViewCompatibilityShim.kt', import.meta.url), 'utf8')
const shim = /internal const val BROWSER_COMPATIBILITY_SHIM = """([\s\S]*?)"""/u.exec(source)?.[1]
assert.notEqual(shim, undefined, 'Android document-start source was not found')

const browser = await chromium.launch({ headless: true })
try {
  for (const mode of ['bundle', 'Android document-start']) {
    const page = await browser.newPage()
    await page.addInitScript(mode => {
      delete Promise.withResolvers
      delete AbortSignal.any
      delete globalThis.Iterator
      if (mode === 'bundle') {
        delete AbortSignal.prototype.throwIfAborted
        delete Object.hasOwn
        delete Array.prototype.at
        delete String.prototype.at
        delete Array.prototype.findLast
        delete Array.prototype.findLastIndex
        delete Array.prototype.toSorted
        delete Array.prototype.toReversed
        delete globalThis.structuredClone
        globalThis.clientApisMissingAtStart = [
          typeof Object.hasOwn, typeof Array.prototype.at, typeof String.prototype.at,
          typeof Array.prototype.findLast, typeof Array.prototype.findLastIndex,
          typeof Array.prototype.toSorted, typeof Array.prototype.toReversed, typeof structuredClone,
        ]
      }
      globalThis.compatMissingAtStart = [typeof Promise.withResolvers, typeof AbortSignal.any, typeof Iterator]
    }, mode)
    await page.route('https://compat.test/**', route => {
      const pathname = new URL(route.request().url()).pathname
      return pathname === '/compat.js'
        ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: mode === 'bundle' ? bundle : shim })
        : route.fulfill({ contentType: 'text/html', body: '<!doctype html><script src="/compat.js"></script><script>new AbortController().signal.throwIfAborted(); globalThis.bootReady = Promise.withResolvers(); bootReady.resolve("ready");' + (mode === 'bundle' ? 'globalThis.collectionBoot = Object.hasOwn(structuredClone({ values: [3, 1, 2].toSorted().toReversed() }), "values") && [1, 2].findLast(Boolean) === 2 && [1, 2].findLastIndex(Boolean) === 1 && [1, 2].at(-1) === 2 && "abc".at(-1) === "c";' : '') + '</script>' })
    })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('https://compat.test/', { waitUntil: 'load' })
    assert.deepEqual(await page.evaluate(() => compatMissingAtStart), ['undefined', 'undefined', 'undefined'])
    assert.equal(await page.evaluate(() => bootReady.promise), 'ready')
    const promise = await page.evaluate(async () => {
      class P extends Promise {}
      const subclass = P.withResolvers().promise instanceof P
      const invalid = []
      for (const constructor of [{}, function () {}, function (executor) { executor(1, 2) }]) {
        try { Promise.withResolvers.call(constructor); invalid.push(false) } catch (error) { invalid.push(error instanceof TypeError) }
      }
      const result = Promise.withResolvers()
      result.resolve('settled')
      const rejected = Promise.withResolvers()
      const rejection = rejected.promise.catch(reason => reason)
      rejected.reject('rejected')
      return { subclass, invalid, value: await result.promise, rejected: await rejection, enumerable: Object.getOwnPropertyDescriptor(Promise, 'withResolvers').enumerable }
    })
    assert.deepEqual(promise, { subclass: true, invalid: [true, true, true], value: 'settled', rejected: 'rejected', enumerable: false })
    if (mode === 'bundle') {
      assert.deepEqual(await page.evaluate(() => clientApisMissingAtStart), Array(8).fill('undefined'))
      assert.equal(await page.evaluate(() => collectionBoot), true, 'Published-client collection APIs must be available to the first boot script')
      const collections = await page.evaluate(() => {
        const original = [3, 1, 2]
        const sorted = original.toSorted((left, right) => left - right)
        const reversed = original.toReversed()
        const shared = { enabled: true }
        const source = { left: shared, right: shared, rows: new Map([['created', new Date(0)]]) }
        source.self = source
        const copy = structuredClone(source)
        copy.left.enabled = false
        let rejectedFunction = false
        try { structuredClone({ callback() {} }) } catch (error) { rejectedFunction = error.name === 'DataCloneError' }
        const buffer = new ArrayBuffer(2)
        new Uint8Array(buffer)[0] = 7
        const transferred = structuredClone({ buffer }, { transfer: [buffer] })
        const invalidReceivers = []
        for (const method of [Array.prototype.at, Array.prototype.toSorted, Array.prototype.toReversed]) {
          try { method.call(null); invalidReceivers.push(false) } catch (error) { invalidReceivers.push(error instanceof TypeError) }
        }
        return {
          sorted, reversed, original, negativeIndex: 'abc'.at(-1),
          hasOwn: [Object.hasOwn(Object.create({ inherited: true }), 'inherited'), Object.hasOwn({ field: undefined }, 'field')],
          findLast: [1, 2, 3].findLast(value => value < 3), findLastIndex: [1, 2, 3].findLastIndex(value => value < 3),
          clone: [copy !== source, copy.self === copy, copy.left === copy.right, source.left.enabled, copy.rows.get('created').getTime()],
          transfer: [buffer.byteLength, new Uint8Array(transferred.buffer)[0]], rejectedFunction, invalidReceivers,
        }
      })
      assert.deepEqual(collections, {
        sorted: [1, 2, 3], reversed: [2, 1, 3], original: [3, 1, 2], negativeIndex: 'c',
        hasOwn: [false, true], findLast: 2, findLastIndex: 1,
        clone: [true, true, true, true, 0], transfer: [0, 7], rejectedFunction: true, invalidReceivers: [true, true, true],
      })
      const signal = await page.evaluate(() => {
        const left = new AbortController(), right = new AbortController()
        let added = 0, removed = 0, events = 0
        for (const source of [left.signal, right.signal]) {
          const add = source.addEventListener, remove = source.removeEventListener
          source.addEventListener = function (...args) { added++; return add.apply(this, args) }
          source.removeEventListener = function (...args) { removed++; return remove.apply(this, args) }
        }
        const combined = AbortSignal.any(new Set([left.signal, right.signal]))
        combined.addEventListener('abort', () => events++)
        left.signal.dispatchEvent(new Event('abort'))
        const syntheticIgnored = !combined.aborted
        const reason = { message: 'cancelled' }
        right.abort(reason)
        left.abort('later')
        let exactThrownReason = false
        try { combined.throwIfAborted() } catch (error) { exactThrownReason = error === reason }
        const fresh = new AbortController()
        const pendingCheck = fresh.signal.throwIfAborted()
        fresh.abort()
        let defaultThrownReason = false
        try { fresh.signal.throwIfAborted() } catch (error) { defaultThrownReason = error === fresh.signal.reason && error.name === 'AbortError' }
        const invalidReceivers = []
        for (const receiver of [undefined, null, {}, { aborted: false }, Object.create(AbortSignal.prototype)]) {
          try { AbortSignal.prototype.throwIfAborted.call(receiver); invalidReceivers.push(false) } catch (error) { invalidReceivers.push(error instanceof TypeError) }
        }
        const invalid = []
        for (const input of [null, {}, [AbortSignal.abort('early'), {}], [{ aborted: false, addEventListener() {} }]]) {
          try { AbortSignal.any(input); invalid.push(false) } catch (error) { invalid.push(error instanceof TypeError) }
        }
        const first = AbortSignal.abort('first'), second = AbortSignal.abort('second')
        const generatorReason = AbortSignal.any((function* () { yield second; yield first })()).reason
        const iframe = document.createElement('iframe')
        document.body.append(iframe)
        const crossRealmSource = new iframe.contentWindow.AbortController()
        const crossRealmResult = AbortSignal.any([crossRealmSource.signal])
        crossRealmSource.abort('other frame')
        let crossRealmThrown = false
        try { AbortSignal.prototype.throwIfAborted.call(crossRealmSource.signal) } catch (error) { crossRealmThrown = error === 'other frame' }
        iframe.remove()
        return {
          syntheticIgnored, aborted: combined.aborted, sameReason: combined.reason === reason,
          added, removed, events, invalid, generatorReason, crossRealmReason: crossRealmResult.reason,
          emptyPending: !AbortSignal.any([]).aborted,
          pendingCheck, exactThrownReason, defaultThrownReason, invalidReceivers, crossRealmThrown,
          enumerable: Object.getOwnPropertyDescriptor(AbortSignal, 'any').enumerable,
          iterator: Iterator.from([1, 2, 3]).map(value => value * 2).join(','),
        }
      })
      assert.deepEqual(signal, {
        syntheticIgnored: true, aborted: true, sameReason: true, added: 2, removed: 2, events: 1,
        invalid: [true, true, true, true], generatorReason: 'second', crossRealmReason: 'other frame',
        emptyPending: true, enumerable: false, iterator: '2,4,6',
        pendingCheck: undefined, exactThrownReason: true, defaultThrownReason: true,
        invalidReceivers: [true, true, true, true, true], crossRealmThrown: true,
      })
    }
    const installed = await page.evaluate(() => {
      globalThis.installedPromise = Promise.withResolvers
      globalThis.installedAny = AbortSignal.any
      globalThis.installedCheck = AbortSignal.prototype.throwIfAborted
      return typeof installedPromise
    })
    assert.equal(installed, 'function')
    await page.addScriptTag({ content: mode === 'bundle' ? bundle : shim })
    assert.equal(await page.evaluate(() => installedPromise === Promise.withResolvers && installedAny === AbortSignal.any && installedCheck === AbortSignal.prototype.throwIfAborted), true)
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`${mode}: missing-API boot, Promise capabilities and idempotence passed${mode === 'bundle' ? '; real browser cancellation, iframe signals and listener cleanup passed' : ''}`)
  }
  const oldest = await browser.newPage()
  await oldest.goto('about:blank')
  await oldest.evaluate(() => {
    globalThis.originalController = AbortController
    globalThis.oldSignal = new AbortController().signal
    delete AbortSignal.prototype.reason
    delete AbortSignal.prototype.throwIfAborted
    delete AbortSignal.any
  })
  await oldest.addScriptTag({ content: bundle })
  assert.deepEqual(await oldest.evaluate(() => {
    const source = new AbortController(), reason = { message: 'cancelled' }
    let observed, thrown, events = 0
    source.signal.addEventListener('abort', () => { observed = source.signal.reason; events++ })
    source.signal.dispatchEvent(new Event('abort'))
    const syntheticIgnored = source.signal.reason === undefined
    const combined = AbortSignal.any([source.signal])
    source.abort(reason)
    source.abort('later')
    try { combined.throwIfAborted() } catch (error) { thrown = error }
    const staticSignal = AbortSignal.abort(reason), fallback = AbortSignal.abort()
    return {
      nativeController: originalController === AbortController, pending: oldSignal.reason === undefined,
      syntheticIgnored, synchronousReason: observed === reason, exactReason: source.signal.reason === reason,
      combinedReason: combined.reason === reason, thrownReason: thrown === reason, events,
      staticReason: staticSignal.reason === reason, defaultReason: fallback.reason.name,
      stableDefault: fallback.reason === fallback.reason,
    }
  }), {
    nativeController: true, pending: true, syntheticIgnored: true, synchronousReason: true,
    exactReason: true, combinedReason: true, thrownReason: true, events: 2, staticReason: true,
    defaultReason: 'AbortError', stableDefault: true,
  })
  assert.equal(await oldest.evaluate(async () => {
    const source = new AbortController(), reason = { message: 'cancelled fetch' }
    const combined = AbortSignal.any([source.signal])
    source.abort(reason)
    try { await fetch('data:text/plain,not-requested', { signal: combined }); return false } catch (error) { return error === reason }
  }), true, 'The composed signal must still cancel native fetch with its exact reason')
  await oldest.evaluate(() => {
    globalThis.installedReason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get
    globalThis.installedAbort = AbortController.prototype.abort
  })
  await oldest.addScriptTag({ content: bundle })
  assert.equal(await oldest.evaluate(() => installedReason === Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason').get && installedAbort === AbortController.prototype.abort), true)
  await oldest.close()
  console.log('Reason-less browser cancellation keeps the native controller and exact synchronous controller/static reasons')
  const native = await browser.newPage()
  await native.goto('about:blank')
  await native.evaluate(() => {
    globalThis.originalPromise = Promise.withResolvers
    globalThis.originalAny = AbortSignal.any
    globalThis.originalCheck = AbortSignal.prototype.throwIfAborted
    globalThis.originalAbort = AbortController.prototype.abort
    globalThis.originalHostname = Object.getOwnPropertyDescriptor(URL.prototype, 'hostname').get
    globalThis.originalHost = Object.getOwnPropertyDescriptor(URL.prototype, 'host').get
    globalThis.originalCollections = [Object.hasOwn, Array.prototype.at, String.prototype.at, Array.prototype.findLast, Array.prototype.findLastIndex, Array.prototype.toSorted, Array.prototype.toReversed]
  })
  await native.addScriptTag({ content: bundle })
  await native.addScriptTag({ content: shim })
  assert.equal(await native.evaluate(() => originalPromise === Promise.withResolvers && originalAny === AbortSignal.any
    && originalCheck === AbortSignal.prototype.throwIfAborted && originalAbort === AbortController.prototype.abort), true)
  assert.equal(await native.evaluate(() => originalCollections.every((value, index) => value === [Object.hasOwn, Array.prototype.at, String.prototype.at, Array.prototype.findLast, Array.prototype.findLastIndex, Array.prototype.toSorted, Array.prototype.toReversed][index])), true)
  assert.equal(await native.evaluate(() => originalHostname === Object.getOwnPropertyDescriptor(URL.prototype, 'hostname').get
    && originalHost === Object.getOwnPropertyDescriptor(URL.prototype, 'host').get
    && new URL('dsh-resource://file/probe').hostname === 'file'), true, 'An engine that already reports the authority must keep its own accessors')
  await native.close()
  console.log('Native browser Promise, AbortSignal and collection implementations remained unchanged')
  const opaque = await browser.newPage()
  await opaque.addInitScript(() => {
    const protocol = Object.getOwnPropertyDescriptor(URL.prototype, 'protocol').get
    const hostname = Object.getOwnPropertyDescriptor(URL.prototype, 'hostname').get
    const host = Object.getOwnPropertyDescriptor(URL.prototype, 'host').get
    const special = new Set(['http:', 'https:', 'file:', 'ftp:', 'ws:', 'wss:'])
    const opaqueAuthority = (instance, read) => (special.has(protocol.call(instance)) ? read.call(instance) : '')
    Object.defineProperty(URL.prototype, 'hostname', { configurable: true, enumerable: true, get() { return opaqueAuthority(this, hostname) } })
    Object.defineProperty(URL.prototype, 'host', { configurable: true, enumerable: true, get() { return opaqueAuthority(this, host) } })
    globalThis.authorityMissingAtStart = new URL('dsh-resource://file/session/s-1/a.txt').hostname
  })
  await opaque.route('https://compat.test/**', route => {
    const pathname = new URL(route.request().url()).pathname
    return pathname === '/compat.js'
      ? route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: bundle })
      : route.fulfill({ contentType: 'text/html', body: '<!doctype html><script src="/compat.js"></script>' })
  })
  await opaque.goto('https://compat.test/authority', { waitUntil: 'load' })
  assert.equal(await opaque.evaluate(() => authorityMissingAtStart), '')
  assert.deepEqual(await opaque.evaluate(() => [
    new URL('dsh-resource://file/session/s-1/a.txt').hostname,
    new URL('dsh-resource://file/session/s-1/a.txt').host,
    new URL('dsh-resource://FILE:8443/x').host,
    new URL('dsh-resource:///x').hostname,
    new URL('other-scheme://host/x').hostname,
    new URL('https://example.com/a').hostname,
  ]), ['file', 'file', 'file:8443', '', '', 'example.com'], 'The compat layer must restore the written authority without inventing one')
  await opaque.close()
  console.log('Custom scheme authority restored for a WebView that parses it as an opaque path')
} finally {
  await browser.close()
}

// Optional observation only: scheduling garbage collection is not a CI timing gate.
if (process.argv.includes('--gc')) {
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { createContext, runInContext } from 'node:vm';
    const signal = class PageAbortSignal extends AbortSignal {};
    Object.defineProperty(signal, 'any', { value: undefined, configurable: true });
    for (const name of ['aborted', 'reason']) Object.defineProperty(signal.prototype, name, Object.getOwnPropertyDescriptor(AbortSignal.prototype, name));
    const page = createContext({ AbortSignal: signal, AbortController, EventTarget });
    runInContext(readFileSync(${JSON.stringify(fileURLToPath(bundleUrl))}, 'utf8'), page);
    runInContext('var source = new AbortController(); var removed = 0; source.signal.removeEventListener = function (...args) { removed++; return EventTarget.prototype.removeEventListener.apply(this, args); }; var result = AbortSignal.any([source.signal]); var reference = new WeakRef(result); result = null;', page);
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      global.gc();
      if (runInContext('removed', page) === 1) { console.log('GC observation: unreachable combined signal released its source listener'); process.exit(0); }
    }
    console.log('GC observation inconclusive: finalizer scheduling did not complete within this run');
  `], { encoding: 'utf8', timeout: 15_000 })
  if (result.error !== undefined) throw result.error
  assert.equal(result.status, 0, result.stderr)
  process.stdout.write(result.stdout)
}
