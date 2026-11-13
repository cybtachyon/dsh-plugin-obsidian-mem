# TASK-001-reminder-text

Repo: /home/derek/src/dsh-plugin-obsidian-mem

## Goal

Rewrite `compactionInstruction()` in `packages/events/src/budget.ts` so the
global memory budget reminder becomes a two-part message:

1. Agent instruction: manually compact **just the global memory** (the
   global-scope notes) using the ordinary memory tools: `memory_search` to
   survey, `memory_read` to review, `memory_write` to merge/correct and to
   retire (`archive: true`), least-read first. The instruction must state
   the agent MUST NOT start this work until the user approves it.
2. User suggestion: tell the agent to suggest to the user that running the
   much-heavier `memory_dream` tool is available for a more complete
   optimization of the whole memory store.

Keep the existing over-budget framing: the `Obsidian Mem: the global memory
recall budget is spent (<used> of <budget> tokens injected since the last
successful dream or host restart)` sentence (the window wording is
load-bearing, pinned by other tests), and the
`No fresh recall sections are inject…` sentence ONLY IF Q-SUPPRESSION in
PLAN-budget-reminder.md keeps the turn-start suppression gate (read its
recorded answer first; if the gate is dropped, delete that sentence).

Constraints:

- The function stays pure: `(usedTokens: number, budgetTokens: number) => string`.
- Update the module docblock of budget.ts and the function's docblock to
  describe the new turn-end delivery and the approval-gated manual path.
- Keep the exported name `compactionInstruction` (also exported from
  `packages/events/src/index.ts`); do not rename.
- Do not touch any other file.

## Definition of Done

- `pnpm build` green; `pnpm lint` green.
- The new text names: manual global-memory-only compaction, the approval
  requirement (must not start until user approves), and the `memory_dream`
  suggestion to the user.

## Dependencies

- Depends on: Q-SUPPRESSION answer recorded in PLAN-budget-reminder.md.
- Blocks: TASK-003, TASK-004, TASK-005.
