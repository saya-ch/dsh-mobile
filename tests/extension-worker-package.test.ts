import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildExtensionWorkerArtifacts } from './helpers/extension-worker-build.js'

const run = promisify(execFile)

/**
 * Packaged-installation smoke (spike deliverable): the worker must start from
 * the installed npm artifact. tsdown entries are an explicit list — a new
 * source file ships nowhere without an entry, and this test proves the entry
 * made it into the tarball and actually boots.
 */
describe('packaged extension worker artifact', () => {
  let packed: { readonly tarball: string; readonly extracted: string } | undefined

  beforeAll(async () => {
    const staging = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-pack-'))
    const repo = fileURLToPath(new URL('..', import.meta.url))
    await run('npm', ['run', 'build'], { cwd: repo })
    const { stdout } = await run('npm', ['pack', '--ignore-scripts'], { cwd: repo })
    const tarballName = stdout.trim().split('\n').at(-1)
    if (tarballName === undefined) throw new Error('npm pack produced no tarball name')
    await rename(join(repo, tarballName), join(staging, tarballName))
    const extracted = join(staging, 'package')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(extracted, { recursive: true })
    await run('tar', ['-xzf', join(staging, tarballName), '-C', extracted, '--strip-components', '1'])
    packed = { tarball: join(staging, tarballName), extracted }
  }, 240_000)

  it('ships the worker entry in the npm artifact', async () => {
    expect(packed).toBeDefined()
    const entry = join(packed!.extracted, 'lib', 'extension-worker-runtime.mjs')
    const body = await readFile(entry, 'utf8')
    // Self-contained: no bare package imports that would need node_modules.
    expect(body).not.toMatch(/from "@deepseek-ai\//u)
    expect(body).toContain('extension-worker-runtime must run inside a Worker')
  })

  it('boots the worker from the installed artifact and terminates it', async () => {
    expect(packed).toBeDefined()
    const artifacts = await buildExtensionWorkerArtifacts()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-installed-'))
    try {
      await writeFile(join(root, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'smoke', name: 'smoke', version: '1.0.0' }))
      await writeFile(join(root, 'host.mjs'), `
export default (api) => {
  api.action('spin', { timeoutMs: 200, run: () => { while (true) {} } })
  api.action('probe', { run: async () => ({ ok: true }) })
}
`)
      const supervisorModule = await import(artifacts.supervisorBundle) as typeof import('../src/extension-worker.js')
      const ExtensionWorkerHost = supervisorModule.ExtensionWorkerHost
      const host = new ExtensionWorkerHost({
        // THE point of the smoke: the worker file comes from the npm artifact.
        workerModule: join(packed!.extracted, 'lib', 'extension-worker-runtime.mjs'),
        hostFile: join(root, 'host.mjs'),
        manifest: { schemaVersion: 1, id: 'smoke', name: 'smoke', version: '1.0.0' },
        generation: 'pack-smoke',
        logger: { debug() {}, info() {}, warn() {}, error() {} },
      })
      const activated = await host.activate()
      expect(activated.actions.map(action => action.name)).toEqual(['spin', 'probe'])
      const blocked = host.invoke('spin', {}, { signal: new AbortController().signal, deviceId: 'device' })
      await expect(blocked).rejects.toMatchObject({ code: 'extension_action_timeout' })
      await expect(Promise.race([host.whenExited().then(() => true), new Promise(resolve => { setTimeout(() => resolve(false), 4_000) })])).resolves.toBe(true)
      await rm(root, { recursive: true, force: true })
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }, 30_000)
})
