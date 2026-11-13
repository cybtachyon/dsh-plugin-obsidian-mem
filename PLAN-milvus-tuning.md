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
- [ ] [TASK-010-weighted-ranker-eval](docs/PLAN-milvus-tuning-TASK-010-weighted-ranker-eval.md)
- [ ] [TASK-011-bm25-index-params](docs/PLAN-milvus-tuning-TASK-011-bm25-index-params.md)
- [ ] [TASK-012-cross-encoder-reranker](docs/PLAN-milvus-tuning-TASK-012-cross-encoder-reranker.md)

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
