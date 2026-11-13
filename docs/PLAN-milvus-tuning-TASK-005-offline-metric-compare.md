# TASK-005: Offline before/after metric comparison

Prove the TASK-004 radii moved the numbers before burning a restart cycle.

Scope:
1. Re-run the TASK-002 harness with dense radius 0.78 + sparse radius 2.5
   (all other knobs at production values).
2. Diff against the TASK-003 baseline JSON: per-query and aggregate
   precision@6, noise rows eliminated, relevant sources newly missed.
3. If a labeled relevant source disappeared, raise the sensitivity
   question early: record which route killed it and the smallest radius
   that restores it (sweep the offending route's radius a few points,
   e.g. dense 0.60/0.68/0.73, sparse 1.5/2.0).
4. Append the comparison table to `PLAN-milvus-tuning.md` under
   `## Offline comparison: radii 0.78 / 2.5`.

Definition of Done: comparison table committed; a clear verdict line:
keep 0.78/2.5, or adjust to X/Y with the measured reason. No src change in
this task (any value change belongs to TASK-007 after the live test).
- [x] Complete (2026-11-13). Radii 0.78/2.5 have no offline impact (plateau; keep as zero-cost guards); post-RRF floor >= 1/(k+1) is the substantial win; full table in PLAN-milvus-tuning.md "Offline comparison".
