/** Exercise real packed DSH sidebar slots, Workspace rows and mobile hit/scroll ownership. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { installPackedBundle, packBundle } from './packed-profile.mjs'
import { completeSmoke, recordSmokeFailure } from './negative-control.mjs'
import { observeMobileBootDiagnostics, summarizeMobileBootDiagnostics } from './mobile-boot-diagnostics.mjs'
import { CLIENT_TIMEOUT_MS, createMobileProfile, dismissOnboarding, launchDsh, openMobileSettings, openPairing,
  pairMobilePage, removeTemporaryRoot, sanitized } from './mobile-boot-fixture.mjs'

const args = process.argv.slice(2)
assert(args.length === 0 || args.length === 1 && ['--negative-control-drawer', '--footer-only'].includes(args[0]), 'Unexpected sidebar smoke arguments')
const negative = args.includes('--negative-control-drawer')
const footerOnly = args.includes('--footer-only')
const marker = 'Mobile sidebar scroll ownership negative control detected'
const repository = fileURLToPath(new URL('..', import.meta.url))
const dshBin = process.env.DSH_BOOT_SMOKE_BIN
const tarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL
assert(dshBin !== undefined && tarball !== undefined, 'Set exact DSH_BOOT_SMOKE_BIN and DSH_BOOT_SMOKE_MOBILE_TARBALL artifacts')
await access(dshBin); await access(tarball)
const prefix = 'dsh-mobile-sidebar-smoke-'
const root = await mkdtemp(join(tmpdir(), prefix))
const evidence = process.env.DSH_SIDEBAR_EVIDENCE_DIR === undefined
  ? join(repository, 'local/mobile-sidebar-smoke', randomUUID()) : resolve(process.env.DSH_SIDEBAR_EVIDENCE_DIR)
const fixtureName = 'dsh-mobile-sidebar-fixture'
const record = { geometry: [], checks: [], errors: [], prompts: 0 }
const failures = []
let browser, dsh, phone, bootDiagnostics, stage = 'installation', observedNegative = false, sequence = 0
// Names the active frontend in failure diagnostics before a check can throw.
let currentFrontend = 'unknown'

// Public additive slots stress the actual SidebarRoot and WorkspaceBrowser.
// No stock rows, handlers or styles are copied into this fixture.
const fixtureClient = `window.__ModuleLoader__.load({id:${JSON.stringify(fixtureName)},factory:require=>{
 const {createElement:h,useState,useEffect}=require('react');
 const state={long:true,footerMode:'long',overlay:false,clicks:[]};window.__sidebarFixture=state;
 function useFixture(){const [revision,setRevision]=useState(0);useEffect(()=>{const update=()=>setRevision(value=>value+1);window.addEventListener('sidebar-fixture-update',update);return()=>window.removeEventListener('sidebar-fixture-update',update)},[]);return state}
 const update=()=>window.dispatchEvent(new Event('sidebar-fixture-update'));
 function Footer({wide}){const current=useFixture();if(current.footerMode==='hidden')return null;if(current.footerMode==='shared')return wide?h('div',{'data-sidebar-fixture-shared':true,style:{position:'relative',display:'flex',minWidth:0,width:'100%'}},h('button',{id:'sidebar-fixture-shared',style:{boxSizing:'border-box',width:'100%',minWidth:0,height:42,display:'flex',alignItems:'center',gap:8,padding:'0 6px 0 8px',border:0,background:'transparent',color:'inherit',font:'14px/22px system-ui',whiteSpace:'nowrap'},onClick:()=>state.clicks.push('shared')},h('span',null,'Balance'),h('span',{'data-sidebar-fixture-amount':true,style:{marginLeft:'auto',flex:'none'}},'310.13 CNY'))):null;return h('div',{'data-sidebar-fixture-footer':true,style:{width:'100%',minHeight:wide&&current.long?280:48,display:'flex',flexDirection:'column',justifyContent:'flex-end'}},h('button',{id:'sidebar-fixture-footer',style:{font:'inherit',minHeight:48,width:'100%'},onClick:()=>{state.clicks.push('footer');state.overlay=true;update()}},'Owned footer action'))}
 function Overlay(){const current=useFixture();return current.overlay?h('div',{id:'sidebar-fixture-dialog',role:'dialog','aria-label':'Owned sidebar overlay',style:{position:'fixed',inset:'72px 16px auto',padding:16,zIndex:1200,background:'var(--dsw-alias-bg-base)',color:'var(--dsw-alias-label-primary)'}},h('button',{id:'sidebar-fixture-close',style:{minWidth:48,minHeight:48},onClick:()=>{state.clicks.push('overlay');state.overlay=false;update()}},'Close owned overlay')):null}
 function Stop(){return h('button',{id:'sidebar-fixture-stop',style:{minWidth:44,minHeight:44},onClick:()=>state.clicks.push('stop')},'Owned Stop control')}
 function apply(ctx){ctx.effect(()=>{const off=[];state.setLong=value=>{state.long=value;update()};state.setFooterMode=value=>{state.footerMode=value;update()};state.hasSession=id=>ctx.sessions.list.getSnapshot().byId[id]!==undefined;state.openSession=id=>ctx.uiWorkspace.openSession(id);state.openRightbar=()=>{if(!ctx.sidebarRight.isExpanded())ctx.sidebarRight.toggleExpanded()};
 for(const [name,id,component] of [['sidebar.footer.action','sidebar-fixture-footer',Footer],['shell.overlay','sidebar-fixture-overlay',Overlay],['conversation.input.right','sidebar-fixture-stop',Stop]])off.push(ctx.slots.inject(name,()=>ctx.slots.register({name,id},component)));
 const panels=[];state.clearPanels=()=>panels.splice(0).reverse().forEach(dispose=>dispose());off.push(()=>state.clearPanels());
 for(let i=0;i<5;i++){const id='sidebar-fixture-panel-'+i;panels.push(ctx.slots.inject('sidebar.panellist',()=>ctx.slots.register({name:'sidebar.panellist',id,label:'Owned panel '+i},()=>h('span',null,'P'))));panels.push(ctx.slots.inject('main',()=>ctx.slots.register({name:'main',key:id},()=>h('div',{'data-sidebar-fixture-panel':id},'Owned panel '+i))))}
 return()=>{off.reverse().forEach(dispose=>dispose());delete window.__sidebarFixture}})}return{inject:['slots','uiWorkspace','sessions','sidebarRight'],apply};}});`

async function addFixture(home) {
  const directory = join(root, fixtureName)
  await mkdir(join(directory, 'lib'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: fixtureName, version: '1.0.0', type: 'module',
    main: './lib/index.mjs', exports: { '.': './lib/index.mjs', './package.json': './package.json', './client': './lib/client.js' },
    peerDependencies: { '@deepseek-ai/dsh-llm': '*' },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-sidebar', '@deepseek-ai/dsh-client-ui-workspace', '@deepseek-ai/dsh-client-ui-sidebar-right'], immediately: true } } }) + '\n')
  // Blank Sessions are intentionally omitted from the real Workspace tree.
  // Commit a completed synthetic message in these owned Sessions, without a
  // prompt RPC, model, tool or replacement client projection.
  await writeFile(join(directory, 'lib/index.mjs'), `import {createUserMessage} from '@deepseek-ai/dsh-llm';
export const inject=['webServer','sessionController','sessions'];
export function apply(ctx){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/api/mobile-sidebar-fixture',handler:async(request,response)=>{
 if(request.method!=='POST'){response.writeHead(405);response.end();return}
 const id=new URL(request.url,'http://fixture.invalid').searchParams.get('id');
 const resolved=await ctx.sessionController.resolveAgent(id);
 if(resolved.agent===undefined){response.writeHead(409,{'Content-Type':'application/json'});response.end(JSON.stringify({error:resolved.error}));return}
 const session=resolved.agent.session;
 session.append('turn/start',{turn:1});
 session.append('user/message',createUserMessage({content:[{type:'text',text:'Owned completed sidebar fixture; no model runs.'}],source:{kind:'user'}}),{surfaceOp:'append'});
 session.append('turn/end',{turn:1,reason:{kind:'completed'}});await ctx.sessions.flush(session);
 response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({ok:true}));
}}))}\n`)
  await writeFile(join(directory, 'lib/client.js'), fixtureClient + '\n')
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'sidebar-fixture', name: fixtureName }] }]) + '\n')
  await installPackedBundle(await packBundle(directory, root), join(home, 'profiles/web'), { dshBin })
}

async function rpc(page, method, request, argumentName = 'request') {
  const result = await page.evaluate(async ({ method, request, argumentName, rpcId }) => {
    const response = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { [argumentName]: request } } }), signal: AbortSignal.timeout(60_000) })
    return { status: response.status, body: await response.json() }
  }, { method, request, argumentName, rpcId: `sidebar-smoke-${++sequence}` })
  assert.equal(result.status, 200, `${method}: HTTP rejected`)
  assert.equal(result.body.result?.ok, true, `${method}: ${sanitized(JSON.stringify(result.body))}`)
  return result.body.result.value
}

const frames = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
const sidebar = () => phone.locator('[data-dsh-mobile-sidebar]')
const sidebarRoot = () => phone.locator('[data-dsh-mobile-sidebar-root]')

async function openDrawer() {
  if (await sidebar().getAttribute('data-open') !== 'true') await sidebar().locator('[data-dsh-mobile-toggle]').tap()
  await phone.waitForFunction(() => document.querySelector('[data-dsh-mobile-sidebar]')?.dataset.open === 'true')
  await sidebarRoot().evaluate(node => { node.scrollTop = 0 })
  await frames(phone)
}

async function hit(locator, label, tap = true) {
  await locator.scrollIntoViewIfNeeded()
  await frames(phone)
  const value = await locator.evaluate(node => {
    const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height,
      hit: hit === node || node.contains(hit), covering: hit?.className ?? hit?.tagName }
  })
  const viewport = phone.viewportSize()
  assert(value.left >= -1 && value.right <= viewport.width + 1 && value.top >= -1 && value.bottom <= viewport.height + 1 && value.hit,
    `${label}: unreachable target ${JSON.stringify(value)}`)
  if (tap) await locator.tap()
  return value
}

async function revealSessionRow(sessionId) {
  // WorkspaceBrowser virtualizes its list. Scroll the actual owner until the
  // requested row mounts instead of requiring every account row in the DOM.
  await phone.evaluate(() => {
    const region = document.querySelector('[data-dsh-mobile-sidebar-root] [class*="_regionArea"]')
    const list = [...region.querySelectorAll('[class]')].find(node => [...node.classList].some(token => token.endsWith('_list')))
    if (list === undefined || getComputedStyle(list).overflowY !== 'auto') throw new Error('Actual Workspace scroll owner missing')
    // This helper deliberately navigates away from the restored position.
    list.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
    list.dataset.sidebarFixtureScroller = 'true'; list.scrollTop = 0
  })
  const row = sidebar().locator(`[data-row-key="session:${sessionId}"]`)
  for (let step = 0; step < 32; step++) {
    await frames(phone)
    if (await row.count() === 1) return row
    const moved = await phone.locator('[data-sidebar-fixture-scroller]').evaluate(node => {
      const before = node.scrollTop
      node.scrollTop += Math.max(32, node.clientHeight / 2)
      return node.scrollTop > before
    })
    if (!moved) break
  }
  throw new Error(`Actual Workspace virtual list did not reveal the requested owned Session\n${JSON.stringify(await sidebarRetentionDiagnostics(currentFrontend, sessionId), null, 1)}`)
}

/**
 * Capture the facts that separate a broken scroll restoration from a row that is
 * simply not in the mounted window: the scroll owners and their rects, every
 * mounted keyed row, the visible groups and any "More" control. Without them a
 * failed reveal cannot be attributed.
 */
