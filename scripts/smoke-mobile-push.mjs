/** Packed, loopback-only Task 8 acceptance for declarative Mobile Web Push. */
import assert from 'node:assert/strict'
import { createECDH, randomBytes, randomUUID, createHash, X509Certificate } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { createSecureContext } from 'node:tls'
import { createRequire } from 'node:module'
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { closeSync, openSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'
import {
  CLIENT_TIMEOUT_MS, createMobileProfile, dismissOnboarding, observeWorkspaceStream, openMobileSettings, openPairing,
  pairMobilePage, removeTemporaryRoot, sanitized, within,
} from './mobile-boot-fixture.mjs'
import { createPushIntegrationFixture, packPushIntegrationFixture } from './push-integration-fixture.mjs'
import { readTransportEvidence } from './push-evidence-reader.mjs'
import { installPackedBundle } from './packed-profile.mjs'
import { completeSmoke } from './negative-control.mjs'

const repository = fileURLToPath(new URL('../', import.meta.url))
const TRANSPORT_MARKER = 'dsh.mobile.push.integration.transport'
// Allowed DSH runtimes for the packed push lanes (kept identical to scripts/smoke-mobile-push-contract.mjs).
const RUNTIME_VERSIONS = ['0.2.1-rc.2', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.2-alpha.3', '0.2.2-rc.1', '0.2.2-rc.2']
const OWNER_NEGATIVE_MARKER = 'Push ownership negative control detected'
const PAIR_DIAGNOSTIC_LOG_ENV = 'DSH_PUSH_PAIR_DIAGNOSTIC_LOG'
const args = process.argv.slice(2)
const allowed = new Set(['--help', '--transport-self-test', '--negative-control-owner', '--pair-diagnostic'])
for (const arg of args) if (!allowed.has(arg)) throw new Error(`Unknown argument: ${arg}`)
assert.equal(new Set(args).size, args.length, 'Duplicate smoke arguments are not supported')
assert(args.filter(arg => arg === '--transport-self-test' || arg === '--negative-control-owner' || arg === '--pair-diagnostic').length <= 1,
  'Transport self-test, pair diagnostic and full-smoke modes cannot be combined')

const usage = `Usage: node scripts/smoke-mobile-push.mjs [--transport-self-test|--negative-control-owner|--pair-diagnostic|--help]

Full packed smoke requires explicit artifacts:
  DSH_BOOT_SMOKE_BIN=/path/to/owned/dsh/lib/bin.js
  DSH_BOOT_SMOKE_MOBILE_TARBALL=/path/to/coherent-built-dsh-mobile.tgz

Optional: DSH_PUSH_EVIDENCE_DIR=<absolute dir> retains raw per-child guard/helper/preflight
evidence before the owned temporary root is removed (private diagnostics; CI needs no such dir).

--transport-self-test proves the three-preload owned child guard chain (network guard -> transport
helper -> hard preflight attestation), web-push encryption/decryption, loopback pass-through,
fail-closed unowned Apple endpoints, fail-closed non-loopback/conflicting connect shapes, and
missing-preload aborts before any egress, with complete cleanup and without DSH.
--negative-control-owner intentionally runs the cross-device opaque-reference denial and, only after
all smoke diagnostics and cleanup succeed, emits: ${OWNER_NEGATIVE_MARKER}
--pair-diagnostic stops after the owned pair attempt and records redacted boundary evidence before
cleanup; it requires DSH_PUSH_PAIR_DIAGNOSTIC_LOG=<absolute new file> for its progress log.
All runtime diagnostics are written inside the owned per-run temporary root and retained only
through DSH_PUSH_EVIDENCE_DIR; no private plan path is used.`
if (args.includes('--help')) { console.log(usage); process.exit(0) }

const prefix = 'dsh-mobile-push-smoke-'
const transportPath = join(repository, 'scripts', 'push-integration-transport.mjs')
const networkGuardPath = join(repository, 'scripts', 'push-integration-network-guard.mjs')
const preflightPath = join(repository, 'scripts', 'push-integration-preflight.mjs')
/** Owned reserved-TLD authority for the loopback-bound Gateway (RFC 6761 .test; never resolves publicly). */
const FIXTURE_AUTHORITY_HOST = 'task8-push.dsh-smoke.test'
const preloadImport = path => `--import=${pathToFileURL(path).href}`
/** The order is load-bearing: outer network guard first, transport helper second, hard preflight last. */
const guardChainImports = () => [networkGuardPath, transportPath, preflightPath].map(preloadImport).join(' ')
const fileSha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const webPushPath = createRequire(join(repository, 'package.json')).resolve('web-push')
const httpEcePath = createRequire(webPushPath).resolve('http_ece')

function deferred() {
  let resolvePromise, rejectPromise
  const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function tail(text, limit = 12_000) { return String(text).slice(-limit) }
function safeText(text) {
  return sanitized(String(text))
    .replace(/([?&#]mobile-push=)[A-Za-z0-9_-]+/giu, '$1<opaque>')
    .replace(/n-[a-f0-9]{48}\.push\.apple\.com/giu, '<nonce-owned-push-host>')
    .slice(-12_000)
}

function safeHostLogEvidence(text) {
  const relevant = String(text).split(/\r?\n/u).filter(line => /sessionQuery|observeSession|dsh-mobile-push-integration-fixture|Cordis|plugin.*(?:fail|error)|(?:fail|error).*plugin|TypeError|ReferenceError|SessionQueryError|sqlite|DSH_MOBILE_PUSH_ORIGIN_ATTACH_FAILED|declarative push unavailable|declarative push origin attach failed|Mobile push origin attachment failed/iu.test(line))
  return relevant.slice(-12).map(line => safeText(line)
    .replace(/https?:\/\/\S+/giu, '<url>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, '<uuid>')
    .replace(/\btask8-never-created-[A-Za-z0-9_-]+\b/giu, '<fixture-session>')
    .replace(/\b(?:session|reference|token|device|installation|nonce)[-_]?(?:id)?\s*[:=]\s*[^\s,;]+/giu, '<id-redacted>')
    .replace(/\b[A-Za-z0-9_-]{80,}\b/gu, '<opaque>')
    .replace(/\/Users\/[^/\s]+/gu, '/Users/<user>')
    .slice(-240))
}

function pairDiagnosticEntry(fd, runId, phase, stage, fields = {}) {
  if (fd === undefined) return
  const safeFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value === null
    || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'))
  writeSync(fd, JSON.stringify({ runId, at: new Date().toISOString(), phase, stage, ...safeFields }) + '\n')
}

function pairDiagnosticDetail(fd, runId, phase, stage, details) {
  if (fd === undefined) return
  writeSync(fd, JSON.stringify({ runId, at: new Date().toISOString(), phase, stage, details }) + '\n')
}

/**
 * Settle one promise under a deadline with an HONEST outcome label: 'fulfilled', 'rejected'
 * (including rejection with an undefined reason), or 'timeout'. `completed` is kept for existing
 * callers and means only "settled before the deadline", never success.
 */
function settleBefore(promise, timeoutMs) {
  let timer
  return Promise.race([
    Promise.resolve(promise).then(
      value => ({ completed: true, status: 'fulfilled', value }),
      error => ({ completed: true, status: 'rejected', error })),
    new Promise(resolve => { timer = setTimeout(() => resolve({ completed: false, status: 'timeout' }), timeoutMs) }),
  ]).finally(() => clearTimeout(timer))
}

/**
 * Derive the warm-tap history-return labels from OBSERVED session identity plus the wait's honest
 * settlement status — never from settlement alone. Persistence is claimed only when the draft
 * session itself was observed after the return; otherwise it stays 'cannot-verify'.
 */
function historyReturnLabels({ waitStatus, observedSessionId, draftSessionId, observedDraft, unsentDraft }) {
  const restoredToDraftSession = waitStatus === 'fulfilled' && observedSessionId === draftSessionId
  return {
    historyReturn: { waitStatus, restoredToDraftSession, landedOnSession: observedSessionId ?? null },
    draftSessionPersistence: restoredToDraftSession
      ? (observedDraft === unsentDraft ? 'retained' : 'not-retained')
      : 'cannot-verify',
  }
}

/**
 * Validate one child's FINAL network-guard evidence after that child has exited: exact PID, no
 * blocked entries of any family, and both binding attestations still true. Pure on its input so the
 * covering controls can exercise every failure branch.
 */
function checkFinalGuardEvidence(evidence, expectedPid) {
  if (evidence === undefined || evidence === null) return { ok: false, reason: 'missing-final-guard-evidence' }
  if (evidence.processId !== expectedPid) {
    return { ok: false, reason: `final-guard-pid-mismatch:${String(evidence.processId)}!==${String(expectedPid)}` }
  }
  const counters = ['dnsBlocked', 'resolveBlocked', 'connectBlocked', 'httpBlocked', 'fetchBlocked', 'udpDnsBlocked']
  for (const counter of counters) {
    const value = evidence[counter]
    if (value === undefined || value === null || value < 0 || !Number.isSafeInteger(value)) {
      return { ok: false, reason: `final-guard-counter-invalid:${counter}=${String(value)}` }
    }
    if (value !== 0) return { ok: false, reason: `final-guard-block-present:${counter}=${String(value)}` }
  }
  if (!Array.isArray(evidence.blocked) || evidence.blocked.length !== 0) {
    return { ok: false, reason: `final-guard-blocked-entries:${String(evidence.blocked?.length ?? 'not-an-array')}` }
  }
  if (evidence.facadeSyncEffective !== true || evidence.cjsPatchVisible !== true) {
    return { ok: false, reason: 'final-guard-attestation-not-visible' }
  }
  return { ok: true, reason: null, finalCounters: Object.fromEntries(counters.map(counter => [counter, evidence[counter]])) }
}

/**
 * Release-check route matcher (F1): the tested product's best-effort update lookup
 * (GET /api/mobile-access/release; src/release-update.ts via src/plugin.ts, triggered by
 * src/client.ts's control-panel install) is aborted at the OWNED Playwright route boundary before
 * it can reach the Gateway, so the child's release manager never issues its external fetches.
 * ONLY this exact GET is matched; everything else passes through untouched.
 */
function isReleaseCheckRequest(url, method, allowedOrigins) {
  try {
    const parsed = new URL(url)
    return String(method).toUpperCase() === 'GET'
      && parsed.pathname === '/api/mobile-access/release'
      && (allowedOrigins instanceof Set ? allowedOrigins.has(parsed.origin) : false)
  } catch { return false }
}

const releaseCheckInterceptions = { count: 0, methods: new Set(), origins: new Set(),
  nonMatchingPassThrough: 0, foreignOriginSamePathPassThrough: 0 }

/**
 * Arm the owned release-check abort on one context BEFORE any of its pages navigate. The route
 * glob deliberately also catches query-suffixed and sub-path spellings; the exact decision is the
 * pure matcher above: ONLY an exact-path GET whose origin is one of the run's OWNED control origins
 * (upstream desktop or the Gateway public authority) is aborted. Same-path foreign-origin and
 * non-GET requests pass through untouched and are counted separately.
 */
function armReleaseCheckAbort(context, label, allowedOrigins) {
  return context.route('**/api/mobile-access/release*', async route => {
    const request = route.request()
    let url
    try { url = new URL(request.url()) } catch { releaseCheckInterceptions.nonMatchingPassThrough += 1; await route.continue(); return }
    if (String(request.method()).toUpperCase() !== 'GET' || url.pathname !== '/api/mobile-access/release') {
      releaseCheckInterceptions.nonMatchingPassThrough += 1
      await route.continue()
      return
    }
    if (!allowedOrigins.has(url.origin)) {
      releaseCheckInterceptions.foreignOriginSamePathPassThrough += 1
      await route.continue()
      return
    }
    releaseCheckInterceptions.count += 1
    releaseCheckInterceptions.methods.add(request.method())
    releaseCheckInterceptions.origins.add(url.origin)
    await route.abort('blockedbyclient')
  }).then(() => label)
}

function waitForChildClose(child, timeoutMs) {
  if (child === undefined || child === null || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ exited: true, code: child?.exitCode ?? null, signal: child?.signalCode ?? null })
  }
  return new Promise(resolve => {
    const onClose = (code, signal) => { clearTimeout(timer); resolve({ exited: true, code, signal }) }
    const timer = setTimeout(() => { child.removeListener('close', onClose); resolve({ exited: false, timeout: true }) }, timeoutMs)
    child.once('close', onClose)
  })
}

async function closeBrowserBounded(browser) {
  if (browser === undefined) return { closed: true, acquired: false }
  const child = typeof browser.process === 'function' ? browser.process() : undefined
  const closeTask = Promise.resolve().then(() => browser.close()).then(() => ({ ok: true }), error => ({ ok: false, errorName: error?.name ?? 'Error' }))
  const apiClose = await settleBefore(closeTask, 10_000)
  let signalSent = null, forceKillSent = false
  if (!apiClose.completed || apiClose.value?.ok !== true) {
    if (child && child.exitCode === null && child.signalCode === null) {
      signalSent = 'SIGTERM'
      try { child.kill('SIGTERM') } catch {}
    }
  }
  let processClose = await waitForChildClose(child, 5_000)
  if (!processClose.exited && child && child.exitCode === null && child.signalCode === null) {
    forceKillSent = true
    try { child.kill('SIGKILL') } catch {}
    processClose = await waitForChildClose(child, 5_000)
  }
  return { closed: processClose.exited && (apiClose.completed || child !== undefined), apiCloseCompleted: apiClose.completed,
    apiCloseOk: apiClose.value?.ok ?? false, apiCloseTimedOut: !apiClose.completed, signalSent, forceKillSent,
    processExitCode: processClose.code ?? child?.exitCode ?? null, processSignal: processClose.signal ?? child?.signalCode ?? null,
    processExitConfirmed: processClose.exited }
}

async function safeResponseErrorCode(response, page, timeoutMs = 3_000) {
  if (response === undefined || response.status() < 400) return null
  const bodyRead = response.json().then(value => ({ value }), () => ({ value: null }))
  const result = await settleBefore(bodyRead, timeoutMs)
  if (!result.completed) { await page?.close().catch(() => {}); return null }
  const candidate = result.value?.value?.errorCode ?? result.value?.value?.code ?? result.value?.value?.error
  return typeof candidate === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(candidate) ? candidate : null
}

async function installedPackageIdentity(entryPath) {
  const entry = await realpath(entryPath)
  let directory = dirname(entry)
  for (let level = 0; level < 10; level++) {
    const metadataPath = join(directory, 'package.json')
    let source
    try { source = await readFile(metadataPath, 'utf8') }
    catch (error) { if (error.code === 'ENOENT') { directory = dirname(directory); continue } throw error }
    const metadata = JSON.parse(source)
    if (typeof metadata.name === 'string' && typeof metadata.version === 'string') {
      return { name: metadata.name, version: metadata.version, license: metadata.license ?? null, packagePath: directory, entryPath: entry }
    }
    directory = dirname(directory)
  }
  throw new Error('Installed package metadata was not found for a resolved runtime entry')
}

function limitedEnvironment(extra = {}) {
  const result = {}
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) result[key] = process.env[key]
  }
  Object.assign(result, {
    NODE_OPTIONS: '', NODE_PATH: '', TSX_TSCONFIG_PATH: '',
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    DSH_TELEMETRY_DISABLED: '1', DEEPSEEK_API_KEY: '',
  }, extra)
  return result
}

async function runChild(command, childArgs, cwd, env, timeoutMs = 90_000, allowNonZeroExit = false) {
  const child = spawn(command, childArgs, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', exited = false
  let exitValue
  const exit = new Promise(resolveExit => { exitValue = resolveExit })
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout = tail(stdout + chunk, 32_000) })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = tail(stderr + chunk, 32_000) })
  child.once('error', error => { stderr = tail(stderr + String(error), 32_000) })
  child.once('close', (code, signal) => { exited = true; exitValue({ code, signal }) })
  let timer
  try {
    const result = await Promise.race([
      exit,
      new Promise((_resolve, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('owned child timed out')) }, timeoutMs) }),
    ])
    if ((result.code !== 0 || result.signal !== null) && !allowNonZeroExit) {
      throw new Error(`owned child failed (${JSON.stringify(result)}): ${safeText(stdout)}\n${safeText(stderr)}`)
    }
    return { stdout, stderr, exited: true, code: result.code, signal: result.signal, pid: child.pid }
  } catch (error) {
    if (!exited) {
      child.kill('SIGKILL')
      await exit
    }
    throw new Error(`${error.message}\nowned child stdout=${safeText(stdout)}\nowned child stderr=${safeText(stderr)}`)
  } finally { clearTimeout(timer) }
}

async function reserveLoopbackPort() {
  const server = createServer()
  await new Promise((resolveListen, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolveListen()))
  const address = server.address()
  assert(address && typeof address === 'object')
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return address.port
}

async function configureOwnedHttps(root, home, listenPort) {
  assert(Number.isInteger(listenPort) && listenPort > 0 && listenPort <= 65_535)
  const selfsigned = createRequire(join(repository, 'package.json'))('selfsigned')
  const ca = await selfsigned.generate([{ name: 'commonName', value: 'Task8 owned loopback fixture CA' }], {
    algorithm: 'sha256', keyType: 'ec', curve: 'P-256', days: 1,
    extensions: [{ name: 'basicConstraints', cA: true }, { name: 'keyUsage', keyCertSign: true, cRLSign: true }],
  })
  const intermediate = await selfsigned.generate([{ name: 'commonName', value: 'Task8 owned loopback fixture intermediate' }], {
    algorithm: 'sha256', keyType: 'ec', curve: 'P-256', days: 1, ca: { key: ca.private, cert: ca.cert },
    extensions: [{ name: 'basicConstraints', cA: true, pathLenConstraint: 0 },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true }],
  })
  // The public authority is an owned reserved-.test name; the listener itself stays bound to explicit loopback.
  const leaf = await selfsigned.generate([{ name: 'commonName', value: FIXTURE_AUTHORITY_HOST }], {
    algorithm: 'sha256', keyType: 'ec', curve: 'P-256', days: 1, ca: { key: intermediate.private, cert: intermediate.cert },
    extensions: [{ name: 'basicConstraints', cA: false },
      { name: 'subjectAltName', altNames: [{ type: 2, value: FIXTURE_AUTHORITY_HOST }, { type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }] },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true }, { name: 'extKeyUsage', serverAuth: true }],
  })
  const rootCertificate = new X509Certificate(ca.cert)
  const intermediateCertificate = new X509Certificate(intermediate.cert)
  const leafCertificate = new X509Certificate(leaf.cert)
  assert.equal(rootCertificate.ca, true)
  assert.equal(intermediateCertificate.ca, true)
  assert(intermediateCertificate.checkIssued(rootCertificate) && intermediateCertificate.verify(rootCertificate.publicKey))
  assert.equal(leafCertificate.checkHost(FIXTURE_AUTHORITY_HOST), FIXTURE_AUTHORITY_HOST)
  assert.equal(leafCertificate.checkIP('127.0.0.1'), '127.0.0.1')
  assert(leafCertificate.checkIssued(intermediateCertificate) && leafCertificate.verify(intermediateCertificate.publicKey))
  createSecureContext({ cert: leaf.cert, key: leaf.private, ca: intermediate.cert })
  const tlsRoot = join(root, 'owned-loopback-tls')
  await mkdir(tlsRoot, { recursive: true })
  const certFile = join(tlsRoot, 'loopback-leaf.pem'), keyFile = join(tlsRoot, 'loopback-leaf-key.pem')
  const caFile = join(tlsRoot, 'private-fixture-intermediate.pem')
  const rootCaFile = join(tlsRoot, 'private-fixture-ca.pem'), rootCaKeyFile = join(tlsRoot, 'private-fixture-ca-key.pem')
  await Promise.all([
    writeFile(certFile, leaf.cert, { mode: 0o600 }), writeFile(keyFile, leaf.private, { mode: 0o600 }),
    writeFile(caFile, intermediate.cert, { mode: 0o600 }), writeFile(rootCaFile, ca.cert, { mode: 0o600 }),
    writeFile(rootCaKeyFile, ca.private, { mode: 0o600 }),
  ])
  const tls = { mode: 'provided', certFile, keyFile, caFile }
  const profile = join(home, 'profiles', 'web')
  const patchFile = join(profile, 'cordis.patch.yml')
  const patch = JSON.parse(await readFile(patchFile, 'utf8'))
  const mobile = patch.find(entry => entry.id === 'mobile-access')
  assert(mobile?.config, 'Owned Mobile Gateway config patch was missing')
  mobile.config.tls = tls
  mobile.config.listenHost = '127.0.0.1'
  mobile.config.listenPort = listenPort
  mobile.config.publicAuthorities = [FIXTURE_AUTHORITY_HOST]
  await writeFile(patchFile, JSON.stringify(patch) + '\n', { mode: 0o600 })
  const setupFile = join(home, 'mobile-access', 'setup.json')
  const setup = JSON.parse(await readFile(setupFile, 'utf8'))
  setup.listenHost = '127.0.0.1'
  setup.listenPort = listenPort
  setup.tls = tls
  setup.publicAuthorities = [FIXTURE_AUTHORITY_HOST]
  await writeFile(setupFile, JSON.stringify(setup) + '\n', { mode: 0o600 })
  return { caFile, certFile, privateCa: true, listenerHost: '127.0.0.1', publicAuthority: FIXTURE_AUTHORITY_HOST }
}

function testKeys() {
  const receiver = createECDH('prime256v1')
  receiver.generateKeys()
  const auth = randomBytes(16)
  return { receiver, auth, p256dh: receiver.getPublicKey(undefined, 'uncompressed').toString('base64url'), authKey: auth.toString('base64url') }
}

async function decryptCaptured(bodyBase64, keyMaterial, modulePath = httpEcePath) {
  const requireEce = createRequire(modulePath)
  const ece = requireEce(modulePath)
  const plaintext = ece.decrypt(Buffer.from(bodyBase64, 'base64'), {
    privateKey: keyMaterial.receiver,
    authSecret: keyMaterial.authKey,
    version: 'aes128gcm',
  })
  return JSON.parse(plaintext.toString('utf8'))
}

function projectTransportEvidence(value) {
  const counter = key => Number.isSafeInteger(value?.[key]) && value[key] >= 0 ? value[key] : null
  return { evidencePresent: value !== undefined, dnsOwned: counter('dnsOwned'), requestsAccepted: counter('requestsAccepted'),
    appleRequestsBlocked: counter('appleRequestsBlocked'), bodyBytes: counter('bodyBytes'),
    bodySha256Present: typeof value?.bodySha256 === 'string', bodyBase64Present: typeof value?.bodyBase64 === 'string' }
}

