/**
 * Hybrid search over the `obsidian_mem` collection (TASK-024):
 * embedQuery → hybridSearch (dense COSINE + BM25, RRFRanker(60), filter
 * expression builder) → dedupe/truncate/registry-resolved results, plus
 * searchExactSections for the Read intercept and the typed
 * IndexOfflineError callers degrade quietly on.
 *
 * Invariants from docs/research/milvus-transformers-findings.md §3/§4 and
 * the G10 addendum: sub-requests go under `data[]` (never `requests`)
 * with metric_type on EACH item (lite rejects sparse without it, G3);
 * the shared filter expression goes into each route's `expr` (that is
 * the §4.2 verified shape; HybridSearchReq omits a top-level filter);
 * RRFRanker only (BM25 scores can be negative, G7, so never threshold
 * BM25 raw scores; minScore applies to fused scores only); output_fields
 * ALWAYS include the primary key chunk_id (G10) plus the columns the
 * result rows are built from; a Strong-consistency count(*) guards the
 * empty collection before BM25 dispatch.
 *
 * Assumes the collection is loaded: lite searches fail in the 'released'
 * state and getLoadState lies (G5/G6), so the service/indexer ensures
 * loadCollectionSync (schema.ts) before search is ever reached; this
 * module documents the assumption instead of re-loading per query.
 * @module dsh-plugin-obsidian-mem/service/search
 */

import { MetricType, RRFRanker } from '@zilliz/milvus2-sdk-node'

import {
  approxCharsForTokens,
  MILVUS_COLLECTION,
  MILVUS_CONSISTENCY_LEVEL,
  MILVUS_FIELDS,
  normalizeExtension,
  RECALL_READ_MAX_SECTIONS,
  RECALL_READ_SECTION_TOKENS,
  SEARCH_DEFAULT_TOP_K,
  SEARCH_MAX_RESULTS,
} from '../../core/lib/index.js'
import type { VaultMode } from '../../core/lib/index.js'
import type { Embedder } from './embedder.js'
import { describeError } from './errors.js'
import { assertOk } from './milvus/ok.js'

/**
 * SEARCH_OUTPUT_FIELDS is the projection every search dispatches:
 * chunk_id (the PK, G10) first, then the columns the result row and the
 * ui/audit display read. Never trimmed per call.
 */
export const SEARCH_OUTPUT_FIELDS: readonly string[] = [
  MILVUS_FIELDS.chunkId,
  MILVUS_FIELDS.sourcePath,
  MILVUS_FIELDS.sectionHeader,
  MILVUS_FIELDS.scope,
  MILVUS_FIELDS.vault,
  MILVUS_FIELDS.updatedAt,
  MILVUS_FIELDS.chunkText,
] as const

/** One sub-request inside hybridSearch `data[]`. */
export interface HybridRoute {
  anns_field: string
  data: unknown[]
  limit: number
  metric_type: string
  /** Per-route scalar filter; the verified lite shape (§4.2). */
  expr?: string
  params?: Record<string, unknown>
}

/** The hybridSearch request this module dispatches. */
export interface HybridSearchDispatch {
  collection_name: string
  data: HybridRoute[]
  rerank: unknown
  limit: number
  output_fields: string[]
  consistency_level?: string
}

/** Raw row shape: lite returns one object per hit with score included. */
export type RawSearchRow = Record<string, unknown>

/** The client slice search needs; MilvusClient satisfies it structurally. */
export interface SearchMilvus {
  count(request: { collection_name: string }): Promise<{ data?: number; status?: unknown }>
  hybridSearch(request: HybridSearchDispatch): Promise<{ results?: RawSearchRow[]; status?: unknown }>
}

/** Thrown when Milvus cannot answer; callers degrade quietly (typed). */
export class IndexOfflineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'IndexOfflineError'
  }
}

/** One scored, deduped, budget-cut memory result. */
export interface MemorySearchResult {
  chunk_id: number
  source_path: string
  section_header: string
  chunk_text: string
  scope: string
  vault: string
  /** Vault access mode from the injected registry lookup; null when unknown. */
  mode: VaultMode | null
  updated_at: number
  /** RRF-fused score (never a raw BM25 score; G7). */
  score: number
}

/** Search-side dependencies; everything external is injected. */
export interface SearchDependencies {
  client: SearchMilvus
  embedder: Embedder
  collectionName?: string
  /** Vault-registry lookup: vault path -> access mode. */
  vaultModeFor?: (vault: string) => VaultMode | undefined
  /** Per-result chunk_text budget; default RECALL_READ_SECTION_TOKENS. */
  defaultTokenCap?: number
}

