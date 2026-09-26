import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CPOLAR_COMPONENT_RELEASE,
  CPOLAR_COMPONENT_RELEASES,
  CpolarComponentManager,
  validateCpolarAuthtoken,
} from '../src/cpolar-component.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

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
})
