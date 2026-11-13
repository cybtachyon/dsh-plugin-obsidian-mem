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
import type { VaultMode } from '../../core/lib/index.js';
import type { Embedder } from './embedder.js';
/**
 * SEARCH_OUTPUT_FIELDS is the projection every search dispatches:
 * chunk_id (the PK, G10) first, then the columns the result row and the
 * ui/audit display read. Never trimmed per call.
 */
export declare const SEARCH_OUTPUT_FIELDS: readonly string[];
/**
 * SearchRouteDispatch is one standalone route `search` this module
 * dispatches: dense (vector data) or sparse (stop-word-stripped query
 * text data, see sparseQueryText).
 */
export interface SearchRouteDispatch {
    collection_name: string;
    anns_field: string;
    data: unknown[];
    limit: number;
    metric_type: string;
    /** Per-route scalar filter; the same expr rides both searches. */
    expr?: string;
    params: Record<string, unknown>;
    output_fields: string[];
    consistency_level?: string;
}
/** Raw row shape: lite returns one object per hit with score included. */
export type RawSearchRow = Record<string, unknown>;
/** The client slice search needs; MilvusClient satisfies it structurally. */
export interface SearchMilvus {
    count(request: {
        collection_name: string;
    }): Promise<{
        data?: number;
        status?: unknown;
    }>;
    search(request: SearchRouteDispatch): Promise<{
        results?: RawSearchRow[];
        status?: unknown;
    }>;
}
/** Thrown when Milvus cannot answer; callers degrade quietly (typed). */
export declare class IndexOfflineError extends Error {
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** One scored, deduped, budget-cut memory result. */
export interface MemorySearchResult {
    chunk_id: number;
    source_path: string;
    section_header: string;
    chunk_text: string;
    scope: string;
    vault: string;
    /** Vault access mode from the injected registry lookup; null when unknown. */
    mode: VaultMode | null;
    updated_at: number;
    /** Client-fused RRF score (never a raw BM25 score; G7). */
    score: number;
}
/** Search-side dependencies; everything external is injected. */
export interface SearchDependencies {
    client: SearchMilvus;
    embedder: Embedder;
    collectionName?: string;
    /** Vault-registry lookup: vault path -> access mode. */
    vaultModeFor?: (vault: string) => VaultMode | undefined;
    /** Per-result chunk_text budget; default RECALL_READ_SECTION_TOKENS. */
    defaultTokenCap?: number;
}
/** Filter inputs the shared expression builder turns into a scalar expr. */
export interface FilterCriteria {
    /** Named scopes or project slugs; prunes via the partition key. */
    scopes?: readonly string[];
    /** Vault paths; prunes via the vault scalar. */
    vaults?: readonly string[];
    /** Single trigger extension (".ts"); normalized defensively. */
    ext?: string;
    /** Framework labels for ARRAY_CONTAINS_ANY. */
    frameworks?: readonly string[];
    /** Wake keywords for ARRAY_CONTAINS_ANY. */
    wakeKeywords?: readonly string[];
    /** Exact source_path equality (the Read intercept's file). */
    sourcePath?: string;
}
/** Parameters of a hybrid memory search. */
export interface SearchRequest {
    query: string;
    ext?: string;
    frameworks?: readonly string[];
    wakeKeywords?: readonly string[];
    scopes?: readonly string[];
    vaults?: readonly string[];
    /** Result count; default SEARCH_DEFAULT_TOP_K, cap SEARCH_MAX_RESULTS. */
    topK?: number;
    /**
     * Floor on the RRF-fused score (NOT a BM25 threshold, G7). Omitted:
     * the FUSED_SCORE_FLOOR default applies; that constant's note states
     * the rule, override semantics (including 0) included.
     */
    minScore?: number;
    /** Per-result chunk_text token budget; overrides deps.defaultTokenCap. */
    tokenCap?: number;
}
/** Parameters of the Read-intercept exact-section recall. */
export interface ExactSectionRequest {
    /**
     * Vault-relative source_path for the exact-match pass. An ABSOLUTE path
     * (the Read intercept's usual input, a file outside every vault) skips
     * the exact pass: stored source_paths are vault-relative, so equality
     * against it can never match and only the ext/framework fallback applies.
     */
    filePath: string;
    /** Extension of that file, e.g. ".tsx"; filters trigger_extensions. */
    ext?: string;
    /**
     * File-derived wake tokens: the read file's name parts, directory
     * signals, and import/symbol identifiers (lower-cased, wake-term-
     * shaped; the Read intercept fills them). The fallback leg REQUIRES a
     * stored wake_keywords overlap on these: only chunks whose
     * wake_keywords contain at least one token may answer. Absent, or none
     * usable: the fallback answers [] (no intersection is possible).
     */
    fileTokens?: readonly string[];
    /** Query text (usually the Read result snippet); path when absent. */
    snippet?: string;
    /** Sections to return; default RECALL_READ_MAX_SECTIONS. */
    k?: number;
    /** Token budget per section; default RECALL_READ_SECTION_TOKENS. */
    sectionTokens?: number;
    /**
     * Floor on the RRF-fused score of the fallback leg only (NOT a BM25
     * threshold, G7). Omitted: the READ_FALLBACK_AGREEMENT_FLOOR default
     * applies (see that constant for the joint-rank-1 rule and override
     * semantics). The exact-file leg is never floored (TASK-014).
     */
    minScore?: number;
    /** Explicit framework filter for the fallback route. */
    frameworks?: readonly string[];
    /** Restrict to these vaults. */
    vaults?: readonly string[];
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
export declare const RRF_RANKER_K = 60;
export declare const DENSE_SEARCH_EF = 64;
/**
 * DENSE_SEARCH_RADIUS is the server-side COSINE range cutoff on the
 * standalone dense search: survivors satisfy
 * `radius < score <= range_filter`, radius EXCLUSIVE
 * (radius-tuning-findings §2), so it keeps only scores strictly above
 * 0.78; DENSE_RANGE_MAX is the metric ceiling.
 */
export declare const DENSE_SEARCH_RADIUS = 0.78;
export declare const DENSE_RANGE_MAX = 1;
/**
 * SPARSE_SEARCH_RADIUS is the client-side BM25 floor
 * (radius-tuning-findings §3): lite 3.2.2 returns NEGATED relevance
 * scores best-first, so a positive server-side radius would be an
 * upper bound, not a floor. A hit survives when
 * `-score >= SPARSE_SEARCH_RADIUS`; raising it raises required
 * relevancy and has no ceiling.
 */
export declare const SPARSE_SEARCH_RADIUS = 2.5;
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
 */
export declare const FUSED_SCORE_FLOOR: number;
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
export declare const READ_FALLBACK_AGREEMENT_FLOOR: number;
/**
 * CANDIDATE_OVERSAMPLE: each route asks for this many times the
 * caller's limit, so dedupe and the minScore floor still leave a full
 * page of results to return.
 */
export declare const CANDIDATE_OVERSAMPLE = 2;
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
export declare function buildFilterExpr(criteria: FilterCriteria): string | undefined;
/**
 * SparseQueryText renders the query text the BM25 route receives: tokens
 * split on non-word chars (SPARSE_TOKEN_RUN; Han per codepoint), the
 * {@link SPARSE_QUERY_STOPWORDS} list applied via stopword's
 * case-insensitive match (nothing re-cased here), survivors re-joined with
 * single spaces. Its ONE application point is dispatchRoutes' sparse
 * `data`, covering both hybridSearch and searchExactSections; the dense
 * route keeps the FULL query (the callers embed before dispatch).
 * Fail-open: an all-stop-word or symbols-only query returns the ORIGINAL
 * text; an empty BM25 data string must never reach lite.
 *
 * Recorded choice (TASK-002, plan A2): CJK runs are split into single
 * codepoints and re-joined with single spaces so the 78 single-character
 * `zho` entries can fire. OPEN QUESTION for the TASK-005 A/B: whether
 * those re-joined codepoints still match what the analyzer produced at
 * index time (schema.ts enables the default analyzer, no jieba); if they
 * provably cannot, keep CJK text UNSTRIPPED (fail-open) and document that
 * `zho` only guards mixed-language noise.
 *
 * Exported (like RRF_RANKER_K) so scripts/eval replays production from
 * the shipped module (TASK-004).
 */
export declare function sparseQueryText(query: string): string;
/**
 * HybridSearch runs the dense + BM25 two-search dispatch with client-side
 * RRF fusion and returns deduped, budget-cut, registry-resolved results.
 * Offline or error statuses become IndexOfflineError; embedder failures
 * propagate as-is (that is not an index-offline condition).
 */
export declare function hybridSearch(deps: SearchDependencies, request: SearchRequest): Promise<MemorySearchResult[]>;
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
export declare function searchExactSections(deps: SearchDependencies, request: ExactSectionRequest): Promise<MemorySearchResult[]>;
//# sourceMappingURL=search.d.ts.map
