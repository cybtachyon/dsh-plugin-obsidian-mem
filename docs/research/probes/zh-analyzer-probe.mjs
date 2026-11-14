#!/usr/bin/env node
/**
 * ZhAnalyzerProbe replays the TASK-005 zh probe: BM25 searches of pinned
 * Han query shapes against the LIVE production `obsidian_mem` collection,
 * to show what the default Milvus analyzer (no jieba) stores and matches
 * for Han text. The settled finding (maximal Han runs on both index and
 * query sides, so per-codepoint query tokens provably cannot match a Han
 * word) lives in docs/research/stopword-strip-findings.md §"CJK analyzer
 * open question" and the rule home is the sparseQueryText docblock in
 * packages/service/src/search.ts; this script is the re-runnable form of
 * the evidence the TASK-005 run recorded in a /tmp-only dump.
 *
 * HARD READ-ONLY: the only RPCs issued are connectPromise, getVersion,
 * count, query (two read-only chunk_text like lookups that locate the
 * Han-bearing chunks), and search. Never a write, delete, drop,
 * createIndex, load, release, or DDL call here, and never spawn or kill
 * the server.
 *
 * Server discovery: reads {port, pid} from
 * /home/derek/.dsh/obsidian-mem-db/.memlite.json (override with
 * MEMLITE_JSON=/path). The gRPC client mirrors
 * packages/service/src/milvus/client.ts: lite's Python server GOAWAYs the
 * SDK's default keepalive pings, so channelOptions pin
 * grpc.keepalive_time_ms huge and grpc.keepalive_permit_without_calls 0.
 *
 * Text discipline: the split forms are PINNED STRINGS, reproducing the
 * TASK-002-era per-codepoint strip output exactly (the shipped TASK-018
 * code no longer produces them); only the `shipped-strip-out` line is
 * computed, via the sparseQueryText imported from the shipped lib
 * (packages/service/lib/search.js), so it follows the current rule the
 * docblock states. Searches ride the production sparse route shape:
 * anns_field MILVUS_FIELDS.sparseVector, metric_type BM25, params {}
 * (floorless: this probe reads raw scores, no client floor), limit 12,
 * Strong consistency. A re-run shows the same analyzer facts; the hit
 * CHUNKS depend on live collection content (2026-11-13: exactly two
 * Han-bearing chunks).
 *
 * Run: node docs/research/probes/zh-analyzer-probe.mjs [--wake-gate]
 * WITHOUT --wake-gate (default OFF) the output is byte-identical to the
 * TASK-003 pin. WITH --wake-gate every SEARCH carries the production
 * sparse-leg wake gate as its scalar expr, built the way dispatchRoutes
 * builds it (ARRAY_CONTAINS_ANY(wake_keywords, [sparseWakeFilterTokens
 * (sparseQueryTokens(text))]) via buildFilterExpr, fail-open to no expr
 * when no token survives; the imported SPARSE_WAKE_GATE_ENABLED kill
 * switch is honored, --wake-gate then a noted no-op), and the SEARCH
 * lines echo that expr. This is the TASK-010/011 zh comparison form
 * (PLAN-wake-gate TASK-007).
 * Output: one JSON object per line on stdout (BOOT, two LOCATE context
 * lines, one SEARCH line per pinned text with its surviving
 * {chunk_id, source_path, score} digest, then a SUMMARY roll-up);
 * progress on stderr. Deterministic: fixed texts, fixed limit, no
 * timestamps.
 * @module docs/research/probes/zh-analyzer-probe
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { MilvusClient } = require('@zilliz/milvus2-sdk-node')

// Production names imported, never retyped (TASK-004 discipline): the
// collection + field + consistency names from core/lib, and the strip
// itself from the shipped service lib.
const {
  MILVUS_COLLECTION,
  MILVUS_CONSISTENCY_LEVEL,
  MILVUS_FIELDS,
} = await import('../../../packages/core/lib/index.js')
const {
  SPARSE_WAKE_GATE_ENABLED,
  buildFilterExpr,
  sparseQueryText,
  sparseQueryTokens,
  sparseWakeFilterTokens,
} = await import('../../../packages/service/lib/search.js')

// --wake-gate is the only accepted flag; default OFF keeps the output
// byte-identical to the TASK-003 pin. Parse errors surface through
// main()'s FATAL path (called there, not at module load).
function parseWakeGate(argv) {
  let wakeGate = false
  for (const arg of argv) {
    if (arg !== '--wake-gate') {
      throw new Error(`unknown argument "${arg}" (only --wake-gate is accepted)`)
    }
    wakeGate = true
  }
  return wakeGate
}

// wakeGateExpr builds the production sparse-leg wake gate for one probe
// text exactly as search.ts dispatchRoutes merges it
// (docs/research/sparse-wake-gate-spec.md §"Gate definition"): the
// clause is buildFilterExpr({ wakeKeywords }) over
// sparseWakeFilterTokens(sparseQueryTokens(text)) with the shipped
// quoteExpr/listLiteral escaping. There is no base expr here (the probe
// dispatches ungated otherwise), and fail-open is the same shape: no
// usable token survives legality → no clause → the search keeps today's
// no-expr form (single-codepoint texts gate empty, exactly the
// spec §Step 1.3 reading).
function wakeGateExpr(text) {
  return buildFilterExpr({ wakeKeywords: sparseWakeFilterTokens(sparseQueryTokens(text)) })
}

const PORT_FILE = process.env.MEMLITE_JSON
  ?? '/home/derek/.dsh/obsidian-mem-db/.memlite.json'
const REQUEST_TIMEOUT_MS = 60_000
const SEARCH_LIMIT = 12
const LOCATE_LIMIT = 50
// The phrase the TASK-005 probe was phrased on: 智能体的共享记忆, from
// the plugin's own Chinese README copy that
// chinese-copy-plugin-description-grammar-rules.md documents.
const SOURCE_PHRASE = '智能体的共享记忆'

// Pinned probe texts, mirroring the findings-doc evidence table one row
// each. t002-strip-out and split-unstripped are fixed strings of
// codepoint tokens: they record the TASK-002-era strip shape, not what
// any current function returns. cp-* are the single-codepoint lookups;
// run-* are whole maximal Han runs; substr-共享记忆 is a substring that
// is NOT a stored token, the substring != token control.
const PINNED_TEXTS = [
  { id: 'raw-joined', text: '智能体的共享记忆', note: 'whole phrase as one Han run (what --keep-stopwords sends)' },
  { id: 't002-strip-out', text: '智 能 体 享 记 忆', note: 'TASK-002-era sparseQueryText output, 的 removed (pinned form)' },
  { id: 'split-unstripped', text: '智 能 体 的 共 享 记 忆', note: 'per-codepoint split with 的 kept (pinned form)' },
  { id: 'cp-智', text: '智', note: 'single codepoint' },
  { id: 'cp-能', text: '能', note: 'single codepoint' },
  { id: 'cp-体', text: '体', note: 'single codepoint' },
  { id: 'cp-共', text: '共', note: 'single codepoint' },
  { id: 'cp-享', text: '享', note: 'single codepoint' },
  { id: 'cp-记', text: '记', note: 'single codepoint' },
  { id: 'cp-忆', text: '忆', note: 'single codepoint' },
  { id: 'cp-的', text: '的', note: 'single codepoint (the standalone-run accident: zho list entry)' },
  { id: 'run-记忆', text: '记忆', note: 'whole Han run' },
  { id: 'run-智能体', text: '智能体', note: 'whole Han run' },
  { id: 'run-的共享记忆', text: '的共享记忆', note: 'the maximal run as the note stores it' },
  { id: 'substr-共享记忆', text: '共享记忆', note: 'substring of 的共享记忆, not a stored token (control)' },
]

const log = (obj) => console.log(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
const progress = (msg) => console.error(`[zh-analyzer-probe] ${msg}`)

// digestHits maps a search response's rows to the evidence shape the
// findings table reasons over: full chunk_id, vault-relative source_path,
// raw (negated-relevance) BM25 score.
function digestHits(rows) {
  return rows.map((hit) => ({
    chunk_id: String(hit[MILVUS_FIELDS.chunkId] ?? hit.id ?? '?'),
    source_path: String(hit[MILVUS_FIELDS.sourcePath] ?? ''),
    score: hit.score,
  }))
}

// searchHits unpacks client.search results: SDK returns results[qid][]
// for standalone search (radius-probe searchHits shape).
function searchHits(response) {
  const results = response?.results ?? []
  return Array.isArray(results[0]) || results.length === 0 ? results[0] ?? [] : results
}

async function main() {
  let wakeGate = parseWakeGate(process.argv.slice(2))
  if (wakeGate && !SPARSE_WAKE_GATE_ENABLED) {
    progress('note: SPARSE_WAKE_GATE_ENABLED is false in the shipped lib; --wake-gate is a no-op, mirroring the production kill switch')
    wakeGate = false
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
  const version = await client.getVersion()
  const rowCount = Number((await client.count({ collection_name: MILVUS_COLLECTION })).data ?? 0)
  log({ probe: 'BOOT', version, rowCount, ...(wakeGate ? { wakeGate: true } : {}) })
  if (rowCount === 0) {
    throw new Error(`${MILVUS_COLLECTION} is empty; the probe answers nothing (not a server fault)`)
  }

  // LOCATE: which chunks hold Han text at all, so every SEARCH digest is
  // interpretable (2026-11-13: exactly two Han-bearing chunks). Read-only
  // `like` lookups on the two probe runs, the same way TASK-005 verified
  // the corpus by a chunk_text projection.
  const locates = []
  for (const [id, term] of [['LOCATE-记忆', '记忆'], ['LOCATE-智能体', '智能体']]) {
    const found = await client.query({
      collection_name: MILVUS_COLLECTION,
      expr: `chunk_text like "%${term}%"`,
      output_fields: [MILVUS_FIELDS.chunkId, MILVUS_FIELDS.sourcePath],
      limit: LOCATE_LIMIT,
      consistency_level: MILVUS_CONSISTENCY_LEVEL,
    })
    const rows = digestHits(found?.data ?? [])
    locates.push({ probe: id, term, rows })
    log({ probe: id, term, rows })
  }

  // SEARCH: the pinned texts, then the shipped strip's CURRENT output for
  // the source phrase (computed via the imported sparseQueryText so the
  // line follows the shipped rule instead of a restatement).
  const shippedText = sparseQueryText(SOURCE_PHRASE)
  const searches = []
  for (const { id, text, note } of [
    ...PINNED_TEXTS,
    {
      id: 'shipped-strip-out',
      text: shippedText,
      note: 'sparseQueryText("智能体的共享记忆") as shipped (TASK-018 rule, computed via the lib import)',
    },
  ]) {
    if (text.trim() === '') {
      // A stripped-to-empty text must never reach lite (the production
      // fail-open); record why the line is skipped rather than erroring.
      log({ probe: id, text, note, skipped: 'empty after strip; production fail-open would send the original' })
      continue
    }
    // Production-merged gate expr per SEARCH when --wake-gate (default
    // OFF: expr undefined, request and output byte-identical to today).
    const expr = wakeGate ? wakeGateExpr(text) : undefined
    const response = await client.search({
      collection_name: MILVUS_COLLECTION,
      ...(expr === undefined ? {} : { expr }),
      anns_field: MILVUS_FIELDS.sparseVector,
      data: [text],
      limit: SEARCH_LIMIT,
      metric_type: 'BM25',
      params: {},
      output_fields: [MILVUS_FIELDS.chunkId, MILVUS_FIELDS.sourcePath],
      consistency_level: MILVUS_CONSISTENCY_LEVEL,
    })
    const digest = digestHits(searchHits(response))
    searches.push({ probe: id, text, hits: digest })
    log({ probe: id, text, note, ...(expr === undefined ? {} : { expr }), n: digest.length, digest })
  }

  log({
    probe: 'SUMMARY',
    server: version,
    rowCount,
    shippedStripText: shippedText,
    hits: searches.map(({ probe: id, text, hits }) => ({
      probe: id,
      text,
      hitChunkIds: hits.map((hit) => hit.chunk_id),
    })),
  })

  await client.closeConnection()
  progress('done')
}

main().catch((error) => {
  console.error('[zh-analyzer-probe] FATAL', error)
  process.exitCode = 1
})
