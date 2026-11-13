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

import { TOOL_MEMORY_AUDIT } from '../../core/lib/index.js'
import type { AuditReport, AuditRequest, AuditView } from '../../service/lib/audit.js'
import type { JsonSchemaNode, MemoryService, ToolDefinition } from './host.js'
import { asRecord, optionalInt, textBlock } from './host.js'

/** Whole-store stat walk plus two live-index reads, capped below the dream. */
export const AUDIT_TIMEOUT_MS = 30_000

/** The description the model sees for `memory_audit`. */
export const AUDIT_DESCRIPTION
  = 'Run a read-only doctor pass over the memory vaults, the indexer state, the vector index, and the global memory budget. Returns every finding as an ISSUE (needs fixing) or INFO line with its remediation, whole-store rollups, a bounded list of note rows (size, read stats, indexed and archive flags), and the global memory budget section. Audit never writes, bumps read stats, or provisions the default vault: a missing store is reported, never created. Run it any time; an over-budget line names the memory_dream compaction order.'

/** Parameter schema; view meanings and the rollup guarantee live on them. */
export const AUDIT_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    view: {
      type: 'string',
      enum: ['full', 'topStale', 'oldestUnread'],
      description: 'Note-row list to show: \'full\' every live and archived note by path; \'topStale\' never-read and least-recently-read notes first; \'oldestUnread\' only never-read notes, oldest on disk first. Defaults to \'full\'. Issue and stat rollups always cover the whole store, whatever the view.',
    },
    limit: {
      type: 'integer',
      description: 'Largest number of note rows to return (1-500). Defaults to 50.',
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

const BUDGET_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['budget_tokens', 'used_tokens', 'measured', 'over_budget', 'global_note_count', 'global_note_paths'],
  properties: {
    budget_tokens: { type: 'integer' },
    used_tokens: { type: 'integer' },
    measured: { type: 'boolean' },
    over_budget: { type: 'boolean' },
    global_note_count: { type: 'integer' },
    global_note_paths: { type: 'array', items: { type: 'string' } },
  },
}

// Nullable report scalars (index offline) stay honest nulls, a closed
// value-or-null union inside the JsonSchemaNode subset.
const nullableNumber: JsonSchemaNode = {
  oneOf: [{ type: 'integer' }, { type: 'null' }],
}
const nullableTime: JsonSchemaNode = {
  oneOf: [{ type: 'string' }, { type: 'null' }],
}
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
        view: { type: 'string', enum: ['full', 'topStale', 'oldestUnread'] },
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
            collection_count: nullableNumber,
            expected_chunks: nullableNumber,
            last_dream_at: nullableTime,
            dreaming_schedules: { type: 'integer' },
          },
        },
        rows: { type: 'array', items: ROW_SCHEMA },
        rows_total: { type: 'integer' },
        budget: BUDGET_SCHEMA,
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
    budget: {
      budget_tokens: number
      used_tokens: number
      measured: boolean
      over_budget: boolean
      global_note_count: number
      global_note_paths: string[]
    }
  }
  | { kind: 'failed', message: string }

const AUDIT_VIEWS: readonly AuditView[] = ['full', 'topStale', 'oldestUnread']

/** Execute one memory_audit call; a store fault comes back as `failed`. */
export async function executeAudit(service: MemoryService, args: unknown): Promise<AuditValue> {
  const raw = asRecord(args)
  const view = optionalView(raw)
  const limit = optionalInt(raw, 'limit')
  const request: AuditRequest = {
    ...(view === undefined ? {} : { view }),
    ...(limit === undefined ? {} : { limit }),
  }
  try {
    const report = await service.audit(request)
    return mapReport(report)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    return ({ kind: 'failed' as const, message: `memory_audit could not complete: ${message}` })
  }
}

function optionalView(args: Record<string, unknown>): AuditView | undefined {
  const value = args.view
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string' || !AUDIT_VIEWS.includes(value as AuditView)) {
    throw new Error(`obsidian-mem tool: "view" must be one of ${AUDIT_VIEWS.join(' | ')}`)
  }
  return value as AuditView
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
    budget: {
      budget_tokens: report.budget.budgetTokens,
      used_tokens: report.budget.usedTokens,
      measured: report.budget.measured,
      over_budget: report.budget.overBudget,
      global_note_count: report.budget.globalNoteCount,
      global_note_paths: [...report.budget.globalNotePaths],
    },
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
    ? `${String(value.budget.used_tokens)} of ${String(value.budget.budget_tokens)} tokens used`
    : `tracker not yet active this process (configured budget ${String(value.budget.budget_tokens)} tokens)`
  lines.push('', `Global memory budget: ${tracker}; ${String(value.budget.global_note_count)} live global notes.`)
  if (value.budget.over_budget) {
    lines.push('OVER BUDGET: run memory_dream to process and compact all global memory markdown files, least-read first:',
      ...value.budget.global_note_paths.map((path) => `- ${path}`))
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
  return {
    name: TOOL_MEMORY_AUDIT,
    description: AUDIT_DESCRIPTION,
    parameters: AUDIT_PARAMETERS,
    output: {
      schema: AUDIT_OUTPUT,
      render: (_args, value) => [textBlock(renderAudit(value as AuditValue))],
    },
    timeoutMs: AUDIT_TIMEOUT_MS,
    execute: async (args) => await executeAudit(service, args),
    presentCall: (args) => {
      const view = (args as { view?: unknown }).view
      return {
        card: 'generic' as const,
        kind: 'read' as const,
        title: `${TOOL_MEMORY_AUDIT} ${typeof view === 'string' ? view : 'full'}`,
        rawInput: args,
      }
    },
  }
}
