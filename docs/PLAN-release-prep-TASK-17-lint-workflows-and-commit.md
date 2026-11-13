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
