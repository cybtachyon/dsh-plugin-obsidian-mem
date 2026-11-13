# TASK-004: Intents vocabulary from all vaults, intent words only

Files: `packages/events/src/thinkIntercept.ts`, `packages/events/tests/thinkIntercept.spec.ts`.

Replace `readRecordedIntentTerms`:

- Read `<vault>/.INTENTS.md` for EVERY registered vault
  (`deps.memory.listVaults()`, shared and readonly), union the results;
  unreadable files skip.
- Collect ONLY intent words, never prose tokens (Q1: marker section headers
  only). The admitted shape is a `## <marker>` header whose lower-cased name
  passes `isIntentMarker`; bullets and prose contribute nothing.
- Delete the INTENT_HINTS seed-line comparison and the content tokenization
  loop; the INTENT_HINTS comparison is unneeded once prose is never read.
- Keep the `intentsTerms()` once-per-agent cache and `INTENTS_TERMS_MAX`.
- Update the module header's vocabulary sentence (source (c) becomes "the
  intent words recorded in every vault's `.INTENTS.md`").

Definition of Done: tests with two vaults assert the union of marker-header
words lands in the match vocabulary, prose content lines and backticked
paths contribute nothing, a non-marker `##` header is ignored, and a vault
whose file is unreadable contributes nothing. src+lib+spec same commit;
gates green.

Depends on: Q1 answer; no code dependency on other tasks.
