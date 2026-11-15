# TASK-006: launch-window-suppression

Phase 2: Dream-lineage recall suppression (events).

Per the Q1 answer: while a dream run is in flight, the session that
launched it through `memory_dream` also receives no recall injection
(card Run Dream and scheduled triggers have no launching agent session, so
the window simply has no member there). The window closes the moment the
run is no longer in flight; other sessions are untouched throughout.

## Steps

1. Seam (`packages/service/src/service.ts` + `packages/events/src/host.ts`
   `MemoryEventsService`): expose `dreamRunBusy(): boolean` returning the
   orchestrator's live `busy` flag (false before the engine is constructed;
   the orchestrator getter already exists, no new state).
2. `packages/events/src/`: new small observer module (mirrors the
   writeLedger plugin-ctx `tools/result` pattern): on a `tools/result` for
   tool `memory_dream` with parsed `arguments.operation === 'run'` and
   `!result.isError`, claim `registry.markDreamLaunch(String(exec.agent.id))`.
   Wire in `mountLifecycle`.
3. `packages/events/src/sessions.ts`: live-only `dreamLaunch` boolean on
   the record, set via a dedicated `markDreamLaunch(sessionId)`; never
   persisted.
4. Single gate rule, one home (events `toolkit.ts` helper):
   `isRecallSuppressed(sessionId)` = `registry.isDreamLineage(sessionId)`
   OR (`memory.dreamRunBusy()` AND `registry.isDreamLaunch(sessionId)`).
   Apply at every injection decision:
   - `turnStart.ts` claimTurnStart: check BEFORE `markTurnStartDone` (a
     suppressed turn-start is not consumed; recall remains eligible after
     the window closes).
   - `thinkIntercept.ts`: early return inside its guarded flow.
   - `readIntercept.ts` (replaces the plain lineage check from TASK-005).
5. Tests: seam fake; observer claims the launcher only for operation=run
   successful calls; gate truth table across busy/idle x
   lineage/launch/normal; turn-start re-eligible after the window when it
   was suppressed at step 1.

## Definition of Done

- `pnpm test` green; suppression is window-scoped (no leak after the run;
  `markDreamLaunch` on an idle window injects normally at the next route);
  no new seam config surface.
