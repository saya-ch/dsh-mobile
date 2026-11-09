// Check that contributor credits in the tracked Markdown match the real authors
// of the issues and pull requests they cite.
//
// Two released credits were wrong: issue 97 was credited to an unrelated handle
// and PR 191 to the wrong contributor. Both shipped in published documentation,
// so the check compares every "@handle" with the GitHub author of the number
// that follows it in the same clause.
//
// Usage:
//   npm run check:attribution               # uses the cached index when it is fresh
//   npm run check:attribution -- --refresh  # refetch the issue index
//   npm run check:attribution -- --self-test
//
// The index is fetched from the GitHub API through `gh` when it is available, or
// with a GITHUB_TOKEN/GH_TOKEN. It is cached under local/ so repeated runs do
// not consume API quota. This check needs network access and is therefore a
// pre-release step, not part of `npm run verify`.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cacheFile = path.join(root, 'local', 'attribution-index.json')
const cacheMaxAgeMs = 6 * 60 * 60 * 1000

const args = process.argv.slice(2)
const refresh = args.includes('--refresh')
const selfTest = args.includes('--self-test')

/** Combinations that a human reviewed and confirmed are not errors. */
const reviewed = [
  {
    num: 211,
    handle: 'GavinQiEr',
    reason: '#211 is the maintainer integration PR; the same sentence states that it keeps the original author commits'
  }
]

/**
 * Pair every "@handle" with the numbers that follow it in the same clause.
 * A handle owns only the text up to the next handle, so "@A's #1 and @B's #2"
 * cannot be read as "@A -> #2".
 */
