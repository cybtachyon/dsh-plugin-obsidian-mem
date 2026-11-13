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
