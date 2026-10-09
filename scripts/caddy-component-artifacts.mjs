import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { CADDY_BUILD_LOCK as lock, verifyCaddyBuild } from './caddy-component-build-inputs.mjs'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const buildLockSha256 = () => sha256(Buffer.from(JSON.stringify(lock)))
const TARGETS = ['win32-x64', 'linux-x64']
const METADATA = ['manifest.json', 'version.txt', 'modules.txt', 'go-build.json', 'THIRD_PARTY_LICENSES.txt']

export function reviewTag(tag) {
  const prefix = `caddy-component-${lock.core.slice(1)}-tencentcloud-${lock.dns.slice(1)}-review.`
  if (typeof tag !== 'string' || !tag.startsWith(prefix) || !/^[1-9][0-9]*$/u.test(tag.slice(prefix.length))) {
    throw new Error('Expected version-bound non-v component review tag')
  }
  return tag
}

export function releaseIdentity(repository, tag, channel = 'review') {
  if (channel === 'review') {
    reviewTag(tag)
    if (repository !== 'abworks-dev/dsh-mobile') throw new Error('Invalid review repository identity')
  } else if (channel === 'official') {
    if (repository !== 'saya-ch/dsh-mobile' || tag !== `caddy-component-${lock.core.slice(1)}-tencentcloud-${lock.dns.slice(1)}`) {
      throw new Error('Invalid official component identity')
    }
  } else throw new Error('Unknown component release channel')
  return { channel, kind: `managed-caddy-component-${channel}`, environment: `caddy-component-${channel === 'official' ? 'release' : 'review'}` }
}

/** Pure validation shared by early native gates and the publisher; absent inputs are read-only. */
export function publicationRequest({ event, repository, ref, review = 'false', official = 'false', nativeResult, repositoryPrivate }) {
  const enabled = value => value === true || value === 'true'
  if (![true, false, 'true', 'false', ''].includes(review) || ![true, false, 'true', 'false', ''].includes(official)) {
    throw new Error('Invalid publication boolean')
  }
  if (enabled(review) && enabled(official)) throw new Error('Publication channels are mutually exclusive')
  if (!enabled(review) && !enabled(official)) return null
  if (event !== 'workflow_dispatch' || typeof ref !== 'string' || !ref.startsWith('refs/tags/')) throw new Error('Publication requires manual existing tag dispatch')
  if (nativeResult !== undefined && nativeResult !== 'success') throw new Error('Native gates must succeed')
  if (enabled(official) && repositoryPrivate !== false && repositoryPrivate !== 'false') throw new Error('Official publication requires trusted public repository context')
  return releaseIdentity(repository, ref.slice('refs/tags/'.length), enabled(official) ? 'official' : 'review')
}

export function verifyOfficialEnvironment(policy) {
  if (!Array.isArray(policy?.protection_rules) || !policy.protection_rules.some(rule => rule?.type === 'required_reviewers'
    && Array.isArray(rule.reviewers) && rule.reviewers.length > 0 && rule.prevent_self_review === true
    && rule.reviewers.every(assignment => assignment !== null && typeof assignment === 'object' && !Array.isArray(assignment)
      && ['User', 'Team'].includes(assignment.type) && assignment.reviewer !== null
      && typeof assignment.reviewer === 'object' && !Array.isArray(assignment.reviewer)
      && Number.isSafeInteger(assignment.reviewer.id) && assignment.reviewer.id > 0))) {
    throw new Error('Official environment requires nonempty required reviewers and prevention of self review')
  }
}

/** Bind local asset bytes and metadata before copying or publishing; never executes a supplied binary. */
export function verifyArtifact(manifest, build, binary, target) {
  if (!TARGETS.includes(target) || manifest?.platform + '-' + manifest?.arch !== target
    || manifest.version !== lock.core.slice(1) || manifest.dnsPluginVersion !== lock.dns
    || manifest.xcaddyVersion !== lock.xcaddy || manifest.goVersion !== lock.toolchain
    || manifest.sourceProvenanceVerified !== true || manifest.buildLockSha256 !== buildLockSha256()
    || manifest.publication !== 'not-published') throw new Error('Caddy artifact provenance mismatch')
  const executableName = target === 'win32-x64' ? 'caddy.exe' : 'caddy'
  if (manifest.executableName !== executableName || !Number.isSafeInteger(manifest.downloadBytes)
    || manifest.downloadBytes <= 0 || binary.length !== manifest.downloadBytes || binary.length !== manifest.executableBytes
    || sha256(binary) !== manifest.downloadSha256 || sha256(binary) !== manifest.executableSha256) {
    throw new Error('Caddy artifact size or SHA-256 mismatch')
  }
  if (manifest.sourceRevisions === null || typeof manifest.sourceRevisions !== 'object'
    || Object.keys(manifest.sourceRevisions).length !== Object.keys(lock.sources).length
    || Object.entries(lock.sources).some(([name, pin]) => manifest.sourceRevisions[name] !== pin.revision)) {
    throw new Error('Caddy artifact source revisions mismatch')
  }
  verifyCaddyBuild(build, manifest.platform, manifest.arch)
  if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length !== build.Deps.length) {
    throw new Error('Caddy artifact dependency evidence mismatch')
  }
  const dependencies = new Map(build.Deps.map(entry => [entry.Path, entry]))
  const seen = new Set()
  for (const entry of manifest.dependencies) {
    const compiled = dependencies.get(entry.path)
    if (compiled === undefined || seen.has(entry.path) || entry.version !== compiled.Version || entry.sum !== compiled.Sum
      || !Array.isArray(entry.licenses) || entry.licenses.length === 0
      || entry.licenses.some(name => typeof name !== 'string' || !/^(LICENSE|LICENCE|COPYING|NOTICE|PATENTS)(\.[A-Za-z0-9_-]+)?$/iu.test(name))) {
      throw new Error('Caddy artifact dependency evidence mismatch')
    }
    seen.add(entry.path)
  }
}

