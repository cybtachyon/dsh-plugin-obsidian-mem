# TASK-02 Flip the lib-tracking policy in AGENTS.md

AGENTS.md documents the opposite of what this plan establishes. Rewrite:

- The "**lib is NOT tracked here.**" bullet (Dev Environment Tips, ~line 78).
  State that `packages/*/lib` IS committed so a git or npm install ships the
  runtime entry points, that `packages/*/tsconfig.tsbuildinfo` stays ignored,
  and that after `git clean` a `pnpm install` is still required but
  `pnpm build` must leave the tree clean rather than create missing entry points.
- The parenthetical "(lib is git-ignored and carries no node_modules of its
  own)" in the root-install-carrier bullet (~line 95): the node_modules half of
  the argument stands; only the "git-ignored" clause changes.
- The Dev Environment Tips line "After `git clean`, run `pnpm build` before
  anything consumes `lib/`" if it still contradicts the new policy.

## Definition of Done

- `grep -n "NOT tracked" AGENTS.md` returns nothing.
- Every remaining mention of lib tracking in AGENTS.md agrees with .gitignore.
