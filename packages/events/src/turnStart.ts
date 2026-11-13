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
 * injected first), one workspace manifest scan at the agent's session cwd,
 * search over the first user text plus the manifest query text, budget
 * trimming to `budgets.turnStartRecallTokens`, the once-per-session source
 * filter, `core.wrapRecalled` envelopes (defang included), the
 * memory_search guidance line naming the discovered extensions/languages/
 * frameworks, and the token accounting TASK-045 consumes.
 * @module dsh-plugin-obsidian-mem/events/turnStart
 */

import { readdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { approxTokens, manifestQueryText, scanManifest, wrapRecalled } from '../../core/lib/index.js'
import type { ManifestFs, WorkspaceManifest } from '../../core/lib/index.js'
import { describeError } from '../../service/lib/errors.js'
import type { MemorySearchResult } from '../../service/lib/search.js'
import type { HookLogger, LiveAgent, MemoryEventsService, PreStepListener, StepMessage } from './host.js'
import { firstUserText, makeNoticeMessage } from './host.js'
import { sourceKeyFor, wakeTermsForSource, type SessionRegistry } from './sessions.js'

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
    try {
      claimTurnStart(deps, payload.agent, payload.messages, payload.turn, payload.step)
    } catch (error: unknown) {
      // Observation only: a broken recall gate never touches the decision.
      deps.logger.warn(`turn-start recall gate failed: ${describeError(error)}`)
    }
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
  deps.registry.noteTurn(sessionId, turn)
  if (step !== 1 || deps.registry.isTurnStartDone(sessionId)) {
    return
  }
  deps.registry.markTurnStartDone(sessionId)
  void runTurnStartRecall(deps, sessionId, messages).catch((error: unknown) => {
    deps.logger.warn(`turn-start recall failed (skipped): ${describeError(error)}`)
  })
}

/** RunTurnStartRecall is the whole once-per-session flow, errors contained. */
async function runTurnStartRecall(
  deps: TurnStartDeps,
  sessionId: string,
  messages: readonly StepMessage[],
): Promise<void> {
  const { memory, registry } = deps
  const newId = deps.newMessageId ?? (() => randomUUID())
  const inject = (id: string, summary: string, block: string): number => {
    deps.agent.inject(makeNoticeMessage(id, summary, [block]))
    return approxTokens(block)
  }
  let injectedTokens = 0

  // Step 0: lazy provisioning; the trigger call answers the one-time
  // default-vault notice, which reads first, exactly once.
  const notice = await memory.ensureMemoryAccess()
  if (notice !== undefined) {
    injectedTokens += inject(newId(), 'obsidian-mem: default memory vault provisioned', notice)
  }

  // Step 1: one manifest scan for the session, at the agent's workspace.
  const cwd = deps.agent.session?.header?.cwd
  const manifest = cwd === undefined || cwd === ''
    ? null
    : scanManifestSafe(cwd, deps.manifestFs ?? nodeManifestFs, deps.logger)

  // Steps 2-3: query = first user text + manifest text; budget-fit trim.
  const query = [firstUserText(messages), manifest === null ? '' : manifestQueryText(manifest)]
    .filter((part) => part !== '')
    .join('\n\n')
  const kept: Array<{ key: string, block: string, fingerprint: string, terms: string[] }> = []
  if (query !== '') {
    let results: MemorySearchResult[]
    try {
      results = await memory.search({ query, topK: memory.config.budgets.searchTopK })
    } catch (error: unknown) {
      deps.logger.warn(`turn-start recall search failed (skipped): ${describeError(error)}`)
      results = []
    }
    let used = 0
    for (const result of results) {
      const key = sourceKeyFor(result)
      const fingerprint = String(result.updated_at)
      if (!registry.shouldInject(sessionId, key, fingerprint)) {
        continue
      }
      const block = wrapRecalled(result.source_path, result.chunk_text)
      const cost = approxTokens(block)
      if (used + cost > memory.config.budgets.turnStartRecallTokens) {
        break
      }
      used += cost
      kept.push({ key, block, fingerprint, terms: wakeTermsForSource(result) })
    }
  }

  // Recall bodies first, so the guidance line reads last.
  for (const item of kept) {
    injectedTokens += inject(newId(), 'obsidian-mem: turn-start recall', item.block)
    registry.markInjected(sessionId, item.key, item.fingerprint)
    registry.noteWakeTerms(sessionId, item.terms)
  }
  if (manifest !== null) {
    const guidance = guidanceLine(manifest)
    if (guidance !== '') {
      injectedTokens += inject(newId(), 'obsidian-mem: memory_search guidance', guidance)
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
