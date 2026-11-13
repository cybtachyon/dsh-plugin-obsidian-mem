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

## Result (TASK-11 closeout)

- `.github/workflows/publish.yml` copied from
  `/home/derek/src/dsh-plugin-local-infer/.github/workflows/publish.yml`.
  A `git diff --no-index` against the source shows exactly two hunks:
  `pnpm/action-setup` `version: 12.11.2 -> 12.18.0`, and the already-published
  gate/echo pair `dsh-plugin-local-infer@${RELEASE_VERSION} ->
  dsh-plugin-obsidian-mem@${RELEASE_VERSION}`.
- The `uses:` commit-SHA pins (`actions/checkout@3d3c42e5...` v7.0.1,
  `pnpm/action-setup@ea17c68d...` v6.1.0,
  `actions/setup-node@949feb24...` v7.1.0) were carried over verbatim from
  the local-infer source file, pin and comment pair together. They were not
  independently resolved against the action repos' tag history in this task.
- Prerequisite (no `NPM_TOKEN` anywhere): the npmjs.com package
  `dsh-plugin-obsidian-mem` must have a Trusted Publisher configured for this
  GitHub repository and this workflow file (Publish / publish.yml) before the
  first `npm publish --provenance` run can succeed. Until then a real run of
  this workflow publishes anonymously and the registry answers E404.
- `mise x jactionlint@2.3.0 -- jactionlint .github/workflows/publish.yml`
  reports no findings (exit 0, run from the repo root).
