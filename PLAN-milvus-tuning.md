# Plan: Milvus recall relevancy tuning (dense/sparse radius + fusion knobs)

Objective: stop irrelevant memories from clouding agent sessions. Required:
add a range-search radius to the dense route (start 0.78, COSINE scale up to
1.0) and the sparse BM25 route (start 2.5, unbounded) in
`packages/service/src/search.ts`, verified with before/after metrics.
Optional (metrics-gated): BM25 k1/b re-index, lower RRF k, post-RRF cutoff,
WeightedRanker, bge-reranker-base cross-encoder.

## Verification guidelines

- Repo gates per AGENTS.md: `pnpm build` (lib is tracked; src edit and its
  lib emit land in the SAME commit), `pnpm test`, `pnpm lint`,
  `prek run --files <paths>` before each commit.
- Every tuning change is proven by the offline eval harness metrics
  (precision@k, noise count, relevant-recall loss) AND the live
  subagent recall test on the machinae-game testbed, not by inspection.
- Host-side tuning only activates after a DSH restart; never conclude a
  tuning worked without a post-restart live test.
- Revert values immediately if relevant test memories stop being recalled
  (false-negative regression outranks noise reduction).
- The live milvus-lite server is the production store: ALL probes against
  it are read-only searches (user decision A2: no scratch instances, no
  scratch collections). Destructive experiments (e.g. BM25 k1/b re-index)
  require explicit user consent at that point.

## Open questions

All resolved; see Answers below.

## Micro-tasks

### Phase A: Research and baseline

- [x] [TASK-001-radius-semantics-probe](docs/PLAN-milvus-tuning-TASK-001-radius-semantics-probe.md)
- [x] [TASK-002-eval-harness](docs/PLAN-milvus-tuning-TASK-002-eval-harness.md)
- [x] [TASK-003-baseline-metrics](docs/PLAN-milvus-tuning-TASK-003-baseline-metrics.md)

### Phase B: Required tuning

- [x] [TASK-004-implement-radii](docs/PLAN-milvus-tuning-TASK-004-implement-radii.md)
- [x] [TASK-005-offline-metric-compare](docs/PLAN-milvus-tuning-TASK-005-offline-metric-compare.md)
- [ ] [TASK-006-live-restart-recall-test](docs/PLAN-milvus-tuning-TASK-006-live-restart-recall-test.md)
- [ ] [TASK-007-iterate-tuning](docs/PLAN-milvus-tuning-TASK-007-iterate-tuning.md)
- [ ] [Refactor-review-phase-b](docs/PLAN-milvus-tuning-TASK-008-refactor-review-phase-b.md)

### Phase C: Optional tuning (metrics-gated; run only on the questionnaire's decided scope)

- [x] [TASK-009-rrf-k-and-cutoff](docs/PLAN-milvus-tuning-TASK-009-rrf-k-and-cutoff.md)
- [x] [TASK-010-weighted-ranker-eval](docs/PLAN-milvus-tuning-TASK-010-weighted-ranker-eval.md)
- [x] [TASK-011-bm25-index-params](docs/PLAN-milvus-tuning-TASK-011-bm25-index-params.md)
- [x] [TASK-012-cross-encoder-reranker](docs/PLAN-milvus-tuning-TASK-012-cross-encoder-reranker.md)
- [x] [TASK-014-read-intercept-fallback-floor](docs/PLAN-milvus-tuning-TASK-014-read-intercept-fallback-floor.md)
- [x] [TASK-015-manifest-text-ab](docs/PLAN-milvus-tuning-TASK-015-manifest-text-ab.md)

### Phase D: Finalize

- [ ] [TASK-013-cleanup-verify](docs/PLAN-milvus-tuning-TASK-013-cleanup-verify.md)

## Task dependencies

- TASK-002 depends on TASK-001 (harness must use probe-verified param shapes).
- TASK-003 depends on TASK-002.
- TASK-004 depends on Q1 (placement) and TASK-001 (param shapes).
- TASK-005 depends on TASK-003 and TASK-004.
- TASK-006 depends on TASK-004 (built) plus a user DSH restart.
- TASK-007 depends on TASK-005 and TASK-006.
- TASK-008 depends on TASK-007 (reviewed commits are the Phase B commits).
- Phase C tasks depend on TASK-007 metrics and Q4 scope answer.
- TASK-013 depends on everything above.

## Answers (from questionnaire)

- A1: Keep the radius values as module constants in `search.ts` (defaults
  for the route `search` params, as TASK-004 shipped them).
- A2: NO scratch instances/collections. Probe range semantics with
  read-only searches directly against the live production collection.
- A3: Yes. Tagged test memories allowed in the shared default vault;
  archive after each test iteration.
- A4: Stop when required tuning hits target; treat every optional tuning
  as a hypothesis to evaluate, and proceed with any that the harness
  metrics show make a substantial positive impact.
- A5: No preference; any reasonable small change or investigation on
  machinae-game works.

## Baseline metrics (TASK-003, legacy-hybrid, 2026-11-13)

