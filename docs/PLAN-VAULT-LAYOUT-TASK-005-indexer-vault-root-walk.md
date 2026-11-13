# TASK-005 indexer-vault-root-walk

Objective: index from the vault root with un-prefixed relative keys, per the
layout contract in [PLAN-vault-layout.md](../PLAN-vault-layout.md).

Files: `packages/service/src/indexer.ts`, indexer specs.

Steps:
1. `listMarkdownFiles`: walk `vault.path` with `relDir = ''`; build relative
   keys without the `markdown/` prefix; keep skipping dotfiles, dot dirs
   (covers `.obsidian-mem/` and Obsidian's `.obsidian/`), and
   `isReservedNonIndexed` names at any level that are root-reserved by
   today's rule (keep behavior identical otherwise).
2. Watcher + `pollStats`: watch/stat the vault root instead of `markdownDir`;
   `onWatchEvent` prepends nothing.
3. `normalizeRel`: accept vault-relative or vault-absolute `.md` paths;
   reject any path with a dot-directory segment or a reserved name.
4. `saveState` mkdirp semantics: the parent is `metadataDir` (path already
   updated by TASK-002's helper); tmp + rename stay inside it.
5. Bump `INDEX_STATE_VERSION` 1 → 2 (documented reason: relative-key layout
   change; forces one full re-embed, stale `markdown/…` keys purge through
   the existing per-file stale-delete).
6. Remove leftover `markdownDir` imports.

Definition of Done: indexer specs pin root-relative keys, `.obsidian-mem`
never watched/indexed, version-bump rebuild path; `pnpm build` clean; emit
committed with the change.

Depends on: TASK-004.
