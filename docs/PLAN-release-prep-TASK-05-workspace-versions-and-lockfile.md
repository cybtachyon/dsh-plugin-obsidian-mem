# TASK-05 Version-bump the workspace and refresh the lockfile

Set `version` to `0.0.1` in every `packages/*/package.json`
(bundle, client, core, service, tools, events, ui) so one release version
covers the whole workspace, then refresh `pnpm-lock.yaml` so the
`workspace:^` cross-dependencies resolve against it.

`scripts/release/bump-versions.ts` (TASK-12) automates this for later
releases; here the edit may be direct or via that script.

```
pnpm install --no-frozen-lockfile   # refresh lockfile importer versions
```

## Definition of Done

- `node -e "const fs=require('fs');for(const f of fs.readdirSync('packages'))console.log(f, require('./packages/'+f+'/package.json').version)"`
  prints 0.0.1 for all seven packages.
- `pnpm install --frozen-lockfile` exits 0.
- `git diff --stat pnpm-lock.yaml` touches only version lines, not resolution
  downgrades.
