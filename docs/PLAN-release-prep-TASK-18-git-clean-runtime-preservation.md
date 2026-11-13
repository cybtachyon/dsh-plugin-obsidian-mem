# TASK-18 Prove runtime files survive `git clean -fxd`

Sequence (each step's output recorded in this file under `## Findings`):

1. `git status --porcelain` must be empty (commit or stash anything first).
2. `git ls-files 'packages/*/lib/*' | wc -l` and `ls dsh`: record the
   pre-clean counts.
3. `git clean -fxdn` (dry run): confirm it targets node_modules, coverage,
   `dsh/.build`, tsbuildinfo, `.idea` leftovers, and that it lists NO
   `packages/*/lib` or `dsh/*.js` paths.
4. `git clean -fxd`.
5. Confirm `dsh/host.js`, `dsh/client.js`, and every `packages/*/lib`
   entry point named in `exports` still exist on disk.
6. `pnpm install --frozen-lockfile`.
7. `pnpm build` then `git status --porcelain`: empty, which proves the
   committed emit equals a fresh build.
8. `pnpm test`: green, proving the tree is functional after the clean.

## Definition of Done

- Steps 3, 5, 7, 8 all hold; findings written here.

## Precondition

`README.md` carries a user IDE edit outside this plan. Confirm with the user that
it is committed or stashed before step 3; never clean over it.
