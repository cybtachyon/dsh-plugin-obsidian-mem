# TASK-007: harness-flag + zh probe flag

Phase B (spec Step 2.4) plus the zh probe flag deferred from TASK-003.
Runs AFTER TASK-005 so `packages/service/lib/search.js` (rebuilt in
TASK-008's build; `pnpm build` locally before smoke) exports
`sparseQueryTokens`, `sparseWakeFilterTokens`, `SPARSE_WAKE_GATE_ENABLED`,
`SPARSE_WAKE_GATE_MAX_TOKENS`. Never restate values in the harness
(TASK-008 export pattern; import everything).

`scripts/eval/recall-eval.mjs`:

1. New flag `--wake-gate` (parseArgs + USAGE text: "gate the BM25 route
   on stored wake_keywords intersecting the stripped query tokens
   (production SPARSE_WAKE_GATE parity); split-rrf sparse route only").
2. When set, compute per query:
   `tokens = sparseWakeFilterTokens(sparseQueryTokens(query))`,
   `gateClause = buildFilterExpr({ wakeKeywords: tokens })` (import
   buildFilterExpr too), and merge `base + " and " + gateClause` exactly
   as production's dispatchRoutes does (empty tokens -> no clause,
   fail-open; honor `SPARSE_WAKE_GATE_ENABLED` imported from the lib: if
   it is false, the flag is a no-op with a note, mirroring production).
   Apply to the split-rrf SPARSE `client.search` expr only (dense stays
   on the base expr).
3. `routeMembership`'s sparse membership search mirrors the same expr so
   route flags describe the gated route; legacy-hybrid's BM25 route in
   hybridSearch cannot carry a per-route filter there, so reject
   `--wake-gate --mode legacy-hybrid` with a clear error.
4. Artifact `config` block gains `wakeGate: <boolean>`; the aggregates
   line echoes it.

`docs/research/probes/zh-analyzer-probe.mjs`: add the same `--wake-gate`
flag (default OFF keeps today's output byte-identical); when set, each
SEARCH passes the merged expr built the same production way.

Smoke: `node scripts/eval/recall-eval.mjs --mode split-rrf --wake-gate
--top-k 6 --out /tmp/wakegate-smoke.json` (throwaway) completes and its
config shows wakeGate true; baseline smoke without the flag still
works. Smokes not committed.

Definition of Done: both scripts updated; smokes pass; no separate
commit (lands in TASK-008).
