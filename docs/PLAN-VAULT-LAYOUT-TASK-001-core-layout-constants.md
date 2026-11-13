# TASK-001 core-layout-constants

Objective: make `packages/core/src/constants.ts` the single source for the new
storage layout defined in [PLAN-vault-layout.md](../PLAN-vault-layout.md)
"Target layout".

Files: `packages/core/src/constants.ts`, core constants specs.

Steps:
1. Drop `VAULT_MARKDOWN_DIR` (and every export/const that only existed for
   the removed `markdown/` dir). Note root == vault root; no helper needed.
2. Add `PLUGIN_VAULT_DIR = '.obsidian-mem'` and change `VAULT_METADATA_DIR`
   usage so `metadata` sits at `<vault>/.obsidian-mem/metadata` (the join
   itself moves in TASK-002; here define the two constants cleanly).
3. Change `modelCacheDir(homedir)` to `join(dbDir(homedir), MODELS_DIR)`.
4. Keep `DREAMS_FILE = 'DREAMS.md'` and keep `DREAMS.md` inside
   `RESERVED_NON_INDEXED` (belt-and-braces against a stray root copy).
5. Add `GLOBAL_MEMORY_FILE_DEFAULT = 'GLOBAL.md'`.
6. Update doc comments; update the core specs that pin old values/paths.

Definition of Done: `pnpm build` clean; core specs pass; no grep hit ties the
model cache to `defaultVaultPath`. Commit emit in the same commit.

Depends on: Questionnaire answers recorded.
