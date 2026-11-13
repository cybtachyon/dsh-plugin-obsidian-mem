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

- [ ] [TASK-001-radius-semantics-probe](docs/PLAN-milvus-tuning-TASK-001-radius-semantics-probe.md)
- [ ] [TASK-002-eval-harness](docs/PLAN-milvus-tuning-TASK-002-eval-harness.md)
- [ ] [TASK-003-baseline-metrics](docs/PLAN-milvus-tuning-TASK-003-baseline-metrics.md)

### Phase B: Required tuning

- [ ] [TASK-004-implement-radii](docs/PLAN-milvus-tuning-TASK-004-implement-radii.md)
- [ ] [TASK-005-offline-metric-compare](docs/PLAN-milvus-tuning-TASK-005-offline-metric-compare.md)
- [ ] [TASK-006-live-restart-recall-test](docs/PLAN-milvus-tuning-TASK-006-live-restart-recall-test.md)
- [ ] [TASK-007-iterate-tuning](docs/PLAN-milvus-tuning-TASK-007-iterate-tuning.md)
- [ ] [Refactor-review-phase-b](docs/PLAN-milvus-tuning-TASK-008-refactor-review-phase-b.md)

### Phase C: Optional tuning (metrics-gated; run only on the questionnaire's decided scope)

- [ ] [TASK-009-rrf-k-and-cutoff](docs/PLAN-milvus-tuning-TASK-009-rrf-k-and-cutoff.md)
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
  for dispatchHybrid's route params).
- A2: NO scratch instances/collections. Probe range semantics with
  read-only searches directly against the live production collection.
- A3: Yes. Tagged test memories allowed in the shared default vault;
  archive after each test iteration.
- A4: Stop when required tuning hits target; treat every optional tuning
  as a hypothesis to evaluate, and proceed with any that the harness
  metrics show make a substantial positive impact.
- A5: No preference; any reasonable small change or investigation on
  machinae-game works.

## Live test-loop log

Populated by TASK-006/TASK-007 iterations: restart, test-note ids, per-
subagent recalled-source list, verdict per value set.
