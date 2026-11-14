/**
 * The lifecycle hooks for the Obsidian Mem capability: turn-start recall
 * injection through the per-agent channel, the Read-tool intercept, the
 * Think-stream keyword intercept, the memory-tool watch, and the
 * global per-session recall budget that caps what all of them inject.
 *
 * Mount shape (mirrors the tools row): the static `inject` pins the
 * `obsidianMem` seam, and `apply` runs a scoped
 * `ctx.inject(['obsidianMem', 'agents'], …)` so a profile without live
 * agents loads the row inertly. Per AGENTS.md "DSH Event Facts", agent-
 * scoped events (`agent/pre-step`) fire on the AGENT's own context: they
 * are registered from the `agent/created` handler onto `agent.ctx`, each
 * wrapped in one `agent.ctx.effect()` whose disposer is kept here and torn
 * down on `agent/disposed` (and with the plugin fiber). Plugin-ctx
 * listeners for those events never fire. `agent/created` and
 * `agent/disposed` are dispatched through the agent's registry carrier and
 * are observed on the plugin ctx; both handlers contain their errors
 * because `agent/created` is serial and a throwing listener fails creation.
 * @module dsh-plugin-obsidian-mem/events
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ManifestFs } from '../../core/lib/index.js';
import type { LiveAgent, MemoryEventsScope } from './host.js';
import { SessionRegistry } from './sessions.js';
export declare const name = "obsidian-mem-events";
export declare const inject: string[];
/** Test seams for the mount; production calls `apply` without options. */
export interface MountOptions {
    /** Workspace manifest fs the turn-start scan reads; defaults to node fs. */
    manifestFs?: ManifestFs;
    /** Message id factory for injected messages; defaults to random UUIDs. */
    newMessageId?: () => string;
    /** Clock for the session registry's throttle/TTL state; defaults to Date.now. */
    now?: () => number;
}
/**
 * Mount the lifecycle hooks. The scoped inject waits for the memory seam
 * plus the host `agents` service; with both present, the session registry
 * is constructed, wired onto the seam for TASK-045's global budget, and the
 * agent-lifecycle listeners register. The turn-start recall and the
 * Read/Think intercepts join through the same wiring.
 */
export declare function apply(ctx: Context, options?: MountOptions): void;
/**
 * MountLifecycle wires one profile's lifecycle: session registry, seam
 * hookup, and the agent create/dispose pairing whose per-agent
 * `agent.ctx.effect()` carries every agent-scoped listener this row
 * installs (turn-start recall and the Think-stream intercept). Answers the
 * registry (tests assert on it).
 */
export declare function mountLifecycle(scope: MemoryEventsScope, options?: MountOptions): SessionRegistry;
/**
 * IsSubagentAgent reads the subagent signal off the session header: the
 * durable `origin: 'subagent'` classification or a positive delegation
 * depth (verified against the @deepseek-ai/dsh-session SessionHeader
 * types). Sessions are keyed by their own ids regardless, so this feeds
 * bookkeeping only, never keying.
 */
export declare function isSubagentAgent(agent: LiveAgent): boolean;
declare const plugin: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default plugin;
export { READ_INJECTION_CAP_PER_SESSION, READ_INJECTION_THROTTLE_MS, SESSION_TTL_MS, SESSIONS_FILE_NAME, SESSIONS_LRU_MAX, SESSIONS_PERSIST_DEBOUNCE_MS, SessionRegistry, sourceKeyFor, wakeTermsForSource, } from './sessions.js';
export type { InjectedSourceRecord, SessionRecord, SessionRegistryOptions, } from './sessions.js';
export type { EffectDisposer, HookLogger, LiveAgent, MemoryEventsScope, MemoryEventsService, ToolResultEvents, } from './host.js';
export { guidanceLine, installTurnStart, nodeManifestFs } from './turnStart.js';
export type { TurnStartDeps } from './turnStart.js';
export { dirSignalsOf, fileTokensOf, HARNESS_READ_TOOL_NAME, importSnippetFrom, installReadIntercept, } from './readIntercept.js';
export type { ReadInterceptDeps } from './readIntercept.js';
export { extractCompletedThinkBlocks, installThinkIntercept, intentSentencesOf, readRecordedIntentTerms, THINK_QUERY_MAX_CHARS, THINK_SEARCH_TOP_K, THINK_SLEEP_BLOCKS_AFTER_INJECTION, } from './thinkIntercept.js';
export type { ThinkInterceptDeps } from './thinkIntercept.js';
export { installMemoryToolWatch, isTrivialTurn, TRIVIAL_TURN_MAX_CHARS, WORK_MARKER, } from './turnEnd.js';
export type { MemoryToolWatchDeps } from './turnEnd.js';
export { installWriteLedger } from './writeLedger.js';
export type { WriteLedgerDeps } from './writeLedger.js';
//# sourceMappingURL=index.d.ts.map
