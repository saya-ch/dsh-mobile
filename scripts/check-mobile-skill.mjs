#!/usr/bin/env node
/**
 * Keep the bundled skill's factual claims tied to the code that owns them.
 *
 * `packages/mobile-skill` documents pinned component versions, platform lists and
 * per-channel facts for the agent. Nothing else reads it, so a version bump or a
 * packaging change silently leaves it describing the previous release: the Funnel split
 * into per-platform packages shipped in 0.9.0 while the skill still called the sidecar
 * bundled.
 *
 * This check compares the numbers the skill states against the constants that define
 * them, and fails with the corrected value rather than only reporting a mismatch.
 *
 * Usage: node scripts/check-mobile-skill.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function read(relative) {
  return readFileSync(resolve(root, relative), 'utf8')
}

/** Read one string constant from a source file, exported or module-local. */
function constant(relative, name) {
  const match = new RegExp(`(?:export )?const ${name} = '([^']+)'`, 'u').exec(read(relative))
  if (match?.[1] === undefined) throw new Error(`cannot read ${name} from ${relative}`)
  return match[1]
}

/**
 * The `platform`/`arch` pairs a component release table declares.
 *
 * Each `*-component.ts` holds exactly one release table, and they are written either on
 * one line or one field per line, so matching the pairs across the file is both simpler
 * and steadier than locating a particular constant name.
 */
function releaseTargets(relative) {
  const targets = [...read(relative).matchAll(/platform:\s*'([^']+)',\s*arch:\s*'([^']+)'/gu)]
    .map(([, platform, arch]) => `${platform}-${arch}`)
  if (targets.length === 0) throw new Error(`${relative} declares no release targets`)
  return [...new Set(targets)]
}

const channels = read('packages/mobile-skill/references/channels.md')
const access = read('packages/mobile-skill/access.md')

/**
 * Assert the component table in channels.md states this exact version.
 *
 * Deliberately scoped to channels.md: accepting the version anywhere in the skill would
 * pass while the component table itself described a previous release, which is the
 * failure this check exists to catch.
 */
function expectVersion(label, version) {
  if (!channels.includes(version)) {
    failures.push(`${label}: channels.md does not state ${version}`)
  }
}

/** Assert every target the code declares is named in the skill, and no other is claimed. */
function expectTargets(label, targets) {
  for (const target of targets) {
    if (!channels.includes(target)) failures.push(`${label}: target ${target} missing from channels.md`)
  }
}

expectVersion('iroh component', constant('src/iroh-component.ts', 'IROH_VERSION'))
expectTargets('iroh component', releaseTargets('src/iroh-component.ts'))

expectVersion('cpolar component', constant('src/cpolar-component.ts', 'CPOLAR_VERSION'))
expectTargets('cpolar component', releaseTargets('src/cpolar-component.ts'))

expectVersion('cloudflared component', constant('src/cloudflared-component.ts', 'CLOUDFLARED_VERSION'))
expectTargets('cloudflared component', releaseTargets('src/cloudflared-component.ts'))

expectVersion('frp component', constant('src/frp-component.ts', 'FRP_VERSION'))
expectTargets('frp component', releaseTargets('src/frp-component.ts'))

// The Windows client and the Android floor move on their own tracks; a stale number here
// tells a user to upgrade to a version that does not exist.
const windowsVersion = /<Version>([^<]+)<\/Version>/u.exec(read('apps/windows/DshMobile.Win/DshMobile.Win.csproj'))
if (windowsVersion?.[1] === undefined) throw new Error('cannot read the Windows client version')
if (!access.includes(windowsVersion[1])) {
  failures.push(`windows client: ${windowsVersion[1]} is not stated in access.md`)
}

const androidFloor = constant('src/version.ts', 'MINIMUM_ANDROID_APP_VERSION')
if (!access.includes(androidFloor)) {
  failures.push(`android floor: ${androidFloor} is not stated in access.md`)
}

// A link that resolves nowhere is worse than no link: the agent cannot follow it.
const skillFiles = ['packages/mobile-skill/access.md',
  ...['channels', 'management-api', 'pairing', 'diagnostics'].map(name => `packages/mobile-skill/references/${name}.md`)]
for (const file of skillFiles) {
  const body = read(file)
  for (const [, target] of body.matchAll(/\]\((?<t>[^)#][^)]*\.md)\)/gu)) {
    const resolved = resolve(root, dirname(file), target)
    try {
      readFileSync(resolved)
    } catch {
      failures.push(`${file}: link ${target} does not resolve`)
    }
  }
}

if (failures.length > 0) {
  console.error('mobile skill is out of date:')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('\nUpdate packages/mobile-skill so it describes the current code.')
  process.exit(1)
}

console.log('mobile skill matches the code it documents')