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

## Results

- Second `pnpm build` (on top of commit `cb523da`) exited 0 and dirtied no
  tracked path. `git status --porcelain` showed only the out-of-scope
  `README.md` IDE edit and the pre-existing untracked `.idea/`; no
  `packages/*/lib` or `dsh/` diff. `scripts/build-format.mjs` already
  carries a `TARGET_DIRS` row for `dsh` and all six emitting
  `packages/*/lib`, so no fix was needed. Build is idempotent on the
  committed emit.
