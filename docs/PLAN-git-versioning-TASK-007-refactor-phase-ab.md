# TASK-007-refactor-phase-ab

Review the files touched by the previous 6 commits and identify the following code risks:
 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.
Then address and resolve each risk.

Review scope: TASK-001..TASK-006 commits (core memory-git + churn, config
git group, VaultGitManager, write commit, dream commit/tunables).
The prepared prompt constants (`DEFAULT_DREAM_PROMPT`,
`MEMORY_PROMPT_SECTION_TEXT`, `AUDIT_CHECKPOINT_PROMPT_SECTION_TEXT`) are
OFF LIMITS to edits; the surrounding code in their host files stays
editable.

Additional carried item (TASK-006 handoff, fix in this task): prek's
builtin trailing-whitespace hook REWRITES the protected prompt constants
(trailing whitespace inside `DEFAULT_DREAM_PROMPT` is load-bearing
source-of-truth bytes, and the same literals sit in the tracked `lib`
emit). Add `exclude` patterns in `prek.toml` for the prepared-prompt
carriers, src and lib forms (`packages/{service/src,service/lib,tools/src,tools/lib}/*`
covering dream.ts/.js, prompt.ts/.js, audit.ts/.js by precise regex, not
whole packages), verify with `prek run --files packages/service/src/dream.ts`
(reports skipped) and that the constant is still byte-identical to
a113305. If prek.toml's schema cannot express the exclude, fall back to a
comment block at the top of prek.toml naming the never-pass paths, and
append the same warning to this plan's Verification guidelines.

Definition of Done: each risk above answered in the task commit message
body (found+fixed, or absent); full service+core suites still green;
`pnpm build` leaves the tree clean; src+lib committed together.
