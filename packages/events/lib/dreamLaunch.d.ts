/**
 * memory_dream launch observer (TASK-006, PLAN-dream-isolation). Rides the
 * plugin-ctx `tools/result` (emit; the frozen final outcome) and claims
 * the calling session as the launcher of a dream run
 * (`registry.markDreamLaunch`), so the combined recall gate
 * (toolkit.isRecallSuppressed) can suppress that session's recall for
 * exactly the window the orchestrator's guard stays armed. The outcome is
 * read from the structured `result.value` the live emit carries, never by
 * parsing the rendered text: a busy (`dream_running`) or blocked
 * (`dream_blocked`) answer arrives as a structured failure kind with
 * `isError` false (tools/dream.ts maps the guard errors to values, it does
 * not throw), so only the successful-launch shape — `kind: 'started'` with
 * a string `run_id` — claims. `plan` never claims: the launcher gate also
 * requires the parsed `arguments.operation` to be `'run'`.
 * @module dsh-plugin-obsidian-mem/events/dreamLaunch
 */
import type { HookLogger, ToolResultEvents } from './host.js';
import type { SessionRegistry } from './sessions.js';
/** Dependencies of the plugin-ctx dream-launch observer (mount-owned). */
export interface DreamLaunchLedgerDeps {
    ctx: ToolResultEvents;
    registry: SessionRegistry;
    logger: HookLogger;
}
/**
 * InstallDreamLaunchLedger registers the plugin-level `tools/result`
 * observer that claims dream-launch windows, keyed by the calling agent's
 * session (same registration shape as installWriteLedger; mounted from
 * mountLifecycle). Answers the listener disposer.
 */
export declare function installDreamLaunchLedger(deps: DreamLaunchLedgerDeps): () => void;
//# sourceMappingURL=dreamLaunch.d.ts.map
