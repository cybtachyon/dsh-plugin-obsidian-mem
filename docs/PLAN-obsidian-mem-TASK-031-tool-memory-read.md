# TASK-031 Tool: memory_read

Depends: TASK-030. `packages/tools/src/read.ts`. Register via the ToolRuntime definition
shape verified in dsh-longterm-memory/src/host/dsh/tools.ts (name, description, parameters
JSON Schema, output{schema, render}, execute(args, exec)) — re-verify current API with
`cordis_inspect_query` Service provider before wiring.

## Scope

- Params: `{ path: string (absolute), offset?: int, limit?: int (lines) }`.
- Path must resolve inside a known vault's `markdown/` dir (classifyPath) → else clear
  error listing configured vaults. Reading from read-only vaults is ALLOWED.
- Effects: update frontmatter `last_read_at` (date) and `read_count += 1` (file write;
  skipped with a note for read-only vaults); register {path, contentHash, mtimeMs, at} in
  the read registry consumed by memory_write staleness.
- Result: full content wrapped exactly in
  `<recalled_memory source="/abs/path/to/memory.md">\n...\n</recalled_memory>`; oversized
  files paginated by offset/limit with a "truncated" marker line inside the wrapper.

## DoD

Tool registration smoke (fake runtime), path-guard tests, read-stat update tests,
read-only note behavior, wrapper exact-match test; commit.
