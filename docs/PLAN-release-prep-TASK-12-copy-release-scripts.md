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

## Result (TASK-12 closeout)

- Both scripts copied byte-for-byte (`diff` against the source is empty);
  neither eslint nor tsc required any change. Note: the `bump-versions.ts`
  header comment names `dsh-plugin-local-infer` as its example bundle; kept
  verbatim per the byte-for-byte instruction.
- Coverage finding, stated rather than silently widened:
  - `eslint.config.mjs` DOES cover `scripts/release/*.ts` through the
    existing `files: ['**/*.{js,ts,tsx}']` block (only `packages/*/lib/**`
    and `dsh/client.js` are ignored). No eslint entry was added.
  - The root `tsconfig.json` does NOT cover them: it is solution-style
    (`"files": []` plus references to the six `packages/*` projects), so
    `pnpm exec tsc --noEmit -p tsconfig.json` compiles zero script files and
    exits 0 regardless. local-infer's tsconfig has the same shape, so its
    release scripts sit outside its typecheck graph too; this repo matches
    that baseline. No tsconfig include was added. As a standalone signal,
    `pnpm exec tsc --noEmit --strict --module nodenext --moduleResolution
    nodenext --target es2023 --types node scripts/release/*.ts` also
    exits 0.
- Baseline before the copy: `pnpm lint` 0; `tsc --noEmit -p tsconfig.json` 0.
  After the copy: both again 0.
- No-op proof: all eight workspace `package.json` files already read 0.0.1.
  `npx tsx scripts/release/bump-versions.ts 0.0.1` printed the eight
  `0.0.1 -> 0.0.1` lines and rewrote all eight files, but every rewrite was
  byte-identical: `git status --porcelain` afterwards showed only the new
  untracked `.github/` and `scripts/release/` directories, no modified
  package.json. Nothing needed reverting.
