# TASK-007 audit-inventory-layout

Objective: `memory_audit`'s inventory speaks the new layout.

Files: `packages/service/src/audit.ts`, audit specs.

Steps:
1. `InventoryVault`: stat + walk the vault root instead of `markdownDir`;
   note inventory excludes dot dirs (covers `.obsidian-mem`) and
   `isReservedNonIndexed` names as before.
2. `measureUsage` root skip-list: drop `models` / `metadata` names; dot-dir
   rule already covers `.obsidian-mem`; keep excluding the model cache dir
   (now under dbDir) per the current comment.
3. Reserved-placement issue: reserved files sitting inside the note tree are
   flagged; DREAMS.md remediation text now says "move it to
   `.obsidian-mem/metadata/`" and `.INTENTS.md` stays a root file.
4. `no markdown/` issue: the "has no markdown/ directory" issue becomes
   "vault root has no indexed notes" wording (or drops if redundant); update
   the matching remediation.
5. Indexer-state reads and the model-cache check follow the updated
   `metadataDir` / `modelCacheDir` helpers automatically; adjust the
   strings that name the old paths.

Definition of Done: audit specs updated for root inventory, new remediation
wording, state path; `pnpm build` clean; emit committed with the change.

Depends on: TASK-006.
