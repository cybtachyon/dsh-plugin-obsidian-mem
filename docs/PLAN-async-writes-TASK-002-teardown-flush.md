# TASK-002 — Bounded follow-up flush at teardown

Context: TASK-001 moved the index+commit follow-ups off the write path onto
tracked asynchronous chains observable through `flushWriteFollowUps()`. The service
teardown (`stop()` L1327 → `teardown()` L1941) stops the indexer and disposes
the Milvus launcher/client; pending follow-ups would then fail mid-flight
(their Milvus inserts and (via the op lane) embed work die with the client).

Change:

1. In `teardown()`, before `this.indexer?.stop()`, await
   `flushWriteFollowUps()` with a bounded timeout: new exported constant
   `TEARDOWN_FLUSH_TIMEOUT_MS` (default 60_000; Questionnaire answer may
   tune). Use a `Promise.race` with a timer; on timeout log a warn naming
   how many follow-ups were still unsettled (the lane itself keeps running;
   the state-file content diff makes the next start re-dirty whatever did
   not land, so dropping is safe).
2. The flush never rejects teardown: catch and log.
3. Update the `stop()` doc comment.

Definition of Done:

- `pnpm build` green with lib carriers committed; tree clean.
- Unit tests: (a) a write whose fake indexer resolves after ~10 ms still
  indexed before the fake indexer `stop()` was called; (b) a write whose
  fake indexer never resolves does not hang `stop()`: teardown completes
  within a test-enforced margin, logs the warn, and the launcher/client
  teardown still ran; (c) an empty queue settles teardown without delay.