async function sidebarRetentionDiagnostics(frontend, id) {
  return phone.evaluate(({ frontend, id }) => {
    const rect = node => {
      if (node === null || node === undefined) return null
      const box = node.getBoundingClientRect()
      return [Math.round(box.left), Math.round(box.top), Math.round(box.width), Math.round(box.height)]
    }
    const root = document.querySelector('[data-dsh-mobile-sidebar-root]')
    if (root === null) return { frontend, target: `session:${id}`, root: null, viewport: { width: innerWidth, height: innerHeight } }
    const region = root.querySelector('[class*="_regionArea"]')
    const list = [...(region === null ? [] : region.querySelectorAll('[class]'))]
      .find(node => [...node.classList].some(token => token.endsWith('_list'))) ?? null
    const rows = list === null ? [] : [...list.querySelectorAll('[data-row-key]')].map(node => node.dataset.rowKey)
    const target = rows.includes(`session:${id}`) ? list.querySelector(`[data-row-key="session:${id}"]`) : null
    return {
      frontend,
      target: `session:${id}`,
      targetMounted: target !== null,
      mountedRows: rows.length,
      rows,
      groups: list === null ? [] : [...list.querySelectorAll('[class*="_groupSection"]')].map(node => (node.textContent ?? '').trim().slice(0, 48)).slice(0, 8),
      moreControls: [...root.querySelectorAll('button')].map(node => (node.textContent ?? '').trim())
        .filter(text => /more|更多|altro|altre/i.test(text)).slice(0, 4),
      scrollOwners: {
        list: list === null ? null : { top: list.scrollTop, client: list.clientHeight, scroll: list.scrollHeight,
          overflowY: getComputedStyle(list).overflowY, rect: rect(list) },
        outer: { top: root.scrollTop, client: root.clientHeight, scroll: root.scrollHeight,
          overflowY: getComputedStyle(root).overflowY, rect: rect(root) },
      },
      targetRect: rect(target),
      targetAncestors: target === null ? [] : (() => {
        const result = []
        for (let node = target; node !== null && result.length < 12; node = node.parentElement) {
          const css = getComputedStyle(node)
          result.push({ tag: node.tagName, class: node.className, display: css.display, visibility: css.visibility,
            opacity: css.opacity, hidden: node.hidden, inert: node.inert, rect: rect(node) })
        }
        return result
      })(),
      viewport: { width: innerWidth, height: innerHeight },
    }
  }, { frontend, id })
}

