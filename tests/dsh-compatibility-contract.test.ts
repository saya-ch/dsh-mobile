import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const checker = fileURLToPath(new URL('../scripts/check-dsh-compatibility.mjs', import.meta.url))
const temporaryDirectories: string[] = []
const connection = '@deepseek-ai/dsh-client-connection'
const remotes = '@deepseek-ai/dsh-api-remotes'
const gateway = '@deepseek-ai/dsh-api-gateway'
const renderer = '@deepseek-ai/dsh-client-ui-renderer'

function manifest(version: string, inject?: string[]): string {
  return JSON.stringify({ version, dsh: { client: inject === undefined ? {} : { inject } } })
}

function sourceFixture(version = '0.1.2-alpha.2', architecture: 'renderer-v2' | 'runtime-v1' = 'renderer-v2', remoteTrust = true): Record<string, string> {
  const sources: Record<string, string> = { 'package.json': JSON.stringify({ version }) }
  for (const path of [
    'host/webserver', 'client/connection', 'client/ui-theme', 'client/ui-layout', 'client/ui-sidebar',
    'client/ui-conversation', 'client/ui-input-trigger', 'client/ui-settings', 'client/ui-user-questions',
    ...(architecture === 'runtime-v1' ? ['client/runtime'] : ['client/web', 'client/locale', 'client/ui-renderer', 'client/ui-session']),
  ]) sources[`packages/${path}/package.json`] = manifest(version)
  sources['packages/client/ui-layout/package.json'] = manifest(version, architecture === 'runtime-v1'
    ? ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-theme']
    : ['@deepseek-ai/dsh-client-locale', renderer, '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-theme'])
  sources['packages/client/ui-settings/package.json'] = manifest(version, remoteTrust ? [remotes] : [connection, remotes])
  sources['packages/api/remotes/package.json'] = manifest(version, [gateway])
  sources['packages/api/gateway/package.json'] = manifest(version, ['@deepseek-ai/dsh-typert-registry', connection])
  // DSH 0.1.5 moved the conversation panel into the keyed 'main' root slot,
  // widened 'rightbar' from session to root scope, and kept the module's root
  // 'panelInfo' standard hook. The dedicated mobile layout replaces this module,
  // so it declares and dispatches the same slots and republishes that hook.
  sources['packages/client/ui-layout/src/client/index.ts'] = [
    "'sidebar': { kind: 'single', scope: 'root' }", "'main': { kind: 'keyed', scope: 'root' }",
    "'rightbar': { kind: 'single', scope: 'root' }", "'shell.overlay': { kind: 'list', scope: 'root' }",
    "ctx.reflect.provide('layout'", "ctx.slots.provideRoot({ hooks: { panelInfo } })",
  ].join('\n')
  sources['packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx'] = 'data-conversation-scroll'
  sources['packages/client/ui-conversation/src/client/skeleton/InputBar.tsx'] = 'data-composer-card data-input-scroll aria-haspopup="listbox"'
  sources['packages/client/ui-input-trigger/src/client/MenuView.tsx'] = 'data-trigger-menu=""'
  sources['packages/client/connection/src/client/index.ts'] = [
    'readonly isLoopback: boolean',
    'const transport = (globalThis as ClientTransportGlobal).__DSH_TRANSPORT__',
    'createWebConnectionRpc(transport?.fetch, transport?.openStream)',
    'isLoopback: transport?.ownsHost === true || pageLocation === undefined || isLoopbackHostname(pageLocation.hostname)',
  ].join('\n')
  sources['packages/client/ui-settings/src/client/index.ts'] = remoteTrust
    ? "export const inject = ['remote', 'remote.settings']\nconst persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'"
    : "connection.isLoopback ? 'host' : 'memory'"
  sources['packages/client/ui-renderer/src/client/index.ts'] = 'export const inject: string[] = []\nnew SlotRegistry(ctx)'
  sources['packages/api/remotes/src/client/index.ts'] = "export const inject = ['remote']\nctx.remote.$mount(contribution)"
  sources['packages/api/gateway/src/client/index.ts'] = [
    "export const inject = ['typert', 'connection']", "const connection = ctx.get('connection') as ConnectionHandle",
    'this.connection = connection', 'get $host(): RemoteHostFacts {',
    'if (this.hostFacts === undefined || this.hostFacts.home !== home) {',
    'this.hostFacts = { home, isLoopback: this.connection.isLoopback }', '}', '}',
  ].join('\n')
  sources['packages/client/ui-sidebar/src/client/SidebarRoot.tsx'] = 'css.fallbackBrandName\nDSH Local Build'
  sources['packages/client/ui-user-questions/src/client/QuestionComposer.tsx'] = 'data-question-key data-question-scroll'
  sources['packages/client/ui-user-questions/src/client/PlanReviewPanel.tsx'] = 'data-plan-review-key data-plan-review-scroll'
  // The preview-path copy affordance taps the titled path bar and never the
  // changes-review file switcher; the card stays a pure open action.
  sources['packages/client/ui-sidebar-documentpreview/src/client/PreviewFrame.tsx'] = 'data-textpreview-path'
  sources['packages/client/ui-deliverables/src/client/ReviewTab.tsx'] = 'data-changes-review'
  sources['packages/client/ui-primitives/src/PathLabel.tsx'] = 'title={path} data-path-label'
  sources['packages/host/webserver/src/injections.ts'] = 'globalThis[${name}] = ${value}'
  return sources
}

