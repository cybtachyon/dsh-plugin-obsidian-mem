# TASK-006: repo-gates

Bring the full repo gate set green on the finished tree and leave the
working tree clean.

## Steps

1. `pnpm build` (tsc -b --force, client bundle, format, verify-emit).
   Also re-check the TASK-002 intent gate as an import check (parent
   ruling, TASK-002 note):
   `grep -n "from '@deepseek-ai" packages/service/src` must stay empty;
   the literal `grep "dsh-agent" packages/service/src` is not a gate, the
   only allowed hit is the user-facing blockedReason sentence in
   `dream.ts` naming the host service.
2. `pnpm test` (vitest run) — coverage thresholds in `vitest.config.ts`
   (85/85/78/85) must clear; add coverage where TASK-001/003 branches
   demand it.
3. `pnpm lint` (`eslint .`).
4. Carry-over nit from TASK-001 (pre-existing, verified at old HEAD): in
   `packages/service/tests/dream.spec.ts` `deps()`, the `globalIndex`
   fixture literal omits required `GlobalMemoryIndex.overBudget` under
   `exactOptionalPropertyTypes`; give it the explicit property. (Only this
   one fixture; the rest of the ~82 test-tree error groups stay out of
   scope.)
5. `prek run --files <every path touched by TASK-001..005>`.
5. `git status --short` empty; commit any emitted artifacts per the repo's
   tracked-`lib` convention.

## Definition of Done

- All four commands exit 0; tree clean; if a gate forced code changes, they
  land in a `test:`/`fix:` commit before this task closes.
