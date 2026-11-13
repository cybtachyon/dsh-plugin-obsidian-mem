/**
 * Turn-start recall injection (TASK-041). The listener rides
 * `agent/pre-step` (there is no turn/start event): registered on the
 * AGENT's own context from the plugin's `agent/created` handler (AGENTS.md
 * "DSH Event Facts"), it fires the flow once per session at the first step
 * the session is first seen at. The waterfall discipline is absolute: every
 * path through the handler ends in `await next()` with the decision spread,
 * so this listener can never reject or reshape a step, and all recall work
 * is fire-and-forget (`agent.inject()` lands the context at the next step
 * boundary without waking the agent; blocking the waterfall behind a
 * cold-starting index would stall the loop).
 *
 * The flow: ensureMemoryAccess (the one-time default-vault notice is
 * injected first), TASK-045's budget switch (an over-budget session gets the
 * memory_dream compaction pointer instead of anything below and returns
 * early), TASK-014's pinned injection of each shared vault's global memory
 * file within the remaining global budget, one workspace manifest scan at
 * the agent's session cwd, search over the first user text plus the manifest
 * query text, budget trimming to `budgets.turnStartRecallTokens`, the
 * once-per-session source filter, `core.wrapRecalled` envelopes (defang
 * included), the memory_search guidance line naming the discovered
 * extensions/languages/frameworks, the token accounting TASK-045 consumes,
 * and the once-per-session mark that keeps a pinned global file out of the
 * search recall below.
 * @module dsh-plugin-obsidian-mem/events/turnStart
 */

import { readdirSync, readFileSync } from 'node:fs'
import { approxCharsForTokens, approxTokens, manifestQueryText, scanManifest, wrapRecalled } from '../../core/lib/index.js'
import type { ManifestFs, WorkspaceManifest } from '../../core/lib/index.js'
import { describeError } from '../../service/lib/errors.js'
import type { MemorySearchResult } from '../../service/lib/search.js'
import { compactionInstruction, isGlobalBudgetSpent } from './budget.js'
import type { HookLogger, LiveAgent, MemoryEventsService, PreStepListener, StepMessage } from './host.js'
import { firstUserText } from './host.js'
import { sourceKeyFor, type SessionRegistry } from './sessions.js'
import {
  collectFreshSources,
  deliverProvisionNotice,
  type FreshSource,
  fireAndForget,
  injectNotice,
  logSearchFailure,
  markSourceInjected,
  messageIdFactory,
  retainProvisionNotice,
  runGuarded,
  sessionWorkspaceCwd,
} from './toolkit.js'

/** Node ManifestFs over sync fs reads; unreadable paths answer null (skip). */
export const nodeManifestFs: ManifestFs = {
  listDirectory(path) {
    try {
      return readdirSync(path, { withFileTypes: true })
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
    } catch {
      return null
    }
  },
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
}

/** Constructor dependencies; `manifestFs` and `newMessageId` are test seams. */
export interface TurnStartDeps {
  agent: LiveAgent
  memory: MemoryEventsService
  registry: SessionRegistry
  logger: HookLogger
  manifestFs?: ManifestFs
  newMessageId?: () => string
}

/**
 * InstallTurnStart registers the per-agent `agent/pre-step` observer and
 * answers its disposer (the caller keeps it in the plugin's own effect per
 * AGENTS.md Event Facts). The registration itself happens on the agent's
 * context, inside the caller's `agent.ctx.effect()`.
 */
export function installTurnStart(deps: TurnStartDeps): () => void {
  const listener: PreStepListener = async (payload, next) => {
    // Observation only: a broken recall gate never touches the decision.
    runGuarded(deps.logger, 'turn-start recall gate', () => {
      claimTurnStart(deps, payload.agent, payload.messages, payload.turn, payload.step)
    })
    const decision = await next()
    return { ...decision }
  }
  const off = deps.agent.ctx.on('agent/pre-step', listener)
  return () => { off() }
}

// Synchronous claim: per-turn bookkeeping, then the once-per-session slot.
// Marking done BEFORE the async work prevents a second step from starting a
// parallel recall while the first is still searching.
function claimTurnStart(
  deps: TurnStartDeps,
  agent: LiveAgent,
  messages: readonly StepMessage[],
  turn: number,
  step: number,
): void {
  const sessionId = String(agent.id)
  // The first user text rides into the registry for TASK-044's trivial-turn
  // guard (the turn-stopping payload carries no messages).
  deps.registry.noteTurn(sessionId, turn, firstUserText(messages))
  if (step !== 1 || deps.registry.isTurnStartDone(sessionId)) {
    return
  }
  deps.registry.markTurnStartDone(sessionId)
  fireAndForget(
    deps.logger,
    'turn-start recall',
    runTurnStartRecall(deps, sessionId, messages),
  )
}

