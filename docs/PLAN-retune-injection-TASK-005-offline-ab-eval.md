# TASK-005 offline-ab-eval

Run the labeled 17-query set against the LIVE collection (read-only
discipline per scripts/eval/README.md) at production knobs
(dense radius 0.78, range 1.0, ef 64, sparse floor 2.5, k 60, topK 6,
oversample 2):
1. Baseline: `--mode split-rrf --keep-stopwords --label strip-off-d078-s25-k60`.
2. Treatment: `--mode split-rrf --label strip-on-d078-s25-k60`.

Commit both artifacts deliberately:
`--out docs/research/eval-split-strip-off-d078-s25-k60.json` and
`--out docs/research/eval-split-strip-on-d078-s25-k60.json`. Write a new
findings doc `docs/research/stopword-strip-findings.md`: aggregate P@k,
forbidden-rate, recall, per-query deltas, and the sparse-route score
distribution shift (how much BM25 mass disappeared). Verdict framing:
strip is DECIDED work, so the doc decides knob follow-ups (TASK-006), not
whether the feature ships; record any query that regressed and why.

Definition of Done:
- Two committed artifacts + findings doc with the comparison table.
- Note the label-honesty caveat if the live vault drifted since
  `queries-labels.mjs` was cut (README "Collections drift").

Depends on: TASK-004.
