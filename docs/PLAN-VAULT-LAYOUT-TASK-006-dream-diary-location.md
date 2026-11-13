# TASK-006 dream-diary-location

Objective: DREAMS.md lives at `<vault>/.obsidian-mem/metadata/DREAMS.md`.

Files: `packages/service/src/dream.ts`, dream specs.

Steps:
1. Replace `join(first.vault.path, DREAMS_FILE)` with a path under
   `metadataDir(first.vault.path)` (add a small core or local helper if two
   call sites need it, so the diary path has one definition).
2. Ensure the diary append creates parent dirs if missing (provisioned older
   vaults won't have `.obsidian-mem/metadata/` until migrated; the move of
   existing DREAMS.md files belongs to TASK-013, not here).
3. Update the dream prompt/doc wording that says "DREAMS.md at the first
   shared vault root".
4. Re-root `packages/service/tests/dream.spec.ts` fixtures that seed
   `${vault}/markdown/…` note paths (left by TASK-005's audit) to vault-root
   relative notes.

Definition of Done: dream specs pin the new diary path and parent-creation;
`pnpm build` clean; emit committed with the change.

Depends on: TASK-005.
