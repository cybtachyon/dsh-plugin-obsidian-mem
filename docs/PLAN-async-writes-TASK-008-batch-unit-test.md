# TASK-008 — Batched 10-write unit test

Add the goal's regression test at the service unit tier (fast, no live
stack): a new describe block (or file) in
`packages/service/tests/service.spec.ts`:

1. Harness: the existing fake launcher/client/embedder/indexer seams; the
   fake indexer `indexFile` resolves after a delay scaled by call count
   (e.g. 300 ms each) to reproduce the pile-up that used to blow the tool
   budget when writes awaited the queue; the fake git runner adds a small
   delay per commit.
2. Drive ten consecutive `await service.applyWrite(...)` calls (unique
   titles/paths). Measure each call's wall time.
3. Assert: every individual write resolves well under `WRITE_TIMEOUT_MS`
   (the constant imported from `packages/tools/src/write.ts` is NOT
   importable from service tests; restate the 10_000 ms budget in a named
   test constant `TOOL_WRITE_BUDGET_MS` with a comment pointing at
   `WRITE_TIMEOUT_MS`); with the fake indexer at ~300 ms x 10, the OLD
   awaited pipeline would have summed ~3 s of queue waits into call
   latencies, so assert each write resolves under 1_000 ms AND that after
   the tenth call the fake indexer has processed at most a prefix of the
   ten paths (proof the calls returned ahead of the queue).
4. `await service.flushWriteFollowUps()`; assert all ten paths reached the
   fake indexer in write order and the fake git lane recorded ten
   `obsidian-mem: memory_write` commit messages in order.
5. No duplicated tools-tier timing test: `executeWrite` adds only fast
   guards and one `applyWrite` await, so the service-tier test is the
   timing proof (the tools tier keeps its behavioral pins from TASK-006).

Definition of Done:

- The new test runs in the default `pnpm test` tier, is green, and fails
  loudly if someone re-adds an `await` before the index/commit follow-ups
  (prove it once by temporarily re-awaiting in a scratch run, not in the
  commit).
- Coverage floors hold; `pnpm lint` green; tree clean.
