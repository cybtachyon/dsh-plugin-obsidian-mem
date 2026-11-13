# TASK-009: Read fallback leg requires both-route agreement

Files: `packages/service/src/search.ts`, `packages/service/tests/search.spec.ts`.

Exclusively for the `searchExactSections` fallback leg, relevance means the
chunk surfaced on BOTH routes, per the Q3 answer as the literal
`2/(k+1)` fused floor (the TASK-009 offline table row "floor > 2/(k+1)
(both-routes-only)"; that row replays as 7 rows over
`docs/research/eval-split-d078-s25-k60.json`):

- New exported constant `READ_FALLBACK_AGREEMENT_FLOOR = 2 / (RRF_RANKER_K +
  1)` replaces `FUSED_SCORE_FLOOR` as the omitted-minScore default on the
  fallback leg only. The constant note states the math explicitly: under
  RRF(k) the inclusive `2/(k+1)` passes only a hit ranked 1 on both routes;
  a single-route hit tops out at `1/(k+1)`. `fuseRrf` keeps its current
  route-agnostic shape (no presence tagging).
- `hybridSearch` and the exact-file leg keep their current floors unchanged.
- `ExactSectionRequest.minScore` keeps full-override semantics; its doc
  names the new default constant instead of FUSED_SCORE_FLOOR for this leg.
- Module header updates; `FUSED_SCORE_FLOOR` stays the rule home for
  hybridSearch.
- Behavior tests: single-route hit dropped from the fallback leg,
  both-route hit kept (per chosen semantics), explicit minScore override
  unchanged, exact-file leg unaffected.

Definition of Done: probe on
`docs/research/eval-split-d078-s25-k60.json` recorded in this file's
completion note (row counts under the chosen floor match the replay);
src+lib+spec same commit; gates green.

Depends on: TASK-008; Q3 answer.
