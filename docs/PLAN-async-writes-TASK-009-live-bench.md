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
