# PLAN-budget-reminder

Objective: move the global memory budget reminder from turn-start injection
to the turn-end steer (alongside the memory_write save/audit reminder), fire
it only for root agents, and reword it to (1) instruct the agent to manually
compact just the global memory WITHOUT starting until the user approves, and
(2) suggest the user run the much-heavier `memory_dream` for a more complete
optimization.

Baseline facts (verified 2026-11-12):

- The reminder today rides turn-start (`packages/events/src/turnStart.ts`,
  the `isGlobalBudgetSpent` branch) and injects `compactionInstruction()`
  (`packages/events/src/budget.ts`) naming only `memory_dream`.
- The turn-end save/audit reminder rides `agent/turn-stopping` via
  `installTurnEnd` (`packages/events/src/turnEnd.ts`), steers once per turn,
  and already skips subagent sessions (`registry.isSubagent`), memory-tool
  turns, and trivial turns. Root-agent-only therefore comes free by riding
  this channel.
- `packages/events/tests/turnStart.spec.ts` ("global memory budget switch")
  snapshots the old turn-start pointer; `packages/events/tests/turnEnd.spec.ts`
  snapshots the byte-exact checklist for the not-over case.

## Verification guidelines

- Record a baseline: run `pnpm test` once BEFORE the first edit and keep the
  output; a pre-existing failure is never claimed or blamed.
- Final gates for every code task: `pnpm build`, `pnpm lint`, `pnpm test`
  (coverage thresholds in vitest.config.ts), `prek run --files <staged paths>`.
- lib IS tracked: a `packages/*/src` edit is not done until `pnpm build` ran
  and the matching `packages/*/lib` emit is committed IN THE SAME COMMIT; a
  second `pnpm build` must leave `git status --porcelain` empty.
- Commit messages must pass the repo commit-msg attribution hook (no
  assistant-attribution wording).
- Full build/test/lint commands are authoritative in AGENTS.md; do not
  restate them elsewhere.

## Open questions (answers land here as they arrive)

1. Q-SUPPRESSION: While over budget, does turn-start recall stay suppressed
   (only the reminder text moves to turn-end), or does the suppression gate
   also go away (recall keeps flowing when over budget)?
   - Answer: **Keep suppression.** The over-budget turn-start branch still
     returns early (no recall, no pinned injection); only the reminder
     injection and its import are removed.
2. Q-PIGGYBACK: Does the budget section fire strictly alongside the
   save/audit reminder, inheriting its skips (subagent, memory-tool-used
   turn, trivial turn), or should it bypass the memory-tool and trivial-turn
   skips and only inherit the subagent skip?
   - Answer: **Full piggyback.** One steer per turn carries both texts; the
     existing skips are inherited unchanged; no separate steer path.
3. Q-WORDING-SCOPE: Do the audit `budget.over` remediation, the dream plan
   text, and the tools renderers keep their current "run memory_dream"
   wording, or should they be aligned to the new manual-plus-suggestion
   story in this change too?
   - Answer: **Align all budget sentences.** The audit `budget.over`
     remediation (service), the dream plan-text over-budget lines (service),
     and the tools renderers (audit/dream) all move to the two-part story:
     manual compaction of just the global memory pending user approval,
     plus the suggestion that the user can run the heavier `memory_dream`
     for a more complete optimization. Tracked as TASK-006/TASK-007.

## Micro-tasks

Task bodies live in the linked files. Execute top to bottom.

### Phase 1: behavior change

- [ ] [TASK-001-reminder-text](docs/PLAN-budget-reminder-TASK-001-reminder-text.md)
- [ ] [TASK-002-turnstart-drop-pointer](docs/PLAN-budget-reminder-TASK-002-turnstart-drop-pointer.md)
- [ ] [TASK-003-turnend-budget-section](docs/PLAN-budget-reminder-TASK-003-turnend-budget-section.md)

### Phase 2: tests

- [ ] [TASK-004-turnstart-specs](docs/PLAN-budget-reminder-TASK-004-turnstart-specs.md)
- [ ] [TASK-005-turnend-specs](docs/PLAN-budget-reminder-TASK-005-turnend-specs.md)

### Phase 2b: budget-sentence alignment (service + tools, per Q-WORDING-SCOPE)

- [ ] [TASK-006-budget-sentences](docs/PLAN-budget-reminder-TASK-006-budget-sentences.md)
- [ ] [TASK-007-sentence-specs](docs/PLAN-budget-reminder-TASK-007-sentence-specs.md)

### Phase 3: refactor and verification

- [ ] [TASK-008-refactor-review](docs/PLAN-budget-reminder-TASK-008-refactor-review.md)
- [ ] [TASK-009-docs-verify](docs/PLAN-budget-reminder-TASK-009-docs-verify.md)

## Task dependencies

- TASK-001 → TASK-003, TASK-004, TASK-005, TASK-006 (text story reused)
- TASK-002 → TASK-004
- TASK-003 → TASK-005
- TASK-006 → TASK-007
- TASK-001..007 → TASK-008 → TASK-009
- Q-SUPPRESSION gates TASK-002 + TASK-004; Q-PIGGYBACK gates TASK-003 +
  TASK-005; Q-WORDING-SCOPE gates TASK-006 + TASK-007 + TASK-009.
