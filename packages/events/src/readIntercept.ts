/**
 * Read-tool intercept (TASK-042). Observes `tools/result` (emit; the frozen
 * final outcome) on the plugin context and enriches the calling agent's
 * session with exact-section recall for the file it just read: top
 * `budgets.readSections` sections at `budgets.readSectionTokens` tokens
 * each, from `service.searchExactSections` (exact-file chunks first, ext/
 * framework ARRAY_CONTAINS fallback). Filtered to the harness Read tool by
 * name: `memory_read` never appears here because it is a different tool
 * name and reads through the service, not the harness registry.
 *
 * Loop guard (task file, DoD "vault-file skip"): a file inside a registered
 * vault is itself indexed memory, and reading it must never trigger more
 * memory injection. On top of that, the session throttle (15 s window),
 * the session cap independent of the Think budget, the covered-directory
 * skip, the per-turn path dedupe, and the once-per-session source rule all
 * gate the fire. The listener never throws (emit dispatch runs it raw) and
 * all work is fire-and-forget: a cold index must not delay the tool-result
 * path, and the one-time provisioning notice is prepended when
 * ensureMemoryAccess returns it.
 * @module dsh-plugin-obsidian-mem/events/readIntercept
 */

import { randomUUID } from 'node:crypto'
import { dirname, extname, isAbsolute, normalize, resolve, sep } from 'node:path'
import {
  approxTokens,
  classifyPath,
  normalizeExtension,
  wrapRecalled,
} from '../../core/lib/index.js'
import { describeError } from '../../service/lib/errors.js'
import { IndexOfflineError } from '../../service/lib/search.js'
import type { MemorySearchResult } from '../../service/lib/search.js'
import type {
  HookLogger,
  LiveAgent,
  MemoryEventsService,
  ToolExecutionMirror,
  ToolResultMirror,
} from './host.js'
import { boundSummary, makeNoticeMessage } from './host.js'
import { sourceKeyFor, wakeTermsForSource, type SessionRegistry } from './sessions.js'

/** The harness Read tool's registry name (verified live: `read`). */
export const HARNESS_READ_TOOL_NAME = 'read'

/** Import-ish lines are worth ~2 KB of the result at most. */
const SNIPPET_SOURCE_CHARS = 2_048

/** …and never more than 12 lines. */
const SNIPPET_MAX_LINES = 12

/** Directory-signal segments taken from the path, deepest first. */
const DIR_SIGNAL_MAX_SEGMENTS = 6

/** Registration dependencies; the plugin ctx only needs `on`. */
export interface ReadInterceptDeps {
  ctx: {
    on(name: 'tools/result', listener: (exec: ToolExecutionMirror, result: ToolResultMirror) => undefined): () => boolean
  }
  memory: MemoryEventsService
  registry: SessionRegistry
  logger: HookLogger
  /** Message id factory; defaults to random UUIDs (test seam). */
  newMessageId?: () => string
}

/** InstallReadIntercept registers the plugin-level `tools/result` observer. */
export function installReadIntercept(deps: ReadInterceptDeps): () => void {
  // warnOnce for the offline state: a session that keeps reading against a
  // dead index gets one warning, then quiet skips.
  const warned = new Set<string>()
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) {
      return
    }
    warned.add(key)
    deps.logger.warn(message)
  }

  const off = deps.ctx.on('tools/result', (exec, result) => {
    try {
      observeRead(deps, exec, result, warnOnce)
    } catch (error: unknown) {
      // Emit dispatch runs listeners raw; nothing may escape this one.
      deps.logger.warn(`read-intercept failed: ${describeError(error)}`)
    }
    return undefined
  })
  return () => { off() }
}

// All the cheap filters run before any await; the search itself is
// fire-and-forget with contained errors.
function observeRead(
  deps: ReadInterceptDeps,
  exec: ToolExecutionMirror,
  result: ToolResultMirror,
  warnOnce: (key: string, message: string) => void,
): void {
  if (exec.name !== HARNESS_READ_TOOL_NAME || result.isError) {
    return
  }
  const agent = exec.agent
  if (agent === undefined) {
    return
  }
  const args = asObject(exec.arguments)
  const given = typeof args['file_path'] === 'string' ? (args['file_path'] as string).trim() : ''
  if (given === '') {
    return
  }
  const sessionId = String(agent.id)
  const absPath = resolveAgainstSession(agent, given)
  if (absPath === null) {
    return
  }
  // Loop guard: reads of memory content (anything inside a registered
  // vault) never inject more memory.
  if (classifyPath(deps.memory.listVaults(), absPath) !== null) {
    return
  }
  const registry = deps.registry
  if (registry.readPathSeen(sessionId, absPath)) {
    return
  }
  if (registry.readThrottleActive(sessionId) || !registry.readCapLeft(sessionId)) {
    return
  }
  const dir = dirname(absPath)
  if (registry.readDirCovered(sessionId, dir)) {
    return
  }
  const ext = normalizeExtension(extname(absPath))
  const snippet = importSnippetFrom(result.content)
  const dirSignals = dirSignalsOf(absPath)
  void runExactRecall(deps, agent, sessionId, absPath, {
    ...(ext === null ? {} : { ext }),
    ...(snippet === '' ? {} : { snippet }),
    ...(dirSignals.length === 0 ? {} : { dirSignals }),
  }, dir, warnOnce).catch((error: unknown) => {
    deps.logger.warn(`read-intercept recall failed (skipped): ${describeError(error)}`)
  })
}

