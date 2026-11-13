import { DataType, FunctionType, type MilvusClient } from '@zilliz/milvus2-sdk-node'
import { describe, expect, it } from 'vitest'

import { MILVUS_COLLECTION, MILVUS_FIELDS, VECTOR_DIM_DEFAULT } from '../../core/lib/index.js'
import {
  BM25_FUNCTION_NAME,
  createCollectionParams,
  dropCollection,
  ensureCollection,
  indexParams,
  rebuildCollection,
} from '../src/milvus/schema.ts'
import { assertOk } from '../src/milvus/ok.ts'

/**
 * Pure-tier tests for the collection schema: exact builder JSON against
 * the TASK-022 table, ensureCollection call sequencing against a stub
 * client, dim-drift/rebuild detection, and the shared assertOk guard.
 */

interface StubClientOptions {
  exists?: boolean
  denseDim?: number | null
  hasSparse?: boolean
  failOn?: string
}

interface StubCall {
  method: string
  payload?: Record<string, unknown>
}

/** StubClient builds a MilvusClient-shaped fake that records the calls. */
function stubClient(options: StubClientOptions = {}) {
  const calls: StubCall[] = []
  const exists = options.exists ?? false
  const denseDim = options.denseDim === undefined ? VECTOR_DIM_DEFAULT : options.denseDim
  const hasSparse = options.hasSparse ?? true
  const ok = { error_code: 'Success', code: 0, reason: '' }
  const failure = { error_code: 'ServerError', code: 7, reason: 'stubbed failure' }
  const result = (method: string, status: unknown) =>
    options.failOn === method ? status : ok

  const client = {
    async hasCollection(payload: { collection_name: string }) {
      calls.push({ method: 'hasCollection', payload: { ...payload } })
      return { status: result('hasCollection', failure), value: exists }
    },
    async createCollection(payload: Record<string, unknown>) {
      calls.push({ method: 'createCollection', payload })
      // createCollection resolves to a BARE ResStatus (findings G2).
      return result('createCollection', failure)
    },
    async createIndex(payload: Record<string, unknown>) {
      calls.push({ method: 'createIndex', payload })
      return result('createIndex', failure)
    },
    async loadCollectionSync(payload: { collection_name: string }) {
      calls.push({ method: 'loadCollectionSync', payload: { ...payload } })
      return result('loadCollectionSync', failure)
    },
    async describeCollection(payload: { collection_name: string }) {
      calls.push({ method: 'describeCollection', payload: { ...payload } })
      if (options.failOn === 'describeCollection') {
        return { status: failure, schema: { fields: [] } }
      }
      const fields: Array<Record<string, unknown>> = []
      if (denseDim !== null) {
        fields.push({ name: MILVUS_FIELDS.denseVector, dim: denseDim })
      }
      if (hasSparse) {
        fields.push({ name: MILVUS_FIELDS.sparseVector })
      }
      return { status: ok, schema: { fields } }
    },
    async dropCollection(payload: { collection_name: string }) {
      calls.push({ method: 'dropCollection', payload: { ...payload } })
      return result('dropCollection', failure)
    },
  }
  return { client: client as unknown as MilvusClient, calls }
}

function fieldByName(params: { fields: Array<Record<string, unknown> & { name: string }> }, name: string) {
  const field = params.fields.find((candidate) => candidate.name === name)
  if (!field) {
    throw new Error(`field ${name} missing`)
  }
  return field
}

