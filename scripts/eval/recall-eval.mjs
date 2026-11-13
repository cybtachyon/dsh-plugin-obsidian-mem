#!/usr/bin/env node
/**
 * RecallEval replays the labeled query set (scripts/eval/queries-labels.mjs)
 * against the LIVE production milvus-lite `obsidian_mem` collection and
 * prints per-query tables plus precision@k / forbidden-rate /
 * recall-of-labeled aggregates, so a before/after knob comparison is one
 * tool (TASK-002, PLAN-milvus-tuning Phase A).
 *
 * HARD READ-ONLY: the only RPCs issued are connectPromise, getVersion,
 * count (the production empty-collection guard), search, and hybridSearch.
 * Never a write, delete, drop, createIndex, load, release, or DDL call
 * here, and never spawn or kill the server.
 *
 * Server discovery: reads {port, pid} from
 * /home/derek/.dsh/obsidian-mem-db/.memlite.json (override with
 * MEMLITE_JSON=/path). The gRPC client mirrors
 * packages/service/src/milvus/client.ts: lite's Python server GOAWAYs the
 * SDK's default keepalive pings, so channelOptions pin
 * grpc.keepalive_time_ms huge and grpc.keepalive_permit_without_calls 0.
 *
 * Dispatch modes (the point of this harness — radius knobs only exist in
 * split-rrf because per-route radii inside hybridSearch are accepted but
 * NOT honored by lite 3.2.2, docs/research/radius-tuning-findings.md §4):
 * - legacy-hybrid: the pre-split production shape (the retired
 *   dispatchHybrid, since replaced by split dispatchRoutes): one
 *   client.hybridSearch, `data[]` routes
 *   with per-route metric_type COSINE / BM25, dense params {ef: 64},
 *   RRFRanker(rrfK default 60), no radii, route+page limit = topK *
 *   oversample, Strong consistency, full G10 output projection.
 * - split-rrf: two standalone client.search calls (dense COSINE with
 *   params {ef: 64, radius, range_filter} from the CLI; sparse BM25 with
 *   params {}), a CLIENT-SIDE sparse floor (BM25 scores come back
 *   negated, best-first, so a hit survives when -score >=
 *   --sparse-radius, per radius-tuning-findings.md §3), then client-side
 *   RRF fusion (fused += 1/(k+rank) with rank starting at 1, merged by
 *   chunk_id, sorted fused desc then chunk_id asc) replicating the
 *   RRFRanker(60) formula the probe confirmed lite uses.
 * In legacy-hybrid the radius knobs are ignored (with a note): they are
 * provably no-ops on that route (H1-H5 evidence). --rrf-k maps to
 * RRFRanker(k) in legacy-hybrid and to the client-side fusion in split-rrf.
 * --min-score floors FUSED scores only in both modes (never raw BM25, G7).
 * The BM25 route receives sparseQueryText(query) (the production stop-word
 * strip from search.ts's emitted module, TASK-002) in every dispatch,
 * matching production. --keep-stopwords sends the RAW query on the sparse
 * route instead, the baseline half of the strip A/B (TASK-004/005); the
 * choice is echoed in the artifact config block.
 *
 * Embeddings come from the production embedder itself:
 * packages/service/lib/embedder.js createEmbedder() loads standalone
 * (no Cordis host needed; verified 2026-11-12). The model id
 * (Xenova/multilingual-e5-small), the `query: ` prefix, the q8 dtype, and
 * the model cache dir all come from the defaults baked into
 * packages/service/lib + packages/core/lib constants — nothing retyped
 * here — so dense scores match what production would send.
 *
 * Determinism: same inputs (query set, knobs, collection state) produce
 * the same output; lite search is stable at this corpus size and every
 * client-side order is total (fused desc, then chunk_id asc). The JSON
 * artifact carries no timestamps for byte-stable diffs.
 *
 * Run (smoke, prints tables + aggregates, writes
 * scripts/eval/results/<label>.json):
 *   node scripts/eval/recall-eval.mjs --mode legacy-hybrid
 *   # split-rrf at the shipped production knobs (the values search.ts
 *   # exports; --min-score = FUSED_SCORE_FLOOR 1/(k+2)):
 *   node scripts/eval/recall-eval.mjs --mode split-rrf \
 *     --dense-radius 0.78 --dense-range 1.0 --sparse-radius 5.0 \
 *     --rrf-k 60 --min-score 0.016129 --top-k 6 --oversample 2 \
 *     --label split-d078-s50-k60-m016129
 * See scripts/eval/README.md for every knob and the label caveats.
 * @module scripts/eval/recall-eval
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { MilvusClient, RRFRanker, MetricType } = require('@zilliz/milvus2-sdk-node')

// Production pieces imported, never retyped: the embedder (model id,
// query: prefix, cache layout via core constants), the exact search
// projection, tuning constants + status gate + BM25 stop-word strip from
// service/lib, and the shared names from core/lib.
const { createEmbedder } = await import('../../packages/service/lib/embedder.js')
const {
  SEARCH_OUTPUT_FIELDS,
  RRF_RANKER_K,
  DENSE_SEARCH_EF,
  CANDIDATE_OVERSAMPLE,
  sparseQueryText,
} = await import('../../packages/service/lib/search.js')
const { assertOk } = await import('../../packages/service/lib/milvus/ok.js')
const {
  MILVUS_COLLECTION,
  MILVUS_CONSISTENCY_LEVEL,
  MILVUS_FIELDS,
  SEARCH_DEFAULT_TOP_K,
} = await import('../../packages/core/lib/index.js')
const { EVAL_QUERIES, matchesLabel } = await import('./queries-labels.mjs')

const PORT_FILE = process.env.MEMLITE_JSON
  ?? '/home/derek/.dsh/obsidian-mem-db/.memlite.json'
const REQUEST_TIMEOUT_MS = 60_000
// The imported search.ts constants (RRF_RANKER_K, DENSE_SEARCH_EF,
// CANDIDATE_OVERSAMPLE) seed the CLI defaults and ef is never a knob, so
// harness defaults track production without restating its values; the
// CLI still overrides rrf-k and oversample per run.
const MODES = ['legacy-hybrid', 'split-rrf']

const USAGE = `recall-eval.mjs — offline recall metrics against the live production collection (read-only)

Usage:
  node scripts/eval/recall-eval.mjs --mode MODE [knobs]

  --mode ${MODES.join(' | ')}     dispatch shape (required)
  --dense-radius N     dense COSINE radius; EXCLUSIVE lower bound (split-rrf only)
  --dense-range  N     dense range_filter; INCLUSIVE upper bound (split-rrf only)
  --sparse-radius N    client-side BM25 floor: keep hits with -score >= N (split-rrf only)
  --keep-stopwords     send the RAW query to the BM25 route, skipping the production sparseQueryText stop-word strip (A/B baseline)
  --rrf-k N            RRF fusion k (default ${RRF_RANKER_K}, imported from search.ts); RRFRanker(k) in legacy-hybrid
  --min-score N        floor on FUSED scores before the top-k cut (default: none)
  --top-k N            page size (default ${SEARCH_DEFAULT_TOP_K})
  --oversample N       each route fetches topK * N candidates (default ${CANDIDATE_OVERSAMPLE}, imported from search.ts)
  --label NAME         results file stem (default: the mode) -> scripts/eval/results/NAME.json
  --out PATH           explicit artifact path (overrides --label placement)
  --help               this text
`

function parseArgs(argv) {
  const opts = {
    mode: null,
    denseRadius: undefined,
    denseRange: undefined,
    sparseRadius: undefined,
    keepStopwords: false,
    rrfK: RRF_RANKER_K,
    minScore: undefined,
    topK: SEARCH_DEFAULT_TOP_K,
    oversample: CANDIDATE_OVERSAMPLE,
    label: null,
    out: null,
  }
  const number = (flag, raw) => {
    const value = Number(raw)
    if (!Number.isFinite(value)) {
      throw new Error(`${flag} needs a number, got "${raw}"`)
    }
    return value
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--mode':
        opts.mode = argv[++i]
        break
      case '--dense-radius':
        opts.denseRadius = number(arg, argv[++i])
        break
      case '--dense-range':
        opts.denseRange = number(arg, argv[++i])
        break
      case '--sparse-radius':
        opts.sparseRadius = number(arg, argv[++i])
        break
      case '--keep-stopwords':
        opts.keepStopwords = true
        break
      case '--rrf-k':
        opts.rrfK = number(arg, argv[++i])
        break
      case '--min-score':
        opts.minScore = number(arg, argv[++i])
        break
      case '--top-k':
        opts.topK = number(arg, argv[++i])
        break
      case '--oversample':
        opts.oversample = number(arg, argv[++i])
        break
      case '--label':
        opts.label = argv[++i]
        break
      case '--out':
        opts.out = resolve(argv[++i])
        break
      default:
        throw new Error(`unknown argument "${arg}" (see --help)`)
    }
  }
  if (opts.mode !== null && !MODES.includes(opts.mode)) {
    throw new Error(`--mode must be one of ${MODES.join(', ')}`)
  }
  if (opts.topK < 1 || !Number.isInteger(opts.topK)) {
    throw new Error('--top-k must be a positive integer')
  }
  if (opts.oversample < 1) {
    throw new Error('--oversample must be >= 1')
  }
  return opts
}

const progress = (msg) => console.error(`[recall-eval] ${msg}`)

// normalize turns an SDK hit into the row shape the eval reasons over.
// chunk_id is Int64: stringified once here and used as the merge key.
function normalize(hit) {
  return {
    chunk_id: String(hit[MILVUS_FIELDS.chunkId] ?? hit.id ?? ''),
    source_path: String(hit[MILVUS_FIELDS.sourcePath] ?? ''),
    section_header: String(hit[MILVUS_FIELDS.sectionHeader] ?? ''),
    scope: String(hit[MILVUS_FIELDS.scope] ?? ''),
    score: Number(hit.score ?? 0),
  }
}

// standaloneHits unpacks client.search results: SDK returns results[qid][]
// for standalone search (radius-probe searchHits shape).
function standaloneHits(response) {
  const results = response?.results ?? []
  return (Array.isArray(results[0]) ? results[0] : results).map(normalize)
}

// sparseText renders the query text for a BM25 dispatch: production's
// strip (dispatchRoutes sends sparseQueryText; TASK-002), or the raw
// query under --keep-stopwords so one corpus answers the strip A/B
// (TASK-004/005). Every sparse call site goes through here.
function sparseText(query, opts) {
  return opts.keepStopwords ? query : sparseQueryText(query)
}

// legacyHybrid replays the retired pre-split dispatchHybrid shape: one
// hybridSearch, per-route metric_type (G3), ef on the dense route only,
// RRFRanker(k), route AND page limit = candidateLimit, G10 projection.
// The BM25 data still goes through sparseText: the strip is a route-input
// rule production applies in dispatchRoutes, so every mode takes it under
// the same flag.
async function legacyHybrid(client, embedder, query, opts, candidateLimit) {
  const dense = await embedder.embedQuery(query)
  const response = assertOk(await client.hybridSearch({
    collection_name: MILVUS_COLLECTION,
    data: [
      {
        anns_field: MILVUS_FIELDS.denseVector,
        data: [dense],
        limit: candidateLimit,
        metric_type: MetricType.COSINE,
        params: { ef: DENSE_SEARCH_EF },
      },
      {
        anns_field: MILVUS_FIELDS.sparseVector,
        data: [sparseText(query, opts)],
        limit: candidateLimit,
        metric_type: MetricType.BM25,
      },
    ],
    rerank: RRFRanker(opts.rrfK),
    limit: candidateLimit,
    output_fields: [...SEARCH_OUTPUT_FIELDS],
    consistency_level: MILVUS_CONSISTENCY_LEVEL,
  }), 'hybridSearch')
  const fused = (response.results ?? []).map(normalize)
  return { page: fused }
}

// routeMembership reports dense/sparse membership for the printed route
// flags. In split-rrf the two standalone calls ARE the routes; in
// legacy-hybrid two extra probe searches (same limits, chunk_id-only
// projection, still read-only) recover the flags for the report.
async function routeMembership(client, embedder, query, opts, candidateLimit) {
  const dense = await embedder.embedQuery(query)
  const denseRes = assertOk(await client.search({
    collection_name: MILVUS_COLLECTION,
    anns_field: MILVUS_FIELDS.denseVector,
    data: [dense],
    limit: candidateLimit,
    metric_type: MetricType.COSINE,
    params: { ef: DENSE_SEARCH_EF },
    output_fields: [MILVUS_FIELDS.chunkId],
    consistency_level: MILVUS_CONSISTENCY_LEVEL,
  }), 'search(dense route membership)')
  const sparseRes = assertOk(await client.search({
    collection_name: MILVUS_COLLECTION,
    anns_field: MILVUS_FIELDS.sparseVector,
    data: [sparseText(query, opts)],
    limit: candidateLimit,
    metric_type: MetricType.BM25,
    output_fields: [MILVUS_FIELDS.chunkId],
    consistency_level: MILVUS_CONSISTENCY_LEVEL,
  }), 'search(sparse route membership)')
  return {
    dense: standaloneHits(denseRes),
    sparse: standaloneHits(sparseRes),
  }
}

// hitId accepts either a normalized hit or a bare chunk_id string.
function hitId(hit) {
  return typeof hit === 'string' ? hit : hit.chunk_id
}

// splitRrf implements the TASK-004 candidate shape: standalone dense with
// the range band, standalone sparse, client-side BM25 floor, client-side
// RRF(k) fusion — the one way per-route cutoffs can work on lite 3.2.2
// (radius-tuning-findings.md §4 option 1).
async function splitRrf(client, embedder, query, opts, candidateLimit) {
  const dense = await embedder.embedQuery(query)
  const denseParams = { ef: DENSE_SEARCH_EF }
  if (opts.denseRadius !== undefined) {
    denseParams.radius = opts.denseRadius
  }
  if (opts.denseRange !== undefined) {
    denseParams.range_filter = opts.denseRange
  }
  const denseRes = assertOk(await client.search({
    collection_name: MILVUS_COLLECTION,
    anns_field: MILVUS_FIELDS.denseVector,
    data: [dense],
    limit: candidateLimit,
    metric_type: MetricType.COSINE,
    params: denseParams,
    output_fields: [...SEARCH_OUTPUT_FIELDS],
    consistency_level: MILVUS_CONSISTENCY_LEVEL,
  }), 'search(dense)')
  const sparseRes = assertOk(await client.search({
    collection_name: MILVUS_COLLECTION,
    anns_field: MILVUS_FIELDS.sparseVector,
    data: [sparseText(query, opts)],
    limit: candidateLimit,
    metric_type: MetricType.BM25,
    params: {},
    output_fields: [...SEARCH_OUTPUT_FIELDS],
    consistency_level: MILVUS_CONSISTENCY_LEVEL,
  }), 'search(sparse)')

  const denseHits = standaloneHits(denseRes)
  // Returned BM25 scores are negated relevance (best = most negative):
  // the floor keeps a hit when its relevance (-score) clears the value.
  const sparseHits = standaloneHits(sparseRes).filter(
    (hit) => opts.sparseRadius === undefined || -hit.score >= opts.sparseRadius,
  )

  const fused = new Map()
  const contribute = (hits, weight) => {
    hits.forEach((hit, index) => {
      const rank = index + 1
      const entry = fused.get(hit.chunk_id) ?? { row: hit, fused: 0 }
      entry.fused += weight(rank)
      fused.set(hit.chunk_id, entry)
    })
  }
  contribute(denseHits, (rank) => 1 / (opts.rrfK + rank))
  contribute(sparseHits, (rank) => 1 / (opts.rrfK + rank))

  const page = [...fused.values()]
    .map((entry) => ({
      ...entry.row,
      // The page is ranked and reported by FUSED score; the raw route
      // score (COSINE or negated BM25) survives only in routeCandidates.
      score: entry.fused,
      routeScore: entry.row.score,
    }))
    .filter((row) => opts.minScore === undefined || row.score >= opts.minScore)
    .sort((a, b) => b.score - a.score || compareChunkIds(a.chunk_id, b.chunk_id))
  return {
    page,
    routes: { dense: denseHits, sparse: sparseHits },
  }
}

// compareChunkIds orders 16-digit ids ascending numerically (BigInt),
// falling back to string order for anything else.
function compareChunkIds(a, b) {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const left = BigInt(a)
    const right = BigInt(b)
    return left < right ? -1 : left > right ? 1 : 0
  }
  return a < b ? -1 : a > b ? 1 : 0
}

function classify(row, labels) {
  const hit = (list) => labelsOf(list).some((label) => matchesLabel(label, row))
  if (hit(labels.relevant)) return 'R'
  if (hit(labels.acceptable)) return 'A'
  if (hit(labels.forbidden)) return 'F'
  return '.'
}

function labelsOf(list) {
  return list ?? []
}

// queryMetrics computes the per-query row at the returned page.
// relevantLabelHits counts DISTINCT relevant labels satisfied, so a note
// with several chunks on the page is one recall point, not three.
function queryMetrics(entry, page) {
  const classes = page.map((row) => classify(row, entry))
  const count = (cls) => classes.filter((c) => c === cls).length
  const relevantLabels = labelsOf(entry.relevant)
  const hitLabels = relevantLabels.filter((label) => page.some((row) => matchesLabel(label, row)))
  const returned = page.length
  const relevant = count('R')
  const acceptable = count('A')
  const forbidden = count('F')
  return {
    returned,
    relevant,
    acceptable,
    forbidden,
    neutral: returned - relevant - acceptable - forbidden,
    relevantLabels: relevantLabels.length,
    relevantLabelHits: hitLabels.length,
    relevantMissed: relevantLabels.length - hitLabels.length,
    precisionAtK: returned === 0 ? null : relevant / returned,
    forbiddenRate: returned === 0 ? null : forbidden / returned,
    recallOfLabeled: relevantLabels.length === 0 ? null : hitLabels.length / relevantLabels.length,
  }
}

const fmt = (value) => (value === null ? ' n/a ' : value.toFixed(3))

function printQuery(entry, page, classes, metrics) {
  console.log(`\n=== ${entry.id} [${entry.origin}]`)
  console.log(`    q: ${entry.query.slice(0, 96)}`)
  for (let i = 0; i < page.length; i += 1) {
    const row = page[i]
    const header = row.section_header === '' ? '' : ` # ${row.section_header.slice(0, 36)}`
    console.log(
      `  ${String(i + 1).padStart(2)} ${classes[i]} ${row.routes.padEnd(5)} ${row.score.toFixed(6).padStart(9)}`
      + `  ${row.source_path}${header} [${row.scope}]`,
    )
  }
  console.log(
    `  rel=${metrics.relevant} acc=${metrics.acceptable} forb=${metrics.forbidden}`
    + ` missed=${metrics.relevantMissed}/${metrics.relevantLabels}`
    + ` P@k=${fmt(metrics.precisionAtK)} forbRate=${fmt(metrics.forbiddenRate)}`
    + ` recall=${fmt(metrics.recallOfLabeled)}`,
  )
}

function routeFlag(chunkId, routes) {
  const dense = routes.dense.some((hit) => hitId(hit) === chunkId)
  const sparse = routes.sparse.some((hit) => hitId(hit) === chunkId)
  if (dense && sparse) return 'both'
  if (dense) return 'dense'
  if (sparse) return 'sparse'
  return 'fused'
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help || opts.mode === null) {
    console.log(USAGE)
    process.exitCode = opts.help ? 0 : 2
    return
  }
  if (opts.mode === 'legacy-hybrid'
    && (opts.denseRadius !== undefined || opts.denseRange !== undefined || opts.sparseRadius !== undefined)) {
    progress('note: radius knobs are split-rrf only; lite ignores per-route radii inside hybridSearch (findings §4), so they are dropped in legacy-hybrid')
  }

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
  const version = assertOk(await client.getVersion(), 'getVersion')
  const rowCount = Number(assertOk(await client.count({ collection_name: MILVUS_COLLECTION }), 'count').data ?? 0)
  progress(`server ${version.version}, ${rowCount} rows in ${MILVUS_COLLECTION}`)
  if (rowCount === 0) {
    throw new Error(`${MILVUS_COLLECTION} is empty; nothing to evaluate (production guard, not a server fault)`)
  }

  const embedder = createEmbedder()
  const candidateLimit = opts.topK * opts.oversample
  const results = []
  let denseEmbedCalls = 0
  const embedded = new Map()
  const embed = async (text) => {
    if (!embedded.has(text)) {
      denseEmbedCalls += 1
      embedded.set(text, await embedder.embedQuery(text))
    }
    return embedded.get(text)
  }
  // Wrap the embedder so each query vector is computed once per run.
  const cachedEmbedder = { embedQuery: embed }

  for (const entry of EVAL_QUERIES) {
    let dispatched
    if (opts.mode === 'legacy-hybrid') {
      dispatched = await legacyHybrid(client, cachedEmbedder, entry.query, opts, candidateLimit)
      dispatched.routes = await routeMembership(client, cachedEmbedder, entry.query, opts, candidateLimit)
    } else {
      dispatched = await splitRrf(client, cachedEmbedder, entry.query, opts, candidateLimit)
    }
    const page = dispatched.page
      .filter((row) => opts.mode === 'split-rrf' || opts.minScore === undefined || row.score >= opts.minScore)
      .slice(0, opts.topK)
      .map((row) => ({ ...row, routes: routeFlag(row.chunk_id, dispatched.routes) }))
    const classes = page.map((row) => classify(row, entry))
    const metrics = queryMetrics(entry, page)
    printQuery(entry, page, classes, metrics)
    results.push({
      id: entry.id,
      origin: entry.origin,
      query: entry.query,
      labels: {
        relevant: labelsOf(entry.relevant),
        acceptable: labelsOf(entry.acceptable),
        forbidden: labelsOf(entry.forbidden),
      },
      ...(entry.note === undefined ? {} : { note: entry.note }),
      routeCandidates: {
        dense: dispatched.routes.dense.map((hit) => ({ chunk_id: hitId(hit), score: hit.score })),
        sparse: dispatched.routes.sparse.map((hit) => ({ chunk_id: hitId(hit), score: hit.score })),
      },
      returned: page.map((row) => ({
        chunk_id: row.chunk_id,
        source_path: row.source_path,
        section_header: row.section_header,
        scope: row.scope,
        score: row.score,
        routes: row.routes,
        classification: classify(row, entry),
      })),
      metrics,
    })
  }

  const sum = (key) => results.reduce((total, r) => total + r.metrics[key], 0)
  const returnedTotal = sum('returned')
  const aggregates = {
    queries: results.length,
    returned: returnedTotal,
    relevant: sum('relevant'),
    acceptable: sum('acceptable'),
    forbidden: sum('forbidden'),
    neutral: sum('neutral'),
    relevantLabels: sum('relevantLabels'),
    relevantLabelHits: sum('relevantLabelHits'),
    relevantMissed: sum('relevantMissed'),
    precisionAtK: returnedTotal === 0 ? null : sum('relevant') / returnedTotal,
    forbiddenRate: returnedTotal === 0 ? null : sum('forbidden') / returnedTotal,
    recallOfLabeled: sum('relevantLabels') === 0 ? null : sum('relevantLabelHits') / sum('relevantLabels'),
  }
  console.log(
    `\n=== AGGREGATES mode=${opts.mode} topK=${opts.topK} oversample=${opts.oversample}`
    + ` rrfK=${opts.rrfK} minScore=${opts.minScore ?? 'none'}`
    + ` denseRadius=${opts.denseRadius ?? 'none'} denseRange=${opts.denseRange ?? 'none'}`
    + ` sparseRadius=${opts.sparseRadius ?? 'none'} keepStopwords=${opts.keepStopwords}`,
  )
  console.log(
    `  queries=${aggregates.queries} returned=${aggregates.returned}`
    + ` relevant=${aggregates.relevant} acceptable=${aggregates.acceptable}`
    + ` forbidden=${aggregates.forbidden} neutral=${aggregates.neutral}`,
  )
  console.log(
    `  precision@k=${fmt(aggregates.precisionAtK)}`
    + ` forbidden-rate=${fmt(aggregates.forbiddenRate)}`
    + ` recall-of-labeled=${aggregates.relevantLabelHits}/${aggregates.relevantLabels}=${fmt(aggregates.recallOfLabeled)}`,
  )

  const label = opts.label ?? opts.mode
  const outPath = opts.out ?? join(HERE, 'results', `${label}.json`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify({
    harness: 'scripts/eval/recall-eval.mjs',
    server: { version: version.version, rowCount },
    collection: MILVUS_COLLECTION,
    config: {
      mode: opts.mode,
      topK: opts.topK,
      oversample: opts.oversample,
      rrfK: opts.rrfK,
      minScore: opts.minScore ?? null,
      denseRadius: opts.denseRadius ?? null,
      denseRange: opts.denseRange ?? null,
      sparseRadius: opts.sparseRadius ?? null,
      keepStopwords: opts.keepStopwords,
      denseEf: DENSE_SEARCH_EF,
      embedder: embedder.modelId,
      embedCalls: denseEmbedCalls,
    },
    aggregates,
    queries: results,
  }, null, 2)}\n`)
  progress(`artifact: ${outPath}`)

  await client.closeConnection()
}

main().catch((error) => {
  console.error('[recall-eval] FATAL', error)
  process.exitCode = 1
})
