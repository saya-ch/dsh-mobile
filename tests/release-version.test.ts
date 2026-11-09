import { spawnSync } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const checker = fileURLToPath(new URL('../scripts/check-release-version.mjs', import.meta.url))
const roots: string[] = []
const prefix = 'dsh-mobile-release-version-test-'
const version = '0.5.6'
const releaseLink = `https://github.com/saya-ch/dsh-mobile/releases/tag/v${version}`
const apkLink = `https://github.com/saya-ch/dsh-mobile/releases/download/v${version}/dsh-mobile-android-v${version}.apk`

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(root) !== root || dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith(prefix)) {
      throw new Error('Refusing to remove an unowned release-version fixture')
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
})

function releasedFiles(): Record<string, string> {
  return {
    'package.json': JSON.stringify({ version }),
    'package-lock.json': JSON.stringify({ version, packages: { '': { version } } }),
    'apps/mobile/android/app/build.gradle.kts': `applicationId = "io.github.sayach.dshmobile"\nversionName = "${version}"\nversionCode = 76\n`,
    'apps/mobile/release.json': JSON.stringify({ version, versionCode: 76, releaseTag: `v${version}` }),
    'CHANGELOG.md': `# Changelog\n\n## ${version} - 2026-10-07\n`,
    'README.md': `# DSH Mobile\n\n> **当前正式版本：${version}**。\n\n[App](${apkLink})\n[更新](${releaseLink})\n`,
    'README.en.md': `# DSH Mobile\n\n> **Current stable release: ${version}**.\n\n[App](${apkLink})\n[Release](${releaseLink})\n`,
    'apps/mobile/README.md': `# Android App\n\nThe current stable app is **${version}**.\n\n## Changes\n\nManaged Caddy remains unavailable; other candidate work was reviewed separately.\n`,
    'apps/mobile/README.zh-CN.md': `# Android App\n\n当前正式 App 为 **${version}**。\n\n## 更新\n\n托管 Caddy 安装仍不可用；不要将候选测试说成公网验证。\n`,
    'assets/screenshots/lan-access.png': 'fixture-image',
    'assets/screenshots/remote-access.png': 'fixture-image',
    'assets/screenshots/lan-access-en.png': 'fixture-image',
    'assets/screenshots/remote-access-en.png': 'fixture-image',
  }
}

async function check(overrides: Record<string, string> = {}, tagged: boolean | 'android' = true, tag = `v${version}`): Promise<{ status: number | null; output: string }> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  for (const [file, source] of Object.entries({ ...releasedFiles(), ...overrides })) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await writeFile(join(root, file), source)
  }
  await mkdir(join(root, 'scripts'))
  const copiedChecker = join(root, 'scripts', 'check-release-version.mjs')
  await copyFile(checker, copiedChecker)
  const result = spawnSync(process.execPath, [copiedChecker, ...(tagged === 'android' ? ['--android-tag-env'] : tagged ? ['--tag-env'] : [])], {
    encoding: 'utf8', windowsHide: true, timeout: 10_000, env: { ...process.env, GITHUB_REF_NAME: tag },
  })
  if (result.error) throw result.error
  expect(result.signal).toBeNull()
  return { status: result.status, output: result.stdout + result.stderr }
}

