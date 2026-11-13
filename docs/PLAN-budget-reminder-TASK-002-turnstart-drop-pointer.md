# TASK-002-turnstart-drop-pointer

Repo: /home/derek/src/dsh-plugin-obsidian-mem

## Goal

In `packages/events/src/turnStart.ts`, remove the turn-start injection of
the global budget reminder (the `injectNotice` call labeled
`obsidian-mem: global memory budget spent, run memory_dream` inside the
`isGlobalBudgetSpent` branch of `runTurnStartRecall`). The reminder now
rides the turn-end steer (TASK-003), so nothing budget-related may be
injected at turn-start anymore.

Read Q-SUPPRESSION in PLAN-budget-reminder.md and apply the recorded answer:

- If suppression KEPT (recommended): the over-budget branch still returns
  early (no pinned global injection, no search recall), still delivers the
  provision notice first, and still calls
  `registry.addRecallTokens(sessionId, injectedTokens)` before returning.
  Only the `compactionInstruction`/`injectNotice` pair and the now-unused
  `compactionInstruction` import go away.
- If suppression DROPPED: delete the branch entirely; recall flows normally
  regardless of budget.

Update the module header docblock (it documents "TASK-045's budget switch
… injects the compaction pointer") to describe the new shape.

Constraints:

- Do not change any other flow in the file.
- Do not edit tests (TASK-004 owns them).

## Definition of Done

- `pnpm build` green; no unused import; `pnpm lint` green.
- `grep -n compactionInstruction packages/events/src/turnStart.ts` empty.

## Dependencies

- Depends on: Q-SUPPRESSION answer; TASK-001 not required (removes usage only).
- Blocks: TASK-004.
