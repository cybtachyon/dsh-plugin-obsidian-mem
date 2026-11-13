# PLAN-vault-layout

Objective: move the plugin's on-disk storage to a new layout (notes at the
vault root, `.obsidian-mem/metadata/` sidecars, model cache under the Milvus
db dir), add a per-vault "global memory relative file path" settings-card
field defaulting to `GLOBAL.md`, keep every quality gate green, and apply the
layout migration to the live vault at `$HOME/.dsh/obsidian-mem`.

## Target layout (single source of truth for every task)

```
<vault>/                            # registered vault root IS the indexed note root
  <note>.md                         # indexed: every *.md, recursive
  <slug>_history.md                 # reserved suffix, never indexed (unchanged)
  .INTENTS.md                       # reserved root file, never indexed (unchanged)
  .obsidian-mem/                    # plugin-internal dir, never indexed (dot-dir rule)
    metadata/
      DREAMS.md                     # dream diary  (was <vault>/DREAMS.md)
      obsidian-mem-state.json       # indexer state (was <vault>/metadata/)

$HOME/.dsh/obsidian-mem-db/         # dbDir(homedir), unchanged base
  models/                           # transformers.js cache (was <default vault>/models/)
  state/                            # vaults.json, relevancy.json, dream state (unchanged)
```

Removed from the layout: `<vault>/markdown/` (notes live at the vault root)
and `<vault>/metadata/` (renamed into `.obsidian-mem/metadata/`).

Config model change: every vault entry (row config `config.vaults`, card
`POST /obsidian-mem/vaults`, persisted `state/vaults.json`, card registry
rows) gains `globalFile: string` — the path, relative to the vault root, of
that vault's global memory file. Blank/omitted defaults to `GLOBAL.md`.
Behavior contract (questionnaire Q3/Q3b): the service exposes the shared
vaults' global memory contents; turn-start injection pins that content into
the session (budget-bounded by `budgets.globalMemoryTokens`, marked injected
so per-session search recall skips it); the dreaming pass never proposes the
named file for compaction or merging (the file remains an ordinary editable,
indexable note otherwise).

Index-state contract: `INDEX_STATE_VERSION` bumps 1 → 2 so every vault
re-embeds once under the new relative keys (old `markdown/…` state keys are
purged through the existing stale-file delete path).

## Verification guidelines

- Gates follow AGENTS.md "Testing Instructions" (build, test, coverage, lint,
  prek); do not restate them here. A task is not done while a gate it touched
  is red.
- `packages/*/lib` and `dsh/client.js` are tracked: each code task commits its
  matching emit in the same commit; a second `pnpm build` must leave
  `git status --porcelain` empty.
- Disk-layout claims are verified with directory listings, not assertions.
- Host-side behavior needs a host restart to load new `lib`; the final task
  hands that restart to the user and verifies afterwards with `memory_audit`.

## Open questions (answers written below as they arrive)

- Q1: The request names the live vault `$HOME/derek.dsh/obsidian-mem`, which
  does not exist; the provisioned vault is `$HOME/.dsh/obsidian-mem`. Treat
  `$HOME/.dsh/obsidian-mem` as the migration target?
- Q2: Are `/.obsidian-mem/metadata/` and the DREAMS.md target vault-root
  relative (`<vault>/.obsidian-mem/metadata/`) rather than `$HOME`-relative?
- Q3: How deep is `globalFile` wired this release: stored/defaulted/persisted
  and shown in the card only, or does it also drive behavior (e.g. protect the
  named file from dream compaction)?
- Q4: Live-vault migration: one-off shell moves run now by this session, or a
  committed migration script shipped in the plugin (or auto-migrate at
  provisioning)?
- Q5: Re-indexing after the move: accept the `INDEX_STATE_VERSION` bump (full
  re-embed once), or hand-migrate the state keys?

Answers (2026-11-12 questionnaire):
- Q1: migration target is `$HOME/.dsh/obsidian-mem` ("derek.dsh" was a typo).
- Q2: `.obsidian-mem/metadata/` is vault-root relative; every vault owns its
  sidecars.
