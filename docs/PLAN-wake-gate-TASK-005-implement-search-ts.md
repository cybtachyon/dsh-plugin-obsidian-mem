# TASK-005: implement-search-ts

Phase B (spec Step 2.1, green step). Touch ONLY
`packages/service/src/search.ts` (docblocks are load-bearing: house
style, dated evidence notes citing
`docs/research/eval-split-strip-on-d078-s50-k60-m016129.json`).

1. Refactor `sparseQueryText`: extract the token list into exported
   `sparseQueryTokens(query): string[]` (SPARSE_TOKEN_RUN match,
   `removeStopwords` with `SPARSE_QUERY_STOPWORDS`; the fail-open keeps
   the ORIGINAL tokens when stripping empties, never an empty list);
   `sparseQueryText` becomes `join(' ')` of that (docblock updated: one
   home for the Han-run rule stays there).
2. Add exported pure helper `sparseWakeFilterTokens(tokens): string[]`:
   trim, lower-case, drop len < 2, drop len >
   `MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.wakeKeywords` (import from core
   lib; do not restate), dedupe, slice to `SPARSE_WAKE_GATE_MAX_TOKENS`.
3. Add exported constants with dated evidence docblocks (house style,
   citing the A/B artifact and the route-attribution finding):
   `SPARSE_WAKE_GATE_ENABLED = true` (kill switch) and
   `SPARSE_WAKE_GATE_MAX_TOKENS = 64` (expression-length guard).
4. Wire into `dispatchRoutes`: build the gate clause ONLY for the sparse
   search via the existing `listLiteral`/`quoteExpr` helpers (reuse the
   buildFilterExpr clause shape: `ARRAY_CONTAINS_ANY(wake_keywords,
   [...])`), merge with ` and ` after the shared base expr; empty usable
   tokens or `SPARSE_WAKE_GATE_ENABLED === false` -> sparse expr is
   exactly the base expr. Dense route unchanged. Gate tokens:
   `sparseWakeFilterTokens(sparseQueryTokens(queryText))`. The gate
   rides EVERY dispatchRoutes caller (hybridSearch, exact-file,
   fallback): "the sparse route of every recall dispatch" per spec.
5. Keep `sparseSurvivors`, fusion, floors untouched.

Definition of Done: TASK-004 tests GREEN (`pnpm test`); lint clean on
the file; no separate commit (lands in TASK-008).
