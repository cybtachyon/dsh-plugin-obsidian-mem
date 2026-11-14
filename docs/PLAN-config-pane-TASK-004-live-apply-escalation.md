# TASK-004: live-apply-escalation

Apply an accepted settings patch to the running service with the smallest
safe escalation, reusing the existing provisioning machinery.

## Escalation classes (one switch on the changed whitelist keys)

1. `budgets.*` (except `thinkShotsPerTurn`) and `llm.*`:
   - Replace the nested config object in place (`this.config` is a mutable
     object behind a readonly field; replace whole `budgets` / `llm` objects).
   - `budgets.*` are read at call time by `packages/events` (turnStart,
     turnEnd, readIntercept) and `service.search` (`readSectionTokens`): no
     further work.
   - `llm.*`: call `restartIndexer()` (it rebuilds `IndexerManager` from
     `this.config.llm`, mirroring `commitRegistryMutation`).
   - `budgets.thinkShotsPerTurn` lives in the events-owned
     `SessionRegistry` (baked at construction): add
     `setThinkShotsPerTurn(n: number): void` to `SessionRegistry`
     (`packages/events/src/sessions.ts`), add it as an OPTIONAL member of
     `SessionRegistryView` (`packages/service/src/service.ts`), and call it
     through `this.sessionRegistryValue?.setThinkShotsPerTurn?.(n)`.
2. `model.id`, `vectorDim`, `model.cacheDir`:
   - Replace `this.config.model` / `vectorDim`; drop `embedderStore`
     (`null`) ONLY when no `hooks.embedder` seam was provided (a test seam
     stays authoritative).
   - When `phase === 'ready' && client !== null` and the dim changed:
     re-run the provision step-5 pair (`ensureCollection` → on
     `needsRebuild`: `rebuildCollection` + `dropVaultStateFiles()`), then
     `restartIndexer()`. Same width or cacheDir-only: just `restartIndexer()`
     (chunk ids bake modelId+vectorDim, so the indexer's state diff
     re-embeds changed content and stale-deletes the old rows by itself).
   - When not yet provisioned: config mutation is enough; provisioning picks
     up the new values (dim drift is answered at step 5 the same way).
3. `milvus.dbPath`: persist-only. In-process the subsystem keeps running on
   the old dir; `cardSettings().restartPending` reports it; the next host
   start provisions against the new one (fresh collection + vault state
   files intact means the indexer diffs against the old collection's dim
   normally; the new empty collection gets a full scan because
   `ensureCollection` creates it and the state files' chunk ids are absent →
   reindex fills it). Card copy warns "rebuilds the search index on the next
   host restart".

Ordering guard: a single in-flight apply (a second concurrent
`updateCardSettings` rejects); applies while `phase === 'provisioning'`
wait on `this.access.promise` first. Keep every restart behind the existing
`restartIndexer`/teardown discipline; never leave `this.indexer`/`client`
dangling on a failed embedder recreation (log + answer the validation-style
error, previous config stays applied).

## Tests

- budgets patch: `turnStart`-style read path sees the new value immediately
  (assert via `service.config` and the search `defaultTokenCap` wiring).
- thinkShots: wired fake registry receives `setThinkShotsPerTurn`.
- llm patch: `indexerFactory` is called again with new llm options
  (fake-launcher harness from `service.spec.ts`).
- vectorDim patch while ready with the fake client: `ensureCollection`/
  `rebuildCollection` pair exercised (fake client harness as in existing
  service tests), `dropVaultStateFiles` ran, indexer re-formed.
- vectorDim patch while inactive: no client work, config only.
- dbPath patch: restartPending lists `milvus.dbPath`, no subsystem touched,
  vaults.json copied (TASK-003 test may already cover the copy).

## Definition of Done

- Tests green; `pnpm build` emit in the same commit; tree clean after a
  second build; `pnpm lint` clean for touched files.

## Dependencies

TASK-003 (call sites). Events change stays additive (no behavior change for
mounts that never call the setter).
