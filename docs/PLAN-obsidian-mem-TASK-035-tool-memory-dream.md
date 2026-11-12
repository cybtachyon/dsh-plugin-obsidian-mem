# TASK-035 Tool: memory_dream (compaction)

Depends: TASK-034. Consult the engramory-ext Dreaming implementation
(`/home/derek/src/dsh-plugin-engramory-ext/packages/**/dream*`) — canonical process, but
NO system-prompt injection variant (per user: too verbose); the tool itself carries the
instructions.

## Scope

- Params: `{ dryRun?: bool (default false = analysis-only plan + instructions, files are
  only touched by memory_write by the agent) }`.
- Candidate analysis (shared engine with audit): global-scope notes over budget; stale
  (low read_count / old last_read_at); near-duplicate clusters (pairwise dense similarity of
  note-level embeddings > threshold, config); oversized notes; archived-but-active.
- Output: a numbered work plan for the agent: for each cluster/stale item the concrete
  actions (merge X into Y with memory_read→memory_write; archive Z via memory_write
  archive=true; compact oversized), file paths, and the budget math before/after.
- Tool DESCRIPTION (model-facing) must include: use at end of significant work or when
  memory_audit reports over budget; and the note: "Automated dreaming can be scheduled —
  ask the user whether they want a DSH schedule/timer trigger for memory_dream (managed in
  the Obsidian Mem settings card)."
- dreaming.schedules config surfaces in status() for the card (TASK-051 Dreaming section).

## DoD

Candidate-ranking tests with faked vectors/stats, plan output golden test, description text
contains the scheduling note; commit.
