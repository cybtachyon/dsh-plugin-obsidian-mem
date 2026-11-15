/**
 * TASK-009 integration tier (live, opt-in): the async-write lane measured
 * against REAL dependencies on the machinae-game testbed vault. Nothing
 * here is faked:
 *
 * - `/home/derek/src/machinae-game` is registered as the one SHARED vault
 *   (a repo that exists only to test DSH processes); bench notes land under
 *   `<vault>/dsh-bench/` so they never shadow the game's own files, and
 *   every title carries a run stamp so reruns cannot collide.
 * - transformers.js loads `Xenova/multilingual-e5-small` from the warm
 *   cache at `$HOME/.dsh/obsidian-mem-db/models` (never the tmp home, or
 *   every run would re-download the model); milvus-lite is spawned for
 *   real via MilvusLauncher (uvx, warm cache) into a tmp dbPath; the real
 *   git runner adopts the testbed's existing repo and the per-write
 *   `obsidian-mem: memory_write` commits land in its history (accepted
 *   for this testbed; the first wave may also sweep the pre-existing WIP,
 *   which the beforeAll logs verbatim before anything is provisioned).
 * - The writes ride the real `memory_write` executor
 *   (`executeWrite` from packages/tools/lib/write.js), so the full guard
 *   ladder runs exactly as the tool's 10 000 ms budget sees it.
 *
 * Proof shape (Questionnaire answer 4): the COLD case measures the first
 * `applyWrite` of a fresh service and asserts it lands under
 * WRITE_TIMEOUT_MS while the Milvus/indexer stack still boots behind it
 * (the TASK-003 split); the WARM batch waits for `status().state ===
 * 'ready'`, then ten consecutive awaited writes each measure under the
 * same budget; the SETTLE pass waits (shared generous budget) until each
 * note's rare PROBE word answers through `service.search`. The budget is
 * minutes-wide because the vault op lane can hold the testbed's background
 * full scan (~130 markdown files, 128 under node_modules) ahead of the
 * bench files' index follow-ups; the measured run queued the ten
 * follow-ups first and settled in 0.1 s. The settle pass also asserts the
 * git history holds one `memory_write` subject per warm write for THIS
 * run's stamp.
 *
 * The settle probes ride rare words (the live-pipeline `petrichor`
 * pattern): a long alphanumeric nonce fails to surface even when indexed,
 * because the dense route enforces the 0.78 radius floor and the BM25
 * route gates on wake-keyword intersection the token may miss. The nonce
 * stays in title/body/filename purely for rerun uniqueness, and the
 * commit assertion matches this run's stamp so older bench runs cannot
 * inflate the count.
 *
 * WRITE_PACE_MS separates the warm writes on the wall clock so each
 * write's git commit wave lands alone: `commitAll` is `git add -A` over
 * the whole tree, so a note that arrives while the previous commit runs
 * gets swept into that commit and its own commit answers null on the then
 * clean tree. The per-write latency is measured before the pause, so the
 * latency proof is untouched by the pacing.
 *
 * Collection gating lives in vitest.config.ts: `*.live.test.ts` files are
 * only collected with RUN_LIVE=1, so `pnpm test` stays green offline. The
 * describeLive mirror below is the guard for direct `vitest run <this
 * file>` invocations. Teardown stops the service and deletes
 * `<vault>/dsh-bench/`; the testbed's git history keeps the bench commits.
 * @module dsh-plugin-obsidian-mem/service/tests/integration/async-write-bench
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir as osHomedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { DEFAULT_MODEL_ID, VECTOR_DIM_DEFAULT, modelCacheDir } from '../../../core/lib/index.js'
import { WRITE_TIMEOUT_MS, executeWrite } from '../../../tools/lib/write.js'
import type { WriteValue } from '../../../tools/lib/write.js'
import { createEmbedder } from '../../src/embedder.ts'
import { MilvusLauncher } from '../../src/milvus/launcher.ts'
import { ObsidianMemService } from '../../src/service.ts'
import type { MilvusLauncherLike } from '../../src/service.ts'

const describeLive = process.env.RUN_LIVE === '1' ? describe : describe.skip

const execFileAsync = promisify(execFile)

/** The testbed vault (PLAN-async-writes Verification guidelines). */
const TESTBED_VAULT = '/home/derek/src/machinae-game'
/** Bench notes live here so they never shadow the game's own files. */
const BENCH_DIR = join(TESTBED_VAULT, 'dsh-bench')

