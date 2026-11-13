/**
 * Think-stream keyword intercept (TASK-043). Rides `agent/assistant-stream`
 * (emit; `this: Scoped<Agent>`, verified against the live cordis 4.1.0
 * Event catalog), so the listener registers on the AGENT's own context from
 * the plugin's `agent/created` handler inside the agent effect (AGENTS.md
 * "DSH Event Facts": plugin-ctx listeners for agent-scoped events never
 * fire). It watches the accumulated stream text for COMPLETED
 * `<think>...</think>` blocks and, when one names a recall term, searches
 * memory and injects the hits.
 *
 * Block detection: per attempt (keyed by `attemptId`) the text-delta stream
 * accumulates; a scan cursor per attempt advances past each closed block, so
 * every block is matched exactly once even when its tags span deltas; an
 * unclosed opener is rescanned as later deltas arrive and is never injected
 * half. The harness's native reasoning channel (`reasoning-delta`, closed by
 * a reasoning `block-end`) is a completed think block on close, so its text
 * enters the same pipeline.
 *
 * The term vocabulary is the union of (a) the core INTENT_MARKERS, (b) the
 * wake terms the SessionRegistry kept for sources injected into this
 * session (the indexed wake_keywords never leave the collection and no live
 * keyword enumeration exists, so intercepts store deterministic note-header
 * terms: file stem + section header), and (c) the intent words recorded in
 * every vault's `.INTENTS.md`: the `## <marker>` section headers only, so
 * the file prose that lists people, paths, and decisions never floods the
 * vocabulary with generic tokens. Regex-scan only, no embedding; a block
 * with no hit is dropped. On a hit: `service.search`
 * with the block text (capped) as query and the matched terms as
 * `wakeKeywords` (top 2), the once-per-session source filter (shared in
 * toolkit.ts, where a session never gets back what it itself wrote, no
 * matter which agent instance of that session wrote it), the per-turn
 * `budgets.thinkShotsPerTurn` gate via the registry counter, and
 * `wrapRecalled` envelopes through `agent.inject()` (never `steer`, never
 * wakes). The listener never throws and all work is fire-and-forget: a cold
 * or dead index degrades to a warning, never a stalled stream.
 * @module dsh-plugin-obsidian-mem/events/thinkIntercept
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  INTENT_MARKERS,
  INTENTS_FILE,
  isIntentMarker,
} from '../../core/lib/index.js'
import type { MemorySearchResult } from '../../service/lib/search.js'
import type {
  AssistantStreamFrameMirror,
  AssistantStreamPayload,
  HookLogger,
  LiveAgent,
  MemoryEventsService,
} from './host.js'
import { boundSummary } from './host.js'
import type { SessionRegistry } from './sessions.js'
import {
  collectFreshSources,
  deliverProvisionNotice,
  fireAndForget,
  injectNotice,
  logSearchFailure,
  makeWarnOnce,
  markSourceInjected,
  messageIdFactory,
  retainProvisionNotice,
  runGuarded,
  type WarnOnce,
} from './toolkit.js'

/** Completed-block search top K (task file: topK=2). */
export const THINK_SEARCH_TOP_K = 2

/** Query cap: the block text enters the hybrid search capped at 500 chars. */
export const THINK_QUERY_MAX_CHARS = 500

/** Cap on the marker-header intent words admitted into the vocabulary. */
const INTENTS_TERMS_MAX = 120

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

/** Read seam for the shared vault's `.INTENTS.md`; null means unreadable. */
export interface IntentsFs {
  readFile(path: string): string | null
}

const nodeIntentsFs: IntentsFs = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return null
    }
  },
}

/** Constructor dependencies; `intentsFs` and `newMessageId` are test seams. */
export interface ThinkInterceptDeps {
  agent: LiveAgent
  memory: MemoryEventsService
  registry: SessionRegistry
  logger: HookLogger
  /** `.INTENTS.md` read seam; defaults to node fs. */
  intentsFs?: IntentsFs
  /** Message id factory; defaults to random UUIDs (test seam). */
  newMessageId?: () => string
}

