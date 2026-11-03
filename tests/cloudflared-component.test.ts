import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOUDFLARED_COMPONENT_RELEASE, CLOUDFLARED_COMPONENT_RELEASES, CloudflaredComponentManager, selectCloudflaredArchiveEntry } from '../src/cloudflared-component.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cloudflared-component-'))
  temporaryDirectories.push(directory)
  return directory
}

/** The staging root is private; the purge contract still needs it observed. */
function stagingRoot(manager: CloudflaredComponentManager): string {
  return (manager as unknown as { readonly stagingRoot: string }).stagingRoot
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

describe('managed cloudflared component', () => {
  it('pins the official release per platform', () => {
    expect(CLOUDFLARED_COMPONENT_RELEASE.version).toMatch(/^\d{4}\.\d+\.\d+$/u)
    expect(CLOUDFLARED_COMPONENT_RELEASE.platform).toBe('win32')
    expect(CLOUDFLARED_COMPONENT_RELEASE.arch).toBe('x64')
    expect(CLOUDFLARED_COMPONENT_RELEASE.downloadUrl).toBe(
      `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_COMPONENT_RELEASE.version}/cloudflared-windows-amd64.exe`,
    )
    expect(Object.keys(CLOUDFLARED_COMPONENT_RELEASES).sort()).toEqual([
      'darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64',
    ])
    for (const release of Object.values(CLOUDFLARED_COMPONENT_RELEASES)) {
      expect(release.version).toBe(CLOUDFLARED_COMPONENT_RELEASE.version)
      expect(release.downloadUrl).toMatch(/^https:\/\/github\.com\/cloudflare\/cloudflared\//u)
      expect(release.downloadSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(release.downloadBytes).toBeGreaterThan(0)
      expect(release.executableSha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(release.executableBytes).toBeGreaterThan(0)
      expect(release.executableName).toBe(release.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
      if (release.archive === undefined) {
        // Bare artifacts are the executable, so both pairs describe one file.
        expect(release.executableBytes).toBe(release.downloadBytes)
        expect(release.executableSha256).toBe(release.downloadSha256)
      } else {
        // Cloudflare publishes macOS only as a `.tgz`: the archive and the
        // binary inside it are two different byte/digest pairs.
        expect(release.platform).toBe('darwin')
        expect(release.archive.format).toBe('tgz')
        expect(release.archive.member).toBe(release.executableName)
        expect(release.downloadUrl.endsWith('.tgz')).toBe(true)
        expect(release.executableBytes).not.toBe(release.downloadBytes)
        expect(release.executableSha256).not.toBe(release.downloadSha256)
      }
    }
  })

  it('reports an uninstalled component without touching the network', async () => {
    const directory = await stateDirectory()
    const fetchArtifact = vi.fn()
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64', fetchArtifact })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ supported: true, installed: false })
    expect(manager.status().storagePath).toContain('cloudflared')
    expect(fetchArtifact).not.toHaveBeenCalled()
  })

  it('refuses unsupported hosts before downloading anything', async () => {
    const directory = await stateDirectory()
    const fetchArtifact = vi.fn()
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'freebsd', arch: 'x64', fetchArtifact })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ supported: false, installed: false })
    await expect(manager.install()).rejects.toThrow('cloudflared_component_unsupported')
    expect(fetchArtifact).not.toHaveBeenCalled()
  })

  it('supports Linux hosts with a bare executable name', async () => {
    const directory = await stateDirectory()
    const fetchArtifact = vi.fn()
    for (const arch of ['x64', 'arm64'] as const) {
      const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'linux', arch, fetchArtifact })
      await manager.initialize()
      expect(manager.status()).toMatchObject({ supported: true, installed: false })
      expect(manager.status().sourceUrl).toBe(CLOUDFLARED_COMPONENT_RELEASES[`linux-${arch}`]?.downloadUrl)
      expect(manager.executable.endsWith('cloudflared')).toBe(true)
      expect(manager.executable.endsWith('.exe')).toBe(false)
    }
    expect(fetchArtifact).not.toHaveBeenCalled()
  })

  it('supports macOS hosts that ship a .tgz instead of a bare executable', async () => {
    const directory = await stateDirectory()
    const fetchArtifact = vi.fn()
    for (const arch of ['x64', 'arm64'] as const) {
      const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'darwin', arch, fetchArtifact })
      await manager.initialize()
      expect(manager.status()).toMatchObject({ supported: true, installed: false })
      expect(manager.status().sourceUrl).toBe(CLOUDFLARED_COMPONENT_RELEASES[`darwin-${arch}`]?.downloadUrl)
      expect(manager.executable.endsWith('cloudflared')).toBe(true)
      // The archive is transport, never the installed path.
      expect(manager.executable.endsWith('.tgz')).toBe(false)
    }
    expect(fetchArtifact).not.toHaveBeenCalled()
  })

  it('reports the unpacked size on macOS rather than the archive that carried it', async () => {
    const directory = await stateDirectory()
    const release = CLOUDFLARED_COMPONENT_RELEASES['darwin-arm64']
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'darwin', arch: 'arm64' })
    await manager.initialize()
    const status = manager.status()
    // A Mac user downloads ~19 MB of gzip and ends up with a ~39 MB Mach-O.
    expect(status.downloadBytes).toBe(release?.downloadBytes)
    expect(status.installedBytes).toBe(release?.executableBytes)
    expect(status.installedBytes).toBeGreaterThan(status.downloadBytes)
  })

  it('rejects an archive-sized macOS file before checking its executable digest', async ({ signal }) => {
    const directory = await stateDirectory()
    const release = CLOUDFLARED_COMPONENT_RELEASES['darwin-arm64']
    if (release === undefined) throw new Error('darwin-arm64 must be pinned')
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'darwin', arch: 'arm64' })
    await mkdir(manager.componentStorage, { recursive: true })
    // Archive length: the executable size gate alone rejects it.
    await writeFile(manager.executable, Buffer.alloc(release.downloadBytes, 0x41), { signal })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ installed: false })
    expect(manager.status().errorCode).toBeUndefined()
  })

  it('rejects a macOS file with the executable size but the wrong digest', async ({ signal }) => {
    const directory = await stateDirectory()
    const release = CLOUDFLARED_COMPONENT_RELEASES['darwin-arm64']
    if (release === undefined) throw new Error('darwin-arm64 must be pinned')
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'darwin', arch: 'arm64' })
    await mkdir(manager.componentStorage, { recursive: true })
    await writeFile(manager.executable, Buffer.alloc(release.executableBytes, 0x42), { signal })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ installed: false, errorCode: 'cloudflared_component_invalid' })
  })

  it('never unpacks an archive that failed its own digest gate', async () => {
    const directory = await stateDirectory()
    const extractArtifact = vi.fn()
    const manager = new CloudflaredComponentManager({
      stateDirectory: directory,
      platform: 'darwin',
      arch: 'arm64',
      // Correct length, wrong bytes: the size gate passes, the digest gate must not.
      fetchArtifact: async () => new Uint8Array(CLOUDFLARED_COMPONENT_RELEASES['darwin-arm64']?.downloadBytes ?? 0),
      extractArtifact,
    })
    await manager.initialize()
    await expect(manager.install()).rejects.toThrow('cloudflared_download_hash_mismatch')
    expect(extractArtifact).not.toHaveBeenCalled()
    expect(manager.status().installed).toBe(false)
    expect(await missing(manager.executable)).toBe(true)
    expect(await readdir(stagingRoot(manager))).toEqual([])
  })

  it('accepts the pinned macOS member while rejecting archive escapes', () => {
    expect(selectCloudflaredArchiveEntry(['cloudflared'], 'cloudflared')).toBe('cloudflared')
    // Cloudflare ships a flat archive today; a nested member must still resolve.
    expect(selectCloudflaredArchiveEntry(['release/cloudflared'], 'cloudflared')).toBe('release/cloudflared')
    expect(() => selectCloudflaredArchiveEntry([], 'cloudflared')).toThrow('cloudflared_archive_entries_invalid')
    expect(() => selectCloudflaredArchiveEntry(['README.md'], 'cloudflared')).toThrow('cloudflared_archive_executable_missing')
    expect(() => selectCloudflaredArchiveEntry(['cloudflared', 'nested/cloudflared'], 'cloudflared'))
      .toThrow('cloudflared_archive_executable_ambiguous')
    expect(() => selectCloudflaredArchiveEntry(['../cloudflared'], 'cloudflared')).toThrow('cloudflared_archive_path_invalid')
    expect(() => selectCloudflaredArchiveEntry(['/etc/cloudflared'], 'cloudflared')).toThrow('cloudflared_archive_path_invalid')
    expect(() => selectCloudflaredArchiveEntry(['C:cloudflared'], 'cloudflared')).toThrow('cloudflared_archive_path_invalid')
    expect(() => selectCloudflaredArchiveEntry(['dir\\cloudflared'], 'cloudflared')).toThrow('cloudflared_archive_path_invalid')
  })

  it('rejects an artifact whose size does not match the pinned bytes', async () => {
    const directory = await stateDirectory()
    const manager = new CloudflaredComponentManager({
      stateDirectory: directory,
      platform: 'win32',
      arch: 'x64',
      fetchArtifact: async () => new Uint8Array(16),
    })
    await manager.initialize()
    await expect(manager.install()).rejects.toThrow('cloudflared_download_size_mismatch')
    expect(manager.status().installed).toBe(false)
    expect(await missing(manager.executable)).toBe(true)
    // A refused install leaves the shared staging root empty, not removed.
    expect(await readdir(stagingRoot(manager))).toEqual([])
  })

  it('rejects an artifact whose digest does not match the pinned hash', async () => {
    const directory = await stateDirectory()
    const manager = new CloudflaredComponentManager({
      stateDirectory: directory,
      platform: 'win32',
      arch: 'x64',
      // Correct length, wrong bytes: the size gate passes, so this exercises the
      // digest gate. The buffer is allocated at the real pinned size deliberately.
      fetchArtifact: async () => new Uint8Array(CLOUDFLARED_COMPONENT_RELEASE.downloadBytes),
    })
    await manager.initialize()
    await expect(manager.install()).rejects.toThrow('cloudflared_download_hash_mismatch')
    expect(manager.status().installed).toBe(false)
    // Nothing unverified may survive at the published path or in staging.
    expect(await missing(manager.executable)).toBe(true)
    expect(await readdir(stagingRoot(manager))).toEqual([])
  })

  it('detects a planted executable that is not the pinned release', async () => {
    const directory = await stateDirectory()
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64' })
    await mkdir(manager.componentStorage, { recursive: true })
    // Exactly the pinned length but not the pinned bytes: the size gate cannot
    // catch this, so initialization must fall back to the digest.
    await writeFile(manager.executable, Buffer.alloc(CLOUDFLARED_COMPONENT_RELEASE.downloadBytes, 0x41))
    await manager.initialize()
    expect(manager.status()).toMatchObject({ installed: false, errorCode: 'cloudflared_component_invalid' })
    await rm(manager.executable)
    await manager.initialize()
    expect(manager.status()).toMatchObject({ installed: false })
    expect(manager.status().errorCode).toBeUndefined()
  })

  it('reports a wrong-length planted executable as simply not installed', async () => {
    const directory = await stateDirectory()
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64' })
    await mkdir(manager.componentStorage, { recursive: true })
    await writeFile(manager.executable, 'not-the-real-cloudflared')
    await manager.initialize()
    expect(manager.status()).toMatchObject({ installed: false })
    expect(manager.status().errorCode).toBeUndefined()
  })

  it('purges every owned cloudflared directory', async () => {
    const directory = await stateDirectory()
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64' })
    await Promise.all([
      mkdir(manager.componentStorage, { recursive: true }),
      mkdir(manager.stateRoot, { recursive: true }),
      mkdir(manager.logRoot, { recursive: true }),
      mkdir(stagingRoot(manager), { recursive: true }),
    ])
    await writeFile(join(manager.componentStorage, 'cloudflared.exe'), 'planted')
    await manager.purge()
    expect(manager.status()).toMatchObject({ installed: false })
    for (const path of [manager.componentRoot, manager.stateRoot, manager.logRoot, stagingRoot(manager)]) {
      expect(await missing(path)).toBe(true)
    }
  })

  it('exposes one pinned byte/digest pair for a bare artifact', async () => {
    const directory = await stateDirectory()
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64' })
    await manager.initialize()
    const status = manager.status()
    expect(status.downloadBytes).toBe(status.installedBytes)
    expect(status.sourceUrl).toBe(CLOUDFLARED_COMPONENT_RELEASE.downloadUrl)
    // No account credential exists anywhere in the public status.
    expect(JSON.stringify(status)).not.toContain('token')
    expect(manager.executable.startsWith(directory)).toBe(true)
    expect(manager.executable).toContain(CLOUDFLARED_COMPONENT_RELEASE.version)
  })
})
