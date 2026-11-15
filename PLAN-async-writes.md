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
 - [x] [TASK-004-refactor-phase1](docs/PLAN-async-writes-TASK-004-refactor-phase1.md)

### Phase 2 — Model contract and docs

 - [x] [TASK-005-contract-text](docs/PLAN-async-writes-TASK-005-contract-text.md)
 - [x] [TASK-006-fix-affected-tests](docs/PLAN-async-writes-TASK-006-fix-affected-tests.md)
 - [x] [TASK-007-refactor-phase2](docs/PLAN-async-writes-TASK-007-refactor-phase2.md)
 - [x] [TASK-007b-reserved-doc-wording](docs/PLAN-async-writes-TASK-007b-reserved-doc-wording.md)

### Phase 3 — Batch verification

 - [ ] [TASK-008-batch-unit-test](docs/PLAN-async-writes-TASK-008-batch-unit-test.md)
 - [ ] [TASK-009-live-bench](docs/PLAN-async-writes-TASK-009-live-bench.md)
 - [ ] [TASK-010-verify-suite](docs/PLAN-async-writes-TASK-010-verify-suite.md)

## Task dependencies

- TASK-001 → TASK-002, TASK-003 (both build on the follow-up lane).
- TASK-001..003 → TASK-004 (refactor pass over those three commits).
- TASK-004 → TASK-005 (contract wording settles after the core shape is final).
- TASK-005 → TASK-006 → TASK-007 (tests follow the contract; refactor pass).
- TASK-007 → TASK-007b (inserted from TASK-007 finding A: core doc wording
  for the any-depth reserved-file rule).
