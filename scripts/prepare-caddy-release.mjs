import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { buildLockSha256, readArtifact, releaseIdentity, sha256 } from './caddy-component-artifacts.mjs'

const args = process.argv.slice(2)
let channel = 'review'
if (args.length === 16 && args[14] === '--channel') channel = args.splice(14, 2)[1]
const flags = ['--input-dir', '--output-dir', '--repository', '--tag', '--commit', '--run-id', '--run-attempt']
if (args.length !== flags.length * 2 || flags.some((flag, index) => args[index * 2] !== flag)) {
  throw new Error('Usage: node scripts/prepare-caddy-release.mjs --input-dir <absolute-dir> --output-dir <new-absolute-dir> --repository <owner/repo> --tag <component-tag> --commit <sha40> --run-id <id> --run-attempt <attempt> [--channel review|official]')
}
const [input, output, repository, tag, commit, runId, runAttempt] = flags.map((_, index) => args[index * 2 + 1])
if (!isAbsolute(input) || !isAbsolute(output)
  || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(repository)
  || !/^[a-f0-9]{40}$/u.test(commit) || !/^[1-9][0-9]*$/u.test(runId) || !/^[1-9][0-9]*$/u.test(runAttempt)) {
  throw new Error('Invalid Caddy release identity')
}
const identity = releaseIdentity(repository, tag, channel)
const targets = ['linux-x64', 'win32-x64']
const expectedDirectories = targets.map(target => 'managed-caddy-review-' + target).sort()
if (JSON.stringify((await readdir(input)).sort()) !== JSON.stringify(expectedDirectories)) {
  throw new Error('Exactly both native platform artifacts from this run are required')
}
const prepared = new Map()
const binaryAssets = {}
for (const target of targets) {
  const artifact = await readArtifact(join(input, 'managed-caddy-review-' + target), target, true)
  const prefix = `caddy-${artifact.manifest.version}-tencentcloud-${artifact.manifest.dnsPluginVersion.slice(1)}-${target}`
  for (const [name, bytes] of artifact.files) {
    const binary = name === artifact.manifest.executableName
    const assetName = binary ? prefix + (target === 'win32-x64' ? '.exe' : '') : prefix + '.' + name
    if (prepared.has(assetName)) throw new Error('Duplicate platform asset name')
    prepared.set(assetName, bytes)
    if (binary) binaryAssets[target] = { name: assetName, version: artifact.manifest.version,
      dnsPluginVersion: artifact.manifest.dnsPluginVersion, platform: artifact.manifest.platform, arch: artifact.manifest.arch,
      executableName: artifact.manifest.executableName, downloadBytes: bytes.length, executableBytes: bytes.length,
      downloadSha256: sha256(bytes), executableSha256: sha256(bytes) }
  }
}
const index = { schemaVersion: 1, kind: identity.kind, repository, tag, sourceCommit: commit,
  runId, runAttempt, buildLockSha256: buildLockSha256(), productionCatalogEnabled: false,
  binaryAssets, assets: Object.fromEntries([...prepared].sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([name, bytes]) => [name, { bytes: bytes.length, sha256: sha256(bytes) }])) }
prepared.set('COMPONENT-RELEASE.json', Buffer.from(JSON.stringify(index, null, 2) + '\n'))
prepared.set('SHA256SUMS', Buffer.from([...prepared].sort(([a], [b]) => a.localeCompare(b, 'en'))
  .map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join('\n') + '\n'))
// All source artifacts were validated before allocating a new destination; no overwrite/clobber path.
await mkdir(output, { recursive: false, mode: 0o700 })
for (const [name, bytes] of prepared) await writeFile(join(output, name), bytes, { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ repository, tag, sourceCommit: commit, assets: [...prepared.keys()], publication: 'prepared-only', productionCatalogEnabled: false }))
