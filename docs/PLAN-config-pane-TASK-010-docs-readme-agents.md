# TASK-010: docs-readme-agents

Update the user-facing README Configuration section and the AGENTS.md
architecture bullets to match what now exists (the "is it complete?"
question is settled by the shipped feature: all README knobs are wired).

## Scope

- `README.md` "Configuration" section, table rewritten to the real config
  paths and concrete defaults:
  - `vaults[]` (kept; note both card Vaults pane and row config manage it)
  - `vectorDim` — default `384`; `128/192/256/320` lossy; change = full
    re-index (card applies live)
  - `model.id` — default `Xenova/multilingual-e5-small`; change re-embeds
    every note (applies live)
  - `model.cacheDir` — default `$HOME/.dsh/obsidian-mem-db/models`;
    transformers.js cache; first use of a new dir re-downloads the model
  - `milvus.dbPath` — default `$HOME/.dsh/obsidian-mem-db`; change applies on
    the next host restart and rebuilds the index at the new location
  - `llm.enabled` / `llm.baseUrl` / `llm.model` / `llm.apiKeyEnv` — default
    off; OpenAI-compatible endpoint that augments wake-keyword extraction
    (applies live)
  - `budgets.*` (README `recallBudget` row, replace the "per plan" default
    with the real numbers): `turnStartRecallTokens` 1200,
    `globalMemoryTokens` 1500, `readSections` 2, `readSectionTokens` 350,
    `searchTopK` 6, `thinkShotsPerTurn` 3 (apply live)
  - A short paragraph: the card's Configuration pane edits and persists
    these under the plugin state dir; card values override the same keys in
    the profile row config; "Reset all to profile settings" clears them.
- `AGENTS.md`:
  - ui bullet: add the settings routes to the route list description.
  - service bullet: mention the settings-override file merged over row config
    (card values win per key).
  - core layout note: settings.json lives under `<default dbDir>/state/`
    regardless of a custom `milvus.dbPath` (bootstrap anchor).
- Keep every statement the single source of truth; no duplication between
  README and AGENTS (README = user behavior, AGENTS = build/architecture).

## Definition of Done

- Both files read consistently with the shipped code (verify each claim
  against source before finalizing).
- Committed with the docs-only change (no lib churn).

## Dependencies

All implementation tasks (001-009); wording must match final behavior.
