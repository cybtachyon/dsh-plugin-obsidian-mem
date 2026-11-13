/**
 * memory_write observer (TASK-002, PLAN-mem-loop-tuning). Rides the
 * plugin-ctx `tools/result` (emit; the frozen final outcome) and mirrors
 * every successful `memory_write` into the session's written-source
 * ledger (TASK-001 `noteWrittenSource`), so the recall flows can exclude
 * memories the session itself authored. The outcome is read from the
 * structured `result.value` the live emit carries
 * (`ToolExecutionSuccess.value: JsonValue`, verified against the
 * installed @deepseek-ai/dsh-tools 0.2.1-alpha.3 types), never by
 * parsing the rendered content text. Only the `written` kind records:
 * the refusal kinds (`read_required`, `stale`, `read_only_vault`,
 * `outside_notes`, `reserved_file`, `invalid_meta`) mean nothing was
 * written, and the key goes through `sourceKeyFor` so one ledger entry
 * matches the identity the recall flows derive from search results.
 * @module dsh-plugin-obsidian-mem/events/writeLedger
 */
import type { HookLogger, ToolResultEvents } from './host.js';
import { type SessionRegistry } from './sessions.js';
/** Dependencies of the plugin-ctx write observer (mount-owned). */
export interface WriteLedgerDeps {
    ctx: ToolResultEvents;
    registry: SessionRegistry;
    logger: HookLogger;
}
/**
 * InstallWriteLedger registers the plugin-level `tools/result` observer
 * that feeds the per-session written-source ledger, keyed by the calling
 * agent's session (same registration shape as installMemoryToolWatch;
 * mounted from mountLifecycle). Answers the listener disposer.
 */
export declare function installWriteLedger(deps: WriteLedgerDeps): () => void;
//# sourceMappingURL=writeLedger.d.ts.map