async function checkSidebarScrollMemory(frontend, sessions) {
  // Workspace displays sessions newest-first; use lower visible rows in a short viewport.
  await phone.setViewportSize({ width: 659, height: 393 })
  // Both layouts can keep older rows behind More. Exercise the lower part of
  // the default five rows; preserving or forcing group expansion is not part
  // of the scroll adapter. Positive scroll/anchor assertions below still apply.
  const targets = [sessions[8], sessions[7], sessions[8]]
  for (const id of targets) {
    await openDrawer()
    const row = await revealSessionRow(id)
    await row.scrollIntoViewIfNeeded()
    await frames(phone)
    const before = await phone.evaluate(id => {
      const root = document.querySelector('[data-dsh-mobile-sidebar-root]')
      const list = [...root.querySelectorAll('[class*="_regionArea"] [class]')].find(node => [...node.classList].some(token => token.endsWith('_list')))
      const row = [...list.querySelectorAll('[data-row-key]')].find(node => node.dataset.rowKey === `session:${id}`)
      return { top: list.scrollTop, outer: root.scrollTop, offset: row.getBoundingClientRect().top - list.getBoundingClientRect().top }
    }, id)
    assert(before.top > 0, `${frontend}: retention test did not reach the lower list`)
    await row.tap().catch(async error => {
      throw new Error(`${frontend}: Session selection was not reachable ${JSON.stringify(await sidebarRetentionDiagnostics(frontend, id))}`, { cause: error })
    })
    await phone.waitForFunction(id => document.querySelector('[data-conversation-session]')?.dataset.conversationSession === id, id)
    // The dedicated shell closes on selection; stock DSH retains its drawer.
    if (frontend === 'stock' && await sidebar().getAttribute('data-open') === 'true') {
      // Tap outside the drawer, not its off-screen header toggle: Playwright
      // would scroll that toggle into view and legitimately replace outer memory.
      await phone.touchscreen.tap(phone.viewportSize().width - 8, 180)
    }
    await phone.waitForFunction(() => document.querySelector('[data-dsh-mobile-sidebar]')?.dataset.open === 'false')
    // Do not use openDrawer(): that geometry helper deliberately resets the
    // outer scrollport and would conceal a broken retention implementation.
    await sidebar().locator('[data-dsh-mobile-toggle]').tap()
    await phone.waitForFunction(({ id, before }) => {
      const root = document.querySelector('[data-dsh-mobile-sidebar-root]')
      const list = [...root.querySelectorAll('[class*="_regionArea"] [class]')].find(node => [...node.classList].some(token => token.endsWith('_list')))
      const row = list && [...list.querySelectorAll('[data-row-key]')].find(node => node.dataset.rowKey === `session:${id}`)
      return row !== undefined && Math.abs(list.scrollTop - before.top) <= 2
        && Math.abs(root.scrollTop - before.outer) <= 2
        && Math.abs(row.getBoundingClientRect().top - list.getBoundingClientRect().top - before.offset) <= 2
    }, { id, before }, { timeout: 5000 }).catch(async error => {
      const after = await sidebarRetentionDiagnostics(frontend, id)
      throw new Error(`${frontend}: sidebar retention failed ${JSON.stringify({ before, after })}`, { cause: error })
    })
    assert.equal(await phone.locator('[data-composer-input]').evaluate(node => node.contains(document.activeElement)), false, 'Session switching unexpectedly focused the composer')
  }
  record.checks.push(`${frontend}: lower-list position, visible keyed row and outer scroll survived three session switches without scrolling again`)
}

