# TASK-22 Untrack the coverage output

`.gitignore` ignores `coverage/` while 507 vitest coverage files are tracked
under it, so a fresh `git clone` ships a stale report that a new run cannot
replace cleanly. Coverage is test output, not a DSH runtime file: untrack it and
leave the ignore rule in force.

```
git rm -r --cached coverage
git commit -m "chore: Stop tracking the vitest coverage report"
```

## Definition of Done

- `git ls-files coverage | wc -l` is 0.
- `git ls-files | grep -c .` dropped by the coverage file count only.
- `git status --porcelain` shows no `coverage/` entries (the directory is
  ignored), and `packages/*/lib` is still untracked at this point (TASK-08
  commits it).
