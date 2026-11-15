# TASK-005: read-intercept-lineage-gate

Phase 2: Dream-lineage recall suppression (events).

Close the third injection route: the Read-tool intercept rides the
plugin-ctx `tools/result` observer, so it fires for every agent including
lineaged ones. It must early-return for dream-lineage sessions.

## Steps

1. `packages/events/src/readIntercept.ts`: right after the session id is
   taken from `exec.agent`, return early on the lineage check
   `deps.registry.isDreamLineage(sessionId)` (before budget, throttle, or
   search work). TASK-006 widens this early-return to the combined gate
   rule (lineage OR launch-window-busy); keep the check in one expression
   that the TASK-006 helper can replace wholesale.
2. Read-intercept spec: a lineaged session's Read of an interesting path
   injects nothing and consumes nothing (no `readInjections` bump, no
   wake-terms, no covered-dirs); a non-lineaged session in the same test is
   unaffected.

## Definition of Done

- `pnpm test` green; the only recall route still open for lineaged sessions
  is the model explicitly calling `memory_search`/`memory_read`, which the
  dreaming protocol requires and stays.
