# TASK-003 Cordis patch rows and client carrier

Status: done

Depends: TASK-001.

## Scope

- Root `cordis.patch.yml` and `packages/bundle/cordis.patch.yml` (kept in sync like
  local-infer), rows:
  - `obsidian-mem` → `name: 'dsh-plugin-obsidian-mem'` (bare carrier; required so the
    client-module scan keys the `dsh.client` declaration and loads dsh/client.js).
  - `obsidian-mem-service` → `dsh-plugin-obsidian-mem/service` (vault registry, embedder,
    Milvus lifecycle, indexer, search, audit/dream engine; publishes `ctx.obsidianMem`).
  - `obsidian-mem-ui` → `dsh-plugin-obsidian-mem/ui` (host routes /obsidian-mem/*).
  - `obsidian-mem-tools` → `dsh-plugin-obsidian-mem/tools` (five memory_* tools + prompt
    section; `inject: ['obsidianMem']`).
  - `obsidian-mem-events` → `dsh-plugin-obsidian-mem/events` (lifecycle hooks;
    `inject: ['obsidianMem']`).
- `dsh/host.js`: no-op carrier module named `obsidian-mem` (copy local-infer's, adapt names).
- Every package stub: `export const name`, `export const inject` ([] for leaf, ['obsidianMem']
  where noted), `export function apply(ctx) { void ctx }`, default export plugin object.
  service stub publishes nothing yet (later tasks fill it).
- Root exports map already includes subpaths (TASK-001); confirm `files` covers dsh/host.js.

## DoD

Patches parse (node -e with yaml lib or vitest fixture); `pnpm build` green; commit.
