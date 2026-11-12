# TASK-045 Global memory index + budget

Depends: TASK-030, TASK-012. `packages/service/src/globalMemory.ts`.

## Scope

- `globalMemoryIndex({ tokenBudget })`: gather active (non-archived) notes whose frontmatter
  `type === 'global'` across SHARED+read-only vaults; build the injected block: index lines
  `- [title] (path) — description` sorted by read_count desc, plus verbatim content for
  notes under 200 tokens; trim tail to budget (keep most-read); return `{ text, tokens,
  paths, overBudget }`.
- Used by: TASK-041 (once-per-session injection), TASK-034 audit (budget check + paths),
  status().
- Cache per vault-set revision; invalidate on indexer change events.

## DoD

Budget trimming tests (over/under, sort order, archived exclusion, read-only vault
inclusion), cache invalidation test; commit.
