/**
 * Global memory budget gate and remedy fragments shared by every surface
 * that reports a spent global recall budget (TASK-008 refactor review,
 * PLAN-budget-reminder Q-WORDING-SCOPE). The predicate is the ONE "strictly
 * over" comparison: the turn-start suppression gate, the turn-end budget
 * section, the service's `globalMemoryIndex`, and the audit budget report
 * all read it. The fragments carry the lighter half of the two-part remedy
 * (manual compaction of the global notes, gated on the user's approval) so
 * the audit remediation, the dream plan text, and the two tool renderers
 * compose the same instruction verbatim; each surface keeps its own opener
 * and its own naming of the heavier alternative (`memory_dream` versus
 * executing the presented plan), which is deliberate per-surface phrasing.
 * @module dsh-plugin-obsidian-mem/core/budget
 */
/**
 * IsOverGlobalBudget answers whether summed recall usage has run strictly
 * past the configured budget: usage exactly at the cap is not over (the
 * flip happens at cap + 1). Every over-budget decision reads this one
 * comparison.
 */
export declare function isOverGlobalBudget(usedTokens: number, budgetTokens: number): boolean;
/**
 * MANUAL_COMPACTION_RECIPE is the four-step manual pass every over-budget
 * surface prescribes: survey, review, merge or correct, retire. Composed
 * verbatim into the audit remediation, the dream plan text, and both tool
 * renderers. Do not reword: the specs snapshot the rendered lines.
 */
export declare const MANUAL_COMPACTION_RECIPE = "survey with memory_search, review with memory_read, merge or correct with memory_write, retire the weakest with archive: true";
/**
 * MANUAL_COMPACTION_APPROVAL gates the manual pass on the user's go-ahead:
 * the agent proposes the compaction and waits. Do not reword: the specs
 * snapshot the rendered lines.
 */
export declare const MANUAL_COMPACTION_APPROVAL = "ask the user to approve this manual compaction and do not start until the user approves";
/**
 * DREAM_RUN_SUGGESTION is the heavier alternative both dream surfaces (the
 * dream plan text and the memory_dream render) append after the manual
 * recipe: executing the presented plan is the whole-store optimization. Do
 * not reword: the specs snapshot the rendered lines.
 */
export declare const DREAM_RUN_SUGGESTION = "Also suggest to the user that executing this plan via operation run is the much heavier, more complete optimization of the whole memory store.";
//# sourceMappingURL=budget.d.ts.map
