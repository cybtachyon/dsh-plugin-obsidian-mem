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
import type { VaultMode } from '../../core/lib/index.js';
import type { Embedder } from './embedder.js';
/**
 * SEARCH_OUTPUT_FIELDS is the projection every search dispatches:
 * chunk_id (the PK, G10) first, then the columns the result row and the
 * ui/audit display read. Never trimmed per call.
 */
export declare const SEARCH_OUTPUT_FIELDS: readonly string[];
/** One sub-request inside hybridSearch `data[]`. */
export interface HybridRoute {
    anns_field: string;
    data: unknown[];
    limit: number;
    metric_type: string;
    /** Per-route scalar filter; the verified lite shape (§4.2). */
    expr?: string;
    params?: Record<string, unknown>;
}
/** The hybridSearch request this module dispatches. */
export interface HybridSearchDispatch {
    collection_name: string;
    data: HybridRoute[];
    rerank: unknown;
    limit: number;
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
    hybridSearch(request: HybridSearchDispatch): Promise<{
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
    /** RRF-fused score (never a raw BM25 score; G7). */
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
    /** Floor on the RRF-fused score (NOT a BM25 threshold, G7). */
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
    /** Workspace directory signals ("src/"); wake-keyword fallback only. */
    dirSignals?: readonly string[];
    /** Query text (usually the Read result snippet); path when absent. */
    snippet?: string;
    /** Sections to return; default RECALL_READ_MAX_SECTIONS. */
    k?: number;
    /** Token budget per section; default RECALL_READ_SECTION_TOKENS. */
    sectionTokens?: number;
    /** Explicit framework filter for the fallback route. */
    frameworks?: readonly string[];
    /** Restrict to these vaults. */
    vaults?: readonly string[];
}
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
 * HybridSearch runs the dense + BM25 hybrid dispatch and returns
 * deduped, budget-cut, registry-resolved results. Offline or error
 * statuses become IndexOfflineError; embedder failures propagate as-is
 * (that is not an index-offline condition).
 */
export declare function hybridSearch(deps: SearchDependencies, request: SearchRequest): Promise<MemorySearchResult[]>;
/**
 * SearchExactSections serves the Read intercept: with a vault-relative
 * filePath, chunks of that exact file (source_path == filter) come first;
 * otherwise (absolute path, or no indexed chunks) a fallback search by
 * trigger_extensions (ext), frameworks, and the query text. Same section
 * budget per result as the main search; offline degrades to
 * IndexOfflineError. Output source_paths are absolute (see toResults).
 */
export declare function searchExactSections(deps: SearchDependencies, request: ExactSectionRequest): Promise<MemorySearchResult[]>;
//# sourceMappingURL=search.d.ts.map
