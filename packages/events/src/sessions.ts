/**
 * SessionRegistry: per-session memory-injection bookkeeping (TASK-040).
 * Keyed by the agent's session id (`agent.id`, a SessionId): the same agent
 * keeps one key across every turn, and a subagent runs under its own
 * session id, so subagents are separate sessions by construction. The
 * subagent signal (verified against the @deepseek-ai/dsh-session
 * SessionHeader types) is `header.origin === 'subagent'` or a positive
 * `header.delegationDepth`; it is recorded for `isSubagent()` only, never
 * used for keying.
 *
 * The load-bearing rule: one memory source is injected at most ONCE per
 * session, even across resumed days, until the source's content fingerprint
 * changes after injection (a note rewritten by dreaming or the user gets
 * re-indexed and its indexed `updated_at` moves, which is the fingerprint
 * search results carry). Live records die with `disposeSession` on
 * `agent/disposed`; the persisted ledger at
 * `<dbPath>/state/sessions.json` survives restarts (LRU-capped, TTL-bounded)
 * so a session resumed next week still honors the rule.
 * @module dsh-plugin-obsidian-mem/events/sessions
 */

import { basename, dirname } from 'node:path'
import type { ServiceFs } from '../../service/lib/index.js'
import { nodeServiceFs } from '../../service/lib/index.js'

/** File name for the persisted per-session ledger under the plugin state dir. */
export const SESSIONS_FILE_NAME = 'sessions.json'

/**
 * SourceKey canonicalizes one memory note's identity for the
 * once-per-session ledger: the (truncated) vault column plus the note's
 * vault-relative source path, exactly as search results carry them, so the
 * turn-start recall and the Read/Think intercepts share one dedupe space.
 */
export function sourceKeyFor(result: { vault: string, source_path: string }): string {
  return `${result.vault}\u0000${result.source_path}`
}

/** Ledger sessions older than this (last touch) are dropped at persist time. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** At most this many sessions persist; the least-recently-touched go first. */
export const SESSIONS_LRU_MAX = 200

/** Two Read-intercept injections for one session must sit this far apart. */
export const READ_INJECTION_THROTTLE_MS = 15_000

/** Read-intercept injections per session, a cap independent of the Think budget. */
export const READ_INJECTION_CAP_PER_SESSION = 6

/** Default debounce between a ledger mutation and the debounced write. */
export const SESSIONS_PERSIST_DEBOUNCE_MS = 1_000

/** Wake terms one injected source contributes to the Think vocabulary. */
const SOURCE_TERMS_MAX = 32

