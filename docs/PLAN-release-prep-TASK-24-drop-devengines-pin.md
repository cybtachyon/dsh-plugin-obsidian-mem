# TASK-24 Drop the `devEngines` block from the root package.json

`package.json` declares:

```json
"devEngines": { "packageManager": { "name": "pnpm", "version": "12.18.0", "onFail": "download" } }
```

npm implements `onFail` as `warn | error | ignore` only, so `download` is not a
value npm understands and every npm command run from the repo root dies:

```
npm pack --dry-run
npm error code EBADDEVENGINES
npm error EBADDEVENGINES   required: { name: 'pnpm', version: '12.18.0', onFail: 'download' }
```

That is fatal for `publish.yml`, whose release step is
`npm publish --provenance`, and for any `npm pack` gate. dsh-plugin-local-infer
publishes from the npm CLI today and has no `devEngines` block at all.

Delete the whole `devEngines` object. Keep `packageManager: "pnpm@12.18.0"`
(corepack and pnpm both honor it) and keep the `pnpm = "12.18.0"` pin in
`mise.toml`. pnpm already warns that `packageManager` is ignored while
`devEngines.packageManager` is present, so the block is currently dead weight.

Then correct the stale caveat in
`docs/research/milvus-transformers-findings.md` ("Caveat for npm commands in
this repo ... fail with EBADDEVENGINES. Run registry queries from a neutral
cwd"): it documents the removed state. Rewrite it in the past tense, keeping the
`[V]` verification marker convention.

## Definition of Done

- `grep -c devEngines package.json` is 0; `packageManager` is still
  `pnpm@12.18.0`.
- `npm pack --dry-run` exits 0 from the repo root (this is the regression proof).
- `pnpm install --frozen-lockfile`, `pnpm lint`, and `pnpm test` exit 0.
- The research-doc caveat no longer describes the pin as current.
- Commit as `build(packaging): Drop the devEngines pin that blocked the npm CLI`,
  path-scoped so no other dirty file rides along.
