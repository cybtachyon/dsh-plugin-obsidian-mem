# Refactor review after Phase 2

Review the files touched by the previous 3 commits and identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

Scope: the Phase 2 commits (`packages/service/src/search.ts`,
`packages/events/src/readIntercept.ts`) and their specs. Check specifically:
the `fallbackFilterExpr` clause-order single source, the wake-term shape
filter not restated per call site, no magic cap literals in the token
builders, and the eval harnesses still importing (not restating) any changed
constants. Commit resolutions separately, src+lib same commit, gates green.

Depends on: TASK-008, TASK-009, TASK-010.
