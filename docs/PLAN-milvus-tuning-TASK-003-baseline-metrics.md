# TASK-003: Baseline metrics snapshot

Run the TASK-002 harness with today's production parameters: no dense
radius, no sparse radius, RRFRanker(60), ef 64, topK 6, no minScore.

Scope:
1. Execute the harness at production values; save the full JSON result
   artifact under the plan artifacts location agreed with the harness
   README (suggested `docs/research/baseline-YYYYMMDD.json`).
2. Summarize in the plan file's Live test-loop log section: aggregate
   precision@6, total noise rows, per-query table (query, top-6 sources,
   relevant/irrelevant/missed counts).
3. Call out the worst noise offenders (which vault/scope sources pollute
   which queries) as the targets tuning must eliminate.

Definition of Done: baseline JSON committed; the summary table pasted into
`PLAN-milvus-tuning.md` under a `## Baseline metrics` heading. No src change.
