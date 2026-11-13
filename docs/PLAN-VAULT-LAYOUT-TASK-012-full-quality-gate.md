# TASK-012 full-quality-gate

Objective: the whole tree passes every repo gate on the final layout code.

Steps:
0. Re-root `packages/service/tests/integration/live-pipeline.live.test.ts`
   (asserts legacy `markdown/…` source_paths AND reads/rm's the OLD
   `<vault>/metadata/obsidian-mem-state.json` at ~L427/L509/L543; state now
   lives at `<vault>/.obsidian-mem/metadata/`; skipped in normal runs but
   must be layout-correct when exercised). Also sweep remaining cosmetic
   `markdown/` fixture path strings through tools/events/core/service test
   specs (opaque strings that pass today: tools write/read/search/dream/audit
   specs, events readIntercept, core constants.spec, service.spec ~L840) so
   fixtures model the real layout.
0b. Type-honest vault-row fixtures (TASK-015 finding): add the required
   `globalFile` to VaultEntry-typed fixtures missing it
   (events/turnEnd.spec ~13 rows, thinkIntercept.spec:39,
   readIntercept.spec:49 — which also carries invalid mode `'readonly'`,
   fix to `'read-only'` —, ui/tests/testkit.ts:110/144,
   client/tests/api.spec.ts:89, tools/tests/testkit.ts:51 spread).
1. `pnpm build` (tsc -b --force, build-client, build-format, verify-emit);
   commit any emitted drift in this commit.
2. A second consecutive `pnpm build` leaves `git status --porcelain` empty.
3. `pnpm test`, then `pnpm test:coverage` clearing the vitest.config.ts
   thresholds; fix or scope-cover gaps this change introduced.
4. `pnpm lint`.
5. `prek run --files <all files this plan touched>`.

Definition of Done: all five green; a single commit if emit drift existed,
otherwise no commit; report exact gate output tails.

Depends on: TASK-011.
