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

## Tasks

### Phase A: pre-flight measurements (spec Step 1, read-only, blocking)

 - [x] [TASK-001-empty-wake-audit](docs/PLAN-wake-gate-TASK-001-empty-wake-audit.md)
 - [ ] [TASK-002-expected-kill-check](docs/PLAN-wake-gate-TASK-002-expected-kill-check.md)
 - [ ] [TASK-003-zh-baseline-pin](docs/PLAN-wake-gate-TASK-003-zh-baseline-pin.md)

 TASK-001 result (2026-11-13, spec "Pre-flight measurements", commit
 0285a65): 39/210 rows (18.571%) carry empty wake arrays, above the 5%
 ceiling, so the >5% STOP fired: Phase B stays blocked until the
 wake-keyword extraction fix lands in core and the probe re-runs to
 ≤5%. TASK-002/003 are deferred: their inputs are the wake arrays the
 fix rewrites.

### Phase A2: wake-extraction fix (spec Step 1.1 STOP consequence)

 - [x] [TASK-014-wake-extraction-fix](docs/PLAN-wake-gate-TASK-014-wake-extraction-fix.md)
 - [ ] [TASK-015-reindex-refresh](docs/PLAN-wake-gate-TASK-015-reindex-refresh.md)

 TASK-014 result (2026-11-13, spec "Pre-flight measurements", commit
 376108d): wake legality (one home, `isUsableKeyword`) drops the generic
 intent labels and fragment shapes, and file-name slug words stand as
 content wake keywords. Vault replay (143 files, 211 chunks): empty-wake
 chunks 39 -> 0 (18.6% -> 0%), generic-label entries 347 -> 0,
 fragment-shape terms 27 -> 0. TASK-015 (live reindex + wake-audit
 re-run, <=5% gate) is next and unblocks Phase B.

### Phase B: implementation (spec Step 2, TDD, single commit with lib)

 - [ ] [TASK-004-unit-tests-red](docs/PLAN-wake-gate-TASK-004-unit-tests-red.md)
 - [ ] [TASK-005-implement-search-ts](docs/PLAN-wake-gate-TASK-005-implement-search-ts.md)
 - [ ] [TASK-006-fakes-green](docs/PLAN-wake-gate-TASK-006-fakes-green.md)
 - [ ] [TASK-007-harness-flag](docs/PLAN-wake-gate-TASK-007-harness-flag.md)
 - [ ] [TASK-008-commit-green](docs/PLAN-wake-gate-TASK-008-commit-green.md)
 - [ ] [TASK-009-refactor-review](docs/PLAN-wake-gate-TASK-009-refactor-review.md)

### Phase C: same-session A/B (spec Step 3)

 - [ ] [TASK-010-baseline-run](docs/PLAN-wake-gate-TASK-010-baseline-run.md)
 - [ ] [TASK-011-gated-run](docs/PLAN-wake-gate-TASK-011-gated-run.md)
 - [ ] [TASK-012-score-commit-decide](docs/PLAN-wake-gate-TASK-012-score-commit-decide.md)

### Phase D: live confirmation (spec Step 4, sequencing per Q1 answer)

 - [ ] [TASK-013-live-confirmation-or-handoff](docs/PLAN-wake-gate-TASK-013-live-confirmation-or-handoff.md)

## Dependencies

- TASK-001 fired its >5% STOP: TASK-014 (core wake-extraction fix) then
  TASK-015 (reindex + re-audit ≤5%) now block everything downstream.
  Phase B (TASK-004..008) stays frozen until TASK-015's gate passes.
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

- RECORDED (vault note `milvus-lite-3-2-2-query-pagination-by-pk-cursor-silently-loses-rows`
  + wake-audit-probe docblock): milvus-lite 3.2.2 `query` answers in
  segment order; PK-cursor pagination silently loses rows and `order_by`
  is ignored. Full-enumeration probes must use chunk_id range-split
  windows (wake-audit-probe pattern); TASK-002 and any future
  row-enumerating harness code follows that pattern.
