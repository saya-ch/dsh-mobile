import type { PublicAgentLike, PublicEventContext } from './contracts.js'

type AgentRegistry = NonNullable<PublicEventContext['agents']>
type DurableHeader = NonNullable<NonNullable<PublicAgentLike['session']>['header']>

const MAX_OWNERSHIP_DEPTH = 64

/**
 * Read the durable header from the object a public event delivered.
 *
 * A `session/event` observer receives the Session itself, whose header lives on
 * the live Agent; a request can carry an Agent-shaped identity without the
 * Session attached. Resolve both through the public registry instead of
 * assuming one shape.
 */
function durableHeader(registry: AgentRegistry | undefined, agent: PublicAgentLike): DurableHeader | undefined {
  const direct = agent.session?.header
  if (direct !== undefined) return direct
  return registry?.get?.(agent.id)?.session?.header
}

/**
 * Find the owning parent recorded by the durable Session header.
 *
 * Only a header that explicitly classifies the Session as a subagent child
 * creates ownership. Historical ordinary forks may retain a `parentSession`
 * source id, so the field alone is not evidence of ownership.
 */
function owningParentId(registry: AgentRegistry | undefined, agent: PublicAgentLike): string | undefined {
  const header = durableHeader(registry, agent)
  if (header?.origin !== 'subagent') return undefined
  const parent = header.parentSession
  return typeof parent === 'string' && parent.length > 0 ? parent : undefined
}

/** The public ownership walk available before DSH 0.2.2-rc.2, when it exists. */
function legacyOwnerOf(registry: AgentRegistry | undefined): ((id: string) => PublicAgentLike | undefined) | undefined {
  if (typeof registry?.list !== 'function' || typeof registry.isOwnedBy !== 'function') return undefined
  // Keep the receiver: DSH exposes these as Cordis service methods and a detached
  // call loses the service state (`this.store`).
  return id => (registry?.list?.() ?? []).find(candidate => registry?.isOwnedBy?.(id, candidate) === true)
}

/**
 * Whether this Agent is a runtime child that must not notify on its own.
 *
 * Without the removed registry ownership API, the live parent Agent recorded
 * by the header is the public evidence; an orphan does not count as owned,
 * matching the earlier walk that stopped at a missing owner.
 */
export function isPushRuntimeChild(registry: AgentRegistry | undefined, agent: PublicAgentLike): boolean {
  const ownerOf = legacyOwnerOf(registry)
  if (ownerOf !== undefined) return ownerOf(agent.id) !== undefined
  const parentId = owningParentId(registry, agent)
  return parentId !== undefined && registry?.get?.(parentId) !== undefined
}

/**
 * Resolve the root Session a notification should target.
 *
 * Uses the removed `isOwnedBy` walk when the host still exposes it, and the
 * durable subagent header ancestry otherwise. A child whose parent Agent is no
 * longer live remains its own root, matching the previous behavior.
 */
export function pushRootAgent(registry: AgentRegistry | undefined, agent: PublicAgentLike): PublicAgentLike {
  const ownerOf = legacyOwnerOf(registry)
  let current = agent
  for (let count = 0; count < MAX_OWNERSHIP_DEPTH; count++) {
    let parent: PublicAgentLike | undefined
    if (ownerOf !== undefined) {
      parent = ownerOf(current.id)
    } else {
      const parentId = owningParentId(registry, current)
      parent = parentId === undefined ? undefined : registry?.get?.(parentId)
    }
    if (parent === undefined || parent.id === current.id) return current
    current = parent
  }
  return current
}
