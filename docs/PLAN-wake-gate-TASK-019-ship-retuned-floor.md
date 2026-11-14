# TASK-019: ship the retuned sparse floor (conditional on TASK-018 YES)

Phase C2 close-out. Only runs when TASK-018 recorded recovery YES at a
radius R < 5.0.

1. `packages/service/src/search.ts`: `SPARSE_SEARCH_RADIUS = R` with a
   docblock update in house style: the value is the GATED-parity knee
   (wake gate ON), citing the Q5-gated sweep artifacts + the
   per-filtered-subset BM25 finding (a floor tuned on the unfiltered
   distribution does not transfer to the gated leg; the 5.0-era sweep
   is superseded for the gated shape).
2. Update any test that pins the literal 5.0 (goldens/fakes; prefer
   tests that already import the constant). Full gates green
   (`pnpm build && pnpm test && pnpm lint`), committed lib in lockstep.
   One commit (src + lib + specs).
3. `docs/research/stopword-strip-findings.md` FINAL TUNING VALUES
   block: update the SPARSE_SEARCH_RADIUS row to R with the gated-parity
   rationale + pointer to the spec doc sweep section (this is the
   PASS-rule mirror the spec asked for, executed on the retuned shape).
   Docs commit (or ride the code commit; keep history legible).
4. Note in spec §Outcome: shipped shape = gate + R floor; Phase D
   (TASK-013) un-superseded and next.

Definition of Done: constant shipped, gates green, FINAL TUNING VALUES
updated, Phase D unblocked.