function hostSettingsFixture(version = '0.2.1-alpha.3'): Record<string, string> {
  const sources = sourceFixture(version)
  sources['packages/client/ui-settings/src/client/index.ts'] = [
    "export const inject = ['remote', 'remote.settings']",
    'const mirror = new SettingsDescribeMirror(ctx)',
    'new ConfigForms(ctx, { mirror, schema })',
  ].join('\n')
  sources['packages/client/ui-settings/src/client/settings-mirror.ts'] = [
    'export class SettingsDescribeMirror', 'constructor(private readonly ctx: ClientContext)',
    "status: 'idle'", 'const response = await this.ctx.remote.settings.describe()',
  ].join('\n')
  sources['packages/client/ui-settings/src/client/config-form.ts'] = [
    'export class ConfigFormController', 'this.owner = ctx',
    'this.owner, { namespace: entryId }, this.mirror, this.schema,',
    'const response = await this.ctx.remote.settings.mutate(this.spec.namespace, ownedOps, revision)',
    'this.mirror.acceptView(response.value)', 'await this.mirror.load()',
  ].join('\n')
  return sources
}

async function check(sources: Record<string, string>): Promise<{ status: number | null; output: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-contract-'))
  temporaryDirectories.push(directory)
  for (const [relative, source] of Object.entries(sources)) {
    const target = join(directory, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, source)
  }
  const result = spawnSync(process.execPath, [checker, directory], {
    encoding: 'utf8', timeout: 5_000, windowsHide: true,
  })
  if (result.error) throw result.error
  return { status: result.status, output: result.stdout + result.stderr }
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('DSH source compatibility gate', () => {
  it.each(['0.2.1-alpha.3', '0.2.1-alpha.99'])('accepts %s only with Host-backed settings reads and writes', async version => {
    const result = await check(hostSettingsFixture(version))
    expect(result.status).toBe(0)
    expect(result.output).toContain(`DSH compatibility ok: ${version} (renderer-v2)`)
  })

  it.each([
    ['replaces mirror wiring with a constant', 'packages/client/ui-settings/src/client/index.ts', 'const mirror = new SettingsDescribeMirror(ctx)', "const persistence = 'host'", 'settings trust contract changed'],
    ['skips Host reads', 'packages/client/ui-settings/src/client/settings-mirror.ts', 'this.ctx.remote.settings.describe()', 'Promise.resolve({ namespaces: [] })', 'settings Host read contract changed'],
    ['skips Host writes', 'packages/client/ui-settings/src/client/config-form.ts', 'this.ctx.remote.settings.mutate(this.spec.namespace, ownedOps, revision)', 'Promise.resolve({ ok: true })', 'settings Host write contract changed'],
    ['drops write-result adoption', 'packages/client/ui-settings/src/client/config-form.ts', 'this.mirror.acceptView(response.value)', '', 'settings Host write contract changed'],
    ['drops failure recovery reads', 'packages/client/ui-settings/src/client/config-form.ts', 'await this.mirror.load()', '', 'settings Host write contract changed'],
    ['uses the caller instead of the settings owner', 'packages/client/ui-settings/src/client/config-form.ts', 'this.owner = ctx', 'this.owner = caller', 'settings Host write contract changed'],
    ['restores process-local persistence', 'packages/client/ui-settings/src/client/settings-mirror.ts', "status: 'idle'", "status: this.persistence === 'memory' ? 'unavailable' : 'idle'", 'settings Host-only persistence policy changed'],
    ['omits its Remote runtime dependency', 'packages/client/ui-settings/src/client/index.ts', "export const inject = ['remote', 'remote.settings']", 'export const inject = []', 'settings Remote trust contract changed'],
  ] as const)('rejects Host-only settings when it %s', async (_label, path, expected, replacement, error) => {
    const sources = hostSettingsFixture()
    sources[path] = sources[path]!.replace(expected, replacement)
    const result = await check(sources)
    expect(result.status).toBe(1)
    expect(result.output).toContain(error)
  })

  it.each([
    ['preview header loses the path bar', 'packages/client/ui-sidebar-documentpreview/src/client/PreviewFrame.tsx', 'data-textpreview-path', 'data-other-path', 'data-textpreview-path'],
    ['the changes-review scope marker disappears', 'packages/client/ui-deliverables/src/client/ReviewTab.tsx', 'data-changes-review', 'data-review-pane', 'data-changes-review'],
    ['PathLabel stops binding title to the path', 'packages/client/ui-primitives/src/PathLabel.tsx', 'title={path} data-path-label', 'data-path-label', 'binds its title'],
  ] as const)('rejects when the %s', async (_label, path, expected, replacement, error) => {
    const sources = sourceFixture()
    sources[path] = sources[path]!.replace(expected, replacement)
    const result = await check(sources)
    expect(result.status).toBe(1)
    expect(result.output).toContain(error)
  })

  it.each([
    ['settings loses Remote assembly', 'packages/client/ui-settings/package.json', manifest('0.2.1-alpha.3', []), 'Remote dependency profile'],
    ['Remote assembly loses Gateway', 'packages/api/remotes/package.json', manifest('0.2.1-alpha.3', []), 'Remote assembly trust dependency changed'],
    ['Gateway loses Connection', 'packages/api/gateway/package.json', manifest('0.2.1-alpha.3', []), 'API Gateway trust dependency changed'],
    ['renderer acquires a cyclic dependency', 'packages/client/ui-renderer/package.json', manifest('0.2.1-alpha.3', [gateway]), 'renderer gained dependencies'],
    ['Gateway alters Host authentication facts', 'packages/api/gateway/src/client/index.ts', 'get $host() { return { isLoopback: false } }', 'API Gateway Host facts contract changed'],
  ] as const)('rejects Host-only settings when %s', async (_label, path, replacement, error) => {
    const sources = hostSettingsFixture()
    sources[path] = replacement
    const result = await check(sources)
    expect(result.status).toBe(1)
    expect(result.output).toContain(error)
  })

  it.each([
    ['0.1.0-rc.7', 'runtime-v1', false],
    ['0.1.2-alpha.1', 'renderer-v2', false],
    ['0.1.2-alpha.2', 'renderer-v2', true],
    ['0.1.2-alpha.3', 'renderer-v2', true],
    ['0.1.2-alpha.4', 'renderer-v2', true],
    ['0.1.99-alpha.1', 'renderer-v2', true],
  ] as const)('recognizes %s %s settings trust dependencies', async (version, architecture, remoteTrust) => {
    const result = await check(sourceFixture(version, architecture, remoteTrust))
    expect(result.output).toContain(`DSH compatibility ok: ${version} (${architecture})`)
    expect(result.status).toBe(0)
  })

  it.each([
    ['settings no longer depends on remotes', 'packages/client/ui-settings/package.json', manifest('0.1.2-alpha.2', []), 'Remote dependency profile'],
    ['Remote assembly no longer depends on Gateway', 'packages/api/remotes/package.json', manifest('0.1.2-alpha.2', []), 'Remote assembly trust dependency changed'],
    ['Gateway no longer depends on Connection', 'packages/api/gateway/package.json', manifest('0.1.2-alpha.2', []), 'API Gateway trust dependency changed'],
    ['renderer acquires a cyclic dependency', 'packages/client/ui-renderer/package.json', manifest('0.1.2-alpha.2', [gateway]), 'renderer gained dependencies'],
    ['renderer requires a runtime service', 'packages/client/ui-renderer/src/client/index.ts', "export const inject = ['remote']\nnew SlotRegistry(ctx)", 'UI renderer trust ordering contract changed'],
    ['Gateway changes Host trust source', 'packages/api/gateway/src/client/index.ts', 'get $host() { return { isLoopback: false } }', 'API Gateway Host facts contract changed'],
    ['Remote assembly skips its runtime dependency', 'packages/api/remotes/src/client/index.ts', 'export const inject = []\nctx.remote.$mount(contribution)', 'Remote assembly contract changed'],
    ['settings switches to unknown trust state', 'packages/client/ui-settings/src/client/index.ts', "ctx.remote.$host.trusted ? 'host' : 'memory'", 'settings trust contract changed'],
    ['Gateway is from a different DSH release', 'packages/api/gateway/package.json', manifest('0.1.2-alpha.1', [connection]), 'API Gateway version does not match'],
  ] as const)('rejects when %s', async (_label, path, replacement, error) => {
    const sources = sourceFixture()
    sources[path] = replacement
    const result = await check(sources)
    expect(result.status).toBe(1)
    expect(result.output).toContain(error)
  })

  it.each([
    ['global transport hooks', '__DSH_TRANSPORT__', '__UNKNOWN_TRANSPORT__'],
    ['authenticated HTTP fetch', 'createWebConnectionRpc(transport?.fetch, transport?.openStream)', 'createWebConnectionRpc()'],
    ['initial Host trust', 'transport?.ownsHost === true', 'transport?.isTrusted === true'],
  ] as const)('rejects a Connection that ignores %s', async (_label, expected, changed) => {
    const sources = sourceFixture()
    const path = 'packages/client/connection/src/client/index.ts'
    sources[path] = sources[path]!.replace(expected, changed)
    const result = await check(sources)
    expect(result.status).toBe(1)
    expect(result.output).toContain('Connection transport contract changed')
  })

  it('rejects when the layout stops declaring the keyed main slot', async () => {
    const sources = sourceFixture()
    const path = 'packages/client/ui-layout/src/client/index.ts'
    sources[path] = sources[path]!.replace("'main': { kind: 'keyed', scope: 'root' }", "'conversation': { kind: 'single', scope: 'session-maybe' }")
    const result = await check(sources)
    expect(result.status).toBe(1)
    expect(result.output).toContain('DSH layout contract changed')
  })

  it('rejects when the layout stops publishing the panelInfo root hook', async () => {
    const sources = sourceFixture()
    const path = 'packages/client/ui-layout/src/client/index.ts'
    sources[path] = sources[path]!.replace("ctx.slots.provideRoot({ hooks: { panelInfo } })", '')
    const result = await check(sources)
    expect(result.status).toBe(1)
    expect(result.output).toContain('DSH layout contract changed')
  })

  it('accepts the layout service as the panelInfo hook source in DSH 0.1.7-rc.2', async () => {
    const sources = sourceFixture('0.1.7-rc.2')
    const path = 'packages/client/ui-layout/src/client/index.ts'
    sources[path] = sources[path]!.replace(
      'ctx.slots.provideRoot({ hooks: { panelInfo } })',
      'ctx.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } })',
    )
    const result = await check(sources)
    expect(result.status).toBe(0)
    expect(result.output).toContain('DSH compatibility ok: 0.1.7-rc.2 (renderer-v2)')
  })

  it('accepts the conversation scroll marker after the skeleton is split across files', async () => {
    const sources = sourceFixture()
    sources['packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx'] = 'export function ConversationRoot() { return null }'
    sources['packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx'] = 'data-conversation-scroll'
    const result = await check(sources)
    expect(result.status).toBe(0)
    expect(result.output).toContain('DSH compatibility ok: 0.1.2-alpha.2 (renderer-v2)')
  })

  it('accepts the input scroll marker after the composer editor is extracted', async () => {
    const sources = sourceFixture()
    sources['packages/client/ui-conversation/src/client/skeleton/InputBar.tsx'] = 'data-composer-card aria-haspopup="listbox"'
    sources['packages/client/ui-conversation/src/client/input/editor/DraftEditor.tsx'] = 'data-input-scroll'
    const result = await check(sources)
    expect(result.status).toBe(0)
    expect(result.output).toContain('DSH compatibility ok: 0.1.2-alpha.2 (renderer-v2)')
  })

  it('accepts the plan-review panel without a scroll region (0.1.6-alpha.2)', async () => {
    const sources = sourceFixture('0.1.6-alpha.2')
    sources['packages/client/ui-user-questions/src/client/PlanReviewPanel.tsx'] = 'data-plan-review-key'
    const result = await check(sources)
    expect(result.status).toBe(0)
    expect(result.output).toContain('DSH compatibility ok: 0.1.6-alpha.2 (renderer-v2)')
  })

  it('accepts a named global transport hook used by the current Connection client', async () => {
    const sources = sourceFixture()
    const connectionSource = sources['packages/client/connection/src/client/index.ts']!
    sources['packages/client/connection/src/client/index.ts'] = connectionSource
      .replace('const transport = (globalThis as ClientTransportGlobal).__DSH_TRANSPORT__', 'const globals = globalThis as ClientTransportGlobal\nconst transport = globals.__DSH_TRANSPORT__')
    const result = await check(sources)
    expect(result.status).toBe(0)
    expect(result.output).toContain('DSH compatibility ok: 0.1.2-alpha.2 (renderer-v2)')
  })

  it('rejects legacy settings without its direct Connection dependency', async () => {
    const sources = sourceFixture('0.1.2-alpha.1', 'renderer-v2', false)
    sources['packages/client/ui-settings/package.json'] = manifest('0.1.2-alpha.1', [remotes])
    const result = await check(sources)
    expect(result.status).toBe(1)
    expect(result.output).toContain('direct trust requires the Connection module')
  })

  it('accepts a new version only while its trust dependencies remain compatible', async () => {
    const sources = sourceFixture('0.1.99-alpha.1')
    expect((await check(sources)).status).toBe(0)
    sources['packages/api/remotes/package.json'] = manifest('0.1.99-alpha.1', [])
    const result = await check(sources)
    expect(result.status).toBe(1)
    expect(result.output).toContain('Remote assembly trust dependency changed')
  })
})
