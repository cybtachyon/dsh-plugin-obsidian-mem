# TASK-009-docs-verify

Repo: /home/derek/src/dsh-plugin-obsidian-mem

## Goal

Documentation sweep plus the final verification gate.

1. Grep README.md and `packages/*/package.json` descriptions for sentences
   stating the budget reminder/compaction pointer is injected at turn-start
   (e.g. the events `package.json` description, README lifecycle prose).
   Align only the sentences this change falsifies: the reminder now rides
   the turn-end steer, alongside the save/audit reminder, root agents only.
2. Q-WORDING-SCOPE is executed by TASK-006/TASK-007 (align all budget
   sentences); here only sweep for leftovers: any remaining doc or
   description sentence that still claims the over-budget remedy is
   memory_dream ALONE, or that the reminder fires at turn-start.
3. Final gates, each quoted in the completion report against the baseline
   recorded at plan start: `pnpm build`, `pnpm lint`, `pnpm test`,
   `prek run --files <every path this plan touched>`.

## Definition of Done

- All four gates green, outputs quoted; only falsified sentences changed.

## Dependencies

- Depends on: TASK-008.
- Blocks: nothing (final task).
