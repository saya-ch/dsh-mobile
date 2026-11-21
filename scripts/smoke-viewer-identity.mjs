// Packed-profile browser-journey smoke: real stock document viewers, packed Mobile client, and production viewer file menu (browser share path; native Android handoff is verified separately).
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { rolldown } from 'rolldown'
import { createMobileProfile, dismissOnboarding, launchDsh, openPairing, pairMobilePage, removeTemporaryRoot, sanitized, within } from './mobile-boot-fixture.mjs'
import { installPackedBundle, packBundle } from './packed-profile.mjs'

const repo = fileURLToPath(new URL('..', import.meta.url))
const bin = resolve(process.env.DSH_BOOT_SMOKE_BIN ?? join(repo, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
const helper = createRequire(bin).resolve('@deepseek-ai/dsh-util-workspace-path')
const name = 'dsh-mobile-viewer-identity-fixture'
const prefix = 'dsh-mobile-viewer-identity-'
const filename = 'same.txt'
const OVER_LIMIT_BYTES = 8 * 1024 * 1024 + 1

// This probe lives only in the owned profile. It observes a trusted click without
// replacing the filename, modifying its contents, or overriding stock clipboard behavior.
function fixture(ctx, parse, address) {
  const sidebar = ctx.sidebarRight
  let last, taps = 0
  function click(e) {
    const owner = e.target?.closest?.('[data-textpreview-path]')
    if (!e.isTrusted || !owner || owner.closest('[data-changes-review]')) return
    taps++
    last = undefined
    const target = sidebar.focusedTarget(owner)
    const nav = target?.occurrence?.navigation.getSnapshot()
    const file = nav && parse(nav.address)
    if (file?.scope === 'session' && nav.revision === target.navigationRevision) last = { owner, target, file }
  }
  function current({ owner, target }) {
    return sidebar.isTargetCurrent(target) && owner.isConnected && owner.checkVisibility()
      && owner.getClientRects().length > 0 && sidebar.focusedTarget(owner)?.occurrence === target.occurrence
  }
  document.addEventListener('click', click, true)
  window.__identityProbe = {
    openSession: id => ctx.uiWorkspace.openSession(id), mounted: () => sidebar.mounted.getSnapshot(),
    open: (id, path, options) => sidebar.openResource(address(id, path), options),
    capture: () => last && ({ taps, host: last.target.host, containing: last.target.sessionId, file: last.file, current: current(last) }),
    hide: () => sidebar.hide(last.target.tabId), close: () => sidebar.close(last.target.tabId),
    replace: (id, path) => sidebar.openResource(address(id, path), { paneId: last.target.paneId, replaceTab: last.target.tabId }),
    async read() {
      const held = last
      if (!held || !current(held)) throw Error('Attempted to read a stale capture')
      const result = await ctx.remote.workspaceFiles.readBytes(held.file.sessionId, held.file.path, {})
      if (!result.ok) throw Error('Fixture file read failed: ' + JSON.stringify(result.error))
      // A positive result stands for the call site at which a sheet could launch.
      // Returning a denied result after a real reply tests the late-completion race.
      return { mayShare: current(held), text: new TextDecoder().decode(result.value.data) }
    },
  }
  return () => { document.removeEventListener('click', click, true); delete window.__identityProbe }
}

async function addProbe(root, home) {
  const dir = join(root, name)
  await mkdir(dir)
  const input = join(dir, 'entry.js')
  await writeFile(input, `import {parseFileAddress, sessionFileAddress} from ${JSON.stringify(helper)}; window.__ModuleLoader__.load({id:${JSON.stringify(name)},factory:()=>({inject:['sidebarRight','uiWorkspace','remote','remote.workspaceFiles'],apply(ctx){ctx.effect(()=>(${fixture})(ctx,parseFileAddress,sessionFileAddress))}})});`)
  const bundle = await rolldown({ input }); try { await bundle.write({ file: join(dir, 'client.js'), format: 'iife' }) } finally { await bundle.close() }
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version:'1.0.0', type:'module', main:'./index.js', exports:{'.':'./index.js','./client':'./client.js','./package.json':'./package.json'}, dsh:{bundle:{patch:'./cordis.patch.yml'},client:{platform:'web',inject:['@deepseek-ai/dsh-client-ui-workspace','@deepseek-ai/dsh-client-ui-sidebar-right'],immediately:true}} }))
  await writeFile(join(dir, 'index.js'), 'export function apply() {}\n')
  await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify([{ insert:[{id:'identity-probe',name}] }]))
  await installPackedBundle(await packBundle(dir,root),join(home,'profiles/web'),{dshBin:bin})
}
async function rpc(page, method, request) {
  return page.evaluate(async ({ method, request }) => {
    const res = await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:{request}}})})
    const body = await res.json(); if (!body.result.ok) throw Error(method+': '+JSON.stringify(body.result.error)); return body.result.value
  },{method,request})
}
async function run(root, home, dsh, browser) {
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const baseUrl = await dsh.ready()
  const pair = await openPairing(desktop, baseUrl, dsh.logs)
  const ids = [], texts = ['file owned by A\n','file owned by B\n']
  const unicodeName = '報告-'.repeat(12)+'binary.bin', binary = [0,255,31,128,7]
  const longNestedDir = 'deep/nested/folder/'.repeat(4).slice(0, -1)
  const longNestedBase = '報告-'.repeat(10)+'payload.bin'
  const longNestedPath = `${longNestedDir}/${longNestedBase}`
  const longNestedBinary = [1,2,3,127,128,254,255]
  const missingFile = 'vanishing.txt'
  const changedFile = 'changing.txt'
  const oversizedFile = 'oversized.bin'
  for (const [i,text] of texts.entries()) {
    const path = join(root,'workspace-'+i); await mkdir(path); await writeFile(join(path,filename),text); await writeFile(join(path,'other.txt'),'replacement\n')
    if (i === 0) {
      await writeFile(join(path,unicodeName),Buffer.from(binary))
      await mkdir(join(path,longNestedDir),{recursive:true})
      await writeFile(join(path,longNestedPath),Buffer.from(longNestedBinary))
      await writeFile(join(path,missingFile),'will vanish\n')
      await writeFile(join(path,changedFile),'before-change\n')
      await writeFile(join(path,oversizedFile),Buffer.alloc(OVER_LIMIT_BYTES, 0x41))
    }
    const {workspace} = await rpc(desktop,'workspace/create',{path})
    ids.push((await rpc(desktop,'session/create',{workspaceId:workspace.workspaceId})).sessionId)
  }

  // Desktop control: stock fine-pointer desktop must stay untouched (no menu, no copy, no readBytes).
  let desktopReadBytes = 0
  desktop.on('request', req => { if (new URL(req.url()).pathname === '/api/workspaceFiles/readBytes') desktopReadBytes++ })
  await desktop.waitForFunction(() => !!window.__identityProbe)
  await dismissOnboarding(desktop)
  await desktop.evaluate(id => window.__identityProbe.openSession(id), ids[0])
  await desktop.waitForFunction(id => window.__identityProbe.mounted() === id, ids[0])
  await desktop.evaluate(({ id, path }) => window.__identityProbe.open(id, path, { destination: 'sidebar' }), { id: ids[0], path: filename })
  const desktopLabel = desktop.locator('[data-dockkit-pane] [data-textpreview-path]:visible').last()
  await desktopLabel.waitFor({ state: 'visible', timeout: 10_000 })
  await desktop.evaluate(() => {
    window.__desktopCopies = 0
    window.__desktopShares = 0
    Object.defineProperties(navigator, {
      clipboard: { configurable: true, value: { writeText: async () => { window.__desktopCopies++ } } },
      canShare: { configurable: true, value: () => true },
      share: { configurable: true, value: async () => { window.__desktopShares++ } },
    })
  })
  const desktopReadsBefore = desktopReadBytes
  await desktopLabel.click()
  await desktop.waitForTimeout(250)
  assert.equal(await desktop.locator('dialog.dsh-mobile-viewer-file-menu').count(), 0, 'Desktop click opened mobile viewer menu')
  assert.equal(await desktop.evaluate(() => window.__desktopCopies), 0, 'Desktop click triggered clipboard write')
  assert.equal(await desktop.evaluate(() => window.__desktopShares), 0, 'Desktop click triggered share')
  assert.equal(desktopReadBytes, desktopReadsBefore, 'Desktop click initiated readBytes')
  console.log('PASS desktop: fine-pointer stock viewer stays unaffected')

  const phone = await browser.newPage({viewport:{width:1280,height:840},hasTouch:true,isMobile:true,reducedMotion:'reduce'})
  let reads=0, statCalls=0, textReadCalls=0
  const readBytesPayloads = []
  const pageErrors = []
  phone.on('pageerror', err => pageErrors.push(String(err)))
  phone.on('request', req=>{
    const pathname = new URL(req.url()).pathname
    if (pathname === '/api/workspaceFiles/readBytes') {
      reads++
      try { readBytesPayloads.push(req.postDataJSON()?.payload?.args) } catch { readBytesPayloads.push(undefined) }
    } else if (pathname === '/api/workspaceFiles/stat') {
      statCalls++
    } else if (pathname === '/api/workspaceFiles/read') {
      textReadCalls++
    }
  })
  await pairMobilePage(phone,pair,dsh.logs); await dismissOnboarding(phone)
  await phone.evaluate(() => {
    window.__unhandledRejections = []
    addEventListener('unhandledrejection', e => window.__unhandledRejections.push(String(e.reason)))
  })
  await phone.waitForFunction(()=>!!window.__identityProbe)
  const select = async id => { await phone.evaluate(id=>window.__identityProbe.openSession(id),id); await phone.waitForFunction(id=>window.__identityProbe.mounted()===id,id) }
  await select(ids[0])
  const label = host => phone.locator(`${host==='float'?'[data-dockkit-float]':'[data-dockkit-pane]'} [data-textpreview-path]:visible`).last()
  const open = async (i,host) => {
    await phone.evaluate(({id,path,host})=>window.__identityProbe.open(id,path,{destination:host}),{id:ids[i],path:filename,host})
    await label(host === 'sidebar' ? 'dock' : host).waitFor({ state: 'visible', timeout: 10_000 })
  }
  const openPath = async (id, path, host = 'sidebar') => {
    const scope = host === 'float' ? '[data-dockkit-float]' : '[data-dockkit-pane]'
    await phone.evaluate(({id,path,host})=>window.__identityProbe.open(id,path,{destination:host}),{id,path,host})
    await phone.waitForFunction(({scope, path}) => Array.from(document.querySelectorAll(`${scope} [data-textpreview-path]`)).some(n => n.checkVisibility() && (n.getAttribute('title') ?? '').replace(/\\/g, '/').endsWith(path)), { scope, path }, { timeout: 10_000 })
    await phone.waitForTimeout(150)
  }
  let taps=0
  const capture = async (i,host) => {
    const before=reads
    await label(host).tap(); const got=await phone.evaluate(()=>window.__identityProbe.capture())
    assert(got,'No bound target after actual filename tap'); assert.equal(got.taps,++taps); assert.equal(got.current,true); assert.equal(got.host,host)
    assert.equal(got.containing,ids[0]); assert.equal(got.file.sessionId,ids[i]); assert.equal(got.file.path,filename); assert.equal(reads,before,'Capture initiated a byte read')
  }
  await open(0,'sidebar'); await open(1,'float')
  for (const [i,host] of [[0,'dock'],[1,'float']]) {
    await capture(i,host); const before=reads; const result=await phone.evaluate(()=>window.__identityProbe.read())
    assert.deepEqual(result,{mayShare:true,text:texts[i]}); assert.equal(reads,before+1); console.log(`PASS ${host}: trusted filename tap, no capture read, exact session and bytes`)
  }
  // Withhold a real Host reply. Never rely on incidental wall-clock slowness.
  for (const action of ['hide','replace','switch']) {
    await open(0,'sidebar'); await capture(0,'dock')
    const held=Promise.withResolvers(), release=Promise.withResolvers(); const pattern='**/api/workspaceFiles/readBytes'
    await phone.route(pattern, async route=>{try {const response=await route.fetch({timeout:15_000}); held.resolve(); await release.promise; await route.fulfill({response})}catch(e){held.reject(e);throw e}},{times:1})
    const pending=phone.evaluate(()=>window.__identityProbe.read()); pending.catch(()=>{})
    try {
      await within(Promise.race([held.promise,pending.then(()=>{throw Error('Byte response escaped test gate')})]),20_000,()=> 'Timed out waiting for the held Host reply')
      if(action==='switch') await select(ids[1]); else await phone.evaluate(({action,id})=>action==='hide'?window.__identityProbe.hide():window.__identityProbe.replace(id,'other.txt'),{action,id:ids[0]})
      await phone.waitForFunction(()=>window.__identityProbe.capture()?.current===false)
    } finally { release.resolve() }
    assert.deepEqual(await pending,{mayShare:false,text:texts[0]}); console.log(`PASS ${action}: real delayed bytes rejected before handoff`)
  }
  await select(ids[0]); await openPath(ids[1], filename, 'sidebar')
  await phone.evaluate(() => {
    window.menuEvidence = { copies: [], shares: [], shareStarts: 0, active: false, shareMode: 'ok', shareGate: null }
    Object.defineProperties(navigator, {
      clipboard: { configurable:true, value:{writeText: async text => window.menuEvidence.copies.push(text)} },
      userActivation: { configurable:true, get: () => ({ isActive: window.menuEvidence.active }) },
      canShare: { configurable:true, value: data => data.files?.length === 1 && data.files[0] instanceof File },
      share: { configurable:true, value: async ({files:[f]}) => {
        window.menuEvidence.shareStarts++
        if (window.menuEvidence.shareGate) await window.menuEvidence.shareGate
        if (window.menuEvidence.shareMode === 'abort') throw Object.assign(new Error('Share cancelled'), { name: 'AbortError' })
        if (window.menuEvidence.shareMode === 'error') throw new Error('Share failed')
        window.menuEvidence.shares.push([f.name, Array.from(new Uint8Array(await f.arrayBuffer()))])
      } },
    })
  })
  const dialog=phone.locator('dialog.dsh-mobile-viewer-file-menu')
  const assertMenuGeometry = async (width, { sheet = false, height = 740, fontSize } = {}) => {
    const bar = await label('dock').elementHandle()
    const metrics = await phone.evaluate(bar => {
      const dlg = document.querySelector('dialog.dsh-mobile-viewer-file-menu')
      if (!dlg) return { ok: false, reason: 'missing dialog' }
      const dRect = dlg.getBoundingClientRect()
      const btns = Array.from(dlg.querySelectorAll('button'))
      if (btns.length !== 2) return { ok: false, reason: `expected 2 buttons, got ${btns.length}` }
      const rects = btns.map(b => {
        const r = b.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return { text: b.textContent, x: r.x, y: r.y, width: r.width, height: r.height, fontSize: getComputedStyle(b).fontSize, hitSelf: hit === b || b.contains(hit) }
      })
      const overlap = !(rects[0].y + rects[0].height <= rects[1].y + 0.5 || rects[1].y + rects[1].height <= rects[0].y + 0.5)
      return {
        ok: true,
        dialog: { x: dRect.x, y: dRect.y, width: dRect.width, height: dRect.height, scrollWidth: dlg.scrollWidth, clientWidth: dlg.clientWidth },
        bar: bar.getBoundingClientRect().toJSON(), backdrop: getComputedStyle(dlg, '::backdrop').backgroundColor,
        rects, overlap,
      }
    }, bar)
    await bar.dispose()
    assert(metrics.ok, metrics.reason)
    const { x, y, width: panelWidth, height: panelHeight } = metrics.dialog
    const geometry = JSON.stringify({ panel: metrics.dialog, bar: metrics.bar })
    assert(x >= 0 && x + panelWidth <= width + 0.5, `Dialog overflows width ${width}: ${geometry}`)
    assert(y >= 0 && y + panelHeight <= height + 0.5, `Dialog overflows height ${height}: ${geometry}`)
    if (sheet) {
      assert(Math.abs(x) <= 0.5 && Math.abs(panelWidth - width) <= 0.5 && Math.abs(y + panelHeight - height) <= 0.5,
        `Sheet did not fill the width at the bottom: ${geometry}`)
    } else {
      assert(Math.abs(y - metrics.bar.bottom - 8) <= 0.5, `Dropdown not 8px below filename bar: ${geometry}`)
      assert(Math.abs(x - metrics.bar.left) <= 0.5 && Math.abs(panelWidth - metrics.bar.width) <= 0.5,
        `Dropdown not aligned to filename bar: ${geometry}`)
      assert(Math.abs(y + panelHeight / 2 - height / 2) > 1, `Dropdown is viewport-centered: ${geometry}`)
    }
    assert.equal(metrics.backdrop, 'rgba(0, 0, 0, 0)', 'Backdrop dims the preview')
    assert(metrics.dialog.scrollWidth <= metrics.dialog.clientWidth + 1, `Dialog has horizontal scroll at ${width}: ${JSON.stringify(metrics.dialog)}`)
    assert(!metrics.overlap, `Menu buttons overlap at ${width}: ${JSON.stringify(metrics.rects)}`)
    for (const r of metrics.rects) {
      assert(r.width >= 44 && r.height >= 44 && r.x >= 0 && r.x + r.width <= width + 0.5 && r.y >= 0 && r.y + r.height <= height + 0.5, `Button box invalid at ${width}: ${JSON.stringify(r)}`)
      assert(r.hitSelf, `Button center hit-test failed at ${width}: ${JSON.stringify(r)}`)
      if (fontSize) assert.equal(r.fontSize, fontSize, `Larger-text case did not reach the menu button: ${r.text}`)
    }
  }

  // No added card/header button anywhere in the preview pane.
  const addedButtons = await phone.evaluate(() => {
    const scope = document.querySelectorAll('[data-dockkit-pane] button, [data-dockkit-float] button, [data-presented-file] button')
    return Array.from(scope).filter(b => b.className.includes('dsh-mobile') || /Share File|Copy Path|分享文件|复制路径/u.test(b.textContent ?? '')).length
  })
  assert.equal(addedButtons, 0, 'Unexpected mobile viewer button added inside preview header or card')

  const before=reads
  for (const width of [320,360]) {
    await phone.setViewportSize({width,height:740})
    const statBeforeMenu = statCalls, readBeforeMenu = textReadCalls
    await label('dock').tap(); await dialog.waitFor({timeout:5000})
    assert.equal(reads, before, 'Opening menu initiated readBytes')
    assert.equal(statCalls, statBeforeMenu, 'Opening menu initiated stat')
    assert.equal(textReadCalls, readBeforeMenu, 'Opening menu initiated text read')
    await assertMenuGeometry(width)
    await phone.keyboard.press('Escape'); await dialog.waitFor({state:'detached'}); assert(await label('dock').evaluate(n=>n===document.activeElement))
  }
  assert.deepEqual(await phone.evaluate(()=>window.menuEvidence.copies),[])
  const title=await label('dock').getAttribute('title')
  await label('dock').press('Enter'); await dialog.waitFor({timeout:5000})
  await dialog.getByRole('button',{name:'Copy Path',exact:true}).tap()
  await dialog.waitFor({state:'detached'})
  assert(await label('dock').evaluate(n=>n===document.activeElement), 'Focus did not return after Copy Path')
  assert.deepEqual(await phone.evaluate(()=>window.menuEvidence.copies),[title]); assert.equal(reads,before)

  // Space key opens menu and dsh-mobile:native-back dismisses it with focus restoration.
  await label('dock').press(' ')
  await dialog.waitFor({timeout:5000})
  const backConsumed = await phone.evaluate(() => {
    const ev = new Event('dsh-mobile:native-back', { cancelable: true })
    window.dispatchEvent(ev)
    return ev.defaultPrevented
  })
  assert.equal(backConsumed, true, 'dsh-mobile:native-back did not dismiss open viewer file menu')
  await dialog.waitFor({state:'detached'})
  assert(await label('dock').evaluate(n=>n===document.activeElement), 'Focus did not return after native-back')

  // A real tap over the filename while the menu is open hits only the backdrop.
  await label('dock').tap(); await dialog.waitFor({timeout:5000})
  const barBox = await label('dock').boundingBox()
  const tapsBeforeBackdrop = await phone.evaluate(() => window.__identityProbe.capture().taps)
  await phone.touchscreen.tap(barBox.x + barBox.width / 2, barBox.y + barBox.height / 2)
  await dialog.waitFor({state:'detached'})
  assert.equal(await phone.evaluate(() => window.__identityProbe.capture().taps), tapsBeforeBackdrop, 'Outside tap reached the underlying filename')
  assert(await label('dock').evaluate(n=>n===document.activeElement), 'Focus did not return after backdrop click')

  async function assertSheetRoundTrip() {
    const node = await dialog.elementHandle()
    const bar = await label('dock').elementHandle()
    const focused = await node.evaluateHandle(() => document.activeElement)
    const retained = () => node.evaluate((dlg, focus) => dlg.open && dlg.isConnected && focus === document.activeElement, focused)
    try {
      await phone.setViewportSize({ width: 360, height: 160 })
      await phone.waitForFunction(dlg => Math.abs(dlg.getBoundingClientRect().bottom - innerHeight) <= 0.5, node)
      await assertMenuGeometry(360, { sheet: true, height: 160 })
      assert(await retained(), 'Sheet move lost the open dialog or focus')
      await phone.setViewportSize({ width: 360, height: 740 })
      await phone.waitForFunction(({ dlg, bar }) => Math.abs(dlg.getBoundingClientRect().top - bar.getBoundingClientRect().bottom - 8) <= 0.5, { dlg: node, bar })
      await assertMenuGeometry(360)
      assert(await retained(), 'Dropdown move lost the open dialog or focus')
    } finally {
      await phone.setViewportSize({ width: 360, height: 740 })
      await focused.dispose()
      await bar.dispose()
      await node.dispose()
    }
  }

  // Slow read (userActivation.isActive === false -> Ready to share -> tap) + duplicate-tap guard.
  const statBeforeSlowShare = statCalls, textBeforeSlowShare = textReadCalls
  await label('dock').tap(); await dialog.getByRole('button',{name:'Share File…',exact:true}).tap()
  const readyBtn = dialog.getByRole('button',{name:'Ready to share — tap to share'})
  await readyBtn.waitFor({state:'visible',timeout:8000})
  assert(await readyBtn.evaluate(n => n === document.activeElement), 'Ready button was not focused')
  await assertMenuGeometry(360)
  await assertSheetRoundTrip()
  assert(await readyBtn.evaluate(n => n === document.activeElement), 'Ready button lost focus during reflow')
  const immediateShareStarts = await phone.evaluate(() => {
    let releaseShare
    window.__releaseSlowShare = () => releaseShare?.()
    window.menuEvidence.shareGate = new Promise(resolve => { releaseShare = resolve })
    const btn = document.querySelector('dialog.dsh-mobile-viewer-file-menu button:nth-of-type(2)')
    const before = window.menuEvidence.shareStarts
    btn.click()
    btn.click()
    return window.menuEvidence.shareStarts - before
  })
  assert.equal(immediateShareStarts, 1, 'Ready gesture did not enter share synchronously exactly once')
  await phone.evaluate(() => window.__releaseSlowShare())
  await dialog.waitFor({state:'detached'})
  assert(await label('dock').evaluate(n=>n===document.activeElement), 'Focus did not return after slow share')
  assert.deepEqual(await phone.evaluate(()=>window.menuEvidence.shares),[[filename,Array.from(Buffer.from(texts[1],'utf8'))]])
  assert.equal(reads,before+1)
  assert.equal(statCalls, statBeforeSlowShare + 1, 'Share should perform one stat preflight')
  assert.equal(textReadCalls, textBeforeSlowShare, 'Share must not issue workspaceFiles/read')
  assert.deepEqual(readBytesPayloads.at(-1), { workspaceFileScopeId: ids[1], path: filename, options: {} })

  // Fast read (userActivation.isActive === true) shares in one tap + duplicate click while reading is ignored.
  await phone.evaluate(() => { window.menuEvidence.active = true; window.menuEvidence.shareGate = null })
  const heldFast = Promise.withResolvers(), releaseFast = Promise.withResolvers()
  await phone.route('**/api/workspaceFiles/readBytes', async route => {
    try {
      const response = await route.fetch({ timeout: 15_000 })
      heldFast.resolve()
      await releaseFast.promise
      await route.fulfill({ response })
    } catch (e) { heldFast.reject(e); throw e }
  }, { times: 1 })
  await label('dock').tap(); await dialog.waitFor({timeout:5000})
  const shareBtn = dialog.getByRole('button',{name:'Share File…',exact:true})
  await shareBtn.tap()
  try {
    await within(heldFast.promise, 20_000, () => 'Timed out waiting for held fast readBytes')
    assert.equal(await shareBtn.isDisabled(), true, 'Share button should be disabled while reading')
    await assertSheetRoundTrip()
    assert.equal(await shareBtn.isDisabled(), true, 'Preparing state was lost during reflow')
    await phone.evaluate(() => {
      document.querySelector('dialog.dsh-mobile-viewer-file-menu button:nth-of-type(2)')?.click()
    })
  } finally { releaseFast.resolve() }
  await dialog.waitFor({state:'detached'})
  assert.equal(await phone.evaluate(() => window.menuEvidence.shares.length), 2, 'Duplicate click produced duplicate share')
  assert.equal(reads, before + 2, 'Duplicate click produced duplicate readBytes')
  assert(await label('dock').evaluate(n=>n===document.activeElement), 'Focus did not return after fast share')
  console.log('PASS fast + slow share + duplicate-tap guard + keyboard/backdrop/native-back dismissal')

  // Long nested Unicode path + larger text at 320 and 360px.
  await openPath(ids[0], longNestedPath, 'sidebar')
  await phone.evaluate(() => { document.documentElement.style.fontSize = '24px' })
  try {
    for (const width of [320, 360]) {
      await phone.setViewportSize({width,height:740})
      const previewOverlap = await phone.evaluate(w => {
        const pathEl = Array.from(document.querySelectorAll('[data-dockkit-pane] [data-textpreview-path]')).find(n => n.checkVisibility())
        const header = pathEl?.parentElement
        const siblings = header ? Array.from(header.querySelectorAll('button')).filter(b => b.checkVisibility()) : []
        const pr = pathEl.getBoundingClientRect()
        const badSibling = siblings.some(b => {
          const br = b.getBoundingClientRect()
          return !(br.right <= pr.left + 0.5 || pr.right <= br.left + 0.5 || br.bottom <= pr.top + 0.5 || pr.bottom <= br.top + 0.5)
        })
        return { pr: { left: pr.left, right: pr.right, width: pr.width }, badSibling, overflow: pr.right > w + 0.5 }
      }, width)
      assert(!previewOverlap.badSibling, `Preview path overlapped sibling button at ${width}px with larger text`)
      await label('dock').tap(); await dialog.waitFor({timeout:5000})
      await assertMenuGeometry(width, { fontSize: '24px' })
      await phone.keyboard.press('Escape'); await dialog.waitFor({state:'detached'})
    }
    const longTitle = await label('dock').getAttribute('title')
    assert(longTitle && longTitle.includes(longNestedPath), `Expected full long path in title, got ${longTitle}`)
    await label('dock').tap(); await dialog.getByRole('button',{name:'Copy Path',exact:true}).tap()
    await dialog.waitFor({state:'detached'})
    assert.equal(await phone.evaluate(() => window.menuEvidence.copies.at(-1)), longTitle, 'Long nested path was truncated on copy')
    await phone.evaluate(() => { window.menuEvidence.active = false })
    await label('dock').tap(); await dialog.getByRole('button',{name:'Share File…',exact:true}).tap()
    await dialog.getByRole('button',{name:'Ready to share — tap to share'}).tap({timeout:8000}); await dialog.waitFor({state:'detached'})
    assert.deepEqual(await phone.evaluate(()=>window.menuEvidence.shares.at(-1)),[longNestedBase,longNestedBinary])
    assert.deepEqual(readBytesPayloads.at(-1), { workspaceFileScopeId: ids[0], path: longNestedPath, options: {} })
  } finally {
    await phone.evaluate(() => { document.documentElement.style.fontSize = '' })
  }
  console.log('PASS long nested Unicode path + larger text (24px) at 320/360px: full path copied, basename + exact bytes shared')

  // Error paths: oversized (>8 MiB, no readBytes), missing file, changed file, share AbortError (neutral), share Error.
  const readsBeforeErrors = reads
  // 1) Oversized file (>8 MiB)
  await openPath(ids[0], oversizedFile, 'sidebar')
  await label('dock').tap(); await dialog.waitFor({timeout:5000})
  await dialog.getByRole('button',{name:'Share File…',exact:true}).tap()
  await phone.waitForFunction(() => document.querySelector('dialog.dsh-mobile-viewer-file-menu [role="status"]')?.textContent === 'Size unknown or larger than 8 MiB.')
  assert.equal(reads, readsBeforeErrors, 'Oversized file must fail at stat preflight without readBytes')
  await phone.keyboard.press('Escape'); await dialog.waitFor({state:'detached'})

  // 2) Missing file (deleted after opening preview)
  await openPath(ids[0], missingFile, 'sidebar')
  await unlink(join(root, 'workspace-0', missingFile))
  await label('dock').tap(); await dialog.waitFor({timeout:5000})
  await dialog.getByRole('button',{name:'Share File…',exact:true}).tap()
  await phone.waitForFunction(() => document.querySelector('dialog.dsh-mobile-viewer-file-menu [role="status"]')?.textContent === 'Could not share this file.')
  assert.equal(reads, readsBeforeErrors, 'Missing file failed at stat without readBytes')
  await phone.keyboard.press('Escape'); await dialog.waitFor({state:'detached'})

  // 3) Changed file between stat and readBytes
  await openPath(ids[0], changedFile, 'sidebar')
  const heldChanged = Promise.withResolvers(), releaseChanged = Promise.withResolvers()
  await phone.route('**/api/workspaceFiles/readBytes', async route => {
    try {
      heldChanged.resolve()
      await releaseChanged.promise
      const response = await route.fetch({ timeout: 15_000 })
      await route.fulfill({ response })
    } catch (e) { heldChanged.reject(e); throw e }
  }, { times: 1 })
  await label('dock').tap(); await dialog.waitFor({timeout:5000})
  await dialog.getByRole('button',{name:'Share File…',exact:true}).tap()
  try {
    await within(heldChanged.promise, 20_000, () => 'Timed out waiting for changed-file readBytes')
    await writeFile(join(root, 'workspace-0', changedFile), 'after-change-longer-payload\n')
  } finally { releaseChanged.resolve() }
  await phone.waitForFunction(() => document.querySelector('dialog.dsh-mobile-viewer-file-menu [role="status"]')?.textContent === 'Could not share this file.')
  await phone.keyboard.press('Escape'); await dialog.waitFor({state:'detached'})

  // 4) navigator.share AbortError (neutral cancellation -> closes cleanly, focus restored) & non-abort failure
  await openPath(ids[0], unicodeName, 'sidebar')
  await phone.evaluate(() => { window.menuEvidence.active = true; window.menuEvidence.shareMode = 'abort' })
  const sharesBeforeAbort = await phone.evaluate(() => window.menuEvidence.shares.length)
  await label('dock').tap(); await dialog.getByRole('button',{name:'Share File…',exact:true}).tap()
  await dialog.waitFor({state:'detached'})
  assert(await label('dock').evaluate(n=>n===document.activeElement), 'Focus did not return after share AbortError')
  assert.equal(await phone.evaluate(() => window.menuEvidence.shares.length), sharesBeforeAbort)

  await phone.evaluate(() => { window.menuEvidence.shareMode = 'error' })
  await label('dock').tap(); await dialog.getByRole('button',{name:'Share File…',exact:true}).tap()
  await phone.waitForFunction(() => document.querySelector('dialog.dsh-mobile-viewer-file-menu [role="status"]')?.textContent === 'Could not share this file.')
  await phone.keyboard.press('Escape'); await dialog.waitFor({state:'detached'})
  await phone.evaluate(() => { window.menuEvidence.shareMode = 'ok'; window.menuEvidence.active = false })
  console.log('PASS error paths: oversized (>8 MiB), missing, changed version, AbortError neutral cancel, share failure')

  // Unaffected changes-review & card targets inside mounted paired page.
  const isolation = await phone.evaluate(() => {
    window.__reviewTapped = 0
    window.__cardTapped = 0
    const host = document.createElement('div')
    host.id = 'dsh-smoke-isolation'
    host.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:2000;background:#fff;color:#000;padding:8px;display:flex;gap:12px'
    host.innerHTML = '<div data-changes-review><span id="rev-path" data-textpreview-path title="src/rev.ts"><span>src/rev.ts</span></span></div><div data-presented-file><button id="card-btn" type="button" title="card.md">card</button></div>'
    document.body.append(host)
    document.getElementById('rev-path').addEventListener('click', () => { window.__reviewTapped++ })
    document.getElementById('card-btn').addEventListener('click', () => { window.__cardTapped++ })
    return { copiesBefore: window.menuEvidence.copies.length, sharesBefore: window.menuEvidence.shares.length }
  })
  const readsBeforeIso = reads
  await phone.locator('#rev-path').tap()
  await phone.locator('#card-btn').tap()
  await phone.waitForTimeout(200)
  assert.equal(await dialog.count(), 0, 'Changes-review or card opened viewer file menu')
  assert.equal(await phone.evaluate(() => window.__reviewTapped), 1)
  assert.equal(await phone.evaluate(() => window.__cardTapped), 1)
  assert.equal(await phone.evaluate(() => window.menuEvidence.copies.length), isolation.copiesBefore)
  assert.equal(await phone.evaluate(() => window.menuEvidence.shares.length), isolation.sharesBefore)
  assert.equal(reads, readsBeforeIso)
  await phone.evaluate(() => document.getElementById('dsh-smoke-isolation')?.remove())
  console.log('PASS unaffected changes-review and presented-file card')

  // Unaffected workspace gestures: close right details panel via native-back, open/close drawer, switch sessions.
  assert.equal(await phone.evaluate(() => { const e = new Event('dsh-mobile:native-back', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented }), true)
  await phone.waitForFunction(() => document.querySelector('.dshm-details')?.getAttribute('data-open') === 'false')
  if (await phone.locator('.dshm-scrim').getAttribute('data-open') === 'true') {
    assert.equal(await phone.evaluate(() => { const e = new Event('dsh-mobile:native-back', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented }), true)
    await phone.waitForFunction(() => document.querySelector('.dshm-scrim')?.getAttribute('data-open') === 'false')
  }
  const drawerToggle = phone.locator('.dshm-drawer button[data-dsh-mobile-toggle]')
  await drawerToggle.click()
  await phone.waitForFunction(() => document.querySelector('.dshm-scrim')?.getAttribute('data-open') === 'true')
  assert.equal(await phone.evaluate(() => { const e = new Event('dsh-mobile:native-back', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented }), true)
  await phone.waitForFunction(() => document.querySelector('.dshm-scrim')?.getAttribute('data-open') === 'false')
  await select(ids[1])
  await select(ids[0])
  assert.deepEqual(await phone.evaluate(() => window.__unhandledRejections), [], 'Unhandled promise rejections observed')
  assert.deepEqual(pageErrors, [], 'Page errors observed')
  console.log('PASS workspace gestures: details close, drawer toggle, native-back, session switch, zero errors')

  await openPath(ids[0], unicodeName, 'sidebar')
  await phone.setViewportSize({width:320,height:740}); await label('dock').tap(); await dialog.waitFor({timeout:5000})
  await assertMenuGeometry(320)
  await dialog.getByRole('button',{name:'Share File…',exact:true}).tap()
  await dialog.getByRole('button',{name:'Ready to share — tap to share'}).tap({timeout:8000}); await dialog.waitFor({state:'detached'})
  assert.deepEqual(await phone.evaluate(()=>window.menuEvidence.shares.at(-1)),[unicodeName,binary])
  console.log('PASS long Unicode binary name: exact original bytes at 320px with a fresh-tap share')
  console.log('PASS production filename menu: 320/360px, larger text, long paths, fast+slow share, errors, isolation')
}
const root=await mkdtemp(join(tmpdir(),prefix)); let browser,dsh
try {
  const home=await createMobileProfile(root,{tarball:await packBundle(repo,root),dshBin:bin}); await addProbe(root,home)
  dsh=launchDsh(root,home,bin); browser=await chromium.launch(); console.log('Packed client; headless Chromium',browser.version()); await run(root,home,dsh,browser)
} catch(e){throw Error(sanitized(String(e.stack??e)))} finally {
  try {await browser?.close()} finally {try {if(dsh){const r=await dsh.close();assert(!r.forced&&(r.code===0||r.signal==='SIGTERM'),'Unclean DSH shutdown')}} finally {await removeTemporaryRoot(root,prefix)}}
}
