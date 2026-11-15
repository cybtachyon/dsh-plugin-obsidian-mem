# TASK-007b — Core reserved-file doc wording (inserted from TASK-007 finding A)

Context: TASK-007 (commit 8a86877) made the reserved protocol-file rule ONE
core rule, `isReservedVaultFile(vaultPath, target)`, applied at ANY depth
(`isNotesPath` has always excluded `sub/DREAMS.md`-style paths from the note
tree). The remaining drift is prose: `packages/core/src/constants.ts`
documents `RESERVED_NON_INDEXED` as "vault-root files" and
`isReservedNonIndexed` as "a vault-root file name", which reads as a
root-only rule and contradicts the shipped any-depth behavior.

Change (doc-only, no behavior change):

1. In `packages/core/src/constants.ts`, reword the `RESERVED_NON_INDEXED`
   and `isReservedNonIndexed` doc comments (and any sibling comment that
   repeats the "vault-root" phrasing for these names) to state the actual
   rule: reserved protocol names are excluded from the note tree AT ANY
   DEPTH (the note walker drops them wherever they appear; the write tiers
   refuse them in-vault at any depth).
2. Keep the any-depth rule's single home unchanged (core); only prose moves.

Definition of Done:

- `pnpm build` exit 0; the doc-comment change reaches the tracked
  `packages/core/lib` carriers (d.ts/js emit of comments where tsc keeps
  them) and is committed in the same commit; tree clean.
- `pnpm test`, `pnpm lint` green; `prek run --files` green on touched paths.
