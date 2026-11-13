# TASK-013: Cleanup and final verification

Scope:
1. Archive every `TUNING-TEST-POS`/`TUNING-TEST-NEG` test memory via
   `memory_write` archive=true (never delete files). Verify they stop
   appearing in recall.
2. Confirm no scratch milvus-lite instances or data dirs remain; harness
   and probe scripts stay committed only if the plan kept them (they are
   legitimately useful); otherwise they were never committed.
3. Final gates: `pnpm build`, `pnpm test`, `pnpm test:coverage` (thresholds
   in vitest.config.ts), `pnpm lint`, `prek run --files <touched paths>`.
4. Final live sanity pass: one post-restart testbed subagent run with zero
   planted notes, confirming the recall stream is quiet for unrelated
   queries and sharp for in-domain ones.
5. Record the final tuning values + before/after aggregate metrics in
   `docs/research/radius-tuning-findings.md`.

Definition of Done: gates green, tree clean, plan-file summary complete.
(Plan-file deletion itself happens in the harness Finalize step, not here.)
