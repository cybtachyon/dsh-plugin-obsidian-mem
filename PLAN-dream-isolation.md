# PLAN-dream-isolation

Objective: during a dream run (tool `memory_dream` op `run` and the card's
Run Dream button; both converge on `DreamOrchestrator.drive()` and its single
`agents.create` launch), the dream agent and every session in its lineage
must receive no obsidian-mem recall injection, and the dream agent session
must carry no deployment system prompt or session runtime context. Its only
session context is the launch text: the add-on-owned `dream-prompt.md` and
the work plan. All other sessions, concurrent or later, keep the default
recall behavior. The user's staged verbiage tweaks to the launch heading
("Work plan for Step 1 of this run") ship as the first commit.

# Verification guidelines

- Host-side packages (service, events, ui, tools) need a host restart to go
  live; unit tests plus `pnpm build` gates prove the code, not the running
  host. Do not restart the host from this session (it hosts the GUI session
  doing this work).
- `packages/service/{src,lib}/dream.ts|js` is a prepared-prompt carrier: any
  src edit requires `pnpm build` and the lib emit committed in the same
  commit; `scripts/verify-emit.mjs` fails on byte drift.
- `packages/service/tests/dream.spec.ts` asserts the `recorder.created`
  entries with exact object equality; a new `create()` option must be added
  to those expectations.
- `dreamLineage` registry state is live-only, like `turnRecallTokensUsed`:
  never serialized into `PersistedSession`.

# Open questions

See the Questionnaire section; answers are persisted here after Step 4.

# Micro-tasks

## Phase 1: Launch-side isolation (service)

 - [x] [TASK-001-verbiage-carrier-rebuild](docs/PLAN-dream-isolation-TASK-001-verbiage-carrier-rebuild.md)
 - [x] [TASK-002-dream-complete-prompt-setup](docs/PLAN-dream-isolation-TASK-002-dream-complete-prompt-setup.md)

## Phase 2: Dream-lineage recall suppression (events)

 - [x] [TASK-003-registry-dream-lineage-flag](docs/PLAN-dream-isolation-TASK-003-registry-dream-lineage-flag.md)
 - [x] [TASK-004-created-handler-lineage](docs/PLAN-dream-isolation-TASK-004-created-handler-lineage.md)
 - [x] [TASK-005-read-intercept-lineage-gate](docs/PLAN-dream-isolation-TASK-005-read-intercept-lineage-gate.md)
 - [ ] [TASK-006-launch-window-suppression](docs/PLAN-dream-isolation-TASK-006-launch-window-suppression.md)

## Phase 3: Refactor and whole-repo verification

 - [ ] [TASK-007-refactor-smell-pass](docs/PLAN-dream-isolation-TASK-007-refactor-smell-pass.md)
 - [ ] [TASK-008-whole-repo-verification](docs/PLAN-dream-isolation-TASK-008-whole-repo-verification.md)

# Task dependencies

- TASK-001: independent (ships the already-staged user edits).
- TASK-002: independent of Phase 2 (service package only).
- TASK-004: depends on TASK-003 (uses the registry flag and accessor).
- TASK-005: depends on TASK-003 (reads `registry.isDreamLineage`).
- TASK-006: depends on TASK-003 and TASK-005 (extends the record and the
  read-intercept gate to the combined rule).
- TASK-007: after TASK-001 through TASK-006.
- TASK-008: after TASK-007.

# Questionnaire answers

- Q1 Suppression scope: the dream-lineage sessions AND, while a run is in
  flight, the agent session that launched it through `memory_dream`
  (TASK-006). Card Run Dream and scheduled triggers have no launching
  session; unrelated concurrent sessions keep default recall.
- Q2 Dream system prompt: scoped complete section with EMPTY text; the
  rendered system prompt is empty. A one-line pointer is the contingency
  only if a live provider adapter rejects the empty prompt.
- Q3 Runtime context: also call `suppressRuntimeContext()` on the dream
  agent scope in the same setup.
- Q4 Live verification: the USER restarts the host and runs Run Dream once
  afterward (checking the transcript for an empty system prompt and no
  `<recalled_memory>` blocks). This session finishes at unit/build gates;
  the final report includes the live-verification checklist.
