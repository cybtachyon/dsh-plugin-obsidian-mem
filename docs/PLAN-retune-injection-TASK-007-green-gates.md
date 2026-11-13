# TASK-007 green-gates

Full repo gates after Phase 1 code + docs land:
- `pnpm build` (tsc -b --force, client bundle, format, verify-emit) leaves
  the tree clean.
- `pnpm test` green; `pnpm lint` green (`eslint .` repo-wide).
- `prek run --files <every touched path>` before each commit.
- `git status` shows no stray artifacts (scripts/eval/results/* stays
  gitignored).

Definition of Done: all four gates green at one commit; record the gate
outputs' one-line summaries in this file.

Depends on: TASK-001..006.
