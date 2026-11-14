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
7. TASK-010 carry-in: confirm no stale lib artifacts of deleted sources
   (events/lib/budget.* were git rm'd in 98e8e9b); if `scripts/
   verify-emit.mjs` lacks a stale-artifact guard, add one (fail when a
   `packages/*/lib` file has no corresponding `src` sibling) with its own
   commit, or record the decision not to.
8. Record the measured coverage totals in the final report.

Definition of Done: every command above green on the final HEAD; report
written for the parent agent.

## Results (2026-11-14, final HEAD 29be1cf on top of 32bd02d)

- `pnpm build`: exit 0; "verify-emit: 260 tsc artifacts intact across 6
  packages; 3 prompt carriers byte-exact"; `git status --porcelain` empty.
- `pnpm test`: exit 0; 53 passed | 1 skipped files (54); 1050 passed |
  2 skipped tests (1052). No red. Per-package tests: core 225,
  service 443, tools 101, events 143, client 63, ui 75, bundle 2.
- `pnpm test:coverage`: exit 0. All files: statements 94.59 / branches
  88.02 / functions 92.60 / lines 94.81 against floors 85 / 78 / 85 / 85.
  New git files: core memory-git.ts and churn.ts 100% on all four;
  service vault-git.ts 96.15 / 97.05 / 95.23 / 96.92. No floor dragged.
- `pnpm lint`: exit 0 (eslint .).
- `prek run --files` over the 114 plan-touched files existing at final
  HEAD (deleted budget.* excluded; jactionlint skipped, no workflow
  touched): all hooks Passed.
- Grep sweeps: `TURN_END_REMINDER`, `installTurnEnd`,
  `compactionInstruction` all absent (rc=1 over packages/scripts/dsh).
  Surviving `{{` are only JSX style props, doc-comment token mentions,
  the prepared source-of-truth prompt placeholders (rendered at runtime;
  specs assert `not.toContain('{{')` on rendered output:
  dream.spec.ts:422, prompt.spec.ts:56, audit.spec.ts:205/217), and one
  JSON-parse fixture. `datedCommitMessage` subjects in src are only
  `dream` (dream.ts) and `memory_write <rel>` (service.ts); the only
  other `obsidian-mem:` message producer is `INITIAL_COMMIT_MESSAGE`
  ('obsidian-mem: initial memory commit'). Other `obsidian-mem:` string
  literals are inject/route labels, not git messages.
- Stale-lib: every one of the 260 files under `packages/*/lib` has a src
  sibling (bundle carries no lib by design); `packages/events/lib/budget.*`
  confirmed GONE (git rm'd in 98e8e9b). No orphans to remove.
- Stale-artifact guard: ADDED (commit 29be1cf). `scripts/verify-emit.mjs`
  now exports `staleLibArtifacts(rootDir)` and fails the build on lib
  files with no src sibling (probe: orphan file -> exit 1 with a
  `git rm <file>` hint; clean tree -> exit 0), pinned by
  `packages/tools/tests/stale-lib-artifacts.spec.ts` (7 tests).
- Byte identity: the three prepared constants are byte-identical between
  a113305 and HEAD (DEFAULT_DREAM_PROMPT 5019 bytes,
  AUDIT_CHECKPOINT_PROMPT_SECTION_TEXT 2283 bytes,
  MEMORY_PROMPT_SECTION_TEXT 824 bytes). `git diff a113305..HEAD` hunks:
  prompt.ts has zero hunks; dream.ts hunks at new lines
  18-33/35-41/55-61/346-367/405-431/840-850/855-861/870-883/910-933/1046-1051
  vs the constant at 71-173; audit.ts hunks at 2-27/42-48/90-96 and
  above vs the constant at 47-83 (the 42-48 hunk touches AUDIT_DESCRIPTION
  only, the constant line appears there as unchanged context).
