# TASK-011 docs-layout-wording

Objective: user-facing docs match the new layout and the new card field.

Files: `README.md`, `AGENTS.md` (Architecture section only where it names
paths), any `docs/research/*` claims are left as historical (do not rewrite
history; append nothing).

Steps:
1. README vault-layout description: notes at the vault root,
   `.obsidian-mem/metadata/` (indexer state + DREAMS.md), model cache under
   `~/.dsh/obsidian-mem-db/models/`, reserved root files.
2. README settings-card section: document the "Global memory relative file
   path" field and the `GLOBAL.md` default; document `vaults[].globalFile`
   in the row-config sample if a sample exists.
3. AGENTS.md: update path wording that says notes live under `markdown/`.
4. Document the note-target contract pinned by TASK-008 (README usage
   section): a new note's path is `<vault>/<slug>.md` (or a subdirectory);
   the bare vault root as a directory target is refused.

Definition of Done: docs grep shows no claim that the plugin indexes a
`markdown/` subdir (research docs excepted); commit (no code touched).

Depends on: R3.
