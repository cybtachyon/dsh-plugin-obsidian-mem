# TASK-040 Session tracking (once-per-session injection)

Depends: TASK-030. `packages/events/src/sessions.ts`.

## Scope

- `SessionRegistry` keyed by `sessionId` (from `agent.session.id` / exec context):
  `{ injectedSources: Map<sourcePath, injectedAtMs>, turnStartDone: bool, thinkShots: int,
  lastTurn: int }`.
- Rule (spec): a given memory source is injected at most ONCE per session, even across
  resumed days. Exception: if the note's contentHash changed after injection (rewritten by
  dreaming/user) it becomes eligible again.
- Sub-agents are NOT the same session: distinct sessionIds; detect via agent/session
  metadata available in `agent/created` payload (check for subagent/child markers;
  `subagent/start` info correlation) — document detection method in code comment once
  verified against the live harness.
- Persistence: `<stateDir>/sessions.json` (sessionId → injectedSources + timestamps),
  capped (LRU 200 sessions, 30-day TTL) so "continued at a later date" honors the rule
  across restarts; atomic write, debounced.
- API: `shouldInject(sessionId, path)`, `markInjected(...)`, `budgetLeft(sessionId, kind)`
  (thinkShotsPerTurn cap), `isSubagent(sessionId)`.

## DoD

Unit tests: once-per-session incl. restart persistence via temp stateDir, changed-note
re-eligibility, subagent separation; commit.
