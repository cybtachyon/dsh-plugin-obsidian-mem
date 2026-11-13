# TASK-005: Think intercept sleeps one block after a successful injection

Files: `packages/events/src/thinkIntercept.ts`, `packages/events/tests/thinkIntercept.spec.ts`.

Give the agent breathing room after an injection:

- Exported constant `THINK_SLEEP_BLOCKS_AFTER_INJECTION = 1`.
- `ThinkWatcher` gains a mutable `sleepBlocks: number` (install-scoped, one
  per agent like the per-attempt map).
- `scheduleThinkRecall` starts with the sleep check: when `sleepBlocks > 0`,
  decrement and return before the vocabulary scan, budget check, or any
  search (the block is consumed, unprocessed).
- `runThinkRecall` sets `watcher.sleepBlocks = THINK_SLEEP_BLOCKS_AFTER_INJECTION`
  on the success path, right after the injection actually lands (after
  `injectNotice`, alongside `markSourceInjected`/`addRecallTokens`).
- Every early return (offline, no fresh, spent shot) leaves the counter
  untouched: no injection, no sleep.
- Module header gains the rule.

Definition of Done: a test injects on block 1, feeds a second matching block
with a fresh (different-source) result and asserts no second injection; the
THIRD matching block injects again (normal behavior resumed). A no-fresh run
asserts no sleep (next block still processes). src+lib+spec same commit;
gates green.

Depends on: no code dependency; same file as TASK-003/004, sequence after them.
