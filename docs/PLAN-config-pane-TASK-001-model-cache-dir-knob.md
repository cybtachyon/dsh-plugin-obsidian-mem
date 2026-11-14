# TASK-001: model-cache-dir-knob

Add the `model.cacheDir` config knob (the README `modelCacheDir` row) so the
transformers.js cache directory is configurable instead of hardcoded to
`modelCacheDir(homedir())`.

## Scope

- `packages/service/src/config.ts`:
  - `ObsidianMemConfig.model` and `ObsidianMemResolvedConfig.model` gain
    `cacheDir?: string` / `cacheDir: string`. Default `''` means "core
    `modelCacheDir(homedir)`", filled at `resolveServiceConfig` time exactly
    like `milvus.dbPath` (keeps core env-free; `resolveServiceConfig` is the
    only place `$HOME` enters).
  - Validation mirrors `model.id`'s string rule (non-string answers an issue
    at `['model', 'cacheDir']`).
- `packages/service/src/service.ts`:
  - `getEmbedder()` passes `cacheDir: this.config.model.cacheDir` (already
    absolute after resolve) to `createEmbedder` instead of computing
    `modelCacheDir(this.homedir())`.
- `packages/service/src/audit.ts`:
  - The `model.uncached` probe checks the configured cache dir
    (`config.model.cacheDir`) instead of `modelCacheDir(deps.homedir)` so the
    audit inspects the directory the plugin actually uses.
- Tests: `packages/service/tests/config.spec.ts` (default empty, custom,
  `~`/relative expansion), `packages/service/tests/service.spec.ts`
  (resolved value), `packages/service/tests/audit.spec.ts` (probe follows the
  custom dir; existing seeded tests keep passing with the default).

## Definition of Done

- `pnpm build` succeeds and the `packages/{service,ui,tools,events,core,client}/lib`
  emit is committed IN THE SAME COMMIT as the src edits (lib is tracked).
- `pnpm test` green, including new cacheDir cases.
- A second `pnpm build` leaves `git status --porcelain` empty.

## Dependencies

None (first task). Touches config/service/audit only.
