# TASK-002 core-vault-registry-model

Objective: move the vault-root semantics into `packages/core/src/vaults.ts`
per the layout contract in [PLAN-vault-layout.md](../PLAN-vault-layout.md).

Files: `packages/core/src/vaults.ts`, `packages/core/lib/index.ts` barrel if
exports change, core vaults specs.

Steps:
1. Delete `markdownDir()`; callers use the vault path directly (later tasks
   re-point them).
2. `metadataDir(vaultPath)` returns
   `join(vaultPath, PLUGIN_VAULT_DIR, VAULT_METADATA_DIR)` →
   `<vault>/.obsidian-mem/metadata`.
3. Add `pluginDir(vaultPath)` returning `<vault>/.obsidian-mem` and a
   predicate for "path is plugin-internal to a vault" usable by the read/write
   guards.
4. `VaultConfig` gains `globalFile: string` (relative to the vault root;
   default `GLOBAL_MEMORY_FILE_DEFAULT`). Extend `VaultConfigLike` with
   optional `globalFile`; `resolveVaults` defaults it.
5. `provisionDefaultVault`: mkdirp the vault root and `metadataDir` only (no
   `markdown/`).
6. `classifyPath`: replace `insideMarkdownDir` with `insideNotes` = inside the
   vault root AND not inside a dot directory AND not the reserved root files;
   keep deepest-vault-wins.
7. Seed `GLOBAL.md`? No. Provisioning writes no global memory file; out of
   scope.

Definition of Done: core specs updated for the new tree semantics (root notes
classified inside, `.obsidian-mem/…` refused, nested dot dirs refused);
`pnpm build` clean; emit committed with the change.

Depends on: TASK-001.
