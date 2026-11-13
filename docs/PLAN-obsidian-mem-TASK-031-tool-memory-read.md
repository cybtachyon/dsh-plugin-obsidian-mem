# TASK-031 Tool: memory_read

Status: done

Depends: TASK-030. `packages/tools/src/read.ts`.

## Registration canon (shared by TASK-031..035; ext §2.3)

- `scope.tools.register({ name, description, parameters, output: { schema, render },
  timeoutMs, execute, presentCall })` through the tools seam via SCOPED
  `ctx.inject([seam,'tools'], cb)`. Expected failures are VALUES in a closed `oneOf`
  output keyed on `kind` (never throw); range validation lives in execute (DSH schema
  subset is narrow). `presentCall` → `{card:'generic', kind:'read'|'execute', title,
  rawInput}`. Timeouts: fast tools 10_000 ms; memory_dream run 300_000 ms.
- Verify the exact API with `cordis_inspect_query` Service provider before wiring; do not
  import `@deepseek-ai/dsh-tools`'s defineTool as a static dependency (may not resolve in
  a third-party plugin's module scope).

## Scope

- Params: `{ path: string (absolute), offset?: int, limit?: int (lines) }`.
- Route through `service.ensureMemoryAccess()`; when it reports the one-time default-vault
  notice, prepend it to the tool result (Decision log: lazy default vault).
- Path must resolve inside a known vault's `markdown/` dir (classifyPath) → else clear
  error listing configured vaults. Reading from read-only vaults is ALLOWED.
- Effects: update frontmatter `last_read_at` (date) and `read_count += 1` (file write;
  skipped with a note for read-only vaults); register {path, contentHash, mtimeMs, at} in
  the read registry consumed by memory_write staleness.
- Defang: inside the wrapper, any literal `</recalled_memory>` sequence in note content is
  rewritten to `[close-tag defanged]` (a human-editable vault can otherwise break out of
  the envelope; injected text reaches the model unescaped).
- Result: full content wrapped exactly in
  `<recalled_memory source="/abs/path/to/memory.md">\n...\n</recalled_memory>`; oversized
  files paginated by offset/limit with a "truncated" marker line inside the wrapper.

## DoD

Tool registration smoke (fake runtime), path-guard tests, read-stat update tests,
read-only note behavior, wrapper exact-match test; commit.
