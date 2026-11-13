/**
 * The lifecycle hooks for the Obsidian Mem capability: turn-start recall
 * injection through the per-agent channel, the Read-tool intercept, the
 * Think-stream keyword intercept, the turn-end save/audit reminder, and the
 * global per-session recall budget that caps what all of them inject.
 *
 * Mount shape (mirrors the tools row): the static `inject` pins the
 * `obsidianMem` seam, and `apply` runs a scoped
 * `ctx.inject(['obsidianMem', 'agents'], …)` so a profile without live
 * agents loads the row inertly. Per AGENTS.md "DSH Event Facts", agent-
 * scoped events (`agent/pre-step`) fire on the AGENT's own context: they
 * are registered from the `agent/created` handler onto `agent.ctx`, each
 * wrapped in one `agent.ctx.effect()` whose disposer is kept here and torn
 * down on `agent/disposed` (and with the plugin fiber). Plugin-ctx
 * listeners for those events never fire. `agent/created` and
 * `agent/disposed` are dispatched through the agent's registry carrier and
 * are observed on the plugin ctx; both handlers contain their errors
 * because `agent/created` is serial and a throwing listener fails creation.
 * @module dsh-plugin-obsidian-mem/events
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

import { dbStateDir } from '../../core/lib/index.js'
// Type import only: pulls the `obsidianMem` Context augmentation in.
import type {} from '../../service/lib/index.js'
import { OBSIDIAN_MEM_SEAM } from '../../service/lib/index.js'
import { describeError } from '../../service/lib/errors.js'
import type { EffectDisposer, LiveAgent, MemoryEventsScope } from './host.js'
import { SESSIONS_FILE_NAME, SessionRegistry } from './sessions.js'

export const name = 'obsidian-mem-events'
export const inject = ['obsidianMem']

/**
 * Mount the lifecycle hooks. The scoped inject waits for the memory seam
 * plus the host `agents` service; with both present, the session registry
 * is constructed, wired onto the seam for TASK-045's global budget, and the
 * agent-lifecycle listeners register. The turn-start recall and the
 * Read/Think intercepts join through the same wiring.
 */
export function apply(ctx: Context): void {
  ctx.inject([OBSIDIAN_MEM_SEAM, 'agents'], (scope) => {
    mountLifecycle(scope as MemoryEventsScope)
  })
}

/**
 * MountLifecycle wires one profile's lifecycle: session registry, seam
 * hookup, and the agent create/dispose pairing that owns every per-agent
 * listener. Answers the registry (the intercept installs below consume it;
 * tests assert on it).
 */
export function mountLifecycle(scope: MemoryEventsScope): SessionRegistry {
  const ctx = scope
  const logger = ctx.logger('obsidian-mem-events')
  const memory = scope.obsidianMem
  const registry = new SessionRegistry({
    file: join(dbStateDir(memory.config.milvus.dbPath), SESSIONS_FILE_NAME),
    thinkShotsPerTurn: memory.config.budgets.thinkShotsPerTurn,
    log: (message) => logger.warn(message),
  })
  memory.setSessionRegistry(registry)
  ctx.effect(() => () => {
    memory.setSessionRegistry(null)
    registry.close()
  }, `${name}.sessions`)

  // Per-agent listener disposers, kept in the PLUGIN's own effect and torn
  // down on agent/disposed (AGENTS.md Event Facts: the disposer lives here).
  const agentDisposers = new Map<string, EffectDisposer>()
  ctx.effect(() => () => {
    for (const dispose of agentDisposers.values()) {
      dispose()
    }
    agentDisposers.clear()
  }, `${name}.agents`)

  ctx.on('agent/created', (payload) => {
    // Serial dispatch: a throw here fails agent creation, so nothing may
    // escape this handler (the payload is read inside the guard too).
    try {
      const agent = payload.agent
      const sessionId = String(agent.id)
      registry.ensure(sessionId, { subagent: isSubagentAgent(agent) })
    } catch (error: unknown) {
      logger.warn(`agent/created session wiring failed: ${describeError(error)}`)
    }
    return undefined
  })

  ctx.on('agent/disposed', (payload) => {
    try {
      const sessionId = String(payload.agent.id)
      agentDisposers.get(sessionId)?.()
      agentDisposers.delete(sessionId)
      registry.disposeSession(sessionId)
    } catch (error: unknown) {
      logger.warn(`agent/disposed session wiring failed: ${describeError(error)}`)
    }
  })

  return registry
}

/**
 * IsSubagentAgent reads the subagent signal off the session header: the
 * durable `origin: 'subagent'` classification or a positive delegation
 * depth (verified against the @deepseek-ai/dsh-session SessionHeader
 * types). Sessions are keyed by their own ids regardless, so this feeds
 * bookkeeping only, never keying.
 */
export function isSubagentAgent(agent: LiveAgent): boolean {
  const header = agent.session?.header
  return header?.origin === 'subagent' || (header?.delegationDepth ?? 0) > 0
}

const plugin = { name, inject, apply }
export default plugin

export {
  READ_INJECTION_CAP_PER_SESSION,
  READ_INJECTION_THROTTLE_MS,
  SESSION_TTL_MS,
  SESSIONS_FILE_NAME,
  SESSIONS_LRU_MAX,
  SessionRegistry,
} from './sessions.js'
export type {
  InjectedSourceRecord,
  SessionRecord,
  SessionRegistryOptions,
} from './sessions.js'
export type {
  EffectDisposer,
  HookLogger,
  LiveAgent,
  MemoryEventsScope,
  MemoryEventsService,
} from './host.js'
