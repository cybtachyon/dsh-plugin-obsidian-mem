# TASK-004 eval-harness-parity

The offline harness must replay production exactly. In
`scripts/eval/recall-eval.mjs`, import the strip helper from
`packages/service/lib/search.js` and apply it to the BM25 `data` in both
the `split-rrf` page computation and the legacy route-membership probes
(production behavior parity). Add a `--keep-stopwords` flag that skips the
strip so one corpus answers the A/B; echo the choice in the artifact config
block (artifacts must stay deterministic, no timestamps).
`scripts/eval/cross-encoder-rerank.mjs` builds its own production page:
give it the same helper import (no flag needed; it follows production).
Update `scripts/eval/README.md` knobs table with the new flag.

Definition of Done:
- `node scripts/eval/recall-eval.mjs --mode split-rrf --label smoke-strip`
  runs clean; its smoke artifact shows the config echo.
- `--keep-stopwords` demonstrably changes the sparse route input (diff a
  two-query smoke run).

Depends on: TASK-002.
