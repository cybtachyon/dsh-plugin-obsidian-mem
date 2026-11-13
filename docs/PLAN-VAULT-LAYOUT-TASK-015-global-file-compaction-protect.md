# TASK-015 global-file-compaction-protect

Objective: the dreaming engine never targets a vault's `globalFile`.

Files: `packages/service/src/dream.ts`, `packages/service/src/audit.ts`,
their specs.

Steps:
1. Dream candidate ranking: skip candidates whose absolute note path equals
   `<candidate vault>/<that vault's globalFile>` (near-duplicate clusters,
   never-read picks, timeline picks, and the global-over-budget picks).
2. The dream `plan` text and the audit `budget.over` remediation list paths
   of compactable global notes; drop protected global files from those lists
   (keep counting them in `globalNoteCount`/used tokens so the budget math
   stays honest).
3. A vault whose ONLY global notes are protected files reports headroom
   wording that says compaction cannot help and points at manual tightening
   of the named file.
4. `memory_write` may still edit the global file (edit, not compact); no
   write-side guard changes here.

Definition of Done: dream/audit specs pin protection per-vault (a globalFile
in vault A does not protect the same relative path in vault B with a
different setting); `pnpm build` clean; emit committed with the change.

Depends on: TASK-014.
