import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CpolarComponentManager } from '../src/cpolar-component.js'
import { CloudflaredComponentManager } from '../src/cloudflared-component.js'
import { FrpComponentManager } from '../src/frp-component.js'
import { FrpConfigStore } from '../src/frp-config.js'
import { CloudflaredTunnelStore } from '../src/cloudflared-tunnel.js'
import { OriginConfigStore } from '../src/origin-proxy-config.js'
import { ensureManagedDirectory, removeManagedTree, replaceManagedDirectory, writeManagedPrivateFile } from '../src/managed-files.js'

const roots: string[] = []
const links: string[] = []
afterEach(async () => {
  for (const link of links.splice(0)) await unlink(link).catch(error => { if (error.code !== 'ENOENT') throw error })
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(): Promise<{ root: string; state: string; outside: string; sentinel: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-path-')); roots.push(root)
  const state = join(root, 'state'); const outside = join(root, 'outside')
  await mkdir(state); await mkdir(outside)
  const sentinel = join(outside, 'sentinel.txt'); await writeFile(sentinel, 'outside must survive')
  return { root, state, outside, sentinel }
}
async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir'); links.push(path)
}

describe('managed component path ownership', () => {
  it('rejects relative component roots rather than rebasing them into the working directory', () => {
    expect(() => new CpolarComponentManager({ stateDirectory: 'relative-state' })).toThrow('cpolar state directory must be absolute')
    expect(() => new CloudflaredComponentManager({ stateDirectory: 'relative-state' })).toThrow('cloudflared state directory must be absolute')
    expect(() => new FrpComponentManager({ stateDirectory: 'relative-state' })).toThrow('frp state directory must be absolute')
  })
  it.each(['cpolar', 'cloudflared', 'frp'] as const)('refuses linked ancestors for %s without reading or deleting the external component', async provider => {
    const { state, outside, sentinel } = await fixture()
    await mkdir(join(outside, provider)); await writeFile(join(outside, provider, 'keep'), 'external component')
    await linkDirectory(outside, join(state, 'components'))
    const fetchArtifact = vi.fn(async () => new Uint8Array())
    const inspectExecutable = vi.fn(async () => '0.70.1')
    const manager = provider === 'cpolar' ? new CpolarComponentManager({ stateDirectory: state, fetchArtifact })
      : provider === 'cloudflared' ? new CloudflaredComponentManager({ stateDirectory: state, fetchArtifact })
        : new FrpComponentManager({ stateDirectory: state, fetchArtifact, inspectExecutable })
    await expect(manager.initialize()).resolves.toBeUndefined()
    expect(manager.status()).toMatchObject({ installed: false, errorCode: `${provider}_component_invalid` })
    await expect(manager.install()).rejects.toThrow(`${provider}_path_invalid`)
    await expect(manager.purge()).rejects.toThrow(`${provider}_path_invalid`)
    expect(fetchArtifact).not.toHaveBeenCalled(); expect(inspectExecutable).not.toHaveBeenCalled()
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
    expect(await readFile(join(outside, provider, 'keep'), 'utf8')).toBe('external component')
  })

  it.each(['cpolar', 'cloudflared', 'frp'] as const)('unlinks a %s component-root junction itself when explicitly purging', async provider => {
    const { state, outside, sentinel } = await fixture()
    await mkdir(join(state, 'components')); await linkDirectory(outside, join(state, 'components', provider))
    const manager = provider === 'cpolar' ? new CpolarComponentManager({ stateDirectory: state })
      : provider === 'cloudflared' ? new CloudflaredComponentManager({ stateDirectory: state })
        : new FrpComponentManager({ stateDirectory: state })
    await manager.purge()
    await expect(lstat(manager.componentRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
  })

  it.each(['cpolar', 'cloudflared', 'frp'] as const)('refuses a linked %s staging ancestor before downloading', async provider => {
    const { state, outside, sentinel } = await fixture()
    await linkDirectory(outside, join(state, 'staging'))
    const fetchArtifact = vi.fn(async () => new Uint8Array())
    const manager = provider === 'cpolar' ? new CpolarComponentManager({ stateDirectory: state, fetchArtifact })
      : provider === 'cloudflared' ? new CloudflaredComponentManager({ stateDirectory: state, fetchArtifact })
        : new FrpComponentManager({ stateDirectory: state, fetchArtifact })
    await expect(manager.install()).rejects.toThrow(`${provider}_path_invalid`)
    expect(fetchArtifact).not.toHaveBeenCalled()
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
    expect(await readdir(outside)).toEqual(['sentinel.txt'])
  })

  it('refuses writing a cpolar credential beneath a linked state ancestor', async () => {
    const { state, outside, sentinel } = await fixture()
    await linkDirectory(outside, join(state, 'state'))
    const manager = new CpolarComponentManager({ stateDirectory: state })
    await expect(manager.configure('valid-token-value-long-enough')).rejects.toThrow('cpolar_path_invalid')
    expect(await readdir(outside)).toEqual(['sentinel.txt'])
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
  })

  it.each(['frp', 'cloudflared', 'origin'] as const)('refuses %s configuration reads, writes and purge across an owned ancestor link', async provider => {
    const { state, outside, sentinel } = await fixture()
    await mkdir(join(outside, provider)); await linkDirectory(outside, join(state, 'remote'))
    const directory = join(state, 'remote', provider)
    const store = provider === 'frp' ? new FrpConfigStore(directory, 'test-proxy', state)
      : provider === 'cloudflared' ? new CloudflaredTunnelStore(directory, state)
        : new OriginConfigStore(directory, state)
    await store.initialize()
    expect(store.status().configured).toBe(false)
    const input = provider === 'frp'
      ? { serverAddress: '1.2.3.4', serverPort: 7000, token: 'high-entropy-test-token-1234567890', publicOrigin: 'https://dsh.example.com' }
      : provider === 'cloudflared' ? { mode: 'named', token: 'a'.repeat(64), hostname: 'dsh.example.com', port: 3444 }
        : { publicOrigin: 'https://dsh.example.com' }
    await expect(store.configure(input)).rejects.toThrow(`${provider}_path_invalid`)
    await expect(store.purge()).rejects.toThrow(`${provider}_path_invalid`)
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
    expect(await readdir(join(outside, provider))).toEqual([])
  })

  it('refuses a root purge and a sensitive-file symlink without altering either target', async () => {
    const { state, outside, sentinel } = await fixture()
    await expect(removeManagedTree(state, state, 'managed')).rejects.toThrow('managed_path_invalid')
    const file = join(state, 'secret.json')
    // Directory junctions are available without Windows Developer Mode.
    // A link at a sensitive-file name must still be refused before writing.
    await linkDirectory(outside, file)
    await expect(writeManagedPrivateFile(state, file, 'secret', 'managed')).rejects.toThrow('managed_config_target_invalid')
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
    await expect(ensureManagedDirectory(state, join(outside, 'created'), 'managed')).rejects.toThrow('managed_path_invalid')
  })

  it('FRP purge removes only its two owned configuration files', async () => {
    const { state } = await fixture(); const store = new FrpConfigStore(state)
    await writeFile(store.settingsFile, 'fixture'); await writeFile(store.runtimeConfigFile, 'fixture')
    await writeFile(join(state, 'unrelated.txt'), 'keep')
    await store.purge()
    expect(await readdir(state)).toEqual(['unrelated.txt'])
  })
})

describe('managed component publication rollback', () => {
  it('restores the previous executable if candidate promotion fails', async () => {
    const { state } = await fixture(); const target = join(state, 'version'); const candidate = join(state, 'candidate')
    await mkdir(target); await mkdir(candidate)
    await writeFile(join(target, 'cloudflared'), 'previous verified executable')
    await writeFile(join(candidate, 'cloudflared'), 'new verified executable')
    const failure = new Error('promotion failed')
    await expect(replaceManagedDirectory(state, target, candidate, 'cloudflared', {
      move: async (source, destination) => { if (source === candidate) throw failure; await rename(source, destination) },
    })).rejects.toBe(failure)
    expect(await readFile(join(target, 'cloudflared'), 'utf8')).toBe('previous verified executable')
    expect(await readdir(state)).toEqual(['version'])
  })

  it('retains the backup if both promotion and rollback fail', async () => {
    const { state } = await fixture(); const target = join(state, 'version'); const candidate = join(state, 'candidate')
    await mkdir(target); await mkdir(candidate); await writeFile(join(target, 'cloudflared'), 'recoverable previous executable')
    let backup: string | undefined
    await expect(replaceManagedDirectory(state, target, candidate, 'cloudflared', {
      move: async (source, destination) => {
        if (source === target) { backup = destination; await rename(source, destination); return }
        throw new Error('filesystem refused promotion and rollback')
      },
    })).rejects.toThrow('cloudflared_component_replace_failed')
    expect(backup).toBeDefined()
    expect(await readFile(join(backup!, 'cloudflared'), 'utf8')).toBe('recoverable previous executable')
    expect(await readdir(state)).toHaveLength(1)
  })
})
