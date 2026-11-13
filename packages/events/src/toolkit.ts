/**
 * Toolkit: the plumbing every lifecycle listener assembles the same way,
 * kept in one home instead of per-module copies (mirrors the tools package
 * toolkit): the throw-proof listener wrapper and the fire-and-forget
 * starter, the keyed warn-once sink behind the offline-index discipline,
 * the search-failure log line (offline degrades to one warning when the
 * caller carries a warn-once sink), the once-per-session fresh-source
 * filter shared by the three recall flows (wrapRecalled envelope, content
 * fingerprint, wake terms, all clumped in one FreshSource), which also
 * drops every source the session itself wrote (a session never gets back
 * what it authored, no matter which agent instance of it wrote that), the
 * notice injector with token accounting, the one-time provisioning-notice
 * prepend, and the per-source ledger mark.
 *
 * Nothing here decides when a flow fires: the gates stay with their owners
 * (SessionRegistry for budgets, throttles, and the once-per-session rule;
 * each listener for its own cheap filters).
 * @module dsh-plugin-obsidian-mem/events/toolkit
 */

import { randomUUID } from 'node:crypto'
import { approxTokens, wrapRecalled } from '../../core/lib/index.js'
import { describeError } from '../../service/lib/errors.js'
import { IndexOfflineError } from '../../service/lib/search.js'
import type { MemorySearchResult } from '../../service/lib/search.js'
import type { HookLogger, LiveAgent } from './host.js'
import { makeNoticeMessage } from './host.js'
import { sourceKeyFor, wakeTermsForSource, type SessionRegistry } from './sessions.js'

// ---------------------------------------------------------------------------
// Listener and task wrappers. Emit dispatch runs listeners raw and serial
// dispatch lets a throw break the close, so every listener body is wrapped;
// async recall work must never block a waterfall or a tool-result path, so
// it starts detached and its rejection only ever logs.

/** RunGuarded runs one listener body; a throw logs and stays contained. */
export function runGuarded(logger: HookLogger, label: string, body: () => void): void {
  try {
    body()
  } catch (error: unknown) {
    logger.warn(`${label} failed: ${describeError(error)}`)
  }
}

/** FireAndForget starts detached async work; a rejection logs as skipped. */
export function fireAndForget(logger: HookLogger, label: string, work: Promise<unknown>): void {
  void work.catch((error: unknown) => {
    logger.warn(`${label} failed (skipped): ${describeError(error)}`)
  })
}

/**
 * AsRecord narrows an unknown event payload (tool arguments, a tool's
 * structured value) to a plain object record; arrays, null, and non-objects
 * answer null, so poisoned payloads take the caller's skip path.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** WarnOnce is a keyed warning sink: every key logs at most once. */
export type WarnOnce = (key: string, message: string) => void

/**
 * MakeWarnOnce builds the keyed sink behind the offline-index discipline:
 * a session hammering a dead index gets one warning, then quiet skips.
 */
export function makeWarnOnce(logger: HookLogger): WarnOnce {
  const warned = new Set<string>()
  return (key, message) => {
    if (warned.has(key)) {
      return
    }
    warned.add(key)
    logger.warn(message)
  }
}

/**
 * LogSearchFailure logs one failed recall search. With a warn-once sink,
 * the typed offline error degrades to the single `skipped (index offline)`
 * line; everything else (and offline without a sink) logs as skipped.
 */
export function logSearchFailure(opts: {
  logger: HookLogger
  /** Module label opening the line, e.g. `read-intercept`. */
  label: string
  error: unknown
  warnOnce?: WarnOnce
}): void {
  const { logger, label, error } = opts
  if (opts.warnOnce !== undefined && error instanceof IndexOfflineError) {
    opts.warnOnce('offline', `${label} skipped (index offline): ${describeError(error)}`)
    return
  }
  logger.warn(`${label} search failed (skipped): ${describeError(error)}`)
}

// ---------------------------------------------------------------------------
// The shared recall-source pipeline. All three flows filter search results
// through the once-per-session rule plus the written-source exclusion (a
// session never gets back a memory it authored itself, no matter which
// agent instance of that session wrote it) and inject the survivors;
// FreshSource clumps what every later step needs (ledger key, wrapped
// block, content fingerprint, wake terms) so the same result fields never
// travel loose.

