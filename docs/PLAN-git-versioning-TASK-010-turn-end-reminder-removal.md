# TASK-010-turn-end-reminder-removal

Remove the turn-end reminder while keeping the memory watch
(`packages/events/src/turnEnd.ts`, `packages/events/src/index.ts`).

Rationale recorded in the prepared system prompt: the completion
checkpoint now rides the `memory_audit` "checkpoint" view at the agent's
own turn end; the steered checklist is token bloat.

Q1 answer (resolved): **Remove the whole steer.**
- Delete `TURN_END_REMINDER`, `turnEndReminder`, and the
  `agent/turn-stopping` registration (`installTurnEnd`) including the
  over-budget `compactionInstruction` piggyback (the audit tool, the card,
  and the dream surfaces all still speak the over-budget remedy; the
  budget accounting itself is untouched).
- KEEP `installMemoryToolWatch` and the `SessionRegistry` memory-use
  bookkeeping (`noteMemoryToolUse`, `memoryToolUsed`, per-turn reset) and
  the subagent/trivial-turn registry tracking: that is the memory watch,
  it feeds recall observation, and it stays observable.
- `packages/events/src/index.ts`: drop the removed exports
  (`installTurnEnd`, `TURN_END_REMINDER`, `turnEndReminder`) unless the
  budget-only variant keeps `installTurnEnd`; keep
  `compactionInstruction` exported if any surface still composes it
  (check `budget.ts` consumers; the turn-start gate path stays).
- Update the module docs and the `agent/turn-stopping` host.ts slice only
  if unused afterwards.

Tests: `turnEnd.spec.ts` shrinks to the watch tests (+ budget-steer tests
only under the budget-only variant); `events.spec.ts` registration matrix
updated; the ledger/registry behavior specs stay green unchanged.

Definition of Done: build + events suite green; no dangling references
(`pnpm lint` clean); src+lib committed together.
