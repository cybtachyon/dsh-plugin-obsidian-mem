# TASK-008: Read fallback leg requires wake-keyword intersection

Files: `packages/service/src/search.ts`, `packages/service/tests/search.spec.ts`.

The `searchExactSections` fallback ("neighborhood") leg may only return a
chunk whose stored `wake_keywords` overlap the file-derived tokens:

- `ExactSectionRequest` gains `fileTokens?: readonly string[]` (the file's
  name, directory, and import/symbol tokens; the Read intercept fills them
  in TASK-010). The old `dirSignals` field is folded into it (the caller now
  passes one merged, lower-cased, wake-term-shaped list).
- `fallbackFilterExpr` ALWAYS carries the
  `ARRAY_CONTAINS_ANY(wake_keywords, [...])` clause from `fileTokens`
  (trailing separators trimmed, values escaped as today), alongside the ext
  and framework clauses. The "join only when nothing else narrows" rule and
  the `EXT_FRAMEWORK_HINTS` wake-keyword exclusion go away.
- No fileTokens (or zero usable): the fallback dispatch is skipped and the
  leg answers `[]` (no intersection is possible). The exact-file leg is
  untouched.
- Golden expression tests for the new clause shapes (with ext, with
  frameworks, bare) and a behavior test proving the skip-to-empty.

Definition of Done: goldens literal; `searchExactSections` docs (module
header + request field) state the intersection rule; src+lib+spec same
commit; gates green.

Depends on: nothing (interface decision final after Q3 shapes TASK-009 in
the same file; sequence before it).
