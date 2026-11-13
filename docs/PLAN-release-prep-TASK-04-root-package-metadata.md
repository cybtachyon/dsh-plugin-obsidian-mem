# TASK-04 Root package.json metadata for namespace-less npm publish

Edit `package.json` (root = the installable bundle):

- `version`: `"1.0.0"` -> `"0.0.1"`.
- Add `publishConfig.access: "public"`.
- Add `repository` (type git, url `https://github.com/cybtachyon/dsh-plugin-obsidian-mem`).
  npm cross-checks `repository.url` against provenance at publish time; a
  missing field fails with E422.
- Add `homepage` and `bugs.url` pointing at the same GitHub repo.
- Audit `files`: keep it explicit and confirm it covers everything the DSH
  loader resolves through `exports` plus `cordis.patch.yml`, `icon.svg`,
  `locale/*.json`. `README.md` and `LICENSE` are always included by npm.
- Do not touch `dependencies`, `peerDependencies`, or the duplicate
  root/per-package runtime rows.

## Definition of Done

- `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` succeeds.
- `npm view --json . version name publishConfig repository` echoes 0.0.1,
  `dsh-plugin-obsidian-mem` (no scope), public access, the repository object.
- `pnpm lint` and `pnpm test` still pass.
