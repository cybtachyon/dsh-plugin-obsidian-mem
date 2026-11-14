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
import { homedir } from 'node:os';
import { AUDIT_DEFAULT_LIMIT, AUDIT_MAX_LIMIT, defaultVaultPath, firstSharedVault, MANUAL_COMPACTION_APPROVAL, MANUAL_COMPACTION_RECIPE, TOOL_MEMORY_AUDIT, } from '../../core/lib/index.js';
import { AUDIT_VIEWS } from '../../service/lib/audit.js';
import { asRecord, optionalEnum, optionalInt } from './host.js';
import { BudgetSectionSchema, defineMemoryTool, failedValue, makePresentCall, mapBudgetSection, NullableIntegerSchema, NullableStringSchema, } from './toolkit.js';
/** Whole-store stat walk plus two live-index reads, capped below the dream. */
export const AUDIT_TIMEOUT_MS = 30_000;
/** The description the model sees for `memory_audit`. */
export const AUDIT_DESCRIPTION = 'Run a read-only doctor pass over the memory vaults, the indexer state, the vector index, and the global memory budget. Returns every finding as an ISSUE (needs fixing) or INFO line with its remediation, whole-store rollups, a bounded list of note rows (size, read stats, indexed and archive flags), and the global memory budget section. The report carries per-note git churn and per-shared-vault git rollups; the \'checkpoint\' view adds the completion-checkpoint instructions below the note rows. Audit never writes, bumps read stats, or provisions the default vault: a missing store is reported, never created. Run it any time; an over-budget line names the manual compaction order and the heavier memory_dream alternative.';
export const AUDIT_CHECKPOINT_PROMPT_SECTION_TEXT = `# Completion Checkpoint

Promote what this session settled, retire what was transient, and write nothing
when nothing qualifies (an empty checkpoint still has to be decided). This is a
judgment call, not an implicit write step.

1. Do not write anything the repo, git history, code, README, or the project's
   own instruction file (e.g. AGENTS.md) already records: those are the source of
   truth. Do not write anything that only matters to the current conversation and
   will not be needed after a compact, clear, or new thread.
2. Only add a project status memory note if the project, repo, or a project
   management skill or tool does not provide status state. Do not accumulate
   project status memories. Instead, coalesce and rewrite existing notes so that
   there is a single source of truth note for the project status without
   duplication. Only carry the few stable pointers needed to resume (branch,
   issue/PR number, file path). It may record a settled fact (what shipped, when,
   what was decided) but never current state: record where to read it, not the
   values.
3. Before writing a new note, use the \`memory_search\` tool and see if a note
   already covers the fact. Settled facts accumulate by update, not by
   accumulation: use the \`memory_read\` tool on the existing note and the 
   \`memory_write\` tool on the same path with the corrected content instead of
   writing a second, contradicting note.
4. Save once a fact is settled (a decision made, a bug root-caused, a
   stated user preference), not mid-speculation. If the note would only
   restate the current conversation, it is not settled yet.
5. New memories go in the most related shared vault.
6. The memory must carry a Why: line and a How to apply: line in the body.
7. Never store secret values (tokens, passwords, api keys). Store where a
   secret lives, never the secret itself.
8. Retire notes by archiving (memory_write with the archive flag), never
   by deleting files; archived notes stay out of recall.
9. Evaluate your turn and find instances where existing memories would have
   assisted you. Check if there were any significant patterns in your language
   that would indicate a use for the memory then update
   {{FIRST_SHARED_VAULT}}/.INTENTS.md with those intent(s).
`;
/** Parameter schema; view meanings and the rollup guarantee live on them. */
export const AUDIT_PARAMETERS = {
    type: 'object',
    additionalProperties: false,
    properties: {
        view: {
            type: 'string',
            enum: AUDIT_VIEWS,
            description: 'Note-row list to show: \'full\' every live and archived note by path; \'topStale\' never-read and least-recently-read notes first; \'oldestUnread\' only never-read notes, oldest on disk first; \'checkpoint\' same note rows as \'full\', followed by the completion-checkpoint instructions for the agent. Defaults to \'full\'. Issue and stat rollups always cover the whole store, whatever the view.',
        },
        limit: {
            type: 'integer',
            description: `Largest number of note rows to return (1-${String(AUDIT_MAX_LIMIT)}). Defaults to ${String(AUDIT_DEFAULT_LIMIT)}.`,
        },
    },
};
const ISSUE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'severity', 'detail', 'remediation'],
    properties: {
        id: { type: 'string' },
        severity: { type: 'string', enum: ['ISSUE', 'INFO'] },
        detail: { type: 'string' },
        remediation: { type: 'string' },
    },
};
const ROW_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['path', 'size_bytes', 'modified', 'read_count', 'last_read_at', 'archived', 'indexed', 'flagged_not_read', 'oversized', 'churn'],
    properties: {
        path: { type: 'string' },
        size_bytes: { type: 'integer' },
        modified: { type: 'string' },
        read_count: { type: 'integer' },
        last_read_at: { type: 'string' },
        archived: { type: 'boolean' },
        indexed: { type: 'boolean' },
        flagged_not_read: { type: 'boolean' },
        oversized: { type: 'boolean' },
        churn: { type: 'number' },
    },
};
// One shared vault's git rollup (TASK-008): honest nulls wherever the
// git layer could not answer clean, the head hash, or the error.
const GIT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['vault', 'initialized', 'clean', 'head_hash', 'error'],
    properties: {
        vault: { type: 'string' },
        initialized: { type: 'boolean' },
        clean: { oneOf: [{ type: 'boolean' }, { type: 'null' }] },
        head_hash: NullableStringSchema,
        error: NullableStringSchema,
    },
};
// Nullable report scalars (index offline) stay honest nulls, a closed
// value-or-null union inside the JsonSchemaNode subset.
const nullableProgress = {
    oneOf: [
        {
            type: 'object',
            additionalProperties: false,
            required: ['indexed', 'pending', 'errors', 'llm_errors'],
            properties: {
                indexed: { type: 'integer' },
                pending: { type: 'integer' },
                errors: { type: 'integer' },
                llm_errors: { type: 'integer' },
            },
        },
        { type: 'null' },
    ],
};
/** Closed output union keyed on kind. */
export const AUDIT_OUTPUT = {
    oneOf: [
        {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'ok', 'generated_at', 'view', 'limit', 'issues', 'stats', 'rows', 'rows_total', 'budget'],
            properties: {
                kind: { type: 'string', const: 'audit' },
                ok: { type: 'boolean' },
                generated_at: { type: 'string' },
                view: { type: 'string', enum: AUDIT_VIEWS },
                limit: { type: 'integer' },
                issues: { type: 'array', items: ISSUE_SCHEMA },
                stats: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['vault_count', 'shared_vault_count', 'note_count', 'archived_count', 'total_bytes', 'vault_usage', 'oversized_notes', 'huge_not_read_notes', 'malformed_notes', 'indexer', 'collection_count', 'expected_chunks', 'last_dream_at', 'dreaming_schedules', 'git'],
                    properties: {
                        vault_count: { type: 'integer' },
                        shared_vault_count: { type: 'integer' },
                        note_count: { type: 'integer' },
                        archived_count: { type: 'integer' },
                        total_bytes: { type: 'integer' },
                        vault_usage: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['vault', 'notes', 'bytes'],
                                properties: {
                                    vault: { type: 'string' },
                                    notes: { type: 'integer' },
                                    bytes: { type: 'integer' },
                                },
                            },
                        },
                        oversized_notes: { type: 'array', items: { type: 'string' } },
                        huge_not_read_notes: { type: 'array', items: { type: 'string' } },
                        malformed_notes: { type: 'array', items: { type: 'string' } },
                        indexer: nullableProgress,
                        collection_count: NullableIntegerSchema,
                        expected_chunks: NullableIntegerSchema,
                        last_dream_at: NullableStringSchema,
                        dreaming_schedules: { type: 'integer' },
                        git: { type: 'array', items: GIT_SCHEMA },
                    },
                },
                rows: { type: 'array', items: ROW_SCHEMA },
                rows_total: { type: 'integer' },
                budget: BudgetSectionSchema,
            },
        },
        {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'message'],
            properties: {
                kind: { type: 'string', const: 'failed' },
                message: { type: 'string' },
            },
        },
    ],
};
/** Execute one memory_audit call; a store fault comes back as `failed`. */
export async function executeAudit(service, args) {
    const raw = asRecord(args);
    const view = optionalEnum(raw, 'view', AUDIT_VIEWS);
    const limit = optionalInt(raw, 'limit');
    const request = {
        ...(view === undefined ? {} : { view }),
        ...(limit === undefined ? {} : { limit }),
    };
    try {
        const report = await service.audit(request);
        return mapReport(report);
    }
    catch (error) {
        return failedValue(TOOL_MEMORY_AUDIT, error);
    }
}
// Report -> model value: camelCase service fields become snake_case, ms
// stamps become ISO strings, and the indexer progress keeps its honest null
// so an offline index never reads as zero activity.
function mapReport(report) {
    return {
        kind: 'audit',
        ok: report.ok,
        generated_at: new Date(report.generatedAt).toISOString(),
        view: report.view,
        limit: report.limit,
        issues: report.issues.map((entry) => ({ ...entry })),
        stats: {
            vault_count: report.stats.vaultCount,
            shared_vault_count: report.stats.sharedVaultCount,
            note_count: report.stats.noteCount,
            archived_count: report.stats.archivedCount,
            total_bytes: report.stats.totalBytes,
            vault_usage: report.stats.vaultUsage.map((entry) => ({ ...entry })),
            oversized_notes: [...report.stats.oversizedNotes],
            huge_not_read_notes: [...report.stats.hugeNotReadNotes],
            malformed_notes: [...report.stats.malformedNotes],
            indexer: report.stats.indexer === null
                ? null
                : {
                    indexed: report.stats.indexer.indexed,
                    pending: report.stats.indexer.pending,
                    errors: report.stats.indexer.errors,
                    llm_errors: report.stats.indexer.llmErrors,
                },
            collection_count: report.stats.collectionCount,
            expected_chunks: report.stats.expectedChunks,
            last_dream_at: report.stats.lastDreamAt === null ? null : new Date(report.stats.lastDreamAt).toISOString(),
            dreaming_schedules: report.stats.dreamingSchedules,
            git: report.stats.git.map((entry) => ({
                vault: entry.vault,
                initialized: entry.initialized,
                clean: entry.clean,
                head_hash: entry.headHash,
                error: entry.error,
            })),
        },
        rows: report.rows.map((row) => ({
            path: row.path,
            size_bytes: row.sizeBytes,
            modified: new Date(row.mtimeMs).toISOString(),
            read_count: row.readCount,
            last_read_at: row.lastReadAt,
            archived: row.archived,
            indexed: row.indexed,
            flagged_not_read: row.flaggedNotRead,
            oversized: row.oversized,
            churn: row.churn,
        })),
        rows_total: report.totalRows,
        budget: mapBudgetSection(report.budget),
    };
}
/**
 * FirstSharedVaultPath answers the first registered shared vault's path,
 * falling back to the default vault path (which provisioning registers as
 * shared) when no shared vault is registered. Pure: reads only the vault
 * list handed to it, and the pick itself is the one core
 * {@link firstSharedVault} definition.
 */
