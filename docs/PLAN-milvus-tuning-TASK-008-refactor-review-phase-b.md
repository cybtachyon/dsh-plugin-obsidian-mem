# Refactor: review Phase B search-tuning commits

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

Context: the Phase B commits touched `packages/service/src/search.ts`
(route params + constants), its spec, the eval harness, and probe scripts.
Watch for the tuning constants drifting from the harness's defaults (one
source of truth for production values; the harness takes them as flags)
and for harness/probe duplication of the dispatch assembly. Gates per
AGENTS.md; behavior-preserving only (no metric changes without a plan-file
row).

Definition of Done: each listed risk answered (fixed or explicitly waived
with a one-line reason in the commit message); gates green; committed.
