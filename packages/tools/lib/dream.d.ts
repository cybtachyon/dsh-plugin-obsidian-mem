/**
 * `memory_dream`: the model-facing face of the service-side dreaming
 * orchestrator (TASK-035). `plan` maps the deterministic
 * {@link DreamPlan} into the closed value; `run` launches the background
 * dream agent and answers as soon as the single-flight guard is armed,
 * attaching the swallowing catch to `done` (the engine logs its own
 * failures; the tool never awaits the run inline). Busy and blocked arrive
 * as `dream_running` / `dream_blocked` kind values, never throws.
 * @module dsh-plugin-obsidian-mem/tools/dream
 */
import type { JsonSchemaNode, MemoryService, ToolDefinition } from './host.js';
import type { BudgetSectionValue } from './toolkit.js';
/** A launched run only waits for the agents gateway; plan is pure math. */
export declare const DREAM_TIMEOUT_MS = 300000;
/**
 * The description the model sees for `memory_dream`. The tool carries the
 * usage timing and the scheduling note itself: there is no system-prompt
 * injection variant for dreaming (task canon).
 */
export declare const DREAM_DESCRIPTION = "Plan or perform memory compaction over the memory vaults. Operation 'plan' (the default) is deterministic analysis with no model call: it returns a ranked candidate list (global notes when the global memory budget is over budget, never-read and unread-since-last-dream notes, near-duplicate clusters, oversized timeline notes), a numbered work plan of concrete memory_read and memory_write steps with file paths, and the global budget math. Operation 'run' launches a dedicated dream agent that carries out such a plan through the memory tools (merges near-duplicates, retires notes with archive=true, appends to the DREAMS.md diary) and returns immediately: the run continues in the background and the next memory_audit shows its findings. Use at the end of significant work or when memory_audit reports the global memory budget over. Automated dreaming can be scheduled: ask the user whether they want a DSH schedule or timer trigger for memory_dream (managed in the Obsidian Mem settings card).";
/** Parameter schema; the default and the run-only rule live on them. */
export declare const DREAM_PARAMETERS: JsonSchemaNode;
/** Closed output union keyed on kind. */
export declare const DREAM_OUTPUT: JsonSchemaNode;
/** The value one memory_dream call returns. */
export type DreamValue = {
    kind: 'plan';
    generated_at: string;
    last_dream_at: string | null;
    prompt: string;
    plan: string;
    candidates: Array<{
        path: string;
        vault_path: string;
        mode: 'shared' | 'read-only';
        reasons: string[];
        read_count: number;
        last_read_at: string;
        size_bytes: number;
    }>;
    clusters: string[][];
    stats: {
        notes: number;
        global_notes: number;
        oversized: number;
        stale_or_unread: number;
        total_bytes: number;
    };
    budget: BudgetSectionValue;
    skipped: string[];
} | {
    kind: 'started';
    run_id: string;
    message: string;
} | {
    kind: 'dream_running';
    message: string;
} | {
    kind: 'dream_blocked';
    message: string;
} | {
    kind: 'failed';
    message: string;
};
/** Execute one memory_dream call; guard rejections become kind values. */
export declare function executeDream(service: MemoryService, args: unknown): Promise<DreamValue>;
/** Model-facing rendering of one memory_dream value. */
export declare function renderDream(value: DreamValue): string;
/** Build the memory_dream definition for one service seam. */
export declare function createDreamTool(service: MemoryService): ToolDefinition;
//# sourceMappingURL=dream.d.ts.map