/** One recall result fresh for this session: never injected, never written. */
export interface FreshSource {
  /** Ledger key of the source (sourceKeyFor of the result). */
  key: string
  /** The wrapRecalled envelope, ready to inject. */
  block: string
  /** Content fingerprint at injection (the indexed updated_at). */
  fingerprint: string
  /** Header wake terms this source contributes to the session. */
  terms: string[]
}

/**
 * CollectFreshSources maps the results the session has neither written
 * itself (the TASK-001 written-source ledger) nor already seen (same or
 * unknown fingerprint stays filtered) to FreshSource records, in result
 * order. Callers keep their own gates: budget trimming (turnStart), the
 * per-turn Think shot (thinkIntercept), the Read throttle and cap.
 */
export function collectFreshSources(
  registry: SessionRegistry,
  sessionId: string,
  results: readonly MemorySearchResult[],
): FreshSource[] {
  const fresh: FreshSource[] = []
  for (const result of results) {
    const key = sourceKeyFor(result)
    // The exclusion is the shared rule of all three flows (PLAN-mem-loop-
    // tuning Q2): a self-authored note answers nothing the author does not
    // already hold, and the written ledger is keyed by session id, so a
    // write by any agent instance of the session excludes the source.
    if (registry.wasWrittenIn(sessionId, key)) {
      continue
    }
    const fingerprint = String(result.updated_at)
    if (!registry.shouldInject(sessionId, key, fingerprint)) {
      continue
    }
    fresh.push({
      key,
      block: wrapRecalled(result.source_path, result.chunk_text),
      fingerprint,
      terms: wakeTermsForSource(result),
    })
  }
  return fresh
}

/** MarkSourceInjected records one injected source: fingerprint + wake terms. */
export function markSourceInjected(
  registry: SessionRegistry,
  sessionId: string,
  source: FreshSource,
): void {
  registry.markInjected(sessionId, source.key, source.fingerprint)
  registry.noteWakeTerms(sessionId, source.terms)
}

// ---------------------------------------------------------------------------
// Injection plumbing. Every injected message is a notice-form UserMessage
// (host.makeNoticeMessage) delivered through agent.inject (never wakes);
// the injector answers the block token cost so the caller can account it
// into the session's TASK-045 usage.

/** InjectNotice delivers one notice message and answers its token cost. */
export function injectNotice(
  agent: LiveAgent,
  id: string,
  summary: string,
  blocks: readonly string[],
): number {
  agent.inject(makeNoticeMessage(id, summary, blocks))
  return blocks.reduce((total, block) => total + approxTokens(block), 0)
}

/** Summary every flow gives the one-time default-vault notice message. */
export const PROVISION_NOTICE_SUMMARY = 'obsidian-mem: default memory vault provisioned'

/**
 * RetainProvisionNotice stores the notice the flow's ensureMemoryAccess
 * answered in the registry's pending slot (no-op without one), so a later
 * injection skip in this flow (offline index, nothing fresh, spent Think
 * shot) cannot lose it. Every flow calls this right after ensureMemoryAccess
 * and delivers through deliverProvisionNotice at its first real injection.
 */
export function retainProvisionNotice(
  registry: SessionRegistry,
  notice: string | undefined,
): void {
  if (notice !== undefined) {
    registry.holdProvisionNotice(notice)
  }
}

/**
 * DeliverProvisionNotice injects the registry's pending default-vault notice,
 * when one waits, as the flow's first message and answers its token cost (0
 * when nothing was pending). Taking clears the slot, so the notice ships
 * exactly once across the turn-start, Read, and Think flows.
 */
export function deliverProvisionNotice(
  agent: LiveAgent,
  newId: () => string,
  registry: SessionRegistry,
): number {
  const notice = registry.takeProvisionNotice()
  return notice === undefined ? 0 : injectNotice(agent, newId(), PROVISION_NOTICE_SUMMARY, [notice])
}

/** MessageIdFactory answers the deps override, else random UUIDs. */
export function messageIdFactory(deps: { newMessageId?: () => string }): () => string {
  return deps.newMessageId ?? randomUUID
}

/**
 * SessionWorkspaceCwd answers the agent's session workspace dir, or null
 * when the header carries none (nothing safe to resolve or scan against).
 */
export function sessionWorkspaceCwd(agent: LiveAgent): string | null {
  const cwd = agent.session?.header?.cwd
  return cwd === undefined || cwd === '' ? null : cwd
}
