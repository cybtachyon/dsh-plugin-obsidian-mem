# TASK-09 Prove the build leaves the tree clean

Run the build a second time and confirm it produces no diff. This is the gate
that keeps committed emit from churning on every rebuild.

```
pnpm build
git status --porcelain
```

## Definition of Done

- `git status --porcelain` prints nothing.
- If it prints anything, fix `scripts/build-format.mjs` coverage (its
  target-directory list is explicit, so a newly tracked package emit needs its
  row added) and re-run until clean; commit the fix separately.
