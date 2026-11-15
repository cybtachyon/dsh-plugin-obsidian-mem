# TASK-003 — Cold-start writes without awaiting the index stack

Context: `provision()` (`packages/service/src/service.ts` L1333) runs the
whole bootstrap inside the first `ensureMemoryAccess()` call, including
`launcher.start()` (milvus-lite spawn under uvx; cold cache measured up to
400 s, readiness budget `DEFAULT_READINESS_TIMEOUT_MS = 600_000`),
`ensureCollection`, and `indexer.start()`. Every memory tool and flow awaits
that call, so the FIRST `memory_write` in a process can blow the 10 000 ms
budget before any indexing happens.

Change (per Questionnaire answer 2; if the answer confirms the recommended
split):

1. Split `provision()` into:
   - `provisionCore()`: default-vault provisioning + `.INTENTS.md` seed +
     registry finality + `fs.mkdirp` of dbDir/stateDir + git
     `ensureSharedVaults()` + uvx prewarm + `registerTeardown()`; returns the
     one-time notice. Everything it awaits is fast local fs/git work.
   - `startIndexStack()`: the current steps 4-6 (launcher start, client,
     `ensureCollection` drift remedy, `buildIndexer` + `indexer.start()`),
     setting `phase`, `milvusVersion`, and `milvusError` exactly as today.
2. `ensureMemoryAccess()` keeps today's contract: awaits core AND the stack
   (the search/read/audit/dream/event flows keep full readiness). The stack
   pass starts once (single-flight alongside the core pass) when either
   entry point runs; awaiting callers share the same promise.
3. New `ensureWriteAccess(): Promise<string | undefined>` on the service (and
   the `MemoryService` seams in `packages/tools/src/host.ts` and, if needed,
   `packages/events/src/host.ts`): awaits only `provisionCore()`; starts the
   stack in the background un-awaited; the one-time notice goes to the
   triggering call. `phase` reports `'provisioning'` while the stack is
   still coming up after the core lands (the card keeps showing the honest
   in-between state).
4. `packages/tools/src/write.ts` `executeWrite` calls
   `service.ensureWriteAccess()` instead of `ensureMemoryAccess()`, AND
   `applyWrite` itself switches its internal `await
   this.ensureMemoryAccess()` to `await this.ensureWriteAccess()` (otherwise
   the tool change is defeated by the service re-await). The seam views in
   `packages/tools/src/host.ts` (and `packages/events/src/host.ts` if its
   fake/service view needs it) grow the method; every non-write caller keeps
   `ensureMemoryAccess()`.
5. The TASK-001 index chain stays as-is: when the indexer is still null at
   follow-up time the write-through index is skipped and the indexer's own
   startup full-scan/watcher/sweep converges (document this in the chain
   comment; the git chain is unaffected).
6. A failed core pass keeps today's retry semantics (`access = null`,
   `phase = 'inactive'`). A failed stack pass settles `'degraded'` exactly as
   today (search offline, writes still land).

Definition of Done:

- `pnpm build` green with lib carriers committed; tree clean.
- Unit tests: (a) a launcher whose `start()` never resolves no longer blocks
  `applyWrite`: the write resolves immediately after core provisioning and
  the file lands; (b) `search` behind the same slow launcher still awaits
  readiness (rejects/answers only after the stack settles or degrades);
  (c) the provisioning notice arrives exactly once, on the write that
  triggered provisioning; (d) status reports `'provisioning'` between core
  completion and stack completion.