- Q3: `globalFile` is stored, defaulted, persisted, displayed AND protected
  from dream compaction. Verified against `turnStart.ts`: today NOTHING
  pins-injects a file at session start (recall is search-ranked only), and
  the user confirmed follow-up Q3b: this release also adds pinned
  session-start injection of each shared vault's `globalFile` within the
  global memory budget (TASK-014, TASK-015).
- Q4: one-off shell moves run by this session; nothing ships in the package.
- Q5: bump `INDEX_STATE_VERSION` 1 → 2; one full re-embed, no state-key
  surgery.

## Task index

Ordered list; every task is defined in its own file.

### Phase 1 — Layout model (core + config schema)
 - [x] [TASK-001-core-layout-constants](docs/PLAN-VAULT-LAYOUT-TASK-001-core-layout-constants.md)
 - [ ] [TASK-002-core-vault-registry-model](docs/PLAN-VAULT-LAYOUT-TASK-002-core-vault-registry-model.md)
 - [ ] [TASK-003-service-config-global-file](docs/PLAN-VAULT-LAYOUT-TASK-003-service-config-global-file.md)
 - [ ] [Refactor: Phase 1 review](docs/PLAN-VAULT-LAYOUT-TASK-R1-refactor-phase-1.md)

### Phase 2 — Service runtime
 - [ ] [TASK-004-service-provisioning-registry](docs/PLAN-VAULT-LAYOUT-TASK-004-service-provisioning-registry.md)
 - [ ] [TASK-005-indexer-vault-root-walk](docs/PLAN-VAULT-LAYOUT-TASK-005-indexer-vault-root-walk.md)
 - [ ] [TASK-006-dream-diary-location](docs/PLAN-VAULT-LAYOUT-TASK-006-dream-diary-location.md)
 - [ ] [TASK-007-audit-inventory-layout](docs/PLAN-VAULT-LAYOUT-TASK-007-audit-inventory-layout.md)
 - [ ] [Refactor: Phase 2 review](docs/PLAN-VAULT-LAYOUT-TASK-R2-refactor-phase-2.md)
 - [ ] [TASK-016-cordis-mount-isolation](docs/PLAN-VAULT-LAYOUT-TASK-016-cordis-mount-isolation.md)

### Phase 3 — Surfaces (tools, injection, routes, card)
 - [ ] [TASK-008-tools-wording-guards](docs/PLAN-VAULT-LAYOUT-TASK-008-tools-wording-guards.md)
 - [ ] [TASK-014-global-memory-injection](docs/PLAN-VAULT-LAYOUT-TASK-014-global-memory-injection.md)
 - [ ] [TASK-015-global-file-compaction-protect](docs/PLAN-VAULT-LAYOUT-TASK-015-global-file-compaction-protect.md)
 - [ ] [TASK-009-ui-route-global-file](docs/PLAN-VAULT-LAYOUT-TASK-009-ui-route-global-file.md)
 - [ ] [TASK-010-client-card-global-file](docs/PLAN-VAULT-LAYOUT-TASK-010-client-card-global-file.md)
 - [ ] [Refactor: Phase 3 review](docs/PLAN-VAULT-LAYOUT-TASK-R3-refactor-phase-3.md)

### Phase 4 — Ship
 - [ ] [TASK-011-docs-layout-wording](docs/PLAN-VAULT-LAYOUT-TASK-011-docs-layout-wording.md)
 - [ ] [TASK-012-full-quality-gate](docs/PLAN-VAULT-LAYOUT-TASK-012-full-quality-gate.md)
 - [ ] [TASK-013-live-vault-migration](docs/PLAN-VAULT-LAYOUT-TASK-013-live-vault-migration.md)

## Dependencies

- TASK-001 → TASK-002 → TASK-003 → R1 → TASK-004 → TASK-005 → TASK-006 →
  TASK-007 → R2 → TASK-016 → TASK-008 → TASK-014 → TASK-015 → TASK-009 →
  TASK-010 → R3 → TASK-011 → TASK-012 → TASK-013.
- All phases depend on the Questionnaire answers above being recorded.