interface ExtractedSignals {
  ext?: string
  snippet?: string
  dirSignals?: string[]
}

async function runExactRecall(
  deps: ReadInterceptDeps,
  agent: LiveAgent,
  sessionId: string,
  absPath: string,
  signals: ExtractedSignals,
  dir: string,
  warnOnce: (key: string, message: string) => void,
): Promise<void> {
  const { memory, registry } = deps
  const budgets = memory.config.budgets
  // Lazy provisioning first: a pending one-time default-vault notice is
  // prepended to the injection (Decision log).
  const notice = await memory.ensureMemoryAccess()
  let results: MemorySearchResult[]
  try {
    results = await memory.searchExactSections({
      filePath: absPath,
      ...signals,
      k: budgets.readSections,
      sectionTokens: budgets.readSectionTokens,
    })
  } catch (error: unknown) {
    if (error instanceof IndexOfflineError) {
      warnOnce('offline', `read-intercept skipped (index offline): ${describeError(error)}`)
      return
    }
    deps.logger.warn(`read-intercept search failed (skipped): ${describeError(error)}`)
    return
  }

  const fresh: Array<{ key: string, block: string, fingerprint: string, terms: string[] }> = []
  for (const item of results) {
    const key = sourceKeyFor(item)
    const fingerprint = String(item.updated_at)
    if (!registry.shouldInject(sessionId, key, fingerprint)) {
      continue
    }
    fresh.push({
      key,
      block: wrapRecalled(item.source_path, item.chunk_text),
      fingerprint,
      terms: wakeTermsForSource(item),
    })
  }
  if (fresh.length === 0) {
    return
  }

  const newId = deps.newMessageId ?? (() => randomUUID())
  let injectedTokens = 0
  const inject = (id: string, summary: string, blocks: readonly string[]): number => {
    agent.inject(makeNoticeMessage(id, summary, blocks))
    return blocks.reduce((total, block) => total + approxTokens(block), 0)
  }
  if (notice !== undefined) {
    injectedTokens += inject(newId(), 'obsidian-mem: default memory vault provisioned', [notice])
  }
  // One envelope: the locality note names the file being read, then the
  // wrapped sections that speak to it.
  const locality = `Obsidian Mem: memory sections related to your read of ${absPath}.`
  injectedTokens += inject(
    newId(),
    boundSummary(`read recall for ${absPath}`),
    [locality, ...fresh.map((item) => item.block)],
  )
  for (const item of fresh) {
    registry.markInjected(sessionId, item.key, item.fingerprint)
    registry.noteWakeTerms(sessionId, item.terms)
  }
  registry.noteReadInjection(sessionId, dir)
  registry.addRecallTokens(sessionId, injectedTokens)
}

// A relative `file_path` is resolved by the harness against the session's
// workspace; without a cwd there is nothing safe to classify.
function resolveAgainstSession(agent: LiveAgent, given: string): string | null {
  if (isAbsolute(given)) {
    return normalize(given)
  }
  const cwd = agent.session?.header?.cwd
  if (cwd === undefined || cwd === '') {
    return null
  }
  return normalize(resolve(cwd, given))
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

// The Read result is line-numbered (`N\t` prefixes); the snippet filter
// works on the recovered source lines of the first ~2 KB, capped at 12
// import-ish lines (task file: import|require|use|from).
export function importSnippetFrom(content: readonly { readonly type: string, readonly text: string }[]): string {
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .slice(0, SNIPPET_SOURCE_CHARS)
  const lines: string[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^\s*\d+\t/, '')
    if (/\b(import|require|use|from)\b/.test(line)) {
      lines.push(line.trim())
      if (lines.length >= SNIPPET_MAX_LINES) {
        break
      }
    }
  }
  return lines.join('\n')
}

/** DirSignalsOf feeds the path's directory names to the wake-signal filter. */
export function dirSignalsOf(absPath: string): string[] {
  return absPath
    .split(sep)
    .slice(0, -1)
    .filter((segment) => segment !== '' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(segment))
    .slice(-DIR_SIGNAL_MAX_SEGMENTS)
}
