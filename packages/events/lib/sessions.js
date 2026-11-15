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
import { basename, dirname } from 'node:path';
import { nodeServiceFs } from '../../service/lib/index.js';
/** File name for the persisted per-session ledger under the plugin state dir. */
export const SESSIONS_FILE_NAME = 'sessions.json';
/**
 * SourceKey canonicalizes one memory note's identity for the
 * once-per-session ledger: the (truncated) vault column plus the note's
 * vault-relative source path, exactly as search results carry them, so the
 * turn-start recall and the Read/Think intercepts share one dedupe space.
 */
export function sourceKeyFor(result) {
    return `${result.vault}\u0000${result.source_path}`;
}
/** Ledger sessions older than this (last touch) are dropped at persist time. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many sessions persist; the least-recently-touched go first. */
export const SESSIONS_LRU_MAX = 200;
/** Two Read-intercept injections for one session must sit this far apart. */
export const READ_INJECTION_THROTTLE_MS = 15_000;
/** Read-intercept injections per session, a cap independent of the Think budget. */
export const READ_INJECTION_CAP_PER_SESSION = 6;
/** Default debounce between a ledger mutation and the debounced write. */
export const SESSIONS_PERSIST_DEBOUNCE_MS = 1_000;
/** Wake terms one injected source contributes to the Think vocabulary. */
const SOURCE_TERMS_MAX = 32;
// A wake term is a lower-cased token; the same shape discipline the
// wake_keywords collection column applies, kept local to the ledger.
const TERM_PATTERN = /^[a-z0-9][a-z0-9.+*#-]*$/;
const TERM_MIN_LENGTH = 2;
const TERM_MAX_LENGTH = 64;
/** IsWakeTerm tests the lower-cased token shape shared by every term source. */
export function isWakeTerm(term) {
    return term.length >= TERM_MIN_LENGTH
        && term.length <= TERM_MAX_LENGTH
        && TERM_PATTERN.test(term);
}
/**
 * WakeTermsForSource returns the deterministic header terms one injected
 * source contributes to the session's Think vocabulary: the file stem (plus
 * its -/_ parts) and the section-header tokens. The true wake_keywords live
 * only in the collection (no live enumeration exists), so these header
 * terms stand in for "wake_keywords of memories injected in this session"
 * (TASK-043 task file).
 */
export function wakeTermsForSource(result) {
    const stem = basename(result.source_path).replace(/\.[A-Za-z0-9]+$/, '');
    const terms = new Set();
    const rawTerms = [
        ...stem.split(/[-_\s]+/),
        stem,
        ...(result.section_header ?? '').split(/\s+/),
    ];
    for (const raw of rawTerms) {
        const term = raw.trim().toLowerCase();
        if (term.length >= TERM_MIN_LENGTH && term.length <= TERM_MAX_LENGTH && TERM_PATTERN.test(term)) {
            terms.add(term);
        }
    }
    return [...terms].slice(0, SOURCE_TERMS_MAX);
}
/**
 * SessionRegistry owns the once-per-session injection rule, the per-turn
 * Think budget counters, and the Read-intercept throttle state, with the
 * injected-sources ledger persisted (atomically, debounced) so resumed
 * sessions across restarts keep honoring it.
 */
export class SessionRegistry {
    file;
    // Mutable: the card's live settings apply rebases the cap through
    // setThinkShotsPerTurn (PLAN-config-pane TASK-004); every other field
    // stays constructor-pinned.
    thinkShotsPerTurn;
    fs;
    now;
    maxSessions;
    ttlMs;
    debounceMs;
    log;
    /** Live records, keyed by session id; disposed sessions leave. */
    sessions = new Map();
    /**
     * The one-time default-vault notice waiting for its first successful
     * injection (TASK-046 carry-over). A recall flow that fetched the notice
     * from the service and then skipped its injection (offline index, nothing
     * fresh, spent Think shot) retains it here instead of losing it; the next
     * flow that injects anything takes it. Live-only: never persisted, the
     * service re-answers the notice to its own callers after a restart.
     */
    pendingProvisionNotice = null;
    /** Persisted mirror; authoritative for what the next write serializes. */
    store = new Map();
    loaded = false;
    closed = false;
    timer = null;
    constructor(options) {
        this.file = options.file;
        this.thinkShotsPerTurn = options.thinkShotsPerTurn;
        this.fs = options.fs ?? nodeServiceFs;
        this.now = options.now ?? (() => Date.now());
        this.maxSessions = options.maxSessions ?? SESSIONS_LRU_MAX;
        this.ttlMs = options.ttlMs ?? SESSION_TTL_MS;
        this.debounceMs = options.debounceMs ?? SESSIONS_PERSIST_DEBOUNCE_MS;
        this.log = options.log ?? (() => { });
    }
    /**
     * Ensure returns the live record, hydrating it from the persisted ledger
     * on first sight (a resumed session keeps its injected-sources history).
     * The `subagent` claim is ledger data (touch); the `dreamLineage` claim
     * is live-only, so it never touches or persists.
     */
    ensure(sessionId, info = {}) {
        this.ensureLoaded();
        let record = this.sessions.get(sessionId);
        if (record === undefined) {
            const persisted = this.store.get(sessionId);
            record = {
                sessionId,
                injectedSources: new Map(Object.entries(persisted?.injected ?? {})
                    .filter(([, value]) => typeof value?.at === 'number')
                    .map(([key, value]) => [key, {
                        at: value.at,
                        ...(typeof value.fingerprint === 'string' ? { fingerprint: value.fingerprint } : {}),
                    }])),
                writtenSources: new Map(Object.entries(persisted?.written ?? {})
                    .filter(([, value]) => typeof value === 'number')
                    .map(([key, value]) => [key, value])),
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
                // dreamLineage is live-only: the persisted ledger never carries it,
                // so a hydrated (resumed) session always starts false.
                dreamLineage: false,
                // dreamLaunch is live-only for the same reason.
                dreamLaunch: false,
                createdAt: persisted?.createdAt ?? this.now(),
                updatedAt: persisted?.updatedAt ?? this.now(),
            };
            this.sessions.set(sessionId, record);
        }
        if (info.subagent === true && !record.subagent) {
            record.subagent = true;
            this.touch(record);
        }
        // One-way like subagent, but live-only: no touch, no ledger write.
        if (info.dreamLineage === true && !record.dreamLineage) {
            record.dreamLineage = true;
        }
        return record;
    }
    /** IsSubagent answers whether the session was created as a subagent child. */
    isSubagent(sessionId) {
        return this.ensure(sessionId).subagent;
    }
    /**
     * IsDreamLineage answers whether the session belongs to a dream run's
     * lineage, the suppression gate every recall flow reads.
     */
    isDreamLineage(sessionId) {
        return this.ensure(sessionId).dreamLineage;
    }
    /**
     * MarkDreamLaunch claims the session as the launcher of a dream run
     * (PLAN-dream-isolation TASK-006). Live-only like the `dreamLineage`
     * claim: no touch, no ledger write, because the suppression window ends
     * the moment the orchestrator's guard is no longer armed.
     */
    markDreamLaunch(sessionId) {
        this.ensure(sessionId).dreamLaunch = true;
    }
    /**
     * IsDreamLaunch answers whether the session launched a dream run, read
     * with the seam's live `dreamRunBusy()` flag by the combined recall gate.
     */
    isDreamLaunch(sessionId) {
        return this.ensure(sessionId).dreamLaunch;
    }
    /**
     * ShouldInject answers the once-per-session rule: a source the session
     * never saw is eligible; one injected with the same (or unknown) content
     * fingerprint is not; one whose fingerprint changed since injection is
     * eligible again (the note was rewritten and re-indexed).
     */
    shouldInject(sessionId, sourceKey, fingerprint) {
        const stored = this.ensure(sessionId).injectedSources.get(sourceKey);
        if (stored === undefined) {
            return true;
        }
        return fingerprint !== undefined
            && stored.fingerprint !== undefined
            && stored.fingerprint !== fingerprint;
    }
    /** MarkInjected records the source (and its content fingerprint) and persists. */
    markInjected(sessionId, sourceKey, fingerprint) {
        const record = this.ensure(sessionId);
        record.injectedSources.set(sourceKey, {
            at: this.now(),
            ...(fingerprint === undefined ? {} : { fingerprint }),
        });
        this.touch(record);
        this.schedulePersist();
    }
    /** InjectedSources snapshots the session's ledger keys (test/audit view). */
    injectedSources(sessionId) {
        return new Map(this.ensure(sessionId).injectedSources);
    }
    /**
     * NoteWrittenSource records one source the session authored (a successful
     * `memory_write`) and persists. `at` overrides the write time (default:
     * the registry clock); later recall flows consult
     * {@link SessionRegistry.wasWrittenIn} and skip what the session itself
     * wrote.
     */
    noteWrittenSource(sessionId, sourceKey, at) {
        const record = this.ensure(sessionId);
        record.writtenSources.set(sourceKey, at ?? this.now());
        this.touch(record);
        this.schedulePersist();
    }
    /** WasWrittenIn answers whether the session already authored this source. */
    wasWrittenIn(sessionId, sourceKey) {
        return this.ensure(sessionId).writtenSources.has(sourceKey);
    }
    /** IsTurnStartDone answers whether turn-start recall already fired. */
    isTurnStartDone(sessionId) {
        return this.ensure(sessionId).turnStartDone;
    }
    /** MarkTurnStartDone claims the once-per-session recall slot. */
    markTurnStartDone(sessionId) {
        const record = this.ensure(sessionId);
        record.turnStartDone = true;
        this.touch(record);
    }
    /**
     * NoteTurn folds one observed pre-step turn into the record: a new turn
     * number resets the per-turn state (Think shots, per-turn Read dedupe,
     * first-user-text, memory-tool-used). When `firstUserText` is supplied
     * and the turn's slot is still empty, it is recorded (the first user
     * message of the turn wins).
     */
    noteTurn(sessionId, turn, firstUserText) {
        const record = this.ensure(sessionId);
        if (turn === record.lastTurn) {
            // Same turn: fill the first-user-text slot only if still empty.
            if (firstUserText !== undefined && record.firstUserTextThisTurn === '' && firstUserText !== '') {
                record.firstUserTextThisTurn = firstUserText;
            }
            return;
        }
        record.lastTurn = turn;
        record.thinkShots = 0;
        record.readPathsThisTurn.clear();
        record.firstUserTextThisTurn = firstUserText ?? '';
        record.memoryToolUsedThisTurn = false;
        this.touch(record);
    }
    /** FirstUserText answers the current turn's first user text (TASK-044). */
    firstUserText(sessionId) {
        return this.ensure(sessionId).firstUserTextThisTurn;
    }
    /** NoteMemoryToolUse flags the current turn as memory-tool-using. */
    noteMemoryToolUse(sessionId) {
        const record = this.ensure(sessionId);
        if (record.memoryToolUsedThisTurn) {
            return;
        }
        record.memoryToolUsedThisTurn = true;
        this.touch(record);
    }
    /** MemoryToolUsed answers whether the current turn used a memory_* tool. */
    memoryToolUsed(sessionId) {
        return this.ensure(sessionId).memoryToolUsedThisTurn;
    }
    /** ThinkBudgetLeft answers the per-turn Think-intercept cap (TASK-043). */
    thinkBudgetLeft(sessionId) {
        return Math.max(0, this.thinkShotsPerTurn - this.ensure(sessionId).thinkShots);
    }
    /**
     * SetThinkShotsPerTurn rebases the per-turn Think cap without a restart
     * (PLAN-config-pane TASK-004): the card edits budgets.thinkShotsPerTurn
     * and the running service forwards the new value here. Shots already
     * spent in the current turn stay spent, so a lowered cap bites as soon
     * as the spend passes it and a raised cap applies immediately. Garbage
     * input (non-finite) keeps the current cap; negative values clamp to 0.
     */
    setThinkShotsPerTurn(shots) {
        if (!Number.isFinite(shots)) {
            return;
        }
        this.thinkShotsPerTurn = Math.max(0, Math.trunc(shots));
    }
    /** ConsumeThinkShot spends one Think shot; false when the turn's cap is spent. */
    consumeThinkShot(sessionId) {
        const record = this.ensure(sessionId);
        if (record.thinkShots >= this.thinkShotsPerTurn) {
            return false;
        }
        record.thinkShots += 1;
        this.touch(record);
        return true;
    }
    /** AddRecallTokens accumulates injected tokens for TASK-045's global budget. */
    addRecallTokens(sessionId, tokens) {
        const record = this.ensure(sessionId);
        record.turnRecallTokensUsed += Math.max(0, Math.trunc(tokens));
        this.touch(record);
    }
    /** RecallTokensUsed answers what turn-start recall injected this session. */
    recallTokensUsed(sessionId) {
        return this.ensure(sessionId).turnRecallTokensUsed;
    }
    /** TotalRecallTokensUsed sums every session (the SessionRegistryView slice). */
    totalRecallTokensUsed() {
        this.ensureLoaded();
        let total = 0;
        for (const record of this.sessions.values()) {
            total += record.turnRecallTokensUsed;
        }
        return total;
    }
    /**
     * ResetRecallUsage zeroes turnRecallTokensUsed on every live record: a
     * successful dream compaction rebaselines the global budget, so the
     * counter means "tokens injected since the last successful compaction or
     * process start". Touches nothing else (dedupe ledger, throttle state,
     * per-turn counters); the counters are live-only and never persisted, so
     * the reset alone triggers no ledger write.
     */
    resetRecallUsage() {
        for (const record of this.sessions.values()) {
            record.turnRecallTokensUsed = 0;
        }
    }
    /**
     * HoldProvisionNotice retains the one-time default-vault notice a recall
     * flow fetched but did not yet deliver, so no injection skip can lose it.
     * A later hold replaces the earlier one (the service answers the notice to
     * one caller per process, so at most one is ever in flight).
     */
    holdProvisionNotice(notice) {
        this.pendingProvisionNotice = notice;
    }
    /**
     * TakeProvisionNotice answers the retained notice and clears the slot, so
     * the delivery is exactly-once across the three recall flows; undefined
     * when nothing waits.
     */
    takeProvisionNotice() {
        const notice = this.pendingProvisionNotice;
        this.pendingProvisionNotice = null;
        return notice ?? undefined;
    }
    /** ReadThrottleActive is true while the last Read injection is < 15 s old. */
    readThrottleActive(sessionId) {
        const record = this.ensure(sessionId);
        return record.lastReadInjectionAt > 0
            && this.now() - record.lastReadInjectionAt < READ_INJECTION_THROTTLE_MS;
    }
    /** ReadCapLeft answers the session's Read-intercept injection cap. */
    readCapLeft(sessionId) {
        return this.ensure(sessionId).readInjections < READ_INJECTION_CAP_PER_SESSION;
    }
    /** ReadDirCovered answers whether an injection already covered this dir. */
    readDirCovered(sessionId, dir) {
        return this.ensure(sessionId).coveredDirs.has(dir);
    }
    /** ReadPathSeen records one file path for the turn and reports the repeat. */
    readPathSeen(sessionId, path) {
        const record = this.ensure(sessionId);
        if (record.readPathsThisTurn.has(path)) {
            return true;
        }
        record.readPathsThisTurn.add(path);
        return false;
    }
    /** NoteReadInjection spends one Read-intercept slot and records its dir. */
    noteReadInjection(sessionId, dir) {
        const record = this.ensure(sessionId);
        record.readInjections += 1;
        record.lastReadInjectionAt = this.now();
        record.coveredDirs.add(dir);
        this.touch(record);
    }
    /**
     * NoteWakeTerms records the header terms of one injected source for
     * TASK-043's Think vocabulary. Session-lifetime: a term stays eligible
     * for later turns' Think blocks (the sources themselves stay injected).
     */
    noteWakeTerms(sessionId, terms) {
        if (terms.length === 0) {
            return;
        }
        const record = this.ensure(sessionId);
        for (const term of terms) {
            record.wakeTerms.add(term);
        }
    }
    /** WakeTermsFor snapshots the session's injected-source terms. */
    wakeTermsFor(sessionId) {
        return new Set(this.ensure(sessionId).wakeTerms);
    }
    /** DisposeSession drops the live record on agent teardown; the persisted
     * ledger entry stays, so a later resume of the same session id still
     * honors the once-per-session rule. */
    disposeSession(sessionId) {
        this.sessions.delete(sessionId);
    }
    /** Flush writes the ledger now, canceling any pending debounce. */
    flush() {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.persistNow();
    }
    /** Close flushes the ledger and stops scheduling writes. */
    close() {
        this.flush();
        this.closed = true;
    }
    // Ledger file read once per process; unreadable or corrupt content is
    // logged and treated as empty (self-healing, never a dead plugin).
    ensureLoaded() {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        const raw = this.readFileSafe();
        if (raw === null) {
            return;
        }
        try {
            const parsed = JSON.parse(raw);
            const sessions = parsed.sessions;
            if (typeof sessions !== 'object' || sessions === null) {
                return;
            }
            const cutoff = this.now() - this.ttlMs;
            for (const [sessionId, entry] of Object.entries(sessions)) {
                if (typeof entry?.updatedAt !== 'number' || entry.updatedAt < cutoff) {
                    continue;
                }
                this.store.set(sessionId, {
                    injected: typeof entry.injected === 'object' && entry.injected !== null ? entry.injected : {},
                    written: typeof entry.written === 'object' && entry.written !== null ? entry.written : {},
                    subagent: entry.subagent === true,
                    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : entry.updatedAt,
                    updatedAt: entry.updatedAt,
                });
            }
        }
        catch (error) {
            this.log(`sessions.json unreadable (${this.file}): ${String(error)}; starting empty`);
            this.store.clear();
        }
    }
    readFileSafe() {
        try {
            return this.fs.readFile(this.file);
        }
        catch (error) {
            this.log(`sessions.json read failed (${this.file}): ${String(error)}`);
            return null;
        }
    }
    touch(record) {
        record.updatedAt = this.now();
        this.store.set(record.sessionId, {
            injected: Object.fromEntries(record.injectedSources),
            written: Object.fromEntries(record.writtenSources),
            subagent: record.subagent,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
        });
    }
    schedulePersist() {
        if (this.closed || this.debounceMs < 0) {
            return;
        }
        if (this.debounceMs === 0) {
            this.persistNow();
            return;
        }
        if (this.timer !== null) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.persistNow();
        }, this.debounceMs);
        // The debounced write must never hold the process open.
        this.timer.unref?.();
    }
    // Atomic tmp+rename (the service's vaults.json pattern): a crash mid-write
    // leaves the previous ledger intact. TTL then LRU prune run at write time
    // so the file stays bounded no matter how many sessions touched it.
    persistNow() {
        const cutoff = this.now() - this.ttlMs;
        for (const [sessionId, entry] of this.store) {
            if (entry.updatedAt < cutoff) {
                this.store.delete(sessionId);
                this.sessions.delete(sessionId);
            }
        }
        if (this.store.size > this.maxSessions) {
            const byAge = [...this.store.entries()].sort((a, b) => b[1].updatedAt - a[1].updatedAt);
            for (const [sessionId] of byAge.slice(this.maxSessions)) {
                this.store.delete(sessionId);
                this.sessions.delete(sessionId);
            }
        }
        if (this.store.size === 0 && !this.fs.exists(this.file)) {
            return;
        }
        const file = {
            version: 1,
            sessions: Object.fromEntries(this.store),
        };
        try {
            this.fs.mkdirp(dirname(this.file));
            const tmp = `${this.file}.obsidian-mem.tmp`;
            this.fs.writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`);
            this.fs.rename(tmp, this.file);
        }
        catch (error) {
            this.log(`sessions.json write failed (${this.file}): ${String(error)}`);
        }
    }
}
//# sourceMappingURL=sessions.js.map
