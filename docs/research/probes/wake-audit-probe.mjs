#!/usr/bin/env node
/**
 * WakeAuditProbe re-runs the TASK-001 (spec Step 1.1) pre-flight
 * measurement: one full scan of the LIVE production `obsidian_mem`
 * collection's `wake_keywords` arrays on the running milvus-lite 3.2.2
 * server. It answers how many rows carry an EMPTY wake array (rows an
 * ARRAY_CONTAINS_ANY wake gate can never return), the empty rate against
 * the spec's >5% STOP threshold, and the global wake-term frequency
 * (top 40) as the generic-intent-marker pollution evidence the PARTIAL
 * decision rule names. The threshold and decision rules live in
 * docs/research/sparse-wake-gate-spec.md §"Step 1"; the measurement
 * record lives in its "Pre-flight measurements (2026-11-13)" section.
 *
 * HARD READ-ONLY: the only RPCs issued are connectPromise, getVersion,
 * count, and query (chunk_id range-split windows). Never a write,
 * delete, drop, createIndex, load, release, search, or DDL call here,
 * and never spawn or kill the server.
 *
 * Server discovery: reads {port, pid} from
 * /home/derek/.dsh/obsidian-mem-db/.memlite.json (override with
 * MEMLITE_JSON=/path). The gRPC client mirrors
 * packages/service/src/milvus/client.ts: lite's Python server GOAWAYs the
 * SDK's default keepalive pings, so channelOptions pin
 * grpc.keepalive_time_ms huge and grpc.keepalive_permit_without_calls 0.
 *
 * Scan discipline: ARRAY_LENGTH filters are unproven on lite 3.2.2, so
 * every row's wake array is fetched once and counted client-side. The
 * TASK file prescribes `chunk_id > <last seen>` cursor pages, but that
 * is unsound on this server: lite 3.2.2 returns query rows in segment
 * order, NOT primary-key order (2026-11-13 probe: a 210-row collection
 * answered `chunk_id > -1` limit 200 with 200 unordered rows and
 * `chunk_id > <page max>` then matched 0, silently losing 10 rows), and
 * the SDK's `order_by` query option is ACCEPTED AND IGNORED (same-day
 * probe: 200 rows, not ascending). This scan instead walks chunk_id
 * RANGE WINDOWS: start at (-1, 2^53-1] (core/idhash masks every chunk_id
 * to a positive 53-bit-safe integer, so JS numbers are exact), query
 * each window with limit L, and split any window that answers exactly L
 * rows into two half-open windows until every window answers under L.
 * A Milvus query limit truncates a full scan, so an under-limit answer
 * is complete for its window, and unique integer ids make a window of
 * span < L un-splittable-to-saturation; the collected id count is
 * cross-checked against the production count-guard shape
 * (search.ts guardCollectionHasRows) and a mismatch is recorded, never
 * silent. Term frequencies count the stored strings verbatim, no
 * normalization.
 *
 * Run: node docs/research/probes/wake-audit-probe.mjs
 * Output: one JSON object per line on stdout (BOOT with version and
 * rowCount; one SPLIT line per saturated window and one WINDOW line per
 * drained window; FINAL with total rows, empty-wake rows, and the empty
 * rate against the 5% threshold; TERMS with the top 40 global wake-term
 * frequencies); progress on stderr. Deterministic: no timestamps.
 * @module docs/research/probes/wake-audit-probe
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { MilvusClient } = require('@zilliz/milvus2-sdk-node')

// Production names imported, never retyped (TASK-004 discipline): the
// collection + field + consistency names from core/lib.
const {
  MILVUS_COLLECTION,
  MILVUS_CONSISTENCY_LEVEL,
  MILVUS_FIELDS,
} = await import('../../../packages/core/lib/index.js')

const PORT_FILE = process.env.MEMLITE_JSON
  ?? '/home/derek/.dsh/obsidian-mem-db/.memlite.json'
const REQUEST_TIMEOUT_MS = 60_000
const QUERY_WINDOW_LIMIT = 200
// core/idhash masks every chunk_id to the low 53 bits: positive and
// Number-safe, so window bounds below are exact JS integers.
const CHUNK_ID_MAX = 2 ** 53 - 1
const MAX_WINDOW_QUERIES = 500
const TERMS_TOP = 40
// Spec Step 1.1: more than 5% of rows with empty wake arrays STOPs the
// plan; wake extraction is fixed before the gate is wired.
const EMPTY_RATE_STOP_PCT = 5

const log = (obj) => console.log(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
const progress = (msg) => console.error(`[wake-audit-probe] ${msg}`)

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
  const version = await client.getVersion()
  // Production count-guard shape (search.ts guardCollectionHasRows):
  // count before the scan; an empty collection answers nothing.
  const rowCount = Number((await client.count({ collection_name: MILVUS_COLLECTION })).data ?? 0)
  log({ probe: 'BOOT', version, rowCount })
  if (rowCount === 0) {
    throw new Error(`${MILVUS_COLLECTION} is empty; the audit answers nothing (not a server fault)`)
  }

  // WINDOW: the full wake_keywords fetch, chunk_id range-split scan (see
  // the docblock for why cursor pages are unsound here). A window that
  // answers under the limit is complete; only a saturated (== limit)
  // window splits. A row whose wake field is missing or non-array
  // counts as empty and is tallied separately as an anomaly.
  const wakeById = new Map()
  let nonArrayWake = 0
  let windowQueries = 0
  const pending = [[-1, CHUNK_ID_MAX]]
  while (pending.length > 0) {
    if (windowQueries >= MAX_WINDOW_QUERIES) {
      throw new Error(`scan exceeded MAX_WINDOW_QUERIES ${String(MAX_WINDOW_QUERIES)}; aborting before runaway windowing`)
    }
    const [lo, hi] = pending.pop()
    windowQueries += 1
    const found = await client.query({
      collection_name: MILVUS_COLLECTION,
      expr: `${MILVUS_FIELDS.chunkId} > ${String(lo)} and ${MILVUS_FIELDS.chunkId} <= ${String(hi)}`,
      output_fields: [MILVUS_FIELDS.chunkId, MILVUS_FIELDS.sourcePath, MILVUS_FIELDS.wakeKeywords],
      limit: QUERY_WINDOW_LIMIT,
      consistency_level: MILVUS_CONSISTENCY_LEVEL,
    })
    const rows = (found?.data ?? []).map((row) => ({
      chunkId: Number(row[MILVUS_FIELDS.chunkId]),
      wake: row[MILVUS_FIELDS.wakeKeywords],
    }))
    if (rows.length >= QUERY_WINDOW_LIMIT) {
      if (hi - lo < QUERY_WINDOW_LIMIT) {
        throw new Error(`window (${String(lo)}, ${String(hi)}] answered ${String(rows.length)} rows at span below the limit; unique integer ids make this impossible`)
      }
      const mid = lo + Math.floor((hi - lo) / 2)
      pending.push([lo, mid], [mid, hi])
      log({ probe: 'SPLIT', lo, hi, mid, n: rows.length })
      progress(`split window (${String(lo)}, ${String(hi)}] at ${String(mid)}`)
      continue
    }
    for (const { chunkId, wake } of rows) {
      if (!Array.isArray(wake)) nonArrayWake += 1
      wakeById.set(chunkId, Array.isArray(wake) ? wake : [])
    }
    log({ probe: 'WINDOW', lo, hi, n: rows.length, collected: wakeById.size })
    progress(`window (${String(lo)}, ${String(hi)}]: ${String(rows.length)} rows, collected ${String(wakeById.size)}/${String(rowCount)}`)
  }

  const collected = wakeById.size
  const collectedIds = [...wakeById.keys()].sort((a, b) => a - b)
  let emptyWakeRows = 0
  const termFreq = new Map()
  for (const wake of wakeById.values()) {
    if (wake.length === 0) emptyWakeRows += 1
    for (const term of wake) termFreq.set(term, (termFreq.get(term) ?? 0) + 1)
  }
  const emptyRatePct = collected === 0 ? Number.NaN : (emptyWakeRows / collected) * 100
  const stop = emptyRatePct > EMPTY_RATE_STOP_PCT

  log({
    probe: 'FINAL',
    server: version,
    rowCount,
    windowQueries,
    collected,
    scanComplete: collected === rowCount,
    firstChunkId: collectedIds[0] ?? null,
    lastChunkId: collectedIds[collectedIds.length - 1] ?? null,
    nonArrayWake,
    emptyWakeRows,
    emptyRatePct: Number.isFinite(emptyRatePct) ? Math.round(emptyRatePct * 1000) / 1000 : null,
    stopThresholdPct: EMPTY_RATE_STOP_PCT,
    decision: stop ? 'STOP' : 'no-STOP',
  })
  if (collected !== rowCount) {
    progress(`WARNING: scan collected ${String(collected)} rows but count said ${String(rowCount)}; rate is over the collected rows`)
  }

  // TERMS: global wake-term frequency, ties broken by term so re-runs
  // are stable. This is the wake-list pollution evidence.
  const top = [...termFreq.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, TERMS_TOP)
    .map(([term, rows]) => ({ term, rows }))
  log({ probe: 'TERMS', distinctTerms: termFreq.size, top })

  await client.closeConnection()
  progress('done')
}

main().catch((error) => {
  console.error('[wake-audit-probe] FATAL', error)
  process.exitCode = 1
})
