# TASK-012: fix test-tier type errors

Pre-existing debt found during TASK-001 (the tests tier is never
type-checked: no tsc project includes `packages/*/tests`, and eslint is not
type-aware). A one-off strict tsc run over the service tests surfaced
long-standing errors that would fail any future typecheck gate. Fix them so
the settings work (TASK-002 through TASK-004 add tests to exactly these
files) lands on a type-clean base.

## Known findings to fix (line numbers as of commit 59360f9)

- `packages/service/tests/audit.spec.ts`: `ObsidianMemConfigValidation`
  union `.value` accesses (~144/147); `statusFixture`/dreaming literals
  missing `degraded`/`readinessTimeoutMs`/`model`/`nearDuplicateThreshold`
  (~153/163/368/379/567); `GlobalMemoryIndex` `overBudget` optionality
  mismatch (~250).
- `packages/service/tests/config.spec.ts`: validation-union casts (~81/244).
- `packages/service/tests/service.spec.ts`: `StubLauncher`/`StubIndexer`
  `vi.fn()` extends-mismatches (~156/241); `exactOptionalPropertyTypes`
  `existingDim` violation (~302).
- Re-run the one-off strict check over ALL `packages/*/tests` and fix any
  further hits the same way (narrow the union properly, complete fixture
  literals, cast at the fake seam, never `as any`).

## Explicitly OUT of scope

- Do NOT add a new tsc project, package script, or CI gate for the tests
  tier; note it in the commit message as a candidate follow-up so the user
  can decide.

## Definition of Done

- A strict `tsc --noEmit` (same compilerOptions as the owning package's
  tsconfig) over every `packages/*/tests/**/*.ts` file exits clean.
- `pnpm test`, `pnpm lint`, `pnpm build` green; tests still pass unchanged
  in behavior (types only); tree clean after build.

## Dependencies

Runs after TASK-005 (so the Phase 1 refactor reviews stay scoped to the
original 4 commits). Findings above are the minimum set; trust the tsc
re-run over stale line numbers.
