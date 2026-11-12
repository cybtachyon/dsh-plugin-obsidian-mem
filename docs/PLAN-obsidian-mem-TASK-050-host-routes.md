# TASK-050 Host routes for the card

Depends: TASK-030. `packages/ui/src/routes.ts` (+ ops). Pattern: local-infer
`packages/ui/src/route.ts` (`scope.webServer.register(route)` on scoped inject of the web
server service — verify service name via cordis inspection `Service listService`).

## Scope

Routes (JSON, no secrets echoed):
- `GET /obsidian-mem/status` → vaults [{path, mode, counts, pending, lastIndexedAt}],
  milvus {mode, address, live}, indexer {indexed, pending, errors}, model {cached, id},
  globalBudget {tokens, budget, over}, dreaming {schedules}.
- `POST /obsidian-mem/vaults` `{path, mode}` → addVault (mkdir markdown/metadata when the
  path is new+shared; reject read-only paths lacking markdown/), starts background reindex.
- `DELETE /obsidian-mem/vaults` `{path}` → removeVault (drop its chunks from Milvus by
  vault filter; never touch files).
- `POST /obsidian-mem/reindex` `{path?}` → manual reindex trigger.
- `GET|POST|DELETE /obsidian-mem/dreaming/schedules` `{id,label,expression|everySeconds}` →
  stored in plugin config document (settings document per Q4; if the settings-write API is
  not plugin-callable, persist to plugin state file and clearly surface in card+status that
  applying schedules requires the profile config; document the finding in code comment).
- 404 route-absent behavior when web profile missing (card probes gracefully).

## DoD

Route handler tests with faked service (status shape, add/remove validation, chunk-drop
call, reindex trigger); commit.
