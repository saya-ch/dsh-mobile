#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { availableLanNetworks, preferredLanInterfaceNames, selectLanNetwork, type LanNetwork } from './managed-setup.js'
import { prepareManagedLanSetup, removeWindowsFirewall } from './lan-setup.js'
import { assertExtensionId } from './extensions.js'
import { restrictPrivateFile } from './private-file.js'

interface SetupOptions {
  readonly address?: string
  readonly family?: 4 | 6
  readonly port: number
  readonly dshPort: number
  readonly configureFirewall: boolean
}

function parseOptions(args: readonly string[]): SetupOptions {
  let address: string | undefined
  let family: 4 | 6 | undefined
  let port = 3443
  let dshPort = 3080
  let configureFirewall = true
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index]
    const value = args[index + 1]
    if (name === '--address' && value !== undefined) {
      address = value
      index += 1
      continue
    }
    if (name === '--family' && value !== undefined) {
      if (value !== 'ipv4' && value !== 'ipv6') throw new Error('--family must be ipv4 or ipv6')
      family = value === 'ipv6' ? 6 : 4
      index += 1
      continue
    }
    if (name === '--port' && value !== undefined) {
      port = Number(value)
      index += 1
      continue
    }
    if (name === '--dsh-port' && value !== undefined) {
      dshPort = Number(value)
      index += 1
      continue
    }
    if (name === '--no-firewall') {
      configureFirewall = false
      continue
    }
    throw new Error(`unknown setup option: ${name ?? ''}`)
  }
  if (address !== undefined && family !== undefined) throw new Error('--address and --family cannot be combined')
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be from 1024 through 65535')
  if (!Number.isSafeInteger(dshPort) || dshPort < 1024 || dshPort > 65535) throw new Error('--dsh-port must be from 1024 through 65535')
  return { ...(address === undefined ? {} : { address }), ...(family === undefined ? {} : { family }), port, dshPort, configureFirewall }
}

function dshHome(): string {
  return resolve(process.env.DSH_HOME ?? join(homedir(), '.dsh'))
}

/**
 * Pick the interface's address in the requested family.
 *
 * IPv4 stays the default so an existing `setup` invocation keeps its meaning; `--family
 * ipv6` is the explicit opt-in for a listener that has no NAT in front of it.
 */
function selectLanNetworkByFamily(family: 4 | 6, preferredInterface: string): LanNetwork {
  const candidates = availableLanNetworks()
  const onInterface = candidates.filter(candidate => candidate.name === preferredInterface && candidate.family === family)
  if (onInterface.length === 1) return onInterface[0]!
  const familyCandidates = candidates.filter(candidate => candidate.family === family)
  if (familyCandidates.length === 1) return familyCandidates[0]!
  if (familyCandidates.length === 0) {
    throw new Error(`no active ${family === 6 ? 'IPv6' : 'IPv4'} LAN address was found`)
  }
  throw new Error(`more than one ${family === 6 ? 'IPv6' : 'IPv4'} LAN address is active; use --address with one of: ${familyCandidates.map(entry => `${entry.name}=${entry.address}`).join(', ')}`)
}

async function setup(args: readonly string[]): Promise<void> {
  const options = parseOptions(args)
  const preferredInterfaces = options.address === undefined ? await preferredLanInterfaceNames() : []
  const selected = selectLanNetwork(options.address, undefined, undefined, preferredInterfaces)
  const network = options.family === undefined || options.family === selected.family
    ? selected
    : selectLanNetworkByFamily(options.family, selected.name)
  const home = dshHome()
  const directory = join(home, 'mobile-access')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const customCss = join(directory, 'mobile.css')
  try {
    await readFile(customCss)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(customCss, [
      '/* Safe mobile overrides. DSH Mobile applies saved changes on the phone automatically. */',
      ':root {',
      '  --dsh-mobile-accent: #2563eb;',
      '  --dsh-mobile-font-scale: 1;',
      '  --dsh-mobile-radius: 14px;',
      '}',
      '',
    ].join('\n'), { mode: 0o600 })
  }

  const customScript = join(directory, 'mobile.js')
  try {
    await readFile(customScript)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await writeFile(customScript, [
      '/* Mount mobile-only Web features here. Saved changes are applied automatically. */',
      'window.dshMobile.register(({ root }) => {',
      '  root.replaceChildren()',
      '  return () => root.replaceChildren()',
      '})',
      '',
    ].join('\n'), { mode: 0o600 })
  }

  const extensions = join(directory, 'extensions')
  await mkdir(extensions, { recursive: true, mode: 0o700 })
  await createExtensionScaffold(extensions, 'custom', '自定义移动扩展', false)

  if (options.configureFirewall && process.platform === 'win32') {
    console.log('Windows will request administrator approval for two LAN-only firewall rules.')
  }
  const result = await prepareManagedLanSetup({
    setupFile: join(directory, 'setup.json'),
    controlFile: join(directory, 'control.json'),
    network,
    listenPort: options.port,
    dshPort: options.dshPort,
    configureFirewall: options.configureFirewall,
  })

  console.log(`DSH Mobile follows ${network.name} and is currently configured for ${result.origin}`)
  console.log(`Install this CA certificate on Android once: ${result.androidCertificate}`)
  console.log(`Ask DSH to customize the mobile Web UI and features in: ${customCss} and ${customScript}`)
  console.log(`Additional extensions live in: ${extensions}`)
  console.log('Start DSH with: dsh --profile web')
  console.log('Then open the Mobile card in the lower-left corner and create a pairing key.')
}

