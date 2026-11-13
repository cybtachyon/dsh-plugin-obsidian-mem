# TASK-010 (metrics-gated): WeightedRanker evaluation

Investigation task. Run only per the A4 scope answer.

Milvus normalizes COSINE/IP-style distances before WeightedRanker fusion,
so a weighted fusion puts both routes on a comparable scale and one
post-fusion relevance threshold can replace per-route tuning. Evaluate
whether swapping `RRFRanker` for `WeightedRanker` (weights swept in the
harness, e.g. dense 1.0/sparse {0.5,1.0} and reverse) plus a single
post-fusion cutoff beats the radius-tuned RRF result on the harness
metrics.

Scope:
1. Extend the harness reranker knob (TASK-002 already parameterizes it).
2. Check the lite 3.2.2 + SDK 3.0.6 support first (probe script from
   TASK-001); WeightedRanker params spelling in the SDK.
3. Compare precision@6 / noise / relevant-recall against the Phase B
   final numbers, then (only if clearly better and the user agrees) swap
   production with constants + goldens + lib, live-test after a restart.

Definition of Done: plan-file comparison table; explicit adopted/rejected
verdict with numbers; if adopted, gates green and committed.

## CLOSED: REJECTED offline (2026-11-13, no implementation, no restart)

Basis (PLAN-milvus-tuning.md separability study): WeightedRanker
reweights per-route scores on a shared scale, but the route scores do
not separate relevant from forbidden (dense medians 0.863 vs 0.836;
sparse relevance medians 16.2 vs 11.0, overlapping ranges). No weights
fix unseparable inputs. The discriminating signals are rank agreement
(handled by the fused floor, TASK-009) and semantics (TASK-012).
