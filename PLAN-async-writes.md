# PLAN-async-writes

Objective: `memory_write` tool calls time out at the declared 10 000 ms
`timeoutMs` because `ObsidianMemService.applyWrite` awaits the write-through
index (ONNX embed + Milvus insert, serialized in the vault op lane so batched
writes pile up) and the per-write git commit inside the tool call. The fix:
`applyWrite` confirms the write immediately after the atomic file write plus
read-registry update, and indexing, git commits, and the cold-start index
stack settle on asynchronous lanes. A successful memory write must complete in
under 10 000 ms even on slower hard-drive systems, including a batch of 10
consecutive writes.

## Diagnosis (settled facts)

- `packages/tools/src/write.ts` registers `memory_write` with
  `WRITE_TIMEOUT_MS = 10_000`; the harness enforces it.
- `applyWrite` (`packages/service/src/service.ts` L825) awaits, inside the
  tool call:
  1. `ensureMemoryAccess()` — cold start spawns milvus-lite via uvx with a
     `DEFAULT_READINESS_TIMEOUT_MS = 600_000` budget (cold uvx measured up to
     400 s);
  2. `indexer.indexFile(...)` — parse → chunk → embed (e5-small int8 ONNX) →
     optional LLM refine → Milvus delete+insert, all serialized on the
     vault's single `enqueueOp` lane, so write N waits behind writes 1..N-1;
  3. `vaultGit.commitVault(...)` — `git add -A` + commit subprocess pair,
     serialized on the vault's git lane.
- The file write itself is a fast atomic write; every slow step is bookkeeping
  the agent does not need confirmed.

## Verification guidelines

Repo-wide gates (run from the repo root; details in AGENTS.md):

- `pnpm build` must exit 0 (tsc -b --force, client bundle, build-format,
  verify-emit) and leave the tree clean. `packages/*/lib` IS tracked: every
  src change ships its rebuilt lib carriers in the same commit.
- `pnpm test` fully green; `pnpm test:coverage` clears the vitest.config.ts
  floors (lines 85 / functions 85 / branches 78 / statements 85).
- `pnpm lint` green. `prek run --files <paths>` green before each commit.
- Import specifiers: `packages/*/src` ends `.js`; tests use `.ts`. The AGENTS
  verification grep must print nothing.
- Commit messages carry no `claude|anthropic` pattern (prek commit-msg hook).
- Concurrent sessions may share this checkout: stage ONLY the paths this
  plan owns (explicit `git add <paths>`, never `git add -A`/`commit -a`),
  and re-check `git status --porcelain` immediately before committing.
- The live tier (`*.live.test.ts`) only runs under `RUN_LIVE=1 pnpm test`.
- Testbed for real-system verification: `/home/derek/src/machinae-game`
  (a repo that exists only for testing DSH plugins and processes).

## Open questions (answered in the Questionnaire task)

1. `write_through` output field: keep the const `'attempted'` or rename the
   value to `'queued'` to honestly report the async follow-up?
2. Cold-start writes: may the write path return after a fast core
   provisioning pass (vault + registry + dirs + notice) with the Milvus/
   indexer stack starting in the background, so even the FIRST write in a
   process stays under the budget? Search/read keep awaiting full readiness.
3. Teardown: bounded flush of pending follow-ups before stopping the indexer
   and disposing Milvus (recommended, bounded), or fire-and-forget with
   next-start convergence via the state diff?
4. Should the live 10-write bench against the machinae-game testbed be
   executed in this session (spawns real milvus-lite + loads the real
   embedding model; minutes of runtime)?

## Task index

### Phase 1 — Async follow-up core (service)

 - [x] [TASK-001-followup-chains](docs/PLAN-async-writes-TASK-001-followup-chains.md)
 - [x] [TASK-002-teardown-flush](docs/PLAN-async-writes-TASK-002-teardown-flush.md)
 - [x] [TASK-003-cold-write-split](docs/PLAN-async-writes-TASK-003-cold-write-split.md)
 - [ ] [TASK-004-refactor-phase1](docs/PLAN-async-writes-TASK-004-refactor-phase1.md)

### Phase 2 — Model contract and docs

 - [ ] [TASK-005-contract-text](docs/PLAN-async-writes-TASK-005-contract-text.md)
 - [ ] [TASK-006-fix-affected-tests](docs/PLAN-async-writes-TASK-006-fix-affected-tests.md)
 - [ ] [TASK-007-refactor-phase2](docs/PLAN-async-writes-TASK-007-refactor-phase2.md)

### Phase 3 — Batch verification

 - [ ] [TASK-008-batch-unit-test](docs/PLAN-async-writes-TASK-008-batch-unit-test.md)
 - [ ] [TASK-009-live-bench](docs/PLAN-async-writes-TASK-009-live-bench.md)
 - [ ] [TASK-010-verify-suite](docs/PLAN-async-writes-TASK-010-verify-suite.md)

## Task dependencies

- TASK-001 → TASK-002, TASK-003 (both build on the follow-up lane).
- TASK-001..003 → TASK-004 (refactor pass over those three commits).
- TASK-004 → TASK-005 (contract wording settles after the core shape is final).
- TASK-005 → TASK-006 → TASK-007 (tests follow the contract; refactor pass).
- TASK-007 → TASK-008 → TASK-009 → TASK-010 (batch proof, then real-system
  bench, then the whole-repo verification gate).

## Questionnaire answers

2026-11-14, answered by Derek:

1. `write_through` value renamed to `'queued'` (field name kept); schema,
   render text, and test fixtures follow.
2. YES to the cold-start split: `ensureWriteAccess()` awaits only
   `provisionCore()`; the index stack boots in the background; search, read,
   audit, and the event flows keep awaiting full readiness.
3. Bounded teardown flush with a 60 s cap; on timeout, warn and continue
   (the state-file diff converges on next start).
4. YES, run the live bench in this session. Extra instruction carried:
   if a DSH restart is ever needed to observe changes in the running host,
   ask the user to restart, send a continue message, and end the turn.
   (Note: the live bench runs through the vitest harness against the repo's
   own src/lib, so it needs no host restart.)

## Results

(to be filled at TASK-010 with measured totals)
