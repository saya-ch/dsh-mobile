#!/usr/bin/env node
/**
 * Mirror one GitHub release, with its assets, to AtomGit.
 *
 * AtomGit's release API is a mix of three designs, and guessing any part of it
 * fails silently rather than loudly:
 *
 *  - paths are Gitee v5 style, but authentication is the GitLab `PRIVATE-TOKEN`
 *    header (a bearer token answers 401 "token not found");
 *  - a release has no numeric id, only `tag_name`, so everything is addressed by tag;
 *  - an asset is not posted to the release. You first ask for a signed object-store
 *    URL, then PUT the bytes to it with every `x-obs-*` header the response carried.
 *    Drop one and the write can still succeed while the release page never shows
 *    the file.
 *
 * The last point is why this script re-reads the release after uploading and compares
 * sizes. "The upload returned 200" is not evidence that the asset is downloadable,
 * and an earlier attempt at this mirroring went green for days while nothing arrived.
 *
 * Usage: node scripts/sync-atomgit-release.mjs <tag> [--dry-run]
 * Environment: ATOMGIT_TOKEN (user access token with write access to the mirror),
 *              GH_TOKEN or an authenticated `gh` for the GitHub side.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'

const API = 'https://api.atomgit.com/api/v5'
const OWNER = 'saya-ch'
const REPO = 'dsh-mobile'

const tag = process.argv[2]
const dryRun = process.argv.includes('--dry-run')
if (tag === undefined || tag.startsWith('-')) {
  console.error('usage: sync-atomgit-release.mjs <tag> [--dry-run]')
  process.exit(2)
}

const token = process.env.ATOMGIT_TOKEN
if (token === undefined || token === '') {
  if (!dryRun) {
    console.error('ATOMGIT_TOKEN is not set; refusing to pretend the mirror ran')
    process.exit(1)
  }
}

const auth = token === undefined || token === '' ? {} : { 'PRIVATE-TOKEN': token }

/** Call the AtomGit API, returning the parsed body and the status. */
async function api(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...auth, ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let body
  try { body = text === '' ? undefined : JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

/** Read the GitHub release this mirror is meant to reproduce. */
function readGithubRelease() {
  const raw = execFileSync('gh', [
    'release', 'view', tag,
    '--json', 'tagName,name,body,isPrerelease,isDraft,publishedAt,assets',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return JSON.parse(raw)
}

/** AtomGit answers 404 for a tag with no release, and 200 with the release otherwise. */
async function findAtomgitRelease() {
  const { status, body } = await api(`/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`)
  if (status === 404) return undefined
  if (status !== 200) throw new Error(`AtomGit release lookup failed with ${status}: ${JSON.stringify(body)}`)
  return body
}

async function createAtomgitRelease(release) {
  const { status, body } = await api(
    `/repos/${OWNER}/${REPO}/releases?access_token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: release.tagName,
        name: release.name ?? release.tagName,
        body: release.body ?? '',
        // The tag already exists on AtomGit because the mirror pushes tags; naming it
        // explicitly keeps the release attached to that commit instead of a branch head.
        target_commitish: release.tagName,
        release_status: release.isPrerelease ? 'pre' : 'latest',
      }),
    },
  )
  if (status !== 200 && status !== 201) {
    throw new Error(`AtomGit release creation failed with ${status}: ${JSON.stringify(body)}`)
  }
  return body
}

/** Remove one attachment so a failed upload can be retried under the same name. */
async function deleteAsset(asset) {
  const id = asset.id ?? asset.attach_file_id
  if (id === undefined) {
    throw new Error(`${asset.name} has no attachment id, so the empty placeholder cannot be cleared`)
  }
  const { status, body } = await api(
    `/repos/${OWNER}/${REPO}/releases/${encodeURIComponent(tag)}/attach_files/${id}`
    + `?access_token=${encodeURIComponent(token)}`,
    { method: 'DELETE' },
  )
  if (status !== 200 && status !== 204) {
    throw new Error(`removing the empty ${asset.name} failed with ${status}: ${JSON.stringify(body)}`)
  }
}

/** Ask for a signed object-store target: a URL plus the headers it demands. */
async function requestUploadTarget(fileName) {
  const { status, body } = await api(
    `/repos/${OWNER}/${REPO}/releases/${encodeURIComponent(tag)}/upload_url`
    + `?access_token=${encodeURIComponent(token)}&file_name=${encodeURIComponent(fileName)}`,
  )
  if (status !== 200) throw new Error(`AtomGit upload_url failed with ${status}: ${JSON.stringify(body)}`)
  // The shape differs between deployments; accept the documented keys and the common
  // aliases rather than pinning one spelling.
  const uploadUrl = body?.url ?? body?.upload_url ?? body?.uploadUrl
  const headers = body?.headers ?? body?.header ?? {}
  if (typeof uploadUrl !== 'string') {
    throw new Error(`AtomGit upload_url returned no URL: ${JSON.stringify(body)}`)
  }
  return { uploadUrl, headers }
}

/** Download one GitHub asset to a temporary file, streaming so large archives stay off the heap. */
async function downloadAsset(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok || response.body === null) {
    throw new Error(`downloading ${url} failed with ${response.status}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
  return statSync(destination).size
}

async function uploadAsset(asset, directory) {
  const { uploadUrl, headers } = await requestUploadTarget(asset.name)
  // Every x-obs-* header is part of the signature; passing them through verbatim is the
  // only way the store's callback fires and the asset appears on the release.
  const signed = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  )
  // The signature covers a known length; a chunked stream leaves the store able to
  // accept the write while the callback that publishes the asset never runs.
  const bytes = readFileSync(join(directory, asset.name))
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: signed,
    body: bytes,
  })
  if (!response.ok) {
    throw new Error(`uploading ${asset.name} failed with ${response.status}: ${await response.text()}`)
  }
  return signed
}

const workspace = mkdtempSync(join(tmpdir(), 'atomgit-release-'))
try {
  const release = readGithubRelease()
  console.log(`GitHub release ${release.tagName}: ${release.assets.length} asset(s)`)

  let mirrored = await findAtomgitRelease()
  if (mirrored === undefined) {
    if (dryRun) {
      console.log(`[dry-run] would create the AtomGit release for ${tag}`)
    } else {
      mirrored = await createAtomgitRelease(release)
      console.log(`created the AtomGit release for ${tag}`)
    }
  } else {
    console.log(`the AtomGit release for ${tag} already exists`)
  }

  const existing = new Map((mirrored?.assets ?? []).map(asset => [asset.name, asset]))
  let uploaded = 0
  let skipped = 0

  for (const asset of release.assets) {
    let present = existing.get(asset.name)
    // An asset that is already there with the same size is left alone: re-uploading an
    // existing name is documented to answer success while the old bytes keep serving,
    // which is the failure this whole script exists to avoid.
    if (present !== undefined && Number(present.size) === Number(asset.size)) {
      console.log(`  ${asset.name}: already mirrored (${asset.size} B)`)
      skipped += 1
      continue
    }
    // A zero-byte entry is the leftover of a write whose payload never landed, not a
    // conflict with real content. Clearing it is what lets a retry succeed at all.
    if (present !== undefined && Number(present.size) === 0) {
      if (dryRun) {
        console.log(`  [dry-run] would clear the empty placeholder for ${asset.name} and upload it`)
        continue
      }
      await deleteAsset(present)
      console.log(`  ${asset.name}: cleared a 0 B placeholder left by an earlier upload`)
      present = undefined
    }
    if (present !== undefined) {
      throw new Error(
        `${asset.name} is already on AtomGit with ${present.size} B but GitHub has ${asset.size} B; `
        + 'AtomGit ignores a re-upload of an existing name, so this needs the asset renamed or removed by hand',
      )
    }
    if (dryRun) {
      console.log(`  [dry-run] would upload ${asset.name} (${asset.size} B)`)
      continue
    }
    const local = join(workspace, asset.name)
    const size = await downloadAsset(asset.url, local)
    if (size !== Number(asset.size)) {
      throw new Error(`${asset.name}: GitHub download is ${size} B but the release lists ${asset.size} B`)
    }
    await uploadAsset(asset, workspace)
    uploaded += 1
    console.log(`  ${asset.name}: uploaded (${size} B)`)
  }

  if (dryRun) {
    console.log(`[dry-run] ${release.assets.length} asset(s) considered, nothing written`)
  } else {
    // Re-read instead of trusting the PUT responses: the object store can accept a write
    // whose callback never lands, and then the release page stays empty.
    const verified = await findAtomgitRelease()
    const landed = new Map((verified?.assets ?? []).map(asset => [asset.name, Number(asset.size)]))
    const missing = release.assets.filter(asset => landed.get(asset.name) !== Number(asset.size))
    if (missing.length > 0) {
      throw new Error(
        `AtomGit does not show these assets after the upload: ${missing.map(asset => asset.name).join(', ')}. `
        + 'The object-store callback most likely did not fire; check that every x-obs-* header was forwarded.',
      )
    }
    console.log(`mirror verified: ${release.assets.length} asset(s) on AtomGit, ${uploaded} uploaded, ${skipped} already present`)
  }
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
