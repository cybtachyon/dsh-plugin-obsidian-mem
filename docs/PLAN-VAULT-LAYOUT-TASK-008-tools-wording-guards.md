# TASK-008 tools-wording-guards

Objective: the model-facing tools describe and guard the vault-root note tree
(no `markdown/` anywhere), per
[PLAN-vault-layout.md](../PLAN-vault-layout.md).

Files: `packages/tools/src/read.ts`, `write.ts`, `prompt.ts`, `audit.ts`,
`search.ts` (descriptions), `packages/events/src/turnEnd.ts` reminder text,
tools/events specs.

Steps:
1. Use the TASK-002 `classifyPath` result (`insideNotes` + internal-dir
   predicate) in read/write guards; a target under `.obsidian-mem/` is
   refused with the same "outside the indexed notes" answer shape.
2. Rewrite the refusal `message` strings and the `vaults` /
   `shared_note_dirs` echo lists to name the vault root(s), not
   `markdownDir(...)`.
3. Rename the write refusal kind `outside_markdown` → `outside_notes` (output
   schema union, presentCall renderers, and specs included); the read kind
   `outside_vault` stays.
4. Update tool `description`/param text: "inside a registered vault's
   markdown/ directory" → "inside a registered vault" (root); keep the
   rest of the contract wording identical.
5. Update the memory section in `prompt.ts` and the turnEnd reminder so
   nothing steers the agent to a `markdown/` dir.

Definition of Done: no `markdown/` strings remain in tools/events src outside
git-ignored emit; specs pin the new kind + wording; `pnpm build` clean; emit
committed with the change.

Depends on: R2.
