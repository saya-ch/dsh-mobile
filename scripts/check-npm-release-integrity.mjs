/** Reconcile an occupied npm version with the exact candidate tarball before GitHub publication. */
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/**
 * Compare immutable npm metadata with candidate bytes.
 * @param bytes - exact candidate tarball bytes.
 * @param metadata - parsed npm registry version record.
 * @param version - version selected by the release tag.
 * @returns matching sha512 integrity, or throws for any disagreement.
 */
export function verifyPublishedPlugin(bytes, metadata, version, name = 'dsh-mobile') {
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (metadata?.name !== name || metadata.version !== version
    || metadata.dist?.integrity !== integrity) {
    throw new Error(`Occupied npm version ${name}@${version} does not match the candidate tarball; publication must stop`)
  }
  return integrity
}

/**
 * Read public registry metadata; only a genuine 404 permits a new publication.
 * @param bytes - candidate tarball bytes.
 * @param version - version selected by the release tag.
 * @param request - Fetch implementation for the public registry.
 * @returns published if immutable bytes match, otherwise unpublished on 404.
 */
export async function checkPluginPublication(bytes, version, request = fetch, name = 'dsh-mobile') {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error('Invalid plugin release version')
  }
  if (typeof name !== 'string' || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(name)) {
    throw new Error('Invalid npm package name')
  }
  const response = await request(`https://registry.npmjs.org/${name}/${encodeURIComponent(version)}`, {
    redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' },
  })
  if (response.status === 404) {
    await response.body?.cancel()
    return 'unpublished'
  }
  if (response.status !== 200) {
    await response.body?.cancel()
    throw new Error(`npm registry metadata failed with HTTP ${response.status}; publication must stop`)
  }
  verifyPublishedPlugin(bytes, await response.json(), version, name)
  return 'published'
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, version, name, ...extra] = process.argv.slice(2)
  if (file === undefined || version === undefined || extra.length !== 0) throw new Error('Expected candidate tarball and release version')
  const metadata = await lstat(file)
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Candidate tarball is not a regular file')
  console.log(await checkPluginPublication(await readFile(file), version, fetch, name ?? 'dsh-mobile'))
}
