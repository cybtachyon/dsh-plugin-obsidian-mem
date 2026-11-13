# TASK-014: Apply the fused floor to the Read-intercept fallback

- [x] Complete. The `searchExactSections` fallback leg now applies the
  same `request.minScore ?? FUSED_SCORE_FLOOR` rule (inclusive) as
  `hybridSearch`; `ExactSectionRequest` gained `minScore` for it, and
  the exact-file leg stays floor-free (a file the agent is reading is
  relevant by construction). Commit 4abf302 with three spec goldens:
  fallback default floor (single-route rank-2-only row dropped),
  explicit 0 disable, floor-free exact-file leg.

Iteration-1 evidence: read-intercept bleeds (guestwise seatmap x2,
theme-playwright, seatmap-scale-plan onto machinae-game ECS reads) go
through `searchExactSections`'s fallback (the file itself is not
indexed), which dispatches the tuned two-search shape but applies NO
fused floor (TASK-009 scoped the default floor to `hybridSearch`
only).

Scope (packages/service/src/search.ts + spec):
1. Apply the same `scoreFloor = request.minScore ?? FUSED_SCORE_FLOOR`
   rule in `searchExactSections`'s fallback leg (the leg that
   dispatches routes), keeping the exact-file leg floor-free (a file
   the agent is reading is relevant by construction).
2. Spec: golden that a fallback page drops a single-route rank-2-only
   row and keeps rank-1/both-route rows; exact-file leg unchanged.
3. Gates per AGENTS.md; src+lib+spec same commit; tick plan.

Definition of Done: gates green; committed; live iteration 2 verifies
machinae-game reads stop bleeding guestwise notes (or the reranker
supersedes this gate).
