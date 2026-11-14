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
 * search results carry). Alongside it the ledger records every source the
 * session itself authored (`noteWrittenSource`, keyed by the same
 * {@link sourceKeyFor} identity), so recall flows can exclude memories the
 * session wrote; it is process-wide by session id, so every agent instance
 * of one session shares the ledger. Live records die with `disposeSession` on
 * `agent/disposed`; the persisted ledger at
 * `<dbPath>/state/sessions.json` survives restarts (LRU-capped, TTL-bounded)
 * so a session resumed next week still honors the rule.
 * @module dsh-plugin-obsidian-mem/events/sessions
 */
import type { ServiceFs } from '../../service/lib/index.js';
/** File name for the persisted per-session ledger under the plugin state dir. */
export declare const SESSIONS_FILE_NAME = "sessions.json";
/**
 * SourceKey canonicalizes one memory note's identity for the
 * once-per-session ledger: the (truncated) vault column plus the note's
 * vault-relative source path, exactly as search results carry them, so the
 * turn-start recall and the Read/Think intercepts share one dedupe space.
 */
export declare function sourceKeyFor(result: {
    vault: string;
    source_path: string;
}): string;
/** Ledger sessions older than this (last touch) are dropped at persist time. */
export declare const SESSION_TTL_MS: number;
/** At most this many sessions persist; the least-recently-touched go first. */
export declare const SESSIONS_LRU_MAX = 200;
/** Two Read-intercept injections for one session must sit this far apart. */
export declare const READ_INJECTION_THROTTLE_MS = 15000;
/** Read-intercept injections per session, a cap independent of the Think budget. */
export declare const READ_INJECTION_CAP_PER_SESSION = 6;
/** Default debounce between a ledger mutation and the debounced write. */
export declare const SESSIONS_PERSIST_DEBOUNCE_MS = 1000;
/** IsWakeTerm tests the lower-cased token shape shared by every term source. */
export declare function isWakeTerm(term: string): boolean;
/**
 * WakeTermsForSource returns the deterministic header terms one injected
 * source contributes to the session's Think vocabulary: the file stem (plus
 * its -/_ parts) and the section-header tokens. The true wake_keywords live
 * only in the collection (no live enumeration exists), so these header
 * terms stand in for "wake_keywords of memories injected in this session"
 * (TASK-043 task file).
 */
export declare function wakeTermsForSource(result: {
    source_path: string;
    section_header?: string | null;
}): string[];
/** What one injected source remembers: when, and the content it was injected for. */
export interface InjectedSourceRecord {
    at: number;
    /** Content fingerprint at injection (the result's indexed updated_at). */
    fingerprint?: string;
}
/** The live per-session bookkeeping record. */
export interface SessionRecord {
    readonly sessionId: string;
    /** sourceKey -> what was injected; the once-per-session rule's state. */
    readonly injectedSources: Map<string, InjectedSourceRecord>;
    /**
     * sourceKey -> epoch ms the session authored it (a successful
     * `memory_write`); the recall flows' self-authored exclusion ledger.
     */
    readonly writtenSources: Map<string, number>;
    /** Turn-start recall has fired (per process; re-evaluated on resume). */
    turnStartDone: boolean;
    /** Last pre-step turn number observed; drives per-turn resets. */
    lastTurn: number;
    /**
     * First user-sourced text of the current turn (TASK-044's trivial-turn
     * guard); captured at the pre-step, reset by noteTurn.
     */
    firstUserTextThisTurn: string;
    /** A memory_* tool ran in the current turn (TASK-044's skip guard). */
    memoryToolUsedThisTurn: boolean;
    /** Think-intercept injections used in the current turn (TASK-043 consumes). */
    thinkShots: number;
    /**
     * Approx tokens the turn-start recall has injected this session since
     * {@link SessionRegistry.resetRecallUsage} last zeroed it (TASK-045):
     * "tokens injected since the last successful compaction or process start".
     */
    turnRecallTokensUsed: number;
    /** Read-intercept injections this session (cap enforcement). */
    readInjections: number;
    /** Epoch ms of the last Read-intercept injection (throttle input). */
    lastReadInjectionAt: number;
    /** Directories a Read-intercept injection already covered this session. */
    readonly coveredDirs: Set<string>;
    /** Files already observed by the Read intercept in the current turn. */
    readonly readPathsThisTurn: Set<string>;
    /**
     * Wake terms of memories injected into this session (TASK-043's Think
     * vocabulary: "wake_keywords of memories injected in this session").
     * The indexed wake_keywords never leave the collection, so the intercepts
     * store the deterministic note-header terms (file stem + section header)
     * of every source they inject; the Think intercept unions them with the
     * INTENT_MARKERS and the shared vault's recorded `.INTENTS.md` entries.
     */
    readonly wakeTerms: Set<string>;
    subagent: boolean;
    readonly createdAt: number;
    updatedAt: number;
}
/** Constructor options; only `file` and `thinkShotsPerTurn` are required. */
export interface SessionRegistryOptions {
    /** Absolute path of the persisted ledger (`<stateDir>/sessions.json`). */
    file: string;
    /** Per-turn Think-intercept cap, from the mounted service config. */
    thinkShotsPerTurn: number;
    /** Disk seam; production passes the service's nodeServiceFs. */
    fs?: ServiceFs;
    /** Clock seam for throttle/TTL tests. */
    now?: () => number;
    /** Persisted-session LRU cap; default {@link SESSIONS_LRU_MAX}. */
    maxSessions?: number;
    /** Persisted-session TTL; default {@link SESSION_TTL_MS}. */
    ttlMs?: number;
    /** Persist debounce; 0 persists synchronously on every mutation. */
    debounceMs?: number;
    /** Sink for ledger warnings; absent stays silent. */
    log?: (message: string) => void;
}
/**
 * SessionRegistry owns the once-per-session injection rule, the per-turn
 * Think budget counters, and the Read-intercept throttle state, with the
 * injected-sources ledger persisted (atomically, debounced) so resumed
 * sessions across restarts keep honoring it.
 */
