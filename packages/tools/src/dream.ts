/**
 * `memory_dream`: the model-facing face of the service-side dreaming
 * orchestrator (TASK-035). `plan` maps the deterministic
 * {@link DreamPlan} into the closed value; `run` launches the background
 * dream agent and answers as soon as the single-flight guard is armed,
 * attaching the swallowing catch to `done` (the engine logs its own
 * failures; the tool never awaits the run inline). Busy and blocked arrive
 * as `dream_running` / `dream_blocked` kind values, never throws.
 * @module dsh-plugin-obsidian-mem/tools/dream
 */

import { TOOL_MEMORY_DREAM } from '../../core/lib/index.js'
import { DreamBlockedError, DreamBusyError } from '../../service/lib/dream.js'
import type { DreamEngineResult, DreamPlan, DreamRequest } from '../../service/lib/dream.js'
import type { JsonSchemaNode, MemoryService, ToolDefinition } from './host.js'
import { asRecord, optionalEnum, optionalString } from './host.js'
import {
  BudgetSectionSchema,
  defineMemoryTool,
  failedValue,
  makePresentCall,
  mapBudgetSection,
  NullableStringSchema,
} from './toolkit.js'
import type { BudgetSectionValue } from './toolkit.js'

/** A launched run only waits for the agents gateway; plan is pure math. */
export const DREAM_TIMEOUT_MS = 300_000

/**
 * The description the model sees for `memory_dream`. The tool carries the
 * usage timing and the scheduling note itself: there is no system-prompt
 * injection variant for dreaming (task canon).
 */
export const DREAM_DESCRIPTION
  = 'Plan or perform memory compaction over the memory vaults. Operation \'plan\' (the default) is deterministic analysis with no model call: it returns a ranked candidate list (global notes when the global memory budget is over budget, never-read and unread-since-last-dream notes, near-duplicate clusters, oversized timeline notes), a numbered work plan of concrete memory_read and memory_write steps with file paths, and the global budget math. Operation \'run\' launches a dedicated dream agent that carries out such a plan through the memory tools (merges near-duplicates, retires notes with archive=true, appends to the DREAMS.md diary) and returns immediately: the run continues in the background and the next memory_audit shows its findings. Use at the end of significant work or when memory_audit reports the global memory budget over. Automated dreaming can be scheduled: ask the user whether they want a DSH schedule or timer trigger for memory_dream (managed in the Obsidian Mem settings card).'

/** Parameter schema; the default and the run-only rule live on them. */
export const DREAM_PARAMETERS: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operation: {
      type: 'string',
      enum: ['plan', 'run'],
      description: '\'plan\' returns the deterministic work plan without a model call (default); \'run\' launches the background dream agent to carry out that plan. Only one run can be in flight at a time.',
    },
    model: {
      type: 'string',
      description: 'For \'run\' only: model id override for the dream agent, replacing the session default model for this run. Ignored by \'plan\'.',
    },
  },
}

const CANDIDATE_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'vault_path', 'mode', 'reasons', 'read_count', 'last_read_at', 'size_bytes'],
  properties: {
    path: { type: 'string' },
    vault_path: { type: 'string' },
    mode: { type: 'string', enum: ['shared', 'read-only'] },
    reasons: { type: 'array', items: { type: 'string' } },
    read_count: { type: 'integer' },
    last_read_at: { type: 'string' },
    size_bytes: { type: 'integer' },
  },
}