export function firstSharedVaultPath(vaults, homedirValue = homedir()) {
    return firstSharedVault(vaults)?.path ?? defaultVaultPath(homedirValue);
}
// CheckpointSection fills the prepared instructions' {{FIRST_SHARED_VAULT}}
// hole; the constant itself stays byte-identical (pinned by the TASK-015
// carrier suite).
function checkpointSection(vaults) {
    const vaultPath = firstSharedVaultPath(vaults);
    return AUDIT_CHECKPOINT_PROMPT_SECTION_TEXT.replace('{{FIRST_SHARED_VAULT}}', () => vaultPath);
}
// The rollup prints a head hash at git's default short-form width; the
// full 40 chars add nothing a `git log` at the vault cannot print.
const GIT_HEAD_ABBREV = 7;
/**
 * RenderAudit is the model-facing rendering of one memory_audit value.
 * `vaults` only supplies the first shared vault the `checkpoint` view's
 * appended instructions point at; every other section ignores it.
 */
export function renderAudit(value, vaults = []) {
    if (value.kind === 'failed') {
        return value.message;
    }
    const lines = [
        `memory_audit ${value.ok ? 'found no problems' : 'found problems'} at ${value.generated_at}`
            + ` (${String(value.stats.vault_count)} vaults, ${String(value.stats.shared_vault_count)} shared;`
            + ` ${String(value.stats.note_count)} notes, ${String(value.stats.archived_count)} archived;`
            + ` ${formatBytes(value.stats.total_bytes)} on disk)`,
    ];
    if (value.stats.indexer !== null) {
        const indexer = value.stats.indexer;
        lines.push(`Indexer this process: ${String(indexer.indexed)} indexed, ${String(indexer.pending)} pending, `
            + `${String(indexer.errors)} errors, ${String(indexer.llm_errors)} llm fallbacks.`);
    }
    lines.push('', 'Findings:');
    for (const entry of value.issues) {
        lines.push(`- [${entry.severity}] ${entry.id}: ${entry.detail}${entry.remediation === 'none' ? '' : ` -> ${entry.remediation}`}`);
    }
    if (value.issues.length === 0) {
        lines.push('- none');
    }
    const tracker = value.budget.measured
        ? `${String(value.budget.used_tokens)} of ${String(value.budget.budget_tokens)} tokens used, injected since the last successful dream or host restart`
        : `no recall budget spent since the last successful dream or host restart (configured budget ${String(value.budget.budget_tokens)} tokens)`;
    lines.push('', `Global memory budget: ${tracker}; ${String(value.budget.global_note_count)} live global notes.`);
    if (value.budget.over_budget) {
        if (value.budget.protected_only) {
            lines.push('OVER BUDGET: compaction cannot help: every live global note is a protected vault global file; with the user\'s approval, tighten these files by hand to shrink every session:', ...value.budget.global_note_paths.map((path) => `- ${path}`));
        }
        else {
            lines.push(`OVER BUDGET: as the lighter remedy, compact the global memory only: ${MANUAL_COMPACTION_RECIPE}; ${MANUAL_COMPACTION_APPROVAL}. Also suggest to the user that the much heavier memory_dream is available for a more complete optimization of the whole memory store. Global notes to compact, least-read first:`, ...value.budget.compactable_global_note_paths.map((path) => `- ${path}`));
        }
    }
    lines.push('', `Notes (${value.view}, showing ${String(value.rows.length)} of ${String(value.rows_total)}):`);
    for (const row of value.rows) {
        const flags = [
            row.archived ? 'archived' : '',
            row.indexed ? '' : 'not indexed',
            row.flagged_not_read ? 'too large to read' : '',
            row.oversized ? 'oversized' : '',
        ].filter((flag) => flag !== '').join(', ');
        const read = row.last_read_at === '' ? 'never read' : `read ${row.last_read_at} (${String(row.read_count)}x)`;
        // Token discipline: churn renders only for churned notes.
        const churn = row.churn > 0 ? `, churn ${String(Math.round(row.churn * 100))}%` : '';
        lines.push(`- ${row.path} (${formatBytes(row.size_bytes)}, ${read}${flags === '' ? '' : `, ${flags}`}${churn})`);
    }
    if (value.stats.git.length > 0) {
        lines.push('');
        for (const entry of value.stats.git) {
            const state = entry.error !== null || entry.clean === null ? 'unavailable' : entry.clean ? 'clean' : 'dirty';
            const head = entry.head_hash === null ? '' : ` [head ${entry.head_hash.slice(0, GIT_HEAD_ABBREV)}]`;
            lines.push(`Git (${entry.vault}): ${state}${head}`);
        }
    }
    if (value.view === 'checkpoint') {
        lines.push('', checkpointSection(vaults));
    }
    return lines.join('\n');
}
// Compact byte sizes for the report lines; one decimal below 1 MiB keeps
// note rows to one visual line each.
function formatBytes(bytes) {
    if (bytes < 1024) {
        return `${String(bytes)} B`;
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KiB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
/** Build the memory_audit definition for one service seam. */
export function createAuditTool(service) {
    return defineMemoryTool({
        name: TOOL_MEMORY_AUDIT,
        description: AUDIT_DESCRIPTION,
        parameters: AUDIT_PARAMETERS,
        output: AUDIT_OUTPUT,
        timeoutMs: AUDIT_TIMEOUT_MS,
        execute: async (args) => await executeAudit(service, args),
        render: (value) => renderAudit(value, service.listVaults()),
        presentCall: makePresentCall({ tool: TOOL_MEMORY_AUDIT, kind: 'read', field: 'view', fallback: 'full' }),
    });
}
//# sourceMappingURL=audit.js.map