async function transportSelfTest() {
  const root = await mkdtemp(join(tmpdir(), prefix + 'guard-'))
  const keys = testKeys()
  let server
  let localHits = 0
  const checks = []
  const runGuardedChild = async ({ label, imports, script, expectExitZero = true, nonce = randomBytes(24).toString('hex') }) => {
    const paths = {
      transportEvidence: join(root, `selftest-${label}-transport.json`),
      guardEvidence: join(root, `selftest-${label}-guard.json`),
      preflightEvidence: join(root, `selftest-${label}-preflight.json`),
    }
    const childEnv = limitedEnvironment({
      HOME: root, TMPDIR: root,
      DSH_PUSH_TRANSPORT_NONCE: nonce,
      DSH_PUSH_TRANSPORT_EVIDENCE: paths.transportEvidence,
      DSH_GUARD_TRIPWIRE_EVIDENCE: paths.guardEvidence,
      DSH_GUARD_BOOTSTRAP_EVIDENCE: paths.preflightEvidence,
      NODE_OPTIONS: imports,
    })
    const child = await runChild(process.execPath, ['--input-type=module', '-e', script], root, childEnv, 30_000, !expectExitZero)
    return { child, ...paths, nonce }
  }
  const readEvidence = async path => readTransportEvidence(path)
  try {
    server = createServer((request, response) => {
      localHits++
      request.resume()
      response.writeHead(204)
      response.end()
    })
    server.listen(0, '127.0.0.1')
    await new Promise((resolveListen, reject) => { server.once('listening', resolveListen); server.once('error', reject) })
    const address = server.address()
    assert(address && typeof address === 'object' && Number.isInteger(address.port))

    // Child A — full three-preload chain, production-shaped synthetic request, delta-counted evidence.
    const positiveNonce = randomBytes(24).toString('hex')
    const endpoint = `https://n-${positiveNonce}.push.apple.com/${positiveNonce}`
    const selfTestNavigate = 'https://wire-selftest.example.test/?mobile-push=selftest-ref'
    const plaintext = JSON.stringify({ web_push: 8030, notification: { title: 'Fixture', body: 'Synthetic only', lang: 'en', navigate: selfTestNavigate, tag: 'push-selftest' } })
    const positive = await runGuardedChild({
      label: 'positive',
      nonce: positiveNonce,
      imports: guardChainImports(),
      script: `
        import assert from 'node:assert/strict'
        import dns from 'node:dns/promises'
        import https from 'node:https'
        import http from 'node:http'
        import { createRequire } from 'node:module'
        const guardMarker=globalThis[Symbol.for('dsh.mobile.push.guard.tripwire')]
        assert.deepEqual(guardMarker,{version:3},'network guard preload was not active before the helper')
        const marker=globalThis[Symbol.for(${JSON.stringify(TRANSPORT_MARKER)})]
        assert.deepEqual(marker,{version:1},'owned preload was not active before package imports')
        const preflightMarker=globalThis[Symbol.for('dsh.mobile.push.guard.bootstrap')]
        assert.deepEqual(preflightMarker,{version:1,attested:true},'hard preflight did not attest before the main entry')
        const webPush=createRequire(${JSON.stringify(join(repository, 'package.json'))})(${JSON.stringify(webPushPath)})
        const url=new URL(${JSON.stringify(endpoint)})
        const subscription={endpoint:url.href,keys:{p256dh:${JSON.stringify(keys.p256dh)},auth:${JSON.stringify(keys.authKey)}}}
        const vapid=webPush.generateVAPIDKeys()
        const details=webPush.generateRequestDetails(subscription,${JSON.stringify(plaintext)},{contentEncoding:'aes128gcm',vapidDetails:{subject:'mailto:push-fixture@example.test',publicKey:vapid.publicKey,privateKey:vapid.privateKey},TTL:60,timeout:10000})
        const answer=await dns.lookup(url.hostname,{all:true,verbatim:true})
        assert.deepEqual(answer,[{address:'17.0.0.1',family:4}])
        assert.deepEqual(await dns.lookup('0.0.0.0',{all:true}),[{address:'0.0.0.0',family:4}])
        assert.deepEqual(await dns.lookup('255.255.255.255',{all:true}),[{address:'255.255.255.255',family:4}])
        await new Promise((resolve,reject)=>{
          const request=https.request(url,{method:details.method,headers:details.headers,servername:url.hostname,rejectUnauthorized:true,agent:false,lookup:(_host,_options,callback)=>callback(null,'17.0.0.1',4)},response=>{assert.equal(response.statusCode,201);response.resume();response.once('end',resolve)})
          request.once('error',reject);request.end(details.body)
        })
        await assert.rejects(dns.lookup('unowned.push.apple.com',{all:true}),/external_apple_dns_blocked/)
        assert.throws(()=>https.request(new URL('https://unowned.push.apple.com/x'),{method:'POST',servername:'unowned.push.apple.com',rejectUnauthorized:true,agent:false}),/external_apple_https_blocked/)
        await new Promise((resolve,reject)=>{http.get(${JSON.stringify(`http://127.0.0.1:${address.port}/unrelated`)},response=>{assert.equal(response.statusCode,204);response.resume();response.once('end',resolve)}).once('error',reject)})
        process.stdout.write('transport-child-ok')
      `,
    })
    assert.equal(positive.child.code, 0)
    assert(positive.child.stdout.includes('transport-child-ok'), 'positive guard-chain child did not reach its synthetic provider receipt')
    const positiveTransport = await readEvidence(positive.transportEvidence)
    const positiveGuard = await readEvidence(positive.guardEvidence)
    const positivePreflight = await readEvidence(positive.preflightEvidence)
    assert.equal(positivePreflight?.attested, true, 'preflight did not attest before the main entry')
    assert.equal(positivePreflight?.bindingIdentity?.namedBindingIsCjsProperty, true)
    assert.equal(positivePreflight?.processId, positive.child.pid, 'preflight evidence PID did not match the actual child')
    assert.equal(positiveGuard?.processId, positive.child.pid, 'guard evidence PID did not match the actual child')
    assert.equal(positiveGuard?.facadeSyncEffective, true)
    assert.equal(positiveGuard?.cjsPatchVisible, true)
    assert.deepEqual(positiveGuard?.blocked ?? [{}], [], 'the outer guard blocked a legitimated owned-child call')
    // The preflight deliberately probes dnsOwned+1 / appleRequestsBlocked+2 before the main entry,
    // so these literals are the preflight baseline plus exactly one owned send attempt.
    assert.equal(positiveTransport?.processId, positive.child.pid)
    assert.equal(positiveTransport?.dnsOwned, 2)
    assert.equal(positiveTransport?.requestsAccepted, 1)
    assert.equal(positiveTransport?.appleRequestsBlocked, 4)
    assert(positiveTransport.bodyBytes > 0)
    assert.equal(positiveGuard?.delegatedOriginals?.httpGet, 1)
    assert.equal(positiveGuard?.delegatedOriginals?.httpsRequest, 0)
    assert.equal(positiveGuard?.dnsBlocked, 0)
    assert.equal(positiveGuard?.connectBlocked, 0)
    assert.equal(positiveGuard?.httpBlocked, 0)
    const decrypted = await decryptCaptured(positiveTransport.bodyBase64, keys)
    assert.deepEqual(decrypted, { web_push: 8030, notification: { title: 'Fixture', body: 'Synthetic only', lang: 'en', navigate: selfTestNavigate, tag: 'push-selftest' } })
    assert.equal(new URL(decrypted.notification.navigate).href, selfTestNavigate,
      'self-test wire navigate must stay an absolute URL parsable without a base URL')
    assert.equal(localHits, 1, 'unrelated loopback HTTP traffic must pass through unchanged')
    checks.push('three-preload chain active before main (guard marker, helper marker, preflight attestation with PID match)',
      'nonce-scoped Apple DNS returned only the controlled global address after the preflight baseline',
      'only nonce-owned Apple HTTPS returned synthetic 201 with a decryptable aes128gcm body',
      'unowned Apple DNS/HTTPS failed closed inside the helper with no guard leak and no outbound call',
      'unrelated loopback HTTP request passed through with exactly one original delegation')

    // Child B — missing outer network guard must abort at preload before the main entry or any egress.
    const missingGuard = await runGuardedChild({
      label: 'missing-guard',
      expectExitZero: false,
      imports: [preloadImport(transportPath), preloadImport(preflightPath)].join(' '),
      script: `process.stdout.write('main-reached')`,
    })
    assert.notEqual(missingGuard.child.code, 0, 'a child without the network guard must not reach its main entry')
    assert(!missingGuard.child.stdout.includes('main-reached'))
    const missingGuardPreflight = await readEvidence(missingGuard.preflightEvidence)
    assert.equal(missingGuardPreflight?.failure, 'outer tripwire marker absent or not v3')
    assert.equal(missingGuardPreflight?.processId, missingGuard.child.pid)
    const missingGuardTransport = await readEvidence(missingGuard.transportEvidence)
    assert.equal(missingGuardTransport?.processId, missingGuard.child.pid)
    assert.equal(missingGuardTransport?.dnsOwned ?? 0, 0, 'a preload-aborted child must emit no owned DNS probe')
    assert.equal(missingGuardTransport?.requestsAccepted ?? 0, 0)
    assert.equal(missingGuardTransport?.appleRequestsBlocked ?? 0, 0)
    assert.equal(await readEvidence(missingGuard.guardEvidence), undefined, 'no guard evidence may exist when the guard is not preloaded')
    checks.push('missing network guard aborted at the preflight marker check before main entry or any egress')

    // Child C — missing transport helper must abort at preload before the main entry or any egress.
    const missingHelper = await runGuardedChild({
      label: 'missing-helper',
      expectExitZero: false,
      imports: [preloadImport(networkGuardPath), preloadImport(preflightPath)].join(' '),
      script: `process.stdout.write('main-reached')`,
    })
    assert.notEqual(missingHelper.child.code, 0, 'a child without the transport helper must not reach its main entry')
    assert(!missingHelper.child.stdout.includes('main-reached'))
    const missingHelperPreflight = await readEvidence(missingHelper.preflightEvidence)
    assert.equal(missingHelperPreflight?.failure, 'Task8 helper marker absent')
    assert.equal(missingHelperPreflight?.processId, missingHelper.child.pid)
    const missingHelperGuard = await readEvidence(missingHelper.guardEvidence)
    assert.equal(missingHelperGuard?.processId, missingHelper.child.pid)
    assert.equal(await readEvidence(missingHelper.transportEvidence), undefined, 'no transport evidence may exist when the helper is not preloaded')
    checks.push('missing transport helper aborted at the preflight marker check before main entry or any egress')

    // Child D — fail-closed normalized/conflicting connect shapes and the targeted loopback control.
    const shapes = await runGuardedChild({
      label: 'shapes',
      imports: guardChainImports(),
      script: `
        import net from 'node:net'
        import tls from 'node:tls'
        import https from 'node:https'
        const attempt = fn => { try { fn(); return { threw: false } } catch (error) { return { threw: true, message: error?.message ?? String(error) } } }
        const shapes = [
          attempt(() => net.connect([443, 'egress-cover.test'])),
          attempt(() => tls.connect({ 0: 443, 1: 'egress-cover.test', rejectUnauthorized: true })),
          attempt(() => net.connect({ hostname: 'localhost', host: 'egress-cover.test', port: 443 })),
          attempt(() => https.request({ hostname: 'localhost', host: 'egress-cover.test', port: 443, path: '/x' })),
        ]
        const loopback = await new Promise(resolve => {
          const socket = net.connect({ host: '127.0.0.1', port: ${address.port} }, () => { socket.destroy(); resolve('connected') })
          socket.once('error', () => resolve('error'))
        })
        process.stdout.write('shape-child-ok:' + JSON.stringify({ shapes, loopback }))
      `,
    })
    assert.equal(shapes.child.code, 0)
    const shapeMarker = 'shape-child-ok:'
    assert(shapes.child.stdout.includes(shapeMarker), 'shape-covering child did not report its results')
    const shapeResults = JSON.parse(shapes.child.stdout.slice(shapes.child.stdout.indexOf(shapeMarker) + shapeMarker.length))
    assert.deepEqual(shapeResults.shapes.map(item => item.threw), [true, true, true, true],
      'a non-loopback or conflicting connect shape reached a real socket function')
    assert.deepEqual(shapeResults.shapes.map(item => item.message), ['guard_tripwire_blocked_net_connect', 'guard_tripwire_blocked_tls_connect',
      'guard_tripwire_blocked_net_connect', 'guard_tripwire_blocked_https_request'])
    assert.equal(shapeResults.loopback, 'connected', 'the loopback positive control must still delegate')
    const shapesGuard = await readEvidence(shapes.guardEvidence)
    const shapesPreflight = await readEvidence(shapes.preflightEvidence)
    const shapesTransport = await readEvidence(shapes.transportEvidence)
    assert.equal(shapesGuard?.processId, shapes.child.pid)
    assert.equal(shapesGuard?.connectBlocked, 3)
    assert.equal(shapesGuard?.httpBlocked, 1)
    assert.equal(shapesGuard?.delegatedOriginals?.netConnect, 1, 'only the loopback control may delegate to the real net.connect')
    assert.equal(shapesGuard?.delegatedOriginals?.tlsConnect, 0)
    assert.equal(shapesGuard?.delegatedOriginals?.httpsRequest, 0)
    assert.equal(shapesPreflight?.attested, true)
    assert.equal(shapesPreflight?.processId, shapes.child.pid)
    assert.equal(shapesTransport?.dnsOwned, 1, 'shape probes must add no owned DNS beyond the preflight baseline')
    assert.equal(shapesTransport?.requestsAccepted, 0)
    assert.equal(shapesTransport?.appleRequestsBlocked, 2)
    assert.equal(localHits, 1, 'a raw loopback TCP control connection must not fabricate an HTTP request')
    checks.push('normalized array/numeric-keyed and conflicting-host-field targets denied without delegation; loopback still delegated')
    // Covering controls for the fix-round-1 amended logic (no DSH, no network): honest settlement
    // labels, history-return label derivation from observed identity, strict final-guard gate
    // failure branches, and the narrow release-check route matcher with pass-through.
    const settlementControls = await Promise.all([
      settleBefore(Promise.resolve('ok'), 250),
      settleBefore(Promise.reject(new Error('boom')), 250),
      settleBefore(Promise.reject(undefined), 250),
      settleBefore(new Promise(() => {}), 250),
    ])
    assert.deepEqual(settlementControls.map(entry => entry.status), ['fulfilled', 'rejected', 'rejected', 'timeout'],
      'settleBefore must distinguish fulfilled/rejected (incl. undefined rejection)/timeout')
    assert.equal(settlementControls[1].error?.message, 'boom')
    assert.equal(settlementControls[2].error, undefined, 'rejection with an undefined reason must stay labelled rejected')
    checks.push('settleBefore honest outcome labels (fulfilled/rejected-with-undefined/timeout)')

    const labelsA = historyReturnLabels({ waitStatus: 'fulfilled', observedSessionId: 'B', draftSessionId: 'B',
      observedDraft: 'draft', unsentDraft: 'draft' })
    const labelsB = historyReturnLabels({ waitStatus: 'fulfilled', observedSessionId: 'A', draftSessionId: 'B',
      observedDraft: '', unsentDraft: 'draft' })
    const labelsC = historyReturnLabels({ waitStatus: 'timeout', observedSessionId: 'A', draftSessionId: 'B',
      observedDraft: '', unsentDraft: 'draft' })
    const labelsD = historyReturnLabels({ waitStatus: 'rejected', observedSessionId: null, draftSessionId: 'B',
      observedDraft: null, unsentDraft: 'draft' })
    assert.equal(labelsA.draftSessionPersistence, 'retained')
    assert.deepEqual(labelsB.historyReturn, { waitStatus: 'fulfilled', restoredToDraftSession: false, landedOnSession: 'A' })
    assert.equal(labelsB.draftSessionPersistence, 'cannot-verify')
    assert.equal(labelsC.draftSessionPersistence, 'cannot-verify')
    assert.equal(labelsD.draftSessionPersistence, 'cannot-verify')
    checks.push('history-return labels derive from observed identity; cannot-verify preserved on mismatch/transient/timeout')

    const goodGuard = { processId: 4242, blocked: [], dnsBlocked: 0, resolveBlocked: 0, connectBlocked: 0,
      httpBlocked: 0, fetchBlocked: 0, udpDnsBlocked: 0, facadeSyncEffective: true, cjsPatchVisible: true }
    assert.equal(checkFinalGuardEvidence(goodGuard, 4242).ok, true)
    assert.equal(checkFinalGuardEvidence(undefined, 4242).reason, 'missing-final-guard-evidence')
    assert.equal(checkFinalGuardEvidence({ ...goodGuard, processId: 1 }, 4242).reason.startsWith('final-guard-pid-mismatch'), true)
    assert.equal(checkFinalGuardEvidence({ ...goodGuard, fetchBlocked: 2 }, 4242).reason, 'final-guard-block-present:fetchBlocked=2')
    assert.equal(checkFinalGuardEvidence({ ...goodGuard, blocked: [{ api: 'fetch', host: 'x' }] }, 4242).reason,
      'final-guard-blocked-entries:1')
    assert.equal(checkFinalGuardEvidence({ ...goodGuard, cjsPatchVisible: false }, 4242).reason,
      'final-guard-attestation-not-visible')
    assert.equal(checkFinalGuardEvidence({ ...goodGuard, connectBlocked: undefined }, 4242).reason,
      'final-guard-counter-invalid:connectBlocked=undefined')
    checks.push('strict final-guard gate fails on late block / wrong PID / missing / invalid counter / lost attestation')

    const ownedOrigins = new Set(['https://owned.test'])
    assert.equal(isReleaseCheckRequest('https://owned.test/api/mobile-access/release', 'GET', ownedOrigins), true)
    assert.equal(isReleaseCheckRequest('https://owned.test/api/mobile-access/release?x=1', 'GET', ownedOrigins), true, 'exact path with query still matches by pathname')
    assert.equal(isReleaseCheckRequest('https://foreign.test/api/mobile-access/release', 'GET', ownedOrigins), false, 'same-path foreign origin must pass through')
    assert.equal(isReleaseCheckRequest('https://owned.test/api/mobile-access/release/extra', 'GET', ownedOrigins), false)
    assert.equal(isReleaseCheckRequest('https://owned.test/api/mobile-access/release', 'POST', ownedOrigins), false)
    assert.equal(isReleaseCheckRequest('https://owned.test/mobile-access/release', 'GET', ownedOrigins), false)
    assert.equal(isReleaseCheckRequest('not a url', 'GET', ownedOrigins), false)
    checks.push('release-check pure matcher: exact GET on an owned origin only; foreign origin, sub-path, non-GET, malformed pass through')

    // REAL route-predicate control (owned headless Chromium + loopback origins only, no DSH): the
    // armed route glob plus matcher must abort an owned-origin GET including the query-suffixed
    // spelling, while a same-path foreign-origin GET and an owned-origin POST pass through.
    {
      const ownedServer = createServer((_request, response) => { response.writeHead(200).end('ok') })
      const foreignServer = createServer((_request, response) => { response.writeHead(200).end('foreign') })
      await new Promise((resolveListen, reject) => { ownedServer.once('error', reject); ownedServer.listen(0, '127.0.0.1', resolveListen) })
      await new Promise((resolveListen, reject) => { foreignServer.once('error', reject); foreignServer.listen(0, '127.0.0.1', resolveListen) })
      const ownedOrigin = `http://127.0.0.1:${ownedServer.address().port}`
      const foreignOrigin = `http://127.0.0.1:${foreignServer.address().port}`
      const routeOrigins = new Set([ownedOrigin])
      const routeCounter = { aborted: 0, passed: 0 }
      let routeBrowser
      try {
        routeBrowser = await chromium.launch({ headless: true })
        const routeContext = await routeBrowser.newContext()
        await routeContext.route('**/api/mobile-access/release*', async route => {
          const request = route.request()
          let url
          try { url = new URL(request.url()) } catch { routeCounter.passed += 1; await route.continue(); return }
          if (String(request.method()).toUpperCase() !== 'GET' || url.pathname !== '/api/mobile-access/release'
            || !routeOrigins.has(url.origin)) { routeCounter.passed += 1; await route.continue(); return }
          routeCounter.aborted += 1
          await route.abort('blockedbyclient')
        })
        const routePage = await routeContext.newPage()
        await routePage.goto(`${ownedOrigin}/`, { waitUntil: 'domcontentloaded' })
        await routePage.evaluate(async ({ ownedOrigin, foreignOrigin }) => {
          window.__results = {}
          const attempt = async (label, url, method) => {
            try {
              const response = await fetch(url, { method })
              window.__results[label] = `ok:${response.status}`
            } catch (error) { window.__results[label] = `aborted:${String(error).slice(0, 40)}` }
          }
          await attempt('GET /api/mobile-access/release', `${ownedOrigin}/api/mobile-access/release`, 'GET')
          await attempt('GET /api/mobile-access/release?probe=1', `${ownedOrigin}/api/mobile-access/release?probe=1`, 'GET')
          await attempt('POST /api/mobile-access/release', `${ownedOrigin}/api/mobile-access/release`, 'POST')
          await attempt('GET /api/mobile-access/release/extra', `${ownedOrigin}/api/mobile-access/release/extra`, 'GET')
        }, { ownedOrigin, foreignOrigin })
        // Same-path foreign-origin GET is issued through the context's API request (a page-side
        // cross-origin fetch would fail on CORS, which is not the boundary under test).
        const foreignResponse = await routeContext.request.get(`${foreignOrigin}/api/mobile-access/release`, { timeout: 5_000 }).catch(error => ({ error }))
        routePage.__foreignResult = foreignResponse.status !== undefined ? `ok:${foreignResponse.status()}` : `error:${String(foreignResponse.error).slice(0, 40)}`
        const routeResults = await routePage.evaluate(() => window.__results)
        assert.equal(routeCounter.aborted, 2, 'owned-origin exact-path GETs (plain + query) must be aborted by the actual route')
        assert.equal(String(routeResults['GET /api/mobile-access/release']).startsWith('aborted:'), true)
        assert.equal(String(routeResults['GET /api/mobile-access/release?probe=1']).startsWith('aborted:'), true, 'query-suffixed owned GET must be caught by the route glob and aborted')
        assert.equal(String(routeResults['POST /api/mobile-access/release']).startsWith('ok:'), true, 'owned-origin POST must pass through')
        assert.equal(String(routeResults['GET /api/mobile-access/release/extra']).startsWith('ok:'), true, 'sub-path GET must pass through')
        assert.equal(routePage.__foreignResult.startsWith('ok:'), true, 'same-path foreign-origin GET must pass through')
        checks.push('actual route predicate: owned-origin GET aborted incl query spelling; foreign-origin/sub-path/POST pass through')
      } finally {
        await routeBrowser?.close().catch(() => {})
        for (const server of [ownedServer, foreignServer]) {
          server.closeAllConnections?.()
          if (server.listening) await new Promise(resolveClose => server.close(resolveClose))
        }
      }
    }

  } finally {
    if (server?.listening) await new Promise(resolveClose => server.close(resolveClose))
    await removeTemporaryRoot(root, prefix + 'guard-')
  }
  return {
    status: 'PASS', syntheticOnly: true, checks,
    guardChain: {
      imports: 'network-guard -> transport helper -> hard preflight',
      networkGuardSha256: await fileSha256(networkGuardPath),
      transportSha256: await fileSha256(transportPath),
      preflightSha256: await fileSha256(preflightPath),
    },
    cleanup: 'owned children awaited with exit codes; loopback server closed; temp root removed',
  }
}

function launchDsh(root, home, binary, { nonce, transportEvidence, guardEvidence, preflightEvidence, fixtureNonce, fixtureControl }) {
  const environment = limitedEnvironment({
    HOME: home,
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(root, '.agents'),
    DSH_PUSH_TRANSPORT_NONCE: nonce,
    DSH_PUSH_TRANSPORT_EVIDENCE: transportEvidence,
    DSH_GUARD_TRIPWIRE_EVIDENCE: guardEvidence,
    DSH_GUARD_BOOTSTRAP_EVIDENCE: preflightEvidence,
    DSH_PUSH_FIXTURE_NONCE: fixtureNonce,
    DSH_PUSH_FIXTURE_CONTROL: fixtureControl,
    NODE_OPTIONS: guardChainImports(),
  })
  const child = spawn(process.execPath, [binary, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stdout = '', stderr = '', exited = false, resolveExit
  const exit = new Promise(resolve => { resolveExit = resolve })
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout = tail(stdout + chunk, 24_000) })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = tail(stderr + chunk, 24_000) })
  child.once('error', error => { stderr = tail(stderr + String(error), 24_000) })
  child.once('close', (code, signal) => { exited = true; resolveExit({ code, signal }) })
  return {
    ready: async () => {
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        const url = /dsh web: (http:\/\/[^\s]+)/u.exec(stdout)?.[1]
        if (url !== undefined) return url
        if (exited) throw new Error(`owned DSH exited before ready (${JSON.stringify(await exit)})\n${safeText(stdout)}\n${safeText(stderr)}`)
        await new Promise(resolvePoll => setTimeout(resolvePoll, 75))
      }
      throw new Error(`owned DSH did not reach readiness\n${safeText(stdout)}\n${safeText(stderr)}`)
    },
    close: async () => {
      if (exited) return { ...(await exit), forced: false }
      child.kill('SIGTERM')
      let forced = false
      const timer = setTimeout(() => { if (!exited) { forced = true; child.kill('SIGKILL') } }, 12_000)
      try { return { ...(await exit), forced } } finally { clearTimeout(timer) }
    },
    logs: () => safeText(`${stdout}\n${stderr}`),
    pid: child.pid,
  }
}

async function waitForJson(path, predicate, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let last
  let lastPartial
  while (Date.now() < deadline) {
    // A live writer may be mid-write: treat an unparsable file as not-ready (like ENOENT) while polling.
    try { last = await readTransportEvidence(path) }
    catch (error) {
      if (error instanceof SyntaxError) lastPartial = error
      else throw error
    }
    if (last !== undefined && predicate(last)) return last
    await new Promise(resolvePoll => setTimeout(resolvePoll, 40))
  }
  const observed = last === undefined ? 'none' : JSON.stringify({
    fixture: { phase: typeof last.phase === 'string' ? last.phase : null,
      ok: typeof last.ok === 'boolean' ? last.ok : null,
      probeOutcome: typeof last.publicSessionObservation?.outcome === 'string' ? last.publicSessionObservation.outcome : null,
      probeErrorName: typeof last.publicSessionObservation?.errorName === 'string' ? last.publicSessionObservation.errorName : null,
      probeErrorCode: typeof last.publicSessionObservation?.errorCode === 'string' ? last.publicSessionObservation.errorCode : null },
    transport: projectTransportEvidence(last),
  })
  throw new Error(`Timed out waiting for ${label}; observed=${observed}`)
}

async function loseShortSessionCookie(context, origin, expectedDeviceId) {
  // The durable renewal credential is deliberately path-scoped to /mobile-access/auth/renew
  // (gateway.ts handlePair), so a root-URL cookie query cannot see it; query both paths.
  const cookieUrls = [origin, `${origin}/mobile-access/auth/renew`]
  const before = await context.cookies(cookieUrls)
  const deviceToken = before.filter(cookie => cookie.httpOnly && cookie.path === '/mobile-access/auth/renew')
  const deviceBinding = before.filter(cookie => cookie.httpOnly && cookie.path === '/' && cookie.value === expectedDeviceId)
  const shortSession = before.filter(cookie => cookie.httpOnly && cookie.path === '/' && cookie.value !== expectedDeviceId)
  assert.equal(deviceToken.length, 1, 'Expected exactly one persistent renewal credential')
  assert.equal(deviceBinding.length, 1, 'Expected exactly one persistent browser device binding')
  assert(shortSession.length >= 1, 'No short-session browser cookie was issued')
  for (const cookie of shortSession) await context.clearCookies({ name: cookie.name, domain: cookie.domain, path: cookie.path })
  const after = await context.cookies(cookieUrls)
  assert(after.some(cookie => cookie.name === deviceToken[0].name && cookie.path === deviceToken[0].path
    && cookie.value === deviceToken[0].value), 'Expired-session simulation removed the persistent pairing credential')
  assert(after.some(cookie => cookie.name === deviceBinding[0].name && cookie.path === deviceBinding[0].path
    && cookie.value === expectedDeviceId), 'Expired-session simulation removed the persistent pairing binding')
  assert.equal(after.some(cookie => shortSession.some(expired => expired.name === cookie.name && expired.path === cookie.path)), false,
    'Expired-session simulation retained a short-session credential')
  return { removedSessionCookies: shortSession.length, retainedPairing: true }
}


async function createOwnedWorkspace(desktop, workspacePath, runId) {
  const created = await desktop.evaluate(async ({ path, runId }) => {
    const response = await fetch('/api/workspace/create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: runId, method: 'workspace/create', payload: { args: { request: { path } } } }),
      signal: AbortSignal.timeout(60_000),
    })
    const body = await response.json()
    return { status: response.status, ok: body.result?.ok === true, workspaceId: body.result?.value?.workspace?.workspaceId }
  }, { path: workspacePath, runId })
  assert.equal(created.status, 200, 'Owned DSH Workspace create did not return HTTP 200')
  assert.equal(created.ok, true, 'Owned DSH Workspace create was rejected')
  assert.equal(typeof created.workspaceId, 'string')
  return created.workspaceId
}

