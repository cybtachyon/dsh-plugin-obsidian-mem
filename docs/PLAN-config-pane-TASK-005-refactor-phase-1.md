# TASK-005 (Refactor): Phase 1 hardening

Refactor: Review the files touched by the previous 4 commits and identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

## Notes for this pass

- Prime suspects: the whitelist merge/validation/escalation chain spread over
  `config.ts` + `service.ts` (consider a small `SettingsStore`-style collaborator
  inside the service package if the class gained a data clump), the
  deep-merge/deep-diff pair (one walker, not two), and duplicated
  state-dir/anchor path derivations.
- Keep the public service surface unchanged; behavior is pinned by the Phase 1
  tests, so refactors must land with `pnpm test` green and a fresh `pnpm build`
  emit in the same commit.

## Definition of Done

- Each risk above explicitly judged (fixed, or one-line justification for
  leaving it) in the commit message body.
- `pnpm test`, `pnpm lint`, `pnpm build` green; tree clean.

## Dependencies

TASK-001 through TASK-004 commits.
