# TASK-013 live-loop-iteration

One live-loop iteration, repeated until convergence (record each
iteration's ledger in the table below or a sibling notes file referenced
here):

1. Seed per TASK-011 (fresh iteration notes if the previous set burned).
2. Launch a `subagent` whose task is real, small work in
   `/home/derek/src/machinae-game` (pick a task matching the seeded
   relevant notes; e.g. a small simulation/entity change). Instructions:
   "For EVERY <recalled_memory> block you receive (turn-start, think, or
   read intercept), immediately `send_message` your parent with: the
   source path, which intercept delivered it, and whether it is useful,
   unrelated, or a near-miss for your task. Do not otherwise deviate from
   the coding task."
3. Collect the reports; also read the subagent's session transcript
   (`~/.dsh/sessions/<slug>/<id>/session.v4.jsonl.zstd`, per the vault
   probe note) to catch injections the subagent failed to report.
4. Ledger per note: seeded-relevant recalled? (which intercept), decoy
   recalled? (which intercept), unrelated pre-existing notes injected
   (forbidden-rate proxy), useful-but-missed notes.
5. Between iterations: dispose the subagent session (drops its budget
   contribution), tune constants per TASK-014 decisions, re-run.

Ledger table (append per iteration): iteration / relevant hit / decoy hit /
forbidden / misses / notes.

Definition of Done: at least one complete iteration ledger; a decision
whether to iterate again.

Depends on: TASK-011, TASK-012, TASK-009, TASK-010.
