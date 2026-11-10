/**
 * Keep the hand-maintained direct-dependency credit list honest.
 *
 * `THIRD_PARTY_NOTICES.md` is edited by hand, so a dependency added, removed or
 * re-ranged in `package.json` can silently drift out of the published notices.
 * This check fails closed when a declared direct dependency is not named in the
 * notices, when its declared range does not appear in the same paragraph, or
 * when a notices file is no longer part of the npm package.
 *
 * Read-only: it never rewrites the notice, the manifest or the package files.
 */
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED_PACKAGE_FILES = Object.freeze(['THIRD_PARTY_NOTICES.md', 'FUNNEL_THIRD_PARTY_LICENSES.txt'])

/** Collapse inline-code markers and whitespace so one declared range compares as a token. */
function normalize(text) {
  return text.replaceAll('`', '').replace(/\s+/gu, ' ').trim()
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Blank-line separated blocks: a credited dependency and its range must share one block. */
function noticeParagraphs(markdown) {
  return markdown
    .split(/\r?\n[ \t]*\r?\n/u)
    .map(block => normalize(block))
    .filter(block => block !== '')
}

/** Whether one paragraph names the dependency, with package-token boundaries for bare names. */
function namesDependency(paragraph, name) {
  if (name.startsWith('@') || name.includes('/')) return paragraph.toLowerCase().includes(name.toLowerCase())
  return new RegExp(`(?:^|[^A-Za-z0-9_./-])${escapeRegExp(name)}(?![A-Za-z0-9_./-])`, 'iu').test(paragraph)
}

/** Whether one paragraph states the exact declared range (for example `^3.18.1` or `2.4.0`). */
function statesRange(paragraph, range) {
  // A sentence period may follow the range, but a period that starts a longer
  // version such as `4.6.7.1` is not a boundary.
  return new RegExp(`(?<![0-9A-Za-z.+-])${escapeRegExp(normalize(range))}(?![0-9A-Za-z+-]|\\.[0-9])`, 'iu').test(paragraph)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function main() {
  const manifest = await readJson(resolve(repositoryRoot, 'package.json'))
  const notices = await readFile(resolve(repositoryRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  const dependencies = manifest.dependencies ?? {}
  const paragraphs = noticeParagraphs(notices)
  const problems = []

  for (const [name, range] of Object.entries(dependencies)) {
    const credited = paragraphs.filter(paragraph => namesDependency(paragraph, name))
    if (credited.length === 0) {
      problems.push(`THIRD_PARTY_NOTICES.md does not name ${name}`)
      continue
    }
    if (!credited.some(paragraph => statesRange(paragraph, range))) {
      problems.push(`THIRD_PARTY_NOTICES.md does not state ${name} ${range} in the same paragraph`)
    }
  }

  const packageFiles = Array.isArray(manifest.files) ? manifest.files : []
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!packageFiles.includes(required)) problems.push(`package.json files must include ${required}`)
  }

  if (problems.length > 0) {
    for (const problem of problems) console.error(`third-party notices: ${problem}`)
    process.exitCode = 1
    return
  }
  console.log(`third-party notices ok: ${String(Object.keys(dependencies).length)} dependencies`)
}

main().catch(error => {
  console.error(`Third-party notices check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
