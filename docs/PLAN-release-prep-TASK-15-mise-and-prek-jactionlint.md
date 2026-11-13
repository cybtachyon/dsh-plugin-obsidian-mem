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
