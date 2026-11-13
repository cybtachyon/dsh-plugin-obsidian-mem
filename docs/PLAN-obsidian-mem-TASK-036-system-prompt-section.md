# TASK-036 System-prompt section for memory tools

Status: done

Depends: TASK-033. `packages/tools/src/prompt.ts`.

## Scope

- Register via `ctx.systemPrompt.section()` with `interpolate: false` (the assembler
  interpolates by default and THROWS on unknown/malformed {{groups}} in text) and a
  provider fn that NEVER throws (missing data ⇒ '' + warnOnce per reason). Order: a
  finite external-range number (use 9600; internal sections own the low range). Recall
  injection happens via events, not here; the memory-discipline prose lives in
  README/AGENTS.md and is not duplicated here (ext §2.4 lesson).
- Content (concise, <180 lines): when to use each of the five tools; read-before-write
  rule; atomic one-fact files; Why:/How to apply: lines required; archive instead of
  delete; never store secret values, only where they live; vault modes; search-before-
  write dedupe.
- Section order in DSH's external range (longterm-memory used 9500; pick 9600).

## DoD

Section registration test (fake ctx); text snapshot; commit.
