# TASK-040 Session tracking (once-per-session injection)

Status: done

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

## Status notes

- Subagent detection: the durable `SessionHeader.origin === 'subagent'` marker or a
  positive `delegationDepth` (verified against the @deepseek-ai/dsh-session types);
  keying never depends on it (every session is its own key already).
- Seam choice: the events package owns and constructs the registry; the service gained
  the additive `setSessionRegistry(view | null)` + `sessionRegistry` getter with a
  minimal structural `SessionRegistryView` (`totalRecallTokensUsed()`), so the package
  dependency stays events -> service. TASK-045 reads the wired registry in
  `globalMemoryIndex()`.
- Changed-note re-eligibility uses the indexed `updated_at` carried by search results
  as the content fingerprint (a rewrite re-indexes and moves it); the raw `contentHash`
  never crosses the search boundary.
- Teardown: `agent/disposed` is observable, so live records die there (plus the plugin
  fiber effect); no WeakMap needed. The persisted ledger always survives disposal.
