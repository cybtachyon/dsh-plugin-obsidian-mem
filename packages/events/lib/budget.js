/**
 * Global memory budget gate (TASK-045). Every recall flow accounts its
 * injected tokens per session (`SessionRegistry.addRecallTokens`); the
 * registry sums them (`totalRecallTokensUsed`), and that one number feeds
 * both decisions made with it: this gate and the service's
 * `globalMemoryIndex()` echo (audit/dream/card read the identical
 * numbers). A session reaching turn-start recall while the summed recall
 * injections sit past `budgets.globalMemoryTokens` gets no fresh recall
 * sections: that suppression gate stays (PLAN-budget-reminder
 * Q-SUPPRESSION), so the turn-start branch only returns early. The
 * over-budget reminder itself rides the turn-end steer next to the
 * save/audit reminder (TASK-003) and carries the two-part remedy: the
 * agent may compact just the global-scope notes by hand with the ordinary
 * memory tools once the user approves, and should suggest the user run
 * the much heavier `memory_dream` for a more complete optimization.
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
 * CompactionInstruction returns the over-budget reminder text carried by
 * the turn-end steer (TASK-003). The framing sentence names the window
 * the number is summed over: a successful dream resets the counters
 * (service dream wiring), so usage counts from the last successful dream
 * or host restart. The remedy is two-part: manual compaction of just the
 * global-scope memory notes with the ordinary memory tools, which the
 * agent must not start until the user approves, plus the instruction to
 * suggest the much heavier `memory_dream` to the user for a more complete
 * optimization of the whole store.
 */
export function compactionInstruction(usedTokens, budgetTokens) {
    return 'Obsidian Mem: the global memory recall budget is spent '
        + `(${String(usedTokens)} of ${String(budgetTokens)} tokens injected since the last successful dream or host restart). `
        + 'No fresh recall sections are injected while it stays over budget. '
        + 'As the lighter remedy, compact the global memory only: survey the global-scope notes with `memory_search`, '
        + 'review them with `memory_read`, then merge or correct with `memory_write` '
        + 'and retire the weakest with `archive: true`, least-read first. '
        + 'Ask the user to approve this manual compaction; do not start until the user approves. '
        + 'Also suggest to the user that the much heavier `memory_dream` tool is available '
        + 'for a more complete optimization of the whole memory store.';
}
//# sourceMappingURL=budget.js.map
