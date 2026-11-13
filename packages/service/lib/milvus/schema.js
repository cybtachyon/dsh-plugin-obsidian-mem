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
import { DataType, FunctionType, IndexType, MetricType, } from '@zilliz/milvus2-sdk-node';
import { MILVUS_ARRAY_CAPACITIES, MILVUS_ARRAY_ELEMENT_MAX_LENGTHS, MILVUS_COLLECTION, MILVUS_CONSISTENCY_LEVEL, MILVUS_FIELDS, MILVUS_SCALAR_MAX_LENGTHS, VECTOR_DIM_DEFAULT, } from '../../../core/lib/index.js';
import { assertOk } from './ok.js';
/** BM25 function name inside the collection. */
export const BM25_FUNCTION_NAME = 'bm25';
// HNSW build params verified in findings §4.2; the index is small
// (personal vaults), so favor recall over build speed.
const HNSW_PARAMS = { M: 16, efConstruction: 200 };
// Partition key on scope with dynamic slug values + num_partitions was
// verified working on lite (findings §3 "partition key ... dynamic values").
const NUM_PARTITIONS = 16;
/**
 * CreateCollectionParams assembles the full createCollection request for
 * the given dense width: Int64 PK, scalar VarChars, scope as partition
 * key, three Array<VarChar> fields, FloatVector(dim), the BM25 Function
 * feeding SparseFloatVector, enable_dynamic_field, Strong consistency,
 * and num_partitions 16.
 */
export function createCollectionParams(dim = VECTOR_DIM_DEFAULT, collectionName = MILVUS_COLLECTION) {
    return {
        collection_name: collectionName,
        description: 'obsidian-mem memory chunks (TASK-022 schema)',
        enable_dynamic_field: true,
        // MILVUS_CONSISTENCY_LEVEL is pinned here and on every read (search.ts):
        // SDK 3.0.6 has no client-level consistency setting, and the constant
        // holds the name string the SDK maps (not the numeric enum).
        consistency_level: MILVUS_CONSISTENCY_LEVEL,
        num_partitions: NUM_PARTITIONS,
        fields: [
            // 53-bit-safe ids from core/idhash; never autoID (we key by content).
            {
                name: MILVUS_FIELDS.chunkId,
                data_type: DataType.Int64,
                is_primary_key: true,
                autoID: false,
            },
            {
                name: MILVUS_FIELDS.sourcePath,
                data_type: DataType.VarChar,
                max_length: MILVUS_SCALAR_MAX_LENGTHS.sourcePath,
            },
            {
                name: MILVUS_FIELDS.sectionHeader,
                data_type: DataType.VarChar,
                max_length: MILVUS_SCALAR_MAX_LENGTHS.sectionHeader,
            },
            // BM25 text source. Choice recorded here: lite supports the BM25
            // Function, so chunk_text carries the analyzer and the client-side
            // keyword-scoring fallback is NOT needed. lite accepts TEXT_MATCH
            // with enable_analyzer alone (no enable_match, findings §3).
            {
                name: MILVUS_FIELDS.chunkText,
                data_type: DataType.VarChar,
                max_length: MILVUS_SCALAR_MAX_LENGTHS.chunkText,
                enable_analyzer: true,
            },
            {
                name: MILVUS_FIELDS.vault,
                data_type: DataType.VarChar,
                max_length: MILVUS_SCALAR_MAX_LENGTHS.vault,
            },
            {
                name: MILVUS_FIELDS.scope,
                data_type: DataType.VarChar,
                max_length: MILVUS_SCALAR_MAX_LENGTHS.scope,
                is_partition_key: true,
            },
            {
                name: MILVUS_FIELDS.triggerExtensions,
                data_type: DataType.Array,
                element_type: DataType.VarChar,
                max_capacity: MILVUS_ARRAY_CAPACITIES.triggerExtensions,
                max_length: MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.triggerExtensions,
            },
            {
                name: MILVUS_FIELDS.triggerFrameworks,
                data_type: DataType.Array,
                element_type: DataType.VarChar,
                max_capacity: MILVUS_ARRAY_CAPACITIES.triggerFrameworks,
                max_length: MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.triggerFrameworks,
            },
            {
                name: MILVUS_FIELDS.wakeKeywords,
                data_type: DataType.Array,
                element_type: DataType.VarChar,
                max_capacity: MILVUS_ARRAY_CAPACITIES.wakeKeywords,
                max_length: MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.wakeKeywords,
            },
            {
                name: MILVUS_FIELDS.denseVector,
                data_type: DataType.FloatVector,
                dim,
            },
            // Function output; the BM25 Function fills it from chunk_text at
            // insert time, so inserts must never send this field.
            {
                name: MILVUS_FIELDS.sparseVector,
                data_type: DataType.SparseFloatVector,
            },
            {
                name: MILVUS_FIELDS.updatedAt,
                data_type: DataType.Int64,
            },
        ],
        functions: [
            {
                name: BM25_FUNCTION_NAME,
                type: FunctionType.BM25,
                input_field_names: [MILVUS_FIELDS.chunkText],
                output_field_names: [MILVUS_FIELDS.sparseVector],
                params: {},
            },
        ],
    };
}
/**
 * IndexParams lists the four index requests for the collection: dense
 * HNSW/COSINE, sparse SPARSE_INVERTED_INDEX/BM25 (the metric_type must be
 * explicit or lite rejects sparse queries, findings G3), and INVERTED on
 * the vault/scope scalars used as filters. DISKANN is deliberately absent:
 * lite records the type but does not honor it (findings §3).
 */
