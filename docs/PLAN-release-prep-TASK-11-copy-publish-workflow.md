# TASK-11 Copy the publish workflow

Copy `/home/derek/src/dsh-plugin-local-infer/.github/workflows/publish.yml` to
`.github/workflows/publish.yml` and adapt only what differs:

- The npm-name version gate: `dsh-plugin-obsidian-mem@${RELEASE_VERSION}`.
- `pnpm/action-setup` version: 12.18.0 (this repo's `packageManager`).
- Keep as-is: pinned commit SHAs for all `uses:`, `permissions: {}` at
  workflow level, `contents: write` + `id-token: write` on the job,
  `fetch-depth: 0` with `persist-credentials: false`, no pnpm cache,
  `node-version: 24` (trusted publishing needs npm CLI >= 11.5.1),
  the `RELEASE_VERSION` env indirection, and the already-published skip.
- No `NPM_TOKEN` secret: publishing rides the npmjs.com trusted publisher.
  Record that prerequisite in this task file.

## Definition of Done

- `.github/workflows/publish.yml` exists; `git diff` against the source copy
  shows only the intended adaptations.
- `mise x jactionlint@2.3.0 -- jactionlint .github/workflows/publish.yml`
  (run from the repo root) reports no findings.