async function checkUpstreamDrawer(sessions) {
  // The preceding dedicated checks own the synthetic five panels/280px footer.
  // This control exercises upstream's native drawer without those stress slots.
  await phone.evaluate(() => {
    window.__sidebarFixture.setFooterMode('hidden')
    window.__sidebarFixture.clearPanels()
  })
  await frames(phone)
  for (const viewport of [{ width: 393, height: 659 }, { width: 659, height: 393 }]) {
    await phone.setViewportSize(viewport)
    const opener = phone.locator('[data-sidebar-opener]')
    await opener.waitFor({ state: 'visible' })
    assert.equal(await phone.locator('[data-dsh-mobile-frame]').count(), 0, 'Legacy frame adaptation claimed native drawer layout')
    assert.equal(await phone.locator('.dsh-native-mobile-backdrop:not([hidden])').count(), 0, 'Legacy scrim covered upstream navigation')
    await opener.tap()
    const drawer = phone.locator('[data-shortcut-modal="sidebar"][aria-modal="true"]')
    await drawer.waitFor({ state: 'visible' })
    const row = drawer.locator(`[data-row-key="session:${sessions[11]}"]`)
    await row.scrollIntoViewIfNeeded()
    await hit(row, 'Upstream native drawer Session')
    await phone.waitForFunction(id => document.querySelector('[data-conversation-session]')?.dataset.conversationSession === id, sessions[11])
    await drawer.waitFor({ state: 'hidden' })
    await opener.tap()
    await drawer.waitFor({ state: 'visible' })
    await phone.keyboard.press('Escape')
    await drawer.waitFor({ state: 'hidden' })
    const hiddenDesktop = await phone.locator('[class*="_sidebarCol"]').evaluate(node => ({ inert: node.inert, visibility: getComputedStyle(node).visibility }))
    assert(hiddenDesktop.inert && hiddenDesktop.visibility === 'hidden', 'Mobile overrode the hidden desktop sidebar')
    record.checks.push(`stock ${viewport.width}x${viewport.height}: upstream modal opener, visible row hit/navigation, selection dismissal and Escape; desktop sidebar remains inert/hidden`)
  }
}

async function geometry(label) {
  const value = await phone.evaluate(() => {
    const root = document.querySelector('[data-dsh-mobile-sidebar-root]'), region = root.querySelector('[class*="_regionArea"]')
    const list = region.querySelector('[class*="_list"]:not([class*="_listArea"])')
    const css = getComputedStyle(root), area = region.getBoundingClientRect(), bounds = root.getBoundingClientRect()
    return { root: { height: bounds.height, client: root.clientHeight, scroll: root.scrollHeight, top: bounds.top, bottom: bounds.bottom,
      overflow: css.overflowY }, region: { height: area.height, flex: getComputedStyle(region).flex, shrink: getComputedStyle(region).flexShrink },
      list: list === null ? null : { client: list.clientHeight, scroll: list.scrollHeight, overflow: getComputedStyle(list).overflowY },
      frame: document.querySelector('[data-dsh-mobile-frame]') === null ? null : getComputedStyle(document.querySelector('[data-dsh-mobile-frame]')).pointerEvents,
      width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth }
  })
  record.geometry.push({ label, ...value })
  return value
}

async function observeWorkspaceScroll() {
  const top = await phone.evaluate(() => {
    const region = document.querySelector('[data-dsh-mobile-sidebar-root] [class*="_regionArea"]')
    const list = [...region.querySelectorAll('[class]')].find(node => [...node.classList].some(token => token.endsWith('_list')))
    if (list === undefined) throw new Error('Actual Workspace list missing')
    list.scrollTop = Math.min(80, list.scrollHeight - list.clientHeight)
    return list.scrollTop
  })
  await frames(phone)
  assert(top > 0, 'Actual Workspace list with an overflowing range did not scroll')
  return top
}

async function removeDrawerOwnership() {
  return phone.evaluate(() => {
    let count = 0
    const visit = rules => {
      for (let index = rules.length - 1; index >= 0; index--) {
        const rule = rules[index]
        if (rule.selectorText?.includes('[data-dsh-mobile-sidebar-root]')
          && (rule.style?.getPropertyValue('flex') === '1 0 50%' || rule.style?.getPropertyValue('overflow-y') === 'auto')) {
          if (rule.parentRule !== null) rule.parentRule.deleteRule(index)
          else rule.parentStyleSheet.deleteRule(index)
          count++
        } else if (rule.cssRules !== undefined) visit(rule.cssRules)
      }
    }
    const style = document.querySelector('style[data-plugin="dsh-mobile"]')
    if (style === null) throw new Error('Missing packed mobile stylesheet')
    visit(style.sheet.cssRules)
    return count
  })
}