export declare class SessionRegistry {
    private readonly file;
    private thinkShotsPerTurn;
    private readonly fs;
    private readonly now;
    private readonly maxSessions;
    private readonly ttlMs;
    private readonly debounceMs;
    private readonly log;
    /** Live records, keyed by session id; disposed sessions leave. */
    private readonly sessions;
    /**
     * The one-time default-vault notice waiting for its first successful
     * injection (TASK-046 carry-over). A recall flow that fetched the notice
     * from the service and then skipped its injection (offline index, nothing
     * fresh, spent Think shot) retains it here instead of losing it; the next
     * flow that injects anything takes it. Live-only: never persisted, the
     * service re-answers the notice to its own callers after a restart.
     */
    private pendingProvisionNotice;
    /** Persisted mirror; authoritative for what the next write serializes. */
    private readonly store;
    private loaded;
    private closed;
    private timer;
    constructor(options: SessionRegistryOptions);
    /**
     * Ensure returns the live record, hydrating it from the persisted ledger
     * on first sight (a resumed session keeps its injected-sources history).
     */
    ensure(sessionId: string, info?: {
        subagent?: boolean;
    }): SessionRecord;
    /** IsSubagent answers whether the session was created as a subagent child. */
    isSubagent(sessionId: string): boolean;
    /**
     * ShouldInject answers the once-per-session rule: a source the session
     * never saw is eligible; one injected with the same (or unknown) content
     * fingerprint is not; one whose fingerprint changed since injection is
     * eligible again (the note was rewritten and re-indexed).
     */
    shouldInject(sessionId: string, sourceKey: string, fingerprint?: string): boolean;
    /** MarkInjected records the source (and its content fingerprint) and persists. */
    markInjected(sessionId: string, sourceKey: string, fingerprint?: string): void;
    /** InjectedSources snapshots the session's ledger keys (test/audit view). */
    injectedSources(sessionId: string): Map<string, InjectedSourceRecord>;
    /**
     * NoteWrittenSource records one source the session authored (a successful
     * `memory_write`) and persists. `at` overrides the write time (default:
     * the registry clock); later recall flows consult
     * {@link SessionRegistry.wasWrittenIn} and skip what the session itself
     * wrote.
     */
    noteWrittenSource(sessionId: string, sourceKey: string, at?: number): void;
    /** WasWrittenIn answers whether the session already authored this source. */
    wasWrittenIn(sessionId: string, sourceKey: string): boolean;
    /** IsTurnStartDone answers whether turn-start recall already fired. */
    isTurnStartDone(sessionId: string): boolean;
    /** MarkTurnStartDone claims the once-per-session recall slot. */
    markTurnStartDone(sessionId: string): void;
    /**
     * NoteTurn folds one observed pre-step turn into the record: a new turn
     * number resets the per-turn state (Think shots, per-turn Read dedupe,
     * first-user-text, memory-tool-used). When `firstUserText` is supplied
     * and the turn's slot is still empty, it is recorded (the first user
     * message of the turn wins).
     */
    noteTurn(sessionId: string, turn: number, firstUserText?: string): void;
    /** FirstUserText answers the current turn's first user text (TASK-044). */
    firstUserText(sessionId: string): string;
    /** NoteMemoryToolUse flags the current turn as memory-tool-using. */
    noteMemoryToolUse(sessionId: string): void;
    /** MemoryToolUsed answers whether the current turn used a memory_* tool. */
    memoryToolUsed(sessionId: string): boolean;
    /** ThinkBudgetLeft answers the per-turn Think-intercept cap (TASK-043). */
    thinkBudgetLeft(sessionId: string): number;
    /**
     * SetThinkShotsPerTurn rebases the per-turn Think cap without a restart
     * (PLAN-config-pane TASK-004): the card edits budgets.thinkShotsPerTurn
     * and the running service forwards the new value here. Shots already
     * spent in the current turn stay spent, so a lowered cap bites as soon
     * as the spend passes it and a raised cap applies immediately. Garbage
     * input (non-finite) keeps the current cap; negative values clamp to 0.
     */
    setThinkShotsPerTurn(shots: number): void;
    /** ConsumeThinkShot spends one Think shot; false when the turn's cap is spent. */
    consumeThinkShot(sessionId: string): boolean;
    /** AddRecallTokens accumulates injected tokens for TASK-045's global budget. */
    addRecallTokens(sessionId: string, tokens: number): void;
    /** RecallTokensUsed answers what turn-start recall injected this session. */
    recallTokensUsed(sessionId: string): number;
    /** TotalRecallTokensUsed sums every session (the SessionRegistryView slice). */
    totalRecallTokensUsed(): number;
    /**
     * ResetRecallUsage zeroes turnRecallTokensUsed on every live record: a
     * successful dream compaction rebaselines the global budget, so the
     * counter means "tokens injected since the last successful compaction or
     * process start". Touches nothing else (dedupe ledger, throttle state,
     * per-turn counters); the counters are live-only and never persisted, so
     * the reset alone triggers no ledger write.
     */
    resetRecallUsage(): void;
    /**
     * HoldProvisionNotice retains the one-time default-vault notice a recall
     * flow fetched but did not yet deliver, so no injection skip can lose it.
     * A later hold replaces the earlier one (the service answers the notice to
     * one caller per process, so at most one is ever in flight).
     */
    holdProvisionNotice(notice: string): void;
    /**
     * TakeProvisionNotice answers the retained notice and clears the slot, so
     * the delivery is exactly-once across the three recall flows; undefined
     * when nothing waits.
     */
    takeProvisionNotice(): string | undefined;
    /** ReadThrottleActive is true while the last Read injection is < 15 s old. */
    readThrottleActive(sessionId: string): boolean;
    /** ReadCapLeft answers the session's Read-intercept injection cap. */
    readCapLeft(sessionId: string): boolean;
    /** ReadDirCovered answers whether an injection already covered this dir. */
    readDirCovered(sessionId: string, dir: string): boolean;
    /** ReadPathSeen records one file path for the turn and reports the repeat. */
    readPathSeen(sessionId: string, path: string): boolean;
    /** NoteReadInjection spends one Read-intercept slot and records its dir. */
    noteReadInjection(sessionId: string, dir: string): void;
    /**
     * NoteWakeTerms records the header terms of one injected source for
     * TASK-043's Think vocabulary. Session-lifetime: a term stays eligible
     * for later turns' Think blocks (the sources themselves stay injected).
     */
    noteWakeTerms(sessionId: string, terms: readonly string[]): void;
    /** WakeTermsFor snapshots the session's injected-source terms. */
    wakeTermsFor(sessionId: string): ReadonlySet<string>;
    /** DisposeSession drops the live record on agent teardown; the persisted
     * ledger entry stays, so a later resume of the same session id still
     * honors the once-per-session rule. */
    disposeSession(sessionId: string): void;
    /** Flush writes the ledger now, canceling any pending debounce. */
    flush(): void;
    /** Close flushes the ledger and stops scheduling writes. */
    close(): void;
    private ensureLoaded;
    private readFileSafe;
    private touch;
    private schedulePersist;
    private persistNow;
}
//# sourceMappingURL=sessions.d.ts.map
