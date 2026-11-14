# PLAN-wake-gate: sparse-leg wake gate implementation and A/B

Objective: execute
[docs/research/sparse-wake-gate-spec.md](docs/research/sparse-wake-gate-spec.md)
end to end: Step 1 pre-flight measurements against the live collection,
Step 2 TDD implementation of the wake gate plus the `--wake-gate` harness
flag in one commit, Step 3 same-session A/B with committed artifacts and a
recorded PASS / PARTIAL / FAIL decision, Step 4 live confirmation per the
Q1 answer. Spec Decision rules and Option 4 stay authoritative in the spec
doc; they are not restated here. Definition of done (spec): Steps 1-4
recorded with artifacts committed, one decision executed, tree clean,
gates green.

Live server: `/home/derek/.dsh/obsidian-mem-db/.memlite.json` (port 45429,
pid 1091813 verified alive 2026-11-13).

## Verification guidelines

- Pre-flight probes and probes extended by this plan stay HARD READ-ONLY:
  RPC allow-list connectPromise, getVersion, count, query, search. Never
  a write, delete, drop, createIndex, load, release, DDL, spawn, or kill;
  attach to the running server only.
- Harness and probe scripts import production pieces (constants, strip,
  helpers) from `packages/*/lib`; never restate values in `scripts/eval`.
- A/B validity: baseline (no-flag) and gated runs execute back to back in
  the SAME session on the SAME corpus (equal `server.rowCount` in both
  artifacts); the committed prior artifact is never the control. Artifacts
  carry no timestamps.
- The dense route never carries the gate clause. Gate element-length
  legality imports `MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.wakeKeywords` from
  core, mirroring `isUsableKeyword` in `packages/core/src/triggers.ts`
  without restating numbers.
- Fail-open: empty filter tokens emit no gate clause;
  `SPARSE_WAKE_GATE_ENABLED = false` emits no gate clause anywhere.
- Per-task commits run `prek run --files <paths>` first; the
  implementation commit carries src AND `packages/*/lib` (lib IS
  tracked); commit messages carry no external assistant attribution.

## Open questions (asked 2026-11-13; answers persisted below)

- Q1: Step 4 restarts DSH, which host-runs this session. Hand off a
  restart + live-probe recipe after Steps 1-3 commit, or drive the
  reinstall/restart inline?
- Q2: Baseline artifact filename for the same-session no-flag run (the
  gated run name is fixed by the spec Step 3 command).
- Q3: On FAIL, Option 4 mutates the production dbDir (new collection +
  full reindex). Stop and report for explicit go-ahead, or proceed
  automatically under this plan's authority?

## Answer log

- Q1 (2026-11-13 user answer): at Step 4, drive the work inline up to the
  restart boundary, then request the user restart the host and send
  "continue", and end the turn. On continuation (goal carries over the
  restart), do the profile-bundle grep check and the ONE live-probe
  iteration.
- Q2: baseline artifact =
  `docs/research/eval-split-strip-on-d078-s50-k60-m016129-wakegate-baseline.json`.
- Q3: on a FAIL decision, Option 4 proceeds automatically under this
  plan's authority (snapshot `~/.dsh/obsidian-mem-db` first; old
  collection stays alive until the Option-4 A/B completes).
- Q4 (2026-11-13 user answer, after TASK-003 found the Han wake-key
  gap): fix wake extraction to emit Han wake keys FIRST (TASK-017),
  then wire the gate per the spec unchanged. Option 4 stays the FAIL-
  only opener; the zh-carry-out alternative was rejected.
- Q5 (2026-11-13 user answer, after the Step 3 FAIL): route the FAIL
  through a gate-parity SPARSE_SEARCH_RADIUS re-sweep FIRST (TASK-006
  precedent). If it recovers relevant-of-labeled to >= baseline with
  forbidden and zh held, ship gate + retuned floor (TASK-019) and
  resume Phase D; Option 4 stays open, unspent, if the sweep fails.

## Tasks

