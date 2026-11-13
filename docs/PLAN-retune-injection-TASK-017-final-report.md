# TASK-017 final-report

Final gates and the written report:
- `pnpm build`, `pnpm test`, `pnpm lint` green at HEAD.
- Commit everything (findings doc, eval artifacts, constants, tests).
- Produce the final report (chat response, no new file):
  1. Work done: strip implementation location + scope, tests, harness
     parity, every constant before → after.
  2. Empirical results: offline A/B table (strip off vs on), sparse-floor
     sweep knee, live-loop iteration ledgers (relevant hits, decoy hits,
     forbidden, misses), and the two undecided items' decisions with
     evidence.
  3. Any residual risk (label drift, known misses, budget interaction).
  4. Follow-up candidates surfaced during the loop (NOT fixed here):
     the heuristic wake_keywords vocabulary is dominated by generic
     intent markers ("when/how/why") plus one 64-char emphasis-span
     keyword, weakening think-intercept matching and any topic-driven
     feature (llm.enabled defaults false; no note uses frontmatter
     keywords:) [TASK-010 finding 1]; the workspace manifest scan has
     no VCS/IDE-file exclusion at topExtensions (.iml observed on
     machinae-game) [TASK-010 finding 2]; search.ts's FUSED_SCORE_FLOOR
     docblock cites "TASK-007" from the OLD plan's numbering
     [TASK-009 nit]; radius-tuning-findings.md's "labels include planted
     notes" line describes the pre-6c2ae75 state [TASK-008 finding 4].

Definition of Done: report delivered to the user; tree clean; plan files
removed per the harness Finalization step by the parent agent.

Depends on: TASK-015, TASK-016.
