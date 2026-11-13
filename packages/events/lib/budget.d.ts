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
import type { SessionRegistry } from './sessions.js';
/**
 * IsGlobalBudgetSpent answers whether the summed recall injections across
 * every session the registry knows have run past the configured budget.
 * Strictly over: usage exactly at the cap still gets fresh recall (the
 * flow flips at cap + 1), matching `GlobalMemoryIndex.overBudget`.
 */
export declare function isGlobalBudgetSpent(registry: SessionRegistry, budgetTokens: number): boolean;
/**
 * CompactionInstruction returns the turn-start injection that replaces the
 * recall sections while the budget is spent: a short pointer naming
 * `memory_dream` (the compactor) and `memory_audit` (the report naming the
 * least-read global notes), mirroring the audit budget.over remediation.
 * The sentence names the window the number is summed over: a successful
 * dream resets the counters (service dream wiring), so usage counts from
 * the last successful dream or host restart.
 */
export declare function compactionInstruction(usedTokens: number, budgetTokens: number): string;
//# sourceMappingURL=budget.d.ts.map