describe('createCollectionParams', () => {
  it('matches the TASK-022 field table exactly', () => {
    const params = createCollectionParams(384)

    expect(params.collection_name).toBe(MILVUS_COLLECTION)
    expect(params.enable_dynamic_field).toBe(true)
    expect(params.consistency_level).toBe('Strong')
    expect(params.num_partitions).toBe(16)

    expect(params.fields.map((field) => field.name)).toEqual([
      MILVUS_FIELDS.chunkId,
      MILVUS_FIELDS.sourcePath,
      MILVUS_FIELDS.sectionHeader,
      MILVUS_FIELDS.chunkText,
      MILVUS_FIELDS.vault,
      MILVUS_FIELDS.scope,
      MILVUS_FIELDS.triggerExtensions,
      MILVUS_FIELDS.triggerFrameworks,
      MILVUS_FIELDS.wakeKeywords,
      MILVUS_FIELDS.denseVector,
      MILVUS_FIELDS.sparseVector,
      MILVUS_FIELDS.updatedAt,
    ])

    expect(fieldByName(params, MILVUS_FIELDS.chunkId)).toMatchObject({
      data_type: DataType.Int64,
      is_primary_key: true,
      autoID: false,
    })
    expect(fieldByName(params, MILVUS_FIELDS.sourcePath)).toMatchObject({
      data_type: DataType.VarChar,
      max_length: 1024,
    })
    expect(fieldByName(params, MILVUS_FIELDS.sectionHeader)).toMatchObject({
      data_type: DataType.VarChar,
      max_length: 512,
    })
    expect(fieldByName(params, MILVUS_FIELDS.chunkText)).toMatchObject({
      data_type: DataType.VarChar,
      max_length: 65_535,
      enable_analyzer: true,
    })
    expect(fieldByName(params, MILVUS_FIELDS.vault)).toMatchObject({
      data_type: DataType.VarChar,
      max_length: 256,
    })
    expect(fieldByName(params, MILVUS_FIELDS.scope)).toMatchObject({
      data_type: DataType.VarChar,
      max_length: 64,
      is_partition_key: true,
    })
    expect(fieldByName(params, MILVUS_FIELDS.triggerExtensions)).toMatchObject({
      data_type: DataType.Array,
      element_type: DataType.VarChar,
      max_capacity: 64,
      max_length: 32,
    })
    expect(fieldByName(params, MILVUS_FIELDS.triggerFrameworks)).toMatchObject({
      data_type: DataType.Array,
      element_type: DataType.VarChar,
      max_capacity: 64,
      max_length: 64,
    })
    expect(fieldByName(params, MILVUS_FIELDS.wakeKeywords)).toMatchObject({
      data_type: DataType.Array,
      element_type: DataType.VarChar,
      max_capacity: 96,
      max_length: 64,
    })
    expect(fieldByName(params, MILVUS_FIELDS.denseVector)).toMatchObject({
      data_type: DataType.FloatVector,
      dim: 384,
    })
    expect(fieldByName(params, MILVUS_FIELDS.sparseVector)).toMatchObject({
      data_type: DataType.SparseFloatVector,
    })
    expect(fieldByName(params, MILVUS_FIELDS.updatedAt)).toMatchObject({
      data_type: DataType.Int64,
    })

    // Only scope carries the partition key; no stray partition flags.
    const partitionKeys = params.fields.filter((field) => field.is_partition_key)
    expect(partitionKeys.map((field) => field.name)).toEqual([MILVUS_FIELDS.scope])
  })

  it('wires the BM25 Function from chunk_text to the sparse field', () => {
    const params = createCollectionParams()

    expect(params.functions).toEqual([
      {
        name: BM25_FUNCTION_NAME,
        type: FunctionType.BM25,
        input_field_names: [MILVUS_FIELDS.chunkText],
        output_field_names: [MILVUS_FIELDS.sparseVector],
        params: {},
      },
    ])
  })

  it('defaults the dense width to the 384-d e5-small width', () => {
    const params = createCollectionParams()

    expect(fieldByName(params, MILVUS_FIELDS.denseVector)).toMatchObject({ dim: VECTOR_DIM_DEFAULT })
  })

  it('bakes a custom dim into the dense field', () => {
    const params = createCollectionParams(256)

    expect(fieldByName(params, MILVUS_FIELDS.denseVector)).toMatchObject({ dim: 256 })
  })
})

describe('indexParams', () => {
  it('declares HNSW/COSINE dense, BM25 sparse, and INVERTED scalars', () => {
    const indexes = indexParams()

    expect(indexes).toHaveLength(4)
    expect(indexes[0]).toMatchObject({
      collection_name: MILVUS_COLLECTION,
      field_name: MILVUS_FIELDS.denseVector,
      index_type: 'HNSW',
      metric_type: 'COSINE',
      params: { M: 16, efConstruction: 200 },
    })
    expect(indexes[1]).toMatchObject({
      field_name: MILVUS_FIELDS.sparseVector,
      index_type: 'SPARSE_INVERTED_INDEX',
      // The sparse metric must be explicit or lite rejects the query (G3).
      metric_type: 'BM25',
    })
    expect(indexes[2]).toMatchObject({
      field_name: MILVUS_FIELDS.vault,
      index_type: 'INVERTED',
    })
    expect(indexes[3]).toMatchObject({
      field_name: MILVUS_FIELDS.scope,
      index_type: 'INVERTED',
    })
  })
})

