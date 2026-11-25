import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { funnelExecutable } from '../src/funnel.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

/** The sidecar name this machine would spawn. */
const target = `${process.platform}-${process.arch}`
const fileName = `dsh-mobile-funnel-${target}${process.platform === 'win32' ? '.exe' : ''}`
const packageName = `dsh-mobile-funnel-${target}`

async function fixture(): Promise<{ root: string, importMetaUrl: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dshm-funnel-'))
  roots.push(root)
  await mkdir(join(root, 'lib'), { recursive: true })
  // Stands in for the compiled plugin, so module resolution walks up from here.
  return { root, importMetaUrl: pathToFileURL(join(root, 'lib', 'plugin.js')).href }
}

it('resolves the installed platform package rather than the bundled fallback', async () => {
  // The sidecar ships as an optional per-platform package; npm installs only the one
  // matching this machine's os/cpu, so the lookup has to find it through the loader.
  const { root, importMetaUrl } = await fixture()
  const packageDirectory = join(root, 'node_modules', packageName)
  await mkdir(packageDirectory, { recursive: true })
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name: packageName, version: '0.0.0' }))
  await writeFile(join(packageDirectory, fileName), 'binary')

  expect(funnelExecutable(importMetaUrl, {})).toBe(join(packageDirectory, fileName))
})

it('falls back to the bundled bin/ path when the platform package is missing', async () => {
  // A checkout that built straight into bin/ has no package to resolve; the returned
  // path is allowed not to exist, because the spawn reports the real failure.
  const { root, importMetaUrl } = await fixture()
  expect(funnelExecutable(importMetaUrl, {})).toBe(resolve(root, 'bin', fileName))
})

it('ignores a platform package whose manifest resolves but whose binary is absent', async () => {
  // A partially extracted install must not hand spawn a path that cannot run; falling
  // back keeps the failure at the documented binary instead of a directory.
  const { root, importMetaUrl } = await fixture()
  const packageDirectory = join(root, 'node_modules', packageName)
  await mkdir(packageDirectory, { recursive: true })
  await writeFile(join(packageDirectory, 'package.json'), JSON.stringify({ name: packageName, version: '0.0.0' }))

  expect(funnelExecutable(importMetaUrl, {})).toBe(resolve(root, 'bin', fileName))
})

it('lets an absolute development override win over both', async () => {
  const override = process.platform === 'win32' ? 'C:\\funnel\\funnel.exe' : '/opt/funnel/funnel'
  expect(funnelExecutable('file:///nowhere/lib/plugin.js', { DSH_MOBILE_FUNNEL_SIDECAR: override })).toBe(resolve(override))
})

it('rejects a relative development override', () => {
  // A relative path would resolve against the unknown working directory of whoever
  // launched DSH, which is not what the documented override means.
  expect(() => funnelExecutable('file:///nowhere/lib/plugin.js', { DSH_MOBILE_FUNNEL_SIDECAR: './funnel' }))
    .toThrow(/must be an absolute path/u)
})
