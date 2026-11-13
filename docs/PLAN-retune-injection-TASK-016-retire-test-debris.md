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

## Cleanup record (2026-11-13)

Archived (frontmatter `archive: true`, all four seeding-log rows;
write-through reindex confirmed; post-archive `memory_search` probes on
"machinae ECS fixed-step system" and "bitECS query order swap-remove"
return zero seeded rows):
- machinae-game/machinae-ecs-adding-a-new-fixed-step-system-file.md
  (archived body carries the retirement note; durable SNAPSHOT_SPECS
  fact promoted first to NEW live note
  machinae-game/machinae-game-snapshot-specs-blocks-new-components-until-specced.md)
- machinae-game/bitecs-0-4-query-order-swap-remove-ids-and-any-typed-components.md
  (facts duplicate machinae-game repo docs commit b5c20d5)
- dsh-client-card-guarded-primitives-require-and-fallback-rendering.md
  (duplicates AGENTS.md DSH UI Component Library)
- turn-start-recall-once-per-session-claim-before-async-work.md
  (ordering lives in turnStart.ts + AGENTS.md Event Facts)

Not archived (pre-existing, ambiguous, reported only): the two older
plants (machinae-game-bitecs-query-registration-for-sim-tests,
machinae-game-three-js-instanced-render-batching) are already archived
+ unindexed since the 2026-11-13 TASK-006 re-label. `archive/`-folder
files like phpstan-double-include-guestwi.md carry `archive: false`
(hygiene item, not this plan's debris; left for a future dream).

Repo/testbed debris: deleted gitignored smoke
`scripts/eval/results/legacy-hybrid.json` (the dir's only content);
machinae-game reset to f118494, probe-3's two untracked files
(src/ecs/systems/beaconPulseSystem.ts, test/beaconPulseSystem.test.ts)
removed; `git status --porcelain` now empty at f118494. Iteration-1's
committed variant `58c50e4` remains reflog-reachable only, per the
user's reset disposition.

Definition of Done: seeding-log rows all archived; audit shows no live
test rows; testbed clean; debris list recorded here.
SATISFIED 2026-11-13 as above.

Depends on: TASK-014.
