/** Isolated packed DSH profile, lifecycle, and real browser pairing for development tools. */
import { spawn } from 'node:child_process'
import { lstat, mkdir, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertProfileComponents, installPackedBundle, runPackagingCommand } from './packed-profile.mjs'

const START_TIMEOUT_MS = 90_000
export const CLIENT_TIMEOUT_MS = 60_000

/** Unlink projected package links before removing the script's private temporary root. */
export async function removeTemporaryRoot(root, prefix = 'dsh-mobile-boot-smoke-') {
  const absolute = resolve(root)
  if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith(prefix)) {
    throw new Error('Refusing to remove a directory outside this owned temporary root')
  }
  const rootMetadata = await lstat(absolute)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Refusing to remove a replaced or linked temporary root')
  }
  const unlinkNestedLinks = async directory => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) await unlink(path)
      else if (metadata.isDirectory()) await unlinkNestedLinks(path)
    }
  }
  // DSH may project package links into the profile. Never let recursive removal
  // encounter any link.
  await unlinkNestedLinks(absolute)
  await rm(absolute, { recursive: true, force: true })
}

/** Redact launch and pairing credentials from diagnostics. */
export function sanitized(output) {
  return output
    .replace(/([?&#](?:token|key)=)[^\s&#]+/giu, '$1<redacted>')
    .slice(-12_000)
}

/** Observe the real Workspace subscription carried by the page's authenticated WebSocket. */
export function observeWorkspaceStream(page) {
  const state = { sockets: 0, closed: 0, sentOpens: [], receivedFrames: 0, socketErrors: [] }
  let resolveBaseline
  const baseline = new Promise(resolve => { resolveBaseline = resolve })
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/api/remote.mux') return
    state.sockets++
    const streams = new Map()
    socket.on('framesent', frame => {
      let message
      try { message = JSON.parse(String(frame.payload)) } catch { return }
      if (message?.type !== 'open' || typeof message.streamId !== 'string' || typeof message.endpoint !== 'string') return
      streams.set(message.streamId, message.endpoint)
      if (state.sentOpens.length < 12) state.sentOpens.push(message.endpoint)
    })
    socket.on('framereceived', frame => {
      state.receivedFrames++
      let message
      try { message = JSON.parse(String(frame.payload)) } catch { return }
      if (message?.type !== 'item' || streams.get(message.streamId) !== 'workspace/follow') return
      const value = message.value
      if (value?.type !== 'baseline' || !Array.isArray(value.value?.items)
        || !Array.isArray(value.value.archivedSessionIds) || !Array.isArray(value.value.pinnedSessionIds)) return
      resolveBaseline({ workspaces: value.value.items.length, value: value.value, socket })
    })
    socket.on('socketerror', error => { if (state.socketErrors.length < 8) state.socketErrors.push(String(error)) })
    socket.on('close', () => { state.closed++ })
  })
  return { baseline, state }
}

/** Bound an observable state wait; clear the timer on every outcome. */
export async function within(promise, timeoutMs, failure) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(failure())), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}

/** Install the actual npm tarball and reject source or unrelated runtime fallbacks. */
export async function createMobileProfile(root, { tarball, dshBin, excludedClientModules = [], compressedWebSocket = false, missingCompanion = false, extraPatches = [], hostExecution }) {
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'web')
  const mobileState = join(home, 'mobile-access')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await mkdir(mobileState, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }, null, 2) + '\n')
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{
    id: 'mobile-access',
    config: {
      setupFile: join(mobileState, 'setup.json'),
      stateFile: join(mobileState, 'devices.json'),
      controlFile: join(mobileState, 'control.json'),
      customCssFile: join(mobileState, 'mobile.css'),
      customScriptFile: join(mobileState, 'mobile.js'),
      initiallyEnabled: true,
      ...(hostExecution === undefined ? {} : { hostExecution }),
      ...(excludedClientModules.length > 0 ? { excludedClientModules } : {}),
      ...(compressedWebSocket ? { websocketCompression: { paths: ['/api/remote.mux'] } } : {}),
      listenHost: '127.0.0.1',
      listenPort: 0,
      allowedCidrs: ['127.0.0.0/8'],
      tls: { mode: 'disabled' },
    },
  }, ...extraPatches]) + '\n')
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  await installPackedBundle(tarball, profile, { dshBin })
  const installed = join(profile, 'node_modules', 'dsh-mobile')
  await assertProfileComponents(installed)
  if (missingCompanion) {
    const companion = join(installed, 'packages', 'question-fixes')
    const metadata = await lstat(companion)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error('Negative-control component is not a real directory')
    const inside = relative(await realpath(root), await realpath(companion))
    if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) {
      throw new Error('Negative-control component is outside the owned temporary profile')
    }
    await rm(companion, { recursive: true })
    await assertProfileComponents(installed)
  }
  await runPackagingCommand(process.execPath, [
    fileURLToPath(new URL('./check-packed-profile.mjs', import.meta.url)), dshBin, profile, home,
  ], root)
  await writeFile(join(mobileState, 'setup.json'), JSON.stringify({
    version: 1,
    listenHost: '127.0.0.1',
    listenPort: 0,
    allowedCidrs: ['127.0.0.0/8'],
    tls: { mode: 'disabled' },
  }) + '\n')
  return home
}

