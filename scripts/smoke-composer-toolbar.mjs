/** Exercise the stock DSH InputBar with genuinely registered optional slot controls. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { installPackedBundle, packBundle } from './packed-profile.mjs'
import { createMobileProfile, launchDsh, removeTemporaryRoot, openPairing, pairMobilePage, dismissOnboarding, CLIENT_TIMEOUT_MS, sanitized } from './mobile-boot-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const source = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined ? repository : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const prefix = 'dsh-mobile-toolbar-smoke-'
const fixtureName = 'dsh-mobile-composer-fixture'
const root = await mkdtemp(join(tmpdir(), prefix))
let dsh, browser, failure
let sequence = 0

// This plugin uses DSH's actual public slots. It has no copied core handlers,
// network operations, microphone access, or production package registration.
const fixtureClient = `window.__ModuleLoader__.load({ id:${JSON.stringify(fixtureName)}, factory:require=>{
 const {createElement:h,useEffect,useRef,useState}=require('react');
 const fixture={mode:'none',clicks:[],mounts:0}; window.__dshToolbarFixture=fixture;
 function useMode(){const [mode,setMode]=useState(fixture.mode);useEffect(()=>{const changed=()=>setMode(fixture.mode);window.addEventListener('toolbar-fixture-change',changed);return()=>window.removeEventListener('toolbar-fixture-change',changed)},[]);return mode}
 function action(id,text,extra={}){return h('button',{id,style:{font:'inherit',color:'inherit',background:'var(--dsw-specific-selector)',border:0,borderRadius:12,padding:'6px 10px',minHeight:44},onClick:()=>fixture.clicks.push(id),...extra},text)}
 function Left(){const mode=useMode();return mode==='none'?null:h('div',{'data-fixture-left':true,style:{display:'inline-flex',flexWrap:'wrap',gap:8}},action('fixture-skill','Skill selection'),action('fixture-memory','Memory enabled'),action('fixture-expert','Expert prompt'))}
 function Right(){const mode=useMode();const [open,setOpen]=useState(false);return mode==='none'?null:h('div',{'data-fixture-right':true,style:{position:'relative',display:'inline-flex',flexWrap:'wrap',gap:8}},action('fixture-right','Quota details',{onClick:()=>setOpen(!open),'aria-expanded':open,'aria-haspopup':'dialog'}),h('label',{style:{display:'inline-flex',alignItems:'center',minHeight:44,gap:8}},h('button',{id:'fixture-switch',role:'switch','aria-checked':true,style:{width:32,height:20,minWidth:32,minHeight:20,padding:0,background:'var(--dsw-alias-label-primary-bluish)'},onClick:()=>fixture.clicks.push('fixture-switch')}),'Optional'),open?h('div',{id:'fixture-inline-dialog',role:'dialog','aria-label':'Inline fixture dialog',style:{position:'fixed',zIndex:2500,inset:'100px 16px auto',width:'auto',padding:12,background:'var(--dsw-specific-input-major)'}},h('button',{id:'fixture-dialog-action',style:{width:120,height:30,minWidth:0,minHeight:0,whiteSpace:'nowrap'},onClick:()=>setOpen(false)},'Close details')):null)}
 function Activity({onActiveChange}){const mode=useMode();const [active,setActive]=useState(false);const identity=useRef(null);if(identity.current===null)identity.current=++fixture.mounts;useEffect(()=>{onActiveChange(active);return()=>onActiveChange(false)},[active,onActiveChange]);return h('div',{'data-fixture-activity':identity.current,style:{display:'flex',alignItems:'center',gap:8}},action('fixture-activity',active?'Finish recording':'Voice',{onClick:()=>setActive(!active)}),active?action('fixture-cancel','Cancel',{onClick:()=>setActive(false)}):null)}
 function apply(ctx){ctx.effect(()=>{const off=[];for(const [name,component] of [['conversation.input.left',Left],['conversation.input.right',Right],['conversation.input.activity',Activity]])off.push(ctx.slots.inject(name,()=>ctx.slots.register({name,id:'toolbar-fixture-'+name,priority:-100},component)));return()=>{off.reverse().forEach(dispose=>dispose());delete window.__dshToolbarFixture}})}
 return {inject:['slots'],apply};}});`

async function addFixture(home) {
  const profile = join(home, 'profiles', 'web')
  const directory = join(root, fixtureName)
  await mkdir(join(directory, 'lib'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: fixtureName, version: '1.0.0', type: 'module', main: './lib/index.mjs', exports: { '.': './lib/index.mjs', './package.json': './package.json', './client': './lib/client.js' }, dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-conversation'], immediately: true } } }) + '\n')
  await writeFile(join(directory, 'lib', 'index.mjs'), 'export function apply() {}\n')
  await writeFile(join(directory, 'lib', 'client.js'), fixtureClient + '\n')
  await writeFile(join(directory, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'toolbar-fixture', name: fixtureName }] }]) + '\n')
  await installPackedBundle(await packBundle(directory, root), profile, { dshBin })
}

async function rpc(page, method, request) {
  const response = await page.evaluate(async ({ method, request, rpcId }) => {
    const result = await fetch(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }), signal: AbortSignal.timeout(60000) })
    return { status: result.status, body: await result.json() }
  }, { method, request, rpcId: `toolbar-smoke-${++sequence}` })
  assert.equal(response.status, 200, sanitized(JSON.stringify(response)))
  assert.equal(response.body.result?.ok, true, sanitized(JSON.stringify(response)))
  return response.body.result.value
}

const frames = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))

async function geometry(page, label) {
  const buttons = await page.locator('[data-dsh-mobile-composer-row] button:not([role="switch"])').evaluateAll(nodes => nodes.filter(node => node.closest('[role="dialog"],dialog,[popover],[role="menu"],[role="listbox"]') === null).flatMap(node => {
    const rect = node.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return []
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return [{ label: node.id || node.getAttribute('aria-label'), x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, hit: node === hit || node.contains(hit), covering: hit === null ? null : { tag: hit.tagName, id: hit.id, class: hit.className, button: hit.closest('button')?.getAttribute('aria-label') } }]
  }))
  const viewport = page.viewportSize()
  assert(buttons.length >= 3, `${label}: controls did not mount`)
  for (const button of buttons) {
    assert(button.x >= -0.5 && button.right <= viewport.width + 0.5 && button.y >= -0.5 && button.bottom <= viewport.height + 0.5, `${label}: offscreen ${JSON.stringify(button)}`)
    assert(button.hit, `${label}: covered ${JSON.stringify({ button, buttons })}`)
    if (viewport.width <= 720) assert(button.width >= 43.5 && button.height >= 43.5, `${label}: small touch target ${JSON.stringify(button)}`)
  }
  for (let left = 0; left < buttons.length; left++) for (const right of buttons.slice(left + 1)) {
    const a = buttons[left]
    assert(Math.min(a.right, right.right) - Math.max(a.x, right.x) <= 0.5 || Math.min(a.bottom, right.bottom) - Math.max(a.y, right.y) <= 0.5, `${label}: overlapping controls ${JSON.stringify({ a, right })}`)
  }
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: document overflow`)
}

try {
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const home = await createMobileProfile(root, { tarball: await packBundle(source, root), dshBin,
    extraPatches: [{ id: 'llm-deepseek', config: { models: [{ id: 'toolbar-model', name: 'Toolbar example model with a long label', contextWindow: 128000, inputModalities: ['text', 'image'] }] } }] })
  await addFixture(home)
  console.log('Packed candidate and actual optional slot fixture installed in the owned profile.')
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const desktop = await browser.newPage({ locale: 'en-US' })
  const pairUrl = await openPairing(desktop, await dsh.ready(), dsh.logs)
  const createdWorkspace = await rpc(desktop, 'workspace/create', { path: workspace })
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'en-US', isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  const errors = [], prompts = []
  phone.on('pageerror', error => errors.push(String(error)))
  await phone.route('**/api/session/prompt', async route => { prompts.push(route.request().url()); await route.abort('blockedbyclient') })
  await pairMobilePage(phone, pairUrl, dsh.logs)
  await dismissOnboarding(phone)
  const drawer = phone.locator('.dshm-drawer')
  if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  const created = phone.waitForResponse(response => new URL(response.url()).pathname === '/api/session/create' && response.request().postDataJSON()?.payload?.args?.request?.workspaceId === createdWorkspace.workspace.workspaceId)
  await drawer.locator(`[role="treeitem"][data-row-key="workspace:${createdWorkspace.workspace.workspaceId}"]`).getByRole('button').last().click()
  const session = await (await created).json()
  assert.equal(session.result?.ok, true)
  const editor = phone.locator('[data-composer-input][contenteditable="true"]').first()
  await editor.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  try { await phone.locator('#fixture-activity').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS }) } catch (error) {
    const state = await phone.evaluate(async () => ({ fixtureLoaded: window.__dshToolbarFixture !== undefined,
      slotErrors: Array.from(document.querySelectorAll('[data-slot-error]'), node => node.getAttribute('data-slot-error')),
      session: document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session'),
      catalog: await fetch('/mobile-access/client-modules').then(response => response.json()).then(body => body.entries?.filter(entry => entry.id.includes('fixture'))).catch(error => String(error)),
    }))
    throw new Error(`Optional slot fixture did not mount: ${sanitized(JSON.stringify({ ...state, errors }))}`, { cause: error })
  }
  console.log('Stock composer, Lexical editor and optional plugin slots mounted.')
  if (await drawer.getAttribute('data-open') === 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
  await phone.waitForFunction(() => document.querySelector('.dshm-drawer')?.getAttribute('data-open') === 'false')
  await editor.fill('Held stock Lexical draft — do not submit')
  await phone.evaluate(() => { window.__toolbarOriginalEditor = document.querySelector('[data-composer-input]'); window.__toolbarOriginalActivity = document.querySelector('[data-fixture-activity]') })
  const initialTime = await phone.evaluate(() => performance.timeOrigin)
  const backgrounds = new Set()
  const compactModes = new Set()
  let cases = 0
  for (const theme of ['light', 'dark']) {
    await phone.emulateMedia({ colorScheme: theme })
    await phone.waitForFunction(scheme => document.documentElement.style.colorScheme === scheme, theme)
    backgrounds.add(await phone.locator('[data-composer-card]').evaluate(node => getComputedStyle(node).backgroundColor))
    for (const size of [16, 24]) {
      // Author CSS text enlargement exercises native sizing and the real
      // width observer without changing a user's Host font preference.
      await phone.addStyleTag({ content: `[data-dsh-mobile-composer-row]{font-size:${size}px!important}[data-dsh-mobile-composer-row] button{font-size:${size}px!important}` })
      for (const viewport of [{ width: 288, height: 812 }, { width: 320, height: 812 }, { width: 375, height: 812 }, { width: 390, height: 844 }, { width: 720, height: 390 }, { width: 844, height: 393 }]) {
        await phone.setViewportSize(viewport)
        for (const mode of ['none', 'extensions']) {
          await phone.evaluate(mode => { window.__dshToolbarFixture.mode = mode; window.dispatchEvent(new Event('toolbar-fixture-change')) }, mode)
          await frames(phone)
          const label = `${viewport.width}x${viewport.height}/${theme}/${size}/${mode}`
          await geometry(phone, label)
          const observed = await phone.locator('[data-dsh-mobile-composer-row]').evaluate(node => ({
            groups: Array.from(node.children, group => group.getBoundingClientRect().width),
            compact: node.hasAttribute('data-model-compact'),
            labelDisplay: getComputedStyle(node.querySelector('[data-dsh-mobile-composer-model-label]')).display,
          }))
          assert.equal(observed.groups.length, 2, `${label}: the stock observer's two parent groups changed`)
          assert(observed.groups.every(width => width > 0), `${label}: a group became unmeasurable`)
          compactModes.add(observed.compact)
          if (observed.compact) assert.equal(observed.labelDisplay, 'none', `${label}: model ignored the actual width observer`)
          assert.equal(await editor.textContent(), 'Held stock Lexical draft — do not submit', `${label}: draft lost`)
          assert(await editor.evaluate(node => node === window.__toolbarOriginalEditor), `${label}: editor remounted`)
          assert(await phone.evaluate(() => document.querySelector('[data-fixture-activity]') === window.__toolbarOriginalActivity), `${label}: activity remounted`)
          if (mode === 'extensions') {
            assert.equal(await phone.locator('#fixture-switch').evaluate(node => getComputedStyle(node).height), '20px', `${label}: switch styling overridden`)
            await phone.locator('#fixture-right').click()
            const popup = phone.locator('#fixture-inline-dialog')
            await popup.waitFor({ state: 'visible' })
            assert.equal(await popup.locator('button').evaluate(node => getComputedStyle(node).height), '30px', `${label}: dialog inherited toolbar sizing`)
            assert.equal(await popup.locator('button').evaluate(node => getComputedStyle(node).whiteSpace), 'nowrap', `${label}: dialog wrapping changed`)
            await popup.locator('button').click()
          }
          cases++
        }
      }
    }
  }
  assert.equal(backgrounds.size, 2, 'Light/dark produced the same stock composer surface')
  assert.equal(compactModes.size, 2, 'The stock width observer did not adapt between expanded and compact model controls')
  await phone.setViewportSize({ width: 375, height: 812 })
  await phone.locator('#fixture-activity').click()
  await phone.waitForFunction(() => document.querySelector('[data-dsh-mobile-composer-tools]')?.hidden === true)
  await geometry(phone, 'active activity')
  const mounts = await phone.evaluate(() => window.__dshToolbarFixture.mounts)
  await phone.setViewportSize({ width: 844, height: 393 })
  await frames(phone)
  await geometry(phone, 'active activity landscape')
  assert.equal(await phone.evaluate(() => window.__dshToolbarFixture.mounts), mounts, 'Rotation remounted an active activity')
  await phone.locator('#fixture-cancel').click()
  await phone.waitForFunction(() => document.querySelector('[data-dsh-mobile-composer-tools]')?.hidden === false)
  assert.equal(await editor.textContent(), 'Held stock Lexical draft — do not submit')
  assert.equal(await phone.evaluate(() => performance.timeOrigin), initialTime)
  assert.equal(prompts.length, 0, 'A model request was attempted')
  assert.equal(errors.length, 0, sanitized(errors.join('\n')))
  console.log(`Packed stock DSH toolbar passed ${cases} real-slot layouts, inline dialog and switch exclusions, active activity rotation and unchanged Lexical draft/document. No model or microphone request was made.`)
} catch (error) {
  failure = new Error(`${sanitized(error instanceof Error ? error.stack ?? error.message : String(error))}\n${dsh?.logs() ?? ''}`)
} finally {
  const failures = failure === undefined ? [] : [failure]
  if (browser !== undefined) await browser.close().catch(error => failures.push(error))
  if (dsh !== undefined) {
    try { const stopped = await dsh.close(); if (stopped.forced) failures.push(new Error('DSH required forced termination')) } catch (error) { failures.push(error) }
  }
  await removeTemporaryRoot(root, prefix).catch(error => failures.push(error))
  if (failures.length > 0) throw new AggregateError(failures, 'Stock composer toolbar acceptance failed')
}
