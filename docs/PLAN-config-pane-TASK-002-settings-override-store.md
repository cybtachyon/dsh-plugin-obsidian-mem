# TASK-002: settings-override-store

Persist card-editable settings overrides in `<state>/settings.json` and merge
them over the profile row config at service construction. The card edits
become durable exactly like card vaults are (the `vaults.json` precedent).

## Decisions (from questionnaire; re-read before implementing)

- Card overrides WIN per leaf key over the same key in the profile row
  config (card is the newer user intent). Row-config-only keys stay as set.
- `model.cacheDir` (like `milvus.dbPath`) takes `''` as the default
  sentinel: validation accepts any string (`stringOr`, not `model.id`'s
  non-empty rule, because cordis re-validates the resolved row whose stored
  default IS `''`), and `resolveServiceConfig` maps `''` to core
  `modelCacheDir(homedir)`. So a settings.json override row may legitimately
  carry `''`, meaning "the core default", never "unset the knob". Clearing an
  override means DELETING the key from the overrides map (the profile row
  value then wins again), not writing `''`.
- The override file anchors at the FIXED core layout location
  `stateDir(homedir())` (= `dbStateDir(dbDir(homedir()))`, from
  `packages/core/lib/index.js`), NOT at the config-derived `stateDirPath()`,
  so a pending `milvus.dbPath` override is never orphaned (no chicken-and-egg
  on load). `vaults.json` keeps its current location.

## Scope

- `packages/service/src/service.ts`:
  - `export const SETTINGS_FILE_NAME = 'settings.json'` and
    `SETTINGS_FILE_VERSION = 1`; record shape
    `{ version, overrides: <partial config with only whitelisted keys> }`.
  - The whitelist `CARD_SETTINGS_KEYS` (leaf dot-paths) lives in
    `packages/service/src/config.ts` as the single source:
    `vectorDim`, `model.id`, `model.cacheDir`, `milvus.dbPath`,
    `budgets.turnStartRecallTokens`, `budgets.globalMemoryTokens`,
    `budgets.readSections`, `budgets.readSectionTokens`,
    `budgets.searchTopK`, `budgets.thinkShotsPerTurn`,
    `llm.enabled`, `llm.baseUrl`, `llm.model`, `llm.apiKeyEnv`.
  - Constructor order: validate row config → read + parse `settings.json`
    (corrupt/unreadable file: log warn, treat as empty, self-heal like
    `vaults.json`) → filter to whitelisted keys (non-whitelist keys dropped
    with a warn) → deep-merge leaves over the resolved row value → re-run
    `validateObsidianMemConfig` on the merged value; on issues, log and fall
    back to the row-only config → `resolveServiceConfig`.
  - Atomic write helper reuse: `writeAtomic`. The state anchor dir is
    `mkdirp`-ed only at write time (construction stays side-effect free).
- No new service public methods yet (TASK-003 adds them). This task makes the
  persisted file authoritative at boot.
- Tests in `packages/service/tests/` (config.spec.ts or a new settings.spec.ts):
  override beats row config per leaf; partial nested merge (override sets
  `budgets.searchTopK` only, row's other budgets survive); corrupt JSON
  self-heals; non-whitelist keys dropped; no override file keeps today's
  behavior exactly; ~-expansion still happens after the merge.

## Definition of Done

- Tests above green; `pnpm build` emit committed in the same commit; second
  build leaves the tree clean.

## Dependencies

TASK-001 (model.cacheDir must exist as a config key before it joins the
whitelist).