/** Per-install state shared by the frame listener and the block pipeline. */
interface ThinkWatcher {
  deps: ThinkInterceptDeps
  stateByAttempt: Map<string, AttemptState>
  warnOnce: WarnOnce
  /** The recorded-intents vocabulary half, read once per agent. */
  intentsTerms(): string[]
}

/** One attempt's accumulation: text for the tag scan, reasoning per block. */
interface AttemptState {
  text: string
  /** Scan cursor; blocks ending before it are already consumed. */
  scanFrom: number
  /** Native reasoning text accumulated per content-block index. */
  readonly reasoning: Map<number, string>
}

/**
 * InstallThinkIntercept registers the per-agent `agent/assistant-stream`
 * observer (called from inside the caller's `agent.ctx.effect()`, per
 * AGENTS.md Event Facts) and answers its disposer, which also drops the
 * per-attempt buffers (the agent/disposed path tears the whole effect down).
 */
export function installThinkIntercept(deps: ThinkInterceptDeps): () => void {
  const stateByAttempt = new Map<string, AttemptState>()
  const warnOnce = makeWarnOnce(deps.logger)
  // The recorded-intents half of the vocabulary, read once per agent.
  let intentsTerms: string[] | null = null
  const intentsTermsOnce = (): string[] => {
    if (intentsTerms === null) {
      intentsTerms = readRecordedIntentTerms(deps.memory, deps.intentsFs)
    }
    return intentsTerms
  }
  const watcher: ThinkWatcher = { deps, stateByAttempt, warnOnce, intentsTerms: intentsTermsOnce }

  const listener = (payload: AssistantStreamPayload): void => {
    // Emit dispatch runs listeners raw; nothing may escape this one.
    runGuarded(deps.logger, 'think-intercept', () => {
      const frame = payload.frame
      if (typeof frame !== 'object' || frame === null || typeof frame.type !== 'string') {
        return
      }
      const sessionId = String(payload.agent.id)
      if (frame.type === 'start') {
        // Turn hint keeps the per-turn shot counter aligned even for loops
        // that reach the stream without a pre-step the hook observed.
        if (typeof frame.turn === 'number') {
          deps.registry.noteTurn(sessionId, frame.turn)
        }
        stateByAttempt.set(frame.attemptId, {
          text: '',
          scanFrom: 0,
          reasoning: new Map(),
        })
        return
      }
      if (frame.type === 'end') {
        // An abandoned attempt's text never commits; drop its buffers so a
        // retry re-scans from scratch (blocks still inject exactly once via
        // the registry's once-per-session source rule).
        if (frame.outcome?.kind === 'abandoned') {
          stateByAttempt.delete(frame.attemptId)
        }
        return
      }
      if (frame.type !== 'chunk') {
        return
      }
      const state = attemptState(stateByAttempt, frame.attemptId)
      observeChunk(watcher, sessionId, state, frame)
    })
  }

  const off = deps.agent.ctx.on('agent/assistant-stream', listener)
  return () => {
    off()
    stateByAttempt.clear()
  }
}

// Chunks without a start frame (poisoned or raced ordering) accumulate in a
// lazily created state instead of being dropped: the block rule is the close
// tag, not the frame protocol.
function attemptState(byAttempt: Map<string, AttemptState>, attemptId: string): AttemptState {
  let state = byAttempt.get(attemptId)
  if (state === undefined) {
    state = { text: '', scanFrom: 0, reasoning: new Map() }
    byAttempt.set(attemptId, state)
  }
  return state
}

