import { lstat, readFile, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { buildLockSha256, releaseIdentity, sha256, verifyArtifactFiles } from './caddy-component-artifacts.mjs'
import { CADDY_BUILD_LOCK as lock } from './caddy-component-build-inputs.mjs'
import { downloadPinnedArtifact } from '../src/component-download.ts'

const args = process.argv.slice(2)
let channel = 'review'
if (args.length === 16 && args[14] === '--channel') channel = args.splice(14, 2)[1]
const flags = ['--directory', '--repository', '--tag', '--commit', '--run-id', '--run-attempt', '--candidate-output']
if (args.length !== flags.length * 2 || flags.some((flag, index) => args[index * 2] !== flag)) throw new Error('Expected exact Caddy release verification arguments')
const [directory, repository, tag, commit, runId, runAttempt, output] = flags.map((_, index) => args[index * 2 + 1])
if (!isAbsolute(directory) || !isAbsolute(output) || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repository)
  || !/^[a-f0-9]{40}$/u.test(commit) || !/^[1-9][0-9]*$/u.test(runId) || !/^[1-9][0-9]*$/u.test(runAttempt)) throw new Error('Invalid release verification identity')
const identity = releaseIdentity(repository, tag, channel)
const bytes = async name => {
  const path = join(directory, name)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 128 * 1024 * 1024) throw new Error('Invalid downloaded release asset')
  return readFile(path)
}
const indexBytes = await bytes('COMPONENT-RELEASE.json')
const index = JSON.parse(indexBytes.toString('utf8'))
if (index.schemaVersion !== 1 || index.kind !== identity.kind || index.repository !== repository || index.tag !== tag
  || index.sourceCommit !== commit || index.runId !== runId || index.runAttempt !== runAttempt
  || index.productionCatalogEnabled !== false || index.buildLockSha256 !== buildLockSha256()) throw new Error('Downloaded release identity mismatch')
const targets = ['linux-x64', 'win32-x64']
if (JSON.stringify(Object.keys(index.binaryAssets).sort()) !== JSON.stringify(targets)) throw new Error('Both reviewed platforms required')
const assetNames = Object.keys(index.assets)
if (assetNames.length !== 14 || assetNames.some(name => !/^[A-Za-z0-9_.-]+$/u.test(name))) throw new Error('Unexpected release asset set')
const expectedNames = [...assetNames, 'COMPONENT-RELEASE.json', 'SHA256SUMS'].sort()
if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expectedNames)) throw new Error('Downloaded release asset set mismatch')
const expectedSums = []
for (const name of assetNames.sort()) {
  const expected = index.assets[name]
  const actual = await bytes(name)
  if (!Number.isSafeInteger(expected.bytes) || actual.length !== expected.bytes || sha256(actual) !== expected.sha256) throw new Error('Downloaded asset size or hash mismatch: ' + name)
  expectedSums.push([name, expected.sha256])
}
expectedSums.push(['COMPONENT-RELEASE.json', sha256(indexBytes)])
const sumText = expectedSums.sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, sum]) => `${sum}  ${name}`).join('\n') + '\n'
if ((await bytes('SHA256SUMS')).toString('utf8') !== sumText) throw new Error('Downloaded SHA256SUMS mismatch')

const reviewed = new Map()
for (const target of targets) {
  const prefix = `caddy-${lock.core.slice(1)}-tencentcloud-${lock.dns.slice(1)}-${target}`
  const executableName = target === 'win32-x64' ? 'caddy.exe' : 'caddy'
  const binaryAsset = prefix + (target === 'win32-x64' ? '.exe' : '')
  const files = new Map([[executableName, await bytes(binaryAsset)]])
  for (const name of ['manifest.json', 'version.txt', 'modules.txt', 'go-build.json', 'THIRD_PARTY_LICENSES.txt', 'reproducibility.json']) {
    files.set(name, await bytes(prefix + '.' + name))
  }
  const { manifest } = verifyArtifactFiles(files, target, true)
  const expected = { name: binaryAsset, version: manifest.version, dnsPluginVersion: manifest.dnsPluginVersion,
    platform: manifest.platform, arch: manifest.arch, executableName: manifest.executableName,
    downloadBytes: manifest.downloadBytes, executableBytes: manifest.executableBytes,
    downloadSha256: manifest.downloadSha256, executableSha256: manifest.executableSha256 }
  const entry = index.binaryAssets[target]
  if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(Object.keys(expected).sort())
    || Object.entries(expected).some(([name, value]) => entry[name] !== value)) throw new Error('Release binary metadata differs from reviewed artifact')
  reviewed.set(target, expected)
}

