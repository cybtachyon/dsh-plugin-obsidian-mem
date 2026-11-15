# TASK-009 — Live-system batch bench against the machinae-game testbed

Goal proof on a real stack (real uvx milvus-lite child, real transformers.js
e5-small model, real git), per Questionnaire answer 4.

1. New live file `packages/service/tests/integration/async-write-bench.live
.test.ts` (RUN_LIVE tier, mirroring live-pipeline.live.test.ts's harness and
   describeLive gate):
   - vault root: `/home/derek/src/machinae-game` (testbed repo; it exists
     only to test DSH processes), registered as a SHARED vault via the card
     vaults file/`addVault` seam the harness already supports; notes live in
     a `<vault>/dsh-bench/` subdirectory so they never shadow the game's own
     files; unique timestamped titles make reruns collision-safe.
   - Warm the stack with one write, flush, and (with the TASK-003 split)
     wait for `status().state` to be `'ready'` so the timed batch runs
     warm; keep a separate cold-start case that measures ONLY the first
     `applyWrite` of a fresh service instance (its budget: the write must
     not await the index stack; assert it resolves under 10 s even while the
     launcher seam is still coming up — use the real launcher).
   - Timed batch: ten consecutive `memory_write` tool executions (drive the
     real tool `execute` from `packages/tools/lib` or the service
     `applyWrite` — prefer the tool execution so the full guard ladder runs);
     assert every single call resolves under 10_000 ms and record the
     per-call ms in the test log.
   - Settle: `await service.flushWriteFollowUps()` (or `vi.waitFor` polling
     the index state file), then assert each of the ten notes is searchable
     (distinct nonce token per note through `service.search`) and
     `service.vaultGit.logShared` contains ten
     `obsidian-mem: memory_write` commits (direct `git log` on the vault is
     also acceptable).
   - Teardown: remove the ten notes (plain fs) and drop the vault from the
     registry; leave the testbed's files otherwise untouched.
2. Run it once in this session: `RUN_LIVE=1 pnpm test` scoped to the file;
   paste measured per-call latencies into the task file's Results section.
   (Cold uvx cache may push total wall time into several minutes; that is
   the stack warm-up, not a write.)
3. Do not register the testbed vault in the developer's live `~/.dsh`
   registry; the bench uses its own scratch `home` seam for dbPath/state.

Definition of Done:

- The live file is collected only under RUN_LIVE=1 and green when run;
  default `pnpm test` unchanged.
- Results section records: ten per-call latencies (all < 10_000 ms), the
  cold first-write latency, settle time, and commit count.

## Results

Green run 2026-11-14 in-session:
`RUN_LIVE=1 pnpm exec vitest run packages/service/tests/integration/async-write-bench.live.test.ts`
— 3 tests passed, 13.8 s wall. `pnpm test` default tier: 1104 passed /
2 skipped, and `vitest list --filesOnly` shows zero async-write-bench
entries without RUN_LIVE (one with RUN_LIVE=1).

Pre-provisioning testbed `git status --porcelain`, logged verbatim by the
first (exploratory) run against the untouched tree: ` M src/ecs/components.ts`,
` M src/ecs/snapshot.ts`, ` M src/main.ts`,
`?? src/ecs/systems/beaconPulseSystem.ts`,
`?? test/beaconPulseSystem.test.ts`. The first commit wave swept that WIP
plus the plugin's own `.obsidian-mem/` sidecar into its commit, as the
parent pre-accepted. The green run's own pre-provision status additionally
showed the previous run's leftovers (` M .obsidian-mem/…state.json`,
11 ` D dsh-bench/…`), which its first wave committed onward.

Measured on the green run (all budgets 10 000 ms = `WRITE_TIMEOUT_MS`):

- Cold first write of a fresh service: **17 ms**, returning while
  `status().state` was `'provisioning'` and the real uvx launcher had not
  resolved.
- Ten warm writes (ms, in call order): **15.2, 17.7, 15.4, 22.7, 8.5,
  15.3, 18.7, 7.2, 18.2, 18.8**. Every call asserted under budget
  individually; max 22.7 ms.
- Settle (all ten per-note probe words answering `service.search`):
  **0.1 s**. The ten write follow-up `indexFile` jobs took the vault op
  lane ahead of the background full scan in this run (indexer reported
  `indexed: 11, pending: 10` at the first probe).
- Commits: **11** subjects matching
  `^obsidian-mem: memory_write <slug>…membench<run-stamp>` (cold + the
  ten warm, one per write; the ten warm satisfy the >= 10 pin).

Context from the exploratory run against a cold `.obsidian-mem` sidecar:
the testbed's full scan (~130 markdown files, 128 under node_modules) had
reached only 57 files / 497 chunks after 600 s, so a cold-state settle can
be minutes wide; the bench keeps the 900 s settle budget for that case.
The green run's sidecar was warm from that scan.

Honest deviations and their reasons (all commented in the test file):

- Warm writes are paced 1 s apart (latency measured before the pause).
  `commitAll` is a whole-tree `git add -A` and answers null on a clean
  tree, so back-to-back writes land while the previous commit runs and
  collapse into one wave; the pacing makes "one commit per write"
  observable in real history (unit-tier batchGitHarness fakes the
  tree-dirty condition this sidesteps).
- Notes pass a non-existent FILE path inside `dsh-bench/` (the write
  still creates the dir through applyWrite's mkdirp). Passing the
  missing DIRECTORY itself silently slugged every note into the vault
  root — pre-existing issue 1 below; the exploratory run's eleven
  root-level notes were removed from the work tree afterwards.
- Settle probes are rare coined words, not the nonce tokens: a long
  alphanumeric token never surfaced through `service.search` even for
  indexed notes (dense-route radius floor + BM25 wake-keyword gate),
  while the live-pipeline rare-word pattern surfaced instantly.
  Pre-existing issue 2 below.

Pre-existing issues discovered (found, not touched):

1. `tools/write.ts` new-note placement: a path naming a MISSING directory
   takes the `dirname()` branch and slugs the note into the directory's
   PARENT, contradicting the "the path you pass supplies the directory"
   contract. No unit test passes a missing-dir target. RESOLVED by
   TASK-009b: the target itself is the directory unless its basename ends
   in `.md`, and the bench's file-inside-dir comment no longer calls the
   dir-as-target shape a trap.
2. Hybrid search cannot surface rare machine-generated tokens (long
   alphanumerics): the dense route's 0.78 radius floor rejects them and
   the BM25 route's wake-keyword gate can skip the rows. Fine for prose
   memories; surprising for nonce-shaped titles.
3. The managed gitignore constant `.obsidian-mem/` lands only when the
   vault root has NO `.gitignore` (an existing file only ever receives
   the extras append), so on a user vault like the testbed the sidecar
   state file is committed and churns every later commit wave.
4. Testbed end state: bench-run commits sit in the repo history
   (intended); its work tree now shows ` M .obsidian-mem/…state.json` and
   11 ` D dsh-bench/…` entries (teardown's plain-fs removals, committed by
   whichever bench run follows). No user file was altered beyond the
   pre-accepted WIP sweep.
5. Default-tier count reads 1104 passed / 2 skipped; the 1103 carried in
   earlier TASK-007/008 prose was already stale before this task (this
   task adds no default-tier test).
