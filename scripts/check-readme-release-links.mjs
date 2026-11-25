#!/usr/bin/env node
/**
 * Assert that the README download links point at the versions this tree declares.
 *
 * The documents carry literal release URLs, so every version bump makes them stale
 * without anything failing: a README kept pointing at `windows-v0.1.0-alpha` after
 * the client moved to 0.1.1-alpha, and another linked a `setup.exe` on a release
 * that had been published before the installer existed. Both render as working links
 * and both break for the reader, so the release procedure checks them instead of
 * trusting the last edit.
 *
 * The offline rule is what catches the common mistake: a `releases/download/<tag>/…`
 * or `releases/tag/<tag>` link must name one of the three track versions declared in
 * this tree, and the asset file name must carry that same version. `--online` also
 * asks GitHub whether the release and each asset actually exist, which is what proves
 * a link resolves rather than merely looking plausible.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(resolve(root, path), 'utf8')

const PLUGIN_VERSION = JSON.parse(read('package.json')).version
const ANDROID_VERSION = JSON.parse(read('apps/mobile/release.json')).version
const WINDOWS_VERSION = /<Version>([^<]+)<\/Version>/u.exec(
  read('apps/windows/DshMobile.Win/DshMobile.Win.csproj'),
)?.[1]?.trim()

if (typeof WINDOWS_VERSION !== 'string' || WINDOWS_VERSION === '') {
  console.error('readme release links failed: the client project declares no <Version>')
  process.exit(1)
}

/** Track tag -> the version string the tag must equal. */
const tracks = new Map([
  [`v${PLUGIN_VERSION}`, PLUGIN_VERSION],
  [`android-v${ANDROID_VERSION}`, ANDROID_VERSION],
  [`windows-v${WINDOWS_VERSION}`, WINDOWS_VERSION],
])

const documents = [
  'README.md',
  'README.en.md',
  'apps/windows/README.md',
  'apps/windows/README.en.md',
]

const problems = []
/** tag -> Set of asset names the documents link. */
const linked = new Map()

for (const document of documents) {
  const text = read(document)
  for (const [index, raw] of text.split('\n').entries()) {
    for (const match of raw.matchAll(/releases\/(download|tag)\/([A-Za-z0-9._-]+)(?:\/([A-Za-z0-9._-]+))?/gu)) {
      const [, kind, tag, asset] = match
      const where = `${document}:${index + 1}`

      if (!tracks.has(tag)) {
        const known = [...tracks.keys()].join(', ')
        problems.push(`${where}: ${tag} is not this tree's release tag (${known})`)
        continue
      }

      if (kind === 'tag') continue

      if (asset === undefined) {
        problems.push(`${where}: ${tag} is linked without an asset name`)
        continue
      }

      // The version, not just the track prefix: a copied URL keeps the old number in
      // its file name when the tag is edited by hand.
      const version = tracks.get(tag)
      if (!asset.includes(version)) {
        problems.push(`${where}: asset ${asset} does not carry version ${version}`)
      }

      if (!linked.has(tag)) linked.set(tag, new Set())
      linked.get(tag).add(asset)
    }
  }
}

if (problems.length > 0) {
  console.error(`readme release links failed: ${problems.length} stale or inconsistent link(s)`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

const summary = [...linked.entries()]
  .map(([tag, assets]) => `${tag} (${assets.size} asset${assets.size === 1 ? '' : 's'})`)
  .join(', ')
console.log(`readme release links ok: ${documents.length} documents, ${summary}`)

if (!process.argv.includes('--online')) process.exit(0)

// Opt-in: confirm the release and its assets exist. Used after publication, when
// pointing at the new tag is correct but only the remote can say it resolves.
const online = []
for (const [tag, assets] of linked) {
  let release
  try {
    const output = execFileSync('gh', [
      'release', 'view', tag, '--repo', 'saya-ch/dsh-mobile', '--json', 'assets,isDraft,tagName',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    release = JSON.parse(output)
  } catch (error) {
    online.push(`${tag}: cannot read the release (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`)
    continue
  }
  if (release.isDraft) {
    online.push(`${tag}: the release is still a draft`)
    continue
  }
  const present = new Set(release.assets.map(entry => entry.name))
  for (const asset of assets) {
    if (!present.has(asset)) online.push(`${tag}: the release has no asset ${asset}`)
  }
}

if (online.length > 0) {
  console.error(`readme release links failed online: ${online.length} problem(s)`)
  for (const problem of online) console.error(`  ${problem}`)
  process.exit(1)
}
console.log(`readme release links ok online: ${linked.size} release(s) resolve with their assets`)
