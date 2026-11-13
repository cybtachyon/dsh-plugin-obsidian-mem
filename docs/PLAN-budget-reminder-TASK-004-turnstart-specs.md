# TASK-004-turnstart-specs

Repo: /home/derek/src/dsh-plugin-obsidian-mem

## Goal

Update `packages/events/tests/turnStart.spec.ts` (the "global memory budget
switch" describe, around line 371, plus any other case asserting the removed
turn-start compaction pointer) to the new TASK-002 shape:

- Over budget: no compaction-pointer notice is injected at turn-start; no
  recall, no pinned global file, no guidance (per Q-SUPPRESSION in
  PLAN-budget-reminder.md, if suppression is kept). Assert the absence of
  any notice containing "budget" wording instead of the old `toContain`
  snapshot.
- The flip test at exactly the cap still gets fresh recall.
- The "over-budget pointer returns before the global files are even fetched"
  test becomes "over-budget session fetches no recall and injects nothing"
  (suppression kept) or is replaced by "over budget still searches"
  (suppression dropped). Follow the recorded answer.
- Provision-notice delivery while over budget (if the kept-gate path still
  delivers it) stays covered.

Also run `pnpm test packages/events` (or the vitest filter) and fix any
OTHER events test that asserts the removed sentence
("Run the `memory_dream` tool to compact the global memory notes" as a
turn-start notice). Do not change service/tools/client tests.

## Definition of Done

- `pnpm test` green for the events package; full `pnpm test` has no new
  failures versus the recorded baseline (quote both).

## Dependencies

- Depends on: TASK-001, TASK-002.
- Blocks: TASK-006.
