import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FunnelController } from '../src/funnel.js'
import { ensureFrpIngressCertificate, frpIngressPaths, frpIngressSelfCheck, purgeFrpIngressCertificates } from '../src/frp-ingress.js'
import { parseFrpSettings } from '../src/frp-config.js'
import { readFrpIngressTrustAnchor } from '../src/plugin.js'
import { JsonMobileAccessControlStore } from '../src/control.js'

const roots: string[] = []
const links: string[] = []
const controllers: FunnelController[] = []
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close()
  for (const path of links.splice(0)) {
    const entry = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined })
    if (entry?.isSymbolicLink()) await unlink(path)
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(): Promise<{ state: string; outside: string; sentinel: string; executable: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-path-')); roots.push(root)
  const state = join(root, 'mobile-access'); const outside = join(root, 'outside')
  await mkdir(state); await mkdir(outside)
  const sentinel = join(outside, 'keep'); await writeFile(sentinel, 'outside must survive')
  const executable = join(root, 'owned-test-sidecar.exe'); await writeFile(executable, 'must not be launched')
  return { state, outside, sentinel, executable }
}
async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir'); links.push(path)
}
function funnel(state: string, stateDirectory: string, executable: string, explicitRoot = true) {
  const store = { load: async () => ({ version: 1 as const, enabled: false }), save: vi.fn(async () => {}) }
  const createGateway = vi.fn(async () => { throw new Error('a rejected state must not start a gateway') })
  const controller = new FunnelController({ store, executable, stateDirectory, hostname: 'test-node', createGateway, ...(explicitRoot ? { ownedRoot: state } : {}) })
  controllers.push(controller)
  return { controller, store, createGateway }
}
const ingressSettings = parseFrpSettings({ serverAddress: '1.2.3.4', serverPort: 7000, token: '0123456789abcdef0123456789abcdef', publicOrigin: 'https://1.2.3.4', mode: 'attach', entryTls: 'self-signed' })

describe('private remote state ownership', () => {
  it('Funnel does not launch or reset through an internal remote ancestor junction', async () => {
    const { state, outside, sentinel, executable } = await fixture()
    await mkdir(join(outside, 'tailscale')); await writeFile(join(outside, 'tailscale', 'private-node-state'), 'external node')
    await linkDirectory(outside, join(state, 'remote'))
    const { controller, createGateway, store } = funnel(state, join(state, 'remote', 'tailscale'), executable)
    await controller.initialize()
    expect(controller.status()).toMatchObject({ enabled: false, state: 'unavailable', errorCode: 'funnel_state_invalid' })
    await expect(controller.setEnabled(true)).rejects.toThrow('funnel_path_invalid')
    await expect(controller.reconnect()).rejects.toThrow('funnel_path_invalid')
    await expect(controller.reset()).rejects.toThrow('funnel_path_invalid')
    expect(controller.status()).toMatchObject({ enabled: false, state: 'off', errorCode: 'funnel_state_invalid' })
    expect(store.save).not.toHaveBeenCalled()
    expect(createGateway).not.toHaveBeenCalled()
    expect(await readFile(join(outside, 'tailscale', 'private-node-state'), 'utf8')).toBe('external node')
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
  })

  it('Funnel removes its selected state-directory link itself, not the linked node', async () => {
    const { state, outside, sentinel, executable } = await fixture()
    await mkdir(join(state, 'remote')); const selected = join(state, 'remote', 'tailscale')
    await linkDirectory(outside, selected)
    const { controller } = funnel(state, selected, executable)
    await controller.initialize(); await controller.reset()
    await expect(lstat(selected)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
  })

  it('Funnel reset never saves control state through the selected leaf link', async () => {
    const { state, outside, sentinel, executable } = await fixture()
    await mkdir(join(state, 'remote')); const selected = join(state, 'remote', 'tailscale')
    await writeFile(join(outside, 'control.json'), '{"version":1,"enabled":true}\n')
    await linkDirectory(outside, selected)
    const store = new JsonMobileAccessControlStore(join(selected, 'control.json'), false)
    const controller = new FunnelController({ store, executable, stateDirectory: selected, ownedRoot: state, hostname: 'test-node', createGateway: async () => { throw new Error('not started') } })
    controllers.push(controller)
    await controller.initialize()
    expect(controller.status()).toMatchObject({ enabled: false, state: 'unavailable', errorCode: 'funnel_state_invalid' })
    await controller.reset()
    const realDirectory = await lstat(selected)
    expect(realDirectory.isDirectory()).toBe(true); expect(realDirectory.isSymbolicLink()).toBe(false)
    expect(JSON.parse(await readFile(join(selected, 'control.json'), 'utf8'))).toEqual({ version: 1, enabled: false })
    expect(await readFile(join(outside, 'control.json'), 'utf8')).toBe('{"version":1,"enabled":true}\n')
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
  })

  it('keeps the explicit standalone Funnel state directory reset compatible and leaves its siblings', async () => {
    const { state, outside, sentinel, executable } = await fixture()
    const selected = join(state, 'standalone-node'); await mkdir(selected)
    await writeFile(join(selected, 'state'), 'owned node'); await writeFile(join(state, 'other-provider'), 'keep')
    const { controller } = funnel(state, selected, executable, false)
    await controller.initialize(); await controller.reset()
    await expect(lstat(selected)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(state, 'other-provider'), 'utf8')).toBe('keep')
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
    expect(await readdir(outside)).toEqual(['keep'])
  })

  it('FRP does not read, create or delete ingress material through an internal remote ancestor junction', async () => {
    const { state, outside, sentinel } = await fixture()
    await mkdir(join(outside, 'frp', 'ingress'), { recursive: true })
    const certificate = join(outside, 'frp', 'ingress', 'ca.pem'); await writeFile(certificate, 'external CA')
    await linkDirectory(outside, join(state, 'remote'))
    const stateFile = join(state, 'remote', 'frp', 'devices.json')
    await expect(ensureFrpIngressCertificate(ingressSettings, stateFile, Date.now(), undefined, state)).rejects.toThrow('frp_ingress_path_invalid')
    await expect(frpIngressSelfCheck(ingressSettings, stateFile, state)).rejects.toThrow('frp_ingress_path_invalid')
    await expect(readFrpIngressTrustAnchor(ingressSettings, stateFile, state)).rejects.toThrow('frp_ingress_ca_invalid')
    await expect(purgeFrpIngressCertificates(stateFile, state)).rejects.toThrow('frp_ingress_path_invalid')
    expect(await readFile(certificate, 'utf8')).toBe('external CA')
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
    expect(await readdir(join(outside, 'frp'))).toEqual(['ingress'])
  })

  it('FRP purge unlinks only a selected ingress junction and retains unrelated private files', async () => {
    const { state, outside, sentinel } = await fixture()
    const directory = join(state, 'remote', 'frp'); await mkdir(directory, { recursive: true })
    const stateFile = join(directory, 'devices.json'); const paths = frpIngressPaths(stateFile)
    await writeFile(paths.statusFile, 'owned identity'); await writeFile(stateFile, 'paired devices')
    await linkDirectory(outside, paths.directory)
    await expect(ensureFrpIngressCertificate(ingressSettings, stateFile, Date.now(), undefined, state)).rejects.toThrow('frp_ingress_path_invalid')
    await purgeFrpIngressCertificates(stateFile, state)
    await expect(lstat(paths.directory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(paths.statusFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(stateFile, 'utf8')).toBe('paired devices')
    expect(await readFile(sentinel, 'utf8')).toBe('outside must survive')
  })
})
