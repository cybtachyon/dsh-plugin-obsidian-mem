# TASK-007: refactor-smell-pass

Phase 3: Refactor and whole-repo verification.

Review the files touched by the previous 6 commits and identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

Carry the adjudications (or a finding per risk) into
`PLAN-dream-isolation.md` under this task's section before committing.

## Definition of Done

- `pnpm build` + `pnpm test` + `pnpm lint` green after the pass.
- Adjudication section written; each risk is resolved or explicitly waived
  with a reason.
