#!/usr/bin/env node
/**
 * RadiusProbe exercises Milvus range-search parameters (radius,
 * range_filter) against the LIVE production `obsidian_mem` collection on
 * the running milvus-lite 3.2.2 server, per PLAN-milvus-tuning answer A2
 * (no scratch instance, no scratch collection, read-only searches only).
 *
 * HARD READ-ONLY: the only RPCs issued are connectPromise, checkHealth,
 * getVersion, describeCollection, count, query (one read-only expr lookup),
 * search, and hybridSearch. Never a write, delete, createIndex, load,
 * release, or DDL call here, and never spawn or kill the server.
 *
 * Server discovery: reads {port, pid} from
 * /home/derek/.dsh/obsidian-mem-db/.memlite.json (override with
 * MEMLITE_JSON=/path). The gRPC client mirrors
 * packages/service/src/milvus/client.ts: lite's Python server GOAWAYs the
 * SDK's default keepalive pings, so channelOptions pin
 * grpc.keepalive_time_ms huge and grpc.keepalive_permit_without_calls 0.
 *
 * SDK serialization note (3.0.6, utils/Search.js): every route's `params`
 * object is JSON.stringify'd into search_params.params, so JS numbers stay
 * JSON numbers and JS strings stay JSON strings on the wire. Radius bound
 * inclusivity is probed by feeding an EXACT returned score back as the
 * radius: scores pass through the SDK unrounded (round_decimal -1), so the
 * round trip hits the boundary exactly. A self-vector query (a stored
 * dense_vector used as the query) pins the max-score boundary.
 *
 * Run: node docs/research/probes/radius-probe.mjs
 * Output: one JSON object per line on stdout (probe id, raw request echo
 * with vectors compacted and chunk_text shortened, raw response/error, and
 * a per-probe digest of surviving {chunk_id, score}); progress on stderr.
 * @module docs/research/probes/radius-probe
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { MilvusClient, RRFRanker } = require('@zilliz/milvus2-sdk-node')

const PORT_FILE = process.env.MEMLITE_JSON
  ?? '/home/derek/.dsh/obsidian-mem-db/.memlite.json'
const COLLECTION = 'obsidian_mem'
const REQUEST_TIMEOUT_MS = 60_000
const DENSE_LIMIT = 8
const SPARSE_LIMIT = 8
const ROUTE_LIMIT = 10
const FINAL_LIMIT = 10
const RRF_K = 60
const DENSE_EF = 64
const SPARSE_QUERY_TEXT = 'memory search index vault note chunk'
// Production projection (search.ts SEARCH_OUTPUT_FIELDS); chunk_text is
// shortened in the recorded echo only, never in the request.
const OUTPUT_FIELDS = [
  'chunk_id',
  'source_path',
  'section_header',
  'scope',
  'vault',
  'updated_at',
  'chunk_text',
]

const log = (obj) => console.log(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
const progress = (msg) => console.error(`[radius-probe] ${msg}`)

// Sanitize keeps the recorded evidence faithful where identity matters and
// compact where it does not: long vectors collapse to dim + head, long
// strings (chunk_text) shorten with their true length annotated.
function sanitize(value) {
  if (typeof value === 'bigint') return `bigint:${value.toString()}`
  if (Array.isArray(value)) {
    if (value.length >= 16 && value.every((item) => typeof item === 'number')) {
      return { __vector: value.length, __head: value.slice(0, 4) }
    }
    return value.map(sanitize)
  }
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = sanitize(item)
    return out
  }
  if (typeof value === 'string' && value.length > 70) {
    return `${value.slice(0, 60)}…[${value.length} chars]`
  }
  return value
}

// Mulberry32: deterministic synthetic 384-dim unit vector; the task allows
// synthetic query vectors for semantics probing (no embedder model load).
function syntheticUnit(dim, seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const v = Array.from({ length: dim }, () => next() * 2 - 1)
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0))
  return v.map((x) => x / norm)
}

// One probe: request echo, raw response/error, digest of survivors.
// Resolves with the raw response object (null on error).
async function probe(client, id, note, request, call) {
  log({ probe: id, note, request: request === undefined ? undefined : sanitize(request) })
  try {
    const response = await call()
    log({ probe: id, response: sanitize(response) })
    log({ probe: id, digest: digestHits(searchHits(response)) })
    return response
  } catch (error) {
    log({
      probe: id,
      error: {
        name: error?.name,
        message: error?.message,
        code: error?.code,
        details: error?.details ?? error?.error_code ?? error?.reason,
      },
    })
    return null
  }
}

// search() returns results[qid][]; hybridSearch() returns flat results[].
function searchHits(response) {
  if (response?.results === undefined || response?.results === null) return []
  return Array.isArray(response.results[0]) || response.results.length === 0
    ? response.results[0] ?? []
    : response.results
}

function digestHits(hits) {
  return hits.map((hit) => ({
    chunk_id: String(hit.chunk_id ?? hit.id ?? '?'),
    score: hit.score,
  }))
}

function mid(a, b) {
  return (a + b) / 2
}

async function main() {
  const { port, pid } = JSON.parse(readFileSync(PORT_FILE, 'utf8'))
  progress(`attaching to live milvus-lite pid ${pid} port ${port} (read-only)`)
  const client = new MilvusClient({
    address: `127.0.0.1:${port}`,
    database: 'default',
    timeout: REQUEST_TIMEOUT_MS,
    logLevel: 'warn',
    telemetry: { enabled: false },
    pool: { max: 1, min: 1 },
    // Keepalive suppression per packages/service/src/milvus/client.ts.
    channelOptions: {
      'grpc.keepalive_time_ms': 86_400_000,
      'grpc.keepalive_permit_without_calls': 0,
    },
  })

  await client.connectPromise
  log({ probe: 'BOOT', health: await client.checkHealth(), version: await client.getVersion() })

  // Field names come from the live schema; dense is the FloatVector, sparse
  // the SparseFloatVector (BM25 function output). SDK 3.0.6 returns
  // {schema:{fields:[{name,data_type,type_params:[{key,value}]}]}}.
  const described = await client.describeCollection({ collection_name: COLLECTION })
  const fields = described.schema?.fields ?? []
  const typeParam = (field, key) =>
    (field.type_params ?? []).find((p) => p.key === key)?.value
  const denseFieldDef = fields.find((f) => f.data_type === 'FloatVector')
  const sparseFieldDef = fields.find((f) => f.data_type === 'SparseFloatVector')
  const denseField = denseFieldDef?.name
  const sparseField = sparseFieldDef?.name
  const dim = Number(typeParam(denseFieldDef ?? {}, 'dim') ?? 384)
  const rows = await client.count({ collection_name: COLLECTION })
  log({
    probe: 'SCHEMA',
    denseField,
    sparseField,
    dim,
    rowCount: rows.data,
    vectorFields: fields
      .filter((f) => String(f.data_type).endsWith('Vector'))
      .map((f) => ({ name: f.name, data_type: f.data_type, type_params: f.type_params })),
    functions: described.schema?.functions?.map((fn) => ({
      name: fn.name,
      type: fn.type,
      input: fn.input_field_names,
      output: fn.output_field_names,
    })),
  })
  if (denseField === undefined || sparseField === undefined) {
    throw new Error('vector fields not found in live schema')
  }

  const denseQuery = syntheticUnit(dim, 42)
  const denseBase = (params) => ({
    collection_name: COLLECTION,
    anns_field: denseField,
    data: [denseQuery],
    limit: DENSE_LIMIT,
    metric_type: 'COSINE',
    output_fields: ['chunk_id'],
    consistency_level: 'Strong',
    ...params,
  })
  const sparseBase = (params) => ({
    collection_name: COLLECTION,
    anns_field: sparseField,
    data: [SPARSE_QUERY_TEXT],
    limit: SPARSE_LIMIT,
    metric_type: 'BM25',
    output_fields: ['chunk_id'],
    consistency_level: 'Strong',
    ...params,
  })

  // ---- Dense controls -------------------------------------------------
  const d0 = await probe(client, 'D0-dense-control', 'no params (control; anchor scores)',
    denseBase({}), () => client.search(denseBase({})))
  const d1 = await probe(client, 'D1-dense-ef64', 'params {ef:64} mirrors production dense route',
    denseBase({ params: { ef: DENSE_EF } }), () => client.search(denseBase({ params: { ef: DENSE_EF } })))

  const scores = digestHits(searchHits(d0)).map((h) => h.score).filter((s) => typeof s === 'number')
  const s1 = scores[0]
  const s2 = scores[1]
  const s3 = scores[2]
  const s4 = scores[3]

  // ---- Dense fixed radii (task values) --------------------------------
  await probe(client, 'D2-dense-radius-0.78', 'number radius only',
    denseBase({ params: { radius: 0.78 } }), () => client.search(denseBase({ params: { radius: 0.78 } })))
  await probe(client, 'D3-dense-radius-0.78-rf-1.0', 'number radius + range_filter',
    denseBase({ params: { radius: 0.78, range_filter: 1.0 } }),
    () => client.search(denseBase({ params: { radius: 0.78, range_filter: 1.0 } })))
  await probe(client, 'D4-dense-radius-0.55', 'number radius near control scores',
    denseBase({ params: { radius: 0.55 } }), () => client.search(denseBase({ params: { radius: 0.55 } })))
  await probe(client, 'D5-dense-radius-0.60-rf-1.0', 'number radius + range_filter near control scores',
    denseBase({ params: { radius: 0.6, range_filter: 1.0 } }),
    () => client.search(denseBase({ params: { radius: 0.6, range_filter: 1.0 } })))

  // ---- Dense inclusivity at exact control scores -----------------------
  if (s1 !== undefined) {
    await probe(client, 'D6-dense-radius-eq-s1', `radius === top control score ${s1} exactly`,
      denseBase({ params: { radius: s1 } }), () => client.search(denseBase({ params: { radius: s1 } })))
    await probe(client, 'D7-dense-radius-s1-eps', `radius === s1 - 1e-6 (${s1 - 1e-6})`,
      denseBase({ params: { radius: s1 - 1e-6 } }),
      () => client.search(denseBase({ params: { radius: s1 - 1e-6 } })))
    await probe(client, 'D8-dense-radius-s1-plus-eps', `radius === s1 + 1e-6 (${s1 + 1e-6})`,
      denseBase({ params: { radius: s1 + 1e-6 } }),
      () => client.search(denseBase({ params: { radius: s1 + 1e-6 } })))
  }
  if (s2 !== undefined && s3 !== undefined) {
    const cut = mid(s2, s3)
    await probe(client, 'D9-dense-radius-cut-s2s3', `radius mid(s2,s3)=${cut}; expect s1..s2 to survive`,
      denseBase({ params: { radius: cut, range_filter: 1.0 } }),
      () => client.search(denseBase({ params: { radius: cut, range_filter: 1.0 } })))
  }
  if (s2 !== undefined) {
    await probe(client, 'D10-dense-radius-eq-s2-rf-s1', `radius===s2 (${s2}) range_filter===s1 (${s1}) band`,
      denseBase({ params: { radius: s2, range_filter: s1 } }),
      () => client.search(denseBase({ params: { radius: s2, range_filter: s1 } })))
  }

  // ---- Self-vector max-boundary inclusivity ----------------------------
  // Output the stored vector itself, then re-query with it: the exact
  // max-score hit is a boundary probe for radius at that score.
  const selfRes = await probe(client, 'V0-self-vector-fetch', 'pull one stored dense_vector (read-only)',
    denseBase({ limit: 1, output_fields: ['chunk_id', denseField] }),
    () => client.search({ ...denseBase({ limit: 1 }), output_fields: ['chunk_id', denseField] }))
  const selfHit = (searchHits(selfRes) ?? [])[0]
  const storedVector = selfHit?.[denseField]
  if (Array.isArray(storedVector)) {
    const selfQuery = (params) => ({
      collection_name: COLLECTION,
      anns_field: denseField,
      data: [storedVector],
      limit: 4,
      output_fields: ['chunk_id'],
      consistency_level: 'Strong',
      ...params,
    })
    const v0 = await probe(client, 'V1-self-control', 'query = stored vector (self-similarity)',
      selfQuery({}), () => client.search(selfQuery({})))
    const selfScore = digestHits(searchHits(v0))[0]?.score
    if (typeof selfScore === 'number') {
      await probe(client, 'V2-self-radius-eq-selfscore', `radius === self score ${selfScore} exactly`,
        selfQuery({ params: { radius: selfScore } }),
        () => client.search(selfQuery({ params: { radius: selfScore } })))
      await probe(client, 'V3-self-radius-1.0', 'radius 1.0 (COSINE max) number',
        selfQuery({ params: { radius: 1.0 } }),
        () => client.search(selfQuery({ params: { radius: 1.0 } })))
      await probe(client, 'V4-self-radius-1.0-rf-1.0', 'radius 1.0 + range_filter 1.0 (degenerate band)',
        selfQuery({ params: { radius: 1.0, range_filter: 1.0 } }),
        () => client.search(selfQuery({ params: { radius: 1.0, range_filter: 1.0 } })))
    }
  } else {
    log({ probe: 'V1-self-control', note: 'skipped: no dense_vector in self-fetch response' })
  }

  // ---- Dense param-type and bounds edge cases ---------------------------
  await probe(client, 'E1-dense-string-radius', "radius as STRING '0.78'",
    denseBase({ params: { radius: '0.78' } }), () => client.search(denseBase({ params: { radius: '0.78' } })))
  await probe(client, 'E2-dense-string-radius-rf', "radius+range_filter as STRINGS",
    denseBase({ params: { radius: '0.55', range_filter: '1.0' } }),
    () => client.search(denseBase({ params: { radius: '0.55', range_filter: '1.0' } })))
  await probe(client, 'E3-dense-rf-only', 'range_filter without radius',
    denseBase({ params: { range_filter: 1.0 } }), () => client.search(denseBase({ params: { range_filter: 1.0 } })))
  await probe(client, 'E4-dense-rf-inverted', 'radius > range_filter (0.9 / 0.5)',
    denseBase({ params: { radius: 0.9, range_filter: 0.5 } }),
    () => client.search(denseBase({ params: { radius: 0.9, range_filter: 0.5 } })))
  await probe(client, 'E5-dense-radius-above-max', 'radius 1.5 above COSINE max',
    denseBase({ params: { radius: 1.5 } }), () => client.search(denseBase({ params: { radius: 1.5 } })))
  await probe(client, 'E6-dense-radius-negative', 'radius -1 below COSINE min',
    denseBase({ params: { radius: -1 } }), () => client.search(denseBase({ params: { radius: -1 } })))
  if (s2 !== undefined && s3 !== undefined) {
    const cut = mid(s2, s3)
    await probe(client, 'E7-dense-ef16-radius', `ef 16 + radius ${cut}`,
      denseBase({ params: { ef: 16, radius: cut } }),
      () => client.search(denseBase({ params: { ef: 16, radius: cut } })))
    await probe(client, 'E8-dense-ef256-radius', `ef 256 + radius ${cut}`,
      denseBase({ params: { ef: 256, radius: cut } }),
      () => client.search(denseBase({ params: { ef: 256, radius: cut } })))
  }

  // ---- Sparse BM25 route -------------------------------------------------
  const sp0 = await probe(client, 'S0-sparse-control', 'params {} (control; BM25 scores)',
    sparseBase({}), () => client.search(sparseBase({})))
  const spScores = digestHits(searchHits(sp0)).map((h) => h.score).filter((s) => typeof s === 'number')
  const p1 = spScores[0]
  const p2 = spScores[1]
  const p3 = spScores[2]

  await probe(client, 'S1-sparse-radius-2.5', 'number radius only (BM25 route)',
    sparseBase({ params: { radius: 2.5 } }), () => client.search(sparseBase({ params: { radius: 2.5 } })))
  await probe(client, 'S2-sparse-radius-2.5-rf-100', 'radius + range_filter (BM25 route)',
    sparseBase({ params: { radius: 2.5, range_filter: 100 } }),
    () => client.search(sparseBase({ params: { radius: 2.5, range_filter: 100 } })))
  await probe(client, 'S3-sparse-radius-9999', 'radius 9999: zero rows or error?',
    sparseBase({ params: { radius: 9999 } }), () => client.search(sparseBase({ params: { radius: 9999 } })))
  await probe(client, 'S4-sparse-rf-only', 'range_filter without radius (BM25 route)',
    sparseBase({ params: { range_filter: 5 } }), () => client.search(sparseBase({ params: { range_filter: 5 } })))
  await probe(client, 'S5-sparse-string-radius', "radius as STRING '2.5'",
    sparseBase({ params: { radius: '2.5' } }), () => client.search(sparseBase({ params: { radius: '2.5' } })))
  if (p1 !== undefined) {
    await probe(client, 'S6-sparse-radius-eq-p1', `radius === top BM25 score ${p1} exactly`,
      sparseBase({ params: { radius: p1 } }), () => client.search(sparseBase({ params: { radius: p1 } })))
    await probe(client, 'S7-sparse-radius-p1-eps', `radius === p1 - 1e-6 (${p1 - 1e-6})`,
      sparseBase({ params: { radius: p1 - 1e-6 } }),
      () => client.search(sparseBase({ params: { radius: p1 - 1e-6 } })))
  }
  if (p2 !== undefined && p3 !== undefined) {
    const cut = mid(p2, p3)
    await probe(client, 'S8-sparse-radius-cut-p2p3', `radius mid(p2,p3)=${cut}; expect p1,p2 survive`,
      sparseBase({ params: { radius: cut } }), () => client.search(sparseBase({ params: { radius: cut } })))
  }
  // Round 2: pin the (apparently inverted) BM25 bound roles and their
  // inclusivity with the control's own scores as boundaries.
  if (p2 !== undefined) {
    await probe(client, 'S9-sparse-radius-eq-p2', `radius === p2 ${p2} exactly (upper-bound test)`,
      sparseBase({ params: { radius: p2 } }), () => client.search(sparseBase({ params: { radius: p2 } })))
    await probe(client, 'S10-sparse-rf-eq-p2', `range_filter === p2 ${p2} exactly (lower-bound test)`,
      sparseBase({ params: { range_filter: p2 } }),
      () => client.search(sparseBase({ params: { range_filter: p2 } })))
  }
  if (p1 !== undefined && p3 !== undefined) {
    await probe(client, 'S11-sparse-band-p1-p3', `range_filter=${p1} + radius=${p3} band`,
      sparseBase({ params: { radius: p3, range_filter: p1 } }),
      () => client.search(sparseBase({ params: { radius: p3, range_filter: p1 } })))
  }
  // BM25 score sign across different query texts (is 2.5 even on-scale?).
  for (const [id, text] of [
    ['S12-sparse-text-a', 'react component props re-render memo'],
    ['S13-sparse-text-b', 'milvus'],
    ['S14-sparse-nonsense', 'zzqxjvkf qlmmtbwq nonexistentterm'],
  ]) {
    const req = { ...sparseBase({}), data: [text] }
    await probe(client, id, `control scores for text "${text}"`, req, () => client.search(req))
  }
  // Unparseable radius: does lite at least PARSE the value?
  await probe(client, 'S15-sparse-radius-garbage', "radius 'not-a-number' (BM25 route)",
    sparseBase({ params: { radius: 'not-a-number' } }),
    () => client.search(sparseBase({ params: { radius: 'not-a-number' } })))

  // Rare-term sign check: find a chunk containing a distinctive term, then
  // BM25 that term; a single-hit NEGATIVE score evidences returned BM25
  // scores are negated relevance.
  try {
    const found = await client.query({
      collection_name: COLLECTION,
      expr: 'chunk_text like "%GOAWAY%"',
      output_fields: ['chunk_id'],
      limit: 5,
      consistency_level: 'Strong',
    })
    log({ probe: 'R1-query-term-rows', rows: sanitize(found) })
    if (Array.isArray(found?.data) && found.data.length > 0) {
      const req = { ...sparseBase({ limit: 5 }), data: ['GOAWAY'] }
      await probe(client, 'R2-sparse-rare-term', 'BM25 a term present in few chunks (sign check)',
        req, () => client.search(req))
    }
  } catch (error) {
    log({ probe: 'R1-query-term-rows', error: { name: error?.name, message: error?.message } })
  }

  // Dense: pin range_filter inclusivity at the exact top score.
  if (s1 !== undefined) {
    await probe(client, 'D11-dense-rf-eq-s1', `range_filter === s1 ${s1} (inclusive → 8)`,
      denseBase({ params: { range_filter: s1 } }),
      () => client.search(denseBase({ params: { range_filter: s1 } })))
  }
  await probe(client, 'D12-dense-radius-garbage', "dense radius 'not-a-number' (parse error?)",
    denseBase({ params: { radius: 'not-a-number' } }),
    () => client.search(denseBase({ params: { radius: 'not-a-number' } })))

  // ---- hybridSearch (dispatchHybrid shape, per-route radius) -------------
  const hybrid = (denseParams, sparseParams) => ({
    collection_name: COLLECTION,
    data: [
      {
        anns_field: denseField,
        data: [denseQuery],
        limit: ROUTE_LIMIT,
        metric_type: 'COSINE',
        params: { ef: DENSE_EF, ...denseParams },
      },
      {
        anns_field: sparseField,
        data: [SPARSE_QUERY_TEXT],
        limit: ROUTE_LIMIT,
        metric_type: 'BM25',
        ...(Object.keys(sparseParams).length > 0 ? { params: sparseParams } : {}),
      },
    ],
    rerank: RRFRanker(RRF_K),
    limit: FINAL_LIMIT,
    output_fields: OUTPUT_FIELDS,
    consistency_level: 'Strong',
  })
  const runHybrid = (req) => () => client.hybridSearch(req)

  const h0Req = hybrid({}, {})
  const h0 = await probe(client, 'H0-hybrid-control', 'both routes, no radii (control)',
    h0Req, runHybrid(h0Req))

  const denseCut = s2 !== undefined && s3 !== undefined ? mid(s2, s3) : 0.5
  const sparseCut = p2 !== undefined && p3 !== undefined ? mid(p2, p3) : 1.0
  const h1Req = hybrid({ radius: denseCut }, {})
  const h1 = await probe(client, 'H1-hybrid-dense-radius', `dense route params {ef, radius:${denseCut}}`,
    h1Req, runHybrid(h1Req))
  const h2Req = hybrid({ radius: denseCut }, { radius: sparseCut })
  const h2 = await probe(client, 'H2-hybrid-both-radii', `dense radius ${denseCut} + sparse radius ${sparseCut}`,
    h2Req, runHybrid(h2Req))
  const h3Req = hybrid({ radius: 9999 }, {})
  const h3 = await probe(client, 'H3-hybrid-dense-killed', 'dense radius 9999: fused must go sparse-only',
    h3Req, runHybrid(h3Req))
  const h4Req = hybrid({}, { radius: 9999 })
  const h4 = await probe(client, 'H4-hybrid-sparse-killed', 'sparse radius 9999: fused must go dense-only',
    h4Req, runHybrid(h4Req))
  const h5Req = hybrid({ radius: String(denseCut) }, { radius: String(sparseCut) })
  const h5 = await probe(client, 'H5-hybrid-string-radii', 'both routes STRING radii',
    h5Req, runHybrid(h5Req))
  const h6Req = hybrid({ radius: 'not-a-number' }, {})
  const h6 = await probe(client, 'H6-hybrid-garbage-param', "dense route radius 'not-a-number': parse or ignore?",
    h6Req, runHybrid(h6Req))

  // Cross-checks: per-route survivors at the SAME radii, standalone, with
  // the wider ROUTE_LIMIT the hybrid routes used.
  await probe(client, 'X1-dense-standalone-cut', `dense standalone ef+radius ${denseCut} limit ${ROUTE_LIMIT}`,
    denseBase({ params: { ef: DENSE_EF, radius: denseCut }, limit: ROUTE_LIMIT }),
    () => client.search(denseBase({ params: { ef: DENSE_EF, radius: denseCut }, limit: ROUTE_LIMIT })))
  await probe(client, 'X2-sparse-standalone-cut', `sparse standalone radius ${sparseCut} limit ${ROUTE_LIMIT}`,
    sparseBase({ params: { radius: sparseCut }, limit: ROUTE_LIMIT }),
    () => client.search(sparseBase({ params: { radius: sparseCut }, limit: ROUTE_LIMIT })))

  const fusedIds = (hits) => hits.map((h) => `${String(h.chunk_id)}@${h.score}`)
  const h0Ids = fusedIds(searchHits(h0))
  const sameAsH0 = (hits) => {
    const ids = fusedIds(searchHits(hits))
    return ids.length === h0Ids.length && ids.every((v, i) => v === h0Ids[i])
  }
  log({
    probe: 'SUMMARY',
    denseControlScores: scores,
    sparseControlScores: spScores,
    denseCutRadius: denseCut,
    sparseCutRadius: sparseCut,
    hybridFusedIds: {
      H0: h0Ids,
      H1: fusedIds(searchHits(h1)),
      H2: fusedIds(searchHits(h2)),
      H3: fusedIds(searchHits(h3)),
      H4: fusedIds(searchHits(h4)),
      H5: fusedIds(searchHits(h5)),
      H6: fusedIds(searchHits(h6)),
    },
    hybridIdenticalToControl: {
      H1: sameAsH0(h1),
      H2: sameAsH0(h2),
      H3: sameAsH0(h3),
      H4: sameAsH0(h4),
      H5: sameAsH0(h5),
      H6: sameAsH0(h6),
    },
  })

  await client.closeConnection()
  progress('done')
}

main().catch((error) => {
  console.error('[radius-probe] FATAL', error)
  process.exitCode = 1
})