describe('ensureCollection', () => {
  it('creates, indexes, and loadCollectionSyncs a missing collection', async () => {
    const { client, calls } = stubClient({ exists: false })

    const result = await ensureCollection(client, { dim: VECTOR_DIM_DEFAULT })

    expect(result).toEqual({ created: true, needsRebuild: false, storedDim: VECTOR_DIM_DEFAULT })
    expect(calls.map((call) => call.method)).toEqual([
      'hasCollection',
      'createCollection',
      'createIndex',
      'createIndex',
      'createIndex',
      'createIndex',
      'loadCollectionSync',
    ])
    // getLoadState lies on lite (G5), so the sync load is mandatory.
    expect(calls.at(-1)!.payload).toEqual({ collection_name: MILVUS_COLLECTION })
  })

  it('reports dim drift as needsRebuild without touching the collection', async () => {
    const { client, calls } = stubClient({ exists: true, denseDim: 768 })

    const result = await ensureCollection(client, { dim: VECTOR_DIM_DEFAULT })

    expect(result).toEqual({ created: false, needsRebuild: true, storedDim: 768 })
    expect(calls.map((call) => call.method)).toEqual(['hasCollection', 'describeCollection'])
  })

  it('treats a collection without the BM25 sparse field as needing rebuild', async () => {
    const { client } = stubClient({ exists: true, hasSparse: false })

    const result = await ensureCollection(client, { dim: VECTOR_DIM_DEFAULT })

    expect(result.needsRebuild).toBe(true)
  })

  it('treats a matching existing collection as ready', async () => {
    const { client } = stubClient({ exists: true, denseDim: VECTOR_DIM_DEFAULT })

    const result = await ensureCollection(client, { dim: VECTOR_DIM_DEFAULT })

    expect(result).toEqual({
      created: false,
      needsRebuild: false,
      storedDim: VECTOR_DIM_DEFAULT,
    })
  })

  it('throws through assertOk when the server resolves an error status', async () => {
    const { client } = stubClient({ exists: true, failOn: 'describeCollection' })

    await expect(ensureCollection(client)).rejects.toThrow(/describeCollection: ServerError/)
  })

  it('catches the bare ResStatus failure of createCollection', async () => {
    const { client } = stubClient({ exists: false, failOn: 'createCollection' })

    await expect(ensureCollection(client)).rejects.toThrow(/createCollection: ServerError/)
  })

  it('rebuildCollection drops first and then ensures', async () => {
    const { client, calls } = stubClient({ exists: false })

    await rebuildCollection(client, { dim: 256 })

    expect(calls[0]!.method).toBe('dropCollection')
    expect(calls[1]!.method).toBe('hasCollection')
    const created = calls.find((call) => call.method === 'createCollection')
    const dense = (created?.payload as { fields: Array<{ name: string; dim?: number }> }).fields
      .find((field) => field.name === MILVUS_FIELDS.denseVector)
    expect(dense?.dim).toBe(256)
  })

  it('dropCollection surfaces server failures too', async () => {
    const { client } = stubClient({ failOn: 'dropCollection' })

    await expect(dropCollection(client)).rejects.toThrow(/dropCollection: ServerError/)
  })
})

describe('assertOk', () => {
  it('passes Success-nested responses through unchanged', () => {
    const response = { status: { error_code: 'Success', reason: '' }, data: [1, 2] }

    expect(assertOk(response, 'query')).toBe(response)
  })

  it('throws on nested error statuses', () => {
    const response = { status: { error_code: 'CollectionNotExists', reason: 'gone' } }

    expect(() => assertOk(response, 'query')).toThrow(/query: CollectionNotExists gone/)
  })

  it('throws on bare ResStatus failures', () => {
    const bare = { error_code: 'UnexpectedError', reason: 'bad index' }

    expect(() => assertOk(bare, 'createIndex')).toThrow(/createIndex: UnexpectedError/)
  })

  it('passes status-less responses through', () => {
    const version = { version: 'milvus_lite-3.2.2' }

    expect(assertOk(version, 'getVersion')).toBe(version)
  })
})
