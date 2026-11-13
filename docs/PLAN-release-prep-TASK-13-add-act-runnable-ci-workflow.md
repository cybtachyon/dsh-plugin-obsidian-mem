# TASK-13 Add the act-runnable CI workflow

Add `.github/workflows/ci.yml` so `act` has a workflow that exercises the
build without touching the registry. Trigger: `push` and `pull_request` on
`main`. Job `verify` on `ubuntu-latest`, `timeout-minutes: 30`,
least-privilege `permissions: { contents: read }`, steps:

1. `actions/checkout@<pinned sha>` (same pin as publish.yml).
2. `pnpm/action-setup@<pinned sha>` v6.1.0, version 12.18.0.
3. `actions/setup-node@<pinned sha>` v7.1.0, `node-version: 24`,
   `cache: pnpm` (a CI cache is fine here; publish.yml stays cache-free).
4. `pnpm install --frozen-lockfile`.
5. `pnpm run lint`, `pnpm run typecheck`, `pnpm run build`, `pnpm test`.
6. `npm pack --dry-run` so a packaging regression fails the build.

Pin every `uses:` to a commit SHA, matching publish.yml's style.

## Definition of Done

- `mise x jactionlint@2.3.0 -- jactionlint` reports no findings.
- `act push --list -W .github/workflows/ci.yml` prints the `verify` job.
