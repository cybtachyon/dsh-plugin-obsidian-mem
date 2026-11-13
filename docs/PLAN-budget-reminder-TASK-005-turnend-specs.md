# TASK-005-turnend-specs

Repo: /home/derek/src/dsh-plugin-obsidian-mem

## Goal

Update `packages/events/tests/turnEnd.spec.ts` for the TASK-003 shape. The
unit harness already builds a `SessionRegistry` and `fakeMemory`; drive the
budget over the cap via `registry.addRecallTokens('session-1', ...)` with
`budgets.globalMemoryTokens` lowered through the existing testkit `budgets`
option.

New/changed coverage:

- Over budget + work turn: exactly one steer whose body carries the
  save/audit checklist AND the new budget reminder text (assert on stable
  fragments of the TASK-001 text: the spent numbers, the approval gate, the
  `memory_dream` suggestion).
- Not over budget: the existing byte-exact checklist snapshot still passes
  (no budget text).
- Subagent over budget: no steer at all (existing skip still swallows the
  budget section).
- Per Q-PIGGYBACK answer: memory-tool-used and trivial-turn skips behave as
  recorded; add the assertions for whichever side the answer picks.
- Once-per-turn guard still holds while over budget.

Also run the events package tests and fix any remaining assertion elsewhere
in packages/events/tests that expected the old turn-start reminder sentence.

## Definition of Done

- `pnpm test` green for the events package; no new failures versus the
  baseline elsewhere (quote outputs).

## Dependencies

- Depends on: TASK-001, TASK-003.
- Blocks: TASK-006.
