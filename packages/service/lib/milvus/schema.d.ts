/**
 * Schema builds the `obsidian_mem` Milvus collection parameters as pure
 * JSON assembly (unit-testable without a server) and provides the
 * idempotent ensureCollection/dropCollection/rebuildCollection flow.
 *
 * Every field, type, and index here was verified on milvus-lite 3.2.2
 * driven by @zilliz/milvus2-sdk-node 3.0.6 (findings §3): partition key +
 * num_partitions, Array<VarChar> with ARRAY_CONTAINS, enable_analyzer +
 * BM25 Function into SparseFloatVector, HNSW/COSINE and
 * SPARSE_INVERTED_INDEX/BM25. The SDK resolves on server errors, so every
 * call runs through assertOk.
 * @module dsh-plugin-obsidian-mem/service/milvus/schema
 */
import { type CreateIndexRequest, type CreateCollectionWithFieldsReq, type DescribeCollectionResponse, type MilvusClient } from '@zilliz/milvus2-sdk-node';
/** BM25 function name inside the collection. */
export declare const BM25_FUNCTION_NAME = "bm25";
/** Result of ensureCollection: what happened to the collection. */
export interface EnsureCollectionResult {
    /** True when this call created the collection. */
    created: boolean;
    /**
     * True when an existing collection's stored width (or BM25 sparse field)
     * does not match the configured dim. ensureCollection never drops data by
     * itself: dropping is the caller's (indexer, TASK-023) decision because a
     * dim flip that then fails to re-index would lose more than a held stale
     * collection. Use rebuildCollection to drop + re-create.
     */
    needsRebuild: boolean;
    /** Width of the stored dense_vector field, or null when absent. */
    storedDim: number | null;
}
/** Options for ensureCollection/rebuildCollection. */
export interface SchemaOptions {
    /** Dense vector width; default VECTOR_DIM_DEFAULT (384, e5-small). */
    dim?: number;
    /** Collection name; default MILVUS_COLLECTION. */
    collectionName?: string;
}
/**
 * CreateCollectionParams assembles the full createCollection request for
 * the given dense width: Int64 PK, scalar VarChars, scope as partition
 * key, three Array<VarChar> fields, FloatVector(dim), the BM25 Function
 * feeding SparseFloatVector, enable_dynamic_field, Strong consistency,
 * and num_partitions 16.
 */
export declare function createCollectionParams(dim?: number, collectionName?: string): CreateCollectionWithFieldsReq;
/**
 * IndexParams lists the four index requests for the collection: dense
 * HNSW/COSINE, sparse SPARSE_INVERTED_INDEX/BM25 (the metric_type must be
 * explicit or lite rejects sparse queries, findings G3), and INVERTED on
 * the vault/scope scalars used as filters. DISKANN is deliberately absent:
 * lite records the type but does not honor it (findings §3).
 */
export declare function indexParams(collectionName?: string): CreateIndexRequest[];
/**
 * EnsureCollection creates the collection idempotently: create + all
 * indexes + loadCollectionSync when absent (getLoadState reports Loaded
 * for never-loaded collections, so never gate on it, findings G5); when it
 * exists, describe it, report dim drift as needsRebuild without touching
 * data, and re-run loadCollectionSync so a server restart (which persists
 * the collection in state 'released') is search-ready after ensure.
 */
export declare function ensureCollection(client: MilvusClient, options?: SchemaOptions): Promise<EnsureCollectionResult>;
/** DropCollection removes the collection (bare ResStatus, assertOk applies). */
export declare function dropCollection(client: MilvusClient, collectionName?: string): Promise<void>;
/**
 * RebuildCollection drops and re-creates: the dim-drift answer. Data is
 * rebuildable from the vaults (the indexer re-inserts), which is why this
 * is allowed to be destructive only when the caller invokes it.
 */
export declare function rebuildCollection(client: MilvusClient, options?: SchemaOptions): Promise<EnsureCollectionResult>;
/** StoredDenseDim reads the dense_vector width out of a describe response. */
export declare function storedDenseDim(described: DescribeCollectionResponse): number | null;
//# sourceMappingURL=schema.d.ts.map