/** Filter inputs the shared expression builder turns into a scalar expr. */
export interface FilterCriteria {
  /** Named scopes or project slugs; prunes via the partition key. */
  scopes?: readonly string[]
  /** Vault paths; prunes via the vault scalar. */
  vaults?: readonly string[]
  /** Single trigger extension (".ts"); normalized defensively. */
  ext?: string
  /** Framework labels for ARRAY_CONTAINSAny. */
  frameworks?: readonly string[]
  /** Wake keywords for ARRAY_CONTAINSAny. */
  wakeKeywords?: readonly string[]
  /** Exact source_path equality (the Read intercept's file). */
  sourcePath?: string
}

/** Parameters of a hybrid memory search. */
export interface SearchRequest {
  query: string
  ext?: string
  frameworks?: readonly string[]
  wakeKeywords?: readonly string[]
  scopes?: readonly string[]
  vaults?: readonly string[]
  /** Result count; default SEARCH_DEFAULT_TOP_K, cap SEARCH_MAX_RESULTS. */
  topK?: number
  /** Floor on the RRF-fused score (NOT a BM25 threshold, G7). */
  minScore?: number
  /** Per-result chunk_text token budget; overrides deps.defaultTokenCap. */
  tokenCap?: number
}

/** Parameters of the Read-intercept exact-section recall. */
export interface ExactSectionRequest {
  /** Vault-relative source_path of the file being read. */
  filePath: string
  /** Extension of that file, e.g. ".tsx"; filters trigger_extensions. */
  ext?: string
  /** Workspace directory signals ("src/"); wake-keyword fallback only. */
  dirSignals?: readonly string[]
  /** Query text (usually the Read result snippet); path when absent. */
  snippet?: string
  /** Sections to return; default RECALL_READ_MAX_SECTIONS. */
  k?: number
  /** Token budget per section; default RECALL_READ_SECTION_TOKENS. */
  sectionTokens?: number
  /** Explicit framework filter for the fallback route. */
  frameworks?: readonly string[]
  /** Restrict to these vaults. */
  vaults?: readonly string[]
}

// ext -> fallback framework hint for the Read intercept; only component
// file types carry a framework with real confidence.
const EXT_FRAMEWORK_HINTS: Readonly<Record<string, readonly string[]>> = {
  '.tsx': ['react'],
  '.jsx': ['react'],
  '.vue': ['vue'],
  '.svelte': ['svelte'],
}

// The verified fusion and search-knob values from findings §4.2: RRFRanker
// (k) fuses the two routes by rank only (so negative BM25 scores never leak
// into a result, G7), and ef is the HNSW candidate width per dense route.
const RRF_RANKER_K = 60
const DENSE_SEARCH_EF = 64

// Each route asks for this many times the caller's limit, so dedupe and the
// minScore floor still leave a full page of results to return.
const CANDIDATE_OVERSAMPLE = 2

/**
 * BuildFilterExpr renders FilterCriteria into a Milvus scalar expression
 * in fixed clause order (scope, trigger_extensions, trigger_frameworks,
 * wake_keywords, vault, source_path) joined by ` and `, or undefined
 * when no clause applies. Values are double-quoted with backslash and
 * quote escaping. Golden-tested against literal expressions
 * (tests/search.spec.ts); verified filter forms per findings §3:
 * `scope IN [...]`, ARRAY_CONTAINS, ARRAY_CONTAINSAny, `==`, `IN`.
 */
export function buildFilterExpr(criteria: FilterCriteria): string | undefined {
  const clauses: string[] = []

  if (criteria.scopes !== undefined && criteria.scopes.length > 0) {
    clauses.push(`${MILVUS_FIELDS.scope} IN [${criteria.scopes.map(quoteExpr).join(', ')}]`)
  }
  const ext = criteria.ext === undefined ? null : normalizeExtension(criteria.ext)
  if (ext !== null) {
    clauses.push(`ARRAY_CONTAINS(${MILVUS_FIELDS.triggerExtensions}, ${quoteExpr(ext)})`)
  }
  if (criteria.frameworks !== undefined && criteria.frameworks.length > 0) {
    clauses.push(`ARRAY_CONTAINSAny(${MILVUS_FIELDS.triggerFrameworks}, ${listLiteral(criteria.frameworks)})`)
  }
  if (criteria.wakeKeywords !== undefined && criteria.wakeKeywords.length > 0) {
    clauses.push(`ARRAY_CONTAINSAny(${MILVUS_FIELDS.wakeKeywords}, ${listLiteral(criteria.wakeKeywords)})`)
  }
  if (criteria.vaults !== undefined && criteria.vaults.length > 0) {
    clauses.push(`${MILVUS_FIELDS.vault} IN [${criteria.vaults.map(quoteExpr).join(', ')}]`)
  }
  if (criteria.sourcePath !== undefined && criteria.sourcePath !== '') {
    clauses.push(`${MILVUS_FIELDS.sourcePath} == ${quoteExpr(criteria.sourcePath)}`)
  }

  return clauses.length > 0 ? clauses.join(' and ') : undefined
}

