# TASK-011-client-git-toggle

Settings card: the "Use Git to version shared vaults" control
(`packages/client/src/sections/configuration.tsx`).

Row spec (data-driven list, same shape as `llm.enabled`):
- `path: 'git.enabled'`, group `Git`, kind `toggle`,
  label exactly `Use Git to version shared vaults` (the requirement's
  checkbox wording; the card renders toggles with the existing segmented
  off/on vocabulary like `llm.enabled`).
- tooltip: when on, `memory_write` and `memory_dream` commit each shared
  vault to git; when off, the plugin never touches git.
- default on: the control's draft seeds from the resolved config, and
  `git.enabled` defaults to true (TASK-003), so an unmodified install
  shows On.
- Q4 answer adds two `number` rows in the same `Git` group:
  `git.churnThresholdPercent` (label `Churn threshold percent`,
  placeholder `50`) and `git.churnWindowCommits` (label
  `Churn window commits`, placeholder `8`); tooltips name the dream
  Step 4 stressor rule ("a note edited in over this share of the last N
  commits"). Placeholder copy follows the existing pattern of pinning
  against the config defaults, not restating literals.

Known-red assignment (from TASK-003 handoff): `packages/client/tests/
configuration.spec.ts` "covers exactly the service CARD_SETTINGS_KEYS
paths" is RED since commit 5ff21f2 (the whitelist gained the three
`git.*` leaves); this task's three Git-pane rows turn it GREEN in the
same commit.

Notes:
- The card toggles flow through the existing settings GET/POST/DELETE
  routes via `CARD_SETTINGS_KEYS` (TASK-003 whitelisted the path); no
  route or api.ts change is needed. Verify the Configuration pane's
  draft/apply/reset machinery treats the new leaf generically; the
  `FormatFieldSeed` off/on vocabulary comment mentions `llm` only, update
  the comment to name both toggles.
- Client spec pins: `configuration.spec.ts` row-list/label pins plus the
  DEFAULT-pinned placeholder copy pattern for the two new number rows
  (placeholders come from the config defaults, mirroring the
  `DEFAULT_BUDGETS` pin pattern). Keep the bundle-text pins in sync after
  `pnpm build` (the dsh/client.js rebuild rides this commit).

Definition of Done: build (client artifact rebuilt) + client and ui suites
green; `dsh/client.js` regenerated in the same commit; prek clean.
