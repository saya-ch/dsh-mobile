import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('DeepSeek Harness compatibility', () => {
  it('declares DSH host families without enumerating individual prereleases', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'))
    expect(lock.packages[''].peerDependencies).toEqual(manifest.peerDependencies)
    for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      if (!name.startsWith('@deepseek-ai/dsh-')) continue
      expect(range).toContain('^0.1.2-0')
      expect(range).toContain('^0.1.3-0')
      expect(range).not.toMatch(/0\.1\.2-alpha\.\d/u)
    }
  })

  it('does not reject the host by its package version during startup', async () => {
    const source = await readFile(new URL('../src/plugin.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/assertSupportedDshVersion|SUPPORTED_DSH_VERSIONS/u)
  })
})
