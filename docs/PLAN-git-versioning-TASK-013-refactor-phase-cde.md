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

Definition of Done: each risk answered in the task commit message body
(found+fixed, or absent); full suite green; `pnpm build` leaves the tree
clean; src+lib committed together.
