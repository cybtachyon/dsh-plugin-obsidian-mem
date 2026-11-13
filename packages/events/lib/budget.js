/**
 * Global memory budget gate (TASK-045). Every recall flow accounts its
 * injected tokens per session (`SessionRegistry.addRecallTokens`); the
 * registry sums them (`totalRecallTokensUsed`), and that one number feeds
 * both decisions made with it: this gate and the service's
 * `globalMemoryIndex()` echo (audit/dream/card read the identical
 * numbers). A session reaching turn-start recall while the summed recall
 * injections sit past `budgets.globalMemoryTokens` gets no fresh recall
 * sections: turnStart injects the compaction pointer naming `memory_dream`
 * instead (the same remedy the audit's `budget.over` line carries, so both
 * channels tell one story) until dreaming compacts the store.
 * @module dsh-plugin-obsidian-mem/events/budget
 */
/**
 * IsGlobalBudgetSpent answers whether the summed recall injections across
 * every session the registry knows have run past the configured budget.
 * Strictly over: usage exactly at the cap still gets fresh recall (the
 * flow flips at cap + 1), matching `GlobalMemoryIndex.overBudget`.
 */
export function isGlobalBudgetSpent(registry, budgetTokens) {
    return registry.totalRecallTokensUsed() > budgetTokens;
}
/**
 * CompactionInstruction returns the turn-start injection that replaces the
 * recall sections while the budget is spent: a short pointer naming
 * `memory_dream` (the compactor) and `memory_audit` (the report naming the
 * least-read global notes), mirroring the audit budget.over remediation.
 */
export function compactionInstruction(usedTokens, budgetTokens) {
    return 'Obsidian Mem: the global memory recall budget is spent '
        + `(${String(usedTokens)} of ${String(budgetTokens)} tokens injected across this process's sessions). `
        + 'No fresh recall sections are injected while it stays over budget. '
        + 'Run the `memory_dream` tool to compact the global memory notes (least-read first), '
        + 'then `memory_audit` to see the budget report.';
}
//# sourceMappingURL=budget.js.map
