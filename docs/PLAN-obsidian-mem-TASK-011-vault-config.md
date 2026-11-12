# TASK-011 Vault config + default-vault bootstrap

Depends: TASK-010. `packages/core/src/vaults.ts`.

## Scope

- `VaultConfig = { path: string (absolute), mode: 'shared' | 'read-only' }`.
- `resolveVaults(configs, fsProbe)`: normalize/validate (absolute, exists; mode one of the
  two; de-dupe by realpath); `markdownDir(p)`/`metadataDir(p)` accessors.
- `ensureDefaultVault(fs)`: when the resolved list has zero `shared` vaults, create
  `$HOME/.dsh/obsidian-mem/{markdown,metadata}` (mkdir -p) and append it as shared.
- `firstSharedVault(vaults)`: first shared vault in list order (target for .INTENTS.md).
- `classifyPath(vaults, absPath)`: returns { vault, mode, insideMarkdownDir } or null
  (used by memory_read/write guards).
- Seed `.INTENTS.md` helper (used later by service activation): creates the file in the
  first shared vault listing the 9 intent markers as sections when absent.

## DoD

Unit tests with in-memory fs stub: default creation triggered only with zero shared vaults;
read-only kept out of "shared" queries; .INTENTS.md seeding idempotent; commit.
