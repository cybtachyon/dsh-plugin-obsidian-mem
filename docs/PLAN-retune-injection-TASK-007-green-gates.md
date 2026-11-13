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

## Gate record (2026-11-13, all four green at HEAD 334bc06, no fixes)

- `pnpm build`: exit 0; `tsc -b --force` + client bundle (47158 bytes) +
  format + verify-emit ("240 tsc artifacts intact across 6 packages");
  `git status --porcelain` empty immediately after the build (tree clean).
- `pnpm test`: exit 0; 45 test files passed | 1 skipped (milvus-live),
  829 tests passed | 2 skipped, 0 failed, 1.13s.
- `pnpm lint`: exit 0; `eslint .` repo-wide, zero warnings zero errors.
- `git status` stray-artifact check: no tracked modifications, no
  untracked paths; `scripts/eval/results/` wholly gitignored
  (`.gitignore:17`). The five stale `smoke-*.json` scratch files inside
  it were deleted per the sanctioned disposition; `legacy-hybrid.json`
  left in place.