/** The tool-tier budget every measured write must beat (10 000 ms). */
const WRITE_BUDGET_MS = WRITE_TIMEOUT_MS
const WARM_WRITE_COUNT = 10
/** Rare settle probes: wake-keyword-safe single words (live-pipeline style). */
const COLD_PROBE = 'vorblin'
const WARM_PROBES = ['zompf', 'quexly', 'brintle', 'flamp', 'snibble', 'worvig', 'troken', 'miffle', 'grunsel', 'paxwick'] as const

/** One run stamp: every title, filename, and nonce is rerun-collision-safe. */
const RUN_STAMP = new Date().toISOString().replace(/[-:.]/g, '')
/** The git subjects of THIS run: the stamp is inside every bench slug. */
const COMMIT_SUBJECT_RE = new RegExp(`^obsidian-mem: memory_write [^ ]*membench${RUN_STAMP.toLowerCase()}`)
/** The stack boot (uvx milvus-lite spawn) gets this before the warm batch. */
const READY_WAIT_MS = 300_000
/** The whole settle pass: the full scan embeds ~130 markdown files first. */
const SETTLE_BUDGET_MS = 900_000
/** Wall-clock separation so each write's git commit wave lands alone. */
const WRITE_PACE_MS = 1_000
/** Commit-history wait cap once every note is already searchable. */
const COMMIT_WAIT_MS = 120_000

// One warm-cached embedder backs the service (G13 discipline copied from
// live-pipeline.live.test.ts): the cache is deliberately the real warm one.
const benchEmbedder = createEmbedder({
  modelId: DEFAULT_MODEL_ID,
  vectorDim: VECTOR_DIM_DEFAULT,
  cacheDir: modelCacheDir(osHomedir()),
})

/** Fake ctx: the Service base plus the seam's own consumption surface. */
function fakeCtx() {
  const ctx = {
    reflect: { provide: () => () => undefined },
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    effect: (execute: () => () => unknown) => {
      const dispose = execute()
      return () => {
        dispose()
      }
    },
    get: () => undefined,
  }
  return ctx as unknown as Context
}

function childAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Bench tool args: one probe-carrying note under the dsh-bench dir. */
function benchArgs(nonce: string, probe: string): Record<string, unknown> {
  return {
    // A non-existent FILE path inside the dir: the tool slugs the title
    // into the path's dirname and applyWrite mkdirps that dir, so the
    // first write creates dsh-bench/ itself. Since TASK-009b the
    // dir-as-target spelling (BENCH_DIR, with or without a trailing
    // separator) names this same directory; the bench keeps the shape it
    // actually measured.
    path: join(BENCH_DIR, 'bench-note.md'),
    index_title: `Async-write bench ${probe}: ${nonce}`,
    index_description: `Throwaway TASK-009 bench artifact tagged ${nonce}; delete-safe.`,
    type: 'reference',
    contents: [
      `# Async-write bench note ${probe}`,
      '',
      `Bench artifact carrying the settle probe word ${probe} (${nonce}).`,
      '',
      'Why: the TASK-009 live bench measures real memory_write latencies',
      'against a shared vault while indexing and git settle behind.',
      'How to apply: nothing; this note is a test artifact, delete it.',
      '',
    ].join('\n'),
  }
}

/** RequireWritten fails the test with the refusal value on any non-write. */
function requireWritten(value: WriteValue, label: string): { path: string, created: boolean } {
  if (value.kind !== 'written') {
    throw new Error(`${label}: memory_write refused: ${JSON.stringify(value)}`)
  }
  // The TASK-005 contract rides the live stack too: a confirmed write
  // reports its follow-ups as queued, never as done.
  expect(value.write_through).toBe('queued')
  return { path: value.path, created: value.created }
}

