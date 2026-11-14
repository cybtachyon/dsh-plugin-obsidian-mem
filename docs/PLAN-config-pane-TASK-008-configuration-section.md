# TASK-008: configuration-section

The new client "Configuration" details section, mounted directly below
"Vaults" in the card, editing the README Configuration knobs.

## Layout (Section body, top to bottom)

Fetch `GET /obsidian-mem/settings` on mount; show a RowHint while
`status === null`-style loading; errors render in `ERROR_BANNER_STYLE`.
Values seed from `payload.settings`; every control is a draft input with
dirty tracking; one "Apply changes" button POSTs `{ set }` for dirty fields
plus `unset` for fields reverted to the profile value; one "Reset all to
profile settings" button (two-step confirm like Vaults remove) DELETEs.

1. Retrieval: `vectorDim` segmented (384 | 320 | 256 | 192 | 128, labels mark
   the lossy ones; warning line "Lossy widths trade recall for speed;
   changes force a full re-index"), `budgets.searchTopK` number input.
2. Recall budgets (README `recallBudget` row): numbers for
   `turnStartRecallTokens`, `globalMemoryTokens`, `readSections`,
   `readSectionTokens`, `thinkShotsPerTurn`. Each gets a one-line title
   tooltip; defaults shown as placeholder.
3. Embedding model (README `embeddingModel`): text input `model.id`
   (warning: "changing the model re-embeds every note") and `model.cacheDir`
   (placeholder shows the effective default path; note "the model is
   downloaded here on first use").
4. Database (README `dbDir`): text input `milvus.dbPath` + a Tag chip
   "restart to apply" when `restartPending` includes `milvus.dbPath`; a
   warning banner whenever `restartPending` is non-empty.
5. Keyword LLM (README `keywordLlm`): segmented off|on for `llm.enabled`,
   text inputs `llm.baseUrl`, `llm.model`, `llm.apiKeyEnv` (tooltip: "name of
   the environment variable holding the key; never the key itself").
   Disabled rows when enabled is off.

Badges: a Tag "custom" (tone info) next to each field present in
`payload.overrides`. Toast "Settings applied" on success. Busy-gate all
controls while a POST/DELETE is in flight (existing `busy` pattern).

## Scope

- New `packages/client/src/sections/configuration.tsx` following the
  vaults.tsx patterns (guarded primitives via `renderInput` /
  `renderSegmented` / `renderButton` / `renderTag` / `renderToast`, native
  fallbacks already handled; number inputs via `renderInput({ type:
  'number' })`).
- `packages/client/src/cardRoot.tsx`: `<Section title="Configuration">`
  immediately after the Vaults Section (before "Index status"); body
  `<ConfigurationSection />`; update the module header comment ("five
  collapsible sections" count/wording).
- Shared styles: reuse `styles.ts` entries; add a small label style there if
  needed (no inline one-offs).
- Tests `packages/client/tests/configuration.spec.ts` (vitest + the existing
  DOM-less render approach used by `vaults.spec.ts`/`dreaming.spec.ts`):
  section renders with stubbed fetch; dirty-field submit builds the exact
  `set`/`unset` body; blank number field does not send that key; reset is
  two-step and DELETEs; restartPending renders the chip.

## Definition of Done

- `node scripts/build-client.mjs` bundles it (part of `pnpm build`; the
  artifact `dsh/client.js` is tracked and committed in the same commit).
- `pnpm test` green; primitives-absent fallback exercised by existing guard
  patterns.

## Dependencies

TASK-007 (api functions).
