# TASK-004: card-last-run-error

Surface the most recent dream run outcome in the client card's Dreaming
section so a failed run is visible on the page, not only in host logs.
`service.status().dream.lastRun` (a `DreamRunSummary | null` with
`ok`, `error`, `summary`, `finishedAt`) already ships on the status route;
the card ignores it today.

## Files

- `packages/client/src/sections/dreaming.tsx`
- `packages/client/src/api.ts` / status type modules (add `lastRun` to the
  card's dream status shape only if the wire type omits it).

## Changes

1. When `dream.lastRun !== null && dream.lastRun.ok === false`, render a
   warning banner (reuse the existing `WARNING_BANNER_STYLE` pattern) like
   `Last dream run failed: <summary or error>` with the `finishedAt` local
   date.
2. When `ok === true`, keep current behavior (no new banner; the existing
   lastDreamAt display suffices).

## Constraints

- Guard every primitives use per AGENTS.md (`primitives && typeof ... ===
  'function'`), keep to the existing card idioms in `dreaming.tsx`.
- This is a client-card change: it ships through `pnpm build`
  (`dsh/client.js`) and needs a host restart for the served artifact
  (per the known boot-composed rev behavior), not just a page refresh, in
  this install layout.

## Definition of Done

- `pnpm build` green (client artifact rebuilds); existing client specs
  untouched or extended; commit.
