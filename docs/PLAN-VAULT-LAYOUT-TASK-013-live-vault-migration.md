# TASK-013 live-vault-migration

Objective: the live vault at the QUESTIONNAIRE-CONFIRMED path (default
assumption `$HOME/.dsh/obsidian-mem`) matches the new layout, with no data
loss.

Steps (verify each resolved absolute target before any move; nothing here
deletes content):
1. Pre-flight: `ls -la` the vault root, `markdown/`, `metadata/`; check for
   name collisions between `markdown/*` (including dotfiles) and the vault
   root; record the note file count before and after.
2. `models/` → `$HOME/.dsh/obsidian-mem-db/models/` (create the target; the
   embedder cache must survive so no model re-download).
3. `markdown/*` (incl. hidden files) → vault root; then remove the now-empty
   `markdown/` dir.
4. `metadata/` → `.obsidian-mem/metadata/` (create `.obsidian-mem/`).
5. `DREAMS.md` → `.obsidian-mem/metadata/DREAMS.md`.
6. Leave `<vault>/GLOBAL.md` where the move puts it (vault root); no rename.
7. Do NOT touch `$HOME/.dsh/obsidian-mem-db/state/`.
8. Post-flight tree listing + note-count equality as evidence.
9. Report to the parent: the running host still holds the OLD code in memory;
   the user must restart the host (profile installs load `lib` at startup),
   then `INDEX_STATE_VERSION` 1→2 forces one full re-embed with the old
   `markdown/…` keys purged; final verification is a `memory_audit` +
   `memory_search` round after the restart (parent schedules it).

Definition of Done: post-flight tree matches the PLAN "Target layout"; counts
match; no deletions. (If the Questionnaire chose a committed script instead,
this task ships `scripts/migrate-vault-layout.mjs` with the steps above as an
idempotent tool and runs it against the live vault.)

Depends on: TASK-012, Questionnaire Q1/Q4 answers.
