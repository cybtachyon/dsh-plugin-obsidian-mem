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
import { MEMORY_TOOL_NAMES } from '../../core/lib/index.js';
import { runGuarded } from './toolkit.js';
/** First user text this long or shorter is trivial unless it carries a work marker. */
export const TRIVIAL_TURN_MAX_CHARS = 24;
/** The WORK_MARKER rule: a path, separator, or code tick means real work. */
export const WORK_MARKER = /[/\\`]/;
/** IsTrivialTurn applies the WORK_MARKER rule: a short greeting is not work. */
export function isTrivialTurn(firstUserText) {
    const text = firstUserText.trim();
    if (text === '') {
        // A turn whose user text never surfaced is not worth any turn-end action.
        return true;
    }
    return text.length <= TRIVIAL_TURN_MAX_CHARS && !WORK_MARKER.test(text);
}
const MEMORY_TOOL_SET = new Set(MEMORY_TOOL_NAMES);
/**
 * InstallMemoryToolWatch registers the plugin-level `tools/result` observer
 * that flags per-turn memory_* usage keyed by the calling agent's session:
 * the memory watch that survives the TASK-010 steer removal, feeding recall
 * observation (the task file rejected `tools/post-execute`
 * additionalContexts — a tool-less turn is exactly when the observation
 * matters).
 */
export function installMemoryToolWatch(deps) {
    const off = deps.ctx.on('tools/result', (exec, result) => {
        runGuarded(deps.logger, 'memory-tool watch', () => {
            void result;
            if (!MEMORY_TOOL_SET.has(exec.name)) {
                return;
            }
            const agent = exec.agent;
            if (agent === undefined) {
                return;
            }
            deps.registry.noteMemoryToolUse(String(agent.id));
        });
        return undefined;
    });
    return () => { off(); };
}
//# sourceMappingURL=turnEnd.js.map
