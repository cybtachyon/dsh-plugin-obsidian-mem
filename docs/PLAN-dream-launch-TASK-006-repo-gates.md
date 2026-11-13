# TASK-006: repo-gates

Bring the full repo gate set green on the finished tree and leave the
working tree clean.

## Steps

1. `pnpm build` (tsc -b --force, client bundle, format, verify-emit).
2. `pnpm test` (vitest run) — coverage thresholds in `vitest.config.ts`
   (85/85/78/85) must clear; add coverage where TASK-001/003 branches
   demand it.
3. `pnpm lint` (`eslint .`).
4. `prek run --files <every path touched by TASK-001..005>`.
5. `git status --short` empty; commit any emitted artifacts per the repo's
   tracked-`lib` convention.

## Definition of Done

- All four commands exit 0; tree clean; if a gate forced code changes, they
  land in a `test:`/`fix:` commit before this task closes.
