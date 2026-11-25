import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IROH_COMPONENT_RELEASES, IROH_VERSION, IrohComponentManager, type IrohArtifact } from '../src/iroh-component.js'

const roots: string[] = []
const prefix = 'dsh-mobile-iroh-component-test-'

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(root) === root && basename(root).startsWith(prefix) && resolve(root, '..') === resolve(tmpdir())) {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } else throw new Error('Refusing to remove an unowned fixture')
  }
})

async function fixtureCompanion(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  const binary = Buffer.alloc(128, 7)
  await mkdir(join(root, 'native'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-mobile-iroh', version: '0.1.0-alpha.2' }))
  // The manifest must inventory every published target; a partial one is an invalid
  // manifest, not a companion with a platform gap.
  const files: Record<string, string> = {
    'win32-x64': 'dsh-mobile-iroh-host-win32-x64.exe',
    'linux-x64': 'dsh-mobile-iroh-host-linux-x64',
    'darwin-x64': 'dsh-mobile-iroh-host-darwin-x64',
    'darwin-arm64': 'dsh-mobile-iroh-host-darwin-arm64',
  }
  const digest = createHash('sha256').update(binary).digest('hex')
  const artifacts: Record<string, unknown> = {}
  for (const [target, file] of Object.entries(files)) {
    const path = join(root, 'native', file)
    await writeFile(path, binary)
    if (!file.endsWith('.exe') && process.platform !== 'win32') await chmod(path, 0o755)
    artifacts[target] = { file, bytes: 128, sha256: digest }
  }
  await writeFile(join(root, 'native', 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    packageVersion: '0.1.0-alpha.2',
    artifacts,
  }))
  return root
}

function fixtureArtifact(overrides: Partial<IrohArtifact> = {}): { artifact: IrohArtifact; bytes: Buffer } {
  const bytes = Buffer.alloc(64, 3)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    bytes,
    artifact: {
      version: '9.9.9-fixture',
      platform: 'win32',
      arch: 'x64',
      downloadUrl: 'https://example.test/iroh-host-fixture.exe',
      downloadBytes: bytes.length,
      downloadSha256: sha256,
      executableName: 'dsh-mobile-iroh-host-win32-x64.exe',
      executableBytes: bytes.length,
      executableSha256: sha256,
      ...overrides,
    },
  }
}

