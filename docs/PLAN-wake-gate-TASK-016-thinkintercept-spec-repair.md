# TASK-016: thinkIntercept spec repair (pre-existing breakage)

Inserted from the TASK-014 report: `pnpm test` is RED at HEAD
independent of the wake work. Commit `4bf4f8f` ("feat(events): Improves
relevancy tagging for agent thought injections", 2026-11-13 15:58)
changed the think-injection header from `...terms: <matched>.` to
`Memory related to: <queryString>.` without updating
`packages/events/tests/thinkIntercept.spec.ts`, which still asserts
`terms: why` / `terms: debug`. 3 failures; every later task's
`pnpm test` gate is blocked until this is green.

1. Read `4bf4f8f` (`git show 4bf4f8f --stat` then the src diff) to
   confirm the committed BEHAVIOR is intended (relevancy tagging) and
   that its lib shipped in lockstep. The fix is to the stale SPEC, not
   the src: update the header assertions to the new `Memory related
   to:` shape, keeping each test's original intent (which rows/terms
   got injected, once-per-turn guards, budget accounting). If any
   failure shows the new behavior is actually wrong (not just
   differently-worded), STOP and report instead of changing behavior.
2. Touch only `packages/events/tests/` (plus events src ONLY if a real
   bug surfaces, with the reasoning in the commit body).
3. Full gates green: `pnpm test` (all 800 tests), `pnpm lint`.
   `git status --porcelain` before commit; `git show --stat HEAD`
   after; `prek run --files` first; no assistant attribution.

Definition of Done: full suite green at HEAD again; one commit;
TASK-015/Phase B inherit a green baseline.
