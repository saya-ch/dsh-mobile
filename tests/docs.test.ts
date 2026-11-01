import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

interface Finding { file: string; line: number; message: string }
const checkerUrl = new URL('../scripts/check-docs.mjs', import.meta.url)
const checker: {
  listDocumentationFiles: (root: string, candidates?: readonly string[]) => Promise<string[]>
  validateDocumentation: (root: string, files: readonly string[]) => Promise<Finding[]>
} = await import(checkerUrl.href)
const roots: string[] = []
const prefix = 'dsh-mobile-docs-test-'

afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (resolve(root) === root && basename(root).startsWith(prefix) && resolve(root, '..') === resolve(tmpdir())) {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    } else throw new Error('Refusing to remove an unowned documentation fixture')
  }
})

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  for (const [name, source] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), source)
  }
  return root
}

describe('documentation checks', () => {
  it('ships both baseline guides linked by the published documentation index', async () => {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { files: readonly string[] }
    for (const guide of ['docs/MOBILE_PLUGIN_BASELINE.md', 'docs/MOBILE_PLUGIN_BASELINE.en.md']) {
      expect(manifest.files).toContain(guide)
    }
  })

  it('lists source Markdown without generated trees or duplicate entries', async () => {
    expect(await checker.listDocumentationFiles('.', ['README.md', 'docs/guide.md', 'docs\\guide.md', 'node_modules/a/README.md', 'vendor/a.md', 'build/a.md', '.git/a.md', 'src/a.ts', 'NEW.md']))
      .toEqual(['NEW.md', 'README.md', 'docs/guide.md'])
  })

  it('uses the real repository inventory without traversing ignored output', async () => {
    const files = await checker.listDocumentationFiles(fileURLToPath(new URL('../', import.meta.url)))
    expect(files).toContain('README.md')
    expect(files).toContain('docs/README.md')
    expect(files.every(file => !file.includes('node_modules/') && !file.includes('/build/'))).toBe(true)
  })

  it('accepts local links, HTML images, reference links, explicit anchors and owned raw assets', async () => {
    const root = await fixture({
      'README.md': '# Welcome\n\n[Guide](docs/guide.md#hello-world) · [Named](docs/guide.md#named)\n[Reference][guide]\n[guide]: docs/guide.md#hello-world\n![Asset](<assets/my image.png>)\n<img src="assets/my%20image.png">\n<img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/my%20image.png">\n',
      'docs/guide.md': '# Hello, **World**!\n\n<a id="named"></a>\n<p><sub>Caption</sub></p>\n',
      'assets/my image.png': 'fixture',
    })
    expect(await checker.validateDocumentation(root, ['README.md', 'docs/guide.md'])).toEqual([])
  })

  it('matches Unicode, duplicate and setext heading fragments', async () => {
    const root = await fixture({
      'README.md': '# 通用 设置\n# 通用 设置\n# 通用 设置-1\n\n## `App` &amp; **Browser** / Notes\n\nSetext heading\n==============\n\n[One](#通用-设置) [Two](#通用-设置-1) [Three](#通用-设置-1-1)\n[Styled](#app--browser--notes) [Setext](#setext-heading)\n',
    })
    expect(await checker.validateDocumentation(root, ['README.md'])).toEqual([])
  })

  it('rejects stale local section links rather than accepting an existing file alone', async () => {
    const root = await fixture({ 'README.md': '[Browser](README.en.md#app-and-browser)\n', 'README.en.md': '## App and mobile browser\n' })
    expect(await checker.validateDocumentation(root, ['README.md', 'README.en.md']))
      .toEqual([{ file: 'README.md', line: 1, message: 'Missing local fragment: README.en.md#app-and-browser' }])
  })

  it('rejects missing Markdown, HTML and owned raw-asset targets', async () => {
    const root = await fixture({ 'README.md': '[Missing](missing.md)\n![Image](missing.png)\n<a href="missing.html">Page</a>\n<img src="https://raw.githubusercontent.com/saya-ch/dsh-mobile/main/assets/missing.png">\n' })
    const findings = await checker.validateDocumentation(root, ['README.md'])
    expect(findings).toHaveLength(4)
    expect(findings.every(finding => finding.message.startsWith('Missing local target:'))).toBe(true)
  })

  it('ignores fenced examples, inline code, HTML comments and external URLs', async () => {
    const root = await fixture({ 'README.md': '# Actual\n\n~~~markdown\n[Example](missing.md)\n<details>\n~~~\n\n`[Example](missing.md) <p>`\n``code on\n[Example](missing.md)\nnext line``\n<!--\n[Hidden](missing.md)\n<sub>\n-->\n[^note]: A footnote is not a link destination.\n[External](https://example.invalid/never-fetched#not-a-local-anchor)\n' })
    expect(await checker.validateDocumentation(root, ['README.md'])).toEqual([])
  })

  it.each(['CRLF', 'mixed'])('accepts paired list-indented fences with %s line endings without rewriting bytes', async endings => {
    const lf = '# Guide\n\n1. First step:\n   ```sh\n   [Example](missing.md)\n   ```\n2. Next step:\n   ```text\n   <details>\n   ```\n'
    const source = endings === 'CRLF' ? lf.replaceAll('\n', '\r\n') : lf.replaceAll('   ```\n', '   ```\r\n')
    const root = await fixture({ 'README.md': source })
    expect(await checker.validateDocumentation(root, ['README.md'])).toEqual([])
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe(source)
  })

  it('checks multiline HTML attributes and explicit SVG anchors without imposing Markdown EOF rules on assets', async () => {
    const root = await fixture({
      'README.md': '<a title="1 > 0"\n href="assets/icon.svg#whale">Icon</a>\n<img\n src="missing.png">\n',
      'assets/icon.svg': '<svg><path id="whale"/></svg>',
    })
    expect(await checker.validateDocumentation(root, ['README.md']))
      .toEqual([{ file: 'README.md', line: 3, message: 'Missing local target: missing.png' }])
  })

  it.each(['LF', 'CRLF', 'mixed'])('reports an unclosed %s fence without parsing the unfinished example as prose', async endings => {
    const lf = '# Actual\n\n```markdown\n[Example](missing.md)\n<details>\n'
    const source = endings === 'CRLF' ? lf.replaceAll('\n', '\r\n') : endings === 'mixed' ? lf.replace('# Actual\n', '# Actual\r\n') : lf
    const root = await fixture({ 'README.md': source })
    expect(await checker.validateDocumentation(root, ['README.md']))
      .toEqual([{ file: 'README.md', line: 3, message: 'Unclosed fenced code block' }])
  })

  it.each(['details', 'table', 'p', 'sub'])('rejects unclosed <%s> HTML', async tag => {
    const root = await fixture({ 'README.md': `<${tag}>\nText\n` })
    expect(await checker.validateDocumentation(root, ['README.md']))
      .toEqual([{ file: 'README.md', line: 1, message: `Unclosed <${tag}>` }])
  })

  it('rejects crossed and unmatched closing tags', async () => {
    const root = await fixture({ 'README.md': '<p><sub>Caption</p></sub>\n</details>\n' })
    const findings = await checker.validateDocumentation(root, ['README.md'])
    expect(findings.some(finding => finding.message === 'Unexpected closing </p>')).toBe(true)
    expect(findings.some(finding => finding.message === 'Unexpected closing </details>')).toBe(true)
    expect(findings.some(finding => finding.message === 'Unclosed <p>')).toBe(true)
  })

  it('accepts one LF or CRLF and rejects absent or repeated EOF newlines', async () => {
    const root = await fixture({ 'lf.md': '# LF\n', 'crlf.md': '# CRLF\r\n', 'missing.md': '# Missing', 'double.md': '# Double\r\n\r\n' })
    expect(await checker.validateDocumentation(root, ['lf.md', 'crlf.md'])).toEqual([])
    expect((await checker.validateDocumentation(root, ['missing.md', 'double.md'])).map(finding => finding.message))
      .toEqual(['File must end with exactly one newline', 'File must end with exactly one newline'])
  })

  it('handles escaped parentheses and rejects malformed encoding or escaping the root', async () => {
    const root = await fixture({ 'README.md': '[Parentheses](docs/a\\(b\\).md#section)\n[Encoding](bad%zz.md)\n[Outside](../outside.md)\n', 'docs/a(b).md': '# Section\n' })
    expect((await checker.validateDocumentation(root, ['README.md'])).map(finding => finding.message))
      .toEqual(['Invalid local URL encoding: bad%zz.md', 'Local target is outside the repository: ../outside.md'])
  })

  it('uses the same CLI entry path for passing and rejected documents', async () => {
    const root = await fixture({ 'README.md': '# Good\n\n[Section](#good)\n' })
    const run = () => spawnSync(process.execPath, [fileURLToPath(checkerUrl), '--root', root, '--files', 'README.md'],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    const valid = run()
    expect(valid.error).toBeUndefined()
    expect(valid.signal).toBeNull()
    expect(valid.status).toBe(0)
    expect(valid.stdout).toContain('documentation check passed: 1 Markdown files')
    await writeFile(join(root, 'README.md'), '# Good\n\n[Section](#missing)\n')
    const invalid = run()
    expect(invalid.error).toBeUndefined()
    expect(invalid.signal).toBeNull()
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('Missing local fragment: #missing')
  })
})
