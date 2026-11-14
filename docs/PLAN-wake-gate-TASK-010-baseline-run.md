# TASK-010: baseline-run (same-session control)

Phase C (spec Step 3). Execute FIRST, back to back with TASK-011 on the
same corpus and the same built lib. Read-only harness run.

Command (baseline name per PLAN-wake-gate.md Answer log Q2):

```
node scripts/eval/recall-eval.mjs --mode split-rrf \
  --dense-radius 0.78 --dense-range 1.0 --sparse-radius 5.0 \
  --rrf-k 60 --top-k 6 --oversample 2 --min-score 0.016129 \
  --out docs/research/<Q2 baseline name>
```

No `--wake-gate`. Capture: artifact path, `server.rowCount`, aggregates
line (returned, relevant, forbidden, recall, P@k, forbRate), and the
class x route counts of the page rows for the record. Do NOT commit yet
(TASK-012 commits the pair together).

Sanity: if this baseline's aggregates differ materially from the
committed `eval-split-strip-on-d078-s50-k60-m016129.json` (corpus
drifted, e.g. an indexer touched rows mid-window), note it in the run
report; the same-session pair is still the valid control.

Definition of Done: artifact exists; rowCount + aggregates reported.
