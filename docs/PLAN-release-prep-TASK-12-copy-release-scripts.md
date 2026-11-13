# TASK-12 Copy the release helper scripts

Copy `scripts/release/bump-versions.ts` and `scripts/release/git-release.ts`
from `/home/derek/src/dsh-plugin-local-infer` into `scripts/release/`. They
are repo-agnostic (workspace-wide version bump; commit, tag, push with
token re-pointing). Verify they satisfy eslint (the repo lints `.ts` sources)
and that `scripts/release` is inside the lint/typecheck graph.

## Definition of Done

- `pnpm lint` and `pnpm exec tsc --noEmit -p tsconfig.json` exit 0 with the
  new files present (add a tsconfig include or an eslint entry only if the
  current config skips them; note which).
- `node -e` sanity: running `npx tsx scripts/release/bump-versions.ts 0.0.1`
  is a no-op on an already-0.0.1 tree (no diff), proving the script works here.