function installSyntheticPushManager(page, { endpoint, p256dh, auth }) {
  return page.addInitScript(({ endpoint, p256dh, auth }) => {
    const storeKey = '__dsh_mobile_push_smoke_subscription'
    const countsKey = '__dsh_mobile_push_smoke_counts'
    const counts = () => {
      try { return JSON.parse(localStorage.getItem(countsKey) ?? '{}') }
      catch { return {} }
    }
    const increment = name => { const next = counts(); next[name] = (next[name] ?? 0) + 1; localStorage.setItem(countsKey, JSON.stringify(next)) }
    const originalMatchMedia = window.matchMedia.bind(window)
    window.matchMedia = query => query.includes('display-mode') ? { matches: true, media: query, onchange: null,
      addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } }
      : originalMatchMedia(query)
    try { Object.defineProperty(navigator, 'standalone', { configurable: true, value: true }) } catch {}
    class SyntheticNotification {
      static permission = 'granted'
      static async requestPermission() { increment('permissionRequests'); return 'granted' }
    }
    try { Object.defineProperty(window, 'Notification', { configurable: true, value: SyntheticNotification }) } catch {}
    const stored = () => { try { return JSON.parse(localStorage.getItem(storeKey) ?? 'null') } catch { return null } }
    const browserSubscription = applicationServerKey => {
      const value = stored()
      if (!value) return null
      const raw = Uint8Array.from(atob(value.applicationServerKey), ch => ch.charCodeAt(0))
      const buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
      return { endpoint: value.endpoint, options: { applicationServerKey: applicationServerKey ?? buffer },
        toJSON: () => ({ endpoint: value.endpoint, expirationTime: null, keys: { p256dh: value.p256dh, auth: value.auth } }),
        async unsubscribe() { increment('unsubscribeCalls'); localStorage.removeItem(storeKey); return true } }
    }
    const manager = {
      async getSubscription() { return browserSubscription() },
      async subscribe(options) {
        increment('subscribeCalls')
        const userGesture = navigator.userActivation?.isActive === true
        const record = { endpoint, p256dh, auth, applicationServerKey: btoa(String.fromCharCode(...new Uint8Array(options.applicationServerKey))) }
        localStorage.setItem(storeKey, JSON.stringify(record))
        const subscription = browserSubscription(options.applicationServerKey)
        window.__dshPushSmokeSubscribe = { userGesture, userVisibleOnly: options.userVisibleOnly,
          applicationServerKeyBytes: new Uint8Array(options.applicationServerKey).length }
        return subscription
      },
    }
    try { Object.defineProperty(window, 'pushManager', { configurable: true, value: manager }) } catch { window.pushManager = manager }
    window.__dshPushSmokeDocumentId = crypto.randomUUID()
    window.__dshPushSmokeCounts = counts
    // Observe any worker lifecycle change without replacing the actual DSH APIs.
    try {
      const containerPrototype = Object.getPrototypeOf(navigator.serviceWorker)
      const originalRegister = containerPrototype.register
      if (typeof originalRegister === 'function') containerPrototype.register = function (...args) { increment('serviceWorkerRegisterCalls'); return originalRegister.apply(this, args) }
      const registrationPrototype = window.ServiceWorkerRegistration?.prototype
      const originalUnregister = registrationPrototype?.unregister
      if (typeof originalUnregister === 'function') registrationPrototype.unregister = function (...args) { increment('serviceWorkerUnregisterCalls'); return originalUnregister.apply(this, args) }
    } catch {}
  }, { endpoint, p256dh, auth })
}

async function workerAndCacheSnapshot(page) {
  return page.evaluate(async () => ({
    workers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).map(registration => registration.scope).sort() : [],
    cacheKeys: 'caches' in window ? (await caches.keys()).sort() : [],
    calls: window.__dshPushSmokeCounts?.() ?? {},
  }))
}

async function readPushConfig(page, installationId) {
  const result = await page.evaluate(async id => {
    const response = await fetch(`/mobile-access/push/config?installationId=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5_000) })
    return { status: response.status, body: await response.json() }
  }, installationId)
  assert.equal(result.status, 200, 'Paired device could not read its actual Gateway push config')
  assert.equal(result.body.installationId, installationId)
  return result.body
}

function projectPushConfig(config) {
  const prefs = config?.preferences
  const bool = value => typeof value === 'boolean' ? value : null
  return { available: bool(config?.available), status: ['disabled', 'enabled', 'suspended', 'repair-required', 'unsupported'].includes(config?.status) ? config.status : 'other',
    publicKeyPresent: typeof config?.publicKey === 'string' && config.publicKey.length > 0,
    preferences: { question: bool(prefs?.question), plan: bool(prefs?.plan), approval: bool(prefs?.approval),
      response: bool(prefs?.response), goal: bool(prefs?.goal), failure: bool(prefs?.failure) } }
}

async function observePublicPushConfig(page, installationId, expectedOrigin) {
  const observed = await page.evaluate(async ({ id, origin }) => {
    let body
    const response = await fetch(`/mobile-access/push/config?installationId=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(5_000) })
    try { body = await response.json() } catch { body = null }
    return { httpStatus: response.status, sameOrigin: location.origin === origin, installationIdMatches: body?.installationId === id, body }
  }, { id: installationId, origin: expectedOrigin })
  return { httpStatus: observed.httpStatus, sameOrigin: observed.sameOrigin, installationIdMatches: observed.installationIdMatches,
    ...projectPushConfig(observed.body) }
}

async function readOwnedNotificationSummary(root, home, { deviceId, installationId, origin }) {
  const file = join(home, 'mobile-access', 'mobile-push', 'push-state.json')
  let metadata
  try { metadata = await lstat(file) }
  catch (error) { return { filePresent: false, withinOwnedRoot: null, withinByteLimit: null,
    readErrorCode: error?.code === 'ENOENT' ? 'ENOENT' : 'READ_ERROR' } }
  if (!metadata.isFile() || metadata.isSymbolicLink()) return { filePresent: true, regularNonSymlink: false, withinOwnedRoot: false }
  const rootReal = await realpath(root)
  const fileReal = await realpath(file)
  const rel = relative(rootReal, fileReal)
  const withinOwnedRoot = rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
  if (!withinOwnedRoot) return { filePresent: true, regularNonSymlink: true, withinOwnedRoot: false, withinByteLimit: null }
  const limit = 4 * 1024 * 1024
  if (metadata.size > limit) return { filePresent: true, regularNonSymlink: true, withinOwnedRoot: true, withinByteLimit: false }
  const bytes = await readFile(file)
  if (bytes.byteLength > limit) return { filePresent: true, regularNonSymlink: true, withinOwnedRoot: true, withinByteLimit: false }
  let snapshot
  try { snapshot = JSON.parse(bytes.toString('utf8')) }
  catch (error) { return { filePresent: true, regularNonSymlink: true, withinOwnedRoot: true, withinByteLimit: true,
    parseOk: false, parseErrorName: error?.name ?? 'Error' } }
  const registrations = Array.isArray(snapshot.registrations) ? snapshot.registrations : []
  const pending = Array.isArray(snapshot.pending) ? snapshot.pending : []
  const receipts = Array.isArray(snapshot.receipts) ? snapshot.receipts : []
  const references = Array.isArray(snapshot.references) ? snapshot.references : []
  const expectedScope = join(home, 'mobile-access', 'devices.json')
  const sameKey = row => row?.scopeId === expectedScope && row?.deviceId === deviceId
    && row?.origin === origin && row?.installationId === installationId
  const matchingRegistrations = registrations.filter(sameKey)
  const matching = matchingRegistrations[0]
  const matchingPending = pending.filter(row => sameKey(row?.key))
  const matchingReceipts = receipts.filter(row => sameKey(row?.key))
  const matchingReferences = references.filter(row => sameKey(row?.key))
  const categories = ['question', 'plan', 'approval', 'response', 'goal', 'failure']
  const prefs = matching?.preferences
  return { filePresent: true, regularNonSymlink: true, withinOwnedRoot: true, withinByteLimit: true, parseOk: true,
    versionIsSupported: snapshot.version === 1, keyMaterialPresent: typeof snapshot.keys?.publicKey === 'string' && typeof snapshot.keys?.privateKey === 'string',
    registrationCount: registrations.length, enabledRegistrationCount: registrations.filter(row => row.enabled === true).length,
    readyRegistrationCount: registrations.filter(row => row.health === 'ready').length,
    matchingRegistrationCount: matchingRegistrations.length, registeredOriginMatchesCurrentOrigin: matchingRegistrations.some(row => row.origin === origin),
    matchingRegistrationEnabled: matching?.enabled === true,
    matchingRegistrationHealth: ['ready', 'suspended', 'repair-required'].includes(matching?.health) ? matching.health : 'unknown',
    matchingQuestionPreference: typeof prefs?.question === 'boolean' ? prefs.question : null,
    matchingPreferences: Object.fromEntries(categories.map(category => [category, typeof prefs?.[category] === 'boolean' ? prefs[category] : null])),
    matchingOwnerGenerationPresent: Array.isArray(snapshot.ownerGenerations)
      && snapshot.ownerGenerations.some(row => row.scopeId === expectedScope && row.deviceId === deviceId && row.origin === origin),
    pendingCount: pending.length, pendingQuestionCount: pending.filter(row => row.source?.category === 'question').length,
    matchingPendingCount: matchingPending.length, matchingQuestionPendingCount: matchingPending.filter(row => row.source?.category === 'question').length,
    receiptCount: receipts.length, matchingReceiptCount: matchingReceipts.length,
    referenceCount: references.length, matchingReferenceCount: matchingReferences.length,
    matchingQuestionReferenceCount: matchingReferences.filter(row => row.source?.category === 'question').length }
}

/** Poll the owned notification state until a predicate holds; readiness wait, never a fixed sleep. */
async function waitForOwnedRegistryState(root, home, key, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await readOwnedNotificationSummary(root, home, key)
    if (predicate(last)) return last
    await new Promise(resolvePoll => setTimeout(resolvePoll, 100))
  }
  throw new Error(`Timed out waiting for owned notification state; observed=${JSON.stringify({
    receiptCount: last?.receiptCount ?? null, matchingReceiptCount: last?.matchingReceiptCount ?? null,
    matchingPendingCount: last?.matchingPendingCount ?? null })}`)
}

async function readFixtureAskSettlement(home) {  let value
  try { value = JSON.parse(await readFile(join(home, 'push-integration-fixture-settlement.json'), 'utf8')) }
  catch (error) { return { present: false, readErrorCode: error?.code === 'ENOENT' ? 'ENOENT' : 'READ_ERROR' } }
  return { present: true, outcome: ['pending', 'resolved', 'rejected', 'threw'].includes(value?.outcome) ? value.outcome : 'other',
    resultPending: typeof value?.resultPending === 'boolean' ? value.resultPending : null,
    resultCallIdMatches: typeof value?.resultCallIdMatches === 'boolean' ? value.resultCallIdMatches : null,
    answersPresent: typeof value?.answersPresent === 'boolean' ? value.answersPresent : null,
    errorName: typeof value?.errorName === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value.errorName) ? value.errorName : null,
    errorCode: typeof value?.errorCode === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value.errorCode) ? value.errorCode : null }
}

async function readDesktopDevices(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/mobile-access/lan/devices', { signal: AbortSignal.timeout(5_000) })
    const body = await response.json().catch(() => ({}))
    return { status: response.status, devices: Array.isArray(body.devices) ? body.devices.map(device => ({
      id: typeof device.id === 'string' ? device.id : null, label: typeof device.label === 'string' ? device.label : null,
    })) : [] }
  })
}

function assertPublicObserveSessionNegative(value, stage) {
  if (value?.name !== 'public-observeSession-never-created-owned-fixture-id' || value?.projectionMode !== 'all'
    || value?.outcome !== 'threw' || value?.errorCode !== 'SESSION_QUERY_SESSION_NOT_FOUND'
    || value?.sessionStoreUnchanged !== true || value?.agentStoreUnchanged !== true
    || value?.noSessionOrAgentCreationOrWake !== true || value?.sessionPresentBefore !== false
    || value?.sessionPresentAfter !== false || value?.agentPresentBefore !== false || value?.agentPresentAfter !== false) {
    throw new Error(`Public observeSession missing-id probe failed at ${stage}: ${JSON.stringify(value ?? null)}`)
  }
  return value
}

async function openTargetFromPush(page, origin, reference, expectedSessionId) {
  const responsePromise = page.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/push/resolve'
    && response.request().method() === 'POST', { timeout: CLIENT_TIMEOUT_MS })
  await page.goto(`${origin}/?mobile-push=${encodeURIComponent(reference)}`, { waitUntil: 'domcontentloaded', timeout: CLIENT_TIMEOUT_MS })
  const response = await responsePromise
  assert.equal(response.status(), 200, 'Authenticated PushTarget resolver was not accepted')
  const target = await response.json()
  assert.equal(target.sessionId, expectedSessionId, 'Public resolver returned a different Session target')
  assert(['current', 'resolved'].includes(target.interaction), 'Public resolver returned an unknown interaction state')
  await page.waitForFunction(id => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === id,
    expectedSessionId, { timeout: CLIENT_TIMEOUT_MS })
  await page.waitForFunction(() => location.pathname === '/' && location.search === '', undefined, { timeout: CLIENT_TIMEOUT_MS })
  return { status: response.status(), sessionIdMatched: target.sessionId === expectedSessionId, interaction: target.interaction }
}

