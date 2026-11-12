# TASK-011 Vault config + default-vault bootstrap

Depends: TASK-010. `packages/core/src/vaults.ts`.

## Scope

- `VaultConfig = { path: string (absolute), mode: 'shared' | 'read-only' }`.
- `resolveVaults(configs, fsProbe)`: normalize/validate (absolute, exists; mode one of the
  two; de-dupe by realpath); `markdownDir(p)`/`metadataDir(p)` accessors.
- `provisionDefaultVault(fs)` (LAZY, per Decision log): creates
  `$HOME/.dsh/obsidian-mem/{markdown,metadata}` (mkdir -p) and returns the shared
  `VaultConfig`; called ONLY from the service's first-memory-access seam
  (`ensureMemoryAccess`), never at activation. `resolveVaults` itself must NOT create
  anything; it reports `hasSharedVault` so callers can decide.
- `firstSharedVault(vaults)`: first shared vault in list order (target for .INTENTS.md).
- `classifyPath(vaults, absPath)`: returns { vault, mode, insideMarkdownDir } or null
  (used by memory_read/write guards).
- Seed `.INTENTS.md` helper (used later by service activation): creates the file in the
  first shared vault listing the 9 intent markers as sections when absent.

## DoD

Unit tests with in-memory fs stub: resolveVaults has zero side effects; provisioning only
through provisionDefaultVault and only meaningful with zero shared vaults; read-only kept
out of "shared" queries; .INTENTS.md seeding idempotent; commit.
