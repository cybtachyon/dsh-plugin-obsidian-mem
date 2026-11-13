/**
 * `memory_audit`: the model-facing face of the service-side read-only
 * doctor pass (TASK-034). It forwards the bounded {view, limit} request,
 * maps the structured {@link AuditReport} into the closed oneOf value, and
 * renders issues (ISSUE before INFO), rollups, note rows, and the global
 * memory budget section. Audit never provisions and never writes; the
 * service engine already quotes and truncates every echoed store path, so
 * the tool adds no further fencing.
 * @module dsh-plugin-obsidian-mem/tools/audit
 */
import type { AuditView } from '../../service/lib/audit.js';
import type { JsonSchemaNode, MemoryService, ToolDefinition } from './host.js';
import type { BudgetSectionValue } from './toolkit.js';
/** Whole-store stat walk plus two live-index reads, capped below the dream. */
export declare const AUDIT_TIMEOUT_MS = 30000;
/** The description the model sees for `memory_audit`. */
export declare const AUDIT_DESCRIPTION = "Run a read-only doctor pass over the memory vaults, the indexer state, the vector index, and the global memory budget. Returns every finding as an ISSUE (needs fixing) or INFO line with its remediation, whole-store rollups, a bounded list of note rows (size, read stats, indexed and archive flags), and the global memory budget section. Audit never writes, bumps read stats, or provisions the default vault: a missing store is reported, never created. Run it any time; an over-budget line names the memory_dream compaction order.";
/** Parameter schema; view meanings and the rollup guarantee live on them. */
export declare const AUDIT_PARAMETERS: JsonSchemaNode;
/** Closed output union keyed on kind. */
export declare const AUDIT_OUTPUT: JsonSchemaNode;
/** The value one memory_audit call returns. */
export type AuditValue = {
    kind: 'audit';
    ok: boolean;
    generated_at: string;
    view: AuditView;
    limit: number;
    issues: Array<{
        id: string;
        severity: 'ISSUE' | 'INFO';
        detail: string;
        remediation: string;
    }>;
    stats: {
        vault_count: number;
        shared_vault_count: number;
        note_count: number;
        archived_count: number;
        total_bytes: number;
        vault_usage: Array<{
            vault: string;
            notes: number;
            bytes: number;
        }>;
        oversized_notes: string[];
        huge_not_read_notes: string[];
        malformed_notes: string[];
        indexer: {
            indexed: number;
            pending: number;
            errors: number;
            llm_errors: number;
        } | null;
        collection_count: number | null;
        expected_chunks: number | null;
        last_dream_at: string | null;
        dreaming_schedules: number;
    };
    rows: Array<{
        path: string;
        size_bytes: number;
        modified: string;
        read_count: number;
        last_read_at: string;
        archived: boolean;
        indexed: boolean;
        flagged_not_read: boolean;
        oversized: boolean;
    }>;
    rows_total: number;
    budget: BudgetSectionValue;
} | {
    kind: 'failed';
    message: string;
};
/** Execute one memory_audit call; a store fault comes back as `failed`. */
export declare function executeAudit(service: MemoryService, args: unknown): Promise<AuditValue>;
/** Model-facing rendering of one memory_audit value. */
export declare function renderAudit(value: AuditValue): string;
/** Build the memory_audit definition for one service seam. */
export declare function createAuditTool(service: MemoryService): ToolDefinition;
//# sourceMappingURL=audit.d.ts.map