async function runFullSmoke({ negativeControl = false, pairDiagnostic = false } = {}) {
  const dshBinValue = process.env.DSH_BOOT_SMOKE_BIN
  const tarballValue = process.env.DSH_BOOT_SMOKE_MOBILE_TARBALL
  if (typeof dshBinValue !== 'string' || dshBinValue.trim() === '') throw new Error('Set DSH_BOOT_SMOKE_BIN to the explicit read-only DSH CLI path')
  if (typeof tarballValue !== 'string' || tarballValue.trim() === '') throw new Error('Set DSH_BOOT_SMOKE_MOBILE_TARBALL to the coherent built plugin tarball')
  const binary = resolve(dshBinValue), tarball = resolve(tarballValue)
  for (const path of [binary, tarball]) {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Runtime and tarball inputs must be explicit regular files')
  }
  const dshVersion = createRequire(binary)('@deepseek-ai/dsh/package.json').version
  assert(RUNTIME_VERSIONS.includes(dshVersion), `Push public-contract fixture requires an allowed DSH contract runtime (got ${dshVersion}, allowed ${RUNTIME_VERSIONS.join('/')})`)
  const tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  const pairDiagnosticRunId = randomUUID()
  // All diagnostics live inside the OWNED per-run temporary root (unique run identity; no committed
  // plan-path dependency, no fixed filenames, no clean-checkout ENOENT / repeat-run EEXIST). The
  // optional pair-diagnostic log requires an explicit absolute output path from the caller.
  const root = await mkdtemp(join(tmpdir(), prefix))
  // Optional explicit seam for behavioral coverage of the runtime-diagnostic setup-failure path:
  // an absolute directory for the runtime diagnostic; defaults to the owned root. Pointing it at an
  // existing FILE (or an unwritable location) deterministically exercises the fail-closed setup path.
  const explicitDiagnosticsDir = process.env.DSH_PUSH_DIAGNOSTICS_DIR
  const diagnosticsDir = typeof explicitDiagnosticsDir === 'string' && explicitDiagnosticsDir !== '' && isAbsolute(explicitDiagnosticsDir)
    ? explicitDiagnosticsDir : join(root, 'diagnostics')
  const runtimeDiagnosticPath = join(diagnosticsDir, `task8-push-runtime-${pairDiagnosticRunId}.jsonl`)
  const pairDiagnosticTarget = process.env[PAIR_DIAGNOSTIC_LOG_ENV]
  let pairDiagnosticFd
  let runtimeDiagnosticFd
  let identity
  const loggingSetupFailures = []
  // Owned fail-closed diagnostic setup (fix-round-2 N1): any failure here is reported by its named
  // condition, closes acquired descriptors (caller-owned partial files are kept, never overwritten
  // or deleted), removes ONLY this owned root, and exits before any package/profile/DSH/browser work.
  const failClosedSetup = async named => {
    const closed = []
    for (const [label, fd] of [['runtime-diagnostic', runtimeDiagnosticFd], ['pair-diagnostic', pairDiagnosticFd]]) {
      if (fd !== undefined) { try { closeSync(fd); closed.push(label) } catch { closed.push(`${label}:close-failed`) } }
    }
    // The owned mkdtemp root is always ours to remove on setup failure; caller-owned explicit
    // outputs (pair log / seam diagnostics dir) are never inside it and are never touched.
    let rootRemoved = false
    try { await rm(root, { recursive: true, force: true }); rootRemoved = true } catch { rootRemoved = false }
    console.log(JSON.stringify({ status: 'DIAGNOSTIC_SETUP_FAILED', failure: named,
      ownedRoot: root, rootRemoved, descriptorsClosed: closed,
      callerTargetTouched: false, mode: pairDiagnostic ? 'pair-diagnostic' : negativeControl ? 'negative-control-owner' : 'positive' }))
    process.exit(1)
  }
  try { await mkdir(diagnosticsDir, { recursive: true }) }
  catch (error) { await failClosedSetup(`diagnostics-dir-create:${error?.code ?? error?.name ?? 'Error'}`) }
  try {
    identity = { runId: pairDiagnosticRunId, at: new Date().toISOString(), mode: pairDiagnostic ? 'pair-diagnostic' : negativeControl ? 'negative-control-owner' : 'positive',
      smokeSha256: await fileSha256(fileURLToPath(import.meta.url)), tarballSha256,
      dshVersion, runtimeCli: binary, transportHelperSha256: await fileSha256(transportPath),
      networkGuardSha256: await fileSha256(networkGuardPath), preflightSha256: await fileSha256(preflightPath) }
  } catch (error) { await failClosedSetup(`run-identity:${error?.code ?? error?.name ?? 'Error'}`) }
  try {
    runtimeDiagnosticFd = openSync(runtimeDiagnosticPath, 'wx', 0o600)
  } catch (error) { await failClosedSetup(`runtime-diagnostic-open:${error?.code ?? error?.name ?? 'Error'}`) }
  if (pairDiagnostic) {
    if (typeof pairDiagnosticTarget !== 'string' || !isAbsolute(pairDiagnosticTarget)) {
      await failClosedSetup('pair-diagnostic-target-missing')
    }
    try { pairDiagnosticFd = openSync(pairDiagnosticTarget, 'wx', 0o600) }
    catch (error) { await failClosedSetup(`pair-diagnostic-open:${error?.code ?? error?.name ?? 'Error'}`) }
  }
  pairDiagnosticEntry(pairDiagnosticFd, pairDiagnosticRunId, 'identity', 'run-identity', identity)
  pairDiagnosticEntry(runtimeDiagnosticFd, pairDiagnosticRunId, 'identity', 'run-identity', identity)
  pairDiagnosticEntry(pairDiagnosticFd, pairDiagnosticRunId, 'complete', 'owned-temp-root')
  let gatewayPort
  const home = join(root, 'home')
  const evidenceFile = join(home, 'push-transport-evidence.json')
  const guardEvidenceFile = join(home, 'push-network-guard-evidence.json')
  const preflightEvidenceFile = join(home, 'push-preflight-evidence.json')
  const evidenceFileRestart = join(home, 'push-transport-evidence-restart.json')
  const guardEvidenceFileRestart = join(home, 'push-network-guard-evidence-restart.json')
  const preflightEvidenceFileRestart = join(home, 'push-preflight-evidence-restart.json')
  const fixtureControl = join(home, 'push-integration-control.json')
  const transportNonce = randomBytes(24).toString('hex')
  const fixtureNonce = randomBytes(24).toString('hex')
  // Private-diagnostics hook only: when set to an absolute directory, raw per-child guard/helper/
  // preflight evidence is copied there BEFORE the owned temporary root is removed. CI never sets it.
  const persistRawGuardEvidence = async () => {
    const target = process.env.DSH_PUSH_EVIDENCE_DIR
    if (typeof target !== 'string' || target === '' || !isAbsolute(target)) return null
    await mkdir(target, { recursive: true })
    const copies = []
    for (const [label, path] of [['initial-transport', evidenceFile], ['initial-guard', guardEvidenceFile],
      ['initial-preflight', preflightEvidenceFile], ['restart-transport', evidenceFileRestart],
      ['restart-guard', guardEvidenceFileRestart], ['restart-preflight', preflightEvidenceFileRestart],
      ['runtime-diagnostic', runtimeDiagnosticPath]]) {
      try { await copyFile(path, join(target, `task8-${pairDiagnosticRunId}-${label}.json`)); copies.push(label) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    return { directory: target, copied: copies }
  }
  const keyMaterial = testKeys()
  const endpoint = `https://n-${transportNonce}.push.apple.com/${transportNonce}`
  const cases = [], cleanupFailures = []
  let dsh, browser, browserProxy, failed, stage = 'profile', processExited = false, promptAttempts = 0
  let initialChildPid, restartedChildPid, evidenceRetentionDir = null
  const releaseCheckAllowedOrigins = new Set()
  let promptHoldReached, promptHoldRelease, promptHoldPromise, promptHoldHandlerDone
  let desktopContext, desktop, phoneContext, phone, deviceId, installationId, negativeObserved = false
  let expectedProviderCountAfterRevoke, summary, pairDiagnosticResult
  let pushRowCount, subscribeCallsBeforeEnable, subscribeCallsAfterEnable, successfulEnrollCount
  let publicSessionObservationInitial, publicSessionObservationRestarted
  const pairDiagnosticComplete = Symbol('pair-diagnostic-complete')
  const proxySockets = new Set()
  const guardChainReceipts = []
  const observations = { pushRequests: [], pushResponses: [], pageErrors: [], consoleCategories: [], consoleTexts: [], cspViolations: [],
    pushConfigBodyTasks: [], pushConfigBodies: [], resolvedTarget: undefined }
  let pushSettingsDiagnostic
  let diagnosticCancelled = false, deadlineTimer, pairStepCancelPromise, browserClosePromise, dshClosePromise, browserStopResult, dshStopResult
  const absoluteDeadline = Date.now() + 340_000
  const bodyDeadline = absoluteDeadline - 40_000
  const mark = (phase, name, fields = {}) => {
    pairDiagnosticEntry(pairDiagnosticFd, pairDiagnosticRunId, phase, name, fields)
    pairDiagnosticEntry(runtimeDiagnosticFd, pairDiagnosticRunId, phase, name, fields)
  }
  const checkpoint = name => {
    if (diagnosticCancelled || Date.now() >= bodyDeadline) throw new Error(`Task 8 smoke cancelled before ${name}`)
    mark('before', name)
  }
  const traced = async (name, action) => {
    checkpoint(name)
    try {
      const result = await action()
      mark('complete', name)
      return result
    } catch (error) {
      mark('error', name, { errorName: error?.name ?? 'Error' })
      throw error
    }
  }
  const closeOwnedBrowser = () => {
    if (browserClosePromise) return browserClosePromise
    browserClosePromise = closeBrowserBounded(browser).then(result => {
      browserStopResult = result
      mark('cleanup', 'browser', { closed: result.closed, forceKillSent: result.forceKillSent, processExitConfirmed: result.processExitConfirmed })
      return result
    })
    return browserClosePromise
  }
  const closeOwnedDsh = () => {
    if (dshClosePromise) return dshClosePromise
    const owned = dsh
    if (owned === undefined) return Promise.resolve({ closed: true, acquired: false, forced: false })
    mark('cleanup-before', 'dsh')
    dshClosePromise = owned.close().then(result => {
      mark('cleanup', 'dsh', { closed: true, forced: result?.forced === true, code: result?.code ?? null, signal: result?.signal ?? null })
      return { ...result, closed: true }
    })
    return dshClosePromise
  }
  const cancelOwnedRuntime = () => {
    if (diagnosticCancelled) return Promise.resolve()
    diagnosticCancelled = true
    mark('cancel', 'absolute-deadline')
    return Promise.allSettled([closeOwnedBrowser(), closeOwnedDsh()])
  }
  const remainingBodyMs = Math.max(1, bodyDeadline - Date.now())
  deadlineTimer = setTimeout(() => { void cancelOwnedRuntime() }, remainingBodyMs)
  deadlineTimer.unref()
  try {
    gatewayPort = await traced('reserve-loopback-gateway-port', () => reserveLoopbackPort())
    const mobileState = join(home, 'mobile-access')
    await traced('create-owned-mobile-state-directory', () => mkdir(mobileState, { recursive: true }))
    const fixture = await traced('create-public-host-fixture', () => createPushIntegrationFixture({ root }))
    const packedFixture = await traced('pack-public-host-fixture', () => packPushIntegrationFixture({ fixture, root, repository }))
    await traced('create-isolated-mobile-profile', () => createMobileProfile(root, { tarball, dshBin: binary, packageStoreDirectory: join(root, 'pnpm-store') }))
    const tlsEvidence = await traced('configure-owned-loopback-tls', () => configureOwnedHttps(root, home, gatewayPort))
    const profile = join(home, 'profiles', 'web')
    await traced('install-exact-mobile-tarball-and-host-fixture', () => installPackedBundle(packedFixture.tarball, profile, { dshBin: binary }))
    const packageManifest = JSON.parse(await traced('read-installed-profile-manifest', () => readFile(join(profile, 'package.json'), 'utf8')))
    assert(packageManifest.dsh.profile.bundles.includes(packedFixture.packageName), 'Actual DSH profile did not select the public Host fixture')
    assert(packageManifest.dependencies[packedFixture.packageName], 'Actual DSH profile did not install the Host fixture tarball')
    const installedMobile = join(profile, 'node_modules', 'dsh-mobile')
    const installedRequire = createRequire(join(installedMobile, 'package.json'))
    const installedMobileManifest = JSON.parse(await traced('read-packed-mobile-manifest', () => readFile(join(installedMobile, 'package.json'), 'utf8')))
    const installedHostEntry = await traced('resolve-packed-host-entry', () => realpath(join(installedMobile, installedMobileManifest.main)))
    const installedClientEntry = await traced('resolve-packed-client-entry', () => realpath(join(installedMobile, installedMobileManifest.exports['./client'].default)))
    const installedHostIdentity = await traced('read-packed-host-identity', () => installedPackageIdentity(installedHostEntry))
    const installedClientIdentity = await traced('read-packed-client-identity', () => installedPackageIdentity(installedClientEntry))
    assert.equal(installedHostIdentity.name, 'dsh-mobile')
    assert.equal(installedClientIdentity.name, 'dsh-mobile')
    assert.equal(installedHostIdentity.version, installedMobileManifest.version)
    assert.equal(installedClientIdentity.version, installedMobileManifest.version)
    const installedWebPushPath = installedRequire.resolve('web-push')
    const installedWebPushIdentity = await traced('resolve-packed-web-push-identity', () => installedPackageIdentity(installedWebPushPath))
    const installedZodIdentity = await traced('resolve-packed-zod-identity', () => installedPackageIdentity(installedRequire.resolve('zod')) )
    assert.equal(installedWebPushIdentity.version, '3.6.7')
    assert.equal(installedZodIdentity.version, '4.6.7')
    const installedEcePath = createRequire(installedWebPushPath).resolve('http_ece')
    const fixtureRequire = createRequire(join(profile, 'package.json'))
    const installedHostFixtureIdentity = await traced('resolve-public-host-fixture-identity', () => installedPackageIdentity(fixtureRequire.resolve(packedFixture.packageName)))
    const transportSeed = { ...keyMaterial }
    mark('before', 'launch-owned-dsh-process')
    dsh = launchDsh(root, home, binary, { nonce: transportNonce, transportEvidence: evidenceFile,
      guardEvidence: guardEvidenceFile, preflightEvidence: preflightEvidenceFile, fixtureNonce, fixtureControl })
    mark('complete', 'launch-owned-dsh-process', { pid: dsh.pid })
    initialChildPid = dsh.pid
    // The hard preflight's deliberate probes are the post-preload baseline (dnsOwned 1 / accepted 0 /
    // blocked 2). Every later counter assertion is a delta against these exact literals, never an
    // absolute feature count.
    const preloadBaseline = await traced('await-owned-guard-chain-startup', async () => {
      const transport = await waitForJson(evidenceFile, value => value.processId === dsh.pid
        && value.requestsAccepted === 0 && value.dnsOwned === 1 && value.appleRequestsBlocked === 2,
        'owned transport preflight baseline', 10_000)
      const guard = await waitForJson(guardEvidenceFile, value => value.processId === dsh.pid
        && Array.isArray(value.blocked) && value.blocked.length === 0
        && value.facadeSyncEffective === true && value.cjsPatchVisible === true,
        'owned network-guard startup evidence', 10_000)
      const preflight = await waitForJson(preflightEvidenceFile, value => value.processId === dsh.pid
        && value.attested === true && value.bindingIdentity?.namedBindingIsCjsProperty === true,
        'owned pre-main preflight attestation', 10_000)
      return { transport, guard, preflight }
    })
    assert.equal(preloadBaseline.transport.processId, dsh.pid, 'Transport evidence PID did not match the actual DSH child')
    assert.equal(preloadBaseline.guard.processId, dsh.pid, 'Network-guard evidence PID did not match the actual DSH child')
    assert.equal(preloadBaseline.preflight.processId, dsh.pid, 'Preflight evidence PID did not match the actual DSH child')
    guardChainReceipts.push({ child: 'initial', pid: dsh.pid, preflightAttested: true,
      guardBlockedCount: 0, guardBlockedSamplingPoint: 'startup-window',
      baseline: { dnsOwned: 1, requestsAccepted: 0, appleRequestsBlocked: 2 } })
    stage = 'browser'
    // Route ONLY the owned exact public authority through an owned loopback CONNECT tunnel; every
    // other CONNECT authority is destroyed, and desktop-style contexts keep direct loopback access
    // (probe-verified per-context proxy: page navigation and APIRequestContext both honor it).
    browserProxy = createServer()
    const gatewayAuthority = `${FIXTURE_AUTHORITY_HOST}:${gatewayPort}`
    browserProxy.on('connect', (request, client, head) => {
      if (request.url !== gatewayAuthority) { client.destroy(); return }
      const remote = connect(gatewayPort, '127.0.0.1')
      for (const socket of [client, remote]) {
        proxySockets.add(socket)
        socket.on('error', () => { client.destroy(); remote.destroy() })
        socket.once('close', () => { proxySockets.delete(socket); client.destroy(); remote.destroy() })
      }
      remote.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length > 0) remote.write(head)
        client.pipe(remote).pipe(client)
      })
    })
    await traced('listen-owned-exact-authority-proxy', () => new Promise((resolveListen, reject) => {
      browserProxy.once('error', reject)
      browserProxy.listen(0, '127.0.0.1', resolveListen)
    }))
    const ownedContextProxy = { server: `http://127.0.0.1:${browserProxy.address().port}` }
    browser = await traced('launch-owned-headless-chromium', () => chromium.launch({ headless: true }))
    desktopContext = await traced('create-owned-desktop-context', () => browser.newContext({ locale: 'en-US' }))
    await traced('arm-release-check-abort-desktop', () => armReleaseCheckAbort(desktopContext, 'desktop', releaseCheckAllowedOrigins))
    desktop = await traced('create-owned-desktop-page', () => desktopContext.newPage())
    const desktopUrl = await traced('await-owned-dsh-web-readiness', () => dsh.ready())
    const upstreamOrigin = new URL(desktopUrl).origin
    releaseCheckAllowedOrigins.add(upstreamOrigin)
    let initialFixtureReady
    try {
      initialFixtureReady = await traced('await-public-host-fixture-ready', () => waitForJson(join(home, 'push-integration-fixture-result.json'), value => value.phase === 'fixture-ready' && value.ok === true,
        'public Host fixture readiness', 15_000))
    } catch (error) {
      const fixtureState = await readTransportEvidence(join(home, 'push-integration-fixture-result.json')).catch(() => undefined)
      pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'error', 'public-fixture-readiness', {
        errorName: error?.name || 'Error', observedFixturePhase: typeof fixtureState?.phase === 'string' ? fixtureState.phase : 'none',
        probeOutcome: typeof fixtureState?.publicSessionObservation?.outcome === 'string' ? fixtureState.publicSessionObservation.outcome : null,
        probeErrorName: typeof fixtureState?.publicSessionObservation?.errorName === 'string' ? fixtureState.publicSessionObservation.errorName : null,
        probeErrorCode: typeof fixtureState?.publicSessionObservation?.errorCode === 'string' ? fixtureState.publicSessionObservation.errorCode : null,
        safeHostLogEvidence: safeHostLogEvidence(dsh.logs()),
      })
      throw error
    }
    publicSessionObservationInitial = assertPublicObserveSessionNegative(initialFixtureReady.publicSessionObservation, 'initial owned DSH fixture')
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'probe', 'public-observeSession-initial', publicSessionObservationInitial)
    cases.push('real public ctx.sessionQuery.observeSession(all) threw SESSION_QUERY_SESSION_NOT_FOUND for a never-created syntactically valid fixture ID without creating/waking Session or Agent')
    await traced('load-owned-desktop-page', () => desktop.goto(desktopUrl, { waitUntil: 'domcontentloaded' }))
    const upstreamMetadata = await traced('inspect-upstream-document-metadata', () => desktop.evaluate(() => ({
      gatewayMarker: document.querySelector('meta[name="dsh-mobile-gateway"]')?.content ?? null,
      manifestHref: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
    })))
    assert.notEqual(upstreamMetadata.manifestHref, '/mobile-access/push/manifest.webmanifest', 'Ordinary upstream index must retain its original manifest metadata')
    const workspacePath = join(root, 'owned-workspace')
    await traced('create-owned-workspace-directory', () => mkdir(workspacePath))
    const workspaceId = await traced('create-owned-dsh-workspace-through-public-api', () => createOwnedWorkspace(desktop, workspacePath, 'push-smoke-workspace'))
    const gatewayPairUrl = await traced('open-real-desktop-pairing-window', () => openPairing(desktop, undefined, dsh.logs))
    const gatewayOrigin = new URL(gatewayPairUrl).origin
    releaseCheckAllowedOrigins.add(gatewayOrigin)
    assert.equal(Number(new URL(gatewayPairUrl).port), gatewayPort, 'Owned HTTPS Gateway must use its allocated restart-stable port')
    assert.equal(new URL(gatewayPairUrl).hostname, FIXTURE_AUTHORITY_HOST,
      'Gateway public origin must derive from the configured publicAuthorities entry, not the loopback bind address')
    phoneContext = await traced('create-owned-mobile-context', () => browser.newContext({ viewport: { width: 390, height: 844 },
      isMobile: true, hasTouch: true, locale: 'en-US', ignoreHTTPSErrors: true, proxy: ownedContextProxy }))
    await traced('arm-release-check-abort-phone', () => armReleaseCheckAbort(phoneContext, 'phone', releaseCheckAllowedOrigins))
    const pairConsoleDiagnostics = [], pairPageErrors = []
    const attachPhoneObservers = async page => {
      await traced('install-synthetic-push-manager-init-script', () => installSyntheticPushManager(page,
        { endpoint, p256dh: keyMaterial.p256dh, auth: keyMaterial.authKey }))
      await traced('install-pre-document-csp-observer', () => page.addInitScript(expectedUpstreamOrigin => {
        const violations = []
        Object.defineProperty(window, '__dshPairDiagnosticInitialFragmentPresent', { configurable: false, value: location.hash.includes('token=') })
        Object.defineProperty(window, '__dshPairDiagnosticCsp', { configurable: false, value: violations })
        addEventListener('securitypolicyviolation', event => {
          let blockedBaseClass = 'none'
          if (event.blockedURI === 'inline') blockedBaseClass = 'inline'
          else if (event.blockedURI) {
            try {
              const blockedOrigin = new URL(event.blockedURI, location.href).origin
              blockedBaseClass = blockedOrigin === location.origin ? 'same-origin'
                : blockedOrigin === expectedUpstreamOrigin ? 'upstream' : 'other'
            } catch { blockedBaseClass = 'other' }
          }
          const evidence = { pathname: location.pathname, directive: event.effectiveDirective, blockedBaseClass }
          if (violations.length < 32) violations.push(evidence)
          console.debug(`DSH_PUSH_CSP_DIAGNOSTIC:${JSON.stringify(evidence)}`)
        })
      }, upstreamOrigin))
      page.on('console', message => {
        const text = message.text()
        const cspPrefix = 'DSH_PUSH_CSP_DIAGNOSTIC:'
        if (text.startsWith(cspPrefix)) {
          try { if (observations.cspViolations.length < 32) observations.cspViolations.push(JSON.parse(text.slice(cspPrefix.length))) } catch {}
          return
        }
        if (!['error', 'warning'].includes(message.type())) return
        const category = /content security policy/i.test(text) ? 'csp'
          : /script|javascript|pair/i.test(text) ? 'script-or-pair' : 'other'
        if (observations.consoleCategories.length < 32) observations.consoleCategories.push({ type: message.type(), category })
        if (category !== 'csp' && observations.consoleTexts.length < 8) observations.consoleTexts.push(safeText(text).slice(0, 160))
        if (pairDiagnostic && pairConsoleDiagnostics.length < 16) pairConsoleDiagnostics.push({ type: message.type(), category })
      })
      page.on('pageerror', error => {
        if (observations.pageErrors.length < 32) observations.pageErrors.push(error.name || 'Error')
        if (pairDiagnostic && pairPageErrors.length < 16) pairPageErrors.push(error.name || 'Error')
      })
      page.on('request', request => {
        const requestUrl = new URL(request.url())
        const path = requestUrl.pathname
        if (path === '/mobile-access/push/config') installationId = requestUrl.searchParams.get('installationId') ?? installationId
        if (path.startsWith('/mobile-access/push/')) observations.pushRequests.push({ method: request.method(), path })
        if (path === '/api/session/prompt') promptAttempts++
      })
      page.on('response', response => {
        const path = new URL(response.url()).pathname
        if (!path.startsWith('/mobile-access/push/')) return
        const status = response.status()
        observations.pushResponses.push({ method: response.request().method(), path, status })
        if (path === '/mobile-access/push/config' && observations.pushConfigBodyTasks.length < 16) {
          const task = settleBefore(response.json(), 5_000).then(settled => {
            if (!settled.completed) return { httpStatus: status, available: null, status: null, errorCode: null, publicKeyPresent: false, bodyRead: 'timeout' }
            if (settled.error) return { httpStatus: status, available: null, status: null, errorCode: null, publicKeyPresent: false, bodyRead: 'invalid-json' }
            const body = settled.value
            const code = body?.errorCode ?? body?.code ?? body?.error?.code ?? body?.error
            const safeCode = typeof code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/u.test(code) ? code : null
            const configStatus = typeof body?.status === 'string' && /^[A-Za-z0-9_-]{1,32}$/u.test(body.status) ? body.status : null
            return { httpStatus: status, available: typeof body?.available === 'boolean' ? body.available : null,
              status: configStatus, errorCode: safeCode, publicKeyPresent: typeof body?.publicKey === 'string' && body.publicKey.length > 0 }
          })
          observations.pushConfigBodyTasks.push(task)
          void task.then(value => { if (observations.pushConfigBodies.length < 16) observations.pushConfigBodies.push(value) })
        }
      })
    }
    const capturePushSettingsDiagnostic = async page => {
      const state = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('.dsh-mobile-settings_row')]
        const pushRows = rows.filter(row => row.querySelector('.dsh-mobile-push-actions') !== null)
        const visible = element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0
          && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none'
        const safeHeading = value => /^[A-Za-zÀ-ÖØ-öø-ÿ0-9\u3400-\u9fff _.,:!?()[\]'-]{1,80}$/u.test(value)
          && !/(?:https?:|token=|reference=|mobile-push=|[0-9a-f]{32,})/iu.test(value)
        const headings = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].filter(visible)
          .map(element => (element.innerText ?? '').replace(/\s+/gu, ' ').trim()).filter(safeHeading).slice(0, 12)
        const titleTexts = [...document.querySelectorAll('.dsh-mobile-settings_title')].filter(visible)
          .map(element => (element.innerText ?? '').replace(/\s+/gu, ' ').trim()).filter(safeHeading).slice(0, 16)
        const frontend = window.__DSH_MOBILE_FRONTEND__
        const notificationPermission = !('Notification' in window) ? 'unsupported'
          : ['granted', 'denied', 'default'].includes(window.Notification.permission) ? window.Notification.permission : 'other'
        const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches
          || matchMedia('(display-mode: fullscreen)').matches
        return { pathname: location.pathname, settingsLanguage: document.documentElement.lang || null,
          browserLanguage: navigator.language || null, pushRowLanguage: pushRows[0]?.getAttribute('lang') ?? null,
          frontendKind: frontend === 'dedicated' ? 'dedicated' : frontend === 'native' ? 'native' : frontend === undefined ? 'absent' : 'other',
          nativeClientPresent: window.__DSH_MOBILE_NATIVE__ !== undefined,
          gatewayAuthenticatedMarker: document.querySelector('meta[name="dsh-mobile-gateway"][content="authenticated"]') !== null,
          secureContext: isSecureContext, topLevel: window.top === window.self, standalone,
          pushManagerPresent: window.pushManager !== undefined, notificationPermission,
          serviceWorkerSupported: 'serviceWorker' in navigator, moduleLoaderPresent: window.__ModuleLoader__ !== undefined,
          visibleHeadings: headings, visibleSettingsTitles: titleTexts,
          selectorCounts: { '.dsh-mobile-settings_row': rows.length, '.dsh-mobile-push-actions': pushRows.length,
            '.dsh-mobile-settings_title': document.querySelectorAll('.dsh-mobile-settings_title').length },
          visiblePushRowCount: pushRows.filter(visible).length,
          englishPushTitleCount: titleTexts.filter(value => value === 'Web push notifications').length,
          zhPushTitleCount: titleTexts.filter(value => value === '网页推送通知').length,
          itPushTitleCount: titleTexts.filter(value => value === 'Notifiche Web push').length,
          settingsDialogCount: document.querySelectorAll('[role="dialog"]').length }
      }).catch(() => ({ pageState: 'closed-or-unavailable' }))
      const configTasks = observations.pushConfigBodyTasks.slice(-8)
      const configBodies = await Promise.all(configTasks.map(async task => {
        const settled = await settleBefore(task, 2_000)
        return settled.completed ? settled.value : { bodyRead: 'pending' }
      }))
      const configRequests = observations.pushRequests.filter(item => item.path === '/mobile-access/push/config')
      const configResponses = observations.pushResponses.filter(item => item.path === '/mobile-access/push/config')
      const availableConfig = configBodies.some(body => body.available === true && body.publicKeyPresent)
      const unavailableConfig = configBodies.some(body => body.available === false)
      const configSucceeded = configResponses.some(response => response.status === 200)
      const controllerReadinessEvidence = configRequests.length === 0 ? 'no-config-get-observed'
        : availableConfig ? 'config-available-and-public-key-present' : unavailableConfig ? 'config-unavailable'
          : configSucceeded ? 'config-200-capability-unconfirmed' : 'config-request-not-successful'
      return { ...state, selectorUnderTest: '.dsh-mobile-settings_row containing exact title “Web push notifications”',
        configGetCount: configRequests.length, configHttpStatuses: configResponses.map(response => response.status).slice(-8),
        configBodies, controllerReadinessEvidence, pageErrors: observations.pageErrors.slice(-16),
        consoleCategories: observations.consoleCategories.slice(-16), cspViolations: observations.cspViolations.slice(-16) }
    }
    phone = await traced('create-fresh-mobile-page', () => phoneContext.newPage())
    await attachPhoneObservers(phone)
    phone.setDefaultNavigationTimeout(15_000)
    phone.setDefaultTimeout(10_000)
    // Capture the module system the DSH shell creates so later native-Switch paint
    // assertions can render the shell's own public component test-only (same wrap
    // pattern as scripts/smoke-mobile-settings.mjs); no page behavior is changed.
    await traced('arm-module-loader-capture', () => phone.addInitScript(() => {
      let moduleLoader
      Object.defineProperty(window, '__ModuleLoader__', {
        configurable: true,
        get: () => moduleLoader,
        set: value => {
          moduleLoader = value
          const create = value.create
          value.create = function (...args) {
            const modules = create.apply(this, args)
            window.__pushSmokeModules = modules
            return modules
          }
        },
      })
    }))

    // Credential-free fixed assets must work on the public route before pairing.
    const unauthManifest = await traced('get-public-prepair-manifest', () => phone.request.get(`${gatewayOrigin}/mobile-access/push/manifest.webmanifest`, { timeout: 5_000 }))
    assert.equal(unauthManifest.status(), 200, 'Credential-free push manifest was not public before pairing')
    assert.match(unauthManifest.headers()['content-type'] ?? '', /application\/manifest\+json/iu)
    const manifest = await traced('decode-public-prepair-manifest', () => unauthManifest.json())
    assert.deepEqual({ id: manifest.id, start_url: manifest.start_url, scope: manifest.scope, display: manifest.display },
      { id: '/', start_url: '/', scope: '/', display: 'standalone' })
    assert(!/credential|authorization|token|reference|[?&]ref=/iu.test(JSON.stringify(manifest)), 'Manifest contained credential or tap metadata')
    for (const [name, size] of [['icon-180.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
      const icon = await traced(`get-public-prepair-${name}`, () => phone.request.get(`${gatewayOrigin}/mobile-access/push/${name}`, { timeout: 5_000 }))
      assert.equal(icon.status(), 200, `Fixed ${size}px push icon was not public before pairing`)
      assert.match(icon.headers()['content-type'] ?? '', /image\/png/iu)
      const iconBytes = await traced(`read-public-prepair-${name}`, () => icon.body())
      assert.deepEqual([...Buffer.from(iconBytes).subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
    }
    const unauthId = randomBytes(16).toString('hex').replace(/^([a-f0-9]{8})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{4})([a-f0-9]{12})$/u, '$1-$2-$3-$4-$5')
    const unauthorizedConfig = await traced('get-protected-config-before-pair', () => phone.request.get(`${gatewayOrigin}/mobile-access/push/config?installationId=${encodeURIComponent(unauthId)}`, { timeout: 5_000 }))
    assert.equal(unauthorizedConfig.status(), 401, 'Push config must remain authenticated before pairing')
    const publicProbePage = await traced('create-separate-prepair-probe-page', () => phoneContext.newPage())
    let prepairResolveStatus = null
    try {
      publicProbePage.setDefaultNavigationTimeout(15_000)
      await traced('load-separate-public-pair-page', () => publicProbePage.goto(`${gatewayOrigin}/mobile-access/pair`, { waitUntil: 'domcontentloaded' }))
      prepairResolveStatus = await traced('probe-resolve-authentication-boundary', () => publicProbePage.evaluate(async reference => {
        const response = await fetch('/mobile-access/push/resolve', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reference }), signal: AbortSignal.timeout(5_000) })
        return response.status
      }, `missing-${transportNonce}`))
      assert.equal(prepairResolveStatus, 401, 'Target resolution must remain authenticated before pairing')
    } finally { await traced('close-separate-prepair-probe-page', () => publicProbePage.close()) }
    cases.push('fixed manifest/icons are public before pairing; config/resolve remain 401')

    // Pair against the real Gateway from a fresh page, preserving the fragment-to-form execution path.
    const pairRequests = [], pairResponses = [], pairRequestHeaderTasks = []
    const pairLabelA = `Task8 Pair A ${pairDiagnosticRunId.slice(0, 8)}`
    let pairFormDiagnostics
    phone.on('request', request => {
      if (new URL(request.url()).pathname !== '/mobile-access/auth/pair') return
      pairRequestHeaderTasks.push(request.allHeaders().then(headers => {
        const url = new URL(request.url())
        const cookieNames = (headers.cookie ?? '').split(';').map(item => item.trim().split('=')[0]).filter(Boolean).sort()
        pairRequests.push({ method: request.method(), originClass: headers.origin === url.origin ? 'same-origin'
          : headers.origin ? 'other-origin' : 'absent', hostClass: (headers[':authority'] ?? headers.host) === undefined
            ? 'browser-managed' : (headers[':authority'] ?? headers.host) === url.host ? 'matches-url' : 'mismatch',
          cookieNames, credentialsPresent: cookieNames.length > 0 })
      }, () => { pairRequests.push({ method: request.method(), headerRead: 'failed' }) }))
    })
    phone.on('response', response => {
      if (new URL(response.url()).pathname === '/mobile-access/auth/pair') pairResponses.push({ status: response.status(), method: response.request().method() })
    })
    const pairResponsePromise = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/auth/pair'
      && response.request().method() === 'POST', { timeout: 15_000 }).then(response => ({ response }), error => ({ error }))
    const capturePairForm = async page => {
      await page.locator('#device-label').fill(pairLabelA)
      if (!pairDiagnostic) return
      pairFormDiagnostics = await traced('capture-form-state-before-pair-submit', () => page.evaluate(label => {
        const form = document.querySelector('#pair-form')
        const token = document.querySelector('#pair-token')
        const submit = form?.querySelector('button[type="submit"]')
        const validityKeys = ['valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow',
          'rangeOverflow', 'stepMismatch', 'badInput', 'customError']
        const invalidControls = [...(form?.elements ?? [])].filter(control => control.willValidate && !control.validity.valid)
          .map(control => ({ name: control.name || null, id: control.id || null, type: control.type || null,
            validity: Object.fromEntries(validityKeys.map(key => [key, Boolean(control.validity[key])])) }))
        const formValid = form?.checkValidity() ?? null
        return { pathname: location.pathname, pairScriptResourceLoaded: performance.getEntriesByType('resource')
            .some(entry => { try { return new URL(entry.name, location.href).pathname === '/mobile-access/pair.js' } catch { return false } }),
          initialPairFragmentPresent: window.__dshPairDiagnosticInitialFragmentPresent === true,
          tokenPresent: Boolean(token?.value.trim()), formValid, invalidControls,
          button: submit ? { type: submit.type, disabled: submit.disabled, formNoValidate: submit.formNoValidate } : null,
          deviceLabelSet: document.querySelector('#device-label')?.value === label }
      }, pairLabelA))
      pairDiagnosticDetail(pairDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'pair-form-pre-submit', pairFormDiagnostics)
    }
    let pairingBaseline
    let pairStepTimer
    if (pairDiagnostic) pairStepTimer = setTimeout(() => {
      diagnosticCancelled = true
      mark('cancel', 'pair-helper-25s-boundary')
      pairStepCancelPromise = phone.close().catch(() => {})
    }, 25_000)
    try {
      mark('before', 'pair-through-public-helper')
      pairingBaseline = await traced('pair-through-public-helper', () => pairMobilePage(phone, gatewayPairUrl, dsh.logs, {
        beforeSubmit: capturePairForm, workspaceTimeoutMs: 15_000,
      }))
    } catch (error) {
      const pairResponseResult = await pairResponsePromise
      await Promise.all(pairRequestHeaderTasks)
      const pairResponseStatus = pairResponseResult.response?.status() ?? null
      const pagePathname = await phone.evaluate(() => location.pathname).catch(() => '<closed>')
      if (pairDiagnostic) {
        const publicBoundary = await phone.request.get(`${gatewayOrigin}/mobile-access/push/config?installationId=${encodeURIComponent(unauthId)}`, { timeout: 5_000 })
          .then(response => ({ status: response.status() }), () => ({ status: null }))
        const cookies = await phoneContext.cookies([gatewayOrigin, `${gatewayOrigin}/mobile-access/auth/renew`]).catch(() => [])
        const safeErrorCode = await safeResponseErrorCode(pairResponseResult.response, phone)
        pairDiagnosticResult = { status: 'PAIR_DIAGNOSTIC_CAPTURED', pairStatus: pairResponseStatus, safeErrorCode,
          pairRequests, pairResponses, form: pairFormDiagnostics ?? null, pageErrors: pairPageErrors, console: pairConsoleDiagnostics,
          cspViolations: await phone.evaluate(() => window.__dshPairDiagnosticCsp ?? []).catch(() => []),
          cookiePresence: { present: cookies.length > 0, names: [...new Set(cookies.map(cookie => cookie.name))].sort() },
          resultingPathname: pagePathname, prepairConfigStatus: unauthorizedConfig.status(), prepairResolveStatus,
          targetedPublicBoundary: publicBoundary, helperPageWasFresh: true, actualPostSent: pairRequests.length > 0 }
        pairDiagnosticDetail(pairDiagnosticFd, pairDiagnosticRunId, 'proof', 'pair-failure-boundary', pairDiagnosticResult)
        throw pairDiagnosticComplete
      }
      throw new Error(`Pairing lifecycle did not reach the owned root: responseStatus=${String(pairResponseStatus)}, page=${JSON.stringify({ pathname: pagePathname })}, error=${safeText(error?.message ?? error)}`)
    } finally { clearTimeout(pairStepTimer) }
    const pairResponseResult = await pairResponsePromise
    if (pairResponseResult.error) throw pairResponseResult.error
    const pairResponse = pairResponseResult.response
    if (pairDiagnostic) {
      const pairStatus = pairResponse.status()
      const pairList = await traced('verify-pair-through-real-desktop-admin-list', () => readDesktopDevices(desktop))
      const labelMatches = pairList.devices.filter(device => device.label === pairLabelA && typeof device.id === 'string')
      assert.equal(pairStatus, 201, 'Actual Gateway pair route did not return 201')
      assert.equal(pairList.status, 200, 'Desktop admin device list did not return 200 after pairing')
      assert.equal(labelMatches.length, 1, 'Public desktop-admin list did not expose exactly one new labelled pairing')
      const configAfterPair = await traced('verify-protected-config-after-real-pair', () => readPushConfig(phone, installationId))
      const cookies = await phoneContext.cookies([gatewayOrigin, `${gatewayOrigin}/mobile-access/auth/renew`])
      await Promise.all(pairRequestHeaderTasks)
      pairDiagnosticResult = { status: 'PAIR_DIAGNOSTIC_CAPTURED', candidateSha256: tarballSha256, pairStatus,
        safeErrorCode: null, pairRequests, pairResponses, form: pairFormDiagnostics, pageErrors: pairPageErrors,
        console: pairConsoleDiagnostics, cspViolations: await phone.evaluate(() => window.__dshPairDiagnosticCsp ?? []).catch(() => []),
        cookiePresence: { present: cookies.length > 0, names: [...new Set(cookies.map(cookie => cookie.name))].sort() },
        resultingPathname: new URL(phone.url()).pathname, publicBoundaryStatusBeforePair: unauthorizedConfig.status(), prepairResolveStatus,
        protectedConfigStatusAfterPair: 200, mountedShell: true, workspaceBaseline: pairingBaseline.value.items.some(item => item.workspaceId === workspaceId),
        desktopAdminList: { status: pairList.status, matchingLabelCount: labelMatches.length, deviceIdPresent: typeof labelMatches[0]?.id === 'string' },
        helperPageWasFresh: true, comparison: 'prepair probe ran on a separate page; pairMobilePage ran on the untouched fresh main phone page' }
      pairDiagnosticDetail(pairDiagnosticFd, pairDiagnosticRunId, 'proof', 'public-pair-result', pairDiagnosticResult)
      mark('complete', 'pair-diagnostic-public-contract-proof', { pairStatus, adminListStatus: pairList.status })
      throw pairDiagnosticComplete
    }
    assert.equal(pairResponse.status(), 201)
    const pairedDevices = await traced('read-actual-paired-device-from-admin-list', () => readDesktopDevices(desktop))
    assert.equal(pairedDevices.status, 200)
    const pairedDeviceMatches = pairedDevices.devices.filter(device => device.label === pairLabelA && typeof device.id === 'string')
    assert.equal(pairedDeviceMatches.length, 1, 'Exactly one actual paired Device A must be found from desktop admin')
    deviceId = pairedDeviceMatches[0].id
    assert.match(deviceId, /^[a-f\d]{32}$/u)
    assert(pairingBaseline.value.items.some(item => item.workspaceId === workspaceId), 'Authenticated Workspace baseline omitted owned Workspace')
    assert(pairingBaseline.value.items.some(item => item.workspaceId === workspaceId), 'Authenticated Workspace baseline omitted owned Workspace')
    const unpairedContext = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-US', proxy: ownedContextProxy })
    await traced('arm-release-check-abort-unpaired', () => armReleaseCheckAbort(unpairedContext, 'unpaired', releaseCheckAllowedOrigins))
    try {
      const unpairedPage = await unpairedContext.newPage()
      const opaqueReturn = 'task8-return-check'
      await unpairedPage.goto(`${gatewayOrigin}/?mobile-push=${opaqueReturn}`, { waitUntil: 'domcontentloaded', timeout: CLIENT_TIMEOUT_MS })
      const loginLocation = new URL(unpairedPage.url())
      assert.equal(loginLocation.pathname, '/mobile-access/login')
      assert.equal(loginLocation.searchParams.get('return'), `/?mobile-push=${opaqueReturn}`)
      cases.push('unpaired Gateway return redirect preserved the opaque mobile-push path through the existing safe login return')
    } finally { await unpairedContext.close() }
    await dismissOnboarding(phone)
    await phone.waitForFunction(() => document.querySelector('.dshm-shell') !== null, undefined, { timeout: CLIENT_TIMEOUT_MS })
    const dedicatedDocument = await phone.evaluate(() => ({
      gatewayMarker: document.querySelector('meta[name="dsh-mobile-gateway"]')?.content,
      manifestHref: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
    }))
    assert.equal(dedicatedDocument.gatewayMarker, 'authenticated')
    assert.equal(dedicatedDocument.manifestHref, '/mobile-access/push/manifest.webmanifest')
    await phone.route('**/api/session/prompt', async route => {
      if (!promptHoldPromise) { await route.abort('blockedbyclient'); return }
      promptHoldReached?.resolve({ method: route.request().method(), held: true })
      const completed = promptHoldHandlerDone
      try {
        await promptHoldPromise
        await route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"bad_request"}' })
        completed?.resolve('fulfilled-after-navigation')
      } catch { completed?.resolve('aborted-before-forward') }
    })

    const controlsBefore = await workerAndCacheSnapshot(phone)
    assert.equal(controlsBefore.calls.serviceWorkerRegisterCalls ?? 0, 0)
    assert.equal(controlsBefore.calls.serviceWorkerUnregisterCalls ?? 0, 0)
    await openMobileSettings(phone)
    const settings = phone.locator('.dsh-mobile-settings_row').filter({ has: phone.getByText('Web push notifications', { exact: true }) })
    pushSettingsDiagnostic = await capturePushSettingsDiagnostic(phone)
    pushSettingsDiagnostic.exactEnglishLocatorCount = await settings.count()
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'pre-settings-row-wait', pushSettingsDiagnostic)
    try { await settings.waitFor({ state: 'visible', timeout: 10_000 }) }
    catch {
      pushSettingsDiagnostic = await capturePushSettingsDiagnostic(phone)
      pushSettingsDiagnostic.exactEnglishLocatorCount = await settings.count()
      pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'settings-row-wait-timeout', pushSettingsDiagnostic)
      throw new Error(`Expected one visible Web Push settings row/controller; safeDiagnostic=${JSON.stringify(pushSettingsDiagnostic)}`)
    }
    pushSettingsDiagnostic = await capturePushSettingsDiagnostic(phone)
    pushSettingsDiagnostic.exactEnglishLocatorCount = await settings.count()
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'settings-row-visible', pushSettingsDiagnostic)
    pushRowCount = pushSettingsDiagnostic.exactEnglishLocatorCount
    assert.equal(pushRowCount, 1, 'Exactly one mounted Web Push settings row/controller is expected')
    // Presentation acceptance for the mounted category rows: the controls must be the
    // actual public DSH Switch. Component identity (same shell-owned track class), DOM
    // semantics and track/thumb geometry are compared with the real "Show coding view"
    // toggle mounted by General settings on the same page — state-independent checks.
    // Label typography must equal the General row title (14px/20px regular). Native
    // paint is compared per matching aria-checked state after the Responses toggle.
    const mountedNativeSwitch = await phone.evaluate(() => {
      const group = document.querySelector('.dsh-mobile-push-categories')
      if (group === null) return { missing: 'group' }
      // The General "Show coding view" toggle names its own Switch with the row title
      // (DeveloperToolsRow passes label: t("developerTools.title")); locate it directly.
      const referenceSwitch = [...document.querySelectorAll('button[role="switch"]')]
        .find(control => control.getAttribute('aria-label') === 'Show coding view') ?? null
      const referenceRow = referenceSwitch?.closest('[class*="_row"]') ?? null
      const referenceTitle = referenceRow?.querySelector('[class*="_title"]') ?? null
      if (referenceSwitch === null || referenceTitle === null) return { missing: 'reference' }
      const trackClassOf = element => [...element.classList].find(name => /_switch_/u.test(name)) ?? null
      const referenceTitleStyle = getComputedStyle(referenceTitle)
      const groupRect = group.getBoundingClientRect()
      const rows = [...group.querySelectorAll('.dsh-mobile-push-category')].map(row => {
        const control = row.querySelector('button[role="switch"]')
        const text = row.querySelector('.dsh-mobile-push-categoryName')
        if (control === null || text === null) return { missingControl: true }
        const l = row.getBoundingClientRect(), c = control.getBoundingClientRect(), t = text.getBoundingClientRect()
        const textStyle = getComputedStyle(text)
        const thumb = control.querySelector('span')
        const thumbBox = thumb ? thumb.getBoundingClientRect() : null
        return { missingControl: false, rowHeight: l.height, rowWidth: l.width, rowRight: l.right, rowTop: l.top, rowBottom: l.bottom,
          controlRight: c.right, controlLeft: c.left, controlTop: c.top, controlBottom: c.bottom, textRight: t.right,
          controlWidth: c.width, controlHeight: c.height, controlType: control.getAttribute('type'), controlRole: control.getAttribute('role'),
          trackClass: trackClassOf(control), thumbWidth: thumbBox?.width ?? null, thumbHeight: thumbBox?.height ?? null,
          typography: `${textStyle.fontSize}/${textStyle.lineHeight}/${textStyle.fontWeight}` }
      })
      const referenceBox = referenceSwitch.getBoundingClientRect()
      const referenceThumb = referenceSwitch.querySelector('span')
      const referenceThumbBox = referenceThumb ? referenceThumb.getBoundingClientRect() : null
      return { missing: false, rows, paintedInputs: group.querySelectorAll('input').length,
        reference: { checked: referenceSwitch.getAttribute('aria-checked'), trackClass: trackClassOf(referenceSwitch),
          width: referenceBox.width, height: referenceBox.height, thumbWidth: referenceThumbBox?.width ?? null, thumbHeight: referenceThumbBox?.height ?? null,
          typography: referenceTitleStyle ? `${referenceTitleStyle.fontSize}/${referenceTitleStyle.lineHeight}/${referenceTitleStyle.fontWeight}` : null },
        groupLeft: groupRect.left, groupRight: groupRect.right,
        docScrollWidth: document.scrollingElement.scrollWidth, viewportWidth: document.documentElement.clientWidth }
    })
    assert.equal(mountedNativeSwitch.missing, false,
      `Mounted settings must expose the push category group and the Show coding view reference row (missing=${String(mountedNativeSwitch.missing)})`)
    assert.equal(mountedNativeSwitch.rows.length, 6, 'Mounted push settings must render six category rows')
    assert.equal(mountedNativeSwitch.paintedInputs, 0, 'Mounted push settings must not render painted input switches')
    const referenceSwitchMetrics = mountedNativeSwitch.reference
    assert.ok(referenceSwitchMetrics.trackClass !== null, 'Show coding view reference switch has no shell track class to compare')
    mountedNativeSwitch.rows.forEach((row, index) => {
      assert.equal(row.missingControl, false, `Mounted category row ${index} must carry a native Switch control`)
      assert.equal(row.controlType, 'button', `Mounted category row ${index} control must be a native button`)
      assert.equal(row.controlRole, 'switch', `Mounted category row ${index} control must keep role=switch`)
      assert.equal(row.trackClass, referenceSwitchMetrics.trackClass,
        `Mounted category row ${index} must use the same shell Switch component class as the Show coding view toggle`)
      assert.equal(row.typography, referenceSwitchMetrics.typography,
        `Mounted category row ${index} label typography must equal the General row title (${referenceSwitchMetrics.typography})`)
      assert.equal(row.typography, '14px/20px/400', `Mounted category row ${index} label must be 14px/20px regular weight`)
      assert.ok(Math.abs(row.controlWidth - referenceSwitchMetrics.width) <= 0.5 && Math.abs(row.controlHeight - referenceSwitchMetrics.height) <= 0.5,
        `Mounted category row ${index} track geometry must equal the Show coding view toggle (${row.controlWidth}x${row.controlHeight} vs ${referenceSwitchMetrics.width}x${referenceSwitchMetrics.height})`)
      assert.ok(Math.abs((row.thumbWidth ?? -1) - referenceSwitchMetrics.thumbWidth) <= 0.5 && Math.abs((row.thumbHeight ?? -1) - referenceSwitchMetrics.thumbHeight) <= 0.5,
        `Mounted category row ${index} thumb geometry must equal the Show coding view toggle`)
      assert.ok(row.rowHeight >= 47.5, `Mounted category row ${index} must keep a >=48px full-row target (got ${row.rowHeight}px)`)
      assert.ok(Math.abs(row.rowWidth - (mountedNativeSwitch.groupRight - mountedNativeSwitch.groupLeft)) <= 1.5, `Mounted category row ${index} must fill the settings section width`)
      assert.ok(row.textRight <= row.controlLeft - 2, `Mounted category row ${index} must keep its label left of the switch`)
      assert.ok(row.rowRight - row.controlRight <= 1.5, `Mounted category row ${index} must right-align its switch`)
      assert.ok(row.controlTop >= row.rowTop - 1 && row.controlBottom <= row.rowBottom + 1, `Mounted category row ${index} switch must stay on its row`)
    })
    assert.ok(mountedNativeSwitch.docScrollWidth <= mountedNativeSwitch.viewportWidth + 1,
      'Mounted push category rows must not overflow the phone viewport horizontally')
    // Touch targets: the associated label row and the native switch track must both be
    // hittable across their box without clipping — measured, not toggled, so no extra
    // preference mutation is introduced beyond the existing Responses flow. The row is
    // scrolled into view first: elementFromPoint needs the target inside the scrollport,
    // and the settings overlay may mount the push group below the fold.
    await phone.locator('.dsh-mobile-push-category').first().scrollIntoViewIfNeeded()
    const touchTargets = await phone.evaluate(() => {
      const row = document.querySelector('.dsh-mobile-push-category')
      const control = row?.querySelector('button[role="switch"]') ?? null
      if (row === undefined || row === null || control === null) return { missing: true }
      const probe = element => {
        const box = element.getBoundingClientRect()
        const center = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        const edges = [box.x + 4, box.right - 4].every(x => {
          const edge = document.elementFromPoint(x, box.y + box.height / 2)
          return edge !== null && (edge === element || element.contains(edge) || element.closest('label') === edge?.closest('label'))
        })
        return { width: box.width, height: box.height, left: box.left, right: box.right, viewport: innerWidth,
          hit: center !== null && (center === element || element.contains(center) || element.closest('label') === center?.closest('label')), edges }
      }
      return { missing: false, row: probe(row), control: probe(control) }
    })
    assert.equal(touchTargets.missing, false, 'Mounted category touch targets could not be probed')
    assert.ok(touchTargets.row.height >= 47.5 && touchTargets.row.width >= 44, 'Mounted category full-row touch target is too small')
    assert.ok(touchTargets.row.hit && touchTargets.row.edges, 'Mounted category full-row touch target is clipped or blocked')
    assert.ok(touchTargets.control.hit && touchTargets.control.edges, 'Mounted native Switch track touch target is clipped or blocked')
    assert.ok(touchTargets.control.left >= -1 && touchTargets.control.right <= touchTargets.control.viewport + 1, 'Mounted native Switch track overflows the viewport')
    const mountedEvidenceDir = process.env.DSH_PUSH_EVIDENCE_DIR
    if (typeof mountedEvidenceDir === 'string' && mountedEvidenceDir !== '' && isAbsolute(mountedEvidenceDir)) {
      await mkdir(mountedEvidenceDir, { recursive: true })
      await settings.screenshot({ path: join(mountedEvidenceDir, `task8-${pairDiagnosticRunId}-push-settings-mounted-categories.png`) })
    }
    cases.push('mounted push categories render the real shell Switch (Show coding view identity/geometry) with 14px/20px labels and full-row touch targets')
    const enable = settings.getByRole('button', { name: 'Enable', exact: true })
    await enable.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    subscribeCallsBeforeEnable = await phone.evaluate(() => window.__dshPushSmokeCounts().subscribeCalls ?? 0)
    assert.equal(subscribeCallsBeforeEnable, 0, 'Mount/refresh must not subscribe before explicit Enable gesture')
    const configBeforeEnable = observations.pushResponses.filter(item => item.path === '/mobile-access/push/config' && item.status === 200)
    assert(configBeforeEnable.length > 0, 'Mounted paired settings did not call actual config route')
    await enable.click()
    await settings.getByRole('button', { name: 'Disable', exact: true }).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    const subscribeEvidence = await phone.evaluate(() => window.__dshPushSmokeSubscribe)
    assert.deepEqual(subscribeEvidence, { userGesture: true, userVisibleOnly: true, applicationServerKeyBytes: 65 },
      'Synthetic PushManager must observe an explicit valid subscription gesture')
    subscribeCallsAfterEnable = await phone.evaluate(() => window.__dshPushSmokeCounts().subscribeCalls ?? 0)
    successfulEnrollCount = observations.pushResponses.filter(item => item.path === '/mobile-access/push/subscription' && [200, 201].includes(item.status)).length
    assert.equal(subscribeCallsAfterEnable, 1, 'One mounted controller must call subscribe exactly once after one gesture')
    assert.equal(successfulEnrollCount, 1, 'One explicit Enable gesture must cause exactly one successful packed enrollment')
    const enrolledConfigEvidence = await observePublicPushConfig(phone, installationId, gatewayOrigin)
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'post-enrollment-public-config', enrolledConfigEvidence)
    assert.equal(enrolledConfigEvidence.httpStatus, 200, 'Post-enrollment public config read was not authorized')
    assert.equal(enrolledConfigEvidence.sameOrigin, true)
    assert.equal(enrolledConfigEvidence.installationIdMatches, true)
    assert.equal(enrolledConfigEvidence.status, 'enabled', 'Public config did not persist push consent after enrollment')
    assert.equal(enrolledConfigEvidence.preferences.question, true, 'Question notification category must remain enabled for source fixture')
    const registryAfterEnrollment = await readOwnedNotificationSummary(root, home, { deviceId, installationId, origin: gatewayOrigin })
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'post-enrollment-owned-notification-summary', registryAfterEnrollment)
    cases.push('one mounted settings row/controller caused one user-gesture subscribe and one real packed enrollment')

    // The same-origin fetch bootstrap supplies the real cookie token unless an explicit bad token is present.
    // Empty CSRF is preserved by the wrapper and rejected before the mutation body is read.
    const invalidCsrfStatus = await phone.evaluate(async () => {
      const response = await fetch('/mobile-access/push/preferences', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dsh-mobile-csrf': '' }, body: JSON.stringify({ installationId: '00000000-0000-4000-8000-000000000001',
          preferences: { question: true, plan: true, approval: true, response: true, goal: true, failure: true }, ownerGeneration: 0, registrationGeneration: 0 }) })
      return response.status
    })
    assert.equal(invalidCsrfStatus, 403, `Paired Gateway did not reject the invalid-CSRF mutation: ${invalidCsrfStatus}`)
    cases.push('paired Gateway rejected a same-origin mutation with an explicitly invalid CSRF token')

    // Persist one category through the actual Host registry route and re-read after a page reload.
    // The toggle is the mounted native Switch itself, activated with a real touch tap.
    const responseChoice = settings.getByRole('switch', { name: 'Responses', exact: true })
    await responseChoice.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    assert.equal(await responseChoice.getAttribute('aria-checked'), 'true', 'Responses category must start enabled before the tap')
    await responseChoice.tap()
    await phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/push/preferences'
      && response.status() === 200, { timeout: CLIENT_TIMEOUT_MS })
    await phone.reload({ waitUntil: 'domcontentloaded' })
    await phone.waitForFunction(() => document.querySelector('.dshm-shell') !== null, undefined, { timeout: CLIENT_TIMEOUT_MS })
    const postReloadUiBoundary = await phone.evaluate(() => {
      const drawer = document.querySelector('.dshm-drawer')
      const account = drawer?.querySelector('button[aria-haspopup="menu"]')
      const dialogs = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      const knownButtonLabels = new Set(['Close', '关闭', 'Add API Key', '添加 API Key', 'Sign in', '登录',
        'Configure later', '稍后配置', 'Continue', '继续'])
      return { drawerOpen: drawer?.getAttribute('data-open') ?? null,
        accountMenuExpanded: account?.getAttribute('aria-expanded') ?? null,
        dialogLabels: dialogs.map(dialog => dialog.getAttribute('aria-label') ?? null),
        dialogButtonLabels: dialogs.map(dialog => [...dialog.querySelectorAll('button')].map(button => {
          const label = (button.getAttribute('aria-label') ?? button.textContent ?? '').trim()
          return knownButtonLabels.has(label) ? label : '<other>'
        })),
        ariaHiddenPresentationCount: document.querySelectorAll('[role="presentation"] [aria-hidden="true"]').length }
    })
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'post-preference-reload-before-settings', postReloadUiBoundary)
    await dismissOnboarding(phone)
    await openMobileSettings(phone)
    const restoredSettings = phone.locator('.dsh-mobile-settings_row').filter({ has: phone.getByText('Web push notifications', { exact: true }) })
    await restoredSettings.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    const restoredResponseChoice = restoredSettings.getByRole('switch', { name: 'Responses', exact: true })
    await restoredResponseChoice.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    assert.equal(await restoredResponseChoice.getAttribute('aria-checked'), 'false', 'Category preference did not persist in actual registry')
    cases.push('category preference persisted through real preferences route and reloaded config')

    // Native paint acceptance, matched-state only: the persisted Responses-off category
    // gives a natural off state; the Show coding view reference toggle is compared in
    // whatever state it is mounted in. The on state is compared against the shell's own
    // public Switch rendered test-only from the captured module system into an isolated
    // offscreen container — the same real component and stylesheet, zero Host mutation.
    const nativePaintComparison = await phone.evaluate(async () => {
      const modules = window.__pushSmokeModules
      const group = document.querySelector('.dsh-mobile-push-categories')
      const referenceSwitch = [...document.querySelectorAll('button[role="switch"]')]
        .find(control => control.getAttribute('aria-label') === 'Show coding view') ?? null
      if (modules === undefined || group === null || referenceSwitch === null) return { missing: true, hasModules: modules !== undefined, hasGroup: group !== null, hasReference: referenceSwitch !== null }
      const paint = element => {
        const style = getComputedStyle(element)
        const thumb = element.querySelector('span')
        const thumbStyle = thumb ? getComputedStyle(thumb) : null
        return { trackClass: [...element.classList].find(name => /_switch_/u.test(name)) ?? null, background: style.backgroundColor,
          thumbTransform: thumbStyle?.transform ?? null, thumbBackground: thumbStyle?.backgroundColor ?? null }
      }
      const categorySwitches = [...group.querySelectorAll('button[role="switch"]')]
      const offCategory = categorySwitches.find(control => control.getAttribute('aria-checked') === 'false') ?? null
      const onCategory = categorySwitches.find(control => control.getAttribute('aria-checked') === 'true') ?? null
      const [react, reactDom, primitives] = await Promise.all([
        modules.import('react'), modules.import('react-dom/client'), modules.import('@deepseek-ai/dsh-client-ui-primitives'),
      ])
      const container = document.createElement('div')
      container.dataset.pushSmokeSwitchProof = 'true'
      container.setAttribute('aria-hidden', 'true')
      container.style.cssText = 'position:fixed;left:-9999px;top:0;'
      document.body.append(container)
      const root = reactDom.createRoot(container)
      let proofOn = null, proofOff = null
      try {
        // A distinct key per state mounts a FRESH native control: the shell thumb animates
        // its transform over .12s on state change, so reusing one node would read a
        // mid-transition matrix. Static initial paint per state is what is compared.
        const renderState = async checked => {
          await new Promise(resolve => {
            root.render(react.createElement(primitives.Switch, { key: checked ? 'push-smoke-proof-on' : 'push-smoke-proof-off',
              checked, label: `push smoke native proof ${String(checked)}`, onChange: () => undefined }))
            const settled = () => {
              if (container.querySelector(`button[role="switch"][aria-checked="${String(checked)}"]`) !== null) resolve()
              else requestAnimationFrame(settled)
            }
            requestAnimationFrame(settled)
          })
          const proof = container.querySelector('button[role="switch"]')
          return proof === null ? null : paint(proof)
        }
        proofOn = await renderState(true)
        proofOff = await renderState(false)
      } finally {
        root.unmount()
        container.remove()
      }
      return { missing: false, referenceChecked: referenceSwitch.getAttribute('aria-checked'), reference: paint(referenceSwitch),
        offCategory: offCategory === null ? null : paint(offCategory), onCategory: onCategory === null ? null : paint(onCategory), proofOn, proofOff }
    })
    assert.equal(nativePaintComparison.missing, false, 'Native paint comparison could not find the mounted switches or captured module system')
    const samePaint = (a, b, what) => {
      assert.ok(a !== null && b !== null, `${what}: missing switch to compare`)
      assert.equal(a.trackClass, b.trackClass, `${what}: track class mismatch`)
      assert.equal(a.background, b.background, `${what}: track background mismatch (${a.background} vs ${b.background})`)
      assert.equal(a.thumbTransform, b.thumbTransform, `${what}: thumb transform mismatch`)
      assert.equal(a.thumbBackground, b.thumbBackground, `${what}: thumb background mismatch`)
    }
    assert.ok(nativePaintComparison.proofOn !== null && nativePaintComparison.proofOff !== null, 'Test-only shell Switch render produced no measurable control')
    assert.notEqual(nativePaintComparison.proofOn.background, nativePaintComparison.proofOff.background, 'Shell Switch on/off paint states are indistinguishable')
    samePaint(nativePaintComparison.proofOn, nativePaintComparison.onCategory, 'on-state category switch vs shell Switch')
    samePaint(nativePaintComparison.proofOff, nativePaintComparison.offCategory, 'off-state category switch vs shell Switch')
    if (nativePaintComparison.referenceChecked === 'false') samePaint(nativePaintComparison.proofOff, nativePaintComparison.reference, 'off-state Show coding view reference vs shell Switch')
    else if (nativePaintComparison.referenceChecked === 'true') samePaint(nativePaintComparison.proofOn, nativePaintComparison.reference, 'on-state Show coding view reference vs shell Switch')
    else assert.fail(`Show coding view reference switch has unexpected aria-checked state ${String(nativePaintComparison.referenceChecked)}`)
    cases.push('mounted category Switch paint matched the real shell Switch and Show coding view reference per aria-checked state')

    // WB-2: the REAL authenticated Test route is exercised end to end. One explicit UI click
    // POSTs /mobile-access/push/test; the packed default Sender delivers to the nonce-owned
    // synthetic provider; the decrypted payload must navigate the bare same-origin root with no
    // mobile-push reference, and the tap must stay resolver-free and notice-free.
    const testPostsBeforeClick = observations.pushRequests.filter(item => item.path === '/mobile-access/push/test').length
    const testResponsePromise = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/push/test'
      && response.request().method() === 'POST', { timeout: CLIENT_TIMEOUT_MS })
    await restoredSettings.getByRole('button', { name: 'Send test', exact: true }).click()
    const testResponse = await testResponsePromise
    assert.equal(testResponse.status(), 200, `Real authenticated Test route returned ${String(testResponse.status())}`)
    await restoredSettings.getByText(/Accepted by the push provider; lock-screen delivery is not confirmed\./u).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    // The shared requireCsrf mutation gate covers the Test route too: an explicitly empty token is
    // preserved by the page fetch wrapper and rejected before the mutation body is read.
    const testCsrfStatus = await phone.evaluate(async installationId => {
      const response = await fetch('/mobile-access/push/test', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-dsh-mobile-csrf': '' }, body: JSON.stringify({ installationId }) })
      return response.status
    }, installationId)
    assert.equal(testCsrfStatus, 403, `Paired Gateway did not reject the invalid-CSRF Test mutation: ${testCsrfStatus}`)
    // One installation may request one Test per minute; the explicit click consumed it, and an
    // immediate authenticated repeat must be rate limited at the real route.
    const testRateLimitStatus = await phone.evaluate(async installationId => {
      const response = await fetch('/mobile-access/push/test', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installationId }) })
      return response.status
    }, installationId)
    assert.equal(testRateLimitStatus, 429, `Immediate repeat Test POST was not rate limited: ${testRateLimitStatus}`)
    assert.equal(observations.pushRequests.filter(item => item.path === '/mobile-access/push/test').length, testPostsBeforeClick + 3,
      'Exactly the one clicked Test POST plus the two deliberate probes may reach the route (no automatic replay)')
    const testTransport = await waitForJson(evidenceFile, value => value.processId === initialChildPid
      && value.requestsAccepted >= 1 && typeof value.bodyBase64 === 'string', 'real packed Test send at the synthetic provider')
    const testPayload = await decryptCaptured(testTransport.bodyBase64, transportSeed, installedEcePath)
    assert.equal(testPayload.web_push, 8030)
    assert.equal(testPayload.notification?.title, 'Test notification')
    // The wire navigate must already be absolute — WebKit's declarative parser applies it without
    // any base URL — so parse it the same way and require the bare root of the registered origin.
    const testNavigate = new URL(testPayload.notification?.navigate)
    assert.equal(testNavigate.origin, gatewayOrigin, 'Test notification navigate must be bound to the registered HTTPS origin')
    assert.equal(testNavigate.pathname, '/', 'Test notification must navigate the bare same-origin app root')
    assert.equal(testNavigate.search, '', 'Test notification must carry no mobile-push query')
    assert.equal(testNavigate.hash, '', 'Test notification must carry no fragment')
    // Test tap: landing on the decrypted bare-root URL must stay authenticated and must involve no
    // push resolver request and no missing-conversation notice. DSH may restore the last active app
    // UI at the root; no Session/list state is forced or asserted here.
    const resolvePostsBeforeTestTap = observations.pushRequests.filter(item => item.path === '/mobile-access/push/resolve').length
    const testTap = await phone.goto(`${gatewayOrigin}/`, { waitUntil: 'domcontentloaded', timeout: CLIENT_TIMEOUT_MS })
    assert.equal(testTap?.status(), 200, 'Bare-root Test tap did not land on the authenticated Gateway page')
    await phone.waitForFunction(() => document.querySelector('.dshm-shell') !== null, undefined, { timeout: CLIENT_TIMEOUT_MS })
    await phone.waitForFunction(() => location.pathname === '/' && location.search === '', undefined, { timeout: CLIENT_TIMEOUT_MS })
    const testTapBoundary = await phone.evaluate(() => ({
      authenticatedMarker: document.querySelector('meta[name="dsh-mobile-gateway"][content="authenticated"]') !== null,
      missingConversationNoticeVisible: [...document.querySelectorAll('body *')].some(element => element.children.length === 0
        && /no longer available/u.test(element.textContent ?? '')) }))
    assert.equal(testTapBoundary.authenticatedMarker, true, 'Test tap landing was not the authenticated mobile page')
    assert.equal(testTapBoundary.missingConversationNoticeVisible, false, 'Test tap must not show a missing-conversation notice')
    assert.equal(observations.pushRequests.filter(item => item.path === '/mobile-access/push/resolve').length, resolvePostsBeforeTestTap,
      'Test tap must not trigger a push resolver request')
    const testRouteEvidence = { realRouteStatus: testResponse.status(), csrfNegativeStatus: testCsrfStatus, rateLimitStatus: testRateLimitStatus,
      providerAcceptedCount: testTransport.requestsAccepted, payloadTitle: testPayload.notification?.title, navigate: testPayload.notification?.navigate,
      tapStatus: testTap?.status() ?? null, resolverPostsDuringTap: 0, missingNotice: false }
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'test-notification-boundary', testRouteEvidence)
    cases.push('real authenticated Test route sent through the default packed Sender; decrypted payload navigates the bare root with no resolver request or missing-target notice')

    // The test-only Host plugin uses public Agent/session/UserQuestions services; its fake model is never invoked.
    const targetSessionId = `push-smoke-${randomUUID()}`
    const runFixtureCommand = async (command, sessionId, timeout) => {
      const commandId = randomBytes(12).toString('hex')
      const trigger = { nonce: fixtureNonce, command, commandId,
        ...(sessionId === undefined ? {} : { sessionId }), ...(timeout === undefined ? {} : { timeout }) }
      const temporaryControl = `${fixtureControl}.${commandId}.tmp`
      await writeFile(temporaryControl, JSON.stringify(trigger), { mode: 0o600 })
      await rename(temporaryControl, fixtureControl)
      return commandId
    }
    const runQuestion = async (sessionId = targetSessionId, timeout) => runFixtureCommand('emit-question', sessionId, timeout)
    const closeQuestion = async () => runFixtureCommand('close-question')
    // Question A must remain OPEN through the post-restart recovery tap (a settled source is not
    // resolvable), so it uses the fixture's maximum timed wait; it is never answered and aborts at teardown.
    const firstCommand = await runQuestion(targetSessionId, 600_000)
    const firstFixtureResult = await waitForJson(join(home, 'push-integration-fixture-result.json'), value => value.commandId === firstCommand
      && (value.fixtureCommandProcessed === true || value.phase === 'fixture-failed'),
      'public Host fixture to record its timed-question boundary')
    const rawQuestionRequest = firstFixtureResult.questionRequestEvidence ?? {}
    const questionRequestEvidence = { questionEntryCount: Number.isSafeInteger(rawQuestionRequest.questionEntryCount) ? rawQuestionRequest.questionEntryCount : null,
      nextCallCount: Number.isSafeInteger(rawQuestionRequest.nextCallCount) ? rawQuestionRequest.nextCallCount : null,
      agentMatchesTarget: typeof rawQuestionRequest.agentMatchesTarget === 'boolean' ? rawQuestionRequest.agentMatchesTarget : null,
      callIdMatches: typeof rawQuestionRequest.callIdMatches === 'boolean' ? rawQuestionRequest.callIdMatches : null,
      timed: typeof rawQuestionRequest.timed === 'boolean' ? rawQuestionRequest.timed : null,
      signalAborted: typeof rawQuestionRequest.signalAborted === 'boolean' ? rawQuestionRequest.signalAborted : null,
      downstreamOutcome: ['not-entered', 'pending', 'resolved', 'rejected', 'threw'].includes(rawQuestionRequest.downstreamOutcome) ? rawQuestionRequest.downstreamOutcome : 'unknown',
      downstreamErrorName: typeof rawQuestionRequest.downstreamErrorName === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(rawQuestionRequest.downstreamErrorName) ? rawQuestionRequest.downstreamErrorName : null,
      downstreamErrorCode: typeof rawQuestionRequest.downstreamErrorCode === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(rawQuestionRequest.downstreamErrorCode) ? rawQuestionRequest.downstreamErrorCode : null,
      disposerAvailable: rawQuestionRequest.disposerAvailable === true, disposed: rawQuestionRequest.disposed === true }
    const agentIdentityEvidence = { sessionMatchesTarget: firstFixtureResult.agentIdentity?.sessionMatchesTarget === true,
      sameRegisteredAgent: firstFixtureResult.agentIdentity?.sameRegisteredAgent === true,
      isRuntimeRoot: firstFixtureResult.agentIdentity?.isRuntimeRoot === true,
      hasLiveOwner: firstFixtureResult.agentIdentity?.hasLiveOwner === true }
    const askSettlementAtQuestion = await readFixtureAskSettlement(home)
    const publicQuestionEvidence = { commandProcessed: firstFixtureResult.fixtureCommandProcessed === true,
      phase: typeof firstFixtureResult.phase === 'string' ? firstFixtureResult.phase : null,
      targetSessionMatched: firstFixtureResult.targetSessionId === targetSessionId, sourceCategory: 'question',
      agentIdentity: agentIdentityEvidence, questionRequest: questionRequestEvidence,
      projection: firstFixtureResult.publicQuestionProjection ?? null, askSettlement: askSettlementAtQuestion }
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'public-question-fixture-boundary', publicQuestionEvidence)
    const publicConfigAtQuestion = await observePublicPushConfig(phone, installationId, gatewayOrigin)
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'post-question-public-config', publicConfigAtQuestion)
    const registryAtQuestion = await readOwnedNotificationSummary(root, home, { deviceId, installationId, origin: gatewayOrigin })
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'post-question-owned-notification-summary', registryAtQuestion)
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'post-question-allowlisted-host-boundary-log', { lines: safeHostLogEvidence(dsh.logs()) })
    assert.equal(firstFixtureResult.fixtureCommandProcessed, true, 'Public fixture command did not complete')
    assert.equal(firstFixtureResult.ok, true)
    assert.equal(firstFixtureResult.targetSessionId, targetSessionId)
    assert.equal(firstFixtureResult.phase, 'question-probe-recorded')
    assert.deepEqual(agentIdentityEvidence, { sessionMatchesTarget: true, sameRegisteredAgent: true, isRuntimeRoot: true, hasLiveOwner: false },
      'Fixture Agent must be the exact public runtime root before askTimed')
    assert.equal(questionRequestEvidence.questionEntryCount, 1, 'Public timed ask did not enter request waterfall exactly once')
    assert.equal(questionRequestEvidence.nextCallCount, 1, 'Public pass-through probe must call next exactly once')
    assert.equal(questionRequestEvidence.agentMatchesTarget, true)
    assert.equal(questionRequestEvidence.callIdMatches, true)
    assert.equal(questionRequestEvidence.timed, true)
    assert.equal(questionRequestEvidence.signalAborted, false)
    assert.equal(questionRequestEvidence.disposerAvailable, true)
    assert.equal(questionRequestEvidence.disposed, true, 'Public request probe disposer was not invoked')
    assert.equal(firstFixtureResult.publicQuestionProjection?.projectionAvailable, true, 'Public userQuestions projection was unavailable')
    assert.equal(firstFixtureResult.publicQuestionProjection?.matchingCallActive, true, 'Public question projection did not show the fixture call as active')
    assert(['open', 'continued'].includes(firstFixtureResult.publicQuestionProjection?.matchingCallState), 'Unexpected public question projection state')
    assert.equal(firstFixtureResult.publicQuestionProjection?.leaseDisposed, true, 'Public projection read lease was not disposed')
    let firstTransport
    try {
      firstTransport = await waitForJson(evidenceFile, value => value.requestsAccepted >= 2 && typeof value.bodyBase64 === 'string',
        'real packed Delivery→Sender synthetic provider response (Test send plus question A)')
    } catch (error) {
      const [publicConfigAfterWait, notificationAfterWait, transportAfterWait, askSettlementAfterWait] = await Promise.all([
        observePublicPushConfig(phone, installationId, gatewayOrigin).catch(() => ({ httpStatus: null, sameOrigin: false, installationIdMatches: false,
          available: null, status: 'unavailable', publicKeyPresent: false, preferences: {} })),
        readOwnedNotificationSummary(root, home, { deviceId, installationId, origin: gatewayOrigin }).catch(error => ({ filePresent: false,
          withinOwnedRoot: null, withinByteLimit: null, readErrorCode: error?.code === 'ENOENT' ? 'ENOENT' : 'READ_ERROR' })),
        readTransportEvidence(evidenceFile).catch(() => undefined),
        readFixtureAskSettlement(home).catch(() => ({ present: false, readErrorCode: 'READ_ERROR' })),
      ])
      pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'delivery-boundary-timeout', {
        publicFixture: publicQuestionEvidence, publicConfig: publicConfigAfterWait, notificationState: notificationAfterWait,
        askSettlement: askSettlementAfterWait, senderTransport: projectTransportEvidence(transportAfterWait),
        allowlistedHostLogEvidence: safeHostLogEvidence(dsh.logs()),
      })
      throw error
    }
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'delivery-boundary-receipt', {
      publicFixture: publicQuestionEvidence, publicConfig: publicConfigAtQuestion, notificationState: registryAtQuestion,
      askSettlement: askSettlementAtQuestion, senderTransport: projectTransportEvidence(firstTransport),
    })
    const payload = await decryptCaptured(firstTransport.bodyBase64, transportSeed, installedEcePath)
    assert.equal(payload.web_push, 8030)
    assert.equal(typeof payload.notification?.navigate, 'string')
    // Ordinary alerts keep the opaque-ref resolver behavior; the wire value itself must already be
    // absolute (no base URL here) and same-origin with the Gateway that enrolled the registration.
    const firstUrl = new URL(payload.notification.navigate)
    assert.equal(firstUrl.origin, gatewayOrigin)
    assert.equal(firstUrl.pathname, '/')
    const reference = firstUrl.searchParams.get('mobile-push')
    assert.equal(firstUrl.searchParams.size, 1)
    assert.match(reference ?? '', /^[A-Za-z0-9_-]{1,256}$/u)
    // Durable registry receipt: settlement follows the synthetic provider 201, so poll the OWNED
    // notification state (fresh post-settlement read) instead of inferring from transport counters.
    const settledRegistry = await traced('await-durable-push-receipt', () => waitForOwnedRegistryState(root, home,
      { deviceId, installationId, origin: gatewayOrigin }, value => value.matchingReceiptCount >= 1))
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'post-settlement-owned-notification-summary', settledRegistry)
    cases.push('real packed default Sender delivery settled into a durable owned registry receipt (fresh post-settlement state read)')
    const expiredCookieState = await loseShortSessionCookie(phoneContext, gatewayOrigin, deviceId)
    const loginPagePromise = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/login'
      && response.request().method() === 'GET', { timeout: CLIENT_TIMEOUT_MS })
    const renewalPromise = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/auth/renew'
      && response.request().method() === 'POST', { timeout: CLIENT_TIMEOUT_MS })
    const resolvePromise = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/push/resolve'
      && response.request().method() === 'POST', { timeout: CLIENT_TIMEOUT_MS })
    const expiredLoginWorkspaceStream = observeWorkspaceStream(phone)
    await phone.goto(`${gatewayOrigin}/?mobile-push=${encodeURIComponent(reference)}`, { waitUntil: 'domcontentloaded', timeout: CLIENT_TIMEOUT_MS })
    // Bounded failure boundary: identify WHICH leg of the expired-login return flow stalls before failing.
    const expiredLoginSettled = await Promise.allSettled([loginPagePromise, renewalPromise, resolvePromise])
    if (expiredLoginSettled.some(entry => entry.status !== 'fulfilled')) {
      const pageBoundary = await phone.evaluate(() => ({
        href: location.href.slice(0, 120), pathname: location.pathname, search: location.search.slice(0, 80),
        loginProgressHidden: document.getElementById('login-progress')?.hidden ?? null,
        loginFailedHidden: document.getElementById('login-failed')?.hidden ?? null,
        shellPresent: document.querySelector('.dshm-shell') !== null,
        conversationRows: document.querySelectorAll('[data-conversation-session]').length,
        sidebarNodes: document.querySelectorAll('.dshm-sidebar, [class*="sidebar" i]').length,
      })).catch(error => ({ evaluateError: error?.name ?? 'Error' }))
      const lateRecheck = await settleBefore(new Promise(resolve => setTimeout(() => resolve({
        search: phone.url().includes('?') ? new URL(phone.url()).search.slice(0, 80) : '',
      }), 5_000)), 7_000).then(entry => entry.completed ? entry.value : { probeTimeout: true }).catch(() => ({ probeError: true }))
      pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'expired-login-boundary', {
        outcomes: expiredLoginSettled.map(entry => entry.status),
        loginResponseStatus: expiredLoginSettled[0]?.status === 'fulfilled' ? expiredLoginSettled[0].value.status() : null,
        renewResponseStatus: expiredLoginSettled[1]?.status === 'fulfilled' ? expiredLoginSettled[1].value.status() : null,
        page: { ...pageBoundary, lateRecheck },
        resolveRequestSeen: observations.pushRequests.some(item => item.path === '/mobile-access/push/resolve'),
        recentPushRequests: observations.pushRequests.slice(-12), recentPushResponses: observations.pushResponses.slice(-12),
        recentConsole: observations.consoleCategories.slice(-12), consoleTexts: observations.consoleTexts.slice(-8),
        cspViolations: observations.cspViolations.slice(-8), pageErrors: observations.pageErrors.slice(-8),
        workspaceStream: { ...expiredLoginWorkspaceStream.state, baselineSettled: (await settleBefore(expiredLoginWorkspaceStream.baseline.then(() => true), 3_000)).completed },
        cookieState: expiredCookieState,
      })
      for (const entry of expiredLoginSettled) if (entry.status === 'rejected') throw entry.reason
    }
    const [loginPage, renewalResponse, resolveResponse] = expiredLoginSettled.map(entry => {
      if (entry.status !== 'fulfilled') throw new Error('expired-login return flow leg did not settle')
      return entry.value
    })
    assert.equal(loginPage.status(), 200)
    assert.equal(renewalResponse.status(), 200, 'Persistent paired credential did not renew the lost short Session')
    assert.equal(resolveResponse.status(), 200, 'Expired-login return did not reach the authenticated actual resolver')
    const renewedTarget = await resolveResponse.json()
    assert.equal(renewedTarget.sessionId, targetSessionId)
    assert(['current', 'resolved'].includes(renewedTarget.interaction))
    await phone.waitForFunction(id => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === id,
      targetSessionId, { timeout: CLIENT_TIMEOUT_MS })
    await phone.waitForFunction(() => location.pathname === '/' && location.search === '', undefined, { timeout: CLIENT_TIMEOUT_MS })
    const firstTargetResult = { status: resolveResponse.status(), sessionIdMatched: renewedTarget.sessionId === targetSessionId,
      interaction: renewedTarget.interaction }
    const expiredSession = { simulation: 'short-session-cookie-loss; no server-TTL expiry claimed', ...expiredCookieState,
      loginStatus: loginPage.status(), renewalStatus: renewalResponse.status(), targetOpened: firstTargetResult.sessionIdMatched }
    cases.push('paired short-session cookie loss retained persistent consent and renewed through login before actual resolver/session readiness')

    // O2 measurement: capture the actual warm-tap surface geometry before interacting, so a hidden
    // composer is diagnosed from page state instead of assumed.
    const warmTapBoundary = await phone.evaluate(() => {
      const visible = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el)
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
      const sessions = [...document.querySelectorAll('[data-conversation-session]')].map(el => ({
        session: el.getAttribute('data-conversation-session'), visible: visible(el),
        rect: { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } }))
      const composers = [...document.querySelectorAll('[data-composer-input]')].map(el => ({
        visible: visible(el),
        rect: { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) },
        phase: el.getAttribute('data-phase'),
        inSession: el.closest('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? null }))
      const drawer = document.querySelector('.dshm-drawer')
      const visibleEl = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el)
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' }
      return { pathname: location.pathname, search: location.search, sessions, composers,
        questionCards: [...document.querySelectorAll('[data-question-key]')].map(el => ({
          visible: visibleEl(el), rect: { w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) },
          text: (el.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 60) })),
        composerAncestorDisplay: (() => { const el = document.querySelector('[data-composer-input]')
          const chain = []; let node = el; for (let i = 0; node && i < 4; i++) { const s = getComputedStyle(node); chain.push(`${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]}:${s.display}/${s.visibility}`); node = node.parentElement } return chain })(),
        drawerOpen: drawer?.getAttribute('data-open') ?? null,
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map(dialog => dialog.getAttribute('aria-label')).slice(0, 4),
        shellPresent: document.querySelector('.dshm-shell') !== null, viewport: { w: innerWidth, h: innerHeight } }
    }).catch(error => ({ evaluateError: error?.name ?? 'Error' }))
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'warm-tap-pre-draft-boundary', warmTapBoundary)
    // Clean composer-session design (human-approved amendment 2026-10-26): drafts live in ORDINARY
    // EMPTY Sessions created through real public Workspace/Session UI actions (the proven
    // custom-assets flow), independent of any question. Question A remains the genuine packed-Sender
    // source and the still-eligible tap target; no B question, no optimistic answer dismissal.
    const drawer = phone.locator('.dshm-drawer')
    const createOrdinaryDraftSession = async label => {
      if (await drawer.getAttribute('data-open') !== 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
      const createdSessionResponse = phone.waitForResponse(response => new URL(response.url()).pathname === '/api/session/create'
        && response.request().postDataJSON()?.payload?.args?.request?.workspaceId === workspaceId, { timeout: CLIENT_TIMEOUT_MS })
      await drawer.locator(`[role="treeitem"][data-row-key="workspace:${workspaceId}"]`).getByRole('button').last().click()
      const createdSession = await (await createdSessionResponse).json()
      assert.equal(createdSession.result?.ok, true, `Owned ${label} Session creation through the real Workspace action failed`)
      const sessionId = createdSession.result.value.sessionId
      await phone.waitForFunction(id => document.querySelector('[data-conversation-session]')?.dataset.conversationSession === id,
        sessionId, { timeout: CLIENT_TIMEOUT_MS })
      if (await drawer.getAttribute('data-open') === 'true') await drawer.locator('button[data-dsh-mobile-toggle]').click()
      const editor = phone.locator('[data-conversation-session] [data-composer-input][contenteditable="true"]').first()
      await editor.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
      pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', `clean-${label}-session-created`, {
        sessionId, workspaceId, composerVisible: true })
      return { sessionId, editor }
    }
    const draftSession = await createOrdinaryDraftSession('draft')
    const draftSessionId = draftSession.sessionId
    const draftEditor = draftSession.editor

    // Eligibility control before each tap (controller scope check): the still-open first question
    // must be publicly active, so the tap target is a genuinely eligible reference every time.
    const assertFirstQuestionEligible = async label => {
      const command = await runFixtureCommand('observe-question', targetSessionId)
      const observed = await waitForJson(join(home, 'push-integration-fixture-result.json'),
        value => value.commandId === command && (value.ok === true || value.phase === 'fixture-failed'),
        `public eligibility control (${label}) for the first question`, 15_000)
      const evidence = observed.evidence ?? {}
      pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', `first-question-eligibility-${label}`, evidence)
      assert.equal(evidence.observeErrorCode ?? null, null, `First question public observation failed before the ${label} tap`)
      assert.equal(evidence.projectionAvailable, true, `First question projection unavailable before the ${label} tap`)
      assert(Array.isArray(evidence.activeStates) && evidence.activeStates.some(row => row.state === 'open' || row.state === 'continued'),
        `First question call not publicly active before the ${label} tap`)
    }

    // Measurement 1 — PURE UNSENT DRAFT (spec §6/§10: measured, never guaranteed retained): fill B's
    // editor, assert nothing was submitted, tap the STILL-ELIGIBLE question-A reference, then return
    // to ordinary B by real history navigation and measure the actual editor/document state there.
    const unsentDraft = 'Task 8 warm push tap draft; intentionally not submitted'
    await draftEditor.fill(unsentDraft)
    const promptsBeforeWarmTap = promptAttempts
    assert.equal(promptsBeforeWarmTap, 0, 'Filling an unsent draft must not submit anything')
    const beforeWarmTap = await phone.evaluate(() => ({ documentId: window.__dshPushSmokeDocumentId,
      sessionId: document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session'),
      draft: document.querySelector('[data-conversation-session] [data-composer-input][contenteditable="true"]')?.textContent }))
    assert.equal(beforeWarmTap.sessionId, draftSessionId)
    assert.equal(beforeWarmTap.draft, unsentDraft)
    await assertFirstQuestionEligible('warm')
    const warmTapResult = await openTargetFromPush(phone, gatewayOrigin, reference, targetSessionId)
    observations.resolvedTarget = warmTapResult
    const afterWarmTap = await phone.evaluate(() => ({ documentId: window.__dshPushSmokeDocumentId,
      sessionId: document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session'),
      draft: document.querySelector('[data-conversation-session] [data-composer-input][contenteditable="true"]')?.textContent,
      query: location.search }))
    assert.equal(promptAttempts, promptsBeforeWarmTap, 'The pure unsent-draft warm tap must not submit any prompt')
    // History return attempt (recorded effect): the push tap replaced the SPA conversation state,
    // and history back re-boots the app at the LAST-ACTIVE session (measured landing recorded; the
    // drawer tree does not reliably list newly created sessions in this composition — boundary
    // drawer-session-row-boundary in run e3f10abf documents the rendered rows).
    await phone.goBack({ timeout: CLIENT_TIMEOUT_MS }).catch(() => {})
    const returnSettled = await settleBefore(phone.waitForFunction(id =>
      document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === id,
      draftSessionId, { timeout: 15_000, polling: 250 }), 17_000)
    // Observe the ACTUAL mounted session after the return, regardless of the wait's outcome; every
    // label below is derived from this observed identity plus the wait's honest settlement status.
    const returnObservation = await phone.evaluate(() => ({ documentId: window.__dshPushSmokeDocumentId,
      sessionId: document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session'),
      draft: document.querySelector('[data-conversation-session] [data-composer-input][contenteditable="true"]')?.textContent,
      composerVisible: (() => { const el = document.querySelector('[data-composer-input]'); if (!el) return false
        const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 })() })).catch(() => ({}))
    const returnLabels = historyReturnLabels({ waitStatus: returnSettled.status,
      observedSessionId: returnObservation.sessionId ?? null, draftSessionId,
      observedDraft: returnObservation.draft, unsentDraft })
    // Draft measurement semantics (reviewer F2): before = B observed before the tap; after =
    // visibility in the CURRENT document after the tap; persistence is claimed ONLY when the draft
    // session itself was observed after the return, otherwise explicitly cannot-verify.
    const warmTap = { documentChanged: beforeWarmTap.documentId !== afterWarmTap.documentId,
      draftBeforeInDraftSession: beforeWarmTap.draft, draftVisibilityInDocumentAfterTap: afterWarmTap.draft ?? null,
      returnObservedSession: returnObservation.sessionId ?? null, returnComposerVisible: returnObservation.composerVisible === true,
      ...returnLabels,
      targetOpened: afterWarmTap.sessionId === targetSessionId, queryCleared: afterWarmTap.query === '' }
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'warm-tap-measured-effects', warmTap)
    assert.equal(warmTapResult.sessionIdMatched, true, 'Warm tap actual resolver did not reopen the owned Session')
    assert.equal(warmTap.documentChanged, true, 'Warm tap did not perform a real document navigation')
    assert.equal(warmTap.targetOpened, true)
    assert.equal(warmTap.queryCleared, true)
    cases.push('pure unsent-draft warm tap on an ordinary empty Session measured actual document/draft/return effects without a retention claim')

    // Measurement 2 — HELD IN-FLIGHT SEND (separate observation): a genuine public state
    // precondition requires a fresh composer (the history return re-boots at the last-active
    // session, measured above), so a SECOND ordinary empty Session is created through the same
    // real Workspace action. A real composer Send is intercepted at the browser boundary — never
    // forwarded to Host/model — while the still-eligible question-A reference navigation completes.
    const heldSession = await createOrdinaryDraftSession('held-send')
    // A modal presentation mask (dialog root/mask) can intercept composer interactions on the fresh
    // page; dismiss only a RECOGNIZED onboarding modal through the existing guarded helper.
    await dismissOnboarding(phone)
    const heldEditor = heldSession.editor
    const heldText = 'Task 8 held in-flight send; never forward to Host'
    await heldEditor.fill(heldText)
    const holdReached = deferred(), releaseHold = deferred(), handlerDone = deferred()
    promptHoldReached = holdReached
    promptHoldPromise = releaseHold.promise
    promptHoldRelease = releaseHold
    promptHoldHandlerDone = handlerDone
    await phone.getByRole('button', { name: /Send/u }).click()
    const heldRequest = await within(holdReached.promise, CLIENT_TIMEOUT_MS, () => 'Send did not reach the owned browser-side hold')
    assert.equal(heldRequest.method, 'POST')
    assert.equal(heldRequest.held, true)
    await assertFirstQuestionEligible('held-send')
    const heldTapResult = await openTargetFromPush(phone, gatewayOrigin, reference, targetSessionId)
    releaseHold.resolve()
    const heldSettlement = await handlerDone.promise
    const afterHeldTap = await phone.evaluate(() => ({ documentId: window.__dshPushSmokeDocumentId,
      sessionId: document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session'),
      draft: document.querySelector('[data-conversation-session] [data-composer-input][contenteditable="true"]')?.textContent }))
    const heldSend = { requestIntercepted: promptAttempts === 1, forwardedToHost: false, settlement: heldSettlement,
      documentChanged: beforeWarmTap.documentId !== afterHeldTap.documentId, targetOpened: afterHeldTap.sessionId === targetSessionId,
      draftAfterHeldNavigation: afterHeldTap.draft ?? null }
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'held-send-measured-effects', heldSend)
    assert.equal(promptAttempts, 1, 'Exactly one real composer Send request must reach the owned browser hold')
    assert.equal(heldTapResult.sessionIdMatched, true, 'Held-send actual resolver did not reopen the owned Session')
    assert.equal(heldSend.documentChanged, true, 'Held-send tap did not perform real cross-document navigation')
    assert.equal(heldSend.targetOpened, true)
    assert(['aborted-before-forward', 'fulfilled-after-navigation'].includes(heldSettlement), 'Held send settled outside the owned browser interception')
    cases.push('one real held composer POST stayed behind the browser boundary while the actual target navigation completed')

    const configBeforeRestart = await readPushConfig(phone, installationId)
    assert.equal(configBeforeRestart.status, 'enabled')
    assert.equal(configBeforeRestart.available, true)
    const firstAcceptedBeforeRestart = (await readTransportEvidence(evidenceFile))?.requestsAccepted ?? 0
    await unlink(fixtureControl).catch(error => { if (error.code !== 'ENOENT') throw error })
    await phone.close()
    await desktopContext.close()
    const firstChildStop = await dsh.close()
    assert.equal(firstChildStop.forced, false, 'The owned first DSH child did not drain gracefully')
    dsh = undefined
    const packedBytesAfterStop = createHash('sha256').update(await readFile(tarball)).digest('hex')
    assert.equal(packedBytesAfterStop, tarballSha256, 'The packed candidate changed across owned DSH restart')
    dsh = launchDsh(root, home, binary, { nonce: transportNonce, transportEvidence: evidenceFileRestart,
      guardEvidence: guardEvidenceFileRestart, preflightEvidence: preflightEvidenceFileRestart, fixtureNonce, fixtureControl })
    // One owned-run nonce spans both sequential children because the persisted subscription endpoint
    // must remain helper-owned across the restart (controller ruling 2026-10-26); each child still
    // gets its OWN raw evidence files, PID match and a fresh preflight baseline. No re-enrollment.
    const restartedBaseline = await traced('await-restarted-guard-chain-startup', async () => {
      const transport = await waitForJson(evidenceFileRestart, value => value.processId === dsh.pid
        && value.requestsAccepted === 0 && value.dnsOwned === 1 && value.appleRequestsBlocked === 2,
        'restarted transport preflight baseline', 10_000)
      const guard = await waitForJson(guardEvidenceFileRestart, value => value.processId === dsh.pid
        && Array.isArray(value.blocked) && value.blocked.length === 0
        && value.facadeSyncEffective === true && value.cjsPatchVisible === true,
        'restarted network-guard startup evidence', 10_000)
      const preflight = await waitForJson(preflightEvidenceFileRestart, value => value.processId === dsh.pid
        && value.attested === true && value.bindingIdentity?.namedBindingIsCjsProperty === true,
        'restarted pre-main preflight attestation', 10_000)
      return { transport, guard, preflight }
    })
    assert.equal(restartedBaseline.transport.processId, dsh.pid, 'Restarted transport evidence PID did not match the actual DSH child')
    assert.equal(restartedBaseline.guard.processId, dsh.pid, 'Restarted network-guard evidence PID did not match the actual DSH child')
    assert.equal(restartedBaseline.preflight.processId, dsh.pid, 'Restarted preflight evidence PID did not match the actual DSH child')
    restartedChildPid = dsh.pid
    guardChainReceipts.push({ child: 'restart', pid: dsh.pid, preflightAttested: true,
      guardBlockedCount: 0, guardBlockedSamplingPoint: 'startup-window',
      baseline: { dnsOwned: restartedBaseline.transport.dnsOwned,
        requestsAccepted: restartedBaseline.transport.requestsAccepted,
        appleRequestsBlocked: restartedBaseline.transport.appleRequestsBlocked } })
    desktopContext = await browser.newContext({ locale: 'en-US' })
    await traced('arm-release-check-abort-restarted-desktop', () => armReleaseCheckAbort(desktopContext, 'restarted-desktop', releaseCheckAllowedOrigins))
    desktop = await desktopContext.newPage()
    const restartedDesktopUrl = await dsh.ready()
    releaseCheckAllowedOrigins.add(new URL(restartedDesktopUrl).origin)
    const restartedFixtureReady = await waitForJson(join(home, 'push-integration-fixture-result.json'), value => value.phase === 'fixture-ready' && value.ok === true,
      'public Host fixture readiness after DSH restart', 15_000)
    publicSessionObservationRestarted = assertPublicObserveSessionNegative(restartedFixtureReady.publicSessionObservation, 'same-profile DSH restart')
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'probe', 'public-observeSession-after-restart', publicSessionObservationRestarted)
    cases.push('public observeSession never-created-ID negative lookup repeated without Session/Agent mutation on the same-profile restart')
    await desktop.goto(restartedDesktopUrl, { waitUntil: 'domcontentloaded' })
    phone = await phoneContext.newPage()
    attachPhoneObservers(phone)
    const restartWorkspaceStream = observeWorkspaceStream(phone)
    // Server-side session absence: DSH Mobile's auth sessions live in runtime memory only
    // (src/access.ts keeps sessions in a private Map and persists only devices), so the restart
    // genuinely lost the phone's session while its short-session cookie was retained. The FIRST
    // phone navigation is question A's push URL with the renewal held, proving the pre-auth gate.
    const retainedCookies = await phoneContext.cookies([gatewayOrigin, `${gatewayOrigin}/mobile-access/auth/renew`])
    const retainedShortSession = retainedCookies.filter(cookie => cookie.httpOnly && cookie.path === '/' && cookie.value !== deviceId)
    assert(retainedShortSession.length >= 1, 'Phone lost its short-session cookie across the owned restart')
    const renewHoldReached = deferred(), releaseRenewHold = deferred()
    await phone.route('**/mobile-access/auth/renew', async route => { renewHoldReached.resolve(); await releaseRenewHold.promise; await route.continue() })
    const sessionAbsenceLogin = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/login'
      && response.request().method() === 'GET', { timeout: CLIENT_TIMEOUT_MS })
    const sessionAbsenceRenew = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/auth/renew'
      && response.request().method() === 'POST', { timeout: CLIENT_TIMEOUT_MS })
    // The page-driven resolver (status 200) is awaited separately from the stale-cookie probe below (401).
    const sessionAbsenceResolve = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/push/resolve'
      && response.request().method() === 'POST' && response.status() === 200, { timeout: CLIENT_TIMEOUT_MS })
    await phone.goto(`${gatewayOrigin}/?mobile-push=${encodeURIComponent(reference)}`, { waitUntil: 'domcontentloaded', timeout: CLIENT_TIMEOUT_MS })
    await within(renewHoldReached.promise, CLIENT_TIMEOUT_MS, () => 'Renewal was not requested for the server-unknown session')
    // While renewal is held the retained cookie must be server-rejected: a protected probe 401s
    // (authentication_failed) and no workspace/conversation content has rendered.
    const staleProbe = await phone.evaluate(async reference => {
      const response = await fetch('/mobile-access/push/resolve', { method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference }), signal: AbortSignal.timeout(5_000) })
      return { status: response.status }
    }, reference)
    assert.equal(staleProbe.status, 401, `Protected push route did not reject the server-unknown session cookie: ${String(staleProbe.status)}`)
    const preAuthPage = await phone.evaluate(() => ({ shell: document.querySelector('.dshm-shell') !== null,
      conversations: document.querySelectorAll('[data-conversation-session]').length }))
    assert.equal(preAuthPage.shell, false, 'Workspace content rendered before authentication')
    assert.equal(preAuthPage.conversations, 0, 'Conversation content rendered before authentication')
    releaseRenewHold.resolve()
    const [sessionAbsenceLoginPage, sessionAbsenceRenewal, sessionAbsenceResolved] = await Promise.all([sessionAbsenceLogin, sessionAbsenceRenew, sessionAbsenceResolve])
    // Unroute only after the held handler's continue() has completed (unroute auto-continues pending routes).
    await phone.unroute('**/mobile-access/auth/renew')
    assert.equal(sessionAbsenceLoginPage.status(), 200)
    assert.equal(sessionAbsenceRenewal.status(), 200, 'Persistent pairing did not renew the server-unknown session')
    assert.equal(sessionAbsenceResolved.status(), 200, 'Tap reference was not resolvable after renewal')
    const sessionAbsenceTarget = await sessionAbsenceResolved.json()
    assert.equal(sessionAbsenceTarget.sessionId, targetSessionId, 'Renewed resolver returned a different target')
    await phone.waitForFunction(() => document.querySelector('.dshm-shell') !== null, undefined, { timeout: CLIENT_TIMEOUT_MS })
    // The plugin owns the resolver contract (correct target, authenticated, consent intact). Whether the
    // upstream app's session-open then mounts the target on a FRESH-boot renewed login is app behavior:
    // observed here landing on the last-active session ("session reference is released") — recorded, not asserted.
    const sessionAbsenceLanding = await phone.evaluate(() => ({
      href: location.href.slice(0, 160), search: location.search.slice(0, 80),
      sessionId: document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? null,
    }))
    assert.notEqual(sessionAbsenceLanding.sessionId, null, 'Renewed fresh boot mounted no conversation at all')
    const configAfterSessionAbsence = await readPushConfig(phone, installationId)
    assert.equal(configAfterSessionAbsence.status, 'enabled', 'Server-side session absence revoked persistent push consent')
    const serverSideSessionAbsence = { retainedShortSessionCookies: retainedShortSession.length, staleProbe, preAuthPage,
      loginStatus: sessionAbsenceLoginPage.status(), renewalStatus: sessionAbsenceRenewal.status(),
      resolveStatus: sessionAbsenceResolved.status(), targetSessionId: sessionAbsenceTarget.sessionId,
      landing: sessionAbsenceLanding, freshBootSessionOpenBoundary: 'resolver returned the intended target; the upstream app may land on the last-active session on a fresh-boot renewed login (session-open reference released)',
      consentStillEnabled: configAfterSessionAbsence.status === 'enabled' }
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'server-side-session-absence', serverSideSessionAbsence)
    cases.push('server-side session absence (runtime-memory auth sessions lost at restart) enforced authentication before content, renewed through pairing, resolved the intended target and kept push consent enabled')
    const restartedRoot = await phone.goto(`${gatewayOrigin}/`, { waitUntil: 'domcontentloaded', timeout: CLIENT_TIMEOUT_MS })
    assert.equal(restartedRoot?.status(), 200, 'Persisted Gateway origin did not survive DSH restart')
    assert.equal(new URL(phone.url()).origin, gatewayOrigin)
    await phone.waitForFunction(() => document.querySelector('.dshm-shell') !== null, undefined, { timeout: CLIENT_TIMEOUT_MS })
    const restartedWorkspace = await within(restartWorkspaceStream.baseline, CLIENT_TIMEOUT_MS,
      () => `Workspace public baseline was not ready after DSH restart: ${JSON.stringify(restartWorkspaceStream.state)}`)
    assert(restartedWorkspace.value.items.some(item => item.workspaceId === workspaceId), 'Restarted Workspace readiness omitted the owned Workspace')
    assert.equal(restartedWorkspace.socket.isClosed(), false)
    const configAfterRestart = await readPushConfig(phone, installationId)
    assert.equal(configAfterRestart.status, configBeforeRestart.status)
    assert.equal(configAfterRestart.available, configBeforeRestart.available)
    assert.equal(configAfterRestart.publicKey, configBeforeRestart.publicKey)
    assert.equal(configAfterRestart.keyFingerprint, configBeforeRestart.keyFingerprint)
    assert.equal(configAfterRestart.ownerGeneration, configBeforeRestart.ownerGeneration)
    assert.equal(configAfterRestart.registrationGeneration, configBeforeRestart.registrationGeneration)
    assert.deepEqual(configAfterRestart.preferences, configBeforeRestart.preferences)
    const noHistoryFanout = await readTransportEvidence(evidenceFileRestart)
    assert.equal(noHistoryFanout?.processId, dsh.pid)
    assert.equal(noHistoryFanout?.requestsAccepted, restartedBaseline.transport.requestsAccepted, 'Persisted source history must not fan out on restart')
    assert.equal(noHistoryFanout?.appleRequestsBlocked, restartedBaseline.transport.appleRequestsBlocked)
    assert.equal(firstAcceptedBeforeRestart, 2, 'Expected exactly the two genuine pre-restart synthetic provider sends (Test notification plus question A)')
    // Recovery boundary: record the persisted reference row and the public cold projection state of
    // the first question around the post-restart recovery tap, so a denial is diagnosed exactly.
    const observeFirstCommand = await runFixtureCommand('observe-question', targetSessionId)
    const observeFirst = await waitForJson(join(home, 'push-integration-fixture-result.json'),
      value => value.commandId === observeFirstCommand && (value.ok === true || value.phase === 'fixture-failed'),
      'post-restart public cold projection observation of the first question', 15_000)
    const observeDraftCommand = await runFixtureCommand('observe-question', draftSessionId)
    const observeDraft = await waitForJson(join(home, 'push-integration-fixture-result.json'),
      value => value.commandId === observeDraftCommand && (value.ok === true || value.phase === 'fixture-failed'),
      'post-restart public cold projection observation of the answered draft-session question', 15_000)
    const registryAtRecovery = await readOwnedNotificationSummary(root, home, { deviceId, installationId, origin: gatewayOrigin })
    // Bounded read-only look at the persisted session log layout for the first fixture session
    // (event TYPES only) to pinpoint the cold-rehydration grammar violation.
    const persistedLogProbe = await (async () => {
      const candidates = []
      const search = async (directory, depth) => {
        if (depth > 4 || candidates.length >= 8) return
        let entries
        try { entries = await readdir(directory) } catch { return }
        for (const name of entries) {
          const full = join(directory, name)
          let info
          try { info = await lstat(full) } catch { continue }
          if (info.isDirectory()) await search(full, depth + 1)
          else if (name.includes(targetSessionId) && info.isFile() && !info.isSymbolicLink()) candidates.push(full)
        }
      }
      await search(home, 0)
      if (candidates.length === 0) return { fileFound: false, matches: [] }
      const log = candidates.find(candidate => candidate.endsWith('.jsonl')) ?? candidates[0]
      if (log.endsWith('.json')) {
        try {
          const parsed = JSON.parse(await readFile(log, 'utf8'))
          const dig = (value, depth) => {
            if (depth > 3 || value === null || typeof value !== 'object') return null
            if (Array.isArray(value) && value.length > 0 && value.every(item => item !== null && typeof item === 'object' && typeof item.type === 'string')) return value
            for (const child of Array.isArray(value) ? value : Object.values(value)) {
              const found = dig(child, depth + 1)
              if (found !== null) return found
            }
            return null
          }
          const eventArray = dig(parsed, 0)
          return { fileFound: true, path: relative(root, log), kind: 'json-blob',
            topKeys: Object.keys(parsed).slice(0, 12),
            eventTypes: eventArray ? eventArray.map(event => String(event.type).slice(0, 48)).slice(0, 40) : null }
        } catch (error) {
          return { fileFound: true, path: relative(root, log), kind: 'json-blob', parseError: error?.name ?? 'Error' }
        }
      }
      const lines = (await readFile(log, 'utf8')).split(/\r?\n/u).filter(line => line !== '').slice(0, 40)
      return { fileFound: true, path: relative(root, log), kind: 'jsonl', matches: candidates.map(candidate => relative(root, candidate)),
        eventCount: lines.length,
        eventTypes: lines.map(line => { try { return JSON.parse(line)?.type ?? null } catch { return '<unparseable>' } }) }
    })()
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'recovery-boundary', {
      coldProjectionFirstQuestion: observeFirst.evidence ?? null,
      coldProjectionAnsweredDraftQuestion: observeDraft.evidence ?? null,
      persistedLogProbe,
      referenceRows: { matchingReferenceCount: registryAtRecovery.matchingReferenceCount ?? null,
        referenceCount: registryAtRecovery.referenceCount ?? null, receiptCount: registryAtRecovery.receiptCount ?? null },
    })
    // Cold-grammar proof (controller scope check): after the append-order fix, the persisted first
    // fixture session MUST cold-observe cleanly with its question call publicly active.
    assert.notEqual(observeFirst.evidence?.observeErrorCode ?? 'missing', 'SESSION_QUERY_CORRUPT_SESSION',
      'Persisted first fixture session still fails cold rehydration after the grammar fix')
    assert.equal(observeFirst.evidence?.observeErrorCode ?? null, null, 'Cold observation of the first fixture session failed')
    assert.equal(observeFirst.evidence?.projectionAvailable, true, 'Cold projection unavailable for the first fixture session')
    assert(Array.isArray(observeFirst.evidence?.activeStates)
      && observeFirst.evidence.activeStates.some(row => row.state === 'open' || row.state === 'continued'),
      'First question call not publicly active in the cold projection after restart')
    // Recovery tap with an instrumented UI boundary: the resolve leg is asserted exactly, and the
    // conversation-open leg records the page state if it stalls.
    const recoveryResolvePromise = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/push/resolve'
      && response.request().method() === 'POST', { timeout: CLIENT_TIMEOUT_MS })
    await phone.goto(`${gatewayOrigin}/?mobile-push=${encodeURIComponent(reference)}`, { waitUntil: 'domcontentloaded', timeout: CLIENT_TIMEOUT_MS })
    const recoveryResolve = await recoveryResolvePromise
    assert.equal(recoveryResolve.status(), 200, 'Stored registry reference was not resolvable after restart')
    const recoveryTarget = await recoveryResolve.json()
    assert.equal(recoveryTarget.sessionId, targetSessionId, 'Recovered reference targeted a different Session')
    const recoveryUiSettled = await settleBefore(phone.waitForFunction(id =>
      document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === id,
      targetSessionId, { timeout: 20_000, polling: 250 }), 22_000)
    if (!recoveryUiSettled.completed) {
      const recoveryPageBoundary = await phone.evaluate(() => ({
        pathname: location.pathname, search: location.search.slice(0, 80),
        sessionId: document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? null,
        shellPresent: document.querySelector('.dshm-shell') !== null,
        questionCards: [...document.querySelectorAll('[data-question-key]')].map(card => (card.textContent ?? '').replace(/\s+/gu, ' ').trim().slice(0, 50)),
        conversationRows: document.querySelectorAll('[data-conversation-session]').length,
      })).catch(error => ({ evaluateError: error?.name ?? 'Error' }))
      pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'recovery-tap-ui-boundary', recoveryPageBoundary)
      throw new Error(`Recovered reference did not open its Session conversation on the restarted page: ${JSON.stringify(recoveryPageBoundary)}`)
    }
    await phone.waitForFunction(() => location.pathname === '/' && location.search === '', undefined, { timeout: CLIENT_TIMEOUT_MS })
    const recoveredReference = { status: recoveryResolve.status(), sessionIdMatched: recoveryTarget.sessionId === targetSessionId,
      interaction: recoveryTarget.interaction }
    cases.push('same owned profile and exact packed bytes restarted on the same TLS origin; public key, consent, reference, and Workspace readiness persisted without history fanout')

    const restartedSessionId = `push-smoke-${randomUUID()}`
    const restartedQuestionCommand = await runQuestion(restartedSessionId)
    const restartedQuestion = await waitForJson(join(home, 'push-integration-fixture-result.json'),
      value => value.commandId === restartedQuestionCommand && value.ok === true, 'public Host fixture to open a new post-restart question')
    assert.equal(restartedQuestion.targetSessionId, restartedSessionId)
    const postRestartTransport = await waitForJson(evidenceFileRestart, value => value.processId === dsh.pid
      && value.requestsAccepted >= 1 && typeof value.bodyBase64 === 'string', 'fresh post-restart synthetic provider send')
    const postRestartPayload = await decryptCaptured(postRestartTransport.bodyBase64, transportSeed, installedEcePath)
    const postRestartUrl = new URL(postRestartPayload.notification.navigate)
    assert.equal(postRestartUrl.origin, gatewayOrigin)
    const postRestartReference = postRestartUrl.searchParams.get('mobile-push')
    assert.match(postRestartReference ?? '', /^[A-Za-z0-9_-]{1,256}$/u)
    const postRestartTarget = await openTargetFromPush(phone, gatewayOrigin, postRestartReference, restartedSessionId)
    assert.equal(postRestartTarget.sessionIdMatched, true)
    cases.push('a fresh public Host source after restart created and resolved a new encrypted registry-owned reference')


    const deviceBContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      locale: 'en-US', ignoreHTTPSErrors: true, proxy: ownedContextProxy })
    await traced('arm-release-check-abort-device-b', () => armReleaseCheckAbort(deviceBContext, 'device-b', releaseCheckAllowedOrigins))
    const deviceBPage = await deviceBContext.newPage()
    const pairLabelB = `Task8 Pair B ${randomUUID().slice(0, 8)}`
    const pairBResponsePromise = deviceBPage.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/auth/pair'
      && response.request().method() === 'POST', { timeout: CLIENT_TIMEOUT_MS })
    const pairBUrl = await openPairing(desktop, undefined, dsh.logs)
    const pairingBBaseline = await pairMobilePage(deviceBPage, pairBUrl, dsh.logs, {
      beforeSubmit: page => page.locator('#device-label').fill(pairLabelB), workspaceTimeoutMs: CLIENT_TIMEOUT_MS,
    })
    assert(pairingBBaseline.value.items.some(item => item.workspaceId === workspaceId), 'Device B Workspace baseline omitted the owned Workspace')
    const pairBResponse = await pairBResponsePromise
    assert.equal(pairBResponse.status(), 201)
    const pairedDevicesB = await readDesktopDevices(desktop)
    assert.equal(pairedDevicesB.status, 200)
    const pairBMatches = pairedDevicesB.devices.filter(device => device.label === pairLabelB && typeof device.id === 'string')
    assert.equal(pairBMatches.length, 1, 'Exactly one actual paired Device B must be found from desktop admin')
    const deviceBId = pairBMatches[0].id
    assert.match(deviceBId, /^[a-f\d]{32}$/u)
    assert.notEqual(deviceBId, deviceId)
    const deviceBResolve = await deviceBPage.evaluate(async reference => {
      const response = await fetch('/mobile-access/push/resolve', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference }) })
      return { status: response.status, body: await response.json() }
    }, postRestartReference)
    const deviceBMissing = await deviceBPage.evaluate(async reference => {
      const response = await fetch('/mobile-access/push/resolve', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference }) })
      return { status: response.status, body: await response.json() }
    }, `missing-${transportNonce}`)
    assert.equal(deviceBResolve.status, 404, 'Device B unexpectedly resolved Device A opaque reference')
    assert.equal(deviceBMissing.status, 404)
    assert.deepEqual(deviceBResolve.body, deviceBMissing.body, 'Cross-device denial was not the neutral missing-reference result')
    assert.equal(JSON.stringify(deviceBResolve.body).includes(postRestartReference), false)
    negativeObserved = true
    cases.push('paired Device B received the same neutral 404 for Device A actual reference and a random missing reference')

    // A random missing reference is only a negative lookup; no registry state is fabricated.
    const missingResponse = await phone.evaluate(async reference => {
      const response = await fetch('/mobile-access/push/resolve', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reference }),
      })
      return { status: response.status, body: await response.json() }
    }, `missing-${transportNonce}`)
    assert.equal(missingResponse.status, 404, 'Authenticated missing-reference lookup should return the Gateway safe-missing status')
    const missing = missingResponse.body
    assert(missing === undefined || missing === null || missing.available === false || missing.sessionId === undefined,
      'Missing target resolver unexpectedly returned an openable Session')

    // Disable uses the actual authenticated route; no external sender request is issued by this action.
    const finalSettingsOpen = phone.locator('.dsh-mobile-settings_row').filter({ has: phone.getByText('Web push notifications', { exact: true }) })
    if (await finalSettingsOpen.count() === 0) await openMobileSettings(phone)
    const finalSettings = phone.locator('.dsh-mobile-settings_row').filter({ has: phone.getByText('Web push notifications', { exact: true }) })
    await finalSettings.getByRole('button', { name: 'Disable', exact: true }).click()
    const disableResponse = await phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/push/disable'
      && response.request().method() === 'POST', { timeout: CLIENT_TIMEOUT_MS })
    if (disableResponse.status() !== 200) {
      pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'disable-route-boundary', {
        status: disableResponse.status(), errorCode: await safeResponseErrorCode(disableResponse, phone) })
    }
    assert.equal(disableResponse.status(), 200, `Explicit Disable route returned ${String(disableResponse.status())}`)
    const disabledConfig = await readPushConfig(phone, installationId)
    assert.equal(disabledConfig.status, 'disabled', 'Consent must be disabled before logout')
    cases.push('explicit Disable used the actual authenticated Gateway route and persisted disabled consent')

    const logoutResult = await phone.evaluate(async () => {
      const response = await fetch('/mobile-access/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      return { status: response.status, body: await response.json() }
    })
    assert.equal(logoutResult.status, 200, 'Actual protected logout route did not succeed after consent disable')
    const cookiesAfterLogout = await phoneContext.cookies([gatewayOrigin, `${gatewayOrigin}/mobile-access/auth/renew`])
    const retainedRenewalCredentials = cookiesAfterLogout.filter(cookie => cookie.httpOnly && cookie.path === '/mobile-access/auth/renew')
    const retainedDeviceBindings = cookiesAfterLogout.filter(cookie => cookie.httpOnly && cookie.path === '/' && cookie.value === deviceId)
    const remainingShortSessions = cookiesAfterLogout.filter(cookie => cookie.httpOnly && cookie.path === '/' && cookie.value !== deviceId)
    assert.equal(retainedRenewalCredentials.length, 1, 'Logout removed the persistent pairing renewal credential')
    assert.equal(retainedDeviceBindings.length, 1, 'Logout removed the persistent browser device binding')
    assert.equal(remainingShortSessions.length, 0, 'Logout did not clear short-session cookies')
    const loggedOutConfig = await phone.evaluate(async id => {
      const response = await fetch(`/mobile-access/push/config?installationId=${encodeURIComponent(id)}`)
      return response.status
    }, installationId)
    assert.equal(loggedOutConfig, 401, 'Logout left the protected push config route available')
    cases.push('protected logout cleared short-session cookies while retaining the persistent pairing credential after consent disable')

    const renewAfterLogoutPromise = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/auth/renew'
      && response.request().method() === 'POST', { timeout: CLIENT_TIMEOUT_MS })
    const loginAfterLogoutPromise = phone.waitForResponse(response => new URL(response.url()).pathname === '/mobile-access/login'
      && response.request().method() === 'GET', { timeout: CLIENT_TIMEOUT_MS })
    await phone.goto(`${gatewayOrigin}/`, { waitUntil: 'domcontentloaded', timeout: CLIENT_TIMEOUT_MS })
    const [loginAfterLogout, renewAfterLogout] = await Promise.all([loginAfterLogoutPromise, renewAfterLogoutPromise])
    assert.equal(loginAfterLogout.status(), 200)
    assert.equal(renewAfterLogout.status(), 200, 'Retained pairing credential could not renew after logout')
    await phone.waitForFunction(() => location.pathname === '/' && location.search === '', undefined, { timeout: CLIENT_TIMEOUT_MS })
    await phone.waitForFunction(() => document.querySelector('.dshm-shell') !== null, undefined, { timeout: CLIENT_TIMEOUT_MS })
    const consentAfterRenew = await readPushConfig(phone, installationId)
    assert.equal(consentAfterRenew.status, 'disabled')
    await openMobileSettings(phone)
    const reenableSettings = phone.locator('.dsh-mobile-settings_row').filter({ has: phone.getByText('Web push notifications', { exact: true }) })
    await reenableSettings.getByRole('button', { name: 'Enable', exact: true }).click()
    await reenableSettings.getByRole('button', { name: 'Disable', exact: true }).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    const consentBeforeRevoke = await readPushConfig(phone, installationId)
    assert.equal(consentBeforeRevoke.status, 'enabled', 'Device revoke setup requires an actually enabled registration')
    // Explicit Disable and logout are owner-scoped withdrawals that advance the owner generation by
    // design (the control floor rises above all old owner rows); the re-enabled registration must sit
    // on a LATER generation than the pre-disable snapshot, not an unchanged one.
    assert(consentBeforeRevoke.ownerGeneration > configAfterRestart.ownerGeneration,
      'Explicit disable/logout did not advance the owner generation before re-enable')
    cases.push('persistent pairing renewed after logout; consent stayed disabled until a new explicit Enable gesture')

    const pushConfigBeforeStock = observations.pushRequests.filter(item => item.path === '/mobile-access/push/config').length
    const stockResponse = await phone.goto(`${gatewayOrigin}/?frontend=stock`, { waitUntil: 'domcontentloaded', timeout: CLIENT_TIMEOUT_MS })
    assert.equal(stockResponse?.status(), 200, 'Gateway stock frontend control did not return HTTP 200')
    const stockMetadata = await phone.evaluate(() => ({
      frontend: window.__DSH_MOBILE_FRONTEND__,
      manifestHref: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
      pushSettings: document.querySelectorAll('.dsh-mobile-push-categories').length,
    }))
    assert.equal(stockMetadata.frontend, undefined, 'Stock Gateway view must not load the dedicated frontend entry')
    assert.equal(stockMetadata.manifestHref, upstreamMetadata.manifestHref, 'Stock Gateway view changed the upstream manifest identity')
    assert.notEqual(stockMetadata.manifestHref, '/mobile-access/push/manifest.webmanifest')
    assert.equal(stockMetadata.pushSettings, 0)
    assert.equal(observations.pushRequests.filter(item => item.path === '/mobile-access/push/config').length, pushConfigBeforeStock,
      'Stock Gateway control should not issue push config reads')
    cases.push('stock Gateway control retained upstream metadata and remained push-inert')

    const dedicatedAgain = await phone.goto(`${gatewayOrigin}/`, { waitUntil: 'domcontentloaded', timeout: CLIENT_TIMEOUT_MS })
    assert.equal(dedicatedAgain?.status(), 200)
    await phone.waitForFunction(() => document.querySelector('.dshm-shell') !== null, undefined, { timeout: CLIENT_TIMEOUT_MS })
    const enabledBeforeRevoke = await readPushConfig(phone, installationId)
    assert.equal(enabledBeforeRevoke.status, 'enabled')
    const deviceListBeforeRevoke = await desktop.evaluate(async () => {
      const response = await fetch('/api/mobile-access/lan/devices')
      return { status: response.status, body: await response.json() }
    })
    assert.equal(deviceListBeforeRevoke.status, 200, 'Desktop admin could not list owned paired devices')
    assert(deviceListBeforeRevoke.body.devices.some(device => device.id === deviceId))
    assert(deviceListBeforeRevoke.body.devices.some(device => device.id === deviceBId))
    const revokeResult = await desktop.evaluate(async id => {
      const response = await fetch('/api/mobile-access/lan/devices/revoke', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: id }),
      })
      return { status: response.status, body: await response.json() }
    }, deviceId)
    assert.equal(revokeResult.status, 200, 'Real desktop-admin device revoke route failed')
    assert.equal(revokeResult.body.revoked, true)
    const deviceListAfterRevoke = await desktop.evaluate(async () => {
      const response = await fetch('/api/mobile-access/lan/devices')
      return { status: response.status, body: await response.json() }
    })
    assert.equal(deviceListAfterRevoke.status, 200)
    assert.equal(deviceListAfterRevoke.body.devices.some(device => device.id === deviceId), false,
      'Desktop-admin device listing retained the revoked device')
    assert(deviceListAfterRevoke.body.devices.some(device => device.id === deviceBId), 'Revoking Device A removed unrelated Device B')
    const revokedConfigStatus = await phone.evaluate(async id => {
      const response = await fetch(`/mobile-access/push/config?installationId=${encodeURIComponent(id)}`)
      return response.status
    }, installationId)
    assert.equal(revokedConfigStatus, 401, 'Revoked Device A retained protected push config access')
    const revokedResolveStatus = await phone.evaluate(async reference => {
      const response = await fetch('/mobile-access/push/resolve', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reference }) })
      return response.status
    }, postRestartReference)
    assert.equal(revokedResolveStatus, 401, 'Revoked Device A retained protected target resolution access')
    cases.push('real desktop-admin revoke removed Device A, preserved Device B, and denied A config/resolve routes')

    expectedProviderCountAfterRevoke = postRestartTransport.requestsAccepted
    const revokedSourceSessionId = `push-smoke-${randomUUID()}`
    const revokedSourceCommand = await runQuestion(revokedSourceSessionId)
    const revokedSource = await waitForJson(join(home, 'push-integration-fixture-result.json'),
      value => value.commandId === revokedSourceCommand && value.ok === true, 'public Host source after persistent device revoke')
    assert.equal(revokedSource.targetSessionId, revokedSourceSessionId)
    const postRevokeEvidence = await readTransportEvidence(evidenceFileRestart)
    assert.equal(postRevokeEvidence?.requestsAccepted, expectedProviderCountAfterRevoke,
      'A newly emitted source sent to the revoked Device A after its notification state was removed')
    const finalCloseQuestionCommand = await closeQuestion()
    await waitForJson(join(home, 'push-integration-fixture-result.json'),
      value => value.commandId === finalCloseQuestionCommand && value.phase === 'question-closed' && value.ok === true,
      'public Host fixture to dispose its post-revoke question')
    const drainedPostRevokeEvidence = await readTransportEvidence(evidenceFileRestart)
    assert.equal(drainedPostRevokeEvidence?.requestsAccepted, expectedProviderCountAfterRevoke,
      'Post-revoke synthetic provider send appeared before child drain')
    cases.push('post-revoke public Host source produced no transport request to the revoked registration')

    const workersAfter = await workerAndCacheSnapshot(phone)
    assert.deepEqual(workersAfter.workers, controlsBefore.workers, 'Push did not register or unregister any Service Worker')
    assert.deepEqual(workersAfter.cacheKeys, controlsBefore.cacheKeys, 'Push created or removed a browser CacheStorage cache')
    assert.equal(workersAfter.calls.serviceWorkerRegisterCalls ?? 0, 0, 'No Service Worker register call is permitted')
    assert.equal(workersAfter.calls.serviceWorkerUnregisterCalls ?? 0, 0, 'No Service Worker unregister call is permitted')
    assert.equal(promptAttempts, 1, 'Only the explicit held send may produce a prompt request')
    assert.deepEqual(observations.pageErrors, [], 'Packed browser push flow produced unhandled page errors')
    const finalTransport = await readTransportEvidence(evidenceFileRestart)
    assert.equal(finalTransport?.appleRequestsBlocked, restartedBaseline.transport.appleRequestsBlocked,
      'Unowned Apple network attempts beyond the restarted preflight baseline were observed')
    assert(finalTransport?.requestsAccepted >= 1)
    assert.equal(testRouteEvidence.realRouteStatus, 200, 'The real Test route evidence was not a successful authenticated send')
    assert.equal(observations.pushRequests.filter(item => item.path === '/mobile-access/push/test').length, testPostsBeforeClick + 3,
      'No further Test POST may appear after the clicked send and its two probes (no replay)')
    cases.push('no Service Worker or CacheStorage delta; no Host prompt/model invocation')

    // Retain only redacted summary evidence, never subscription credentials or notification references.
    summary = {
      status: 'PASS', dshVersion, tarballSha256, runtimeCli: binary,
      tlsFixture: { privateCaChain: tlsEvidence.privateCa, listenerHost: tlsEvidence.listenerHost,
        publicAuthority: tlsEvidence.publicAuthority, fixedPortAcrossRestart: true,
        browserAcceptedFixtureCertificate: true, iPhoneTrustEvidence: false },
      guardChain: {
        imports: 'network-guard -> transport helper -> hard preflight (order load-bearing, applied to every DSH child)',
        networkGuardSha256: await fileSha256(networkGuardPath),
        transportSha256: await fileSha256(transportPath),
        preflightSha256: await fileSha256(preflightPath),
        nonceScope: 'one fresh 48-hex nonce per owned run across its sequential children; per-child evidence and PID checks; no cross-run reuse',
        perChild: guardChainReceipts,
        proxy: 'owned loopback CONNECT tunnel for the exact public authority only; per-context proxy honored by pages and APIRequestContext; desktop contexts stay direct',
        evidenceRetention: typeof process.env.DSH_PUSH_EVIDENCE_DIR === 'string' && process.env.DSH_PUSH_EVIDENCE_DIR !== ''
          ? 'raw per-child evidence copied to DSH_PUSH_EVIDENCE_DIR before owned root removal'
          : 'owned-root-only (CI default; no ignored-path dependency)',
      },
      packedPackages: {
        host: installedHostIdentity, client: installedClientIdentity, testHostFixture: installedHostFixtureIdentity,
        runtimeDependencies: { webPush: installedWebPushIdentity, zod: installedZodIdentity },
      },
      provider: { kind: 'synthetic controlled Apple endpoint', ownedHost: true, acceptedHttpsCount: finalTransport.requestsAccepted,
        blockedUnownedAppleAttempts: finalTransport.appleRequestsBlocked, decryptedWith: 'packed dependency http_ece' },
      routes: observations.pushResponses,
      browserDiagnostics: { pageErrors: observations.pageErrors, consoleCategories: observations.consoleCategories, cspViolations: observations.cspViolations },
      publicSessionObservation: { initial: publicSessionObservationInitial, afterSameProfileRestart: publicSessionObservationRestarted,
        provesNeverCreatedMissingLookupOnly: true, genuinePersistedDeletedTargetVerified: false },
      cases,
      effects: { expiredSession, serverSideSessionAbsence,
        warmTap, pushController: { mountedRowCount: pushRowCount, subscribeCallsBeforeEnable,
        subscribeCallsAfterEnable, successfulEnrollCount, settingsDiagnostic: pushSettingsDiagnostic }, workerCounts: workersAfter.calls, serviceWorkerScopes: workersAfter.workers,
        cacheKeys: workersAfter.cacheKeys, promptAttempts, testNotification: testRouteEvidence },
      limits: ['Synthetic PushManager and local Apple HTTPS acceptance are not Apple/iPhone delivery evidence.',
        'Server-side session absence is produced by an owned-runtime restart (auth sessions are runtime memory in src/access.ts), not by waiting out a configured server session TTL.',
        'On a fresh-boot renewed login the resolver returns the intended target while the upstream app may land on the last-active session (session-open reference released); booted-app taps open the target.',
        'A genuinely persisted-then-deleted target Session remains unprovable here: no public SessionPersistence delete operation exists, and deleting every id-named persisted artifact under the owned root still left the Session resolvable through the public session query (the authoritative store is a generic-named workspace structure).',
        'Chromium cross-document navigation does not establish iOS Home Screen warm-tap or in-flight preservation behavior.'],
      cleanup: 'browser and both owned DSH children drained before temporary root removal',
    }
  } catch (error) {
    if (error !== pairDiagnosticComplete) failed = new Error(`Task 8 smoke failed at ${stage}: ${safeText(error?.stack ?? error)}`)
  } finally {
    clearTimeout(deadlineTimer)
    promptHoldRelease?.resolve()
    try {
      ;[browserStopResult, dshStopResult] = await Promise.all([closeOwnedBrowser(), closeOwnedDsh()])
      if (pairStepCancelPromise) {
        const pairPageClose = await settleBefore(pairStepCancelPromise, 5_000)
        if (!pairPageClose.completed) cleanupFailures.push(new Error('Timed-out pair page close was not drained'))
      }
      processExited = dsh === undefined || dshStopResult?.closed === true
    } catch { cleanupFailures.push(new Error('owned process teardown failed')) }
    if (browserStopResult?.closed !== true) cleanupFailures.push(new Error('Owned Chromium process exit was not confirmed'))
    if (browserStopResult?.forceKillSent) cleanupFailures.push(new Error('Owned Chromium required forced termination'))
    if (dshStopResult?.forced) cleanupFailures.push(new Error('Owned DSH fixture required forced termination'))
    const browserExited = browserStopResult?.closed === true
    for (const socket of proxySockets) socket.destroy()
    browserProxy?.closeAllConnections()
    if (browserProxy?.listening) {
      await new Promise(resolveClose => browserProxy.close(resolveClose))
      if (browserProxy.listening) cleanupFailures.push(new Error('Owned exact-authority proxy did not close'))
    }
    // F1 strict final gate: after each actual child has exited (guard files still in the owned root),
    // its FINAL guard evidence must show the exact PID, zero blocked entries and zero block counters
    // of every family, with both binding attestations still visible. Any late block, invalid or
    // missing evidence fails the run — which also suppresses the negative receipt by throwing first.
    if (processExited || pairDiagnosticResult !== undefined) {
      const finalGuardChecks = []
      const checkChild = async (label, expectedPid, guardPath) => {
        if (expectedPid === undefined) return
        const evidence = await readTransportEvidence(guardPath).catch(() => undefined)
        const verdict = checkFinalGuardEvidence(evidence, expectedPid)
        pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'cleanup', `final-guard-evidence-${label}`, {
          expectedPid, ok: verdict.ok, reason: verdict.reason, finalCounters: verdict.finalCounters ?? null })
        finalGuardChecks.push({ label, ...verdict })
        const receipt = guardChainReceipts.find(entry => entry.pid === expectedPid)
        if (receipt !== undefined) {
          receipt.guardFinalSamplingPoint = 'final-after-exit'
          receipt.guardFinalCounters = verdict.finalCounters ?? null
        }
        if (!verdict.ok) cleanupFailures.push(new Error(`Strict final guard gate failed for the ${label} child: ${verdict.reason}`))
      }
      await checkChild('initial', initialChildPid, guardEvidenceFile)
      if (restartedChildPid !== undefined) await checkChild('restart', restartedChildPid, guardEvidenceFileRestart)
      mark('cleanup', 'release-check-abort-settlement', {
        intercepted: releaseCheckInterceptions.count, methods: [...releaseCheckInterceptions.methods],
        origins: [...releaseCheckInterceptions.origins],
        allowedOrigins: [...releaseCheckAllowedOrigins],
        foreignOriginSamePathPassThrough: releaseCheckInterceptions.foreignOriginSamePathPassThrough,
        nonMatchingPassThrough: releaseCheckInterceptions.nonMatchingPassThrough })
      if (summary !== undefined && summary.guardChain !== undefined) {
        summary.guardChain.releaseCheckAbort = { path: '/api/mobile-access/release', method: 'GET',
          allowedOrigins: [...releaseCheckAllowedOrigins],
          intercepted: releaseCheckInterceptions.count, origins: [...releaseCheckInterceptions.origins],
          foreignOriginSamePathPassThrough: releaseCheckInterceptions.foreignOriginSamePathPassThrough,
          nonMatchingPassThrough: releaseCheckInterceptions.nonMatchingPassThrough,
          settlement: 'aborted-at-owned-route-boundary' }
      }
    }

    // Evidence copy runs AFTER the strict gate so the RETAINED runtime diagnostic includes the
    // per-child final-guard records and the release-abort settlement.
    const evidenceRetention = await persistRawGuardEvidence().catch(error => {
      cleanupFailures.push(new Error(`Raw guard evidence persistence failed: ${error?.message ?? error}`))
      return null
    })
    evidenceRetentionDir = evidenceRetention?.directory ?? null
    if (evidenceRetention !== null) mark('cleanup', 'raw-guard-evidence-retained', { copied: evidenceRetention.copied.length })

    if (processExited && browserExited) {
      const finalAskSettlement = typeof home === 'string'
        ? await readFixtureAskSettlement(home).catch(() => ({ present: false, readErrorCode: 'READ_ERROR' })) : { present: false, readErrorCode: 'HOME_UNAVAILABLE' }
      pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'snapshot', 'fixture-ask-settlement-after-owned-teardown', finalAskSettlement)
      const finalEvidence = await readTransportEvidence(evidenceFileRestart).catch(() => undefined)
      if (expectedProviderCountAfterRevoke !== undefined
        && finalEvidence?.requestsAccepted !== expectedProviderCountAfterRevoke) {
        cleanupFailures.push(new Error('Revoked registration emitted synthetic provider traffic before DSH drain completed'))
      }
      if (finalEvidence !== undefined && summary !== undefined) {
        summary.provider.acceptedHttpsCount = finalEvidence.requestsAccepted
        summary.provider.blockedUnownedAppleAttempts = finalEvidence.appleRequestsBlocked
        summary.effects.postRevokeAcceptedCount = expectedProviderCountAfterRevoke
      }
      try {
        await removeTemporaryRoot(root, prefix)
        mark('cleanup', 'owned-root-removal', { removed: true })
      } catch { cleanupFailures.push(new Error('Owned temporary root cleanup failed')); mark('cleanup', 'owned-root-removal', { removed: false }) }
    } else {
      cleanupFailures.push(new Error('Owned DSH/browser exit was not confirmed; private root retained'))
      mark('cleanup', 'owned-root-removal', { removed: false })
    }
    pairDiagnosticDetail(runtimeDiagnosticFd, pairDiagnosticRunId, 'cleanup', 'owned-runtime', {
      processExited, browserExited, browserApiCloseCompleted: browserStopResult?.apiCloseCompleted === true,
      browserSignal: browserStopResult?.signalSent ?? null, browserForceKillSent: browserStopResult?.forceKillSent === true,
      dshClosed: dshStopResult?.closed === true, dshForced: dshStopResult?.forced === true,
      dshExitCode: dshStopResult?.code ?? null, privateRootRemoved: processExited && browserExited })
    if (pairDiagnosticFd !== undefined) {
      mark('finished', 'pair-diagnostic', { bodyDeadlineExpired: diagnosticCancelled, processExited, browserExited })
      try { closeSync(pairDiagnosticFd) } catch {}
    }
    try { closeSync(runtimeDiagnosticFd) } catch {}
  }
  if (pairDiagnosticResult !== undefined) {
    if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'Owned pair diagnostic cleanup failed')
    pairDiagnosticResult.cleanup = { browserClosed: browserStopResult?.closed === true, browserApiCloseCompleted: browserStopResult?.apiCloseCompleted,
      browserSignal: browserStopResult?.signalSent, browserForceKillSent: browserStopResult?.forceKillSent,
      dshClosed: dshStopResult?.closed === true, dshForced: dshStopResult?.forced === true,
      privateRootRemoved: processExited && browserStopResult?.closed === true, withinAbsoluteDeadline: Date.now() <= absoluteDeadline }
    pairDiagnosticResult.progressLog = pairDiagnosticTarget ?? null
    console.log(JSON.stringify(pairDiagnosticResult, null, 2))
    return pairDiagnosticResult
  }
  if (failed || cleanupFailures.length > 0) {
    throw new AggregateError([...(failed ? [failed] : []), ...cleanupFailures], `Task 8 packed Mobile Push smoke failed; sanitizedRuntimeEvidence=${runtimeDiagnosticPath}`)
  }
  assert(summary !== undefined, 'The owned browser smoke did not produce a redacted completion summary')
  summary.cleanup = { browserClosed: browserStopResult?.closed === true, browserApiCloseCompleted: browserStopResult?.apiCloseCompleted === true,
    browserSignal: browserStopResult?.signalSent ?? null, browserForceKillSent: browserStopResult?.forceKillSent === true,
    dshClosed: dshStopResult?.closed === true, dshForced: dshStopResult?.forced === true, dshExitCode: dshStopResult?.code ?? null,
    privateRootRemoved: processExited && browserStopResult?.closed === true, withinAbsoluteDeadline: Date.now() <= absoluteDeadline,
    bodyDeadlineExpired: diagnosticCancelled }
  summary.runtimeDiagnostic = { path: runtimeDiagnosticPath,
    retention: evidenceRetentionDir !== null ? `retained copy at ${evidenceRetentionDir}` : 'ephemeral (owned temporary root; set DSH_PUSH_EVIDENCE_DIR to retain)' }
  if (negativeControl) {
    summary.status = 'EXPECTED_NEGATIVE_CONTROL'
    summary.negativeControl = OWNER_NEGATIVE_MARKER
  }
  console.log(JSON.stringify(summary, null, 2))
  if (negativeControl) {
    // The helper's terminal receipt requires exactly one recorded deliberate failure observed by
    // the run: the cross-device ownership denial itself is that condition.
    const deliberate = new Error('Push ownership negative: paired Device B received the neutral missing-reference denial for Device A actual reference')
    completeSmoke(negativeObserved ? [deliberate] : [], OWNER_NEGATIVE_MARKER, negativeObserved)
  }
  return summary
}

if (args.includes('--transport-self-test')) {
  const result = await transportSelfTest()
  console.log(JSON.stringify(result, null, 2))
} else {
  await runFullSmoke({ negativeControl: args.includes('--negative-control-owner'), pairDiagnostic: args.includes('--pair-diagnostic') })
}
