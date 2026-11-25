import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify, TextDecoder } from 'node:util'

const execFile = promisify(execFileCallback)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'native/funnel-host')
const executable = resolve(root, 'packages/funnel-win32-x64/dsh-mobile-funnel-win32-x64.exe')
const output = resolve(root, 'FUNNEL_THIRD_PARTY_LICENSES.txt')
const workspaceGo = resolve(root, '../go/bin/go.exe')
const go = process.env.GO_BINARY || (process.platform === 'win32' && existsSync(workspaceGo) ? workspaceGo : 'go')
const licenseName = /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:\.(?:txt|md|rst|html|htm))?$/i
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function goJson(args) {
  const { stdout } = await execFile(go, args, { cwd: source, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
  return JSON.parse(stdout)
}

function resolvedDependency(dependency) {
  if (dependency.Replace !== undefined) {
    throw new Error(`Funnel dependency ${JSON.stringify(dependency.Path)} uses a module replacement`)
  }
  if (typeof dependency.Path !== 'string' || typeof dependency.Version !== 'string'
    || typeof dependency.Sum !== 'string' || dependency.Version === '' || dependency.Sum === '') {
    throw new Error(`Funnel dependency ${JSON.stringify(dependency.Path)} does not have reproducible module metadata`)
  }
  return {
    label: `${dependency.Path}@${dependency.Version}`,
    path: dependency.Path,
    version: dependency.Version,
    sum: dependency.Sum,
  }
}

async function licenseSection(path, label) {
  const bytes = await readFile(path)
  if (bytes.byteLength === 0 || bytes.byteLength > 1024 * 1024 || bytes.includes(0)) {
    throw new Error(`Invalid license file ${label}`)
  }
  let text
  try {
    text = utf8Decoder.decode(bytes)
  } catch {
    throw new Error(`License file ${label} is not valid UTF-8`)
  }
  text = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trimEnd()
  if (text === '') throw new Error(`License file ${label} is empty after normalization`)
  return [
    `--- BEGIN ${label} ---`,
    `SHA-256: ${sha256(bytes)}`,
    '',
    text,
    `--- END ${label} ---`,
  ].join('\n')
}

async function moduleLicense(module) {
  const downloaded = await goJson(['mod', 'download', '-json', `${module.path}@${module.version}`])
  if (downloaded.Path !== module.path || downloaded.Version !== module.version || downloaded.Sum !== module.sum
    || typeof downloaded.Dir !== 'string' || downloaded.Dir === '') {
    throw new Error(`Downloaded metadata does not match embedded module ${module.label}`)
  }
  const entries = (await readdir(downloaded.Dir, { withFileTypes: true }))
    .filter(entry => entry.isFile() && licenseName.test(entry.name))
    .sort((left, right) => compareText(left.name, right.name))
  if (entries.length === 0) throw new Error(`Embedded module ${module.label} has no top-level license or notice file`)

  const sections = []
  for (const entry of entries) {
    sections.push(await licenseSection(resolve(downloaded.Dir, entry.name), entry.name))
  }
  return [
    `Module: ${module.label}`,
    `Module sum: ${module.sum}`,
    `Files: ${entries.map(entry => entry.name).join(', ')}`,
    '',
    sections.join('\n\n'),
  ].join('\n')
}

async function generate() {
  if (!existsSync(executable)) throw new Error('Bundled Funnel executable is missing; run npm run build:funnel-host first')
  const executableDigest = sha256(await readFile(executable))
  const build = await goJson(['version', '-m', '-json', executable])
  if (build.Path !== 'github.com/saya-ch/dsh-mobile/native/funnel-host'
    || !Array.isArray(build.Deps) || build.Deps.length === 0) {
    throw new Error('Bundled Funnel executable has unexpected Go build metadata')
  }
  const goModule = await readFile(resolve(source, 'go.mod'), 'utf8')
  const goDirective = goModule.match(/^go (\d+\.\d+\.\d+)$/mu)?.[1]
  if (goDirective === undefined || build.GoVersion !== `go${goDirective}`) {
    throw new Error(`Bundled Funnel executable Go version ${JSON.stringify(build.GoVersion)} does not match go.mod`)
  }
  const settings = new Map((build.Settings ?? []).map(setting => [setting.Key, setting.Value]))
  for (const [key, expected] of [['GOOS', 'windows'], ['GOARCH', 'amd64'], ['CGO_ENABLED', '0'], ['-trimpath', 'true']]) {
    if (settings.get(key) !== expected) {
      throw new Error(`Bundled Funnel executable must set ${key}=${expected}`)
    }
  }
  const modules = build.Deps.map(resolvedDependency).sort((left, right) => compareText(left.label, right.label))
  const seen = new Set()
  for (const module of modules) {
    const key = `${module.path}@${module.version}`
    if (seen.has(key)) throw new Error(`Bundled Funnel executable contains duplicate module ${key}`)
    seen.add(key)
  }
  const licenses = []
  for (const module of modules) licenses.push(await moduleLicense(module))
  const goEnvironment = await goJson(['env', '-json', 'GOROOT'])
  if (typeof goEnvironment.GOROOT !== 'string' || goEnvironment.GOROOT === '') {
    throw new Error('Go toolchain did not report GOROOT')
  }
  const toolchainLicenses = [
    'Go toolchain files: LICENSE, PATENTS',
    '',
    await licenseSection(resolve(goEnvironment.GOROOT, 'LICENSE'), 'Go toolchain LICENSE'),
    '',
    await licenseSection(resolve(goEnvironment.GOROOT, 'PATENTS'), 'Go toolchain PATENTS'),
  ].join('\n')
  return [
    'DSH Mobile Funnel Host - Third-Party Licenses',
    '',
    'This file is generated from the Go module metadata embedded in',
    'packages/funnel-win32-x64/dsh-mobile-funnel-win32-x64.exe. DSH Mobile itself is licensed under',
    'the repository root LICENSE file. Do not edit this generated file by hand.',
    '',
    `Source binary SHA-256: ${executableDigest}`,
    `Go toolchain: ${build.GoVersion}`,
    `Embedded third-party modules: ${String(modules.length)}`,
    '',
    toolchainLicenses,
    `\n${'='.repeat(80)}\n`,
    licenses.join(`\n\n${'='.repeat(80)}\n\n`),
    '',
  ].join('\n')
}

async function main() {
  if (process.argv.includes('--write')) {
    const generated = await generate()
    await writeFile(output, generated, 'utf8')
    console.log(`wrote ${output}`)
    return
  }
  let existing
  try {
    existing = await readFile(output, 'utf8')
  } catch {
    throw new Error('FUNNEL_THIRD_PARTY_LICENSES.txt is missing; run npm run generate:funnel-licenses')
  }
  if (!existsSync(executable)) throw new Error('Bundled Funnel executable is missing; run npm run build:funnel-host first')
  const embeddedDigest = existing.match(/^Source binary SHA-256: ([a-f0-9]{64})$/mu)?.[1]
  const executableDigest = sha256(await readFile(executable))
  if (embeddedDigest !== executableDigest) {
    throw new Error(`Funnel executable SHA-256 does not match FUNNEL_THIRD_PARTY_LICENSES.txt (recorded: ${embeddedDigest ?? 'missing'}, actual: ${executableDigest}); run npm run generate:funnel-licenses`)
  }
  const moduleCount = existing.match(/^Embedded third-party modules: ([1-9]\d*)$/mu)?.[1]
  if (moduleCount === undefined || Number(moduleCount) !== (existing.match(/^Module: /gmu) ?? []).length) {
    throw new Error('FUNNEL_THIRD_PARTY_LICENSES.txt has invalid module metadata')
  }
  const beginSections = existing.match(/^--- BEGIN .+ ---$/gmu) ?? []
  const endSections = existing.match(/^--- END .+ ---$/gmu) ?? []
  if (!/^Go toolchain: go\d+\.\d+\.\d+$/mu.test(existing)
    || !existing.includes('--- BEGIN Go toolchain LICENSE ---')
    || !existing.includes('--- BEGIN Go toolchain PATENTS ---')
    || beginSections.length !== endSections.length
    || beginSections.length < Number(moduleCount) + 2) {
    throw new Error('FUNNEL_THIRD_PARTY_LICENSES.txt has incomplete license sections')
  }
  if (process.argv.includes('--full-check')) {
    const generated = await generate()
    if (existing !== generated) {
      throw new Error('FUNNEL_THIRD_PARTY_LICENSES.txt content differs from the verified module licenses; run npm run generate:funnel-licenses')
    }
  }
  console.log(`Funnel third-party licenses ok: ${moduleCount} modules`)
}

main().catch(error => {
  console.error(`Funnel license check failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
