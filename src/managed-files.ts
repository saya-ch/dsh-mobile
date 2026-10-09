import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { restrictPrivateFile } from './private-file.js'

/** Refuse link-shaped ancestors inside an owned state root before accessing a child. */
export async function assertManagedParents(root: string, target: string, prefix: string): Promise<void> {
  const parent = resolve(root)
  const candidate = resolve(target)
  const offset = relative(parent, candidate)
  if (!isAbsolute(root) || (offset !== '' && (offset.startsWith('..') || isAbsolute(offset)))) throw new Error(`${prefix}_path_invalid`)
  const paths = [parent]
  let cursor = parent
  if (offset !== '') {
    for (const segment of relative(parent, dirname(candidate)).split(/[\\/]/u).filter(Boolean)) {
      cursor = join(cursor, segment); paths.push(cursor)
    }
  }
  for (const path of paths) {
    let entry
    try { entry = await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${prefix}_path_invalid`)
  }
}

/** Retry Windows handle contention while checking ownership before every mutation. */
async function mutateManagedPath(validate: () => Promise<void>, mutate: () => Promise<void>): Promise<void> {
  let original: unknown
  for (let attempt = 0; ; attempt++) {
    await validate()
    try { await mutate(); return } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY')) throw error
      if (attempt === 0) original = error
      if (attempt === 7) throw original
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(50 * 2 ** attempt, 400)))
    }
  }
}

/** Move only owned paths, retaining parent checks on every Windows retry. */
export async function renameManagedPath(root: string, source: string, destination: string, prefix: string): Promise<void> {
  if (resolve(source) === resolve(root) || resolve(destination) === resolve(root)) throw new Error(`${prefix}_path_invalid`)
  await mutateManagedPath(async () => {
    await assertManagedParents(root, source, prefix)
    await assertManagedParents(root, destination, prefix)
  }, () => rename(source, destination))
}

/** Create a real owned directory; secure new directories without changing existing child ACLs. */
export async function ensureManagedDirectory(root: string, directory: string, prefix: string): Promise<void> {
  await assertManagedParents(root, directory, prefix)
  const created = await mkdir(directory, { recursive: true, mode: 0o700 })
  const entry = await lstat(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${prefix}_path_invalid`)
  // Existing directories may contain user-owned children with inherited ACLs.
  // Sensitive new files receive their own ACL before promotion.
  if (created !== undefined) await restrictPrivateFile(directory, 0o700)
}

/** Delete an owned child tree; remove links themselves and never delete the root. */
export async function removeManagedTree(root: string, target: string, prefix: string): Promise<void> {
  if (resolve(target) === resolve(root)) throw new Error(`${prefix}_path_invalid`)
  await assertManagedParents(root, target, prefix)
  let entry
  try { entry = await lstat(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    await mutateManagedPath(() => assertManagedParents(root, target, prefix), () => unlink(target))
    return
  }
  for (const name of await readdir(target)) await removeManagedTree(root, join(target, name), prefix)
  await mutateManagedPath(() => assertManagedParents(root, target, prefix), () => rmdir(target))
}

/** Validate every selected child, then await all deletion work even when one fails. */
export async function removeManagedPaths(root: string, paths: readonly string[], prefix: string): Promise<void> {
  for (const path of paths) {
    if (resolve(path) === resolve(root)) throw new Error(`${prefix}_path_invalid`)
    await assertManagedParents(root, path, prefix)
  }
  const results = await Promise.allSettled(paths.map(path => removeManagedTree(root, path, prefix)))
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason as unknown)
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, `${prefix}_cleanup_failed`)
}

/** Atomically replace one sensitive file beneath real owned directories. */
export async function writeManagedPrivateFile(root: string, file: string, body: string, prefix: string): Promise<void> {
  await ensureManagedDirectory(root, dirname(file), prefix)
  try {
    const entry = await lstat(file)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${prefix}_config_target_invalid`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(dirname(file), '.' + basename(file) + '.' + randomBytes(12).toString('hex') + '.tmp')
  let failed = false
  try {
    await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await restrictPrivateFile(temporary)
    await renameManagedPath(root, temporary, file, prefix)
  } catch (error) { failed = true; throw error } finally {
    try { await removeManagedTree(root, temporary, prefix) } catch (error) { if (!failed) throw error }
  }
}

/** Filesystem operations used to exercise publication failures without downloading artifacts. */
export interface ManagedPublicationOperations {
  readonly move?: (source: string, destination: string) => Promise<void>
  readonly remove?: (target: string) => Promise<void>
}

/** Promote a verified directory, restoring the previous version if promotion fails. */
export async function replaceManagedDirectory(
  root: string, target: string, candidate: string, prefix: string,
  operations: ManagedPublicationOperations = {},
): Promise<void> {
  if (resolve(target) === resolve(root) || resolve(candidate) === resolve(root)) throw new Error(`${prefix}_path_invalid`)
  const move = async (source: string, destination: string): Promise<void> => {
    await assertManagedParents(root, source, prefix)
    await assertManagedParents(root, destination, prefix)
    if (operations.move === undefined) await renameManagedPath(root, source, destination, prefix)
    else await operations.move(source, destination)
  }
  const remove = operations.remove ?? (path => removeManagedTree(root, path, prefix))
  const backup = join(dirname(target), `.${basename(target)}.previous-${randomBytes(12).toString('hex')}`)
  let previous = false
  let promoted = false
  try {
    await assertManagedParents(root, join(candidate, 'publication-check'), prefix)
    await assertManagedParents(root, target, prefix)
    try {
      const entry = await lstat(target)
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`${prefix}_path_invalid`)
      await move(target, backup)
      previous = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await move(candidate, target)
      promoted = true
    } catch (error) {
      if (previous) {
        try { await move(backup, target); previous = false } catch (restoreError) {
          throw new AggregateError([error, restoreError], `${prefix}_component_replace_failed`)
        }
      }
      throw error
    }
  } finally {
    try { await remove(candidate) } catch (_error) {
      process.emitWarning(`${prefix} candidate cleanup failed`, { code: 'DSH_MOBILE_COMPONENT_CLEANUP_FAILED' })
    }
    if (promoted && previous) {
      try { await remove(backup) } catch (_error) {
        process.emitWarning(`${prefix} previous component cleanup failed`, { code: 'DSH_MOBILE_COMPONENT_CLEANUP_FAILED' })
      }
    }
  }
}