function collectFindings (documents, index) {
  const findings = []
  let pairs = 0
  for (const document of documents) {
    const lines = document.text.split(/\r?\n/)
    lines.forEach((raw, lineNumber) => {
      const handles = [...raw.matchAll(/@([A-Za-z0-9_-]{2,})\b/g)]
      if (handles.length === 0) return
      handles.forEach((match, position) => {
        const start = match.index + match[0].length
        const end = position + 1 < handles.length ? handles[position + 1].index : raw.length
        for (const reference of raw.slice(start, end).matchAll(/\[(?:PR |Issue )?#(\d+)\]/g)) {
          const number = Number(reference[1])
          const handle = match[1]
          const entry = index[number]
          pairs += 1
          if (entry === undefined) {
            findings.push({ kind: 'missing', relative: document.path, lineNumber, number, handle, actual: '(no such issue or pull request)' })
            continue
          }
          if (handle.toLowerCase() !== entry.author.toLowerCase()) {
            findings.push({
              kind: 'mismatch',
              relative: document.path,
              lineNumber,
              number,
              handle,
              actual: entry.author,
              isPullRequest: entry.isPullRequest === true,
              title: entry.title
            })
          }
        }
      })
    })
  }
  return { findings, pairs }
}

function isReviewed (finding) {
  return reviewed.some((entry) => entry.num === finding.number && entry.handle.toLowerCase() === finding.handle.toLowerCase())
}

function runSelfTest () {
  const index = {
    1: { author: 'alpha', isPullRequest: false, title: 'first' },
    2: { author: 'beta', isPullRequest: true, title: 'second' }
  }
  const documents = [
    { path: 'good.md', text: 'Thanks @alpha for [#1](https://example.invalid/1) and @beta for [PR #2](https://example.invalid/2).\n' },
    { path: 'wrong.md', text: 'Thanks @alpha for [PR #2](https://example.invalid/2).\n' },
    { path: 'missing.md', text: 'Thanks @alpha for [#99](https://example.invalid/99).\n' }
  ]
  const { findings } = collectFindings(documents, index)
  const mismatches = findings.filter((finding) => finding.kind === 'mismatch' && !isReviewed(finding))
  const missing = findings.filter((finding) => finding.kind === 'missing')
  const failures = []
  if (mismatches.length !== 1 || mismatches[0].number !== 2) failures.push('a wrong author was not detected')
  if (mismatches[0]?.relative !== 'wrong.md') failures.push('the wrong document was not reported')
  if (missing.length !== 1 || missing[0].number !== 99) failures.push('an unknown reference was not detected')
  const boundary = collectFindings(
    [{ path: 'boundary.md', text: "@alpha's [#1](https://example.invalid/1) and @beta's [#2](https://example.invalid/2)\n" }],
    index
  )
  if (boundary.findings.length !== 0) failures.push('the next handle did not end the previous clause')
  if (failures.length > 0) {
    for (const failure of failures) console.error(`attribution self-test failed: ${failure}`)
    process.exit(1)
  }
  console.log('attribution self-test passed: wrong authors, unknown references and clause boundaries are detected')
}

if (selfTest) {
  runSelfTest()
} else {
  await main()
}

async function main () {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? ''
  const repositoryUrl = repository.replace(/^git\+/, '').replace(/\.git$/, '')
  const repoMatch = repositoryUrl.match(/github\.com[/:]([^/]+\/[^/.]+)$/)
  if (repoMatch === null) {
    console.error('attribution check: cannot determine the GitHub repository from package.json')
    process.exit(2)
  }
  const repo = repoMatch[1]

  function ghAvailable () {
    return spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0
  }

  async function requestPage (page) {
    const query = `repos/${repo}/issues?state=all&per_page=100&page=${page}`
    let lastError
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        if (ghAvailable()) {
          return execFileSync('gh', ['api', query], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        }
        const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
        if (token === undefined) {
          console.error('attribution check: no `gh` CLI and no GITHUB_TOKEN/GH_TOKEN; cannot read the issue index')
          process.exit(2)
        }
        const response = await fetch(`https://api.github.com/${query}`, {
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'dsh-mobile-attribution-check' }
        })
        if (!response.ok) throw new Error(`GitHub API returned ${response.status}`)
        return await response.text()
      } catch (error) {
        lastError = error
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 2000))
      }
    }
    console.error(`attribution check: cannot read ${query} — ${lastError instanceof Error ? lastError.message : String(lastError)}`)
    process.exit(2)
  }

  function readCache () {
    try {
      const stat = fs.statSync(cacheFile)
      if (!refresh && Date.now() - stat.mtimeMs < cacheMaxAgeMs) {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      }
    } catch {
      // no usable cache
    }
    return undefined
  }

  async function loadIndex () {
    const cached = readCache()
    if (cached !== undefined) return cached
    const index = {}
    for (let page = 1; page <= 10; page += 1) {
      const items = JSON.parse(await requestPage(page))
      if (!Array.isArray(items)) {
        console.error(`attribution check: unexpected response for page ${page}`)
        process.exit(2)
      }
      for (const item of items) {
        index[item.number] = { author: item.user?.login ?? '', isPullRequest: item.pull_request !== undefined, title: item.title ?? '' }
      }
      if (items.length < 100) break
    }
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify(index))
    console.error(`attribution check: fetched ${Object.keys(index).length} issues and pull requests into ${path.relative(root, cacheFile)}`)
    return index
  }

  const index = await loadIndex()
  const tracked = execFileSync('git', ['ls-files', '*.md'], { cwd: root, encoding: 'utf8' }).split('\n').filter((line) => line !== '')
  const documents = tracked.map((relative) => ({ path: relative, text: fs.readFileSync(path.join(root, relative), 'utf8') }))
  const { findings, pairs } = collectFindings(documents, index)

  const active = findings.filter((finding) => !isReviewed(finding))
  const mismatches = active.filter((finding) => finding.kind === 'mismatch')
  const missing = active.filter((finding) => finding.kind === 'missing')
  const suppressed = findings.filter(isReviewed)

  console.log(`attribution check: ${tracked.length} Markdown files, ${pairs} handle/number pairs, ${Object.keys(index).length} indexed issues and pull requests`)

  if (active.length === 0) {
    console.log('attribution check passed: every credited handle matches the referenced author')
    return
  }

  for (const finding of active) {
    if (finding.kind === 'mismatch') {
      console.error(`${finding.relative}:${finding.lineNumber}  #${finding.number} credited to @${finding.handle} but authored by @${finding.actual}${finding.title === '' ? '' : ` (${finding.title})`}`)
    } else {
      console.error(`${finding.relative}:${finding.lineNumber}  #${finding.number} does not exist in ${repo} but is credited to @${finding.handle}`)
    }
  }
  for (const finding of suppressed) {
    const entry = reviewed.find((candidate) => candidate.num === finding.number && candidate.handle.toLowerCase() === finding.handle.toLowerCase())
    console.log(`attribution check: #${finding.number} @${finding.handle} reviewed and accepted — ${entry.reason}`)
  }
  console.error(`attribution check failed: ${mismatches.length} wrong author(s), ${missing.length} unknown reference(s)`)
  process.exit(1)
}
