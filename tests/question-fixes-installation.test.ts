import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const helperUrl = new URL('../scripts/packed-profile.mjs', import.meta.url)
const { assertProfileComponents }: { assertProfileComponents: (installed: string) => Promise<void> } = await import(helperUrl.href)
const temporaryRoots: string[] = []

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function packageFiles(directory: string, component = false): Promise<void> {
  await mkdir(join(directory, 'lib'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify(component ? {
    name: 'dsh-mobile-question-fixes', version: '0.6.3', type: 'module',
    exports: { '.': './lib/index.mjs', './client': './lib/client.js', './package.json': './package.json' },
  } : {
    name: 'dsh-mobile', version: '0.6.3', type: 'module',
  }))
  if (component) {
    await writeFile(join(directory, 'lib', 'index.mjs'), 'export function apply() {}\n')
    await writeFile(join(directory, 'lib', 'client.js'), 'export function apply() {}\n')
  }
}

async function fixture(): Promise<{ root: string; installed: string; component: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-component-installation-'))
  temporaryRoots.push(root)
  const installed = join(root, 'profile', 'node_modules', 'dsh-mobile')
  const component = join(installed, 'packages', 'question-fixes')
  await packageFiles(installed)
  return { root, installed, component }
}

describe('packed question-card component ownership', () => {
  it('accepts the self-contained component without a profile-level companion', async () => {
    const { installed, component } = await fixture()
    await packageFiles(component, true)
    await expect(assertProfileComponents(installed)).resolves.toBeUndefined()
  })

  it('rejects a missing embedded copy even when legacy and profile copies exist', async () => {
    const { root, installed } = await fixture()
    await packageFiles(join(installed, 'node_modules', 'dsh-mobile-question-fixes'), true)
    await packageFiles(join(root, 'profile', 'node_modules', 'dsh-mobile-question-fixes'), true)
    await expect(assertProfileComponents(installed)).rejects.toThrow('Packed bundle is missing embedded component')
  })

  it('rejects a workspace link that resolves outside the installed bundle', async () => {
    const { root, installed, component } = await fixture()
    const workspace = join(root, 'checkout', 'question-fixes')
    await packageFiles(workspace, true)
    await mkdir(join(installed, 'packages'), { recursive: true })
    await symlink(workspace, component, process.platform === 'win32' ? 'junction' : 'dir')
    try {
      await expect(assertProfileComponents(installed)).rejects.toThrow('outside the installed bundle')
    } finally { await unlink(component) }
    await expect(import(pathToFileURL(join(workspace, 'lib', 'index.mjs')).href)).resolves.toHaveProperty('apply')
  })

  it('rejects a client export that points to a sibling package', async () => {
    const { installed, component } = await fixture()
    await packageFiles(component, true)
    await writeFile(join(component, 'package.json'), JSON.stringify({
      name: 'dsh-mobile-question-fixes', version: '0.6.3', type: 'module',
      exports: { '.': './lib/index.mjs', './client': '../unpacked-client.js', './package.json': './package.json' },
    }))
    await expect(assertProfileComponents(installed)).rejects.toThrow('Invalid "exports" target')
  })

  it('rejects an embedded component from a different Mobile version', async () => {
    const { installed, component } = await fixture()
    await packageFiles(component, true)
    await writeFile(join(component, 'package.json'), JSON.stringify({ name: 'dsh-mobile-question-fixes', version: '0.6.2', exports: { '.': './lib/index.mjs', './client': './lib/client.js', './package.json': './package.json' } }))
    await expect(assertProfileComponents(installed)).rejects.toThrow('version does not match')
  })
})
