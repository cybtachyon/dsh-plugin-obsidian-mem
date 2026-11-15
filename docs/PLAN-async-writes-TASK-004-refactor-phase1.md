# TASK-004 — Refactor: Phase 1 smell pass

Refactor: Review the files touched by the previous 3 commits and identify the
following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple
   methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a
   different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

Scope notes for this pass:

- The follow-up tracking trio (`trackFollowUp` / pending set /
  `flushWriteFollowUps`) must stay one home; the index/git chains must not
  grow per-caller copies.
- `TEARDOWN_FLUSH_TIMEOUT_MS` lives once in service and is imported (never
  restated) wherever the margin is asserted in tests.
- The core/stack split must not duplicate the single-flight guard logic:
  one guard mechanism, two passes.
- Adjudicate every listed risk explicitly (resolve or waive with a one-line
  reason) in the Results section of `PLAN-async-writes.md`.

Definition of Done:

- `pnpm build` + `pnpm test` + `pnpm lint` green; tree clean; lib carriers
  and tests follow every src change in the same commit.
