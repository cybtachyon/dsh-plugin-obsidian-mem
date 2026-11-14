# PLAN-config-pane

Objective: add a "Configuration" details section below "Vaults" in the
Obsidian Mem client settings card, wiring every tunable knob from the
README Configuration table (card-editable, whitelisted, validated,
persisted to the plugin state dir, live-applied where safe), plus the one
missing feature the README promises (`modelCacheDir`) and matching
README/AGENTS docs.

## Verification guidelines

- Every src commit includes its `pnpm build` emit (`packages/*/lib` and
  `dsh/client.js` are tracked); a second `pnpm build` must leave
  `git status --porcelain` empty.
- Gates per AGENTS.md "Testing Instructions" (build, test, coverage
  thresholds, repo-wide lint, prek). Do not restate them elsewhere.
- Route handlers never throw to the wire: new endpoints answer the shared
  error envelope with stable codes.
- The card's `routes.spec.ts` contract test must stay green (it diffs the
  client route table against ui `ROUTES`).
- Live probes against `http://127.0.0.1:3080` per TASK-011; host-side
  changes are verified by host restart, never by page reload.
- Never log or persist an API key value; `llm.apiKeyEnv` is an env var NAME.

## Open questions (questionnaire; answers recorded below)

1. Precedence: card overrides beat the profile row config per key?
2. `milvus.dbPath`: persist + "restart to apply" chip, or live subsystem
   restart?
3. `budgets.thinkShotsPerTurn`: live via a SessionRegistry setter, or
   restart-only?
4. Card edit scope: exactly the README knobs, or also milvus mode/address/
   readinessTimeoutMs and model.dtype?
5. README Configuration table: rewrite to real config paths and concrete
   defaults?
6. End-to-end: restart the running DSH host during TASK-011 to verify the
   live card?

### Answers (2026-11-13)

1. Precedence: **card override wins** per key; "Reset all to profile
   settings" clears them.
2. `milvus.dbPath`: **persist + "restart to apply" chip**; no in-process
   subsystem restart.
3. `budgets.thinkShotsPerTurn`: **live via a SessionRegistry setter**
   (all budgets apply instantly).
4. Card scope: **exactly the README knobs**; milvus infra and model.dtype
   stay profile-config only.
5. README: **rewrite to real config paths** with concrete defaults and
   apply-semantics notes.
6. Live verify: **do not restart the host autonomously.** At TASK-011, ask
   the user to restart the host and send a continue message, then end the
   turn; continue verification after the restart.

## Task index

### Phase 1: settings domain (service + events)

 - [x] [TASK-001-model-cache-dir-knob](docs/PLAN-config-pane-TASK-001-model-cache-dir-knob.md)
 - [x] [TASK-002-settings-override-store](docs/PLAN-config-pane-TASK-002-settings-override-store.md)
 - [x] [TASK-003-card-settings-service-api](docs/PLAN-config-pane-TASK-003-card-settings-service-api.md)
 - [x] [TASK-004-live-apply-escalation](docs/PLAN-config-pane-TASK-004-live-apply-escalation.md)
 - [x] [TASK-005-refactor-phase-1](docs/PLAN-config-pane-TASK-005-refactor-phase-1.md)
 - [x] [TASK-012-fix-test-tier-type-errors](docs/PLAN-config-pane-TASK-012-fix-test-tier-type-errors.md)

### Phase 2: host routes

 - [ ] [TASK-006-config-routes](docs/PLAN-config-pane-TASK-006-config-routes.md)

### Phase 3: client card

 - [ ] [TASK-007-client-api-config](docs/PLAN-config-pane-TASK-007-client-api-config.md)
 - [ ] [TASK-008-configuration-section](docs/PLAN-config-pane-TASK-008-configuration-section.md)
 - [ ] [TASK-009-refactor-phase-2-3](docs/PLAN-config-pane-TASK-009-refactor-phase-2-3.md)

### Phase 4: docs and gates

 - [ ] [TASK-010-docs-readme-agents](docs/PLAN-config-pane-TASK-010-docs-readme-agents.md)
 - [ ] [TASK-011-gates-and-live-verify](docs/PLAN-config-pane-TASK-011-gates-and-live-verify.md)

## Dependencies

- TASK-001 → TASK-002 → TASK-003 → TASK-004 → TASK-005.
- TASK-012 (test-tier type debt, pre-existing) runs after TASK-005, before
  TASK-006; it is cleanup, not feature scope.
- TASK-006 needs TASK-003 (service surface).
- TASK-007 needs TASK-006 (ROUTES contract); TASK-008 needs TASK-007.
- TASK-009 follows TASK-006 through TASK-008.
- TASK-010 needs all implementation tasks; TASK-011 is last.
- Questionnaire answers bind TASK-002 (precedence), TASK-004 (dbPath,
  think-shots liveness), TASK-008 (scope), TASK-010 (README wording), and
  TASK-011 (restart consent).

## Design anchors (single sources of truth)

- Whitelist of card-editable config paths: `CARD_SETTINGS_KEYS` in
  `packages/service/src/config.ts` (service validation, route descriptions,
  and tests all read it).
- Override persistence: `<core stateDir(homedir())>/settings.json` (fixed
  anchor; survives a pending `milvus.dbPath` move). `vaults.json` keeps its
  dbPath-derived location and is copied forward on a dbPath change.
- Escalation classes and restart-pending semantics: TASK-004 file.
- Route/method vocabulary stays `GET | POST | DELETE` (no PUT on this host
  table): GET read, POST apply, DELETE reset.
