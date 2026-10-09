import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileText } from '../src/exec-file.js'
import { CADDY_COMPONENT_RELEASES } from '../src/caddy-component.js'
import { afterEach, describe, expect, it } from 'vitest'

const inputHelpers = await import(new URL('../scripts/caddy-component-build-inputs.mjs', import.meta.url).href)
const helpers = await import(new URL('../scripts/caddy-component-artifacts.mjs', import.meta.url).href)
const lock = inputHelpers.CADDY_BUILD_LOCK
const { sha256, buildLockSha256, reviewTag, verifyArtifact, readArtifact } = helpers
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function fixture(platform = 'win32') {
  const binary = Buffer.from('pinned-test-byte')
  const deps = ['caddy', 'tencentcloud'].map(name => ({ Path: lock.sources[name].path, Version: lock.sources[name].version, Sum: lock.sources[name].sum }))
  const build = { GoVersion: lock.toolchain, Main: { Path: 'caddy' }, Deps: deps,
    Settings: Object.entries({ '-buildmode': 'exe', '-compiler': 'gc', '-trimpath': 'true', CGO_ENABLED: '0',
      GOOS: platform === 'win32' ? 'windows' : 'linux', GOARCH: 'amd64', GOAMD64: 'v1' }).map(([Key, Value]) => ({ Key, Value })) }
  const manifest = { version: lock.core.slice(1), dnsPluginVersion: lock.dns, xcaddyVersion: lock.xcaddy, goVersion: lock.toolchain,
    platform, arch: 'x64', executableName: platform === 'win32' ? 'caddy.exe' : 'caddy', downloadBytes: binary.length,
    executableBytes: binary.length, downloadSha256: sha256(binary), executableSha256: sha256(binary),
    sourceProvenanceVerified: true, buildLockSha256: buildLockSha256(), publication: 'not-published',
    sourceRevisions: Object.fromEntries(Object.entries(lock.sources).map(([name, pin]) => [name, (pin as { revision: string }).revision])),
    dependencies: deps.map(dep => ({ path: dep.Path, version: dep.Version, sum: dep.Sum, licenses: ['LICENSE'] })),
  }
  return { binary, manifest, build }
}

async function diskFixture(platform = 'win32') {
  const root = await mkdtemp(join(tmpdir(), 'caddy-artifact-test-')); roots.push(root)
  const data = fixture(platform)
  const licenses = ['DSH Mobile optional managed Caddy - embedded dependency licenses', '',
    ...data.manifest.dependencies.map(dep => `${dep.path}@${dep.version} / LICENSE\nSHA-256: ${'a'.repeat(64)}\nfixture license`),
    `Go ${lock.toolchain} / LICENSE\nfixture license`, `Go ${lock.toolchain} / PATENTS\nfixture patents`, ''].join('\n')
  const files = { 'manifest.json': JSON.stringify(data.manifest), 'go-build.json': JSON.stringify(data.build),
    'version.txt': lock.core + ' ' + lock.sources.caddy.sum + '\n',
    'modules.txt': 'tls.issuance.internal ' + lock.core + '\n  Standard modules: 1\n\ndns.providers.tencentcloud ' + lock.dns + '\n  Non-standard modules: 1\n',
    'THIRD_PARTY_LICENSES.txt': licenses, [data.manifest.executableName]: data.binary }
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(root, name), bytes)
  return { root, data }
}

async function cli(name: string, args: string[]) {
  return execFileText(process.execPath, [fileURLToPath(new URL('../scripts/' + name, import.meta.url)), ...args], { timeout: 15_000 })
}

async function provedFixture(platform: string) {
  const first = await diskFixture(platform)
  const second = await diskFixture(platform)
  await cli('compare-caddy-builds.mjs', ['--first', first.root, '--second', second.root, '--target', platform + '-x64'])
  return first
}