async function checkDesktopFooter(page) {
  await page.locator('.dsh-mobile-control__trigger').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  await page.waitForFunction(() => typeof window.__sidebarFixture?.setFooterMode === 'function')
  await dismissOnboarding(page)
  const trigger = page.locator('.dsh-mobile-control__trigger')
  const shared = page.locator('#sidebar-fixture-shared')
  // The public slot fixture stresses an adjacent full-width root. It does not
  // run a community plugin's account/Host code or change the shell's layout.
  record.desktopFooter = []
  try {
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' })
      for (const mode of ['hidden', 'shared', 'hidden']) {
        await page.evaluate(mode => window.__sidebarFixture.setFooterMode(mode), mode)
        await frames(page)
        const value = await trigger.evaluate(node => {
          const rect = node.getBoundingClientRect(), label = node.querySelector('.dsh-mobile-control__trigger-label')
          const outlet = node.closest('[data-slot="sidebar.footer.action"]'), row = outlet.parentElement
          const bounds = row.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          const amount = document.querySelector('[data-sidebar-fixture-amount]')?.getBoundingClientRect()
          return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, rowLeft: bounds.left, rowRight: bounds.right,
            rowDirection: getComputedStyle(row).flexDirection, hit: hit === node || node.contains(hit),
            covering: typeof hit?.className === 'string' ? hit.className : hit?.tagName,
            name: node.getAttribute('aria-label'), title: node.title, labelDisplay: getComputedStyle(label).display,
            amountRight: amount?.right }
        })
        record.desktopFooter.push({ colorScheme, mode, ...value })
        await page.screenshot({ path: join(evidence, `desktop-footer-${colorScheme}-${mode}.png`) })
        assert(value.height >= 42 && value.hit, `Desktop ${mode}: Mobile target was shrunk or covered ${JSON.stringify(value)}`)
        assert.equal(value.name, 'Mobile access'); assert.equal(value.title, 'Mobile access')
        assert.equal(value.rowDirection, 'row', 'Mobile changed the shared footer orientation')
        if (mode === 'shared') {
          assert(value.amountRight <= value.rowRight + 1, `Adjacent amount clipped ${JSON.stringify(value)}`)
          assert.equal(value.width, 44, 'Mobile did not reserve its compact shared-row target')
          assert.equal(value.labelDisplay, 'none', 'Compact Mobile label was squeezed instead of hidden')
          await shared.click()
          assert.equal(await page.evaluate(() => window.__sidebarFixture.clicks.at(-1)), 'shared')
        } else {
          assert(value.width > 100 && value.labelDisplay !== 'none', 'Lone Mobile action did not restore its full label')
        }
        await trigger.click()
        await page.locator('.dsh-mobile-control__panel').waitFor({ state: 'visible' })
        await page.locator('.dsh-mobile-control__close').click()
        await page.locator('.dsh-mobile-control__panel').waitFor({ state: 'hidden' })
      }
    }
    await page.setViewportSize({ width: 1000, height: 800 })
    await page.waitForFunction(() => document.querySelector('.dsh-mobile-control__trigger')?.classList.contains('is-rail'))
    const rail = await trigger.evaluate(node => {
      const rect = node.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      return { width: rect.width, height: rect.height, hit: node === hit || node.contains(hit) }
    })
    assert(rail.width === 36 && rail.height === 36 && rail.hit, `Collapsed rail target changed ${JSON.stringify(rail)}`)
    await trigger.click()
    await page.locator('.dsh-mobile-control__panel').waitFor({ state: 'visible' })
    await page.locator('.dsh-mobile-control__close').click()
    record.desktopFooter.push({ mode: 'rail', ...rail })
    record.checks.push('Desktop lone/shared/lone footer in light/dark: Mobile and adjacent action hit targets, amount containment, retained public row direction')
  } finally {
    await page.evaluate(() => window.__sidebarFixture.setFooterMode('long'))
    await page.setViewportSize({ width: 1280, height: 900 })
  }
}