/**
 * HybridSearch runs the dense + BM25 hybrid dispatch and returns
 * deduped, budget-cut, registry-resolved results. Offline or error
 * statuses become IndexOfflineError; embedder failures propagate as-is
 * (that is not an index-offline condition).
 */
export async function hybridSearch(
  deps: SearchDependencies,
  request: SearchRequest,
): Promise<MemorySearchResult[]> {
  const topK = clampTopK(request.topK)
  const tokenCap = tokenBudget(request.tokenCap, deps)
  const expr = buildFilterExpr({
    ...(request.scopes !== undefined ? { scopes: request.scopes } : {}),
    ...(request.vaults !== undefined ? { vaults: request.vaults } : {}),
    ...(request.ext !== undefined ? { ext: request.ext } : {}),
    ...(request.frameworks !== undefined ? { frameworks: request.frameworks } : {}),
    ...(request.wakeKeywords !== undefined ? { wakeKeywords: request.wakeKeywords } : {}),
  })

  if (!(await guardCollectionHasRows(deps))) {
    return []
  }
  const dense = await deps.embedder.embedQuery(request.query)
  const rows = await dispatchHybrid(deps, request.query, dense, expr, candidatesFor(topK))

  let results = toResults(deps, rows, tokenCap)
  if (request.minScore !== undefined) {
    const floor = request.minScore
    // Applies to RRF-fused scores only; BM25 raw scores can be negative
    // (G7) and never reach this comparison.
    results = results.filter((row) => row.score >= floor)
  }
  return topSections(results, topK)
}

/**
 * SearchExactSections serves the Read intercept: chunks of the exact
 * file first (source_path == filter); when that file has no indexed
 * chunks, a fallback search by trigger_extensions (ext), frameworks,
 * and the query text. Same section budget per result as the main search;
 * offline degrades to IndexOfflineError.
 */
export async function searchExactSections(
  deps: SearchDependencies,
  request: ExactSectionRequest,
): Promise<MemorySearchResult[]> {
  const k = clampTopK(request.k ?? RECALL_READ_MAX_SECTIONS)
  const sectionTokens = tokenBudget(request.sectionTokens, deps)
  const ext = request.ext === undefined ? null : normalizeExtension(request.ext)
  const queryText = request.snippet !== undefined && request.snippet.trim() !== ''
    ? request.snippet
    : request.filePath

  if (!(await guardCollectionHasRows(deps))) {
    return []
  }
  const dense = await deps.embedder.embedQuery(queryText)

  const exactExpr = buildFilterExpr({
    sourcePath: request.filePath,
    ...(request.vaults !== undefined ? { vaults: request.vaults } : {}),
  })
  const exactRows = await dispatchHybrid(deps, queryText, dense, exactExpr, candidatesFor(k))
  const exact = topSections(toResults(deps, exactRows, sectionTokens), k)
  if (exact.length > 0) {
    return exact
  }

  // Fallback: ext/framework-filtered recall on the query text. Directory
  // signals only join as wake keywords when nothing else narrows, so the
  // clause never over-restricts an already-filtered query.
  const frameworks = [
    ...(request.frameworks ?? []),
    ...(ext === null ? [] : EXT_FRAMEWORK_HINTS[ext] ?? []),
  ]
  const wakeKeywords = request.dirSignals?.map((signal) => signal.replace(/\/+$/, '')) ?? []
  const fallbackExpr = buildFilterExpr({
    ...(ext === null ? {} : { ext }),
    ...(frameworks.length > 0 ? { frameworks } : {}),
    ...(request.vaults !== undefined ? { vaults: request.vaults } : {}),
    ...(frameworks.length === 0 && request.ext === undefined && wakeKeywords.length > 0
      ? { wakeKeywords }
      : {}),
  })
  const fallbackRows = await dispatchHybrid(deps, queryText, dense, fallbackExpr, candidatesFor(k))
  return topSections(toResults(deps, fallbackRows, sectionTokens), k)
}

