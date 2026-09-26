import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CPOLAR_COMPONENT_RELEASE,
  CPOLAR_COMPONENT_RELEASES,
  CpolarComponentManager,
  cleanupCpolarInstallStaging,
  publishVerifiedCpolarExecutable,
  validateCpolarAuthtoken,
} from '../src/cpolar-component.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function publicationFixture(): Promise<{
  readonly root: string
  readonly storage: string
  readonly extracted: string
  readonly executable: string
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cpolar-publish-'))
  temporaryDirectories.push(directory)
  const root = join(directory, 'components', 'cpolar')
  const storage = join(root, CPOLAR_COMPONENT_RELEASE.version)
  const executable = join(storage, 'cpolar.exe')
  const extracted = join(directory, 'verified-cpolar.exe')
  await mkdir(storage, { recursive: true })
  await writeFile(executable, 'previous executable')
  await writeFile(extracted, 'verified replacement')
  return { root, storage, extracted, executable }
}

describe('managed cpolar component', () => {
  it('pins the official artifact per platform and rejects malformed tokens', () => {
    expect(CPOLAR_COMPONENT_RELEASE.downloadUrl).toMatch(/^https:\/\/www\.cpolar\.com\//u)
    expect(CPOLAR_COMPONENT_RELEASE.downloadSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(CPOLAR_COMPONENT_RELEASE.executableSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(Object.keys(CPOLAR_COMPONENT_RELEASES).sort()).toEqual(['linux-arm64', 'linux-x64', 'win32-x64'])
    for (const release of Object.values(CPOLAR_COMPONENT_RELEASES)) {
      expect(release.version).toBe(CPOLAR_COMPONENT_RELEASE.version)
      expect(release.downloadUrl).toMatch(/^https:\/\/www\.cpolar\.com\//u)
      expect(release.downloadSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(release.executableSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(release.executableName).toBe(release.platform === 'win32' ? 'cpolar.exe' : 'cpolar')
    }
    expect(validateCpolarAuthtoken('a'.repeat(32))).toBe('a'.repeat(32))
    expect(() => validateCpolarAuthtoken('short')).toThrow('cpolar_authtoken_invalid')
    expect(() => validateCpolarAuthtoken(`a${'b'.repeat(30)}\n`)).toThrow('cpolar_authtoken_invalid')
  })

  it('keeps the token in private component state and purges all owned files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cpolar-component-'))
    temporaryDirectories.push(directory)
    const manager = new CpolarComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64' })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ supported: true, installed: false, configured: false })

    const token = 'token-value-with-enough-characters-1234'
    await manager.configure(token)
    expect(manager.status()).toMatchObject({ installed: false, configured: true })
    expect(JSON.stringify(manager.status())).not.toContain(token)
    const config = await readFile(manager.configFile, 'utf8')
    expect(config).toContain(JSON.stringify(token))
    expect(config).toContain('update: false')
    expect(config).toContain('inspect_db_size: -1')
    expect((await lstat(manager.configFile)).isFile()).toBe(true)

    await manager.purge()
    expect(manager.status()).toMatchObject({ installed: false, configured: false })
    await expect(lstat(manager.configFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports unsupported hosts without attempting a download', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cpolar-component-'))
    temporaryDirectories.push(directory)
    const manager = new CpolarComponentManager({ stateDirectory: directory, platform: 'freebsd', arch: 'x64' })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ supported: false, installed: false })
    await expect(manager.install()).rejects.toThrow('cpolar_component_unsupported')
  })

  it('selects the Linux tarball on Linux hosts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cpolar-component-'))
    temporaryDirectories.push(directory)
    const fetchArtifact = vi.fn(async () => new Uint8Array(16))
    for (const arch of ['x64', 'arm64'] as const) {
      const manager = new CpolarComponentManager({ stateDirectory: directory, platform: 'linux', arch, fetchArtifact })
      await manager.initialize()
      expect(manager.status()).toMatchObject({ supported: true, installed: false })
      expect(manager.status().sourceUrl).toBe(CPOLAR_COMPONENT_RELEASES[`linux-${arch}`]?.downloadUrl)
      expect(manager.executable.endsWith('cpolar')).toBe(true)
      expect(manager.executable.endsWith('.exe')).toBe(false)
      await expect(manager.install()).rejects.toThrow('cpolar_download_hash_mismatch')
    }
    expect(fetchArtifact).toHaveBeenCalledWith(
      CPOLAR_COMPONENT_RELEASES['linux-x64']?.downloadUrl,
      expect.anything(),
    )
  })

  it('classifies a failed download and cleans only its staging files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cpolar-component-'))
    temporaryDirectories.push(directory)
    const manager = new CpolarComponentManager({
      stateDirectory: directory, platform: 'win32', arch: 'x64',
      fetchArtifact: async () => { throw new TypeError('fetch failed') },
    })
    await manager.initialize()
    await expect(manager.install()).rejects.toThrow('cpolar_download_failed')
    expect(manager.status()).toMatchObject({ installed: false, configured: false })
    expect(await readdir(join(directory, 'staging', 'cpolar'))).toEqual([])
    await expect(lstat(manager.executable)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('classifies an inaccessible private directory before downloading', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cpolar-component-'))
    temporaryDirectories.push(directory)
    const blocked = join(directory, 'blocked')
    await writeFile(blocked, 'not a directory')
    const fetchArtifact = vi.fn(async () => new Uint8Array(0))
    const manager = new CpolarComponentManager({
      stateDirectory: blocked, platform: 'win32', arch: 'x64', fetchArtifact,
    })
    await expect(manager.install()).rejects.toThrow('cpolar_storage_failed')
    expect(fetchArtifact).not.toHaveBeenCalled()
  })

  it('replaces a verified component only after preserving the previous directory', async () => {
    const fixture = await publicationFixture()
    await publishVerifiedCpolarExecutable(fixture.extracted, fixture.root, fixture.storage, 'cpolar.exe')
    expect(await readFile(fixture.executable, 'utf8')).toBe('verified replacement')
    expect(await readdir(fixture.root)).toEqual([CPOLAR_COMPONENT_RELEASE.version])
  })

  it('installs a verified component when no previous directory exists', async () => {
    const fixture = await publicationFixture()
    await rm(fixture.storage, { recursive: true })
    await publishVerifiedCpolarExecutable(fixture.extracted, fixture.root, fixture.storage, 'cpolar.exe')
    expect(await readFile(fixture.executable, 'utf8')).toBe('verified replacement')
    expect(await readdir(fixture.root)).toEqual([CPOLAR_COMPONENT_RELEASE.version])
  })

  it('keeps the previous component when its directory cannot be renamed', async () => {
    const fixture = await publicationFixture()
    await expect(publishVerifiedCpolarExecutable(fixture.extracted, fixture.root, fixture.storage, 'cpolar.exe', {
      move: async (from, to) => {
        if (from === fixture.storage) throw new Error('previous executable locked')
        await rename(from, to)
      },
    })).rejects.toThrow('previous executable locked')
    expect(await readFile(fixture.executable, 'utf8')).toBe('previous executable')
    expect(await readdir(fixture.root)).toEqual([CPOLAR_COMPONENT_RELEASE.version])
  })

  it('restores the previous component when promotion of the replacement fails', async () => {
    const fixture = await publicationFixture()
    await expect(publishVerifiedCpolarExecutable(fixture.extracted, fixture.root, fixture.storage, 'cpolar.exe', {
      move: async (from, to) => {
        if (to === fixture.storage && basename(from).startsWith('.install-')) throw new Error('promotion blocked')
        await rename(from, to)
      },
    })).rejects.toThrow('promotion blocked')
    expect(await readFile(fixture.executable, 'utf8')).toBe('previous executable')
    expect(await readdir(fixture.root)).toEqual([CPOLAR_COMPONENT_RELEASE.version])
  })

  it('does not hide the promotion error when temporary-file cleanup also fails', async () => {
    const fixture = await publicationFixture()
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    try {
      await expect(publishVerifiedCpolarExecutable(fixture.extracted, fixture.root, fixture.storage, 'cpolar.exe', {
        move: async (from, to) => {
          if (to === fixture.storage && basename(from).startsWith('.install-')) throw new Error('promotion blocked')
          await rename(from, to)
        },
        remove: async path => {
          if (basename(path).startsWith('.install-')) throw new Error('cleanup blocked')
          await rm(path, { recursive: true, force: true })
        },
      })).rejects.toThrow('promotion blocked')
      expect(await readFile(fixture.executable, 'utf8')).toBe('previous executable')
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('temporary component remains'), {
        code: 'DSH_MOBILE_CPOLAR_CLEANUP_FAILED',
      })
    } finally {
      warning.mockRestore()
    }
  })

  it('retains the previous component in a recoverable backup if rollback fails', async () => {
    const fixture = await publicationFixture()
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    try {
      await expect(publishVerifiedCpolarExecutable(fixture.extracted, fixture.root, fixture.storage, 'cpolar.exe', {
        move: async (from, to) => {
          if (to === fixture.storage) throw new Error(`rename blocked: ${basename(from)}`)
          await rename(from, to)
        },
      })).rejects.toThrow('cpolar_storage_failed')
      const entries = await readdir(fixture.root)
      const backup = entries.find(entry => entry.startsWith('.previous-'))
      expect(backup).toBeDefined()
      expect(await readFile(join(fixture.root, backup!, 'cpolar.exe'), 'utf8')).toBe('previous executable')
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('automatic rollback failed'), {
        code: 'DSH_MOBILE_CPOLAR_ROLLBACK_FAILED',
      })
    } finally {
      warning.mockRestore()
    }
  })

  it('keeps the replacement installed if removing the previous backup fails', async () => {
    const fixture = await publicationFixture()
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    try {
      await publishVerifiedCpolarExecutable(fixture.extracted, fixture.root, fixture.storage, 'cpolar.exe', {
        remove: async path => {
          if (basename(path).startsWith('.previous-')) throw new Error('backup locked')
          await rm(path, { recursive: true, force: true })
        },
      })
      expect(await readFile(fixture.executable, 'utf8')).toBe('verified replacement')
      const backup = (await readdir(fixture.root)).find(entry => entry.startsWith('.previous-'))
      expect(backup).toBeDefined()
      expect(await readFile(join(fixture.root, backup!, 'cpolar.exe'), 'utf8')).toBe('previous executable')
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('previous component remains'), {
        code: 'DSH_MOBILE_CPOLAR_CLEANUP_FAILED',
      })
    } finally {
      warning.mockRestore()
    }
  })

  it('preserves the primary installation error when staging cleanup also fails', async () => {
    const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const primary = new Error('cpolar_download_failed')
    try {
      await expect((async () => {
        try {
          throw primary
        } finally {
          await cleanupCpolarInstallStaging('test-staging', true, async () => { throw new Error('cleanup blocked') })
        }
      })()).rejects.toBe(primary)
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('staging directory remains'), {
        code: 'DSH_MOBILE_CPOLAR_CLEANUP_FAILED',
      })
      await expect(cleanupCpolarInstallStaging('test-staging', false, async () => {
        throw new Error('cleanup blocked')
      })).rejects.toThrow('cpolar_storage_failed')
    } finally {
      warning.mockRestore()
    }
  })
})
