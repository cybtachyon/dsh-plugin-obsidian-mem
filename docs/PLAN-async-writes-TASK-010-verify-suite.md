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

## Results

Ran 2026-11-14 at HEAD 0a7944b; the full evidence block is the
`TASK-010 whole-repo verification` section of `PLAN-async-writes.md`.

- Build: exit 0, `verify-emit: 264 tsc artifacts intact across 6
  packages; 3 prompt carriers byte-exact`, tree clean afterwards.
- Default tier: 1113 passed / 2 skipped (54 passed + 1 skipped files),
  exit 0. Coverage `All files` 94.69 / 88.22 / 93.01 / 94.90 against the
  85 / 85 / 78 / 85 floors. `pnpm lint` exit 0. `prek run --all-files`
  green, plus `prek run --files` over all 58 paths of the plan range.
  The AGENTS import grep printed nothing.
- Live tier: `live-pipeline.live.test.ts` 11 passed in 6.43 s, including
  the TASK-006 `async settle` case (140 ms) running live for the first
  time; `async-write-bench.live.test.ts` 3 passed in 12.51 s, cold write
  21 ms, ten warm writes `4, 13, 18, 20, 18, 14, 18, 16, 22, 10` ms,
  settle 0.4 s, 11 commits. The rerun also proved TASK-009c live: the
  testbed's `.obsidian-mem` sidecar went from 1 tracked path to 0, with
  the ignore constant appended to the vault's own `.gitignore` and the
  sidecar removal recorded in the cold wave's commit.
- Docs: README's Git versioning paragraph and the AGENTS `VaultGitManager`
  bullet no longer promise one commit per write; both state that a batch
  outrunning the serial commit lane shares a commit wave. No other
  sentence promised synchronous write-through.
