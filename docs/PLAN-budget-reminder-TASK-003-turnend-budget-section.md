# TASK-003-turnend-budget-section

Repo: /home/derek/src/dsh-plugin-obsidian-mem

## Goal

In `packages/events/src/turnEnd.ts`, deliver the global memory budget
reminder alongside the turn-end save/audit checklist, inside the SAME
`agent.steer` notice the `installTurnEnd` listener already sends.

Shape:

- At steer time, evaluate
  `isGlobalBudgetSpent(deps.registry, deps.memory.config.budgets.globalMemoryTokens)`
  (import from `./budget.js`).
- When over budget, the notice body carries two blocks: the existing
  `turnEndReminder(...)` checklist text and, after it,
  `compactionInstruction(usedTokens, budgetTokens)` (from `./budget.js`),
  where `usedTokens = deps.registry.totalRecallTokensUsed()`. When not over
  budget, the body stays exactly what it is today (the checklist alone;
  byte-exact snapshot in tests).
- Read Q-PIGGYBACK in PLAN-budget-reminder.md for the recorded gating
  answer. Default (if piggyback): the budget section rides the existing
  `deliverReminder` skips unchanged (subagent skip, memory-tool-used skip,
  trivial-turn skip). No new gate, no separate steer, no extra
  once-per-turn state; the existing `firedTurn` guard already limits this to
  one steer per turn.
- Root-agent-only comes from the existing `registry.isSubagent` skip; do not
  weaken it.

Update the module docblock to mention the budget section riding the same
steer.

Constraints:

- Do not edit tests (TASK-005 owns them).
- Keep `TURN_END_REMINDER` and `turnEndReminder()` untouched so the
  not-over-budget snapshot stays byte-exact.

## Definition of Done

- `pnpm build` green; `pnpm lint` green.
- One steer per turn semantics unchanged.

## Dependencies

- Depends on: TASK-001 (final reminder text), Q-PIGGYBACK answer.
- Blocks: TASK-005.
