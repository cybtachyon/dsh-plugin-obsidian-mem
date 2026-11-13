# TASK-009 (metrics-gated): RRF k and post-RRF cutoff

Run only if the A4 scope answer includes it and/or Phase B left noise or
borderline misses.

Scope:
1. Sweep RRF_RANKER_K through the harness (60 → 30 → 20 → 10): a lower k
   steepens rank weighting so a candidate that is deep in both routes stops
   out-ranking one that is top-1 in a single route.
2. Post-RRF cutoff: RRF-fused score for rank r ≈ 1/(k + r) summed over
   routes. For a "cut everything below rank c" rule, test the floor
   slightly above 1/(k + c) (single-route case) as minScore in the
   harness; also test it inside production via the existing
   `minScore` plumbing (SearchRequest.minScore default or a config knob per
   A1) with the source relevance multiplier (if any is introduced by then)
   applied AFTER the cutoff, never before.
3. Note from the repo invariant (G7): cutoff applies to fused scores only.

Definition of Done: sweep table in the plan file; chosen k/cutoff (or
explicit "keep k=60, no cutoff" verdict) recorded; if changed, implemented
with constants + spec goldens + lib, gates green, committed.
