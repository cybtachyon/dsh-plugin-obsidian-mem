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
import type { ManifestFs } from '../../core/lib/index.js'
// Type import only: pulls the `obsidianMem` Context augmentation in.
import type {} from '../../service/lib/index.js'
import { OBSIDIAN_MEM_SEAM } from '../../service/lib/index.js'
import type { EffectDisposer, HookLogger, LiveAgent, MemoryEventsScope } from './host.js'
import { installReadIntercept } from './readIntercept.js'
import { SESSIONS_FILE_NAME, SessionRegistry } from './sessions.js'
import { installThinkIntercept } from './thinkIntercept.js'
import { installMemoryToolWatch, installTurnEnd } from './turnEnd.js'
import { installTurnStart } from './turnStart.js'
import { runGuarded } from './toolkit.js'
import { installWriteLedger } from './writeLedger.js'

export const name = 'obsidian-mem-events'
export const inject = ['obsidianMem']

/** Test seams for the mount; production calls `apply` without options. */
export interface MountOptions {
  /** Workspace manifest fs the turn-start scan reads; defaults to node fs. */
  manifestFs?: ManifestFs
  /** Message id factory for injected messages; defaults to random UUIDs. */
  newMessageId?: () => string
  /** Clock for the session registry's throttle/TTL state; defaults to Date.now. */
  now?: () => number
}

/**
 * Mount the lifecycle hooks. The scoped inject waits for the memory seam
 * plus the host `agents` service; with both present, the session registry
 * is constructed, wired onto the seam for TASK-045's global budget, and the
 * agent-lifecycle listeners register. The turn-start recall and the
 * Read/Think intercepts join through the same wiring.
 */
export function apply(ctx: Context, options: MountOptions = {}): void {
  ctx.inject([OBSIDIAN_MEM_SEAM, 'agents'], (scope) => {
    mountLifecycle(scope as MemoryEventsScope, options)
  })
}

/**
 * MountLifecycle wires one profile's lifecycle: session registry, seam
 * hookup, and the agent create/dispose pairing whose per-agent
 * `agent.ctx.effect()` carries every agent-scoped listener this row
 * installs (turn-start recall, the Think-stream intercept, and the turn-end
 * reminder). Answers the registry (tests assert on it).
 */
export function mountLifecycle(scope: MemoryEventsScope, options: MountOptions = {}): SessionRegistry {
  const ctx = scope
  const logger = ctx.logger('obsidian-mem-events')
  const hookLogger = logger as HookLogger
  const memory = scope.obsidianMem
  const registry = new SessionRegistry({
    file: join(dbStateDir(memory.config.milvus.dbPath), SESSIONS_FILE_NAME),
    thinkShotsPerTurn: memory.config.budgets.thinkShotsPerTurn,
    log: (message) => logger.warn(message),
    ...(options.now === undefined ? {} : { now: options.now }),
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
    runGuarded(hookLogger, 'agent/created wiring', () => {
      const agent = payload.agent
      const sessionId = String(agent.id)
      registry.ensure(sessionId, { subagent: isSubagentAgent(agent) })
      // Agent-scoped events fire on the AGENT's context: one effect per
      // agent carries every agent-scoped listener this row installs, and
      // its disposer lives in the plugin-side map below (AGENTS.md facts).
      const deps = {
        agent,
        memory,
        registry,
        logger: hookLogger,
        ...(options.manifestFs === undefined ? {} : { manifestFs: options.manifestFs }),
        ...(options.newMessageId === undefined ? {} : { newMessageId: options.newMessageId }),
      }
      const handle = agent.ctx.effect(() => {
        const disposers = [
          installTurnStart(deps),
          installThinkIntercept(deps),
          installTurnEnd(deps),
        ]
        return () => {
          for (const dispose of disposers) {
            dispose()
          }
        }
      }, `${name}.agent`)
      agentDisposers.set(sessionId, () => { handle() })
    })
    return undefined
  })

  ctx.on('agent/disposed', (payload) => {
    runGuarded(hookLogger, 'agent/disposed session wiring', () => {
      const sessionId = String(payload.agent.id)
      agentDisposers.get(sessionId)?.()
      agentDisposers.delete(sessionId)
      registry.disposeSession(sessionId)
    })
  })

  // Plugin-level tool observation: tools/result is keyed by exec.agent and
  // observed here (not per agent.ctx); see TASK-042 and the TASK-044
  // memory-tool turn guard.
  installReadIntercept({ ctx, memory, registry, logger: hookLogger })
  installMemoryToolWatch({ ctx, registry, logger: hookLogger })
  installWriteLedger({ ctx, registry, logger: hookLogger })

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
  SESSIONS_PERSIST_DEBOUNCE_MS,
  SessionRegistry,
  sourceKeyFor,
  wakeTermsForSource,
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
export { guidanceLine, installTurnStart, nodeManifestFs } from './turnStart.js'
export type { TurnStartDeps } from './turnStart.js'
export {
  dirSignalsOf,
  HARNESS_READ_TOOL_NAME,
  importSnippetFrom,
  installReadIntercept,
} from './readIntercept.js'
export type { ReadInterceptDeps } from './readIntercept.js'
export {
  extractCompletedThinkBlocks,
  installThinkIntercept,
  THINK_QUERY_MAX_CHARS,
  THINK_SEARCH_TOP_K,
} from './thinkIntercept.js'
export type { ThinkInterceptDeps } from './thinkIntercept.js'
export {
  installMemoryToolWatch,
  installTurnEnd,
  isTrivialTurn,
  TURN_END_REMINDER,
  TRIVIAL_TURN_MAX_CHARS,
  turnEndReminder,
  WORK_MARKER,
} from './turnEnd.js'
export type { MemoryToolWatchDeps, TurnEndDeps } from './turnEnd.js'
export { compactionInstruction } from './budget.js'
export { installWriteLedger } from './writeLedger.js'
export type { WriteLedgerDeps } from './writeLedger.js'
