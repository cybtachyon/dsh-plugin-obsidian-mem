# TASK-011 seed-test-memories

SEQUENCING GUARD (added 2026-11-13): do NOT seed before TASK-005 and
TASK-006 finish. The offline eval harnesses replay a LABELED query set
against the same live collection these notes would index into; seeded
rows are unlabeled and would contaminate P@k/forbidden-rate baselines.

Use `memory_write` (never direct file writes) to seed the default vault
`/home/derek/.dsh/obsidian-mem/` with the iteration's probe set. Record
EVERY seeded note path in the Seeding log table below; TASK-016 archives
exactly those.

Seed design per machinae-game task flavor:
- RELEVANT set (2..4 notes): machinae-game / TypeScript-simulation work
  that the subagent's task genuinely needs (e.g. entity/sim-loop, ECS, or
  tsconfig conventions for that repo). Hooks name the activity with the
  words the reader is thinking while working (per the memory-hooks
  naming note in the vault).
- DECOY set (2..4 notes): share overlapping verbiage (TypeScript, game,
  loop, entity, state) but belong to other projects (guestwise, lywa,
  drupal-ish) or describe unrelated activity; they must NOT be recalled
  for this task.
- Wake-word hygiene: give decoys and relevant notes plausible
  frontmatter; do not label anything "decoy" in the content in a way the
  agent could read as an instruction.

Seeding log (append per iteration):

| iteration | path | kind |
| --- | --- | --- |

Definition of Done: table complete; notes visible via a direct
`memory_search` probe before the live run (indexer caught up).

Depends on: none (re-runnable per iteration).
