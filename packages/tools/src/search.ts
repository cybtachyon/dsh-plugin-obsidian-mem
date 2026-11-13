/**
 * `memory_search`: hybrid recall over the indexed vaults, shaped for the
 * model as ranked sections (source path, section header, score, vault
 * access mode, token-capped snippet with an honest truncation flag). The
 * service dispatch runs with the chunker's own ceiling as its snippet
 * budget so the tool, not the dispatch, applies the per-section budget and
 * therefore knows exactly which snippets it clipped. An offline or crashed
 * index comes back as the `index_offline` value with remediation, never a
 * throw. The 300 s timeout budgets the cold start: the first query embeds
 * only after the embedding model may have downloaded (hundreds of MB).
 * @module dsh-plugin-obsidian-mem/tools/search
 */

import {
  approxCharsForTokens,
  CHUNK_MAX_TOKENS,
  clampInt,
  SEARCH_MAX_RESULTS,
  TOOL_MEMORY_SEARCH,
} from '../../core/lib/index.js'
import { IndexOfflineError } from '../../service/lib/search.js'
import type { JsonSchemaNode, MemoryService, ToolDefinition } from './host.js'
import { asRecord, optionalInt, optionalString, requiredString } from './host.js'
import { defineMemoryTool, makePresentCall, noticeHeader, withNotice } from './toolkit.js'

/** Cold start budget: model download plus Milvus-Lite first spawn. */
export const SEARCH_TIMEOUT_MS = 300_000

// Beyond every chunker-produced chunk, so the dispatch never clips a
// snippet before the tool's own budget does (that is where the truncation
// flag's honesty comes from).
const DISPATCH_SNIPPET_TOKENS = CHUNK_MAX_TOKENS

/** What to tell the agent when the index cannot answer. */
export const INDEX_OFFLINE_REMEDIATION
  = 'Retry the search once more: the first search waits on the memory index starting and the embedding model downloading, which can take minutes. If searches stay offline, check the Obsidian Mem settings (milvus mode and address) and restart the harness.'

/** The description the model sees for `memory_search`. */
export const SEARCH_DESCRIPTION
  = 'Search the indexed memory vaults and return ranked sections: each result carries the source note path, the section header, a match score, the vault\'s access mode, and a token-capped snippet. Narrow with scope and ext filters. Follow a promising section with memory_read on its path for the full note.'

/** Parameter schema; defaults, ranges, and formats live on the parameters. */
export function searchParameters(defaultTopK: number): JsonSchemaNode {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'What to recall, phrased with the words a matching note would contain.',
      },
      scope: {
        type: 'string',
        description: 'Keep only notes of one scope: \'global\', \'domain\', \'reference\', or a kebab-case project slug.',
      },
      ext: {
        type: 'string',
        description: 'Keep only notes whose trigger list contains this file extension, e.g. \'.tsx\'. The leading dot is optional.',
      },
      limit: {
        type: 'integer',
        description: `Number of ranked sections to return, 1-${SEARCH_MAX_RESULTS}. Defaults to ${defaultTopK}.`,
      },
    },
  }
}

/** Closed output union keyed on kind. */
export const SEARCH_OUTPUT: JsonSchemaNode = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'query', 'count', 'sections'],
      properties: {
        kind: { type: 'string', const: 'search' },
        query: { type: 'string' },
        count: { type: 'integer' },
        sections: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['path', 'section_header', 'scope', 'vault', 'vault_mode', 'score', 'snippet', 'snippet_truncated'],
            properties: {
              path: { type: 'string' },
              section_header: { type: 'string' },
              scope: { type: 'string' },
              vault: { type: 'string' },
              vault_mode: { type: 'string', enum: ['shared', 'read-only', 'unknown'] },
              score: { type: 'number' },
              snippet: { type: 'string' },
              snippet_truncated: { type: 'boolean' },
            },
          },
        },
        notice: { type: 'string' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'message', 'remediation'],
      properties: {
        kind: { type: 'string', const: 'index_offline' },
        message: { type: 'string' },
        remediation: { type: 'string' },
        notice: { type: 'string' },
      },
    },
  ],
}

