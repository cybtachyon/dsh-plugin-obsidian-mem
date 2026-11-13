# TASK-016 retire-test-debris

Clean the shared memory and repo of test debris:
- Archive EVERY note in the TASK-011 Seeding log via `memory_write` with
  `archive: true` (retire by archiving, never delete files). Confirm the
  archived rows leave recall: post-archive `memory_search` probes for the
  seeded wake words return nothing unarchived.
- `memory_audit` sweep: any stray test notes this session created outside
  the log (probe notes, iteration variants) get archived too; report the
  audit's note-row lines for anything ambiguous rather than archiving
  blindly.
- Repo debris: remove uncommitted smoke artifacts under
  `scripts/eval/results/` (gitignored, just clean them), keep committed
  docs/research eval artifacts (those are evidence). Delete stray
  `smoke-*` labels only if untracked.
- machinae-game testbed: the subagent's trial edits land in its working
  tree; `git -C ~/src/machinae-game status` and revert any changes the
  probe subagents left (ask before reverting anything that predates this
  plan).

Definition of Done: seeding-log rows all archived; audit shows no live
test rows; testbed clean; debris list recorded here.

Depends on: TASK-014.
