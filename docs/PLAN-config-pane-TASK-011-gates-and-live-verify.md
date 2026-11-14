# TASK-011: gates-and-live-verify

Run the full repo gates and verify the feature against the live harness at
http://127.0.0.1:3080 (per the questionnaire answer on host restarts).

## Scope

0. Folded-in fixes from TASK-009/TASK-010 findings (commit BEFORE the gate
   sweep so the gates cover them):
   - Fix the Configuration tooltip for `budgets.searchTopK`
     (`packages/client/src/sections/configuration.tsx`): the memory_search
     tool parameter is `limit`, not `topK`; re-pin the configuration.spec
     expectation and rebuild `dsh/client.js`.
   - Add a Storage layout table row to README.md for
     `$HOME/.dsh/obsidian-mem-db/state/` (holds `settings.json`,
     `vaults.json`, plugin session state).
   Do NOT add a tests-tier typecheck gate (user decision, final report).

1. Repo gates (all from the repo root):
   - `pnpm build` then a second `pnpm build` (tree must be clean;
     `verify-emit` passes).
   - `pnpm test`; `pnpm test:coverage` clearing the vitest thresholds
     (lines 85 / functions 85 / branches 78 / statements 85).
   - `pnpm lint` (repo-wide eslint).
   - `prek run --files <every touched path>` per the commit convention.
2. Live verification (host-side packages need a host restart; the client
   half needs only a page refresh to pick up the rebuilt `dsh/client.js`):
   - `curl http://127.0.0.1:3080/obsidian-mem/settings` → 200 view shape.
   - `curl -X POST` one budgets change; `curl GET` shows it in
     `overrides`; the profile row config untouched.
   - `curl -X POST` an invalid body (e.g. `vectorDim: 999`) → 400 envelope.
   - `curl -X DELETE` → overrides empty.
   - Confirm the profile bundle is the workspace symlink
     (`~/.dsh/profiles/web/node_modules/dsh-plugin-obsidian-mem`).
   - Questionnaire decision: the agent does NOT restart the host. Split
     the work: complete step 0, step 1, and the pre-restart parts of step 2
     (symlink check; a `curl` of GET /obsidian-mem/settings against the
     stale host is EXPECTED to 404 until the restart, and that 404 is
     itself the pre-restart evidence). Then STOP: report back to the parent
     agent that all pre-restart work is done and the user's host restart is
     the only remaining step. The parent agent asks the user, ends the
     session turn, and the post-restart probes (POST/GET/DELETE curls,
     card spot-check) run only after the user's continue message. Report
     what cannot be seen without browser control instead of guessing.
3. Restore user state changed during testing (reset overrides the tests
   created; leave the live profile as found).

## Definition of Done

- Every gate output attached or quoted in the final report; live probe
  results recorded; any verification limit stated explicitly.
- Checkbox rule: check TASK-011 off in PLAN-config-pane.md ONLY when
  steps 0, 1 and the pre-restart probes are all green, and append one line
  under the checkbox: "post-restart probes pending on the user's host
  restart + continue message."

## Dependencies

TASK-010 (docs) and everything else; this is the last task.
