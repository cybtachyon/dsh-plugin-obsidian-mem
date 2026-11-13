#!/usr/bin/env node
/**
 * CrossEncoderRerank replays the labeled query set through the CURRENT
 * production candidate page (TASK-004/009 split-rrf shape) and scores every
 * surviving row with the Xenova/bge-reranker-base cross-encoder, so a
 * post-fusion cutoff + re-rank is decided by numbers (TASK-012,
 * PLAN-milvus-tuning-TASK-012-cross-encoder-reranker.md).
 *
 * The page under reranking is reproduced exactly from recall-eval's
 * split-rrf with production's own tuning constants, imported from
 * packages/service/lib/search.ts's emitted module (radius exclusive
 * lower bound, range_filter, ef, client-side BM25 floor, client RRF,
 * the shipped FUSED_SCORE_FLOOR, topK, oversample). What survives that
 * page is the reranker's input; nothing refills it. Cutoffs are applied
 * on the sigmoid probability and, separately, the page is re-sorted by
 * it; cutoff metrics are order-independent, so the sweep table is the
 * re-sort's table too.
 *
 * WHY the pipeline's own score is bypassed: TextClassificationPipeline
 * (installed @huggingface/transformers 4.3.2, src/pipelines/
 * text-classification.js) applies softmax unless problem_type is
 * multi_label_classification, and this model's config.json carries no
 * problem_type and num_labels 1 (id2label LABEL_0), so softmax over a
 * single logit is the constant 1.0. bge-reranker scores are raw logits;
 * Python's pipeline special-cases single-logit models with sigmoid. This
 * harness therefore loads the pipeline (correct preprocessing and model
 * class) but calls classifier.model directly and applies
 * sigmoid(logit) = 1/(1+exp(-logit)) itself.
 *
 * HARD READ-ONLY on milvus: connectPromise, getVersion, count, and search
 * only, mirroring recall-eval.mjs and packages/service/src/milvus/
 * client.ts (keepalive suppression: lite GOAWAYs the SDK's default pings).
 * The only writes anywhere are the artifact file and the transformers.js
 * model cache under <dbDir>/models (production's cacheDir, via core's
 * modelCacheDir).
 *
 * Determinism: same inputs produce a byte-identical artifact (no
 * timestamps; latency is stdout-only, never in the JSON). CPU onnxruntime
 * is deterministic run to run at fixed thread count, and every client-side
 * order is total (fused desc then chunk_id asc; rerank prob desc then
 * chunk_id asc).
 *
 * Run (writes scripts/eval/results/cross-encoder-rerank.json):
 *   node scripts/eval/cross-encoder-rerank.mjs
 *   node scripts/eval/cross-encoder-rerank.mjs --label rerun1 --dtype q8
 * See scripts/eval/README.md.
 * @module scripts/eval/cross-encoder-rerank
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { MilvusClient, MetricType } = require('@zilliz/milvus2-sdk-node')

// Production pieces imported, never retyped (same seams as recall-eval):
// the embedder (model id, query: prefix, cache layout via core
// constants), the exact search projection + production tuning constants
// + status gate from service/lib, and the shared names + modelCacheDir
// from core/lib.
const { createEmbedder } = await import('../../packages/service/lib/embedder.js')
const {
  SEARCH_OUTPUT_FIELDS,
  RRF_RANKER_K,
  DENSE_SEARCH_EF,
  DENSE_SEARCH_RADIUS,
  DENSE_RANGE_MAX,
  SPARSE_SEARCH_RADIUS,
  FUSED_SCORE_FLOOR,
  CANDIDATE_OVERSAMPLE,
} = await import('../../packages/service/lib/search.js')
const { assertOk } = await import('../../packages/service/lib/milvus/ok.js')
const {
  MILVUS_COLLECTION,
  MILVUS_CONSISTENCY_LEVEL,
  MILVUS_FIELDS,
  SEARCH_DEFAULT_TOP_K,
  modelCacheDir,
} = await import('../../packages/core/lib/index.js')
const { EVAL_QUERIES, matchesLabel } = await import('./queries-labels.mjs')

const PORT_FILE = process.env.MEMLITE_JSON
  ?? '/home/derek/.dsh/obsidian-mem-db/.memlite.json'
const REQUEST_TIMEOUT_MS = 60_000

// The page under reranking IS production, so every knob rides the
// constants search.ts exports (imported above; recall-eval.mjs carries
// the same seam) and nothing varies by CLI. WHY: this harness used to
// restate them and its fused floor drifted behind TASK-007; the import
// keeps the shipped values authoritative.
const TOP_K = SEARCH_DEFAULT_TOP_K

// The reranker under evaluation. dtype q8 matches production's embedder
// (TRANSFORMERS_PIPELINE_OPTIONS.dtype); in v4.3.2 q8 maps to the hub's
// onnx/model_quantized.onnx (~279 MB).
const RERANKER_MODEL_ID = 'Xenova/bge-reranker-base'
const RERANKER_DTYPE_DEFAULT = 'q8'
// 0.35 is the user's suggested example cutoff; the rest is the sweep.
// "none" is the no-rerank production baseline (identical page, identity
// order) so every row of the sweep table shares one denominator basis.
const CUTOFFS_DEFAULT = ['none', '0.2', '0.25', '0.3', '0.35', '0.4', '0.5']
// Scoring warmup text: excluded from all latency numbers.
const WARMUP_PAIR = ['warmup query', 'warmup passage for onnxruntime session priming']

const USAGE = `cross-encoder-rerank.mjs — post-fusion bge-reranker-base cutoff study on the production page (read-only)

Usage:
  node scripts/eval/cross-encoder-rerank.mjs [knobs]

  --cutoffs LIST       comma-separated sigmoid-probability cutoffs (default ${CUTOFFS_DEFAULT.join(',')})
  --dtype NAME         reranker quantization the hub ships (default ${RERANKER_DTYPE_DEFAULT})
  --label NAME         results file stem (default: cross-encoder-rerank) -> scripts/eval/results/NAME.json
  --out PATH           explicit artifact path (overrides --label placement)
  --help               this text

The candidate page is fixed at the constants search.ts exports (imported,
never restated): dense COSINE radius ${DENSE_SEARCH_RADIUS} (exclusive) range_filter
${DENSE_RANGE_MAX} ef ${DENSE_SEARCH_EF} + BM25 with client floor ${SPARSE_SEARCH_RADIUS}, client
RRF(${RRF_RANKER_K}), fused floor ${FUSED_SCORE_FLOOR}, topK ${TOP_K},
oversample ${CANDIDATE_OVERSAMPLE}. No knobs change it; this harness only decides what
the reranker would do to that page.
`

function parseArgs(argv) {
  // "none" is the sentinel -1 cutoff (no drop): the no-rerank baseline.
  const cutoffToNumber = (raw) => {
    const value = raw === 'none' ? -1 : Number(raw)
    if (!Number.isFinite(value)) {
      throw new Error(`--cutoffs needs numbers or "none", got "${raw}"`)
    }
    return value
  }
  const opts = {
    cutoffs: CUTOFFS_DEFAULT.map(cutoffToNumber),
    dtype: RERANKER_DTYPE_DEFAULT,
    label: 'cross-encoder-rerank',
    out: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--help':
      case '-h':
        opts.help = true
        break
      case '--cutoffs':
        opts.cutoffs = argv[++i].split(',').map(cutoffToNumber)
        break
      case '--dtype':
        opts.dtype = argv[++i]
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
  return opts
}

const progress = (msg) => console.error(`[cross-encoder-rerank] ${msg}`)

// normalize turns an SDK hit into the row shape the eval reasons over.
// Compared to recall-eval this keeps chunk_text: it is the reranker's
// passage input. chunk_id is Int64: stringified once and used as merge key.
function normalize(hit) {
  return {
    chunk_id: String(hit[MILVUS_FIELDS.chunkId] ?? hit.id ?? ''),
    source_path: String(hit[MILVUS_FIELDS.sourcePath] ?? ''),
    section_header: String(hit[MILVUS_FIELDS.sectionHeader] ?? ''),
    scope: String(hit[MILVUS_FIELDS.scope] ?? ''),
    chunk_text: String(hit[MILVUS_FIELDS.chunkText] ?? ''),
    score: Number(hit.score ?? 0),
  }
}

// standaloneHits unpacks client.search results: SDK returns results[qid][]
// for standalone search (radius-probe searchHits shape).
function standaloneHits(response) {
  const results = response?.results ?? []
  return (Array.isArray(results[0]) ? results[0] : results).map(normalize)
}

// productionPage implements the CURRENT production dispatch exactly (the
// split-rrf recall-eval mode with the imported search.ts constants, plus
// the fused-floor + top-k cut search.ts applies after fusion): standalone
// dense with the radius band, standalone sparse, client-side BM25 floor,
// client-side RRF(RRF_RANKER_K) fusion (fused += 1/(k+rank), rank from 1),
// fused-desc then chunk_id-asc sort, FUSED_SCORE_FLOOR cut, slice to topK.
// That sliced page is the reranker's input; nothing refills a cut row.
async function productionPage(client, embedder, query) {
  const dense = await embedder.embedQuery(query)
  const candidateLimit = TOP_K * CANDIDATE_OVERSAMPLE
  const shared = {
    collection_name: MILVUS_COLLECTION,
    limit: candidateLimit,
    output_fields: [...SEARCH_OUTPUT_FIELDS],
    consistency_level: MILVUS_CONSISTENCY_LEVEL,
  }
  const denseRes = assertOk(await client.search({
    ...shared,
    anns_field: MILVUS_FIELDS.denseVector,
    data: [dense],
    metric_type: MetricType.COSINE,
    params: { ef: DENSE_SEARCH_EF, radius: DENSE_SEARCH_RADIUS, range_filter: DENSE_RANGE_MAX },
  }), 'search(dense)')
  const sparseRes = assertOk(await client.search({
    ...shared,
    anns_field: MILVUS_FIELDS.sparseVector,
    data: [query],
    metric_type: MetricType.BM25,
    params: {},
  }), 'search(sparse)')

  const denseHits = standaloneHits(denseRes)
  // Returned BM25 scores are negated relevance (best = most negative):
  // the floor keeps a hit when its relevance (-score) clears the value.
  const sparseHits = standaloneHits(sparseRes).filter(
    (hit) => -hit.score >= SPARSE_SEARCH_RADIUS,
  )

  const fused = new Map()
  const contribute = (hits) => {
    hits.forEach((hit, index) => {
      const entry = fused.get(hit.chunk_id) ?? { row: hit, fused: 0 }
      entry.fused += 1 / (RRF_RANKER_K + index + 1)
      fused.set(hit.chunk_id, entry)
    })
  }
  contribute(denseHits)
  contribute(sparseHits)

  const page = [...fused.values()]
    .map((entry) => ({ ...entry.row, score: entry.fused }))
    .filter((row) => row.score >= FUSED_SCORE_FLOOR)
    .sort((a, b) => b.score - a.score || compareChunkIds(a.chunk_id, b.chunk_id))
    .slice(0, TOP_K)

  const routes = { dense: denseHits.map((hit) => hit.chunk_id), sparse: sparseHits.map((hit) => hit.chunk_id) }
  return {
    page: page.map((row) => ({ ...row, routes: routeFlag(row.chunk_id, routes) })),
  }
}

function routeFlag(chunkId, routes) {
  const dense = routes.dense.includes(chunkId)
  const sparse = routes.sparse.includes(chunkId)
  if (dense && sparse) return 'both'
  if (dense) return 'dense'
  if (sparse) return 'sparse'
  return 'fused'
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

// queryMetrics computes the per-query row at a returned page (same
// definitions as recall-eval: multi-chunk note counts once for recall,
// every row counts for precision).
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

function aggregate(perQuery) {
  const sum = (key) => perQuery.reduce((total, m) => total + m[key], 0)
  const returnedTotal = sum('returned')
  return {
    queries: perQuery.length,
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
}

// loadReranker loads the text-classification pipeline from the production
// model cache dir (same cacheDir discipline as packages/service/lib/
// embedder.js) and returns it with the wall-clock load time. The pipeline
// instance is used for preprocessing + model only; its classifier score is
// softmax-over-one-logit (constant 1.0) and deliberately bypassed (see the
// module header).
async function loadReranker(dtype) {
  const { env, pipeline } = await import('@huggingface/transformers')
  const cacheDir = modelCacheDir(homedir())
  mkdirSync(cacheDir, { recursive: true })
  env.cacheDir = cacheDir
  env.allowLocalModels = false
  env.allowRemoteModels = true
  const startedAt = performance.now()
  const classifier = await pipeline('text-classification', RERANKER_MODEL_ID, {
    dtype,
    progress_callback: ({ status, file, progress: percent }) => {
      if (status === 'progress' && file) {
        console.error(`[cross-encoder-rerank] download ${file} ${percent ?? 0}%`)
      }
    },
  })
  return { classifier, cacheDir, loadMs: performance.now() - startedAt }
}

// scorePairs returns raw logits for (query, passage) pairs in one batched
// model call. Passage truncation to the model's 512-token window is the
// tokenizer's (truncation: true cuts the tail of the pair, i.e. the
// passage end). Output shape is asserted to [batch][1]: this is a
// single-logit sequence classifier, and anything else means the wrong
// head was loaded.
async function scorePairs(classifier, query, passages) {
  const texts = passages.map(() => query)
  const inputs = classifier.tokenizer(texts, {
    text_pair: passages,
    padding: true,
    truncation: true,
  })
  const outputs = await classifier.model(inputs)
  const logits = outputs.logits
  const rows = logits.tolist()
  const sequenceLengths = inputs.input_ids.dims[1] ?? 0
  if (rows.length !== passages.length || rows.some((row) => row.length !== 1)) {
    throw new Error(`reranker logits shape ${JSON.stringify(logits.dims)} is not [${passages.length}][1]`)
  }
  return { logits: rows.map((row) => row[0]), sequenceLengths }
}

// sigmoid turns a bge-reranker logit into the 0..1 relevance probability
// the cutoffs are calibrated on (Python reference: torch.sigmoid).
function sigmoid(logit) {
  return 1 / (1 + Math.exp(-logit))
}

// summarizeProbs returns distribution stats over sorted values using the
// linear-interpolation quantile convention (numpy default), so two runs
// over the same values report the same numbers.
function summarizeProbs(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const quantile = (q) => {
    if (sorted.length === 0) return null
    const position = (sorted.length - 1) * q
    const low = Math.floor(position)
    const high = Math.ceil(position)
    return low === high ? sorted[low] : sorted[low] + (position - low) * (sorted[high] - sorted[low])
  }
  const mean = sorted.length === 0 ? null : sorted.reduce((total, v) => total + v, 0) / sorted.length
  return {
    n: sorted.length,
    min: quantile(0),
    q1: quantile(0.25),
    median: quantile(0.5),
    q3: quantile(0.75),
    max: quantile(1),
    mean,
  }
}

// dirBytes sums regular-file sizes under a path; used for the model cache
// footprint report (disk facts, deterministic between runs).
function dirBytes(path) {
  let bytes = 0
  let files = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      const inner = dirBytes(child)
      bytes += inner.bytes
      files += inner.files
    } else if (entry.isFile()) {
      bytes += statSync(child).size
      files += 1
    }
  }
  return { bytes, files }
}

const fmt = (value) => (value === null || value === undefined ? ' n/a ' : value.toFixed(3))
const fmtCutoff = (cutoff) => (cutoff < 0 ? 'none ' : cutoff.toFixed(2).padStart(5))

function printPage(entry, rows) {
  console.log(`\n=== ${entry.id} [${entry.origin}]`)
  console.log(`    q: ${entry.query.slice(0, 96)}`)
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const header = row.section_header === '' ? '' : ` # ${row.section_header.slice(0, 36)}`
    console.log(
      `  ${String(i + 1).padStart(2)} ${row.classification} ${row.routes.padEnd(5)}`
      + ` fused=${row.score.toFixed(6).padStart(9)} p=${row.prob.toFixed(6).padStart(8)}`
      + `  ${row.source_path}${header} [${row.scope}]`,
    )
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    console.log(USAGE)
    process.exitCode = 0
    return
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

  const { classifier, cacheDir, loadMs } = await loadReranker(opts.dtype)
  const cacheModelDir = join(cacheDir, ...RERANKER_MODEL_ID.split('/'))
  const cacheFootprint = dirBytes(cacheModelDir)
  progress(`model ${RERANKER_MODEL_ID} (${opts.dtype}) loaded in ${loadMs.toFixed(0)} ms from ${cacheModelDir} (${(cacheFootprint.bytes / 1024 / 1024).toFixed(1)} MB, ${cacheFootprint.files} files)`)

  // Warm the onnxruntime session once; excluded from latency stats.
  {
    const warm = await scorePairs(classifier, WARMUP_PAIR[0], [WARMUP_PAIR[1]])
    progress(`warmup sigmoid=${sigmoid(warm.logits[0]).toFixed(6)}`)
  }

  const embedder = createEmbedder()
  const embedded = new Map()
  const embed = async (text) => {
    if (!embedded.has(text)) {
      embedded.set(text, await embedder.embedQuery(text))
    }
    return embedded.get(text)
  }
  const cachedEmbedder = { embedQuery: embed }

  // Pass 1: reproduce the production page per query, then score every row
  // once with the cross-encoder. Latency is measured here (per query,
  // post-warmup), stdout-only.
  const scoredQueries = []
  const latencies = []
  for (const entry of EVAL_QUERIES) {
    const { page } = await productionPage(client, cachedEmbedder, entry.query)
    let scoring = { ms: 0, sequenceLengths: 0 }
    const rows = page.map((row) => ({ ...row }))
    if (rows.length > 0) {
      const startedAt = performance.now()
      const result = await scorePairs(classifier, entry.query, rows.map((row) => row.chunk_text))
      scoring = { ms: performance.now() - startedAt, sequenceLengths: result.sequenceLengths }
      rows.forEach((row, index) => {
        row.logit = result.logits[index]
        row.prob = sigmoid(result.logits[index])
        row.classification = classify(row, entry)
      })
    }
    latencies.push({ id: entry.id, rows: rows.length, ms: scoring.ms, paddedTokens: scoring.sequenceLengths })
    printPage(entry, rows)
    scoredQueries.push({ entry, rows })
  }

  // Pass 2: cutoff sweep over the scored pages. A cutoff drops rows below
  // the probability; the kept set is also re-sorted by it. The metrics
  // depend only on the kept SET, so one table covers (a) cutoff and (b)
  // re-sort; the artifact records the re-sort order explicitly.
  const sweep = opts.cutoffs.map((cutoff) => {
    const perQuery = []
    const flipped = []
    const rerankedPages = []
    for (const { entry, rows } of scoredQueries) {
      const kept = rows.filter((row) => row.prob >= cutoff)
      const dropped = rows.filter((row) => row.prob < cutoff)
      perQuery.push(queryMetrics(entry, kept))
      rerankedPages.push({
        id: entry.id,
        // Total order: prob desc, then chunk_id asc (never a score tie
        // leaving output order to insertion).
        page: [...kept]
          .sort((a, b) => b.prob - a.prob || compareChunkIds(a.chunk_id, b.chunk_id))
          .map((row) => ({ chunk_id: row.chunk_id, source_path: row.source_path, prob: row.prob, classification: row.classification })),
      })
      for (const row of dropped) {
        flipped.push({
          id: entry.id,
          classification: row.classification,
          source_path: row.source_path,
          section_header: row.section_header,
          prob: row.prob,
          fused: row.score,
        })
      }
    }
    return {
      cutoff,
      aggregates: aggregate(perQuery),
      flipped: flipped.sort((a, b) => compareChunkIds(a.chunk_id, b.chunk_id) || a.source_path.localeCompare(b.source_path) || a.id.localeCompare(b.id)),
      rerankedPages,
    }
  })

  // Ordering-only effect of the re-sort at cutoff none: mean index of the
  // best relevant row per query (1-based), baseline vs reranked. Shows the
  // re-sort's value that the cutoff table cannot (metrics ignore order).
  const bestRelevantIndex = (rows) => {
    const indices = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => row.classification === 'R')
      .map(({ index }) => index + 1)
    if (indices.length === 0) return null
    return Math.min(...indices)
  }
  const ordering = { baseline: [], reranked: [] }
  for (const { rows } of scoredQueries) {
    const baseline = bestRelevantIndex(rows)
    if (baseline !== null) ordering.baseline.push(baseline)
    const reranked = bestRelevantIndex(
      [...rows].sort((a, b) => b.prob - a.prob || compareChunkIds(a.chunk_id, b.chunk_id)),
    )
    if (reranked !== null) ordering.reranked.push(reranked)
  }
  const meanIndex = (list) => (list.length === 0 ? null : list.reduce((t, v) => t + v, 0) / list.length)

  // Probability separability evidence: distributions over every scored
  // row's sigmoid probability, bucketed by label class.
  const byClass = { R: [], A: [], F: [], '.': [] }
  const perRowProbabilities = []
  for (const { entry, rows } of scoredQueries) {
    for (const row of rows) {
      byClass[row.classification].push(row.prob)
      perRowProbabilities.push({
        id: entry.id,
        chunk_id: row.chunk_id,
        source_path: row.source_path,
        section_header: row.section_header,
        scope: row.scope,
        routes: row.routes,
        fused: row.score,
        logit: row.logit,
        prob: row.prob,
        classification: row.classification,
      })
    }
  }
  const distributions = {
    R: summarizeProbs(byClass.R),
    A: summarizeProbs(byClass.A),
    F: summarizeProbs(byClass.F),
    neutral: summarizeProbs(byClass['.']),
  }

  // Report.
  console.log('\n=== BASELINE (production page, no rerank): cutoff "none" is the same page')
  console.log('\n=== CUTOFF SWEEP (sigmoid probability floor on the production page)')
  console.log('  cutoff  returned  R   A   F   .   P@k    forbRate  recall  relMissed')
  for (const point of sweep) {
    const a = point.aggregates
    console.log(
      `  ${fmtCutoff(point.cutoff)}  ${String(a.returned).padStart(8)}`
      + `  ${String(a.relevant).padStart(2)} ${String(a.acceptable).padStart(2)} ${String(a.forbidden).padStart(2)} ${String(a.neutral).padStart(2)}`
      + `  ${fmt(a.precisionAtK)}  ${fmt(a.forbiddenRate)}   ${fmt(a.recallOfLabeled)}  ${a.relevantMissed}/${a.relevantLabels}`,
    )
  }

  console.log('\n=== FLIPPED ROWS (dropped by the cutoff, per cutoff; label of every change)')
  for (const point of sweep) {
    if (point.cutoff < 0 || point.flipped.length === 0) continue
    console.log(`  cutoff ${point.cutoff.toFixed(2)} (${point.flipped.length} dropped):`)
    for (const row of point.flipped) {
      console.log(
        `    ${row.classification} ${row.id} p=${row.prob.toFixed(4)} fused=${row.fused.toFixed(5)}  ${row.source_path}`
        + (row.section_header === '' ? '' : ` # ${row.section_header.slice(0, 40)}`),
      )
    }
  }

  console.log('\n=== PROBABILITY DISTRIBUTIONS BY LABEL CLASS (all scored rows)')
  console.log('  class    n     min     q1  median     q3     max    mean')
  for (const [cls, stats] of Object.entries(distributions)) {
    console.log(
      `  ${cls.padEnd(6)} ${String(stats.n).padStart(4)}  ${fmt(stats.min)}  ${fmt(stats.q1)}  ${fmt(stats.median)}  ${fmt(stats.q3)}  ${fmt(stats.max)}  ${fmt(stats.mean)}`,
    )
  }

  console.log('\n=== ORDERING (best relevant row index, 1-based, cutoff none)')
  console.log(
    `  baseline mean=${fmt(meanIndex(ordering.baseline))} (n=${ordering.baseline.length})`
    + `  reranked mean=${fmt(meanIndex(ordering.reranked))} (n=${ordering.reranked.length})`,
  )

  console.log('\n=== LATENCY (post-warmup, wall clock, single batched call per query)')
  console.log(`  model load (incl. any download): ${loadMs.toFixed(0)} ms`)
  console.log(`  cache ${cacheModelDir}: ${(cacheFootprint.bytes / 1024 / 1024).toFixed(1)} MB over ${cacheFootprint.files} files`)
  const totalMs = latencies.reduce((total, l) => total + l.ms, 0)
  const scoredRows = latencies.reduce((total, l) => total + l.rows, 0)
  for (const latency of latencies) {
    console.log(
      `  ${latency.id.padEnd(28)} rows=${String(latency.rows).padStart(2)}`
      + ` padTokens=${String(latency.paddedTokens).padStart(3)} ${latency.ms.toFixed(1).padStart(8)} ms`,
    )
  }
  console.log(
    `  total ${scoredRows} rows over ${latencies.length} queries: ${totalMs.toFixed(0)} ms`
    + `  mean/query ${(totalMs / latencies.length).toFixed(1)} ms`
    + `  mean/row ${(totalMs / scoredRows).toFixed(1)} ms`,
  )

  const outPath = opts.out ?? join(HERE, 'results', `${opts.label}.json`)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify({
    harness: 'scripts/eval/cross-encoder-rerank.mjs',
    server: { version: version.version, rowCount },
    collection: MILVUS_COLLECTION,
    config: {
      // The page shape under reranking: search.ts production constants.
      production: {
        topK: TOP_K,
        oversample: CANDIDATE_OVERSAMPLE,
        rrfK: RRF_RANKER_K,
        denseEf: DENSE_SEARCH_EF,
        denseRadius: DENSE_SEARCH_RADIUS,
        denseRange: DENSE_RANGE_MAX,
        sparseRadius: SPARSE_SEARCH_RADIUS,
        fusedFloor: FUSED_SCORE_FLOOR,
        embedder: embedder.modelId,
      },
      reranker: {
        model: RERANKER_MODEL_ID,
        dtype: opts.dtype,
        score: 'sigmoid(raw logit); the pipeline softmax is degenerate at num_labels=1',
        truncation: 'tokenizer truncation to the model max length (512)',
        cacheBytes: cacheFootprint.bytes,
        cacheFiles: cacheFootprint.files,
      },
      cutoffs: opts.cutoffs,
    },
    // Latency and load time are deliberately NOT here: they vary between
    // runs, and this artifact must diff byte-identically (stdout carries
    // them; findings docs quote them).
    ordering: {
      bestRelevantIndexMean: { baseline: meanIndex(ordering.baseline), reranked: meanIndex(ordering.reranked) },
      bestRelevantIndexes: ordering,
    },
    distributions,
    sweep: sweep.map((point) => ({
      cutoff: point.cutoff < 0 ? null : point.cutoff,
      aggregates: point.aggregates,
      flipped: point.flipped,
      rerankedPages: point.rerankedPages,
    })),
    scoredPages: scoredQueries.map(({ entry, rows }) => ({
      id: entry.id,
      origin: entry.origin,
      query: entry.query,
      labels: {
        relevant: labelsOf(entry.relevant),
        acceptable: labelsOf(entry.acceptable),
        forbidden: labelsOf(entry.forbidden),
      },
      ...(entry.note === undefined ? {} : { note: entry.note }),
      rows: rows.map((row) => ({
        chunk_id: row.chunk_id,
        source_path: row.source_path,
        section_header: row.section_header,
        scope: row.scope,
        routes: row.routes,
        fused: row.score,
        logit: row.logit,
        prob: row.prob,
        classification: row.classification,
      })),
    })),
    scoredRows: perRowProbabilities,
  }, null, 2)}\n`)
  progress(`artifact: ${outPath}`)

  await client.closeConnection()
}

main().catch((error) => {
  console.error('[cross-encoder-rerank] FATAL', error)
  process.exitCode = 1
})
