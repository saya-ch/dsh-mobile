import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function read(relativePath) {
  return readFile(resolve(root, relativePath), 'utf8')
}

async function readBinary(relativePath) {
  return readFile(resolve(root, relativePath))
}

function singleMatch(source, pattern, label) {
  const matches = [...source.matchAll(pattern)]
  if (matches.length !== 1 || matches[0][1] === undefined) {
    throw new Error(`${label} must appear exactly once`)
  }
  return matches[0][1]
}

function positiveBuildNumber(value, label) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} must be a positive safe integer`)
  }
  return value
}

function stableVersion(value, label) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
    || value.split('.').some(part => !Number.isSafeInteger(Number(part)))) {
    throw new Error(`${label} must be a stable numeric SemVer`)
  }
  return value
}

function compareStableVersions(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return Math.sign(a[index] - b[index])
  }
  return 0
}

async function releaseDocumentation() {
  const selected = ['README.md', 'README.en.md', 'CHANGELOG.md', 'CONTRIBUTORS.md']
  async function collect(relativeDirectory) {
    let entries
    try {
      entries = await readdir(resolve(root, relativeDirectory), { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const relativePath = `${relativeDirectory}/${entry.name}`
      if (entry.isDirectory()) await collect(relativePath)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) selected.push(relativePath)
    }
  }
  await collect('docs')
  return [...new Set(selected)]
}

function lineNumber(source, offset) {
  return source.slice(0, offset).split('\n').length
}

async function staleReleaseClaims(packageVersion) {
  const findings = []
  const statusPatterns = [
    /(?:^|[\s(（`])v?(\d+\.\d+\.\d+)\s+(?:候选|尚未发布|还未发布|未发布)/gu,
    /(?:^|[\s(（`])v?(\d+\.\d+\.\d+)\s+(?:candidate|not released|not yet released)\b/giu,
    /\bVersion\s+(\d+\.\d+\.\d+)\s+is\s+not\s+released(?:\s+yet)?\b/giu,
  ]
  for (const file of await releaseDocumentation()) {
    let source
    try {
      source = await read(file)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const pattern of statusPatterns) {
      for (const match of source.matchAll(pattern)) {
        if (match[1] !== undefined && compareStableVersions(match[1], packageVersion) <= 0) {
          findings.push(`${file}:${lineNumber(source, match.index)}: ${match[0].trim()} describes ${match[1]} as unreleased`)
        }
      }
    }
    for (const match of source.matchAll(/\bPlugin-only preparation candidate\b/giu)) {
      findings.push(`${file}:${lineNumber(source, match.index)}: ${match[0]} remains in release documentation`)
    }
  }
  return [...new Set(findings)]
}

async function main() {
  const manifest = JSON.parse(await read('package.json'))
  if (typeof manifest.version !== 'string') throw new Error('package.version must be a string')

  const packageVersion = manifest.version
  const packageLock = JSON.parse(await read('package-lock.json'))
  const lockRootVersion = packageLock?.packages?.['']?.version
  if (packageLock?.version !== packageVersion || lockRootVersion !== packageVersion) {
    throw new Error(`package-lock versions ${JSON.stringify(packageLock?.version)} and ${JSON.stringify(lockRootVersion)} must equal package.version ${JSON.stringify(packageVersion)}`)
  }
  const android = await read('apps/mobile/android/app/build.gradle.kts')

  const androidVersion = stableVersion(singleMatch(android, /^\s*versionName\s*=\s*"([^"]+)"\s*$/gm, 'Android versionName'), 'Android versionName')
  const androidBuild = positiveBuildNumber(
    singleMatch(android, /^\s*versionCode\s*=\s*(\d+)\s*$/gm, 'Android versionCode'),
    'Android versionCode',
  )
  const publishedApp = JSON.parse(await read('apps/mobile/release.json'))
  const publishedAppVersion = stableVersion(publishedApp?.version, 'Published Android version')
  if (!Number.isSafeInteger(publishedApp.versionCode) || publishedApp.versionCode <= 0) {
    throw new Error('Published Android versionCode must be a positive safe integer')
  }
  if (publishedApp.releaseTag !== `v${publishedAppVersion}` && publishedApp.releaseTag !== `android-v${publishedAppVersion}`) {
    throw new Error('Published Android releaseTag must match its version with v or android-v prefix')
  }
  if (Number(androidBuild) < publishedApp.versionCode || compareStableVersions(androidVersion, publishedAppVersion) < 0
    || (Number(androidBuild) === publishedApp.versionCode && androidVersion !== publishedAppVersion)) {
    throw new Error('Android candidate must not precede or reuse a differently versioned published App build')
  }
  if (process.argv.includes('--android-tag-env')) {
    const expectedTag = `android-v${androidVersion}`
    if (process.env.GITHUB_REF_NAME !== expectedTag) {
      throw new Error(`GITHUB_REF_NAME ${JSON.stringify(process.env.GITHUB_REF_NAME)} must equal ${JSON.stringify(expectedTag)}`)
    }
    const applicationId = singleMatch(android, /^\s*applicationId\s*=\s*"([^"]+)"\s*$/gm, 'Android applicationId')
    if (applicationId !== 'io.github.sayach.dshmobile') throw new Error('Android release must retain the established applicationId')
    if (Number(androidBuild) <= publishedApp.versionCode || compareStableVersions(androidVersion, publishedAppVersion) <= 0) {
      throw new Error('Android release must increment both versionName and versionCode beyond the published App')
    }
    console.log(`Android release tag ok: ${expectedTag}`)
  }

  if (process.argv.includes('--tag-env')) {
    const expectedTag = `v${packageVersion}`
    const actualTag = process.env.GITHUB_REF_NAME
    if (actualTag !== expectedTag) {
      throw new Error(`GITHUB_REF_NAME ${JSON.stringify(actualTag)} must equal ${JSON.stringify(expectedTag)}`)
    }

    const [changelog, readme, englishReadme, englishAppReadme, chineseAppReadme] = await Promise.all([
      read('CHANGELOG.md'),
      read('README.md'),
      read('README.en.md'),
      read('apps/mobile/README.md'),
      read('apps/mobile/README.zh-CN.md'),
    ])
    const escapedVersion = packageVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const finalizedHeading = new RegExp(`^## ${escapedVersion} - \\d{4}-\\d{2}-\\d{2}$`, 'mu')
    if (!finalizedHeading.test(changelog)) {
      throw new Error(`CHANGELOG.md must finalize ${packageVersion} with an ISO release date before tagging`)
    }
    const developmentMarkers = [
      `${packageVersion} 开发中`,
      `${packageVersion}（开发中）`,
      `${packageVersion} 更新（待发布）`,
      `${packageVersion} 尚未发布`,
      `${packageVersion} is in development`,
      `${packageVersion} (in development)`,
      `${packageVersion} update (unreleased)`,
      `${packageVersion} is not published yet`,
      `${packageVersion} is not released`,
    ]
    const appVersion = '(\\d+\\.\\d+\\.\\d+(?:-[a-z\\d]+(?:[.-][a-z\\d]+)*)?(?:\\+[a-z\\d]+(?:[.-][a-z\\d]+)*)?)'
    for (const [source, label, prefix] of [
      [readme, 'README.md', '当前正式版本：'],
      [englishReadme, 'README.en.md', 'Current stable release:'],
    ]) {
      const marker = developmentMarkers.find(candidate => source.includes(candidate))
      if (marker !== undefined) throw new Error(`${label} still marks ${marker} as in development`)
      const apk = `releases/download/${publishedApp.releaseTag}/dsh-mobile-android-v${publishedAppVersion}.apk`
      const release = `releases/tag/v${packageVersion}`
      if (!source.includes(apk) || !source.includes(release)) {
        throw new Error(`${label} must link the published Android ${publishedAppVersion} download and plugin ${packageVersion} release notes`)
      }
      const stableVersion = singleMatch(source,
        new RegExp(`^[ \\t]*(?:>[ \\t]*)?(?:\\*\\*)?${prefix}[ \\t]*(?:\\*\\*)?${appVersion}(?:\\*\\*)?(?=\\s|[;。；]|\\.(?:\\s|$))`, 'gimu'),
        `${label} stable release version`)
      if (stableVersion !== packageVersion) throw new Error(`${label} stable release version ${JSON.stringify(stableVersion)} must equal package.version ${JSON.stringify(packageVersion)} before tagging`)
    }
    const escapedAppVersion = publishedAppVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const candidateHeading = new RegExp(`^#{1,6}[ \\t]+[^\\n]*(?<![a-z\\d.+-])${escapedAppVersion}[ \\t]+(?:candidate changes|候选更新)(?:[ \\t]|$)`, 'imu')
    for (const [source, label, prefix] of [
      [englishAppReadme, 'apps/mobile/README.md', 'The current stable app is '],
      [chineseAppReadme, 'apps/mobile/README.zh-CN.md', '当前正式 App 为 '],
    ]) {
      const stableVersion = singleMatch(source,
        new RegExp(`^${prefix}(?:\\*\\*)?${appVersion}(?:\\*\\*)?(?=\\s|[;。；]|\\.(?:\\s|$))`, 'gimu'),
        `${label} stable App version`)
      if (stableVersion !== publishedAppVersion) throw new Error(`${label} stable App version ${JSON.stringify(stableVersion)} must equal published Android version ${JSON.stringify(publishedAppVersion)} before tagging`)
      if (candidateHeading.test(source)) throw new Error(`${label} still has a ${publishedAppVersion} candidate changes headline before tagging`)
    }
    const staleClaims = await staleReleaseClaims(packageVersion)
    if (staleClaims.length > 0) {
      throw new Error(`release documentation still contains stale claims:\n${staleClaims.join('\n')}`)
    }
    for (const screenshot of [
      'assets/screenshots/lan-access.png',
      'assets/screenshots/remote-access.png',
      'assets/screenshots/lan-access-en.png',
      'assets/screenshots/remote-access-en.png',
    ]) {
      if ((await readBinary(screenshot)).byteLength === 0) {
        throw new Error(`${screenshot} must exist and be non-empty before tagging`)
      }
    }
    console.log(`release tag ok: ${actualTag}`)
  }

  console.log(`release versions ok: package=${packageVersion}, Android=${androidVersion} (${androidBuild}), published App=${publishedAppVersion} (${publishedApp.versionCode})`)
}

main().catch((error) => {
  console.error(`release version check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
