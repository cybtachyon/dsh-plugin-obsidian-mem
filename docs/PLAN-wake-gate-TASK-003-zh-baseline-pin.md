# TASK-003: zh-baseline-pin

Phase A (spec Step 1.3). Read-only.

1. Run `node docs/research/probes/zh-analyzer-probe.mjs` unchanged.
2. Record the SUMMARY line (per-probe `hitChunkIds`, the two Han-bearing
   chunks, rowCount) into the spec doc's "Pre-flight measurements
   (2026-11-13)" section as the zh control pin that TASK-010/011
   compare against ("zh probe hits unchanged" PASS criterion).

The `--wake-gate` flag for this probe ships in TASK-007 (it needs the
lib helpers that exist only after TASK-005); do NOT touch the probe
here. Commit spec doc only (probe unchanged).

Definition of Done: pinned SUMMARY recorded verbatim in the spec doc;
commit exists.
