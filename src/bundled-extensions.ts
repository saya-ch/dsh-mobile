import { cp, lstat, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Extension ids shipped inside the dsh-mobile package itself. */
export const BUNDLED_EXTENSION_IDS = Object.freeze(['wallpaper'] as const)

/** Directory holding the bundled extension sources (repo `extensions/`, package root after build). */
export function bundledExtensionsRoot(): string {
  return fileURLToPath(new URL('../extensions', import.meta.url))
}

/**
 * Copy bundled extensions into the user state directory on first run.
 * An extension whose `extension.json` already exists is never touched, so
 * user edits are never overwritten; delete the directory to restore defaults.
 * Only the pack's `mobile/` payload is seeded; sibling content (such as the
 * desktop userstyle) stays repo-side and out of the asset pipeline.
 */
export async function seedBundledExtensions(
  extensionsDir: string,
  log?: (event: string, fields: Readonly<Record<string, string | number | boolean>>) => void,
): Promise<readonly string[]> {
  const seeded: string[] = []
  for (const id of BUNDLED_EXTENSION_IDS) {
    const target = join(extensionsDir, id)
    try {
      const manifest = await lstat(join(target, 'extension.json'))
      if (manifest.isFile()) continue
    } catch {
      // Missing manifest: fall through to seeding.
    }
    // A directory without a manifest is not a loadable extension; replace it
    // wholesale instead of merging, so a broken install cannot linger.
    await rm(target, { recursive: true, force: true })
    await mkdir(extensionsDir, { recursive: true })
    await cp(join(bundledExtensionsRoot(), id, 'mobile'), target, { recursive: true })
    log?.('bundled-extension-seeded', { id })
    seeded.push(id)
  }
  return Object.freeze(seeded)
}
