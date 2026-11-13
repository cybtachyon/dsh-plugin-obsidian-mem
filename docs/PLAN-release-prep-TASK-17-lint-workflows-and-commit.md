# TASK-17 Lint the workflows and commit

```
mise x jactionlint@2.3.0 -- jactionlint
prek run --files .actrc .gitignore mise.toml prek.toml AGENTS.md
git add .actrc .gitignore mise.toml prek.toml AGENTS.md
git commit -m "ci: Configure act for local GitHub Actions runs"
```

## Definition of Done

- jactionlint exits 0 over `.github/workflows`.
- `git show --stat HEAD` lists the five paths.

## Result (TASK-17 closeout)

- `mise x jactionlint@2.3.0 -- jactionlint` from the repo root exits 0 and
  left `mise.toml` at exactly the four intended pins (no auto-added
  `latest` entry).
- `prek run --files .actrc .gitignore mise.toml prek.toml AGENTS.md` exits
  0 (built-ins passed; the jactionlint hook skipped, no workflow staged).
- Commit `9f573df ci: Configure act for local GitHub Actions runs` made
  with `git add <the five explicit paths>` followed by
  `git commit --only -m ... -- <the five explicit paths>`.
  `git show --stat HEAD` lists exactly the five paths
  (`.actrc .gitignore AGENTS.md mise.toml prek.toml`, 5 files,
  32 insertions).
- The first attempt (initial hash `9064ec6`) was amended in place, same
  message and same five paths, after the `--container-archive-skip`
  incompatibility found while completing TASK-16 made the original
  `.actrc` unusable; see the TASK-16 Result.
