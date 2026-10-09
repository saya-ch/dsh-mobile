import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { restrictPrivateFile } from './private-file.js'

/** Refuse link-shaped ancestors within the owned state root before filesystem operations. */
export async function assertCaddyParents(root: string, target: string): Promise<void> {
  const parent = resolve(root)
  const candidate = resolve(target)
  const offset = relative(parent, candidate)
  if (!isAbsolute(root) || (offset !== '' && (offset.startsWith('..') || isAbsolute(offset)))) throw new Error('caddy_path_invalid')
  const paths = [parent]
  let cursor = parent
  for (const segment of relative(parent, dirname(candidate)).split(/[\\/]/u).filter(Boolean)) {
    cursor = join(cursor, segment); paths.push(cursor)
  }
  for (const path of paths) {
    let entry
    try { entry = await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('caddy_path_invalid')
  }
}

/** Windows may briefly keep inspected executables busy after their process exits.
 * Retry only EPERM/EBUSY mutations, never other errors or safety checks.
 * Eight attempts wait at most 1,950ms; exhaustion retains the first OS error.
 */
async function mutateCaddyPath(validate: () => Promise<void>, mutate: () => Promise<void>): Promise<void> {
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

/** Atomically move an owned path, rechecking both real parent chains on every attempt. */
export async function renameCaddyPath(root: string, source: string, destination: string): Promise<void> {
  await mutateCaddyPath(async () => {
    await assertCaddyParents(root, source)
    await assertCaddyParents(root, destination)
  }, () => rename(source, destination))
}

/** Create a private real directory, never traversing a link owned by the component. */
export async function ensureCaddyDirectory(root: string, directory: string): Promise<void> {
  await assertCaddyParents(root, directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const entry = await lstat(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('caddy_path_invalid')
  await restrictPrivateFile(directory, 0o700)
}

/** Atomically replace one private configuration file under a real owned directory. */
export async function writeCaddyPrivateFile(root: string, file: string, body: string): Promise<void> {
  await ensureCaddyDirectory(root, dirname(file))
  try {
    const entry = await lstat(file)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('caddy_config_target_invalid')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(dirname(file), '.' + basename(file) + '.' + randomBytes(12).toString('hex') + '.tmp')
  let failed = false
  try {
    await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await restrictPrivateFile(temporary)
    await renameCaddyPath(root, temporary, file)
  } catch (error) { failed = true; throw error } finally {
    try { await removeCaddyTree(root, temporary) } catch (error) { if (!failed) throw error }
  }
}

/** Delete only owned entries; junctions and symlinks are unlinked, never descended into. */
export async function removeCaddyTree(root: string, target: string): Promise<void> {
  await assertCaddyParents(root, target)
  let entry
  try { entry = await lstat(target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    await mutateCaddyPath(() => assertCaddyParents(root, target), () => unlink(target))
    return
  }
  for (const name of await readdir(target)) await removeCaddyTree(root, join(target, name))
  await mutateCaddyPath(() => assertCaddyParents(root, target), () => rmdir(target))
}
