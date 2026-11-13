# TASK-14 Commit workflows and release scripts

```
prek run --files .github/workflows/publish.yml .github/workflows/ci.yml \
  scripts/release/bump-versions.ts scripts/release/git-release.ts
git add .github/workflows scripts/release
git commit -m "ci: Add npm publish and act-runnable verify workflows"
```

Note: the prek `jactionlint` hook only exists after TASK-15; if it is not yet
installed, `prek run` simply does not run it, and TASK-17 lints the workflows
explicitly.

## Definition of Done

- `git show --stat HEAD` lists the two workflows and two scripts.

## Result (TASK-14 closeout)

- `prek run --files .github/workflows/publish.yml .github/workflows/ci.yml
  scripts/release/bump-versions.ts scripts/release/git-release.ts` exits 0
  (trim-trailing-whitespace, end-of-file, large-files; no jactionlint hook
  yet, as expected pre-TASK-15).
- Commit `58d40fa ci: Add npm publish and act-runnable verify workflows`
  made with `git add <the four explicit paths>` followed by
  `git commit --only -m ... -- <the four explicit paths>`.
  `git show --stat HEAD` lists exactly the two workflows and two scripts
  (4 files, 262 insertions).
