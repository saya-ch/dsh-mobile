/** Exercise the installed Worker entry through a real DSH profile and paired Gateway. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { packBundle } from './packed-profile.mjs'
import { createMobileProfile, launchDsh, openPairing, pairMobilePage, removeTemporaryRoot } from './mobile-boot-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const dshBin = resolve(process.env.DSH_BOOT_SMOKE_BIN ?? join(repository, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))
const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-smoke-'))
let owner
let browser
try {
  const directory = join(root, 'home/mobile-access/extensions/worker-smoke')
  const effects = join(root, 'effects.txt')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'worker-smoke', name: 'Worker smoke', version: '1' }) + '\n')
  await writeFile(join(directory, 'host.mjs'), `
import { appendFileSync } from 'node:fs'
import { Readable } from 'node:stream'
export default api => {
  appendFileSync(${JSON.stringify(effects)}, 'activate\\n')
  api.action('probe', { run: () => ({ ok: true }) })
  api.action('spin', { timeoutMs: 5000, run: () => {
    appendFileSync(${JSON.stringify(effects)}, 'spin\\n')
    while (true) {}
  } })
  api.route({ method: 'GET', path: '/stream', handle: () => ({ body: Readable.from([Buffer.alloc(700000, 120)]) }) })
}
`)
  const tarball = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL ?? await packBundle(repository, root)
  const home = await createMobileProfile(root, { tarball, dshBin, hostExecution: { mode: 'worker', cancelGraceMs: 100 } })
  owner = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const desktop = await browser.newPage()
  await desktop.goto(await owner.ready(), { waitUntil: 'domcontentloaded' })
  const hosts = () => desktop.evaluate(async () => {
    const response = await fetch('/api/mobile-access/extensions/hosts')
    if (!response.ok) throw new Error(`Host status: ${response.status}`)
    return response.json()
  })
  const initial = await hosts()
  assert.equal(initial.hosts.length, 1)
  assert.equal(initial.hosts[0].mode, 'worker')
  assert.equal(initial.hosts[0].state, 'ready')
  console.log('Packed Worker: loaded by DSH')
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await pairMobilePage(phone, await openPairing(desktop, undefined, owner.logs), owner.logs)
  console.log('Packed Worker: paired client mounted')
  const action = name => phone.evaluate(async name => {
    const csrf = document.cookie.split('; ').find(value => value.startsWith('dsh_ma_csrf='))?.slice('dsh_ma_csrf='.length)
    const response = await fetch(`/mobile-access/extensions/worker-smoke/actions/${name}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-dsh-mobile-csrf': decodeURIComponent(csrf ?? '') }, body: '{}',
    })
    return { status: response.status, body: await response.json() }
  }, name)
  const probe = await action('probe')
  assert.equal(probe.status, 200)
  assert.deepEqual(probe.body, { ok: true })
  const streamed = await phone.evaluate(async () => {
    const response = await fetch('/mobile-access/extensions/worker-smoke/routes/stream')
    const bytes = new Uint8Array(await response.arrayBuffer())
    return { status: response.status, length: bytes.length, correct: bytes.every(value => value === 120) }
  })
  assert.deepEqual(streamed, { status: 200, length: 700000, correct: true })
  let settled = false
  const spinning = action('spin').finally(() => { settled = true })
  const startDeadline = performance.now() + 3000
  while (!(await readFile(effects, 'utf8')).includes('spin\n')) {
    assert.ok(performance.now() < startDeadline, 'The blocking action did not start')
    await delay(10)
  }
  assert.equal(settled, false)
  const responsive = await desktop.evaluate(async () => {
    const response = await fetch('/api/mobile-access/lan/control')
    return { status: response.status, running: (await response.json()).running }
  })
  assert.deepEqual(responsive, { status: 200, running: true })
  assert.equal(settled, false, 'The Host must answer while the Worker action is still blocked')
  const timedOut = await spinning
  assert.equal(timedOut.status, 500)
  assert.equal(timedOut.body.error, 'extension_action_timeout')
  const exitDeadline = performance.now() + 10000
  while ((await hosts()).hosts[0]?.state !== 'unavailable') {
    assert.ok(performance.now() < exitDeadline, 'The timed-out Worker did not become unavailable')
    await delay(20)
  }
  assert.equal((await hosts()).hosts[0].state, 'unavailable')
  const recover = confirm => desktop.evaluate(async confirm => {
    const response = await fetch('/api/mobile-access/extensions/recover', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'worker-smoke', confirm }),
    })
    return { status: response.status, body: await response.json() }
  }, confirm)
  assert.equal((await recover(false)).status, 400)
  assert.equal((await hosts()).hosts[0].state, 'unavailable')
  assert.equal((await readFile(effects, 'utf8')).split('\n').filter(value => value === 'activate').length, 1)
  const recovered = await recover(true)
  assert.equal(recovered.status, 200, JSON.stringify({ body: recovered.body, effects: await readFile(effects, 'utf8') }))
  assert.equal(recovered.body.hosts[0].state, 'ready')
  assert.equal(recovered.body.hosts[0].generation, initial.hosts[0].generation, 'Unchanged source keeps its content generation')
  assert.equal((await action('probe')).status, 200)
  assert.equal((await recover(true)).status, 409)
  assert.equal((await readFile(effects, 'utf8')).split('\n').filter(value => value === 'spin').length, 1)
  assert.equal((await readFile(effects, 'utf8')).split('\n').filter(value => value === 'activate').length, 2)
  console.log('Packed Worker smoke passed: DSH Loader default entry, authenticated action, 700KB HTTP stream, responsive Host during synchronous loop, termination and confirmed recovery without replay')
} finally {
  await browser?.close()
  await owner?.close()
  await removeTemporaryRoot(root, 'dsh-mobile-worker-smoke-')
}
