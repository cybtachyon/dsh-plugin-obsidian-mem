# TASK-011 (metrics-gated): BM25 index params k1/b + re-index

Investigation + potentially destructive task. Run only per the A4 scope
answer, and only when keyword-ranking quality (not the radius floor) is
the residual problem.

Scope:
1. milvus-lite 3.2.2 support check first: BM25 function params
   (`bm25_k1`, `bm25_b`) at createCollection in this stack (SDK
   typing/docs; no scratch collection per A2).
2. If supported: add k1/b to `createCollectionParams` in
   `packages/service/src/milvus/schema.ts` (currently `params: {}`) as
   named constants; sweep sensible pairs (defaults k1=1.2, b=0.75;
   candidates e.g. k1 1.5/b 0.4, k1 0.9/b 0.75) measuring on the
   production collection via the harness only where measurement is
   read-only; a real k1/b change needs the rebuild below to take effect,
   so evaluate candidates by their BM25 score-distribution shift
   (recompute expected scores from raw sparse vectors returned read-
   only) before consenting to any rebuild.
3. Re-indexing the production collection means drop + recreate + full
   re-index from the vaults (rebuildCollection + indexer re-insert). That
   is destructive; ask the user before running it on the production store
   and verify the indexer fully repopulates (count matches, spot-checks
   searchable) before declaring success.

Definition of Done: candidate sweep evidence in the plan file; adopted/rejected
verdict; if adopted, schema change + lib + goldens committed, production
re-indexed with user consent, live recall test green after restart.

## CLOSED: REJECTED offline (2026-11-13, no re-index, no user consent needed)

The task's precondition never became true: keyword-ranking quality was
not the residual problem. The iteration-1 replay showed the sparse
route's failure is shared cross-project vocabulary (probe query sparse
top-12 was 12/12 cross-project notes at relevance 41-75; relevant
notes absent entirely), and the separability study showed sparse
relevance distributions overlap by class (medians 16.2 / 11.0 / 11.4).
k1/b control term-frequency saturation and length normalization; they
cannot distinguish "shares the words pnpm/vitest/config" from
genuinely relevant, so no plausible pair lifts the missing relevant
rows into the window without lifting the co-vocabulary noise too. The
cost is a destructive production re-index. Superseded for this class
by the query-hygiene fix (TASK-015 adopted: user-text-only turn-start
queries remove the manifest vocabulary that fed the shared-word
matching).
