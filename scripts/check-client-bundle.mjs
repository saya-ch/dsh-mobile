import { readFile, stat } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { pathToFileURL } from 'node:url'

/**
 * Largest boot entry the gateway serves on its own asset route
 * (`MAX_MOBILE_BOOT_ENTRY_BYTES` in `src/gateway.ts`; `tests/client-bundle-imports.test.ts` keeps them equal).
 */
export const OWNED_BOOT_BUNDLE_LIMIT = 8 * 1024 * 1024

/**
 * Largest customization asset the gateway serves
 * (`LEGACY_CUSTOM_ASSET_LIMIT` in `src/extension-limits.ts`; the same test keeps them equal).
 */
export const CUSTOMIZATION_ASSET_LIMIT = 256 * 1024

/** The limit of the route that serves each gateway-owned bundle. */
export const OWNED_BUNDLE_LIMITS = Object.freeze({
  'mobile-graph-follower.js': OWNED_BOOT_BUNDLE_LIMIT,
  'mobile-layout.js': CUSTOMIZATION_ASSET_LIMIT,
  'mobile-compat.js': CUSTOMIZATION_ASSET_LIMIT,
})

/**
 * Refuse an owned boot bundle the gateway would decline to serve.
 * @param bytes - size of the built bundle.
 * @param limit - largest body the gateway serves for this asset.
 * @param label - bundle path for the error.
 * @returns nothing; throws when the bundle exceeds the limit.
 */
export function checkOwnedBundleSize(bytes, limit, label) {
  if (bytes > limit) {
    throw new Error(`${label} is ${bytes} bytes; the gateway serves an owned boot bundle only up to ${limit} bytes`)
  }
}

/**
 * Refuse imports the browser's DSH module loader cannot supply.
 * @param source - generated client bundle.
 * @param runtimeDependencies - packages shipped as npm runtime dependencies, not DSH client providers.
 * @returns nothing; throws for Node builtins or unbundled runtime package imports.
 */
export function checkClientBundleImports(source, runtimeDependencies = []) {
  const imports = [...source.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/gu)].map(match => match[2])
  const builtins = imports.filter(specifier => isBuiltin(specifier))
  if (builtins.length > 0) {
    throw new Error(`Browser client bundle imports Node builtins: ${[...new Set(builtins)].join(', ')}`)
  }
  const unbundled = imports.filter(specifier => runtimeDependencies.some(name => specifier === name || specifier.startsWith(name + '/')))
  if (unbundled.length > 0) {
    throw new Error(`Browser client runtime dependencies must be bundled: ${[...new Set(unbundled)].join(', ')}`)
  }
}

/**
 * Refuse imports of modules the DSH page's module loader does not supply to an owned boot bundle.
 * Minified bundles rename the loader's `require` parameter, so read the name from the banner.
 * @param source - generated boot bundle.
 * @param supplied - module ids the DSH page supplies to this row; the bundle must take at least one.
 * @returns nothing; throws for Node builtins, any other module id, or a bundle that takes none of them.
 */
export function checkOwnedBundleImports(source, supplied = []) {
  const loader = /factory:\s*([A-Za-z_$][\w$]*)\s*=>/u.exec(source)?.[1] ?? 'require'
  const calls = new RegExp('(?<![\\w$])' + loader.replace(/\$/gu, '\\$') + '\\s*\\(\\s*([\'"`])([^\'"`]+)\\1\\s*\\)', 'gu')
  const imports = [...source.matchAll(calls)].map(match => match[2])
  if (imports.length === 0) {
    throw new Error(`Owned boot bundle imports none of the modules the DSH page supplies: ${supplied.join(', ')}`)
  }
  const builtins = imports.filter(specifier => isBuiltin(specifier))
  if (builtins.length > 0) {
    throw new Error(`Browser client bundle imports Node builtins: ${[...new Set(builtins)].join(', ')}`)
  }
  const unsupplied = imports.filter(specifier => !supplied.includes(specifier))
  if (unsupplied.length > 0) {
    throw new Error(`Owned boot bundle imports modules the DSH page does not supply: ${[...new Set(unsupplied)].join(', ')}`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  checkClientBundleImports(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), Object.keys(manifest.dependencies ?? {}))
  const ownedBundle = async (name, limit) => {
    const url = new URL(`../lib/${name}`, import.meta.url)
    const info = await stat(url).catch((error) => { if (error.code === 'ENOENT') return undefined; throw error })
    if (!info) throw new Error(`lib/${name} was not built`)
    checkOwnedBundleSize(info.size, limit, `lib/${name}`)
    return readFile(url, 'utf8')
  }
  for (const [name, limit] of Object.entries(OWNED_BUNDLE_LIMITS)) await ownedBundle(name, limit)
  // The DSH page supplies these two to the stock client row, and so to Mobile's follower.
  checkOwnedBundleImports(await ownedBundle('mobile-graph-follower.js', OWNED_BOOT_BUNDLE_LIMIT), ['@deepseek-ai/dsh-api-gateway/client', 'zod'])
}