Artifact: `docs/research/eval-baseline-legacy.json` (17 labeled queries,
topK=6, oversample=2, RRF k=60, no radii).
Aggregates: `precision@k=0.216 forbidden-rate=0.294
recall-of-labeled=15/22=0.682` (returned=102, relevant=22,
acceptable=29, forbidden=30, neutral=21).
Worst noise offenders: cross-project notes riding BOTH routes on
machinae-game/three.js queries (drupal/bigpipe x3), guestwise/lywa
notes at rank 1 on each other's queries. machinae-game has no own
note in the collection (its only relevant label is the TS-simulation
note).

## Offline comparison: radii 0.78 / 2.5 (TASK-005)

Real run split-rrf @ dense 0.78 / sparse 2.5
(`docs/research/eval-split-d078-s25-k60.json`):
`P@k=0.216 forbRate=0.304 recall=0.682` - no measurable impact versus
the baseline. Simulation sweep (same route candidates; split-rrf mode
is simulable from the baseline artifact) across dense radius 0-0.86 x
sparse floor 0-6 confirms the plateau; dense 0.82+ cuts relevant
(recall 0.636). Verdict: KEEP the required radii at 0.78/2.5 - zero
recall cost, trims junk pages - but they are NOT the cure.

Why they cannot cure it (separability study, from the baseline
artifact): per-route scores do not separate labeled classes. Dense
median scores relevant 0.863 / forbidden 0.836 / neutral 0.838 with
near-identical minima (~0.807); sparse relevance medians 16.2 / 11.0 /
11.4 with overlapping ranges. Cross-project notes genuinely score
high on both routes; only the dual-route agreement differs (relevant
53% both-routes vs forbidden 8%).

What DOES move offline (radii off unless noted; floor = post-RRF
minScore):

| point | P@k | forbRate | recall | returned |
| --- | --- | --- | --- | --- |
| baseline | 0.216 | 0.294 | 0.682 | 102 |
| floor >= 1/(k+1), k=60 | 0.303 | 0.197 | 0.636 | 66 |
| radii 0.78/2.5 + floor >= 1/(k+1) | 0.297 | 0.203 | 0.636 | 64 |
| floor >= 1/(k+2) | 0.250 | 0.237 | 0.636 | 80 |
| floor > 2/(k+1) (both-routes-only) | 0.714 | 0.143 | 0.227 | 7 |

Floor >= 1/(k+1) keeps every both-route hit and single-route rank-1
hits (inclusive boundary). rrfK 10/20/30/60 are indistinguishable on
this corpus (tiny candidate lists): keep k=60. Verdict per answer A4:
adopt the post-RRF floor (substantial: +40% precision, -33%
forbidden, -35% page volume; recall cost 1 labeled source - must be
watched in the live loop); skip the rrfK change; WeightedRanker is
not worth pursuing given the score-separability collapse (no weights
fix unseparable route scores); cross-encoder reranker (TASK-012)
remains the hypothesis for the residual ~0.20 forbidden rate.

Cross-encoder follow-up (closed, TASK-012, docs/research/
cross-encoder-findings.md + scripts/eval/cross-encoder-rerank.mjs,
commit 41dacb0): measured the hypothesis on the current production
page (this run's none-row 63 rows, P@k 0.286 forbRate 0.206 recall
0.636). Zero-shot bge-reranker-base sigmoid probs separate class
bodies (R median 0.603 vs F median 0.002) but the tail overlap
[0.0029, 0.0651] contains 6 relevant AND 6 forbidden rows: the
zero-relevant-loss cutoff is p >= 0.0028 (forbRate 0.206 -> 0.133; 6
forbidden survive), and forbRate 0.0 requires p >= 0.07 at recall
0.636 -> 0.409. Re-sort is a no-op (best-relevant index 1.286 both
ways). Verdict per A4: REJECTED; the residual forbidden class is
design-relevance-shaped and inseparable by a zero-shot cross-encoder;
cost is 283 MB + ~0.5 s CPU/query. The manifest-contamination fix
(TASK-015) attacks the same residual from the query side instead.

## Live test-loop log

### Iteration 1 (2026-11-13 00:41 restart; dense 0.78 / sparse 2.5 / fused floor 1/(k+1))

Planted notes: POS
machinae-game/machinae-game-bitecs-query-registration-for-sim-tests.md,
machinae-game/machinae-game-three-js-instanced-render-batching.md;
NEG unity-dots-entity-query-chunk-iteration.md,
react-three-fiber-gallery-viewer-memoization.md.
Budget enabler active (globalMemoryTokens=50000; the probe received
injections, so it worked). Probe subagent 0ccf7c59 (machinae-game
ECS/render task).

Observed (through injection 15): turn-start page = GLOBAL (pinned) +
dsh-session-transcript-probe + lib-is-tracked + typescript-verify-
before-done; read-intercept bleed x5 (guestwise seatmap x2, theme-
playwright, throwaway-tsconfig, pnpm-dir-hijack, ts-installed-types,
vitest-lazy-cjs); think-intercept bleed x3 (drupal entity-form,
declarative-TS, hf-cli) - think intercepts fired on STOPWORD-ONLY term
lists ("and, the, should, not, after").
POS recalled: 0/2. NEG recalled: 0/2 (excluded by the same mechanism
that excluded POS-2).

