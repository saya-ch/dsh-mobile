import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Workflow {
  readonly on: { readonly push: { readonly tags: readonly string[] } }
  readonly jobs: Readonly<Record<string, {
    readonly needs?: string | readonly string[]
    readonly strategy?: { readonly matrix: { readonly dsh: readonly string[] } }
    readonly steps: readonly { readonly name?: string; readonly run?: string; readonly if?: string }[]
  }>>
}

async function workflow(name: string): Promise<Workflow> {
  return load(await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8')) as Workflow
}

describe('independent plugin and Android release workflows', () => {
  it('checks the current rc.1 candidate without dependency overrides or an ignored compatibility failure', async () => {
    const ci = await workflow('ci')
    const boot = ci.jobs['mobile-client-boot']!
    expect(boot.strategy!.matrix.dsh).toContain('0.2.2-rc.1')
    expect(boot.strategy!.matrix.dsh).not.toContain('0.2.2-alpha.2')
    const installation = boot.steps.find(step => step.name === 'Install DSH and pack the Mobile bundle')!.run!
    expect(installation).toContain('"@deepseek-ai/dsh@${{ matrix.dsh }}"')
    expect(installation).not.toContain('@deepseek-ai/cordis@')
    expect(installation).not.toContain('overrides')
    const current = boot.steps.find(step => step.name === 'Verify current upstream settings, module recovery, picker, attachments and compressed mux')!
    expect(current.if).toContain("matrix.dsh == '0.2.2-rc.1'")
    for (const check of ['smoke:mobile-settings', 'smoke:module-settings', 'smoke:directory-picker', 'smoke:attachments', 'smoke:mobile-sidebar', '--compressed-websocket --diagnostics']) {
      expect(current.run).toContain(check)
    }
    const source = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    expect(source).not.toContain('continue-on-error: true')
    for (const script of ['smoke-mobile-push-contract.mjs', 'smoke-mobile-push.mjs']) {
      const probe = await readFile(new URL(`../scripts/${script}`, import.meta.url), 'utf8')
      expect(probe).toContain("'0.2.2-rc.1'")
      expect(probe).not.toContain("'0.2.2-alpha.2'")
    }
  })

  it('publishes plugin tags without rebuilding or waiting for Android', async () => {
    const release = await workflow('release')
    expect(release.on.push.tags).toEqual(['v*'])
    expect(release.jobs).not.toHaveProperty('android')
    expect(release.jobs.publish?.needs).toBe('package')
    const commands = Object.values(release.jobs).flatMap(job => job.steps.map(step => step.run ?? '')).join('\n')
    expect(commands).not.toContain('assembleRelease')
    expect(commands).not.toContain('ANDROID_KEYSTORE')
    expect(commands).not.toContain('--clobber')
  })

  it('carries the verified App pointer into plugin artifacts and generated Release notes', async () => {
    const release = await workflow('release')
    const packageCommands = release.jobs.package!.steps.map(step => step.run ?? '').join('\n')
    expect(packageCommands).toContain('cp apps/mobile/release.json dsh-mobile-android-release.json')
    const publication = release.jobs['github-release']!.steps.map(step => step.run ?? '').join('\n')
    expect(publication).toContain('release-assets/dsh-mobile-android-release.json')
    expect(publication).toContain('Android App: **${app.version}**')
    expect(publication).toContain('releases/download/${tag}/dsh-mobile-android-v${version}.apk')
    expect(publication).toContain('--generate-notes')
    expect(publication).toContain('--notes-start-tag "$previous_plugin_tag"')
    expect(publication).toContain('--notes "$release_note"')
    expect(publication).not.toContain('dsh-mobile-android-v${GITHUB_REF_NAME#v}.apk')
  })

  it('reconciles immutable npm tarball integrity before continuing to GitHub publication', async () => {
    const release = await workflow('release')
    const commands = release.jobs.publish!.steps.map(step => step.run ?? '').join('\n')
    expect(commands).toContain('node scripts/check-npm-release-integrity.mjs "$package" "$version"')
    expect(commands).toContain('test "$publication" = "unpublished"')
    expect(commands).not.toContain('npm view')
    expect(commands.indexOf('check-npm-release-integrity.mjs')).toBeLessThan(commands.indexOf('npm publish'))
    expect(release.jobs['github-release']!.needs).toBe('publish')
  })

  it.each(['v0.6.1', 'android-v0.6.1'])('executes the Release note generator using the artifact App version and tag %s', async releaseTag => {
    const release = await workflow('release')
    const command = release.jobs['github-release']!.steps.find(step => step.name === 'Create GitHub release')!.run!
    const source = /app_note="\$\(node --input-type=module -e '([^']+)'\)"/u.exec(command)?.[1]
    expect(source).toBeDefined()
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-release-note-'))
    try {
      await mkdir(join(root, 'release-assets'))
      await writeFile(join(root, 'release-assets', 'dsh-mobile-android-release.json'), JSON.stringify({ version: '0.6.1', versionCode: 77, releaseTag }))
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', source!], { cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true })
      if (result.error) throw result.error
      expect(result.signal).toBeNull()
      expect(result.status).toBe(0)
      expect(result.stdout).toBe(`Android App: **0.6.1** — [Download APK](https://github.com/saya-ch/dsh-mobile/releases/download/${releaseTag}/dsh-mobile-android-v0.6.1.apk). Plugin and App versions are independent.`)
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  })

  it('keeps App tags, signing gates and post-publication pointer promotion independent of npm', async () => {
    const release = await workflow('android-release')
    expect(release.on.push.tags).toEqual(['android-v*'])
    const steps = release.jobs.android!.steps
    const commands = steps.map(step => step.run ?? '').join('\n')
    expect(commands).toContain('npm run check:android-release-tag')
    expect(commands).toContain('lintDebug testDebugUnitTest assembleRelease')
    expect(commands).toContain('node scripts/verify-android-signature.mjs')
    expect(commands).toContain('40 * 1024 * 1024')
    expect(steps.find(step => step.name === 'Remove signing keystore')?.if).toBe('always()')
    const publish = release.jobs['github-release']!
    expect(publish.needs).toBe('android')
    const publication = publish.steps.map(step => step.run ?? '').join('\n')
    expect(publication).toContain('--latest=false')
    expect(publication).toContain('copy dsh-mobile-android-release.json to apps/mobile/release.json')
    expect(publication).not.toContain('npm publish')
    expect(publication).not.toContain('--clobber')
    expect(publication).not.toMatch(/git (?:push|commit)/u)
    expect(commands).toContain('dsh-mobile-android-v${version}.apk')
    expect(commands).not.toContain('dsh-mobile-android-${GITHUB_REF_NAME}.apk')
  })

  it('includes the verified App descriptor in published npm packages', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { readonly files: readonly string[] }
    expect(manifest.files).toContain('apps/mobile/release.json')
  })

  it('preserves the full signed APK before rebuilding the legacy compatibility download', async () => {
    const release = await workflow('android-release')
    const commands = release.jobs.android!.steps.map(step => step.run ?? '').join('\n')
    const preserveFull = commands.indexOf('cp apps/mobile/android/app/build/outputs/apk/release/app-release.apk "dsh-mobile-android-v${version}-iroh.apk"')
    const rebuildCompatibility = commands.indexOf('assembleRelease -PirohNative=false')
    const preserveCompatibility = commands.indexOf('cp apps/mobile/android/app/build/outputs/apk/release/app-release.apk "dsh-mobile-android-v${version}.apk"')
    expect(preserveFull).toBeGreaterThan(0)
    expect(rebuildCompatibility).toBeGreaterThan(preserveFull)
    expect(preserveCompatibility).toBeGreaterThan(rebuildCompatibility)
    expect(commands).toContain('--variant compatibility')
    expect(commands).toContain('for apk in dsh-mobile-android-v*.apk; do')
    expect(commands).toContain('releaseRuntimeClasspath -PirohNative=true')
    expect(commands).toContain('releaseRuntimeClasspath -PirohNative=false')
    const publication = release.jobs['github-release']!.steps.map(step => step.run ?? '').join('\n')
    expect(publication).toContain('legacy update link serves the compatibility APK')
  })
})
