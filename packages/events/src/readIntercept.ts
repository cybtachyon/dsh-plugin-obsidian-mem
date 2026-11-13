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

import { dirname, extname, isAbsolute, normalize, resolve, sep } from 'node:path'
import {
  classifyPath,
  normalizeExtension,
} from '../../core/lib/index.js'
import type { MemorySearchResult } from '../../service/lib/search.js'
import type {
  HookLogger,
  LiveAgent,
  MemoryEventsService,
  ToolExecutionMirror,
  ToolResultMirror,
} from './host.js'
import { boundSummary } from './host.js'
import type { SessionRegistry } from './sessions.js'
import {
  collectFreshSources,
  fireAndForget,
  injectNotice,
  injectProvisionNotice,
  logSearchFailure,
  makeWarnOnce,
  markSourceInjected,
  messageIdFactory,
  runGuarded,
  sessionWorkspaceCwd,
  type WarnOnce,
} from './toolkit.js'

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
  const warnOnce = makeWarnOnce(deps.logger)

  const off = deps.ctx.on('tools/result', (exec, result) => {
    // Emit dispatch runs listeners raw; nothing may escape this one.
    runGuarded(deps.logger, 'read-intercept', () => {
      observeRead(deps, exec, result, warnOnce)
    })
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
  warnOnce: WarnOnce,
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
  const recall = runExactRecall(deps, agent, sessionId, absPath, {
    ...(ext === null ? {} : { ext }),
    ...(snippet === '' ? {} : { snippet }),
    ...(dirSignals.length === 0 ? {} : { dirSignals }),
  }, dir, warnOnce)
  fireAndForget(deps.logger, 'read-intercept recall', recall)
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
  warnOnce: WarnOnce,
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
    logSearchFailure({ logger: deps.logger, label: 'read-intercept', error, warnOnce })
    return
  }

  const fresh = collectFreshSources(registry, sessionId, results)
  if (fresh.length === 0) {
    return
  }

  const newId = messageIdFactory(deps)
  let injectedTokens = injectProvisionNotice(agent, newId, notice)
  // One envelope: the locality note names the file being read, then the
  // wrapped sections that speak to it.
  const locality = `Obsidian Mem: memory sections related to your read of ${absPath}.`
  injectedTokens += injectNotice(
    agent,
    newId(),
    boundSummary(`read recall for ${absPath}`),
    [locality, ...fresh.map((item) => item.block)],
  )
  for (const item of fresh) {
    markSourceInjected(registry, sessionId, item)
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
  const cwd = sessionWorkspaceCwd(agent)
  if (cwd === null) {
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
