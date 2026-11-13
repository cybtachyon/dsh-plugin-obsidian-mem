# TASK-001: SessionRegistry written-source ledger

Files: `packages/events/src/sessions.ts`, `packages/events/tests/sessions.spec.ts`.

Add per-session written-source tracking so later flows can exclude memories
the session itself authored:

- `SessionRecord` gains `writtenSources: Map<string, number>` keyed by the
  same `sourceKeyFor` identity the injected ledger uses (value: epoch ms).
- `noteWrittenSource(sessionId, sourceKey, at?)` records one and persists.
- `wasWrittenIn(sessionId, sourceKey): boolean` answers the membership.
- `PersistedSession` gains `written: Record<string, number>`; hydration,
  touch, and the TTL/LRU paths treat it exactly like `injected`. A resumed
  session keeps honoring the rule (30-day ledger TTL already bounds it).
- Written sources are process-wide by session id: `agent.id` IS the session
  id, so every agent instance of one session shares the ledger ("no matter
  which agent wrote it").

Definition of Done: unit tests cover record/answer, persistence round-trip
through a fresh registry over the same `sessions.json`, hydration of an
unknown key answering false, and the LRU/TTL pruning covering `written`.
src+lib+spec in the SAME commit; gates green.

Depends on: nothing.
