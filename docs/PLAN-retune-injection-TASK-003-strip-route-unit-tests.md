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

## Implementation record (2026-11-13)

- `packages/service/tests/search.spec.ts` gained two describes (18 new
  tests; suite 825 passed, 2 skipped):
  - `sparseQueryText tokenizer table (shipped behavior)`: a 15-row
    `it.each` pinning the ACTUAL shipped tokenizer, computed from
    `packages/service/lib/search.js` before writing the goldens:
    multi-space collapse after removal, hyphen/punctuation as
    separators, `_` inside the word run, digits kept, case-insensitive
    removal with survivor casing kept (`'THE rate Limit'` →
    `'rate Limit'`), Han per-codepoint split, kana/Hangul whole, and the
    fail-opens (all-stop-word, symbols-only, empty input → original,
    identity at `''`).
  - `stop-word strip on the BM25 route (TASK-003 pins)`:
    `hybridSearch` BM25 `data` golden `'does Milvus indexer'` (only
    true function words drop) plus dense `data` asserted equal to the
    fakeEmbedder vector of the FULL query and NOT the stripped text's
    vector (fakeEmbedder is a deterministic hash of the exact text);
    fail-open at the route (`'the a of'` reaches BM25 verbatim, never
    empty); and the `searchExactSections` shared seam: both dispatch
    pairs' BM25 legs carry the stripped snippet (`'the widget of'` →
    `'widget'`) while all four dense legs carry the FULL snippet's
    vector.
- Verified list facts the goldens rely on (queried against the installed
  stopword@3.1.5, correcting earlier notes): `eng` has `do` but NOT
  `does`; `zho` (all 78 entries are single characters) has 日/时/和/的
  but NOT 時 (traditional), 二, or 间/間. The `テストの時間` →
  `テストの 時 間` pin records that Han splits respect the Han/script
  boundary: a kana run absorbs adjacent kana but stops at Han.
- Empty-input note: `sparseQueryText('')` returns `''` (fail-open to the
  original is the identity there); no caller builds an empty query
  (searchExactSections falls back to `filePath`), so the pin records the
  behavior without changing it.
- Gates: `pnpm test` (825 passed, 2 skipped), `pnpm test:coverage`
  thresholds clear, `pnpm lint` clean, `prek run --files`.
