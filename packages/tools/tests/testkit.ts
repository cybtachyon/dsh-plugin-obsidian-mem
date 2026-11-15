/**
 * Shared test kit for the tools specs: a fake MemoryService implementing
 * the seam slice over a real temp-directory vault tree (so the tools' own
 * fs guards hit real bytes), a recording tools scope for registration
 * assertions, a real-cordis mount helper, and a JSON-Schema-subset value
 * validator that checks every tool value against its registered
 * output.schema the way the host does.
 * @module dsh-plugin-obsidian-mem/tools/tests/testkit
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  classifyPath,
  contentHash,
  GLOBAL_MEMORY_FILE_DEFAULT,
  parseNote,
  serializeNoteWithRaw,
} from '../../core/lib/index.js'
import type { NoteMeta, VaultConfig } from '../../core/lib/index.js'
import type { AuditReport, AuditRequest } from '../../service/lib/audit.js'
import type { DreamEngineResult, DreamRequest } from '../../service/lib/dream.js'
import type { MemorySearchResult, SearchRequest } from '../../service/lib/search.js'
import type {
  ObsidianMemReadResult,
  ReadRegistryEntry,
  VaultEntry,
} from '../../service/lib/index.js'
import type { JsonSchemaNode, MemoryService, ToolDefinition } from '../src/index.ts'

export type { NoteMeta }

/** A temp tree: files map relative path -> contents; returns {root, cleanup}. */
export function makeTempTree(files: Record<string, string>): { root: string, cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'obsidian-mem-tools-'))
  for (const [rel, contents] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, contents, 'utf8')
  }
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/**
 * VaultEntry rows from registry-shaped config rows: rows that omit
 * globalFile get the resolved default, mirroring resolveVaults so a
 * fixture can name only the knobs its spec exercises.
 */
export function vaultEntries(
  ...vaults: (Omit<VaultConfig, 'globalFile'> & Partial<Pick<VaultConfig, 'globalFile'>>)[]
): VaultEntry[] {
  return vaults.map((vault) => ({
    globalFile: GLOBAL_MEMORY_FILE_DEFAULT,
    ...vault,
    source: 'settings' as const,
  }))
}

/** The knobs one fake service run needs. */
export interface FakeServiceOptions {
  vaults: VaultEntry[]
  /** The one-time provisioning notice; only the FIRST ensure call sees it. */
  notice?: string
  searchResults?: MemorySearchResult[]
  searchError?: Error
  readRecords?: Map<string, ReadRegistryEntry>
  budgets?: { searchTopK: number, readSectionTokens: number }
  /** Canned audit report; absent makes the fake audit throw (never stubbed). */
  auditReport?: AuditReport
  /** Canned dream result; absent makes the fake dream throw (never stubbed). */
  dreamResult?: DreamEngineResult
  /** Thrown by dream() instead of answering (guard-error mapping tests). */
  dreamError?: Error
}

/** The fake plus its call ledgers. */
export interface FakeMemoryService extends MemoryService {
  ensureCalls: number
  readCalls: Array<{ path: string, options: { offset?: number, limit?: number } }>
  searchRequests: SearchRequest[]
  writeRequests: Array<{ path: string, meta: NoteMeta, body: string }>
  /** The read-registry; tests seed staleness scenarios here. */
  records: Map<string, ReadRegistryEntry>
  auditRequests: AuditRequest[]
  dreamRequests: DreamRequest[]
}

/** Create the seam-slice fake. read/applyWrite mirror the real service. */
export function createFakeService(options: FakeServiceOptions): FakeMemoryService {
  const budgets = options.budgets ?? { searchTopK: 6, readSectionTokens: 350 }
  const records = options.readRecords ?? new Map<string, ReadRegistryEntry>()
  const fake: FakeMemoryService = {
    ensureCalls: 0,
    readCalls: [],
    searchRequests: [],
    writeRequests: [],
    records,
    config: { budgets },
    async ensureMemoryAccess() {
      fake.ensureCalls += 1
      return fake.ensureCalls === 1 ? options.notice : undefined
    },
    async ensureWriteAccess() {
      fake.ensureCalls += 1
      return fake.ensureCalls === 1 ? options.notice : undefined
    },
    listVaults() {
      return options.vaults.map((entry) => ({ ...entry }))
    },
    async read(absPath, readOptions = {}) {
      fake.readCalls.push({ path: absPath, options: readOptions })
      const text = readOrThrow(absPath)
      const note = parseNote(text)
      const classified = classifyPath(options.vaults, absPath)
      if (classified === null) {
        throw new Error(`fake read: ${absPath} outside vaults`)
      }
      const lines = note.body.replace(/\n$/, '').split('\n')
      const totalLines = lines.length
      const offset = Math.max(1, Math.trunc(readOptions.offset ?? 1))
      const limit = readOptions.limit === undefined ? totalLines : Math.max(0, Math.trunc(readOptions.limit))
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      records.set(absPath, { contentHash: contentHash(text), mtimeMs: 0, at: Date.now() })
      const result: ObsidianMemReadResult = {
        path: absPath,
        meta: note.meta,
        body: slice.join('\n'),
        mode: classified.mode,
        statsUpdated: classified.mode === 'shared',
        offset,
        limit,
        totalLines,
        truncated: offset - 1 + slice.length < totalLines,
      }
      return result
    },
    async search(request) {
      fake.searchRequests.push(request)
      if (options.searchError !== undefined) {
        throw options.searchError
      }
      return options.searchResults ?? []
    },
    readRecord(absPath) {
      return records.get(absPath)
    },
    auditRequests: [],
    async audit(request = {}) {
      fake.auditRequests.push(request)
      if (options.auditReport === undefined) {
        throw new Error('fake service: audit report not stubbed')
      }
      return options.auditReport
    },
    dreamRequests: [],
    async dream(request = {}) {
      fake.dreamRequests.push(request)
      if (options.dreamError !== undefined) {
        throw options.dreamError
      }
      if (options.dreamResult === undefined) {
        throw new Error('fake service: dream result not stubbed')
      }
      return options.dreamResult
    },
    async applyWrite(path, meta, body) {
      fake.writeRequests.push({ path, meta, body })
      const existing = tryRead(path)
      const created = existing === null
      const raw = existing === null ? undefined : parseNote(existing).raw
      mkdirSync(dirname(path), { recursive: true })
      const rendered = serializeNoteWithRaw({ meta, body }, raw)
      writeFileSync(path, rendered, 'utf8')
      records.set(path, { contentHash: contentHash(rendered), mtimeMs: 0, at: Date.now() })
      const classified = classifyPath(options.vaults, path)
      return {
        path,
        created,
        vaultPath: classified?.vault.path ?? '',
        relPath: path.slice((classified?.vault.path ?? '').length + 1),
      }
    },
  }
  return fake
}

