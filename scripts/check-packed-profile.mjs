import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const [dshBin, profileDir, home] = process.argv.slice(2)
if (dshBin === undefined || profileDir === undefined || home === undefined) {
  throw new Error('Usage: check-packed-profile.mjs <dsh-bin> <profile> <home>')
}
const require = createRequire(dshBin)
const installation = require.resolve('@deepseek-ai/dsh/package.json')
const { loadProfileDirectory, createRuntimeResolution, PluginPackages } = await import(
  pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot'))
)
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const { ModuleLoader } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-loader')))
const { ClientModuleRegistry } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-modules')))
const profile = loadProfileDirectory('dsh', profileDir, installation)
const installed = await realpath(join(profileDir, 'node_modules', 'dsh-mobile'))
const selected = profile.layers.find(layer => layer.packageName === 'dsh-mobile')
if (selected === undefined || await realpath(selected.packageDir) !== installed) {
  throw new Error('DSH selected Mobile outside the installed test profile; install the DSH runtime without dsh-mobile')
}
const resolution = await createRuntimeResolution({ installAnchor: installation, profile, home })
const context = new Context()
const baseUrl = `${pathToFileURL(profileDir).href}/`
context.baseUrl = baseUrl
try {
  new PluginPackages(context, { resolution })
  const internal = ModuleLoader.fromInternal()
  if (internal === undefined) throw new Error('DSH internal module resolver is unavailable')
  const specifier = selected.patches.flatMap(patch => patch.insert ?? []).find(row => row.id === 'dsh-ui-fixes')?.name
  if (typeof specifier !== 'string') throw new Error('Packed Mobile bundle has no question-card component row')
  const expected = await realpath(join(installed, 'packages', 'question-fixes'))
  const located = internal.version === 'v2' ? internal.resolveSync(baseUrl, { specifier, attributes: {} }).url : internal.resolveSync(specifier, baseUrl, {}).url
  if (await realpath(dirname(dirname(fileURLToPath(located)))) !== expected) throw new Error('DSH resolved question-card Host code outside the installed Mobile artifact')
  const node = await internal.import(specifier, baseUrl, {})
  if (typeof node.apply !== 'function') throw new Error('Packed question-card component has no Host apply export')
  context.provide('loader', {
    internal,
    *entries() {
      yield {
        options: { name: specifier }, fiber: {}, disabled: false,
        parent: { tree: { ctx: { baseUrl } } },
      }
    },
  })
  const registry = new ClientModuleRegistry(context)
  const clientPath = registry.clientPath('dsh-mobile-question-fixes')
  if (clientPath === undefined || await realpath(dirname(dirname(clientPath))) !== expected) {
    throw new Error('DSH client discovery did not select the packed question-card component')
  }
  if (!registry.graph().entries.some(candidate => candidate.id === 'dsh-mobile-question-fixes')) {
    throw new Error('Packed question-card component is absent from the DSH client graph')
  }
  console.log('Packed question-card component resolves through DSH from the isolated profile')
} finally { await context.fiber.dispose() }
