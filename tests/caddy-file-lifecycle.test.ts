import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CaddyComponentManager, CADDY_VERSION, type CaddyArtifact } from '../src/caddy-component.js'
import { ensureCaddyDirectory, removeCaddyTree, renameCaddyPath, writeCaddyPrivateFile } from '../src/caddy-files.js'
import { restrictPrivateFile } from '../src/private-file.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink), rmdir: vi.fn(actual.rmdir) }
})
// ACL behavior has its own tests; these fixtures exercise only the mutation owner.
vi.mock('../src/private-file.js', () => ({ restrictPrivateFile: vi.fn(async () => {}) }))
const native = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
const roots: string[] = []
let delays: number[] = []
const nativeTimeout = globalThis.setTimeout
function busy(code = 'EPERM'): NodeJS.ErrnoException { return Object.assign(new Error(code), { code }) }
async function directory(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-caddy-lifecycle-')); roots.push(root); return root
}
beforeEach(() => {
  vi.mocked(restrictPrivateFile).mockReset().mockResolvedValue(undefined)
  vi.mocked(fs.lstat).mockReset().mockImplementation(native.lstat)
  vi.mocked(fs.rename).mockReset().mockImplementation(native.rename)
  vi.mocked(fs.unlink).mockReset().mockImplementation(native.unlink)
  vi.mocked(fs.rmdir).mockReset().mockImplementation(native.rmdir)
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  delays = []
  // Virtual retry time only: the install deadline is neither advanced nor fired.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
    if (delay !== undefined && delay <= 400) {
      delays.push(delay); queueMicrotask(callback); return {} as NodeJS.Timeout
    }
    return nativeTimeout(callback, delay)
  }) as typeof setTimeout)
})
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  for (const root of roots.splice(0)) await native.rm(root, { recursive: true, force: true })
})

const bytes = new TextEncoder().encode('verified executable fixture')
const hash = createHash('sha256').update(bytes).digest('hex')
const artifact: CaddyArtifact = {
  version: CADDY_VERSION, platform: 'win32', arch: 'x64', downloadUrl: 'https://example.com/immutable/caddy.exe',
  downloadBytes: bytes.length, downloadSha256: hash, executableName: 'caddy.exe', executableBytes: bytes.length,
  executableSha256: hash, dnsPluginVersion: 'v0.4.3',
}
function manager(root: string, overrides: Partial<ConstructorParameters<typeof CaddyComponentManager>[0]> = {}) {
  return new CaddyComponentManager({ stateDirectory: root, platform: 'win32', arch: 'x64', artifact,
    fetchArtifact: async () => bytes,
    inspectExecutable: async () => ({ version: 'v2.11.6 h1:fixture', modules: 'dns.providers.tencentcloud v0.4.3\nNon-standard modules: 1\n' }),
    ...overrides })
}

