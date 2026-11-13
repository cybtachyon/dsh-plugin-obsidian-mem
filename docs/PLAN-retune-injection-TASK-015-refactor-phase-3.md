# TASK-015 refactor-phase-3

Review the files touched by the previous 4 commits and identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

Phase-2/3 watch items: any Phase-2 injection implementation (if GO) must
reuse the existing injectNotice/token-accounting seams, not hand-roll a new
inject path; tuning constants keep exactly one authoritative note each.

Definition of Done: risks resolved or waived with reasons here; gates
green.

Depends on: TASK-014.