Root-cause replay (full production-shape simulation of the probe's
actual turn-start query, top-12 per route):
- Dense route: POS notes rank 1-2 at 0.8999/0.8932 (the 0.78 radius is
  irrelevant to them); guestwise/lywa/drupal noise ranks 4-12 at
  0.836-0.876 - all survivors; the radius cuts nothing here.
- Sparse route: 12/12 cross-project noise at relevance 41-75; the 2.5
  floor is one to two orders of magnitude below the noise floor on
  this vocabulary-heavy query.
- Fused page: dual-route AGREEMENT ranks cross-project noise
  (guestwise/featureflags at dense-5 + sparse-7 = 0.0303) ABOVE the
  relevant single-route POS note (dense rank 1 = 0.01639); the fused
  floor then DROPS the relevant POS-2 (dense rank 2 single-route,
  0.01613 < 1/61) together with the NEG notes. The floor's
  rank-1-or-both-routes rule assumes both-route implies relevant;
  manifest-vocabulary contamination (turn-start query = user text +
  workspace manifest tokens like .ts/.json/typescript/vitest) breaks
  that assumption.

Verdict versus convergence rules: planted NEG 0/2 (pass), planted POS
0/2 (FALSE-NEGATIVE FAILURE - must loosen or arbitrate differently),
cross-project bleed persists in all three channels. Iteration-2
candidates queued: (a) cross-encoder rerank (TASK-012 running) as the
relevance arbiter, applied BEFORE the fused floor decides so the floor
never pre-empts the reranker's view; (b) evaluate the manifest-text
half of the turn-start query (packages/events/src/turnStart.ts) as the
vocabulary-contamination source (harness queries never carried it, so
offline under-measured production noise); (c) think-intercept
stopword-only term lists look like a query-construction defect to
file separately.

### Iteration 2 (2026-11-13 01:44 restart; + fallback-leg floor 4abf302 + user-text-only turn-start queries 970e2f8)

Same values as iteration 1 plus the two pipeline-hygiene changes;
budget enabler 50000 active. Probe 826b1e03 (machinae-game fixed-step
loop + draw-batching task).

Observed 14 injections (4 turn-start, 3 think-intercept, 7
read-intercept):
- Turn-start page: GLOBAL + typescript-verify-before-done (acceptable)
  + subagent-zero-recall + session-transcript-probe (both META notes
  this experiment planted; the probe prompt's own protocol vocabulary
  ("recall/probe/injection") recalled them).
- Think-intercept: drupal kernel-test + declarative-TS + npm-cli notes
  (cross-domain); term lists echo note slugs of previously recalled
  notes: a self-amplification loop in the think channel.
- Read-intercept: 7 pages on machinae files, all generic-process or
  cross-project (guestwise x3, pnpm-dir, vitest, throwaway-tsconfig).
POS recalled: 0/2 again. NEG recalled: 0/2 (still clean).

Root-cause replay (user-text-only production-shape sim of the probe's
prompt): POS-2 three-js dense rank-1 fused 0.01639 PASSES the floor;
POS-1 bitecs dense rank-2 single-route fused 0.01613 = 1/62 DROPS
exactly one rank below the 1/(k+1) floor. On the live page POS-2 was
additionally squeezed out by turn-start token-budget fit behind two
long meta-notes (page had 4 slots). Read-intercept pages survive the
fallback floor because it only removes single-route rank-2-and-below:
every rank-1 survivor passes; ext-fallback "neighborhood" search over
generic .ts/.md vocabulary is inherently weak (design issue, not a
constant; recorded as a follow-up recommendation).

Offline re-comparison with the planted notes added to the machinae
labels (17 queries, radii 0.78/2.5, k=60; floor off P@k 0.225
forbRate 0.275 recall 0.708 returned 102):

| single-route rank allowed | P@k | forbRate | recall | returned |
| --- | --- | --- | --- | --- |
| rank-1 only (1/(k+1)) | 0.311 | 0.197 | 0.625 | 61 |
| rank<=2 (1/(k+2)) | 0.276 | 0.211 | 0.667 | 76 |
| rank<=3 (1/(k+3)) | 0.242 | 0.264 | 0.667 | 91 |
| rank<=4 | 0.224 | 0.265 | 0.667 | 98 |

Knee at 1/(k+2): the extra recall (planted POS-1 on
machinae-combat-systems, recall 0.5 -> 1.0) is gained there and one
step looser buys zero recall for +8 forbidden rows. Decision (TASK-007
iteration): FUSED_SCORE_FLOOR 1/(k+1) -> 1/(k+2) per the user rule
"adjust the values back if relevant memories stop showing up"; the
live loop showed exactly that failure mode. Remaining residual noise
(think-intercept stopword/self-echo vocabulary; read-intercept ext
fallback; turn-start token-budget fit displacing short relevant notes)
is query-construction and budget design, out of tuning scope: recorded
as follow-up recommendations for the user.
