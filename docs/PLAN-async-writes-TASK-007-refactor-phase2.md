# TASK-007 — Refactor: Phase 2 smell pass

Refactor: Review the files touched by the previous 2 commits and identify the
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

- The success-string in `renderWrite` and the tool `WRITE_DESCRIPTION` and
  the README/AGENTS wording must not restate the same sentence three ways
  where one shared intent (doc pointer) suffices; keep each surface terse but
  not duplicated verbatim beyond necessity.
- The `'queued'` literal has one home: the `WriteValue` type + schema in
  write.ts; tests import the const if they pin it.
- Adjudicate every listed risk explicitly (resolve or waive with a one-line
  reason) in the Results section of `PLAN-async-writes.md`.

Definition of Done:

- `pnpm build` + `pnpm test` + `pnpm lint` green; tree clean; lib carriers
  ride src changes.
