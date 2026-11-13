# TASK-25 Remove the RESEARCH-FINDINGS.md scratch document

`RESEARCH-FINDINGS.md` is 51,667 bytes of pre-implementation scratch from
2026-10-25/26. `docs/research/milvus-transformers-findings.md` and
`docs/research/engramory-and-ext-findings.md` are the maintained, more accurate
replacements (the former corrects three `>`-cited claims from the scratch file).
It is also always-included by npm, so it ships in the published tarball.

User decision 2026-11-12: delete it. The content stays reachable through git
history (`git show 3b2e01b:RESEARCH-FINDINGS.md`).

Steps:

1. `git rm RESEARCH-FINDINGS.md`
2. Fix the one live code citation, in
   `packages/service/src/milvus/launcher.ts` (the `retireLegacyDataDir` doc
   comment, "(RESEARCH-FINDINGS scar tissue; findings §2.3)"): cite the
   maintained research doc instead, so the comment names a file that exists.
3. `pnpm build` so the tracked `packages/service/lib/milvus/launcher.d.ts` and
   `launcher.js` emit carry the corrected comment, and commit that emit with the
   source change.
4. Confirm the pack list drops the file: `npm pack --dry-run` (works after
   TASK-24) must not list `RESEARCH-FINDINGS.md`.

Leave `PLAN-release-prep.md` and `docs/PLAN-release-prep-TASK-06-*` mentions
alone: they are plan records, not citations of a live file.

## Definition of Done

- `test ! -e RESEARCH-FINDINGS.md` and `git ls-files RESEARCH-FINDINGS.md` is empty.
- `grep -rn "RESEARCH-FINDINGS" packages/*/src` is empty.
- `pnpm build` and `pnpm test` exit 0; the emit diff for the comment fix is
  committed in the same change.
- The pack list has no `RESEARCH-FINDINGS.md` row and its entry count dropped.
