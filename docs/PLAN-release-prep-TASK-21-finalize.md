# TASK-21 Finalize

- Delete `PLAN-release-prep.md` and `docs/PLAN-release-prep-TASK-*.md`.
- Commit the deletions.
- Run `pnpm lint`, `pnpm test`, `pnpm build` one final time and confirm
  `git status --porcelain` is empty.
- Summarize for the user: what is now tracked, the publish prerequisites
  (npmjs.com trusted publisher for the GitHub repo, `repository` field,
  `node-version: 24`), and the exact `act` command.

## Definition of Done

- `git status --porcelain` empty, no `PLAN-release-prep*` files left.
- HEAD contains the release-prep work; working tree clean.
