# TASK-060 Unit test coverage gate

Depends: all implementation phases (run after TASK-046 and 052). Raises the repo test bar.

## Scope

- Vitest coverage thresholds: lines 90 / functions 90 / branches 78 / statements 90 (adapt
  to reality; never below 75 anywhere without a listed exclusion).
- Fill gaps with fakes only (no network, no child processes in unit tier). Fixtures under
  `tests/fixtures/` (fake vaults, fake milvus client recording calls, scripted stream
  frames).
- Exclude from coverage: `scripts/`, `dsh/`, build outputs, `packages/client/lib` bundle.

## DoD

`pnpm test:coverage` passes thresholds; no skipped tests outside RUN_LIVE tier; commit.