describeLive('live async-write bench: memory_write budgets on the machinae-game testbed (RUN_LIVE=1)', () => {
  // One service for the whole file (the cold case must be its FIRST
  // write), so test 1 owns provisioning and tests 2-3 ride the result.
  let homeDir = ''
  let dbDir = ''
  let service: ObsidianMemService | null = null
  let launcherRef: MilvusLauncher | null = null

  let coldMs = 0
  const warmMs: number[] = []
  const warmNotes: Array<{ nonce: string, probe: string, path: string }> = []
  let settleMs = 0
  let commitSubjects: string[] = []

  beforeAll(async () => {
    // The testbed exists and is a git repo, or the bench is pointless.
    expect(existsSync(join(TESTBED_VAULT, '.git')), `${TESTBED_VAULT} must be a git repo`).toBe(true)

    homeDir = mkdtempSync(join(tmpdir(), 'mem-bench-home-'))
    dbDir = mkdtempSync(join(tmpdir(), 'mem-bench-db-'))

    // Honest record BEFORE anything is provisioned: the testbed's WIP that
    // the first whole-tree commit wave will sweep into history.
    const { stdout: porcelain } = await execFileAsync('git', ['-C', TESTBED_VAULT, 'status', '--porcelain'])
    console.log(`[bench] testbed git status --porcelain before provisioning:\n${porcelain.trim() === '' ? '(clean)' : porcelain.trimEnd()}`)

    service = new ObsidianMemService(
      fakeCtx(),
      {
        // The configured SHARED testbed vault: no default vault is ever
        // provisioned, and the scratch home keeps dbPath/state out of
        // the developer's live ~/.dsh.
        vaults: [{ path: TESTBED_VAULT, mode: 'shared' }],
        milvus: { dbPath: dbDir },
      },
      {
        homedir: () => homeDir,
        embedder: benchEmbedder,
        // The uv cache is already warm (G13); skip the detached uvx warm.
        prewarm: () => undefined,
        launcherFactory: (options): MilvusLauncherLike => {
          const launcher = new MilvusLauncher(options)
          launcherRef = launcher
          return launcher
        },
      },
    )
  }, 60_000)

  afterAll(async () => {
    if (service !== null) {
      await service.stop().catch(() => undefined)
    }
    const pid = launcherRef?.ownedChild?.pid
    if (pid !== undefined && childAlive(pid)) {
      process.kill(pid, 'SIGKILL')
    }
    // Plain fs removal; the watcher purge rides away with the stopped
    // indexer, and the testbed's history keeps the bench commits.
    rmSync(BENCH_DIR, { recursive: true, force: true })
    for (const dir of [homeDir, dbDir]) {
      rmSync(dir, { recursive: true, force: true })
    }
    console.log(
      `[bench] RESULT cold ${coldMs.toFixed(0)} ms | warm ${warmMs.map((ms) => ms.toFixed(0)).join(', ')} ms`
      + ` | settle ${(settleMs / 1000).toFixed(1)} s | ${commitSubjects.length} memory_write commits`,
    )
  })

  it('cold first write: the first applyWrite of a fresh service lands under the tool budget while the stack still boots', async () => {
    const nonce = `membench${RUN_STAMP}cold`
    const started = performance.now()
    // No ensureMemoryAccess anywhere near this call: executeWrite's own
    // ensureWriteAccess gates on the fast core pass only, and the real
    // uvx launcher.start() is still in flight when this resolves.
    const value = await executeWrite(service!, benchArgs(nonce, COLD_PROBE))
    coldMs = performance.now() - started
    const { path, created } = requireWritten(value, 'cold write')

    console.log(
      `[bench] cold first write: ${coldMs.toFixed(0)} ms (status state at return:`
      + ` "${service!.status().state}", launcher resolved: ${service!.status().milvus.address !== null}) -> ${path}`,
    )
    expect(created, 'the fresh note reports created; applyWrite mkdirped dsh-bench/').toBe(true)
    expect(path.startsWith(`${BENCH_DIR}/`), 'cold write target').toBe(true)
    expect(coldMs).toBeLessThan(WRITE_BUDGET_MS)
  }, READY_WAIT_MS)

  it('warm batch: ten consecutive memory_write calls each return under the tool budget', async () => {
    await vi.waitFor(
      () => expect(service!.status().state).toBe('ready'),
      { timeout: READY_WAIT_MS, interval: 2_000 },
    )
    console.log(`[bench] stack ready after ${service!.status().milvus.version ?? '?'}; starting the ten timed writes`)

    for (let write = 1; write <= WARM_WRITE_COUNT; write += 1) {
      const nonce = `membench${RUN_STAMP}w${write}`
      const probe = WARM_PROBES[write - 1] as string
      const started = performance.now()
      const value = await executeWrite(service!, benchArgs(nonce, probe))
      const ms = performance.now() - started
      const { path } = requireWritten(value, `warm write ${write}`)
      warmMs.push(ms)
      warmNotes.push({ nonce, probe, path })
      console.log(`[bench] warm write ${write}: ${ms.toFixed(1)} ms -> ${path}`)
      // Asserted per call, inside the loop: a re-awaited follow-up would
      // pile up and trip here, exactly like the TASK-008 unit proof.
      expect(ms).toBeLessThan(WRITE_BUDGET_MS)
      expect(path.startsWith(`${BENCH_DIR}/`), `warm write ${write} target`).toBe(true)
      if (write < WARM_WRITE_COUNT) {
        await sleep(WRITE_PACE_MS)
      }
    }
  }, READY_WAIT_MS + 120_000)

  it('settle: every bench probe word reaches search and the git history holds one memory_write commit per warm write', async () => {
    expect(warmNotes).toHaveLength(WARM_WRITE_COUNT)

    // Shared deadline: the vault op lane can hold the testbed's full scan
    // (the ~130 node_modules markdown files) ahead of the bench notes'
    // index follow-ups, so this window is minutes wide even though the
    // measured green run queued the follow-ups first and settled in 0.1 s.
    // Date.now() throughout: mixing it with performance.now()'s process
    // origin would drive the remaining-budget arithmetic negative.
    const settleStarted = performance.now()
    const deadline = Date.now() + SETTLE_BUDGET_MS
    let lastProgressLogAt = Date.now()
    for (const note of warmNotes) {
      const remaining = deadline - Date.now()
      expect(remaining, `settle budget exhausted before ${note.probe} was searchable`).toBeGreaterThan(0)
      await vi.waitFor(
        async () => {
          // Progress trace every minute into the long full-scan window,
          // so a future miss names the indexer position it stalled at.
          if (Date.now() - lastProgressLogAt >= 60_000) {
            lastProgressLogAt = Date.now()
            const progress = service!.status().indexer
            console.log(
              `[bench] settle waiting for ${note.probe} at +${((Date.now() - (deadline - SETTLE_BUDGET_MS)) / 1000).toFixed(0)}s`
              + ` (indexer ${JSON.stringify(progress)})`,
            )
          }
          const hits = await service!.search({ query: note.probe, topK: 10 })
          expect(hits.some((hit) => hit.source_path === note.path)).toBe(true)
        },
        { timeout: remaining, interval: 5_000 },
      )
      const progress = service!.status().indexer
      console.log(
        `[bench] settle +${((performance.now() - settleStarted) / 1000).toFixed(1)}s ${note.probe} searchable`
        + ` (indexer indexed: ${progress?.indexed ?? '?'}, pending: ${progress?.pending ?? '?'})`,
      )
    }
    settleMs = performance.now() - settleStarted

    // The git lane settles independently of the index lane; by the last
    // searchable note its queue is normally done, so this stays a short
    // confirm window on the shared budget.
    const remaining = Math.min(deadline - Date.now(), COMMIT_WAIT_MS)
    expect(remaining, 'settle budget exhausted before the commit-history check').toBeGreaterThan(0)
    await vi.waitFor(
      async () => {
        const { stdout } = await execFileAsync('git', ['-C', TESTBED_VAULT, 'log', '--format=%s', '-n', '40'])
        commitSubjects = stdout.split('\n').filter((subject) => COMMIT_SUBJECT_RE.test(subject))
        expect(commitSubjects.length).toBeGreaterThanOrEqual(WARM_WRITE_COUNT)
      },
      { timeout: remaining, interval: 5_000 },
    )
    console.log(
      `[bench] settle took ${(settleMs / 1000).toFixed(1)} s; newest 40 commits hold`
      + ` ${commitSubjects.length} "${COMMIT_SUBJECT_RE.source}" subjects, e.g. ${commitSubjects[0] ?? '(none)'}`,
    )
  }, SETTLE_BUDGET_MS + 180_000)
})
