# TASK-014-full-suite-verify

Whole-repo verification gate.

Run, in order, fixing anything red (each fix its own commit with src+lib):
1. `pnpm build` (tsc -b --force, client bundle, format, verify-emit) and
   `git status --porcelain` afterwards: must be empty.
2. `pnpm test`.
3. `pnpm test:coverage` clearing vitest.config.ts floors
   (lines 85 / functions 85 / branches 78 / statements 85); new git
   files must not drag branches below floor.
4. `pnpm lint`.
5. `prek run --files <every file this plan touched>`.
6. Grep sweep: no `TURN_END_REMINDER` consumers left (unless the Q1
   budget-only variant was chosen); no surviving `{{` inside rendered
   prompt fixtures; `obsidian-mem: memory_write` and
   `obsidian-mem: dream` are the only new commit-message formats.
7. Record the measured coverage totals in the final report.

Definition of Done: every command above green on the final HEAD; report
written for the parent agent.