async function createExtensionScaffold(root: string, id: string, name: string, refuseExisting = true): Promise<void> {
  assertExtensionId(id)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = join(root, id)
  try {
    await mkdir(directory, { recursive: false, mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST' && !refuseExisting) return
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`extension directory already exists: ${id}`)
    throw error
  }
  const files: Readonly<Record<string, string>> = {
    'extension.json': `${JSON.stringify({ schemaVersion: 1, id, name, version: '0.1.0', description: '在手机端扩展 DSH' }, null, 2)}\n`,
    'host.mjs': `export default async function activate(api) {\n  api.action('hello', {\n    input: api.schema.object({ name: api.schema.string().max(80) }),\n    async run({ signal, deviceId }, input) {\n      void signal; void deviceId\n      return { message: \`Hello, \${input.name}\` }\n    },\n  })\n}\n`,
    'mobile.js': `window.dshMobile?.define?.({\n  apiVersion: 1,\n  id: '${id}',\n  activate(api) {\n    return api.ui.registerSurface({\n      id: '${id}-page', placement: 'page', label: ${JSON.stringify(name)},\n      mount(container) {\n        container.textContent = ${JSON.stringify(`这是 ${name} 的移动页面。`)}\n        return () => container.replaceChildren()\n      },\n    })\n  },\n})\n`,
    'mobile.css': `/* ${name.replaceAll('*/', '* /')} 的移动端样式。保存后通常会在几秒内刷新。 */\n`,
  }
  try {
    for (const [file, contents] of Object.entries(files)) await writeFile(join(directory, file), contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  console.log(`Created extension: ${directory}`)
}

async function extensionCommand(args: readonly string[]): Promise<void> {
  const [subcommand, id, ...rest] = args
  if (subcommand !== 'create' || id === undefined) throw new Error('usage: extension create <id> [--name <name>]')
  let name = id
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--name' && rest[index + 1] !== undefined) { name = rest[index + 1]!; index += 1; continue }
    throw new Error(`unknown extension option: ${rest[index] ?? ''}`)
  }
  if (name.length === 0 || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error('--name is invalid')
  await createExtensionScaffold(join(dshHome(), 'mobile-access', 'extensions'), id, name)
}

async function purge(args: readonly string[]): Promise<void> {
  if (args.length !== 1 || args[0] !== '--yes') throw new Error('purge requires --yes')
  const home = dshHome()
  await rm(join(home, 'mobile-access'), { recursive: true, force: true })
  await removeWindowsFirewall()
  console.log('Removed DSH Mobile certificates, devices, preferences, and custom Web files.')
}

function help(): void {
  console.log([
    'dsh-mobile setup [--address 192.168.x.x | --family ipv6] [--port 3443] [--dsh-port 3080] [--no-firewall]',
    'dsh-mobile extension create <id> [--name <name>]',
    'dsh-mobile purge --yes',
    '',
    'Run through the DSH profile:',
    '  dsh plugin --profile web exec dsh-mobile setup',
  ].join('\n'))
}

async function main(): Promise<void> {
  const [command = 'help', ...args] = process.argv.slice(2)
  if (command === 'setup') await setup(args)
  else if (command === 'extension') await extensionCommand(args)
  else if (command === 'purge') await purge(args)
  else if (command === 'help' || command === '--help' || command === '-h') help()
  else throw new Error(`unknown command: ${command}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
