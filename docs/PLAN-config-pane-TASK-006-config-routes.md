# TASK-006: config-routes

Expose the settings view and its two mutations as host routes so the browser
card can read and edit them.

## Scope

- `packages/ui/src/index.ts`:
  - `ROUTES` gains three contract lines:
    - `GET /obsidian-mem/settings` — answers
      `{ settings, overrides, restartPending }` from `service.cardSettings()`.
    - `POST /obsidian-mem/settings` — JSON body
      `{ set: object, unset?: string[] }`; wire-shape checks here only
      (set is an object, unset is a string array); the service owns the
      whitelist and value validation; a validation throw maps to
      `400 config_invalid` with the service message verbatim (the
      `vaultAnswer` precedent).
    - `DELETE /obsidian-mem/settings` — `service.resetCardSettings()`;
      answers the fresh view.
  - `ROUTE_ERROR_CODES` gains `configInvalid: 'config_invalid'`
    (`settingsInvalid` wording is fine too; pick one and use it in both
    places).
  - `RouteService` interface gains `cardSettings()`,
    `updateCardSettings(patch)`, `resetCardSettings()`; handlers added to
    `routeHandlers`.
- Tests in `packages/ui/tests/`: contract↔handler coverage (buildRoutes throws
  without them anyway), 405 on un-declared method, 415/413/400 body discipline
  (shared middleware already covers; assert once for the new POST), a fake
  `cardSettings` round trip, validation-failure envelope (service throws →
  400 with code), DELETE answer.
- `packages/ui/tests/testkit.ts` fake service extended.

## Definition of Done

- `pnpm build` emit (packages/ui/lib) in the same commit; `pnpm test` green;
  the client contract test (TASK-007) will pin paths later, the ROUTES
  description strings must name the exact answer shapes.

## Dependencies

TASK-003 (service methods exist). TASK-005 refactor output is the baseline.
