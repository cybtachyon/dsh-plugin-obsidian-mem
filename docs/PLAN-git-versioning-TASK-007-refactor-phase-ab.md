# TASK-007-refactor-phase-ab

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

Review scope: TASK-001..TASK-006 commits (core memory-git + churn, config
git group, VaultGitManager, write commit, dream commit/tunables).
The prepared prompt constants (`DEFAULT_DREAM_PROMPT`,
`MEMORY_PROMPT_SECTION_TEXT`, `AUDIT_CHECKPOINT_PROMPT_SECTION_TEXT`) are
OFF LIMITS to edits; the surrounding code in their host files stays
editable.

Definition of Done: each risk above answered in the task commit message
body (found+fixed, or absent); full service+core suites still green;
`pnpm build` leaves the tree clean; src+lib committed together.
