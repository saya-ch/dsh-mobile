import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'tsdown'
import { afterAll } from 'vitest'

/**
 * Build standalone worker artifacts in owned temporary directories.
 *
 * The production artifact comes from the tsdown entry (packaged install smoke
 * covers that path); tests must not depend on a prior full `npm run build`.
 */
let cached: Promise<{ readonly runtimeEntry: string; readonly supervisorBundle: string }> | undefined
const ownedDirectories: string[] = []
afterAll(async () => { for (const directory of ownedDirectories.splice(0)) await rm(directory, { recursive: true, force: true }) })

export interface ExtensionWorkerBuild {
  readonly runtimeEntry: string
  readonly supervisorBundle: string
}

export function buildExtensionWorkerEntry(): Promise<string> {
  return buildExtensionWorkerArtifacts().then(artifacts => artifacts.runtimeEntry)
}

export function buildExtensionWorkerArtifacts(): Promise<ExtensionWorkerBuild> {
  cached ??= (async (): Promise<ExtensionWorkerBuild> => {
    const outDir = await mkdtemp(join(tmpdir(), 'dsh-mobile-worker-entry-'))
    ownedDirectories.push(outDir)
    const shared = {
      // Isolate from tsdown.config.ts (its multi-entry defaults externalize deps).
      // `config: false` is accepted at runtime but absent from UserConfig's type.
      config: false,
      outDir,
      format: ['esm'],
      platform: 'node',
      target: 'node22',
      dts: false,
      sourcemap: false,
      clean: true,
      // Both bundles must be self-contained: the supervised runner is plain JS
      // and the packaged artifact has no node_modules beside it.
      deps: { alwaysBundle: ['@deepseek-ai/schemastery'] },
    }
    await build({ ...shared, entry: { 'extension-worker-runtime': join(process.cwd(), 'src', 'extension-worker-runtime.ts') } } as Parameters<typeof build>[0])
    // The supervisor bundle lets the plain-JS supervised runner drive the REAL
    // ExtensionWorkerHost (test-only artifact; production ships only the runtime entry).
    await build({
      ...shared,
      clean: false,
      entry: { 'extension-worker-supervisor-test': join(process.cwd(), 'src', 'extension-worker.ts') },
      deps: { alwaysBundle: ['@deepseek-ai/cordis', '@deepseek-ai/cosmokit', '@deepseek-ai/schemastery'] },
    } as Parameters<typeof build>[0])
    return {
      runtimeEntry: join(outDir, 'extension-worker-runtime.mjs'),
      supervisorBundle: join(outDir, 'extension-worker-supervisor-test.mjs'),
    }
  })().catch((error: unknown) => {
    cached = undefined
    throw error
  })
  return cached
}
