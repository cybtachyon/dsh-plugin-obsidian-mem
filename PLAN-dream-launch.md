# PLAN: dream-launch — make memory_dream run actually launch a working dream agent

The `memory_dream` `run` operation launches a `dream-<uuid>` session through
`ctx.get('agents').create()` with no `agentOptions`, so `agent.options.model`
is undefined; the deployment persona's `{{model}}` interpolation then throws
during first prompt assembly. Agent-loop contains the turn error, `whenIdle()`
resolves, and the orchestrator records the dead run as success (stamping
`lastDreamAt`). All eight dream sessions since 2026-11-08 died this way
(`~/.dsh/sessions/_no-cwd/dream-*/session.v4.jsonl.zstd`, final record
`turn/end` with `reason.kind === "error"`). This plan fixes the launch to
pass a resolved `AgentOptions`, makes failed turns fail the run honestly, and
surfaces the failure in the card.

## Verification guidelines

- Repo gates per AGENTS.md: `pnpm build`, `pnpm test`, `pnpm lint`;
  `prek run --files <paths>` before each commit.
- The plugin profile install at `~/.dsh/profiles/web/node_modules/dsh-plugin-obsidian-mem`
  is a symlink to this repo, so `pnpm build` plus a host restart ships host
  changes. **Never restart the host from inside this session** (the session
  runs in that host process); live verification is a user action after the
  final commit: restart `dsh web`, click Run on the Obsidian Mem card, then
  confirm the newest `dream-*` transcript contains `assistant/message`
  records and `memory_*` tool calls.
- Transcripts are the behavioral truth: `zstd -dc <session.v4.jsonl.zstd>`.
- Do not type-import agents internals; the `agents` and `agentDefaultModel`
  services stay reflection-gateway seams (`ctx.get`), matching the existing
  `agentsGateway` pattern.

## Decisions (questionnaire closed)

- Resolution order for the dream agent model: per-run `model` override →
  `config.dreaming.model` (finally consumed, closing its stale-comment
  promise) → host `ctx.get('agentDefaultModel').currentSelection()` (the
  `dsh-headless` pattern). `provider` comes only from the host selection;
  model overrides replace the model id, never the provider route.
- A run whose provider+model pair cannot be resolved is `dream_blocked`
  before launch (`blockedReason()` grows this reason; the card's Run button
  already disables on `blocked` and shows the banner).
- Failed runs reject `done`, set `DreamRunSummary.error`, and must NOT stamp
  `lastDreamAt` or run the relevancy post-pass (already true for throws; the
  new failed-turn detection must throw before them).
- Failed-turn detection is deterministic session-log inspection between
  `whenIdle()` and the post-pass: any `turn/end` with
  `data.reason.kind === 'error'` fails the run. No new host event
  subscriptions (agent-scoped events never reach plugin-ctx listeners).

## Task index

### Phase A: launch with resolved AgentOptions

- [x] [TASK-001-dream-agent-options-resolution](docs/PLAN-dream-launch-TASK-001-dream-agent-options-resolution.md)
- [ ] [TASK-002-default-model-gateway-wiring](docs/PLAN-dream-launch-TASK-002-default-model-gateway-wiring.md)

### Phase B: honest run outcomes

- [ ] [TASK-003-failed-turn-detection](docs/PLAN-dream-launch-TASK-003-failed-turn-detection.md)
- [ ] [TASK-004-card-last-run-error](docs/PLAN-dream-launch-TASK-004-card-last-run-error.md)

### Phase C: consolidation

- [ ] [TASK-005-refactor-review](docs/PLAN-dream-launch-TASK-005-refactor-review.md)
- [ ] [TASK-006-repo-gates](docs/PLAN-dream-launch-TASK-006-repo-gates.md)

## Dependencies

- TASK-002 depends on TASK-001 (the seam shape it wires is defined there).
- TASK-003 depends on TASK-001 (same file, `drive()`); independent of 002.
- TASK-004 depends on TASK-003 (there is a trustworthy `lastRun.error` only then).
- TASK-005 reviews the commits of TASK-001..004. TASK-006 is last.

## Deferred to the user after TASK-006

- Restart `dsh web` and trigger one live `memory_dream` run (card Run or tool
  `operation: "run"`); confirm the transcript shows real turns and the
  summary reports bumped/degraded counts that match actual note work.
