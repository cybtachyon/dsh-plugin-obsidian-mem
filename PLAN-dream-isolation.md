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
- Import-extension convention (recurring subagent error, user-flagged):
  the SOURCE tier (`packages/*/src`, compiled by `tsc -b` under NodeNext)
  must use `.js` specifiers for every relative import; a `.ts` specifier
  there is a TS5097-class build break. The TESTS tier (`packages/*/tests`)
  deliberately uses `.ts` specifiers (vitest resolves them literally; the
  throwaway `tsconfig.testscheck.json` recipe types them with
  `allowImportingTsExtensions`); do not churn those to `.js`. Verification
  grep (must print nothing): `grep -rn "from '\.\{1,2\}/[^']*\.tsx\?'"
  packages/*/src`. Every new or touched file also gets the repo's other
  gates (`pnpm build`, `pnpm test`, `pnpm lint`).

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
 - [x] [TASK-006-launch-window-suppression](docs/PLAN-dream-isolation-TASK-006-launch-window-suppression.md)

## Phase 3: Refactor and whole-repo verification

 - [x] [TASK-007-refactor-smell-pass](docs/PLAN-dream-isolation-TASK-007-refactor-smell-pass.md)
 - [x] [TASK-008-whole-repo-verification](docs/PLAN-dream-isolation-TASK-008-whole-repo-verification.md)

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

# Results

## TASK-007 refactor-smell-pass

Reviewed the six task commits (2f5c22d, 4814064, a3283c0, db6a888, e50f436,
d8b1ccb) plus the adjacent a863357 user verbiage commit and the a095679
test-tree fix: the events src tier (sessions.ts, index.ts, host.ts,
readIntercept.ts, thinkIntercept.ts, turnStart.ts, toolkit.ts,
dreamLaunch.ts), the service src tier (dream.ts, service.ts), and the
service/events test tiers. One risk resolved in code; the rest adjudicated
below.

- Multiple Sources of Truth: RESOLVED (the one code fix). The full
  `recorder.created` exact-equality entry (sessionId, agentOptions pair,
  meta.cwd, `setup: expect.any(Function)`) was restated five times across
  dream.spec.ts (4 pins) and service.spec.ts (1 pin). It now has one home,
  `createdEntry()` in packages/service/tests/dream-testkit.ts, so a future
  `create()` option is added once. Verified clean elsewhere: the lineage
  rule lives only in the index.ts agent/created handler, the dream- id
  prefix travels as the shared core DREAM_SESSION_PREFIX (dream.ts builds
  the id from the same constant), the combined gate has its one
  `isRecallSuppressed` home with three thin call sites, and the busy answer
  is the orchestrator's single `busy` getter read by
  `service.dreamRunBusy()`. WAIVED: the `'obsidian-mem:dream-prompt-complete'`
  literal restated in the dream.spec setup pin; the test deliberately pins
  the shipped section name, not the src constant.
- Duplicate Code: WAIVED (three findings). (1) dreamLaunch.ts repeats the
  six-line tools/result registration scaffold of writeLedger.ts
  (on + runGuarded + name/isError filter + agent-undefined guard); the
  bodies (value-shape guard, argument gate) share nothing, and the
  same-registration-shape convention is documented in both modules; a
  parameterized installer would add indirection without removing real
  logic. (2) Each events spec harness restates the ~25-line
  ctx/memory/registry/tempdir scaffold; that is the established per-spec
  test convention across all pre-existing specs. (3) The launch-window gate
  describes in the turnStart, thinkIntercept, and readIntercept specs are
  parallel but each binds to its own harness shape; no shareable body.
  The agent-override copy-paste bug class (fixed in e50f436) was audited
  across all sibling harnesses: writeLedger.spec and dreamLaunch.spec honor
  the override (`agent ?? default`), turnEnd.spec passes each caller
  explicitly, and the turnStart, thinkIntercept, and events harnesses emit
  their closure agent or build the second agent's payload by hand. No
  further occurrences.
- Bloaters: WAIVED. The agent/created handler, observeRead, and drive()
  each grew by a handful of sequential gate/option lines; none crossed
  into multi-responsibility.
- Data Clumps: RESOLVED where it mattered, WAIVED for the rest. TASK-006
  already extracted the {memory, registry} pair as `RecallSuppressionDeps`
  instead of widening three deps interfaces. The identical
  {ctx, registry, logger} triples of WriteLedgerDeps, MemoryToolWatchDeps,
  and DreamLaunchLedgerDeps stay separate: type-only, each name documents
  its observer's mount contract, and the per-observer pattern predates the
  plan.
- Shotgun Edits: WAIVED. TASK-006 touching eight src files is the shape of
  adding one rule at three distinct decision points; with
  `isRecallSuppressed` as the rule's single home, a future change to the
  rule is a one-function edit, and a new route is a one-line call.
- Feature Envy: WAIVED. The launch observer touches only
  `registry.markDreamLaunch`; `dreamRunBusy()` reading the private
  `dreamEngineValue` field directly is the documented deliberate shape
  (never constructs the engine on the hot recall path).
- Magic Numbers: WAIVED. No numeric literals were added to the reviewed
  src. The `'run'` and `'started'` literals in dreamLaunch.ts are the
  cross-package tool value protocol, restated as literals per the
  writeLedger `'written'` precedent; the tools package exports neither.
- Overengineering: WAIVED. `isRecallSuppressed` (two lines) plus its
  two-field deps interface is the point of the single-home gate;
  markDreamLaunch/isDreamLaunch mirror the isSubagent accessor pair; the
  structural guards in `dreamPromptIsolationSetup()` are the host-seam
  contract of Q2/Q3.
- Flagged, not touched (user verbiage): the DEFAULT_DREAM_PROMPT closing
  headline pair ("Proceed with Steps 0 - 4." / "Here is the work plan for
  Step 1:") from a863357 reads redundant next to the Step 0 heading. It is
  the user's own launch text; prompt-carrier text is out of scope for this
  pass.

Fix surface: three test-tier files (dream-testkit.ts, dream.spec.ts,
service.spec.ts); no src change, so no lib carrier rode the commit. Gates:
pnpm build green with verify-emit (3 prompt carriers byte-exact, tree
clean), full suite 1090 passed 2 skipped, pnpm lint green.
