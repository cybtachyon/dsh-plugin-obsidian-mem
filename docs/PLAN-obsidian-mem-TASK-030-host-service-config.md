# TASK-030 Host service + Config schema

Depends: TASK-024, TASK-011. `packages/service/src/index.ts` (+ config.ts, service.ts).
This is the `export function apply(ctx, config)` + `export const Config` row.

## Scope

- `Config` JSON Schema (validated by cordis at activation; document every field):
  `vaults: [{path, mode: 'shared'|'read-only'}]`, `vectorDim: 256|384|768 (768)`,
  `model: { id, quantized }`, `milvus: { mode: 'spawn'|'external', address, dbPath }`,
  `budgets: { turnStartRecallTokens, globalMemoryTokens, readSections, readSectionTokens,
  searchTopK, thinkShotsPerTurn }`, `llm: { enabled, baseUrl, model, apiKeyEnv }`,
  `dreaming: { schedules: [{ id, label, expression|everySeconds }] }` (card-managed).
- Activation stays side-effect free: resolve config/vaults and publish the service object.
  NO vault/db creation, NO Milvus child when nothing is configured.
- `ensureMemoryAccess()` (idempotent async, Decision log): first call only, in this order:
  zero shared vaults → `provisionDefaultVault` + seed `.INTENTS.md` → mkdir dbDir →
  milvus launcher start (spawn) → ensureCollection → indexer background start → set the
  one-time `notice` = "Obsidian Mem is using the default memory vault at <full path>.
  Add your own vaults in the Obsidian Mem settings card to override." The notice is
  returned to, and must be included by, whichever tool/injection triggered it (tools
  031-034 prepend it to the result; turn-start recall prepends it to the injected context;
  audit restates it while the default vault is in use).
  All memory-access service methods route through it first.
- Publish `ctx.obsidianMem` service object (plain object on ctx via
  ctx.provide? follow the Cordis service-declaration convention found via
  `cordis_inspect_query Service listService` + local-infer's `ctx.localInfer` pattern — the
  service class as default export OR ctx service declaration, whichever this harness build
  requires; tools/events then `inject: ['obsidianMem']`).
- Service surface (single source of truth reused by tools/ui/events): `listVaults()`,
  `addVault({path,mode})` (mkdir markdown/metadata for shared; rejects duplicates),
  `removeVault(path)`, `read(absPath, {offset?,limit?})` (+ read-stats update + registry
  note for write-staleness), `write(req)` orchestration hook (used by memory_write tool),
  `search(req)`, `status()`, `audit()`, `dream(req)` (candidates+instructions, see 034/035),
  `globalMemoryIndex()` (TASK-045 shape), `sessionRegistry` handle (TASK-040).
- Everything defensive: a failed milvus start degrades (status reports), never crashes the
  harness; log via ctx logger.

## DoD

Schema snapshot test; apply() lifecycle test: activation with empty vaults creates NOTHING
on disk (stat assertions); ensureMemoryAccess creates default vault exactly once (two
concurrent calls) and yields the notice exactly once; degraded start; disposal cleans
watchers+child; commit.
