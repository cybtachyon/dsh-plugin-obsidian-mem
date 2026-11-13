# TASK-002 implement-bm25-stopword-strip

In `packages/service/src/search.ts`, strip stop words from the query text
sent to the BM25 route. One seam: `dispatchRoutes` builds the sparse route's
`data` from the stripped text; the dense route keeps the FULL query (the
e5 embedder is trained on natural language). This covers both
`hybridSearch` and `searchExactSections` (they share `dispatchRoutes`).

Shape (adjust per the recorded `stopword` API from TASK-001; answer A2:
lists are `en` AND `zh`):
- Export a helper, e.g. `sparseQueryText(query: string): string`: tokenize
  on non-word chars, lower-case is NOT needed (analyzer handles case),
  `removeStopwords(tokens, [...en, ...zh])`, re-join with single spaces.
- CJK handling: a whitespace/`\W` tokenizer leaves a whole Chinese run as
  one token the `zh` list can never match. Split CJK runs into single
  codepoints (via `Intl.Segmenter` if you want word shapes, otherwise
  per-character) so single-character `zh` stop words actually filter.
  Record the choice; the A/B (TASK-005) is the empirical check that the
  re-joined CJK tokens still match what the analyzer produced at index
  time. If they provably cannot, keep the CJK text UNSTRIPPED (fail-open)
  and document that the `zh` list only guards mixed-language noise.
- Fail-open: if the stripped result is empty (every token was a stop word,
  or the query was symbols-only), fall back to the ORIGINAL query. An empty
  BM25 data string must never reach lite.
- Keep the helper exported like `RRF_RANKER_K` / `SEARCH_OUTPUT_FIELDS` so
  scripts/eval replays production from the shipped module (TASK-004).
- Update the module doc comment (`@module` header) to state the strip
  rides the sparse route only.

Do NOT: touch the embed query, wake-keyword filters, or the think/read
intercept keyword extraction. No stop-word list edits yet (Q2 answer may add
domain terms; keep the list a module-level constant so it is one edit).

Definition of Done:
- `pnpm build` passes; `packages/service/lib/search.js` exports the helper.
- Grep confirms the sparse `data:` site is the only strip application.

Depends on: TASK-001.
