# TASK-010 — Whole-repo verification and measured totals

Run every repo gate and record the evidence:

1. `pnpm build` exit 0, verify-emit reports artifacts, `git status` clean
   (lib carriers all committed).
2. `pnpm test` full suite green (note passed/skipped counts).
3. `pnpm test:coverage` clears the vitest.config.ts floors (85/85/78/85);
   record measured totals.
4. `pnpm lint` green.
5. `prek run --files <all paths touched across this plan>` green.
6. AGENTS verification grep prints nothing:
   `grep -rn "from '\.\{1,2\}/[^']*\.tsx\?'" packages/*/src`.
7. The AGENTS.md service bullet + README reflect the confirm-then-settle
   write contract (final read-through).

Definition of Done:

- All gates green; the `Results` section of `PLAN-async-writes.md` records
  build state, suite counts, coverage totals, lint, prek, and the grep
  result, plus a one-line summary of the measured write latencies from
  TASK-008/TASK-009.
