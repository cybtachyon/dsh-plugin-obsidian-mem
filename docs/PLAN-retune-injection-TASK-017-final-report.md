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

Definition of Done: report delivered to the user; tree clean; plan files
removed per the harness Finalization step by the parent agent.

Depends on: TASK-015, TASK-016.
