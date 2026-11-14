# TASK-004: unit-tests-red

Phase B (spec Step 2.1, TDD red step). Touch ONLY
`packages/service/tests/search.spec.ts` (match its existing fake-client
and expr-assertion conventions; read the file first).

New tests (they must fail against current code, since the exports do not
exist yet):

1. `sparseWakeFilterTokens` legality: lower-cases, trims, drops tokens
   with length < 2, drops tokens longer than
   `MILVUS_ARRAY_ELEMENT_MAX_LENGTHS.wakeKeywords` (import the constant
   from core lib; mirror `isUsableKeyword` intent without restating the
   number), dedupes, caps the result at `SPARSE_WAKE_GATE_MAX_TOKENS`
   (66 distinct tokens in, `SPARSE_WAKE_GATE_MAX_TOKENS` out, first-seen
   order).
2. Gate clause shape: with the gate enabled and usable stripped tokens,
   the SPARSE route request `expr` equals the base expr +
   ` + and ARRAY_CONTAINS_ANY(wake_keywords, [...])` with the
   quoteExpr/listLiteral escaping (golden string, same style as the
   existing buildFilterExpr goldens); with NO base expr the sparse route
   carries ONLY the gate clause.
3. Empty usable tokens (all stop-words / too short) -> sparse `expr` is
   exactly the base expr (fail-open, no clause).
4. `SPARSE_WAKE_GATE_ENABLED === true` is exported; with the gate
   conceptually disabled the behavior must be "no clause" — since a
   module-level const cannot be flipped per test, test the pure path the
   implementation exposes (e.g. the clause builder takes an `enabled`
   decision, or the wiring is a pure function the spec drives); pick the
   seam that keeps `dispatchRoutes` honest and note it in the test.
5. The DENSE route request `expr` stays the ungated base expr.

Tokens for the gate come from `sparseQueryTokens(query)` (the list form
` sparseQueryText` joins — TASK-005 creates it); test via a query whose
stripped token list is known.

Definition of Done: new tests exist and `pnpm test` shows them RED for
the right reason (missing behavior/exports, not a broken fixture). Do
NOT commit separately; this work lands in the TASK-008 single commit.