describe('review component artifact binding', () => {
  it('shares strict channel identity and exclusive publication request validation', () => {
    const officialTag = 'caddy-component-2.11.6-tencentcloud-0.4.3'
    const request = { event: 'workflow_dispatch', repository: 'saya-ch/dsh-mobile', ref: 'refs/tags/' + officialTag,
      official: 'true', review: 'false', nativeResult: 'success', repositoryPrivate: false }
    expect(helpers.publicationRequest(request)).toMatchObject({ channel: 'official', environment: 'caddy-component-release' })
    expect(helpers.publicationRequest({ event: 'pull_request' })).toBeNull()
    expect(helpers.publicationRequest({ ...request, review: '', official: '' })).toBeNull()
    for (const override of [{ review: 'true' }, { event: 'pull_request' }, { ref: 'refs/heads/main' }, { ref: 'refs/tags/v0.6.2' },
      { ref: request.ref + '-review.1' }, { repository: 'abworks-dev/dsh-mobile' }, { official: 'yes' },
      { nativeResult: 'failure' }, { nativeResult: 'skipped' }, { repositoryPrivate: true }, { repositoryPrivate: undefined }]) {
      expect(() => helpers.publicationRequest({ ...request, ...override })).toThrow()
    }
    expect(() => helpers.releaseIdentity(request.repository, officialTag, 'unknown')).toThrow('channel')
    expect(() => helpers.releaseIdentity('saya-ch/dsh-mobile', officialTag + '-review.1')).toThrow('repository')
    expect(() => helpers.releaseIdentity('abworks-dev/dsh-mobile', officialTag, 'official')).toThrow('identity')
    for (const policy of [null, {}, { protection_rules: {} }, { protection_rules: [] },
      { protection_rules: [{ type: 'required_reviewers', reviewers: [{}], prevent_self_review: 'true' }] },
      { protection_rules: [{ type: 'wait_timer', reviewers: [{}], prevent_self_review: true }] }]) {
      expect(() => helpers.verifyOfficialEnvironment(policy)).toThrow()
    }
  })
  it('requires every official reviewer assignment to identify a supported User or Team', () => {
    const user = { type: 'User', reviewer: { id: 1 } }
    const team = { type: 'Team', reviewer: { id: 2 } }
    const policy = (reviewers: unknown[]) => ({ protection_rules: [{ type: 'required_reviewers', reviewers, prevent_self_review: true }] })
    for (const reviewers of [[user], [team], [user, team]]) expect(() => helpers.verifyOfficialEnvironment(policy(reviewers))).not.toThrow()
    for (const assignment of [null, {}, [], true, { type: 'Other', reviewer: { id: 1 } }, { type: 'User' },
      { type: 'User', reviewer: null }, { type: 'User', reviewer: [] }, { type: 'Team', reviewer: {} },
      ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'].map(id => ({ type: 'User', reviewer: { id } }))]) {
      expect(() => helpers.verifyOfficialEnvironment(policy([assignment]))).toThrow()
      expect(() => helpers.verifyOfficialEnvironment(policy([user, assignment]))).toThrow()
    }
  })
  it('requires exact version-bound review tags that cannot trigger v* plugin releases', () => {
    expect(reviewTag('caddy-component-2.11.6-tencentcloud-0.4.3-review.1')).toContain('-review.1')
    for (const tag of ['v0.6.1', 'latest', 'caddy-component-2.11.7-tencentcloud-0.4.3-review.1',
      'caddy-component-2.11.6-tencentcloud-0.4.3-review.0', 'caddy-component-2.11.6-tencentcloud-0.4.3-review.01']) {
      expect(() => reviewTag(tag)).toThrow('review tag')
    }
  })
  it.each(['win32', 'linux'])('binds metadata, raw bytes, source and graph for %s', platform => {
    const data = fixture(platform)
    expect(() => verifyArtifact(data.manifest, data.build, data.binary, platform + '-x64')).not.toThrow()
  })
  it('rejects incorrect size/hash, metadata, target, source revision and build lock', () => {
    const { manifest, build, binary } = fixture()
    for (const override of [{ version: '2.11.7' }, { sourceProvenanceVerified: false }, { platform: 'linux' },
      { executableName: 'renamed.exe' }, { downloadBytes: binary.length + 1 }, { executableSha256: 'a'.repeat(64) },
      { buildLockSha256: 'a'.repeat(64) }, { sourceRevisions: {} }, { publication: 'published' }, { dependencies: [] }]) {
      expect(() => verifyArtifact({ ...manifest, ...override }, build, binary, 'win32-x64')).toThrow()
    }
    const corrupted = Buffer.from(binary); corrupted[0] = corrupted[0]! ^ 1
    expect(() => verifyArtifact(manifest, build, corrupted, 'win32-x64')).toThrow('SHA-256 mismatch')
    expect(() => verifyArtifact(manifest, build, binary, 'darwin-x64')).toThrow()
  })
  it('reads a complete bounded artifact without executing fake bytes', async () => {
    const { root, data } = await diskFixture()
    const result = await readArtifact(root, 'win32-x64')
    expect(result.files.get('caddy.exe')).toEqual(data.binary)
  })
  it('rejects missing independent-build evidence in a publication input', async () => {
    const { root } = await diskFixture()
    await expect(readArtifact(root, 'win32-x64', true)).rejects.toThrow('Unexpected')
  })
  it('rejects false independent-build proof even when binary hashes agree', async () => {
    const { root, data } = await diskFixture()
    await writeFile(join(root, 'reproducibility.json'), JSON.stringify({ schemaVersion: 1, target: 'win32-x64', independentBuilds: 1,
      buildLockSha256: buildLockSha256(), bytes: data.binary.length, firstSha256: sha256(data.binary), secondSha256: sha256(data.binary) }))
    await expect(readArtifact(root, 'win32-x64', true)).rejects.toThrow('reproducibility evidence mismatch')
  })
  it('rejects unexpected file or remaining work directories', async () => {
    const { root } = await diskFixture(); await mkdir(join(root, '.build-leftover'))
    await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('Unexpected')
  })
  it('rejects forged version, module and missing license evidence', async () => {
    const { root } = await diskFixture()
    const original = await readFile(join(root, 'version.txt'))
    await writeFile(join(root, 'version.txt'), 'v2.11.7 fake')
    await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('version evidence')
    await writeFile(join(root, 'version.txt'), original)
    await writeFile(join(root, 'modules.txt'), 'dns.providers.tencentcloud v0.4.3\nNon-standard modules: 2\n')
    await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('DNS module evidence')
    await writeFile(join(root, 'modules.txt'), 'tls.issuance.internal ' + lock.core + '\n  Standard modules: 1\n\ndns.providers.tencentcloud ' + lock.dns + '\n  Non-standard modules: 1\n')
    await writeFile(join(root, 'THIRD_PARTY_LICENSES.txt'), 'missing licenses')
    await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('license evidence')
  })
  it('rejects extra nonstandard modules even with a forged count of one', async () => {
    const { root } = await diskFixture()
    const original = await readFile(join(root, 'modules.txt'), 'utf8')
    for (const addition of ['dns.providers.cloudflare v1.0.0\n', 'Non-standard modules: 1\n', 'Standard modules: 1\n']) {
      await writeFile(join(root, 'modules.txt'), original + addition)
      await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('DNS module evidence')
    }
  })
  it('rejects empty license sections, malformed digests and duplicate headings', async () => {
    const { root } = await diskFixture()
    const original = await readFile(join(root, 'THIRD_PARTY_LICENSES.txt'), 'utf8')
    for (const changed of [original.replaceAll('fixture license', ''), original.replaceAll('a'.repeat(64), 'invalid'),
      original + '\nGo ' + lock.toolchain + ' / LICENSE\nfixture license\n']) {
      await writeFile(join(root, 'THIRD_PARTY_LICENSES.txt'), changed)
      await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('license evidence')
    }
  })
  it('runs the actual comparison CLI and rejects identical directories or a previous report', async () => {
    const first = await provedFixture('win32')
    expect((await readArtifact(first.root, 'win32-x64', true)).manifest.executableSha256).toBe(sha256(first.data.binary))
    await expect(cli('compare-caddy-builds.mjs', ['--first', first.root, '--second', first.root, '--target', 'win32-x64'])).rejects.toThrow('Independent')
    const second = await diskFixture()
    await expect(cli('compare-caddy-builds.mjs', ['--first', first.root, '--second', second.root, '--target', 'win32-x64'])).rejects.toThrow('Unexpected')
  })
  it('prepares exactly both platform proofs through the real CLI and never overwrites existing output', async () => {
    const wrapper = await mkdtemp(join(tmpdir(), 'caddy-release-input-')); roots.push(wrapper)
    const input = join(wrapper, 'input'); await mkdir(input)
    for (const platform of ['linux', 'win32']) {
      const proved = await provedFixture(platform)
      await cp(proved.root, join(input, 'managed-caddy-review-' + platform + '-x64'), { recursive: true })
    }
    const output = join(wrapper, 'prepared')
    const args = ['--input-dir', input, '--output-dir', output, '--repository', 'abworks-dev/dsh-mobile',
      '--tag', 'caddy-component-2.11.6-tencentcloud-0.4.3-review.1', '--commit', 'b'.repeat(40), '--run-id', '123', '--run-attempt', '1']
    await cli('prepare-caddy-release.mjs', args)
    const index = JSON.parse(await readFile(join(output, 'COMPONENT-RELEASE.json'), 'utf8'))
    expect(Object.keys(index.binaryAssets).sort()).toEqual(['linux-x64', 'win32-x64'])
    expect(index.productionCatalogEnabled).toBe(false)
    const verifyArgs = ['--directory', output, '--repository', 'abworks-dev/dsh-mobile',
      '--tag', 'caddy-component-2.11.6-tencentcloud-0.4.3-review.1', '--commit', 'c'.repeat(40),
      '--run-id', '123', '--run-attempt', '1', '--candidate-output', join(wrapper, 'candidate.json')]
    // Must reject mismatched provenance BEFORE any GitHub lookup or public asset request.
    await expect(cli('verify-caddy-release.mjs', verifyArgs)).rejects.toThrow('Downloaded release identity mismatch')
    const explicitReview = [...args]; explicitReview[3] = join(wrapper, 'explicit-review')
    await cli('prepare-caddy-release.mjs', [...explicitReview, '--channel', 'review'])
    expect(await readFile(join(explicitReview[3]!, 'COMPONENT-RELEASE.json'))).toEqual(await readFile(join(output, 'COMPONENT-RELEASE.json')))
    const invalidChannel = [...args]; invalidChannel[3] = join(wrapper, 'invalid-channel')
    await expect(cli('prepare-caddy-release.mjs', [...invalidChannel, '--channel', 'unknown'])).rejects.toThrow('channel')
    await expect(readFile(join(invalidChannel[3]!, 'COMPONENT-RELEASE.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const original = await readFile(join(output, 'SHA256SUMS'))
    await expect(cli('prepare-caddy-release.mjs', args)).rejects.toThrow()
    expect(await readFile(join(output, 'SHA256SUMS'))).toEqual(original)
    const bad = [...args]; bad[5] = '../foreign/repo'
    await expect(cli('prepare-caddy-release.mjs', bad)).rejects.toThrow('identity')
    const wrongTag = [...args]; wrongTag[7] = 'v0.6.1'
    await expect(cli('prepare-caddy-release.mjs', wrongTag)).rejects.toThrow('review tag')
    const missing = await mkdtemp(join(tmpdir(), 'caddy-release-missing-')); roots.push(missing)
    await cp(join(input, 'managed-caddy-review-win32-x64'), join(missing, 'managed-caddy-review-win32-x64'), { recursive: true })
    const missingArgs = [...args]; missingArgs[1] = missing
    await expect(cli('prepare-caddy-release.mjs', missingArgs)).rejects.toThrow('both native platform')
    await mkdir(join(input, 'foreign-target'))
    await expect(cli('prepare-caddy-release.mjs', args)).rejects.toThrow('both native platform')
  })
  it.each(['review', 'official'])('executes the %s verifier offline against all 16 assets and adversarial API/public bytes', async channel => {
    const wrapper = await mkdtemp(join(tmpdir(), 'caddy-verifier-execution-')); roots.push(wrapper)
    const input = join(wrapper, 'input'); await mkdir(input)
    for (const platform of ['linux', 'win32']) {
      const proved = await provedFixture(platform)
      expect(proved.data.binary.length).toBe(16) // Never execute these synthetic bytes.
      await cp(proved.root, join(input, 'managed-caddy-review-' + platform + '-x64'), { recursive: true })
    }
    const directory = join(wrapper, 'prepared')
    const repository = channel === 'official' ? 'saya-ch/dsh-mobile' : 'abworks-dev/dsh-mobile'
    const tag = 'caddy-component-2.11.6-tencentcloud-0.4.3' + (channel === 'review' ? '-review.1' : '')
    const commit = 'b'.repeat(40)
    await cli('prepare-caddy-release.mjs', ['--input-dir', input, '--output-dir', directory,
      '--repository', repository, '--tag', tag, '--commit', commit, '--run-id', '123', '--run-attempt', '1', '--channel', channel])
    const index = JSON.parse(await readFile(join(directory, 'COMPONENT-RELEASE.json'), 'utf8'))
    const names = [...Object.keys(index.assets), 'COMPONENT-RELEASE.json', 'SHA256SUMS'].sort()
    expect(names).toHaveLength(16)
    for (const [key, value] of [['kind', 'managed-caddy-component-wrong'], ['productionCatalogEnabled', true]] as const) {
      const badDirectory = join(wrapper, 'bad-' + key)
      await cp(directory, badDirectory, { recursive: true })
      await writeFile(join(badDirectory, 'COMPONENT-RELEASE.json'), JSON.stringify({ ...index, [key]: value }))
      const candidate = join(wrapper, 'bad-' + key + '-candidate.json')
      await expect(cli('verify-caddy-release.mjs', ['--directory', badDirectory, '--repository', repository, '--tag', tag,
        '--commit', commit, '--run-id', '123', '--run-attempt', '1', '--candidate-output', candidate, '--channel', channel])).rejects.toThrow('Downloaded release identity mismatch')
      await expect(readFile(candidate)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    const assets: Record<string, { base64: string; size: number; sha256: string }> = {}
    for (const name of names) {
      const bytes = await readFile(join(directory, name))
      assets[name] = { base64: bytes.toString('base64'), size: bytes.length, sha256: sha256(bytes) }
    }
    const token = 'synthetic-caddy-review-token-not-a-secret'
    const apiUrls = [`https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      `https://api.github.com/repos/${repository}/commits/${encodeURIComponent(tag)}`,
      ...(channel === 'official' ? [`https://api.github.com/repos/${repository}/releases/latest`] : [])]
    const publicUrl = (name: string) => `https://github.com/${repository}/releases/download/${tag}/${name}`
    const redirectUrl = (name: string) => `https://release-assets.githubusercontent.com/test/${name}?signed=synthetic`
    const productionBefore = await readFile(fileURLToPath(new URL('../src/caddy-component.ts', import.meta.url)))
    const cases: [string, string | undefined][] = [
      ['valid', undefined], ['preexisting-output', 'EEXIST'],
      ...(channel === 'official' ? [['latest404', undefined], ['latest-component', 'Official component must not be latest'],
        ['latest-other-component', 'Official component must not be latest'],
        ['latest-malformed', 'Official component must not be latest'], ['latest-null', 'Official component must not be latest'],
        ['latest-json', 'JSON'], ['latest-network', 'synthetic API network failure'],
        ...['401', '403', '500'].map(status => ['latest-' + status, 'GitHub release identity lookup failed: ' + status])] as [string, string | undefined][] : []),
      ...['malformed-release', 'malformed-commit', 'wrong-commit', 'moved-commit', 'draft', 'non-prerelease', 'wrong-tag', 'missing-asset', 'extra-asset', 'duplicate-asset']
        .map(mode => [mode, 'Published prerelease identity mismatch'] as [string, string]),
      ...['bad-binary-digest', 'bad-binary-size', 'bad-binary-url', 'tampered-sidecar-digest']
        .map(mode => [mode, 'GitHub published asset metadata mismatch'] as [string, string]),
      ['corrupt-public-binary', 'Published HTTPS download hash mismatch'],
      ['corrupt-public-sidecar', 'Published HTTPS download hash mismatch'],
      ['untrusted-redirect', 'caddy_download_redirect_rejected'],
      ...['release', 'commit'].flatMap(endpoint => ['401', '403', '500', 'network'].map(status =>
        [`api-${endpoint}-${status}`, status === 'network' ? 'synthetic API network failure' : `GitHub release identity lookup failed: ${status}`] as [string, string])),
    ]
    for (const [mode, failure] of cases) {
      const candidate = join(wrapper, `candidate-${mode}.json`)
      const config = join(wrapper, `fetch-${mode}.json`)
      const trace = join(wrapper, `trace-${mode}.jsonl`)
      await writeFile(trace, '')
      await writeFile(config, JSON.stringify({ repository, tag, commit, assets, mode, trace, channel }))
      if (mode === 'preexisting-output') await writeFile(candidate, 'do-not-overwrite\n')
      // Explicit allowlist: no inherited GH_TOKEN, NODE_OPTIONS, profile, or API override.
      const env: NodeJS.ProcessEnv = { GH_TOKEN: token, CADDY_TEST_FETCH_INPUT: config }
      for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key]
      let stdout = ''; let stderr = ''; let rejection: Error | undefined
      try {
        ({ stdout, stderr } = await execFileText(process.execPath, [
          '--import', new URL('./helpers/caddy-release-fetch-preload.mjs', import.meta.url).href,
          fileURLToPath(new URL('../scripts/verify-caddy-release.mjs', import.meta.url)),
          '--directory', directory, '--repository', repository, '--tag', tag, '--commit', commit,
          '--run-id', '123', '--run-attempt', '1', '--candidate-output', candidate,
          ...(channel === 'official' ? ['--channel', channel] : []),
        ], { env, timeout: 5_000, maxBuffer: 256 * 1024 }))
      } catch (error) {
        rejection = error as Error
        const streams = error as { stdout?: string; stderr?: string }
        stdout = streams.stdout ?? ''; stderr = streams.stderr ?? ''
      }
      expect(stdout + stderr + (rejection?.message ?? ''), mode).not.toContain(token)
      const requests: { url: string; redirect: string; authorization: boolean }[] =
        (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
      expect(requests.length, mode).toBeGreaterThan(0)
      for (const request of requests) {
        const api = apiUrls.includes(request.url)
        expect(request.authorization, mode).toBe(api)
        expect(request.redirect, mode).toBe(api || request.url.startsWith('https://release-assets.') ? 'error' : 'manual')
      }
      if (failure) {
        expect(rejection, mode).toBeDefined()
        expect(stderr + rejection?.message, mode).toContain(failure)
        expect(stdout, mode).not.toContain('verifiedPublished')
        if (mode === 'preexisting-output') expect(await readFile(candidate, 'utf8')).toBe('do-not-overwrite\n')
        else await expect(readFile(candidate), mode).rejects.toMatchObject({ code: 'ENOENT' })
        // Consistent API metadata with corrupted bytes must reach the actual public downloader/hash verdict.
        if (mode.startsWith('corrupt-public-')) {
          const name = names.find(name => mode.endsWith('binary') ? name.endsWith('-linux-x64') : name.endsWith('.modules.txt'))!
          expect(requests.map(request => request.url), mode).toContain(redirectUrl(name))
        }
      } else {
        expect(rejection, mode).toBeUndefined()
        expect(JSON.parse(stdout)).toEqual({ ...(channel === 'review' ? { verifiedPublishedPrerelease: true } : { verifiedPublishedOfficialComponent: true }), targets: ['linux-x64', 'win32-x64'], productionCatalogEnabled: false })
        const result = JSON.parse(await readFile(candidate, 'utf8'))
        expect(result).toMatchObject({ schemaVersion: 1, kind: channel + '-candidate-not-production', repository, tag, sourceCommit: commit,
          runId: '123', runAttempt: '1', productionCatalogEnabled: false })
        expect(Object.keys(result.artifacts).sort()).toEqual(['linux-x64', 'win32-x64'])
        for (const target of ['linux-x64', 'win32-x64']) {
          const entry = index.binaryAssets[target]
          expect(result.artifacts[target]).toEqual({ version: entry.version, dnsPluginVersion: entry.dnsPluginVersion,
            platform: entry.platform, arch: entry.arch, executableName: entry.executableName, downloadUrl: publicUrl(entry.name),
            downloadBytes: assets[entry.name]!.size, executableBytes: assets[entry.name]!.size,
            downloadSha256: assets[entry.name]!.sha256, executableSha256: assets[entry.name]!.sha256 })
        }
      }
      if (mode === 'valid' || mode === 'preexisting-output' || mode === 'latest404') {
        expect(requests).toEqual([
          ...apiUrls.map(url => ({ url, redirect: 'error', authorization: true })),
          ...names.flatMap(name => [{ url: publicUrl(name), redirect: 'manual', authorization: false },
            { url: redirectUrl(name), redirect: 'error', authorization: false }]),
        ])
      }
    }
    expect(CADDY_COMPONENT_RELEASES).toEqual({})
    expect(await readFile(fileURLToPath(new URL('../src/caddy-component.ts', import.meta.url)))).toEqual(productionBefore)
  }, 60_000)
  it.runIf(process.platform !== 'win32')('refuses symlinked metadata rather than reading its target', async () => {
    const { root } = await diskFixture()
    const outside = join(root, 'outside.json')
    await writeFile(outside, '{}'); await rm(join(root, 'manifest.json'))
    await symlink(outside, join(root, 'manifest.json')); await rm(outside)
    await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('Invalid')
  })
})
