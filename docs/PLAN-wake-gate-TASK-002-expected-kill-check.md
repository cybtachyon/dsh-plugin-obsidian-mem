# TASK-002: expected-kill-check

Phase A (spec Step 1.2). Depends on TASK-001 (reuse its fetched wake
arrays; either extend `docs/research/probes/wake-audit-probe.mjs` with a
`--kill-check` mode or write a companion probe). Read-only RPC rules as
TASK-001.

For the 6 forbidden sparse-only collision rows listed in
`docs/research/sparse-wake-gate-spec.md` §Problem (locate their
`chunk_id` + `source_path` in the `returned[]` arrays of
`docs/research/eval-split-strip-on-d078-s50-k60-m016129.json`,
`routes: "sparse"` and `classification: "F"`):

1. For each labeled query in `scripts/eval/queries-labels.mjs`,
   recompute stripped tokens: `sparseQueryText(query)` imported from
   `packages/service/lib/search.js`, split on single spaces (that is
   the strip's join shape).
2. Intersect those tokens with each collision row's stored
   `wake_keywords`.
3. Predict per row: dies (no intersection) or survives (intersection).
   A row whose wake array CONTAINS its collision word is wake-list
   pollution: call it out per row.

Record the 6-row table (query | row source_path | collision word |
wake-array contains collision word? | predicted survive/die) in the
spec doc's "Pre-flight measurements (2026-11-13)" section, plus a line
naming which labeled queries' relevant rows the check predicts safe (if
a relevant labeled row appears). Commit probe + spec doc.

Definition of Done: table recorded; pollution rows identified; commit
exists. This prediction is compared against the TASK-011 A/B outcome.