async function fixtureState(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('iroh component manager', () => {
  it.each(['component', 'parent'] as const)('keeps external files behind a replaced %s junction', async junction => {
    const stateDirectory = await fixtureState()
    const external = await fixtureState()
    const { artifact } = fixtureArtifact()
    await writeFile(join(external, 'keep.txt'), 'external-owned-fixture')
    await mkdir(join(stateDirectory, 'components', ...(junction === 'component' ? ['iroh'] : [])), { recursive: true })
    const target = join(stateDirectory, 'components', 'iroh', ...(junction === 'component' ? [artifact.version] : []))
    await symlink(external, target, process.platform === 'win32' ? 'junction' : 'dir')
    const manager = new IrohComponentManager({ stateDirectory, platform: 'win32', arch: 'x64', artifact, locateCompanionRoots: () => [] })
    if (junction === 'parent') await expect(manager.purge()).rejects.toThrow('iroh_component_cleanup_failed')
    else await expect(manager.purge()).resolves.toMatchObject({ installed: false })
    expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('external-owned-fixture')
    expect(manager.status().installed).toBe(false)
  })
  it('purges only its downloaded component and keeps identity, pairings and external packages', async () => {
    const stateDirectory = await fixtureState()
    const externalRoot = await fixtureCompanion()
    const { artifact, bytes } = fixtureArtifact()
    const manager = new IrohComponentManager({ stateDirectory, platform: 'win32', arch: 'x64', artifact,
      locateCompanionRoots: () => [], fetchArtifact: async () => bytes })
    await manager.initialize()
    await manager.install()
    const executable = manager.executable!
    const identity = join(stateDirectory, 'remote', 'iroh', 'identity.json')
    const pairings = join(stateDirectory, 'devices.json')
    await mkdir(join(stateDirectory, 'remote', 'iroh'), { recursive: true })
    await writeFile(identity, 'fixture-identity')
    await writeFile(pairings, 'fixture-pairings')
    await manager.purge()
    expect(manager.status()).toMatchObject({ installed: false })
    expect(manager.executable).toBeUndefined()
    await expect(readFile(executable)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(identity, 'utf8')).toBe('fixture-identity')
    expect(await readFile(pairings, 'utf8')).toBe('fixture-pairings')
    expect(await readFile(join(externalRoot, 'native', artifact.executableName))).toHaveLength(128)
    await expect(manager.purge()).resolves.toMatchObject({ installed: false })
  })
  it('pins exactly the published sidecar releases', () => {
    expect(IROH_VERSION).toBe('0.1.0-alpha.2')
    expect(Object.keys(IROH_COMPONENT_RELEASES).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64'])
    for (const [target, release] of Object.entries(IROH_COMPONENT_RELEASES)) {
      const [platform, arch] = target.split('-')
      expect(release.platform).toBe(platform)
      expect(release.arch).toBe(arch)
      expect(release.version).toBe(IROH_VERSION)
      expect(release.downloadUrl.startsWith('https://unpkg.com/dsh-mobile-iroh@0.1.0-alpha.2/native/')).toBe(true)
      expect(release.downloadBytes).toBeGreaterThan(1_000_000)
      expect(release.downloadBytes).toBe(release.executableBytes)
      expect(release.downloadSha256).toMatch(/^[a-f0-9]{64}$/)
      expect(release.executableSha256).toBe(release.downloadSha256)
    }
    expect(IROH_COMPONENT_RELEASES['win32-x64']!.executableName).toBe('dsh-mobile-iroh-host-win32-x64.exe')
    expect(IROH_COMPONENT_RELEASES['win32-x64']!.downloadBytes).toBe(14861312)
    expect(IROH_COMPONENT_RELEASES['linux-x64']!.executableName).toBe('dsh-mobile-iroh-host-linux-x64')
    expect(IROH_COMPONENT_RELEASES['linux-x64']!.downloadBytes).toBe(24451352)
  })

  it('reports unsupported platforms closed', async () => {
    // darwin is published since 0.1.0-alpha.2; linux-arm64 is still absent.
    const manager = new IrohComponentManager({ stateDirectory: tmpdir(), platform: 'linux', arch: 'arm64' })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ supported: false, installed: false, errorCode: 'irohPlatformUnsupported' })
    await expect(manager.install()).rejects.toThrow('iroh_platform_unsupported')
    await expect(manager.ensureAvailable()).rejects.toThrow('iroh_platform_unsupported')
  })

  it('reports a fresh state without downloading anything', async () => {
    const fetchArtifact = vi.fn(async () => { throw new Error('must not download') })
    const manager = new IrohComponentManager({
      stateDirectory: await fixtureState(),
      platform: 'win32',
      arch: 'x64',
      locateCompanionRoots: () => [],
      fetchArtifact,
    })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ supported: true, installed: false })
    expect(manager.status().errorCode).toBeUndefined()
    expect(manager.executable).toBeUndefined()
    expect(fetchArtifact).not.toHaveBeenCalled()
    await expect(manager.ensureAvailable()).rejects.toThrow('iroh_companion_missing')
  })

  it('downloads and verifies the pinned sidecar on explicit install', async () => {
    const { artifact, bytes } = fixtureArtifact()
    const fetchArtifact = vi.fn(async () => bytes)
    const manager = new IrohComponentManager({
      stateDirectory: await fixtureState(),
      platform: 'win32',
      arch: 'x64',
      locateCompanionRoots: () => [],
      artifact,
      fetchArtifact,
    })
    await manager.initialize()
    expect(manager.status().installed).toBe(false)
    const installed = await manager.install()
    expect(installed).toMatchObject({ installed: true, version: artifact.version })
    expect(fetchArtifact).toHaveBeenCalledTimes(1)
    expect(fetchArtifact).toHaveBeenCalledWith(artifact.downloadUrl, expect.any(AbortSignal))
    expect(manager.executable).toContain(artifact.executableName)
    expect(await readFile(manager.executable!, 'utf8')).toBe(bytes.toString('utf8'))
    // A second install reuses the verified state copy without downloading again.
    await manager.install()
    expect(fetchArtifact).toHaveBeenCalledTimes(1)
    expect(manager.status()).toMatchObject({ installed: true, version: artifact.version })
  })

  it('reuses a verified companion copy without downloading', async () => {
    const binary = Buffer.alloc(128, 7)
    const sha256 = createHash('sha256').update(binary).digest('hex')
    const { artifact } = fixtureArtifact({
      version: '0.1.0-alpha.2',
      downloadBytes: binary.length,
      downloadSha256: sha256,
      executableBytes: binary.length,
      executableSha256: sha256,
    })
    const fetchArtifact = vi.fn(async () => { throw new Error('must not download') })
    const root = await fixtureCompanion()
    const manager = new IrohComponentManager({
      stateDirectory: await fixtureState(),
      platform: 'win32',
      arch: 'x64',
      locateCompanionRoots: () => [root],
      artifact,
      fetchArtifact,
    })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ installed: true, version: '0.1.0-alpha.2' })
    expect(manager.executable).toContain('dsh-mobile-iroh-host-win32-x64.exe')
    const installed = await manager.install()
    expect(installed).toMatchObject({ installed: true })
    expect(fetchArtifact).not.toHaveBeenCalled()
    // The state copy is now independent of the companion directory.
    expect(manager.executable).toContain(join('components', 'iroh'))
  })

  it('fails closed on a tampered companion binary without downloading over it', async () => {
    const fetchArtifact = vi.fn(async () => { throw new Error('must not download') })
    const root = await fixtureCompanion()
    await writeFile(join(root, 'native', 'dsh-mobile-iroh-host-win32-x64.exe'), Buffer.alloc(128, 9))
    const manager = new IrohComponentManager({
      stateDirectory: await fixtureState(),
      platform: 'win32',
      arch: 'x64',
      locateCompanionRoots: () => [root],
      fetchArtifact,
    })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ installed: false, errorCode: 'irohSidecarInvalid' })
    await expect(manager.install()).rejects.toThrow('iroh_sidecar_invalid')
    expect(fetchArtifact).not.toHaveBeenCalled()
  })

  it('fails closed on a stale state copy', async () => {
    const { artifact } = fixtureArtifact()
    const state = await fixtureState()
    const storage = join(state, 'components', 'iroh', artifact.version)
    await mkdir(storage, { recursive: true })
    await writeFile(join(storage, artifact.executableName), Buffer.alloc(artifact.executableBytes, 9))
    const manager = new IrohComponentManager({
      stateDirectory: state,
      platform: 'win32',
      arch: 'x64',
      locateCompanionRoots: () => [],
      artifact,
      fetchArtifact: async () => { throw new Error('must not download') },
    })
    await manager.initialize()
    // A corrupt state copy reads as invalid, not merely absent.
    expect(manager.status()).toMatchObject({ installed: false, errorCode: 'irohSidecarInvalid' })
  })

  it('rejects a state copy without execute permission', async () => {
    const { artifact } = fixtureArtifact({
      platform: 'linux',
      arch: 'x64',
      executableName: 'dsh-mobile-iroh-host-linux-x64',
    })
    const state = await fixtureState()
    const storage = join(state, 'components', 'iroh', artifact.version)
    await mkdir(storage, { recursive: true })
    // Plain writeFile never sets execute bits, mirroring a hand-placed copy.
    await writeFile(join(storage, artifact.executableName), Buffer.alloc(artifact.executableBytes, 3))
    const manager = new IrohComponentManager({
      stateDirectory: state,
      platform: 'linux',
      arch: 'x64',
      locateCompanionRoots: () => [],
      artifact,
      fetchArtifact: async () => { throw new Error('must not download') },
    })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ installed: false, errorCode: 'irohSidecarInvalid' })
  })

  it('heals a corrupt state copy by reinstalling over it', async () => {
    const { artifact, bytes } = fixtureArtifact()
    const fetchArtifact = vi.fn(async () => bytes)
    const state = await fixtureState()
    const storage = join(state, 'components', 'iroh', artifact.version)
    await mkdir(storage, { recursive: true })
    await writeFile(join(storage, artifact.executableName), Buffer.alloc(artifact.executableBytes, 9))
    const manager = new IrohComponentManager({
      stateDirectory: state,
      platform: 'win32',
      arch: 'x64',
      locateCompanionRoots: () => [],
      artifact,
      fetchArtifact,
    })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ installed: false, errorCode: 'irohSidecarInvalid' })
    const installed = await manager.install()
    expect(installed).toMatchObject({ installed: true, version: artifact.version })
    expect(fetchArtifact).toHaveBeenCalledTimes(1)
    expect(manager.executable).toContain(artifact.executableName)
  })

  it('rejects a download with mismatched bytes or hash', async () => {
    const { artifact, bytes } = fixtureArtifact()
    const state = await fixtureState()
    const short = new IrohComponentManager({
      stateDirectory: state,
      platform: 'win32',
      arch: 'x64',
      locateCompanionRoots: () => [],
      artifact,
      fetchArtifact: async () => bytes.subarray(0, 8),
    })
    await expect(short.install()).rejects.toThrow('iroh_download_size_mismatch')
    const tampered = Buffer.from(bytes)
    tampered[0] = tampered[0]! ^ 0xff
    const corrupt = new IrohComponentManager({
      stateDirectory: state,
      platform: 'win32',
      arch: 'x64',
      locateCompanionRoots: () => [],
      artifact,
      fetchArtifact: async () => tampered,
    })
    await expect(corrupt.install()).rejects.toThrow('iroh_download_hash_mismatch')
    expect(corrupt.status().installed).toBe(false)
  })

  it.runIf(process.platform !== 'win32')('rejects a companion binary without execute permission', async () => {
    const { chmod } = await import('node:fs/promises')
    const root = await fixtureCompanion()
    await chmod(join(root, 'native', 'dsh-mobile-iroh-host-linux-x64'), 0o644)
    const manager = new IrohComponentManager({
      stateDirectory: await fixtureState(),
      platform: 'linux',
      arch: 'x64',
      locateCompanionRoots: () => [root],
    })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ installed: false, errorCode: 'irohSidecarInvalid' })
  })
})
