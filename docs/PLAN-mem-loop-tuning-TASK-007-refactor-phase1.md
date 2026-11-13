# Refactor review after Phase 1

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

Scope: the Phase 1 commits across `packages/events` (sessions.ts, host.ts,
writeLedger.ts, index.ts, thinkIntercept.ts, toolkit.ts per the Q2 answer)
and their specs. Commit each resolution separately from any feature work,
src+lib same commit, gates green.

Carry-over from TASK-001: `packages/events/tests/sessions.spec.ts`
pre-existing test "drops TTL-expired sessions and caps the file at the LRU
bound" never exercises LRU (the TTL prune removes the expired session
before the LRU check, leaving the store exactly at the cap). Tidy the
name/assertion mismatch or re-tune the fixture so LRU eviction actually
runs; TASK-001's new test already covers real LRU eviction.

Depends on: TASK-001..TASK-006.
