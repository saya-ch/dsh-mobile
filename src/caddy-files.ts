import { assertManagedParents, ensureManagedDirectory, removeManagedTree, renameManagedPath, writeManagedPrivateFile } from './managed-files.js'

/** Refuse link-shaped ancestors within Caddy's owned state root. */
export async function assertCaddyParents(root: string, target: string): Promise<void> {
  await assertManagedParents(root, target, 'caddy')
}

/** Move a Caddy-owned path, preserving bounded Windows retries and ownership checks. */
export async function renameCaddyPath(root: string, source: string, destination: string): Promise<void> {
  await renameManagedPath(root, source, destination, 'caddy')
}

/** Create a real Caddy directory, securing fresh directories and preserving existing ACLs. */
export async function ensureCaddyDirectory(root: string, directory: string): Promise<void> {
  await ensureManagedDirectory(root, directory, 'caddy')
}

/** Atomically replace one private Caddy configuration file. */
export async function writeCaddyPrivateFile(root: string, file: string, body: string): Promise<void> {
  await writeManagedPrivateFile(root, file, body, 'caddy')
}

/** Delete only Caddy-owned children; unlink junctions and symlinks themselves. */
export async function removeCaddyTree(root: string, target: string): Promise<void> {
  await removeManagedTree(root, target, 'caddy')
}
