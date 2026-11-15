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
import { TOOL_MEMORY_DREAM } from '../../core/lib/index.js';
import { asRecord, runGuarded } from './toolkit.js';
/**
 * InstallDreamLaunchLedger registers the plugin-level `tools/result`
 * observer that claims dream-launch windows, keyed by the calling agent's
 * session (same registration shape as installWriteLedger; mounted from
 * mountLifecycle). Answers the listener disposer.
 */
export function installDreamLaunchLedger(deps) {
    const off = deps.ctx.on('tools/result', (exec, result) => {
        // Emit dispatch runs listeners raw; nothing may escape this one.
        runGuarded(deps.logger, 'dream-launch observer', () => {
            if (exec.name !== TOOL_MEMORY_DREAM || result.isError) {
                return;
            }
            const agent = exec.agent;
            if (agent === undefined) {
                return;
            }
            const args = asRecord(exec.arguments);
            if (args === null || args['operation'] !== 'run') {
                return;
            }
            // The launched-run shape is the ONLY claim trigger: guard answers
            // (dream_running, dream_blocked, failed) and plan values launch
            // nothing, so they must not open a window.
            const value = asRecord(result.value);
            if (value === null || value['kind'] !== 'started' || typeof value['run_id'] !== 'string') {
                return;
            }
            deps.registry.markDreamLaunch(String(agent.id));
        });
        return undefined;
    });
    return () => { off(); };
}
//# sourceMappingURL=dreamLaunch.js.map
