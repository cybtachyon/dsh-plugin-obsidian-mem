# TASK-013-refactor-phase-cde

Review the files touched by the previous 5 commits and identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

Review scope: TASK-008..TASK-012 commits (audit service + tool surfaces,
events removal, client toggle, docs). The prepared prompt constants are
OFF LIMITS to edits.

Carried items to adjudicate in this task:
- Test-tier type drift: packages/service/tests/service.spec.ts:1683
  `commitMessages` errors TS2322 ((string|undefined)[] vs string[] under
  noUncheckedIndexedAccess) under the testscheck tsconfig recipe
  (introduced by 71f28a3); fix the annotation (one-line) or document why
  the throwaway recipe should ignore it.
- VaultGitManager logShared/statusShared swallow the git command error
  (answer null), so audit's git-error detail is generic wording; decide
  whether widening the accessor to carry the error string into
  AuditGitFacts is worth the churn (TASK-008 note) and record the call.

Definition of Done: each risk answered in the task commit message body
(found+fixed, or absent); full suite green; `pnpm build` leaves the tree
clean; src+lib committed together.
