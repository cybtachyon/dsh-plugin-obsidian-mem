/**
 * Read-tool intercept (TASK-042). Observes `tools/result` (emit; the frozen
 * final outcome) on the plugin context and enriches the calling agent's
 * session with exact-section recall for the file it just read: top
 * `budgets.readSections` sections at `budgets.readSectionTokens` tokens
 * each, from `service.searchExactSections` (exact-file chunks first, ext/
 * framework ARRAY_CONTAINS fallback narrowed to chunks whose wake_keywords
 * intersect the file's tokens). Filtered to the harness Read tool by
 * name: `memory_read` never appears here because it is a different tool
 * name and reads through the service, not the harness registry.
 *
 * Loop guard (task file, DoD "vault-file skip"): a file inside a registered
 * vault is itself indexed memory, and reading it must never trigger more
 * memory injection. On top of that, the session throttle (15 s window),
 * the session cap independent of the Think budget, the covered-directory
 * skip, the per-turn path dedupe, and the once-per-session source rule all
 * gate the fire, and a dream-work session (lineage, or the launcher while
 * its run is in flight) returns before every one of them (the combined
 * gate of PLAN-dream-isolation TASK-005/006). The listener never throws (emit
 * dispatch runs it raw) and
 * all work is fire-and-forget: a cold index must not delay the tool-result
 * path, and the one-time provisioning notice is prepended when
 * ensureMemoryAccess returns it.
 * @module dsh-plugin-obsidian-mem/events/readIntercept
 */

import { basename, dirname, extname, isAbsolute, normalize, resolve, sep } from 'node:path'
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
  ToolResultEvents,
  ToolResultMirror,
} from './host.js'
import { boundSummary } from './host.js'
import type { SessionRegistry } from './sessions.js'
import { isWakeTerm } from './sessions.js'
import {
  asRecord,
  collectFreshSources,
  deliverProvisionNotice,
  fireAndForget,
  injectNotice,
  isRecallSuppressed,
  logSearchFailure,
  makeWarnOnce,
  markSourceInjected,
  messageIdFactory,
  retainProvisionNotice,
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
  ctx: ToolResultEvents
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
  const args = asRecord(exec.arguments) ?? {}
  const given = typeof args['file_path'] === 'string' ? (args['file_path'] as string).trim() : ''
  if (given === '') {
    return
  }
  const sessionId = String(agent.id)
  // Dream-work suppression (PLAN-dream-isolation TASK-005/006): the
  // combined gate (dream lineage OR the launch window while a run is in
  // flight) returns before path resolution, the loop guard, the dedupe,
  // the throttle, the cap, the covered-directory skip, the search, and
  // every bookkeeping write, so a suppressed Read injects nothing and
  // consumes nothing.
  if (isRecallSuppressed(sessionId, deps)) {
    return
  }
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
  const fileTokens = fileTokensOf(absPath, snippet)
  const recall = runExactRecall(deps, agent, sessionId, absPath, {
    ...(ext === null ? {} : { ext }),
    ...(snippet === '' ? {} : { snippet }),
    ...(fileTokens.length === 0 ? {} : { fileTokens }),
  }, dir, warnOnce)
  fireAndForget(deps.logger, 'read-intercept recall', recall)
}

interface ExtractedSignals {
  ext?: string
  snippet?: string
  fileTokens?: string[]
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
  // prepended to the injection (Decision log). It rides the registry's
  // pending slot from here to the first flow that actually injects, so the
  // skips below (offline search, nothing fresh) never swallow it.
  retainProvisionNotice(registry, await memory.ensureMemoryAccess())
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
  let injectedTokens = deliverProvisionNotice(agent, newId, registry)
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

/** Upper bound on the file-derived wake tokens one fallback request carries. */
const FILE_TOKENS_MAX = 24

// Import-line fragments: the package/path specifier, the braced named
// bindings, and the default binding. Keywords (import/from/require) never
// reach the token set; only bindings and specifier chunks do.
const IMPORT_SPECIFIER_RE = /\bfrom\s+['"]([^'"]+)['"]|\brequire\(\s*['"]([^'"]+)['"]\s*\)/
const BRACED_BINDINGS_RE = /\{([^}]*)\}/
const DEFAULT_BINDING_RE = /^import\s+([A-Za-z_$][\w$]*)/

/**
 * FileTokensOf derives the deterministic wake tokens of the file being
 * read: the extensionless basename plus its `[-_\s]` parts, the
 * dirSignalsOf segments, and the identifiers and specifier chunks of the
 * import snippet (camel/snake split). Lower-cased, isWakeTerm-filtered,
 * deduped, capped at FILE_TOKENS_MAX. The fallback leg's wake_keywords
 * filter intersects exactly these tokens (TASK-008/010): a stored note
 * sharing no token with the read file never answers the neighborhood.
 */
export function fileTokensOf(absPath: string, snippet: string): string[] {
  const tokens = new Set<string>()
  // Split BEFORE lowering (camel humps vanish in the lower case), then the
  // one shared wake-term shape guard decides.
  const addParts = (word: string, split: RegExp): void => {
    for (const part of word.split(split)) {
      const term = part.toLowerCase()
      if (isWakeTerm(term)) {
        tokens.add(term)
      }
    }
  }
  addParts(basename(absPath).replace(/\.[^.]*$/, ''), /[-_\s]+/)
  for (const signal of dirSignalsOf(absPath)) {
    addParts(signal, /[_\s]+|(?=[A-Z])/)
  }
  for (const line of snippet.split('\n')) {
    const specifier = IMPORT_SPECIFIER_RE.exec(line)
    if (specifier !== null) {
      for (const chunk of (specifier[1] ?? specifier[2] ?? '').split(/[^\p{L}\p{N}]+/u)) {
        addParts(chunk, /[_\s]+|(?=[A-Z])/)
      }
    }
    const braced = BRACED_BINDINGS_RE.exec(line)
    if (braced !== null) {
      for (const binding of braced[1]!.split(/[\s,]+/)) {
        addParts(binding, /[_\s]+|(?=[A-Z])/)
      }
    }
    const named = DEFAULT_BINDING_RE.exec(line)
    if (named !== null) {
      addParts(named[1]!, /[_\s]+|(?=[A-Z])/)
    }
  }
  return [...tokens].slice(0, FILE_TOKENS_MAX)
}
