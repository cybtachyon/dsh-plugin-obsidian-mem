# TASK-004: created-handler-lineage

Phase 2: Dream-lineage recall suppression (events).

Claim dream lineage at `agent/created` and skip installing the recall hooks
for lineaged sessions, so the dream agent and every descendant session (the
Step 2 reasoning subagents included) receive no turn-start or Think-stream
recall while the dream process runs. Other sessions are untouched.

Lineage rule (single home: the handler): a session is lineaged when its own
id starts with the core `DREAM_SESSION_PREFIX` (the orchestrator's own
`dream-<uuid>` identity), or when its session header's `parentSession` is
already a lineaged session (transitive through the registry flag, so depth
is unbounded and the rule stays one line).

## Steps

1. `packages/events/src/host.ts`: extend the `AgentSessionHeader` mirror
   with `readonly parentSession?: string` (verified field of the
   `@deepseek-ai/dsh-session` SessionHeader).
2. `packages/events/src/index.ts` (`agent/created` handler):
   - Import `DREAM_SESSION_PREFIX` from the core barrel.
   - Compute `dreamLineage = sessionId.startsWith(DREAM_SESSION_PREFIX)
     || (header?.parentSession !== undefined &&
         registry.isDreamLineage(header.parentSession))`.
   - Pass it through `registry.ensure(sessionId, { subagent, dreamLineage })`.
   - When lineaged, skip the `installTurnStart` + `installThinkIntercept`
     effect entirely (keep `registry.ensure`; keep the memory-tool watch
     and write ledger bookkeeping untouched, plugin-level).
   - The handler stays throw-free (`runGuarded` discipline unchanged).
3. Events mount spec (fake agents like the existing lifecycle tests):
   - `dream-...` agent: registry record lineaged; no `agent/pre-step` and
     no `agent/assistant-stream` listeners registered on its ctx.
   - Child (id `c-1`, `parentSession: 'dream-x'`) of a created dream agent:
     lineaged, hooks skipped.
   - Grandchild (parentSession = the child id): lineaged.
   - Unrelated sibling session created in the same window: hooks installed,
     not lineaged.
   - A session whose `parentSession` is unknown to the registry: not
     lineaged.

## Definition of Done

- `pnpm test` green; suppression is decided once, at creation; no new
  event registrations beyond what exists.
