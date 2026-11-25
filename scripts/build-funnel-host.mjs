import { execFile as execFileCallback } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'native/funnel-host')
const workspaceGo = resolve(root, '../go/bin/go.exe')
const go = process.env.GO_BINARY || (process.platform === 'win32' && existsSync(workspaceGo) ? workspaceGo : 'go')

/**
 * Every Funnel sidecar is published as its own platform package: npm installs
 * only the optional dependency whose os/cpu fields match the current machine,
 * so the main dsh-mobile package no longer carries ~62 MB of foreign binaries.
 * Each target is still built reproducibly from this one source tree.
 *
 * `cpuType` is the Mach-O cputype the cross-build must declare: CPU_TYPE_X86_64
 * for darwin/amd64 and CPU_TYPE_ARM64 for darwin/arm64.
 */
const targets = [
  { goos: 'windows', goarch: 'amd64', package: 'funnel-win32-x64', file: 'dsh-mobile-funnel-win32-x64.exe', header: 'MZ' },
  { goos: 'linux', goarch: 'amd64', package: 'funnel-linux-x64', file: 'dsh-mobile-funnel-linux-x64', header: 'ELF' },
  { goos: 'linux', goarch: 'arm64', package: 'funnel-linux-arm64', file: 'dsh-mobile-funnel-linux-arm64', header: 'ELF' },
  { goos: 'darwin', goarch: 'amd64', package: 'funnel-darwin-x64', file: 'dsh-mobile-funnel-darwin-x64', header: 'Mach-O', cpuType: 0x01000007 },
  { goos: 'darwin', goarch: 'arm64', package: 'funnel-darwin-arm64', file: 'dsh-mobile-funnel-darwin-arm64', header: 'Mach-O', cpuType: 0x0100000c },
]

/**
 * Classify a compiled executable from its leading bytes. A cross-build that
 * silently produced the wrong format (or the wrong Mach-O architecture) must
 * fail here instead of shipping in a platform package.
 */
function executableHeader(bytes, target) {
  if (bytes.byteLength < 8) return 'unknown'
  if (target.header === 'MZ') return bytes.subarray(0, 2).toString('ascii') === 'MZ' ? 'MZ' : 'unknown'
  if (target.header === 'ELF') {
    return bytes[0] === 0x7f && bytes.subarray(1, 4).toString('ascii') === 'ELF' ? 'ELF' : 'unknown'
  }
  // 64-bit Mach-O stores MH_MAGIC_64 (0xFEEDFACF) little-endian, then its cputype.
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) return 'unknown'
  return bytes.readUInt32LE(4) === target.cpuType ? 'Mach-O' : 'unknown'
}

for (const target of targets) {
  const outputDirectory = resolve(root, 'packages', target.package)
  await mkdir(outputDirectory, { recursive: true })
  const output = resolve(outputDirectory, target.file)
  await execFile(go, [
    'build',
    '-trimpath',
    '-buildvcs=false',
    // Omit build-cache action IDs; retain module metadata for license verification.
    '-ldflags=-s -w -buildid=',
    '-o',
    output,
    '.',
  ], {
    cwd: source,
    env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
    windowsHide: true,
  })
  const header = executableHeader(await readFile(output), target)
  if (header !== target.header) {
    throw new Error(`funnel host build did not produce a ${target.header} binary for ${target.goos}/${target.goarch}: ${output}`)
  }
  console.log(`built ${output}`)
}
