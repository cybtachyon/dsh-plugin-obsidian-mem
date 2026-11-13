# TASK-005: Refactor: risk review over the plan's commits

Review the files touched by the previous 4 commits and identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

## Notes for this plan's territory

- The precedence rule (override > config > host) must stay in exactly one
  resolver (TASK-001); the blocked message and the resolver must read the
  same resolved pair.
- The `turn/end` reason shape is parsed in one place.
- `packages/tools/src/dream.ts` and the `ui` route layer: check whether the
  grown `blockedReason` needs any wording change in their surfaces
  (tool `dream_blocked` message, 503 `dream_unavailable`) — they forward the
  reason string, so no duplication should appear.
- Keep the test doubles for `create()` a single shared builder if the file
  grows more launch assertions.

## Definition of Done

- Each listed risk either resolved with a commit (message starts
  `refactor(dream):`) or explicitly waved in a comment in this file with a
  one-line reason.
