# TASK-15 Pin jactionlint in mise and prek

- `mise.toml`: add `jactionlint = "2.3.0"` under `[tools]`.
- `prek.toml`: in the `local` repo hooks, add
  `{ id = "jactionlint", name = "jactionlint (GitHub Actions workflows)", entry = "jactionlint", language = "system", files = "^\\.github/workflows/.*\\.ya?ml$", pass_filenames = false }`.
- Run `prek install` so the hook is wired into `.git/hooks` (the repo already
  relies on a local commit-msg hook; a fresh clone needs this step, and
  AGENTS.md already documents the commit-msg half).

## Definition of Done

- `mise x jactionlint@2.3.0 -- jactionlint` runs from the repo root.
- `prek run jactionlint --files .github/workflows/ci.yml` exits 0.
