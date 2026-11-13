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

## Result (TASK-13 closeout)

- `.github/workflows/ci.yml` authored with the specified trigger, job, and
  step order. The three `uses:` pins are the same commit-SHA and comment
  pairs carried over from publish.yml; they were not independently resolved.
- Two additions beyond the task's step list were required to make
  jactionlint 2.3.0 exit 0: a top-level `concurrency:` block
  (`concurrency-limits`), and `persist-credentials: false` on the checkout
  step (`artipacked`; no ci step pushes).
- `mise x jactionlint@2.3.0 -- jactionlint` (bare, repo root) exits 0.
- `mise x act@0.2.89 -- act push --list -W .github/workflows/ci.yml` exits 0
  and prints the `verify` job for events `push,pull_request`. (Plain `act`
  is not yet activated in this directory; activating it is TASK-16 scope.)
