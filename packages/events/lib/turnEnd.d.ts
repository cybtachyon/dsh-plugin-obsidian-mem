/**
 * Turn-end observation (TASK-010). The save/audit reminder steer that used
 * to ride `agent/turn-stopping` is removed: the completion checkpoint now
 * rides the `memory_audit` `checkpoint` view at the agent's own turn end
 * (prepared system prompt), and the steered checklist cost tokens. The
 * memory-tool watch is all that remains at turn end: the plugin-level
 * `tools/result` observer below flags per-turn memory_* usage keyed by the
 * calling agent's session, and that bookkeeping stays observable
 * (recall observation, registry accounting). The over-budget remedy no
 * longer piggybacks on any steer; the audit tool, the card, and the dream
 * surfaces speak it, and the budget accounting itself is untouched.
 * @module dsh-plugin-obsidian-mem/events/turnEnd
 */
import type { HookLogger, ToolResultEvents } from './host.js';
import type { SessionRegistry } from './sessions.js';
/** First user text this long or shorter is trivial unless it carries a work marker. */
export declare const TRIVIAL_TURN_MAX_CHARS = 24;
/** The WORK_MARKER rule: a path, separator, or code tick means real work. */
export declare const WORK_MARKER: RegExp;
/** IsTrivialTurn applies the WORK_MARKER rule: a short greeting is not work. */
export declare function isTrivialTurn(firstUserText: string): boolean;
/** Dependencies of the plugin-ctx memory-tool watcher (mount-owned). */
export interface MemoryToolWatchDeps {
    ctx: ToolResultEvents;
    registry: SessionRegistry;
    logger: HookLogger;
}
/**
 * InstallMemoryToolWatch registers the plugin-level `tools/result` observer
 * that flags per-turn memory_* usage keyed by the calling agent's session:
 * the memory watch that survives the TASK-010 steer removal, feeding recall
 * observation (the task file rejected `tools/post-execute`
 * additionalContexts — a tool-less turn is exactly when the observation
 * matters).
 */
export declare function installMemoryToolWatch(deps: MemoryToolWatchDeps): () => void;
//# sourceMappingURL=turnEnd.d.ts.map
