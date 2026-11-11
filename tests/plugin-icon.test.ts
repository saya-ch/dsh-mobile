import { readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
  readonly icon?: unknown
  readonly files?: unknown
  readonly exports?: unknown
}

/**
 * DSH reads a plugin icon from `package.json#icon` (relative path inside the package,
 * PNG/JPEG/WebP/SVG, at most 256 KiB) and falls back to its default glyph otherwise.
 * The manifest itself is only visible through the exported `./package.json` subpath.
 * These checks keep the declared file present, packaged and readable by that reader.
 */
describe('plugin icon metadata', () => {
  it('declares a package-relative PNG icon within the DSH size limit', () => {
    expect(typeof manifest.icon).toBe('string')
    const icon = manifest.icon as string
    expect(icon).toMatch(/^assets\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.png$/u)
    // DSH rejects a path that escapes the manifest directory; refuse it here first.
    expect(icon.split('/')).not.toContain('..')
    expect(icon.startsWith('/')).toBe(false)
    expect(icon.includes('\\')).toBe(false)
    const file = new URL(icon, root)
    const bytes = readFileSync(file)
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    expect(statSync(file).size).toBeLessThanOrEqual(256 * 1024)
    expect(bytes.toString('ascii', 12, 16)).toBe('IHDR')
    expect(bytes.readUInt32BE(16)).toBe(bytes.readUInt32BE(20))
  })

  it('ships the declared icon and reaches the manifest through the package export', () => {
    expect(Array.isArray(manifest.files)).toBe(true)
    expect(manifest.files as string[]).toContain(manifest.icon as string)
    // Without this subpath export DSH cannot read the manifest, and the icon silently disappears.
    expect((manifest.exports as Record<string, unknown> | undefined)?.['./package.json'])
      .toBe('./package.json')
  })
})