function observeChunk(
  watcher: ThinkWatcher,
  sessionId: string,
  state: AttemptState,
  frame: AssistantStreamFrameMirror,
): void {
  const chunk = frame.chunk
  if (typeof chunk !== 'object' || chunk === null || typeof chunk.type !== 'string') {
    return
  }
  if (chunk.type === 'text-delta') {
    if (typeof chunk.text !== 'string' || chunk.text === '') {
      return
    }
    state.text += chunk.text
    const { blocks, next } = extractCompletedThinkBlocks(state.text, state.scanFrom)
    state.scanFrom = next
    for (const block of blocks) {
      scheduleThinkRecall(watcher, sessionId, block)
    }
    return
  }
  if (chunk.type === 'reasoning-delta') {
    if (typeof chunk.text !== 'string' || chunk.text === '' || typeof chunk.index !== 'number') {
      return
    }
    state.reasoning.set(chunk.index, (state.reasoning.get(chunk.index) ?? '') + chunk.text)
    return
  }
  if (chunk.type === 'block-end') {
    // The native thinking channel: a reasoning block's close is a completed
    // think block (task file), fed from the block text or the deltas.
    const block = chunk.block
    if (typeof block !== 'object' || block === null || block.type !== 'reasoning') {
      return
    }
    const streamed = typeof chunk.index === 'number' ? state.reasoning.get(chunk.index) : undefined
    if (typeof chunk.index === 'number') {
      state.reasoning.delete(chunk.index)
    }
    const text = typeof block.text === 'string' && block.text !== '' ? block.text : streamed
    if (typeof text !== 'string' || text.trim() === '') {
      return
    }
    scheduleThinkRecall(watcher, sessionId, text)
  }
}

function scheduleThinkRecall(watcher: ThinkWatcher, sessionId: string, blockText: string): void {
  const { deps } = watcher
  // The cheap scan runs before any await: no term, no work.
  const matched = matchVocabulary(deps, sessionId, blockText, watcher.intentsTerms)
  if (matched.length === 0) {
    return
  }
  if (!deps.registry.thinkBudgetLeft(sessionId)) {
    return
  }
  fireAndForget(
    deps.logger,
    'think-intercept recall',
    runThinkRecall(deps, sessionId, blockText, matched, watcher.warnOnce),
  )
}

async function runThinkRecall(
  deps: ThinkInterceptDeps,
  sessionId: string,
  blockText: string,
  matched: readonly string[],
  warnOnce: WarnOnce,
): Promise<void> {
  const { memory, registry } = deps
  // Lazy provisioning first: a pending one-time default-vault notice is
  // prepended to the injection (the pattern TASK-041/042 established). It
  // waits in the registry's pending slot through the offline-search, no-fresh,
  // and spent-shot returns below, so none of them swallows it.
  retainProvisionNotice(registry, await memory.ensureMemoryAccess())
  let results: MemorySearchResult[]
  try {
    results = await memory.search({
      query: blockText.slice(0, THINK_QUERY_MAX_CHARS),
      wakeKeywords: matched,
      topK: THINK_SEARCH_TOP_K,
    })
  } catch (error: unknown) {
    logSearchFailure({ logger: deps.logger, label: 'think-intercept', error, warnOnce })
    return
  }

  const fresh = collectFreshSources(registry, sessionId, results)
  if (fresh.length === 0) {
    return
  }
  // The per-turn cap is the last gate before any injection; the counter
  // itself is the budget (turnStart's noteTurn resets it each new turn).
  if (!registry.consumeThinkShot(sessionId)) {
    return
  }

  const newId = messageIdFactory(deps)
  let injectedTokens = deliverProvisionNotice(deps.agent, newId, registry)
  const header = `Obsidian Mem: memories matched by your thinking, terms: ${matched.join(', ')}.`
  injectedTokens += injectNotice(
    deps.agent,
    newId(),
    boundSummary(`think recall: ${matched.join(', ')}`),
    [header, ...fresh.map((item) => item.block)],
  )
  for (const item of fresh) {
    markSourceInjected(registry, sessionId, item)
  }
  registry.addRecallTokens(sessionId, injectedTokens)
}

// ---------------------------------------------------------------------------
// Completed-block scan.

/**
 * ExtractCompletedThinkBlocks returns every `<think>…</think>` block closed
 * at or after `from`, plus the cursor to resume the next scan from: the
 * cursor lands after the last consumed close tag, or on an unclosed opener
 * (rescanned as deltas arrive, so a tag split across deltas still completes
 * and half blocks never inject). Blocks match exactly once.
 */