try {
  await mkdir(evidence, { recursive: true })
  record.tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  const home = await createMobileProfile(root, { tarball: resolve(tarball), dshBin, packageStoreDirectory: join(root, 'pnpm-store'),
    extraPatches: [{ id: 'llm-deepseek', config: { models: [{ id: 'sidebar-model', name: 'Owned sidebar model', contextWindow: 128000, inputModalities: ['text'] }] } }] })
  await addFixture(home)
  console.log('Packed sidebar candidate and public-slot fixture installed in an owned profile.')
  const workspacePath = join(root, 'owned-workspace'); await mkdir(workspacePath)
  stage = 'boot'
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
  const launchUrl = await dsh.ready()
  const pairUrl = await openPairing(desktop, launchUrl, dsh.logs)
  console.log('Owned DSH desktop and Mobile Gateway are ready.')
  stage = 'desktop-footer'
  await checkDesktopFooter(desktop)
  if (!footerOnly) {
  const workspace = await rpc(desktop, 'workspace/create', { path: workspacePath })
  const sessions = []
  for (let index = 0; index < 12; index++) {
    const id = (await rpc(desktop, 'session/create', { workspaceId: workspace.workspace.workspaceId })).sessionId
    const seeded = await desktop.evaluate(async id => {
      const response = await fetch(`/api/mobile-sidebar-fixture?id=${encodeURIComponent(id)}`, { method: 'POST', signal: AbortSignal.timeout(60_000) })
      const text = await response.text(); let body
      try { body = JSON.parse(text) } catch { body = undefined }
      return { status: response.status, body }
    }, id)
    assert.equal(seeded.status, 200, `Owned completed-turn fixture rejected: ${JSON.stringify(seeded)}`)
    assert.equal(seeded.body?.ok, true, `Owned completed-turn response was not accepted: ${JSON.stringify(seeded)}`)
    sessions.push(id)
  }
  record.seededList = await rpc(desktop, 'session/list', {}, '_request')
  phone = await browser.newPage({ viewport: { width: 393, height: 659 }, locale: 'en-US', isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  bootDiagnostics = observeMobileBootDiagnostics(phone)
  phone.on('pageerror', error => record.errors.push(error.message))
  await phone.route('**/api/session/prompt', async route => { record.prompts++; await route.abort('blockedbyclient') })
  const baseline = await pairMobilePage(phone, pairUrl, dsh.logs); await dismissOnboarding(phone)
  const account = baseline.value.items.find(item => item.workspaceId === workspace.workspace.workspaceId)
  assert(account !== undefined && sessions.every(id => account.sessionIds.includes(id)), 'Actual Workspace baseline omitted owned Session membership')
  await phone.waitForFunction(() => typeof window.__sidebarFixture?.openSession === 'function', undefined, { timeout: CLIENT_TIMEOUT_MS })
  const stockPreview = new URL(launchUrl)
  stockPreview.searchParams.delete('token')
  stockPreview.searchParams.set('dsh-mobile-preview', '1')
  record.stockScope = 'Authenticated stock DSH preview on its private server; not the raw frontend=stock Gateway route, which skips mobile boot/trust'
  const desktopBefore = await desktop.locator('[class*="_frame"]').first().evaluate(node => ({ pointer: getComputedStyle(node).pointerEvents, width: node.clientWidth }))
  for (const frontend of ['dedicated', 'stock']) {
    currentFrontend = frontend
    stage = `${frontend}-boot`
    if (frontend === 'stock') {
      // The diagnostic raw Gateway route omits mobile trust/boot. Use the
      // authenticated stock DSH document for this geometry comparison; the
      // existing preview flag selects only its mobile adapter on loopback.
      // The launch-token exchange redirects to ./ and drops all query fields.
      await phone.goto(launchUrl, { waitUntil: 'domcontentloaded' })
      await phone.goto(stockPreview.href, { waitUntil: 'domcontentloaded' })
      await phone.locator('[data-dsh-mobile-frame],[data-sidebar-opener]').first().waitFor({ state: 'attached', timeout: CLIENT_TIMEOUT_MS })
      assert.equal(await phone.locator('.dshm-shell').count(), 0, 'Stock control loaded the dedicated layout')
    }
    await phone.waitForFunction(() => typeof window.__sidebarFixture?.openSession === 'function')
    await phone.waitForFunction(id => window.__sidebarFixture.hasSession(id), sessions[0], { timeout: CLIENT_TIMEOUT_MS })
    await phone.evaluate(id => window.__sidebarFixture.openSession(id), sessions[0])
    await phone.locator('[data-composer-input][contenteditable="true"]').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    if (frontend === 'stock' && await phone.locator('[data-sidebar-opener]').count() > 0) {
      await checkUpstreamDrawer(sessions)
      continue
    }
    if (frontend === 'dedicated' && !negative) {
      for (const width of [393, 719, 720, 721, 844, 899, 900, 901]) {
        await phone.setViewportSize({ width, height: 800 })
        await openDrawer()
        await sidebar().locator('[data-dsh-mobile-toggle]').tap()
        await phone.waitForFunction(() => document.querySelector('[data-dsh-mobile-sidebar]')?.dataset.open === 'false')
        await frames(phone)
        const value = await phone.locator('.dshm-main').evaluate(node => {
          const rect = node.getBoundingClientRect()
          const drawer = document.querySelector('.dshm-drawer')
          const rail = drawer.getBoundingClientRect()
          const hit = document.elementFromPoint(rect.x + 8, rect.y + rect.height / 2)
          return { x: rect.x, width: rect.width, railWidth: rail.width, railClip: getComputedStyle(drawer).overflowX,
            obscuresMain: hit !== null && drawer.contains(hit) }
        })
        const offset = width <= 720 ? 0 : 56
        assert(Math.abs(value.x - offset) < 1 && Math.abs(value.width - (width - offset)) < 1,
          `Closed rail at ${width}px lost content width: ${JSON.stringify(value)}`)
        if (width > 720) assert(Math.abs(value.railWidth - offset) < 1, `Offset disagrees with the actual rail: ${JSON.stringify(value)}`)
        else assert(value.railWidth <= 56, `Phone drawer left a persistent navigation column: ${JSON.stringify(value)}`)
        assert.equal(value.obscuresMain, false, `Closed navigation intercepted the main column: ${JSON.stringify(value)}`)
        record.checks.push(`dedicated: closed rail ${width}px reserves ${offset}px`)
      }
    }
    // Both sides of the 0.7.1 merge are retained: the closed-rail breakpoint
    // sweep above and the scroll-retention check this PR adds.
    if (!negative) await checkSidebarScrollMemory(frontend, sessions)
    for (const viewport of [{ width: 393, height: 659 }, { width: 369, height: 800 }, { width: 659, height: 393 }]) {
      await phone.setViewportSize(viewport)
      for (const large of [false, true]) {
        const label = `${frontend} ${viewport.width}x${viewport.height}${large ? ' large-text' : ''}`
        stage = label
        console.log(`Checking ${label}`)
        if (large) await phone.addStyleTag({ content: '[data-dsh-mobile-sidebar-root] :is(button,[role="treeitem"],span){font-size:22px!important;line-height:1.5!important}' }).then(style => style.evaluate(node => { node.dataset.sidebarLargeText = 'true' }))
        await openDrawer()
        if (frontend === 'dedicated' && !negative && !large) {
          for (const portalZ of [10, 60]) {
            await phone.evaluate(z => {
              const menu = document.createElement('button')
              menu.id = 'sidebar-fixture-body-menu'
              menu.textContent = 'Owned body menu'
              Object.assign(menu.style, { position: 'fixed', zIndex: String(z), left: '12px', top: '150px', width: '180px', height: '48px', background: 'Canvas', color: 'CanvasText' })
              menu.onclick = () => { menu.dataset.clicked = 'true' }
              document.body.append(menu)
            }, portalZ)
            try {
              const menu = phone.locator('#sidebar-fixture-body-menu')
              await hit(menu, `${label} body portal z=${portalZ}`)
              assert.equal(await menu.getAttribute('data-clicked'), 'true')
            } finally {
              await phone.locator('#sidebar-fixture-body-menu').evaluateAll(nodes => nodes.forEach(node => node.remove()))
            }
            await openDrawer()
          }
          record.checks.push(`${label}: body-portal menus at z=10/60 received taps above the real drawer`)
        }
        const mounted = await sidebar().locator('[data-row-key^="session:"]').evaluateAll(nodes => nodes.map(node => node.dataset.rowKey))
        record.mountedRows = mounted
        assert(mounted.length > 0, 'Actual WorkspaceBrowser did not render any Session rows')
        if (negative) {
          assert.equal(await removeDrawerOwnership(), 2, 'Negative control did not remove exactly the drawer/region ownership rules')
          await frames(phone)
          const broken = await geometry(label)
          assert(Number(broken.region.shrink) > 0 && broken.region.height < 80 && broken.root.overflow !== 'auto', `Deliberate collapse was not observed: ${JSON.stringify(broken)}`)
          observedNegative = true
          throw new Error(marker)
        }
        const value = await geometry(label)
        assert(value.root.overflow === 'auto' && value.region.shrink === '0' && value.region.height >= value.root.height * .49,
          `${label}: workspace seat collapsed ${JSON.stringify(value)}`)
        assert(value.root.scroll > value.root.client, `${label}: controlled oversized footer/panels did not stress the outer scrollport`)
        assert(value.documentWidth <= value.width + 1, `${label}: page horizontal overflow`)
        if (frontend === 'stock') assert.equal(value.frame, 'none', `${label}: layout frame reclaimed the hit target`)
        if (value.list.scroll > value.list.client + 1) record.geometry.at(-1).workspaceScrollTop = await observeWorkspaceScroll()
        const row = await revealSessionRow(sessions[9])
        const rowHit = await hit(row, `${label} actual Session row`)
        await phone.waitForFunction(id => document.querySelector('[data-conversation-session]')?.dataset.conversationSession === id, sessions[9])
        record.checks.push(`${label}: actual WorkspaceBrowser row tap opened owned Session`)
        await openDrawer()
        await hit(sidebar().getByRole('button', { name: 'Owned panel 0', exact: true }), `${label} panel`)
        await phone.locator('[data-sidebar-fixture-panel="sidebar-fixture-panel-0"]').waitFor({ state: 'visible' })
        await openDrawer()
        await hit(sidebar().locator('button[class*="_newSession"]'), `${label} New Session`)
        await phone.locator('[data-composer-input][contenteditable="true"]').waitFor({ state: 'visible' })
        await dismissOnboarding(phone)
        await openDrawer()
        await hit(phone.locator('#sidebar-fixture-footer'), `${label} footer`)
        record.geometry.at(-1).footerScrollTop = await sidebarRoot().evaluate(node => node.scrollTop)
        assert(record.geometry.at(-1).footerScrollTop > 0, `${label}: footer did not exercise the actual outer drawer scrollport`)
        await phone.locator('#sidebar-fixture-dialog').waitFor({ state: 'visible' })
        await hit(phone.locator('#sidebar-fixture-close'), `${label} shell overlay dialog`)
        assert.equal(await phone.evaluate(() => window.__sidebarFixture.clicks.at(-1)), 'overlay')
        await openMobileSettings(phone, { sidebar: sidebar(), activate: (button, stage) => hit(button, `${label} Settings ${stage}`) })
        const settingsDialog = phone.locator('[data-dsh-mobile-settings]')
        await settingsDialog.waitFor({ state: 'visible' })
        await settingsDialog.evaluate(node => {
          const popup = node.closest('[role="presentation"]')
          if (popup !== null) popup.dataset.sidebarFixtureSettingsPopup = 'true'
        })
        await hit(settingsDialog.locator('[data-dsh-mobile-settings-header] button[class*="_close"]'), `${label} Settings close`)
        await settingsDialog.waitFor({ state: 'detached' })
        await phone.locator('[data-sidebar-fixture-settings-popup]').waitFor({ state: 'detached' })
        await openDrawer()
        await phone.touchscreen.tap(viewport.width - 4, Math.round(viewport.height / 2))
        await phone.waitForFunction(() => document.querySelector('[data-dsh-mobile-sidebar]')?.dataset.open === 'false')
        const editor = phone.locator('[data-composer-input][contenteditable="true"]')
        await hit(editor, `${label} composer`)
        assert(await editor.evaluate(node => node.contains(document.activeElement)), `${label}: composer did not focus`)
        await editor.fill('Owned sidebar draft; never submit.')
        const send = phone.locator('[data-composer-card] button[class*="_primary"]')
        assert(await send.isEnabled(), `${label}: stock Send not enabled for draft`)
        await hit(send, `${label} stock Send geometry`, false)
        await hit(phone.locator('#sidebar-fixture-stop'), `${label} additive Stop slot control`)
        assert.equal(await phone.evaluate(() => window.__sidebarFixture.clicks.at(-1)), 'stop')
        record.checks.push(`${label}: new/panel/footer/settings/overlay; outside dismissal; focused composer; real Send hit and additive Stop activation`)
        record.geometry.at(-1).sessionHit = rowHit
        await editor.fill('')
        if (large) await phone.locator('style[data-sidebar-large-text]').evaluateAll(nodes => nodes.forEach(node => node.remove()))
      }
    }
    await phone.setViewportSize({ width: 1000, height: 800 }); await frames(phone)
    await phone.evaluate(() => window.__sidebarFixture.setLong(false)); await openDrawer()
    const wide = await geometry(`${frontend} wide control`)
    assert.notEqual(wide.region.shrink, '0', 'Narrow scroll-seat override leaked onto a wide viewport')
    if (frontend === 'stock') assert.equal(wide.frame, 'auto', 'Narrow frame hit policy leaked onto wide stock')
    record.checks.push(`${frontend}: wide geometry/hit policy remained stock`)
    if (frontend === 'dedicated') {
      await phone.evaluate(() => window.__sidebarFixture.openRightbar())
      const nativePanel = phone.locator('[data-sidebar-right-panel][data-sidebar-right-open]')
      await nativePanel.waitFor({ state: 'visible' })
      await nativePanel.locator('[data-sidebar-right-mode="fullscreen"]').click()
      await phone.waitForFunction(() => document.querySelector('.dshm-shell')?.dataset.rightbarFullscreen === 'true')
      const full = await phone.locator('.dshm-details').evaluate(node => {
        const rect = node.getBoundingClientRect()
        return { left: rect.left, right: rect.right, width: rect.width, viewport: innerWidth, inert: document.querySelector('.dshm-main')?.inert }
      })
      assert(Math.abs(full.left) < 1 && Math.abs(full.width - full.viewport) < 1 && full.inert, `Real fullscreen panel clipped: ${JSON.stringify(full)}`)
      await hit(nativePanel.locator('[data-sidebar-right-mode="push"]'), 'Real fullscreen exit')
      await phone.waitForFunction(() => document.querySelector('.dshm-shell')?.dataset.rightbarFullscreen === 'false')
      const restored = await phone.locator('.dshm-details').evaluate(node => ({ width: node.getBoundingClientRect().width, viewport: innerWidth, inert: document.querySelector('.dshm-main')?.inert }))
      assert(restored.width < restored.viewport && !restored.inert, 'Leaving fullscreen did not restore the conversation')
      await hit(nativePanel.locator('[data-sidebar-right-toggle]'), 'Real right panel close')
      await phone.waitForFunction(() => document.querySelector('.dshm-details')?.getAttribute('data-open') === 'false')
      record.checks.push('dedicated: real stock right-panel fullscreen entry, exit and close kept geometry and background ownership')
    }
    await phone.evaluate(() => window.__sidebarFixture.setLong(true))
    await phone.setViewportSize({ width: 393, height: 659 })
  }
  const desktopAfter = await desktop.locator('[class*="_frame"]').first().evaluate(node => ({ pointer: getComputedStyle(node).pointerEvents, width: node.clientWidth }))
  assert.deepEqual(desktopAfter, desktopBefore, 'Mobile changes altered desktop frame geometry/hit policy')
  assert.equal(record.prompts, 0, 'Sidebar smoke attempted a model request')
  assert.deepEqual(record.errors, [], 'Sidebar smoke emitted a page error')
  }
  record.completed = true
  stage = 'completed'
} catch (error) {
  record.failure = sanitized(error instanceof Error ? error.stack ?? error.message : String(error))
  record.stage = stage
  if (dsh !== undefined) record.hostLogs = dsh.logs()
  recordSmokeFailure(failures, error)
  if (bootDiagnostics !== undefined) record.bootDiagnostics = await bootDiagnostics.snapshot().then(summarizeMobileBootDiagnostics).catch(cause => ({ unavailable: sanitized(String(cause)) }))
  if (phone !== undefined) record.dom = await phone.evaluate(() => ({ slots: [...document.querySelectorAll('[data-slot-error]')].map(node => node.dataset.slotError),
    fixtureLoaded: window.__sidebarFixture !== undefined, sidebar: document.querySelector('[data-dsh-mobile-sidebar]')?.dataset.open,
    dialogs: [...document.querySelectorAll('[role="dialog"],[role="presentation"]')].map(node => ({ role: node.getAttribute('role'), label: node.getAttribute('aria-label'),
      text: node.textContent?.slice(0, 500), buttons: [...node.querySelectorAll('button')].map(button => ({ text: button.textContent, label: button.getAttribute('aria-label') })) })) })).catch(() => undefined)
} finally {
  bootDiagnostics?.dispose()
  if (browser !== undefined) await browser.close().catch(error => recordSmokeFailure(failures, error))
  if (dsh !== undefined) {
    try { record.hostExit = await dsh.close(); assert(!record.hostExit.forced && (record.hostExit.code === 0 || record.hostExit.signal === 'SIGTERM'), 'Sidebar fixture needed forced/abnormal DSH termination') }
    catch (error) { recordSmokeFailure(failures, error) }
  }
  await removeTemporaryRoot(root, prefix).catch(error => recordSmokeFailure(failures, error))
  record.cleanup = failures.length === (record.failure === undefined ? 0 : 1) ? 'completed' : 'failed'
  await mkdir(evidence, { recursive: true }).catch(error => recordSmokeFailure(failures, error))
  await writeFile(join(evidence, 'evidence.json'), JSON.stringify(record, null, 2) + '\n').catch(error => recordSmokeFailure(failures, error))
}
console.log(JSON.stringify({ completed: record.completed ?? false, geometryCases: record.geometry.length, evidence, stage,
  scope: 'packed dedicated Mobile Gateway plus authenticated stock DSH preview; not raw stock Gateway, reporter scripts or physical Android' }))
completeSmoke(failures, negative ? marker : undefined, observedNegative)
