import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { seedBundledExtensions } from '../src/bundled-extensions.js'
import { parseExtensionManifest } from '../src/extensions.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

const repoRoot = new URL('..', import.meta.url)

async function readRepo(relative: string): Promise<Buffer> {
  return readFile(new URL(relative, repoRoot))
}

describe('wallpaper pack', () => {
  it('seeds the bundled extension on first run and never overwrites user files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-wallpaper-'))
    temporaryDirectories.push(directory)
    expect(await seedBundledExtensions(directory)).toEqual(['wallpaper'])
    const seeded = await readFile(join(directory, 'wallpaper', 'mobile.js'))
    expect(seeded.equals(await readRepo('extensions/wallpaper/mobile/mobile.js'))).toBe(true)
    expect(parseExtensionManifest(JSON.parse(await readFile(join(directory, 'wallpaper', 'extension.json'), 'utf8'))).id)
      .toBe('wallpaper')
    // Second run restores nothing; a user marker survives.
    await writeFile(join(directory, 'wallpaper', 'user-note.txt'), 'mine')
    expect(await seedBundledExtensions(directory)).toEqual([])
    expect(await readFile(join(directory, 'wallpaper', 'user-note.txt'), 'utf8')).toBe('mine')
  })

  it('serves the referenced built-in asset from the extension directory', async () => {
    const mobile = await readRepo('extensions/wallpaper/mobile/mobile.js')
    expect(mobile.toString('utf8')).toContain("assetUrl('wallpaper-builtin.png')")
    const png = await readRepo('extensions/wallpaper/mobile/assets/wallpaper-builtin.png')
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true)
    expect(png.length).toBeLessThan(8 * 1024 * 1024)
    expect(png.readUInt32BE(16)).toBeGreaterThan(0)
  })

  it('keeps the desktop userstyle on the same built-in image', async () => {
    const css = (await readRepo('extensions/wallpaper/desktop/dsh-wallpaper.user.css')).toString('utf8')
    expect(css).toContain('==UserStyle==')
    expect(css).toContain('@var text bg-url')
    expect(css).toContain('127.0.0.1:3080')
    expect(css).toContain('html body #root')
    const match = /data:image\/png;base64,([A-Za-z0-9+/=]+)/u.exec(css)
    expect(match?.[1]).toBeDefined()
    const decoded = Buffer.from(match![1]!, 'base64')
    expect(decoded.equals(await readRepo('extensions/wallpaper/mobile/assets/wallpaper-builtin.png'))).toBe(true)
  })
})