function verifyLicenseEvidence(text, manifest) {
  if (!text.startsWith('DSH Mobile optional managed Caddy - embedded dependency licenses\n')) throw new Error('Caddy license evidence missing')
  const records = manifest.dependencies.flatMap(entry => entry.licenses.map(name => ({ heading: `${entry.path}@${entry.version} / ${name}`, digest: true })))
  records.push({ heading: `Go ${lock.toolchain} / LICENSE`, digest: false }, { heading: `Go ${lock.toolchain} / PATENTS`, digest: false })
  const positions = records.map(record => {
    const marker = '\n' + record.heading + '\n'
    const index = text.indexOf(marker)
    if (index < 0 || text.indexOf(marker, index + marker.length) !== -1) throw new Error('Caddy license evidence missing or duplicated')
    return index + marker.length
  })
  for (let index = 0; index < records.length; index += 1) {
    if (index > 0 && positions[index] <= positions[index - 1]) throw new Error('Caddy license evidence order mismatch')
    const end = index + 1 < records.length ? text.indexOf('\n' + records[index + 1].heading + '\n', positions[index]) : text.length
    let body = text.slice(positions[index], end).trim()
    if (records[index].digest) {
      const match = body.match(/^SHA-256: [a-f0-9]{64}\n\s*([\s\S]+)$/u)
      if (match === null) throw new Error('Caddy license evidence digest or text missing')
      body = match[1].trim()
    }
    if (body.length === 0 || body.includes('\0')) throw new Error('Caddy license evidence text missing')
  }
  // Section digests describe original source bytes; rendered trimEnd text is not a raw-byte digest proof.
}

async function regularBytes(directory, name, limit) {
  const path = join(directory, name)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > limit) throw new Error('Invalid Caddy artifact file: ' + name)
  return readFile(path)
}

/** Only known regular files are eligible release assets; hidden work trees and symlinks fail closed. */
export async function readArtifact(directory, target, requireReproducibility = false) {
  if (!TARGETS.includes(target)) throw new Error('Unreviewed Caddy artifact target')
  const binaryName = target === 'win32-x64' ? 'caddy.exe' : 'caddy'
  const names = [...METADATA, binaryName, ...(requireReproducibility ? ['reproducibility.json'] : [])]
  const root = await lstat(directory)
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid Caddy artifact directory')
  const actualNames = (await readdir(directory)).sort()
  if (JSON.stringify(actualNames) !== JSON.stringify([...names].sort())) throw new Error('Unexpected Caddy artifact files')
  const files = new Map()
  for (const name of names) files.set(name, await regularBytes(directory, name, name === binaryName ? 128 * 1024 * 1024 : 8 * 1024 * 1024))
  return verifyArtifactFiles(files, target, requireReproducibility)
}

/** Validate the same complete evidence after platform-prefixed release assets are mapped to local names. */
export function verifyArtifactFiles(files, target, requireReproducibility = false) {
  if (!TARGETS.includes(target)) throw new Error('Unreviewed Caddy artifact target')
  const binaryName = target === 'win32-x64' ? 'caddy.exe' : 'caddy'
  const names = [...METADATA, binaryName, ...(requireReproducibility ? ['reproducibility.json'] : [])]
  if (JSON.stringify([...files.keys()].sort()) !== JSON.stringify(names.sort()) || [...files.values()].some(value => !Buffer.isBuffer(value))) {
    throw new Error('Unexpected Caddy artifact files')
  }
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))
  const build = JSON.parse(files.get('go-build.json').toString('utf8'))
  verifyArtifact(manifest, build, files.get(binaryName), target)
  const version = files.get('version.txt').toString('utf8').trim()
  const core = lock.sources.caddy
  if (version !== core.version + ' ' + core.sum) throw new Error('Caddy version evidence mismatch')
  const lines = files.get('modules.txt').toString('utf8').split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  const standardEnd = lines.findIndex(line => /^Standard modules: [1-9][0-9]*$/u.test(line))
  const standard = lines.slice(0, standardEnd)
  if (standardEnd < 1 || lines[standardEnd] !== 'Standard modules: ' + String(standard.length)
    || new Set(standard).size !== standard.length
    || standard.some(line => !/^[a-z0-9_.]+ v[0-9]+\.[0-9]+\.[0-9]+$/u.test(line) || !line.endsWith(' ' + lock.core))
    || JSON.stringify(lines.slice(standardEnd + 1)) !== JSON.stringify(['dns.providers.tencentcloud ' + lock.dns, 'Non-standard modules: 1'])) {
    throw new Error('Caddy DNS module evidence mismatch')
  }
  verifyLicenseEvidence(files.get('THIRD_PARTY_LICENSES.txt').toString('utf8'), manifest)
  if (requireReproducibility) {
    const proof = JSON.parse(files.get('reproducibility.json').toString('utf8'))
    if (proof.schemaVersion !== 1 || proof.target !== target || proof.independentBuilds !== 2
      || proof.buildLockSha256 !== buildLockSha256() || proof.bytes !== manifest.executableBytes
      || proof.firstSha256 !== manifest.executableSha256 || proof.secondSha256 !== manifest.executableSha256) {
      throw new Error('Caddy reproducibility evidence mismatch')
    }
  }
  return { manifest, files }
}