/** Launch a supported DSH profile with scrubbed environment and await owned process exit. */
export function launchDsh(root, home, dshBin) {
  const environment = {}
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  const child = spawn(process.execPath, [dshBin, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: root,
    env: {
      ...environment,
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(root, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: '',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
      http_proxy: '', https_proxy: '', all_proxy: '',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      NODE_OPTIONS: '', NODE_PATH: '', TSX_TSCONFIG_PATH: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  let exited = false
  let exitResult
  const exit = new Promise(resolve => { exitResult = resolve })
  child.once('error', error => { stderr += `\n${String(error)}` })
  child.once('close', (code, signal) => {
    exited = true
    exitResult({ code, signal })
  })
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-24_000) })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-24_000) })
  const ready = async () => {
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      const url = /dsh web: (http:\/\/[^\s]+)/u.exec(stdout)?.[1]
      if (url !== undefined) return url
      if (exited) throw new Error(`DSH exited before readiness\n${sanitized(stdout)}\n${sanitized(stderr)}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`DSH did not start in ${START_TIMEOUT_MS} ms\n${sanitized(stdout)}\n${sanitized(stderr)}`)
  }
  const close = async () => {
    if (exited) return { ...(await exit), forced: false }
    child.kill('SIGTERM')
    let forced = false
    const watchdog = setTimeout(() => {
      if (exited) return
      forced = true
      child.kill('SIGKILL')
    }, 12_000)
    try { return { ...(await exit), forced } } finally { clearTimeout(watchdog) }
  }
  return { ready, close, logs: () => sanitized(`${stdout}\n${stderr}`) }
}

/** Open one pairing window from a stock DSH page authenticated through its launch URL. */
export async function openPairing(desktop, baseUrl, logs) {
  if (baseUrl !== undefined) await desktop.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  const pairing = await desktop.evaluate(async () => {
    const response = await fetch('/api/mobile-access/pairing/open', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    const text = await response.text()
    let body
    try { body = JSON.parse(text) } catch { body = undefined }
    return { status: response.status, body }
  })
  if (pairing.status !== 201 || typeof pairing.body?.pairUrl !== 'string') {
    throw new Error(`Pairing could not open: status=${pairing.status} json=${String(pairing.body !== undefined)}\n${logs()}`)
  }
  return pairing.body.pairUrl
}

/** Pair a real phone viewport and require both mounted DSH and the Workspace stream baseline. */
export async function pairMobilePage(phone, pairUrl, logs, {
  beforeSubmit,
  workspaceStream = observeWorkspaceStream(phone),
  workspaceTimeoutMs = CLIENT_TIMEOUT_MS,
} = {}) {
  await phone.goto(pairUrl, { waitUntil: 'domcontentloaded' })
  await phone.locator('#pair-form button').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  await beforeSubmit?.(phone)
  await phone.locator('#pair-form button').click()
  await phone.waitForURL(url => url.pathname === '/', { timeout: 15_000 })
  const result = await phone.waitForFunction(() => {
    const root = document.querySelector('#root')
    const boot = document.querySelector('[data-dsh-boot]')
    if (boot?.textContent?.includes('Failed to load plugins')) return 'failed'
    if (root !== null && boot === null && root.querySelector('.dshm-shell') !== null) return 'mounted'
    return false
  }, undefined, { timeout: CLIENT_TIMEOUT_MS })
  try {
    if (await result.jsonValue() !== 'mounted') throw new Error('DSH client reported failed plugin imports')
  } finally { await result.dispose() }
  const workspace = await within(workspaceStream.baseline, workspaceTimeoutMs,
    () => `DSH Workspace stream did not receive an opening baseline over /api/remote.mux: ${sanitized(JSON.stringify(workspaceStream.state))}\n${logs()}`)
  if (workspace.socket.isClosed()) throw new Error('DSH Workspace stream closed after its opening baseline')
  return workspace
}

/** Dismiss first-run choices without hiding arbitrary dialogs from screenshots. */
export async function dismissOnboarding(phone) {
  const dialog = phone.locator('[role="dialog"][aria-modal="true"]').first()
  for (let step = 0; step < 3; step++) {
    await dialog.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {})
    if (await dialog.count() === 0) return
    const label = await dialog.getAttribute('aria-label')
    const choices = await dialog.locator('button').allTextContents()
    const skip = choices.findIndex(value => /稍后|later|skip|not now/iu.test(value))
    const choice = skip >= 0 ? skip : choices.length === 1 ? 0 : -1
    if (choice < 0) throw new Error('Unexpected initial DSH dialog choices')
    await dialog.locator('button').nth(choice).click()
    await phone.waitForFunction(previous => document.querySelector('[role="dialog"][aria-modal="true"]')?.getAttribute('aria-label') !== previous, label)
  }
}
