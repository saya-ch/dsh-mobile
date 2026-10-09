/**
 * Supervised runner for the blocking extension-worker scenarios (spike).
 *
 * Plain ESM on purpose: no TypeScript imports, no vitest. It drives the REAL
 * bundled ExtensionWorkerHost against the REAL worker runtime entry while the
 * worker thread is synchronously blocked, then prints a JSON verdict and exits.
 * The vitest wrapper supervises this process with a hard timeout.
 */
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const runtimeEntry = process.argv[2]
const supervisorBundle = process.argv[3]
if (runtimeEntry === undefined || supervisorBundle === undefined) {
  console.error('usage: node extension-worker-blocking-runner.mjs <runtime-entry> <supervisor-bundle>')
  process.exit(2)
}

const { ExtensionWorkerHost } = await import(supervisorBundle)
const noopLogger = { debug() {}, info() {}, warn() {}, error() {} }
const manifest = { schemaVersion: 1, id: 'blocked', name: 'blocked', version: '1.0.0' }

async function makeHost(root, generation) {
  const host = new ExtensionWorkerHost({
    workerModule: runtimeEntry,
    hostFile: join(root, 'host.mjs'),
    manifest,
    generation,
    logger: noopLogger,
  })
  return { host, activation: await host.activate() }
}

async function writeExtension(root, hostSource) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'extension.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'host.mjs'), hostSource)
}

async function scenarioA() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worker-block-a-'))
  try {
    // `spin` synchronously blocks the worker thread forever — but only after
    // appending a marker, so the runner can PROVE the block started before
    // measuring parent-loop responsiveness.
    const marker = join(root, 'started.marker')
    await writeExtension(root, `
import { appendFile } from 'node:fs/promises'
const marker = ${JSON.stringify(marker)}
export default (api) => {
  api.action('spin', { timeoutMs: 300, run: async () => { await appendFile(marker, 'go'); while (true) {} } })
  api.action('probe', { run: async () => ({ ok: true }) })
}
`)
    const server = createServer((_, response) => { response.writeHead(200); response.end('pong') })
    await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port

    const { host, activation } = await makeHost(root, 'a1')
    const caller = { signal: new AbortController().signal, deviceId: 'device' }

    const spin = host.invoke('spin', {}, caller)
    // Wait until the worker has actually entered its blocking loop.
    const { existsSync } = await import('node:fs')
    const startedAt = Date.now()
    while (!existsSync(marker)) {
      if (Date.now() - startedAt > 2_000) throw new Error('worker never signaled it started blocking')
      await new Promise(resolve => { setTimeout(resolve, 20) })
    }
    // While the worker thread is blocked, the parent loop must stay responsive.
    const pong = await fetch(`http://127.0.0.1:${port}/ping`)
    const responsive = pong.status === 200 && Date.now() - startedAt < 3_000

    let timedOut = false
    try { await spin } catch (error) { timedOut = error?.code === 'extension_action_timeout' }

    // Deadline fired but the worker never settles: the supervisor's own
    // cleanup grace must terminate the blocked worker without our help.
    const terminated = await Promise.race([
      host.whenExited().then(() => true),
      new Promise(resolve => { setTimeout(() => resolve(false), 4_000) }),
    ])

    // A fresh runtime for the same generation content has a distinct identity.
    const second = await makeHost(root, 'a1')
    const runtimeRotated = second.activation.runtimeId !== activation.runtimeId
    const probe = await second.host.invoke('probe', {}, { signal: new AbortController().signal, deviceId: 'device' })
    const recovered = probe.bytes.toString('utf8') === '{"ok":true}'
    await second.host.terminate('done')
    await new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })
    return { responsive, timeout: timedOut, terminated, recovered, runtimeRotated }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function scenarioB() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-worker-block-b-'))
  try {
    // The stream source blocks synchronously in read(): the worker wedges
    // mid-stream after stream-start crossed.
    await writeExtension(root, `
import { Readable } from 'node:stream'
export default (api) => {
  api.route({
    method: 'GET',
    path: 'firehose',
    handle: () => ({ contentType: 'application/octet-stream', body: new Readable({ read() { while (true) {} } }) }),
  })
}
`)
    const { host } = await makeHost(root, 'b1')
    const response = await host.handleRoute(0, {
      method: 'GET', pathname: '/firehose', query: new URLSearchParams(), headers: {},
      body: Buffer.alloc(0), signal: new AbortController().signal, deviceId: 'device',
    })
    const bridge = response.body
    const closed = new Promise(resolve => { bridge.once('close', resolve) })
    bridge.destroy()
    await closed
    // The supervisor recorded a cancellation (it posted stream-cancel) …
    const streamCancelled = host.streamStats().cancelledStreams >= 1
    // … but the blocked worker cannot end the stream, so the cancel grace must
    // terminate the worker (bounded by the race below).
    const terminated = await Promise.race([
      host.whenExited().then(() => true),
      new Promise(resolve => { setTimeout(() => resolve(false), 4_000) }),
    ])
    return { streamCancelled, terminated }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

try {
  const scenarioAResult = await scenarioA()
  const scenarioBResult = await scenarioB()
  console.log(JSON.stringify({ scenarioA: scenarioAResult, scenarioB: scenarioBResult }))
  process.exit(0)
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
}
