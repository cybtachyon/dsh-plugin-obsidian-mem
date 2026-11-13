# TASK-004 Scaffold green build gate

Status: done

Depends: TASK-001..003.

## Scope

- `pnpm install`, `pnpm build` (including verify-emit.mjs adapted to this repo's expected
  artifacts: dsh/client.js placeholder NOT yet present — make verify-emit tolerant until
  TASK-052 lands, then it must require dsh/client.js), `pnpm typecheck`, `pnpm test`,
  `pnpm lint` all pass.
- Add one smoke vitest per package asserting its default export shape {name, inject, apply}.
- `prek install` hooks if prek.toml present; run `prek run --files <staged>` before commit.

## DoD

All four commands green from a clean tree; commit.
