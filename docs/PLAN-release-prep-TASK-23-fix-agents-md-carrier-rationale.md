# TASK-23 Correct the install-carrier rationale in AGENTS.md

TASK-02 rewrote the lib-tracking bullets but left the "Runtime deps are
declared at BOTH the root and their owning package" bullet's parenthetical
"(lib is git-ignored and carries no node_modules of its own)". The second half
of that argument still holds (the installed profile tree is the only tree
`packages/*/lib` resolves bare specifiers against); only the "git-ignored"
premise is now false.

Rewrite the parenthetical so it states the surviving reason without the stale
premise, for example: the committed `packages/*/lib` carries no
`node_modules` of its own, so the profile tree materialized from the root
`dependencies` is the only tree those files resolve bare specifiers against.

## Definition of Done

- `grep -n "git-ignored" AGENTS.md` no longer appears inside the
  install-carrier bullet.
- The bullet still names both halves of the lockstep rule (root half for the
  installed profile tree, per-package half for local typecheck/test resolution)
  and the "do not run pnpm dedupe" warning.
