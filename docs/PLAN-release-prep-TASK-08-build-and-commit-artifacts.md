# TASK-08 Build and commit the runtime artifacts

```
pnpm build
git status --porcelain
```

Stage every emitted runtime artifact that is now tracked: `packages/*/lib/**`
for the packages that emit, plus any root `dsh/` change. Never use `git add -A`.

```
git add packages/*/lib
git commit -m "build: Emit committed lib output so installs ship entry points"
```

## Definition of Done

- `pnpm build` exits 0 (verify-emit green).
- `git ls-files 'packages/*/lib/*' | wc -l` is greater than 50.
- `git ls-files 'packages/*/lib/*' | grep -c '\.map$'` matches the number of
  `.js` and `.d.ts` artifacts minus zero (source maps are committed with the
  emit; if any single file exceeds the prek 500 KiB large-file cap, record it
  here and address it, do not bypass the hook).
- `git status --porcelain` is empty apart from ignored paths.
