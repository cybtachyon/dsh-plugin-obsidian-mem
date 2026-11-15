# TASK-005 — Model-facing contract and docs honesty

Context: the write path now confirms the file write and settles indexing and
git asynchronously. The `memory_write` contract still promises write-through
("write-through indexing ran for the note", `write_through: 'attempted'`).

Change (per Questionnaire answer 1; recommended: rename the const value):

1. `packages/tools/src/write.ts`:
   - Output schema + value type: `write_through` const `'attempted'` →
     `'queued'` (field name kept; the value now means "follow-up queued").
   - `WRITE_DESCRIPTION`: replace "queued for immediate indexing" phrasing
     with the honest contract: written atomically and confirmed; indexing and
     git commit settle asynchronously afterwards.
   - `renderWrite` success line: e.g. "Created/Updated memory note: <path>
     (vault <vault>; note confirmed on disk; indexing and git commit are
     settling in the background)."
   - `WRITE_TIMEOUT_MS` doc comment: the budget now bounds guards + the
     atomic write only (plus core provisioning on the process's first call).
   - The module `@module` header line about "applyWrite does the raw-merging
     atomic write plus write-through reindex" → async follow-ups.
2. README: the indexer bullet ("...write-through → purge pipeline") and any
   memory_write wording updated to the confirm-then-settle contract.
3. AGENTS.md: the `VaultGitManager` bullet's "commits once per successful
   applyWrite" sentence gains that the commit rides the async follow-up
   chain; no other prose churn.

Definition of Done:

- `pnpm build` green, lib carriers committed; the tools tests updated in
  TASK-006 are allowed to fail ONLY on the schema/const rename if they are
  not touched here (prefer touching them in TASK-006 in the next step).
