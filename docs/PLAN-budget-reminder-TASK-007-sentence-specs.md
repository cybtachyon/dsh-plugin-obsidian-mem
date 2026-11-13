# TASK-007-sentence-specs

Repo: /home/derek/src/dsh-plugin-obsidian-mem

## Goal

Update every test pin falsified by TASK-006's service + tools budget
sentence alignment. Known anchors (verify by reading before editing):

- `packages/service/tests/audit.spec.ts`: the budget.over remediation pin
  (~line 26 fixture and the "over budget: reports an ISSUE instructing
  memory_dream over the least-read-first list" test ~line 576; the
  protected-only test ~line 634).
- `packages/service/tests/dream.spec.ts`: golden plan-text lines ~351 and
  ~369-370. Fixture idiom: `globalIndex: { budgetTokens, usedTokens,
  remainingTokens }` with `overBudget` derived in the `deps()` helper; when
  asserting a numbered plan line, give the fixture a budget-independent
  candidate (e.g. `sizeBytes: NOTE_TIMELINE_BYTES + 1`) or the
  "No candidates found" short-circuit swallows it.
- `packages/tools/tests/audit.spec.ts`: remediation echo rows (~line 26)
  and the OVER BUDGET renderer rows (~lines 154-159).
- `packages/tools/tests/dream.spec.ts`: OVER BUDGET renderer rows
  (~lines 169-173).
- Any test asserting AUDIT_DESCRIPTION or DREAM_DESCRIPTION verbatim.

New pins must quote the final TASK-006 sentences exactly; assert stable
fragments (approval gate, manual global-only path, `memory_dream`
suggestion, protected-only "compaction cannot help").

## Definition of Done

- `pnpm test` green for `packages/service` and `packages/tools` filters,
  and no new failures elsewhere versus the recorded baseline (quote both).
- Test-only commit (plus committed lib emit only if a build was needed).

## Dependencies

- Depends on: TASK-006.
- Blocks: TASK-008.
