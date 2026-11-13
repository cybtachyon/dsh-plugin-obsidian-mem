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

import {
  AUDIT_DEFAULT_LIMIT,
  AUDIT_MAX_LIMIT,
  MANUAL_COMPACTION_APPROVAL,
  MANUAL_COMPACTION_RECIPE,
  TOOL_MEMORY_AUDIT,
} from '../../core/lib/index.js'
import { AUDIT_VIEWS } from '../../service/lib/audit.js'
import type { AuditReport, AuditRequest, AuditView } from '../../service/lib/audit.js'
import type { JsonSchemaNode, MemoryService, ToolDefinition } from './host.js'
import { asRecord, optionalEnum, optionalInt } from './host.js'
import {
  BudgetSectionSchema,
  defineMemoryTool,
  failedValue,
  makePresentCall,
  mapBudgetSection,
  NullableIntegerSchema,
  NullableStringSchema,
} from './toolkit.js'
import type { BudgetSectionValue } from './toolkit.js'

/** Whole-store stat walk plus two live-index reads, capped below the dream. */
export const AUDIT_TIMEOUT_MS = 30_000

/** The description the model sees for `memory_audit`. */
export const AUDIT_DESCRIPTION
  = 'Run a read-only doctor pass over the memory vaults, the indexer state, the vector index, and the global memory budget. Returns every finding as an ISSUE (needs fixing) or INFO line with its remediation, whole-store rollups, a bounded list of note rows (size, read stats, indexed and archive flags), and the global memory budget section. Audit never writes, bumps read stats, or provisions the default vault: a missing store is reported, never created. Run it any time; an over-budget line names the manual compaction order and the heavier memory_dream alternative.'

/** Parameter schema; view meanings and the rollup guarantee live on them. */
export const AUDIT_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    view: {
      type: 'string',
      enum: AUDIT_VIEWS,
      description: 'Note-row list to show: \'full\' every live and archived note by path; \'topStale\' never-read and least-recently-read notes first; \'oldestUnread\' only never-read notes, oldest on disk first. Defaults to \'full\'. Issue and stat rollups always cover the whole store, whatever the view.',
    },
    limit: {
      type: 'integer',
      description: `Largest number of note rows to return (1-${String(AUDIT_MAX_LIMIT)}). Defaults to ${String(AUDIT_DEFAULT_LIMIT)}.`,
    },
  },
}

const ISSUE_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'severity', 'detail', 'remediation'],
  properties: {
    id: { type: 'string' },
    severity: { type: 'string', enum: ['ISSUE', 'INFO'] },
    detail: { type: 'string' },
    remediation: { type: 'string' },
  },
}

const ROW_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'size_bytes', 'modified', 'read_count', 'last_read_at', 'archived', 'indexed', 'flagged_not_read', 'oversized'],
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
  },
}

// Nullable report scalars (index offline) stay honest nulls, a closed
// value-or-null union inside the JsonSchemaNode subset.
const nullableProgress: JsonSchemaNode = {
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
}

/** Closed output union keyed on kind. */
export const AUDIT_OUTPUT: JsonSchemaNode = {
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
          required: ['vault_count', 'shared_vault_count', 'note_count', 'archived_count', 'total_bytes', 'vault_usage', 'oversized_notes', 'huge_not_read_notes', 'malformed_notes', 'indexer', 'collection_count', 'expected_chunks', 'last_dream_at', 'dreaming_schedules'],
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
}

/** The value one memory_audit call returns. */
export type AuditValue
  = {
    kind: 'audit'
    ok: boolean
    generated_at: string
    view: AuditView
    limit: number
    issues: Array<{ id: string, severity: 'ISSUE' | 'INFO', detail: string, remediation: string }>
    stats: {
      vault_count: number
      shared_vault_count: number
      note_count: number
      archived_count: number
      total_bytes: number
      vault_usage: Array<{ vault: string, notes: number, bytes: number }>
      oversized_notes: string[]
      huge_not_read_notes: string[]
      malformed_notes: string[]
      indexer: { indexed: number, pending: number, errors: number, llm_errors: number } | null
      collection_count: number | null
      expected_chunks: number | null
      last_dream_at: string | null
      dreaming_schedules: number
    }
    rows: Array<{
      path: string
      size_bytes: number
      modified: string
      read_count: number
      last_read_at: string
      archived: boolean
      indexed: boolean
      flagged_not_read: boolean
      oversized: boolean
    }>
    rows_total: number
    budget: BudgetSectionValue
  }
  | { kind: 'failed', message: string }