// A wake term is a lower-cased token; the same shape discipline the
// wake_keywords collection column applies, kept local to the ledger.
const TERM_PATTERN = /^[a-z0-9][a-z0-9.+*#-]*$/
const TERM_MIN_LENGTH = 2
const TERM_MAX_LENGTH = 64

/** IsWakeTerm tests the lower-cased token shape shared by every term source. */
export function isWakeTerm(term: string): boolean {
  return term.length >= TERM_MIN_LENGTH
    && term.length <= TERM_MAX_LENGTH
    && TERM_PATTERN.test(term)
}

/**
 * WakeTermsForSource returns the deterministic header terms one injected
 * source contributes to the session's Think vocabulary: the file stem (plus
 * its -/_ parts) and the section-header tokens. The true wake_keywords live
 * only in the collection (no live enumeration exists), so these header
 * terms stand in for "wake_keywords of memories injected in this session"
 * (TASK-043 task file).
 */
export function wakeTermsForSource(result: {
  source_path: string
  section_header?: string | null
}): string[] {
  const stem = basename(result.source_path).replace(/\.[A-Za-z0-9]+$/, '')
  const terms = new Set<string>()
  const rawTerms = [
    ...stem.split(/[-_\s]+/),
    stem,
    ...(result.section_header ?? '').split(/\s+/),
  ]
  for (const raw of rawTerms) {
    const term = raw.trim().toLowerCase()
    if (term.length >= TERM_MIN_LENGTH && term.length <= TERM_MAX_LENGTH && TERM_PATTERN.test(term)) {
      terms.add(term)
    }
  }
  return [...terms].slice(0, SOURCE_TERMS_MAX)
}

/** What one injected source remembers: when, and the content it was injected for. */
export interface InjectedSourceRecord {
  at: number
  /** Content fingerprint at injection (the result's indexed updated_at). */
  fingerprint?: string
}

/** The live per-session bookkeeping record. */
export interface SessionRecord {
  readonly sessionId: string
  /** sourceKey -> what was injected; the once-per-session rule's state. */
  readonly injectedSources: Map<string, InjectedSourceRecord>
  /** Turn-start recall has fired (per process; re-evaluated on resume). */
  turnStartDone: boolean
  /** Last pre-step turn number observed; drives per-turn resets. */
  lastTurn: number
  /**
   * First user-sourced text of the current turn (TASK-044's trivial-turn
   * guard); captured at the pre-step, reset by noteTurn.
   */
  firstUserTextThisTurn: string
  /** A memory_* tool ran in the current turn (TASK-044's skip guard). */
  memoryToolUsedThisTurn: boolean
  /** Think-intercept injections used in the current turn (TASK-043 consumes). */
  thinkShots: number
  /** Approx tokens the turn-start recall injected this session (TASK-045). */
  turnRecallTokensUsed: number
  /** Read-intercept injections this session (cap enforcement). */
  readInjections: number
  /** Epoch ms of the last Read-intercept injection (throttle input). */
  lastReadInjectionAt: number
  /** Directories a Read-intercept injection already covered this session. */
  readonly coveredDirs: Set<string>
  /** Files already observed by the Read intercept in the current turn. */
  readonly readPathsThisTurn: Set<string>
  /**
   * Wake terms of memories injected into this session (TASK-043's Think
   * vocabulary: "wake_keywords of memories injected in this session").
   * The indexed wake_keywords never leave the collection, so the intercepts
   * store the deterministic note-header terms (file stem + section header)
   * of every source they inject; the Think intercept unions them with the
   * INTENT_MARKERS and the shared vault's recorded `.INTENTS.md` entries.
   */
  readonly wakeTerms: Set<string>
  subagent: boolean
  readonly createdAt: number
  updatedAt: number
}

/** Constructor options; only `file` and `thinkShotsPerTurn` are required. */
export interface SessionRegistryOptions {
  /** Absolute path of the persisted ledger (`<stateDir>/sessions.json`). */
  file: string
  /** Per-turn Think-intercept cap, from the mounted service config. */
  thinkShotsPerTurn: number
  /** Disk seam; production passes the service's nodeServiceFs. */
  fs?: ServiceFs
  /** Clock seam for throttle/TTL tests. */
  now?: () => number
  /** Persisted-session LRU cap; default {@link SESSIONS_LRU_MAX}. */
  maxSessions?: number
  /** Persisted-session TTL; default {@link SESSION_TTL_MS}. */
  ttlMs?: number
  /** Persist debounce; 0 persists synchronously on every mutation. */
  debounceMs?: number
  /** Sink for ledger warnings; absent stays silent. */
  log?: (message: string) => void
}

// The persisted file shape. Live-only fields (turnStartDone, counters) are
// never persisted: a resumed process re-runs turn-start recall, and the
// once-per-session rule is enforced by `injected` alone.
interface PersistedSession {
  injected: Record<string, InjectedSourceRecord>
  subagent: boolean
  createdAt: number
  updatedAt: number
}

interface SessionsFile {
  version: 1
  sessions: Record<string, PersistedSession>
}

/**
 * SessionRegistry owns the once-per-session injection rule, the per-turn
 * Think budget counters, and the Read-intercept throttle state, with the
 * injected-sources ledger persisted (atomically, debounced) so resumed
 * sessions across restarts keep honoring it.
 */
export class SessionRegistry {
  private readonly file: string
  private readonly thinkShotsPerTurn: number
  private readonly fs: ServiceFs
  private readonly now: () => number
  private readonly maxSessions: number
  private readonly ttlMs: number
  private readonly debounceMs: number
  private readonly log: (message: string) => void

  /** Live records, keyed by session id; disposed sessions leave. */
  private readonly sessions = new Map<string, SessionRecord>()
  /**
   * The one-time default-vault notice waiting for its first successful
   * injection (TASK-046 carry-over). A recall flow that fetched the notice
   * from the service and then skipped its injection (offline index, nothing
   * fresh, spent Think shot) retains it here instead of losing it; the next
   * flow that injects anything takes it. Live-only: never persisted, the
   * service re-answers the notice to its own callers after a restart.
   */
  private pendingProvisionNotice: string | null = null
  /** Persisted mirror; authoritative for what the next write serializes. */
  private readonly store = new Map<string, PersistedSession>()
  private loaded = false
  private closed = false
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: SessionRegistryOptions) {
    this.file = options.file
    this.thinkShotsPerTurn = options.thinkShotsPerTurn
    this.fs = options.fs ?? nodeServiceFs
    this.now = options.now ?? (() => Date.now())
    this.maxSessions = options.maxSessions ?? SESSIONS_LRU_MAX
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS
    this.debounceMs = options.debounceMs ?? SESSIONS_PERSIST_DEBOUNCE_MS
    this.log = options.log ?? (() => {})
  }

  /**
   * Ensure returns the live record, hydrating it from the persisted ledger
   * on first sight (a resumed session keeps its injected-sources history).
   */
  ensure(sessionId: string, info: { subagent?: boolean } = {}): SessionRecord {
    this.ensureLoaded()
    let record = this.sessions.get(sessionId)
    if (record === undefined) {
      const persisted = this.store.get(sessionId)
      record = {
        sessionId,
        injectedSources: new Map(
          Object.entries(persisted?.injected ?? {})
            .filter(([, value]) => typeof value?.at === 'number')
            .map(([key, value]) => [key, {
              at: value.at,
              ...(typeof value.fingerprint === 'string' ? { fingerprint: value.fingerprint } : {}),
            }]),
        ),
        turnStartDone: false,
        lastTurn: 0,
        firstUserTextThisTurn: '',
        memoryToolUsedThisTurn: false,
        thinkShots: 0,
        turnRecallTokensUsed: 0,
        readInjections: 0,
        lastReadInjectionAt: 0,
        coveredDirs: new Set(),
        readPathsThisTurn: new Set(),
        wakeTerms: new Set(),
        subagent: persisted?.subagent ?? false,
        createdAt: persisted?.createdAt ?? this.now(),
        updatedAt: persisted?.updatedAt ?? this.now(),
      }
      this.sessions.set(sessionId, record)
    }
    if (info.subagent === true && !record.subagent) {
      record.subagent = true
      this.touch(record)
    }
    return record
  }

  /** IsSubagent answers whether the session was created as a subagent child. */
  isSubagent(sessionId: string): boolean {
    return this.ensure(sessionId).subagent
  }

  /**
   * ShouldInject answers the once-per-session rule: a source the session
   * never saw is eligible; one injected with the same (or unknown) content
   * fingerprint is not; one whose fingerprint changed since injection is
   * eligible again (the note was rewritten and re-indexed).
   */
  shouldInject(sessionId: string, sourceKey: string, fingerprint?: string): boolean {
    const stored = this.ensure(sessionId).injectedSources.get(sourceKey)
    if (stored === undefined) {
      return true
    }
    return fingerprint !== undefined
      && stored.fingerprint !== undefined
      && stored.fingerprint !== fingerprint
  }

  /** MarkInjected records the source (and its content fingerprint) and persists. */
  markInjected(sessionId: string, sourceKey: string, fingerprint?: string): void {
    const record = this.ensure(sessionId)
    record.injectedSources.set(sourceKey, {
      at: this.now(),
      ...(fingerprint === undefined ? {} : { fingerprint }),
    })
    this.touch(record)
    this.schedulePersist()
  }

  /** InjectedSources snapshots the session's ledger keys (test/audit view). */
  injectedSources(sessionId: string): Map<string, InjectedSourceRecord> {
    return new Map(this.ensure(sessionId).injectedSources)
  }

  /** IsTurnStartDone answers whether turn-start recall already fired. */
  isTurnStartDone(sessionId: string): boolean {
    return this.ensure(sessionId).turnStartDone
  }

  /** MarkTurnStartDone claims the once-per-session recall slot. */
  markTurnStartDone(sessionId: string): void {
    const record = this.ensure(sessionId)
    record.turnStartDone = true
    this.touch(record)
  }

  /**
   * NoteTurn folds one observed pre-step turn into the record: a new turn
   * number resets the per-turn state (Think shots, per-turn Read dedupe,
   * first-user-text, memory-tool-used). When `firstUserText` is supplied
   * and the turn's slot is still empty, it is recorded (the first user
   * message of the turn wins).
   */
  noteTurn(sessionId: string, turn: number, firstUserText?: string): void {
    const record = this.ensure(sessionId)
    if (turn === record.lastTurn) {
      // Same turn: fill the first-user-text slot only if still empty.
      if (firstUserText !== undefined && record.firstUserTextThisTurn === '' && firstUserText !== '') {
        record.firstUserTextThisTurn = firstUserText
      }
      return
    }
    record.lastTurn = turn
    record.thinkShots = 0
    record.readPathsThisTurn.clear()
    record.firstUserTextThisTurn = firstUserText ?? ''
    record.memoryToolUsedThisTurn = false
    this.touch(record)
  }

  /** FirstUserText answers the current turn's first user text (TASK-044). */
  firstUserText(sessionId: string): string {
    return this.ensure(sessionId).firstUserTextThisTurn
  }

  /** NoteMemoryToolUse flags the current turn as memory-tool-using. */
  noteMemoryToolUse(sessionId: string): void {
    const record = this.ensure(sessionId)
    if (record.memoryToolUsedThisTurn) {
      return
    }
    record.memoryToolUsedThisTurn = true
    this.touch(record)
  }

  /** MemoryToolUsed answers whether the current turn used a memory_* tool. */
  memoryToolUsed(sessionId: string): boolean {
    return this.ensure(sessionId).memoryToolUsedThisTurn
  }

  /** ThinkBudgetLeft answers the per-turn Think-intercept cap (TASK-043). */
  thinkBudgetLeft(sessionId: string): number {
    return Math.max(0, this.thinkShotsPerTurn - this.ensure(sessionId).thinkShots)
  }

  /** ConsumeThinkShot spends one Think shot; false when the turn's cap is spent. */
  consumeThinkShot(sessionId: string): boolean {
    const record = this.ensure(sessionId)
    if (record.thinkShots >= this.thinkShotsPerTurn) {
      return false
    }
    record.thinkShots += 1
    this.touch(record)
    return true
  }

  /** AddRecallTokens accumulates injected tokens for TASK-045's global budget. */
  addRecallTokens(sessionId: string, tokens: number): void {
    const record = this.ensure(sessionId)
    record.turnRecallTokensUsed += Math.max(0, Math.trunc(tokens))
    this.touch(record)
  }

  /** RecallTokensUsed answers what turn-start recall injected this session. */
  recallTokensUsed(sessionId: string): number {
    return this.ensure(sessionId).turnRecallTokensUsed
  }

  /** TotalRecallTokensUsed sums every session (the SessionRegistryView slice). */
  totalRecallTokensUsed(): number {
    this.ensureLoaded()
    let total = 0
    for (const record of this.sessions.values()) {
      total += record.turnRecallTokensUsed
    }
    return total
  }

  /**
   * HoldProvisionNotice retains the one-time default-vault notice a recall
   * flow fetched but did not yet deliver, so no injection skip can lose it.
   * A later hold replaces the earlier one (the service answers the notice to
   * one caller per process, so at most one is ever in flight).
   */
  holdProvisionNotice(notice: string): void {
    this.pendingProvisionNotice = notice
  }

  /**
   * TakeProvisionNotice answers the retained notice and clears the slot, so
   * the delivery is exactly-once across the three recall flows; undefined
   * when nothing waits.
   */
  takeProvisionNotice(): string | undefined {
    const notice = this.pendingProvisionNotice
    this.pendingProvisionNotice = null
    return notice ?? undefined
  }

  /** ReadThrottleActive is true while the last Read injection is < 15 s old. */
  readThrottleActive(sessionId: string): boolean {
    const record = this.ensure(sessionId)
    return record.lastReadInjectionAt > 0
      && this.now() - record.lastReadInjectionAt < READ_INJECTION_THROTTLE_MS
  }

  /** ReadCapLeft answers the session's Read-intercept injection cap. */
  readCapLeft(sessionId: string): boolean {
    return this.ensure(sessionId).readInjections < READ_INJECTION_CAP_PER_SESSION
  }

  /** ReadDirCovered answers whether an injection already covered this dir. */
  readDirCovered(sessionId: string, dir: string): boolean {
    return this.ensure(sessionId).coveredDirs.has(dir)
  }

  /** ReadPathSeen records one file path for the turn and reports the repeat. */
  readPathSeen(sessionId: string, path: string): boolean {
    const record = this.ensure(sessionId)
    if (record.readPathsThisTurn.has(path)) {
      return true
    }
    record.readPathsThisTurn.add(path)
    return false
  }

  /** NoteReadInjection spends one Read-intercept slot and records its dir. */
  noteReadInjection(sessionId: string, dir: string): void {
    const record = this.ensure(sessionId)
    record.readInjections += 1
    record.lastReadInjectionAt = this.now()
    record.coveredDirs.add(dir)
    this.touch(record)
  }

  /**
   * NoteWakeTerms records the header terms of one injected source for
   * TASK-043's Think vocabulary. Session-lifetime: a term stays eligible
   * for later turns' Think blocks (the sources themselves stay injected).
   */
  noteWakeTerms(sessionId: string, terms: readonly string[]): void {
    if (terms.length === 0) {
      return
    }
    const record = this.ensure(sessionId)
    for (const term of terms) {
      record.wakeTerms.add(term)
    }
  }

  /** WakeTermsFor snapshots the session's injected-source terms. */
  wakeTermsFor(sessionId: string): ReadonlySet<string> {
    return new Set(this.ensure(sessionId).wakeTerms)
  }

  /** DisposeSession drops the live record on agent teardown; the persisted
   * ledger entry stays, so a later resume of the same session id still
   * honors the once-per-session rule. */
  disposeSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Flush writes the ledger now, canceling any pending debounce. */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.persistNow()
  }

  /** Close flushes the ledger and stops scheduling writes. */
  close(): void {
    this.flush()
    this.closed = true
  }

  // Ledger file read once per process; unreadable or corrupt content is
  // logged and treated as empty (self-healing, never a dead plugin).
  private ensureLoaded(): void {
    if (this.loaded) {
      return
    }
    this.loaded = true
    const raw = this.readFileSafe()
    if (raw === null) {
      return
    }
    try {
      const parsed = JSON.parse(raw) as Partial<SessionsFile>
      const sessions = parsed.sessions
      if (typeof sessions !== 'object' || sessions === null) {
        return
      }
      const cutoff = this.now() - this.ttlMs
      for (const [sessionId, entry] of Object.entries(sessions)) {
        if (typeof entry?.updatedAt !== 'number' || entry.updatedAt < cutoff) {
          continue
        }
        this.store.set(sessionId, {
          injected: typeof entry.injected === 'object' && entry.injected !== null ? entry.injected : {},
          subagent: entry.subagent === true,
          createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : entry.updatedAt,
          updatedAt: entry.updatedAt,
        })
      }
    } catch (error: unknown) {
      this.log(`sessions.json unreadable (${this.file}): ${String(error)}; starting empty`)
      this.store.clear()
    }
  }

  private readFileSafe(): string | null {
    try {
      return this.fs.readFile(this.file)
    } catch (error: unknown) {
      this.log(`sessions.json read failed (${this.file}): ${String(error)}`)
      return null
    }
  }

  private touch(record: SessionRecord): void {
    record.updatedAt = this.now()
    this.store.set(record.sessionId, {
      injected: Object.fromEntries(record.injectedSources),
      subagent: record.subagent,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
  }

  private schedulePersist(): void {
    if (this.closed || this.debounceMs < 0) {
      return
    }
    if (this.debounceMs === 0) {
      this.persistNow()
      return
    }
    if (this.timer !== null) {
      clearTimeout(this.timer)
    }
    this.timer = setTimeout(() => {
      this.timer = null
      this.persistNow()
    }, this.debounceMs)
    // The debounced write must never hold the process open.
    this.timer.unref?.()
  }

  // Atomic tmp+rename (the service's vaults.json pattern): a crash mid-write
  // leaves the previous ledger intact. TTL then LRU prune run at write time
  // so the file stays bounded no matter how many sessions touched it.
  private persistNow(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [sessionId, entry] of this.store) {
      if (entry.updatedAt < cutoff) {
        this.store.delete(sessionId)
        this.sessions.delete(sessionId)
      }
    }
    if (this.store.size > this.maxSessions) {
      const byAge = [...this.store.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      for (const [sessionId] of byAge.slice(this.maxSessions)) {
        this.store.delete(sessionId)
        this.sessions.delete(sessionId)
      }
    }
    if (this.store.size === 0 && !this.fs.exists(this.file)) {
      return
    }
    const file: SessionsFile = {
      version: 1,
      sessions: Object.fromEntries(this.store),
    }
    try {
      this.fs.mkdirp(dirname(this.file))
      const tmp = `${this.file}.obsidian-mem.tmp`
      this.fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`)
      this.fs.rename(tmp, this.file)
    } catch (error: unknown) {
      this.log(`sessions.json write failed (${this.file}): ${String(error)}`)
    }
  }
}
