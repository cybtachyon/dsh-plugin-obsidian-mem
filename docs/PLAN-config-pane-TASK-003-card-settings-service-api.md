# TASK-003: card-settings-service-api

The service surface the card will drive: read the settings view, apply a
validated patch, reset overrides.

## Scope

- `packages/service/src/service.ts` public methods (keep them sync except the
  documented waits):
  - `cardSettings(): CardSettingsView` — sync, never provisions. Shape:
    `{ settings: CardEditableConfig, overrides: Partial<CardEditableConfig>,
       restartPending: string[] }` where
    - `settings` = the PERSISTED effective view (current in-process config
      merged with the stored overrides, paths home-expanded): the values the
      card edits and displays,
    - `overrides` = exactly the whitelisted keys the card has set (so the UI
      can badge "custom" and per-key reset),
    - `restartPending` = whitelisted dot-paths whose persisted value differs
      from the in-process `this.config` value (today: `milvus.dbPath` after a
      change; a plain deep-diff, no key allow-list needed).
  - `updateCardSettings(patch: { set: Partial<CardEditableConfig>, unset?: string[] }): CardSettingsView`
    — validates `set` against the whitelist and value types by deep-merging
    into a draft and running `validateObsidianMemConfig` (issues throw with
    the joined messages; the route maps them to 400), removes `unset` dot-paths
    from the stored overrides, persists atomically, then runs the
    live-apply escalation from TASK-004 and answers the fresh view.
  - `resetCardSettings(): CardSettingsView` — clears all stored overrides
    (writes `{ version, overrides: {} }`), re-escalates back to the row
    config values, answers the fresh view.
  - `CardEditableConfig` type (nested partial-friendly) exported from
    `config.ts` next to the whitelist.
- `milvus.dbPath` special effect: when an applied patch (or reset) changes
  the persisted dbPath, copy the current `vaults.json` into the NEW state dir
  (`dbStateDir(newDbPath)`) best-effort so card-registered vaults survive the
  next host start; the override file itself stays anchored (TASK-002).
- `status()` unchanged (the Configuration pane fetches
  `GET /obsidian-mem/settings`; no status shape churn).
- Tests: view shape and restartPending flip on a dbPath change; patch
  validation rejections (bad vectorDim enum, negative budget, unknown key,
  `unset` of a non-whitelist path); reset returns to row values; vaults.json
  copy lands in the new dir.

## Definition of Done

- Tests green; `pnpm build` emit in the same commit; tree clean after a
  second build.

## Dependencies

TASK-002 (override store + whitelist). Live-apply bodies may be stubbed with
a TODO seam if TASK-004 lands after; keep the call site single.
