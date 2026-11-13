# TASK-043 Think-stream intercept

Depends: TASK-040, TASK-024. `packages/events/src/thinkIntercept.ts`.

## Scope

- Listener: `agent/assistant-stream` (Scoped<Agent>, {agent, frame}) registered ON
  `agent.ctx` from an `agent/created` handler (agent-scoped events do NOT fire on
  plugin-ctx listeners — dsh-ltm lesson; wrap in agent.ctx.effect + keep disposer keyed by
  agent in the plugin's own effect). Accumulate per-agent stream text; detect COMPLETED
  `<think>...</think>` blocks only (no prior art exists for think-stream interception;
  this is net-new) (closed-tag regex over
  accumulated text; also handle the harness's native thinking frame type if
  AssistantStreamFrame exposes reasoning content — verify shape via inspection; if the
  native channel exists, treat its close as a completed block too).
- On block completion: tokenize; match against the UNION of (a) INTENT_MARKERS constants,
  (b) wake_keywords of memories injected in this session (registry keeps them), (c) intent
  entries recorded in the first shared vault `.INTENTS.md`.
- Regex-scan only (no embedding) to stay cheap; no match → drop block.
- On match: `search({ query: block text (cap 500 chars), wakeKeywords, topK=2 })` via
  `service.ensureMemoryAccess()` (pending default-vault notice prepends to injection) →
  `shouldInject` filter → `agent.inject()` wrapped; count vs budgets.thinkShotsPerTurn;
  reset counter each new turn (track via payload turn hints or turn boundaries).
- Cleanup per-agent buffers on `agent/disposed`.

## DoD

Stream-chunk fixtures (split tags across frames, multiple blocks, native-thinking variant),
union keyword set test, budget counter test, disposal cleanup; commit.
