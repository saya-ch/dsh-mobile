#!/usr/bin/env node
/**
 * Assert that every download link and version claim in the project's documents matches this tree.
 *
 * The documents carry literal release URLs and literal version numbers, so a bump makes them
 * stale without anything failing: a README kept pointing at `windows-v0.1.0-alpha` after the
 * client moved to 0.1.1-alpha, and another linked a `setup.exe` on a release published before the
 * installer existed. Both render as working links and both break for the reader.
 *
 * Two rules, because two different mistakes happen:
 *
 *  - A link to one of this repository's three release tracks must name that track's current
 *    version, and a downloaded asset name must carry it too. Links to other repositories and to
 *    fixed component distributions are ignored — those versions belong to their own owners.
 *  - A version the documents state in prose ("当前正式版本：0.9.3", "Android App 0.8.4") must equal
 *    the version this tree declares. A link-only check passed while such a sentence said 0.8.4
 *    after 0.8.5 shipped, which is why the claims are checked here rather than left to review.
 *
 * `--online` additionally asks GitHub whether each release and asset actually exists, which is
 * what proves a link resolves rather than merely looking plausible.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = path => readFileSync(resolve(root, path), 'utf8')

const PLUGIN_VERSION = JSON.parse(read('package.json')).version
const ANDROID_DESCRIPTOR = JSON.parse(read('apps/mobile/release.json'))
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
  [`android-v${ANDROID_DESCRIPTOR.version}`, ANDROID_DESCRIPTOR.version],
  [`windows-v${WINDOWS_VERSION}`, WINDOWS_VERSION],
])

/** This repository's own releases; anything else belongs to another owner. */
const OWN_REPO = 'github.com/saya-ch/dsh-mobile/releases'
/** Fixed component distributions that deliberately keep their own tag and are not a track. */
const COMPONENT_TAG = /^(?:caddy|funnel|iroh)-/u

const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'local', 'build', 'dist', 'bin', 'obj',
])

/** Every Markdown document the project maintains, build output and caches excluded. */
function collectDocuments(directory = root, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.agent') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue
      // Android build trees carry vendored dependency documentation and are not ours.
      if (relative(root, path).split('\\').join('/').includes('app/build')) continue
      collectDocuments(path, found)
      continue
    }
    if (!entry.name.endsWith('.md')) continue
    found.push(relative(root, path).split('\\').join('/'))
  }
  return found.sort()
}

const documents = collectDocuments()

const problems = []
/** tag -> Set of asset names the documents link. */
const linked = new Map()

/** Version claims, mapped to where they must come from. */
const CLAIMS = [
  { pattern: /当前正式版本[：:]\s*([0-9][0-9A-Za-z.-]*)/gu, expected: PLUGIN_VERSION, what: 'plugin' },
  { pattern: /Current stable release:\s*([0-9][0-9A-Za-z.-]*)/gu, expected: PLUGIN_VERSION, what: 'plugin' },
  { pattern: /<b>Android App\s+([0-9][0-9A-Za-z.-]*)<\/b>/gu, expected: ANDROID_DESCRIPTOR.version, what: 'Android' },
  { pattern: /<b>Windows 客户端\s+([0-9][0-9A-Za-z.-]*)<\/b>/gu, expected: WINDOWS_VERSION, what: 'Windows client' },
  { pattern: /<b>Windows client\s+([0-9][0-9A-Za-z.-]*)<\/b>/gu, expected: WINDOWS_VERSION, what: 'Windows client' },
  { pattern: /alpha 预览[^)）]*?当前\s*`([0-9][0-9A-Za-z.-]*)`/gu, expected: WINDOWS_VERSION, what: 'Windows client' },
  { pattern: /alpha preview[^)）]*?currently\s*`([0-9][0-9A-Za-z.-]*)`/gu, expected: WINDOWS_VERSION, what: 'Windows client' },
]

for (const document of documents) {
  const text = read(document)
  for (const [index, raw] of text.split('\n').entries()) {
    const where = `${document}:${index + 1}`

    for (const match of raw.matchAll(/releases\/(download|tag)\/([A-Za-z0-9._-]+)(?:\/([A-Za-z0-9._%-]+))?/gu)) {
      const [, kind, tag, asset] = match

      // Only this repository's releases are ours to keep current. Another project's tag
      // (frp, a dependency) and a fixed component distribution are not a version claim.
      if (!raw.includes(OWN_REPO)) continue
      if (COMPONENT_TAG.test(tag)) continue

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

      // The version, not just the track prefix: a copied URL keeps the old number in its
      // file name when the tag is edited by hand.
      const version = tracks.get(tag)
      if (!asset.includes(version)) {
        problems.push(`${where}: asset ${asset} does not carry version ${version}`)
      }

      if (!linked.has(tag)) linked.set(tag, new Set())
      linked.get(tag).add(asset)
    }

    for (const claim of CLAIMS) {
      claim.pattern.lastIndex = 0
      for (const match of raw.matchAll(claim.pattern)) {
        if (match[1] !== claim.expected) {
          problems.push(`${where}: ${claim.what} version says ${match[1]}, this tree declares ${claim.expected}`)
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`readme release links failed: ${problems.length} stale or inconsistent claim(s)`)
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
