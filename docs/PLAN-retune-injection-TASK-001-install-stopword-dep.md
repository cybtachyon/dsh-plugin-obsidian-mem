# TASK-001 install-stopword-dep

Add the `stopword` npm package (latest 3.x, currently 3.1.5) as a runtime
dependency. Per AGENTS.md "Runtime deps are declared at BOTH the root and
their owning package": add an identical semver row (`"^3.1.5"`) to the root
`package.json` `dependencies` AND `packages/service/package.json`
`dependencies`, then `pnpm install`. The root copy is what the installed
plugin materializes into `~/.dsh/profiles/<profile>/node_modules`; deleting
either half breaks one surface. Do not run dedupe tooling that prunes the
root copy.

Definition of Done:
- Both package.json files carry `stopword` with the same range.
- `pnpm install` succeeds; `pnpm-lock.yaml` updated and staged.
- `node -e "console.log(require.resolve('stopword'))"` resolves from the
  repo; inspect its shipped `.d.ts` and record the import shape
  (`removeStopwords(words, [en])` and the `en` list export) in this file.

Depends on: none.
