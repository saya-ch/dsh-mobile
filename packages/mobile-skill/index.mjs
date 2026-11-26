/**
 * Bundled "DSH Mobile access" documentation skill, host half.
 *
 * This is documentation, not a capability: it adds one entry to the session skill
 * catalog and touches nothing else. Keeping it in its own component means the user can
 * switch the documentation off from the plugin manager without disabling phone access,
 * and a deployment without the skill service simply leaves this row inactive while
 * dsh-mobile keeps working.
 *
 * Mirrors the stock bundled providers: `list()` advertises the candidate, `get()` returns
 * the Markdown body. `inject` is declared so the component waits for the skill service
 * instead of failing activation, which is what makes the row show up as waiting when the
 * service is absent.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const PROVIDER_NAME = 'dsh-mobile'
const SKILL_NAME = 'dsh-mobile-access'

const SKILL_BODY_URL = new URL('./access.md', import.meta.url)
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('./', import.meta.url)),
}

/**
 * Rank used by the stock bundled providers, which sort the catalog. Repeating the value
 * keeps this provider ordered alongside them without importing a DSH package that a
 * published bundle cannot depend on resolving.
 */
const BUNDLED_SKILL_RANK = 600

const CANDIDATE = {
  name: SKILL_NAME,
  description: 'Inspect, configure and troubleshoot DSH Mobile phone access: local network, Tailscale Funnel, cpolar, cloudflared, self-hosted FRP, an own reverse proxy and iroh; pairing; and reading dsh-mobile.log. Use when a phone cannot reach DSH, when a channel must be enabled or switched, or when the user asks which channel to use.',
  invocation: { modelInvocable: true, userInvocable: true },
  provider: PROVIDER_NAME,
  source: 'bundled',
  resourceBase: RESOURCE_BASE,
  rank: BUNDLED_SKILL_RANK,
  locator: SKILL_BODY_URL,
}

const provider = {
  name: PROVIDER_NAME,
  list: () => Promise.resolve([CANDIDATE]),
  async get() {
    return {
      name: CANDIDATE.name,
      description: CANDIDATE.description,
      invocation: CANDIDATE.invocation,
      provider: CANDIDATE.provider,
      source: CANDIDATE.source,
      resourceBase: RESOURCE_BASE,
      content: await readFile(SKILL_BODY_URL, 'utf8'),
    }
  },
}

/** Cordis plugin name, shown as the component row's id in the plugin manager. */
export const name = 'dsh-mobile-skill'

/** The documentation is only useful with the skill registry present. */
export const inject = ['skills']

/** Register the provider; the returned disposer removes it again. */
export function apply(ctx) {
  return ctx.skills.registerProvider(() => provider)
}