export function indexParams(collectionName = MILVUS_COLLECTION) {
    return [
        {
            collection_name: collectionName,
            field_name: MILVUS_FIELDS.denseVector,
            index_type: IndexType.HNSW,
            metric_type: MetricType.COSINE,
            params: { ...HNSW_PARAMS },
        },
        {
            collection_name: collectionName,
            field_name: MILVUS_FIELDS.sparseVector,
            index_type: IndexType.SPARSE_INVERTED_INDEX,
            // The sparse metric must match what search will ask for (G3); the
            // field only ever answers BM25.
            metric_type: MetricType.BM25,
        },
        {
            collection_name: collectionName,
            field_name: MILVUS_FIELDS.vault,
            index_type: IndexType.INVERTED,
        },
        {
            collection_name: collectionName,
            field_name: MILVUS_FIELDS.scope,
            index_type: IndexType.INVERTED,
        },
    ];
}
/**
 * EnsureCollection creates the collection idempotently: create + all
 * indexes + loadCollectionSync when absent (getLoadState reports Loaded
 * for never-loaded collections, so never gate on it, findings G5); when it
 * exists, describe it, report dim drift as needsRebuild without touching
 * data, and re-run loadCollectionSync so a server restart (which persists
 * the collection in state 'released') is search-ready after ensure.
 */
export async function ensureCollection(client, options = {}) {
    const dim = options.dim ?? VECTOR_DIM_DEFAULT;
    const collectionName = options.collectionName ?? MILVUS_COLLECTION;
    const exists = assertOk(await client.hasCollection({ collection_name: collectionName }), 'hasCollection').value;
    if (!exists) {
        assertOk(await client.createCollection(createCollectionParams(dim, collectionName)), 'createCollection');
        for (const index of indexParams(collectionName)) {
            assertOk(await client.createIndex(index), `createIndex ${String(index.field_name)}`);
        }
        assertOk(await client.loadCollectionSync({ collection_name: collectionName }), 'loadCollectionSync');
        return { created: true, needsRebuild: false, storedDim: dim };
    }
    const described = assertOk(await client.describeCollection({ collection_name: collectionName }), 'describeCollection');
    const storedDim = storedDenseDim(described);
    const sparseMissing = !described.schema.fields.some((field) => field.name === MILVUS_FIELDS.sparseVector);
    const needsRebuild = storedDim !== dim || sparseMissing;
    if (!needsRebuild) {
        // A persisted lite 3.x collection comes back in state 'released' in a
        // new server process; search/get fail until load. getLoadState lies
        // (findings G5), so re-load unconditionally: loadCollectionSync on an
        // already-loaded collection is a no-op success (live-verified).
        assertOk(await client.loadCollectionSync({ collection_name: collectionName }), 'loadCollectionSync');
    }
    return { created: false, needsRebuild, storedDim };
}
/** DropCollection removes the collection (bare ResStatus, assertOk applies). */
export async function dropCollection(client, collectionName = MILVUS_COLLECTION) {
    assertOk(await client.dropCollection({ collection_name: collectionName }), 'dropCollection');
}
/**
 * RebuildCollection drops and re-creates: the dim-drift answer. Data is
 * rebuildable from the vaults (the indexer re-inserts), which is why this
 * is allowed to be destructive only when the caller invokes it.
 */
export async function rebuildCollection(client, options = {}) {
    const collectionName = options.collectionName ?? MILVUS_COLLECTION;
    await dropCollection(client, collectionName);
    return await ensureCollection(client, options);
}
/** StoredDenseDim reads the dense_vector width out of a describe response. */
export function storedDenseDim(described) {
    const dense = described.schema.fields.find((field) => field.name === MILVUS_FIELDS.denseVector);
    if (!dense) {
        return null;
    }
    const dim = Number(dense.dim);
    return Number.isInteger(dim) && dim > 0 ? dim : null;
}
//# sourceMappingURL=schema.js.map
