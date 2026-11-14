/**
 * `memory_audit`: the model-facing face of the service-side read-only
 * doctor pass (TASK-034). It forwards the bounded {view, limit} request,
 * maps the structured {@link AuditReport} into the closed oneOf value, and
 * renders issues (ISSUE before INFO), rollups, note rows with churn, the
 * per-vault git rollups, and the global memory budget section; the
 * `checkpoint` view appends the completion-checkpoint instructions with
 * the first shared vault filled in. Audit never provisions and never
 * writes: the service engine already quotes and truncates every echoed
 * store path, so the tool adds no further fencing.
 * @module dsh-plugin-obsidian-mem/tools/audit
 */
import type { AuditView } from '../../service/lib/audit.js';
import type { JsonSchemaNode, MemoryService, ToolDefinition } from './host.js';
import type { BudgetSectionValue } from './toolkit.js';
/** Whole-store stat walk plus two live-index reads, capped below the dream. */
export declare const AUDIT_TIMEOUT_MS = 30000;
/** The description the model sees for `memory_audit`. */
export declare const AUDIT_DESCRIPTION = "Run a read-only doctor pass over the memory vaults, the indexer state, the vector index, and the global memory budget. Returns every finding as an ISSUE (needs fixing) or INFO line with its remediation, whole-store rollups, a bounded list of note rows (size, read stats, indexed and archive flags), and the global memory budget section. The report carries per-note git churn and per-shared-vault git rollups; the 'checkpoint' view adds the completion-checkpoint instructions below the note rows. Audit never writes, bumps read stats, or provisions the default vault: a missing store is reported, never created. Run it any time; an over-budget line names the manual compaction order and the heavier memory_dream alternative.";
export declare const AUDIT_CHECKPOINT_PROMPT_SECTION_TEXT = "# Completion Checkpoint\n\nPromote what this session settled, retire what was transient, and write nothing\nwhen nothing qualifies (an empty checkpoint still has to be decided). This is a\njudgment call, not an implicit write step.\n\n1. Do not write anything the repo, git history, code, README, or the project's\n   own instruction file (e.g. AGENTS.md) already records: those are the source of\n   truth. Do not write anything that only matters to the current conversation and\n   will not be needed after a compact, clear, or new thread.\n2. Only add a project status memory note if the project, repo, or a project\n   management skill or tool does not provide status state. Do not accumulate\n   project status memories. Instead, coalesce and rewrite existing notes so that\n   there is a single source of truth note for the project status without\n   duplication. Only carry the few stable pointers needed to resume (branch,\n   issue/PR number, file path). It may record a settled fact (what shipped, when,\n   what was decided) but never current state: record where to read it, not the\n   values.\n3. Before writing a new note, use the `memory_search` tool and see if a note\n   already covers the fact. Settled facts accumulate by update, not by\n   accumulation: use the `memory_read` tool on the existing note and the \n   `memory_write` tool on the same path with the corrected content instead of\n   writing a second, contradicting note.\n4. Save once a fact is settled (a decision made, a bug root-caused, a\n   stated user preference), not mid-speculation. If the note would only\n   restate the current conversation, it is not settled yet.\n5. New memories go in the most related shared vault.\n6. The memory must carry a Why: line and a How to apply: line in the body.\n7. Never store secret values (tokens, passwords, api keys). Store where a\n   secret lives, never the secret itself.\n8. Retire notes by archiving (memory_write with the archive flag), never\n   by deleting files; archived notes stay out of recall.\n9. Evaluate your turn and find instances where existing memories would have\n   assisted you. Check if there were any significant patterns in your language\n   that would indicate a use for the memory then update\n   {{FIRST_SHARED_VAULT}}/.INTENTS.md with those intent(s).\n";
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
        git: Array<{
            vault: string;
            initialized: boolean;
            clean: boolean | null;
            head_hash: string | null;
            error: string | null;
        }>;
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
        /** Share of the recent commit window that touched this note (0..1). */
        churn: number;
    }>;
    rows_total: number;
    budget: BudgetSectionValue;
} | {
    kind: 'failed';
    message: string;
};
/** Execute one memory_audit call; a store fault comes back as `failed`. */
export declare function executeAudit(service: MemoryService, args: unknown): Promise<AuditValue>;
/**
 * FirstSharedVaultPath answers the first registered shared vault's path,
 * falling back to the default vault path (which provisioning registers as
 * shared) when no shared vault is registered. Pure: reads only the vault
 * list handed to it. Mirrors the events turn-end pick; TASK-010 retires
 * that copy.
 */
export declare function firstSharedVaultPath(vaults: readonly {
    path: string;
    mode: string;
}[], homedirValue?: string): string;
/**
 * RenderAudit is the model-facing rendering of one memory_audit value.
 * `vaults` only supplies the first shared vault the `checkpoint` view's
 * appended instructions point at; every other section ignores it.
 */
export declare function renderAudit(value: AuditValue, vaults?: readonly {
    path: string;
    mode: string;
}[]): string;
/** Build the memory_audit definition for one service seam. */
export declare function createAuditTool(service: MemoryService): ToolDefinition;
//# sourceMappingURL=audit.d.ts.map