// Shared dispatch: one hybridSearch carrying both routes with explicit
// metric_types (G3), the filter expr per route (§4.2), RRFRanker(60)
// fusion, and the full G10 projection.
async function dispatchHybrid(
  deps: SearchDependencies,
  queryText: string,
  dense: number[],
  expr: string | undefined,
  candidateLimit: number,
): Promise<RawSearchRow[]> {
  const routes: HybridRoute[] = [
    {
      anns_field: MILVUS_FIELDS.denseVector,
      data: [dense],
      limit: candidateLimit,
      metric_type: MetricType.COSINE,
      params: { ef: DENSE_SEARCH_EF },
    },
    {
      anns_field: MILVUS_FIELDS.sparseVector,
      data: [queryText],
      limit: candidateLimit,
      metric_type: MetricType.BM25,
    },
  ]
  if (expr !== undefined) {
    for (const route of routes) {
      route.expr = expr
    }
  }

  const response = await callMilvus('hybridSearch', () => deps.client.hybridSearch({
    collection_name: collectionOf(deps),
    data: routes,
    rerank: RRFRanker(RRF_RANKER_K),
    limit: candidateLimit,
    output_fields: [...SEARCH_OUTPUT_FIELDS],
    // The collection declares the same level at create (schema.ts) and lite
    // writes are read-back immediate; asking per read keeps it explicit.
    consistency_level: MILVUS_CONSISTENCY_LEVEL,
  }))
  return response.results ?? []
}

// count(*) guard: BM25 against an empty collection crashes lite (NaN),
// so callers return [] before dispatch. Strong per request; the empty
// answer must not come from a stale snapshot.
async function guardCollectionHasRows(deps: SearchDependencies): Promise<boolean> {
  const response = await callMilvus('count', () => deps.client.count({
    collection_name: collectionOf(deps),
  }))
  return Number(response.data ?? 0) > 0
}

// Milvus-call wrapper: transports and error statuses (the SDK resolves
// them, G1) all surface as the typed IndexOfflineError.
async function callMilvus<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return assertOk(await run(), what)
  } catch (cause) {
    throw new IndexOfflineError(`memory search: ${describeError(cause)}`, { cause })
  }
}

// Row shaping: coerce fields, budget chunk_text, resolve the vault mode
// through the injected registry lookup.
function toResults(
  deps: SearchDependencies,
  rows: readonly RawSearchRow[],
  tokenCap: number,
): MemorySearchResult[] {
  return rows.map((row) => {
    const vault = String(row[MILVUS_FIELDS.vault] ?? '')
    return {
      chunk_id: Number(row[MILVUS_FIELDS.chunkId] ?? 0),
      source_path: String(row[MILVUS_FIELDS.sourcePath] ?? ''),
      section_header: String(row[MILVUS_FIELDS.sectionHeader] ?? ''),
      chunk_text: truncateToTokens(String(row[MILVUS_FIELDS.chunkText] ?? ''), tokenCap),
      scope: String(row[MILVUS_FIELDS.scope] ?? ''),
      vault,
      mode: deps.vaultModeFor?.(vault) ?? null,
      updated_at: Number(row[MILVUS_FIELDS.updatedAt] ?? 0),
      score: Number(row.score ?? 0),
    }
  })
}

// collectionOf resolves the one collection name every dispatch reads.
function collectionOf(deps: SearchDependencies): string {
  return deps.collectionName ?? MILVUS_COLLECTION
}

// tokenBudget resolves the per-result text budget: request, then deps, then
// the shared read-section default.
function tokenBudget(requestValue: number | undefined, deps: SearchDependencies): number {
  return requestValue ?? deps.defaultTokenCap ?? RECALL_READ_SECTION_TOKENS
}

// candidatesFor widens each route's limit before dedupe and the score floor
// trim the results.
function candidatesFor(limit: number): number {
  return limit * CANDIDATE_OVERSAMPLE
}

// Same file + same section header is one logical section that long-chunk
// splitting or the two routes both surfaced: keep the highest score.
function dedupeBySection(results: readonly MemorySearchResult[]): MemorySearchResult[] {
  const best = new Map<string, MemorySearchResult>()
  for (const result of [...results].sort((a, b) => b.score - a.score)) {
    const key = `${result.source_path}\u0000${result.section_header}`
    if (!best.has(key)) {
      best.set(key, result)
    }
  }
  return [...best.values()]
}

// topSections is the one shaping order every dispatch ends on: dedupe to one
// row per logical section first, then cut to the caller's limit.
function topSections(
  results: readonly MemorySearchResult[],
  limit: number,
): MemorySearchResult[] {
  return dedupeBySection(results).slice(0, limit)
}

function truncateToTokens(text: string, tokens: number): string {
  const capChars = approxCharsForTokens(tokens)
  return text.length <= capChars ? text : text.slice(0, capChars)
}

function clampTopK(value: number | undefined): number {
  const wanted = value === undefined || !Number.isFinite(value) ? SEARCH_DEFAULT_TOP_K : Math.trunc(value)
  return Math.max(1, Math.min(SEARCH_MAX_RESULTS, wanted))
}

function quoteExpr(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function listLiteral(values: readonly string[]): string {
  return `[${values.map(quoteExpr).join(', ')}]`
}
