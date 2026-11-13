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
 * with only the sentences of the block that carry a matched term (capped)
 * as the query and the matched terms as
 * `wakeKeywords` (top 2), the once-per-session source filter (shared in
 * toolkit.ts, where a session never gets back what it itself wrote, no
 * matter which agent instance of that session wrote it), the per-turn
 * `budgets.thinkShotsPerTurn` gate via the registry counter, and
 * `wrapRecalled` envelopes through `agent.inject()` (never `steer`, never
 * wakes). A successful injection then sleeps: the NEXT completed think
 * block is consumed unprocessed (`THINK_SLEEP_BLOCKS_AFTER_INJECTION`),
 * giving the agent room to absorb what arrived before another recall wave;
 * normal scanning resumes after that block. The listener never throws and
 * all work is fire-and-forget: a cold
 * or dead index degrades to a warning, never a stalled stream.
 * @module dsh-plugin-obsidian-mem/events/thinkIntercept
 */
import type { HookLogger, LiveAgent, MemoryEventsService } from './host.js';
import type { SessionRegistry } from './sessions.js';
/** Completed-block search top K (task file: topK=2). */
export declare const THINK_SEARCH_TOP_K = 2;
/** Query cap: the block text enters the hybrid search capped at 500 chars. */
export declare const THINK_QUERY_MAX_CHARS = 500;
/** Completed think blocks consumed unprocessed after a successful injection. */
export declare const THINK_SLEEP_BLOCKS_AFTER_INJECTION = 1;
/** Read seam for the shared vault's `.INTENTS.md`; null means unreadable. */
export interface IntentsFs {
    readFile(path: string): string | null;
}
/** Constructor dependencies; `intentsFs` and `newMessageId` are test seams. */
export interface ThinkInterceptDeps {
    agent: LiveAgent;
    memory: MemoryEventsService;
    registry: SessionRegistry;
    logger: HookLogger;
    /** `.INTENTS.md` read seam; defaults to node fs. */
    intentsFs?: IntentsFs;
    /** Message id factory; defaults to random UUIDs (test seam). */
    newMessageId?: () => string;
}
/**
 * InstallThinkIntercept registers the per-agent `agent/assistant-stream`
 * observer (called from inside the caller's `agent.ctx.effect()`, per
 * AGENTS.md Event Facts) and answers its disposer, which also drops the
 * per-attempt buffers (the agent/disposed path tears the whole effect down).
 */
export declare function installThinkIntercept(deps: ThinkInterceptDeps): () => void;
/**
 * ExtractCompletedThinkBlocks returns every `<think>…</think>` block closed
 * at or after `from`, plus the cursor to resume the next scan from: the
 * cursor lands after the last consumed close tag, or on an unclosed opener
 * (rescanned as deltas arrive, so a tag split across deltas still completes
 * and half blocks never inject). Blocks match exactly once.
 */
export declare function extractCompletedThinkBlocks(text: string, from: number): {
    blocks: string[];
    next: number;
};
export declare function intentSentencesOf(blockText: string, matchedTerms: readonly string[]): string;
export declare function readRecordedIntentTerms(memory: MemoryEventsService, intentsFs: IntentsFs | undefined): string[];
//# sourceMappingURL=thinkIntercept.d.ts.map
