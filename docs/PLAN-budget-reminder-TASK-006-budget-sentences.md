# TASK-006-budget-sentences

Repo: /home/derek/src/dsh-plugin-obsidian-mem

## Goal

Per Q-WORDING-SCOPE ("Align all budget sentences"), move every
user-visible over-budget story sentence to the SAME two-part story the
events reminder now tells (see the final TASK-001 text):

- Part A: manually compact JUST THE GLOBAL MEMORY (the live global notes,
  least-read first, via `memory_search` / `memory_read` / `memory_write`
  merge-and-archive), and the agent must NOT start until the user approves.
- Part B: suggest to the user the much-heavier `memory_dream` run for a
  more complete optimization.

Keep every factual payload already in these sentences: the used/budget
numbers, the "injected since the last successful dream or host restart"
window, the named path lists, and the protected-only fact that compaction
cannot help. Keep the sentences terse (no filler; describe the remedy, not
the implementation).

Anchors (verify by reading before editing):

1. `packages/service/src/audit.ts`, `budgetOverRemediation()` (~line 633):
   the non-protected branch "run memory_dream to process and compact the
   global memory markdown files, least-read first: …" becomes the two-part
   story over the same `pathList(...)`. The protected-only branch keeps
   "compaction cannot help" + hand-tighten + named files; fold in the
   user-approval gate only if it stays terse.
2. `packages/service/src/dream.ts`, `renderPlanText()` over-budget lines
   (~lines 896-901): the protected-only and compactable variants. Inside
   dream plan output, part B reads as: this `memory_dream` run is the
   more complete optimization (running it via operation `run` is the
   suggestion), part A is the lighter manual path needing user approval.
   Do not touch the numbered per-candidate work steps.
3. `packages/tools/src/audit.ts` renderer (~lines 298-306): the
   "OVER BUDGET: run memory_dream to process and compact…" and the
   protected_only "tighten these files by hand" lines.
4. `packages/tools/src/dream.ts` renderer (~lines 255-263): the two
   "OVER BUDGET: …" lines.
5. `packages/tools/src/audit.ts` AUDIT_DESCRIPTION tail sentence
   "…an over-budget line names the memory_dream compaction order." align so
   it is true of the new line. Check `DREAM_DESCRIPTION` and
   `packages/tools/src/prompt.ts` MEMORY_PROMPT_SECTION_TEXT for any now-
   false budget clause and align minimally (agent-experience: say each fact
   once; do not restate the reminder in tool descriptions).

Do NOT edit any test (TASK-007 owns the snapshot updates). Do not touch
`packages/client` (its over-budget callout points the user at Dreaming,
which still matches part B).

## Definition of Done

- `pnpm build` green AND the rebuilt `packages/{service,tools}/lib` emit
  committed in the SAME commit (lib IS tracked here); a second `pnpm build`
  leaves `git status --porcelain` empty.
- `pnpm lint` green. Tests may stay red until TASK-007; note the exact
  failing pins in the report instead of fixing them.

## Dependencies

- Depends on: TASK-001 (story text), Q-WORDING-SCOPE answer.
- Blocks: TASK-007.
