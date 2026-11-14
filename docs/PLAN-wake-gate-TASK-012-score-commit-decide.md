# TASK-012: score-commit-decide

Phase C close-out (spec Step 3 scoring + Decision rules).

1. Recompute the class x route table per artifact (relevant/acceptable/
   forbidden x both/dense/sparse) from `returned[]` `routes` +
   `classification` fields; the script pattern lives in the vault note
   `obsidian-mem-route-attribution-sparse-only-carries-no-unique-relevance.md`
   (read it via memory_read for the exact replay shape; a throwaway
   node script is fine, keep its output in the doc, not the script).
2. Build the per-query diff table (query id, rows lost, rows gained,
   class deltas) between the two same-session artifacts.
3. Apply the spec Decision rules verbatim (see
   docs/research/sparse-wake-gate-spec.md §Decision rules): PASS needs
   sparse-only forbidden <= 2, relevant-of-labeled >= baseline, zh hits
   unchanged, P@k up OR forbidden-rate down with the other held.
   PARTIAL and FAIL route to their follow-on work (PARTIAL: file the
   wake-keyword EXTRACTION fix as its own task immediately after this
   one, re-run Step 1.2 counts, re-run the A/B; FAIL: Option 4 opens,
   sequencing per the Q3 answer).
4. Update `docs/research/sparse-wake-gate-spec.md`: implementation
   commit hash, both class x route tables, the per-query diff table,
   the A/B outcome + decision, and a pointer from the Step 1 section to
   the outcome.
5. ONE docs commit: both artifacts + the spec doc (timestamp-free paths;
   the baseline artifact name from the Q2 answer).

Definition of Done: decision (PASS / PARTIAL / FAIL) recorded in the
spec doc with the tables, committed; next-task consequence explicit.
