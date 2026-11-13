# TASK-27 Correct the copied release scripts' self-identity

`scripts/release/bump-versions.ts` was copied byte-for-byte from
dsh-plugin-local-infer (TASK-12), and its header comment still describes that
repo:

```
 * The root package.json is the installable bundle (`dsh-plugin-local-infer`);
```

In this repo the installable bundle is `dsh-plugin-obsidian-mem`, so the comment
names the wrong package for the code that now lives here. Fix the comment text
only. No behavior change in either script.

Keep `git-release.ts`'s `git add -A` as-is: on a fresh CI checkout with nothing
untracked it is the intended "stage the whole bump" step, and the script is only
ever run from `publish.yml`. Local runs are out of scope; the Phase 4 closeout
records that hazard.

## Definition of Done

- `grep -rn "local-infer" scripts/release/` returns nothing.
- `pnpm lint` exits 0.
- `npx tsx scripts/release/bump-versions.ts 0.0.1` still leaves the tree clean
  (byte-identical rewrites), verified with `git status --porcelain`.

## Result (TASK-27 closeout)

- The header comment now names `dsh-plugin-obsidian-mem` as the
  installable bundle; the comment is the only edit, no behavior change, and
  `git-release.ts` is untouched.
- `grep -rn "local-infer" scripts/release/` returns nothing (exit 1).
- `pnpm lint` exits 0.
- `npx tsx scripts/release/bump-versions.ts 0.0.1` exited 0 rewriting all
  eight workspace `package.json` files `0.0.1 -> 0.0.1` byte-identically;
  `git status --porcelain` showed only this task's comment edit.
- Committed alone as
  `8fdc689 fix(scripts): Correct the release scripts' self-identity comment`
  with `git commit --only -m ... -- scripts/release/bump-versions.ts`.