describe('release version and documentation gate', () => {
  it('accepts a complete finalized release without banning unrelated candidate or Caddy text', async () => {
    const result = await check()
    expect(result.status).toBe(0)
    expect(result.output).toContain(`release tag ok: v${version}`)
  })

  it('accepts a plugin-only release while the published App keeps its own version and APK', async () => {
    const appVersion = '0.5.5'
    const appLink = `https://github.com/saya-ch/dsh-mobile/releases/download/v${appVersion}/dsh-mobile-android-v${appVersion}.apk`
    const result = await check({
      'apps/mobile/android/app/build.gradle.kts': `versionName = "${appVersion}"\nversionCode = 75\n`,
      'apps/mobile/release.json': JSON.stringify({ version: appVersion, versionCode: 75, releaseTag: `v${appVersion}` }),
      'README.md': `当前正式版本：${version}。\n[App](${appLink})\n[更新](${releaseLink})\n`,
      'README.en.md': `Current stable release: ${version}.\n[App](${appLink})\n[Release](${releaseLink})\n`,
      'apps/mobile/README.md': `The current stable app is ${appVersion}.\n`,
      'apps/mobile/README.zh-CN.md': `当前正式 App 为 ${appVersion}。\n`,
    })
    expect(result.status).toBe(0)
    expect(result.output).toContain(`package=${version}, Android=${appVersion} (75), published App=${appVersion} (75)`)
  })

  it('accepts a newer native candidate without promoting the already published App pointer', async () => {
    const result = await check({
      'apps/mobile/android/app/build.gradle.kts': 'versionName = "0.5.7"\nversionCode = 77\n',
    })
    expect(result.status).toBe(0)
  })

  it('keeps prerelease plugin package versions independent of a stable Android release', async () => {
    const candidateVersion = '0.5.7-rc.1'
    const result = await check({
      'package.json': JSON.stringify({ version: candidateVersion }),
      'package-lock.json': JSON.stringify({ version: candidateVersion, packages: { '': { version: candidateVersion } } }),
    }, false)
    expect(result.status).toBe(0)
    expect(result.output).toContain(`package=${candidateVersion}, Android=${version} (76)`)
  })

  it.each([
    { version: '0.5.6', versionCode: '76', releaseTag: 'v0.5.6' },
    { version: '0.5.6', versionCode: 0, releaseTag: 'v0.5.6' },
    { version: '0.5.6', versionCode: 76, releaseTag: 'v0.5.5' },
    { version: '0.5.6', versionCode: 76, releaseTag: 'https://evil.example/app.apk' },
    { version: '0.5.6-rc.1', versionCode: 76, releaseTag: 'v0.5.6-rc.1' },
  ])('rejects an invalid published App descriptor: %j', async descriptor => {
    expect((await check({ 'apps/mobile/release.json': JSON.stringify(descriptor) })).status).toBe(1)
  })

  it('accepts an independent Android tag only after both native version fields advance', async () => {
    const result = await check({
      'apps/mobile/android/app/build.gradle.kts': 'applicationId = "io.github.sayach.dshmobile"\nversionName = "0.5.7"\nversionCode = 77\n',
    }, 'android', 'android-v0.5.7')
    expect(result.status).toBe(0)
    expect(result.output).toContain('Android release tag ok: android-v0.5.7')
  })

  it.each([
    ['0.5.7', 77, 'v0.5.7', 'io.github.sayach.dshmobile', 'GITHUB_REF_NAME'],
    ['0.5.6', 76, 'android-v0.5.6', 'io.github.sayach.dshmobile', 'increment both'],
    ['0.5.6', 77, 'android-v0.5.6', 'io.github.sayach.dshmobile', 'increment both'],
    ['0.5.7', 76, 'android-v0.5.7', 'io.github.sayach.dshmobile', 'must not precede or reuse'],
    ['0.5.7', 77, 'android-v0.5.7', 'io.github.fork.app', 'established applicationId'],
  ])('rejects an invalid Android release (version=%s build=%s tag=%s package=%s)', async (appVersion, versionCode, tag, applicationId, message) => {
    const result = await check({
      'apps/mobile/android/app/build.gradle.kts': `applicationId = "${applicationId}"\nversionName = "${appVersion}"\nversionCode = ${versionCode}\n`,
    }, 'android', tag)
    expect(result.status).toBe(1)
    expect(result.output).toContain(message)
  })

  it('accepts the established plain-text App stable-version statements as well as bold versions', async () => {
    const result = await check({
      'apps/mobile/README.md': `The current stable app is ${version}.\n`,
      'apps/mobile/README.zh-CN.md': `当前正式 App 为 ${version}。\n`,
    })
    expect(result.status).toBe(0)
  })

  it('accepts plain root stable labels and independently bold version numbers', async () => {
    const result = await check({
      'README.md': `当前正式版本：${version}。\n[App](${apkLink})\n[更新](${releaseLink})\n`,
      'README.en.md': `Current stable release: **${version}**.\n[App](${apkLink})\n[Release](${releaseLink})\n`,
    })
    expect(result.status).toBe(0)
  })

  it.each([
    ['README.md', '当前正式版本：'],
    ['README.en.md', 'Current stable release: '],
  ])('rejects a stale root stable header in %s even when current APK and release links are present', async (file, label) => {
    const result = await check({ [file]: `> **${label}0.5.5**\n[App](${apkLink})\n[Release](${releaseLink})\n` })
    expect(result.status).toBe(1)
    expect(result.output).toContain(`${file} stable release version "0.5.5" must equal package.version "${version}" before tagging`)
  })

  it('rejects the known English unreleased sentence even without its candidate heading', async () => {
    const result = await check({ 'README.en.md': `${releasedFiles()['README.en.md']}\nVersion ${version} is not released.\n` })
    expect(result.status).toBe(1)
    expect(result.output).toContain(`README.en.md still marks ${version} is not released as in development`)
  })

  it('rejects stale release-state claims across shipped guides', async () => {
    const result = await check({
      'docs/CLIENT_MODULES.md': '插件 0.5.5 候选仍将设置入口列为启动必需项。\n',
      'docs/CLIENT_MODULES.en.md': 'The plugin 0.5.5 candidate remains current.\n',
    })
    expect(result.status).toBe(1)
    expect(result.output).toContain('docs/CLIENT_MODULES.md:1: 0.5.5 候选 describes 0.5.5 as unreleased')
    expect(result.output).toContain('docs/CLIENT_MODULES.en.md:1: 0.5.5 candidate describes 0.5.5 as unreleased')
  })

  it('rejects a preparation candidate label in release documentation', async () => {
    const result = await check({
      'CHANGELOG.md': `${releasedFiles()['CHANGELOG.md']}\n- Plugin-only preparation candidate.\n`,
    })
    expect(result.status).toBe(1)
    expect(result.output).toContain('CHANGELOG.md:5: Plugin-only preparation candidate remains in release documentation')
  })

  it('requires one root stable release statement', async () => {
    const missing = await check({ 'README.en.md': `[App](${apkLink})\n[Release](${releaseLink})\n` })
    expect(missing.status).toBe(1)
    expect(missing.output).toContain('README.en.md stable release version must appear exactly once')
    const duplicate = await check({ 'README.md': `${releasedFiles()['README.md']}\n当前正式版本：${version}。\n` })
    expect(duplicate.status).toBe(1)
    expect(duplicate.output).toContain('README.md stable release version must appear exactly once')
  })

  it('does not mistake another release or ordinary candidate wording for the current candidate headline', async () => {
    const result = await check({
      'apps/mobile/README.md': `${releasedFiles()['apps/mobile/README.md']}\n## 10.5.6 candidate changes\n\n## 0.5.5 candidate changes\n`,
    })
    expect(result.status).toBe(0)
  })

  it('rejects a malformed longer App version instead of matching only its current-version prefix', async () => {
    const result = await check({ 'apps/mobile/README.md': 'The current stable app is 0.5.6.1.\n' })
    expect(result.status).toBe(1)
    expect(result.output).toContain('apps/mobile/README.md stable App version must appear exactly once')
  })

  it('keeps ordinary candidate version checking independent of unfinished release documentation', async () => {
    const result = await check({
      'CHANGELOG.md': '## Unreleased\n',
      'README.md': `${version} 更新（待发布）\n`,
      'README.en.md': `${version} update (unreleased)\n`,
      'apps/mobile/README.md': `The current stable app is **0.5.5**; ${version} is an unreleased candidate.\n\n## ${version} candidate changes\n`,
      'apps/mobile/README.zh-CN.md': `当前正式 App 为 **0.5.5**；${version} 为待发布候选。\n\n## ${version} 候选更新\n`,
    }, false)
    expect(result.status).toBe(0)
    expect(result.output).toContain(`release versions ok: package=${version}, Android=${version} (76)`)
  })

  it.each([
    ['apps/mobile/README.md', 'The current stable app is **0.5.5**.\n'],
    ['apps/mobile/README.zh-CN.md', '当前正式 App 为 **0.5.5**。\n'],
  ])('rejects a stale formal App version in %s', async (file, source) => {
    const result = await check({ [file]: source })
    expect(result.status).toBe(1)
    expect(result.output).toContain(`${file} stable App version "0.5.5" must equal published Android version "${version}" before tagging`)
  })

  it.each([
    ['apps/mobile/README.md', `\n## ${version} candidate changes\n`],
    ['apps/mobile/README.zh-CN.md', `\n## ${version} 候选更新\n`],
  ])('rejects a current candidate headline in %s after the stable version is updated', async (file, headline) => {
    const result = await check({ [file]: `${releasedFiles()[file]}${headline}` })
    expect(result.status).toBe(1)
    expect(result.output).toContain(`${file} still has a ${version} candidate changes headline before tagging`)
  })

  it('rejects a missing or duplicated App stable-version statement', async () => {
    const missing = await check({ 'apps/mobile/README.md': '# Android App\n' })
    expect(missing.status).toBe(1)
    expect(missing.output).toContain('apps/mobile/README.md stable App version must appear exactly once')
    const duplicate = await check({ 'apps/mobile/README.zh-CN.md': `当前正式 App 为 ${version}。\n当前正式 App 为 ${version}。\n` })
    expect(duplicate.status).toBe(1)
    expect(duplicate.output).toContain('apps/mobile/README.zh-CN.md stable App version must appear exactly once')
  })

  it('retains the exact tag gate', async () => {
    const result = await check({}, true, 'v0.5.5')
    expect(result.status).toBe(1)
    expect(result.output).toContain(`GITHUB_REF_NAME "v0.5.5" must equal "v${version}"`)
  })

  it('retains package-lock agreement and prevents downgrading the published native App', async () => {
    const lock = await check({ 'package-lock.json': JSON.stringify({ version: '0.5.5', packages: { '': { version } } }) })
    expect(lock.status).toBe(1)
    expect(lock.output).toContain('package-lock versions')
    const native = await check({ 'apps/mobile/android/app/build.gradle.kts': 'versionName = "0.5.5"\nversionCode = 76\n' })
    expect(native.status).toBe(1)
    expect(native.output).toContain('Android candidate must not precede or reuse a differently versioned published App build')
  })

  it('retains the finalized dated changelog requirement', async () => {
    const result = await check({ 'CHANGELOG.md': '## Unreleased\n' })
    expect(result.status).toBe(1)
    expect(result.output).toContain(`CHANGELOG.md must finalize ${version} with an ISO release date before tagging`)
  })

  it.each([
    ['README.md', `${version} 更新（待发布）`],
    ['README.en.md', `${version} update (unreleased)`],
  ])('retains the root development marker rejection in %s', async (file, marker) => {
    const result = await check({ [file]: `${releasedFiles()[file]}\n${marker}\n` })
    expect(result.status).toBe(1)
    expect(result.output).toContain(`${file} still marks ${marker} as in development`)
  })

  it('retains root APK and release-link checks', async () => {
    const result = await check({ 'README.en.md': `[Old App](https://github.com/saya-ch/dsh-mobile/releases/download/v0.5.5/dsh-mobile-android-v0.5.5.apk)\n` })
    expect(result.status).toBe(1)
    expect(result.output).toContain(`README.en.md must link the published Android ${version} download and plugin ${version} release notes`)
  })

  it('retains non-empty release screenshot checks', async () => {
    const result = await check({ 'assets/screenshots/remote-access-en.png': '' })
    expect(result.status).toBe(1)
    expect(result.output).toContain('assets/screenshots/remote-access-en.png must exist and be non-empty before tagging')
  })
})