/** RunTurnStartRecall is the whole once-per-session flow, errors contained. */
async function runTurnStartRecall(
  deps: TurnStartDeps,
  sessionId: string,
  messages: readonly StepMessage[],
): Promise<void> {
  const { memory, registry } = deps
  const newId = messageIdFactory(deps)
  let injectedTokens = 0

  // Step 0: lazy provisioning; the trigger call answers the one-time
  // default-vault notice, which reads first, exactly once. The notice sits
  // in the registry's pending slot until a flow injects it (TASK-046
  // carry-over: a skip here must not swallow it).
  retainProvisionNotice(registry, await memory.ensureMemoryAccess())
  injectedTokens += deliverProvisionNotice(deps.agent, newId, registry)

  // TASK-045: the global memory budget. While the summed recall injections
  // across this process's sessions sit past `budgets.globalMemoryTokens`,
  // fresh recall is replaced by the compaction pointer (the audit's
  // budget.over line names the same remedy with the same numbers).
  const budgetTokens = memory.config.budgets.globalMemoryTokens
  if (isGlobalBudgetSpent(registry, budgetTokens)) {
    const usedTokens = registry.totalRecallTokensUsed()
    injectedTokens += injectNotice(
      deps.agent,
      newId(),
      'obsidian-mem: global memory budget spent, run memory_dream',
      [compactionInstruction(usedTokens, budgetTokens)],
    )
    registry.addRecallTokens(sessionId, injectedTokens)
    return
  }

  // TASK-014: pinned session-start injection of each shared vault's global
  // memory file, inside the remaining global budget (`approxCharsForTokens`
  // cuts the text; a file with nothing left in the budget is skipped). The
  // source mark is fingerprint-less on purpose: that is the registry's
  // session-wide block form, and the search recall below computes its
  // fingerprint from the indexed updated_at, which the raw file read here
  // cannot know. Token accounting rides the flow-total below.
  for (const source of memory.globalMemorySources()) {
    const remainingTokens = budgetTokens - registry.totalRecallTokensUsed()
    if (remainingTokens <= 0) {
      break
    }
    const cap = approxCharsForTokens(remainingTokens)
    const body = source.content.length > cap ? source.content.slice(0, cap) : source.content
    injectedTokens += injectNotice(
      deps.agent,
      newId(),
      'obsidian-mem: pinned global memory',
      [wrapRecalled(source.path, body)],
    )
    registry.markInjected(sessionId, sourceKeyFor({ vault: source.vaultPath, source_path: source.path }))
  }

  // Step 1: one manifest scan for the session, at the agent's workspace.
  const cwd = sessionWorkspaceCwd(deps.agent)
  const manifest = cwd === null
    ? null
    : scanManifestSafe(cwd, deps.manifestFs ?? nodeManifestFs, deps.logger)

  // Steps 2-3: query = first user text + manifest text; budget-fit trim.
  const query = [firstUserText(messages), manifest === null ? '' : manifestQueryText(manifest)]
    .filter((part) => part !== '')
    .join('\n\n')
  const kept: FreshSource[] = []
  if (query !== '') {
    let results: MemorySearchResult[]
    try {
      results = await memory.search({ query, topK: memory.config.budgets.searchTopK })
    } catch (error: unknown) {
      logSearchFailure({ logger: deps.logger, label: 'turn-start recall', error })
      results = []
    }
    let used = 0
    for (const item of collectFreshSources(registry, sessionId, results)) {
      const cost = approxTokens(item.block)
      if (used + cost > memory.config.budgets.turnStartRecallTokens) {
        break
      }
      used += cost
      kept.push(item)
    }
  }

  // Recall bodies first, so the guidance line reads last.
  for (const item of kept) {
    injectedTokens += injectNotice(deps.agent, newId(), 'obsidian-mem: turn-start recall', [item.block])
    markSourceInjected(registry, sessionId, item)
  }
  if (manifest !== null) {
    const guidance = guidanceLine(manifest)
    if (guidance !== '') {
      injectedTokens += injectNotice(deps.agent, newId(), 'obsidian-mem: memory_search guidance', [guidance])
    }
  }
  // TASK-045's global budget counts every token this flow injected.
  registry.addRecallTokens(sessionId, injectedTokens)
}

/** GuidanceLine names the discovered file types, languages, frameworks. */
export function guidanceLine(manifest: WorkspaceManifest): string {
  const discovered = [
    ...manifest.topExtensions.map((extension) => `.${extension}`),
    ...manifest.languages,
    ...manifest.frameworks,
  ].filter((value, index, all) => all.indexOf(value) === index)
  if (discovered.length === 0) {
    return ''
  }
  return 'Use memory_search for the file types, coding languages, or frameworks '
    + `you discover in this workspace: ${discovered.join(', ')}.`
}

/** ScanManifestSafe bounds one workspace walk; a broken tree answers null. */
function scanManifestSafe(
  cwd: string,
  fsLike: ManifestFs,
  logger: HookLogger,
): WorkspaceManifest | null {
  try {
    return scanManifest(cwd, fsLike)
  } catch (error: unknown) {
    logger.warn(`workspace manifest scan failed (skipped): ${describeError(error)}`)
    return null
  }
}
