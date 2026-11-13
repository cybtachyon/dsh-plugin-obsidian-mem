/**
 * HostContract mirrors the exact model-facing tool contract the harness
 * `tools` seam accepts: `register(definition)` with raw JSON Schema
 * `parameters`/`output.schema`, a pure `render`, and `presentCall` card
 * views. Verified against the installed @deepseek-ai/cordis 4.1.0 plus the
 * live host `tools` service contract and @deepseek-ai/dsh-tools 0.2.1's
 * enforced JsonSchemaNode subset.
 *
 * This package never imports @deepseek-ai/dsh-tools at runtime (its module
 * scope may not resolve inside a third-party plugin's install, PLAN
 * TASK-031 canon), so the registration shapes are declared here and read
 * from the seam structurally. Arguments arrive `unknown`: the raw
 * definition path gets no defineTool-style validation, so every tool
 * parses and range-checks its own arguments in `execute`.
 * @module dsh-plugin-obsidian-mem/tools/host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { NoteMeta } from '../../core/lib/index.js'
import type { AuditReport, AuditRequest } from '../../service/lib/audit.js'
import type { DreamEngineResult, DreamRequest } from '../../service/lib/dream.js'
import type { MemorySearchResult, SearchRequest } from '../../service/lib/search.js'
import type {
  ObsidianMemReadResult,
  ObsidianMemWriteResult,
  ReadRegistryEntry,
  VaultEntry,
} from '../../service/lib/index.js'

// The enforced JSON Schema subset (dsh-tools/json-schema): the host
// validates every successful tool value against output.schema, so the
// tool schemas in this package use only these keywords.
export interface JsonSchemaNode {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null'
  oneOf?: readonly JsonSchemaNode[]
  properties?: Readonly<Record<string, JsonSchemaNode>>
  required?: readonly string[]
  additionalProperties?: boolean
  items?: JsonSchemaNode
  enum?: readonly (string | number | boolean | null)[]
  const?: string | number | boolean | null
  description?: string
  title?: string
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface ContentBlock {
  type: string
  text: string
}

/** The generic-card shapes presentCall returns (host presentation types). */
export interface GenericCallView {
  card: 'generic'
  title: string
  kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'
  rawInput?: unknown
}

/** The subset of the host ToolDefinition this package registers. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchemaNode
  output: {
    schema: JsonSchemaNode
    render(args: unknown, value: JsonValue): ContentBlock[]
  }
  timeoutMs?: number
  // The host contract types execute as Promise<unknown> and enforces
  // output.schema against the resolved value; render receives the
  // validated canonical value.
  execute(args: unknown): Promise<unknown>
  presentCall?(args: unknown): GenericCallView | undefined
}

/** The `tools` seam slice the registration needs. */
export interface ToolsSeam {
  register(definition: ToolDefinition): () => void
}

/** The scoped-inject scope: the Context plus the `tools` service. */
export type MemoryToolScope = Context & {
  tools: ToolsSeam
  effect(execute: () => () => void, label?: string): unknown
}

/**
 * MemoryService is the ctx.obsidianMem slice the memory_* tools consume.
 * The real ObsidianMemService satisfies it structurally; tests inject a
 * fake of the same shape.
 */
export interface MemoryService {
  /** Idempotent lazy provisioning; the trigger call returns the notice. */
  ensureMemoryAccess(): Promise<string | undefined>
  listVaults(): VaultEntry[]
  read(absPath: string, options?: { offset?: number; limit?: number }): Promise<ObsidianMemReadResult>
  search(request: SearchRequest): Promise<MemorySearchResult[]>
  readRecord(absPath: string): ReadRegistryEntry | undefined
  applyWrite(path: string, meta: NoteMeta, body: string): Promise<ObsidianMemWriteResult>
  /** Read-only doctor pass (memory_audit); never provisions, never writes. */
  audit(request?: AuditRequest): Promise<AuditReport>
  /**
   * Dream: `plan` answers the deterministic analysis; `run` answers
   * {id, done} once the single-flight guard is armed. Busy and blocked
   * arrive as DreamBusyError / DreamBlockedError.
   */
  dream(request?: DreamRequest): Promise<DreamEngineResult>
  readonly config: {
    budgets: {
      searchTopK: number
      readSectionTokens: number
    }
  }
}

// Argument parsing helpers: raw definitions receive `unknown` args, so
// each tool normalizes through these one-per-field guards. A missing or
// wrong-typed required field throws (the host materializes the throw as an
// error result the model can read); optional numbers clamp.

export function requiredString(args: Record<string, unknown>, name: string): string {
  const value = args[name]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`obsidian-mem tool: "${name}" must be a non-empty string`)
  }
  return value
}

export function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string') {
    throw new Error(`obsidian-mem tool: "${name}" must be a string when provided`)
  }
  return value.trim() === '' ? undefined : value.trim()
}

export function optionalInt(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`obsidian-mem tool: "${name}" must be a number when provided`)
  }
  return Math.trunc(value)
}

/** OptionalEnum accepts one of `allowed` verbatim; absent answers undefined. */
export function optionalEnum(args: Record<string, unknown>, name: string, allowed: readonly string[]): string | undefined {
  const value = args[name]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`obsidian-mem tool: "${name}" must be one of ${allowed.join(' | ')}`)
  }
  return value
}

export function optionalBoolean(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name]
  if (value === undefined || value === null) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new Error(`obsidian-mem tool: "${name}" must be a boolean when provided`)
  }
  return value
}

/** ArgumentsRecord narrows the unknown execute payload once, centrally. */
export function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('obsidian-mem tool: arguments must be an object')
  }
  return args as Record<string, unknown>
}

/** TextBlock builds the one content block every render returns. */
export function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}
