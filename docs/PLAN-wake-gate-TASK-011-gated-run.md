# TASK-011: gated-run + zh gated re-check

Phase C (spec Step 3). Execute immediately after TASK-010 (same
session, same corpus; record that both artifacts carry the same
`server.rowCount`, else rerun both).

1. Spec command verbatim:

```
node scripts/eval/recall-eval.mjs --mode split-rrf --wake-gate \
  --dense-radius 0.78 --dense-range 1.0 --sparse-radius 5.0 \
  --rrf-k 60 --top-k 6 --oversample 2 --min-score 0.016129 \
  --out docs/research/eval-split-strip-on-d078-s50-k60-m016129-wakegate.json
```

2. `node docs/research/probes/zh-analyzer-probe.mjs` and
   `node docs/research/probes/zh-analyzer-probe.mjs --wake-gate`:
   compare the gated SUMMARY hitChunkIds against the TASK-003 pin.
   "zh probe hits unchanged" is a PASS criterion; record any delta.
3. Report aggregates for both runs side by side, plus the raw counts of
   sparse-only forbidden rows in each artifact (from `returned[]`
   `routes`+`classification`, the TASK-002 prediction's real-world check).

Do NOT commit yet; do not commit the zh probe output (pinned in the
spec doc by TASK-012's doc update).

Definition of Done: gated artifact exists; rowCount matches TASK-010's;
zh gated-vs-pin comparison recorded in the run report.
