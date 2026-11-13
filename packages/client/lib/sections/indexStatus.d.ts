/**
 * The Index status section: the seam phase and the Milvus backend (mode,
 * address, version, degradation banner with the host's own error text), the
 * indexer progress counters, the embedder model and vectorDim readout, the
 * configured recall budgets, and the global-memory meter.
 *
 * The meter visualizes the LAST audit pass's budget report (the same
 * globalMemoryIndex numbers the audit's budget lines name): used tokens
 * against `budgets.globalMemoryTokens`, filled red past the budget. Before
 * any audit ran this process it says so instead of drawing an empty bar.
 * @module dsh-plugin-obsidian-mem/client/sections/indexStatus
 */
import type { ReactNode } from 'react';
import type { GlobalBudgetReport } from '../../../service/lib/audit.js';
import type { StatusPayload } from '../api.js';
export interface IndexStatusSectionProps {
    status: StatusPayload | null;
    lastBudget: GlobalBudgetReport | null;
}
export declare function IndexStatusSection(props: IndexStatusSectionProps): ReactNode;
//# sourceMappingURL=indexStatus.d.ts.map
