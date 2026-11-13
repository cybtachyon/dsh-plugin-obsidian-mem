/**
 * The Audit section: the read-only doctor pass (GET /obsidian-mem/audit),
 * the view selector for the bounded note rows, the top issues with ISSUE
 * severity above INFO, and the over-budget callout pointing at Dreaming.
 *
 * The audit runs only when the operator asks (it walks the vaults and probes
 * the collection once). Its budget report doubles as the Index section's
 * global-memory meter, so it travels up through onBudget.
 * @module dsh-plugin-obsidian-mem/client/sections/audit
 */
import type { ReactNode } from 'react';
import type { GlobalBudgetReport } from '../../../service/lib/audit.js';
/** Issues above this many are truncated with a counted tail. */
export declare const AUDIT_ISSUES_SHOWN = 8;
/** Note rows above this many are truncated with a counted tail. */
export declare const AUDIT_ROWS_SHOWN = 10;
export interface AuditSectionProps {
    onBudget: (budget: GlobalBudgetReport) => void;
}
export declare function AuditSection(props: AuditSectionProps): ReactNode;
//# sourceMappingURL=audit.d.ts.map
