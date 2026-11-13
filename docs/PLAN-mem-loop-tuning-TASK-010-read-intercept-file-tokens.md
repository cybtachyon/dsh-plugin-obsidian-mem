# TASK-010: Read intercept derives file-derived tokens

Files: `packages/events/src/readIntercept.ts`, `packages/events/tests/readIntercept.spec.ts`.

Fill the `fileTokens` field TASK-008 added with deterministic file-derived
tokens (lower-cased wake-term shape, `isWakeTerm`-filtered, capped):

- Filename: the extensionless basename plus its `[-_\s]` parts.
- Directories: the existing `dirSignalsOf` segments.
- Imports/symbols: identifiers from the lines `importSnippetFrom` already
  keeps (import/default/`{ … }` named bindings, `require('pkg')`/`from 'pkg'`
  specifiers), camel/snake-split into parts.
- One exported pure function `fileTokensOf(absPath, snippet)` so the spec
  pins it directly; the intercept builds it once and passes it through the
  existing `ExtractedSignals` shape.

Definition of Done: extraction fixtures (TS/tsx import lines, kebab filename,
deep path) and the request-wiring test asserting the fakeMemory receives the
tokens; the old dirSignals-only request test updated. src+lib+spec same
commit; gates green.

Depends on: TASK-008.
