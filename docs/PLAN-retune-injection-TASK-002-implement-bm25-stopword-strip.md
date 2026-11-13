# TASK-002 implement-bm25-stopword-strip

In `packages/service/src/search.ts`, strip stop words from the query text
sent to the BM25 route. One seam: `dispatchRoutes` builds the sparse route's
`data` from the stripped text; the dense route keeps the FULL query (the
e5 embedder is trained on natural language). This covers both
`hybridSearch` and `searchExactSections` (they share `dispatchRoutes`).

Shape (API VERIFIED against stopword@3.1.5 in TASK-001's "Shipped import
shape" section; answer A2: lists are English AND Chinese):
- Types FIRST: stopword ships none; add `"@types/stopword": "^2.0.3"` to
  the ROOT devDependencies only (matching the `@types/node` convention;
  DefinitelyTyped signatures match the v3 flat-array API) or `pnpm build`
  fails TS7016.
- Export a helper, e.g. `sparseQueryText(query: string): string`: tokenize
  on non-word chars (lower-case is NOT needed; removal matches on
  `token.toLowerCase()`), then
  `removeStopwords(tokens, [...eng, ...zho])` (v3 takes ONE FLAT array;
  exports are `eng`/`zho` by ISO 639-3 code, NOT `en`/`zh`), re-join with
  single spaces.
- CJK handling: `zho` is 78 SINGLE-character function words with no CJK
  segmentation in the package, so a whitespace-split zh query strips
  nothing. Split CJK runs into single codepoints so the list actually
  fires, and re-join with single spaces. Record this choice; the A/B
  (TASK-005) is the empirical check that the re-joined CJK tokens still
  match what the analyzer produced at index time. If they provably
  cannot, keep the CJK text UNSTRIPPED (fail-open) and document that the
  `zho` list only guards mixed-language noise.
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

## Implementation record (2026-11-13)

- Types: `"@types/stopword": "^2.0.3"` added to the ROOT devDependencies
  only (the `@types/node` convention). Its declarations are `export =` of
  a `{ [LanguageCode]: string[] } & Stopword` intersection; under
  `moduleResolution: nodenext` the named import
  `import { eng, removeStopwords, zho } from 'stopword'` typechecks, and
  Node's CJS named-export detection resolves it at runtime (verified
  against the emitted `lib` module).
- `sparseQueryText(query: string): string` exported from
  `packages/service/src/search.ts` (emitted + verified in
  `packages/service/lib/search.js`). Its ONE application point is
  `dispatchRoutes`' sparse `data: [sparseQueryText(queryText)]`; grep of
  `packages/*/src` confirms no other call site. Dense/e5 keeps the FULL
  query (callers embed before dispatch).
- Tokenizer (module-level `SPARSE_TOKEN_RUN`):
  `/[\p{Script=Han}]|(?:(?![\p{Script=Han}])[\p{L}\p{N}_])+/gu`. One Han
  codepoint per match; other word-character runs (`\p{L}\p{N}_`) stay
  whole; everything else separates. Removal is
  `removeStopwords(tokens, [...SPARSE_QUERY_STOPWORDS])` where the
  module-level constant is `[...eng, ...zho]` (186 entries, one edit for
  the Q2 follow-up). Re-join with single spaces; fail-open returns the
  ORIGINAL query when the stripped join is empty.
- RECORDED CJK choice: Han runs split per codepoint so the 78
  single-character `zho` entries fire, then re-join with single spaces.
  OPEN QUESTION carried to the TASK-005 A/B: whether the space-re-joined
  codepoints still match what the BM25 analyzer produced at index time
  (schema.ts enables the default analyzer, no jieba). If they provably
  cannot, keep CJK UNSTRIPPED (fail-open) and document `zho` as a
  mixed-language noise guard only. Observed scope notes (CORRECTED
  2026-11-13 per TASK-003 verification against the installed list): `zho`
  contains frequently-used SIMPLIFIED Han characters (日 月 年 时 分 秒 一
  等) but NOT traditional 時, nor 二, nor 间/間, so Japanese-adjacent Han
  runs are affected only on the shared simplified shapes; kana and Hangul
  are word characters here and pass through whole.
- Existing golden updated for the intentional change: the two-route
  dispatch spec's BM25 `data` pin moved from the raw
  `'how do i rate limit'` to the stripped `'rate limit'`. Deeper strip
  goldens stay in TASK-003's scope.
- Gates at commit: `pnpm build`, `pnpm test` (807 passed, 2 skipped),
  `pnpm lint`, `pnpm test:coverage` thresholds, `prek run --files`.
