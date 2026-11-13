# TASK-009: Implement the default post-RRF fused floor

Sweep already done (see PLAN-milvus-tuning.md "Offline comparison"):
rrfK 10-60 indistinguishable (keep k=60); the win is a default floor on
the fused score at 1/(k+1) inclusive, which keeps every both-route hit
plus single-route rank-1 hits (offline: P@k 0.216→0.303, forbRate
0.294→0.197, page volume -35%, recall 0.682→0.636).

Scope (packages/service/src/search.ts + spec):
1. New named constant beside the radius constants:
   `FUSED_SCORE_FLOOR` = `1 / (RRF_RANKER_K + 1)`, comment naming the
   semantics (drops a hit that is rank >= 2 on every route; a
   both-route hit always clears it: its minimum 2/(k+12) with
   oversample 2 > the floor - VERIFY that inequality with oversample 2
   and topK 20 (worst case limit 40): 2/(60+40) = 0.02 > 0.01639, so
   every both-route hit within the fetched window clears; state it).
2. `hybridSearch`: apply the floor when `request.minScore` is
   undefined; an explicit `minScore` (including 0) fully overrides it
   (0 disables). Explicitly-passed values otherwise keep current
   behavior. `searchExactSections` untouched (exact-file recall is
   relevant by construction; fallback already ext/framework-filtered).
3. Spec goldens: default-floor filtering case (single-route rank-2 hit
   dropped, rank-1 kept, both-route deep hit kept), explicit
   minScore=0 disable case, explicit minScore override unchanged.
4. Gates per AGENTS.md; src+lib+spec in the SAME commit; tick the plan.

Definition of Done: gates green; committed together; the emitted lib
shows the floor constant; harness re-run
`--mode split-rrf --dense-radius 0.78 --dense-range 1.0 --sparse-radius
2.5` vs the same point + `--min-score 0.0163934426` recorded in the
plan (matches the simulated 0.297/0.203/0.636 within noise).