/** Closed output union keyed on kind. */
export const DREAM_OUTPUT: JsonSchemaNode = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'generated_at', 'last_dream_at', 'prompt', 'plan', 'candidates', 'clusters', 'stats', 'budget', 'skipped'],
      properties: {
        kind: { type: 'string', const: 'plan' },
        generated_at: { type: 'string' },
        last_dream_at: NullableStringSchema,
        prompt: { type: 'string' },
        plan: { type: 'string' },
        candidates: { type: 'array', items: CANDIDATE_SCHEMA },
        clusters: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        stats: {
          type: 'object',
          additionalProperties: false,
          required: ['notes', 'global_notes', 'oversized', 'stale_or_unread', 'total_bytes'],
          properties: {
            notes: { type: 'integer' },
            global_notes: { type: 'integer' },
            oversized: { type: 'integer' },
            stale_or_unread: { type: 'integer' },
            total_bytes: { type: 'integer' },
          },
        },
        budget: BudgetSectionSchema,
        skipped: { type: 'array', items: { type: 'string' } },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'run_id', 'message'],
      properties: {
        kind: { type: 'string', const: 'started' },
        run_id: { type: 'string' },
        message: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'message'],
      properties: {
        kind: { type: 'string', const: 'dream_running' },
        message: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'message'],
      properties: {
        kind: { type: 'string', const: 'dream_blocked' },
        message: { type: 'string' },
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

/** The value one memory_dream call returns. */
export type DreamValue
  = {
    kind: 'plan'
    generated_at: string
    last_dream_at: string | null
    prompt: string
    plan: string
    candidates: Array<{
      path: string
      vault_path: string
      mode: 'shared' | 'read-only'
      reasons: string[]
      read_count: number
      last_read_at: string
      size_bytes: number
    }>
    clusters: string[][]
    stats: { notes: number, global_notes: number, oversized: number, stale_or_unread: number, total_bytes: number }
    budget: BudgetSectionValue
    skipped: string[]
  }
  | { kind: 'started', run_id: string, message: string }
  | { kind: 'dream_running', message: string }
  | { kind: 'dream_blocked', message: string }
  | { kind: 'failed', message: string }

const DREAM_OPERATIONS = ['plan', 'run'] as const

/** Execute one memory_dream call; guard rejections become kind values. */
export async function executeDream(service: MemoryService, args: unknown): Promise<DreamValue> {
  const raw = asRecord(args)
  const operation = optionalEnum(raw, 'operation', DREAM_OPERATIONS) as DreamRequest['operation']
  const model = optionalString(raw, 'model')
  const request: DreamRequest = {
    ...(operation === undefined ? {} : { operation }),
    ...(model === undefined ? {} : { model }),
  }
  try {
    const result = await service.dream(request)
    return mapResult(result)
  } catch (error: unknown) {
    if (error instanceof DreamBusyError) {
      return { kind: 'dream_running', message: error.message }
    }
    if (error instanceof DreamBlockedError) {
      return { kind: 'dream_blocked', message: error.message }
    }
    return failedValue(TOOL_MEMORY_DREAM, error)
  }
}

function mapResult(result: DreamEngineResult): DreamValue {
  if (result.operation === 'plan') {
    return mapPlan(result.plan)
  }
  // The run continues without this call: the engine logs its own failures,
  // and an unwatched rejection of `done` would surface as a host-level
  // unhandled rejection. Attach the swallow, keep the summary for nothing.
  result.done.then(
    () => undefined,
    () => undefined,
  )
  return {
    kind: 'started',
    run_id: result.id,
    message: 'the dream agent is running in the background; its steps land in the DREAMS.md diary and its findings in the next memory_audit',
  }
}

// Plan -> model value: camelCase becomes snake_case and ms stamps become
// ISO strings, matching the memory_audit value conventions.
function mapPlan(plan: DreamPlan): DreamValue {
  return {
    kind: 'plan',
    generated_at: new Date(plan.generatedAt).toISOString(),
    last_dream_at: plan.lastDreamAt === null ? null : new Date(plan.lastDreamAt).toISOString(),
    prompt: plan.prompt,
    plan: plan.plan,
    candidates: plan.candidates.map((candidate) => ({
      path: candidate.path,
      vault_path: candidate.vaultPath,
      mode: candidate.mode,
      reasons: [...candidate.reasons],
      read_count: candidate.readCount,
      last_read_at: candidate.lastReadAt,
      size_bytes: candidate.sizeBytes,
    })),
    clusters: plan.clusters.map((cluster) => [...cluster]),
    stats: {
      notes: plan.stats.notes,
      global_notes: plan.stats.globalNotes,
      oversized: plan.stats.oversized,
      stale_or_unread: plan.stats.staleOrUnread,
      total_bytes: plan.stats.totalBytes,
    },
    budget: mapBudgetSection(plan.budget),
    skipped: [...plan.skipped],
  }
}

/** Model-facing rendering of one memory_dream value. */
export function renderDream(value: DreamValue): string {
  if (value.kind !== 'plan') {
    return value.message
  }
  const lines = [
    `memory_dream plan at ${value.generated_at}`
    + ` (last dream: ${value.last_dream_at ?? 'never'};`
    + ` ${String(value.stats.notes)} live notes, ${String(value.stats.stale_or_unread)} stale or never-read,`
    + ` ${String(value.stats.oversized)} oversized, ${String(value.clusters.length)} near-duplicate clusters)`,
    '',
    'Work plan:',
    value.plan,
  ]
  if (value.budget.over_budget) {
    lines.push('', `OVER BUDGET: ${String(value.budget.used_tokens)} of ${String(value.budget.budget_tokens)} tokens used; ${String(value.budget.global_note_count)} live global notes inject, least-read first:`)
    lines.push(...value.budget.global_note_paths.map((path) => `- ${path}`))
  } else if (value.budget.measured) {
    lines.push('', `Budget headroom: ${String(value.budget.used_tokens)} of ${String(value.budget.budget_tokens)} tokens used.`)
  } else {
    lines.push('', `No recall budget spent in this process yet (configured budget ${String(value.budget.budget_tokens)} tokens).`)
  }
  if (value.candidates.length > 0) {
    lines.push('', `Candidates (${String(value.candidates.length)}):`)
    for (const candidate of value.candidates) {
      const read = candidate.last_read_at === '' ? 'never read' : `read ${candidate.last_read_at} (${String(candidate.read_count)}x)`
      lines.push(`- ${candidate.path} [${candidate.mode}] (${candidate.reasons.join(', ')}; ${read})`)
    }
  }
  if (value.skipped.length > 0) {
    lines.push('', 'Skipped checks:')
    lines.push(...value.skipped.map((skip) => `- ${skip}`))
  }
  lines.push('', `Prompt: ${value.prompt.length} chars (editable at the plugin dream-prompt.md; omitted here).`)
  return lines.join('\n')
}

/** Build the memory_dream definition for one service seam. */
export function createDreamTool(service: MemoryService): ToolDefinition {
  return defineMemoryTool({
    name: TOOL_MEMORY_DREAM,
    description: DREAM_DESCRIPTION,
    parameters: DREAM_PARAMETERS,
    output: DREAM_OUTPUT,
    timeoutMs: DREAM_TIMEOUT_MS,
    execute: async (args) => await executeDream(service, args),
    render: renderDream,
    presentCall: makePresentCall({
      tool: TOOL_MEMORY_DREAM,
      kind: (operation) => operation === 'run' ? 'execute' : 'other',
      field: 'operation',
      fallback: 'plan',
    }),
  })
}
