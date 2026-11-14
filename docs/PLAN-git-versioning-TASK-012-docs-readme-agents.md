# TASK-012-docs-readme-agents

Documentation for the shipped surfaces (no behavior change).

README.md:
- Configuration table: add the card-editable `git.enabled` (default
  true), `git.churnThresholdPercent` (default 50), and
  `git.churnWindowCommits` (default 8) rows with the same column style as
  the existing rows.
- A short "Git versioning" subsection: shared vaults become git repos
  (branch `main`, an initial commit adopts the store); `memory_write`
  commits the touched vault and a finished dream run commits every shared
  vault; the `.obsidian-mem/` sidecar and `.git` stay out of the history
  via the managed `.gitignore`; churn fractions come from the last
  `git.churnWindowCommits` (default 8) commits and flag notes edited in
  over `git.churnThresholdPercent` (default 50)% of them (the dream Step 4
  stressor rule; all three `git.*` leaves are card-editable); a remote is
  optional plugin-free git (`git remote add origin …` in the vault), and
  the dream agent's Step 0 pre-sync uses it when one exists.
- Usage section: `memory_audit` `view: "checkpoint"` (full rows + the
  completion-checkpoint instructions) is the end-of-work pass; note the
  turn-end steered reminder was removed.

AGENTS.md:
- Architecture: core gains the memory-git wrapper + churn math; service
  gains the per-shared-vault git manager with commits at write/dream end;
  tools: `memory_audit` checkpoint view; events: turn-end reminder row
  replaced by "the memory-tool watch only" (the DSH Event Facts
  `turn/end` bullet keeps its fact, the plugin-usage sentence updates).
- If AGENTS.md still cites the release-prep artifact count ("232"),
  refresh it to the current `verify-emit` count (264 as of TASK-015) or
  phrase it without a number.
- Dev Environment Tips: nothing new unless the build changed (it did not).

Do not touch the prepared prompt constants.

Definition of Done: prose reviewed against the shipped code (identifier
names verified by grep), files committed (docs-only, no lib).