/** Execute one memory_audit call; a store fault comes back as `failed`. */
export async function executeAudit(service: MemoryService, args: unknown): Promise<AuditValue> {
  const raw = asRecord(args)
  const view = optionalEnum(raw, 'view', AUDIT_VIEWS) as AuditView | undefined
  const limit = optionalInt(raw, 'limit')
  const request: AuditRequest = {
    ...(view === undefined ? {} : { view }),
    ...(limit === undefined ? {} : { limit }),
  }
  try {
    const report = await service.audit(request)
    return mapReport(report)
  } catch (error: unknown) {
    return failedValue(TOOL_MEMORY_AUDIT, error)
  }
}

// Report -> model value: camelCase service fields become snake_case, ms
// stamps become ISO strings, and the indexer progress keeps its honest null
// so an offline index never reads as zero activity.
function mapReport(report: AuditReport): AuditValue {
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
    })),
    rows_total: report.totalRows,
    budget: mapBudgetSection(report.budget),
  }
}

/** Model-facing rendering of one memory_audit value. */
export function renderAudit(value: AuditValue): string {
  if (value.kind === 'failed') {
    return value.message
  }
  const lines: string[] = [
    `memory_audit ${value.ok ? 'found no problems' : 'found problems'} at ${value.generated_at}`
    + ` (${String(value.stats.vault_count)} vaults, ${String(value.stats.shared_vault_count)} shared;`
    + ` ${String(value.stats.note_count)} notes, ${String(value.stats.archived_count)} archived;`
    + ` ${formatBytes(value.stats.total_bytes)} on disk)`,
  ]
  if (value.stats.indexer !== null) {
    const indexer = value.stats.indexer
    lines.push(`Indexer this process: ${String(indexer.indexed)} indexed, ${String(indexer.pending)} pending, `
      + `${String(indexer.errors)} errors, ${String(indexer.llm_errors)} llm fallbacks.`)
  }
  lines.push('', 'Findings:')
  for (const entry of value.issues) {
    lines.push(`- [${entry.severity}] ${entry.id}: ${entry.detail}${entry.remediation === 'none' ? '' : ` -> ${entry.remediation}`}`)
  }
  if (value.issues.length === 0) {
    lines.push('- none')
  }
  const tracker = value.budget.measured
    ? `${String(value.budget.used_tokens)} of ${String(value.budget.budget_tokens)} tokens used, injected since the last successful dream or host restart`
    : `no recall budget spent since the last successful dream or host restart (configured budget ${String(value.budget.budget_tokens)} tokens)`
  lines.push('', `Global memory budget: ${tracker}; ${String(value.budget.global_note_count)} live global notes.`)
  if (value.budget.over_budget) {
    if (value.budget.protected_only) {
      lines.push('OVER BUDGET: compaction cannot help: every live global note is a protected vault global file; with the user\'s approval, tighten these files by hand to shrink every session:',
        ...value.budget.global_note_paths.map((path) => `- ${path}`))
    } else {
      lines.push(`OVER BUDGET: as the lighter remedy, compact the global memory only: ${MANUAL_COMPACTION_RECIPE}; ${MANUAL_COMPACTION_APPROVAL}. Also suggest to the user that the much heavier memory_dream is available for a more complete optimization of the whole memory store. Global notes to compact, least-read first:`,
        ...value.budget.compactable_global_note_paths.map((path) => `- ${path}`))
    }
  }
  lines.push('', `Notes (${value.view}, showing ${String(value.rows.length)} of ${String(value.rows_total)}):`)
  for (const row of value.rows) {
    const flags = [
      row.archived ? 'archived' : '',
      row.indexed ? '' : 'not indexed',
      row.flagged_not_read ? 'too large to read' : '',
      row.oversized ? 'oversized' : '',
    ].filter((flag) => flag !== '').join(', ')
    const read = row.last_read_at === '' ? 'never read' : `read ${row.last_read_at} (${String(row.read_count)}x)`
    lines.push(`- ${row.path} (${formatBytes(row.size_bytes)}, ${read}${flags === '' ? '' : `, ${flags}`})`)
  }
  return lines.join('\n')
}

// Compact byte sizes for the report lines; one decimal below 1 MiB keeps
// note rows to one visual line each.
function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Build the memory_audit definition for one service seam. */
export function createAuditTool(service: MemoryService): ToolDefinition {
  return defineMemoryTool({
    name: TOOL_MEMORY_AUDIT,
    description: AUDIT_DESCRIPTION,
    parameters: AUDIT_PARAMETERS,
    output: AUDIT_OUTPUT,
    timeoutMs: AUDIT_TIMEOUT_MS,
    execute: async (args) => await executeAudit(service, args),
    render: renderAudit,
    presentCall: makePresentCall({ tool: TOOL_MEMORY_AUDIT, kind: 'read', field: 'view', fallback: 'full' }),
  })
}
