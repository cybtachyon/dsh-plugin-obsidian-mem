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
import { budgetProtectedOnly } from '../../service/lib/audit.js';
import { describeError } from '../../service/lib/errors.js';
import { textBlock } from './host.js';
// The provisioning notice pair: ensureMemoryAccess answers a notice only
// on the call that triggered provisioning. withNotice attaches it to the
// value in that case and leaves the key absent otherwise (the closed
// output unions accept it as optional); noticeHeader renders it above the
// body. The pair keeps "the notice reads first, exactly once" one
// convention rather than a hand-rolled spread per kind.
/** WithNotice attaches notice to value when set; the key stays absent when not. */
export function withNotice(value, notice) {
    return notice === undefined ? value : { ...value, notice };
}
/** NoticeHeader renders the prepended notice line, or '' when there is none. */
export function noticeHeader(notice) {
    return notice === undefined ? '' : `${notice}\n\n`;
}
// ---------------------------------------------------------------------------
// The failed kind.
/** FailedValue is the `failed` answer for an unexpected service fault: the tool name plus the error message. */
export function failedValue(toolName, error) {
    return { kind: 'failed', message: `${toolName} could not complete: ${describeError(error)}` };
}
// ---------------------------------------------------------------------------
// The global-budget section, identical in the memory_audit and
// memory_dream outputs (the service computes one GlobalBudgetReport).
/** BudgetSectionSchema is the global-memory-budget section of the audit and dream outputs. */
export const BudgetSectionSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['budget_tokens', 'used_tokens', 'measured', 'over_budget', 'global_note_count', 'global_note_paths', 'compactable_global_note_paths', 'protected_only'],
    properties: {
        budget_tokens: { type: 'integer' },
        used_tokens: { type: 'integer' },
        measured: { type: 'boolean' },
        over_budget: { type: 'boolean' },
        global_note_count: { type: 'integer' },
        global_note_paths: { type: 'array', items: { type: 'string' } },
        compactable_global_note_paths: { type: 'array', items: { type: 'string' } },
        protected_only: { type: 'boolean' },
    },
};
/** MapBudgetSection renames the service report's camelCase fields for the model. */
export function mapBudgetSection(budget) {
    return {
        budget_tokens: budget.budgetTokens,
        used_tokens: budget.usedTokens,
        measured: budget.measured,
        over_budget: budget.overBudget,
        global_note_count: budget.globalNoteCount,
        global_note_paths: [...budget.globalNotePaths],
        compactable_global_note_paths: [...budget.compactableGlobalNotePaths],
        protected_only: budgetProtectedOnly(budget),
    };
}
// Nullable report scalars (offline index) stay honest nulls, a closed
// value-or-null union inside the JsonSchemaNode subset.
/** NullableIntegerSchema is the closed integer-or-null union for offline counts. */
export const NullableIntegerSchema = {
    oneOf: [{ type: 'integer' }, { type: 'null' }],
};
/** NullableStringSchema is the closed string-or-null union for offline stamps. */
export const NullableStringSchema = {
    oneOf: [{ type: 'string' }, { type: 'null' }],
};
/**
 * MakePresentCall builds the presentCall every tool answers with: a
 * generic card titled with the tool name plus one argument's string
 * value, falling back to a fixed word when the argument is absent.
 */
export function makePresentCall(card) {
    return (args) => {
        const given = args[card.field];
        const picked = typeof given === 'string' ? given : card.fallback;
        return {
            card: 'generic',
            kind: typeof card.kind === 'function' ? card.kind(picked) : card.kind,
            title: `${card.tool} ${picked}`,
            rawInput: args,
        };
    };
}
/**
 * DefineMemoryTool assembles the verified registration shape every
 * memory_* tool shares: render wraps one text block around render(value),
 * and execute's value passes through unchanged for the host's schema
 * validation. The (value as V) cast lands here once: the host types
 * render's value as the canonical validated JsonValue.
 */
export function defineMemoryTool(spec) {
    return {
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: {
            schema: spec.output,
            render: (_args, value) => [textBlock(spec.render(value))],
        },
        timeoutMs: spec.timeoutMs,
        execute: spec.execute,
        presentCall: spec.presentCall,
    };
}
//# sourceMappingURL=toolkit.js.map