### Phase A: pre-flight measurements (spec Step 1, read-only, blocking)

 - [x] [TASK-001-empty-wake-audit](docs/PLAN-wake-gate-TASK-001-empty-wake-audit.md)
 - [x] [TASK-002-expected-kill-check](docs/PLAN-wake-gate-TASK-002-expected-kill-check.md)
 - [x] [TASK-003-zh-baseline-pin](docs/PLAN-wake-gate-TASK-003-zh-baseline-pin.md)

 TASK-001 result (2026-11-13, spec "Pre-flight measurements", commit
 0285a65): 39/210 rows (18.571%) carry empty wake arrays, above the 5%
 ceiling, so the >5% STOP fired: Phase B stays blocked until the
 wake-keyword extraction fix lands in core and the probe re-runs to
 ≤5%. TASK-002/003 are deferred: their inputs are the wake arrays the
 fix rewrites.

 TASK-002 result (2026-11-13, spec "Pre-flight measurements" §Step
 1.2): new read-only companion probe
 `docs/research/probes/wake-kill-check-probe.mjs` (its INVARIANT line
 first re-confirmed the post-TASK-015 truth: 213 rows, 0 empty-wake,
 intent markers 0 corpus-wide). Expected-kill check over the 6 §Problem
 collision rows: 5 die, 1 survives; the survivor
 (guestwise/drupal-installs-uid-1…) keeps its sparse leg through slug
 word `global`, not its named collision words. Wake-list pollution
 (§Problem word present in the stored wake array) flagged on rows 1–4;
 only row 2's is gate-relevant. Relevant-row safety: 14 of 15 relevant
 sparse-visible rows survive; the lone loser rode `routes: both` so its
 dense leg still carries it. Predicted A/B shape for TASK-011:
 sparse-only forbidden 6 → 1, relevant-of-labeled intact. Full table +
 stored wake arrays in the spec doc.

 TASK-003 result (2026-11-13, spec "Pre-flight measurements" §Step
 1.3): zh baseline SUMMARY pinned verbatim (probe
 `docs/research/probes/zh-analyzer-probe.mjs` run UNCHANGED; HARD
 READ-ONLY; BOOT/SUMMARY rowCount 213; wake-audit invariants
 re-verified in-session first: 213 rows, scanComplete 213/213, empty
 wake 0, marker rows 0). This is the TASK-010/011 zh comparison
 control. Key observation: the three Han-hitting chunks
 (`2725569707718867`, `5384054551459882`, `266388258919095`) carry NO
 Han in their stored `wake_keywords` (Latin slug words only), so the
 gate predicts exactly three probes lose hits (`run-记忆`,
 `run-智能体`, `run-的共享记忆`: 2 hits → 0 each); every
 single-codepoint shape gates to an empty token list and fails open
 unchanged. Full prediction in spec §Step 1.3.

