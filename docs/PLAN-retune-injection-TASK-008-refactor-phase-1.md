# TASK-008 refactor-phase-1

Review the files touched by the previous 7 commits and identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

Phase-1 watch items (starting points, not exhaustive): the strip rule must
have ONE home (helper in search.ts; harness imports, never restates); the
stop-word list constant lives in exactly one place; eval README/flag naming
matches the harness code; the CJK maximal-run rule's single home is the
sparseQueryText docblock (TASK-018), do not relocate; the TASK-005 zh
probe exists only as prose in the findings doc with its raw dump in /tmp
(not committed), so lift it into a re-runnable read-only script under
docs/research/probes/ and reference it from the findings doc.

Definition of Done: risks resolved or each explicitly waived with a
one-line reason recorded here; gates still green.

Depends on: TASK-007.
