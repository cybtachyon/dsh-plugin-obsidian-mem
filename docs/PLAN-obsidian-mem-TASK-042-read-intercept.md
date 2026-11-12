# TASK-042 Read tool-call intercept

Depends: TASK-040, TASK-024. `packages/events/src/readIntercept.ts`.

## Scope

- Listener: `tools/result` (emit; observe final outcome) or `tools/post-execute` returning
  `next()` unchanged — pick per practices.md ("observe final tool outcomes on tools/result").
  Filter: tool name `read` (harness Read tool) with `file_path` arg.
- Extract: file extension, directory signals (path segments: src/tests/pkg names), import
  snippet (first ~2 KB: `import|require|use|from` lines, max 12 lines).
- Call `searchExactSections(filePath, { ext, dirSignals, snippet, k=2,
  sectionTokens=350 })` (exact-file chunks first, ext/framework ARRAY_CONTAINS fallback).
- Respect `shouldInject` (source once per session) + per-session throttle (skip when last
  read-injection < 15s or same dir already covered) + thinkBudget-independent cap.
- Inject with `agent.inject()` wrapped `<recalled_memory source=...>`; mark injected.
  Never inject for reads of files inside vaults (memory files themselves) to avoid loops.

## DoD

Tests: ext/signal extraction fixtures, filter calls (fake search captures args), once-
per-source skip, vault-file skip, error containment; commit.