const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
  ...(process.env.GH_TOKEN ? { authorization: 'Bearer ' + process.env.GH_TOKEN } : {}) }
const api = async (path, allowMissing = false) => {
  const response = await fetch('https://api.github.com/repos/' + repository + path, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) })
  if (allowMissing && response.status === 404) return undefined
  if (!response.ok) throw new Error('GitHub release identity lookup failed: ' + response.status)
  return response.json()
}
const release = await api('/releases/tags/' + encodeURIComponent(tag))
const source = await api('/commits/' + encodeURIComponent(tag))
if (release.draft !== false || release.prerelease !== (channel === 'review') || release.tag_name !== tag || source.sha !== commit
  || !Array.isArray(release.assets) || release.assets.length !== expectedNames.length
  || new Set(release.assets.map(asset => asset.name)).size !== expectedNames.length
  || release.assets.some(asset => !expectedNames.includes(asset.name))) throw new Error('Published prerelease identity mismatch')
if (channel === 'official') {
  const latest = await api('/releases/latest', true)
  if (latest !== undefined && (typeof latest?.tag_name !== 'string' || latest.tag_name.length === 0 || latest.tag_name.startsWith('caddy-component-') || latest.draft !== false || latest.prerelease !== false)) throw new Error('Official component must not be latest')
}
for (const name of expectedNames) {
  const trustedBytes = await bytes(name)
  const expectedHash = sha256(trustedBytes)
  const url = `https://github.com/${repository}/releases/download/${tag}/${name}`
  const asset = release.assets.find(asset => asset.name === name)
  if (asset?.browser_download_url !== url || asset.size !== trustedBytes.length || asset.digest !== 'sha256:' + expectedHash) {
    throw new Error('GitHub published asset metadata mismatch: ' + name)
  }
  // Recheck EVERY binary/evidence/index/checksum asset publicly, not only the earlier authenticated draft.
  const downloaded = await downloadPinnedArtifact({ url, expectedBytes: trustedBytes.length, errorPrefix: 'caddy', signal: AbortSignal.timeout(600_000) })
  if (sha256(downloaded) !== expectedHash) throw new Error('Published HTTPS download hash mismatch: ' + name)
}
const catalog = {}
for (const target of targets) {
  const entry = index.binaryAssets[target]
  const pin = index.assets[entry.name]
  if (entry.platform + '-' + entry.arch !== target || !pin || entry.downloadBytes !== pin.bytes || entry.executableBytes !== pin.bytes
    || entry.downloadSha256 !== pin.sha256 || entry.executableSha256 !== pin.sha256
    || entry.executableName !== (target === 'win32-x64' ? 'caddy.exe' : 'caddy')) throw new Error('Published binary metadata mismatch')
  const url = `https://github.com/${repository}/releases/download/${tag}/${entry.name}`
  catalog[target] = { version: entry.version, dnsPluginVersion: entry.dnsPluginVersion, platform: entry.platform, arch: entry.arch,
    downloadUrl: url, downloadBytes: pin.bytes, executableBytes: pin.bytes, downloadSha256: pin.sha256, executableSha256: pin.sha256,
    executableName: entry.executableName }
}
// A non-production candidate only: never edits src/caddy-component.ts or enables the production catalog.
await writeFile(output, JSON.stringify({ schemaVersion: 1, kind: channel + '-candidate-not-production', repository, tag, sourceCommit: commit,
  runId, runAttempt, productionCatalogEnabled: false, artifacts: catalog }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ ...(channel === 'review' ? { verifiedPublishedPrerelease: true } : { verifiedPublishedOfficialComponent: true }), targets, productionCatalogEnabled: false }))
