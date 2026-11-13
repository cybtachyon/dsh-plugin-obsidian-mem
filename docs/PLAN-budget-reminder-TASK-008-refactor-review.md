# TASK-008-refactor-review

Repo: /home/derek/src/dsh-plugin-obsidian-mem

Refactor: Review the files touched by the previous 7 commits and identify
the following code risks:

 - **Multiple Sources of Truth**: Same calculations done in multiple places.
 - **Duplicate Code**: Nearly-identical code in multiple methods.
 - **Bloaters**: Too many things done in a single method or class.
 - **Data Clumps**: Single variables that travel in a group for multiple methods.
 - **Shotgun Edits**: Commits with singular changes that touch multiple files.
 - **Feature Envy**: Method where over 50% of the code manipulates a different class.
 - **Magic Numbers**: Literals without context in method bodies.
 - **Overengineering**: Methods with single lines of code or slim classes.

Then address and resolve each risk.

Scope hint: the seven preceding commits touch
`packages/events/src/{budget,turnStart,turnEnd}.ts`,
`packages/events/tests/{turnStart,turnEnd}.spec.ts`,
`packages/service/src/{audit,dream}.ts`, and `packages/tools/src/*.ts`
plus their tests. Expected candidate risks to weigh (resolve or waive with
a reason): the `(usedTokens, budgetTokens)` pair travelling together as a
data clump, the over-budget evaluation duplicated between turnStart and
turnEnd as a multiple-sources-of-truth candidate, the two-part budget
story phrased independently in events/service/tools as a duplicate-code
candidate, and any leftover dead code from the removed turn-start pointer.

## Definition of Done

- `pnpm build`, `pnpm lint`, `pnpm test` green.
- Each identified risk resolved, or explicitly waived with a one-line reason
  in the commit message body.

## Dependencies

- Depends on: TASK-001..TASK-007.
- Blocks: TASK-009.
