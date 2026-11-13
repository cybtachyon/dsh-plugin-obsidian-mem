# TASK-07 Commit the packaging metadata

Commit the root package.json, the seven workspace package.json files, and
`pnpm-lock.yaml`. Do not stage build output.

```
prek run --files package.json pnpm-lock.yaml packages/*/package.json
git add package.json pnpm-lock.yaml packages/bundle/package.json packages/client/package.json \
        packages/core/package.json packages/events/package.json packages/service/package.json \
        packages/tools/package.json packages/ui/package.json
git commit -m "build(packaging): Publish dsh-plugin-obsidian-mem 0.0.1 from npmjs.com"
```

## Definition of Done

- `git show --stat HEAD` lists nine paths (root, lockfile, seven packages).
- `git status --porcelain` shows no lib paths in the commit.
