import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'tsdown'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildExtensionWorkerArtifacts } from './helpers/extension-worker-build.js'
import type { Context } from '@deepseek-ai/cordis'
import type { MobileAccessService } from '../src/extensions.js'
const run = promisify(execFile)

/** Owner-local compiled package smoke: does not write the repository's lib/ or run another full build. */
describe('installed default extension worker entry', () => {
  let root: string
  let extracted: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-pack-'))
    const artifacts = await buildExtensionWorkerArtifacts()
    const staging = join(root, 'staging'); await mkdir(join(staging, 'lib'), { recursive: true })
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as Record<string, unknown>
    // Keep the actual package identity, exports and file inclusion rules; this fixture bundles only the Host seam under test.
    await writeFile(join(staging, 'package.json'), JSON.stringify({ ...manifest, scripts: {}, workspaces: undefined, peerDependencies: {}, peerDependenciesMeta: {}, dependencies: {} }))
    await cp(artifacts.runtimeEntry, join(staging, 'lib', 'extension-worker-runtime.mjs'))
    await build({ config: false, entry: { index: join(process.cwd(), 'src', 'extensions.ts') }, outDir: join(staging, 'lib'), format: ['esm'], platform: 'node', target: 'node22', clean: false, dts: false, deps: { alwaysBundle: ['@deepseek-ai/cordis', '@deepseek-ai/cosmokit', '@deepseek-ai/schemastery'] } } as Parameters<typeof build>[0])
    const npmCli = process.env.npm_execpath
    if (npmCli === undefined) throw new Error('run the package smoke through npm so npm_execpath identifies the CLI')
    const packed = await run(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: staging })
    const filename = (JSON.parse(packed.stdout) as { filename: string }[])[0]?.filename
    if (filename === undefined) throw new Error('npm pack did not return a filename')
    const installRoot = join(root, 'installed'); await mkdir(installRoot)
    await run(process.execPath, [npmCli, 'install', '--prefix', installRoot, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', join(root, filename)])
    extracted = join(installRoot, 'node_modules', 'dsh-mobile')
  })
  afterAll(async () => { if (root !== undefined) await rm(root, { recursive: true, force: true }) })

  it('ships a self-contained runtime and activates a worker through the installed default resolver', async () => {
    const body = await readFile(join(extracted, 'lib', 'extension-worker-runtime.mjs'), 'utf8')
    expect(body).not.toMatch(/from ["']@deepseek-ai\//u)
    const module = await import(pathToFileURL(join(extracted, 'lib', 'index.mjs')).href) as { MobileAccessService: typeof MobileAccessService }
    // The bundled Cordis service accepts the real test Context through its ordinary public methods.
    const { Context: CordisContext } = await import('@deepseek-ai/cordis')
    const context: Context = new CordisContext()
    const extensions = join(root, 'extensions'); const directory = join(extensions, 'packaged')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'extension.json'), JSON.stringify({ schemaVersion: 1, id: 'packaged', name: 'packaged', version: '1' }))
    await writeFile(join(directory, 'host.mjs'), 'export default api => { api.action("probe", { run: () => ({ ok: true }) }); api.action("spin", { timeoutMs: 100, run: () => { while (true) {} } }) }')
    const service = new module.MobileAccessService(context)
    try {
      // No workerModule override: import.meta.url in the installed artifact must find its adjacent entry.
      await service.startLocal(extensions, context, { hostExecution: { mode: 'worker', cancelGraceMs: 100 } })
      expect(service.hostStatus().hosts[0]?.state).toBe('ready')
      const result = await service.invoke('packaged', 'probe', {}, { signal: new AbortController().signal, deviceId: 'device' }) as { readonly bytes: Buffer }
      expect(result.bytes.toString()).toBe('{"ok":true}')
      await expect(service.invoke('packaged', 'spin', {}, { signal: new AbortController().signal, deviceId: 'device' })).rejects.toMatchObject({ code: 'extension_action_timeout' })
    } finally { await service.stopLocal(); await context.fiber.dispose() }
  })
})
