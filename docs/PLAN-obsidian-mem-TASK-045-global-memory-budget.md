# TASK-045 Global memory index + budget

Status: done

Implementation note (parent ruling, matching the committed seams): the
budget half shipped as the real `globalMemoryIndex()` accounting in
`service.ts` (per-session recall usage summed via the wired
`SessionRegistryView.totalRecallTokensUsed()`, compared against
`budgets.globalMemoryTokens`, `overBudget` flag; audit and the dream plan
already consumed `globalIndex` and now echo real numbers), plus
`packages/events/src/budget.ts` (the over-budget gate) and the turnStart
switch that injects the memory_dream compaction pointer instead of fresh
recall sections. The note-index text builder of the original scope stays
unimplemented: turn-start recall (TASK-041) already covers per-workspace
injection, and no consumer needed the note-inventory block.

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
