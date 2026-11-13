# TASK-014 converge-final-values

Decide convergence from the TASK-013 ledgers and ship the final tuning
values. Rules:
- Keep a change only when the iteration shows relevant-note recall held
  AND decoy/forbidden rate moved down. A change that only moves the
  boundary between "too few relevant" and "too many irrelevant" is a wash;
  revert to the last measured value instead (the request's named risk).
- Constant edits land in `packages/service/src/search.ts` with dated
  evidence notes citing the iteration ledgers; offline artifacts under
  docs/research/ back each value where the offline proxy is meaningful.
- After any constant change: rebuild, restart verification per TASK-012
  discipline (ask the user to restart again when host code changed), then
  one confirming live iteration.
- Convergence = an iteration where all seeded relevant notes answered,
  decoys stayed out, and no pre-existing forbidden rows appeared; or the
  loop is declared at best-observed values with the remaining imperfection
  documented.

Record: the final value of every tuning constant touched by this plan
(before → after per constant) with its evidence line.

Definition of Done: final values table written here and mirrored at the
top of `docs/research/stopword-strip-findings.md`; confirming iteration
ledger green (or documented best-observed stop).

Depends on: TASK-013 (one or more iterations).
