# TASK-009 (Refactor): Phase 2-3 hardening

Refactor: Review the files touched by the previous 3 commits and identify the following code risks:
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

- TASK-008 carry-ins: lift the shared `TOAST_HOLD_MS` currently imported by
  `configuration.tsx` from `sections/dreaming.js` into a shared home
  (styles.ts or a small toast module); consider the `.gitignore` hygiene
  line for one-off typecheck artifacts (e.g.
  `packages/*/lib/tsconfig.*.tsbuildinfo`) since TASK-012's throwaway
  recipes can drop them there.

- Prime suspects in `configuration.tsx`: five near-identical field blocks
  (lift a declarative field-descriptor table: key, control kind, options,
  warning copy, restart/custom badge wiring; one renderer loop), the
  dirty/unset diff (one helper), and label/badge copy duplicated inline.
- Route side: the settings handlers share the body-parse/validation envelope
  mapping; keep the shared helpers (`requiredString`, `readBody`) as the only
  copy.
- Behavior is pinned by the tests added in TASK-006 through TASK-008; all
  gates must stay green; `pnpm build` emit (incl. `dsh/client.js`) in the
  same commit.

## Definition of Done

- Each risk judged (fixed or one-line justification in the commit body);
  `pnpm test`, `pnpm lint`, `pnpm build` green; tree clean.

## Dependencies

TASK-006 through TASK-008 commits.
