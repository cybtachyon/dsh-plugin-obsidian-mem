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
 * gate the fire, and a dream-lineage session returns before every one of
 * them (PLAN-dream-isolation TASK-005). The listener never throws (emit
 * dispatch runs it raw) and
 * all work is fire-and-forget: a cold index must not delay the tool-result
 * path, and the one-time provisioning notice is prepended when
 * ensureMemoryAccess returns it.
 * @module dsh-plugin-obsidian-mem/events/readIntercept
 */
import type { HookLogger, MemoryEventsService, ToolResultEvents } from './host.js';
import type { SessionRegistry } from './sessions.js';
/** The harness Read tool's registry name (verified live: `read`). */
export declare const HARNESS_READ_TOOL_NAME = "read";
/** Registration dependencies; the plugin ctx only needs `on`. */
export interface ReadInterceptDeps {
    ctx: ToolResultEvents;
    memory: MemoryEventsService;
    registry: SessionRegistry;
    logger: HookLogger;
    /** Message id factory; defaults to random UUIDs (test seam). */
    newMessageId?: () => string;
}
/** InstallReadIntercept registers the plugin-level `tools/result` observer. */
export declare function installReadIntercept(deps: ReadInterceptDeps): () => void;
export declare function importSnippetFrom(content: readonly {
    readonly type: string;
    readonly text: string;
}[]): string;
/** DirSignalsOf feeds the path's directory names to the wake-signal filter. */
export declare function dirSignalsOf(absPath: string): string[];
/**
 * FileTokensOf derives the deterministic wake tokens of the file being
 * read: the extensionless basename plus its `[-_\s]` parts, the
 * dirSignalsOf segments, and the identifiers and specifier chunks of the
 * import snippet (camel/snake split). Lower-cased, isWakeTerm-filtered,
 * deduped, capped at FILE_TOKENS_MAX. The fallback leg's wake_keywords
 * filter intersects exactly these tokens (TASK-008/010): a stored note
 * sharing no token with the read file never answers the neighborhood.
 */
export declare function fileTokensOf(absPath: string, snippet: string): string[];
//# sourceMappingURL=readIntercept.d.ts.map
