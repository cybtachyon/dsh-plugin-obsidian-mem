# TASK-03 Commit the tracking-policy change

Commit `.gitignore` and `AGENTS.md` as one change.

```
prek run --files .gitignore AGENTS.md
git add .gitignore AGENTS.md
git commit -m "build: Track packages/*/lib so installs ship runtime entry points"
```

## Definition of Done

- `git show --stat HEAD` lists exactly those two paths.
- `git status --porcelain` shows no unstaged change to either file.
