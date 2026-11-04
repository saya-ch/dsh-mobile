import { describe, expect, it } from 'vitest'
import { MAC_FULL_DISK_ACCESS_PANE, MacFileAccessProbe, openMacFullDiskAccessSettings } from '../src/macos-file-access.js'

const DATABASE = '/Users/tester/Library/Application Support/com.apple.TCC/TCC.db'

describe('macOS Full Disk Access probe', () => {
  it('never touches the file system on other platforms', async () => {
    let reads = 0
    const probe = new MacFileAccessProbe({ platform: 'win32', readAccess: async () => { reads += 1 } })
    expect(probe.applicable).toBe(false)
    expect(probe.status()).toBe('ok')
    expect(await probe.refresh()).toBe('ok')
    expect(reads).toBe(0)
  })

  it('reports ok when the user TCC database is readable', async () => {
    const paths: string[] = []
    const probe = new MacFileAccessProbe({
      platform: 'darwin',
      home: '/Users/tester',
      readAccess: async (path) => { paths.push(path) },
    })
    expect(probe.status()).toBe('missing')
    expect(await probe.refresh()).toBe('ok')
    expect(probe.status()).toBe('ok')
    expect(paths).toEqual([DATABASE])
  })

  it('reports missing when the read is denied', async () => {
    const probe = new MacFileAccessProbe({
      platform: 'darwin',
      readAccess: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) },
    })
    expect(await probe.refresh()).toBe('missing')
    expect(probe.status()).toBe('missing')
  })

  it('retries a missing result no faster than the retry budget', async () => {
    let reads = 0
    let clock = 0
    const probe = new MacFileAccessProbe({
      platform: 'darwin',
      retryMs: 2_000,
      now: () => clock,
      readAccess: async () => { reads += 1; throw new Error('denied') },
    })
    await probe.refresh()
    await probe.refresh()
    expect(reads).toBe(1)
    clock = 2_000
    await probe.refresh()
    expect(reads).toBe(2)
  })

  it('stops probing once the grant is present', async () => {
    let reads = 0
    let clock = 0
    const probe = new MacFileAccessProbe({
      platform: 'darwin',
      retryMs: 0,
      now: () => clock,
      readAccess: async () => { reads += 1 },
    })
    await probe.refresh()
    clock = 60_000
    await probe.refresh()
    expect(reads).toBe(1)
  })

  it('treats a probe that never settles as missing', async () => {
    const probe = new MacFileAccessProbe({
      platform: 'darwin',
      timeoutMs: 20,
      readAccess: () => new Promise<void>(() => {}),
    })
    expect(await probe.refresh()).toBe('missing')
  })
})

describe('macOS Full Disk Access settings opener', () => {
  it('opens the pane through the system open command', async () => {
    const calls: Array<[string, readonly string[]]> = []
    await openMacFullDiskAccessSettings(async (file, args) => { calls.push([file, args]) })
    expect(calls).toEqual([['/usr/bin/open', [MAC_FULL_DISK_ACCESS_PANE]]])
  })
})