- TASK-007b → TASK-008 → TASK-009 → TASK-010 (batch proof, then real-system
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

### TASK-004 refactor pass (Phase 1 smell adjudication, 2026-11-14)

Reviewed the three commits' stat and diffs, then the full files they touch:
`packages/service/src/service.ts`, `packages/service/tests/service.spec.ts`,
`packages/tools/src/host.ts`, `packages/tools/src/write.ts`,
`packages/tools/tests/testkit.ts`. Every risk class gets one line below.

- **Multiple Sources of Truth**: RESOLVED. The settled-flight short-circuit,
  the start-once call, and the "the notice belongs to the triggering caller"
  rule lived once per provisioning entry; both entries now ride one
  `settlePass(half)` gate where `half` is the only difference. The tests'
  comment that restated the cap as "60 s" now names
  `TEARDOWN_FLUSH_TIMEOUT_MS`, which stays imported and never redefined.
- **Duplicate Code**: RESOLVED. `service.spec.ts`: the flagged
  `writeHarness` wrapper is gone (one `gitWriteHarness` that owns its temp
  vault and returns the path), the duplicated temp-dir-plus-afterEach pair is
  one module-scope `gitTempDir` and one `afterEach`, the six inline
  git-enabled harness option blocks are `gitVaultHarness`/`gitWriteHarness`,
  the five-copy adopt-then-clear-then-markDirty ritual is
  `writeReadyGitHarness`, and the thrice-written never-settling promise is
  `neverSettling<T>()`. `tools/tests/testkit.ts`: `ensureWriteAccess`
  repeated `ensureMemoryAccess` line for line; both entries bind one
  `ensureAccess` closure. WAIVED: the two `startIndexStack` degrade catch
  blocks share two field assignments inside one method and differ in the
  operator-facing warn text; a helper would only rename the assignments.
- **Bloaters**: WAIVED. The phase already split the bloated method
  (`provision` into `provisionCore` plus `startIndexStack`) and gave teardown
  its `boundedFollowUpFlush`; `applyWrite`'s remaining length is the
  pre-existing path-classification guards (blame b86396f) plus the
  confirm-then-fire sequence, and moving the guards out relocates code without
  dropping a concept.
- **Data Clumps**: RESOLVED in the tests (the `(git, vault)` pair every git
  case threaded is now produced and returned by `gitWriteHarness`). WAIVED in
  src: `(vaultPath, relPath)` reaches both follow-ups and the result from one
  method's own locals; a record with a single producer and reader would be new
  ceremony.
- **Shotgun Edits**: WAIVED. No commit changed one concept across unrelated
  files; TASK-003's four files are the `MemoryService` seam, its caller, and
  its fake moving together, which is typed coupling. The related latent edit
  pair (the write path gates in `write.ts` for the notice and again in
  `applyWrite` for non-tool callers) is documented on both sides and left
  alone.
- **Feature Envy**: WAIVED. No Phase 1 method spends most of its body on
  another class: the follow-up trio and `boundedFollowUpFlush` touch only
  `pendingFollowUps`, and the index and git hand-offs are one line each into
  collaborators that own their lanes.
- **Magic Numbers**: RESOLVED in the tests: the `250` that was both the slow
  chain's latency and the ceiling its write had to beat is one
  `SLOW_CHAIN_MS`, and the twice-written `5_000` teardown ceiling is
  `TEARDOWN_MARGIN_MS`. In src the only new literal is the already-named
  exported `TEARDOWN_FLUSH_TIMEOUT_MS`.
- **Overengineering**: WAIVED. `ProvisioningPass` carries the two promises
  three call sites consume (both entries plus the card-settings wait on
  `access.stack`), and `boundedFollowUpFlush` has one caller but is the
  doc-anchored owner of the cap discipline. Every helper this pass added has
  at least two call sites.

Behavior stayed neutral: no assertion changed, no test was added or removed
(1103 passed, 2 skipped before and after), and the scope-note invariants hold
(one follow-up-tracking home, one `TEARDOWN_FLUSH_TIMEOUT_MS`, one single-flight
mechanism with two pass halves). `tools/src/write.ts` contract text is
untouched for TASK-005.

Carried to TASK-007 (found, not touched): `auditGitRunner`
(`service.spec.ts` L2144) is `recordingGit` plus a `log` answer;
`dreamGitHarness` takes a `gitEnabled` boolean flag; the 1..6 provisioning step
comments now straddle `provisionCore` and `startIndexStack`; `service.ts`
spells the reserved-file basename with `lastIndexOf` while `tools/write.ts`
uses `node:path` `basename` for the same rule.

### TASK-007 refactor pass (Phase 2 smell adjudication, 2026-11-14)

Reviewed the two commits' diffs (`e6e937e`, `66363dd`) and the full files they
touch: `packages/tools/src/write.ts`, `README.md`, `AGENTS.md`,
`packages/tools/tests/write.spec.ts`,
`packages/events/tests/writeLedger.spec.ts`,
`packages/events/tests/thinkIntercept.spec.ts`, and
`packages/service/tests/integration/live-pipeline.live.test.ts`. TASK-004's
four carry-overs and the TASK-006 terminology flag are adjudicated at the
end. Every risk class gets one line below.

- **Multiple Sources of Truth**: RESOLVED. The reserved-file rule lived twice:
  `applyWrite` hand-rolled the basename with `lastIndexOf` plus depth
  arithmetic while the tool's Guard 2 spelled it `basename` +
  `isReservedNonIndexed`. Core's `vaults.ts` now exports one
  `isReservedVaultFile(vaultPath, target)` and three sites call it: core's own
  `isNotesPath`, the service throw, and the tool's `reserved_file` refusal.
  The card-settings comments no longer reference a fragile "step 5"; they
  name the collection-rebuild pair.
- **Duplicate Code**: RESOLVED. `service.spec.ts`'s `auditGitRunner` was a
  near-copy of `recordingGit` (same call ledger, same status and probe
  answers); it now wraps `recordingGit` and scripts only the two-commit `log`
  answer. WAIVED: the two fake `WriteValue` fixtures (`writeLedger.spec.ts`
  `writtenValue`, `thinkIntercept.spec.ts`'s inline value) mimic the tool's
  wire shape in another package that never reads the field; a cross-package
  fixture module would couple suites for zero behavior.
- **Bloaters**: WAIVED. Neither commit grew a method; `executeWrite`'s length
  is the documented guard ladder (Guards 1-5) and `renderWrite` is a per-kind
  render branch.
- **Data Clumps**: WAIVED. No new parameter groups in scope; the
  `dreamGitHarness` option record added here carries one field.
- **Shotgun Edits**: WAIVED. `e6e937e` moved contract text through write.ts,
  README, and AGENTS together: the tool contract and its docs moving in
  lockstep is the intended coupling, and each surface was reworded, not
  copy-pasted.
- **Feature Envy**: WAIVED. The only place a write tier reached into core's
  rule internals was the reserved-file guard; after this pass it calls core's
  helper instead of re-spelling the rule.
- **Magic Numbers**: WAIVED. The only literals in scope are the already-named
  exported `WRITE_TIMEOUT_MS` and the `'queued'` contract value (scope note
  below); the audit fixture's `'e'.repeat(40)` hashes are log-record content,
  not thresholds.
- **Overengineering**: WAIVED. `isReservedVaultFile` has three call sites and
  replaces two hand-rolled spellings; the `auditGitRunner` wrapper has one
  call site but retires a 20-line near-copy; no new class or one-line method
  was added.

Scope-note adjudications:

- The `renderWrite` success line vs `WRITE_DESCRIPTION` vs README/AGENTS:
  WAIVED. Three different jobs (model contract, per-call receipt, human doc)
  carry three different phrasings; no sentence repeats verbatim across
  surfaces.
- The `'queued'` literal: WAIVED. Its home is the `WriteValue` type plus the
  `WRITE_OUTPUT` schema const pair; the executor value is type-checked
  against the union and schema-checked by the tests' `matchesOutput`, and
  `write.spec.ts` pins the raw wire value deliberately so a contract rename
  breaks the external pin instead of riding an imported const.

Carry-overs from TASK-004, all adjudicated:

- `auditGitRunner`: RESOLVED (wraps `recordingGit`; only the scripted `log`
  answer stays local).
- `dreamGitHarness` boolean flag: RESOLVED. Both call sites pass the named
  `{ gitEnabled }` option, so the git mode reads explicitly at the call.
- Provisioning step-comment straddle: RESOLVED. `provisionCore` numbers its
  steps 1-4 and `startIndexStack` numbers its own 1-3 under a header note;
  the "step-5" cross-references became "collection-rebuild pair" wording in
  three src comments and one test comment plus one test title (prose only).
- Reserved-file rule spelled two ways: RESOLVED as described under Multiple
  Sources of Truth. Honest behavior note: a reserved protocol name deeper
  than the vault root (say `sub/DREAMS.md`) now takes the service tier's
  reserved-specific refusal instead of the generic outside-note-tree one.
  That is the rule core's `isNotesPath` already applies at any depth, and
  the tool tier already answered `reserved_file` there, so both tiers now
  match core; no test pinned the old generic wording for those paths and the
  root-level pins are untouched.

TASK-006's terminology flag: RESOLVED as the rename. The src prose now calls
`indexer.indexFile` the write follow-up hook: three `service.ts` comments,
five `indexer.ts` doc lines (module header, both class docs, both `IndexFile`
docs), and `indexer.spec.ts`'s describe title plus one `it` title. The output
field name `write_through` stays: Questionnaire answer 1 renamed the value and
kept the field, so the wire key is contract, not stale prose.

Behavior stayed neutral: no assertion changed, the suite holds at 1103 passed
/ 2 skipped, and the only test edits are title/prose renames plus the two
fixture refactors. `pnpm build` exits 0 with the tree clean and the core,
service, and tools lib carriers riding the src changes; `pnpm test`,
`pnpm lint`, and `prek` are green.
