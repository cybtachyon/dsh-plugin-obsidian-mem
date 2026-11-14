#!/usr/bin/env node
/**
 * LiveReindex drives the production indexer code (packages/service/lib,
 * the same IndexerManager the settings card triggers) against the RUNNING
 * milvus-lite server so stored trigger columns (wake_keywords,
 * trigger_extensions, trigger_frameworks) are rewritten for every file of
 * every registered vault. Stored wake arrays are computed at index time,
 * so a core wake-extraction fix (TASK-014, commit 376108d) only reaches
 * live rows once the indexer rewrites them (TASK-015, PLAN-wake-gate).
 *
 * Why the state-read shadow exists: reindex() is a content diff, so a
 * plain reindexAll() after a code change finds every contentHash unchanged
 * and rewrites nothing. The service's supported forced path
 * (dropVaultStateFiles) DELETES the state files, which is forbidden while
 * the host process owns them. Instead this script hands the indexer its
 * documented IndexerFs seam with a read shadow that zeroes the
 * contentHash fields of the in-memory state copy VaultIndexer builds from
 * its own state file at construction. chunkIds are preserved verbatim, so
 * every file still runs the indexer's own delete-old-ids then
 * insert-fresh-rows pair (no duplicate visible entities on lite). The
 * state files on disk are never deleted or hand-edited; the indexer's own
 * atomic saveState replaces them as files land, and a clean run restamps
 * them with fresh hashes.
 *
 * Safety contract:
 * - Attaches only to the server described by {port,pid} in
 *   <dbDir>/.memlite.json and refuses when that pid's cmdline is not a
 *   milvus-lite rooted at dbDir. Never spawns, kills, or restarts.
 * - The only Milvus RPCs are the indexer's own insert and delete-by-id,
 *   plus readyMilvusClient's checkHealth/getVersion handshake and count
 *   lines for reporting. Never a drop, rebuild, DDL, or load call; dim and
 *   model are unchanged. A vault whose state stamp (version/modelId/
 *   vectorDim) drifted from the embedder aborts the run: that migration is
 *   the host's forced-rebuild path, not this one.
 * - The IndexerManager is constructed but never start()ed, so this process
 *   arms no watchers and no stat poll. The running host keeps its own
 *   watchers; a vault note edited during a run can be re-indexed by the
 *   host's in-memory code after this script's rewrite, so touch no vault
 *   notes while it runs.
 * - No LLM refinement: omitting the `llm` option engages the codebase's
 *   disabled LlmRefiner default (heuristics only); no endpoint is invented.
 *
 * Registry derivation mirrors ObsidianMemService.loadRegistry for the
 * default row config (the bundle's obsidian-mem rows in cordis.patch.yml
 * carry no config): config defaults resolved through the service's own
 * validator/resolver, card vaults read from <stateDir>/vaults.json through
 * core resolveVaults, and the already-provisioned default vault path
 * joined when no shared vault exists (its path is computed, never
 * created).
 *
 * Run:
 *   node scripts/live-reindex.mjs --check   # print the plan, write nothing
 *   node scripts/live-reindex.mjs           # reindex every registered vault
 * Output: PLAN/STATE/RESULT lines as JSON on stdout (no timestamps),
 * progress on stderr. Exit code 1 on any failure.
 * @module scripts/live-reindex
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CHECK_ONLY = process.argv.slice(2).includes('--check')
const UNKNOWN_ARGS = process.argv.slice(2).filter((arg) => arg !== '--check')
if (UNKNOWN_ARGS.length > 0) {
  console.error(`live-reindex: unknown argument(s): ${UNKNOWN_ARGS.join(', ')}; usage: live-reindex.mjs [--check]`)
  process.exit(1)
}

// Production pieces imported, never retyped: config validation/resolution
// and the card vaults file name from service/lib, the indexer and its fs
// seam from service/lib, the real embedder, the keepalive-suppressed
// client factory, and the layout constants from core/lib.
const core = await import('../packages/core/lib/index.js')
const {
  dbDir,
  dbStateDir,
  modelCacheDir,
  defaultVaultPath,
  resolveVaults,
  MILVUS_COLLECTION,
  VAULT_MODE_SHARED,
  GLOBAL_MEMORY_FILE_DEFAULT,
} = core
const {
  IndexerManager,
  nodeIndexerFs,
  indexStatePath,
  INDEX_STATE_VERSION,
  STATE_FILE_NAME,
} = await import('../packages/service/lib/indexer.js')
const { validateObsidianMemConfig, resolveServiceConfig } =
  await import('../packages/service/lib/config.js')
const { VAULTS_FILE_NAME } = await import('../packages/service/lib/service.js')
const { createEmbedder } = await import('../packages/service/lib/embedder.js')
const { readyMilvusClient } = await import('../packages/service/lib/milvus/client.js')
const { assertOk } = await import('../packages/service/lib/milvus/ok.js')

const HOME = homedir()
const log = (obj) => console.log(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)))
const progress = (msg) => console.error(`[live-reindex] ${msg}`)
const die = (msg) => {
  throw new Error(msg)
}

// Read the persisted state document directly; used only for the plan, the
// stamp guards, and the before/after chunk-id tallies. Never writes.
function readStateDocument(statePath) {
  const raw = nodeIndexerFs.readFile(statePath)
  if (raw === null) {
    return null
  }
  return JSON.parse(raw)
}

// ForceReindexFs wraps nodeIndexerFs so the ONLY altered call is reading
// a vault's state file: the returned JSON has every files[*].contentHash
// zeroed, which makes the indexer's content diff treat each file as
// changed while its preserved chunkIds keep the stale-delete half of the
// per-file pair. readStateFromDisk runs once per VaultIndexer at
// construction, so the shadow is one-shot by design; saveState writes go
// through unaltered.
function forceReindexFs(statePaths) {
  return {
    ...nodeIndexerFs,
    readFile(path) {
      const raw = nodeIndexerFs.readFile(path)
      if (raw === null || !statePaths.has(path)) {
        return raw
      }
      const doc = JSON.parse(raw)
      for (const file of Object.values(doc.files ?? {})) {
        file.contentHash = ''
      }
      return JSON.stringify(doc)
    },
  }
}

// CardVaultsFileEntries mirrors ObsidianMemService.readVaultsFile's
// tolerant shape filter (path and mode must be strings; a non-string
// globalFile is dropped so the core default wins).
function cardVaultsFileEntries(vaultsFilePath) {
  const raw = nodeIndexerFs.readFile(vaultsFilePath)
  if (raw === null) {
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    die(`${vaultsFilePath} unreadable: ${String(error)}`)
  }
  const entries = Array.isArray(parsed?.vaults) ? parsed.vaults : []
  return entries
    .filter((entry) => typeof entry?.path === 'string' && typeof entry?.mode === 'string')
    .map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      ...(typeof entry.globalFile === 'string' ? { globalFile: entry.globalFile } : {}),
    }))
}

// BuildRegistry replays the service's loadRegistry order: row-config
// vaults first, card vaults second (realpath dupes collapse, first
// wins), and the auto-provisioned default vault when no shared vault
// exists. On this machine the mounted row config is {} (no config on the
// bundle rows), so config.vaults is empty and vaults.json rules.
function buildRegistry(config, probe) {
  const cardPath = join(dbStateDir(config.milvus.dbPath), VAULTS_FILE_NAME)
  const entries = [...config.vaults, ...cardVaultsFileEntries(cardPath)]
  let resolution = resolveVaults(entries, probe)
  if (!resolution.hasSharedVault) {
    resolution = resolveVaults([
      ...entries,
      { path: defaultVaultPath(HOME), mode: VAULT_MODE_SHARED, globalFile: GLOBAL_MEMORY_FILE_DEFAULT },
    ], probe)
  }
  return { cardPath, resolution }
}

// AssertServerIdentity refuses a stale port file: the pid must be alive
// and its cmdline must name milvus-lite rooted at the same dbDir the
// resolved config points at. /proc is Linux-only; elsewhere the check
// warns and passes (the attach itself still targets the file's port).
function assertServerIdentity(portFile) {
  const { port, pid } = JSON.parse(readFileSync(portFile, 'utf8'))
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean)
    const joined = cmdline.join(' ')
    if (!joined.includes('milvus-lite') || !joined.includes('--data-dir') || !joined.includes(dbDir(HOME))) {
      die(`${portFile} pid ${pid} is not the milvus-lite server for ${dbDir(HOME)}: ${joined}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
    progress(`warning: /proc/${pid} unreadable (${String(error)}); attaching to port ${port} unverified`)
  }
  return { port, pid }
}

async function main() {
  const validated = validateObsidianMemConfig({})
  if (validated.issues !== undefined) {
    die(`config defaults rejected: ${validated.issues.map((i) => i.message).join('; ')}`)
  }
  const config = resolveServiceConfig(validated.value, HOME)
  if (config.llm.enabled) {
    die('mounted llm.enabled is true; this script never runs the LLM refine pass, refusing a mismatched run')
  }
  const portFile = process.env.MEMLITE_JSON ?? join(config.milvus.dbPath, '.memlite.json')
  const { port, pid } = assertServerIdentity(portFile)
  progress(`attaching to live milvus-lite pid ${String(pid)} port ${String(port)}`)

  const { cardPath, resolution } = buildRegistry(config, { exists: existsSync, realpath: realpathSync })
  for (const rejection of resolution.rejected) {
    progress(`vault ${rejection.config.path} rejected (${rejection.kind}); not reindexed`)
  }
  if (resolution.vaults.length === 0) {
    die(`no registered vaults (config.vaults empty, ${cardPath} empty); refusing to run`)
  }

  // Per-vault stamp guard: a state file built for another model, width,
  // or schema version means chunk ids would move; that forced migration
  // belongs to the host's rebuild path, never to this maintenance run.
  const plans = resolution.vaults.map((vault) => {
    const statePath = indexStatePath(vault.path)
    const doc = readStateDocument(statePath)
    if (doc === null) {
      die(`${statePath} missing; the live indexer never wrote it (refusing a state-blind reindex that could duplicate chunk ids)`)
    }
    if (doc.version !== INDEX_STATE_VERSION
      || doc.modelId !== config.model.id
      || doc.vectorDim !== config.vectorDim) {
      die(`${statePath} stamp (v${String(doc.version)} ${doc.modelId} ${String(doc.vectorDim)}d) drifted from the resolved config (v${INDEX_STATE_VERSION} ${config.model.id} ${String(config.vectorDim)}d); let the host run its forced rebuild first`)
    }
    const fileCount = Object.keys(doc.files ?? {}).length
    const chunkIds = Object.values(doc.files ?? {}).reduce((sum, file) => sum + (file.chunkIds?.length ?? 0), 0)
    return { vault: vault.path, mode: vault.mode, statePath, fileCount, chunkIds }
  })

  const client = await readyMilvusClient(`127.0.0.1:${port}`)
  try {
    const rowCount = async (what) => Number(
      assertOk(await client.count({ collection_name: MILVUS_COLLECTION }), what).data ?? 0,
    )
    const before = await rowCount('count-before')
    log({
      script: 'PLAN',
      check: CHECK_ONLY,
      server: `127.0.0.1:${port}`,
      modelId: config.model.id,
      dtype: config.model.dtype,
      vectorDim: config.vectorDim,
      llmRefiner: 'disabled (no config passed; heuristics only)',
      rowCountBefore: before,
      vaults: plans,
    })
    if (CHECK_ONLY) {
      progress('--check: plan printed, nothing written')
      return
    }

    const embedder = createEmbedder({
      modelId: config.model.id,
      vectorDim: config.vectorDim,
      dtype: config.model.dtype,
      cacheDir: modelCacheDir(HOME),
    })

    // Constructed, never start()ed: no watcher, no stat poll, no
    // background scan. reindexAll() is the settings-card manual trigger.
    const manager = new IndexerManager({
      vaults: resolution.vaults,
      embedder,
      writer: client,
      fs: forceReindexFs(new Set(plans.map((plan) => plan.statePath))),
      pollIntervalMs: 0,
      log: (message) => { progress(message) },
    })
    await manager.reindexAll()

    const after = await rowCount('count-after')
    const stateTotals = plans.map((plan) => {
      const doc = readStateDocument(plan.statePath)
      const chunkIds = Object.values(doc.files ?? {}).reduce((sum, file) => sum + (file.chunkIds?.length ?? 0), 0)
      return { vault: plan.vault, stateChunkIds: chunkIds }
    })
    log({
      script: 'RESULT',
      rowCountBefore: before,
      rowCountAfter: after,
      progress: manager.progress(),
      stateTotals,
      stateTotalSum: stateTotals.reduce((sum, entry) => sum + entry.stateChunkIds, 0),
    })
    progress(`done: ${String(before)} -> ${String(after)} rows through the indexer code path`)
  } finally {
    await client.closeConnection()
  }
}

main().catch((error) => {
  console.error('[live-reindex] FATAL', error)
  process.exitCode = 1
})
