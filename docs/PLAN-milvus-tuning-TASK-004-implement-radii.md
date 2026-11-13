# TASK-004: Implement dense + sparse search radii

Edit `packages/service/src/search.ts` `dispatchHybrid` to carry range
parameters per the probe-verified shapes from
`docs/research/radius-tuning-findings.md` and the placement decided in
questionnaire A1.

Required starting values:
- dense (COSINE, relevancy scales up to 1.0): radius `0.78`, range_filter
  the metric ceiling (1.0), passed with `ef`.
- sparse (BM25, higher = stricter, no ceiling): radius `2.5` (plus
  range_filter only if the probe proved it necessary).

Scope:
1. Named module constants beside `RRF_RANKER_K` / `DENSE_SEARCH_EF` (or
   config defaults if A1 says config), with comments stating the semantics
   (radius = relevancy floor; COSINE radius < score <= range_filter).
2. Module header invariant block updated: minScore stays fused-only; the
   per-route radius is a per-route candidate floor, and the G7 no-BM25-
   threshold note is superseded for the radius specifically (radius is a
   server-side score bound on the BM25 metric, not a client-side raw-score
   comparison) if that is what the probe showed.
3. Update `packages/service/tests/search.spec.ts` golden dispatch tests to
   pin the new route params; add a case proving radius survives the
   optional-expr path.
4. `pnpm build` (commit lib in the same commit), `pnpm test`, `pnpm lint`,
   `prek run --files <touched paths>`.

Definition of Done: gates green; committed src+lib+tests together; grep of
the emitted `packages/service/lib/search.js` shows the radius values.