function readOrThrow(path: string): string {
  const text = tryRead(path)
  if (text === null) {
    throw new Error(`fake read: ${path} missing`)
  }
  return text
}

function tryRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** A recording tools-scope stand-in: registers become data, not effects. */
export interface RecordingToolsScope {
  tools: { register(definition: ToolDefinition): () => void }
  effect(execute: () => () => void, label?: string): () => void
  registered: ToolDefinition[]
  disposed: string[]
  /** The disposers the scope.effect pass produced, for unload assertions. */
  effectDisposers: Array<() => void>
}

export function createRecordingScope(): RecordingToolsScope {
  const scope: RecordingToolsScope = {
    tools: {
      register(definition) {
        scope.registered.push(definition)
        return () => {
          scope.disposed.push(definition.name)
        }
      },
    },
    effect(execute) {
      const dispose = execute()
      scope.effectDisposers.push(dispose)
      return dispose
    },
    registered: [],
    disposed: [],
    effectDisposers: [],
  }
  return scope
}

/** Run one registered tool's execute with plain args (no agent context). */
export async function runTool(
  definition: ToolDefinition,
  args: Record<string, unknown>,
): Promise<unknown> {
  return await definition.execute(args)
}

/** Render one value through the definition's output.render, as text. */
export function renderTool(definition: ToolDefinition, value: unknown): string {
  return definition.output.render({}, value as never)
    .map((block) => block.text)
    .join('\n')
}

// The JSON Schema subset validator the host roughly applies to tool
// values: oneOf exact-branch, const/enum, scalar types, object
// required/additionalProperties, array items. A tool value that violates
// its own schema is a host-side failure, so specs assert on it directly.
export function schemaViolations(node: JsonSchemaNode, value: unknown, path = '$'): string[] {
  const out: string[] = []
  if (node.oneOf !== undefined) {
    const matches = node.oneOf
      .map((branch) => schemaViolations(branch, value, path))
      .filter((violations) => violations.length === 0)
    if (matches.length !== 1) {
      out.push(`${path}: ${matches.length} oneOf branches matched (want exactly 1)`)
    }
    return out
  }
  if (node.const !== undefined && value !== node.const) {
    out.push(`${path}: expected const ${String(node.const)}, got ${JSON.stringify(value)}`)
  }
  if (node.enum !== undefined && !node.enum.includes(value as never)) {
    out.push(`${path}: ${JSON.stringify(value)} not in enum`)
  }
  switch (node.type) {
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        out.push(`${path}: not an object`)
        break
      }
      const record = value as Record<string, unknown>
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(record, key)) out.push(`${path}.${key}: missing required key`)
      }
      if (node.additionalProperties === false && node.properties !== undefined) {
        for (const key of Object.keys(record)) {
          if (!Object.hasOwn(node.properties, key)) out.push(`${path}.${key}: additional property`)
        }
      }
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        if (Object.hasOwn(record, key)) {
          out.push(...schemaViolations(child, record[key], `${path}.${key}`))
        }
      }
      break
    }
    case 'array': {
      if (!Array.isArray(value)) {
        out.push(`${path}: not an array`)
        break
      }
      if (node.items !== undefined) {
        value.forEach((item, index) => {
          out.push(...schemaViolations(node.items as JsonSchemaNode, item, `${path}[${index}]`))
        })
      }
      break
    }
    case 'string':
      if (typeof value !== 'string') out.push(`${path}: not a string`)
      break
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) out.push(`${path}: not an integer`)
      break
    case 'number':
      if (typeof value !== 'number') out.push(`${path}: not a number`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') out.push(`${path}: not a boolean`)
      break
    case 'null':
      if (value !== null) out.push(`${path}: not null`)
      break
    default:
      break
  }
  return out
}

/** Assert one tool value validates against its definition's output schema. */
export function matchesOutput(definition: ToolDefinition, value: unknown): string[] {
  return schemaViolations(definition.output.schema, value)
}
