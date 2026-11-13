# TASK-004: Implement dense + sparse cutoffs (two-route split + client RRF)

- [x] Complete. Two standalone `search` dispatches (server-side dense
  radius 0.78/1.0, client-side BM25 floor on `-score >= 2.5`) plus
  client RRF(60) fusion landed in `packages/service/src/search.ts`
  (commit 0cbb07e).

Design forced by `docs/research/radius-tuning-findings.md` §3/§4:
per-route radii inside one `hybridSearch` are accepted but NOT honored by
milvus-lite 3.2.2, and the BM25 route returns NEGATED scores (best first;
`-score` = BM25 relevance), so a server-side positive floor is
unexpressible. Replace the single `hybridSearch` dispatch in
`packages/service/src/search.ts` with:

1. Two standalone `search` calls, same filter `expr` and same
   `candidateLimit` on each, full `SEARCH_OUTPUT_FIELDS` projection,
   Strong consistency, `callMilvus`/IndexOfflineError semantics unchanged:
   - dense (COSINE): `params: { ef: DENSE_SEARCH_EF,
     radius: DENSE_SEARCH_RADIUS, range_filter: DENSE_RANGE_MAX }`.
     `DENSE_SEARCH_RADIUS = 0.78` (server bound is EXCLUSIVE: keep
     `radius < score <= range_filter`; document that a floor of 0.78
     keeps scores strictly above 0.78), `DENSE_RANGE_MAX = 1.0`.
   - sparse (BM25): `params: {}` (no server radius); apply the floor
     CLIENT-SIDE: keep a hit when `-score >= SPARSE_SEARCH_RADIUS`,
     `SPARSE_SEARCH_RADIUS = 2.5` (user semantics: raising it raises
     required relevancy, no ceiling; `-score` is the BM25 relevance the
     findings establish).
2. Client-side RRF fusion with the existing `RRF_RANKER_K` (60): for each
   route's cutoff-surviving ordered hits, `fused += 1 / (K + rank)` with
   rank from 1, merged by `chunk_id` (findings confirm lite's fused
   scores use exactly this formula). Deterministic order: fused score
   desc, tie-break by ascending `chunk_id`. Produce the same
   `RawSearchRow[]` shape (fields from the first-seen row, `score` =
   fused) so `toResults`/`minScore`/`topSections`/`searchExactSections`
   are untouched downstream.
3. Constants live in search.ts (answer A1) beside `RRF_RANKER_K`, with
   comments naming the verified semantics and pointing to the findings
   doc.
4. Module header + `SearchMilvus` interface + `HybridRoute`/
   `HybridSearchDispatch` types updated to the two-search reality (the
   interface needs `search`, no longer `hybridSearch`); the G7 and G3
   invariant notes rewritten to what the probe proved (negated BM25
   scores; per-route expr still per-search; count guard unchanged).
5. `packages/service/tests/search.spec.ts`: replace the hybrid golden
   tests with goldens for BOTH searches (params incl. radius/
   range_filter/ef, expr on each route) plus fusion math (dual-route
   chunk = 1/(k+1)+1/(k+1), single-route rank r = 1/(k+r)), sparse
   cutoff boundary (score == -2.5 survives, -2.4999 dropped), and a
   radius-typed regression pin (numbers, not strings).
6. `pnpm build` (lib in the SAME commit), `pnpm test`, `pnpm lint`,
   `prek run --files <touched paths>`; no --no-verify.

Definition of Done: gates green; committed src+lib+tests together; grep of
`packages/service/lib/search.js` shows 0.78, 1, 2.5; the emitted lib
dispatches two `search` calls and fuses client-side.
