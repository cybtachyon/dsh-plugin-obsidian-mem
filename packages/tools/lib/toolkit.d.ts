/**
 * Toolkit: the plumbing every memory_* tool assembles the same way, kept
 * in one home instead of five copies: the one-time provisioning notice's
 * value/render pair, the shared global-budget section (schema, value
 * shape, mapper), the nullable report scalars, the `failed` value
 * builder, the generic-card presentCall factory, and the closed
 * definition assembly. The registration shape these produce is the one
 * verified against the installed @deepseek-ai/cordis 4.1.0 tools seam
 * (host.ts mirrors it); only the assembly is shared here.
 * @module dsh-plugin-obsidian-mem/tools/toolkit
 */
import type { GlobalBudgetReport } from '../../service/lib/audit.js';
import type { GenericCallView, JsonSchemaNode, ToolDefinition } from './host.js';
/** WithNotice attaches notice to value when set; the key stays absent when not. */
export declare function withNotice<T extends object>(value: T, notice: string | undefined): T & {
    notice?: string;
};
/** NoticeHeader renders the prepended notice line, or '' when there is none. */
export declare function noticeHeader(notice: string | undefined): string;
/** FailedValue is the `failed` answer for an unexpected service fault: the tool name plus the error message. */
export declare function failedValue(toolName: string, error: unknown): {
    kind: 'failed';
    message: string;
};
/** BudgetSectionSchema is the global-memory-budget section of the audit and dream outputs. */
export declare const BudgetSectionSchema: JsonSchemaNode;
/** BudgetSectionValue is the model-facing (snake_case) view of the service's budget report. */
export interface BudgetSectionValue {
    budget_tokens: number;
    used_tokens: number;
    measured: boolean;
    over_budget: boolean;
    global_note_count: number;
    global_note_paths: string[];
    /** Global notes a dream may compact: vault globalFile protected files dropped (TASK-015). */
    compactable_global_note_paths: string[];
    /** True when EVERY live global note is protected: compaction cannot help. */
    protected_only: boolean;
}
/** MapBudgetSection renames the service report's camelCase fields for the model. */
export declare function mapBudgetSection(budget: GlobalBudgetReport): BudgetSectionValue;
/** NullableIntegerSchema is the closed integer-or-null union for offline counts. */
export declare const NullableIntegerSchema: JsonSchemaNode;
/** NullableStringSchema is the closed string-or-null union for offline stamps. */
export declare const NullableStringSchema: JsonSchemaNode;
/** PresentCardKind is the generic card's kind, or it picks from the title argument. */
export type PresentCardKind = NonNullable<GenericCallView['kind']> | ((picked: string) => NonNullable<GenericCallView['kind']>);
/**
 * MakePresentCall builds the presentCall every tool answers with: a
 * generic card titled with the tool name plus one argument's string
 * value, falling back to a fixed word when the argument is absent.
 */
export declare function makePresentCall(card: {
    /** Tool name constant opening the card title. */
    tool: string;
    /** Card kind; a function sees the picked title argument. */
    kind: PresentCardKind;
    /** Argument whose string value completes the title. */
    field: string;
    /** Title word when the argument is missing or not a string. */
    fallback: string;
}): (args: unknown) => GenericCallView;
/** MemoryToolSpec is one tool's per-tool parts; the assembly is shared. */
export interface MemoryToolSpec<V> {
    name: string;
    description: string;
    parameters: JsonSchemaNode;
    /** Closed oneOf output schema keyed on kind. */
    output: JsonSchemaNode;
    timeoutMs: number;
    execute(args: unknown): Promise<V>;
    render(value: V): string;
    presentCall: (args: unknown) => GenericCallView;
}
/**
 * DefineMemoryTool assembles the verified registration shape every
 * memory_* tool shares: render wraps one text block around render(value),
 * and execute's value passes through unchanged for the host's schema
 * validation. The (value as V) cast lands here once: the host types
 * render's value as the canonical validated JsonValue.
 */
export declare function defineMemoryTool<V>(spec: MemoryToolSpec<V>): ToolDefinition;
//# sourceMappingURL=toolkit.d.ts.map
