#!/usr/bin/env node
/**
 * WakeKillCheckProbe runs the TASK-002 (spec Step 1.2) pre-flight
 * measurement: the expected-kill check for the wake gate. It locates the
 * 6 forbidden sparse-only collision rows of
 * docs/research/sparse-wake-gate-spec.md §Problem inside the committed
 * production-parity artifact
 * docs/research/eval-split-strip-on-d078-s50-k60-m016129.json
 * (`routes: "sparse"`, `classification: "F"`), fetches each row's STORED
 * wake_keywords from the LIVE collection, recomputes each labeled
 * query's stripped token list through the shipped `sparseQueryText`, and
 * predicts per row: survives the gate (token ∩ wake is non-empty) or
 * dies (empty intersection). A collision row whose wake array CONTAINS
 * its collision word is wake-list pollution and is called out per row
 * (spec Decision rules PARTIAL). It also predicts survive/die for every
 * artifact row classified relevant that was visible on the sparse leg
 * (routes sparse|both), the rows whose loss would sink the PASS rule
 * "relevant-of-labeled must not drop", and re-checks the post-TASK-015
 * collection invariants (empty-wake rows, generic intent markers) on the
 * same full scan. The measurement record lives in the spec doc's
 * "Pre-flight measurements (2026-11-13)" section; the prediction is
 * compared against the TASK-011 A/B outcome.
 *
 * HARD READ-ONLY: the only RPCs issued are connectPromise, getVersion,
 * count, and query (chunk_id range-split windows). Never a write,
 * delete, drop, createIndex, load, release, search, or DDL call here,
 * and never spawn or kill the server.
 *
 * Server discovery and scan discipline are identical to
 * wake-audit-probe.mjs (keepalive suppression per
 * packages/service/src/milvus/client.ts; chunk_id RANGE WINDOWS because
 * lite 3.2.2 answers `query` in segment order and silently loses rows
 * under PK-cursor paging; collected ids cross-checked against the
 * count-guard). Token discipline per spec §Gate definition: token
 * source is `sparseQueryText(query)` split on single spaces (the
 * strip's join shape, imported from packages/service/lib/search.js,
 * never restated), then run through the shipped `sparseWakeFilterTokens`
 * itself (the gate's own legality and cap, imported, not restated). The
 * RAW split is tallied too; a verdict that differs between the two
 * token forms is reported, never hidden.
 *
 * Collision rows are derived from the artifact at run time (the
 * routes/classification filter), never hand-copied; the §Problem table
 * supplies the collision WORDS, held here as EXPECTED_COLLISIONS and
 * cross-checked: a set mismatch against the artifact is a hard stop.
 *
 * Run: node docs/research/probes/wake-kill-check-probe.mjs
 * Env overrides: MEMLITE_JSON (server file), EVAL_ARTIFACT (json).
 * Output: one JSON object per line on stdout (BOOT; INVARIANT with
 * empty-wake and generic-marker counts; TOKENS per labeled query; one
 * COLLISION line per collision row with the per-word pollution check
 * and the survive/die prediction; one RELEVANT line per relevant
 * sparse-visible artifact row; FINAL rollup); progress on stderr.
 * Deterministic: no timestamps.
 * @module docs/research/probes/wake-kill-check-probe
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { MilvusClient } = require('@zilliz/milvus2-sdk-node')

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../..')

// Production names imported, never retyped (TASK-004 discipline).
const {
  MILVUS_COLLECTION,
  MILVUS_CONSISTENCY_LEVEL,
  MILVUS_FIELDS,
} = await import('../../../packages/core/lib/index.js')
// The shipped strip is the token source and the shipped
// sparseWakeFilterTokens is the filter-token legality/cap; both are
// imported, neither is re-implemented.
const { sparseQueryText, sparseWakeFilterTokens } = await import('../../../packages/service/lib/search.js')
// The committed labeled query set the eval harness replays.
const { EVAL_QUERIES } = await import('../../../scripts/eval/queries-labels.mjs')

const PORT_FILE = process.env.MEMLITE_JSON
  ?? '/home/derek/.dsh/obsidian-mem-db/.memlite.json'
const ARTIFACT = process.env.EVAL_ARTIFACT
  ?? resolve(REPO, 'docs/research/eval-split-strip-on-d078-s50-k60-m016129.json')
const REQUEST_TIMEOUT_MS = 60_000
const QUERY_WINDOW_LIMIT = 200
// core/idhash masks every chunk_id to the low 53 bits (wake-audit-probe).
const CHUNK_ID_MAX = 2 ** 53 - 1
const MAX_WINDOW_QUERIES = 500
// The empty-wake ceiling already enforced by Step 1.1 (spec §Step 1).
const EMPTY_RATE_STOP_PCT = 5
// Generic intent markers dropped by core `isUsableKeyword` in TASK-014.
// The set is module-private in packages/core/src/triggers.ts, so the
// AUDIT holds its own copy on purpose: it measures stored rows against
// the words, it does not reuse production code.
const GENERIC_WAKE_TERMS = Object.freeze(['who', 'what', 'when', 'where', 'why', 'how', 'how to apply'])

// spec §Problem "the 6 collision rows and the query token that pulled
// each" — the collision VOCAB columns, keyed by query + row source_path
// exactly as the artifact stores them. A drift between this table and
// the artifact's sparse-only forbidden rows is a hard stop.
const EXPECTED_COLLISIONS = [
  { query: 'dream-plan-runs-actually', sourcePath: 'drupal/bigpipe-streams-checkout-before-drupalsettings.md', words: ['checkout'] },
  { query: 'budget-reminder-end-of-turn', sourcePath: 'guestwise/drupal-installs-uid-1-has-no-global-roles-group-locked-entities-403-for-it.md', words: ['locked', 'roles'] },
  { query: 'machinae-combat-systems', sourcePath: 'lywa/lywa-solr-pywsd-runner.md', words: ['runner', 'enemy'] },
  { query: 'machinae-combat-systems', sourcePath: 'drupal/svg-overlay-swallowed-clicks.md', words: ['clicks', 'entities'] },
  { query: 'machinae-save-restore', sourcePath: 'lywa/lywa-commerce-phpunit-infra.md', words: ['test', 'save'] },
  { query: 'machinae-threejs-renderer', sourcePath: 'drupal/bigpipe-streams-checkout-before-drupalsettings.md', words: ['render'] },
]

const log = (obj) => console.log(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
const progress = (msg) => console.error(`[wake-kill-check-probe] ${msg}`)

/**
 * gateTokens recomputes one query's shipped filter-token list: the
 * production strip split on its single-space join, then the shipped
 * sparseWakeFilterTokens (imported from packages/service/lib — the
 * legality and cap the gate itself applies). Returns { raw, normalized }:
 * `raw` is the task-mandated split of sparseQueryText output;
 * `normalized` is what the shipped clause actually sends in
 * ARRAY_CONTAINS_ANY.
 */
