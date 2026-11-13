/**
 * Hybrid search over the `obsidian_mem` collection (TASK-024, two-route
 * dispatch per TASK-004): embedQuery → two standalone `search` calls
 * (dense COSINE with a server-side radius, BM25 with a client-side
 * floor) → client RRF(60) fusion → dedupe/truncate/registry-resolved
 * results, plus searchExactSections for the Read intercept and the
 * typed IndexOfflineError callers degrade quietly on.
 *
 * The stop-word strip (sparseQueryText, TASK-002) rides the SPARSE route
 * ONLY: the BM25 `data` carries the stripped text while embedQuery, run by
 * the callers on the untouched query, keeps the dense route on the FULL
 * query text (e5 is trained on natural language).
 *
 * One `hybridSearch` cannot carry the per-route cutoffs on this stack:
 * milvus-lite 3.2.2 PARSES route-level `params.radius` but does not
 * honor it (docs/research/radius-tuning-findings.md §4), so each route
 * dispatches its own standalone search. Invariants from
 * docs/research/milvus-transformers-findings.md §3/§4 with the G10
 * addendum plus radius-tuning-findings: metric_type rides EVERY search
 * (lite rejects sparse without it, G3); the shared filter expression
 * repeats in both searches' `expr` (the §4.2 per-route filter shape);
 * COSINE survivors satisfy `radius < score <= range_filter` with the
 * radius EXCLUSIVE, so the 0.78 floor keeps scores strictly above 0.78
 * (radius-tuning-findings §2); BM25 returns NEGATED relevance scores
 * best-first (G7, radius-tuning-findings §3), so its floor applies
 * client-side on `-score` and a raw BM25 score is never thresholded
 * against a positive bound; fusion sums 1/(k + rank) with rank from 1,
 * the exact formula lite's own fused scores show (radius-tuning-
 * findings §4); the fused-score floor (request minScore, else
 * FUSED_SCORE_FLOOR) applies to those fused scores only, and its rule
 * has ONE home: the FUSED_SCORE_FLOOR note, cross-referenced by name
 * everywhere else; output_fields ALWAYS include the primary key chunk_id
 * (G10) plus the columns the result rows are built from; a
 * Strong-consistency count(*) guards the empty collection before BM25
 * dispatch.
 *
 * Assumes the collection is loaded: lite searches fail in the 'released'
 * state and getLoadState lies (G5/G6), so the service/indexer ensures
 * loadCollectionSync (schema.ts) before search is ever reached; this
 * module documents the assumption instead of re-loading per query.
 * @module dsh-plugin-obsidian-mem/service/search
 */

import { isAbsolute, join } from 'node:path'
import { MetricType } from '@zilliz/milvus2-sdk-node'
import { eng, removeStopwords, zho } from 'stopword'

