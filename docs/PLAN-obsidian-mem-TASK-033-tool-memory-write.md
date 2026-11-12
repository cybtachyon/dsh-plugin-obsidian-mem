# TASK-033 Tool: memory_write

Depends: TASK-030, TASK-012. `packages/tools/src/write.ts`.

## Scope

- Params: `{ path (absolute), index_title, index_description, type
  ('global'|'domain'|'reference'|'{{project-name}}' slug), archive? (default false),
  contents (markdown) }`.
- Guards (all errors actionable):
  1. path inside a SHARED vault markdown dir — reject read-only vaults explicitly.
  2. read-before-write: file must exist in the read registry from THIS process's
     memory_read AND current contentHash must match the registered one; new files allowed
     only when the path does not exist on disk; changed-since-read → reject with "run
     memory_read again" message.
  3. validate meta (TASK-012): title "Topic: scenario" style hint (soft warning if no
     colon), description one-sentence-ish (soft warn), valid type slug.
  4. soft warn (result note, not rejection) when contents lack `Why:` and `How to apply:`
     lines.
- Route through `service.ensureMemoryAccess()` before the guards; when it provisions the
  default vault, the write proceeds there and the one-time notice (full path) is prepended
  to the result (Decision log).
- Write: serialize frontmatter + contents (created preserved, updated=now), atomic write,
  then synchronous single-file reindex (indexer.writeThrough) so later searches see it;
  archived=true → note excluded from index (chunks deleted) but file kept.
- Result: canonical absolute path, chunk count indexed, warnings list.

## DoD

Staleness matrix tests (new ok / read-then-write ok / changed-since-read rejected /
not-read rejected), read-only rejection, archive reindex, frontmatter round-trip on disk;
commit.
