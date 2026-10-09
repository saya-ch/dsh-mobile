import { spawn } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'

export const QUESTION_FIXES_PACKAGE = 'dsh-mobile-question-fixes'

/** Run one owned packaging command and await its exit, including on timeout. */
export async function runPackagingCommand(command, args, cwd, overrides = {}) {
  const environment = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }
  for (const name of Object.keys(environment)) {
    if (/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)) delete environment[name]
  }
  Object.assign(environment, overrides)
  const child = spawn(command, args, {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-40_000) })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-40_000) })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 180_000)
  try {
    const result = await new Promise((fulfill, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { fulfill({ code, signal }) })
    })
    if (timedOut || result.code !== 0 || result.signal !== null) {
      throw new Error(`Packaging command failed (${JSON.stringify({ ...result, timedOut })}): ${command}\n${stdout}\n${stderr}`)
    }
    return stdout
  } finally { clearTimeout(timer) }
}

/** Locate npm's JavaScript entry so Windows runs it without a command shell. */
export async function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    if (candidate === undefined || !candidate.endsWith('npm-cli.js')) continue
    try { await access(candidate) } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    return candidate
  }
  throw new Error('Cannot locate npm-cli.js; run this smoke through npm run smoke:dsh-boot')
}

/** Produce the actual npm tarball; npm's files rules select every shipped file. */
export async function packBundle(source, destination) {
  const output = await runPackagingCommand(process.execPath, [
    await npmCli(), 'pack', '--ignore-scripts', '--json', '--pack-destination', destination,
  ], source)
  const [packed] = JSON.parse(output)
  if (typeof packed?.filename !== 'string' || /[/\\]/u.test(packed.filename)) {
    throw new Error('npm pack returned no package filename')
  }
  return join(destination, packed.filename)
}

/** Read an npm-owned tarball manifest without extracting executable files. */
export async function packedManifest(tarball) {
  const archive = await promisify(gunzip)(await readFile(tarball))
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '')
    if (name === '') break
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim(), 8)
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) throw new Error('Malformed npm tarball')
    if (name === 'package/package.json') return JSON.parse(archive.subarray(offset + 512, offset + 512 + size).toString('utf8'))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('npm tarball has no package/package.json')
}

/** Install through DSH's actual pnpm invocation in the owned profile. */
export async function installPackedBundle(tarball, profile, { dshBin }) {
  await runPackagingCommand(process.execPath, [dshBin, 'plugin', '--profile', 'web', 'add', resolve(tarball), '--ignore-scripts'], profile,
    { DSH_HOME: dirname(dirname(profile)), DSH_TELEMETRY_DISABLED: '1' })
}

function contained(directory, file) {
  const path = relative(directory, file)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/** Require the embedded component and reject workspace or unrelated profile copies. */
export async function assertProfileComponents(installed) {
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  for (const name of [QUESTION_FIXES_PACKAGE]) {
    const expected = join(installed, 'packages', 'question-fixes')
    let root
    try { root = await realpath(expected) } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Packed bundle is missing embedded component ${name}`)
      throw error
    }
    if (!contained(await realpath(installed), root)) {
      throw new Error(`Packed component ${name} resolves outside the installed bundle: ${root}`)
    }
    const companion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    if (companion.name !== name || companion.version !== manifest.version) throw new Error(`Packed component ${name} version does not match the Mobile artifact`)
    const require = createRequire(join(root, 'package.json'))
    for (const specifier of [name, `${name}/client`, `${name}/package.json`]) {
      const file = await realpath(require.resolve(specifier))
      if (!contained(root, file)) throw new Error(`Packed component ${specifier} resolves outside its installed package: ${file}`)
    }
  }
}
