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

## Results

- `pnpm build` exited 0; `verify-emit: 232 tsc artifacts intact across 6
  packages`.
- Tracked emit: `git ls-files 'packages/*/lib/*' | wc -l` = 232 (core 32,
  service 60, ui 4, tools 40, events 36, client 60).
- Artifact kinds: 58 `.js` + 58 `.d.ts` = 116, and 116 `.map`
  (58 `.js.map` + 58 `.d.ts.map`), so every artifact ships its source map.
- Largest emitted file: `packages/service/lib/service.js` at 43,095 bytes,
  well under the prek `check-added-large-files` 500 KiB cap. No file tripped
  the hook.
- `dsh/host.js` and `dsh/client.js` were byte-identical after the build (md5
  unchanged), so neither was committed.
- Commit `cb523da build: Emit committed lib output so installs ship entry
  points` landed the 232 files, staged as six explicit `git add
  packages/<name>/lib` paths. prek hooks (trailing-whitespace,
  end-of-file-fixer, check-added-large-files) and the commit-msg attribution
  check all passed. `README.md` stayed modified and unstaged.
- `packages/bundle` emits no `lib` (meta package); none was created.
