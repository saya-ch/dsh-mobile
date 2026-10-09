import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  PluginReleaseManager,
  comparePluginVersions,
  isRegistryPluginSpec,
  launchedProfileName,
  releaseProfileDirectory,
} from '../src/release-update.js'

const temporaryDirectories: string[] = []
const bundledApp = JSON.parse(readFileSync(new URL('../apps/mobile/release.json', import.meta.url), 'utf8')) as { readonly version: string; readonly versionCode: number; readonly releaseTag: string }
const bundledApkUrl = `https://github.com/saya-ch/dsh-mobile/releases/download/${bundledApp.releaseTag}/dsh-mobile-android-v${bundledApp.version}.apk`

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function profileDirectory(spec: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-release-'))
  temporaryDirectories.push(directory)
  await writeFile(join(directory, 'package.json'), JSON.stringify({ dependencies: { 'dsh-mobile': spec } }))
  return directory
}

function releaseFetch(version: string, appVersion = bundledApp.version, releaseTag = appVersion === bundledApp.version ? bundledApp.releaseTag : `v${appVersion}`): typeof globalThis.fetch {
  return vi.fn(async input => {
    const url = String(input)
    if (url === 'https://registry.npmjs.org/dsh-mobile/latest') {
      return new Response(JSON.stringify({ version }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/apps/mobile/release.json') {
      return Response.json({ version: appVersion, versionCode: bundledApp.versionCode, releaseTag })
    }
    return new Response('', { status: 503 })
  })
}

function notesFetch(version: string): typeof globalThis.fetch {
  return vi.fn(async input => {
    const url = String(input)
    if (url === 'https://registry.npmjs.org/dsh-mobile/latest') {
      return new Response(JSON.stringify({ version }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (url === `https://api.github.com/repos/saya-ch/dsh-mobile/releases/tags/v${version}`) {
      return new Response(JSON.stringify({ body: '## 0.3.3 updates: fixes things. Restart DSH after installing.' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url === 'https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/apps/mobile/release.json') {
      return Response.json({ version, versionCode: bundledApp.versionCode, releaseTag: `v${version}` })
    }
    return new Response('', { status: 503 })
  })
}

describe('profile-local release updates', () => {
  it('compares stable and prerelease SemVer values', () => {
    expect(comparePluginVersions('0.3.3', '0.3.2')).toBe(1)
    expect(comparePluginVersions('0.4.0', '0.3.2')).toBe(1)
    expect(comparePluginVersions('0.4.0-alpha.2', '0.4.0-alpha.1')).toBe(1)
    expect(comparePluginVersions('0.4.0-alpha.1', '0.4.0')).toBe(-1)
    expect(comparePluginVersions('not-a-version', '0.4.0')).toBeUndefined()
  })

  it('updates only npm registry dependencies and resolves the active profile', () => {
    expect(isRegistryPluginSpec('0.4.0')).toBe(true)
    expect(isRegistryPluginSpec('^0.3.2')).toBe(true)
    expect(isRegistryPluginSpec('>=0.3.0 <0.5.0')).toBe(true)
    expect(isRegistryPluginSpec('0.3.x || >=1.0.0 <2.0.0')).toBe(true)
    expect(isRegistryPluginSpec('0.3.0 - 0.4.0')).toBe(true)
    expect(isRegistryPluginSpec('latest')).toBe(true)
    expect(isRegistryPluginSpec('next-1')).toBe(true)
    expect(isRegistryPluginSpec('link:C:/develop/dsh-mobile')).toBe(false)
    expect(isRegistryPluginSpec('file:../dsh-mobile')).toBe(false)
    expect(isRegistryPluginSpec('../dsh-mobile')).toBe(false)
    expect(isRegistryPluginSpec('C:\\develop\\dsh-mobile')).toBe(false)
    expect(isRegistryPluginSpec('saya-ch/dsh-mobile')).toBe(false)
    expect(isRegistryPluginSpec('github:saya-ch/dsh-mobile')).toBe(false)
    expect(isRegistryPluginSpec('npm:dsh-mobile-fork@0.4.0')).toBe(false)
    expect(isRegistryPluginSpec('git://github.com/saya-ch/dsh-mobile.git')).toBe(false)
    expect(isRegistryPluginSpec('git+ssh://git@github.com/saya-ch/dsh-mobile.git')).toBe(false)
    expect(isRegistryPluginSpec('git@github.com:saya-ch/dsh-mobile.git')).toBe(false)
    expect(isRegistryPluginSpec('https://example.com/dsh-mobile.tgz')).toBe(false)
    expect(isRegistryPluginSpec('dsh-mobile-0.4.0.tgz')).toBe(false)
    expect(isRegistryPluginSpec('dsh-mobile-0.4.0.tar')).toBe(false)
    expect(launchedProfileName(['node', 'dsh', '--profile', 'work'])).toBe('work')
    expect(launchedProfileName(['node', 'dsh', '--profile=web'])).toBe('web')
    expect(launchedProfileName(['node', 'dsh'])).toBe('web')
  })

  it('reports plugin and Android releases, then installs into the active profile', async () => {
    const directory = await profileDirectory('^0.3.2')
    const runUpdate = vi.fn(async () => {})
    const manager = new PluginReleaseManager({
      profileDirectory: directory,
      installedVersion: '0.3.2',
      fetch: releaseFetch('0.3.3'),
      runUpdate,
      readInstalledVersion: async () => '0.3.3',
    })

    await expect(manager.status()).resolves.toMatchObject({
      installedVersion: '0.3.2',
      latestVersion: '0.3.3',
      updateAvailable: true,
      updateSupported: true,
      androidVersion: bundledApp.version,
      androidDownloadUrl: bundledApkUrl,
    })
    await expect(manager.update()).resolves.toEqual({ installedVersion: '0.3.3', restartRequired: true })
    expect(runUpdate).toHaveBeenCalledWith(directory, '0.3.3')
  })

  it.each([`v${bundledApp.version}`, `android-v${bundledApp.version}`])('keeps the published App separate from a newer plugin for tag %s', async releaseTag => {
    const [major, minor, patch] = bundledApp.version.split('.').map(Number)
    const newerPluginVersion = `${major}.${minor}.${patch! + 1}`
    const manager = new PluginReleaseManager({
      profileDirectory: undefined,
      installedVersion: bundledApp.version,
      fetch: releaseFetch(newerPluginVersion, bundledApp.version, releaseTag),
    })
    await expect(manager.status()).resolves.toMatchObject({
      latestVersion: newerPluginVersion,
      androidVersion: bundledApp.version,
      androidDownloadUrl: `https://github.com/saya-ch/dsh-mobile/releases/download/${releaseTag}/dsh-mobile-android-v${bundledApp.version}.apk`,
    })
  })

  it('does not downgrade the bundled App download when the raw descriptor is stale', async () => {
    const manager = new PluginReleaseManager({ profileDirectory: undefined, fetch: releaseFetch('0.6.2', '0.2.2') })
    await expect(manager.status()).resolves.toMatchObject({ androidVersion: bundledApp.version, androidDownloadUrl: bundledApkUrl })
  })

  it('uses the requested plugin release notes rather than a newer Android release', async () => {
    const fetcher = notesFetch('0.6.2')
    const manager = new PluginReleaseManager({ profileDirectory: undefined, fetch: fetcher })
    await manager.status()
    expect(fetcher).toHaveBeenCalledWith('https://api.github.com/repos/saya-ch/dsh-mobile/releases/tags/v0.6.2', expect.any(Object))
    expect(fetcher).not.toHaveBeenCalledWith('https://api.github.com/repos/saya-ch/dsh-mobile/releases/latest', expect.any(Object))
  })

  it.each([
    null,
    { version: '0.6.1', versionCode: 0, releaseTag: 'v0.6.1' },
    { version: '0.6.1', versionCode: '77', releaseTag: 'v0.6.1' },
    { version: '0.6.1', versionCode: 77, releaseTag: 'v0.6.2' },
    { version: '0.6.1', versionCode: 77, releaseTag: 'https://evil.example/v0.6.1' },
    { version: '0.6.1-rc.1', versionCode: 77, releaseTag: 'v0.6.1-rc.1' },
    { version: '9007199254740992.0.0', versionCode: 77, releaseTag: 'v9007199254740992.0.0' },
  ])('rejects invalid remote metadata and keeps the verified bundled App instead of inventing a plugin APK: %j', async payload => {
    const fetcher: typeof globalThis.fetch = vi.fn(async input => {
      if (String(input).includes('raw.githubusercontent.com')) return Response.json(payload)
      if (String(input).includes('registry.npmjs.org')) return Response.json({ version: '0.6.2' })
      return Response.json({ tag_name: 'v0.6.2', draft: false, prerelease: false, assets: [] })
    })
    const manager = new PluginReleaseManager({ profileDirectory: undefined, fetch: fetcher })
    await expect(manager.status()).resolves.toMatchObject({ androidVersion: bundledApp.version, androidDownloadUrl: bundledApkUrl })
  })

  it.each([404, 503])('keeps the bundled App when the descriptor returns HTTP %s and never looks up a plugin latest APK', async statusCode => {
    const fetcher: typeof globalThis.fetch = vi.fn(async input => {
      if (String(input).includes('raw.githubusercontent.com')) return new Response('', { status: statusCode })
      if (String(input).includes('registry.npmjs.org')) return Response.json({ version: '0.6.2' })
      return new Response('', { status: 404 })
    })
    const manager = new PluginReleaseManager({ profileDirectory: undefined, fetch: fetcher })
    const status = await manager.status()
    expect(status.androidVersion).toBe(bundledApp.version)
    expect(status.androidDownloadUrl).toBe(bundledApkUrl)
    expect(fetcher).not.toHaveBeenCalledWith('https://api.github.com/repos/saya-ch/dsh-mobile/releases/latest', expect.any(Object))
  })

  it('carries the latest release notes for the preview card and degrades when the API fails', async () => {
    const directory = await profileDirectory('^0.3.2')
    const manager = new PluginReleaseManager({
      profileDirectory: directory,
      installedVersion: '0.3.2',
      fetch: notesFetch('0.3.3'),
      runUpdate: async () => {},
    })
    await expect(manager.status()).resolves.toMatchObject({
      latestVersion: '0.3.3',
      updateAvailable: true,
      releaseNotes: '## 0.3.3 updates: fixes things. Restart DSH after installing.',
    })
    const failing = new PluginReleaseManager({
      profileDirectory: directory,
      installedVersion: '0.3.2',
      fetch: releaseFetch('0.3.3'),
      runUpdate: async () => {},
    })
    const failingStatus = await failing.status()
    expect(failingStatus.updateAvailable).toBe(true)
    expect(failingStatus.releaseNotes).toBeUndefined()
  })

  it('uses the launcher-selected Desktop directory instead of the CLI Web profile', async () => {
    const directory = await profileDirectory('^0.3.2')
    const ctx = new Context()
    ctx.provide('desktopRuntime', { platform: 'win32' })
    ctx.provide('desktopProfiles', { current: { name: 'desktop-test', dir: directory } })
    const selectedDirectory = releaseProfileDirectory(ctx, tmpdir(), ['--profile', 'web'])
    expect(selectedDirectory).toBe(directory)
    const runUpdate = vi.fn(async () => {})
    const manager = new PluginReleaseManager({
      profileDirectory: selectedDirectory,
      installedVersion: '0.3.2',
      fetch: releaseFetch('0.3.3'),
      runUpdate,
      readInstalledVersion: async () => '0.3.3',
    })
    await expect(manager.status()).resolves.toMatchObject({ updateAvailable: true, updateSupported: true })
    await expect(manager.update()).resolves.toEqual({ installedVersion: '0.3.3', restartRequired: true })
    expect(runUpdate).toHaveBeenCalledExactlyOnceWith(directory, '0.3.3')
  })

  it.each([
    undefined,
    {},
    { current: {} },
    { current: { dir: '' } },
    { current: { dir: './profiles/desktop' } },
  ])('disables updating when Desktop has no usable current directory: %j', async profiles => {
    const ctx = new Context()
    ctx.provide('desktopRuntime', { platform: 'win32' })
    if (profiles !== undefined) ctx.provide('desktopProfiles', profiles)
    const selectedDirectory = releaseProfileDirectory(ctx, tmpdir(), ['--profile', 'web'])
    expect(selectedDirectory).toBeUndefined()
    const runUpdate = vi.fn(async () => {})
    const manager = new PluginReleaseManager({
      profileDirectory: selectedDirectory,
      installedVersion: '0.3.2',
      fetch: releaseFetch('0.3.3'),
      runUpdate,
    })
    await expect(manager.status()).resolves.toMatchObject({
      updateAvailable: false,
      updateSupported: false,
      androidVersion: bundledApp.version,
    })
    await expect(manager.update()).rejects.toThrow('plugin_update_unsupported')
    expect(runUpdate).not.toHaveBeenCalled()
  })

  it('does not fall back to Web when only the Desktop profile service is present', () => {
    const ctx = new Context()
    ctx.provide('desktopProfiles', { current: {} })
    expect(releaseProfileDirectory(ctx, tmpdir(), ['--profile', 'web'])).toBeUndefined()
  })

  it('retains default and explicit CLI profile resolution outside Desktop', () => {
    const ctx = new Context()
    expect(releaseProfileDirectory(ctx, tmpdir(), [])).toBe(join(tmpdir(), 'profiles', 'web'))
    expect(releaseProfileDirectory(ctx, tmpdir(), ['--profile', 'work'])).toBe(join(tmpdir(), 'profiles', 'work'))
    expect(releaseProfileDirectory(ctx, tmpdir(), ['--profile=work'])).toBe(join(tmpdir(), 'profiles', 'work'))
  })

  it('never offers to overwrite a linked source checkout', async () => {
    const directory = await profileDirectory('link:C:/develop/dsh-mobile')
    const manager = new PluginReleaseManager({
      profileDirectory: directory,
      installedVersion: '0.3.2',
      fetch: releaseFetch('0.3.3'),
    })

    await expect(manager.status()).resolves.toMatchObject({
      updateAvailable: false,
      updateSupported: false,
      androidVersion: bundledApp.version,
    })
    await expect(manager.update()).rejects.toThrow('plugin_update_unsupported')
  })

  it('keeps the bundled verified App download when Android release metadata is unavailable', async () => {
    const directory = await profileDirectory('^0.3.2')
    const fetcher = vi.fn(async input => {
      if (String(input).includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: '0.3.3' }), { status: 200 })
      }
      throw new Error('github unavailable')
    }) as unknown as typeof globalThis.fetch
    const manager = new PluginReleaseManager({
      profileDirectory: directory,
      installedVersion: '0.3.2',
      fetch: fetcher,
    })

    const status = await manager.status()
    expect(status.androidVersion).toBe(bundledApp.version)
    expect(status.androidDownloadUrl).toBe(bundledApkUrl)
  })

  it('runs pnpm.cmd through the fixed Windows command interpreter without shell mode', async () => {
    const directory = await profileDirectory('^0.3.2')
    const start = vi.fn(() => ({
      completion: Promise.resolve({ code: 0, signal: null }),
      terminateTree: vi.fn(async () => {}),
    }))
    const manager = new PluginReleaseManager({
      profileDirectory: directory,
      installedVersion: '0.3.2',
      fetch: releaseFetch('0.3.3'),
      readInstalledVersion: async () => '0.3.3',
      updateProcess: { platform: 'win32', windowsCommandInterpreter: 'C:\\Windows\\System32\\cmd.exe', start },
    })

    await expect(manager.update()).resolves.toEqual({ installedVersion: '0.3.3', restartRequired: true })
    expect(start).toHaveBeenCalledWith({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', 'add', 'dsh-mobile@0.3.3'],
      cwd: directory,
      detached: false,
      platform: 'win32',
      shell: false,
    })
  })

  it.skipIf(process.platform !== 'win32')('launches the real pnpm.cmd shim through cmd.exe', async () => {
    const version = await new Promise<string>((resolveVersion, rejectVersion) => {
      execFile(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm.cmd', '--version'], {
        windowsHide: true,
        timeout: 10_000,
      }, (error, stdout) => {
        if (error === null) resolveVersion(stdout.trim())
        else rejectVersion(error)
      })
    })
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-.+)?$/u)
  })

  it('terminates the update tree on timeout and waits for process close before rejecting', async () => {
    const directory = await profileDirectory('^0.3.2')
    let completeProcess!: (result: { code: number | null; signal: NodeJS.Signals | null }) => void
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { completeProcess = resolve })
    let expire!: () => void
    const deadline = vi.fn(() => ({
      promise: new Promise<void>(resolve => { expire = resolve }),
      cancel: vi.fn(),
    }))
    const terminateTree = vi.fn(async () => {})
    const start = vi.fn(() => ({ completion, terminateTree }))
    const manager = new PluginReleaseManager({
      profileDirectory: directory,
      installedVersion: '0.3.2',
      fetch: releaseFetch('0.3.3'),
      readInstalledVersion: async () => '0.3.3',
      updateProcess: { platform: 'win32', start, deadline },
    })

    const update = manager.update()
    const observed = update.then(
      () => ({ settled: true, error: undefined }),
      error => ({ settled: true, error }),
    )
    await vi.waitFor(() => { expect(start).toHaveBeenCalledOnce() })
    expire()
    await vi.waitFor(() => { expect(terminateTree).toHaveBeenCalledOnce() })
    let settled = false
    void observed.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    completeProcess({ code: null, signal: 'SIGKILL' })
    const result = await observed
    expect(result.settled).toBe(true)
    expect(result.error).toBeInstanceOf(Error)
    expect((result.error as Error).message).toBe('plugin_update_failed')
  })
})
