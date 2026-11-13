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
import { homedir } from 'node:os';
import { defaultVaultPath, MEMORY_TOOL_NAMES, VAULT_MODE_SHARED } from '../../core/lib/index.js';
import { makeNoticeMessage } from './host.js';
import { messageIdFactory, runGuarded } from './toolkit.js';
/** First user text this long or shorter is trivial unless it carries a work marker. */
export const TRIVIAL_TURN_MAX_CHARS = 24;
/** The WORK_MARKER rule: a path, separator, or code tick means real work. */
export const WORK_MARKER = /[/\\`]/;
/**
 * TURN_END_REMINDER is the verbatim save/audit checklist (project spec,
 * PLAN TASK-044); `<FIRST_SHARED_VAULT>` is the only hole, filled with the
 * first shared vault's path. Do not reword: tests snapshot it byte-exact.
 */
export const TURN_END_REMINDER = [
    '1. When you have learned something durable worth knowing in a future session: confirm it isn\'t already in the repo / git / AGENTS.md and isn\'t a secret value. Don\'t duplicate the source of truth.',
    '2. Use the `memory_search` tool and update an existing note rather than duplicate; otherwise write one atomic markdown file (one fact) with the `memory_write` tool.',
    '3. New memories go in the most related shared vault.',
    '4. The memory must carry a Why: line and a How to apply: line in the body.',
    '5. Archive memories that turn out wrong with the `memory_write` tool.',
    '6. Never store secret values, only where they live.',
    '7. Evaluate your turn and find instances where existing memories would have assisted you.',
    'Check if there were any significant patterns in your language that would indicate a use for the memory,',
    'then update <FIRST_SHARED_VAULT>/.INTENTS.md with those intent(s).',
    '8. Run the `memory_audit` tool.',
].join('\n');
/**
 * TurnEndReminder returns the verbatim checklist with `<FIRST_SHARED_VAULT>`
 * replaced by the first shared vault's path, falling back to the default
 * vault path (which provisioning registers as shared) when no shared vault
 * is registered. Pure: reads only the vault list handed to it.
 */
export function turnEndReminder(vaults, homedirValue = homedir()) {
    const shared = vaults.find((vault) => vault.mode === VAULT_MODE_SHARED);
    const vaultPath = shared?.path ?? defaultVaultPath(homedirValue);
    return TURN_END_REMINDER.replace('<FIRST_SHARED_VAULT>', vaultPath);
}
/**
 * InstallTurnEnd registers the per-agent `agent/turn-stopping` observer
 * (called from inside the caller's `agent.ctx.effect()`, per AGENTS.md
 * Event Facts) and answers its disposer. The once-per-turn fired marker is
 * install-scoped state: it dies with the agent effect, exactly like the
 * task file's WeakMap keyed by the agent.
 */
export function installTurnEnd(deps) {
    /** The turn that already received its steer; the anti-loop guard. */
    let firedTurn = null;
    const newId = messageIdFactory(deps);
    const listener = (payload) => {
        // Serial dispatch: a throwing listener must not break the close.
        runGuarded(deps.logger, 'turn-end reminder', () => {
            const turn = typeof payload.turn === 'number' ? payload.turn : -1;
            if (firedTurn === turn) {
                return;
            }
            const agent = payload.agent ?? deps.agent;
            const sessionId = String(agent.id);
            if (!deliverReminder(deps, sessionId)) {
                return;
            }
            // Claim the turn before steering: a steer keeps the turn open and
            // re-fires this listener; anything throwing mid-steer still counts.
            firedTurn = turn;
            const home = deps.homedir ?? homedir;
            agent.steer(makeNoticeMessage(newId(), 'obsidian-mem: turn-end save/audit reminder', [turnEndReminder(deps.memory.listVaults(), home())]));
        });
    };
    const off = deps.agent.ctx.on('agent/turn-stopping', listener);
    return () => { off(); };
}
// Skip gates, in cheap-to-expensive order. False means "stay quiet".
function deliverReminder(deps, sessionId) {
    const registry = deps.registry;
    if (registry.isSubagent(sessionId)) {
        return false;
    }
    if (registry.memoryToolUsed(sessionId)) {
        return false;
    }
    return !isTrivialTurn(registry.firstUserText(sessionId));
}
/** IsTrivialTurn applies the WORK_MARKER rule from the task file. */
export function isTrivialTurn(firstUserText) {
    const text = firstUserText.trim();
    if (text === '') {
        // A turn whose user text never surfaced is not worth the reminder.
        return true;
    }
    return text.length <= TRIVIAL_TURN_MAX_CHARS && !WORK_MARKER.test(text);
}
const MEMORY_TOOL_SET = new Set(MEMORY_TOOL_NAMES);
/**
 * InstallMemoryToolWatch registers the plugin-level `tools/result` observer
 * that flags per-turn memory_* usage keyed by the calling agent's session:
 * a turn that already reached for memory needs no reminder (the task file
 * rejected `tools/post-execute` additionalContexts — a tool-less turn is
 * exactly when the reminder matters).
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
