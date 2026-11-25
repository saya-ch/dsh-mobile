#!/usr/bin/env node
/**
 * Compare the published iroh companion package with the pins this plugin carries.
 *
 * The plugin downloads each host sidecar from unpkg and verifies its byte count and
 * SHA-256 before running it, so those numbers must describe the bytes that are
 * actually published. CI rebuilds the macOS binaries on every release, and a rebuild
 * is not guaranteed to be byte-identical, so the pins have to be read back from the
 * published tarball rather than assumed from an earlier build.
 *
 * Usage: node scripts/check-iroh-component-pins.mjs [--version <x.y.z>]
 * Exits non-zero and prints the correct pins when the published bytes disagree.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const versionFlag = process.argv.indexOf('--version')
const requested = versionFlag >= 0 ? process.argv[versionFlag + 1] : undefined

const source = readFileSync(resolve(root, 'src/iroh-component.ts'), 'utf8')
const versionMatch = /export const IROH_VERSION = '([^']+)'/u.exec(source)
if (versionMatch?.[1] === undefined) throw new Error('cannot read IROH_VERSION')
const version = requested ?? versionMatch[1]

// Read the pins the plugin ships.
const pins = new Map()
const pinPattern = /'(?<target>[a-z0-9]+-[a-z0-9]+)': Object\.freeze\(\{(?<body>[^}]*)\}\)/gu
for (const entry of source.matchAll(pinPattern)) {
  const body = entry.groups.body
  const bytes = /downloadBytes: (?<bytes>\d+)/u.exec(body)?.groups.bytes
  const sha = /downloadSha256: '(?<sha>[a-f0-9]{64})'/u.exec(body)?.groups.sha
  const url = /downloadUrl: '(?<url>[^']+)'/u.exec(body)?.groups.url
  if (bytes && sha && url) {
    pins.set(entry.groups.target, { bytes: Number(bytes), sha256: sha, url })
  }
}

if (pins.size === 0) throw new Error('no pins found in src/iroh-component.ts')

const manifestUrl = `https://unpkg.com/dsh-mobile-iroh@${version}/native/manifest.json`
console.log(`published manifest: ${manifestUrl}`)
const response = await fetch(manifestUrl, { redirect: 'follow' })
if (!response.ok) throw new Error(`manifest fetch failed: HTTP ${response.status}`)
const manifest = await response.json()

if (manifest.packageVersion !== version) {
  throw new Error(`manifest is for ${manifest.packageVersion}, expected ${version}`)
}

const targets = Object.keys(manifest.artifacts ?? {})
console.log(`published targets: ${targets.join(', ')}`)

let mismatches = 0
const corrections = []

for (const [target, pin] of [...pins].sort()) {
  const published = manifest.artifacts?.[target]
  if (published === undefined) {
    console.error(`MISSING  ${target}: the plugin pins it but the package does not ship it`)
    mismatches += 1
    continue
  }
  const sameBytes = published.bytes === pin.bytes
  const sameSha = published.sha256 === pin.sha256
  if (sameBytes && sameSha) {
    console.log(`ok       ${target}: ${pin.bytes} bytes ${pin.sha256.slice(0, 12)}…`)
    continue
  }
  mismatches += 1
  console.error(`MISMATCH ${target}`)
  console.error(`  plugin:    ${pin.bytes} bytes ${pin.sha256}`)
  console.error(`  published: ${published.bytes} bytes ${published.sha256}`)
  corrections.push({ target, ...published })
}

for (const target of targets) {
  if (!pins.has(target)) {
    console.log(`note     ${target}: published but not pinned by this plugin build`)
  }
}

if (mismatches > 0) {
  console.error(`\n${mismatches} pin(s) disagree with the published package.`)
  console.error('Update src/iroh-component.ts with these values:')
  for (const fix of corrections) {
    console.error(`  ${fix.target}: downloadBytes ${fix.bytes}, downloadSha256 '${fix.sha256}'`)
  }
  process.exit(1)
}

console.log(`\nall ${pins.size} pins match dsh-mobile-iroh@${version}`)

// Cross-check the artifact bytes themselves, not only the manifest's claim about them.
if (process.argv.includes('--verify-bytes')) {
  for (const [target, pin] of [...pins].sort()) {
    const url = `https://unpkg.com/dsh-mobile-iroh@${version}/native/${pin.url.split('/native/')[1]}`
    const artifact = await fetch(url, { redirect: 'follow' })
    if (!artifact.ok) {
      console.error(`DOWNLOAD FAILED ${target}: HTTP ${artifact.status}`)
      process.exit(1)
    }
    const bytes = Buffer.from(await artifact.arrayBuffer())
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== pin.bytes || digest !== pin.sha256) {
      console.error(`BYTES DISAGREE ${target}: got ${bytes.length} bytes ${digest}`)
      process.exit(1)
    }
    console.log(`verified ${target}: ${bytes.length} bytes ${digest.slice(0, 12)}…`)
  }
}
