# TASK-012 Memory note format (frontmatter)

Depends: TASK-010. `packages/core/src/note.ts`. gray-matter allowed.

## Scope

- `NoteMeta` frontmatter fields: `index_title` ("Topic: Scenario" style, e.g.
  "Typescript: Writing style"), `index_description` (one concise sentence aiding recall),
  `type` (global|domain|reference|project slug), `archive` (bool, default false),
  `created`/`updated` (ISO 8601), `last_read_at` (ISO date), `read_count` (int >= 0).
- `parseNote(text)` → { meta, body } tolerant of missing fields (defaults applied);
  `serializeNote({meta, body})` stable field order, CRLF normalized.
- `validateMeta(partial)` → errors array; `type` must be a scope constant or valid slug
  (`isScopeSlug` from constants).
- Filename slug helper: `titleToFilename('Typescript: Writing style')` →
  `typescript-writing-style.md` (collision suffix `-2`).
- `isArchived(note)`; archived notes are excluded from search defaults and reindexing.
- `ensureWhyAndHow(body)` → warnings array when body lacks a `Why:` line and a
  `How to apply:` line (used as a soft warning in memory_write, per turn-end policy).

## DoD

Round-trip tests, defaults, slug collisions, archived detection, Why/How warnings; commit.