describe('canonical Caddy file lifecycle', () => {
  it.each(['EPERM', 'EBUSY'])('recovers a short Windows %s rename transition', async code => {
    const root = await directory(); const source = join(root, 'source'); const destination = join(root, 'destination')
    await fs.writeFile(source, 'verified')
    vi.mocked(fs.rename).mockRejectedValueOnce(busy(code)).mockRejectedValueOnce(busy(code))
    await renameCaddyPath(root, source, destination)
    expect(await fs.readFile(destination, 'utf8')).toBe('verified')
    expect(delays).toEqual([50, 100]); expect(fs.rename).toHaveBeenCalledTimes(3)
  })
  it.each(['EPERM', 'EBUSY'])('bounds persistent Windows %s and retains the first error object', async code => {
    const root = await directory(); const original = busy(code)
    vi.mocked(fs.rename).mockRejectedValue(busy(code)).mockRejectedValueOnce(original)
    await expect(renameCaddyPath(root, join(root, 'source'), join(root, 'destination'))).rejects.toBe(original)
    expect(fs.rename).toHaveBeenCalledTimes(8)
    expect(delays).toEqual([50, 100, 200, 400, 400, 400, 400])
    expect(delays.reduce((total, delay) => total + delay, 0)).toBe(1950)
  })
  it.each(['EACCES', 'ENOENT', 'EXDEV'])('does not retry %s', async code => {
    const root = await directory(); const error = busy(code); vi.mocked(fs.rename).mockRejectedValue(error)
    await expect(renameCaddyPath(root, join(root, 'source'), join(root, 'destination'))).rejects.toBe(error)
    expect(fs.rename).toHaveBeenCalledTimes(1); expect(delays).toEqual([])
  })
  it.each(['linux', 'darwin'])('does not retry busy errors on %s', async platform => {
    vi.stubGlobal('process', { ...process, platform })
    const root = await directory(); const error = busy(); vi.mocked(fs.rename).mockRejectedValue(error)
    await expect(renameCaddyPath(root, join(root, 'source'), join(root, 'destination'))).rejects.toBe(error)
    expect(fs.rename).toHaveBeenCalledTimes(1); expect(delays).toEqual([])
  })
  it('routes private configuration atomic rename through the owner', async () => {
    const root = await directory(); const file = join(root, 'config.json')
    await fs.writeFile(file, 'old'); vi.mocked(fs.rename).mockRejectedValueOnce(busy('EBUSY'))
    await writeCaddyPrivateFile(root, file, 'new')
    expect(await fs.readFile(file, 'utf8')).toBe('new')
    expect(await fs.readdir(root)).toEqual(['config.json']); expect(delays).toEqual([50])
  })
  it('retries owned unlink and rmdir without descending into a junction target', async () => {
    const root = await directory(); const outside = await directory(); const target = join(root, 'tree')
    await fs.mkdir(target); await fs.writeFile(join(outside, 'keep'), 'outside')
    await fs.symlink(outside, join(target, 'link'), 'junction')
    vi.mocked(fs.unlink).mockRejectedValueOnce(busy('EBUSY'))
    vi.mocked(fs.rmdir).mockRejectedValueOnce(busy())
    await removeCaddyTree(root, target)
    expect(await fs.readFile(join(outside, 'keep'), 'utf8')).toBe('outside')
    expect(fs.unlink).toHaveBeenCalledTimes(2); expect(fs.rmdir).toHaveBeenCalledTimes(2)
    expect(delays).toEqual([50, 50])
  })
  it.each(['rename', 'unlink', 'rmdir'] as const)('rechecks parent safety before a %s retry', async operation => {
    const root = await directory(); const parent = join(root, 'owned'); const outside = await directory()
    await fs.mkdir(parent); const target = join(parent, 'target')
    if (operation === 'rmdir') await fs.mkdir(target)
    else await fs.writeFile(target, 'owned')
    const replaceParent = async () => {
      await native.rename(parent, join(root, 'displaced'))
      await native.symlink(outside, parent, 'junction')
      throw busy()
    }
    vi.mocked(fs[operation]).mockImplementationOnce(replaceParent)
    const task = operation === 'rename' ? renameCaddyPath(root, target, join(parent, 'new')) : removeCaddyTree(root, target)
    await expect(task).rejects.toThrow('caddy_path_invalid')
    expect(fs[operation]).toHaveBeenCalledTimes(1); expect(delays).toEqual([50])
    expect(await fs.readdir(outside)).toEqual([])
  })
  it.each(['unlink', 'rmdir'] as const)('bounds persistent %s busy failures and retains error identity', async operation => {
    const root = await directory(); const target = join(root, 'target'); const original = busy('EBUSY')
    if (operation === 'rmdir') await fs.mkdir(target)
    else await fs.writeFile(target, 'owned')
    vi.mocked(fs[operation]).mockRejectedValue(busy()).mockRejectedValueOnce(original)
    await expect(removeCaddyTree(root, target)).rejects.toBe(original)
    expect(fs[operation]).toHaveBeenCalledTimes(8)
    expect(delays.reduce((total, delay) => total + delay, 0)).toBe(1950)
  })
  it.each([
    ['unlink', 'win32', 'EACCES'], ['rmdir', 'win32', 'EACCES'],
    ['unlink', 'linux', 'EPERM'], ['rmdir', 'linux', 'EBUSY'],
  ] as const)('fails %s immediately on %s/%s', async (operation, platform, code) => {
    vi.stubGlobal('process', { ...process, platform })
    const root = await directory(); const target = join(root, 'target'); const error = busy(code)
    if (operation === 'rmdir') await fs.mkdir(target)
    else await fs.writeFile(target, 'owned')
    vi.mocked(fs[operation]).mockRejectedValue(error)
    await expect(removeCaddyTree(root, target)).rejects.toBe(error)
    expect(fs[operation]).toHaveBeenCalledTimes(1); expect(delays).toEqual([])
  })
  it.each(['rename', 'unlink', 'rmdir'] as const)('refuses a linked root before owned %s', async operation => {
    const root = await directory(); const outside = await directory(); const linkedRoot = join(root, 'link')
    await fs.symlink(outside, linkedRoot, 'junction'); const target = join(linkedRoot, 'target')
    const task = operation === 'rename' ? renameCaddyPath(linkedRoot, target, join(linkedRoot, 'new')) : removeCaddyTree(linkedRoot, target)
    await expect(task).rejects.toThrow('caddy_path_invalid')
    expect(fs[operation]).not.toHaveBeenCalled(); expect(delays).toEqual([])
  })
  it('retains config rename failure when bounded temporary cleanup also fails', async () => {
    const root = await directory(); const file = join(root, 'config.json'); const original = busy()
    await fs.writeFile(file, 'old')
    vi.mocked(fs.rename).mockRejectedValue(original)
    vi.mocked(fs.unlink).mockRejectedValue(busy('EBUSY'))
    await expect(writeCaddyPrivateFile(root, file, 'new')).rejects.toBe(original)
    expect(fs.rename).toHaveBeenCalledTimes(8); expect(fs.unlink).toHaveBeenCalledTimes(8)
    expect(await fs.readFile(file, 'utf8')).toBe('old')
  })
  it('retains default promotion error through busy candidate cleanup and restores the old installation', async () => {
    const root = await directory(); const first = manager(root); await first.install()
    vi.mocked(fs.rename).mockClear(); const original = busy()
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      if (String(source).includes('.install-')) throw original
      await native.rename(source, destination)
    })
    vi.mocked(fs.unlink).mockRejectedValue(busy('EBUSY'))
    const component = manager(root); await component.initialize()
    await expect(component.install()).rejects.toBe(original)
    expect(fs.rename).toHaveBeenCalledTimes(10); expect(fs.unlink).toHaveBeenCalledTimes(8)
    expect(delays.reduce((total, delay) => total + delay, 0)).toBe(3900)
    expect(createHash('sha256').update(await fs.readFile(component.executable)).digest('hex')).toBe(hash)
    await component.ensureExecutable()
    const entries = await fs.readdir(component.componentRoot)
    expect(entries).toContain(CADDY_VERSION); expect(entries.some(name => name.startsWith('.previous-'))).toBe(false)
  })
  it('checks destination ancestors and outside-root paths before rename', async () => {
    const root = await directory(); const outside = await directory(); const source = join(root, 'source')
    await fs.writeFile(source, 'owned'); await fs.symlink(outside, join(root, 'link'), 'junction')
    await expect(renameCaddyPath(root, source, join(root, 'link', 'new'))).rejects.toThrow('caddy_path_invalid')
    await expect(renameCaddyPath(root, source, join(outside, 'new'))).rejects.toThrow('caddy_path_invalid')
    expect(fs.rename).not.toHaveBeenCalled(); expect(await fs.readFile(source, 'utf8')).toBe('owned')
  })
  it('uses owner retry for default promotion and previous-installation backup', async () => {
    const root = await directory(); const first = manager(root); await first.install()
    vi.mocked(fs.rename).mockClear()
    const failed = new Set<string>()
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      const key = String(source)
      if (!failed.has(key)) { failed.add(key); throw busy() }
      await native.rename(source, destination)
    })
    const component = manager(root); await component.install(); await component.ensureExecutable()
    expect(component.status().installed).toBe(true); expect(delays).toEqual([50, 50])
    expect(await fs.readdir(component.componentRoot)).toEqual([CADDY_VERSION])
  })
  it.each([['EPERM', false], ['EBUSY', false], ['EPERM', true], ['EBUSY', true]] as const)('does not retry a %s validation failure afterMutation=%s', async (code, afterMutation) => {
    const root = await directory(); const error = busy(code)
    vi.mocked(fs.rename).mockRejectedValueOnce(busy())
    vi.mocked(fs.lstat).mockImplementation(async path => {
      if (!afterMutation || vi.mocked(fs.rename).mock.calls.length === 1) throw error
      return native.lstat(path)
    })
    await expect(renameCaddyPath(root, join(root, 'source'), join(root, 'destination'))).rejects.toBe(error)
    expect(fs.rename).toHaveBeenCalledTimes(afterMutation ? 1 : 0)
    expect(delays).toEqual(afterMutation ? [50] : [])
  })
  it('preserves private file setup failure without a config switch', async () => {
    const root = await directory(); const file = join(root, 'config.json'); const error = busy('EPERM')
    await fs.writeFile(file, 'old')
    vi.mocked(restrictPrivateFile).mockRejectedValueOnce(error)
    await expect(writeCaddyPrivateFile(root, file, 'new')).rejects.toBe(error)
    expect(await fs.readFile(file, 'utf8')).toBe('old'); expect(fs.rename).not.toHaveBeenCalled()
    expect(delays).toEqual([]); expect(await fs.readdir(root)).toEqual(['config.json'])
  })
  it('fails explicitly if a newly created owned directory cannot be secured', async () => {
    const root = await directory(); const child = join(root, 'new'); const error = busy('EPERM')
    vi.mocked(restrictPrivateFile).mockRejectedValueOnce(error)
    await expect(ensureCaddyDirectory(root, child)).rejects.toBe(error)
    expect(await fs.readdir(child)).toEqual([])
  })
  it('does not change inherited child ACLs when reusing an existing directory', async () => {
    const root = await directory(); const file = join(root, 'config.json')
    await fs.writeFile(file, 'old')
    await writeCaddyPrivateFile(root, file, 'new')
    expect(restrictPrivateFile).toHaveBeenCalledTimes(1)
    expect(restrictPrivateFile).not.toHaveBeenCalledWith(root, 0o700)
    expect(await fs.readFile(file, 'utf8')).toBe('new')
  })
  it('refuses a destination-only parent link introduced during rename backoff', async () => {
    const root = await directory(); const outside = await directory(); const destinationParent = join(root, 'destination')
    const source = join(root, 'source'); await fs.writeFile(source, 'owned'); await fs.mkdir(destinationParent)
    vi.mocked(fs.rename).mockImplementationOnce(async () => {
      await native.rename(destinationParent, join(root, 'displaced'))
      await native.symlink(outside, destinationParent, 'junction'); throw busy()
    })
    await expect(renameCaddyPath(root, source, join(destinationParent, 'new'))).rejects.toThrow('caddy_path_invalid')
    expect(fs.rename).toHaveBeenCalledTimes(1); expect(delays).toEqual([50])
    expect(await fs.readFile(source, 'utf8')).toBe('owned'); expect(await fs.readdir(outside)).toEqual([])
  })
  it('retains backup and reports both failures without a stale installed flag when rollback stays busy', async () => {
    const root = await directory(); const first = manager(root); await first.install()
    const component = manager(root); await component.initialize(); expect(component.status().installed).toBe(true)
    const promotion = busy('EPERM'); const rollback = busy('EBUSY')
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      if (String(source).includes('.install-')) throw promotion
      if (String(source).includes('.previous-')) throw rollback
      await native.rename(source, destination)
    })
    const failure = await component.install().catch(error => error)
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.message).toBe('caddy_component_rollback_failed')
    expect(failure.cause).toBe(promotion); expect(failure.errors).toEqual([promotion, rollback])
    expect(component.status()).toMatchObject({ installed: false, errorCode: 'caddy_component_invalid' })
    const entries = await fs.readdir(component.componentRoot)
    expect(entries).not.toContain(CADDY_VERSION)
    const backups = entries.filter(name => name.startsWith('.previous-')); expect(backups).toHaveLength(1)
    expect(createHash('sha256').update(await fs.readFile(join(component.componentRoot, backups[0]!, 'caddy.exe'))).digest('hex')).toBe(hash)
    expect(entries.some(name => name.startsWith('.install-'))).toBe(false)
    await expect(component.ensureExecutable()).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves the injected promotion seam and retries backup/rollback while restoring old bytes', async () => {
    const root = await directory(); const first = manager(root); await first.install()
    vi.mocked(fs.rename).mockClear()
    const failed = new Set<string>()
    vi.mocked(fs.rename).mockImplementation(async (source, destination) => {
      const key = String(source)
      if (!failed.has(key)) { failed.add(key); throw busy('EBUSY') }
      await native.rename(source, destination)
    })
    const error = new Error('promotion_failed'); const promoteDirectory = vi.fn(async () => { throw error })
    const component = manager(root, { promoteDirectory }); await component.initialize()
    await expect(component.install()).rejects.toBe(error)
    expect(promoteDirectory).toHaveBeenCalledTimes(1); expect(delays).toEqual([50, 50])
    expect(createHash('sha256').update(await fs.readFile(component.executable)).digest('hex')).toBe(hash)
    await component.ensureExecutable(); expect(await fs.readdir(component.componentRoot)).toEqual([CADDY_VERSION])
  })
})
