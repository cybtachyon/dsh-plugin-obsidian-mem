/**
 * Turn-end save/audit reminder (TASK-044). Rides `agent/turn-stopping`
 * (serial; `this: Scoped<Agent>`, verified against the live cordis 4.1.0
 * Event catalog: "the turn is about to close; a listener that steers keeps
 * the machine re-reading its inbox") registered on the AGENT's own context
 * (AGENTS.md "DSH Event Facts"), and delivers the canonical engramory
 * save/audit checklist via `agent.steer(...)` — steer, never followup: the
 * reminder is for the agent that is about to stop, not a wake of an idle
 * one. A steer keeps the open turn open, so the once-per-turn guard is
 * load-bearing: a per-install fired-turn marker (the per-agent analogue of
 * the task file's `WeakMap<Agent, state>`; it dies with the agent effect)
 * lets exactly one steer per turn and makes an open-turn loop impossible.
 *
 * While the global memory recall budget is spent, the SAME steer also
 * carries the budget section after the checklist: `compactionInstruction`
 * with the registry's summed usage (TASK-003, PLAN-budget-reminder
 * Q-PIGGYBACK full piggyback). The budget section inherits the skips below
 * unchanged: no new gate, no separate steer, no extra once-per-turn state.
 *
 * Skips: subagent sessions (the parent carries the memory duty); turns that
 * already used a memory_* tool (observed via the plugin-ctx `tools/result`
 * listener in installMemoryToolWatch — the agent already knows); trivial
 * turns (first user text of 24 chars or fewer unless it carries a work
 * marker /, \, or backtick); sessions whose first user text never surfaced.
 * The `<FIRST_SHARED_VAULT>` in the verbatim reminder body is interpolated
 * from the live vault registry (first shared vault; the default vault path
 * when none are shared), and the reminder itself never calls
 * ensureMemoryAccess — it is a static text, no provisioning side effect.
 * @module dsh-plugin-obsidian-mem/events/turnEnd
 */
import type { HookLogger, LiveAgent, MemoryEventsService, ToolExecutionMirror, ToolResultMirror } from './host.js';
import type { SessionRegistry } from './sessions.js';
/** First user text this long or shorter is trivial unless it carries a work marker. */
export declare const TRIVIAL_TURN_MAX_CHARS = 24;
/** The WORK_MARKER rule: a path, separator, or code tick means real work. */
export declare const WORK_MARKER: RegExp;
/**
 * TURN_END_REMINDER is the verbatim save/audit checklist (project spec,
 * PLAN TASK-044); `<FIRST_SHARED_VAULT>` is the only hole, filled with the
 * first shared vault's path. Do not reword: tests snapshot it byte-exact.
 */
export declare const TURN_END_REMINDER: string;
/**
 * TurnEndReminder returns the verbatim checklist with `<FIRST_SHARED_VAULT>`
 * replaced by the first shared vault's path, falling back to the default
 * vault path (which provisioning registers as shared) when no shared vault
 * is registered. Pure: reads only the vault list handed to it.
 */
export declare function turnEndReminder(vaults: readonly {
    path: string;
    mode: string;
}[], homedirValue?: string): string;
/** Constructor dependencies; `homedir` is a test seam. */
export interface TurnEndDeps {
    agent: LiveAgent;
    memory: MemoryEventsService;
    registry: SessionRegistry;
    logger: HookLogger;
    /** Home dir for the no-shared-vault default path; defaults to os.homedir. */
    homedir?: () => string;
    /** Message id factory; defaults to random UUIDs (test seam). */
    newMessageId?: () => string;
}
/**
 * InstallTurnEnd registers the per-agent `agent/turn-stopping` observer
 * (called from inside the caller's `agent.ctx.effect()`, per AGENTS.md
 * Event Facts) and answers its disposer. The once-per-turn fired marker is
 * install-scoped state: it dies with the agent effect, exactly like the
 * task file's WeakMap keyed by the agent.
 */
export declare function installTurnEnd(deps: TurnEndDeps): () => void;
/** IsTrivialTurn applies the WORK_MARKER rule from the task file. */
export declare function isTrivialTurn(firstUserText: string): boolean;
/** Dependencies of the plugin-ctx memory-tool watcher (mount-owned). */
export interface MemoryToolWatchDeps {
    ctx: {
        on(name: 'tools/result', listener: (exec: ToolExecutionMirror, result: ToolResultMirror) => undefined): () => boolean;
    };
    registry: SessionRegistry;
    logger: HookLogger;
}
/**
 * InstallMemoryToolWatch registers the plugin-level `tools/result` observer
 * that flags per-turn memory_* usage keyed by the calling agent's session:
 * a turn that already reached for memory needs no reminder (the task file
 * rejected `tools/post-execute` additionalContexts — a tool-less turn is
 * exactly when the reminder matters).
 */
export declare function installMemoryToolWatch(deps: MemoryToolWatchDeps): () => void;
//# sourceMappingURL=turnEnd.d.ts.map
