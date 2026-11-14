# PLAN-git-versioning: Git versioning for shared memory vaults

Objective: shared vaults become git repositories (porting the
dsh-plugin-engramory-ext git design), a card checkbox "Use Git to version
shared vaults" (default on) gates git commits created at the end of the
`memory_write` and `memory_dream` processes, git-based churn tracking feeds
the dream prompt (`{{CHURN_THRESHOLD_PERCENT}}`, `{{CHURN_WINDOW_COMMITS}}`)
and the audit, the turn-end reminder is removed while the memory-tool watch
stays, and `memory_audit` gains a `checkpoint` view.

The user's prepared prompts are the source of truth and MUST NOT be
modified: `packages/tools/src/prompt.ts` (system section),
`packages/tools/src/audit.ts` `AUDIT_CHECKPOINT_PROMPT_SECTION_TEXT`, and
`packages/service/src/dream.ts` `DEFAULT_DREAM_PROMPT` (Step 0 pre-sync,
Step 4 churn stressors). All other code conforms to these prompts.
These three files currently carry uncommitted working-tree edits; they are
committed as part of TASK-001's baseline commit, unchanged.

## Verification guidelines

- Repo rules in AGENTS.md apply unchanged (lib IS tracked: src edit plus its
  `pnpm build` emit commit in the SAME commit; second build leaves the tree
  clean).
- Gate per task: targeted `pnpm vitest run` for the touched package, then
  before each commit `prek run --files <paths>`, `git status --porcelain`
  immediately before `git commit`, `git show --stat HEAD` immediately after
  (concurrent-session index hygiene).
- Gate at the end: `pnpm build`, `pnpm test`, `pnpm test:coverage` (floors
  lines 85 / functions 85 / branches 78 / statements 85), `pnpm lint`.
- No network, no real remote in tests: git tests script a fake `GitRunner`
  plus one real-binary integration spec over a temp dir.
- Host-side behavior (service/events/tools) is verified by tests, not by
  live host reload; live verification belongs to the user's host restart.

## Questionnaire answers (resolved 2026-11-13)

- Q1 (turn-end steer): **Remove the whole steer.** No
  `agent/turn-stopping` listener remains; over-budget remedies live in
  `memory_audit`, `memory_dream`, and the card. The memory-tool watch
  stays.
- Q2 (churn surfaces): **Audit rows + audit git rollup.** `memory_audit`
  note rows carry a churn fraction plus a per-shared-vault git status
  rollup; the dream agent reaches stressors via the audit in Step 4 (the
  reference plugin's pattern). No pre-computed work-plan stressor lines.
- Q3 (commit granularity): **Per write + per dream.** One commit per
  successful `memory_write` (touched vault, serialized per vault) plus
  one when a dream run finishes. No debounce machinery.
- Q4 (churn knobs): **Defaults 50% / 8 commits, card-editable too.**
  `git.churnThresholdPercent` and `git.churnWindowCommits` join the
  config `git` group, `CARD_SETTINGS_KEYS`, and the Configuration pane
  as number rows; the core constants are the defaults only.

## Micro-tasks

### Phase A: core domain (pure, framework-free)

 - [x] [TASK-001-core-memory-git](docs/PLAN-git-versioning-TASK-001-core-memory-git.md)
 - [x] [TASK-002-core-churn-constants](docs/PLAN-git-versioning-TASK-002-core-churn-constants.md)
 - [x] [TASK-003-config-git-group](docs/PLAN-git-versioning-TASK-003-config-git-group.md)

### Phase B: service git seam

 - [x] [TASK-004-service-vault-git-manager](docs/PLAN-git-versioning-TASK-004-service-vault-git-manager.md)
 - [x] [TASK-005-write-commit](docs/PLAN-git-versioning-TASK-005-write-commit.md)
 - [x] [TASK-006-dream-commit-and-churn-tunables](docs/PLAN-git-versioning-TASK-006-dream-commit-and-churn-tunables.md)
 - [x] [TASK-007-refactor-phase-ab](docs/PLAN-git-versioning-TASK-007-refactor-phase-ab.md)

### Phase C: audit checkpoint view + churn surfacing

 - [ ] [TASK-008-audit-service-churn-checkpoint](docs/PLAN-git-versioning-TASK-008-audit-service-churn-checkpoint.md)
 - [ ] [TASK-009-audit-tool-checkpoint](docs/PLAN-git-versioning-TASK-009-audit-tool-checkpoint.md)

### Phase D: events

 - [ ] [TASK-010-turn-end-reminder-removal](docs/PLAN-git-versioning-TASK-010-turn-end-reminder-removal.md)

### Phase E: card + docs

 - [ ] [TASK-011-client-git-toggle](docs/PLAN-git-versioning-TASK-011-client-git-toggle.md)
 - [ ] [TASK-012-docs-readme-agents](docs/PLAN-git-versioning-TASK-012-docs-readme-agents.md)
 - [ ] [TASK-013-refactor-phase-cde](docs/PLAN-git-versioning-TASK-013-refactor-phase-cde.md)

### Phase F: whole-repo verification

 - [ ] [TASK-014-full-suite-verify](docs/PLAN-git-versioning-TASK-014-full-suite-verify.md)

## Task dependencies

- TASK-001, TASK-002: independent (core only); both precede TASK-004.
- TASK-003: independent of 001/002; precedes 004, 006, 008, 011.
- TASK-004 depends on 001, 002, 003; precedes 005, 006, 008.
- TASK-005 depends on 004. TASK-006 depends on 004 (and 002/003).
- TASK-007 reviews TASK-001..006.
- TASK-008 depends on 004, 006. TASK-009 depends on 008.
- TASK-010 depends on nothing but lands after 009 (tool surface settled).
- TASK-011 depends on 003 (config path names) and the Q4 answer.
- TASK-012 depends on 009, 010, 011 (documents the final surfaces).
- TASK-013 reviews TASK-008..012. TASK-014 depends on everything.
