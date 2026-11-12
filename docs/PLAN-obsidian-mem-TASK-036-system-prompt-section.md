# TASK-036 System-prompt section for memory tools

Depends: TASK-033. `packages/tools/src/prompt.ts`.

## Scope

- Register via `ctx.systemPrompt.section()` (verify exact options with cordis inspection:
  id/order/text; text may be a function re-evaluated per assemble — prefer static text
  here; recall injection happens via events, not here).
- Content (concise, <180 lines): when to use each of the five tools; read-before-write
  rule; atomic one-fact files; Why:/How to apply: lines required; archive instead of
  delete; never store secret values, only where they live; vault modes; search-before-
  write dedupe.
- Section order in DSH's external range (longterm-memory used 9500; pick 9600).

## DoD

Section registration test (fake ctx); text snapshot; commit.
