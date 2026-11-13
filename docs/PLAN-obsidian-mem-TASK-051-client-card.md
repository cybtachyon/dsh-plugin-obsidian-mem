# TASK-051 Client settings card

Status: done

Depends: TASK-050. `packages/client/src/{index.ts,plugin.ts,Card.tsx,store/,render/}`.
Copy architecture from `/home/derek/src/dsh-plugin-local-infer/packages/client` (lazy-CJS
factory, `require('react')` + primitives require-with-fallback, routeExists probe,
slots.inject('plugins.bundle.config') + settings.plugin.item fallback,
keyed `{ name: 'plugins.bundle.config', key: 'dsh-plugin-obsidian-mem' }`).

## Scope

Card sections (all data from /obsidian-mem/*):
1. **Vaults**: rows (path, mode badge, note count, pending, last indexed), add form (path
   text input + mode select "Adopt and Share" | "Read-only"), remove (confirm), default
   vault flagged.
2. **Index**: totals, model cached/missing, Reindex now button, vectorDim readout.
3. **Global memory**: injected-tokens / budget meter (over = warning color), audit hint.
4. **Dreaming**: schedules list (label + expression + enable), add/remove form; explanatory
   line that agents can be asked to schedule automated dreaming; per-apply caveat from
   TASK-050 finding.
Style: only `--dsw-alias-*` theme tokens (query Theme listTokens), copied host row/modal
patterns renamed under `.omem-`; no imports of harness client packages (runtime require with
primitives fallback like local-infer). Guard every primitive use.

## DoD

Pure-logic tests (store reducers: pending→ack|timeout per action, form validation);
`tsc -b` type-checks with ambient requires declared; commit.
