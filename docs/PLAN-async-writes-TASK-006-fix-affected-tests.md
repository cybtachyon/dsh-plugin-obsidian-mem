# TASK-006 — Update every affected test for the async contract

Context: TASK-005 renamed the success const to `'queued'` and the write now
settles indexing/git asynchronously. Tests that assume sync settle or pin the
old const must move with it.

Change:

1. `packages/tools/tests/write.spec.ts`: `write_through` assertions to
   `'queued'`; render-text assertions if any pin the old sentence.
2. `packages/events/tests/writeLedger.spec.ts` and
   `packages/events/tests/thinkIntercept.spec.ts`: fake written values'
   `write_through` literal updated (fixture-only change).
3. `packages/service/tests/integration/live-pipeline.live.test.ts`:
   the 'write-through' case (L494) becomes the async settle case: after
   `applyWrite` returns, `await service.flushWriteFollowUps()`, then search
   and state-file assertions unchanged in substance; keep the
   'zephyrline' fresh-token assertion (it now proves the follow-up chain,
   not an in-call await).
4. Sweep for any other test that calls `applyWrite`/`write` and then asserts
   indexer or git effects without flushing; flush first.

Definition of Done:

- `pnpm test` fully green (unit tier); `RUN_LIVE=0` default CI behavior
  unchanged.
- `pnpm build`, `pnpm lint` green; tree clean.
