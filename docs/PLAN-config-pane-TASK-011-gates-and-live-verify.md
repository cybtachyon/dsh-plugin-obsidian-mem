# TASK-011: gates-and-live-verify

Run the full repo gates and verify the feature against the live harness at
http://127.0.0.1:3080 (per the questionnaire answer on host restarts).

## Scope

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
   - Questionnaire decision: the agent does NOT restart the host. Ask the
     user to restart the DSH host and send a continue message, then END THE
     TURN. After the continue: run the curl probes, confirm the
     Configuration pane renders below Vaults on the Plugins page and that a
     saved value survives a page refresh. Report what cannot be seen without
     browser control instead of guessing. (The page-refresh client check and
     the profile-symlink check may already run before asking.)
3. Restore user state changed during testing (reset overrides the tests
   created; leave the live profile as found).

## Definition of Done

- Every gate output attached or quoted in the final report; live probe
  results recorded; any verification limit stated explicitly.

## Dependencies

TASK-010 (docs) and everything else; this is the last task.