/** One ranked section as the tool returns it. */
export interface SearchSection {
  path: string
  section_header: string
  scope: string
  vault: string
  vault_mode: 'shared' | 'read-only' | 'unknown'
  score: number
  snippet: string
  snippet_truncated: boolean
}

/** The value one memory_search call returns. */
export type SearchValue
  = { kind: 'search', query: string, count: number, sections: SearchSection[], notice?: string }
  | { kind: 'index_offline', message: string, remediation: string, notice?: string }

/** Execute one memory_search call; an offline index is a value, not a throw. */
export async function executeSearch(service: MemoryService, args: unknown): Promise<SearchValue> {
  const raw = asRecord(args)
  const query = requiredString(raw, 'query')
  const scope = optionalString(raw, 'scope')
  const ext = optionalString(raw, 'ext')
  const requestedLimit = optionalInt(raw, 'limit')

  const notice = await service.ensureMemoryAccess()

  const topK = clampInt(requestedLimit ?? service.config.budgets.searchTopK, 1, SEARCH_MAX_RESULTS)
  try {
    const results = await service.search({
      query,
      ...(scope === undefined ? {} : { scopes: [scope] }),
      ...(ext === undefined ? {} : { ext }),
      topK,
      tokenCap: DISPATCH_SNIPPET_TOKENS,
    })
    const capChars = approxCharsForTokens(service.config.budgets.readSectionTokens)
    const sections: SearchSection[] = results.map((row) => ({
      path: row.source_path,
      section_header: row.section_header,
      scope: row.scope,
      vault: row.vault,
      vault_mode: row.mode ?? 'unknown',
      score: row.score,
      snippet: row.chunk_text.slice(0, capChars),
      snippet_truncated: row.chunk_text.length > capChars,
    }))
    return withNotice({
      kind: 'search' as const,
      query,
      count: sections.length,
      sections,
    }, notice)
  } catch (error: unknown) {
    if (error instanceof IndexOfflineError) {
      return withNotice({
        kind: 'index_offline' as const,
        message: error.message,
        remediation: INDEX_OFFLINE_REMEDIATION,
      }, notice)
    }
    throw error
  }
}

/** Model-facing rendering of one memory_search value. */
export function renderSearch(value: SearchValue): string {
  const notice = noticeHeader(value.notice)
  if (value.kind === 'index_offline') {
    return `${notice}Memory search is unavailable: ${value.message}\n${value.remediation}`
  }
  if (value.sections.length === 0) {
    return `${notice}No memory sections matched "${value.query}". Broaden the wording or drop the scope/ext filters; if nothing nearby exists, the fact is worth saving with memory_write.`
  }
  const blocks = value.sections.map((section, index) => [
    `${index + 1}. ${section.path}${section.section_header === '' ? '' : ` # ${section.section_header}`}`,
    `   (score ${section.score.toFixed(4)}, scope ${section.scope || 'unset'}, vault ${section.vault} [${section.vault_mode}])`,
    indent(section.snippet),
    ...(section.snippet_truncated ? ['   [section snippet truncated]'] : []),
  ].join('\n'))
  return `${notice}${blocks.join('\n\n')}`
}

function indent(text: string): string {
  return text.split('\n').map((line) => `   ${line}`).join('\n')
}

/** Build the memory_search definition for one service seam. */
export function createSearchTool(service: MemoryService): ToolDefinition {
  return defineMemoryTool({
    name: TOOL_MEMORY_SEARCH,
    description: SEARCH_DESCRIPTION,
    parameters: searchParameters(service.config.budgets.searchTopK),
    output: SEARCH_OUTPUT,
    timeoutMs: SEARCH_TIMEOUT_MS,
    execute: async (args) => await executeSearch(service, args),
    render: renderSearch,
    presentCall: makePresentCall({ tool: TOOL_MEMORY_SEARCH, kind: 'search', field: 'query', fallback: '' }),
  })
}
