# TASK-001 — Async write follow-ups (index + git chains)

Context: `applyWrite` in `packages/service/src/service.ts` (L825) awaits
`indexer.indexFile(vault, rel)` and `vaultGit.commitVault(vault, msg)` after
the atomic write, inside the `memory_write` tool call. Both are the slow,
pile-up-prone steps behind the reported 10 000 ms timeouts.

Design decisions (settled):

- `applyWrite` confirms the write after `writeAtomic` + stat +
  `readRegistry.set` and returns immediately.
- Two INDEPENDENT fire-and-forget follow-up chains per write, both tracked:
  1. index chain: `indexer?.indexFile(vault, rel)` with the existing
     warn-catch (skip when the indexer is null; the watcher, the stat sweep,
     and the next `indexer.start()` full-scan converge);
  2. git chain: `this.vaultGit.commitVault(...)` (already settles to null and
     never rejects; belt-catch anyway).
  Keeping them independent means a slow embed never delays a git commit.
  Vault-internal ordering is already owned by `VaultIndexer.enqueueOp` and
  the `VaultGitManager` per-vault lane; the service adds NO new serial lane.
- Tracking: `private readonly pendingFollowUps = new Set<Promise<void>>()`
  plus a private `trackFollowUp(promise)` helper that attaches a settled
  cleanup removing its own handle, and a warn-log catch. Public
  `flushWriteFollowUps(): Promise<void>` loops
  `await Promise.allSettled([...this.pendingFollowUps])` while the set is
  non-empty, then resolves. It answers resolved when nothing is pending.
- Doc comments: `applyWrite` now states the returned value confirms the note
  file landed on disk; indexing and git settle asynchronously on the
  follow-up chains, in enqueue order per vault; `commitAllShared` (the dream
  end seam) enqueues onto the git lane behind pending per-write commits.
  Update the stale comment "applyWrite already awaits the write-through
  index, so one serialized commit fits the same latency envelope".

Definition of Done:

- `pnpm build` green, tree clean with `packages/service/lib` carriers
  committed.
- New unit tests in `packages/service/tests/service.spec.ts`:
  (a) `applyWrite` resolves while a slow fake indexer `indexFile`
  (e.g. 250 ms) is still pending, and the file is already on disk;
  (b) `flushWriteFollowUps()` then resolves and the fake saw
  `indexFile(vault, 'rel.md')` and the fake git runner recorded the commit;
  (c) flush with nothing pending resolves;
  (d) a rejecting fake `indexFile` does not reject `applyWrite`, does not
  reject `flushWriteFollowUps()`, and a later write's follow-up still
  settles (no wedged lane);
  (e) git and index chains settle independently (a never-settling fake
  indexer does not block the git-chain flush of the same write: flush only
  returns after BOTH, so test via observed order of the fake git runner vs
  the fake indexer, not flush).
- Existing `applyWrite and write` tests updated to flush before asserting
  `indexFile` was called (service.spec.ts L978 and any sibling asserts).
