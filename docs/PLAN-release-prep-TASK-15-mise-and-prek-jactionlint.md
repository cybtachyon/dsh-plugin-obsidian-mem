# TASK-15 Pin jactionlint and act in mise, wire the prek hook

- `mise.toml`: add `jactionlint = "2.3.0"` and `act = "0.2.89"` under `[tools]`
  (both versions are what this host has installed and what the Phase 4 closeouts
  already validated against, so the pin records reality rather than upgrading).
- `prek.toml`: in the `local` repo hooks, add
  `{ id = "jactionlint", name = "jactionlint (GitHub Actions workflows)", entry = "jactionlint", language = "system", files = "^\\.github/workflows/.*\\.ya?ml$", pass_filenames = false }`.
  `pass_filenames = false` is required: a bare `jactionlint` checks the nearest
  `.github/workflows` directory and rejects a directory operand.
- Run `prek install` so the hook is wired into `.git/hooks` (the repo already
  relies on a local commit-msg hook; a fresh clone needs this step, and
  AGENTS.md already documents the commit-msg half).

## Definition of Done

- `mise.toml` lists pnpm, prek, jactionlint, and act; `mise current` in the repo
  root resolves all four.
- Plain `jactionlint` from the repo root exits 0 through the mise shim (no
  `mise x` wrapper), proving the prek hook's bare `entry` will resolve at
  commit time.
- `prek run jactionlint --files .github/workflows/ci.yml` exits 0.

## Result (TASK-15 closeout)

- `mise.toml` now pins exactly four tools: act 0.2.89, jactionlint 2.3.0,
  pnpm 12.18.0, prek 0.5.10; `mise current` in the repo root resolves all
  four (plus the host's global node/php/shellcheck).
- `prek.toml` gained the local `jactionlint` hook exactly as specified
  (`pass_filenames = false`, `files = "^\\.github/workflows/.*\\.ya?ml$"`,
  `language = "system"`).
- `prek install` reinstalled `.git/hooks/pre-commit`; the existing
  prek-generated `commit-msg` hook stayed in place. A probe commit whose
  message contained a forbidden attribution word was rejected by the
  `commit-msg external assistant attribution check` (exit 1, no commit
  made), proving the attribution gate still bites. `--no-verify` was never
  used.
- Plain `jactionlint` from the repo root exits 0 through the mise shim, and
  `act --version` prints 0.2.89 through its shim, so the hook's bare
  `entry` resolves at commit time.
- `prek run jactionlint --files .github/workflows/ci.yml` exits 0.
- The `mise.toml` and `prek.toml` changes are committed in TASK-17's
  `9f573df ci: Configure act for local GitHub Actions runs`.
