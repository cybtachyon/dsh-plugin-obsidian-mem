# TASK-003 strip-route-unit-tests

Extend `packages/service/tests/search.spec.ts` (fake-client captures the
two route `search` requests) with golden assertions:
- `hybridSearch`: the BM25 route `data[0]` equals the stop-stripped query;
  the dense route still receives the full-text embed query.
- `searchExactSections`: its fallback leg dispatches the stripped BM25
  query too (shared `dispatchRoutes`).
- Fail-open: a query whose every token is a stop word dispatches the
  ORIGINAL text on the sparse route (never empty).
- Helper-level table test for `sparseQueryText` (multi-space collapse,
  punctuation/hyphen tokens, empty-input handling).

Definition of Done:
- `pnpm test` green; coverage thresholds in `vitest.config.ts` still clear.

Depends on: TASK-002.