function gateTokens(query) {
  const stripped = sparseQueryText(query)
  const raw = stripped === '' ? [] : stripped.split(' ')
  return { raw, normalized: sparseWakeFilterTokens(raw) }
}

/**
 * predict intersect()s a query's token list with the row's stored wake
 * array verbatim (ARRAY_CONTAINS_ANY semantics are exact-string).
 */
function predict(tokenList, wakeSet) {
  const hits = tokenList.filter((t) => wakeSet.has(t))
  return { survives: hits.length > 0, hits }
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
  const version = await client.getVersion()
  const rowCount = Number((await client.count({ collection_name: MILVUS_COLLECTION })).data ?? 0)
  log({ probe: 'BOOT', server: version.version, rowCount })
  if (rowCount === 0) {
    throw new Error(`${MILVUS_COLLECTION} is empty; the check answers nothing (not a server fault)`)
  }

  // WINDOW: one full scan (chunk_id, source_path, section_header,
  // wake_keywords) over chunk_id RANGE WINDOWS — the wake-audit-probe
  // pattern; PK-cursor paging is unsound on lite 3.2.2.
  /** @type {Map<number, {sourcePath: string, sectionHeader: string, wake: string[]}>} */
  const rowsById = new Map()
  /** @type {Map<string, number>} source_path + section_header -> chunk_id */
  const idByKey = new Map()
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
      output_fields: [MILVUS_FIELDS.chunkId, MILVUS_FIELDS.sourcePath, MILVUS_FIELDS.sectionHeader, MILVUS_FIELDS.wakeKeywords],
      limit: QUERY_WINDOW_LIMIT,
      consistency_level: MILVUS_CONSISTENCY_LEVEL,
    })
    const rows = (found?.data ?? []).map((row) => ({
      chunkId: Number(row[MILVUS_FIELDS.chunkId]),
      sourcePath: row[MILVUS_FIELDS.sourcePath],
      sectionHeader: row[MILVUS_FIELDS.sectionHeader],
      wake: row[MILVUS_FIELDS.wakeKeywords],
    }))
    if (rows.length >= QUERY_WINDOW_LIMIT) {
      if (hi - lo < QUERY_WINDOW_LIMIT) {
        throw new Error(`window (${String(lo)}, ${String(hi)}] answered ${String(rows.length)} rows at span below the limit; unique integer ids make this impossible`)
      }
      const mid = lo + Math.floor((hi - lo) / 2)
      pending.push([lo, mid], [mid, hi])
      progress(`split window (${String(lo)}, ${String(hi)}] at ${String(mid)}`)
      continue
    }
    for (const row of rows) {
      if (!Array.isArray(row.wake)) nonArrayWake += 1
      rowsById.set(row.chunkId, { ...row, wake: Array.isArray(row.wake) ? row.wake : [] })
      idByKey.set(`${row.sourcePath}\u0000${row.sectionHeader}`, row.chunkId)
    }
  }

  // INVARIANT: re-check the post-TASK-015 truth on this same scan: zero
  // empty wake arrays and zero generic intent markers corpus-wide. A
  // regression means a watcher re-polluted the collection; re-run
  // scripts/live-reindex.mjs before trusting any prediction here.
  let emptyWakeRows = 0
  const markerCounts = Object.fromEntries(GENERIC_WAKE_TERMS.map((t) => [t, 0]))
  let markerTotal = 0
  for (const row of rowsById.values()) {
    if (row.wake.length === 0) emptyWakeRows += 1
    for (const term of row.wake) {
      if (term in markerCounts) {
        markerCounts[term] += 1
        markerTotal += 1
      }
    }
  }
  const emptyRatePct = rowsById.size === 0 ? null : Math.round((emptyWakeRows / rowsById.size) * 100_000) / 1000
  log({
    probe: 'INVARIANT',
    windowQueries,
    collected: rowsById.size,
    scanComplete: rowsById.size === rowCount,
    nonArrayWake,
    emptyWakeRows,
    emptyRatePct,
    stopThresholdPct: EMPTY_RATE_STOP_PCT,
    genericMarkerCounts: markerCounts,
    genericMarkerTotal: markerTotal,
    invariantsHold: rowsById.size === rowCount && nonArrayWake === 0 && emptyWakeRows === 0 && markerTotal === 0,
  })

  // TOKENS: one line per labeled query, artifact order, with both token
  // forms so a raw-vs-normalized prediction gap is visible.
  const queryById = new Map(EVAL_QUERIES.map((entry) => [entry.id, entry]))
  const tokensById = new Map()
  for (const entry of EVAL_QUERIES) {
    const { raw, normalized } = gateTokens(entry.query)
    tokensById.set(entry.id, { raw, normalized })
    log({ probe: 'TOKENS', query: entry.id, rawCount: raw.length, normalizedCount: normalized.length, normalized })
  }

  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'))
  const artifactQueries = new Map(artifact.queries.map((entry) => [entry.id, entry]))

  /**
   * liveRowFor resolves an artifact row to its live stored row: exact
   * chunk_id first (the reindex preserved chunkIds), then the
   * source_path+section_header pair when the id is gone (a note edited
   * after the eval re-hashes its chunk ids).
   */
  function liveRowFor(artRow) {
    const byId = rowsById.get(Number(artRow.chunk_id))
    if (byId !== undefined) return { row: byId, matchBy: 'chunk_id', chunkId: Number(artRow.chunk_id) }
    const key = `${artRow.source_path}\u0000${artRow.section_header}`
    const fallbackId = idByKey.get(key)
    if (fallbackId !== undefined) return { row: rowsById.get(fallbackId), matchBy: 'source_path+section_header', chunkId: fallbackId }
    return { row: undefined, matchBy: 'absent', chunkId: Number(artRow.chunk_id) }
  }

  // COLLISION: derive the sparse-only forbidden rows from the artifact,
  // cross-check against the §Problem table, then predict each.
  const derived = []
  for (const q of artifact.queries) {
    for (const r of q.returned ?? []) {
      if (r.routes === 'sparse' && r.classification === 'F') derived.push({ query: q.id, artRow: r })
    }
  }
  const keyOf = (entry) => `${entry.query}\u0000${entry.sourcePath ?? entry.artRow.source_path}`
  const expectedKeys = EXPECTED_COLLISIONS.map((entry) => `${entry.query}\u0000${entry.sourcePath}`).sort()
  const derivedKeys = derived.map(keyOf).sort()
  if (JSON.stringify(expectedKeys) !== JSON.stringify(derivedKeys)) {
    throw new Error(`collision drift: artifact sparse-only forbidden rows ${JSON.stringify(derivedKeys)} != spec §Problem table ${JSON.stringify(expectedKeys)}`)
  }

  let predictedSurvives = 0
  let predictedDies = 0
  let pollutedRows = 0
  for (const expected of EXPECTED_COLLISIONS) {
    const entry = derived.find((d) => keyOf(d) === `${expected.query}\u0000${expected.sourcePath}`)
    const artRow = entry.artRow
    const { row, matchBy, chunkId } = liveRowFor(artRow)
    if (row === undefined) {
      log({ probe: 'COLLISION', query: expected.query, source_path: expected.sourcePath, section_header: artRow.section_header, chunkId, matchBy, error: 'no live row: cannot measure' })
      continue
    }
    const wakeSet = new Set(row.wake)
    const words = expected.words.map((word) => ({ word, inWake: wakeSet.has(word) }))
    const pollution = words.some((w) => w.inWake)
    const { raw, normalized } = tokensById.get(expected.query)
    const norm = predict(normalized, wakeSet)
    const rawPred = predict(raw, wakeSet)
    // Sanity: a §Problem collision word should be a stripped token of
    // its query (that is what made the row retrievable on the leg).
    const wordTokenSanity = Object.fromEntries(expected.words.map((w) => [w, normalized.includes(w.toLowerCase())]))
    if (norm.survives !== rawPred.survives) {
      progress(`NOTE: raw and normalized predictions differ for ${expected.query} x ${expected.sourcePath}: raw=${String(rawPred.survives)} normalized=${String(norm.survives)}`)
    }
    if (norm.survives) predictedSurvives += 1
    else predictedDies += 1
    if (pollution) pollutedRows += 1
    log({
      probe: 'COLLISION',
      query: expected.query,
      source_path: expected.sourcePath,
      section_header: artRow.section_header,
      artifactChunkId: artRow.chunk_id,
      chunkId,
      matchBy,
      wakeCount: row.wake.length,
      collisionWords: words,
      wakeListPollution: pollution,
      strippedTokenCount: normalized.length,
      intersection: norm.hits,
      predicted: norm.survives ? 'survives' : 'dies',
      rawPredictionAgrees: norm.survives === rawPred.survives,
      collisionWordIsStrippedToken: wordTokenSanity,
    })
  }

  // RELEVANT: every artifact row classified 'R' whose routes include
  // the sparse leg (sparse or both): the gate can remove these from the
  // sparse side, and their loss is what the PASS rule "relevant-of-
  // labeled must not drop" guards. Rows the gate predicts to survive
  // stay reachable on the leg.
  let relevantSurvives = 0
  let relevantDies = 0
  let relevantAbsent = 0
  for (const q of artifact.queries) {
    const entry = queryById.get(q.id)
    if (entry === undefined) continue
    for (const r of q.returned ?? []) {
      if (r.classification !== 'R') continue
      if (r.routes !== 'sparse' && r.routes !== 'both') continue
      const { row, matchBy, chunkId } = liveRowFor(r)
      if (row === undefined) {
        relevantAbsent += 1
        log({ probe: 'RELEVANT', query: q.id, source_path: r.source_path, section_header: r.section_header, chunkId, matchBy, routes: r.routes, predicted: 'row-absent' })
        continue
      }
      const wakeSet = new Set(row.wake)
      const { raw, normalized } = tokensById.get(q.id)
      const norm = predict(normalized, wakeSet)
      if (norm.survives) relevantSurvives += 1
      else relevantDies += 1
      log({
        probe: 'RELEVANT',
        query: q.id,
        source_path: r.source_path,
        section_header: r.section_header,
        artifactChunkId: r.chunk_id,
        chunkId,
        matchBy,
        routes: r.routes,
        wakeCount: row.wake.length,
        intersection: norm.hits,
        predicted: norm.survives ? 'survives' : 'dies',
        rawPredictionAgrees: norm.survives === predict(raw, wakeSet).survives,
      })
    }
  }

  log({
    probe: 'FINAL',
    rowCount,
    collisionsTotal: derived.length,
    predictedDies,
    predictedSurvives,
    wakeListPollutionRows: pollutedRows,
    relevantSparseVisibleTotal: relevantSurvives + relevantDies + relevantAbsent,
    relevantSurvives,
    relevantDies,
    relevantAbsent,
    decisionNote: pollutedRows === 0 && predictedDies === derived.length
      ? 'clean sweep: every collision row dies under the gate and no wake array contains its collision word'
      : 'pollution or survivors present: see COLLISION lines (spec PARTIAL rule)',
  })

  await client.closeConnection()
  progress('done')
}

main().catch((error) => {
  console.error('[wake-kill-check-probe] FATAL', error)
  process.exitCode = 1
})