import {
  approxCharsForTokens,
  clampInt,
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

/**
 * SearchRouteDispatch is one standalone route `search` this module
 * dispatches: dense (vector data) or sparse (stop-word-stripped query
 * text data, see sparseQueryText).
 */
export interface SearchRouteDispatch {
  collection_name: string
  anns_field: string
  data: unknown[]
  limit: number
  metric_type: string
  /** Per-route scalar filter; the same expr rides both searches. */
  expr?: string
  params: Record<string, unknown>
  output_fields: string[]
  consistency_level?: string
}

/** Raw row shape: lite returns one object per hit with score included. */
export type RawSearchRow = Record<string, unknown>

/** The client slice search needs; MilvusClient satisfies it structurally. */
export interface SearchMilvus {
  count(request: { collection_name: string }): Promise<{ data?: number; status?: unknown }>
  search(request: SearchRouteDispatch): Promise<{ results?: RawSearchRow[]; status?: unknown }>
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
  /** Client-fused RRF score (never a raw BM25 score; G7). */
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
  /** Framework labels for ARRAY_CONTAINS_ANY. */
  frameworks?: readonly string[]
  /** Wake keywords for ARRAY_CONTAINS_ANY. */
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
  /**
   * Floor on the RRF-fused score (NOT a BM25 threshold, G7). Omitted:
   * the FUSED_SCORE_FLOOR default applies; that constant's note states
   * the rule, override semantics (including 0) included.
   */
  minScore?: number
  /** Per-result chunk_text token budget; overrides deps.defaultTokenCap. */
  tokenCap?: number
}

/** Parameters of the Read-intercept exact-section recall. */
export interface ExactSectionRequest {
  /**
   * Vault-relative source_path for the exact-match pass. An ABSOLUTE path
   * (the Read intercept's usual input, a file outside every vault) skips
   * the exact pass: stored source_paths are vault-relative, so equality
   * against it can never match and only the ext/framework fallback applies.
   */
  filePath: string
  /** Extension of that file, e.g. ".tsx"; filters trigger_extensions. */
  ext?: string
  /**
   * File-derived wake tokens: the read file's name parts, directory
   * signals, and import/symbol identifiers (lower-cased, wake-term-
   * shaped; the Read intercept fills them). The fallback leg REQUIRES a
   * stored wake_keywords overlap on these: only chunks whose
   * wake_keywords contain at least one token may answer. Absent, or none
   * usable: the fallback answers [] (no intersection is possible).
   */
  fileTokens?: readonly string[]
  /** Query text (usually the Read result snippet); path when absent. */
  snippet?: string
  /** Sections to return; default RECALL_READ_MAX_SECTIONS. */
  k?: number
  /** Token budget per section; default RECALL_READ_SECTION_TOKENS. */
  sectionTokens?: number
  /**
   * Floor on the RRF-fused score of the fallback leg only (NOT a BM25
   * threshold, G7). Omitted: the READ_FALLBACK_AGREEMENT_FLOOR default
   * applies (see that constant for the joint-rank-1 rule and override
   * semantics). The exact-file leg is never floored (TASK-014).
   */
  minScore?: number
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

/**
 * RRF_RANKER_K and DENSE_SEARCH_EF are the verified fusion and
 * search-knob values from findings §4.2 and radius-tuning-findings
 * §4: RRF fuses the two routes by rank only (so negative BM25 scores
 * never leak into a result, G7), and ef is the HNSW candidate width
 * per dense route. Exported (like SEARCH_OUTPUT_FIELDS) so the
 * scripts/eval harnesses replay the production page from the shipped
 * module instead of restating these values.
 */
export const RRF_RANKER_K = 60
export const DENSE_SEARCH_EF = 64

/**
 * DENSE_SEARCH_RADIUS is the server-side COSINE range cutoff on the
 * standalone dense search: survivors satisfy
 * `radius < score <= range_filter`, radius EXCLUSIVE
 * (radius-tuning-findings §2), so it keeps only scores strictly above
 * 0.78; DENSE_RANGE_MAX is the metric ceiling.
 */
export const DENSE_SEARCH_RADIUS = 0.78
export const DENSE_RANGE_MAX = 1.0

/**
 * SPARSE_SEARCH_RADIUS is the client-side BM25 floor
 * (radius-tuning-findings §3): lite 3.2.2 returns NEGATED relevance
 * scores best-first, so a positive server-side radius would be an
 * upper bound, not a floor. A hit survives when
 * `-score >= SPARSE_SEARCH_RADIUS`; raising it raises required
 * relevancy and has no ceiling.
 *
 * TASK-006 strip-on re-sweep (2026-11-13, docs/research/stopword-
 * strip-findings.md §"Sparse floor re-sweep (TASK-006)"): the old 2.5
 * was INERT on the post-strip page (trimmed 0 of 193 fetched-window
 * candidates; the stop-word strip shifted BM25 mass −15.6%), so it
 * enforced no gate. The sweep knee is 5.0: engaged (trims 19/193),
 * forbidden rows 21 -> 19 (forbidden-rate 0.266 -> 0.250), P@k
 * 0.241 -> 0.250, and label-granularity recall unchanged at 14/22
 * with an identical missed-label set at every grid point. 5.5 trims
 * further (23/193) with zero page movement, so 5.0 is the knee.
 */
export const SPARSE_SEARCH_RADIUS = 5.0

/**
 * SPARSE_QUERY_STOPWORDS is the stop-word list sparseQueryText removes
 * from the BM25 route's query text: stopword's English `eng` (108) plus
 * Chinese `zho` (78) lists (plan answer A2). One module-level constant so
 * the plan Q2 follow-up (add domain terms if the A/B exposes them) is one
 * edit here.
 */
const SPARSE_QUERY_STOPWORDS: readonly string[] = [...eng, ...zho]

// SparseTokenRun tokenizes sparseQueryText's input: one maximal Han run
// per match, otherwise a run of word characters ([\p{L}\p{N}_], Han
// excluded); every other character separates. Han runs stay maximal to
// mirror the default analyzer's index-time tokenization (see the
// sparseQueryText docblock for the settled finding). Kana and Hangul
// count as word characters: their scripts' lists are not in use, so
// those runs pass through whole.
const SPARSE_TOKEN_RUN = /[\p{Script=Han}]+|(?:(?![\p{Script=Han}])[\p{L}\p{N}_])+/gu

/**
 * FUSED_SCORE_FLOOR is the default FUSED-score floor hybridSearch applies
 * when the request carries no minScore (TASK-009 rule, TASK-014 reach,
 * TASK-007 value). THE authoritative statement of the hybridSearch floor
 * rule: other docs here cross-reference this constant by name. The
 * searchExactSections fallback leg's omitted-minScore default is the
 * separate {@link READ_FALLBACK_AGREEMENT_FLOOR} (TASK-009). A
 * single-route hit scores 1/(k + rank), so the inclusive floor at 1/(k+2)
 * keeps its rank 1 and rank 2 and drops rank >= 3. Every both-route hit
 * inside the fetched window clears it: the worst case takes the window's
 * last rank on both routes (limit topK 20 * oversample 2 = 40) and fuses
 * to 2/(60+40) = 0.02 > 1/62. An explicit minScore (including 0) fully
 * overrides the default.
 *
 * TASK-007 live-loop iteration 2 (machinae-game probe 2026-11-13)
 * floored a planted relevant note whose best shape was single-route
 * dense rank 2 (fused 1/62). With the planted notes added to the
 * labeled set, the offline floor sweep knee sits at 1/(k+2):
 * recall-of-labeled 0.625 -> 0.667 and forbidden rows 12 -> 16. One
 * step looser, 1/(k+3), adds zero recall and +8 forbidden rows.
 *
 * TASK-006 re-check on the strip-on page (2026-11-13, re-labeled
 * 22-label set, docs/research/stopword-strip-findings.md §"Fused-floor
 * re-check (TASK-006)"): value re-confirmed. Loosening to 1/(k+3)
 * still adds zero recall and +6 forbidden rows; the only label a
 * looser floor could recover sits at single-route BM25 rank 4 (fused
 * 1/64), so no 1/(k+2)-adjacent value reaches it. Tightening to
 * 1/(k+1) loses no label hit on today's pages (the extra row it cuts
 * is a duplicate chunk of an already-recalled note), but it re-opens
 * the single-route rank-2 floor-out the live-loop probe above caught.
 */
export const FUSED_SCORE_FLOOR = 1 / (RRF_RANKER_K + 2)

/**
 * READ_FALLBACK_AGREEMENT_FLOOR is the omitted-minScore default the
 * searchExactSections fallback leg applies (TASK-009, plan Q3: the
 * literal floor of the offline sweep's "floor > 2/(k+1)
 * (both-routes-only)" row). The math under RRF(k), stated explicitly:
 * a hit fuses to 1/(k + its rank on each route that surfaced it), so a
 * hit ranked 1 on BOTH routes scores exactly 2/(k+1) and passes this
 * inclusive floor, while every other shape falls short: a single-route
 * hit tops out at 1/(k+1) (half the floor), and a both-route hit one
 * rank down anywhere scores at most 1/(k+1) + 1/(k+2). Relevance here
 * therefore means agreement: only the two routes' joint rank-1 hits
 * answer the fallback. fuseRrf stays route-agnostic (no presence
 * tagging); the shape falls out of the score alone.
 *
 * Probe (2026-11-13 replay of docs/research/eval-split-
 * d078-s25-k60.json, 102 returned rows over 17 queries): 7 rows pass
 * the inclusive floor and all 7 sit at fused exactly 2/(k+1), the
 * joint-rank-1 shape; the sweep's looser both-route-presence reading
 * counted 54 rows, which is why the floor value, not a presence flag,
 * encodes the agreement rule.
 */
export const READ_FALLBACK_AGREEMENT_FLOOR = 2 / (RRF_RANKER_K + 1)

/**
 * CANDIDATE_OVERSAMPLE: each route asks for this many times the
 * caller's limit, so dedupe and the minScore floor still leave a full
 * page of results to return.
 */
export const CANDIDATE_OVERSAMPLE = 2

/**
 * BuildFilterExpr renders FilterCriteria into a Milvus scalar expression
 * in fixed clause order (scope, trigger_extensions, trigger_frameworks,
 * wake_keywords, vault, source_path) joined by ` and `, or undefined
 * when no clause applies. Values are double-quoted with backslash and
 * quote escaping. Golden-tested against literal expressions
 * (tests/search.spec.ts); verified filter forms per findings §3 (plus the
 * TASK-061 live correction: the lite 3.2.2 parser accepts ARRAY_CONTAINS
 * and ARRAY_CONTAINS_ANY but NOT the camel-case ARRAY_CONTAINSAny
 * spelling, which fails as `unknown function`):
 * `scope IN [...]`, ARRAY_CONTAINS, ARRAY_CONTAINS_ANY, `==`, `IN`.
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
    clauses.push(`ARRAY_CONTAINS_ANY(${MILVUS_FIELDS.triggerFrameworks}, ${listLiteral(criteria.frameworks)})`)
  }
  if (criteria.wakeKeywords !== undefined && criteria.wakeKeywords.length > 0) {
    clauses.push(`ARRAY_CONTAINS_ANY(${MILVUS_FIELDS.wakeKeywords}, ${listLiteral(criteria.wakeKeywords)})`)
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
 * SparseQueryText renders the query text the BM25 route receives: tokens
 * split on non-word chars (SPARSE_TOKEN_RUN; Han as maximal runs), the
 * {@link SPARSE_QUERY_STOPWORDS} list applied via stopword's
 * case-insensitive match (nothing re-cased here), survivors re-joined with
 * single spaces. Its ONE application point is dispatchRoutes' sparse
 * `data`, covering both hybridSearch and searchExactSections; the dense
 * route keeps the FULL query (the callers embed before dispatch).
 * Fail-open: an all-stop-word or symbols-only query returns the ORIGINAL
 * text; an empty BM25 data string must never reach lite.
 *
 * A Han run is removed only when the WHOLE run is a stop-word entry, so
 * standalone single-character function-word runs (的, 和, 时) still drop
 * as mixed-language noise while word runs (智能体, 记忆) pass through.
 * Settled by the TASK-005 zh probe against the live analyzer
 * (2026-11-13, docs/research/stopword-strip-findings.md §"CJK analyzer
 * open question"): the default Milvus analyzer stores MAXIMAL HAN RUNS
 * on both index and query sides, so the TASK-002 per-codepoint split
 * provably never matched a Han word and the strip destroyed the matching
 * shape (raw `记忆` hit; split `记 忆` returned 0). This docblock is the
 * single home for that rule (TASK-018). Japanese run-shape under the same
 * analyzer is unproven; kana staying word characters carries the same
 * caveat class as the settled Han finding.
 *
 * Exported (like RRF_RANKER_K) so scripts/eval replays production from
 * the shipped module (TASK-004).
 */
export function sparseQueryText(query: string): string {
  const tokens = query.match(SPARSE_TOKEN_RUN) ?? []
  const stripped = removeStopwords(tokens, [...SPARSE_QUERY_STOPWORDS]).join(' ')
  return stripped === '' ? query : stripped
}

/**
 * HybridSearch runs the dense + BM25 two-search dispatch with client-side
 * RRF fusion and returns deduped, budget-cut, registry-resolved results.
 * Offline or error statuses become IndexOfflineError; embedder failures
 * propagate as-is (that is not an index-offline condition).
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
  const rows = await dispatchRoutes(deps, request.query, dense, expr, candidatesFor(topK))

  return flooredSections(deps, rows, tokenCap, topK, request.minScore)
}

/**
 * SearchExactSections serves the Read intercept: with a vault-relative
 * filePath, chunks of that exact file (source_path == filter) come first,
 * unfloored; otherwise (absolute path, or no indexed chunks) a fallback
 * neighborhood search by trigger_extensions (ext), frameworks, and the
 * query text applies the both-route agreement floor
 * ({@link READ_FALLBACK_AGREEMENT_FLOOR}, TASK-009) and REQUIRES the
 * stored wake_keywords to intersect the request's fileTokens (TASK-008):
 * a chunk with no keyword overlap with the file the agent is reading
 * never answers the fallback, and without tokens the leg is skipped and
 * answers empty. Same section budget per result as the main search;
 * offline degrades to IndexOfflineError. Output source_paths are absolute
 * (see toResults).
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

  const exactFilter = isAbsolute(request.filePath)
    ? null
    : buildFilterExpr({
      sourcePath: request.filePath,
      ...(request.vaults !== undefined ? { vaults: request.vaults } : {}),
    })
  // The exact-file leg stays floor-free (TASK-014): a file the agent is
  // reading is relevant by construction, so its chunks keep whatever
  // fused rank the routes give them.
  if (exactFilter !== null) {
    const exactRows = await dispatchRoutes(deps, queryText, dense, exactFilter, candidatesFor(k))
    const exact = topSections(toResults(deps, exactRows, sectionTokens), k)
    if (exact.length > 0) {
      return exact
    }
  }

  // Fallback: a general neighborhood search by ext/framework filters on
  // the query text. Its omitted-minScore default is the both-route
  // agreement floor (TASK-009): only the joint rank-1 of the two routes
  // answers the neighborhood. The wake-keyword intersection is REQUIRED
  // (TASK-008): without fileTokens nothing can intersect, so the leg is
  // skipped and answers empty instead of widening to a token-free
  // neighborhood search.
  const wakeKeywords = fileWakeKeywordsOf(request)
  if (wakeKeywords.length === 0) {
    return []
  }
  const fallbackExpr = fallbackFilterExpr(request, ext, wakeKeywords)
  const fallbackRows = await dispatchRoutes(deps, queryText, dense, fallbackExpr, candidatesFor(k))
  return flooredSections(
    deps,
    fallbackRows,
    sectionTokens,
    k,
    request.minScore ?? READ_FALLBACK_AGREEMENT_FLOOR,
  )
}

// FileWakeKeywordsOf normalizes the request's fileTokens into
// wake_keywords filter values: trailing separators trimmed, blanks
// dropped. Their intersection with stored wake_keywords gates the
// fallback leg (TASK-008).
function fileWakeKeywordsOf(request: ExactSectionRequest): string[] {
  return (request.fileTokens ?? [])
    .map((token) => token.replace(/\/+$/, ''))
    .filter((token) => token !== '')
}

// FallbackFilterExpr renders the neighborhood leg's scalar filter: the
// wake-keyword intersection (always present, TASK-008), the normalized
// ext, frameworks (request plus EXT_FRAMEWORK_HINTS), and vaults.
function fallbackFilterExpr(
  request: ExactSectionRequest,
  ext: string | null,
  wakeKeywords: readonly string[],
): string | undefined {
  const frameworks = [
    ...(request.frameworks ?? []),
    ...(ext === null ? [] : EXT_FRAMEWORK_HINTS[ext] ?? []),
  ]
  // wakeKeywords is always non-empty at the call site (checked before
  // dispatch), so buildFilterExpr never answers undefined here.
  return buildFilterExpr({
    ...(ext === null ? {} : { ext }),
    ...(frameworks.length > 0 ? { frameworks } : {}),
    ...(request.vaults !== undefined ? { vaults: request.vaults } : {}),
    wakeKeywords,
  })
}

// Shared dispatch: two standalone `search` calls, one per route, carrying
// the same candidate limit, filter expr, and G10 projection (one
// hybridSearch cannot carry per-route radii: radius-tuning-findings §4).
// The dense search carries its server-side radius/range_filter plus ef;
// the BM25 search carries no server params and takes its floor
// client-side in sparseSurvivors. The BM25 `data` is the strip's single
// application point (sparseQueryText, TASK-002); queryText itself stays
// untouched because the caller already embedded the FULL text for the
// dense route.
async function dispatchRoutes(
  deps: SearchDependencies,
  queryText: string,
  denseVector: number[],
  expr: string | undefined,
  candidateLimit: number,
): Promise<RawSearchRow[]> {
  const shared = {
    collection_name: collectionOf(deps),
    limit: candidateLimit,
    ...(expr === undefined ? {} : { expr }),
    output_fields: [...SEARCH_OUTPUT_FIELDS],
    // The collection declares the same level at create (schema.ts) and lite
    // writes are read-back immediate; asking per read keeps it explicit.
    consistency_level: MILVUS_CONSISTENCY_LEVEL,
  }
  const [denseHits, sparseHits] = await Promise.all([
    callMilvus('search', () => deps.client.search({
      ...shared,
      anns_field: MILVUS_FIELDS.denseVector,
      data: [denseVector],
      metric_type: MetricType.COSINE,
      params: {
        ef: DENSE_SEARCH_EF,
        radius: DENSE_SEARCH_RADIUS,
        range_filter: DENSE_RANGE_MAX,
      },
    })),
    callMilvus('search', () => deps.client.search({
      ...shared,
      anns_field: MILVUS_FIELDS.sparseVector,
      data: [sparseQueryText(queryText)],
      metric_type: MetricType.BM25,
      params: {},
    })),
  ])
  return fuseRrf(denseHits.results ?? [], sparseSurvivors(sparseHits.results ?? []))
}

// SparseSurvivors applies the BM25 floor CLIENT-side: lite's BM25 scores
// are negated relevancy ordered best-first, and the server-side radius
// cannot express a relevancy floor (radius-tuning-findings §3). A hit
// survives when `-score >= SPARSE_SEARCH_RADIUS`; a row without a score
// drops (fail closed).
function sparseSurvivors(rows: readonly RawSearchRow[]): RawSearchRow[] {
  return rows.filter((row) => -Number(row.score ?? Number.NaN) >= SPARSE_SEARCH_RADIUS)
}

// FuseRrf merges the cutoff-surviving route rows with the RRF formula
// lite itself uses: 1/(k + rank) summed per route, rank from 1
// (radius-tuning-findings §4). Fields come from the first-seen row
// (dense route first); the order is deterministic: fused score desc,
// then chunk_id asc.
function fuseRrf(
  dense: readonly RawSearchRow[],
  sparse: readonly RawSearchRow[],
): RawSearchRow[] {
  const fused = new Map<number, { chunkId: number; row: RawSearchRow; score: number }>()
  for (const route of [dense, sparse]) {
    route.forEach((row, index) => {
      const chunkId = Number(row[MILVUS_FIELDS.chunkId])
      const entry = fused.get(chunkId) ?? { chunkId, row, score: 0 }
      entry.score += 1 / (RRF_RANKER_K + index + 1)
      fused.set(chunkId, entry)
    })
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.chunkId - b.chunkId)
    .map((entry) => ({ ...entry.row, score: entry.score }))
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
    const stored = String(row[MILVUS_FIELDS.sourcePath] ?? '')
    return {
      chunk_id: Number(row[MILVUS_FIELDS.chunkId] ?? 0),
      // Storage keeps source_path vault-RELATIVE (portable vaults, hashed
      // chunk ids); every agent-facing surface takes ABSOLUTE paths
      // (memory_read resolves only those, <recalled_memory source=...>
      // carries them), so re-anchor on read.
      source_path: stored === '' || vault === '' || isAbsolute(stored)
        ? stored
        : join(vault, stored),
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

// flooredSections is the shared page shape of every floored dispatch
// leg: shape the rows, cut those under the effective fused-score floor
// (request minScore, else FUSED_SCORE_FLOOR), then topSections. Raw
// BM25 route scores never reach the comparison (G7); what the floor
// keeps is stated on FUSED_SCORE_FLOOR.
function flooredSections(
  deps: SearchDependencies,
  rows: readonly RawSearchRow[],
  tokenCap: number,
  limit: number,
  minScore: number | undefined,
): MemorySearchResult[] {
  const scoreFloor = minScore ?? FUSED_SCORE_FLOOR
  const scored = toResults(deps, rows, tokenCap).filter((result) => result.score >= scoreFloor)
  return topSections(scored, limit)
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

// topSections is the one shaping order every dispatch ends on: dedupe
// to one row per logical section first (same file + same section
// header is one logical section that long-chunk splitting or the two
// routes both surfaced: keep the highest score), then cut to the
// caller's limit.
function topSections(
  results: readonly MemorySearchResult[],
  limit: number,
): MemorySearchResult[] {
  const best = new Map<string, MemorySearchResult>()
  for (const result of [...results].sort((a, b) => b.score - a.score)) {
    const key = `${result.source_path}\u0000${result.section_header}`
    if (!best.has(key)) {
      best.set(key, result)
    }
  }
  return [...best.values()].slice(0, limit)
}

function truncateToTokens(text: string, tokens: number): string {
  const capChars = approxCharsForTokens(tokens)
  return text.length <= capChars ? text : text.slice(0, capChars)
}

function clampTopK(value: number | undefined): number {
  const wanted = value === undefined || !Number.isFinite(value) ? SEARCH_DEFAULT_TOP_K : Math.trunc(value)
  return clampInt(wanted, 1, SEARCH_MAX_RESULTS)
}

function quoteExpr(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function listLiteral(values: readonly string[]): string {
  return `[${values.map(quoteExpr).join(', ')}]`
}
