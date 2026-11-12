# TASK-052 Client build pipeline wired

Depends: TASK-051. Adapt local-infer `scripts/build-client.mjs`:
- esbuild `packages/client/src/index.ts` → CJS bundle wrapped as
  `window.__ModuleLoader__.load({ id: 'dsh-plugin-obsidian-mem', factory: (require) => ... })`
  → `dsh/client.js`.
- Externals: `react`, `@deepseek-ai/dsh-client-ui-primitives`.
- verify-emit.mjs now REQUIRES `dsh/client.js`.
- Confirm root package.json `dsh.client` block matches local-infer's
  (`platform: 'web'`, `immediately: true`, `inject: []`) and the bare-carrier patch row
  exists (TASK-003).
- build-format.mjs normalizes emitted newlines.

## DoD

`pnpm build` emits dsh/client.js containing the ModuleLoader factory id; artifact loads
syntax-clean (`node --check` won't parse ESM wrapper? use esbuild parse check or vitest
string assertions: factory id + externals kept); commit.
