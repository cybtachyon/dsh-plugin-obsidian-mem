# TASK-009b — write.ts missing-directory target (inserted from TASK-009 finding 1)

Bug (live-repro by the TASK-009 bench): for a NEW note whose `path` names a
directory that does not exist yet (`<vault>/dsh-bench` with no trailing
separator and no `.md` basename), `executeWrite` falls to
`newNoteDir = dirname(target)` and the slugged note lands in the
directory's PARENT. The documented contract says the passed path supplies
the directory; today that only holds for EXISTING directories. No unit test
covered the missing-dir target.

Fix in `packages/tools/src/write.ts` (Guard 6 / finalPath selection, one
decision point):

- For a new note (target is not an existing FILE), the note directory is:
  the target itself when `statSync(...).isDirectory()` OR the path ends in
  a path separator (trim it); otherwise the target's parent when the
  basename ends in `.md`; otherwise the target itself (a non-`.md`,
  non-existing path means a directory, matching the parameter's own
  wording that note paths are `.md` paths). Keep collision suffixing and
  the existing-directory case behavior identical.
- Update the `path` parameter description ONLY as far as honesty requires
  (the contract sentence already promises the directory; no churn), and
  the module doc if it implies the old rule.
- Tests in `packages/tools/tests/write.spec.ts`: (a) missing-directory
  target slugs INTO that directory (dir absent before, created by the
  write); (b) trailing-separator missing-directory target behaves the same;
  (c) `.md` basename into a missing directory still lands inside it (the
  "pass a file inside" documented workaround must keep working);
  (d) existing-directory behavior unchanged (the current pin).
- This changes a model-facing tool parameter behavior: load the
  `agent-experience` skill first and keep the description honest and terse.

Definition of Done:

- `pnpm build` exit 0, tree clean; `packages/tools/lib` carriers ride.
- Tools suite green (adds to the pins); `pnpm lint` green; `prek` green on
  touched paths.
