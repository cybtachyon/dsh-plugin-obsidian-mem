# TASK-035 Tool: memory_dream (compaction)

Depends: TASK-034. Consult the engramory-ext Dreaming implementation
(`/home/derek/src/dsh-plugin-engramory-ext/packages/**/dream*`) — canonical process, but
NO system-prompt injection variant (per user: too verbose); the tool itself carries the
instructions.

## Scope

- Params: `{ operation?: 'plan'|'run' (default 'plan'), model? (per-run override) }`.
- Single-flight (ext §2.6): orchestrator state `idle|running` ARMED SYNCHRONOUSLY before
  the first await; returns `{id, done}` immediately; callers attach a swallowing logging
  catch to `done` (never drop it, never await it in the tool). One guard converges tool,
  card button, and scheduled triggers.
- `plan` (default; deterministic, no model call — shared engine with audit): global-scope
  notes over budget; stale (low read_count / last_read_at older than
  `<stateDir>/state.json` lastDreamAt); near-duplicate clusters (pairwise dense similarity
  > config threshold); oversized notes (> 12 KiB → timeline pattern: keep conclusion,
  move history to an archived history note). Output = numbered work plan with concrete
  actions (merge X into Y via memory_read→memory_write; archive Z with archive=true),
  file paths, budget math before/after.
- `run`: launch a dedicated dream agent via the reflection gateway `ctx.get('agents')`
  (session id `dream-<runId>`; absent service ⇒ clean `blocked` answer, ext-style); the
  prompt comes from an editable `<dbDir>/dream-prompt.md` SEEDED once from the shipped
  package `prompt.md` (placeholders rendered from config; user edits picked up next run);
  diary `DREAMS.md` at the first shared vault root (reserved, NON-INDEXED); post-run
  deterministic scoring: bump notes accessed since lastDreamAt to relevancy 1.0, degrade
  un-accessed by 0.1 (access stats live in note frontmatter per spec, unlike ext's
  sidecar), THEN set lastDreamAt (order load-bearing). Git-churn stressors are OUT
  (vaults are not necessarily git repos; documented deviation from ext).
- Tool DESCRIPTION (model-facing) must include: use at end of significant work or when
  memory_audit reports over budget; and the note: "Automated dreaming can be scheduled —
  ask the user whether they want a DSH schedule/timer trigger for memory_dream (managed in
  the Obsidian Mem settings card)."
- dreaming.schedules config surfaces in status() for the card (TASK-051 Dreaming section).

## DoD

Candidate-ranking tests with faked vectors/stats, plan output golden test, description text
contains the scheduling note; commit.
