# TASK-007: client-api-config

Give the card an API layer for the new routes, keeping the drift-proof
contract tests green.

## Scope

- `packages/client/src/routes.ts`:
  - `export const PATH_SETTINGS = '/obsidian-mem/settings'`;
    `ALL_CARD_ROUTES` gains `{ method: 'GET'|'POST'|'DELETE', path: PATH_SETTINGS }`
    (three entries).
- `packages/client/src/api.ts`:
  - `CardSettingsPayload` mirrors the GET answer (structural, import types
    from `../../service/lib/index.js` type-only if convenient, else declare
    the narrow view locally like `DreamStatePayload` does; keep `request`'s
    method union extended to include `'DELETE'` usage it already has).
  - `fetchCardSettings(): Promise<CardSettingsPayload>`.
  - `updateCardSettings(set: CardEditablePatch, unset: string[]): Promise<CardSettingsPayload>`
    (omits `unset` when empty, same omission discipline as `addVaultPayload`).
  - `resetCardSettings(): Promise<CardSettingsPayload>`.
  - `ERROR_CODES` gains the settings invalid code (mirror the ui constant).
- Tests:
  - `packages/client/tests/routes.spec.ts` keeps passing (it diffs
    ALL_CARD_ROUTES against ui `ROUTES`: three new paths must match).
  - `packages/client/tests/api.spec.ts`: fetch/update/reset hit the right
    method+path+body through a stubbed fetch; error envelope → ApiError with
    the code.

## Inherited from TASK-004 (via TASK-006's route codes)

- The host awaits a single apply per POST/DELETE; the answer already is the
  fresh view (no follow-up GET needed after success).
- A busy apply answers 409 with the in-flight code (mirror it in
  `ERROR_CODES`); the Configuration section branches on it to keep the
  controls disabled instead of flashing a red banner.
- `restartPending` in the payload is `[]` or `['milvus.dbPath']`; type it
  `string[]` anyway (the host owns the vocabulary).

## Definition of Done

- `pnpm build` emit in the same commit (client lib is tracked even though the
  shipped artifact is `dsh/client.js`); `pnpm test` green.

## Dependencies

TASK-006 (ROUTES contract exists; tests import it).
