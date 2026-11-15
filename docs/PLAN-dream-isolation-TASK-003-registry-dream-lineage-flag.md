# TASK-003: registry-dream-lineage-flag

Phase 2: Dream-lineage recall suppression (events).

Give `SessionRegistry` the single home of "this session belongs to dream
work", as a live-only per-session flag.

## Steps

1. `packages/events/src/sessions.ts`:
   - `SessionRecord` gains `dreamLineage: boolean` (live-only like
     `turnRecallTokensUsed`; `PersistedSession` stays unchanged and the
     hydrator defaults it to false).
   - `ensure(sessionId, info: { subagent?: boolean, dreamLineage?: boolean })`
     sets it once true on first claim (same one-way pattern as `subagent`),
     without touching the persisted ledger (it is not ledger data).
   - Add `isDreamLineage(sessionId): boolean` mirroring `isSubagent`.
2. `packages/events/tests/` (sessions spec): set on ensure; sticky across
   later ensures; not serialized to the sessions file; default false;
   `isDreamLineage` answers without creating a stray record expectation
   mismatch.

## Definition of Done

- `pnpm test` green for the events suites; flag never appears in
  sessions.json output of the persist spec.
