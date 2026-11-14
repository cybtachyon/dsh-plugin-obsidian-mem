# TASK-009: Refactor review of the gate implementation

Refactor: Review the files touched by the previous 5 commits and
identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

Scope: files of the TASK-008 implementation commit plus the pre-flight
probe scripts (`docs/research/probes/wake-audit-probe.mjs`,
`zh-analyzer-probe.mjs`). Likely candidates to check: the gate-clause
merging logic existing twice (search.ts and recall-eval.mjs, allowed
ONLY as an import, never a copy), token-legality rules vs
`core/triggers.ts isUsableKeyword` (a second home must import, not
restate), the probe client-boilerplate triplication (a shared probe
helper is out of scope unless trivial; waiving is acceptable).

Constraints: behavior-preserving. All tests stay green WITHOUT test
edits (goldens included). `pnpm build` afterwards keeps lib in lockstep
and the tree stays clean. Gate semantics from the spec untouched; if a
risk fix would change wire behavior, waiver it with a one-line reason.
Separate commit (`refactor:`); `prek run --files` first; re-verify
`pnpm build && pnpm test && pnpm lint`.

Definition of Done: each of the 8 risk classes answered in the commit
message body (resolved | waived+reason); gates green; tree clean.
