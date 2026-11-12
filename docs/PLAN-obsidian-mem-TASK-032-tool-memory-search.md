# TASK-032 Tool: memory_search

Depends: TASK-030. `packages/tools/src/search.ts`.

## Scope

- Params: `{ query: string, scope?: enum-or-slug, type?: alias of scope, maxResults?: int
  (default budgets.searchTopK, cap 20) }`.
- Route through `service.ensureMemoryAccess()`; prepend the one-time default-vault notice
  (with full path) to the result when the service reports it (Decision log).
- Calls `ctx.obsidianMem.search`; per result include: source_path, section_header, scope,
  `vault` + `vault_mode` ('shared'|'read-only'), score, index_title/index_description
  (frontmatter cache), token-capped snippet.
- Result text: results first, then a short usage footer: "Call memory_read on a path
  before memory_write; search before writing to avoid duplicates; archived notes excluded."
- Offline → IndexOfflineError mapped to actionable tool message (not a crash).

## DoD

Golden output-shape tests with faked service; mode/scope passthrough; offline message test;
commit.