export function extractCompletedThinkBlocks(
  text: string,
  from: number,
): { blocks: string[]; next: number } {
  const blocks: string[] = []
  let cursor = Math.max(0, Math.min(from, text.length))
  for (;;) {
    const open = text.indexOf(THINK_OPEN, cursor)
    if (open === -1) {
      // Keep a tail that could be a partial opener (tag split across deltas).
      return { blocks, next: Math.max(cursor, text.length - THINK_OPEN.length + 1) }
    }
    const close = text.indexOf(THINK_CLOSE, open + THINK_OPEN.length)
    if (close === -1) {
      return { blocks, next: open }
    }
    blocks.push(text.slice(open + THINK_OPEN.length, close))
    cursor = close + THINK_CLOSE.length
  }
}

// ---------------------------------------------------------------------------
// Vocabulary: INTENT_MARKERS + registry-held injected-source terms + the
// first shared vault's recorded .INTENTS.md entries.

function vocabulary(sessionId: string, deps: ThinkInterceptDeps, intentsTerms: readonly string[]): Set<string> {
  const terms = new Set<string>(INTENT_MARKERS)
  for (const term of intentsTerms) {
    terms.add(term)
  }
  for (const term of deps.registry.wakeTermsFor(sessionId)) {
    terms.add(term)
  }
  return terms
}

function matchVocabulary(
  deps: ThinkInterceptDeps,
  sessionId: string,
  blockText: string,
  intentsTermsOnce: () => string[],
): string[] {
  const haystack = blockText.toLowerCase()
  if (haystack.trim() === '') {
    return []
  }
  const matched: string[] = []
  for (const term of vocabulary(sessionId, deps, intentsTermsOnce())) {
    if (termPresent(haystack, term)) {
      matched.push(term)
    }
  }
  return matched
}

// Word-boundary-ish containment: terms are lower-case tokens, so a plain
// non-alphanumeric boundary test (no regex compile per term per block).
function termPresent(haystackLower: string, term: string): boolean {
  const needle = term.toLowerCase()
  let at = haystackLower.indexOf(needle)
  while (at !== -1) {
    const before = at === 0 ? '' : haystackLower[at - 1] as string
    const afterAt = at + needle.length
    const after = afterAt >= haystackLower.length ? '' : haystackLower[afterAt] as string
    if (!isWordChar(before) && !isWordChar(after)) {
      return true
    }
    at = haystackLower.indexOf(needle, at + 1)
  }
  return false
}

function isWordChar(char: string): boolean {
  return char !== '' && /[a-z0-9_]/.test(char)
}

// ---------------------------------------------------------------------------
// Term sources. The header-term derivation lives with the registry
// (`wakeTermsForSource` in sessions.ts); this half reads every vault's
// recorded intents.

// ReadRecordedIntentTerms unions the intent words recorded in EVERY
// registered vault's `.INTENTS.md` (shared and readonly: vocabulary growth
// is read-only work). An intent word is a `## <marker>` section header
// (plan Q1: headers only, so the checklist prose never contributes tokens);
// a non-marker header and every other line are ignored. Unreadable files
// skip: the vault contributes nothing and the INTENT_MARKERS half still
// works.
export function readRecordedIntentTerms(
  memory: MemoryEventsService,
  intentsFs: IntentsFs | undefined,
): string[] {
  const read = intentsFs ?? nodeIntentsFs
  const terms = new Set<string>()
  for (const vault of memory.listVaults()) {
    const text = read.readFile(join(vault.path, INTENTS_FILE))
    if (typeof text !== 'string') {
      continue
    }
    for (const line of text.split('\n')) {
      const header = /^##\s+(\S.*?)\s*$/.exec(line)
      if (header === null) {
        continue
      }
      const name = (header[1] ?? '').toLowerCase()
      if (isIntentMarker(name)) {
        terms.add(name)
      }
    }
    if (terms.size >= INTENTS_TERMS_MAX) {
      break
    }
  }
  return [...terms].slice(0, INTENTS_TERMS_MAX)
}
