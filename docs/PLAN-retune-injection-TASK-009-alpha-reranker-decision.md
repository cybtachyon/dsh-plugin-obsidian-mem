# TASK-009 alpha-reranker-decision

Undecided-1: "continuing to tune the Hybrid search alpha parameter /
Re-Ranker." Record the go/no-go with evidence.

Facts to weigh (verify current before writing):
- The production fusion is CLIENT-SIDE RRF (`fuseRrf`, k=60): a rank-only
  fusion with NO alpha parameter. Tuning an alpha means replacing RRF with
  weighted score fusion (dense-vs-sparse score scales are incomparable:
  COSINE vs negated BM25, G7), a redesign, not a knob.
- `docs/research/cross-encoder-findings.md` (TASK-012) REJECTED
  bge-reranker-base as post-fusion reranker/cutoff, with reasons.
- The existing tunable surfaces (DENSE_SEARCH_RADIUS, SPARSE_SEARCH_RADIUS,
  FUSED_SCORE_FLOOR, RRF_RANKER_K) were already swept (radius-tuning and
  stopword-strip findings).

Decision: follow the Q4 answer (default RECOMMENDED: skip; revisit only if
the Phase-3 live loop shows ranking-order errors that floors cannot fix;
record which observation would reopen it). If the user elects GO, add a
follow-on implementation task to this plan before Phase 3.

Definition of Done: decision + rationale written in this file; plan
updated with any follow-on task.

Citation caveat (TASK-006): docs/research/cross-encoder-findings.md's
committed artifact was computed when the harness imported
SPARSE_SEARCH_RADIUS=2.5; the harness now follows the shipped 5.0, so a
re-run replays a different page. Cite the committed artifact's REJECT
verdict with that staleness flagged; do not present it as replaying
today's production page.

Depends on: TASK-005 (strip-ON numbers inform whether ranking order is
the remaining problem).

# Decision record (2026-11-13): SKIP, no follow-on task

NO-GO on any alpha/fusion/reranker work for this plan, per plan answer A4.
No follow-on implementation task is added to PLAN-retune-injection.md.
Facts re-verified against HEAD d2b43d9 before recording.

## 1. There is no alpha to tune (verified in code)

Production fusion is CLIENT-SIDE RRF: `fuseRrf` in
`packages/service/src/search.ts:611-627` sums `1 / (RRF_RANKER_K +
index + 1)` per route at `RRF_RANKER_K = 60` (search.ts:234). It is rank
only: route scores never enter the fused score, and the negative BM25
scale never leaks (G7). No alpha/weight parameter exists anywhere on the
search path (a repo grep for `alpha` in `packages/service/src` and
`packages/core/src` hits only version strings and the word
"alphanumerics"/"alphabetical"). "Tuning alpha" therefore means
REPLACING rank fusion with weighted score fusion across incomparable
scales: the dense route returns COSINE similarities (search.ts:579-584)
while the sparse route returns negated BM25 relevancy best-first
(`sparseSurvivors`, search.ts:597-604; radius-tuning-findings §3). That
is a redesign, not a knob. The redesign was already rejected with
measurements in the PLAN-milvus-tuning loop: "WeightedRanker (route
scores unseparable: dense class medians 0.863/0.836/0.838)"
(radius-tuning-findings.md, "Rejected with measurements" list in the
Final shipped tuning section).

## 2. The reranker is REJECTED (verified verdict; staleness flagged)

`docs/research/cross-encoder-findings.md` (TASK-012, commit 41dacb0)
REJECTS bge-reranker-base as post-fusion reranker/cutoff on five
measured grounds: the zero-relevant-loss calibration optimum (0.0028)
degenerates the reranker to a deep-tail garbage filter; the residual
forbidden rows sit inside the score band occupied by relevant rows
(the overlap band IS the design-relevance class the system must
surface); it would demote the exact false negative it was queued to
rescue; the re-sort moves the best relevant row by zero (mean index
1.286 both sides); and it costs ~0.5 s CPU/query plus a 283 MB model
per session. Staleness flag per the TASK-006 caveat above: that
artifact's stack header pins the then-production page (sparse floor 2.5,
fused floor 1/61, pre-stop-word-strip BM25 query text); the strip
(fbcca60, then a763d6b) and SPARSE_SEARCH_RADIUS 5.0 (a68e4c1) landed
after 41dacb0. The REJECT verdict is cited as the committed record; a
re-run would replay a different page, and none is owed because the
reopen watch (§4) covers what would change the picture.

## 3. All four tunable surfaces are swept (verified sweep homes)

| knob (search.ts) | value | sweep / re-check home |
| --- | --- | --- |
| DENSE_SEARCH_RADIUS | 0.78 | radius-tuning-findings Final shipped tuning (table row 2) |
| SPARSE_SEARCH_RADIUS | 5.0 | stopword-strip-findings §"Sparse floor re-sweep (TASK-006)" |
| FUSED_SCORE_FLOOR | 1/(k+2) | stopword-strip-findings §"Fused-floor re-check (TASK-006)" |
| RRF_RANKER_K | 60 | radius-tuning-findings Final shipped tuning (table row 4) |

Per-surface evidence, as committed: DENSE 0.78 sits on the measured
plateau 0.78-0.84, with 0.82+ cutting relevant (radius-tuning-findings
Final shipped tuning). SPARSE: the 2.5-era sweep converged in
PLAN-milvus-tuning; the strip-on re-sweep retired the inert 2.5 to the
5.0 knee (trims 19/193 window candidates, forbidden 21 -> 19, P@k
0.241 -> 0.250, recall 14/22 unchanged). FUSED: re-confirmed at 1/(k+2) on
the strip-on page (1/63 adds zero recall and +6/+7 forbidden rows; 1/61
re-opens the live-loop single-route rank-2 floor-out). K: k 10-60
indistinguishable at this corpus size, and the Final shipped tuning
section lists "Rejected with measurements: rrfK change".

No un-swept knob remains that an "alpha/reranker tuning" pass would
turn; the residual forbidden-rate lives in trigger vocabulary and
ext-fallback query design (radius-tuning-findings, Live loop evidence),
not in fusion.

## 4. Reopen evidence watch

Reopen this decision only on this observation in the Phase-3 live loop
(TASK-013 ledgers on /home/derek/src/machinae-game): a seeded RELEVANT
note recalled but ranked BELOW seeded decoys, in a shape where no floor
adjustment fixes the order. The three floors (DENSE_SEARCH_RADIUS,
SPARSE_SEARCH_RADIUS, FUSED_SCORE_FLOOR) only cut candidates from route
tails or the fused tail; they can never permute the survivors, so a
relevant-below-decoy inversion is the one failure mode these knobs
structurally cannot repair. TASK-005's strip-ON numbers predict none:
the strip pair kept every query's label outcome, the page movement
being sub-0.001 score shifts plus single-row swaps, and TASK-006's
sparse-grid sweep trimmed no relevant row at any grid point.

## 5. What follows if reopened

Add a follow-on implementation task to PLAN-retune-injection.md before
further Phase-3 tuning, scoped to exactly one of:
(a) weighted score fusion with explicit per-route normalization, which
must first answer the measured route-score unseparability
(radius-tuning-findings, Rejected list); or (b) a reranker limited to
cross-encoder-findings' own reopen conditions: design-relevance as a
modeled feature fine-tuned on this vault's labels, or
manifest-contamination evidence that the production noise population is
separable after all. Either candidate ships only through the same gate
as everything else in this plan: before/after numbers on committed
recall-eval artifacts, then the live-loop relevance/decoy gate.