### Phase A2: wake-extraction fix (spec Step 1.1 STOP consequence)

 - [x] [TASK-014-wake-extraction-fix](docs/PLAN-wake-gate-TASK-014-wake-extraction-fix.md)
 - [x] [TASK-016-thinkintercept-spec-repair](docs/PLAN-wake-gate-TASK-016-thinkintercept-spec-repair.md)
 - [x] [TASK-015-reindex-refresh](docs/PLAN-wake-gate-TASK-015-reindex-refresh.md)

 TASK-014 result (2026-11-13, spec "Pre-flight measurements", commit
 376108d): wake legality (one home, `isUsableKeyword`) drops the generic
 intent labels and fragment shapes, and file-name slug words stand as
 content wake keywords. Vault replay (143 files, 211 chunks): empty-wake
 chunks 39 -> 0 (18.6% -> 0%), generic-label entries 347 -> 0,
 fragment-shape terms 27 -> 0. TASK-015 (live reindex + wake-audit
 re-run, <=5% gate) is next and unblocks Phase B.

 TASK-016 result (2026-11-13): the 3 red tests were pure header
 rewording; `4bf4f8f` behavior is intended and shipped lib in
 lockstep. Synced `packages/events/tests/thinkIntercept.spec.ts`
 assertions to the `Memory related to: <queryString>.` shape, no
 src or behavior change. Full suite green again (833 passed, 2
 skipped); lint green. TASK-015 inherits a green baseline.

 TASK-015 result (2026-11-13, spec "Pre-flight measurements"): live
 collection reindexed through the indexer's own code path from a new
 durable driver `scripts/live-reindex.mjs` (forced re-diff via the
 `IndexerFs` state-read shadow; no state-file deletion, no raw
 mutation; LLM refiner left on the codebase's disabled default).
 Wake-audit re-run: 213 rows, 0 empty-wake (0.000% ≤ 5%), intent
 markers 0 occurrences corpus-wide, TERMS top-20 content vocabulary.
 Reconciled truth: 213 live rows == 213 state chunk ids (144 files;
 the live side grew from the 210/211 audit/repair-time numbers via
 post-audit vault notes indexed by the host's watchers). GATE PASS:
 Phase B unblocked; TASK-002/003 inputs are now the post-reindex
 wake arrays.

### Phase A3: Han wake-key harvest (Q4 answer; last blocker)

 - [x] [TASK-017-han-wake-keys](docs/PLAN-wake-gate-TASK-017-han-wake-keys.md)

 TASK-017 result (2026-11-13, spec §"Han wake keys (TASK-017)", commit
 68e4a02): core wake extraction harvests the chunk text's maximal Han
 runs after the existing entries through the one legality gate
 (isUsableKeyword gains the whole-run function-word noise rule, small
 core-local char list). Live refresh via scripts/live-reindex.mjs:
 125 files indexed, 19 archived purged, 213 → 213 rows. Wake-audit
 re-run: 0 empty (0.000%, no-STOP), markers 0, 17 distinct Han wake
 terms on the two Han-content chunks (记忆/智能体/的共享记忆 each on
 2 rows). zh gate PREVIEW: all three run-* probes keep BOTH pinned
 hits gated (lost none); shipped-strip-out stays empty as pinned; the
 substring-vs-maximal-run STOP did NOT fire. Verdict: Han wake keys
 live, gate safe for zh; Phase B unblocked.

### Phase B: implementation (spec Step 2, TDD, single commit with lib)

 - [x] [TASK-004-unit-tests-red](docs/PLAN-wake-gate-TASK-004-unit-tests-red.md)
 - [x] [TASK-005-implement-search-ts](docs/PLAN-wake-gate-TASK-005-implement-search-ts.md)
 - [x] [TASK-006-fakes-green](docs/PLAN-wake-gate-TASK-006-fakes-green.md)
 - [x] [TASK-007-harness-flag](docs/PLAN-wake-gate-TASK-007-harness-flag.md)
 - [x] [TASK-008-commit-green](docs/PLAN-wake-gate-TASK-008-commit-green.md)
 - [x] [TASK-009-refactor-review](docs/PLAN-wake-gate-TASK-009-refactor-review.md)

 TASK-004..008 result (2026-11-13, spec Step 2, commit 9c2ae27): the
 wake gate shipped. `dispatchRoutes` merges
 `ARRAY_CONTAINS_ANY(wake_keywords, [<stripped query tokens>])` into the
 SPARSE route's expr (every caller: hybridSearch, exact-file, fallback);
 the dense route never carries it. New exports: `sparseQueryTokens`
 (sparseQueryText's list form, fail-open preserved), pure
 `sparseWakeFilterTokens` (trim, lower-case, len 2..
 `MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.wakeKeywords` imported from core,
 dedupe, cap), pure `sparseWakeGateExpr` (the `enabled` seam the spec
 drives), `SPARSE_WAKE_GATE_ENABLED = true` (kill switch),
 `SPARSE_WAKE_GATE_MAX_TOKENS = 64`. Empty usable tokens fail open to
 exactly the base expr. 14 new unit tests (13 red first for the missing
 exports; the fail-open pin is a no-clause invariant that also holds
 pre-gate); 5 pre-existing search.spec.ts goldens re-pinned to the exact
 gated exprs; service.spec.ts needed NO change (its search stub ignores
 `expr`, so the gate cannot starve it). Full `pnpm test` 854 passed;
 `pnpm build` (lib committed) and `pnpm lint` green; throwaway
 test-tree typecheck recipe: 76 error groups, none in the touched spec
 (pre-existing set, no regressions). Harness: recall-eval.mjs and
 zh-analyzer-probe.mjs gained `--wake-gate` (all pieces imported from
 the emitted lib; legacy-hybrid rejected; wakeGate echoed in artifact
 config + aggregates line). Smokes (/tmp, uncommitted, production
 knobs NOT applied so no metrics read from them): gated run config
 wakeGate=true rowCount 213; baseline no-flag run works rowCount 213;
 probe default-OFF SUMMARY byte-identical to the §Step 1.3 pin; probe
 ON carries the production-merged expr on the 6 non-fail-open texts and
 all three run-* probes keep BOTH pinned hits gated (TASK-017 preview
 confirmed end-to-end against the live analyzer). TASK-009 is next.

  TASK-009 result (2026-11-13, spec Step 2 follow-up, commit 36ab4c6):
  behavior-preserving refactor; all 8 risk classes answered in the commit
  body (resolved: the gate-clause merge in recall-eval.mjs and
  zh-analyzer-probe.mjs is now an import of `sparseWakeGateExpr`, never a
  copy; the token-legality floor/ceiling import core's
  `WAKE_KEYWORD_MIN_LENGTH` and
  `MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.wakeKeywords`, one home each;
  wake-kill-check-probe.mjs's restated
  GATE_TOKEN_MIN/MAX and inline 64 are gone, it calls the shipped
  `sparseWakeFilterTokens`; bloater/shotgun/feature-envy/overengineering
  none found, the zh probe's single-call wrapper deleted at its call
  site; waived with reasons: probe client boilerplate + range-window
  scan duplication (task file allows), core extract* (meta, text,
  filePath) data clump (it is the TriggerInput record re-destructured at
  one entry point)). Gates re-run: build green (core+service lib
  rebuilt, tracked), full test 854 passed / 2 skipped with zero test
  edits (goldens included), lint green. No live-collection access
  (probes edited, not run).

### Phase C: same-session A/B (spec Step 3)

 - [x] [TASK-010-baseline-run](docs/PLAN-wake-gate-TASK-010-baseline-run.md)
 - [x] [TASK-011-gated-run](docs/PLAN-wake-gate-TASK-011-gated-run.md)
 - [x] [TASK-012-score-commit-decide](docs/PLAN-wake-gate-TASK-012-score-commit-decide.md)

 TASK-010..012 result (2026-11-13, spec §"Step 3 A/B executed"):
 **decision FAIL**. Same-session pair (both artifacts `server.rowCount`
 213; wake-audit invariants verified at session start and after the
 gated run: 213/213 scan, 0 empty, 0 markers, 记忆 on 2 rows). Gated:
 sparse-only forbidden 2 -> 1 (inside the <=2 margin; lone survivor
 lywa-php-lint-tooling via slug word `php`, the pre-recorded ruling
 class it PASS-margin, not PARTIAL); P@k 0.284 -> 0.377; forbidden
 10 -> 7; zh control zero deltas (OFF SUMMARY byte-identical to the
 §Step 1.3 pin; ON keeps all three run-* pinned hits, codepoint
 shapes fail open). FAIL trigger: relevant-of-labeled 15/22 -> 14/22
 (machinae-combat-systems lost typescript-simulation-style.md).
 Mechanism measured: the gate PASSES that row (wake contains
 `simulation`); lite 3.2.2 computes filtered-sparse-search BM25
 statistics over the matched subset, the row's raw BM25 rescales
 11.70 -> 4.97, the client sparse floor 5.0 trims it, then
 FUSED_SCORE_FLOOR 1/62 trims the dense-only 1/66. Control: an
 all-rows filter answers bit-identical scores to ungated; a
 one-row-excluded filter shifts every score. Option 4 (Q3: automatic
 under this plan's authority, snapshot first) is the consequence;
 TASK-013 (Phase D live confirmation) is superseded: the gate does
 not ship on a FAIL.

### Phase C2: gated-parity floor re-sweep (Q5 answer)

 - [x] [TASK-018-gated-floor-sweep](docs/PLAN-wake-gate-TASK-018-gated-floor-sweep.md)
 - [x] [TASK-019-ship-retuned-floor](docs/PLAN-wake-gate-TASK-019-ship-retuned-floor.md)

 TASK-018 result (2026-11-13, spec §"Gated floor re-sweep"):
 **recovery: YES, knee at SPARSE_SEARCH_RADIUS 4.75.** Same-session
 gated grid (invariants first AND after: 213/213 scan, 0 empty, 0
 markers, 记忆 on 2 rows; baseline re-run byte-identical to the
 committed control, s50 anchor byte-identical to the committed FAIL
 point; all seven artifacts rowCount 213). 4.75 is the highest radius
 passing all three recovery gates: relevant-of-labeled 15/22 =
 baseline with the missed-label set IDENTICAL to baseline (the lost
 typescript-simulation-style.md row returns, gated BM25 4.968 clears
 4.75); forbidden 7 ≤ 10 with rate 0.109 ≤ 0.114; P@k 0.375. The
 forbidden count is constant 7 across the whole grid; 4.5–3.0 add only
 noise. Fused-floor replay of the winner: 1/62 still the knee (1/63
 buys one 1/63-shape label at forb-rate above baseline; 1/61 is the
 TASK-007-waived corpus artifact). zh canary byte-identical to the
 §Step 1.3 pin. Next: TASK-019 ships 4.75.

 TASK-019 result (2026-11-13, spec §"Outcome (TASK-019, 2026-11-13)",
 commit c7e4d40): shipped shape = wake gate ON +
 `SPARSE_SEARCH_RADIUS = 4.75`, src + lib + specs in one commit; the
 constant's docblock cites the TASK-018 sweep artifacts and keeps the
 TASK-006 5.0-era sweep as superseded unfiltered-shape history; the
 -score cutoff golden now imports the constant instead of pinning 5.0.
 FINAL TUNING VALUES mirrors updated
 (`stopword-strip-findings.md` row with the per-filtered-subset BM25
 gated-parity rationale; `radius-tuning-findings.md` §Final shipped
 tuning kept in lockstep). Gates green: build (lib in lockstep), full
 test 854 passed / 2 skipped, lint. Zero live-collection access. Phase
 D (TASK-013) un-superseded and next.

### Phase D: live confirmation (spec Step 4, sequencing per Q1 answer)

 - [ ] [TASK-013-live-confirmation-or-handoff](docs/PLAN-wake-gate-TASK-013-live-confirmation-or-handoff.md)

  Status: un-superseded (TASK-018 recovered YES and TASK-019 shipped
  the gate + 4.75 shape in c7e4d40). Phase D is next; its bundle
  check now greps the shipped shape (gate AND `SPARSE_SEARCH_RADIUS =
  4.75`) in the installed `service/lib/search.js`.

## Dependencies (tail)

- Q5 routing: TASK-018 (gated floor sweep, read-only) -> TASK-019
  (ship retuned floor, conditional YES) -> TASK-013. Sweep NO
  escalates Option 4 vs plan-close to the user.

## Dependencies

- TASK-014 done (commits 376108d + 57762e3). TASK-016 (repair the
  pre-existing `4bf4f8f` test breakage) runs FIRST in the remaining
  queue so every later task inherits a green `pnpm test`; then TASK-015
  (reindex + re-audit ≤5%) is the live verdict and last blocker before
  Phase B. TASK-016 and TASK-015 run SEQUENTIALLY: shared git index, no
  concurrent subagent commits.
- TASK-002 and TASK-003 run AFTER TASK-015: their inputs are the stored
  wake arrays the reindex rewrites, and the zh pin must sit on the
  post-reindex collection to be a valid TASK-011 control.
- TASK-003 pins the zh control consumed by TASK-011 and TASK-012.
- TASK-004 -> TASK-005 -> TASK-006 -> TASK-007 -> TASK-008 (red, green,
  fakes, harness); TASK-004..007 land inside the single TASK-008 commit.
- TASK-003's probe `--wake-gate` flag ships in TASK-007 (needs TASK-005's
  lib exports).
- TASK-008 -> TASK-009 (refactor keeps tests green, behavior preserved).
- TASK-009 -> TASK-010 -> TASK-011 (back to back, same session) ->
  TASK-012 -> TASK-013 (conditional on the TASK-012 decision).

## Discovered issues ledger

- FOUND (TASK-010/012, spec §"Step 3 A/B executed", the FAIL
  mechanism): milvus-lite 3.2.2 recomputes BM25 corpus statistics
  over the SCALAR-FILTERED subset for every sparse search. A
  filter-shaped control (same query, same session): `chunk_id > 0`
  answers bit-identical scores to the ungated search; excluding one
  row shifts every score; the wake gate rescaled a relevant row's
  raw BM25 11.70 -> 4.97 (below the 5.0 client floor) even though
  the predicate passed it. Any future scalar filter on the sparse
  leg (wake gate, Option-4 legs if ever filtered, scope filters)
  rescores the corpus per query: floors tuned on unfiltered
  distributions do not transfer. Candidate vault note at Finalize:
  `milvus-lite-3-2-2-filtered-sparse-search-rescores-bm25-per-filtered-set`.
- RECORDED (vault note `milvus-lite-3-2-2-query-pagination-by-pk-cursor-silently-loses-rows`
  + wake-audit-probe docblock): milvus-lite 3.2.2 `query` answers in
  segment order; PK-cursor pagination silently loses rows and `order_by`
  is ignored. Full-enumeration probes must use chunk_id range-split
  windows (wake-audit-probe pattern); TASK-002 and any future
  row-enumerating harness code follows that pattern.
- RESOLVED (TASK-016): `packages/events/tests/thinkIntercept.spec.ts`
  stale header assertions from sibling commit 4bf4f8f; the spec is
  synced to the `Memory related to:` shape and full `pnpm test` is
  green at HEAD again.
- NOTED (out of scope): think-channel still treats when/what/etc as
  recall trigger terms (INTENT_MARKERS shared with wake extraction);
  separate hygiene fix if ever scheduled.
- NOTED (TASK-014 report): `LlmRefiner.refine` merges endpoint wake
  terms onto the capped list without `isUsableKeyword` or re-capping;
  and single-segment chunker headers are invisible to wake extraction
  (`section_header` not in `TriggerInput`). Both are follow-up
  candidates outside this plan; TASK-015 should just note whether the
  live reindex engaged the refiner.
- NOTED (TASK-002): the spec §Problem table's vocab column is mis-titled
  "the query token that pulled each": 8 of its 10 listed words are not
  stripped tokens of their queries (only `enemy`, `save` are); the
  column names row-side collision vocab. Step 1.2 predicts from the
  full token ∩ wake intersection, which subsumes it; the table wording
  stays as historical evidence, corrected in the §Step 1.2 record.
- NOTED (TASK-003, spec §Step 1.3): the three Han-hitting zh chunks
  store NO Han wake keys (wake extraction harvests Latin slug words),
  so the gate as specified is predicted to kill the three
  maximal-run zh probes (`run-记忆`, `run-智能体`, `run-的共享记忆`)
  while single-codepoint/stopword-only shapes fail open unchanged.
  TASK-011 must read a zh drop of exactly those three probes as the
  predicted wake-extraction Han gap, not gate wiring; the Decision
  rules' FAIL condition names "zh hits drop". Minor docblock nuance:
  the zh probe says "exactly two Han-bearing chunks"; that is the
  LOCATE-word pair, a third chunk (`266388258919095`) carries the
  standalone `的` character and answers `cp-的`.
  SUPERSEDED by TASK-017 (commit 68e4a02, spec §"Han wake keys"): the
  three Han-hitting chunks now carry Han wake keys, and the zh gate
  PREVIEW shows all three `run-*` probes keep BOTH pinned hits gated
  (lost none). The predicted three-probe zh drop is retired; TASK-011
  is now scored against the "zh probe hits unchanged" PASS criterion
  directly, with the post-Task-017 collection as the control.
- RECIPE for TASK-006 fixture edits (vault note
  `dsh-plugin-obsidian-mem-type-checking-the-test-trees-with-a-throwaway-tsconfig`):
  after changing fixture shapes, typecheck the test trees with the
  throwaway root tsconfig recipe and diff against the ~82-error baseline.
- LIVE HAZARD (TASK-015, commit 2474f02): the running host (pre-fix
  core lib in memory) re-indexes any vault note dirtied AFTER the
  refresh with OLD extraction, and its `memory_read` read-stat bump
  dirties notes by itself. ACTIVE PROTOCOL until Phase C completes: no
  memory_search/memory_read/memory_write against the obsidian-mem vault
  (read vault files by path instead); the session memory checkpoint is
  deferred to Finalize. Post-reindex truth to defend: 213 rows, 0
  empty-wake, markers 0 corpus-wide. If any pin or the A/B finds
  re-pollution, re-run `node scripts/live-reindex.mjs` (~15 s, durable)
  + wake-audit re-check, then proceed. TASK-002/003/010/011 agents get
  the same no-memory-tools instruction.
- PROTOCOL AMENDMENT (TASK-002 report): the agent-side no-memory-tools
  rule is NOT a complete shield; host lifecycle recall hooks can dirty
  notes on their own. Every collection-reading task (003, 010, 011)
  STARTS with the wake-audit invariant check (213 rows, empty 0,
  markers 0) and repairs via live-reindex before measuring; TASK-011
  re-checks invariants immediately after its gated run.
